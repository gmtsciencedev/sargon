import { NodeSelection, Plugin as PMPlugin, PluginKey } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import type { Node as PMNode } from "prosemirror-model"
import type { Plugin as WikiPlugin } from "../compiler/registry"
import { captionNumberingKey, renderInlineMarkdown } from "./caption"

function normalizeImageVersion(raw: string): string | null {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase()
  if (!value) return null
  if (value === "latest") return "latest"
  const n = Number(value)
  if (Number.isInteger(n) && n >= 1) return String(n)
  throw new Error(`Invalid version "${raw}". Expected a positive integer or "latest".`)
}

const imageProperties = [
  {
    name: "size",
    label: "Size",
    default: null,
    parse: (raw: string) => normalizeImageSize(raw),
    serialize: (value: string | null) => String(value ?? ""),
  },
  {
    name: "version",
    label: "Version",
    default: null,
    parse: (raw: string) => normalizeImageVersion(raw),
    serialize: (value: string | null) => String(value ?? ""),
    options: (attrs: Record<string, any>) => {
      const opts = [{ value: "", label: "(default)" }]
      const src = attrs.src || ""
      const cache = (window as any).__sargonMediaVersions as Map<string, number> | undefined
      const maxVersion = cache?.get(src) ?? 0
      const currentV = attrs.version
      const currentN = currentV && currentV !== "latest" ? parseInt(currentV, 10) : 0
      const upper = Math.max(maxVersion, currentN || 0)
      for (let i = 2; i <= upper; i++) {
        opts.push({ value: String(i), label: `v=${i}` })
      }
      opts.push({ value: "latest", label: "latest" })
      return opts
    },
  },
  {
    name: "align",
    label: "Align",
    default: null,
    parse: (raw: string) => {
      const v = String(raw ?? "")
        .trim()
        .toLowerCase()
      if (!v) return null
      if (v === "left" || v === "center" || v === "right") return v
      throw new Error(`Invalid align value "${raw}". Expected "left", "center", or "right".`)
    },
    serialize: (value: string | null) => String(value ?? ""),
    options: () => [
      { value: "", label: "(none)" },
      { value: "left", label: "Left" },
      { value: "center", label: "Center" },
      { value: "right", label: "Right" },
    ],
  },
  {
    name: "wrap",
    label: "Wrap",
    default: null,
    parse: (raw: string) => {
      const v = String(raw ?? "")
        .trim()
        .toLowerCase()
      if (!v) return null
      if (v === "left" || v === "right") return v
      throw new Error(`Invalid wrap value "${raw}". Expected "left" or "right".`)
    },
    serialize: (value: string | null) => String(value ?? ""),
    options: () => [
      { value: "", label: "(none)" },
      { value: "left", label: "Left" },
      { value: "right", label: "Right" },
    ],
  },
  {
    name: "caption",
    label: "Caption",
    default: null,
    wide: true,
    parse: (raw: string) => raw.trim() || null,
    serialize: (val: string | null) => String(val ?? ""),
    visible: (attrs: Record<string, any>) => !!attrs.caption || !!attrs.label,
  },
  {
    name: "label",
    label: "Label",
    default: null,
    parse: (raw: string) => raw.trim() || null,
    serialize: (val: string | null) => String(val ?? ""),
    visible: (attrs: Record<string, any>) => !!attrs.caption || !!attrs.label,
  },
  {
    name: "bg",
    label: "Dark-mode background",
    default: null,
    parse: (raw: string) => {
      const v = String(raw ?? "")
        .trim()
        .toLowerCase()
      if (!v || v === "auto") return null
      if (v === "light" || v === "invert" || v === "none") return v
      throw new Error(`Invalid bg "${raw}". Expected "auto", "light", "invert", or "none".`)
    },
    serialize: (val: string | null) => String(val ?? ""),
    options: () => [
      { value: "", label: "Auto (detect white)" },
      { value: "light", label: "Light — frame in cream" },
      { value: "invert", label: "Invert — flip colours (line art)" },
      { value: "none", label: "None — render as-is" },
    ],
  },
]

const imageStyles = `
.gowiki-image-wrapper {
  position: relative;
  display: inline-block;
  max-width: 100%;
  line-height: 0;
}

.gowiki-image-wrapper img {
  display: block;
}

.gowiki-image-wrapper.ProseMirror-selectednode {
  outline: 2px solid #ffd43b;
  outline-offset: 1px;
}

.gowiki-image-resize-handle {
  position: absolute;
  bottom: -3px;
  right: -3px;
  width: 10px;
  height: 10px;
  border: 1px solid var(--gw-color-primary);
  background: var(--gw-color-accent);
  border-radius: 2px;
  cursor: nwse-resize;
  z-index: 5;
}

.gowiki-image-align-left {
  display: block;
  width: fit-content;
  margin-right: auto;
}

.gowiki-image-align-center {
  display: block;
  width: fit-content;
  margin-left: auto;
  margin-right: auto;
}

.gowiki-image-align-right {
  display: block;
  width: fit-content;
  margin-left: auto;
}

.gowiki-image-wrap-left {
  float: left;
  margin: 0 1em 0.5em 0;
}

.gowiki-image-wrap-right {
  float: right;
  margin: 0 0 0.5em 1em;
}

p:has(> .gowiki-image-wrap-left),
p:has(> .gowiki-image-wrap-right) {
  margin-top: 0;
  margin-bottom: 0;
}
`

const MIN_DRAG_SIZE_PX = 16
const MAX_DRAG_SIZE_PX = 4096

function escapeAltText(raw: string): string {
  return String(raw ?? "").replace(/]/g, "\\]")
}

function normalizeImageSize(raw: string): string | null {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase()
  if (!value) return null

  const pct = value.match(/^(\d+)%$/)
  if (pct) {
    const n = Number(pct[1])
    if (n > 0) return `${n}%`
    throw new Error("Image size percent must be > 0")
  }

  const px = value.match(/^(\d+)px$/)
  if (px) {
    const n = Number(px[1])
    if (n > 0) return `${n}px`
    throw new Error("Image size in px must be > 0")
  }

  const exact = value.match(/^(\d+)px;(\d+)px$/)
  if (exact) {
    const w = Number(exact[1])
    const h = Number(exact[2])
    if (w > 0 && h > 0) return `${w}px;${h}px`
    throw new Error("Image width and height must be > 0")
  }

  throw new Error(`Invalid image size "${raw}". Expected 50%, 200px, or 200px;100px.`)
}

function styleFromImageSize(size: string | null): string | null {
  if (!size) return null
  if (/^\d+%$/.test(size)) {
    return `width: ${size}; height: auto;`
  }
  if (/^\d+px$/.test(size)) {
    return `max-width: ${size}; max-height: ${size}; width: auto; height: auto;`
  }
  const exact = size.match(/^(\d+px);(\d+px)$/)
  if (exact) {
    return `width: ${exact[1]}; height: ${exact[2]};`
  }
  return null
}

function addStyleToDOMSpec(spec: any, style: string | null) {
  if (!style || !Array.isArray(spec)) return spec
  const [tag, maybeAttrs, ...rest] = spec
  const hasAttrs = maybeAttrs && typeof maybeAttrs === "object" && !Array.isArray(maybeAttrs)
  const attrs = hasAttrs ? maybeAttrs : {}
  const existing = attrs.style ? String(attrs.style) : ""
  const mergedStyle = existing ? `${existing}${existing.trim().endsWith(";") ? " " : "; "}${style}` : style
  const children = hasAttrs ? rest : [maybeAttrs, ...rest]
  return [tag, { ...attrs, style: mergedStyle }, ...children]
}

class ImageNodeView {
  dom: HTMLElement
  private imgEl: HTMLImageElement
  private handle: HTMLElement | null = null
  private figcaptionEl: HTMLElement | null = null
  private node: PMNode
  private outerView: EditorView
  private getPos: () => number | undefined

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.outerView = view
    this.getPos = getPos

    this.dom = document.createElement("span")
    this.dom.className = "gowiki-image-wrapper"

    this.imgEl = document.createElement("img")
    this.applyAttrs()
    this.dom.appendChild(this.imgEl)
    this.applyCaptionDisplay()
  }

  private applyAttrs() {
    let src = this.node.attrs.src ?? ""
    const version = this.node.attrs.version ?? null
    if (version) {
      src += (src.includes("?") ? "&" : "?") + "v=" + version
    }
    this.imgEl.src = src
    this.imgEl.alt = this.node.attrs.alt ?? ""
    if (this.node.attrs.title) {
      this.imgEl.title = this.node.attrs.title
    } else {
      this.imgEl.removeAttribute("title")
    }
    const size = this.node.attrs.size ?? null
    const isPercent = size && /^\d+%$/.test(size)
    if (isPercent) {
      // Percentage: set width on wrapper, image fills it.
      this.dom.style.width = size
      this.dom.style.maxWidth = "none"
      this.imgEl.style.cssText = "width: 100%; height: auto;"
    } else {
      const sizeStyle = styleFromImageSize(size)
      // Explicit size: apply it directly, allow exceeding container.
      // No size: constrain to container with max-width.
      this.imgEl.style.cssText = sizeStyle ?? "max-width: 100%; height: auto;"
      this.dom.style.width = ""
      this.dom.style.maxWidth = size ? "none" : ""
    }
    const align = this.node.attrs.align ?? null
    this.dom.classList.remove("gowiki-image-align-left", "gowiki-image-align-center", "gowiki-image-align-right")
    if (align === "left") this.dom.classList.add("gowiki-image-align-left")
    else if (align === "center") this.dom.classList.add("gowiki-image-align-center")
    else if (align === "right") this.dom.classList.add("gowiki-image-align-right")

    const wrap = this.node.attrs.wrap ?? null
    this.dom.classList.remove("gowiki-image-wrap-left", "gowiki-image-wrap-right")
    if (wrap === "left") this.dom.classList.add("gowiki-image-wrap-left")
    else if (wrap === "right") this.dom.classList.add("gowiki-image-wrap-right")

    // Dark-mode background directive (specs/themes.md §11.6). Setting
    // data-bg on the <img> lets the global CSS pick up the author's
    // choice; its presence also tells the auto-frame heuristic to skip
    // this image (explicit choice wins over detection).
    const bg = this.node.attrs.bg ?? null
    // Clear any previous framed class so we re-evaluate from scratch.
    this.imgEl.classList.remove("gowiki-img-auto-invert")
    if (bg) {
      this.imgEl.dataset.bg = bg
    } else {
      delete this.imgEl.dataset.bg
      // Returning to auto — re-run the heuristic on this image.
      const runner = (window as any).__sargonAutoFrameImage
      if (typeof runner === "function") {
        try {
          runner(this.imgEl)
        } catch {
          /* ignore */
        }
      }
    }
  }

  private applyCaptionDisplay() {
    const caption = this.node.attrs.caption ?? null
    const label = this.node.attrs.label ?? null

    if (caption) {
      this.dom.classList.add("gowiki-figure")
      if (label) {
        this.dom.id = label
      } else {
        this.dom.removeAttribute("id")
      }

      // Get figure number from caption numbering plugin
      const captionState = captionNumberingKey.getState(this.outerView.state)
      const pos = this.getPos()
      const number = (pos !== undefined ? captionState?.posnums.get(pos) : null) ?? null

      if (!this.figcaptionEl) {
        this.figcaptionEl = document.createElement("div")
        this.figcaptionEl.className = "gowiki-caption"
        this.figcaptionEl.contentEditable = "false"
        this.dom.appendChild(this.figcaptionEl)
      }

      const numText = number ? `Figure ${number}:` : "Figure:"
      this.figcaptionEl.innerHTML = ""
      const numSpan = document.createElement("span")
      numSpan.className = "gowiki-caption-number"
      numSpan.textContent = numText
      const textSpan = document.createElement("span")
      textSpan.className = "gowiki-caption-text"
      renderInlineMarkdown(caption, textSpan)
      this.figcaptionEl.appendChild(numSpan)
      this.figcaptionEl.appendChild(textSpan)
    } else {
      this.dom.classList.remove("gowiki-figure")
      this.dom.removeAttribute("id")
      if (this.figcaptionEl) {
        this.figcaptionEl.remove()
        this.figcaptionEl = null
      }
    }
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.applyAttrs()
    this.applyCaptionDisplay()
    return true
  }

  selectNode() {
    this.dom.classList.add("ProseMirror-selectednode")
    if (this.outerView.editable) {
      this.showHandle()
    }
  }

  deselectNode() {
    this.dom.classList.remove("ProseMirror-selectednode")
    this.hideHandle()
  }

  private showHandle() {
    if (this.handle) return
    this.handle = document.createElement("span")
    this.handle.className = "gowiki-image-resize-handle"
    this.handle.title = "Drag to resize (Shift keeps ratio)"
    this.handle.addEventListener("mousedown", this.onResizeStart)
    this.dom.appendChild(this.handle)
  }

  private hideHandle() {
    if (this.handle) {
      this.handle.remove()
      this.handle = null
    }
  }

  private onResizeStart = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    const rect = this.imgEl.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    const startWidth = Math.max(1, rect.width)
    const startHeight = Math.max(1, rect.height)
    const ratio = startWidth / startHeight

    const oldCursor = document.body.style.cursor
    const oldSelect = document.body.style.userSelect
    document.body.style.cursor = "nwse-resize"
    document.body.style.userSelect = "none"

    const onMove = (moveEvent: MouseEvent) => {
      let width = Math.round(startWidth + moveEvent.clientX - startX)
      let height = Math.round(startHeight + moveEvent.clientY - startY)

      if (moveEvent.shiftKey) {
        const byWidth = Math.max(MIN_DRAG_SIZE_PX, width)
        const byHeight = Math.max(MIN_DRAG_SIZE_PX, height)
        const widthDrivenHeight = Math.round(byWidth / ratio)
        const heightDrivenWidth = Math.round(byHeight * ratio)
        const widthDelta = Math.abs(byWidth - startWidth)
        const heightDelta = Math.abs(byHeight - startHeight)
        if (widthDelta >= heightDelta) {
          width = byWidth
          height = widthDrivenHeight
        } else {
          width = heightDrivenWidth
          height = byHeight
        }
      }

      width = Math.max(MIN_DRAG_SIZE_PX, Math.min(MAX_DRAG_SIZE_PX, width))
      height = Math.max(MIN_DRAG_SIZE_PX, Math.min(MAX_DRAG_SIZE_PX, height))
      const size = `${width}px;${height}px`

      const pos = this.getPos()
      if (pos === undefined) return
      const state = this.outerView.state
      const node = state.doc.nodeAt(pos)
      if (!node || node.type.name !== "image") return

      const newAttrs = { ...node.attrs, size }
      let tr = state.tr.setNodeMarkup(pos, node.type, newAttrs)
      tr = tr.setSelection(NodeSelection.create(tr.doc, pos))
      this.outerView.dispatch(tr)
    }

    const onUp = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      document.body.style.cursor = oldCursor
      document.body.style.userSelect = oldSelect
    }

    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  stopEvent(event: Event): boolean {
    // Let the resize handle's mousedown through to our handler,
    // block other events on the handle from reaching ProseMirror
    if (event.target === this.handle) {
      return event.type === "mousedown"
    }
    return false
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy() {
    this.hideHandle()
  }
}

export const imagePlugin: WikiPlugin = {
  register(reg) {
    reg.extendSchemaNode("image", (spec) => {
      const baseToDOM = typeof spec.toDOM === "function" ? spec.toDOM : (node: any) => ["img", node.attrs]
      return {
        ...spec,
        attrs: {
          ...(spec.attrs ?? {}),
          size: { default: null },
          version: { default: null },
          align: { default: null },
          wrap: { default: null },
          caption: { default: null },
          label: { default: null },
          bg: { default: null },
        },
        toDOM(node: any) {
          const domSpec = baseToDOM(node)
          const style = styleFromImageSize(node.attrs.size ?? null)
          let result = addStyleToDOMSpec(domSpec, style)
          // Propagate the bg choice onto the <img> so the heuristic skips
          // images with an explicit author preference.
          if (node.attrs.bg) {
            if (Array.isArray(result) && typeof result[1] === "object" && result[1] !== null) {
              result = [result[0], { ...result[1], "data-bg": node.attrs.bg }, ...result.slice(2)]
            }
          }
          return result
        },
      }
    })

    reg.registerDirective("image", {
      nodeType: "image",
      appliesTo: ["paragraph_open"],
      properties: imageProperties,
    })

    reg.registerText("image", {
      run(ctx, tok) {
        let src = tok.attrGet?.("src") ?? ""
        if (!src) return
        const title = tok.attrGet?.("title") ?? null
        const alt = tok.content ?? tok.attrGet?.("alt") ?? ""
        const directive = ctx.findDirective("image")
        const directiveSize = directive?.size ?? null
        const size = normalizeImageSize(directiveSize ?? "")

        // Extract ?v=N from src URL, store in version attr.
        let version: string | null = null
        const vMatch = src.match(/[?&]v=([^&]+)/)
        if (vMatch) {
          version = normalizeImageVersion(vMatch[1])
          src = src.replace(/[?&]v=[^&]+/, "").replace(/\?$/, "")
        }
        // Directive version takes precedence over URL-embedded version.
        const directiveVersion = directive?.version ?? null
        if (directiveVersion !== null) {
          version = normalizeImageVersion(String(directiveVersion))
        }

        const directiveAlign = directive?.align ?? null
        const align = directiveAlign ? String(directiveAlign).trim().toLowerCase() : null
        const directiveWrap = directive?.wrap ?? null
        const wrap = directiveWrap ? String(directiveWrap).trim().toLowerCase() : null

        const caption = directive?.caption ? String(directive.caption).trim() || null : null
        const label = directive?.label ? String(directive.label).trim() || null : null
        const directiveBg = directive?.bg ?? null
        const bg = directiveBg ? String(directiveBg).trim().toLowerCase() || null : null

        ctx.push(ctx.schema.nodes.image.create({ src, title, alt, size, version, align, wrap, caption, label, bg }))
      },
    })

    reg.registerPMNode("image", {
      print(node) {
        let src = String(node.attrs.src ?? "")
        const version = node.attrs.version ?? null
        if (version) {
          src += (src.includes("?") ? "&" : "?") + "v=" + version
        }
        const alt = escapeAltText(node.attrs.alt ?? "")
        const title = node.attrs.title
        if (title) {
          return "![" + alt + "](" + src + ' "' + String(title).replace(/"/g, '\\"') + '")'
        }
        return "![" + alt + "](" + src + ")"
      },
    })

    // NodeView-based image rendering with resize handle
    reg.registerEditorPlugin(() => {
      return new PMPlugin({
        key: new PluginKey("gowiki.imageNodeView"),
        props: {
          nodeViews: {
            image(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new ImageNodeView(node, view, getPos)
            },
          },
        },
      })
    })
    reg.registerStyle("image-resize", imageStyles)
  },
}
