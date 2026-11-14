import { Plugin as PMPlugin, PluginKey, NodeSelection } from "prosemirror-state"
import type { Node as PMNode, Schema } from "prosemirror-model"
import { EditorView } from "prosemirror-view"
import type { Plugin as WikiPlugin } from "../compiler/registry"
import { enablePropertiesPanel } from "../compiler/core_ui"

// --- Properties ---

const versionLinkProperties = [
  {
    name: "version",
    label: "Version number",
    default: "",
    parse: (raw: string) => {
      const n = parseInt(raw.trim(), 10)
      return isNaN(n) || n < 1 ? "" : String(n)
    },
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

// --- Types ---

interface AtticEntry {
  version: number
  timestamp: string
  author: string
  summary: string
}

// --- NodeView ---

class VersionLinkNodeView {
  dom: HTMLElement
  private node: PMNode
  private entry: AtticEntry | null = null
  private pageTitle: string | null = null
  private error: string | null = null
  private loading = true

  constructor(node: PMNode, _view: EditorView, _getPos: () => number | undefined) {
    this.node = node
    this.dom = document.createElement("span")
    this.dom.className = "gowiki-version-link"
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
      span.className = "gowiki-vl-loading"
      span.textContent = `Resolving version ${version}...`
      this.dom.appendChild(span)
      return
    }

    if (this.error || !this.entry) {
      const span = document.createElement("span")
      span.className = "gowiki-vl-error"
      span.textContent = `v${version}${isLocal ? "" : ` (${targetPage})`} — ${this.error || "not found"}`
      this.dom.appendChild(span)
      return
    }

    const pagePath = targetPage.startsWith("/") ? targetPage : "/" + targetPage
    const a = document.createElement("a")
    a.className = "gowiki-vl-link gowiki-link-exists"
    a.href = `${pagePath}?v=${this.entry.version}`
    a.title = `Version ${version} — ${this.entry.author}, ${new Date(this.entry.timestamp).toLocaleDateString()}${this.entry.summary ? ": " + this.entry.summary : ""}`

    // Version badge
    const badge = document.createElement("span")
    badge.className = "gowiki-vl-version-badge"
    badge.textContent = `v${version}`
    a.appendChild(badge)

    // Page label
    const label = document.createElement("span")
    label.className = "gowiki-vl-label"
    label.textContent = isLocal ? this.pageTitle || "this page" : this.pageTitle || pagePath
    a.appendChild(label)

    // Meta: author + date
    const meta = document.createElement("span")
    meta.className = "gowiki-vl-meta"
    const date = new Date(this.entry.timestamp).toLocaleDateString()
    meta.textContent = `${this.entry.author} \u00b7 ${date}`
    a.appendChild(meta)

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

    const vNum = parseInt(version, 10)
    if (isNaN(vNum) || vNum < 1) {
      this.loading = false
      this.error = "invalid version number"
      this.render()
      return
    }

    try {
      const cleanPath = targetPage.replace(/^\/+/, "") || "index"

      // Fetch history to find the version entry
      const histResp = await fetch(`/api/history/${cleanPath}`)
      if (!histResp.ok) {
        this.loading = false
        this.error = "could not load page history"
        this.render()
        return
      }

      const histData = await histResp.json()
      const entries: AtticEntry[] = histData.entries || []
      const match = entries.find((e) => e.version === vNum)

      if (!match) {
        this.loading = false
        this.error = `version ${vNum} not found`
        this.render()
        return
      }

      this.entry = match

      // Resolve page title
      try {
        const metaResp = await fetch(`/api/pages/${cleanPath}`)
        if (metaResp.ok) {
          const pageData = await metaResp.json()
          if (pageData.title) this.pageTitle = pageData.title
        }
      } catch {
        /* use path as fallback */
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
      this.entry = null
      this.pageTitle = null
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

const versionLinkStyles = `
.gowiki-version-link {
  display: inline;
}

.gowiki-vl-loading {
  color: #999;
  font-size: 13px;
  font-style: italic;
}

.gowiki-vl-error {
  color: var(--gw-color-error);
  font-size: 13px;
  border-bottom: 2px dotted var(--gw-color-error);
  padding-bottom: 1px;
}

.gowiki-vl-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  text-decoration: none;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--gw-color-info-bg);
  border: 1px solid var(--gw-color-info-hover-bg);
  font-size: 13px;
  color: var(--gw-color-info);
}

.gowiki-vl-link:hover {
  background: var(--gw-color-info-hover-bg);
}

.gowiki-vl-version-badge {
  background: var(--gw-color-info);
  color: white;
  font-size: 11px;
  font-weight: 600;
  padding: 0 6px;
  border-radius: 8px;
}

.gowiki-vl-label {
  font-weight: 500;
}

.gowiki-vl-meta {
  color: #78909c;
  font-size: 11px;
}

#app.gowiki-editing .gowiki-version-link.ProseMirror-selectednode {
  outline: 2px solid #ffd43b;
  outline-offset: 1px;
}
`

// --- Plugin ---

export const versionLinkPlugin: WikiPlugin = {
  register(reg) {
    // Schema node
    reg.registerSchema({
      nodes: {
        version_link: {
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
                class: "gowiki-version-link",
                "data-version": node.attrs.version || "",
                "data-page": node.attrs.page || "",
              },
              `v${node.attrs.version || "?"}`,
            ]
          },
          parseDOM: [
            {
              tag: "span.gowiki-version-link",
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

    // Self-contained directive: {version-link version=3 page=/path}
    reg.registerSelfContainedDirective("version-link", {
      tokenType: "version_link",
      nodeType: "version_link",
      properties: versionLinkProperties,
      inline: true,
    })

    // Markdown → PM
    reg.registerText("version_link", {
      run(ctx, tok) {
        const attrs = tok.meta?.attrs ?? {}
        ctx.push(
          ctx.schema.nodes.version_link.create({
            version: attrs.version ?? "",
            page: attrs.page ?? "",
          })
        )
      },
    })

    // PM → Markdown
    reg.registerPMNode("version_link", {
      print(node) {
        const parts: string[] = []
        if (node.attrs.version) {
          parts.push(`version=${node.attrs.version}`)
        }
        if (node.attrs.page) {
          parts.push(`page=${node.attrs.page}`)
        }
        return parts.length ? `{version-link ${parts.join(" ")}}` : `{version-link}`
      },
    })

    // Editor plugin: NodeView
    reg.registerEditorPlugin((_schema: Schema) => {
      return new PMPlugin({
        key: new PluginKey("gowiki.version-link"),
        props: {
          nodeViews: {
            version_link(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new VersionLinkNodeView(node, view, getPos)
            },
          },
        },
      })
    })

    // Command: insert a version-link node and open properties panel
    reg.registerCommand("version-link", "insert", (state, dispatch) => {
      const nodeType = reg.schema.nodes.version_link
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
    reg.registerStyle("version-link", versionLinkStyles)
  },
}
