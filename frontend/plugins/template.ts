import { Plugin as PMPlugin, PluginKey, NodeSelection } from "prosemirror-state"
import type { Node as PMNode, Schema } from "prosemirror-model"
import { EditorView } from "prosemirror-view"
import type { Plugin as WikiPlugin } from "../compiler/registry"
import { enablePropertiesPanel } from "../compiler/core_ui"
import { todoProperties } from "./todo"

// ── {template} — the copy marker ──────────────────────────────────────
//
// Replaces the horizontal rule used today. Renders as that rule PLUS a
// Create document button. Visible in both view and edit modes: the whole
// point of a template is that anyone consulting it should be able to
// issue a document from it.

class TemplateMarkerNodeView {
  dom: HTMLElement
  private node: PMNode
  private status: {
    isValidated: boolean
    versionTag: string
    missingRoles: string[]
    hasReviewflow: boolean
    templateTitle: string
    titlePattern: string
  } | null = null

  constructor(node: PMNode, _view: EditorView, _getPos: () => number | undefined) {
    this.node = node
    this.dom = document.createElement("div")
    this.dom.className = "gowiki-template-marker"
    this.dom.contentEditable = "false"
    this.render()
    this.loadStatus()
  }

  private render() {
    this.dom.innerHTML = ""

    const rule = document.createElement("hr")
    rule.className = "gowiki-template-rule"
    this.dom.appendChild(rule)

    const bar = document.createElement("div")
    bar.className = "gowiki-template-bar"

    const label = document.createElement("span")
    label.className = "gowiki-template-label"
    label.textContent = "Template — payload below this line"
    bar.appendChild(label)

    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "gowiki-template-create-btn"
    btn.textContent = "Create document"

    // If we already know the reviewflow is open, refuse upfront —
    // clicking would just get a 409 back. Named-role hints match the
    // spec's "loud refusal" requirement.
    if (this.status && this.status.hasReviewflow && !this.status.isValidated) {
      btn.disabled = true
      btn.title = `Template reviewflow not fully validated (missing: ${this.status.missingRoles.join(", ")})`
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.openDialog()
    })
    bar.appendChild(btn)

    this.dom.appendChild(bar)
  }

  private currentPagePath(): string {
    // The wiki's current pathname doubles as the template path — this
    // NodeView only ever renders inside the template page itself.
    return window.location.pathname
  }

  private async loadStatus() {
    const path = this.currentPagePath()
    const cleanPath = path.replace(/^\/+/, "")

    // Pull the reviewflow status (loose — a template with no reviewflow
    // returns roles: {} which is fine).
    let isValidated = true
    let versionTag = ""
    let missingRoles: string[] = []
    let hasReviewflow = false
    try {
      const resp = await fetch(`/api/plugin/reviewflow/v1/status/${cleanPath}`)
      if (resp.ok) {
        const status = await resp.json()
        hasReviewflow = status.roles && Object.keys(status.roles).length > 0
        if (hasReviewflow) {
          isValidated = !!status.is_fully_validated
          versionTag = status.version_tag || ""
          missingRoles = Object.keys(status.missing_roles || {})
        }
      }
    } catch {
      /* leave defaults */
    }

    // Read the page markdown so we can prefill the title pattern in the
    // dialog. Falling back to "" is fine — the user can type anything.
    let templateTitle = ""
    let titlePattern = ""
    try {
      const pageResp = await fetch(`/api/pages/${cleanPath}`)
      if (pageResp.ok) {
        const data = await pageResp.json()
        templateTitle = data.title || ""
        const md: string = data.markdown || ""
        titlePattern = extractTemplateTitlePattern(md)
      }
    } catch {
      /* leave defaults */
    }

    this.status = { isValidated, versionTag, missingRoles, hasReviewflow, templateTitle, titlePattern }
    this.render()
  }

  private openDialog() {
    if (this.status && this.status.hasReviewflow && !this.status.isValidated) {
      alert(
        `Cannot create: the template's reviewflow is not fully validated. Missing role(s): ${this.status.missingRoles.join(", ")}.`
      )
      return
    }
    openCreateFromTemplateDialog({
      templatePath: this.currentPagePath(),
      templateTitle: this.status?.templateTitle || "",
      titlePattern: this.status?.titlePattern || "",
      versionTag: this.status?.versionTag || "",
      targetPattern: String(this.node.attrs.target || "").trim(),
    })
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
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

// ── {template-title} ─────────────────────────────────────────────────
//
// A muted label above the heading it prefixes, showing that the heading
// on the template page is a pattern the user completes at creation time.

class TemplateTitleNodeView {
  dom: HTMLElement
  private node: PMNode

  constructor(node: PMNode, _view: EditorView, _getPos: () => number | undefined) {
    this.node = node
    this.dom = document.createElement("div")
    this.dom.className = "gowiki-template-title"
    this.dom.contentEditable = "false"
    this.render()
  }

  private render() {
    this.dom.innerHTML = ""
    const label = document.createElement("span")
    label.className = "gowiki-template-title-label"
    label.textContent = "Template title pattern — user completes at creation"
    this.dom.appendChild(label)
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    return true
  }

  stopEvent(event: Event): boolean {
    // Let mouse events through so ProseMirror can create a NodeSelection
    // when the user clicks the node — the properties panel is driven by
    // selection. Keyboard/paste/input still blocked (contenteditable=false).
    const type = event.type
    if (type === "mousedown" || type === "mouseup" || type === "click") return false
    return true
  }
  ignoreMutation(): boolean {
    return true
  }
}

// ── {template-stamp} ─────────────────────────────────────────────────
//
// In a template context: a muted note. In a NON-template context (a page
// that has no {template} directive): a loud error, per spec §5.

// {template-stamp} is a placeholder for the frozen origin sentence
// a resolver will substitute at creation / prefill time. The old
// "page has no {template} marker → loud red error" branch was a
// safety net from when {template} gated resolution; with the dialect
// rule now "parseable syntax has a defined behaviour", a stamp
// directive is always just a placeholder with a well-defined
// substitution — showing it as an error on a page that happens not
// to have a {template} marker (row-bound templates deliberately skip
// {template}) was misleading. Always a muted note.
class TemplateStampNodeView {
  dom: HTMLElement
  private node: PMNode

  constructor(node: PMNode, _view: EditorView, _getPos: () => number | undefined) {
    this.node = node
    this.dom = document.createElement("div")
    this.dom.className = "gowiki-template-stamp"
    this.dom.contentEditable = "false"
    this.render()
  }

  private render() {
    this.dom.innerHTML = ""
    const note = document.createElement("span")
    note.className = "gowiki-template-stamp-note"
    note.textContent = "Created from template: stamped on document creation"
    this.dom.appendChild(note)
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
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

// ── {template-reviewflow …} ──────────────────────────────────────────
//
// Renders like a muted reviewflow: values are placeholders and will be
// resolved into {reviewflow …} at document creation.

class TemplateReviewflowNodeView {
  dom: HTMLElement
  private node: PMNode

  constructor(node: PMNode, _view: EditorView, _getPos: () => number | undefined) {
    this.node = node
    this.dom = document.createElement("div")
    this.dom.className = "gowiki-template-reviewflow"
    this.dom.contentEditable = "false"
    this.render()
  }

  private render() {
    this.dom.innerHTML = ""

    const label = document.createElement("span")
    label.className = "gowiki-template-reviewflow-label"
    label.textContent = "Template reviewflow — resolved at document creation"
    this.dom.appendChild(label)

    let roles: Record<string, string> = {}
    try {
      roles = JSON.parse(this.node.attrs.roles || "{}")
    } catch {
      /* empty */
    }
    const version = this.node.attrs.version || "1.0 (default)"

    const summary = document.createElement("div")
    summary.className = "gowiki-template-reviewflow-summary"
    const parts: string[] = [`version=${version}`]
    for (const key of Object.keys(roles)) {
      parts.push(`${key}=${roles[key]}`)
    }
    if (parts.length === 1) {
      parts.push("(actors inherited from template's own reviewflow)")
    }
    summary.textContent = parts.join(" · ")
    this.dom.appendChild(summary)
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    if (node.attrs.version !== this.node.attrs.version || node.attrs.roles !== this.node.attrs.roles) {
      this.node = node
      this.render()
    } else {
      this.node = node
    }
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

// ── {template-todo …} ────────────────────────────────────────────────
//
// Renders as a muted panel showing the todo args that will be carried
// verbatim into the created document. Prevents the trap where a
// {todo} placed directly in the template would fire against every
// reader of the template itself (or force the author to escape the
// directive and then remember to un-escape after each copy).

class TemplateTodoNodeView {
  dom: HTMLElement
  private node: PMNode

  constructor(node: PMNode, _view: EditorView, _getPos: () => number | undefined) {
    this.node = node
    this.dom = document.createElement("div")
    this.dom.className = "gowiki-template-todo"
    this.dom.contentEditable = "false"
    this.render()
  }

  private render() {
    this.dom.innerHTML = ""

    const label = document.createElement("span")
    label.className = "gowiki-template-todo-label"
    label.textContent = "Template todo — resolved at document creation"
    this.dom.appendChild(label)

    const summary = document.createElement("div")
    summary.className = "gowiki-template-todo-summary"
    const parts: string[] = []
    // Show title first (the todo's primary label), then the two fields
    // authors actually care about at a glance: who's on the hook and
    // what they must do.
    const title = String(this.node.attrs.title || "").trim()
    if (title) parts.push(`title=${JSON.stringify(title)}`)
    const assign = String(this.node.attrs.assign || "").trim()
    if (assign) parts.push(`assign=${assign}`)
    const action = String(this.node.attrs.action || "").trim()
    if (action) parts.push(`action=${action}`)
    const due = String(this.node.attrs.due || "").trim()
    if (due) parts.push(`due=${due}`)
    if (parts.length === 0) parts.push("(no args — bare {todo} will be inserted)")
    summary.textContent = parts.join(" · ")
    this.dom.appendChild(summary)
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
}

// ── Helpers ──────────────────────────────────────────────────────────

// Client-side twin of the Go markdown.ExtractTemplateTitlePattern helper.
// Reads the pattern-text after the first {template-title} directive.
export function extractTemplateTitlePattern(markdown: string): string {
  const lines = markdown.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\{template-title(?:\s[^{}]*)?\}\s*$/.test(lines[i])) continue
    let j = i + 1
    while (j < lines.length && lines[j].trim() === "") j++
    const m = j < lines.length ? lines[j].match(/^#{1,6}\s+(.+?)\s*$/) : null
    return m ? m[1] : ""
  }
  return ""
}

// slugify normalises the author-supplied title into a URL-safe slug
// for {{slug}} substitution in a template's target= pattern. Kept
// deliberately conservative: lowercase, ASCII-fold via NFKD, hyphenate
// whitespace + non-alphanumeric runs, trim leading/trailing dashes.
// Anything more exotic (Unicode-preserving slugs, custom casings) can
// be layered later without breaking existing rules.
function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

// resolveTargetPattern expands the template variables the target=
// pattern may reference. Kept minimal on purpose — the author supplies
// the title in the dialog, the pattern uses {{title}} / {{slug}}, and
// nothing else is guaranteed at dialog time. Unknown names stay
// literal so a typo is visible in the resulting path rather than
// silently becoming "".
export function resolveTargetPattern(pattern: string, title: string): string {
  if (!pattern || pattern.indexOf("{{") === -1) return pattern
  return pattern.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, rawName) => {
    const name = String(rawName).trim().toLowerCase()
    if (name === "title") return title
    if (name === "slug") return slugify(title)
    return whole
  })
}

// ── Create document dialog ───────────────────────────────────────────

interface CreateDialogOpts {
  templatePath: string
  templateTitle: string
  titlePattern: string
  versionTag: string
  // Pinned destination from the {template target=…} attr, if any.
  // May carry {{slug}} / {{title}} tokens that resolve at dialog
  // submit time (the author-supplied title feeds `slug`). When
  // present, the destination field pre-fills and locks.
  targetPattern?: string
}

function openCreateFromTemplateDialog(opts: CreateDialogOpts) {
  const overlay = document.createElement("div")
  overlay.className = "gowiki-link-modal-overlay"

  const dialog = document.createElement("div")
  dialog.className = "gowiki-link-modal gowiki-template-dialog"

  const title = document.createElement("div")
  title.className = "gowiki-link-modal-title"
  title.textContent = "Create document from template"

  const src = document.createElement("div")
  src.className = "gowiki-template-dialog-src"
  const versionPart = opts.versionTag ? `, version ${opts.versionTag}` : ""
  src.textContent = `Template: ${opts.templateTitle || opts.templatePath}${versionPart}`

  // Destination.
  const pathLabel = document.createElement("label")
  pathLabel.className = "gowiki-link-modal-label"
  pathLabel.textContent = "Destination path"
  const pathInput = document.createElement("input")
  pathInput.type = "text"
  pathInput.className = "gowiki-link-modal-input"
  pathInput.placeholder = "/namespace/document-name"
  // Pinned target: pre-fill and lock. {{title}} / {{slug}} in the
  // pattern resolve after the title field settles — see submit().
  const targetPattern = (opts.targetPattern || "").trim()
  if (targetPattern) {
    // Render the pattern as-is so the author sees the rule; the
    // resolution happens on submit.
    pathInput.value = targetPattern
    pathInput.readOnly = true
    pathInput.title = "Destination pinned by the template's target= attribute"
    pathInput.classList.add("gowiki-template-dialog-pinned")
  }

  // Title.
  const titleLabel = document.createElement("label")
  titleLabel.className = "gowiki-link-modal-label"
  titleLabel.textContent = "Document title"
  const titleInput = document.createElement("input")
  titleInput.type = "text"
  titleInput.className = "gowiki-link-modal-input"
  titleInput.value = opts.titlePattern
  titleInput.placeholder = "e.g. VVP/SOFT02 : Verification and Validation Plan"

  // Reviewflow overrides (collapsed).
  const rfDetails = document.createElement("details")
  rfDetails.className = "gowiki-template-dialog-rf"
  const rfSummary = document.createElement("summary")
  rfSummary.textContent = "Reviewflow overrides (optional)"
  rfDetails.appendChild(rfSummary)

  const rfBox = document.createElement("div")
  rfBox.className = "gowiki-template-dialog-rf-box"
  function rfInput(name: string, placeholder: string): HTMLInputElement {
    const wrap = document.createElement("label")
    wrap.className = "gowiki-template-dialog-rf-row"
    const lbl = document.createElement("span")
    lbl.textContent = name
    const inp = document.createElement("input")
    inp.type = "text"
    inp.className = "gowiki-link-modal-input"
    inp.placeholder = placeholder
    wrap.appendChild(lbl)
    wrap.appendChild(inp)
    rfBox.appendChild(wrap)
    return inp
  }
  const versionInput = rfInput("version", "1.0")
  const authorInput = rfInput("author", "leave blank to inherit")
  const reviewerInput = rfInput("reviewer", "leave blank to inherit")
  const validationInput = rfInput("validation", "leave blank to inherit")
  rfDetails.appendChild(rfBox)

  // Warning + summary.
  const warning = document.createElement("div")
  warning.className = "gowiki-link-modal-warning"

  const summaryLabel = document.createElement("label")
  summaryLabel.className = "gowiki-link-modal-label"
  summaryLabel.textContent = "Summary (audit)"
  const summaryInput = document.createElement("input")
  summaryInput.type = "text"
  summaryInput.className = "gowiki-link-modal-input"
  summaryInput.value = `Created from ${opts.templateTitle || opts.templatePath}`

  // Actions.
  const buttons = document.createElement("div")
  buttons.className = "gowiki-link-modal-actions"
  const cancelBtn = document.createElement("button")
  cancelBtn.type = "button"
  cancelBtn.className = "gowiki-link-modal-btn"
  cancelBtn.textContent = "Cancel"
  const okBtn = document.createElement("button")
  okBtn.type = "button"
  okBtn.className = "gowiki-link-modal-btn"
  okBtn.textContent = "Create"

  function close() {
    overlay.remove()
  }

  async function submit() {
    warning.textContent = ""
    const title = titleInput.value.trim()
    // When target= is pinned, resolve {{title}} / {{slug}} against
    // the title the author just typed. This happens now (not at
    // parse time) so the author sees the pattern in the field and
    // the resolved path only becomes real on submit.
    let path = targetPattern ? resolveTargetPattern(targetPattern, title) : pathInput.value.trim()
    const summary = summaryInput.value.trim()
    if (!path) {
      warning.textContent = "Destination path is required."
      pathInput.focus()
      return
    }
    if (!path.startsWith("/")) path = "/" + path
    if (!title) {
      warning.textContent = "Title is required."
      titleInput.focus()
      return
    }
    okBtn.disabled = true
    okBtn.textContent = "Creating…"

    const reviewflow: Record<string, string> = {}
    if (versionInput.value.trim()) reviewflow.version = versionInput.value.trim()
    if (authorInput.value.trim()) reviewflow.author = authorInput.value.trim()
    if (reviewerInput.value.trim()) reviewflow.reviewer = reviewerInput.value.trim()
    if (validationInput.value.trim()) reviewflow.validation = validationInput.value.trim()

    try {
      const resp = await fetch("/api/pages/from-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_path: opts.templatePath,
          path,
          title,
          reviewflow: Object.keys(reviewflow).length > 0 ? reviewflow : undefined,
          summary,
        }),
      })
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        warning.textContent = body.error || `Failed (HTTP ${resp.status})`
        okBtn.disabled = false
        okBtn.textContent = "Create"
        return
      }
      const result = await resp.json()
      close()
      // Navigate to the freshly created page.
      window.location.href = result.path
    } catch (err) {
      warning.textContent = "Network error: " + String(err)
      okBtn.disabled = false
      okBtn.textContent = "Create"
    }
  }

  cancelBtn.addEventListener("click", close)
  okBtn.addEventListener("click", submit)
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close()
  })
  ;[pathInput, titleInput, summaryInput].forEach((inp) => {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault()
        submit()
      }
      if (e.key === "Escape") {
        e.preventDefault()
        close()
      }
    })
  })

  buttons.appendChild(cancelBtn)
  buttons.appendChild(okBtn)
  dialog.appendChild(title)
  dialog.appendChild(src)
  dialog.appendChild(pathLabel)
  dialog.appendChild(pathInput)
  dialog.appendChild(titleLabel)
  dialog.appendChild(titleInput)
  dialog.appendChild(rfDetails)
  dialog.appendChild(summaryLabel)
  dialog.appendChild(summaryInput)
  dialog.appendChild(warning)
  dialog.appendChild(buttons)
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
  pathInput.focus()
}

// ── Styles ───────────────────────────────────────────────────────────

const templateStyles = `
.gowiki-template-marker {
  margin: 0.75em 0;
}

.gowiki-template-rule {
  border: none;
  border-top: 2px dashed var(--gw-color-border);
  margin: 0 0 6px 0;
}

.gowiki-template-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 8px;
  background: var(--gw-color-surface-alt, #f5f8ff);
  border: 1px solid var(--gw-color-border);
  border-radius: 4px;
  font-size: 12px;
}

.gowiki-template-label {
  color: var(--gw-color-muted);
  font-style: italic;
}

.gowiki-template-create-btn {
  padding: 4px 12px;
  border: 1px solid var(--gw-color-primary, #2d5a47);
  background: var(--gw-color-primary, #2d5a47);
  color: var(--gw-color-primary-fg, #ffffff);
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}

.gowiki-template-create-btn:hover:not(:disabled) {
  background: var(--gw-color-primary-hover, #3a6b57);
  border-color: var(--gw-color-primary-hover, #3a6b57);
}

.gowiki-template-create-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.gowiki-template-title {
  margin: 4px 0 -2px 0;
  padding: 1px 6px;
  font-size: 11px;
  color: var(--gw-color-muted);
  font-style: italic;
  border-left: 3px solid var(--gw-color-accent, #4e79a7);
  background: var(--gw-color-surface-alt, #f5f8ff);
}

.gowiki-template-stamp {
  margin: 4px 0;
  padding: 2px 8px;
  font-size: 12px;
  border-radius: 3px;
  border-left: 3px solid var(--gw-color-accent, #4e79a7);
  background: var(--gw-color-surface-alt, #f5f8ff);
}

.gowiki-template-stamp-note {
  display: block;
  color: var(--gw-color-muted);
  font-style: italic;
}

.gowiki-template-reviewflow {
  margin: 4px 0;
  padding: 4px 8px;
  border-left: 3px solid var(--gw-color-accent, #4e79a7);
  background: var(--gw-color-surface-alt, #f5f8ff);
  font-size: 12px;
}

.gowiki-template-reviewflow-label {
  color: var(--gw-color-muted);
  font-style: italic;
  font-size: 11px;
}

.gowiki-template-reviewflow-summary {
  font-family: monospace;
  color: var(--gw-color-text);
  margin-top: 2px;
}

.gowiki-template-todo {
  margin: 4px 0;
  padding: 4px 8px;
  border-left: 3px solid var(--gw-color-accent, #4e79a7);
  background: var(--gw-color-surface-alt, #f5f8ff);
  font-size: 12px;
}
.gowiki-template-todo-label {
  color: var(--gw-color-muted);
  font-style: italic;
  font-size: 11px;
}
.gowiki-template-todo-summary {
  font-family: monospace;
  color: var(--gw-color-text);
  margin-top: 2px;
}

/* Selection outline shared with other block NodeViews. */
#app.gowiki-editing .gowiki-template-marker.ProseMirror-selectednode,
#app.gowiki-editing .gowiki-template-title.ProseMirror-selectednode,
#app.gowiki-editing .gowiki-template-stamp.ProseMirror-selectednode,
#app.gowiki-editing .gowiki-template-reviewflow.ProseMirror-selectednode,
#app.gowiki-editing .gowiki-template-todo.ProseMirror-selectednode {
  outline: 2px solid #ffd43b;
  outline-offset: 1px;
}

.gowiki-template-dialog {
  min-width: 480px;
}

/* Pinned destination — the template's target= attribute is a rule the
   author fixed on the template itself; the create dialog surfaces the
   pattern read-only so nobody accidentally emits documents somewhere
   the template didn't intend. */
.gowiki-template-dialog-pinned {
  background: var(--gw-color-surface, #f5f5f5) !important;
  color: var(--gw-color-muted, #666) !important;
  cursor: not-allowed !important;
}

.gowiki-template-dialog-src {
  color: var(--gw-color-muted);
  font-size: 12px;
  margin: 4px 0 8px 0;
}

.gowiki-template-dialog-rf {
  margin: 8px 0;
}

.gowiki-template-dialog-rf > summary {
  cursor: pointer;
  color: var(--gw-color-muted);
  font-size: 12px;
  padding: 4px 0;
}

.gowiki-template-dialog-rf-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0 4px 12px;
}

.gowiki-template-dialog-rf-row {
  display: grid;
  grid-template-columns: 90px 1fr;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
`

// ── Properties ───────────────────────────────────────────────────────

const templateMarkerProperties = [
  {
    name: "target",
    label: "Destination path",
    default: "",
    parse: (raw: string) => raw.trim(),
    serialize: (v: string | null) => String(v ?? ""),
    helpText:
      "Optional. Where instances of this template land, e.g. /regulatory/qms/campaigns/{{slug}}. Pinned target locks the destination field in the create dialog.",
  },
] as any[]
const templateTitleProperties = [] as any[]
const templateStampProperties = [] as any[]
// {template-reviewflow} property surface mirrors {reviewflow}: a
// `version` string and a multiline `roles` map (one `rolename=username`
// per line, stored on the node as a JSON-encoded string). The ONE
// semantic difference from {reviewflow} is inheritance — any role left
// blank here falls back to the template's own {reviewflow} directive at
// create time. The helpText spells that out so the editor is honest
// about what empty means.
const templateReviewflowProperties = [
  {
    name: "version",
    label: "Version",
    default: "",
    parse: (raw: string) => raw.trim(),
    serialize: (v: string | null) => String(v ?? ""),
    helpText: "Optional. Defaults to 1.0 at creation.",
  },
  {
    name: "roles",
    label: "Roles",
    default: "{}",
    multiline: true,
    parse: (raw: string) => {
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
      try {
        const roles = JSON.parse(value || "{}")
        return Object.entries(roles)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      } catch {
        return value || ""
      }
    },
    helpText:
      "One role per line: rolename=username. Any role left blank inherits from the template's own {reviewflow} at document creation.",
  },
]

// {template-todo} shares its property surface with {todo} — the args are
// carried verbatim into the created document's {todo}. Importing the
// todo plugin's list means "add a field to todo" automatically propagates
// to template-todo, so a template author can pin any todo attribute the
// runtime supports.
//
// One override: the `due` field's help text points out the relative-
// date syntax (`+N`, `+Nd`, `+Nm`, `+Ny`) that resolves at document
// creation. This is a {template-todo}-only feature — on a plain {todo}
// the `due` value is stored literal, so the todo plugin's own help text
// stays as "YYYY-MM-DD" to avoid giving regular todo users a syntax
// that won't fire for them.
const templateTodoProperties = todoProperties.map((p) =>
  p.name === "due"
    ? {
        ...p,
        helpText:
          "YYYY-MM-DD, or +N / +Nd / +Nm / +Ny for a creation-time offset (days / months / years, default days).",
      }
    : p
)

// ── Plugin registration ──────────────────────────────────────────────

export const templatePlugin: WikiPlugin = {
  register(reg) {
    // Schema
    reg.registerSchema({
      nodes: {
        template_marker: {
          group: "block",
          atom: true,
          attrs: {
            // Optional pinned destination path. When set, the create
            // dialog pre-fills the "New page path" field and locks it
            // — a template that emits {{path}} of a rule lives with
            // the rule, and the destination is part of that rule.
            target: { default: "" },
          },
          toDOM(node: PMNode) {
            return [
              "div",
              { class: "gowiki-template-marker", "data-target": node.attrs.target || "" },
              "Template — payload below",
            ]
          },
          parseDOM: [
            {
              tag: "div.gowiki-template-marker",
              getAttrs(dom: HTMLElement) {
                return { target: dom.getAttribute("data-target") || "" }
              },
            },
          ],
        },
        template_title: {
          group: "block",
          atom: true,
          attrs: {},
          toDOM() {
            return ["div", { class: "gowiki-template-title" }, "Template title pattern"]
          },
          parseDOM: [{ tag: "div.gowiki-template-title" }],
        },
        template_stamp: {
          group: "block",
          atom: true,
          attrs: {},
          toDOM() {
            return ["div", { class: "gowiki-template-stamp" }, "Template stamp"]
          },
          parseDOM: [{ tag: "div.gowiki-template-stamp" }],
        },
        template_reviewflow: {
          group: "block",
          atom: true,
          attrs: {
            version: { default: "" },
            roles: { default: "{}" },
          },
          toDOM(node: PMNode) {
            return [
              "div",
              { class: "gowiki-template-reviewflow", "data-version": node.attrs.version || "" },
              "Template reviewflow",
            ]
          },
          parseDOM: [
            {
              tag: "div.gowiki-template-reviewflow",
              getAttrs(dom: HTMLElement) {
                return { version: dom.getAttribute("data-version") || "" }
              },
            },
          ],
        },
        // Same attribute surface as `todo` — the args carry into the
        // created document verbatim. Keeping the schemas parallel means
        // the property panel and any todo-side helper (validation,
        // enum options) work identically for template-todo.
        template_todo: {
          group: "block",
          atom: true,
          attrs: {
            title: { default: "" },
            assign: { default: "" },
            resolution: { default: "any" },
            due: { default: "" },
            recur: { default: "" },
            priority: { default: "normal" },
            action: { default: "" },
            tags: { default: "" },
            description: { default: "" },
          },
          toDOM(node: PMNode) {
            return [
              "div",
              {
                class: "gowiki-template-todo",
                "data-title": node.attrs.title || "",
                "data-assign": node.attrs.assign || "",
                "data-action": node.attrs.action || "",
              },
              "Template todo",
            ]
          },
          parseDOM: [
            {
              tag: "div.gowiki-template-todo",
              getAttrs(dom: HTMLElement) {
                return {
                  title: dom.getAttribute("data-title") || "",
                  assign: dom.getAttribute("data-assign") || "",
                  action: dom.getAttribute("data-action") || "",
                }
              },
            },
          ],
        },
      },
    })

    // Self-contained directives.
    reg.registerSelfContainedDirective("template", {
      tokenType: "template_marker",
      nodeType: "template_marker",
      properties: templateMarkerProperties,
    })
    reg.registerSelfContainedDirective("template-title", {
      tokenType: "template_title",
      nodeType: "template_title",
      properties: templateTitleProperties,
    })
    reg.registerSelfContainedDirective("template-stamp", {
      tokenType: "template_stamp",
      nodeType: "template_stamp",
      properties: templateStampProperties,
    })
    reg.registerSelfContainedDirective("template-reviewflow", {
      tokenType: "template_reviewflow",
      nodeType: "template_reviewflow",
      properties: templateReviewflowProperties,
      collectExtra: true,
    })
    reg.registerSelfContainedDirective("template-todo", {
      tokenType: "template_todo",
      nodeType: "template_todo",
      properties: templateTodoProperties,
    })

    // Markdown → PM.
    reg.registerText("template_marker", {
      run(ctx, tok) {
        const attrs = tok.meta?.attrs ?? {}
        ctx.push(ctx.schema.nodes.template_marker.create({ target: attrs.target ?? "" }))
      },
    })
    reg.registerText("template_title", {
      run(ctx) {
        ctx.push(ctx.schema.nodes.template_title.create({}))
      },
    })
    reg.registerText("template_stamp", {
      run(ctx) {
        ctx.push(ctx.schema.nodes.template_stamp.create({}))
      },
    })
    reg.registerText("template_reviewflow", {
      run(ctx, tok) {
        const attrs = tok.meta?.attrs ?? {}
        const version = attrs.version ?? ""
        const roles: Record<string, string> = {}
        for (const [k, v] of Object.entries(attrs)) {
          if (k !== "version" && k !== "_args") roles[k] = String(v)
        }
        ctx.push(
          ctx.schema.nodes.template_reviewflow.create({
            version,
            roles: JSON.stringify(roles),
          })
        )
      },
    })
    reg.registerText("template_todo", {
      run(ctx, tok) {
        const attrs = tok.meta?.attrs ?? {}
        ctx.push(
          ctx.schema.nodes.template_todo.create({
            title: attrs.title ?? "",
            assign: attrs.assign ?? "",
            resolution: attrs.resolution ?? "any",
            due: attrs.due ?? "",
            recur: attrs.recur ?? "",
            priority: attrs.priority ?? "normal",
            action: attrs.action ?? "",
            tags: attrs.tags ?? "",
            description: attrs.description ?? "",
          })
        )
      },
    })

    // PM → Markdown.
    reg.registerPMNode("template_marker", {
      print(node) {
        const target = String(node.attrs.target || "").trim()
        if (!target) return `{template}\n\n`
        const needsQuote = /[\s"]/.test(target)
        const val = needsQuote ? `"${target.replace(/"/g, '\\"')}"` : target
        return `{template target=${val}}\n\n`
      },
    })
    reg.registerPMNode("template_title", {
      print() {
        return `{template-title}\n`
      },
    })
    reg.registerPMNode("template_stamp", {
      print() {
        return `{template-stamp}\n\n`
      },
    })
    reg.registerPMNode("template_reviewflow", {
      print(node) {
        // Declared order is the signing order of the created document.
        const parts: string[] = []
        if (node.attrs.version) parts.push(`version=${node.attrs.version}`)
        let roles: Record<string, string> = {}
        try {
          roles = JSON.parse(node.attrs.roles || "{}")
        } catch {
          /* empty */
        }
        for (const key of Object.keys(roles)) {
          parts.push(`${key}=${roles[key]}`)
        }
        return parts.length ? `{template-reviewflow ${parts.join(" ")}}\n\n` : `{template-reviewflow}\n\n`
      },
    })
    // Serialization mirrors the `todo` node: title is always emitted
    // (required by the todo directive contract), other keys only when
    // non-default. Quoting on values that may contain spaces (title,
    // assign, description) matches todo.ts's own output so a
    // template-todo and a todo look identical modulo the directive name.
    reg.registerPMNode("template_todo", {
      print(node) {
        const parts: string[] = []
        const title = node.attrs.title || ""
        parts.push(`title="${title}"`)
        if (node.attrs.assign) parts.push(`assign="${node.attrs.assign}"`)
        if (node.attrs.resolution && node.attrs.resolution !== "any") {
          parts.push(`resolution=${node.attrs.resolution}`)
        }
        if (node.attrs.due) parts.push(`due=${node.attrs.due}`)
        if (node.attrs.recur) parts.push(`recur=${node.attrs.recur}`)
        if (node.attrs.priority && node.attrs.priority !== "normal") {
          parts.push(`priority=${node.attrs.priority}`)
        }
        if (node.attrs.action) parts.push(`action="${node.attrs.action}"`)
        if (node.attrs.tags) parts.push(`tags="${node.attrs.tags}"`)
        if (node.attrs.description) parts.push(`description="${node.attrs.description}"`)
        return `{template-todo ${parts.join(" ")}}\n\n`
      },
    })

    // Editor plugin: NodeViews.
    reg.registerEditorPlugin((_schema: Schema) => {
      return new PMPlugin({
        key: new PluginKey("gowiki.template"),
        props: {
          nodeViews: {
            template_marker(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new TemplateMarkerNodeView(node, view, getPos)
            },
            template_title(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new TemplateTitleNodeView(node, view, getPos)
            },
            template_stamp(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new TemplateStampNodeView(node, view, getPos)
            },
            template_reviewflow(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new TemplateReviewflowNodeView(node, view, getPos)
            },
            template_todo(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new TemplateTodoNodeView(node, view, getPos)
            },
          },
        },
      })
    })

    // Insert commands.
    reg.registerCommand("template", "insert", (state, dispatch) => {
      const type = reg.schema.nodes.template_marker
      if (!type) return false
      if (dispatch) {
        const node = type.create({})
        const tr = state.tr.replaceSelectionWith(node)
        dispatch(tr.scrollIntoView())
      }
      return true
    })
    reg.registerCommand("template-stamp", "insert", (state, dispatch) => {
      const type = reg.schema.nodes.template_stamp
      if (!type) return false
      if (dispatch) {
        const node = type.create({})
        const tr = state.tr.replaceSelectionWith(node)
        dispatch(tr.scrollIntoView())
      }
      return true
    })
    reg.registerCommand("template-title", "insert", (state, dispatch) => {
      const type = reg.schema.nodes.template_title
      if (!type) return false
      if (dispatch) {
        const node = type.create({})
        const tr = state.tr.replaceSelectionWith(node)
        dispatch(tr.scrollIntoView())
      }
      return true
    })
    reg.registerCommand("template-reviewflow", "insert", (state, dispatch) => {
      const type = reg.schema.nodes.template_reviewflow
      if (!type) return false
      if (dispatch) {
        const node = type.create({ version: "", roles: "{}" })
        let tr = state.tr.replaceSelectionWith(node)
        const approxPos = tr.mapping.map(state.selection.from)
        tr.doc.nodesBetween(Math.max(0, approxPos - 5), Math.min(tr.doc.content.size, approxPos + 5), (n, pos) => {
          if (n.type === type) {
            try {
              tr = tr.setSelection(NodeSelection.create(tr.doc, pos))
              tr = enablePropertiesPanel(tr)
            } catch {
              /* ignore */
            }
            return false
          }
        })
        dispatch(tr.scrollIntoView())
      }
      return true
    })
    // {template-todo}: insert and immediately open the properties
    // panel. The default is a bare {template-todo} — the author fills
    // title/assign/action/etc. in the panel, same as a {todo}.
    reg.registerCommand("template-todo", "insert", (state, dispatch) => {
      const type = reg.schema.nodes.template_todo
      if (!type) return false
      if (dispatch) {
        const node = type.create({})
        let tr = state.tr.replaceSelectionWith(node)
        const approxPos = tr.mapping.map(state.selection.from)
        tr.doc.nodesBetween(Math.max(0, approxPos - 5), Math.min(tr.doc.content.size, approxPos + 5), (n, pos) => {
          if (n.type === type) {
            try {
              tr = tr.setSelection(NodeSelection.create(tr.doc, pos))
              tr = enablePropertiesPanel(tr)
            } catch {
              /* ignore */
            }
            return false
          }
        })
        dispatch(tr.scrollIntoView())
      }
      return true
    })

    reg.registerStyle("template", templateStyles)
  },
}
