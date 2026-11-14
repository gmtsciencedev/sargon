import { Plugin as PMPlugin, PluginKey, NodeSelection } from "prosemirror-state"
import type { Node as PMNode, Schema } from "prosemirror-model"
import { EditorView } from "prosemirror-view"
import type { Plugin as WikiPlugin } from "../compiler/registry"
import { enablePropertiesPanel } from "../compiler/core_ui"

// --- Properties ---

const reviewflowLinkProperties = [
  {
    name: "version",
    label: "Version",
    default: "",
    parse: (raw: string) => raw.trim(),
    serialize: (value: string | null) => String(value ?? ""),
  },
  {
    name: "page",
    label: "Page",
    default: "",
    parse: (raw: string) => raw.trim(),
    serialize: (value: string | null) => String(value ?? ""),
    helpText: "Target page path (empty = current page)",
  },
]

// --- API ---

const API_BASE = "/api/plugin/reviewflow/v1"

interface VersionRecord {
  page_version: number
  timestamp: string
  confirmed_by: Record<string, string>
  version_tag: string
}

interface ReviewflowStatus {
  version_history?: VersionRecord[]
}

// normalizeVersionTag reduces a hand-typed version like "1", "1.0", "01.0",
// or "1.0.0" to a canonical dot-tuple ("1.0.0"), so exact-string lookups
// against the version history line up regardless of trailing-zero style.
// Non-numeric tags (e.g. "draft") are returned lowercased as-is so a bad
// tag on either side still refuses cleanly.
function normalizeVersionTag(raw: string): string {
  const s = (raw || "").trim().toLowerCase()
  if (!s) return ""
  const parts = s.split(".")
  const nums: number[] = []
  for (const p of parts) {
    const n = parseInt(p, 10)
    if (isNaN(n) || String(n) !== String(parseInt(p, 10))) return s
    nums.push(n)
  }
  while (nums.length < 3) nums.push(0)
  return nums.join(".")
}

// --- NodeView ---

class ReviewflowLinkNodeView {
  dom: HTMLElement
  private node: PMNode
  private resolved: { pageVersion: number; pagePath: string; title: string } | null = null
  private error: string | null = null
  private loading = true

  constructor(node: PMNode, _view: EditorView, _getPos: () => number | undefined) {
    this.node = node
    this.dom = document.createElement("span")
    this.dom.className = "gowiki-reviewflow-link"
    this.dom.contentEditable = "false"
    this.render()
    this.resolve()
  }

  private getTargetPage(): string {
    const page = (this.node.attrs.page || "").trim()
    if (page) return page
    return window.location.pathname
  }

  private render() {
    this.dom.innerHTML = ""
    const version = this.node.attrs.version || ""
    const targetPage = this.getTargetPage()
    const isLocal = !(this.node.attrs.page || "").trim()

    if (this.loading) {
      const span = document.createElement("span")
      span.className = "gowiki-rfl-loading"
      span.textContent = `Resolving v${version}...`
      this.dom.appendChild(span)
      return
    }

    if (this.error || !this.resolved) {
      const span = document.createElement("span")
      span.className = "gowiki-rfl-error"
      span.textContent = `v${version}${isLocal ? "" : ` (${targetPage})`} — ${this.error || "not found"}`
      this.dom.appendChild(span)
      return
    }

    const a = document.createElement("a")
    a.href = `${this.resolved.pagePath}?v=${this.resolved.pageVersion}`

    if (isLocal) {
      // Simple inline badge for local page — just show the version tag
      a.className = "gowiki-rfl-inline-badge gowiki-link-exists"
      a.title = `Validated version ${version}`
      a.textContent = version
    } else {
      // Full display for cross-page links
      a.className = "gowiki-rfl-link gowiki-link-exists"
      a.title = `Validated version ${version} of ${this.resolved.pagePath}`

      const icon = document.createElement("span")
      icon.className = "gowiki-rfl-icon"
      icon.textContent = "\u{1F6E1}\uFE0F"
      a.appendChild(icon)

      const label = document.createElement("span")
      label.className = "gowiki-rfl-label"
      label.textContent = this.resolved.title || this.resolved.pagePath
      a.appendChild(label)

      const badge = document.createElement("span")
      badge.className = "gowiki-rfl-version-badge"
      badge.textContent = `v${version}`
      a.appendChild(badge)
    }

    this.dom.appendChild(a)
  }

  private async resolve() {
    const version = (this.node.attrs.version || "").trim()
    const targetPage = this.getTargetPage()

    if (!version) {
      this.loading = false
      this.error = "no version specified"
      this.render()
      return
    }

    try {
      const cleanPath = targetPage.replace(/^\/+/, "")
      const resp = await fetch(`${API_BASE}/status/${cleanPath}`)
      if (!resp.ok) {
        this.loading = false
        this.error = "could not load reviewflow status"
        this.render()
        return
      }

      const status: ReviewflowStatus = await resp.json()
      const history = status.version_history || []
      // Version tags are typed by hand and inconsistently: `1` and `1.0`
      // are the same version for a reader but different strings for an
      // exact match. Normalize both sides to a dot-tuple padded with
      // zeros so `{reviewflow version=1}` and `{reviewflow-link
      // version=1.0}` line up.
      const target = normalizeVersionTag(version)
      const match = history.find((vr) => normalizeVersionTag(vr.version_tag) === target)

      if (!match) {
        this.loading = false
        this.error = "version not found in history"
        this.render()
        return
      }

      // Resolve page title
      let title = targetPage
      try {
        const metaResp = await fetch(`/api/pages/${cleanPath}`)
        if (metaResp.ok) {
          const pageData = await metaResp.json()
          if (pageData.title) title = pageData.title
        }
      } catch {
        /* use path as fallback */
      }

      this.resolved = {
        pageVersion: match.page_version,
        pagePath: targetPage.startsWith("/") ? targetPage : "/" + targetPage,
        title,
      }
      this.loading = false
      this.render()
    } catch {
      this.loading = false
      this.error = "failed to resolve"
      this.render()
    }
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    const changed = node.attrs.version !== this.node.attrs.version || node.attrs.page !== this.node.attrs.page
    this.node = node
    if (changed) {
      this.loading = true
      this.resolved = null
      this.error = null
      this.render()
      this.resolve()
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

// --- Styles ---

const reviewflowLinkStyles = `
.gowiki-reviewflow-link {
  display: inline;
}

.gowiki-rfl-loading {
  color: #999;
  font-size: 13px;
  font-style: italic;
}

.gowiki-rfl-error {
  color: var(--gw-color-error);
  font-size: 13px;
  border-bottom: 2px dotted var(--gw-color-error);
  padding-bottom: 1px;
}

.gowiki-rfl-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  text-decoration: none;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--gw-color-success-bg);
  border: 1px solid #c8e6c9;
  font-size: 13px;
  color: var(--gw-color-success);
}

.gowiki-rfl-link:hover {
  background: #c8e6c9;
}

.gowiki-rfl-icon {
  font-size: 12px;
}

.gowiki-rfl-label {
  font-weight: 500;
}

.gowiki-rfl-version-badge {
  background: var(--gw-color-info);
  color: white;
  font-size: 11px;
  font-weight: 600;
  padding: 0 6px;
  border-radius: 8px;
}

.gowiki-rfl-inline-badge {
  display: inline-block;
  background: var(--gw-color-info-bg);
  color: var(--gw-color-info);
  padding: 1px 8px;
  border-radius: 10px;
  font-size: inherit;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}

.gowiki-rfl-inline-badge:hover {
  background: var(--gw-color-info-hover-bg);
}

#app.gowiki-editing .gowiki-reviewflow-link.ProseMirror-selectednode {
  outline: 2px solid #ffd43b;
  outline-offset: 1px;
}
`

// --- Plugin ---

export const reviewflowLinkPlugin: WikiPlugin = {
  register(reg) {
    // Schema node
    reg.registerSchema({
      nodes: {
        reviewflow_link: {
          group: "inline",
          inline: true,
          atom: true,
          attrs: {
            version: { default: "" },
            page: { default: "" },
          },
          toDOM(node: PMNode) {
            return [
              "span",
              {
                class: "gowiki-reviewflow-link",
                "data-version": node.attrs.version || "",
                "data-page": node.attrs.page || "",
              },
              `v${node.attrs.version || "?"}`,
            ]
          },
          parseDOM: [
            {
              tag: "span.gowiki-reviewflow-link",
              getAttrs(dom: HTMLElement) {
                return {
                  version: dom.getAttribute("data-version") || "",
                  page: dom.getAttribute("data-page") || "",
                }
              },
            },
          ],
        },
      },
    })

    // Self-contained directive: {reviewflow-link version=1.0 page=/path}
    reg.registerSelfContainedDirective("reviewflow-link", {
      tokenType: "reviewflow_link",
      nodeType: "reviewflow_link",
      properties: reviewflowLinkProperties,
      inline: true,
    })

    // Markdown → PM: handle the synthetic token
    reg.registerText("reviewflow_link", {
      run(ctx, tok) {
        const attrs = tok.meta?.attrs ?? {}
        ctx.push(
          ctx.schema.nodes.reviewflow_link.create({
            version: attrs.version ?? "",
            page: attrs.page ?? "",
          })
        )
      },
    })

    // PM → Markdown: serialize back to directive syntax
    reg.registerPMNode("reviewflow_link", {
      print(node) {
        const parts: string[] = []
        if (node.attrs.version) {
          parts.push(`version=${node.attrs.version}`)
        }
        if (node.attrs.page) {
          parts.push(`page=${node.attrs.page}`)
        }
        return parts.length ? `{reviewflow-link ${parts.join(" ")}}` : `{reviewflow-link}`
      },
    })

    // Editor plugin: NodeView
    reg.registerEditorPlugin((_schema: Schema) => {
      return new PMPlugin({
        key: new PluginKey("gowiki.reviewflow-link"),
        props: {
          nodeViews: {
            reviewflow_link(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new ReviewflowLinkNodeView(node, view, getPos)
            },
          },
        },
      })
    })

    // Command: insert a reviewflow-link node and open properties panel
    reg.registerCommand("reviewflow-link", "insert", (state, dispatch) => {
      const nodeType = reg.schema.nodes.reviewflow_link
      if (!nodeType) return false
      if (dispatch) {
        const node = nodeType.create({ version: "", page: "" })
        const { from } = state.selection
        let tr = state.tr.insert(from, node)
        try {
          tr = tr.setSelection(NodeSelection.create(tr.doc, from))
          tr = enablePropertiesPanel(tr)
        } catch {
          /* leave default selection */
        }
        dispatch(tr.scrollIntoView())
      }
      return true
    })

    // Styles
    reg.registerStyle("reviewflow-link", reviewflowLinkStyles)
  },
}
