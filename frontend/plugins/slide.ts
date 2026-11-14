import { Plugin as PMPlugin, PluginKey, NodeSelection } from "prosemirror-state"
import type { Node as PMNode, Schema } from "prosemirror-model"
import type { EditorView } from "prosemirror-view"
import type { Plugin as WikiPlugin, NodePropertySpec, Registry } from "../compiler/registry"
import { enablePropertiesPanel } from "../compiler/core_ui"

const VALID_THEMES = ["light", "dark"]
const VALID_RATIOS = ["16:9", "4:3"]

// ── Presentation engine ──

class PresentationEngine {
  private overlay: HTMLElement
  private slides: HTMLElement[] // cloned DOM fragments per slide
  private current = 0
  private hideTimer: ReturnType<typeof setTimeout> | null = null
  private progressBar: HTMLElement
  private counter: HTMLElement

  constructor(slides: HTMLElement[], theme: string, ratio: string, background: string, font: string) {
    this.slides = slides

    this.overlay = document.createElement("div")
    this.overlay.className = `gowiki-slides-overlay theme-${theme}`
    if (background) {
      this.overlay.classList.add("has-background")
    }

    const viewport = document.createElement("div")
    viewport.className = "gowiki-slides-viewport"
    this.overlay.appendChild(viewport)

    const [rw, rh] = ratio === "4:3" ? [4, 3] : [16, 9]
    viewport.dataset.ratioW = String(rw)
    viewport.dataset.ratioH = String(rh)

    const slideEl = document.createElement("div")
    slideEl.className = "gowiki-slides-slide"
    if (background) {
      slideEl.style.backgroundImage = `url(${background})`
    }
    if (font) {
      // Percentages are relative to the base 1.5em slide font size.
      // E.g. font=80% → 1.5 * 0.8 = 1.2em
      if (font.endsWith("%")) {
        const pct = parseFloat(font) / 100
        if (!isNaN(pct)) {
          slideEl.style.fontSize = `${(1.5 * pct).toFixed(3)}em`
        }
      } else {
        slideEl.style.fontSize = font
      }
    }
    viewport.appendChild(slideEl)

    this.progressBar = document.createElement("div")
    this.progressBar.className = "gowiki-slides-progress"
    this.overlay.appendChild(this.progressBar)

    this.counter = document.createElement("div")
    this.counter.className = "gowiki-slides-counter"
    this.overlay.appendChild(this.counter)

    this.overlay.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("a, button")) return
      this.next()
    })

    this.handleKey = this.handleKey.bind(this)
    this.handleMouseMove = this.handleMouseMove.bind(this)
    this.handleFullscreenChange = this.handleFullscreenChange.bind(this)
    this.resizeViewport = this.resizeViewport.bind(this)
  }

  start() {
    document.body.appendChild(this.overlay)
    document.addEventListener("keydown", this.handleKey)
    document.addEventListener("mousemove", this.handleMouseMove)
    document.addEventListener("fullscreenchange", this.handleFullscreenChange)
    window.addEventListener("resize", this.resizeViewport)

    if (this.overlay.requestFullscreen) {
      this.overlay.requestFullscreen().catch(() => {})
    }

    this.showSlide(0)
    this.resizeViewport()
    this.startHideTimer()
  }

  private handleKey(e: KeyboardEvent) {
    switch (e.key) {
      case "ArrowRight":
      case " ":
      case "Enter":
        e.preventDefault()
        this.next()
        break
      case "ArrowLeft":
      case "Backspace":
        e.preventDefault()
        this.prev()
        break
      case "Escape":
        e.preventDefault()
        this.exit()
        break
      case "Home":
        e.preventDefault()
        this.showSlide(0)
        break
      case "End":
        e.preventDefault()
        this.showSlide(this.slides.length - 1)
        break
    }
    this.showControls()
  }

  private handleMouseMove() {
    this.showControls()
  }

  private handleFullscreenChange() {
    if (!document.fullscreenElement && document.body.contains(this.overlay)) {
      this.cleanup()
    }
  }

  private next() {
    if (this.current < this.slides.length - 1) {
      this.showSlide(this.current + 1)
    }
  }

  private prev() {
    if (this.current > 0) {
      this.showSlide(this.current - 1)
    }
  }

  private showSlide(index: number) {
    this.current = index
    const slideEl = this.overlay.querySelector(".gowiki-slides-slide")!
    slideEl.innerHTML = ""
    slideEl.appendChild(this.slides[index].cloneNode(true))

    const pct = this.slides.length > 1 ? ((index + 1) / this.slides.length) * 100 : 100
    this.progressBar.style.width = `${pct}%`
    this.counter.textContent = `${index + 1} / ${this.slides.length}`
  }

  private resizeViewport() {
    const viewport = this.overlay.querySelector(".gowiki-slides-viewport") as HTMLElement
    if (!viewport) return

    const rw = parseInt(viewport.dataset.ratioW || "16")
    const rh = parseInt(viewport.dataset.ratioH || "9")

    const vw = this.overlay.clientWidth
    const vh = this.overlay.clientHeight

    let width = vw
    let height = width * (rh / rw)
    if (height > vh) {
      height = vh
      width = height * (rw / rh)
    }

    viewport.style.width = `${width}px`
    viewport.style.height = `${height}px`
  }

  private showControls() {
    this.overlay.classList.remove("controls-hidden")
    this.startHideTimer()
  }

  private startHideTimer() {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => {
      this.overlay.classList.add("controls-hidden")
    }, 2000)
  }

  exit() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
    this.cleanup()
  }

  private cleanup() {
    document.removeEventListener("keydown", this.handleKey)
    document.removeEventListener("mousemove", this.handleMouseMove)
    document.removeEventListener("fullscreenchange", this.handleFullscreenChange)
    window.removeEventListener("resize", this.resizeViewport)
    if (this.hideTimer) clearTimeout(this.hideTimer)
    if (this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay)
    }
  }
}

/**
 * Collect the page DOM and split it into slides at <hr> boundaries.
 * The slides marker node itself is excluded from the output.
 */
function collectSlides(markerDom: HTMLElement): HTMLElement[] {
  // Walk up to find the ProseMirror content root
  const pmRoot = markerDom.closest(".ProseMirror")
  if (!pmRoot) return []

  const slides: HTMLElement[] = []
  let current = document.createElement("div")

  for (const child of Array.from(pmRoot.children)) {
    const el = child as HTMLElement
    // Skip the slides marker node itself
    if (el.classList?.contains("gowiki-slides-marker")) continue

    if (el.tagName === "HR") {
      // Finish current slide if it has content
      if (current.children.length > 0) {
        slides.push(current)
      }
      current = document.createElement("div")
    } else {
      const clone = el.cloneNode(true) as HTMLElement
      // Canvas pixel data is lost on cloneNode — convert to images
      const origCanvases = el.querySelectorAll("canvas")
      const clonedCanvases = clone.querySelectorAll("canvas")
      for (let i = 0; i < origCanvases.length; i++) {
        const orig = origCanvases[i]
        const cloned = clonedCanvases[i]
        if (!orig || !cloned) continue
        try {
          const img = document.createElement("img")
          img.src = orig.toDataURL()
          img.style.width = `${orig.width}px`
          img.style.maxWidth = "100%"
          img.style.height = "auto"
          cloned.replaceWith(img)
        } catch {
          /* tainted canvas, keep blank */
        }
      }
      current.appendChild(clone)
    }
  }

  // Last slide
  if (current.children.length > 0) {
    slides.push(current)
  }

  return slides
}

function launchPresentation(markerDom: HTMLElement, theme: string, ratio: string, background: string, font: string) {
  const slides = collectSlides(markerDom)
  if (slides.length === 0) return

  const engine = new PresentationEngine(slides, theme, ratio, background, font)
  engine.start()
}

// ── NodeView ──

class SlidesMarkerView {
  dom: HTMLElement
  private node: PMNode

  constructor(node: PMNode, _view: EditorView, _getPos: () => number | undefined) {
    this.node = node

    this.dom = document.createElement("div")
    this.dom.className = "gowiki-slides-marker"
    this.dom.contentEditable = "false"

    this.buildBanner()
  }

  private buildBanner() {
    const title = this.node.attrs.title || "Presentation"
    const theme = this.node.attrs.theme || "light"
    const ratio = this.node.attrs.ratio || "16:9"
    const bg = this.node.attrs.background

    let info = `${theme} &middot; ${ratio}`
    if (bg) info += ` &middot; bg`

    this.dom.innerHTML = `
      <span class="gowiki-slides-marker-label">${this.escHtml(title)}</span>
      <span class="gowiki-slides-marker-info">${info}</span>
      <button class="gowiki-slides-present-btn">&#9654; Present</button>
    `

    const btn = this.dom.querySelector(".gowiki-slides-present-btn") as HTMLButtonElement
    btn.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      launchPresentation(
        this.dom,
        this.node.attrs.theme,
        this.node.attrs.ratio,
        this.node.attrs.background,
        this.node.attrs.font
      )
    })
  }

  private escHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.buildBanner()
    return true
  }

  stopEvent(event: Event): boolean {
    if (event.type === "mousedown" || event.type === "mouseup" || event.type === "click") return false
    return true
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy() {}
}

// ── Property definitions ──

const slidesProperties: NodePropertySpec[] = [
  {
    name: "title",
    label: "Title",
    default: "",
    parse: (raw: string) => raw.trim(),
    serialize: (v: string | null) => String(v ?? ""),
  },
  {
    name: "theme",
    label: "Theme",
    default: "light",
    parse: (raw: string) => {
      const t = raw.trim().toLowerCase()
      if (VALID_THEMES.includes(t)) return t
      throw new Error(`Invalid theme "${raw}". Use: ${VALID_THEMES.join(", ")}`)
    },
    serialize: (v: string | null) => String(v ?? "light"),
    options: VALID_THEMES.map((t) => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) })),
  },
  {
    name: "ratio",
    label: "Ratio",
    default: "16:9",
    parse: (raw: string) => {
      const r = raw.trim()
      if (VALID_RATIOS.includes(r)) return r
      throw new Error(`Invalid ratio "${raw}". Use: ${VALID_RATIOS.join(", ")}`)
    },
    serialize: (v: string | null) => String(v ?? "16:9"),
    options: VALID_RATIOS.map((r) => ({ value: r, label: r })),
  },
  {
    name: "background",
    label: "Background",
    default: "",
    parse: (raw: string) => raw.trim(),
    serialize: (v: string | null) => String(v ?? ""),
  },
  {
    name: "font",
    label: "Font size",
    default: "",
    parse: (raw: string) => raw.trim(),
    serialize: (v: string | null) => String(v ?? ""),
  },
]

// ── Styles ──

const slidesStyles = `
/* --- Marker banner in editor/view --- */
.gowiki-slides-marker {
  display: flex;
  align-items: center;
  gap: 0.8em;
  margin: 0 0 0.5em 0;
  padding: 0.4em 0.8em;
  background: var(--gw-color-accent);
  border: 1px solid var(--gw-color-border);
  border-radius: 4px;
  font-size: 0.85em;
}
#app.gowiki-editing .gowiki-slides-marker.ProseMirror-selectednode {
  outline: 2px solid #ffd43b;
  outline-offset: 1px;
}
.gowiki-slides-marker-label {
  font-weight: 600;
}
.gowiki-slides-marker-info {
  color: var(--gw-color-muted);
  font-size: 0.9em;
}
.gowiki-slides-present-btn {
  margin-left: auto;
  padding: 0.25em 0.8em;
  border: none;
  border-radius: 3px;
  background: var(--gw-color-link);
  color: var(--gw-color-primary-fg);
  font-size: 0.85em;
  cursor: pointer;
  white-space: nowrap;
}
.gowiki-slides-present-btn:hover {
  background: var(--gw-color-link-hover);
}

/* --- Fullscreen overlay --- */
.gowiki-slides-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.gowiki-slides-overlay.theme-light {
  background: #ffffff;
  color: #1a1a1a;
}
.gowiki-slides-overlay.theme-dark {
  background: #1a1a1a;
  color: #f0f0f0;
}

/* --- Viewport and slide --- */
.gowiki-slides-viewport {
  position: relative;
  overflow: hidden;
}
.gowiki-slides-slide {
  padding: 2em 3em;
  font-size: 1.5em;
  line-height: 1.5;
  height: 100%;
  box-sizing: border-box;
  overflow: auto;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.gowiki-slides-slide::after {
  content: "";
  display: table;
  clear: both;
}
/* Blockquote wrapping (floats) — these styles are scoped to .ProseMirror in the
   blockquote plugin, so we duplicate them for the slide overlay context. */
.gowiki-slides-slide blockquote.gowiki-bq-wrap-left {
  float: left;
  margin-right: 1em;
  margin-bottom: 0.5em;
}
.gowiki-slides-slide blockquote.gowiki-bq-wrap-right {
  float: right;
  margin-left: 1em;
  margin-bottom: 0.5em;
}
.gowiki-slides-slide blockquote[style*="float: left"] {
  float: left !important;
}
.gowiki-slides-slide blockquote[style*="float: right"] {
  float: right !important;
}
.gowiki-slides-slide h1 { font-size: 2em; margin: 0.3em 0; }
.gowiki-slides-slide h2 { font-size: 1.5em; margin: 0.3em 0; }
.gowiki-slides-slide h3 { font-size: 1.2em; margin: 0.3em 0; }
.gowiki-slides-slide ul, .gowiki-slides-slide ol {
  margin: 0.5em 0;
  padding-left: 1.2em;
}
.gowiki-slides-slide li { margin: 0.3em 0; }
.gowiki-slides-slide img { max-width: 80%; max-height: 60vh; }
.gowiki-slides-slide pre {
  background: #f4f4f4;
  padding: 0.8em;
  border-radius: 4px;
  font-size: 0.7em;
  overflow-x: auto;
}
.gowiki-slides-overlay.theme-dark .gowiki-slides-slide pre {
  background: #2d2d2d;
}
.gowiki-slides-slide code {
  background: #f0f0f0;
  padding: 0.1em 0.3em;
  border-radius: 3px;
  font-size: 0.9em;
}
.gowiki-slides-overlay.theme-dark .gowiki-slides-slide code {
  background: #333;
}
.gowiki-slides-slide pre code {
  background: none;
  padding: 0;
}
.gowiki-slides-slide table {
  border-collapse: collapse;
  margin: 0.5em auto;
}
.gowiki-slides-slide th, .gowiki-slides-slide td {
  border: 1px solid #ccc;
  padding: 0.3em 0.6em;
}
.gowiki-slides-overlay.theme-dark .gowiki-slides-slide th,
.gowiki-slides-overlay.theme-dark .gowiki-slides-slide td {
  border-color: #555;
}
.gowiki-slides-slide blockquote {
  border-left: 4px solid #ccc;
  margin: 0.5em 0;
  padding: 0.3em 1em;
  color: #555;
}
.gowiki-slides-overlay.theme-dark .gowiki-slides-slide blockquote {
  border-left-color: #555;
  color: #aaa;
}

/* --- Progress and counter --- */
.gowiki-slides-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 3px;
  background: var(--gw-color-primary);
  transition: width 0.15s ease;
}
.gowiki-slides-counter {
  position: absolute;
  bottom: 0.5em;
  right: 1em;
  font-size: 0.75em;
  opacity: 0.6;
  transition: opacity 0.3s;
}
.gowiki-slides-overlay.controls-hidden .gowiki-slides-counter {
  opacity: 0;
}
.gowiki-slides-overlay.controls-hidden .gowiki-slides-progress {
  opacity: 0;
}
`

// ── Plugin ──

export const slidePlugin: WikiPlugin = {
  register(reg: Registry) {
    // ── Schema ──
    reg.registerSchema({
      nodes: {
        slides: {
          group: "block",
          atom: true,
          attrs: {
            title: { default: "" },
            theme: { default: "light" },
            ratio: { default: "16:9" },
            background: { default: "" },
            font: { default: "" },
          },
          toDOM(node: any) {
            return [
              "div",
              {
                class: "gowiki-slides-marker",
                "data-slides-title": node.attrs.title,
                "data-slides-theme": node.attrs.theme,
                "data-slides-ratio": node.attrs.ratio,
                "data-slides-background": node.attrs.background,
                "data-slides-font": node.attrs.font,
              },
              `Slides: ${node.attrs.title || "Presentation"}`,
            ]
          },
          parseDOM: [
            {
              tag: "div.gowiki-slides-marker",
              getAttrs(dom: HTMLElement) {
                return {
                  title: dom.getAttribute("data-slides-title") || "",
                  theme: dom.getAttribute("data-slides-theme") || "light",
                  ratio: dom.getAttribute("data-slides-ratio") || "16:9",
                  background: dom.getAttribute("data-slides-background") || "",
                  font: dom.getAttribute("data-slides-font") || "",
                }
              },
            },
          ],
        },
      },
    })

    // ── Self-contained directive: {slides title="..." theme=dark ratio=4:3} ──
    reg.registerSelfContainedDirective("slides", {
      tokenType: "slides",
      nodeType: "slides",
      properties: slidesProperties,
    })

    // ── Markdown → PM ──
    reg.registerText("slides", {
      run(ctx, tok) {
        const attrs = tok.meta?.attrs ?? {}
        ctx.push(
          ctx.schema.nodes.slides.create({
            title: attrs.title ?? "",
            theme: attrs.theme ?? "light",
            ratio: attrs.ratio ?? "16:9",
            background: attrs.background ?? "",
            font: attrs.font ?? "",
          })
        )
      },
    })

    // ── PM → Markdown ──
    reg.registerPMNode("slides", {
      print(node) {
        const parts: string[] = []
        if (node.attrs.title) parts.push(`title=${node.attrs.title}`)
        if (node.attrs.theme && node.attrs.theme !== "light") parts.push(`theme=${node.attrs.theme}`)
        if (node.attrs.ratio && node.attrs.ratio !== "16:9") parts.push(`ratio=${node.attrs.ratio}`)
        if (node.attrs.background) parts.push(`background=${node.attrs.background}`)
        if (node.attrs.font) parts.push(`font=${node.attrs.font}`)
        if (parts.length > 0) {
          return `{slides ${parts.join(" ")}}\n\n`
        }
        return "{slides}\n\n"
      },
    })

    // ── NodeView ──
    reg.registerEditorPlugin((_schema: Schema) => {
      return new PMPlugin({
        key: new PluginKey("gowiki.slides"),
        props: {
          nodeViews: {
            slides(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new SlidesMarkerView(node, view, getPos)
            },
          },
        },
      })
    })

    // ── Toolbar command: insert slides marker + sample content ──
    reg.registerCommand("slides", "insert", (state, dispatch) => {
      const slidesType = reg.schema.nodes.slides
      const hrType = reg.schema.nodes.horizontal_rule
      const headingType = reg.schema.nodes.heading
      const paragraphType = reg.schema.nodes.paragraph
      if (!slidesType || !hrType || !headingType) return false
      if (dispatch) {
        const nodes = [
          slidesType.create({}),
          headingType.create({ level: 1 }, reg.schema.text("Title Slide")),
          hrType.create(),
          headingType.create({ level: 1 }, reg.schema.text("Slide 2")),
          hrType.create(),
          headingType.create({ level: 1 }, reg.schema.text("Thank You")),
        ]
        let tr = state.tr
        const { from, to } = state.selection
        tr = tr.replaceWith(from, to, nodes)

        // Select the slides marker node and open properties
        let insertedAt: number | null = null
        tr.doc.nodesBetween(0, Math.min(tr.doc.content.size, from + 10), (n, pos) => {
          if (n.type === slidesType && insertedAt === null) {
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

    // ── Styles ──
    reg.registerStyle("slides", slidesStyles)
  },
}
