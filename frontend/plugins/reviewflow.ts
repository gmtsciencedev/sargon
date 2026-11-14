import { Plugin as PMPlugin, PluginKey, NodeSelection } from "prosemirror-state"
import type { Node as PMNode, Schema } from "prosemirror-model"
import { EditorView } from "prosemirror-view"
import type { Plugin as WikiPlugin, Registry } from "../compiler/registry"
import { enablePropertiesPanel, requestInputFocus } from "../compiler/core_ui"
import { signConfirmation } from "../signing/signer"
import { hasKey } from "../signing/keystore"

// --- Properties ---

const reviewflowProperties = [
  {
    name: "version",
    label: "Version tag",
    default: "",
    parse: (raw: string) => raw.trim(),
    serialize: (value: string | null) => String(value ?? ""),
  },
  {
    name: "roles",
    label: "Roles",
    default: "{}",
    multiline: true,
    parse: (raw: string) => {
      // Parse "rolename=username\n..." into JSON string
      const roles: Record<string, string> = {}
      for (const line of raw.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const eq = trimmed.indexOf("=")
        if (eq > 0) {
          roles[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
        }
      }
      return JSON.stringify(roles)
    },
    serialize: (value: string | null) => {
      // Convert JSON string back to "rolename=username\n..." lines
      // Keep the declared order: it is the signing order.
      try {
        const roles = JSON.parse(value || "{}")
        return Object.entries(roles)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      } catch {
        return value || ""
      }
    },
    helpText: "One role per line: rolename=username, in signing order",
  },
  {
    name: "parallel",
    label: "Signing order",
    default: "",
    parse: (raw: string) => (isTruthy(raw) ? "true" : ""),
    serialize: (value: string | null) => String(value ?? ""),
    options: [
      { value: "", label: "One signer at a time, in the order listed" },
      { value: "true", label: "All signers at once" },
    ],
  },
  {
    name: "manual_release",
    label: "Signing starts",
    default: "",
    parse: (raw: string) => (isTruthy(raw) ? "yes" : ""),
    serialize: (value: string | null) => String(value ?? ""),
    options: [
      { value: "", label: "As soon as the page is saved" },
      { value: "yes", label: 'When someone ticks "Ready for signature"' },
    ],
  },
]

function isTruthy(raw: string | null | undefined): boolean {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase()
  return v === "true" || v === "1" || v === "yes"
}

// Directive keys that are options, not role assignments.
const OPTION_KEYS = new Set(["version", "parallel", "manual_release", "_args"])

// --- API Gate ---

const API_BASE = "/api/plugin/reviewflow/v1"

interface ReviewflowStatus {
  roles: Record<string, string>
  version_tag: string
  current_page_version: number
  validated_page_version: number
  missing_roles: Record<string, string>
  // Actionable-now roles (parallel: every missing role; sequential: head of
  // queue only). Consumed by the {reviewflow-query when=next} filter.
  next_roles?: string[]
  parallel?: boolean
  role_order?: string[]
  deadlines?: Record<string, string>
  overdue_roles?: string[]
  is_fully_validated: boolean
  version_history?: {
    page_version: number
    timestamp: string
    confirmed_by: Record<string, string>
    version_tag: string
    // Full crypto payload per role that confirmed at this version. Added
    // rc.3 as part of the signature-preservation change — a client reads
    // Confirmations to answer "what was my last signature for this role"
    // (used for the "diff since your last signature" side link when a
    // user's signature has since been invalidated by a content change).
    // Older state files or partial snapshots may still omit it.
    confirmations?: {
      page_version: number
      role: string
      user: string
      timestamp: string
      version_tag: string
      signature?: string
      digest?: string
    }[]
    is_validated?: boolean
  }[]
  signing_enabled?: boolean
  signing_required?: boolean
  signed_roles?: string[]
  // manual_release=yes pages: no signer is alerted until someone ticks
  // "Ready for signature".
  manual_release?: boolean
  released?: boolean
  released_by?: string
  released_at?: string
}

// User display name cache
const userDisplayCache: Record<string, string> = {}

async function resolveUserLabels(usernames: string[]): Promise<void> {
  const unknown = usernames.filter((u) => !(u in userDisplayCache))
  if (unknown.length === 0) return
  try {
    const resp = await fetch(`/api/users/display?users=${encodeURIComponent(unknown.join(","))}`)
    if (!resp.ok) return
    const data = await resp.json()
    for (const [name, info] of Object.entries(data.users || {})) {
      userDisplayCache[name] = (info as any).label || name
    }
  } catch {
    /* best effort */
  }
}

function getUserLabel(username: string): string {
  return userDisplayCache[username] || username
}

// Scan version_history for the most recent page version at which `user`
// signed as `role` (non-empty signature = cryptographic sign, not a plain
// click-through confirmation). Returns 0 when no signed record exists —
// the caller uses that as "no diff link needed" (first-time review, or a
// state-file predating the rc.3 Confirmations field). We do NOT fall back
// to matching by role assignment only, because the whole point of the
// link is to show a diff since the SPECIFIC content the user endorsed.
function findLastSignatureVersion(
  history: NonNullable<ReviewflowStatus["version_history"]>,
  user: string,
  role: string
): number {
  let latest = 0
  for (const vr of history) {
    if (!vr.confirmations) continue
    for (const c of vr.confirmations) {
      if (c.role !== role || c.user !== user) continue
      if (!c.signature) continue
      if (c.page_version > latest) latest = c.page_version
    }
  }
  return latest
}

// isVersionTagAlreadyValidated returns true when the given version tag
// has previously been FULLY VALIDATED in the page's history. Partial-
// signature snapshots (rc.3+) also land in version_history but do NOT
// count — they're bookkeeping for signatures that got wiped between
// edits, not records of completed validations. Treating a partial as
// a validation was the SOP01/TPL13 bug: an author who confirmed
// their own role, got the next edit wipe, then saw "version 2.0 was
// already validated" even though no one else had signed yet.
//
// Signal priority:
//   is_validated === true   — new (rc.3+) snapshots carry this explicitly.
//   legacy fallback          — pre-rc.3 fully-validated records lack the
//                              flag; they're the ones whose confirmed_by
//                              covers every CURRENT role. If any current
//                              role is missing from confirmed_by the entry
//                              can't have been a full validation.
//
// `currentRoles` is the live Roles map on the page (role → user). Empty
// Roles means no reviewflow directive, in which case nothing can be
// stale.
export function isVersionTagAlreadyValidated(
  versionHistory: NonNullable<ReviewflowStatus["version_history"]>,
  versionTag: string,
  currentRoles: Record<string, string>
): boolean {
  if (!versionTag) return false
  const required = Object.keys(currentRoles)
  if (required.length === 0) return false
  for (const vr of versionHistory) {
    if (vr.version_tag !== versionTag) continue
    if (vr.is_validated === true) return true
    const confirmed = vr.confirmed_by || {}
    if (required.every((r) => r in confirmed)) return true
  }
  return false
}

// rowMatchesSignedBy is the `{reviewflow-query signed_by=X}` predicate.
// A row survives when X holds a role on the page AND that role is NOT
// in missing_roles for the current version — i.e. X's seat has been
// confirmed since the last content change. Mirror image of
// rowMatchesUser(when="missing"): one is "X still owes a signature on
// this version", the other is "X has already signed on this version".
//
// A user with no role on the page never matches. The confirmation
// counts regardless of whether it was a cryptographic signature or a
// click-only confirmation; use the per-page SignedRoles field when
// you need the crypto distinction (list_reviewflows exposes it
// through the status payload).
export function rowMatchesSignedBy(status: ReviewflowStatus, user: string): boolean {
  const rolesForUser: string[] = []
  for (const [role, assignee] of Object.entries(status.roles || {})) {
    if (assignee === user) rolesForUser.push(role)
  }
  if (rolesForUser.length === 0) return false
  const missing = status.missing_roles || {}
  // At least one of the user's seats on this page is NOT in missing_roles.
  return rolesForUser.some((r) => !(r in missing))
}

// rowMatchesUser is the `{reviewflow-query user=X when=Y}` predicate.
// A row survives when the user holds a role on the page AND the row
// meets the `when` narrowing:
//   any     — user has any assigned role (widest filter)
//   missing — user's assigned role is in missing_roles for the current version
//   next    — user's role is in next_roles (parallel: any missing role;
//             sequential: only the head of the queue). This is the
//             "queue-position-aware ready-to-sign" case.
//   overdue — user's assigned role is overdue AND missing
// A user with no role on a page never matches, regardless of `when`.
export function rowMatchesUser(status: ReviewflowStatus, user: string, when: string): boolean {
  const rolesForUser: string[] = []
  for (const [role, assignee] of Object.entries(status.roles || {})) {
    if (assignee === user) rolesForUser.push(role)
  }
  if (rolesForUser.length === 0) return false
  if (when === "any") return true

  const missing = status.missing_roles || {}
  const missingForUser = rolesForUser.filter((r) => r in missing)
  if (missingForUser.length === 0) return false // when=missing/next/overdue all require missing

  if (when === "missing") return true
  if (when === "overdue") {
    const overdue = new Set(status.overdue_roles || [])
    return missingForUser.some((r) => overdue.has(r))
  }
  if (when === "next") {
    const next = new Set(status.next_roles || [])
    return missingForUser.some((r) => next.has(r))
  }
  return true
}

const gate = {
  async getStatus(pagePath: string, version?: number | null): Promise<ReviewflowStatus> {
    const cleanPath = pagePath.replace(/^\/+/, "")
    const vParam = version ? `?v=${version}` : ""
    const resp = await fetch(`${API_BASE}/status/${cleanPath}${vParam}`)
    if (!resp.ok) throw new Error(`reviewflow status: ${resp.status}`)
    return resp.json()
  },

  async confirm(
    pagePath: string,
    role: string,
    sigData?: { signature: string; certificate: string; digest: string } | null
  ): Promise<ReviewflowStatus> {
    const cleanPath = pagePath.replace(/^\/+/, "")
    const body: any = { role }
    if (sigData) {
      body.signature = sigData.signature
      body.certificate = sigData.certificate
      body.digest = sigData.digest
    }
    const resp = await fetch(`${API_BASE}/confirm/${cleanPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const b = await resp.json().catch(() => ({}))
      throw new Error(b.error || `reviewflow confirm: ${resp.status}`)
    }
    return resp.json()
  },

  async setReleased(pagePath: string, released: boolean): Promise<ReviewflowStatus> {
    const cleanPath = pagePath.replace(/^\/+/, "")
    const resp = await fetch(`${API_BASE}/release/${cleanPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ released }),
    })
    if (!resp.ok) {
      const b = await resp.json().catch(() => ({}))
      throw new Error(b.error || `reviewflow release: ${resp.status}`)
    }
    return resp.json()
  },
}

// --- NodeView ---

class ReviewflowNodeView {
  dom: HTMLElement
  private node: PMNode
  private view: EditorView
  private getPos: () => number | undefined
  private status: ReviewflowStatus | null = null
  private loading = false
  private historyVersion: number | null = null
  private userHasKey = false

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos

    // Capture history version context (set by viewVersion() in main.js).
    this.historyVersion = (window as any).__sargonViewingVersion ?? null

    this.dom = document.createElement("div")
    this.dom.className = "gowiki-reviewflow"
    this.dom.contentEditable = "false"

    this.render()
    this.fetchStatus()
    // Check if the current user has a signing key.
    const currentUser = (window as any).__sargonCurrentUser?.username
    if (currentUser) {
      hasKey(currentUser)
        .then((has) => {
          this.userHasKey = has
          if (this.status) this.render() // re-render with updated button label
        })
        .catch(() => {})
    }
  }

  private render() {
    this.dom.innerHTML = ""

    let roles: Record<string, string> = {}
    try {
      roles = JSON.parse(this.node.attrs.roles || "{}")
    } catch {
      /* ignore */
    }

    const version = this.node.attrs.version || ""
    // Declared order = signing order.
    const roleEntries = Object.entries(roles)
    // If the backend has no state yet (no roles in status), treat all roles as pending.
    const backendHasState = this.status != null && Object.keys(this.status.roles || {}).length > 0
    const missingRoles = backendHasState ? this.status!.missing_roles || {} : roles
    const overdueSet = new Set(this.status?.overdue_roles || [])
    const currentUser = (window as any).__sargonCurrentUser?.username || ""
    const isValidated = backendHasState && this.status!.is_fully_validated === true
    const manualRelease = this.status?.manual_release ?? isTruthy(this.node.attrs.manual_release)
    const awaitingRelease = manualRelease && !this.status?.released

    // Only flag a stale tag if a PRIOR fully-validated snapshot shared
    // it. The predicate ignores partial snapshots so an author
    // mid-validation isn't told to bump the tag. See
    // isVersionTagAlreadyValidated for the signal priority.
    const versionHistory = this.status?.version_history || []
    const versionTagStale =
      !this.historyVersion && !isValidated && isVersionTagAlreadyValidated(versionHistory, version, roles)

    // Wrapper with border color
    const wrapper = document.createElement("div")
    wrapper.className = "gowiki-rf-wrapper"
    if (isValidated) wrapper.classList.add("gowiki-rf-wrapper--validated")
    else if (overdueSet.size > 0) wrapper.classList.add("gowiki-rf-wrapper--overdue")

    // Header row
    const header = document.createElement("div")
    header.className = "gowiki-rf-header"
    const headerLabel = document.createElement("span")
    headerLabel.className = "gowiki-rf-header-label"
    headerLabel.textContent = "Reviewflow"
    header.appendChild(headerLabel)
    if (version) {
      const tag = document.createElement("span")
      tag.className = "gowiki-rf-version-tag"
      tag.textContent = version
      header.appendChild(tag)
    }
    if (isValidated) {
      const badge = document.createElement("span")
      badge.className = "gowiki-rf-validated-badge"
      badge.textContent = "\u2714 Validated"
      header.appendChild(badge)
    } else if (roleEntries.length > 0 && !this.loading) {
      const draft = document.createElement("span")
      draft.className = "gowiki-rf-draft-badge"
      draft.textContent = "DRAFT"
      header.appendChild(draft)
      // Inline pointer to the last validated version, sized to
      // match the DRAFT badge so readers see it at first glance.
      // Involved viewers only — uninvolved get the validated version
      // served transparently by the backend gate.
      const validatedVersion = this.status?.validated_page_version || 0
      if (validatedVersion > 0) {
        const arrow = document.createElement("span")
        arrow.className = "gowiki-rf-draft-see-arrow"
        arrow.textContent = "→ See "
        header.appendChild(arrow)
        const link = document.createElement("a")
        link.className = "gowiki-rf-draft-see-link"
        link.href = `${window.location.pathname}?v=${validatedVersion}`
        link.textContent = "VALID VERSION"
        header.appendChild(link)
      }
    }
    if (this.loading) {
      const loadEl = document.createElement("span")
      loadEl.className = "gowiki-rf-loading"
      loadEl.textContent = "Loading\u2026"
      header.appendChild(loadEl)
    }
    wrapper.appendChild(header)

    // Warning: version tag already used
    if (versionTagStale) {
      const warn = document.createElement("div")
      warn.className = "gowiki-rf-stale-warning"
      warn.textContent = `\u26A0 Version "${version}" was already validated. Update the version tag before approving.`
      wrapper.appendChild(warn)
    }

    // Draft-with-published pointer now lives inline next to the
    // DRAFT badge (see the header block above) \u2014 a discrete grey
    // block below the header lost too much attention when the whole
    // point is that the reader shouldn't confuse this WIP with the
    // authoritative version.

    if (manualRelease && !isValidated && !this.historyVersion && roleEntries.length > 0) {
      wrapper.appendChild(this.renderReleaseBar(roleEntries, missingRoles, currentUser, awaitingRelease))
    }

    // Table
    if (roleEntries.length > 0) {
      const table = document.createElement("table")
      table.className = "gowiki-rf-table"

      const thead = document.createElement("thead")
      const thRow = document.createElement("tr")
      for (const h of ["Role", "Assignee", "Status", ""]) {
        const th = document.createElement("th")
        th.textContent = h
        thRow.appendChild(th)
      }
      thead.appendChild(thRow)
      table.appendChild(thead)

      const tbody = document.createElement("tbody")
      for (const [role, user] of roleEntries) {
        const tr = document.createElement("tr")
        const isMissing = role in missingRoles
        const isOverdue = overdueSet.has(role)

        // Role name
        const tdRole = document.createElement("td")
        tdRole.className = "gowiki-rf-cell-role"
        tdRole.textContent = role.charAt(0).toUpperCase() + role.slice(1)
        tr.appendChild(tdRole)

        // Assignee
        const tdUser = document.createElement("td")
        tdUser.textContent = getUserLabel(user)
        if (getUserLabel(user) !== user) {
          tdUser.title = user // show login on hover
        }
        tr.appendChild(tdUser)

        // Status
        const tdStatus = document.createElement("td")
        if (isOverdue) {
          tdStatus.className = "gowiki-rf-status--overdue"
          tdStatus.textContent = "\u26A0 Overdue"
        } else if (isMissing && awaitingRelease) {
          tdStatus.className = "gowiki-rf-status--unreleased"
          tdStatus.textContent = "Not released"
        } else if (isMissing) {
          tdStatus.className = "gowiki-rf-status--pending"
          tdStatus.textContent = "\u23F3 Pending"
        } else {
          const isSigned = this.status?.signed_roles?.includes(role)
          tdStatus.className = "gowiki-rf-status--confirmed"
          tdStatus.textContent = isSigned ? "\uD83D\uDD12 Signed" : "\u2714 Confirmed"
        }
        tr.appendChild(tdStatus)

        // Action
        const tdAction = document.createElement("td")
        if (isMissing && user === currentUser && !versionTagStale && !this.historyVersion && !awaitingRelease) {
          const btn = document.createElement("button")
          btn.className = "gowiki-rf-confirm-btn"
          // Show "Sign & Confirm" if signing is enabled and user has a key.
          if (this.status?.signing_enabled && this.userHasKey) {
            btn.textContent = "\uD83D\uDD12 Sign & Confirm"
          } else if (this.status?.signing_required && !this.userHasKey) {
            btn.textContent = "Signing key required"
            btn.disabled = true
          } else {
            btn.textContent = "Confirm"
          }
          btn.addEventListener("click", (e) => {
            e.preventDefault()
            e.stopPropagation()
            this.doConfirm(role)
          })
          tdAction.appendChild(btn)

          // "Diff since your last signature" side link \u2014 when a prior
          // signature by this user for this role was invalidated by a
          // content change, offer a one-click view of what actually moved
          // between the version they signed and the current one. Skip if
          // this is a first-time review (no prior signature) or if the
          // history entries don't carry Confirmations (old state files
          // pre-rc.3 have only the confirmed_by summary).
          const lastSignedVersion = findLastSignatureVersion(versionHistory, currentUser, role)
          if (lastSignedVersion > 0 && lastSignedVersion < (this.status?.current_page_version ?? 0)) {
            const diffLink = document.createElement("a")
            diffLink.className = "gowiki-rf-diff-link"
            diffLink.href = "#"
            diffLink.textContent = `diff since v${lastSignedVersion}`
            diffLink.title = "What changed since your previous signature was invalidated"
            diffLink.addEventListener("click", (e) => {
              e.preventDefault()
              e.stopPropagation()
              const show = (window as any).showDiff
              if (typeof show === "function") show(lastSignedVersion, 0)
            })
            tdAction.appendChild(document.createTextNode(" "))
            tdAction.appendChild(diffLink)
          }
        }
        tr.appendChild(tdAction)

        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      wrapper.appendChild(table)
    }

    this.dom.appendChild(wrapper)
  }

  // "Ready for signature" control for manual_release pages. The backend
  // decides who may toggle it (first signer or edit rights) and refuses
  // withdrawal once a signature exists on the current version; the
  // checkbox mirrors that last rule so it doesn't offer a dead action.
  private renderReleaseBar(
    roleEntries: [string, string][],
    missingRoles: Record<string, string>,
    currentUser: string,
    awaitingRelease: boolean
  ): HTMLElement {
    const bar = document.createElement("div")
    bar.className = "gowiki-rf-release"
    if (awaitingRelease) bar.classList.add("gowiki-rf-release--pending")

    const label = document.createElement("label")
    label.className = "gowiki-rf-release-label"
    const cb = document.createElement("input")
    cb.type = "checkbox"
    cb.checked = !awaitingRelease
    const anySigned = roleEntries.some(([role]) => !(role in missingRoles))
    if (!currentUser) {
      cb.disabled = true
      label.title = "Log in to release this document for signature."
    } else if (!awaitingRelease && anySigned) {
      cb.disabled = true
      label.title = "A signature is already recorded on this version, so the release can no longer be withdrawn."
    }
    cb.addEventListener("change", (e) => {
      e.stopPropagation()
      void this.doSetReleased(cb.checked)
    })
    label.appendChild(cb)
    label.appendChild(document.createTextNode(" Ready for signature"))
    bar.appendChild(label)

    const note = document.createElement("span")
    note.className = "gowiki-rf-release-note"
    if (awaitingRelease) {
      note.textContent = "Draft \u2014 not yet released for signature. Signers are notified once this box is ticked."
    } else {
      const by = this.status?.released_by ? getUserLabel(this.status.released_by) : ""
      const at = this.status?.released_at ? new Date(this.status.released_at).toLocaleDateString() : ""
      note.textContent = by ? `Released by ${by}${at ? " on " + at : ""}` : "Released for signature"
    }
    bar.appendChild(note)
    return bar
  }

  private async doSetReleased(released: boolean) {
    try {
      this.status = await gate.setReleased(window.location.pathname, released)
    } catch (err: any) {
      alert((released ? "Release failed: " : "Withdraw failed: ") + (err?.message || err))
    }
    if (this.status?.released_by) await resolveUserLabels([this.status.released_by])
    this.render()
    this.updatePageBackground()
  }

  private async fetchStatus() {
    const pagePath = window.location.pathname
    this.loading = true
    this.render()
    try {
      this.status = await gate.getStatus(pagePath, this.historyVersion)
    } catch {
      // Status not available — show roles without status
    }
    // Resolve display names for all role assignees
    let roles: Record<string, string> = {}
    try {
      roles = JSON.parse(this.node.attrs.roles || "{}")
    } catch {}
    const usernames = Object.values(roles).filter((u) => u)
    if (usernames.length > 0) {
      await resolveUserLabels(usernames)
    }
    this.loading = false
    this.render()
    this.updatePageBackground()
  }

  /** Apply light red background to the content area when page is not validated. */
  private updatePageBackground() {
    // Don't change page background when viewing a historical version.
    if (this.historyVersion) return
    const contentRoot = document.getElementById("content") || document.querySelector(".ProseMirror")
    if (!contentRoot) return
    const hasRoles =
      Object.keys(
        (() => {
          try {
            return JSON.parse(this.node.attrs.roles || "{}")
          } catch {
            return {}
          }
        })()
      ).length > 0
    if (hasRoles && !this.status?.is_fully_validated) {
      contentRoot.classList.add("gowiki-rf-page-invalid")
    } else {
      contentRoot.classList.remove("gowiki-rf-page-invalid")
    }
  }

  private async doConfirm(role: string) {
    const pagePath = window.location.pathname
    try {
      // Attempt cryptographic signing if enabled and user has a key.
      let sigData: { signature: string; certificate: string; digest: string } | null = null
      if (this.status?.signing_enabled && this.userHasKey) {
        const currentUser = (window as any).__sargonCurrentUser?.username
        if (currentUser) {
          try {
            const markdown = (window as any).__sargonCurrentMarkdown?.() || ""
            sigData = await signConfirmation(currentUser, markdown)
            if (!sigData) {
              console.error("reviewflow: signConfirmation returned null — key or certificate not found")
            }
          } catch (sigErr: any) {
            console.error("reviewflow: signing failed:", sigErr)
            if (this.status?.signing_required) {
              alert("Signing failed: " + (sigErr?.message || sigErr) + "\n\nTry regenerating your signing key.")
              return
            }
          }
        }
      }
      if (this.status?.signing_required && !sigData) {
        alert(
          "Confirm failed: cryptographic signature required but signing failed.\n\nCheck your signing key in the user menu."
        )
        return
      }
      this.status = await gate.confirm(pagePath, role, sigData)
      this.render()
      this.updatePageBackground()
    } catch (err: any) {
      console.error("reviewflow confirm failed:", err)
      if (err?.message) alert("Confirm failed: " + err.message)
    }
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  stopEvent(event: Event): boolean {
    const type = event.type
    if (type === "mousedown" || type === "mouseup" || type === "click") return false
    return true
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy() {
    const contentRoot = document.getElementById("content") || document.querySelector(".ProseMirror")
    if (contentRoot) contentRoot.classList.remove("gowiki-rf-page-invalid")
  }
}

// --- Styles ---

const reviewflowStyles = `
.gowiki-reviewflow {
  margin: 8px 0;
}

.gowiki-rf-release {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  margin: 6px 0 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--gw-color-surface-alt, rgba(0, 0, 0, 0.03));
  font-size: 13px;
}

.gowiki-rf-release--pending {
  background: var(--gw-color-warning-bg);
}

.gowiki-rf-release-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  cursor: pointer;
}

.gowiki-rf-release-note {
  color: var(--gw-color-muted);
}

.gowiki-rf-status--unreleased {
  color: var(--gw-color-muted);
  font-style: italic;
}

.gowiki-rf-wrapper {
  border: 2px solid var(--gw-color-border);
  border-radius: 8px;
  background: var(--gw-color-surface);
  color: var(--gw-color-text);
}

.gowiki-rf-wrapper--validated {
  border-color: var(--gw-color-success);
}

.gowiki-rf-wrapper--overdue {
  border-color: var(--gw-color-warning);
}

.gowiki-rf-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  background: var(--gw-color-table-head-bg);
  color: var(--gw-color-table-head-fg);
  border-bottom: 1px solid var(--gw-color-border);
  border-radius: 6px 6px 0 0;
}

.gowiki-rf-wrapper--validated .gowiki-rf-header {
  background: var(--gw-color-success-bg);
  color: var(--gw-color-success);
  border-bottom-color: var(--gw-color-border);
}

.gowiki-rf-header-label {
  font-weight: 600;
  font-size: 13px;
  color: inherit;
  opacity: 0.9;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.gowiki-rf-version-tag {
  background: var(--gw-color-info-bg);
  color: var(--gw-color-info);
  padding: 1px 8px;
  border-radius: 10px;
  font-weight: 600;
  font-size: 13px;
}

.gowiki-rf-validated-badge {
  color: var(--gw-color-success);
  font-weight: 600;
  font-size: 13px;
}

.gowiki-rf-draft-badge {
  color: var(--gw-color-error);
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 1px;
}

.gowiki-rf-stale-warning {
  padding: 6px 14px;
  background: var(--gw-color-warning-bg);
  color: var(--gw-color-warning);
  font-size: 13px;
  border-bottom: 1px solid var(--gw-color-border);
}

.gowiki-rf-draft-see-arrow {
  color: var(--gw-color-muted);
  font-weight: 500;
  font-size: 15px;
  margin-left: 4px;
}
.gowiki-rf-draft-see-link {
  color: var(--gw-color-success);
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 1px;
  text-decoration: none;
}
.gowiki-rf-draft-see-link:hover {
  text-decoration: underline;
}

.gowiki-rf-loading {
  color: var(--gw-color-subtle);
  font-size: 12px;
  font-style: italic;
}

.gowiki-rf-table {
  border-collapse: collapse;
  font-size: 14px;
  margin: 0.3em !important;
  border-bottom: thin solid var(--gw-color-border);
  color: var(--gw-color-text);
}

.gowiki-rf-table th {
  text-align: left;
  padding: 4px 14px;
  font-weight: 600;
  font-size: 12px;
  color: var(--gw-color-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  border-bottom: 1px solid var(--gw-color-border);
}

.gowiki-rf-table td {
  padding: 5px 14px;
  color: var(--gw-color-text);
  border-bottom: 1px solid var(--gw-color-border-soft);
}

.gowiki-rf-table tr:last-child td {
  border-bottom: none;
}

.gowiki-rf-cell-role {
  font-weight: 500;
}

.gowiki-rf-status--confirmed {
  color: var(--gw-color-success);
}

.gowiki-rf-status--pending {
  color: var(--gw-color-muted);
}

.gowiki-rf-status--overdue {
  color: var(--gw-color-error);
  font-weight: 600;
}

.gowiki-rf-confirm-btn {
  background: var(--gw-color-primary);
  color: var(--gw-color-primary-fg);
  border: none;
  border-radius: var(--gw-radius-sm);
  padding: 4px 12px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}

.gowiki-rf-confirm-btn:hover {
  background: var(--gw-color-primary-hover);
}

.gowiki-rf-diff-link {
  color: var(--gw-color-muted);
  font-size: 11px;
  text-decoration: underline;
  cursor: pointer;
  white-space: nowrap;
}
.gowiki-rf-diff-link:hover {
  color: var(--gw-color-text);
}

#app.gowiki-editing .gowiki-reviewflow.ProseMirror-selectednode {
  outline: 2px solid #ffd43b;
  outline-offset: 1px;
}

.gowiki-rf-page-invalid {
  background: var(--gw-color-invalid-bg, #fff5f5) !important;
}
`

// --- Plugin ---

// --- Reviewflow Query NodeView ---

class ReviewflowQueryNodeView {
  dom: HTMLElement
  private node: PMNode

  constructor(node: PMNode, _view: EditorView, _getPos: () => number | undefined) {
    this.node = node
    this.dom = document.createElement("div")
    this.dom.className = "gowiki-reviewflow-query"
    this.dom.contentEditable = "false"
    this.fetchAndRender()
  }

  private resolvePathPrefix(): string {
    const raw = this.node.attrs.path || ""
    if (raw) return raw.replace(/^\/+/, "")
    // Default: namespace of the current page
    const pathname = window.location.pathname
    const loc = pathname.replace(/^\/+|\/+$/g, "")
    const parts = loc.split("/")
    if (!pathname.endsWith("/")) parts.pop() // remove page name, keep namespace
    return parts.join("/")
  }

  private async fetchAndRender() {
    const path = this.resolvePathPrefix()
    const statusFilter = this.node.attrs.status || "draft"
    // User filter: "@me" resolves to the current viewer; empty means no
    // user filter (path/status only). "when" narrows further:
    //   any     — user has any assigned role on the page
    //   missing — user's role is missing (they haven't confirmed the current version)
    //   next    — user's role is actionable RIGHT NOW (head of the sequential
    //             queue, or any missing role in parallel mode) — the
    //             "what should I sign now?" case
    //   overdue — user's role is missing AND overdue
    const rawUser = String(this.node.attrs.user || "").trim()
    const currentUser = (window as any).__sargonCurrentUser?.username || ""
    const userFilter = rawUser === "@me" ? currentUser : rawUser
    const whenFilter = String(this.node.attrs.when || "any").toLowerCase()
    // signed_by is INDEPENDENT of user/when — it narrows to pages where
    // the given user has already confirmed one of their assigned roles
    // on the current version. Together they answer "docs waiting on me
    // where Etienne already signed" as `user=@me when=next
    // signed_by=etienne.formstecher`. @me resolves the same way.
    const rawSignedBy = String(this.node.attrs.signed_by || "").trim()
    const signedByFilter = rawSignedBy === "@me" ? currentUser : rawSignedBy

    this.dom.innerHTML = '<div class="gowiki-rfq-loading">Loading reviewflow status...</div>'

    try {
      // 1. Fetch all pages under the path
      const nsResp = await fetch(`/api/ai/v1/namespace/${path}?depth=0&include_meta=true`)
      if (!nsResp.ok) {
        this.dom.innerHTML = '<div class="gowiki-rfq-error">Failed to load pages</div>'
        return
      }
      const nsData = await nsResp.json()
      const pages: any[] = nsData.pages || []

      // 2. Fetch reviewflow status for each page (in parallel)
      const statusPromises = pages.map(async (p: any) => {
        const cleanPath = p.path.replace(/^\/+/, "")
        try {
          const resp = await fetch(`/api/plugin/reviewflow/v1/status/${cleanPath}`)
          if (!resp.ok) return null
          const status = await resp.json()
          if (!status.roles || Object.keys(status.roles).length === 0) return null
          return { page: p, status }
        } catch {
          return null
        }
      })
      const results = (await Promise.all(statusPromises)).filter(Boolean) as any[]

      // 3. Filter by status
      let filtered = results.filter((r) => {
        const isValidated = r.status.is_fully_validated === true
        if (statusFilter === "draft") return !isValidated
        if (statusFilter === "validated") return isValidated
        return true // "all"
      })

      // 4. Filter by user + when (when is ignored when user is empty)
      if (userFilter) {
        filtered = filtered.filter((r) => rowMatchesUser(r.status, userFilter, whenFilter))
      }

      // 5. Filter by signed_by (independent of user/when).
      if (signedByFilter) {
        filtered = filtered.filter((r) => rowMatchesSignedBy(r.status, signedByFilter))
      }

      // 4. Sort by date (most recent first)
      filtered.sort((a, b) => {
        const da = a.page.last_modified || ""
        const db = b.page.last_modified || ""
        return db.localeCompare(da)
      })

      this.dom.innerHTML = ""

      // Header
      const header = document.createElement("div")
      header.className = "gowiki-rfq-header"
      const label =
        statusFilter === "draft"
          ? "Documents pending validation"
          : statusFilter === "validated"
            ? "Validated documents"
            : "All reviewflow documents"
      let headerText = `Reviewflow: ${label} (/${path})`
      if (userFilter) {
        const userLabel = getUserLabel(userFilter)
        const suffix =
          whenFilter === "next"
            ? "ready to sign now"
            : whenFilter === "overdue"
              ? "overdue"
              : whenFilter === "missing"
                ? "awaiting confirmation"
                : "with an assigned role"
        headerText += ` — ${userLabel} · ${suffix}`
      }
      if (signedByFilter) {
        // Independent clause (not combined with the user suffix with
        // another dash) because it's a separate narrowing — reader
        // sees exactly which filters are active.
        headerText += ` · signed by ${getUserLabel(signedByFilter)}`
      }
      header.textContent = headerText
      this.dom.appendChild(header)

      if (filtered.length === 0) {
        const empty = document.createElement("div")
        empty.className = "gowiki-rfq-empty"
        empty.textContent = statusFilter === "draft" ? "No documents pending validation." : "No documents found."
        this.dom.appendChild(empty)
        return
      }

      // Resolve user display names
      const allUsers = new Set<string>()
      for (const r of filtered) {
        for (const user of Object.values(r.status.roles || {})) allUsers.add(user as string)
        if (r.page.author) allUsers.add(r.page.author)
      }
      const unknownUsers = [...allUsers].filter((u) => !(u in userDisplayCache))
      if (unknownUsers.length > 0) {
        await resolveUserLabels(unknownUsers)
      }

      // Table
      const table = document.createElement("table")
      table.className = "gowiki-rfq-table"
      const thead = document.createElement("thead")
      const hr = document.createElement("tr")
      for (const h of ["Page", "Version", "Date", "Author", "Status", "Confirmations"]) {
        const th = document.createElement("th")
        th.textContent = h
        hr.appendChild(th)
      }
      thead.appendChild(hr)
      table.appendChild(thead)

      const tbody = document.createElement("tbody")
      for (const r of filtered) {
        const tr = document.createElement("tr")

        // Page link
        const tdPage = document.createElement("td")
        const a = document.createElement("a")
        a.href = r.page.path
        a.textContent = r.page.title || r.page.path
        a.className = "gowiki-link-exists"
        tdPage.appendChild(a)
        tr.appendChild(tdPage)

        // Version tag
        const tdVersion = document.createElement("td")
        if (r.status.version_tag) {
          if (r.status.is_fully_validated && r.status.validated_page_version) {
            const va = document.createElement("a")
            va.href = `${r.page.path}?v=${r.status.validated_page_version}`
            va.textContent = r.status.version_tag
            va.className = "gowiki-rfq-version-link"
            tdVersion.appendChild(va)
          } else {
            tdVersion.textContent = r.status.version_tag
          }
        }
        tr.appendChild(tdVersion)

        // Date
        const tdDate = document.createElement("td")
        tdDate.textContent = r.page.last_modified ? new Date(r.page.last_modified).toLocaleDateString() : ""
        tr.appendChild(tdDate)

        // Author
        const tdAuthor = document.createElement("td")
        tdAuthor.textContent = r.page.author ? getUserLabel(r.page.author) : ""
        tr.appendChild(tdAuthor)

        // Status badge
        const tdStatus = document.createElement("td")
        const badge = document.createElement("span")
        if (r.status.is_fully_validated) {
          badge.className = "gowiki-rfq-badge gowiki-rfq-badge-validated"
          badge.textContent = "Validated"
        } else {
          badge.className = "gowiki-rfq-badge gowiki-rfq-badge-draft"
          badge.textContent = "Draft"
        }
        tdStatus.appendChild(badge)
        tr.appendChild(tdStatus)

        // Confirmations
        const tdConf = document.createElement("td")
        const roles = r.status.roles || {}
        const missingRoles = r.status.missing_roles || {}
        const confirmations = r.status.version_history || []
        // Find confirmations for this version from the raw status
        const fragments: string[] = []
        for (const [role, user] of Object.entries(roles)) {
          const isMissing = role in missingRoles
          const label = getUserLabel(user as string)
          if (isMissing) {
            fragments.push(`${role}: ${label} \u23F3`)
          } else {
            fragments.push(`${role}: ${label} \u2713`)
          }
        }
        tdConf.textContent = fragments.join(", ")
        tdConf.style.fontSize = "0.85em"
        tr.appendChild(tdConf)

        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      this.dom.appendChild(table)
    } catch (err) {
      this.dom.innerHTML = '<div class="gowiki-rfq-error">Failed to load reviewflow data</div>'
    }
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    if (node.attrs.path !== this.node.attrs.path || node.attrs.status !== this.node.attrs.status) {
      this.node = node
      this.fetchAndRender()
      return true
    }
    this.node = node
    return true
  }

  stopEvent(event: Event): boolean {
    const type = event.type
    if (type === "mousedown" || type === "mouseup" || type === "click") return false
    return true
  }

  ignoreMutation(): boolean {
    return true
  }
}

// --- Reviewflow Query Styles ---

const rfqStyles = `
.gowiki-reviewflow-query {
  margin: 0.5em 0;
}

.gowiki-rfq-loading {
  color: #999;
  font-style: italic;
  padding: 8px;
}

.gowiki-rfq-error {
  color: #c62828;
  padding: 8px;
}

.gowiki-rfq-empty {
  color: #666;
  padding: 8px;
  font-style: italic;
}

.gowiki-rfq-header {
  font-size: 11px;
  color: #636e72;
  margin-bottom: 4px;
  font-family: monospace;
}

.gowiki-rfq-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.gowiki-rfq-table th {
  background: #f1f3f5;
  text-align: left;
  padding: 6px 10px;
  font-weight: 600;
  font-size: 13px;
  border-bottom: 2px solid #dee2e6;
}

.gowiki-rfq-table td {
  padding: 6px 10px;
  border-bottom: 1px solid #eee;
}

.gowiki-rfq-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
}

.gowiki-rfq-badge-draft {
  background: #fff3e0;
  color: #e65100;
}

.gowiki-rfq-badge-validated {
  background: #e8f5e9;
  color: #2e7d32;
}

.gowiki-rfq-version-link {
  display: inline-block;
  background: var(--gw-color-info-bg);
  color: var(--gw-color-info);
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}

.gowiki-rfq-version-link:hover {
  background: var(--gw-color-info-hover-bg);
}

#app.gowiki-editing .gowiki-reviewflow-query {
  background: #f8f9fa;
  border: 1px solid #dee2e6;
  border-radius: 4px;
  padding: 8px;
}

#app.gowiki-editing .gowiki-reviewflow-query.ProseMirror-selectednode {
  outline: 2px solid #ffd43b;
  outline-offset: 1px;
}
`

export const reviewflowPlugin: WikiPlugin = {
  register(reg) {
    // Schema node
    reg.registerSchema({
      nodes: {
        reviewflow: {
          group: "block",
          atom: true,
          attrs: {
            version: { default: "" },
            roles: { default: "{}" },
            parallel: { default: "" },
            manual_release: { default: "" },
          },
          toDOM(node: PMNode) {
            return [
              "div",
              {
                class: "gowiki-reviewflow",
                "data-version": node.attrs.version || "",
              },
              `Reviewflow: ${node.attrs.version || "(no version)"}`,
            ]
          },
          parseDOM: [
            {
              tag: "div.gowiki-reviewflow",
              getAttrs(dom: HTMLElement) {
                return {
                  version: dom.getAttribute("data-version") || "",
                }
              },
            },
          ],
        },
      },
    })

    // Self-contained directive: {reviewflow version=X author=alice reviewer=bob}
    // collectExtra: true allows arbitrary role keys (author, reviewer, etc.)
    reg.registerSelfContainedDirective("reviewflow", {
      tokenType: "reviewflow",
      nodeType: "reviewflow",
      properties: reviewflowProperties,
      collectExtra: true,
    })

    // Markdown → PM: handle the synthetic "reviewflow" token
    reg.registerText("reviewflow", {
      run(ctx, tok) {
        const attrs = tok.meta?.attrs ?? {}
        // Separate version from roles
        const version = attrs.version ?? ""
        // Roles keep source order: the backend hands out review tasks
        // in that order.
        const roles: Record<string, string> = {}
        for (const [k, v] of Object.entries(attrs)) {
          if (!OPTION_KEYS.has(k)) {
            roles[k] = String(v)
          }
        }
        ctx.push(
          ctx.schema.nodes.reviewflow.create({
            version,
            roles: JSON.stringify(roles),
            parallel: isTruthy(attrs.parallel as string) ? "true" : "",
            manual_release: isTruthy(attrs.manual_release as string) ? "yes" : "",
          })
        )
      },
    })

    // PM → Markdown: serialize reviewflow node back to directive syntax
    reg.registerPMNode("reviewflow", {
      print(node) {
        const parts: string[] = []

        // version always first
        const version = node.attrs.version || ""
        if (version) {
          parts.push(`version=${version}`)
        }

        // Roles in declared order — it is the signing order, so it
        // must survive a visual-mode save unchanged.
        let roles: Record<string, string> = {}
        try {
          roles = JSON.parse(node.attrs.roles || "{}")
        } catch {
          /* ignore */
        }

        for (const key of Object.keys(roles)) {
          parts.push(`${key}=${roles[key]}`)
        }

        // Options after the roles, in a fixed order.
        if (isTruthy(node.attrs.parallel)) parts.push("parallel=true")
        if (isTruthy(node.attrs.manual_release)) parts.push("manual_release=yes")

        if (parts.length === 0) {
          return "{reviewflow}\n\n"
        }
        return `{reviewflow ${parts.join(" ")}}\n\n`
      },
    })

    // Editor plugin: NodeView
    reg.registerEditorPlugin((_schema: Schema) => {
      return new PMPlugin({
        key: new PluginKey("gowiki.reviewflow"),
        props: {
          nodeViews: {
            reviewflow(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new ReviewflowNodeView(node, view, getPos)
            },
          },
        },
      })
    })

    // Command: insert a new reviewflow node and open properties panel
    reg.registerCommand("reviewflow", "insert", (state, dispatch) => {
      const rfType = reg.schema.nodes.reviewflow
      if (!rfType) return false
      if (dispatch) {
        const node = rfType.create({ version: "", roles: "{}" })
        let tr = state.tr.replaceSelectionWith(node)
        const approxPos = tr.mapping.map(state.selection.from)
        let insertedAt: number | null = null
        tr.doc.nodesBetween(Math.max(0, approxPos - 200), Math.min(tr.doc.content.size, approxPos + 5), (n, pos) => {
          if (n.type === rfType) {
            insertedAt = pos
          }
        })
        if (insertedAt !== null) {
          try {
            tr = tr.setSelection(NodeSelection.create(tr.doc, insertedAt))
            tr = enablePropertiesPanel(tr)
          } catch {
            // Leave default selection if NodeSelection fails
          }
        }
        dispatch(tr.scrollIntoView())
      }
      return true
    })

    // ────────────────────────────────────────────────────
    // Reviewflow Query — {reviewflow-query path=... status=...}
    // ────────────────────────────────────────────────────

    const rfqProperties = [
      {
        name: "path",
        label: "Path prefix",
        default: "",
        parse: (raw: string) => raw.trim(),
        serialize: (value: string | null) => String(value ?? ""),
        helpText: "Namespace to scan (empty = current page's namespace)",
      },
      {
        name: "status",
        label: "Status filter",
        default: "draft",
        parse: (raw: string) => {
          const v = raw.trim().toLowerCase()
          return v === "draft" || v === "validated" || v === "all" ? v : "draft"
        },
        serialize: (value: string | null) => String(value ?? "draft"),
        options: [
          { value: "draft", label: "Draft (pending validation)" },
          { value: "validated", label: "Validated" },
          { value: "all", label: "All" },
        ],
      },
      {
        name: "user",
        label: "User filter",
        default: "",
        parse: (raw: string) => raw.trim(),
        serialize: (value: string | null) => String(value ?? ""),
        helpText: "Only pages where this user has a role. Use @me for the current user.",
      },
      {
        name: "when",
        label: "Actionability",
        default: "any",
        parse: (raw: string) => {
          const v = raw.trim().toLowerCase()
          return v === "next" || v === "missing" || v === "overdue" ? v : "any"
        },
        serialize: (value: string | null) => String(value ?? "any"),
        options: [
          { value: "any", label: "Any (user has a role)" },
          { value: "next", label: "Next (user's action is up now)" },
          { value: "missing", label: "Missing (user has not confirmed current version)" },
          { value: "overdue", label: "Overdue (user's deadline has passed)" },
        ],
        helpText: "Combined with 'User filter'. Ignored when user is empty.",
      },
      {
        name: "signed_by",
        label: "Signed by",
        default: "",
        parse: (raw: string) => raw.trim(),
        serialize: (value: string | null) => String(value ?? ""),
        helpText:
          "Only pages where this user has already confirmed one of their roles on the current version. Use @me for the current viewer. Independent of 'User filter' — combine them to answer 'docs waiting on me where Etienne already signed'.",
      },
    ]

    reg.registerSchema({
      nodes: {
        reviewflow_query: {
          group: "block",
          atom: true,
          attrs: {
            path: { default: "" },
            status: { default: "draft" },
            user: { default: "" },
            when: { default: "any" },
            signed_by: { default: "" },
          },
          toDOM(node: PMNode) {
            return [
              "div",
              {
                class: "gowiki-reviewflow-query",
                "data-path": node.attrs.path || "",
                "data-status": node.attrs.status || "draft",
                "data-user": node.attrs.user || "",
                "data-when": node.attrs.when || "any",
                "data-signed-by": node.attrs.signed_by || "",
              },
              `Reviewflow query: ${node.attrs.status || "draft"}`,
            ]
          },
          parseDOM: [
            {
              tag: "div.gowiki-reviewflow-query",
              getAttrs(dom: HTMLElement) {
                return {
                  path: dom.getAttribute("data-path") || "",
                  status: dom.getAttribute("data-status") || "draft",
                  user: dom.getAttribute("data-user") || "",
                  when: dom.getAttribute("data-when") || "any",
                  signed_by: dom.getAttribute("data-signed-by") || "",
                }
              },
            },
          ],
        },
      },
    })

    reg.registerSelfContainedDirective("reviewflow-query", {
      tokenType: "reviewflow_query",
      nodeType: "reviewflow_query",
      properties: rfqProperties,
    })

    reg.registerText("reviewflow_query", {
      run(ctx, tok) {
        const attrs = tok.meta?.attrs ?? {}
        ctx.push(
          ctx.schema.nodes.reviewflow_query.create({
            path: attrs.path ?? "",
            status: attrs.status ?? "draft",
            user: attrs.user ?? "",
            when: attrs.when ?? "any",
            signed_by: attrs.signed_by ?? "",
          })
        )
      },
    })

    reg.registerPMNode("reviewflow_query", {
      print(node) {
        const parts: string[] = []
        if (node.attrs.path) parts.push(`path=${node.attrs.path}`)
        if (node.attrs.status && node.attrs.status !== "draft") {
          parts.push(`status=${node.attrs.status}`)
        }
        if (node.attrs.user) parts.push(`user=${node.attrs.user}`)
        if (node.attrs.when && node.attrs.when !== "any") parts.push(`when=${node.attrs.when}`)
        if (node.attrs.signed_by) parts.push(`signed_by=${node.attrs.signed_by}`)
        return parts.length ? `{reviewflow-query ${parts.join(" ")}}\n\n` : `{reviewflow-query}\n\n`
      },
    })

    reg.registerEditorPlugin((_schema: Schema) => {
      return new PMPlugin({
        key: new PluginKey("gowiki.reviewflow-query"),
        props: {
          nodeViews: {
            reviewflow_query(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new ReviewflowQueryNodeView(node, view, getPos)
            },
          },
        },
      })
    })

    reg.registerCommand("reviewflow-query", "insert", (state, dispatch) => {
      const queryType = reg.schema.nodes.reviewflow_query
      if (!queryType) return false
      if (dispatch) {
        requestInputFocus("path")
        const node = queryType.create({ path: "", status: "draft" })
        let tr = state.tr.replaceSelectionWith(node)
        const approxPos = tr.mapping.map(state.selection.from)
        let insertedAt: number | null = null
        tr.doc.nodesBetween(Math.max(0, approxPos - 5), Math.min(tr.doc.content.size, approxPos + 5), (n, pos) => {
          if (n.type === queryType && insertedAt === null) {
            insertedAt = pos
            return false
          }
        })
        if (insertedAt !== null) {
          try {
            tr = tr.setSelection(NodeSelection.create(tr.doc, insertedAt))
            tr = enablePropertiesPanel(tr)
          } catch {
            /* leave default selection */
          }
        }
        dispatch(tr.scrollIntoView())
      }
      return true
    })

    // Styles
    reg.registerStyle("reviewflow", reviewflowStyles)
    reg.registerStyle("reviewflow-query", rfqStyles)
  },
}
