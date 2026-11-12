import { EditorState, TextSelection, Selection, Plugin } from "prosemirror-state"
import { EditorView, Decoration, DecorationSet } from "prosemirror-view"
import { Slice } from "prosemirror-model"
import { schema as basicSchema } from "prosemirror-schema-basic"
import { keymap } from "prosemirror-keymap"
import { baseKeymap, setBlockType, toggleMark, wrapIn } from "prosemirror-commands"
import { history, undo, redo } from "prosemirror-history"
import { gapCursor } from "prosemirror-gapcursor"
import { icons } from "prosemirror-menu"
import { splitListItem, sinkListItem, liftListItem, wrapInList } from "prosemirror-schema-list"
import { markdownToPM } from "./compiler/markdown_to_pm.ts"
import { CollabSession } from "./collab.js"
import { pmToMarkdown } from "./compiler/pm_to_markdown.ts"
import { buildRegistry } from "./compiler/build_registry.ts"
import { isPropertiesPanelEnabled, setPropertiesPanelEditable } from "./compiler/core_ui.ts"
import { openMediaManager } from "./media_manager.js"
import { slugify } from "./compiler/slugify.ts"
import {
  computeContentAddress,
  computePmContentAddress,
  resolveContentAddress,
  resolveRawContentAddress,
  pointFromPm,
  pointFromRaw,
  resolvePointInPm,
  resolvePointInRaw,
} from "./compiler/anchor.ts"
import { highlightCodeBlocks } from "./highlight.ts"
import { adjustFormula } from "./plugins/table.ts"
import { HIGHLIGHT_COLORS } from "./plugins/highlight.ts"
import {
  initComments,
  destroyComments,
  addComment,
  getCommentCount,
  createAIComment,
  clearAIComments,
  commentPmPlugin,
} from "./plugins/comment.ts"
import {
  generateKeypair,
  hasKey as signingHasKey,
  getCertificatePEM,
  importCertificate,
  clearCertificate,
  deleteKey as signingDeleteKey,
  getPublicKeySPKI,
  getKeyCreatedAt,
} from "./signing/keystore.ts"
const HLJS_THEMES = [
  "github",
  "atom-one-light",
  "vs",
  "xcode",
  "idea",
  "github-dark",
  "atom-one-dark",
  "monokai",
  "nord",
  "vs2015",
  "tokyo-night-dark",
]

// Separate light/dark picks. The one applied at any moment depends on the
// active site theme (html[data-theme]). Admins can set both; users can't
// override the code theme (it follows the site theme).
let hljsThemeLight = "github"
let hljsThemeDark = "github-dark"

function applyHighlightTheme() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark"
  let theme = isDark ? hljsThemeDark : hljsThemeLight
  if (!HLJS_THEMES.includes(theme)) theme = isDark ? "github-dark" : "github"
  let link = document.getElementById("gowiki-hljs-theme")
  if (!link) {
    link = document.createElement("link")
    link.id = "gowiki-hljs-theme"
    link.rel = "stylesheet"
    document.head.appendChild(link)
  }
  const desired = `/hljs/${theme}.css`
  if (link.getAttribute("href") !== desired) link.href = desired
}

function setHighlightThemes(light, dark) {
  if (light && HLJS_THEMES.includes(light)) hljsThemeLight = light
  if (dark && HLJS_THEMES.includes(dark)) hljsThemeDark = dark
  applyHighlightTheme()
}

window.addEventListener("gowiki:theme-changed", applyHighlightTheme)

applyHighlightTheme()

const registry = buildRegistry(basicSchema)
const schema = registry.buildSchema()
registry.bindSchema(schema)

const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
function shortcutHint(label, key) {
  const mod = isMac ? "\u2318" : "Ctrl+"
  return `${label} (${mod}${key})`
}

function resolvePagePathFromLocation(loc) {
  const path = decodeURIComponent(loc.pathname || "/")
  if (path === "/") return "index"
  let trimmed = path.replace(/^\/+|\/+$/g, "")
  if (!trimmed) return "index"
  // Canonical: /foo/index → foo (namespace index page)
  if (trimmed.endsWith("/index")) trimmed = trimmed.slice(0, -6)
  else if (trimmed === "index") return "index"
  return trimmed
}

const pagePath = resolvePagePathFromLocation(window.location)
const pageDisplayPath = pagePath === "index" ? "/" : `/${pagePath}`
// For namespace index pages (URL ends with /), the namespace IS the pagePath.
// For leaf pages, the namespace is the parent directory.
const urlIsNamespaceIndex = (() => {
  const raw = decodeURIComponent(window.location.pathname || "/")
  return raw.endsWith("/") || raw.endsWith("/index")
})()
let pageNamespace = urlIsNamespaceIndex
  ? pagePath === "index"
    ? ""
    : pagePath
  : pagePath.includes("/")
    ? pagePath.split("/").slice(0, -1).join("/")
    : ""
const defaultMarkdown = `
## Sargon

This is editable text.

- One
- Two
`

const appRoot = document.querySelector("#app")
const contentRoot = document.querySelector("#content")
const actionsRoot = document.querySelector("#gowiki-action-bar")
const sidebarRoot = document.querySelector("#left")
const footerRoot = document.querySelector("#footer")

let currentUser = null // { username } or null
let editToken = null
let autoSaveTimer = null
let pageLockInfo = null // { locked_by, is_draft }
let currentPageVersion = 0
let currentPageMeta = null // full meta object from API: { version, author, created_by, updated_at, ... }

// Global media version cache: maps relative media paths (as in node attrs) to their max version.
window.__sargonMediaVersions = new Map()
window.__sargonUpdateMediaVersionCache = function (absPath, version) {
  const relPath = buildMediaReferencePath(pageNamespace, absPath)
  window.__sargonMediaVersions.set(relPath, version)
}
let stashedEditorState = null // ProseMirror EditorState preserved across draft exit/resume
let historyLatestVersion = null // latest version number from history listing
let draftSavedThisSession = false // true once any draft save succeeds in this edit session
let lastSavedDraftMarkdown = null // markdown from the last successful draft save
let resumedPreexistingDraft = false // true when this edit session started by resuming a draft that already existed on the server (cancel must not discard it)

let mode = "view"
let editMode = "visual"
let collabSession = null
let currentMarkdown = defaultMarkdown
let currentDoc = markdownToPM(defaultMarkdown, registry)
let editBaselineMarkdown = defaultMarkdown
let editorView = null
let rawEditor = null
let statusText = ""
let isNewPage = false
let hasTemplate = false
let isNamespaceIndex = false
let siteTitle = "Sargon"
let siteVersion = ""
let tocMaxLevel = 3
let viewView = null
let sidebarView = null
let footerView = null
let isFullscreen = false
let aiAssistantEnabled = false

const tableCommands = new Map()
const extraCommands = []
let togglePropertiesCommand = null
let includeInsertCommand = null
let databaseInsertQueryCommand = null
let databaseInsertNewRowCommand = null
let databaseInsertRowCommand = null
let databaseInsertVarCommand = null
let tagInsertCommand = null
let tagQueryInsertCommand = null
let captionInsertRefCommand = null
let footnoteInsertCommand = null
let spoilerInsertCommand = null
let chartInsertCommand = null
let mermaidInsertCommand = null
let slidesInsertCommand = null
let todoInsertCommand = null
let todoListInsertCommand = null
let currentUserThemePref = "" // "light" | "dark" | "auto" | ""
// Set of favorite page paths (canonical: leading slash, trailing slash for
// namespace indexes). Populated on login, mutated by toggleFavoriteCurrent.
const currentFavorites = new Set()
let themeAllowUserOverride = true
let todoCalendarInsertCommand = null
let publicationInsertCommand = null
let referencesInsertCommand = null
let reviewflowInsertCommand = null
let reviewflowLinkInsertCommand = null
let reviewflowQueryInsertCommand = null
let versionLinkInsertCommand = null
let changesInsertCommand = null
let highlightCommand = null
let templateInsertCommand = null
let templateTitleInsertCommand = null
let templateStampInsertCommand = null
let templateReviewflowInsertCommand = null
let templateTodoInsertCommand = null
let lifecycleInsertCommand = null

registry.onCommand((namespace, name, cmd) => {
  if (namespace === "table") {
    tableCommands.set(name, cmd)
    return
  }

  if (namespace === "ui" && name === "properties.toggle") {
    togglePropertiesCommand = cmd
    return
  }

  if (namespace === "include") {
    if (name === "insert") includeInsertCommand = cmd
    return
  }

  if (namespace === "database") {
    if (name === "insertQuery") databaseInsertQueryCommand = cmd
    if (name === "insertNewRow") databaseInsertNewRowCommand = cmd
    if (name === "insertRow") databaseInsertRowCommand = cmd
    if (name === "insertVar") databaseInsertVarCommand = cmd
    return
  }

  if (namespace === "tag") {
    if (name === "insert") tagInsertCommand = cmd
    return
  }

  if (namespace === "tag-query") {
    if (name === "insert") tagQueryInsertCommand = cmd
    return
  }

  if (namespace === "caption") {
    if (name === "insertRef") captionInsertRefCommand = cmd
    return
  }

  if (namespace === "footnote") {
    if (name === "insert") footnoteInsertCommand = cmd
    return
  }

  if (namespace === "spoiler") {
    if (name === "insert") spoilerInsertCommand = cmd
    return
  }

  if (namespace === "chart") {
    if (name === "insert") chartInsertCommand = cmd
    return
  }

  if (namespace === "mermaid_diagram") {
    if (name === "insert") mermaidInsertCommand = cmd
    return
  }

  if (namespace === "slides") {
    if (name === "insert") slidesInsertCommand = cmd
    return
  }

  if (namespace === "todo") {
    if (name === "insert") todoInsertCommand = cmd
    return
  }

  if (namespace === "todo-list") {
    if (name === "insert") todoListInsertCommand = cmd
    return
  }

  if (namespace === "todo-calendar") {
    if (name === "insert") todoCalendarInsertCommand = cmd
    return
  }

  if (namespace === "reviewflow") {
    if (name === "insert") reviewflowInsertCommand = cmd
    return
  }

  if (namespace === "reviewflow-link") {
    if (name === "insert") reviewflowLinkInsertCommand = cmd
    return
  }

  if (namespace === "reviewflow-query") {
    if (name === "insert") reviewflowQueryInsertCommand = cmd
    return
  }

  if (namespace === "version-link") {
    if (name === "insert") versionLinkInsertCommand = cmd
    return
  }

  if (namespace === "changes") {
    if (name === "insert") changesInsertCommand = cmd
    return
  }

  if (namespace === "publication") {
    if (name === "insert") publicationInsertCommand = cmd
    return
  }

  if (namespace === "references") {
    if (name === "insert") referencesInsertCommand = cmd
    return
  }

  if (namespace === "highlight") {
    highlightCommand = cmd
    return
  }

  // Template family: captured into dedicated slots so buildMenubar can
  // render them as a single icon group instead of individual text
  // buttons. Favorites is captured too so it stops appearing in the
  // toolbar — the star in the right-hand action bar already covers it.
  if (namespace === "template" && name === "insert") {
    templateInsertCommand = cmd
    return
  }
  if (namespace === "template-title" && name === "insert") {
    templateTitleInsertCommand = cmd
    return
  }
  if (namespace === "template-stamp" && name === "insert") {
    templateStampInsertCommand = cmd
    return
  }
  if (namespace === "template-reviewflow" && name === "insert") {
    templateReviewflowInsertCommand = cmd
    return
  }
  if (namespace === "template-todo" && name === "insert") {
    templateTodoInsertCommand = cmd
    return
  }
  // Lifecycle: not part of the template family but still a plugin-provided
  // insert command that deserves an icon in the toolbar instead of the
  // "lifecycle:insert" text fallback below.
  if (namespace === "lifecycle" && name === "insert") {
    lifecycleInsertCommand = cmd
    return
  }
  if (namespace === "favorites" && name === "insert") {
    // Star lives in the right-hand action bar; no toolbar duplicate.
    return
  }

  extraCommands.push({ label: `${namespace}:${name}`, cmd })
})

function findLinkMarkInMarks(marks, linkType) {
  return marks.find((mark) => mark.type === linkType) ?? null
}

// findMarkRangeAround returns the contiguous [from, to] range around $pos
// covered by a mark of the given type in the current parent's inline
// content. Returns null when $pos does not sit inside such a mark. Used by
// the highlight toolbar button to make "click to un-highlight" work on a
// bare caret (toggleMark on an empty selection only toggles PM stored
// marks — invisible to the user).
function findMarkRangeAround($pos, markType) {
  const parent = $pos.parent
  const parentStart = $pos.start()

  let childInfo = parent.childAfter($pos.parentOffset)
  if (!childInfo.node && $pos.parentOffset > 0) {
    childInfo = parent.childBefore($pos.parentOffset)
  }
  if (!childInfo.node) return null
  if (!markType.isInSet(childInfo.node.marks)) return null

  let from = parentStart + childInfo.offset
  let to = from + childInfo.node.nodeSize

  for (let i = childInfo.index - 1; i >= 0; i--) {
    const prev = parent.child(i)
    if (!markType.isInSet(prev.marks)) break
    from -= prev.nodeSize
  }
  for (let i = childInfo.index + 1; i < parent.childCount; i++) {
    const next = parent.child(i)
    if (!markType.isInSet(next.marks)) break
    to += next.nodeSize
  }
  return { from, to }
}

function findLinkRangeAtPosition(doc, linkType, pos) {
  const $from = doc.resolve(pos)
  const parent = $from.parent
  const parentStart = $from.start()

  let childInfo = parent.childAfter($from.parentOffset)
  if (!childInfo.node && $from.parentOffset > 0) {
    childInfo = parent.childBefore($from.parentOffset)
  }
  if (!childInfo.node) return null

  const link = findLinkMarkInMarks(childInfo.node.marks, linkType)
  if (!link) return null

  let from = parentStart + childInfo.offset
  let to = from + childInfo.node.nodeSize

  for (let i = childInfo.index - 1; i >= 0; i--) {
    const prev = parent.child(i)
    if (!findLinkMarkInMarks(prev.marks, linkType)) break
    from -= prev.nodeSize
  }

  for (let i = childInfo.index + 1; i < parent.childCount; i++) {
    const next = parent.child(i)
    if (!findLinkMarkInMarks(next.marks, linkType)) break
    to += next.nodeSize
  }

  return { from, to, mark: link }
}

function classifyLinkTarget(rawTarget) {
  const target = (rawTarget ?? "").trim()
  if (target.length === 0) {
    return { ok: false, error: "URL/path cannot be empty." }
  }
  if (/^https?:\/\//i.test(target)) {
    return { ok: true, normalized: target, kind: "external" }
  }
  // Encode spaces as %20 so users can type paths with spaces.
  const normalized = target.replace(/ /g, "%20")
  // Accept #fragment (same-page anchor) or internal paths starting with /, ./, ../
  if (/^(#\S+|(\/(?!\/)|\.\/|\.\.\/)\S*)$/.test(normalized)) {
    return { ok: true, normalized, kind: "internal" }
  }
  return {
    ok: false,
    error: "Use http://, https://, #anchor, or an internal path starting with '/', './', or '../'.",
  }
}

function defaultLinkTextForTarget(target) {
  if (/^https?:\/\//i.test(target)) return target
  if (/^mailto:/i.test(target)) return target.replace(/^mailto:/i, "")
  const pathOnly = target.split(/[?#]/)[0]
  const clean = pathOnly.replace(/\/+$/, "")
  const parts = clean
    .split("/")
    .filter(Boolean)
    .filter((p) => p !== "." && p !== "..")
  const raw = parts[parts.length - 1] ?? "index"
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function promptLinkForm(initialTarget, initialText) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div")
    overlay.className = "gowiki-link-modal-overlay"

    const dialog = document.createElement("div")
    dialog.className = "gowiki-link-modal"

    const title = document.createElement("div")
    title.className = "gowiki-link-modal-title"
    title.textContent = "Set link target"

    const textLabel = document.createElement("label")
    textLabel.className = "gowiki-link-modal-label"
    textLabel.textContent = "Link text"

    const textInput = document.createElement("input")
    textInput.type = "text"
    textInput.className = "gowiki-link-modal-input"
    textInput.value = initialText ?? ""
    textInput.placeholder = "(optional)"

    const targetLabel = document.createElement("label")
    targetLabel.className = "gowiki-link-modal-label"
    targetLabel.textContent = "Link target"

    const targetInput = document.createElement("input")
    targetInput.type = "text"
    targetInput.className = "gowiki-link-modal-input"
    targetInput.value = initialTarget
    targetInput.placeholder = "https://example.org or /namespace/page"

    const warning = document.createElement("div")
    warning.className = "gowiki-link-modal-warning"

    // Page search panel
    const searchPanel = document.createElement("div")
    searchPanel.className = "gowiki-link-search-panel"

    const searchHint = document.createElement("div")
    searchHint.style.cssText = "font-size:11px;color:#888;margin-bottom:4px"
    searchHint.textContent = "Type to search wiki pages, # for sections, or enter a URL"
    searchPanel.appendChild(searchHint)

    const searchResults = document.createElement("div")
    searchResults.className = "gowiki-link-search-results"
    searchPanel.appendChild(searchResults)

    let searchTimer = null
    let searchActiveIndex = -1
    let searchItems = []

    function renderLinkSearchResults(results) {
      searchResults.innerHTML = ""
      searchItems = []
      searchActiveIndex = -1
      if (results.length === 0) return
      for (const r of results) {
        const item = document.createElement("div")
        item.className = "gowiki-link-search-item"
        const isAnchor = r.path.startsWith("#")
        const displayPath = isAnchor ? r.path : r.path.startsWith("/") ? r.path : "/" + r.path
        const titleSpan = document.createElement("span")
        titleSpan.className = "gowiki-link-search-title"
        titleSpan.textContent = r.title || displayPath
        const pathSpan = document.createElement("span")
        pathSpan.className = "gowiki-link-search-path"
        pathSpan.textContent = displayPath
        if (isAnchor) {
          const hintSpan = document.createElement("span")
          hintSpan.style.cssText = "font-size:10px;color:#999;margin-left:6px"
          hintSpan.textContent = "shift: auto-title"
          item.appendChild(hintSpan)
        }
        item.appendChild(titleSpan)
        item.appendChild(pathSpan)
        item.addEventListener("click", (e) => {
          targetInput.value = displayPath
          if (isAnchor && e.shiftKey) {
            // Shift-click: leave text blank for auto-title.
            textInput.value = ""
          } else if (!textInput.value) {
            textInput.value = r.title || ""
          }
          searchResults.innerHTML = ""
          searchItems = []
          targetInput.focus()
        })
        searchResults.appendChild(item)
        searchItems.push(item)
      }
    }

    function highlightSearchItem(idx) {
      searchItems.forEach((el, i) => el.classList.toggle("active", i === idx))
      searchActiveIndex = idx
    }

    function getDocumentHeadings() {
      if (!editorView) return []
      const headings = []
      editorView.state.doc.descendants((node) => {
        if (node.type.name === "heading") {
          headings.push({ title: node.textContent, slug: slugify(node.textContent) })
          return false
        }
      })
      // Deduplicate slugs (same logic as heading ID decoration).
      const counts = new Map()
      return headings.map((h) => {
        const count = counts.get(h.slug) ?? 0
        counts.set(h.slug, count + 1)
        const id = count === 0 ? h.slug : `${h.slug}-${count}`
        return { title: h.title, path: "#" + id }
      })
    }

    async function doLinkSearch(query) {
      if (!query || query.length < 1) {
        renderLinkSearchResults([])
        return
      }
      // Anchor search: # prefix shows document headings.
      if (query.startsWith("#")) {
        const filter = query.slice(1).toLowerCase()
        const headings = getDocumentHeadings()
        const matches = headings.filter(
          (h) => h.title.toLowerCase().includes(filter) || h.path.toLowerCase().includes(filter)
        )
        renderLinkSearchResults(matches)
        return
      }
      if (query.length < 2) {
        renderLinkSearchResults([])
        return
      }
      // Don't search if it looks like a URL
      if (/^https?:\/\//i.test(query) || /^mailto:/i.test(query)) {
        renderLinkSearchResults([])
        return
      }
      try {
        const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=8`)
        if (!resp.ok) return
        const data = await resp.json()
        renderLinkSearchResults(data.results || [])
      } catch {
        /* ignore */
      }
    }

    targetInput.addEventListener("input", () => {
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => doLinkSearch(targetInput.value.trim()), 200)
    })

    const buttons = document.createElement("div")
    buttons.className = "gowiki-link-modal-actions"

    const cancelBtn = document.createElement("button")
    cancelBtn.type = "button"
    cancelBtn.textContent = "Cancel"
    cancelBtn.className = "gowiki-link-modal-btn"

    const okBtn = document.createElement("button")
    okBtn.type = "button"
    okBtn.textContent = "OK"
    okBtn.className = "gowiki-link-modal-btn"

    function close(value) {
      clearTimeout(searchTimer)
      overlay.remove()
      // Restore focus to editor.
      if (editorView) editorView.focus()
      else if (rawEditor) rawEditor.focus()
      resolve(value)
    }

    function submit() {
      const verdict = classifyLinkTarget(targetInput.value)
      if (!verdict.ok) {
        warning.textContent = verdict.error
        targetInput.focus()
        return
      }
      close({
        target: verdict.normalized,
        text: textInput.value,
      })
    }

    cancelBtn.addEventListener("click", () => close(null))
    okBtn.addEventListener("click", submit)
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(null)
    })
    targetInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        if (searchActiveIndex >= 0 && searchItems[searchActiveIndex]) {
          searchItems[searchActiveIndex].click()
        } else {
          submit()
        }
      } else if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        if (searchItems.length > 0) {
          renderLinkSearchResults([])
        } else {
          close(null)
        }
      } else if (event.key === "ArrowDown" && searchItems.length > 0) {
        event.preventDefault()
        highlightSearchItem(Math.min(searchActiveIndex + 1, searchItems.length - 1))
      } else if (event.key === "ArrowUp" && searchItems.length > 0) {
        event.preventDefault()
        highlightSearchItem(Math.max(searchActiveIndex - 1, 0))
      }
    })
    textInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        submit()
      } else if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        close(null)
      }
    })

    buttons.appendChild(cancelBtn)
    buttons.appendChild(okBtn)
    dialog.appendChild(title)
    dialog.appendChild(textLabel)
    dialog.appendChild(textInput)
    dialog.appendChild(targetLabel)
    dialog.appendChild(targetInput)
    dialog.appendChild(searchPanel)
    dialog.appendChild(warning)
    dialog.appendChild(buttons)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    targetInput.focus()
    targetInput.select()

    // If there's an initial target that looks like a search term, trigger search.
    if (
      initialTarget &&
      !initialTarget.startsWith("http") &&
      !initialTarget.startsWith("/") &&
      !initialTarget.startsWith("./")
    ) {
      doLinkSearch(initialTarget)
    }
  })
}

// The caret counts as "in a link" only strictly inside it. At either
// edge the user is typing next to the link, and Cmd+K inserts a new one.
function findLinkRangeAtCursor(state) {
  const linkType = state.schema.marks.link
  if (!linkType) return null
  if (!state.selection.empty) return null
  const pos = state.selection.from
  const range = findLinkRangeAtPosition(state.doc, linkType, pos)
  if (!range || pos <= range.from || pos >= range.to) return null
  return range
}

function isSameLinkMark(a, b) {
  if (!a || !b) return false
  return a.type === b.type && (a.attrs?.href ?? "") === (b.attrs?.href ?? "")
}

function findLinkRangeForSelection(state) {
  const linkType = state.schema.marks.link
  if (!linkType) return null
  if (state.selection.empty) return findLinkRangeAtCursor(state)

  const { from, to } = state.selection
  let selectedMark = null
  let hasNonWhitespace = false
  let invalid = false

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || invalid) return
    const start = Math.max(from, pos)
    const end = Math.min(to, pos + node.nodeSize)
    if (end <= start) return

    const chunk = (node.text ?? "").slice(start - pos, end - pos)
    if (chunk.trim().length === 0) return
    hasNonWhitespace = true

    const mark = findLinkMarkInMarks(node.marks, linkType)
    if (!mark) {
      invalid = true
      return
    }
    if (!selectedMark) {
      selectedMark = mark
      return
    }
    if (!isSameLinkMark(selectedMark, mark)) {
      invalid = true
    }
  })

  if (invalid || !hasNonWhitespace || !selectedMark) return null

  let anchor = null
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || anchor !== null) return
    const start = Math.max(from, pos)
    const end = Math.min(to, pos + node.nodeSize)
    if (end <= start) return

    const chunk = (node.text ?? "").slice(start - pos, end - pos)
    if (chunk.trim().length === 0) return
    const mark = findLinkMarkInMarks(node.marks, linkType)
    if (mark && isSameLinkMark(selectedMark, mark)) {
      anchor = start
    }
  })
  if (anchor === null) return null

  const linkAtAnchor = findLinkRangeAtPosition(state.doc, linkType, anchor)
  if (!linkAtAnchor || !isSameLinkMark(selectedMark, linkAtAnchor.mark)) return null
  return linkAtAnchor
}

// True while the Cmd+K link dialog is open. The editor loses focus to
// the dialog; the blur tidy-up is skipped meanwhile so the text the user
// was typing (e.g. a trailing space) stays exactly as it was.
let linkDialogOpen = false

function setExternalLinkCommand() {
  return (state, dispatch, view) => {
    const linkType = state.schema.marks.link
    if (!linkType) return false

    let target = null
    let currentHref = ""
    let currentText = ""

    const linkForSelection = findLinkRangeForSelection(state)
    if (linkForSelection) {
      target = { from: linkForSelection.from, to: linkForSelection.to }
      currentHref = linkForSelection.mark.attrs.href ?? ""
      currentText = state.doc.textBetween(linkForSelection.from, linkForSelection.to, "")
    } else if (!state.selection.empty) {
      target = { from: state.selection.from, to: state.selection.to }
      currentText = state.doc.textBetween(state.selection.from, state.selection.to, "")
    }
    // With nothing selected and the caret outside any link, Cmd+K inserts
    // a new link at the caret. The text is left empty so the link shows
    // the target page's title; the neighbouring word is left alone.

    const promptSeed = currentHref || "https://"
    linkDialogOpen = true
    void promptLinkForm(promptSeed, currentText).then((form) => {
      linkDialogOpen = false
      if (form === null) return
      const activeState = view.state
      const activeDispatch = view.dispatch
      const activeLinkType = activeState.schema.marks.link
      if (!activeLinkType) return

      let activeTarget = null
      const activeLinkForSelection = findLinkRangeForSelection(activeState)
      if (activeLinkForSelection) {
        activeTarget = {
          from: activeLinkForSelection.from,
          to: activeLinkForSelection.to,
        }
      } else if (!activeState.selection.empty) {
        activeTarget = {
          from: activeState.selection.from,
          to: activeState.selection.to,
        }
      }

      const normalized = form.target
      const isAutoText = form.text.trim().length === 0
      const displayText = isAutoText ? defaultLinkTextForTarget(normalized) : form.text

      const tr = activeState.tr
      const linkMark = activeLinkType.create({
        href: normalized,
        autoText: isAutoText,
      })
      if (activeTarget) {
        tr.insertText(displayText, activeTarget.from, activeTarget.to)
        const markFrom = activeTarget.from
        const markTo = activeTarget.from + displayText.length
        tr.removeMark(markFrom, markTo, activeLinkType)
        tr.addMark(markFrom, markTo, linkMark)
        tr.setSelection(TextSelection.create(tr.doc, markTo))
      } else {
        // Caret (text cursor or gap cursor): insert a linked text node.
        // replaceSelectionWith wraps it in a paragraph where text is not
        // allowed directly, and leaves the caret right after the link.
        tr.replaceSelectionWith(activeState.schema.text(displayText, [linkMark]), false)
      }
      tr.removeStoredMark(activeLinkType)
      setStatus("Link updated")
      activeDispatch(tr.scrollIntoView())
      view.focus()
    })
    return true
  }
}

function applyStyles(styles) {
  for (const { id, css } of styles) {
    const styleId = `gowiki-style-${id}`
    const existing = document.getElementById(styleId)
    if (existing) {
      // Update if content changed (e.g. after HMR).
      if (existing.textContent !== css) existing.textContent = css
      continue
    }
    const style = document.createElement("style")
    style.id = styleId
    style.textContent = css
    document.head.appendChild(style)
  }
}

function encodePagePath(path) {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/")
}

// ── Dark-mode image auto-frame (specs/themes.md §11.6) ─────────────────
//
// On dark pages, images with near-white backgrounds look like bright
// blocks. This heuristic samples the 4 corners of each <img> and wraps
// the ones with ≥3 near-white corners in a subtle cream frame (via
// a .gowiki-img-auto-invert class). Images with an explicit data-bg attribute
// bypass the heuristic — the author has already chosen.
//
// Runs only when html[data-theme="dark"] AND the admin hasn't disabled
// it (themes.image_auto_frame). Results are cached per URL so each image
// is sampled at most once per page load.

// Cache: src → "invert" | "skip". "invert" means the heuristic decided to
// apply the auto-invert class; "skip" means either the image isn't
// near-white or the canvas sampling was blocked (CORS).
const imageBgCache = new Map()

function applyImageAutoFrame(img) {
  // Skip if the admin disabled the heuristic.
  const info = (window.__sargonSiteInfo && window.__sargonSiteInfo.theme) || null
  if (info && info.image_auto_frame === false) return
  // Skip if the author has an explicit choice.
  if (img.dataset.bg) return
  // Skip if an ancestor blockquote has set a cascade.
  if (img.closest && img.closest("blockquote[data-image-bg]")) return
  // Skip if we've already decided for this URL.
  const cached = imageBgCache.get(img.src)
  if (cached === "invert") {
    img.classList.add("gowiki-img-auto-invert")
    return
  }
  if (cached === "skip") return
  // Need the image loaded and same-origin for canvas sampling.
  if (!img.complete || img.naturalWidth === 0) {
    img.addEventListener("load", () => applyImageAutoFrame(img), { once: true })
    return
  }
  try {
    const canvas = document.createElement("canvas")
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext("2d", { willReadFrequently: false })
    if (!ctx) return
    ctx.drawImage(img, 0, 0)
    const corners = [
      [0, 0],
      [canvas.width - 1, 0],
      [0, canvas.height - 1],
      [canvas.width - 1, canvas.height - 1],
    ]
    let nearWhite = 0
    for (const [x, y] of corners) {
      const d = ctx.getImageData(x, y, 1, 1).data
      // R+G+B ≥ 720 means average channel ≥ 240 — visibly near-white.
      // Require alpha > 200 so we don't count transparent corners as "white".
      if (d[3] > 200 && d[0] + d[1] + d[2] >= 720) nearWhite++
    }
    if (nearWhite >= 3) {
      img.classList.add("gowiki-img-auto-invert")
      imageBgCache.set(img.src, "invert")
    } else {
      imageBgCache.set(img.src, "skip")
    }
  } catch {
    // Canvas tainted (cross-origin image, CORS) — silently skip.
    imageBgCache.set(img.src, "skip")
  }
}

function scanImagesForAutoFrame(root) {
  if (document.documentElement.dataset.theme !== "dark") return
  const imgs = (root || document).querySelectorAll("img")
  for (const img of imgs) applyImageAutoFrame(img)
}

// Expose to plugins so they can re-trigger the heuristic when an image's
// attributes change (e.g. user toggles bg from "light" back to "auto"
// via the property panel).
if (typeof window !== "undefined") {
  window.__sargonAutoFrameImage = applyImageAutoFrame
}

// Re-scan after theme change (light → dark activates framing).
if (typeof window !== "undefined") {
  window.addEventListener("gowiki:theme-changed", (e) => {
    if (e && e.detail && e.detail.theme === "dark") {
      scanImagesForAutoFrame(document)
    } else {
      // Going back to light mode — drop all frame classes so re-entering
      // dark from a subsequent toggle re-runs the heuristic with a clean slate.
      for (const img of document.querySelectorAll("img.gowiki-img-auto-invert")) {
        img.classList.remove("gowiki-img-auto-invert")
      }
    }
  })
  // Watch the whole body for images added after initial render (includes,
  // async-rendered blocks, ProseMirror NodeView insertions, etc.). Wider
  // than just #content to catch sidebars and any wrappers.
  const imgObserver = new MutationObserver((mutations) => {
    if (document.documentElement.dataset.theme !== "dark") return
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue
        if (n.tagName === "IMG") applyImageAutoFrame(n)
        else if (n.querySelectorAll) {
          for (const img of n.querySelectorAll("img")) applyImageAutoFrame(img)
        }
      }
    }
  })
  // Module scripts execute after DOMContentLoaded, so our handler on that
  // event would never fire. Start the observer as soon as <body> exists,
  // and run an initial scan. Both are re-entrant so double-invocation is
  // harmless.
  function initImageAutoFrame() {
    if (document.body) {
      scanImagesForAutoFrame(document)
      imgObserver.observe(document.body, { childList: true, subtree: true })
    } else {
      // <body> not parsed yet — retry on next microtask.
      setTimeout(initImageAutoFrame, 10)
    }
  }
  initImageAutoFrame()
}

// resolveTheme translates a stored preference ("light"/"dark"/"auto"/"") into
// an effective theme, consulting the OS for "auto" and falling back to the
// admin default.
function resolveTheme(pref, adminDefault) {
  const p = pref || adminDefault || "auto"
  if (p === "light" || p === "dark") return p
  try {
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  } catch {
    return "light"
  }
}

// applyTheme writes the effective theme to <html> and notifies plugins that
// care (e.g. mermaid/chart re-render on theme change).
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  try {
    window.dispatchEvent(new CustomEvent("gowiki:theme-changed", { detail: { theme } }))
  } catch {
    /* ignore */
  }
}

// setThemePreference saves the user's pref and immediately applies the
// resolved theme. Writes localStorage + the backend when authenticated.
async function setThemePreference(pref) {
  currentUserThemePref = pref
  try {
    localStorage.setItem("gowiki-theme", pref)
  } catch {
    /* ignore */
  }
  const adminDefault =
    (window.__sargonSiteInfo && window.__sargonSiteInfo.theme && window.__sargonSiteInfo.theme.default) || "auto"
  applyTheme(resolveTheme(pref, adminDefault))
  if (currentUser) {
    try {
      await fetch("/api/auth/me/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme_preference: pref }),
      })
    } catch {
      /* best effort */
    }
  }
}

// Keep "auto" tracking the OS preference in real time.
try {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const pref = currentUserThemePref || localStorage.getItem("gowiki-theme") || "auto"
    if (pref === "auto" || !pref) {
      const adminDefault =
        (window.__sargonSiteInfo && window.__sargonSiteInfo.theme && window.__sargonSiteInfo.theme.default) || "auto"
      applyTheme(resolveTheme(pref, adminDefault))
    }
  })
} catch {
  /* ignore on unsupported browsers */
}

// waitForQuietDOM resolves once the given root has been visually stable for
// `quietMs`. "Stable" means: every <img> is loaded (or has failed), and no
// DOM mutation has been observed for the last `quietMs` milliseconds.
// `maxWaitMs` is a safety cap so a misbehaving renderer never blocks forever.
//
// Used by the PDF export path to defer the data-export-ready signal until
// async renderers (mermaid, charts, includes, images) have settled.
async function waitForQuietDOM(root, quietMs = 750, maxWaitMs = 20000) {
  const start = Date.now()

  // Wait for all images inside the root to finish loading.
  const imgs = Array.from(root.querySelectorAll("img"))
  await Promise.all(
    imgs.map((img) => {
      if (img.complete) return Promise.resolve()
      return new Promise((resolve) => {
        const finish = () => {
          img.removeEventListener("load", finish)
          img.removeEventListener("error", finish)
          resolve()
        }
        img.addEventListener("load", finish)
        img.addEventListener("error", finish)
      })
    })
  )

  // Then watch for DOM activity; declare "quiet" after quietMs of stillness.
  let lastActivity = Date.now()
  const observer = new MutationObserver(() => {
    lastActivity = Date.now()
  })
  observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true })

  try {
    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 100))
      if (Date.now() - lastActivity >= quietMs) return
    }
  } finally {
    observer.disconnect()
  }
}

// selectTemplateForNewPage fetches the templates applicable to a new page
// path and returns the chosen markdown. When several templates match, a
// picker modal is shown and the user's selection decides.
//
// Returns null when the user wants a blank page or when no template applies.
async function selectTemplateForNewPage(pagePath) {
  let templates = []
  try {
    const resp = await fetch(`/api/templates/for/${encodePagePath(pagePath)}`)
    if (resp.ok) {
      const data = await resp.json()
      templates = Array.isArray(data.templates) ? data.templates : []
    }
  } catch (err) {
    console.error("[gowiki] template fetch error:", err)
    return null
  }

  if (templates.length === 0) return null
  if (templates.length === 1) return templates[0].markdown || null

  return new Promise((resolve) => {
    const overlay = document.createElement("div")
    overlay.className = "gowiki-login-overlay gowiki-template-picker-overlay"

    const dialog = document.createElement("div")
    dialog.className = "gowiki-login-dialog gowiki-template-picker"
    dialog.style.minWidth = "360px"

    const title = document.createElement("h3")
    title.textContent = "Start from a template"
    title.style.margin = "0 0 12px"
    dialog.appendChild(title)

    const subtitle = document.createElement("div")
    subtitle.style.color = "#666"
    subtitle.style.fontSize = "13px"
    subtitle.style.marginBottom = "12px"
    subtitle.textContent = "Several templates apply to this page. Pick one, or start blank."
    dialog.appendChild(subtitle)

    const list = document.createElement("div")
    list.className = "gowiki-template-picker-list"

    const makeRow = (opts) => {
      const row = document.createElement("button")
      row.type = "button"
      row.className = "gowiki-template-picker-row"
      const label = document.createElement("div")
      label.className = "gowiki-template-picker-label"
      label.textContent = opts.label
      row.appendChild(label)
      if (opts.hint) {
        const hint = document.createElement("div")
        hint.className = "gowiki-template-picker-hint"
        hint.textContent = opts.hint
        row.appendChild(hint)
      }
      row.addEventListener("click", () => {
        document.body.removeChild(overlay)
        resolve(opts.markdown)
      })
      return row
    }

    for (const tmpl of templates) {
      const suffix = tmpl.constrained ? " (" + tmpl.slug + "*)" : ""
      list.appendChild(
        makeRow({
          label: tmpl.label + suffix,
          hint: tmpl.template_path,
          markdown: tmpl.markdown || "",
        })
      )
    }
    list.appendChild(
      makeRow({
        label: "Blank page",
        hint: "Start from an empty page",
        markdown: null,
      })
    )

    dialog.appendChild(list)
    overlay.appendChild(dialog)

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        document.body.removeChild(overlay)
        resolve(null)
      }
    })

    document.body.appendChild(overlay)
  })
}

function splitPathParts(raw) {
  return String(raw ?? "")
    .split("/")
    .filter(Boolean)
}

function encodePathSegments(segments) {
  return segments.map((s) => encodeURIComponent(s)).join("/")
}

function buildMediaReferencePath(currentNamespace, mediaPath) {
  const from = splitPathParts(currentNamespace)
  const to = splitPathParts(mediaPath)

  let idx = 0
  while (idx < from.length && idx < to.length && from[idx] === to[idx]) {
    idx += 1
  }

  const upCount = from.length - idx
  const down = encodePathSegments(to.slice(idx))

  if (upCount <= 2) {
    if (upCount === 0) return "./" + down
    return "../".repeat(upCount) + down
  }

  return "/" + encodePathSegments(to)
}

function appendMediaVersion(target, version) {
  if (version && version > 1) return `${target}?v=${version}`
  return target
}

function mediaLabelFromPath(mediaPath) {
  const parts = splitPathParts(mediaPath)
  const raw = parts[parts.length - 1] ?? "file"
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function rawInsertMediaReference(kind, mediaEntry) {
  const textarea = document.querySelector(".gowiki-raw-editor")
  if (!textarea) return

  const target = appendMediaVersion(buildMediaReferencePath(pageNamespace, mediaEntry.path), mediaEntry.version)
  const label = mediaLabelFromPath(mediaEntry.path)

  let snippet
  if (kind === "image") {
    snippet = `![${label}](${target})`
  } else {
    snippet = `[${label}](${target})`
  }

  textarea.focus()
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  textarea.setSelectionRange(start, end)
  rawInsertText(textarea, snippet)
  setStatus("Inserted " + (kind === "image" ? "image" : "link") + " " + target)
}

function insertMediaReference(kind, mediaEntry) {
  if (!editorView || mode !== "edit" || editMode !== "visual") return

  const basePath = buildMediaReferencePath(pageNamespace, mediaEntry.path)
  const label = mediaLabelFromPath(mediaEntry.path)
  const version = mediaEntry.version && mediaEntry.version > 1 ? String(mediaEntry.version) : null

  // Update media version cache so the property panel dropdown knows the max version.
  if (mediaEntry.version > 0) {
    window.__sargonMediaVersions.set(basePath, mediaEntry.version)
  }
  const state = editorView.state
  const tr = state.tr

  if (kind === "image" && state.schema.nodes.image) {
    const imageNode = state.schema.nodes.image.create({
      src: basePath,
      alt: label,
      title: null,
      version,
    })
    tr.replaceSelectionWith(imageNode, false)
    editorView.dispatch(tr.scrollIntoView())
    editorView.focus()
    setStatus("Inserted image " + basePath)
    return
  }

  // Use medialink node for non-image media files
  if (state.schema.nodes.medialink) {
    const medialinkNode = state.schema.nodes.medialink.create({
      href: basePath,
      label,
      version,
      title: null,
      autoText: false,
    })
    tr.replaceSelectionWith(medialinkNode, false)
    editorView.dispatch(tr.scrollIntoView())
    editorView.focus()
    setStatus("Inserted media link " + basePath)
    return
  }

  // Fallback: use link mark if medialink node not available
  const target = appendMediaVersion(basePath, mediaEntry.version)
  const linkType = state.schema.marks.link
  if (!linkType) return

  const from = state.selection.from
  const to = state.selection.to
  tr.insertText(label, from, to)
  const end = from + label.length
  tr.addMark(from, end, linkType.create({ href: target, autoText: false }))
  tr.setSelection(TextSelection.create(tr.doc, from, end))
  editorView.dispatch(tr.scrollIntoView())
  editorView.focus()
  setStatus("Inserted link " + target)
}

class AccessDeniedError extends Error {
  constructor(path) {
    super(`Access denied: ${path}`)
    this.name = "AccessDeniedError"
  }
}

class InvalidPathError extends Error {
  constructor(path, detail) {
    super(detail || `Invalid page path: ${path}`)
    this.name = "InvalidPathError"
  }
}

async function fetchPage(path) {
  const resp = await fetch(`/api/pages/${encodePagePath(path)}`)
  if (resp.status === 404) return null
  if (resp.status === 403) throw new AccessDeniedError(path)
  if (resp.status === 400) {
    const data = await resp.json().catch(() => ({}))
    throw new InvalidPathError(path, data.error || "Invalid page path")
  }
  if (!resp.ok) {
    throw new Error(`Failed to load page ${path}: ${resp.status}`)
  }
  return await resp.json()
}

class CircularIncludeError extends Error {
  constructor(cycle) {
    super(`Circular include detected: ${cycle.join(" → ")}`)
    this.name = "CircularIncludeError"
    this.cycle = cycle
  }
}

async function savePage(path, markdown) {
  const resp = await authFetch(`/api/pages/${encodePagePath(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown }),
  })
  if (resp.status === 422) {
    const body = await resp.json()
    if (body.cycle) {
      throw new CircularIncludeError(body.cycle)
    }
    throw new Error(body.error || `Save rejected: ${resp.status}`)
  }
  if (!resp.ok) {
    throw new Error(`Failed to save page ${path}: ${resp.status}`)
  }
  return await resp.json()
}

async function deleteMedia(mediaPath) {
  const resp = await authFetch(`/api/media/${encodePagePath(mediaPath)}`, {
    method: "DELETE",
  })
  return resp.ok
}

function promptOrphanDeletion(orphanedMedia) {
  const names = orphanedMedia.map((p) => p.split("/").pop())
  const msg =
    orphanedMedia.length === 1
      ? `"${names[0]}" is no longer referenced. Delete it?`
      : `${orphanedMedia.length} files are no longer referenced:\n${names.join(", ")}\nDelete them?`
  if (!confirm(msg)) return

  Promise.all(orphanedMedia.map(deleteMedia)).then((results) => {
    const deleted = results.filter(Boolean).length
    if (deleted > 0) {
      setStatus(`Deleted ${deleted} orphaned file${deleted > 1 ? "s" : ""}`)
    }
  })
}

// ── Paste helpers ─────────────────────────────────────

function buildMediaApiUrl(namespacePath) {
  const encoded = encodePagePath(namespacePath)
  return encoded ? `/api/media/${encoded}` : "/api/media"
}

function generatePasteFilename(originalName) {
  const ext = (originalName.match(/\.([^.]+)$/) ?? [])[1] ?? "png"
  const now = new Date()
  const ts =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    "-" +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0")
  const rand = Math.random().toString(36).slice(2, 6)
  return `paste-${ts}-${rand}.${ext}`
}

async function uploadMediaFile(file) {
  // Rename to a unique timestamped name to avoid collisions
  const uniqueName = generatePasteFilename(file.name)
  const renamedFile = new File([file], uniqueName, { type: file.type })
  const form = new FormData()
  form.append("file", renamedFile)
  form.append("overwrite", "false")
  const resp = await authFetch(buildMediaApiUrl(pageNamespace), {
    method: "POST",
    body: form,
  })
  if (!resp.ok) {
    throw new Error(`Upload failed: ${resp.status}`)
  }
  const data = await resp.json()
  return data.entry
}

function extractImageFiles(clipboardData) {
  if (!clipboardData) return []
  // Check items first (broader coverage than files in some browsers)
  const items = clipboardData.items
  if (items) {
    const found = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === "file" && /^image\//.test(item.type)) {
        const file = item.getAsFile()
        if (file) found.push(file)
      }
    }
    if (found.length > 0) return found
  }
  // Fallback to files
  const files = clipboardData.files
  if (files && files.length > 0) {
    return Array.from(files).filter((f) => /^image\//.test(f.type))
  }
  return []
}

async function handleImageFilePaste(view, imageFiles) {
  for (const file of imageFiles) {
    try {
      const entry = await uploadMediaFile(file)
      const basePath = buildMediaReferencePath(pageNamespace, entry.path)
      const version = entry.version && entry.version > 1 ? String(entry.version) : null
      const label = mediaLabelFromPath(entry.path)
      if (entry.version > 0) {
        window.__sargonMediaVersions.set(basePath, entry.version)
      }

      const imageNode = schema.nodes.image.create({
        src: basePath,
        alt: label,
        title: null,
        version,
      })
      const tr = view.state.tr.replaceSelectionWith(imageNode, false)
      view.dispatch(tr.scrollIntoView())
      setStatus("Pasted image " + basePath)
    } catch (err) {
      console.error("Image paste upload failed", err)
      setStatus("Image paste failed: " + err.message)
    }
  }
}

function dataUrlToFile(dataUrl, baseName) {
  const commaIdx = dataUrl.indexOf(",")
  const header = dataUrl.slice(0, commaIdx)
  const base64 = dataUrl.slice(commaIdx + 1)
  const mime = (header.match(/data:([^;]+)/) ?? [])[1] ?? "application/octet-stream"
  const ext = mime.split("/")[1] ?? "bin"
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new File([bytes], `${baseName}.${ext}`, { type: mime })
}

// Detect if markdown contains images with non-storable src (data URLs, file://, blob://)
// External http(s):// images are kept as-is — they render fine in <img> tags.
function hasNonLocalImages(md) {
  return /!\[[^\]]*\]\((data:|file:\/\/|blob:)/.test(md)
}

// Load an image URL into a canvas and return a blob
function fetchImageAsBlob(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext("2d")
        ctx.drawImage(img, 0, 0)
        canvas.toBlob((blob) => {
          if (blob) resolve(blob)
          else reject(new Error("Canvas toBlob failed"))
        }, "image/png")
      } catch (err) {
        reject(err)
      }
    }
    img.onerror = () => reject(new Error("Image load failed: " + url))
    img.src = url
  })
}

// Upload a single image from its URL (data:, file://, http(s)://) and return wiki path
async function uploadImageFromUrl(url) {
  if (url.startsWith("data:")) {
    const file = dataUrlToFile(url, "pasted-image-" + Date.now())
    const entry = await uploadMediaFile(file)
    return appendMediaVersion(buildMediaReferencePath(pageNamespace, entry.path), entry.version)
  }
  // For file://, blob://, http(s):// — try to load via canvas
  const blob = await fetchImageAsBlob(url)
  const ext = blob.type?.split("/")[1] ?? "png"
  const file = new File([blob], "pasted-image-" + Date.now() + "." + ext, { type: blob.type })
  const entry = await uploadMediaFile(file)
  return appendMediaVersion(buildMediaReferencePath(pageNamespace, entry.path), entry.version)
}

// Process markdown that contains non-storable image URLs: upload each and rewrite src
async function handleNonLocalImagePaste(view, md, slice, plainText) {
  const re = /!\[([^\]]*)\]\(((data:|file:\/\/|blob:)[^)]*)\)/g
  let result = md
  let match
  const replacements = []
  while ((match = re.exec(md)) !== null) {
    replacements.push({ fullMatch: match[0], alt: match[1], url: match[2] })
  }

  let uploadedCount = 0
  for (const { fullMatch, alt, url } of replacements) {
    try {
      const target = await uploadImageFromUrl(url)
      const newAlt = alt && !alt.startsWith("file://") && !alt.startsWith("http") ? alt : mediaLabelFromPath(target)
      result = result.replace(fullMatch, `![${newAlt}](${target})`)
      uploadedCount++
    } catch (err) {
      console.warn("Could not upload pasted image:", url, err)
      // Remove the un-uploadable image
      result = result.replace(fullMatch, "")
    }
  }

  try {
    const cleanDoc = markdownToPM(result, registry)
    let openStart = 0
    let openEnd = 0
    const fc = cleanDoc.content.firstChild
    if (cleanDoc.content.childCount === 1 && fc && fc.type === schema.nodes.paragraph) {
      openStart = Math.min(slice.openStart, 1)
      openEnd = Math.min(slice.openEnd, 1)
    }
    const tr = view.state.tr.replaceSelection(new Slice(cleanDoc.content, openStart, openEnd))
    view.dispatch(tr)
    if (uploadedCount > 0) {
      setStatus(`Uploaded ${uploadedCount} pasted image${uploadedCount > 1 ? "s" : ""}`)
    }
  } catch {
    view.dispatch(view.state.tr.insertText(plainText))
  }
}

function cleanupPastedMarkdown(md) {
  // Convert common bullet-like characters at line starts to markdown list markers
  // ·(middle dot) •(bullet) ◦(white bullet) ▪(small square) ‣(triangular) ►(pointer) –(en dash) —(em dash)
  md = md.replace(/^([ \t]*)[·•◦▪‣►–—]\s+/gm, "$1- ")

  // Collapse excessive whitespace after numbered list markers: "1.       text" → "1. text"
  md = md.replace(/^(\d+\.)\s{2,}/gm, "$1 ")

  return md
}

function normalizeMarkdownForStorage(markdown) {
  const doc = markdownToPM(markdown, registry)
  const normalizedMarkdown = pmToMarkdown(doc, registry)

  // Second round-trip: verify stability
  let roundTripError = false
  let roundTripFirstDiffLine = -1
  let roundTripDiagnostics = ""
  try {
    const doc2 = markdownToPM(normalizedMarkdown, registry)
    const md3 = pmToMarkdown(doc2, registry)
    if (md3 !== normalizedMarkdown) {
      const out = []
      out.push("Round-trip validation failed: serialize→parse→serialize not stable")
      const lines1 = normalizedMarkdown.split("\n")
      const lines2 = md3.split("\n")
      const maxLines = Math.max(lines1.length, lines2.length)
      let firstDiff = -1
      for (let i = 0; i < maxLines; i++) {
        const a = lines1[i] ?? "(missing)"
        const b = lines2[i] ?? "(missing)"
        if (a !== b) {
          if (firstDiff === -1) {
            firstDiff = i
            out.push("  --- context before first diff ---")
            for (let j = Math.max(0, i - 5); j < i; j++) {
              out.push(`  line ${j + 1}: ${JSON.stringify(lines1[j])}`)
            }
            out.push("  --- differences ---")
          }
          out.push(`  line ${i + 1} differs:`)
          out.push(`    pass1: ${JSON.stringify(a)}`)
          out.push(`    pass2: ${JSON.stringify(b)}`)
        }
      }
      if (lines1.length !== lines2.length) {
        out.push(`  line count: pass1=${lines1.length}, pass2=${lines2.length}`)
      }
      roundTripDiagnostics = out.join("\n")
      roundTripFirstDiffLine = firstDiff >= 0 ? firstDiff + 1 : -1
      console.error(roundTripDiagnostics)
      roundTripError = true
    }
  } catch (err) {
    roundTripDiagnostics = "Round-trip validation threw: " + (err.stack || err.message || String(err))
    console.error("Round-trip validation threw:", err)
    roundTripError = true
  }

  return {
    markdown: normalizedMarkdown,
    doc,
    changed: normalizedMarkdown !== markdown,
    roundTripError,
    roundTripFirstDiffLine,
    roundTripDiagnostics,
  }
}

// ── Database-row raw-mode validation ──

function extractDatabaseRowBlocks(markdown) {
  const lines = markdown.split("\n")
  const blocks = []
  const directiveRe = /^\{database-row\s+table=(?:"([^"]+)"|'([^']+)'|(\S+?))\s*\}$/
  const rowRe = /^\|(.+)\|(.+)\|$/
  const sepRe = /^\|[\s-]+\|[\s-]+\|$/
  let inCode = false
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("```")) {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    const m = lines[i].trim().match(directiveRe)
    if (!m) continue
    const table = m[1] || m[2] || m[3]
    const fields = {}
    i++
    while (i < lines.length && lines[i].trim() === "") i++
    if (i < lines.length && rowRe.test(lines[i])) i++ // header
    if (i < lines.length && sepRe.test(lines[i])) i++ // separator
    while (i < lines.length && rowRe.test(lines[i])) {
      const rm = lines[i].match(rowRe)
      if (rm) fields[rm[1].trim()] = rm[2].trim()
      i++
    }
    i--
    blocks.push({ table, fields })
  }
  return blocks
}

const databaseSchemaCache = new Map()

async function getDatabaseSchema(tableName) {
  const cached = databaseSchemaCache.get(tableName)
  if (cached && Date.now() - cached.fetchedAt < 60000) return cached.schema
  const resp = await fetch(`/api/database/${encodeURIComponent(tableName)}/schema`)
  if (!resp.ok) return null
  const schema = await resp.json()
  databaseSchemaCache.set(tableName, { schema, fetchedAt: Date.now() })
  return schema
}

async function validateDatabaseRows(markdown) {
  const errors = []
  const baselineBlocks = extractDatabaseRowBlocks(editBaselineMarkdown)
  const currentBlocks = extractDatabaseRowBlocks(markdown)

  // Reject multiple bound database-row blocks
  if (currentBlocks.length > 1) {
    errors.push("A page cannot contain more than one bound database-row block")
  }

  // On non-row-bound pages, reject any bound database-row block
  if (baselineBlocks.length === 0 && currentBlocks.length > 0) {
    errors.push(
      "Cannot add a bound database-row block to a non-row-bound page — only the {database-row} placeholder is allowed here"
    )
  }

  // Check that every baseline block still exists
  for (const base of baselineBlocks) {
    const match = currentBlocks.find((b) => b.table === base.table)
    if (!match) {
      errors.push(`Cannot remove database-row block (table: ${base.table})`)
      continue
    }
    // Check that every baseline field still exists
    for (const fieldName of Object.keys(base.fields)) {
      if (!(fieldName in match.fields)) {
        errors.push(`Cannot remove field '${fieldName}' from database-row (table: ${base.table})`)
      }
    }
  }

  // Validate enum values against schema
  for (const block of currentBlocks) {
    const tableSchema = await getDatabaseSchema(block.table)
    if (!tableSchema || !tableSchema.fields) continue
    for (const field of tableSchema.fields) {
      if (!(field.name in block.fields)) continue
      const value = block.fields[field.name]
      if (field.type === "enum" && field.enum_values) {
        if (value !== "" && !field.enum_values.includes(value)) {
          errors.push(
            `Invalid value '${value}' for enum field '${field.name}' (table: ${block.table}). Allowed: ${field.enum_values.join(", ")}`
          )
        }
      } else if (field.type === "multi_enum" && field.enum_values) {
        // Strip legacy bracket wrapping (e.g. "[France]" from older buggy
        // serializations) before splitting, so the validator points at the
        // real culprits rather than the brackets.
        const cleaned = String(value).replace(/^\s*\[(.*)\]\s*$/, "$1")
        if (cleaned !== "") {
          const tokens = cleaned
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
          for (const token of tokens) {
            if (!field.enum_values.includes(token)) {
              errors.push(
                `Invalid value '${token}' in multi-enum field '${field.name}' (table: ${block.table}). Allowed: ${field.enum_values.join(", ")}`
              )
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

function applyNormalizedEditState(normalized) {
  currentMarkdown = normalized.markdown
  currentDoc = normalized.doc

  if (mode !== "edit") return

  if (editMode === "raw" && rawEditor) {
    if (rawEditor.value !== normalized.markdown) {
      rawEditor.value = normalized.markdown
    }
    autoResizeRawEditor(rawEditor)
    return
  }

  if (editMode === "visual" && editorView && normalized.changed) {
    // Replace only the span that normalization changed. Replacing the
    // whole document maps the caret to the end of the page, so a link or
    // attachment inserted after a blur (dialog, media manager) landed at
    // the bottom instead of where the user was.
    const oldDoc = editorView.state.doc
    const newDoc = normalized.doc
    const start = oldDoc.content.findDiffStart(newDoc.content)
    if (start == null) return
    let { a: endA, b: endB } = oldDoc.content.findDiffEnd(newDoc.content)
    const overlap = start - Math.min(endA, endB)
    if (overlap > 0) {
      endA += overlap
      endB += overlap
    }
    const tr = editorView.state.tr.replace(start, endA, newDoc.slice(start, endB))
    tr.setMeta("addToHistory", false)
    editorView.dispatch(tr)
  }
}

let statusToastEl = null
let statusToastTimer = null

window.__sargonSetStatus = function (text, isError) {
  setStatus(text, isError)
}

function setStatus(text, isError, details) {
  statusText = text
  if (!text) return
  // Auto-detect errors if not explicitly specified.
  if (isError === undefined) {
    isError = /^(Failed|Invalid|Cannot|Error|.*failed|.*error)/i.test(text)
  }
  if (!statusToastEl) {
    statusToastEl = document.createElement("div")
    statusToastEl.className = "gowiki-action-toast"
    document.body.appendChild(statusToastEl)
  }
  statusToastEl.textContent = ""
  if (isError) {
    statusToastEl.classList.add("visible", "gowiki-toast-error")
    statusToastEl.classList.toggle("gowiki-toast-with-details", !!details)
    const row = document.createElement("div")
    row.className = "gowiki-toast-row"
    const msg = document.createElement("span")
    msg.textContent = text
    row.appendChild(msg)
    const dismissBtn = document.createElement("button")
    dismissBtn.textContent = "\u2715"
    dismissBtn.className = "gowiki-toast-dismiss"
    dismissBtn.addEventListener("click", () =>
      statusToastEl.classList.remove("visible", "gowiki-toast-error", "gowiki-toast-with-details")
    )
    row.appendChild(dismissBtn)
    statusToastEl.appendChild(row)
    if (details) {
      const det = document.createElement("details")
      det.className = "gowiki-toast-details"
      const sum = document.createElement("summary")
      sum.textContent = "Details"
      det.appendChild(sum)
      const pre = document.createElement("pre")
      pre.textContent = details
      det.appendChild(pre)
      statusToastEl.appendChild(det)
    }
    clearTimeout(statusToastTimer)
    // No auto-dismiss for errors.
  } else {
    statusToastEl.classList.remove("gowiki-toast-error")
    statusToastEl.classList.add("visible")
    statusToastEl.textContent = text
    clearTimeout(statusToastTimer)
    statusToastTimer = setTimeout(() => {
      statusToastEl.classList.remove("visible")
    }, 3000)
  }
}

function setMode(nextMode) {
  setPropertiesPanelEditable(nextMode === "edit")

  if (mode !== "edit" && nextMode === "edit") {
    editBaselineMarkdown = currentMarkdown
  }

  if (mode === "edit" && nextMode !== "edit") {
    editBaselineMarkdown = currentMarkdown
    stopAutoSave()
    stopCollabSession()
    closeAIPanel()
  }

  mode = nextMode
  if (mode === "edit") {
    appRoot.classList.add("gowiki-editing")
    renderEdit(editMode)
    startAutoSave()
  } else {
    appRoot.classList.remove("gowiki-editing")
    renderView()
  }
  renderActions()
}

/**
 * Measure the exact pixel offset of a cursor position within a textarea,
 * accounting for wrapped lines. Uses a hidden mirror div with identical styling.
 */
function getTextareaCursorOffset(textarea, pos) {
  const mirror = document.createElement("div")
  const style = getComputedStyle(textarea)
  mirror.style.position = "absolute"
  mirror.style.left = "-9999px"
  mirror.style.top = "0"
  mirror.style.visibility = "hidden"
  mirror.style.whiteSpace = "pre-wrap"
  mirror.style.wordWrap = "break-word"
  mirror.style.overflowWrap = "break-word"
  mirror.style.width = style.width
  mirror.style.font = style.font
  mirror.style.fontSize = style.fontSize
  mirror.style.lineHeight = style.lineHeight
  mirror.style.letterSpacing = style.letterSpacing
  mirror.style.padding = style.padding
  mirror.style.border = style.border
  mirror.style.boxSizing = style.boxSizing
  // Text before cursor
  const textNode = document.createTextNode(textarea.value.substring(0, pos))
  mirror.appendChild(textNode)
  // Marker at cursor position
  const marker = document.createElement("span")
  marker.textContent = "\u200b" // zero-width space
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const y = marker.offsetTop
  const x = marker.offsetLeft
  document.body.removeChild(mirror)
  return { x, y }
}

/** Save cursor anchor to localStorage for draft resume. */
function saveCursorToLocalStorage() {
  if (mode !== "edit" || !pagePath) return
  try {
    let anchor = null
    if (editMode === "visual" && editorView) {
      anchor = pointFromPm(editorView.state.doc, editorView.state.selection.from, { withTextQuote: true })
    } else if (editMode === "raw" && rawEditor) {
      anchor = pointFromRaw(rawEditor.value, rawEditor.selectionStart, { withTextQuote: true })
    }
    if (anchor) {
      localStorage.setItem("gowiki:cursor:" + pagePath, JSON.stringify(anchor))
    }
  } catch {}
}

/** Restore cursor from localStorage after entering edit mode. */
function restoreCursorFromLocalStorage() {
  if (!pagePath) return
  try {
    const stored = localStorage.getItem("gowiki:cursor:" + pagePath)
    if (!stored) return
    const anchor = JSON.parse(stored)
    if (!anchor || typeof anchor.nodeIndex !== "number") {
      // Legacy CursorContext shape — drop it.
      localStorage.removeItem("gowiki:cursor:" + pagePath)
      return
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scroller = document.querySelector("#app")
        if (editMode === "visual" && editorView) {
          const { pos } = resolvePointInPm(editorView.state.doc, anchor)
          const clampedPos = Math.max(0, Math.min(pos, editorView.state.doc.content.size))
          try {
            const $pos = editorView.state.doc.resolve(clampedPos)
            const sel = TextSelection.near($pos)
            editorView.dispatch(editorView.state.tr.setSelection(sel).scrollIntoView())
            const scrollToCursor = (showBeacon) => {
              try {
                const coords = editorView.coordsAtPos(clampedPos)
                if (scroller) scroller.scrollTop += coords.top - window.innerHeight / 2
                if (showBeacon) {
                  const fc = editorView.coordsAtPos(clampedPos)
                  showCursorBeacon(fc.left, fc.top)
                }
              } catch {}
            }
            requestAnimationFrame(() => {
              scrollToCursor(false)
              setTimeout(() => scrollToCursor(true), 150)
              const obs = new MutationObserver(() => scrollToCursor(false))
              obs.observe(editorView.dom, { childList: true, subtree: true, attributes: true })
              setTimeout(() => obs.disconnect(), 5000)
            })
          } catch {}
          editorView.focus()
        } else if (editMode === "raw" && rawEditor) {
          const { pos } = resolvePointInRaw(rawEditor.value, anchor)
          if (pos >= 0) {
            rawEditor.setSelectionRange(pos, pos)
            rawEditor.focus()
            requestAnimationFrame(() => {
              const cursorOffset = getTextareaCursorOffset(rawEditor, pos)
              const textareaRect = rawEditor.getBoundingClientRect()
              const currentScreenY = textareaRect.top + cursorOffset.y
              if (scroller) scroller.scrollTop += currentScreenY - window.innerHeight / 2
              const finalRect = rawEditor.getBoundingClientRect()
              const finalOffset = getTextareaCursorOffset(rawEditor, pos)
              showCursorBeacon(finalRect.left + finalOffset.x, finalRect.top + finalOffset.y)
            })
          } else {
            rawEditor.focus()
          }
        }
      })
    })
  } catch {}
}

/** Clear stored cursor context (on publish/discard). */
function clearCursorLocalStorage() {
  if (pagePath) {
    try {
      localStorage.removeItem("gowiki:cursor:" + pagePath)
    } catch {}
  }
}

/** Show a pulsing "you are here" beacon at the given screen coordinates. */
function showCursorBeacon(screenX, screenY) {
  const el = document.createElement("div")
  el.className = "gowiki-cursor-beacon"
  el.style.left = screenX + "px"
  el.style.top = screenY + "px"
  document.body.appendChild(el)
  // Remove after animation completes.
  el.addEventListener("animationend", () => el.remove())
  setTimeout(() => el.remove(), 2000) // fallback
}

/**
 * Strip markdown syntax to get plain text, preserving character positions
 * roughly. Used for context matching across raw/visual mode switch.
 */
function stripMarkdownForContext(text) {
  return (
    text
      // Links: [text](url) → text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Images: ![alt](url) → alt
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Bold: **text** → text
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      // Italic: *text* → text
      .replace(/\*([^*]+)\*/g, "$1")
      // Underline: _text_ → text
      .replace(/_([^_]+)_/g, "$1")
      // Strikethrough: ~~text~~ → text
      .replace(/~~([^~]+)~~/g, "$1")
      // Inline code: `text` → text
      .replace(/`([^`]+)`/g, "$1")
      // Heading markers
      .replace(/^#{1,6}\s+/gm, "")
      // Directives on their own line
      .replace(/^\{[^}]+\}\s*$/gm, "")
  )
}

/**
 * Extract the full text content from a PM doc with position mapping,
 * so we can map between text offsets and PM positions.
 */
function pmDocTextWithPositions(doc) {
  const chunks = [] // { text, pmPos }
  let textLen = 0
  doc.descendants((node, pos) => {
    if (node.isText) {
      chunks.push({ text: node.text, pmPos: pos, textOffset: textLen })
      textLen += node.text.length
    } else if (node.isBlock && textLen > 0) {
      // Add a newline between blocks for context matching
      chunks.push({ text: "\n", pmPos: pos, textOffset: textLen })
      textLen += 1
    }
  })
  const fullText = chunks.map((c) => c.text).join("")
  return { fullText, chunks }
}

/** Find a PM position from a text offset in the doc's text content. */
function textOffsetToPmPos(doc, targetOffset) {
  const { chunks } = pmDocTextWithPositions(doc)
  for (const chunk of chunks) {
    if (targetOffset <= chunk.textOffset + chunk.text.length) {
      const delta = Math.max(0, targetOffset - chunk.textOffset)
      return chunk.pmPos + delta
    }
  }
  return doc.content.size > 0 ? doc.content.size - 1 : 0
}

// Structural content address for raw↔visual cursor mapping lives in ./compiler/anchor.ts

async function setEditMode(nextEditMode) {
  if (mode !== "edit") return
  if (nextEditMode === editMode) return

  // Compute structural content address from the current mode (no injection).
  let contentAddress = null
  let markdown = currentMarkdown

  if (editMode === "visual" && editorView) {
    contentAddress = computePmContentAddress(editorView.state.doc, editorView.state.selection.from)
    markdown = pmToMarkdown(editorView.state.doc, registry)
  } else if (editMode === "raw" && rawEditor) {
    contentAddress = computeContentAddress(rawEditor.value, rawEditor.selectionStart)
    markdown = rawEditor.value
  }

  // Validate database-row blocks when leaving raw mode
  if (editMode === "raw") {
    const dbValidation = await validateDatabaseRows(markdown)
    if (!dbValidation.valid) {
      setStatus(dbValidation.errors.join("; "))
      return
    }
  }

  try {
    const normalized = normalizeMarkdownForStorage(markdown)
    currentMarkdown = normalized.markdown
    currentDoc = normalized.doc
  } catch (err) {
    console.error("Switch mode failed", err)
    setStatus("Invalid Markdown — " + (err.message || err), true, err.stack || String(err))
    return
  }

  editMode = nextEditMode
  renderEdit(editMode)
  renderActions()

  setTimeout(() => {
    renderRemoteBlockIndicators()
    updateEditOffset()
  }, 100)

  // Resolve the content address in the target mode.
  if (contentAddress) {
    requestAnimationFrame(() => {
      const scroller = document.querySelector("#app")
      if (nextEditMode === "raw" && rawEditor) {
        const pos = resolveRawContentAddress(rawEditor.value, contentAddress.nodeIndex, contentAddress.plainOffset)
        rawEditor.setSelectionRange(pos, pos)
        rawEditor.focus()
        requestAnimationFrame(() => {
          autoResizeRawEditor(rawEditor)
          const cursorOffset = getTextareaCursorOffset(rawEditor, pos)
          const textareaRect = rawEditor.getBoundingClientRect()
          const currentScreenY = textareaRect.top + cursorOffset.y
          if (scroller) scroller.scrollTop += currentScreenY - window.innerHeight / 2
          const finalRect = rawEditor.getBoundingClientRect()
          const finalOffset = getTextareaCursorOffset(rawEditor, pos)
          showCursorBeacon(finalRect.left + finalOffset.x, finalRect.top + finalOffset.y)
        })
      } else if (nextEditMode === "visual" && editorView) {
        const targetPos = resolveContentAddress(
          editorView.state.doc,
          contentAddress.nodeIndex,
          contentAddress.plainOffset
        )
        const clampedPos = Math.min(targetPos, editorView.state.doc.content.size)
        try {
          const $pos = editorView.state.doc.resolve(clampedPos)
          const sel = TextSelection.near($pos)
          editorView.dispatch(editorView.state.tr.setSelection(sel).scrollIntoView())
        } catch {
          /* position out of range, cursor stays at default */
        }
        const scrollToCenter = (showBeacon) => {
          try {
            const coords = editorView.coordsAtPos(clampedPos)
            const offset = coords.top - window.innerHeight / 2
            if (scroller) scroller.scrollTop += offset
            if (showBeacon) {
              const finalCoords = editorView.coordsAtPos(clampedPos)
              showCursorBeacon(finalCoords.left, finalCoords.top)
            }
          } catch {}
        }
        requestAnimationFrame(() => {
          scrollToCenter(false)
          setTimeout(() => scrollToCenter(true), 150)
          // Watch for layout shifts from async content (queries, includes, images, mermaid).
          // Re-scroll when the editor DOM changes, then tear down after 5s.
          const obs = new MutationObserver(() => scrollToCenter(false))
          obs.observe(editorView.dom, { childList: true, subtree: true, attributes: true })
          setTimeout(() => obs.disconnect(), 5000)
        })
        editorView.focus()
      }
    })
  } else {
    if (nextEditMode === "raw" && rawEditor) rawEditor.focus()
    else if (nextEditMode === "visual" && editorView) editorView.focus()
  }
}

function clearContent() {
  if (editorView) {
    editorView.destroy()
    editorView = null
  }
  if (viewView) {
    viewView.destroy()
    viewView = null
  }
  rawEditor = null
  destroyComments()
  if (CSS.highlights) CSS.highlights.delete("search-highlight")
  contentRoot.innerHTML = ""
}

function isInCodeBlock(state) {
  const $from = state.selection.$from
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === "code_block") return true
  }
  return false
}

function isInTableCell(state) {
  const $from = state.selection.$from
  for (let d = $from.depth; d >= 0; d--) {
    const name = $from.node(d).type.name
    if (name === "table_cell" || name === "table_header") return true
  }
  return false
}

function findAncestorOfType($pos, typeName) {
  for (let d = $pos.depth; d >= 0; d--) {
    const node = $pos.node(d)
    if (node.type.name === typeName) {
      return { depth: d, node, start: $pos.start(d) }
    }
  }
  return null
}

function getCodeBlockSelectionInfo(state) {
  const sel = state.selection
  const fromBlock = findAncestorOfType(sel.$from, "code_block")
  const toBlock = findAncestorOfType(sel.$to, "code_block")
  if (!fromBlock || !toBlock) return null
  if (fromBlock.start !== toBlock.start) return null

  const text = fromBlock.node.textContent ?? ""
  return {
    text,
    blockStart: fromBlock.start,
    from: sel.from - fromBlock.start,
    to: sel.to - fromBlock.start,
    empty: sel.empty,
  }
}

function collectTargetLineStarts(text, from, to, empty) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }

  const lineStartAt = (pos) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (starts[mid] <= pos) lo = mid + 1
      else hi = mid - 1
    }
    return starts[Math.max(0, hi)]
  }

  if (empty) {
    return [lineStartAt(from)]
  }

  const effectiveTo = to > from && text.charCodeAt(to - 1) === 10 ? to - 1 : to
  const first = lineStartAt(from)
  const last = lineStartAt(effectiveTo)
  return starts.filter((pos) => pos >= first && pos <= last)
}

function remapPos(pos, changes) {
  let mapped = pos
  for (const change of changes) {
    const { at, delta } = change
    if (delta >= 0) {
      if (mapped >= at) mapped += delta
      continue
    }

    const removed = -delta
    if (mapped <= at) continue
    if (mapped <= at + removed) mapped = at
    else mapped += delta
  }
  return mapped
}

function applyCodeBlockIndent(direction) {
  return (state, dispatch) => {
    const info = getCodeBlockSelectionInfo(state)
    if (!info) return false

    const lineStarts = collectTargetLineStarts(info.text, info.from, info.to, info.empty)
    if (lineStarts.length === 0) return true

    const changes = []
    for (const at of lineStarts) {
      if (direction === "in") {
        changes.push({ at, remove: 0, insert: "  ", delta: 2 })
        continue
      }
      let remove = 0
      if (info.text.charCodeAt(at) === 32) remove++
      if (info.text.charCodeAt(at + 1) === 32) remove++
      if (remove > 0) changes.push({ at, remove, insert: "", delta: -remove })
    }

    if (changes.length === 0) return true

    let nextText = info.text
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i]
      nextText = nextText.slice(0, c.at) + c.insert + nextText.slice(c.at + c.remove)
    }

    if (!dispatch) return true

    const mappedFrom = remapPos(info.from, changes)
    const mappedTo = remapPos(info.to, changes)

    let tr = state.tr.insertText(nextText, info.blockStart, info.blockStart + info.text.length)

    tr = tr.setSelection(TextSelection.create(tr.doc, info.blockStart + mappedFrom, info.blockStart + mappedTo))

    dispatch(tr.scrollIntoView())
    return true
  }
}

function tabKeyCommand(direction) {
  const codeIndent = applyCodeBlockIndent(direction)

  return (state, dispatch) => {
    // Let table plugin own Tab behavior inside table cells.
    if (isInTableCell(state)) return false

    // In code blocks, Tab/Shift-Tab always indent/dedent line starts.
    if (isInCodeBlock(state)) {
      return codeIndent(state, dispatch)
    }

    // In headings, Tab/Shift-Tab adjusts heading level.
    const { $from } = state.selection
    if ($from.parent.type === state.schema.nodes.heading) {
      const node = $from.parent
      const level = node.attrs.level
      const newLevel = direction === "in" ? Math.min(level + 1, 6) : Math.max(level - 1, 1)
      if (newLevel !== level) {
        return setBlockType(state.schema.nodes.heading, {
          level: newLevel,
          numbered: node.attrs.numbered,
        })(state, dispatch)
      }
      return true
    }

    const itemType = state.schema.nodes.list_item
    if (itemType) {
      const listCmd = direction === "in" ? sinkListItem(itemType) : liftListItem(itemType)
      if (listCmd(state, dispatch)) return true
    }

    // Outside list/table/code block, do nothing but keep focus in editor.
    return true
  }
}

function backspaceEmptyListItemCommand() {
  return (state, dispatch) => {
    const sel = state.selection
    if (!sel.empty) return false

    const listItemType = state.schema.nodes.list_item
    if (!listItemType) return false

    const $from = sel.$from
    if ($from.parentOffset !== 0) return false

    let depth = $from.depth
    while (depth > 0 && $from.node(depth).type !== listItemType) depth--
    if (depth <= 0) return false

    const item = $from.node(depth)
    if (item.textContent.trim().length !== 0) return false

    const listDepth = depth - 1
    const indexInList = $from.index(listDepth)
    if (indexInList <= 0) return false

    const itemPos = $from.before(depth)
    const prevItem = $from.node(listDepth).child(indexInList - 1)
    const prevItemPos = itemPos - prevItem.nodeSize

    if (!dispatch) return true

    let tr = state.tr.delete(itemPos, itemPos + item.nodeSize)
    const cursorPos = Math.max(prevItemPos + 1, prevItemPos + prevItem.nodeSize - 2)
    tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos))
    dispatch(tr.scrollIntoView())
    return true
  }
}

function insertHardBreakCommand() {
  return (state, dispatch) => {
    const hardBreak = state.schema.nodes.hard_break
    if (!hardBreak) return false
    if (!dispatch) return true
    dispatch(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView())
    return true
  }
}

function scrollSelectionIntoContentView(view) {
  const scroller = document.querySelector("#app") || contentRoot
  if (!(scroller instanceof HTMLElement)) return false

  const menu = view.dom.closest(".gowiki-raw-wrapper")?.querySelector(".gowiki-raw-menubar")
  const topInset = (menu instanceof HTMLElement ? menu.offsetHeight : 0) + 12
  const bottomInset = 10

  let fromCoords
  let toCoords
  try {
    fromCoords = view.coordsAtPos(view.state.selection.from)
    toCoords = view.coordsAtPos(view.state.selection.to)
  } catch {
    return false
  }

  const scrollerRect = scroller.getBoundingClientRect()
  const topLimit = scrollerRect.top + topInset
  const bottomLimit = scrollerRect.bottom - bottomInset
  const selectionTop = Math.min(fromCoords.top, toCoords.top)
  const selectionBottom = Math.max(fromCoords.bottom, toCoords.bottom)

  let delta = 0
  if (selectionTop < topLimit) {
    delta = selectionTop - topLimit
  } else if (selectionBottom > bottomLimit) {
    delta = selectionBottom - bottomLimit
  }

  if (delta !== 0) {
    scroller.scrollTop += delta
  }
  return true
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
const CHECK_ICON = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>'

function addCodeCopyButtons(container) {
  container.querySelectorAll("pre").forEach((pre) => {
    const btn = document.createElement("button")
    btn.className = "gowiki-code-copy-btn"
    btn.title = "Copy code"
    btn.innerHTML = COPY_ICON
    btn.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      const code = pre.querySelector("code")
      if (!code) return
      navigator.clipboard.writeText(code.textContent || "").then(() => {
        btn.innerHTML = CHECK_ICON
        btn.classList.add("gowiki-code-copy-btn--copied")
        setTimeout(() => {
          btn.innerHTML = COPY_ICON
          btn.classList.remove("gowiki-code-copy-btn--copied")
        }, 1500)
      })
    })
    pre.appendChild(btn)
  })
}

function mountReadOnlyView(container, markdown, className, extraPlugins = []) {
  let doc
  try {
    doc = markdownToPM(markdown, registry)
  } catch (err) {
    console.error("Rendering failed:", err)
    const errorDiv = document.createElement("div")
    errorDiv.style.cssText =
      "background:#fce4ec;border:1px solid #ef9a9a;border-radius:6px;padding:16px;margin:12px 0;color:#b71c1c;font-family:monospace;font-size:13px;white-space:pre-wrap"
    errorDiv.textContent =
      "⚠ Rendering error: " +
      (err.message || err) +
      "\n\nThe raw markdown is shown below. Use raw edit mode (Shift+click Edit) to fix this page."
    container.appendChild(errorDiv)
    const pre = document.createElement("pre")
    pre.style.cssText =
      "background:#f5f5f5;border:1px solid #ddd;border-radius:4px;padding:12px;margin:8px 0;font-size:12px;overflow-x:auto;white-space:pre-wrap"
    pre.textContent = markdown
    container.appendChild(pre)
    return null
  }
  const wrapper = document.createElement("div")
  if (className) wrapper.className = className
  container.appendChild(wrapper)
  const state = EditorState.create({
    doc,
    schema,
    plugins: [...registry.getEditorPlugins(), ...extraPlugins],
  })
  const view = new EditorView(wrapper, {
    state,
    editable: () => false,
    // Override dispatchTransaction so that after every state update (which
    // internally calls domObserver.start()), we immediately re-stop the
    // observer.  Without this, async plugin transactions (e.g. link status
    // check) restart the observer and ProseMirror's selectionchange handler
    // fights the native browser selection — causing code-block selection to
    // blink and fail.
    dispatchTransaction(tr) {
      const newState = view.state.apply(tr)
      view.updateState(newState)
      view.dom.removeAttribute("contenteditable")
      if (view.domObserver && view.domObserver.stop) view.domObserver.stop()
    },
  })
  highlightCodeBlocks(wrapper)
  addCodeCopyButtons(wrapper)
  // Fold spoilers by default in view mode
  wrapper.querySelectorAll("details.gowiki-spoiler[open]").forEach((d) => d.removeAttribute("open"))
  view.dom.removeAttribute("contenteditable")
  if (view.domObserver && view.domObserver.stop) view.domObserver.stop()
  // ProseMirror registers copy/cut/paste handlers on view.dom that call
  // preventDefault(), which suppresses the browser's native copy even when
  // the editor is non-editable.  Add a capture-phase handler that stops
  // the event from reaching ProseMirror's handler.
  for (const evt of ["copy", "cut", "paste"]) {
    view.dom.addEventListener(evt, (e) => e.stopImmediatePropagation(), true)
  }
  return view
}

async function fetchAndMountZone(path, container, className) {
  try {
    const page = await fetchPage(path)
    if (!page) return null
    return mountReadOnlyView(container, page.markdown, className)
  } catch {
    return null
  }
}

let tocIncludeListener = null
let tocIncludeDebounce = null

function setupTOCIncludeRebuild(container) {
  if (tocIncludeListener) {
    document.removeEventListener("gowiki:include-loaded", tocIncludeListener)
  }
  tocIncludeListener = () => {
    if (tocIncludeDebounce) clearTimeout(tocIncludeDebounce)
    tocIncludeDebounce = setTimeout(() => {
      if (document.body.contains(container)) buildTOC(container)
    }, 80)
  }
  document.addEventListener("gowiki:include-loaded", tocIncludeListener)
}

function buildTOC(container) {
  if (tocMaxLevel <= 0) return

  // Remove prior TOC if rebuilding (e.g. after async includes load).
  const prior = container.querySelector(":scope > .gowiki-toc")
  if (prior) prior.remove()

  const selector = Array.from({ length: tocMaxLevel }, (_, i) => `h${i + 1}`).join(", ")
  const headings = container.querySelectorAll(selector)
  if (headings.length <= 1) return

  const toc = document.createElement("div")
  toc.className = "gowiki-toc"
  const title = document.createElement("div")
  title.className = "gowiki-toc-title"
  title.textContent = "Contents"
  toc.appendChild(title)

  const minLevel = Math.min(...Array.from(headings, (h) => parseInt(h.tagName.slice(1), 10)))

  const list = document.createElement("ul")
  for (const h of headings) {
    const level = parseInt(h.tagName.slice(1), 10)
    const id = h.id
    if (!id) continue
    const li = document.createElement("li")
    li.className = `gowiki-toc-level-${level - minLevel}`
    const a = document.createElement("a")
    a.href = `#${id}`
    const num = h.getAttribute("data-heading-number")
    a.textContent = (num ? num + " " : "") + h.textContent
    a.addEventListener("click", (e) => {
      e.preventDefault()
      const target = document.getElementById(id)
      if (target) {
        target.scrollIntoView({ behavior: "smooth" })
        window.history.replaceState(null, "", `#${id}`)
      }
    })
    li.appendChild(a)
    list.appendChild(li)
  }
  toc.appendChild(list)
  container.insertBefore(toc, container.firstChild)
}

function renderView() {
  clearContent()

  if (isNewPage) {
    const banner = document.createElement("div")
    banner.className = "gowiki-new-page-banner"
    banner.textContent = "This page does not exist. Switch to Edit mode to create it."
    contentRoot.appendChild(banner)

    // If the attic has versions for this path, the page was deleted (not
    // never-created). Surface a link so the previous content is discoverable
    // without having to know the history button still works on missing pages.
    //
    // Two sources count:
    //   /api/history → non-empty only for a page whose live attic survived
    //                  (pre-tombstone-fix state, or a page that was deleted
    //                  via a legacy code path).
    //   /api/tombstones → populated whenever Delete() ran under the current
    //                     code, which moves the full history into
    //                     @tombstones/@deleted-<ts>/.
    // Either one proves "a page lived here before" and justifies the link.
    void (async () => {
      try {
        const [histResp, tombResp] = await Promise.all([
          fetch(`/api/history/${encodePagePath(pagePath)}`),
          fetch(`/api/tombstones/${encodePagePath(pagePath)}`),
        ])
        let versionCount = 0
        let tombstoneCount = 0
        if (histResp.ok) {
          const data = await histResp.json()
          if (Array.isArray(data?.versions)) versionCount = data.versions.length
        }
        if (tombResp.ok) {
          const data = await tombResp.json()
          if (Array.isArray(data?.tombstones)) tombstoneCount = data.tombstones.length
        }
        if (versionCount === 0 && tombstoneCount === 0) return
        if (!banner.isConnected) return
        const note = document.createElement("div")
        note.style.marginTop = "6px"
        note.append("This page has been deleted, you can consult older versions if needed by clicking on ")
        const link = document.createElement("a")
        link.href = "#"
        link.textContent = "history"
        link.addEventListener("click", (e) => {
          e.preventDefault()
          void showHistory()
        })
        note.append(link, ".")
        banner.appendChild(note)
      } catch {
        // Keep the default banner on error.
      }
    })()
    return
  }

  viewView = mountReadOnlyView(contentRoot, currentMarkdown, "gowiki-view", [commentPmPlugin])

  // Highlight searched terms if navigating from search.
  const highlight = new URLSearchParams(window.location.search).get("highlight")
  if (highlight) {
    highlightTermsInView(contentRoot, highlight)
  }

  // Build table of contents for view mode. Rebuild after includes load so
  // their headings are picked up too.
  buildTOC(contentRoot)
  setupTOCIncludeRebuild(contentRoot)

  // Check for pending read acknowledgements.
  if (currentUser && !isNewPage) {
    checkReadAck(pagePath, currentPageVersion, contentRoot)
  }

  // Scroll to fragment anchor if present.
  if (window.location.hash) {
    const id = window.location.hash.slice(1)
    if (id) {
      const el = document.getElementById(id)
      if (el) el.scrollIntoView({ behavior: "smooth" })
    }
  }

  updatePageTitle()

  // Initialize comments overlay.
  if (!isNewPage && viewView) {
    initComments({
      pagePath: `/${pagePath}`,
      view: viewView,
      authFetch,
      username: currentUser?.username || null,
      isAdmin: currentUser?.groups?.includes("admin") || false,
    })
  }

  // Comments are decorations on the PM doc — no DOM reapply needed. Search
  // highlights still need re-application when async nodes finish rendering.
  if (highlight) {
    document.addEventListener("gowiki:node-rendered", () => highlightTermsInView(contentRoot, highlight))
  }
}

async function checkReadAck(path, currentVersion, container) {
  try {
    const resp = await fetch(`/api/plugin/todo/v1/tasks/ack/${encodePagePath(path)}`)
    if (!resp.ok) return
    const data = await resp.json()
    const tasks = data.tasks || []
    if (tasks.length === 0) return

    for (const task of tasks) {
      // Skip tasks the user already acknowledged at the current (or later) version.
      if (task.previous_ack_version >= currentVersion) continue

      const banner = document.createElement("div")
      banner.className = "gowiki-ack-banner"

      const title = document.createElement("div")
      title.className = "gowiki-ack-title"
      title.textContent = task.title || "Read acknowledgement required"
      banner.appendChild(title)

      if (task.previous_ack_version > 0 && task.previous_ack_version < currentVersion) {
        const info = document.createElement("div")
        info.className = "gowiki-ack-info"
        info.textContent = `You previously acknowledged version ${task.previous_ack_version}. `
        const diffLink = document.createElement("a")
        diffLink.href = "#"
        diffLink.textContent = "View changes since your last acknowledgement"
        diffLink.addEventListener("click", (e) => {
          e.preventDefault()
          showDiff(task.previous_ack_version, 0)
        })
        info.appendChild(diffLink)
        banner.appendChild(info)
      }

      const row = document.createElement("div")
      row.className = "gowiki-ack-row"

      const label = document.createElement("label")
      label.className = "gowiki-ack-label"
      const checkbox = document.createElement("input")
      checkbox.type = "checkbox"
      label.appendChild(checkbox)
      const labelText = document.createTextNode(" I confirm that I have read and understood the contents of this page")
      label.appendChild(labelText)

      const btn = document.createElement("button")
      btn.className = "gowiki-ack-btn"
      btn.textContent = "Acknowledge"
      btn.disabled = true

      checkbox.addEventListener("change", () => {
        btn.disabled = !checkbox.checked
      })
      btn.addEventListener("click", async () => {
        btn.disabled = true
        btn.textContent = "Acknowledging…"
        try {
          const ackResp = await authFetch(`/api/plugin/todo/v1/tasks/${task.task_id}/acknowledge`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ version: currentVersion }),
          })
          if (ackResp.ok) {
            banner.className = "gowiki-ack-banner gowiki-ack-done"
            banner.textContent = "Acknowledged"
            setTimeout(() => banner.remove(), 2000)
          } else {
            btn.textContent = "Acknowledge"
            btn.disabled = false
            setStatus("Failed to acknowledge")
          }
        } catch {
          btn.textContent = "Acknowledge"
          btn.disabled = false
          setStatus("Failed to acknowledge")
        }
      })

      row.appendChild(label)
      row.appendChild(btn)
      banner.appendChild(row)
      container.appendChild(banner)
    }
  } catch {
    // Silently ignore ack check failures.
  }
}

function highlightTermsInView(container, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return

  // Use CSS Custom Highlight API — it styles ranges without modifying the DOM,
  // so ProseMirror's async DOM reconciliation cannot discard our highlights.
  if (!CSS.highlights) return

  const ranges = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)

  while (walker.nextNode()) {
    const textNode = walker.currentNode
    const parent = textNode.parentElement
    if (!parent) continue
    if (parent.closest("pre, code, script, style")) continue

    const text = textNode.textContent.toLowerCase()

    const hits = []
    for (const term of terms) {
      let idx = 0
      while ((idx = text.indexOf(term, idx)) !== -1) {
        hits.push({ start: idx, length: term.length })
        idx += term.length
      }
    }
    if (hits.length === 0) continue

    hits.sort((a, b) => a.start - b.start)
    const merged = [hits[0]]
    for (let i = 1; i < hits.length; i++) {
      const prev = merged[merged.length - 1]
      if (hits[i].start < prev.start + prev.length) continue
      merged.push(hits[i])
    }

    for (const { start, length } of merged) {
      const range = new Range()
      range.setStart(textNode, start)
      range.setEnd(textNode, start + length)
      ranges.push(range)
    }
  }

  if (ranges.length > 0) {
    const hl = new Highlight(...ranges)
    CSS.highlights.set("search-highlight", hl)
  }
}

function autoResizeRawEditor(editorEl) {
  const scroller = document.querySelector("#app")
  const scrollTop = scroller ? scroller.scrollTop : 0
  editorEl.style.height = "0"
  editorEl.style.height = `${Math.max(editorEl.scrollHeight, 360)}px`
  if (scroller) scroller.scrollTop = scrollTop
}

// --- Raw mode menubar helpers ---

// Characters that render (nearly) invisibly but aren't a plain space/tab/newline.
// Editing source is misleading when they're present, so we paint a highlight
// layer behind the textarea to surface them.
const RAW_INVISIBLE_RE = /[\u00A0\u1680\u2000-\u200F\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]/g

function updateRawOverlay(overlay, text) {
  // Escape HTML, then wrap invisible runs. Trailing newline keeps the last
  // line's height in sync with the textarea.
  let out = ""
  let last = 0
  const src = text + "\n"
  RAW_INVISIBLE_RE.lastIndex = 0
  let m
  while ((m = RAW_INVISIBLE_RE.exec(src)) !== null) {
    out += escapeOverlay(src.slice(last, m.index))
    const ch = m[0]
    const code = ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()
    const cls =
      ch.charCodeAt(0) === 0x00a0 || ch.charCodeAt(0) === 0x202f
        ? "gowiki-raw-invisible gowiki-raw-invisible-nbsp"
        : "gowiki-raw-invisible"
    out += `<span class="${cls}" title="U+${code}">${escapeOverlay(ch)}</span>`
    last = m.index + ch.length
  }
  out += escapeOverlay(src.slice(last))
  overlay.innerHTML = out
}

function escapeOverlay(s) {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"))
}

function rawInsertText(textarea, text) {
  textarea.focus()
  document.execCommand("insertText", false, text)
}

function rawWrapSelection(textarea, before, after) {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selected = textarea.value.substring(start, end)

  if (start === end) {
    // No selection: insert syntax with cursor between markers
    textarea.focus()
    textarea.setSelectionRange(start, start)
    rawInsertText(textarea, before + after)
    textarea.setSelectionRange(start + before.length, start + before.length)
  } else {
    // Wrap selection
    textarea.focus()
    textarea.setSelectionRange(start, end)
    rawInsertText(textarea, before + selected + after)
    textarea.setSelectionRange(start + before.length, start + before.length + selected.length)
  }
}

function rawGetCurrentLineRange(textarea) {
  const val = textarea.value
  const pos = textarea.selectionStart
  let lineStart = pos
  while (lineStart > 0 && val[lineStart - 1] !== "\n") lineStart--
  let lineEnd = pos
  while (lineEnd < val.length && val[lineEnd] !== "\n") lineEnd++
  return { lineStart, lineEnd }
}

function rawGetSelectedLineRanges(textarea) {
  const val = textarea.value
  const selStart = textarea.selectionStart
  const selEnd = textarea.selectionEnd

  let lineStart = selStart
  while (lineStart > 0 && val[lineStart - 1] !== "\n") lineStart--

  let lineEnd = selEnd
  if (selEnd > selStart && val[selEnd - 1] === "\n") {
    lineEnd = selEnd - 1
  }
  while (lineEnd < val.length && val[lineEnd] !== "\n") lineEnd++

  // Split into individual line ranges
  const ranges = []
  let cur = lineStart
  while (cur <= lineEnd) {
    let end = val.indexOf("\n", cur)
    if (end === -1 || end > lineEnd) end = lineEnd
    ranges.push({ lineStart: cur, lineEnd: end })
    cur = end + 1
  }
  return ranges
}

function rawToggleLinePrefix(textarea, prefix) {
  const ranges = rawGetSelectedLineRanges(textarea)
  const val = textarea.value

  // Check if all lines already have the prefix
  const allHavePrefix = ranges.every((r) => val.substring(r.lineStart, r.lineStart + prefix.length) === prefix)

  textarea.focus()

  if (allHavePrefix) {
    // Remove prefix from all lines, working backwards to preserve positions
    for (let i = ranges.length - 1; i >= 0; i--) {
      const r = ranges[i]
      textarea.setSelectionRange(r.lineStart, r.lineStart + prefix.length)
      rawInsertText(textarea, "")
    }
  } else {
    // Add prefix to lines that don't have it, working backwards
    for (let i = ranges.length - 1; i >= 0; i--) {
      const r = ranges[i]
      if (val.substring(r.lineStart, r.lineStart + prefix.length) !== prefix) {
        textarea.setSelectionRange(r.lineStart, r.lineStart)
        rawInsertText(textarea, prefix)
      }
    }
  }
}

function rawSetHeadingLevel(textarea, level, numbered) {
  const { lineStart, lineEnd } = rawGetCurrentLineRange(textarea)
  const val = textarea.value
  const line = val.substring(lineStart, lineEnd)

  // Strip any existing heading prefix (including optional `1. ` numbered marker)
  const stripped = line.replace(/^#{1,6}\s*(?:1\.\s)?/, "")
  const numPrefix = numbered ? "1. " : ""
  const newPrefix = "#".repeat(level) + " " + numPrefix

  // If line already has this exact heading level (ignoring numbered), toggle it off
  const existingMatch = line.match(/^(#{1,6})\s/)
  const alreadyThisLevel = existingMatch && existingMatch[1].length === level && !numbered

  textarea.focus()
  textarea.setSelectionRange(lineStart, lineEnd)
  if (alreadyThisLevel) {
    rawInsertText(textarea, stripped)
    textarea.setSelectionRange(lineStart, lineStart + stripped.length)
  } else {
    const newLine = newPrefix + stripped
    rawInsertText(textarea, newLine)
    textarea.setSelectionRange(lineStart, lineStart + newLine.length)
  }
}

function rawInsertHorizontalRule(textarea) {
  const { lineStart, lineEnd } = rawGetCurrentLineRange(textarea)
  const val = textarea.value
  const line = val.substring(lineStart, lineEnd)

  textarea.focus()
  if (line.trim() === "") {
    // Replace empty line with hr
    textarea.setSelectionRange(lineStart, lineEnd)
    rawInsertText(textarea, "---")
  } else {
    // Insert hr on a new line after current line
    textarea.setSelectionRange(lineEnd, lineEnd)
    rawInsertText(textarea, "\n---")
  }
}

async function rawInsertLink(textarea) {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selectedText = textarea.value.substring(start, end)

  const form = await promptLinkForm("https://", selectedText)
  if (!form) return

  const displayText = form.text.trim().length === 0 ? defaultLinkTextForTarget(form.target) : form.text
  const md = `[${displayText}](${form.target})`

  textarea.focus()
  textarea.setSelectionRange(start, end)
  rawInsertText(textarea, md)
}

function rawInsertCodeBlock(textarea) {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selected = textarea.value.substring(start, end)

  textarea.focus()
  if (selected.length > 0) {
    textarea.setSelectionRange(start, end)
    rawInsertText(textarea, "```\n" + selected + "\n```")
  } else {
    textarea.setSelectionRange(start, start)
    rawInsertText(textarea, "```\n\n```")
    // Place cursor inside the code block
    textarea.setSelectionRange(start + 4, start + 4)
  }
}

function rawInsertSpoiler(textarea) {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selected = textarea.value.substring(start, end)

  textarea.focus()
  if (selected.length > 0) {
    textarea.setSelectionRange(start, end)
    rawInsertText(textarea, "```spoiler Details\n" + selected + "\n```")
  } else {
    textarea.setSelectionRange(start, start)
    rawInsertText(textarea, "```spoiler Details\n\n```")
    // Place cursor inside the spoiler
    textarea.setSelectionRange(start + 19, start + 19)
  }
}

function rawInsertChart(textarea) {
  const start = textarea.selectionStart
  const snippet = "```chart pie\nItem 1 = 30\nItem 2 = 50\nItem 3 = 20\n```"
  textarea.focus()
  textarea.setSelectionRange(start, start)
  rawInsertText(textarea, snippet)
  // Place cursor on the first data line
  const cursorPos = start + 13 // after "```chart pie\n"
  textarea.setSelectionRange(cursorPos, cursorPos)
}

function rawInsertSlides(textarea) {
  const start = textarea.selectionStart
  const snippet = "{slides}\n\n# Title Slide\n\n---\n\n# Slide 2\n\n---\n\n# Thank You"
  textarea.focus()
  textarea.setSelectionRange(start, start)
  rawInsertText(textarea, snippet)
  // Place cursor on the title
  const cursorPos = start + 12 // after "{slides}\n\n# "
  textarea.setSelectionRange(cursorPos, cursorPos)
}

// --- Raw ordered list renumbering ---

function rawRenumberOrderedLists(textarea) {
  const val = textarea.value
  const lines = val.split("\n")
  const origStart = textarea.selectionStart
  const origEnd = textarea.selectionEnd
  const olRe = /^(\s*)(\d+)(\. .*)$/

  const stack = [] // {indent, counter}
  let changed = false
  let startDelta = 0
  let endDelta = 0
  let pos = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(olRe)

    if (m) {
      const indent = m[1].length
      const oldNum = m[2]

      // Pop entries deeper than current indent
      while (stack.length > 0 && stack[stack.length - 1].indent > indent) {
        stack.pop()
      }

      if (stack.length > 0 && stack[stack.length - 1].indent === indent) {
        stack[stack.length - 1].counter++
      } else {
        // Pop entries at same or deeper indent (shouldn't remain, but be safe)
        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
          stack.pop()
        }
        stack.push({ indent, counter: 1 })
      }

      const newNum = String(stack[stack.length - 1].counter)
      if (oldNum !== newNum) {
        changed = true
        const delta = newNum.length - oldNum.length
        lines[i] = m[1] + newNum + m[3]
        const numEnd = pos + indent + oldNum.length
        if (numEnd <= origStart) startDelta += delta
        if (numEnd <= origEnd) endDelta += delta
      }
    } else if (/^\s*$/.test(line)) {
      // Blank line: don't break list continuity
    } else if (/^\s*- /.test(line)) {
      // Bullet list: clear ordered counters at this indent and deeper
      const indent = line.match(/^(\s*)/)[1].length
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop()
      }
    } else {
      // Non-list content: clear entire stack
      stack.length = 0
    }

    pos += line.length + 1
  }

  if (!changed) return

  const newText = lines.join("\n")
  textarea.focus()
  textarea.setSelectionRange(0, val.length)
  rawInsertText(textarea, newText)
  const newStart = Math.max(0, origStart + startDelta)
  const newEnd = Math.max(newStart, origEnd + endDelta)
  textarea.setSelectionRange(newStart, newEnd)
}

// --- Raw list keyboard handling ---

const rawListRe = /^(\s*)(- |\d+\. )/

function rawGetListPrefix(textarea) {
  const { lineStart, lineEnd } = rawGetCurrentLineRange(textarea)
  const line = textarea.value.substring(lineStart, lineEnd)
  const m = line.match(rawListRe)
  if (!m) return null
  return { lineStart, lineEnd, line, indent: m[1], marker: m[2], contentStart: m[1].length + m[2].length }
}

// --- Raw blockquote keyboard handling ---

const rawBlockquoteRe = /^((?:>\s*)+)/

function rawHandleEnterInBlockquote(textarea) {
  const { lineStart, lineEnd } = rawGetCurrentLineRange(textarea)
  const line = textarea.value.substring(lineStart, lineEnd)
  const m = line.match(rawBlockquoteRe)
  if (!m) return false

  const prefix = m[1]
  const pos = textarea.selectionStart
  const contentAfterCursor = textarea.value.substring(pos, lineEnd)
  const contentBeforeCursor = textarea.value.substring(lineStart + prefix.length, pos)

  // Empty blockquote line: remove the prefix (exit blockquote)
  if (contentBeforeCursor.trim() === "" && contentAfterCursor.trim() === "") {
    textarea.focus()
    textarea.setSelectionRange(lineStart, lineEnd)
    rawInsertText(textarea, "")
    return true
  }

  // Continue blockquote on next line with same prefix
  const insertion = "\n" + prefix
  textarea.focus()
  textarea.setSelectionRange(pos, pos)
  rawInsertText(textarea, insertion)
  return true
}

function rawHandleEnterInList(textarea) {
  const info = rawGetListPrefix(textarea)
  if (!info) return false

  const pos = textarea.selectionStart
  const contentAfterCursor = textarea.value.substring(pos, info.lineEnd)
  const contentBeforeCursor = textarea.value.substring(info.lineStart + info.contentStart, pos)

  // Empty list item: remove the prefix (exit list)
  if (contentBeforeCursor.trim() === "" && contentAfterCursor.trim() === "") {
    textarea.focus()
    textarea.setSelectionRange(info.lineStart, info.lineEnd)
    rawInsertText(textarea, "")
    return true
  }

  // Build the next list prefix at the same indent level
  let nextMarker = info.marker
  const orderedMatch = info.marker.match(/^(\d+)\. $/)
  if (orderedMatch) {
    nextMarker = Number(orderedMatch[1]) + 1 + ". "
  }
  const insertion = "\n" + info.indent + nextMarker

  textarea.focus()
  textarea.setSelectionRange(pos, pos)
  rawInsertText(textarea, insertion)
  rawRenumberOrderedLists(textarea)
  return true
}

function rawListIndentWidth(line) {
  // Ordered lists (1. ) need 3-space indent per CommonMark; unordered (- ) need 2
  const stripped = line.replace(/^\s*/, "")
  return /^\d+\. /.test(stripped) ? 3 : 2
}

function rawHandleTabInList(textarea, direction) {
  const ranges = rawGetSelectedLineRanges(textarea)
  const val = textarea.value
  const listLines = ranges.filter((r) => rawListRe.test(val.substring(r.lineStart, r.lineEnd)))
  if (listLines.length === 0) return false

  // Expand each selected root line to include its sub-items (deeper-indented lines below it).
  // Build all line ranges for the entire textarea to scan forward.
  const allRanges = []
  {
    let cur = 0
    while (cur < val.length) {
      let end = val.indexOf("\n", cur)
      if (end === -1) end = val.length
      allRanges.push({ lineStart: cur, lineEnd: end })
      cur = end + 1
    }
  }

  // When indenting, filter out roots that are the first item in their list —
  // you can't sublevel the first item since there's no sibling above it.
  let effectiveRoots = listLines
  if (direction === "in") {
    effectiveRoots = listLines.filter((root) => {
      const rootLine = val.substring(root.lineStart, root.lineEnd)
      const rootIndent = rootLine.match(/^(\s*)/)[1].length
      const rootIsOrdered = /^\s*\d+\. /.test(rootLine)

      // Find this root's index in allRanges and scan backward
      let rootIdx = -1
      for (let i = 0; i < allRanges.length; i++) {
        if (allRanges[i].lineStart === root.lineStart) {
          rootIdx = i
          break
        }
      }
      if (rootIdx <= 0) return false // first line of file, definitely first item

      for (let i = rootIdx - 1; i >= 0; i--) {
        const prevLine = val.substring(allRanges[i].lineStart, allRanges[i].lineEnd)
        if (prevLine.trim() === "") continue // blank line, keep scanning
        const prevIndent = prevLine.match(/^(\s*)/)[1].length
        if (prevIndent > rootIndent) continue // continuation or sub-item, keep scanning
        if (prevIndent < rootIndent) return false // shallower level: root is first at its level
        // Same indent: must be a list item of the same type (both ordered or both unordered)
        if (!rawListRe.test(prevLine)) return false // not a list item
        const prevIsOrdered = /^\s*\d+\. /.test(prevLine)
        if (prevIsOrdered !== rootIsOrdered) return false // different list type = first item of new list
        return true // same-type sibling found, can indent
      }
      return false // reached start of file, first item
    })
    if (effectiveRoots.length === 0) return false
  }

  // Collect the full set of lines to indent: roots + their sub-items
  const linesToProcess = new Set()
  for (const root of effectiveRoots) {
    linesToProcess.add(root.lineStart)
    const rootLine = val.substring(root.lineStart, root.lineEnd)
    const rootIndent = rootLine.match(/^(\s*)/)[1].length

    // Find this root's index in allRanges
    let rootIdx = -1
    for (let i = 0; i < allRanges.length; i++) {
      if (allRanges[i].lineStart === root.lineStart) {
        rootIdx = i
        break
      }
    }
    if (rootIdx === -1) continue

    // Scan forward: collect all subsequent lines at deeper indent (sub-items)
    for (let i = rootIdx + 1; i < allRanges.length; i++) {
      const subLine = val.substring(allRanges[i].lineStart, allRanges[i].lineEnd)
      if (subLine.trim() === "") {
        // Blank line: include it (may be inside a list), keep scanning
        linesToProcess.add(allRanges[i].lineStart)
        continue
      }
      const subIndent = subLine.match(/^(\s*)/)[1].length
      if (subIndent > rootIndent) {
        linesToProcess.add(allRanges[i].lineStart)
      } else {
        break
      }
    }
  }

  // Remove trailing blank lines that aren't actually sub-items
  // (they were speculatively included while scanning)

  // Build the final sorted list of line ranges to process
  const processRanges = allRanges.filter((r) => linesToProcess.has(r.lineStart))

  const origStart = textarea.selectionStart
  const origEnd = textarea.selectionEnd
  textarea.focus()

  let startDelta = 0
  let endDelta = 0

  if (direction === "in") {
    // Use the indent width of the first root for all lines in this operation
    const firstRootLine = val.substring(effectiveRoots[0].lineStart, effectiveRoots[0].lineEnd)
    const indentStr = " ".repeat(rawListIndentWidth(firstRootLine))

    for (let i = processRanges.length - 1; i >= 0; i--) {
      const r = processRanges[i]
      const line = val.substring(r.lineStart, r.lineEnd)
      if (line.trim() === "") continue // skip blank lines
      textarea.setSelectionRange(r.lineStart, r.lineStart)
      rawInsertText(textarea, indentStr)
      if (r.lineStart <= origStart) startDelta += indentStr.length
      if (r.lineStart <= origEnd) endDelta += indentStr.length
    }
  } else {
    const firstRootLine = val.substring(listLines[0].lineStart, listLines[0].lineEnd)
    const width = rawListIndentWidth(firstRootLine)

    for (let i = processRanges.length - 1; i >= 0; i--) {
      const r = processRanges[i]
      const line = val.substring(r.lineStart, r.lineEnd)
      if (line.trim() === "") continue // skip blank lines
      let remove = 0
      for (let j = 0; j < width && j < line.length; j++) {
        if (line.charCodeAt(j) === 32) remove++
        else break
      }
      if (remove > 0) {
        textarea.setSelectionRange(r.lineStart, r.lineStart + remove)
        rawInsertText(textarea, "")
        if (r.lineStart < origStart) {
          startDelta -= Math.min(remove, origStart - r.lineStart)
        }
        if (r.lineStart < origEnd) {
          endDelta -= Math.min(remove, origEnd - r.lineStart)
        }
      }
    }
  }

  const newStart = Math.max(0, origStart + startDelta)
  const newEnd = Math.max(newStart, origEnd + endDelta)
  textarea.setSelectionRange(newStart, newEnd)
  rawRenumberOrderedLists(textarea)
  return true
}

function rawInsertInclude(textarea) {
  const snippet = "{include path=}"
  const start = textarea.selectionStart
  textarea.focus()
  textarea.setSelectionRange(start, textarea.selectionEnd)
  rawInsertText(textarea, snippet)
  // Place cursor between "=" and "}", ready to type the path
  const cursorPos = start + snippet.length - 1
  textarea.setSelectionRange(cursorPos, cursorPos)
}

// --- Raw table helpers ---

function rawGetTableContext(textarea) {
  const val = textarea.value
  const pos = textarea.selectionStart
  const pipeRe = /^\s*\|/

  // Find current line
  let lineStart = pos
  while (lineStart > 0 && val[lineStart - 1] !== "\n") lineStart--
  let lineEnd = pos
  while (lineEnd < val.length && val[lineEnd] !== "\n") lineEnd++
  const curLine = val.substring(lineStart, lineEnd)
  if (!pipeRe.test(curLine)) return null

  // Find table boundaries (contiguous pipe lines)
  const lines = val.split("\n")
  let offset = 0
  let curLineIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (offset === lineStart) {
      curLineIdx = i
      break
    }
    offset += lines[i].length + 1
  }
  if (curLineIdx < 0) return null

  let tableFirstLine = curLineIdx
  while (tableFirstLine > 0 && pipeRe.test(lines[tableFirstLine - 1])) tableFirstLine--
  // Skip a {table ...} directive just above the table
  if (tableFirstLine > 0 && /^\s*\{table\s/.test(lines[tableFirstLine - 1])) tableFirstLine--

  let tableLastLine = curLineIdx
  while (tableLastLine < lines.length - 1 && pipeRe.test(lines[tableLastLine + 1])) tableLastLine++

  return { lines, curLineIdx, tableFirstLine, tableLastLine }
}

function rawParsePipeRow(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null
  const inner = trimmed.slice(1, -1)
  return inner.split("|").map((c) => c.trim())
}

function rawBuildPipeRow(cells) {
  return "| " + cells.join(" | ") + " |"
}

function rawIsSeparatorRow(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false
  const cells = trimmed.slice(1, -1).split("|")
  // Every cell must contain at least one dash
  return cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c))
}

// Convert a table line index to a 0-based formula row (skipping separator)
function rawLineToFormulaRow(ctx, lineIdx) {
  const firstData = ctx.tableFirstLine + (/^\s*\{table\s/.test(ctx.lines[ctx.tableFirstLine]) ? 1 : 0)
  let formulaRow = 0
  for (let i = firstData; i <= ctx.tableLastLine; i++) {
    if (rawIsSeparatorRow(ctx.lines[i])) continue
    if (i === lineIdx) return formulaRow
    formulaRow++
  }
  return formulaRow
}

// Scan all cells in the table for formulas and adjust their references
function rawAdjustFormulas(ctx, changeType, changeIndex) {
  const firstData = ctx.tableFirstLine + (/^\s*\{table\s/.test(ctx.lines[ctx.tableFirstLine]) ? 1 : 0)

  for (let i = firstData; i <= ctx.tableLastLine; i++) {
    if (rawIsSeparatorRow(ctx.lines[i])) continue
    const cells = rawParsePipeRow(ctx.lines[i])
    if (!cells) continue

    let changed = false
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c].trim()
      if (cell.startsWith("=") && cell.length > 1) {
        const formula = cell.slice(1)
        const adjusted = adjustFormula(formula, changeType, changeIndex)
        if (adjusted !== formula) {
          cells[c] = "=" + adjusted
          changed = true
        }
      }
    }

    if (changed) {
      ctx.lines[i] = rawBuildPipeRow(cells)
    }
  }
}

// Adjust column specs (col1.align, col2-5.width, etc.) in the {table ...} directive line
function rawAdjustColumnSpecs(ctx, changeType, changeIndex) {
  const directiveLine = ctx.lines[ctx.tableFirstLine]
  if (!/^\s*\{table\s/.test(directiveLine)) return

  // changeIndex is 0-based column index; col specs use 1-based numbering
  const oneBasedIdx = changeIndex + 1
  const isInsert = changeType === "insertCol"

  const adjusted = directiveLine.replace(
    /col(\d+)(\+|-(?=\.))?\.(align|width|color)|col(\d+)-(\d+)\.(align|width|color)|col\.(align|width|color)/g,
    (match, singleNum, singleSuffix, _singleProp, rangeStart, rangeEnd, _rangeProp, _allProp) => {
      // col.prop — never changes
      if (match.startsWith("col.")) return match

      if (rangeStart !== undefined) {
        // Range: col3-8.prop
        const start = parseInt(rangeStart)
        const end = parseInt(rangeEnd)
        let newStart = start
        let newEnd = end
        if (isInsert) {
          // Extend range when insert is strictly inside
          if (oneBasedIdx > start && oneBasedIdx <= end) {
            newEnd++
          } else {
            if (newStart >= oneBasedIdx) newStart++
            if (newEnd >= oneBasedIdx) newEnd++
          }
        } else {
          // Delete
          if (start === end && start === oneBasedIdx) return "\x00REMOVE\x00"
          if (oneBasedIdx >= start && oneBasedIdx <= end) {
            newEnd--
          } else {
            if (newStart > oneBasedIdx) newStart--
            if (newEnd > oneBasedIdx) newEnd--
          }
        }
        if (newStart === newEnd) {
          return match.replace(/col\d+-\d+\./, `col${newStart}.`)
        }
        return match.replace(/col\d+-\d+\./, `col${newStart}-${newEnd}.`)
      }

      const num = parseInt(singleNum)
      if (singleSuffix === "+") {
        // col3+.prop — shift N when insert/delete strictly before N
        if (isInsert) {
          const newN = oneBasedIdx < num ? num + 1 : num
          return match.replace(/col\d+\+\./, `col${newN}+.`)
        } else {
          if (oneBasedIdx < num) {
            return match.replace(/col\d+\+\./, `col${num - 1}+.`)
          }
          return match
        }
      }

      if (singleSuffix === "-") {
        // col3-.prop — shift N when insert/delete at or before N
        if (isInsert) {
          const newN = oneBasedIdx <= num ? num + 1 : num
          return match.replace(/col\d+-\./, `col${newN}-.`)
        } else {
          if (oneBasedIdx <= num) {
            const newN = num - 1
            if (newN < 1) return "\x00REMOVE\x00"
            return match.replace(/col\d+-\./, `col${newN}-.`)
          }
          return match
        }
      }

      // Single: col3.prop
      if (isInsert) {
        const newIdx = num >= oneBasedIdx ? num + 1 : num
        return match.replace(/col\d+\./, `col${newIdx}.`)
      } else {
        if (num === oneBasedIdx) return "\x00REMOVE\x00"
        const newIdx = num > oneBasedIdx ? num - 1 : num
        return match.replace(/col\d+\./, `col${newIdx}.`)
      }
    }
  )

  // Remove sentinel-marked specs and clean up (handles both unquoted and quoted values)
  // eslint-disable-next-line no-control-regex -- NUL bytes are the sentinel used to mark specs slated for removal; they cannot appear in normal directive text so they're safe as a marker.
  let cleaned = adjusted.replace(/\s*\x00REMOVE\x00=(?:"[^"]*"|\S+)/g, "")
  // If directive is now empty (only "{table }"), remove the line
  if (/^\s*\{table\s*\}\s*$/.test(cleaned)) {
    ctx.lines.splice(ctx.tableFirstLine, 1)
    ctx.tableLastLine--
  } else {
    // Collapse multiple spaces
    cleaned = cleaned.replace(/  +/g, " ")
    ctx.lines[ctx.tableFirstLine] = cleaned
  }
}

function rawTableColCount(ctx) {
  for (let i = ctx.tableFirstLine; i <= ctx.tableLastLine; i++) {
    const cells = rawParsePipeRow(ctx.lines[i])
    if (cells && !rawIsSeparatorRow(ctx.lines[i])) return cells.length
  }
  return 0
}

// Get current cell coordinates (row index within table, column index)
function rawGetCellCoords(textarea, ctx) {
  const val = textarea.value
  const pos = textarea.selectionStart
  const lineStart = ctx.lines.slice(0, ctx.curLineIdx).reduce((s, l) => s + l.length + 1, 0)
  const lineEnd = lineStart + ctx.lines[ctx.curLineIdx].length
  const pipes = rawFindPipes(val, lineStart, lineEnd)
  let col = 0
  for (let i = 0; i < pipes.length - 1; i++) {
    if (pos >= pipes[i] && pos <= pipes[i + 1]) {
      col = i
      break
    }
  }
  return { row: ctx.curLineIdx, col }
}

// Position cursor at cell (row, col) in the table after replacement
function rawFocusCell(textarea, ctx, row, col) {
  const newVal = textarea.value
  // Compute offset of tableFirstLine
  let tableOffset = 0
  const allLines = newVal.split("\n")
  for (let i = 0; i < ctx.tableFirstLine; i++) tableOffset += allLines[i].length + 1

  // Find the target row offset
  let targetLineOffset = tableOffset
  for (let i = ctx.tableFirstLine; i < row && i <= ctx.tableLastLine; i++) {
    targetLineOffset += allLines[i].length + 1
  }
  if (row > ctx.tableLastLine) return

  const targetLine = allLines[row]
  if (!targetLine) return
  const lineStart = targetLineOffset
  const lineEnd = lineStart + targetLine.length
  const pipes = rawFindPipes(newVal, lineStart, lineEnd)

  // Clamp col to available cells
  const maxCol = Math.max(0, pipes.length - 2)
  const c = Math.min(col, maxCol)
  if (pipes.length >= 2 && c < pipes.length - 1) {
    rawSelectCell(textarea, pipes[c], pipes[c + 1])
  }
}

function rawReplaceLines(textarea, ctx, origTableLastLine) {
  const val = textarea.value
  const allLines = val.split("\n")
  const origLast = origTableLastLine ?? ctx.tableLastLine
  // Compute char offsets of the original table region
  let startOffset = 0
  for (let i = 0; i < ctx.tableFirstLine; i++) startOffset += allLines[i].length + 1
  let endOffset = startOffset
  for (let i = ctx.tableFirstLine; i <= origLast; i++) endOffset += allLines[i].length + 1
  if (endOffset > 0 && endOffset <= val.length + 1) endOffset-- // trim trailing newline

  const replacement = ctx.lines.slice(ctx.tableFirstLine, ctx.tableLastLine + 1).join("\n")
  const scroller = document.querySelector("#app")
  const savedScroll = scroller ? scroller.scrollTop : 0
  textarea.focus()
  textarea.setSelectionRange(startOffset, Math.min(endOffset, val.length))
  rawInsertText(textarea, replacement)
  if (scroller) scroller.scrollTop = savedScroll
}

function rawInsertTable(textarea) {
  const row1 = "| Header 1 | Header 2 | Header 3 |"
  const sep = "| --- | --- | --- |"
  const row2 = "|  |  |  |"
  const snippet = row1 + "\n" + sep + "\n" + row2

  const { lineStart, lineEnd } = rawGetCurrentLineRange(textarea)
  const line = textarea.value.substring(lineStart, lineEnd)
  textarea.focus()
  if (line.trim() === "") {
    textarea.setSelectionRange(lineStart, lineEnd)
    rawInsertText(textarea, snippet)
  } else {
    textarea.setSelectionRange(lineEnd, lineEnd)
    rawInsertText(textarea, "\n" + snippet)
  }
}

function rawTableAddRowBelow(textarea) {
  const ctx = rawGetTableContext(textarea)
  if (!ctx) return
  const coords = rawGetCellCoords(textarea, ctx)
  const cols = rawTableColCount(ctx)
  if (cols === 0) return
  const changeIndex = rawLineToFormulaRow(ctx, ctx.curLineIdx) + 1
  const origLast = ctx.tableLastLine
  const newRow = rawBuildPipeRow(Array(cols).fill(""))
  ctx.lines.splice(ctx.curLineIdx + 1, 0, newRow)
  ctx.tableLastLine++
  rawAdjustFormulas(ctx, "insertRow", changeIndex)
  rawReplaceLines(textarea, ctx, origLast)
  rawFocusCell(textarea, ctx, coords.row, coords.col)
}

function rawTableAddRowAbove(textarea) {
  const ctx = rawGetTableContext(textarea)
  if (!ctx) return
  const coords = rawGetCellCoords(textarea, ctx)
  const cols = rawTableColCount(ctx)
  if (cols === 0) return
  const firstDataLine = ctx.tableFirstLine + (/^\s*\{table\s/.test(ctx.lines[ctx.tableFirstLine]) ? 1 : 0)
  if (ctx.curLineIdx <= firstDataLine + 1) return
  const changeIndex = rawLineToFormulaRow(ctx, ctx.curLineIdx)
  const origLast = ctx.tableLastLine
  const newRow = rawBuildPipeRow(Array(cols).fill(""))
  ctx.lines.splice(ctx.curLineIdx, 0, newRow)
  ctx.tableLastLine++
  rawAdjustFormulas(ctx, "insertRow", changeIndex)
  rawReplaceLines(textarea, ctx, origLast)
  // Cursor row shifted down by 1 due to insertion above
  rawFocusCell(textarea, ctx, coords.row + 1, coords.col)
}

function rawTableAddColumnRight(textarea) {
  const ctx = rawGetTableContext(textarea)
  if (!ctx) return
  const coords = rawGetCellCoords(textarea, ctx)
  const cols = rawTableColCount(ctx)
  const firstData = ctx.tableFirstLine + (/^\s*\{table\s/.test(ctx.lines[ctx.tableFirstLine]) ? 1 : 0)

  const insertIdx = coords.col + 1
  for (let i = firstData; i <= ctx.tableLastLine; i++) {
    const row = rawParsePipeRow(ctx.lines[i])
    if (!row) continue
    if (rawIsSeparatorRow(ctx.lines[i])) {
      row.splice(insertIdx, 0, "---")
    } else {
      row.splice(insertIdx, 0, "")
    }
    ctx.lines[i] = rawBuildPipeRow(row)
  }
  rawAdjustFormulas(ctx, "insertCol", insertIdx)
  rawAdjustColumnSpecs(ctx, "insertCol", insertIdx)
  rawReplaceLines(textarea, ctx)
  rawFocusCell(textarea, ctx, coords.row, coords.col)
}

function rawTableAddColumnLeft(textarea) {
  const ctx = rawGetTableContext(textarea)
  if (!ctx) return
  const coords = rawGetCellCoords(textarea, ctx)
  const firstData = ctx.tableFirstLine + (/^\s*\{table\s/.test(ctx.lines[ctx.tableFirstLine]) ? 1 : 0)

  const insertIdx = coords.col
  for (let i = firstData; i <= ctx.tableLastLine; i++) {
    const row = rawParsePipeRow(ctx.lines[i])
    if (!row) continue
    if (rawIsSeparatorRow(ctx.lines[i])) {
      row.splice(insertIdx, 0, "---")
    } else {
      row.splice(insertIdx, 0, "")
    }
    ctx.lines[i] = rawBuildPipeRow(row)
  }
  rawAdjustFormulas(ctx, "insertCol", insertIdx)
  rawAdjustColumnSpecs(ctx, "insertCol", insertIdx)
  rawReplaceLines(textarea, ctx)
  // Column shifted right by 1 due to insertion at left
  rawFocusCell(textarea, ctx, coords.row, coords.col + 1)
}

function rawTableDeleteRow(textarea) {
  const ctx = rawGetTableContext(textarea)
  if (!ctx) return
  const coords = rawGetCellCoords(textarea, ctx)
  const firstData = ctx.tableFirstLine + (/^\s*\{table\s/.test(ctx.lines[ctx.tableFirstLine]) ? 1 : 0)
  if (ctx.curLineIdx <= firstData + 1) return
  const changeIndex = rawLineToFormulaRow(ctx, ctx.curLineIdx)
  const origLast = ctx.tableLastLine
  ctx.lines.splice(ctx.curLineIdx, 1)
  ctx.tableLastLine--
  rawAdjustFormulas(ctx, "deleteRow", changeIndex)
  rawReplaceLines(textarea, ctx, origLast)
  // Focus cell below (same row index, since rows shifted up), or above if was last row
  const targetRow = Math.min(coords.row, ctx.tableLastLine)
  rawFocusCell(textarea, ctx, targetRow, coords.col)
}

function rawTableDeleteColumn(textarea) {
  const ctx = rawGetTableContext(textarea)
  if (!ctx) return
  const coords = rawGetCellCoords(textarea, ctx)
  const firstData = ctx.tableFirstLine + (/^\s*\{table\s/.test(ctx.lines[ctx.tableFirstLine]) ? 1 : 0)
  const cols = rawTableColCount(ctx)
  if (cols <= 1) return

  // Remove the column at cursor position
  for (let i = firstData; i <= ctx.tableLastLine; i++) {
    const row = rawParsePipeRow(ctx.lines[i])
    if (!row || row.length <= 1) continue
    row.splice(coords.col, 1)
    ctx.lines[i] = rawBuildPipeRow(row)
  }
  rawAdjustFormulas(ctx, "deleteCol", coords.col)
  rawAdjustColumnSpecs(ctx, "deleteCol", coords.col)
  rawReplaceLines(textarea, ctx)
  // Focus cell to the right (same col), or left if was last column
  const targetCol = Math.min(coords.col, cols - 2)
  rawFocusCell(textarea, ctx, coords.row, targetCol)
}

// Select a cell's content between two pipe positions.
// For empty cells, place cursor in the middle (after leading space).
function rawSelectCell(textarea, pipeLeft, pipeRight) {
  const val = textarea.value
  const cellStart = pipeLeft + 1
  let contentStart = cellStart
  while (contentStart < pipeRight && val[contentStart] === " ") contentStart++
  let contentEnd = pipeRight
  while (contentEnd > contentStart && val[contentEnd - 1] === " ") contentEnd--
  if (contentStart >= contentEnd) {
    // Empty cell: place cursor after leading space (middle of cell)
    const mid = Math.min(cellStart + 1, pipeRight)
    textarea.setSelectionRange(mid, mid)
  } else {
    textarea.setSelectionRange(contentStart, contentEnd)
  }
}

// Find all pipe positions on a line (within lineStart..lineEnd)
function rawFindPipes(val, lineStart, lineEnd) {
  const pipes = []
  for (let i = lineStart; i <= lineEnd; i++) {
    if (val[i] === "|") pipes.push(i)
  }
  return pipes
}

function rawHandleTabInTable(textarea, direction) {
  const val = textarea.value
  const pos = textarea.selectionStart
  const pipeRe = /^\s*\|/

  // Check if cursor is on a table line
  let lineStart = pos
  while (lineStart > 0 && val[lineStart - 1] !== "\n") lineStart--
  let lineEnd = pos
  while (lineEnd < val.length && val[lineEnd] !== "\n") lineEnd++
  const line = val.substring(lineStart, lineEnd)
  if (!pipeRe.test(line)) return false

  // Don't navigate on the separator row
  if (rawIsSeparatorRow(line)) return false

  const pipes = rawFindPipes(val, lineStart, lineEnd)
  if (pipes.length < 2) return false

  // Find which cell the cursor is in
  let cellIdx = -1
  for (let i = 0; i < pipes.length - 1; i++) {
    if (pos >= pipes[i] && pos <= pipes[i + 1]) {
      cellIdx = i
      break
    }
  }
  if (cellIdx === -1) cellIdx = 0

  const totalCells = pipes.length - 1

  if (direction === 1) {
    // Forward
    if (cellIdx < totalCells - 1) {
      // Move to next cell on same line
      rawSelectCell(textarea, pipes[cellIdx + 1], pipes[cellIdx + 2])
      return true
    }

    // Last cell on this line — move to next data row
    let nextLineStart = lineEnd + 1
    if (nextLineStart >= val.length) return rawTabAddTableRow(textarea)
    let nextLineEnd = nextLineStart
    while (nextLineEnd < val.length && val[nextLineEnd] !== "\n") nextLineEnd++
    let nextLine = val.substring(nextLineStart, nextLineEnd)

    if (!pipeRe.test(nextLine)) return rawTabAddTableRow(textarea)

    // Skip separator rows
    if (rawIsSeparatorRow(nextLine)) {
      nextLineStart = nextLineEnd + 1
      if (nextLineStart >= val.length) return rawTabAddTableRow(textarea)
      nextLineEnd = nextLineStart
      while (nextLineEnd < val.length && val[nextLineEnd] !== "\n") nextLineEnd++
      nextLine = val.substring(nextLineStart, nextLineEnd)
      if (!pipeRe.test(nextLine) || rawIsSeparatorRow(nextLine)) return rawTabAddTableRow(textarea)
    }

    // Move to first cell of next row
    const nextPipes = rawFindPipes(val, nextLineStart, nextLineEnd)
    if (nextPipes.length < 2) return false
    rawSelectCell(textarea, nextPipes[0], nextPipes[1])
    return true
  } else {
    // Backward
    if (cellIdx > 0) {
      // Move to previous cell on same line
      rawSelectCell(textarea, pipes[cellIdx - 1], pipes[cellIdx])
      return true
    }

    // First cell — move to previous row's last cell
    if (lineStart === 0) return false
    let prevLineEnd = lineStart - 1
    let prevLineStart = prevLineEnd
    while (prevLineStart > 0 && val[prevLineStart - 1] !== "\n") prevLineStart--
    let prevLine = val.substring(prevLineStart, prevLineEnd)

    // Skip separator rows
    if (rawIsSeparatorRow(prevLine)) {
      if (prevLineStart === 0) return false
      prevLineEnd = prevLineStart - 1
      prevLineStart = prevLineEnd
      while (prevLineStart > 0 && val[prevLineStart - 1] !== "\n") prevLineStart--
      prevLine = val.substring(prevLineStart, prevLineEnd)
    }

    if (!pipeRe.test(prevLine)) return false
    const prevPipes = rawFindPipes(val, prevLineStart, prevLineEnd)
    if (prevPipes.length < 2) return false
    // Select last cell
    rawSelectCell(textarea, prevPipes[prevPipes.length - 2], prevPipes[prevPipes.length - 1])
    return true
  }
}

function rawTabAddTableRow(textarea) {
  const ctx = rawGetTableContext(textarea)
  if (!ctx) return false
  const cols = rawTableColCount(ctx)
  if (cols === 0) return false

  const newRow = rawBuildPipeRow(Array(cols).fill(""))

  // Find the end of the last table line
  let endOffset = 0
  for (let i = 0; i <= ctx.tableLastLine; i++) endOffset += ctx.lines[i].length + 1
  endOffset-- // remove trailing newline offset

  textarea.focus()
  textarea.setSelectionRange(endOffset, endOffset)
  rawInsertText(textarea, "\n" + newRow)

  // Move cursor to first cell of the new row
  const newRowStart = endOffset + 1
  const newVal = textarea.value
  let newRowEnd = newRowStart
  while (newRowEnd < newVal.length && newVal[newRowEnd] !== "\n") newRowEnd++
  const newPipes = rawFindPipes(newVal, newRowStart, newRowEnd)
  if (newPipes.length >= 2) {
    rawSelectCell(textarea, newPipes[0], newPipes[1])
  }
  return true
}

function rawInsertProperty(textarea) {
  const val = textarea.value
  const pos = textarea.selectionStart

  // Find current line
  let lineStart = pos
  while (lineStart > 0 && val[lineStart - 1] !== "\n") lineStart--
  let lineEnd = pos
  while (lineEnd < val.length && val[lineEnd] !== "\n") lineEnd++
  const line = val.substring(lineStart, lineEnd)

  // Detect context: what directive to insert
  let directive = null
  let tableStart = lineStart
  if (/!\[.*\]\(.*\)/.test(line)) {
    // Image line — check if a {image ...} directive already exists above
    if (lineStart > 0) {
      const prevEnd = lineStart - 1
      let prevStart = prevEnd
      while (prevStart > 0 && val[prevStart - 1] !== "\n") prevStart--
      const prevLine = val.substring(prevStart, prevEnd)
      if (/^\s*\{image\s/.test(prevLine)) {
        // Already has a property directive — select its value for editing
        const eqIdx = prevLine.indexOf("=")
        if (eqIdx >= 0) {
          const valStart = prevStart + eqIdx + 1
          const valEnd = prevStart + prevLine.lastIndexOf("}")
          textarea.focus()
          textarea.setSelectionRange(valStart, Math.max(valStart, valEnd))
        }
        return
      }
    }
    directive = "{image size=}"
  } else if (/^\s*\|/.test(line)) {
    // Table line — check if a {table ...} directive already exists above the table
    // Find the first line of the table
    tableStart = lineStart
    while (tableStart > 0) {
      let pStart = tableStart - 1
      while (pStart > 0 && val[pStart - 1] !== "\n") pStart--
      const pLine = val.substring(pStart, tableStart - 1)
      if (/^\s*\|/.test(pLine)) {
        tableStart = pStart
      } else {
        break
      }
    }
    if (tableStart > 0) {
      const prevEnd = tableStart - 1
      let prevStart = prevEnd
      while (prevStart > 0 && val[prevStart - 1] !== "\n") prevStart--
      const prevLine = val.substring(prevStart, prevEnd)
      if (/^\s*\{table\s/.test(prevLine)) {
        const eqIdx = prevLine.indexOf("=")
        if (eqIdx >= 0) {
          const valStart = prevStart + eqIdx + 1
          const valEnd = prevStart + prevLine.lastIndexOf("}")
          textarea.focus()
          textarea.setSelectionRange(valStart, Math.max(valStart, valEnd))
        }
        return
      }
    }
    directive = "{table width=}"
  }

  if (!directive) return

  // For tables, insert above the table start; for images, above the current line
  const insertAt = /^\s*\|/.test(line) ? tableStart : lineStart

  // Insert directive on its own line before the target line
  const scroller = document.querySelector("#app")
  const savedScroll = scroller ? scroller.scrollTop : 0
  textarea.focus()
  textarea.setSelectionRange(insertAt, insertAt)
  rawInsertText(textarea, directive + "\n")

  // Place cursor between "=" and "}"
  const cursorPos = insertAt + directive.length - 1
  textarea.setSelectionRange(cursorPos, cursorPos)
  if (scroller) scroller.scrollTop = savedScroll
}

function markActive(state, type) {
  const { from, $from, to, empty } = state.selection
  if (empty) return Boolean(type.isInSet(state.storedMarks || $from.marks()))
  return state.doc.rangeHasMark(from, to, type)
}

function updateMenubarState(state, refs) {
  if (!refs) return
  const setActive = (btn, active) => {
    if (!btn) return
    btn.classList.toggle("gowiki-raw-menuitem-active", active)
  }
  if (schema.marks.strong && refs.bold) {
    setActive(refs.bold, markActive(state, schema.marks.strong))
  }
  if (schema.marks.em && refs.italic) {
    setActive(refs.italic, markActive(state, schema.marks.em))
  }
  if (schema.marks.code && refs.code) {
    setActive(refs.code, markActive(state, schema.marks.code))
  }
  if (schema.marks.underline && refs.underline) {
    setActive(refs.underline, markActive(state, schema.marks.underline))
  }
  if (schema.marks.strikethrough && refs.strikethrough) {
    setActive(refs.strikethrough, markActive(state, schema.marks.strikethrough))
  }
  if (schema.marks.subscript && refs.subscript) {
    setActive(refs.subscript, markActive(state, schema.marks.subscript))
  }
  if (schema.marks.superscript && refs.superscript) {
    setActive(refs.superscript, markActive(state, schema.marks.superscript))
  }
  if (refs.properties) {
    setActive(refs.properties, isPropertiesPanelEnabled(state))
  }
}

// --- Symbol picker (searchable panel) ---
const symbolCatalogue = [
  // Indicators
  { char: "\u26A0\uFE0F", label: "Warning", cat: "Indicators", aliases: "alert caution danger" },
  { char: "\u2139\uFE0F", label: "Info", cat: "Indicators", aliases: "information" },
  { char: "\u2705", label: "Check", cat: "Indicators", aliases: "yes ok done" },
  { char: "\u274C", label: "Cross", cat: "Indicators", aliases: "no wrong delete remove" },
  { char: "\u2B50", label: "Star", cat: "Indicators", aliases: "favorite" },
  { char: "\u{1F4A1}", label: "Idea", cat: "Indicators", aliases: "lightbulb tip" },
  { char: "\u{1F4CC}", label: "Pin", cat: "Indicators", aliases: "pushpin" },
  { char: "\u{1F512}", label: "Lock", cat: "Indicators", aliases: "locked secure" },
  { char: "\u{1F513}", label: "Unlock", cat: "Indicators", aliases: "unlocked open" },
  { char: "\u{1F4DD}", label: "Note", cat: "Indicators", aliases: "memo" },
  { char: "\u{1F534}", label: "Red circle", cat: "Indicators", aliases: "stop" },
  { char: "\u{1F7E2}", label: "Green circle", cat: "Indicators", aliases: "go" },
  { char: "\u{1F7E1}", label: "Yellow circle", cat: "Indicators", aliases: "caution" },
  { char: "\u{1F535}", label: "Blue circle", cat: "Indicators", aliases: "" },
  // Checkboxes
  { char: "\u2610", label: "Ballot box", cat: "Checkboxes", aliases: "unchecked empty checkbox" },
  { char: "\u2611\uFE0F", label: "Ballot check", cat: "Checkboxes", aliases: "checked done checkbox" },
  { char: "\u2612", label: "Ballot cross", cat: "Checkboxes", aliases: "crossed rejected checkbox" },
  // Arrows
  { char: "\u2192", label: "Arrow right", cat: "Arrows", aliases: "right ->" },
  { char: "\u2190", label: "Arrow left", cat: "Arrows", aliases: "left <-" },
  { char: "\u2191", label: "Arrow up", cat: "Arrows", aliases: "up" },
  { char: "\u2193", label: "Arrow down", cat: "Arrows", aliases: "down" },
  { char: "\u2194", label: "Arrow left-right", cat: "Arrows", aliases: "horizontal both" },
  { char: "\u2195", label: "Arrow up-down", cat: "Arrows", aliases: "vertical both" },
  { char: "\u21D2", label: "Double arrow right", cat: "Arrows", aliases: "implies =>" },
  { char: "\u21D0", label: "Double arrow left", cat: "Arrows", aliases: "implied by <=" },
  { char: "\u21D4", label: "Double arrow both", cat: "Arrows", aliases: "equivalent <=>" },
  { char: "\u21B5", label: "Return arrow", cat: "Arrows", aliases: "enter newline cr" },
  // Math
  { char: "\u00B1", label: "Plus-minus", cat: "Math", aliases: "plusminus +/-" },
  { char: "\u00D7", label: "Multiply", cat: "Math", aliases: "times cross x" },
  { char: "\u00F7", label: "Divide", cat: "Math", aliases: "division" },
  { char: "\u2260", label: "Not equal", cat: "Math", aliases: "ne !=" },
  { char: "\u2264", label: "Less or equal", cat: "Math", aliases: "le <=" },
  { char: "\u2265", label: "Greater or equal", cat: "Math", aliases: "ge >=" },
  { char: "\u2248", label: "Approximately", cat: "Math", aliases: "approx almost ~" },
  { char: "\u221E", label: "Infinity", cat: "Math", aliases: "inf" },
  { char: "\u221A", label: "Square root", cat: "Math", aliases: "sqrt radical" },
  { char: "\u2211", label: "Summation", cat: "Math", aliases: "sum sigma" },
  { char: "\u220F", label: "Product", cat: "Math", aliases: "prod pi" },
  { char: "\u2202", label: "Partial", cat: "Math", aliases: "partial derivative" },
  { char: "\u2208", label: "Element of", cat: "Math", aliases: "in belongs member" },
  { char: "\u2209", label: "Not element of", cat: "Math", aliases: "notin" },
  { char: "\u2282", label: "Subset", cat: "Math", aliases: "subset" },
  { char: "\u2283", label: "Superset", cat: "Math", aliases: "superset" },
  { char: "\u2229", label: "Intersection", cat: "Math", aliases: "cap and" },
  { char: "\u222A", label: "Union", cat: "Math", aliases: "cup or" },
  { char: "\u2205", label: "Empty set", cat: "Math", aliases: "null void" },
  { char: "\u2234", label: "Therefore", cat: "Math", aliases: "so hence" },
  // Greek
  { char: "\u03B1", label: "Alpha", cat: "Greek", aliases: "" },
  { char: "\u03B2", label: "Beta", cat: "Greek", aliases: "" },
  { char: "\u03B3", label: "Gamma", cat: "Greek", aliases: "" },
  { char: "\u03B4", label: "Delta", cat: "Greek", aliases: "" },
  { char: "\u03B5", label: "Epsilon", cat: "Greek", aliases: "" },
  { char: "\u03B6", label: "Zeta", cat: "Greek", aliases: "" },
  { char: "\u03B7", label: "Eta", cat: "Greek", aliases: "" },
  { char: "\u03B8", label: "Theta", cat: "Greek", aliases: "" },
  { char: "\u03BB", label: "Lambda", cat: "Greek", aliases: "" },
  { char: "\u03BC", label: "Mu", cat: "Greek", aliases: "micro" },
  { char: "\u03C0", label: "Pi", cat: "Greek", aliases: "" },
  { char: "\u03C1", label: "Rho", cat: "Greek", aliases: "" },
  { char: "\u03C3", label: "Sigma", cat: "Greek", aliases: "" },
  { char: "\u03C4", label: "Tau", cat: "Greek", aliases: "" },
  { char: "\u03C6", label: "Phi", cat: "Greek", aliases: "" },
  { char: "\u03C9", label: "Omega", cat: "Greek", aliases: "" },
  { char: "\u0394", label: "Delta (upper)", cat: "Greek", aliases: "capital" },
  { char: "\u03A3", label: "Sigma (upper)", cat: "Greek", aliases: "capital" },
  { char: "\u03A9", label: "Omega (upper)", cat: "Greek", aliases: "capital ohm" },
  // Common
  { char: "\u00A9", label: "Copyright", cat: "Common", aliases: "(c)" },
  { char: "\u00AE", label: "Registered", cat: "Common", aliases: "(r)" },
  { char: "\u2122", label: "Trademark", cat: "Common", aliases: "tm" },
  { char: "\u00B0", label: "Degree", cat: "Common", aliases: "temperature" },
  { char: "\u00B5", label: "Micro", cat: "Common", aliases: "mu" },
  { char: "\u00B6", label: "Pilcrow", cat: "Common", aliases: "paragraph" },
  { char: "\u00A7", label: "Section", cat: "Common", aliases: "paragraph" },
  { char: "\u2020", label: "Dagger", cat: "Common", aliases: "cross obelisk" },
  { char: "\u2021", label: "Double dagger", cat: "Common", aliases: "diesis" },
  { char: "\u2022", label: "Bullet", cat: "Common", aliases: "dot" },
  { char: "\u2026", label: "Ellipsis", cat: "Common", aliases: "dots ..." },
  { char: "\u2013", label: "En dash", cat: "Common", aliases: "ndash" },
  { char: "\u2014", label: "Em dash", cat: "Common", aliases: "mdash" },
  { char: "\u00A0", label: "Non-breaking space", cat: "Common", aliases: "nbsp" },
  // Superscript digits
  { char: "\u2070", label: "Superscript 0", cat: "Superscript", aliases: "sup power" },
  { char: "\u00B9", label: "Superscript 1", cat: "Superscript", aliases: "sup power" },
  { char: "\u00B2", label: "Superscript 2", cat: "Superscript", aliases: "sup power squared" },
  { char: "\u00B3", label: "Superscript 3", cat: "Superscript", aliases: "sup power cubed" },
  { char: "\u2074", label: "Superscript 4", cat: "Superscript", aliases: "sup power" },
  { char: "\u2075", label: "Superscript 5", cat: "Superscript", aliases: "sup power" },
  { char: "\u2076", label: "Superscript 6", cat: "Superscript", aliases: "sup power" },
  { char: "\u2077", label: "Superscript 7", cat: "Superscript", aliases: "sup power" },
  { char: "\u2078", label: "Superscript 8", cat: "Superscript", aliases: "sup power" },
  { char: "\u2079", label: "Superscript 9", cat: "Superscript", aliases: "sup power" },
]

let symbolPanelEl = null
let symbolPanelAnchor = null // "toolbar" or "cursor"
let symbolToolbarAnchor = null // DOM element of the toolbar button
let symbolPanelOutsideHandler = null

function insertSymbolChar(char) {
  if (editMode === "visual" && editorView) {
    const tr = editorView.state.tr.insertText(char)
    editorView.dispatch(tr)
    editorView.focus()
  } else if (editMode === "raw" && rawEditor) {
    rawEditor.focus()
    const start = rawEditor.selectionStart
    const end = rawEditor.selectionEnd
    const before = rawEditor.value.slice(0, start)
    const after = rawEditor.value.slice(end)
    rawEditor.value = before + char + after
    const pos = start + char.length
    rawEditor.setSelectionRange(pos, pos)
    rawEditor.dispatchEvent(new Event("input", { bubbles: true }))
  }
}

function buildSymbolPanel() {
  const panel = document.createElement("div")
  panel.className = "gowiki-symbol-panel"

  const search = document.createElement("input")
  search.className = "gowiki-symbol-search"
  search.type = "text"
  search.placeholder = "Search symbols\u2026"
  panel.appendChild(search)

  const body = document.createElement("div")
  body.className = "gowiki-symbol-body"
  panel.appendChild(body)

  let selectedIdx = -1
  let visibleItems = []

  function renderSymbols(filter) {
    body.innerHTML = ""
    visibleItems = []
    selectedIdx = -1
    const q = filter.toLowerCase()

    if (q) {
      // Flat filtered list
      const matches = symbolCatalogue.filter((s) => {
        const hay = (s.label + " " + s.aliases + " " + s.cat).toLowerCase()
        return hay.includes(q)
      })
      if (matches.length === 0) {
        const empty = document.createElement("div")
        empty.className = "gowiki-symbol-empty"
        empty.textContent = "No matches"
        body.appendChild(empty)
        return
      }
      const grid = document.createElement("div")
      grid.className = "gowiki-symbol-grid-inner"
      for (const sym of matches) {
        const item = createSymbolItem(sym)
        grid.appendChild(item)
        visibleItems.push({ el: item, sym })
      }
      body.appendChild(grid)
      // Auto-select first item
      if (visibleItems.length > 0) {
        selectedIdx = 0
        visibleItems[0].el.classList.add("gowiki-symbol-item--selected")
      }
    } else {
      // Categorized view
      const cats = []
      const catMap = new Map()
      for (const sym of symbolCatalogue) {
        if (!catMap.has(sym.cat)) {
          catMap.set(sym.cat, [])
          cats.push(sym.cat)
        }
        catMap.get(sym.cat).push(sym)
      }
      for (const cat of cats) {
        const header = document.createElement("div")
        header.className = "gowiki-symbol-cat"
        header.textContent = cat
        body.appendChild(header)
        const grid = document.createElement("div")
        grid.className = "gowiki-symbol-grid-inner"
        for (const sym of catMap.get(cat)) {
          const item = createSymbolItem(sym)
          grid.appendChild(item)
          visibleItems.push({ el: item, sym })
        }
        body.appendChild(grid)
      }
    }
  }

  function createSymbolItem(sym) {
    const item = document.createElement("span")
    item.className = "gowiki-symbol-item"
    item.textContent = sym.char
    item.title = sym.label
    item.addEventListener("mousedown", (e) => {
      e.preventDefault()
      closeSymbolPanel()
      insertSymbolChar(sym.char)
    })
    return item
  }

  function moveSelection(delta) {
    if (visibleItems.length === 0) return
    if (selectedIdx >= 0) {
      visibleItems[selectedIdx].el.classList.remove("gowiki-symbol-item--selected")
    }
    if (selectedIdx < 0) {
      selectedIdx = delta > 0 ? 0 : visibleItems.length - 1
    } else {
      selectedIdx = (selectedIdx + delta + visibleItems.length) % visibleItems.length
    }
    visibleItems[selectedIdx].el.classList.add("gowiki-symbol-item--selected")
    visibleItems[selectedIdx].el.scrollIntoView({ block: "nearest" })
  }

  search.addEventListener("input", () => renderSymbols(search.value))
  search.addEventListener("keydown", (e) => {
    const cols = 8 // grid columns
    if (e.key === "ArrowDown") {
      e.preventDefault()
      moveSelection(cols)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      moveSelection(-cols)
    } else if (e.key === "ArrowRight") {
      // Only navigate grid if cursor is at end of search text
      if (search.selectionStart === search.value.length) {
        e.preventDefault()
        moveSelection(1)
      }
    } else if (e.key === "ArrowLeft") {
      if (search.selectionStart === 0 && search.selectionEnd === 0) {
        e.preventDefault()
        moveSelection(-1)
      }
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      if (selectedIdx >= 0 && selectedIdx < visibleItems.length) {
        closeSymbolPanel()
        insertSymbolChar(visibleItems[selectedIdx].sym.char)
      }
    } else if (e.key === "Escape") {
      e.preventDefault()
      closeSymbolPanel()
    }
  })

  renderSymbols("")
  return { panel, search }
}

function openSymbolPanel(anchor) {
  if (symbolPanelEl) closeSymbolPanel()
  const { panel, search } = buildSymbolPanel()
  symbolPanelEl = panel
  symbolPanelAnchor = anchor

  document.body.appendChild(panel)
  let rect
  if (anchor === "toolbar" && symbolToolbarAnchor) {
    const r = symbolToolbarAnchor.getBoundingClientRect()
    rect = { left: r.left, top: r.bottom }
  } else if (editMode === "visual" && editorView) {
    const coords = editorView.coordsAtPos(editorView.state.selection.from)
    rect = { left: coords.left, top: coords.bottom }
  } else if (editMode === "raw" && rawEditor) {
    const r = rawEditor.getBoundingClientRect()
    rect = { left: r.left + 20, top: r.top + 20 }
  } else {
    rect = { left: window.innerWidth / 2 - 150, top: window.innerHeight / 3 }
  }
  panel.style.position = "fixed"
  panel.style.left = Math.min(rect.left, window.innerWidth - 320) + "px"
  panel.style.top = Math.min(rect.top + 4, window.innerHeight - 400) + "px"

  // Dismiss on click outside. Capture phase so we fire before focus steal.
  symbolPanelOutsideHandler = (e) => {
    if (!symbolPanelEl) return
    if (symbolPanelEl.contains(e.target)) return
    if (symbolToolbarAnchor && symbolToolbarAnchor.contains(e.target)) return
    closeSymbolPanel()
  }
  document.addEventListener("mousedown", symbolPanelOutsideHandler, true)

  // Focus the search field after a microtask so it doesn't lose focus immediately
  requestAnimationFrame(() => search.focus())
}

function closeSymbolPanel() {
  if (!symbolPanelEl) return
  symbolPanelEl.remove()
  symbolPanelEl = null
  symbolPanelAnchor = null
  if (symbolPanelOutsideHandler) {
    document.removeEventListener("mousedown", symbolPanelOutsideHandler, true)
    symbolPanelOutsideHandler = null
  }
}

// ── AI Assistant Panel ──────────────────────────────

let aiPanelEl = null
let aiPanelOpen = false
let aiPanelBusy = false
let aiConversationHistory = [] // [{role: "user"|"assistant", content: "..."}]

function toggleAIPanel() {
  if (!aiAssistantEnabled) return
  if (aiPanelOpen) {
    closeAIPanel()
  } else {
    openAIPanel()
  }
}

function openAIPanel() {
  if (aiPanelEl) return
  aiPanelOpen = true

  aiPanelEl = document.createElement("div")
  aiPanelEl.id = "ai-panel"
  const isEditing = mode === "edit"
  const placeholder = isEditing ? "Ask AI to modify this page..." : "Ask a question about this page or the wiki..."
  aiPanelEl.innerHTML = `
    <div class="ai-panel-header">
      <span class="ai-panel-title">AI Assistant</span>
      ${isEditing ? '<button class="ai-panel-clear-comments" title="Clear AI comments">Clear AI notes</button>' : ""}
      <button class="ai-panel-width-toggle" title="Toggle panel width">Wide</button>
      <button class="ai-panel-close" title="Close">\u2715</button>
    </div>
    <div class="ai-panel-input-row">
      <textarea class="ai-panel-input" placeholder="${placeholder}" rows="2"></textarea>
      <button class="ai-panel-send" title="Send (Ctrl+Enter)">&#9654;</button>
      ${isEditing ? '<button class="ai-panel-review" title="Review mode — AI analyzes and proposes changes">Review</button>' : ""}
    </div>
    <div class="ai-panel-messages"></div>
  `
  appRoot.appendChild(aiPanelEl)
  appRoot.classList.add("ai-panel-visible")

  const closeBtn = aiPanelEl.querySelector(".ai-panel-close")
  closeBtn.addEventListener("click", closeAIPanel)

  const clearBtn = aiPanelEl.querySelector(".ai-panel-clear-comments")
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      await clearAIComments()
      aiAddMessage("assistant", "AI comments cleared.").classList.add("ai-msg-applied")
    })
  }

  const widthBtn = aiPanelEl.querySelector(".ai-panel-width-toggle")
  widthBtn.addEventListener("click", () => {
    const isWide = appRoot.classList.toggle("ai-panel-wide")
    widthBtn.textContent = isWide ? "Narrow" : "Wide"
  })

  const sendBtn = aiPanelEl.querySelector(".ai-panel-send")
  const reviewBtn = aiPanelEl.querySelector(".ai-panel-review")
  const input = aiPanelEl.querySelector(".ai-panel-input")
  const defaultMode = isEditing ? "action" : "question"
  sendBtn.addEventListener("click", () => aiSend(defaultMode))
  if (reviewBtn) reviewBtn.addEventListener("click", () => aiSend("review"))
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      aiSend(defaultMode)
    }
  })
  input.focus()
}

function closeAIPanel() {
  aiPanelOpen = false
  aiConversationHistory = []
  if (aiPanelEl) {
    aiPanelEl.remove()
    aiPanelEl = null
  }
  appRoot.classList.remove("ai-panel-visible")
}

function aiAddMessage(role, text) {
  if (!aiPanelEl) return
  const messagesEl = aiPanelEl.querySelector(".ai-panel-messages")
  const msg = document.createElement("div")
  msg.className = `ai-msg ai-msg-${role}`
  msg.textContent = text
  // Newest message goes to the top, directly under the input field.
  messagesEl.prepend(msg)
  aiScrollIfNeeded(messagesEl)
  return msg
}

function aiScrollIfNeeded(messagesEl) {
  // Newest messages are prepended (top), so keep the top in view unless the user
  // has scrolled down to read older history — don't yank them back up.
  if (messagesEl.scrollHeight <= messagesEl.clientHeight) return // no overflow
  if (messagesEl.scrollTop < 100) {
    messagesEl.scrollTop = 0
  }
}

async function aiSend(sendMode = "action") {
  if (!aiPanelEl || aiPanelBusy) return
  const input = aiPanelEl.querySelector(".ai-panel-input")
  const message = input.value.trim()
  if (!message) return

  input.value = ""
  aiPanelBusy = true
  aiSetButtonsDisabled(true)

  // Show user message.
  aiAddMessage("user", message + (sendMode === "review" ? " [review]" : ""))

  // Show AI response placeholder.
  const aiMsg = aiAddMessage("assistant", "")
  aiMsg.textContent = "Thinking..."

  try {
    // Add user message to conversation history.
    aiConversationHistory.push({ role: "user", content: message })

    const { fullText, edits, usage, markers } = await aiStreamRequest(message, sendMode, aiMsg)

    if (sendMode === "question") {
      aiMsg.innerHTML = renderAIMarkdown(fullText)
    } else {
      // Use backend-verified proposals if available, otherwise parse from text.
      const proposals =
        markers && markers.proposals && markers.proposals.length > 0
          ? markers.proposals
          : parseReviewProposals(fullText)

      // Validate proposals against current document content.
      // Strip marker fields — we don't insert markers into the document.
      const markdown = getCurrentMarkdown()
      proposals.forEach((p) => {
        delete p.marker
        p._verified = markdown.includes(p.original)
      })

      if (proposals.length === 0) {
        aiMsg.textContent = "No changes proposed. Raw response:\n\n" + fullText
      } else if (sendMode === "review") {
        aiMsg.textContent = ""
        aiMsg.innerHTML = ""
        renderReviewPanel(aiMsg, proposals)
      } else {
        aiMsg.textContent = ""
        aiMsg.innerHTML = ""
        await autoApplyProposals(aiMsg, proposals)
      }
    }

    // Add assistant response to conversation history (for follow-ups).
    if (fullText) {
      aiConversationHistory.push({ role: "assistant", content: fullText })
    }

    // Show token usage.
    if (usage && (usage.input_tokens || usage.output_tokens)) {
      const usageEl = document.createElement("div")
      usageEl.className = "ai-msg-usage"
      usageEl.textContent = `Tokens: ${usage.input_tokens || 0} in, ${usage.output_tokens || 0} out`
      aiMsg.appendChild(usageEl)
    }
  } catch (err) {
    aiMsg.textContent = `Error: ${err.message}`
    aiMsg.classList.add("ai-msg-error")
  } finally {
    aiPanelBusy = false
    aiSetButtonsDisabled(false)
  }
}

function aiSetButtonsDisabled(disabled) {
  if (!aiPanelEl) return
  for (const btn of aiPanelEl.querySelectorAll(".ai-panel-send, .ai-panel-review")) {
    btn.disabled = disabled
  }
}

async function aiStreamRequest(message, sendMode, aiMsg) {
  const resp = await fetch("/api/ai/assistant/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      page_path: `/${pagePath}`,
      message,
      mode: sendMode,
      history: aiConversationHistory.slice(0, -1), // exclude current message (already in 'message')
    }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "Request failed" }))
    throw new Error(err.error || resp.statusText)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let fullText = ""
  let edits = null
  let usage = null
  let markers = null

  aiMsg.textContent = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split("\n")
    buffer = lines.pop()

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      try {
        const parsed = JSON.parse(line.slice(6))
        if (parsed.type === "token" && parsed.text) {
          fullText += parsed.text
          if (sendMode === "question") {
            aiMsg.innerHTML = renderAIMarkdown(fullText)
          } else {
            // Action/review: don't show raw JSON, show progress instead.
            const count = (fullText.match(/"original"/g) || []).length
            aiMsg.textContent =
              count > 0 ? `Analyzing... ${count} proposal${count > 1 ? "s" : ""} so far` : "Analyzing..."
          }
          const messagesEl = aiPanelEl?.querySelector(".ai-panel-messages")
          if (messagesEl) aiScrollIfNeeded(messagesEl)
        } else if (parsed.type === "edits" && parsed.edits) {
          edits = parsed.edits
        } else if (parsed.type === "markers" && parsed.proposals) {
          markers = parsed
        } else if (parsed.type === "done") {
          usage = parsed
        } else if (parsed.type === "error") {
          throw new Error(parsed.text)
        }
      } catch (e) {
        if (e.message && !e.message.includes("JSON")) throw e
      }
    }
  }

  return { fullText, edits, usage, markers }
}

// Simple markdown→HTML for AI responses (links, bold, italic, code, lists).
function renderAIMarkdown(text) {
  let html = escapeHtml(text)
  // Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="ai-msg-link">$1</a>')
  // Bold: **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  // Italic: *text*
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>")
  // Inline code: `text`
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>")
  // Line breaks
  html = html.replace(/\n/g, "<br>")
  return html
}

// ── Review mode ──

function parseReviewProposals(text) {
  // The AI should return a JSON array. Try to extract it from the response.
  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []
  try {
    const arr = JSON.parse(jsonMatch[0])
    if (!Array.isArray(arr)) return []
    return arr.filter((p) => p.original && p.proposed)
  } catch {
    return []
  }
}

// Character-level inline diff for review display.
function charDiffHtml(oldStr, newStr) {
  // Simple LCS-based char diff.
  const m = oldStr.length,
    n = newStr.length
  // For very long strings, fall back to no highlighting.
  if (m > 2000 || n > 2000) {
    return {
      oldHtml: `<del>${escapeHtml(oldStr)}</del>`,
      newHtml: `<ins>${escapeHtml(newStr)}</ins>`,
    }
  }
  // Build LCS table.
  const prev = new Uint16Array(n + 1)
  const curr = new Uint16Array(n + 1)
  const dp = [prev]
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldStr[i - 1] === newStr[j - 1]) curr[j] = prev[j - 1] + 1
      else curr[j] = prev[j] > curr[j - 1] ? prev[j] : curr[j - 1]
    }
    dp.push(new Uint16Array(curr))
    prev.set(curr)
    curr.fill(0)
  }
  // Backtrack.
  const ops = []
  let i = m,
    j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldStr[i - 1] === newStr[j - 1]) {
      ops.push({ type: "=", ch: oldStr[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "+", ch: newStr[j - 1] })
      j--
    } else {
      ops.push({ type: "-", ch: oldStr[i - 1] })
      i--
    }
  }
  ops.reverse()
  // Build HTML.
  let oldHtml = "",
    newHtml = ""
  for (const op of ops) {
    const esc = escapeHtml(op.ch)
    if (op.type === "=") {
      oldHtml += esc
      newHtml += esc
    } else if (op.type === "-") {
      oldHtml += `<del>${esc}</del>`
    } else {
      newHtml += `<ins>${esc}</ins>`
    }
  }
  return { oldHtml, newHtml }
}

function renderReviewPanel(container, proposals) {
  container.classList.add("ai-review-container")

  // Validate each proposal against the actual document content.
  const markdown = getCurrentMarkdown()
  proposals.forEach((p) => {
    p._verified = markdown.includes(p.original)
  })
  const verified = proposals.filter((p) => p._verified).length

  const header = document.createElement("div")
  header.className = "ai-review-header"
  header.textContent = `${proposals.length} proposal${proposals.length > 1 ? "s" : ""} (${verified} verified)`
  container.appendChild(header)

  const list = document.createElement("div")
  list.className = "ai-review-list"
  container.appendChild(list)

  const states = proposals.map((p) => ({
    status: p._verified ? "pending" : "rejected",
    clarification: "",
  }))

  let activeIndex = -1
  let floatingPanel = null
  let autoAdvance = true

  function removeFloatingPanel() {
    if (floatingPanel) {
      floatingPanel.remove()
      floatingPanel = null
    }
  }

  // Advance to the next proposal after an action.
  function advanceToNext(currentIndex) {
    if (!autoAdvance) return
    // Find next pending proposal.
    for (let j = currentIndex + 1; j < proposals.length; j++) {
      if (states[j].status === "pending") {
        activeIndex = j
        showFloatingProposal(proposals[j], j)
        return
      }
    }
    // No more pending — close panel.
    removeFloatingPanel()
    activeIndex = -1
  }

  // Find the PM position for the start of a proposal's original text.
  function findProposalPos(p) {
    if (!p._verified || editMode !== "visual" || !editorView) return -1
    const docText = editorView.state.doc.textContent
    // Strip markdown syntax from original to match against PM plain text.
    const plain = stripMarkdownForContext(p.original).replace(/\n/g, "")
    // Try full match.
    let idx = docText.indexOf(plain)
    if (idx >= 0) return textOffsetToPmPos(editorView.state.doc, idx)
    // Try with collapsed whitespace.
    const collapsed = plain.replace(/\s+/g, " ").trim()
    if (collapsed.length > 10) {
      const docCollapsed = docText.replace(/\s+/g, " ")
      const cIdx = docCollapsed.indexOf(collapsed)
      if (cIdx >= 0) return textOffsetToPmPos(editorView.state.doc, cIdx)
    }
    // Try prefix (first 30 chars).
    if (plain.length > 30) {
      const prefix = plain.slice(0, 30)
      idx = docText.indexOf(prefix)
      if (idx >= 0) return textOffsetToPmPos(editorView.state.doc, idx)
    }
    // Last resort: structural address from raw markdown.
    const md = getCurrentMarkdown()
    const rawIdx = md.indexOf(p.original)
    if (rawIdx < 0) return -1
    const addr = computeContentAddress(md, rawIdx)
    return resolveContentAddress(editorView.state.doc, addr.nodeIndex, addr.plainOffset)
  }

  // Show a floating panel anchored near the matching text in the editor.
  function showFloatingProposal(p, i) {
    removeFloatingPanel()
    const pmPos = findProposalPos(p)
    if (pmPos < 0) {
      // Can't locate text — mark the item and try the next one.
      const item = list.children[i]
      if (item) item.style.opacity = "0.4"
      if (autoAdvance) advanceToNext(i)
      return
    }

    // Place cursor and scroll to it.
    const clampedPos = Math.min(pmPos, editorView.state.doc.content.size)
    try {
      const $pos = editorView.state.doc.resolve(clampedPos)
      editorView.dispatch(editorView.state.tr.setSelection(TextSelection.near($pos)).scrollIntoView())
    } catch {}

    // Wait for scroll to settle, then position the panel.
    requestAnimationFrame(() => {
      try {
        const coords = editorView.coordsAtPos(clampedPos)
        const scroller = document.querySelector("#app")
        if (scroller) scroller.scrollTop += coords.top - window.innerHeight / 3
      } catch {}

      requestAnimationFrame(() => {
        let anchorTop
        try {
          anchorTop = editorView.coordsAtPos(clampedPos).top
        } catch {
          return
        }

        const diff = charDiffHtml(p.original, p.proposed)
        const warningHtml = p._verified ? "" : `<div class="ai-review-warning">Original text not found</div>`

        floatingPanel = document.createElement("div")
        floatingPanel.className = "ai-review-floating"
        floatingPanel.innerHTML = `
          ${warningHtml}
          <div class="ai-review-diff">
            <div class="ai-review-original">${diff.oldHtml}</div>
            <div class="ai-review-arrow">\u2192</div>
            <div class="ai-review-proposed">${diff.newHtml}</div>
          </div>
          <div class="ai-review-rationale">${escapeHtml(p.rationale || "")}</div>
          <div class="ai-review-actions">
            <button class="ai-review-btn ai-review-accept" ${p._verified ? "" : "disabled"}>Accept</button>
            <button class="ai-review-btn ai-review-reject">Reject</button>
            <button class="ai-review-btn ai-review-clarify">Clarify</button>
          </div>
          <div class="ai-review-clarify-row" style="display:none">
            <input class="ai-review-clarify-input" placeholder="Your clarification..." />
          </div>
          <label class="ai-review-auto-advance" style="display:flex;align-items:center;gap:4px;margin-top:6px;font-size:0.8em;color:#666;cursor:pointer">
            <input type="checkbox" class="ai-review-auto-cb" ${autoAdvance ? "checked" : ""}> Open next automatically
          </label>
        `
        // Position: fixed, right side of editor area, vertically aligned with the text.
        const editorRect = editorView.dom.getBoundingClientRect()
        floatingPanel.style.cssText = `position:fixed;top:${anchorTop}px;right:${window.innerWidth - editorRect.right + 8}px;max-width:350px;z-index:100`
        document.body.appendChild(floatingPanel)

        // Wire action buttons.
        const acceptBtn = floatingPanel.querySelector(".ai-review-accept")
        const rejectBtn = floatingPanel.querySelector(".ai-review-reject")
        const clarifyBtn = floatingPanel.querySelector(".ai-review-clarify")
        const clarifyRow = floatingPanel.querySelector(".ai-review-clarify-row")
        const clarifyInput = floatingPanel.querySelector(".ai-review-clarify-input")

        function updateItemClass() {
          const item = list.children[i]
          if (!item) return
          const s = states[i].status
          item.className =
            "ai-review-item" +
            (s === "accepted"
              ? " ai-review-item-accepted"
              : s === "rejected"
                ? " ai-review-item-rejected"
                : s === "clarify"
                  ? " ai-review-item-clarify"
                  : "")
        }

        if (p._verified) {
          acceptBtn.addEventListener("click", () => {
            states[i].status = "accepted"
            updateItemClass()
            advanceToNext(i)
          })
        }
        rejectBtn.addEventListener("click", () => {
          states[i].status = "rejected"
          updateItemClass()
          advanceToNext(i)
        })
        clarifyBtn.addEventListener("click", () => {
          states[i].status = "clarify"
          updateItemClass()
          clarifyRow.style.display = "flex"
          clarifyInput.focus()
        })
        clarifyInput.addEventListener("input", () => {
          states[i].clarification = clarifyInput.value
        })
        const autoCb = floatingPanel.querySelector(".ai-review-auto-cb")
        if (autoCb)
          autoCb.addEventListener("change", () => {
            autoAdvance = autoCb.checked
          })
      })
    })
  }

  proposals.forEach((p, i) => {
    const item = document.createElement("div")
    item.dataset.index = i
    item.className = "ai-review-item" + (!p._verified ? " ai-review-item-unverified" : "")

    const excerpt = p.original.replace(/\n/g, " ").slice(0, 40) + (p.original.length > 40 ? "\u2026" : "")
    const statusIcon = !p._verified ? " \u26A0" : ""

    item.innerHTML = `<span class="ai-review-num">#${i + 1}${statusIcon}</span> <span class="ai-review-excerpt">${escapeHtml(excerpt)}</span>`
    item.className += " ai-review-item-header"
    item.style.cursor = "pointer"

    item.addEventListener("click", () => {
      // Toggle: clicking the same item closes the panel.
      if (activeIndex === i) {
        removeFloatingPanel()
        activeIndex = -1
        return
      }
      activeIndex = i
      showFloatingProposal(p, i)
    })

    list.appendChild(item)
  })

  // Bottom action bar.
  const actionBar = document.createElement("div")
  actionBar.className = "ai-review-action-bar"

  const applyBtn = document.createElement("button")
  applyBtn.className = "ai-review-apply-btn"
  applyBtn.textContent = "Apply accepted"
  applyBtn.addEventListener("click", () => applyAcceptedProposals(proposals, states))
  actionBar.appendChild(applyBtn)

  const refineBtn = document.createElement("button")
  refineBtn.className = "ai-review-refine-btn"
  refineBtn.textContent = "Refine clarifications"
  refineBtn.addEventListener("click", () => refineClarifications(proposals, states, container))
  actionBar.appendChild(refineBtn)

  container.appendChild(actionBar)
}

function applyMarkedContent(markdown) {
  if (editMode === "visual" && editorView) {
    const newDoc = markdownToPM(markdown, registry)
    const tr = editorView.state.tr
    tr.replaceWith(0, editorView.state.doc.content.size, newDoc.content)
    editorView.dispatch(tr)
  } else if (editMode === "raw" && rawEditor) {
    rawEditor.value = markdown
    rawEditor.dispatchEvent(new Event("input"))
  }
}

async function autoApplyMarkerProposals(container, proposals) {
  let markdown = getCurrentMarkdown()
  let applied = 0
  const failed = []

  for (const p of proposals) {
    if (!p.marker || !p.verified) {
      failed.push(`#${p.number || "?"}: not verified`)
      continue
    }
    const openTag = `{#${p.marker}}`
    const closeTag = `{#/${p.marker}}`
    const openIdx = markdown.indexOf(openTag)
    const closeIdx = markdown.indexOf(closeTag)
    if (openIdx < 0 || closeIdx < 0 || closeIdx <= openIdx) {
      failed.push(`#${p.number || "?"}: markers not found`)
      continue
    }
    // Replace: openTag + content + closeTag → proposed text (no markers)
    markdown = markdown.slice(0, openIdx) + p.proposed + markdown.slice(closeIdx + closeTag.length)
    applied++
  }

  if (applied > 0) {
    applyMarkedContent(markdown)
    for (const p of proposals) {
      if (p.verified && p.proposed && p.proposed.trim()) {
        const selected = p.proposed.length > 200 ? p.proposed.slice(0, 200) : p.proposed
        await createAIComment(selected, "", "", p.rationale || "AI edit")
      }
    }
    saveDraftExplicit()
    let msg = `Applied ${applied} edit${applied > 1 ? "s" : ""}.`
    if (failed.length > 0) msg += ` (${failed.length} skipped)`
    container.textContent = msg
    container.classList.add("ai-msg-applied")
  } else {
    container.textContent = "Could not apply any proposals.\n" + failed.join("\n")
    container.classList.add("ai-msg-error")
  }
}

async function autoApplyProposals(container, proposals) {
  const markdown = getCurrentMarkdown()

  // Verify and position each proposal.
  const positioned = []
  const failed = []
  for (const p of proposals) {
    const idx = markdown.indexOf(p.original)
    if (idx < 0) {
      failed.push(p)
      continue
    }
    const secondIdx = markdown.indexOf(p.original, idx + 1)
    if (secondIdx >= 0) {
      failed.push(p) // ambiguous
      continue
    }
    positioned.push({ ...p, idx })
  }

  if (positioned.length === 0) {
    container.textContent = "Could not verify any proposed edit against the document."
    container.classList.add("ai-msg-error")
    if (failed.length > 0) {
      container.textContent += `\n${failed.length} edit(s) had mismatched original text.`
    }
    return
  }

  // Sort and check overlaps.
  positioned.sort((a, b) => a.idx - b.idx)
  for (let i = 1; i < positioned.length; i++) {
    const prev = positioned[i - 1]
    if (prev.idx + prev.original.length > positioned[i].idx) {
      positioned.splice(i, 1)
      i--
    }
  }

  // Apply in reverse order.
  let result = markdown
  for (let i = positioned.length - 1; i >= 0; i--) {
    const p = positioned[i]
    result = result.slice(0, p.idx) + p.proposed + result.slice(p.idx + p.original.length)
  }

  if (editMode === "visual" && editorView) {
    const newDoc = markdownToPM(result, registry)
    const tr = editorView.state.tr
    tr.replaceWith(0, editorView.state.doc.content.size, newDoc.content)
    editorView.dispatch(tr)
  } else if (editMode === "raw" && rawEditor) {
    rawEditor.value = result
    rawEditor.dispatchEvent(new Event("input"))
  }

  // Create AI comments.
  for (const p of positioned) {
    if (p.proposed && p.proposed.trim()) {
      const selected = p.proposed.length > 200 ? p.proposed.slice(0, 200) : p.proposed
      await createAIComment(selected, "", "", p.rationale || "AI edit")
    }
  }

  saveDraftExplicit()

  let msg = `Applied ${positioned.length} edit${positioned.length > 1 ? "s" : ""}.`
  if (failed.length > 0) msg += ` (${failed.length} could not be verified and were skipped)`
  container.textContent = msg
  container.classList.add("ai-msg-applied")
}

async function applyAcceptedProposals(proposals, states) {
  const accepted = []
  const rejected = []
  for (let i = 0; i < proposals.length; i++) {
    if (states[i].status === "accepted") accepted.push(proposals[i])
    else rejected.push(proposals[i])
  }
  if (accepted.length === 0) {
    aiAddMessage("assistant", "No proposals accepted.").classList.add("ai-msg-error")
    cleanupMarkers(rejected)
    return
  }

  let markdown = getCurrentMarkdown()
  let applied = 0
  const failed = []
  const hasMarkers = accepted.some((p) => p.marker)

  if (hasMarkers) {
    // Marker-based replacement.
    for (const p of accepted) {
      if (!p.marker) {
        failed.push(`#${p.number || "?"}: no marker`)
        continue
      }
      const openTag = `{#${p.marker}}`
      const closeTag = `{#/${p.marker}}`
      const openIdx = markdown.indexOf(openTag)
      const closeIdx = markdown.indexOf(closeTag)
      if (openIdx < 0 || closeIdx < 0 || closeIdx <= openIdx) {
        failed.push(`#${p.number || "?"}: markers not found`)
        continue
      }
      markdown = markdown.slice(0, openIdx) + p.proposed + markdown.slice(closeIdx + closeTag.length)
      applied++
    }
    // Remove markers from rejected proposals.
    for (const p of rejected) {
      if (!p.marker) continue
      markdown = markdown.replace(`{#${p.marker}}`, "").replace(`{#/${p.marker}}`, "")
    }
  } else {
    // Fallback: position-based string matching.
    const positioned = []
    for (const p of accepted) {
      const idx = markdown.indexOf(p.original)
      if (idx < 0) {
        failed.push(`#${p.number || "?"}: not found`)
        continue
      }
      if (markdown.indexOf(p.original, idx + 1) >= 0) {
        failed.push(`#${p.number || "?"}: ambiguous`)
        continue
      }
      positioned.push({ ...p, idx })
    }
    positioned.sort((a, b) => b.idx - a.idx)
    for (const p of positioned) {
      markdown = markdown.slice(0, p.idx) + p.proposed + markdown.slice(p.idx + p.original.length)
      applied++
    }
  }

  if (applied > 0) {
    applyMarkedContent(markdown)
    for (const p of accepted) {
      if (p.proposed && p.proposed.trim()) {
        const selected = p.proposed.length > 200 ? p.proposed.slice(0, 200) : p.proposed
        await createAIComment(selected, "", "", p.rationale || "AI review change")
      }
    }
    saveDraftExplicit()
    let msg = `Applied ${applied} proposal${applied > 1 ? "s" : ""}.`
    if (failed.length > 0) msg += ` Skipped: ${failed.join(", ")}`
    aiAddMessage("assistant", msg).classList.add("ai-msg-applied")
  } else {
    aiAddMessage("assistant", "Could not apply any proposals.\n" + failed.join("\n")).classList.add("ai-msg-error")
  }
}

function cleanupMarkers(proposals) {
  if (!proposals || proposals.length === 0) return
  let markdown = getCurrentMarkdown()
  let changed = false
  for (const p of proposals) {
    if (!p.marker) continue
    const openTag = `{#${p.marker}}`
    const closeTag = `{#/${p.marker}}`
    if (markdown.includes(openTag)) {
      markdown = markdown.replace(openTag, "").replace(closeTag, "")
      changed = true
    }
  }
  if (changed) applyMarkedContent(markdown)
}

async function refineClarifications(proposals, states, container) {
  const clarified = []
  for (let i = 0; i < proposals.length; i++) {
    if (states[i].status === "clarify" && states[i].clarification.trim()) {
      clarified.push({
        ...proposals[i],
        user_clarification: states[i].clarification.trim(),
      })
    }
  }
  if (clarified.length === 0) {
    aiAddMessage("assistant", "No clarifications to refine.").classList.add("ai-msg-error")
    return
  }

  aiPanelBusy = true
  aiSetButtonsDisabled(true)

  const refineMsg = aiAddMessage("assistant", "Refining clarified proposals...")

  try {
    const message =
      "The user has provided clarifications on the following proposals. " +
      "Please revise only these proposals based on the user's feedback. " +
      "Return a JSON array with the same format.\n\n" +
      JSON.stringify(clarified, null, 2)

    const { fullText, usage } = await aiStreamRequest(message, "review", refineMsg)
    const revised = parseReviewProposals(fullText)

    if (revised.length > 0) {
      refineMsg.textContent = ""
      refineMsg.innerHTML = ""
      const newStates = revised.map(() => ({ status: "pending", clarification: "" }))
      renderReviewPanel(refineMsg, revised)
    } else {
      refineMsg.textContent = "No revised proposals returned:\n\n" + fullText
    }

    if (usage && (usage.input_tokens || usage.output_tokens)) {
      const usageEl = document.createElement("div")
      usageEl.className = "ai-msg-usage"
      usageEl.textContent = `Tokens: ${usage.input_tokens || 0} in, ${usage.output_tokens || 0} out`
      refineMsg.appendChild(usageEl)
    }
  } catch (err) {
    refineMsg.textContent = `Error: ${err.message}`
    refineMsg.classList.add("ai-msg-error")
  } finally {
    aiPanelBusy = false
    aiSetButtonsDisabled(false)
  }
}

async function createAICommentsForEdits(edits) {
  for (const edit of edits) {
    // Use the new text as anchor (it's what's in the document now).
    const newText = edit.new_text || ""
    if (!newText.trim()) continue
    // Take first 200 chars as selected text for the anchor.
    const selected = newText.length > 200 ? newText.slice(0, 200) : newText
    const comment = edit.comment || "AI modification"
    await createAIComment(selected, "", "", comment)
  }
}

function buildMenubar() {
  const bar = document.createElement("div")
  bar.className = "gowiki-raw-menubar"
  const refs = {}

  function addButton(label, title, onClick, refName) {
    const btn = document.createElement("span")
    btn.className = "gowiki-raw-menuitem"
    btn.textContent = label
    btn.title = title
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault()
      onClick()
    })
    bar.appendChild(btn)
    if (refName) refs[refName] = btn
    return btn
  }

  function addIconButton(iconData, title, onClick, refName) {
    const btn = document.createElement("span")
    btn.className = "gowiki-raw-menuitem"
    btn.title = title
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("viewBox", `0 0 ${iconData.width} ${iconData.height}`)
    svg.style.width = iconData.width / iconData.height + "em"
    svg.style.height = "1em"
    svg.style.verticalAlign = "middle"
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", iconData.path)
    svg.appendChild(path)
    btn.appendChild(svg)
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault()
      onClick()
    })
    bar.appendChild(btn)
    if (refName) refs[refName] = btn
    return btn
  }

  function addImgButton(src, title, onClick, refName) {
    const btn = document.createElement("span")
    btn.className = "gowiki-raw-menuitem"
    btn.title = title
    const img = document.createElement("img")
    img.src = src
    img.alt = title
    img.width = 14
    img.height = 14
    img.className = "gowiki-menu-icon"
    img.style.verticalAlign = "middle"
    btn.appendChild(img)
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault()
      onClick()
    })
    bar.appendChild(btn)
    if (refName) refs[refName] = btn
    return btn
  }

  function addSeparator() {
    const sep = document.createElement("span")
    sep.className = "gowiki-raw-menusep"
    bar.appendChild(sep)
  }

  // Properties
  addImgButton(
    "/icons/tools.svg",
    "Toggle properties",
    () => {
      if (editMode === "visual" && editorView) {
        if (togglePropertiesCommand) togglePropertiesCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawInsertProperty(rawEditor)
      }
    },
    "properties"
  )

  // Heading dropdown
  const headingWrap = document.createElement("span")
  headingWrap.className = "gowiki-raw-menuitem gowiki-raw-menu-dropdown-wrap"
  headingWrap.title = "Headings"
  headingWrap.textContent = "H#"
  const headingMenu = document.createElement("div")
  headingMenu.className = "gowiki-raw-dropdown-menu"
  const headingItems = []

  // "Paragraph" entry to remove heading
  const paraItem = document.createElement("div")
  paraItem.className = "gowiki-raw-dropdown-item"
  paraItem.textContent = "Paragraph"
  paraItem.style.fontStyle = "italic"
  paraItem.addEventListener("mousedown", (e) => {
    e.preventDefault()
    headingMenu.style.display = "none"
    if (editMode === "visual" && editorView) {
      setBlockType(schema.nodes.paragraph)(editorView.state, editorView.dispatch)
      editorView.focus()
    } else if (editMode === "raw" && rawEditor) {
      const { lineStart, lineEnd } = rawGetCurrentLineRange(rawEditor)
      const line = rawEditor.value.substring(lineStart, lineEnd)
      const stripped = line.replace(/^#{1,6}\s*(?:1\.\s)?/, "")
      rawEditor.focus()
      rawEditor.setSelectionRange(lineStart, lineEnd)
      rawInsertText(rawEditor, stripped)
    }
  })
  headingMenu.appendChild(paraItem)

  for (let level = 1; level <= 5; level++) {
    const item = document.createElement("div")
    item.className = "gowiki-raw-dropdown-item"
    item.textContent = `H${level}`
    item.dataset.level = String(level)
    item.addEventListener("mousedown", (e) => {
      e.preventDefault()
      headingMenu.style.display = "none"
      const numbered = e.shiftKey
      if (editMode === "visual" && editorView) {
        setBlockType(schema.nodes.heading, { level, numbered })(editorView.state, editorView.dispatch)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawSetHeadingLevel(rawEditor, level, numbered)
      }
    })
    headingMenu.appendChild(item)
    headingItems.push(item)
  }
  const headingHint = document.createElement("div")
  headingHint.className = "gowiki-raw-dropdown-item gowiki-raw-dropdown-item--hint"
  headingHint.textContent = "Hold shift for numbered"
  headingMenu.appendChild(headingHint)

  function updateHeadingMenuShift(shift) {
    for (const item of headingItems) {
      const level = item.dataset.level
      item.textContent = shift ? `H${level} numbered` : `H${level}`
    }
  }
  headingMenu.addEventListener("keydown", (e) => {
    if (e.key === "Shift") updateHeadingMenuShift(true)
  })
  headingMenu.addEventListener("keyup", (e) => {
    if (e.key === "Shift") updateHeadingMenuShift(false)
  })
  document.addEventListener("keydown", (e) => {
    if (e.key === "Shift" && headingMenu.style.display === "block") updateHeadingMenuShift(true)
  })
  document.addEventListener("keyup", (e) => {
    if (e.key === "Shift" && headingMenu.style.display === "block") updateHeadingMenuShift(false)
  })

  headingWrap.appendChild(headingMenu)
  headingWrap.addEventListener("mousedown", (e) => {
    e.preventDefault()
    const isOpen = headingMenu.style.display === "block"
    headingMenu.style.display = isOpen ? "none" : "block"
    if (!isOpen) updateHeadingMenuShift(false)
  })
  bar.appendChild(headingWrap)

  document.addEventListener("mousedown", (e) => {
    if (!headingWrap.contains(e.target)) {
      headingMenu.style.display = "none"
    }
  })

  addSeparator()

  // HR
  const hrBtn = addButton("---", "Insert horizontal rule", () => {
    if (editMode === "visual" && editorView) {
      const hr = schema.nodes.horizontal_rule
      if (hr) editorView.dispatch(editorView.state.tr.replaceSelectionWith(hr.create()).scrollIntoView())
      editorView.focus()
    } else if (editMode === "raw" && rawEditor) {
      rawInsertHorizontalRule(rawEditor)
    }
  })
  hrBtn.style.fontWeight = "700"
  hrBtn.style.letterSpacing = "-1px"

  addSeparator()

  // Bold
  addButton(
    "B",
    shortcutHint("Bold", "B"),
    () => {
      if (editMode === "visual" && editorView) {
        toggleMark(schema.marks.strong)(editorView.state, editorView.dispatch)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawWrapSelection(rawEditor, "**", "**")
      }
    },
    "bold"
  ).style.fontWeight = "700"

  // Italic
  addButton(
    "I",
    shortcutHint("Italic", "I"),
    () => {
      if (editMode === "visual" && editorView) {
        toggleMark(schema.marks.em)(editorView.state, editorView.dispatch)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawWrapSelection(rawEditor, "*", "*")
      }
    },
    "italic"
  ).style.fontStyle = "italic"

  // Underline
  const uBtn = addButton(
    "U",
    shortcutHint("Underline", "U"),
    () => {
      if (editMode === "visual" && editorView) {
        toggleMark(schema.marks.underline)(editorView.state, editorView.dispatch)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawWrapSelection(rawEditor, "_", "_")
      }
    },
    "underline"
  )
  uBtn.style.textDecoration = "underline"

  // Strikethrough
  const sBtn = addButton(
    "S",
    shortcutHint("Strikethrough", "Shift-X"),
    () => {
      if (editMode === "visual" && editorView) {
        toggleMark(schema.marks.strikethrough)(editorView.state, editorView.dispatch)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawWrapSelection(rawEditor, "~~", "~~")
      }
    },
    "strikethrough"
  )
  sBtn.style.textDecoration = "line-through"

  // Subscript
  addButton(
    "x\u2082",
    "Subscript",
    () => {
      if (editMode === "visual" && editorView) {
        toggleMark(schema.marks.subscript)(editorView.state, editorView.dispatch)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawWrapSelection(rawEditor, "~", "~")
      }
    },
    "subscript"
  )

  // Superscript
  addButton(
    "x\u00B2",
    "Superscript",
    () => {
      if (editMode === "visual" && editorView) {
        toggleMark(schema.marks.superscript)(editorView.state, editorView.dispatch)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawWrapSelection(rawEditor, "^", "^")
      }
    },
    "superscript"
  )

  // Highlight with color dropdown
  if (schema.marks.highlight) {
    const hlWrap = document.createElement("span")
    hlWrap.style.position = "relative"
    hlWrap.style.display = "inline-block"

    const hlBtn = document.createElement("span")
    hlBtn.className = "gowiki-raw-menuitem"
    hlBtn.textContent = "\u{1F58D}"
    hlBtn.title = "Highlight"
    hlBtn.style.background = "linear-gradient(to top, yellow 40%, transparent 40%)"
    hlBtn.style.borderRadius = "3px 0 0 3px"
    hlBtn.style.paddingRight = "2px"
    hlBtn.addEventListener("mousedown", (e) => {
      e.preventDefault()
      if (editMode === "visual" && editorView) {
        const state = editorView.state
        const markType = schema.marks.highlight
        const sel = state.selection
        // When the caret is inside a highlighted run with no range selected,
        // toggleMark only toggles PM's stored marks — nothing changes on
        // screen. Users expect "click to un-highlight" to remove the whole
        // run, so expand the caret to the mark's contiguous range first.
        if (sel.empty && markType.isInSet(sel.$from.marks())) {
          const range = findMarkRangeAround(sel.$from, markType)
          if (range) {
            editorView.dispatch(state.tr.removeMark(range.from, range.to, markType))
            editorView.focus()
            return
          }
        }
        toggleMark(markType)(state, editorView.dispatch)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        // Unwrap when the selection is already ==-wrapped; otherwise wrap.
        // Recognises both plain and coloured forms: ==text== and =={color=…}text==.
        const s = rawEditor.selectionStart
        const e2 = rawEditor.selectionEnd
        if (s !== e2) {
          const sel = rawEditor.value.substring(s, e2)
          const m = sel.match(/^==(?:\{[^}]*\})?([\s\S]*)==$/)
          if (m) {
            rawEditor.focus()
            rawEditor.setSelectionRange(s, e2)
            rawInsertText(rawEditor, m[1])
            rawEditor.setSelectionRange(s, s + m[1].length)
            return
          }
        }
        rawWrapSelection(rawEditor, "==", "==")
      }
    })

    const hlArrow = document.createElement("span")
    hlArrow.className = "gowiki-raw-menuitem"
    hlArrow.textContent = "\u25BE"
    hlArrow.title = "Highlight color"
    hlArrow.style.fontSize = "10px"
    hlArrow.style.padding = "2px 3px"
    hlArrow.style.borderRadius = "0 3px 3px 0"
    hlArrow.style.marginLeft = "-1px"

    let hlDropdown = null
    function closeHlDropdown() {
      if (hlDropdown) {
        hlDropdown.remove()
        hlDropdown = null
      }
      document.removeEventListener("mousedown", hlOutsideClick)
    }
    function hlOutsideClick(e) {
      if (hlDropdown && !hlDropdown.contains(e.target) && e.target !== hlArrow) closeHlDropdown()
    }
    hlArrow.addEventListener("mousedown", (e) => {
      e.preventDefault()
      if (hlDropdown) {
        closeHlDropdown()
        return
      }
      hlDropdown = document.createElement("div")
      hlDropdown.style.cssText =
        "position:absolute;top:100%;left:0;z-index:999;background:#fff;border:1px solid #ccc;border-radius:4px;padding:4px;display:flex;gap:3px;box-shadow:0 2px 8px rgba(0,0,0,.15)"
      for (const c of HIGHLIGHT_COLORS) {
        const swatch = document.createElement("span")
        swatch.title = c.name
        swatch.style.cssText = `display:inline-block;width:20px;height:20px;border-radius:3px;cursor:pointer;border:1px solid #ccc;background:${c.value}`
        swatch.addEventListener("mousedown", (ev) => {
          ev.preventDefault()
          closeHlDropdown()
          if (editMode === "visual" && editorView) {
            const { from, to } = editorView.state.selection
            if (from === to) return
            const markType = schema.marks.highlight
            editorView.dispatch(editorView.state.tr.addMark(from, to, markType.create({ color: c.value })))
            editorView.focus()
          } else if (editMode === "raw" && rawEditor) {
            // Strip existing ==...== highlight wrapper if present, then re-wrap.
            const sel = rawEditor.value.substring(rawEditor.selectionStart, rawEditor.selectionEnd)
            const hlMatch = sel.match(/^==(?:\{[^}]*\})?([\s\S]*)==$/)
            if (hlMatch) {
              // Selection includes delimiters — strip and re-wrap.
              const inner = hlMatch[1]
              const s = rawEditor.selectionStart
              rawEditor.focus()
              if (c.value === "yellow") {
                rawInsertText(rawEditor, "==" + inner + "==")
              } else {
                rawInsertText(rawEditor, `=={color=${c.value}}` + inner + "==")
              }
            } else {
              if (c.value === "yellow") {
                rawWrapSelection(rawEditor, "==", "==")
              } else {
                rawWrapSelection(rawEditor, `=={color=${c.value}}`, "==")
              }
            }
          }
        })
        hlDropdown.appendChild(swatch)
      }
      hlWrap.appendChild(hlDropdown)
      document.addEventListener("mousedown", hlOutsideClick)
    })

    hlWrap.appendChild(hlBtn)
    hlWrap.appendChild(hlArrow)
    bar.appendChild(hlWrap)
    refs["highlight"] = hlBtn
  }

  // Footnote
  if (footnoteInsertCommand) {
    const fnBtn = addButton("", shortcutHint("Insert footnote", "Shift-N"), () => {
      if (editMode === "visual" && editorView) {
        footnoteInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawWrapSelection(rawEditor, "^[", "]")
      }
    })
    const fnImg = document.createElement("img")
    fnImg.src = "/icons/footnote.svg"
    fnImg.style.height = "1.2em"
    fnImg.style.verticalAlign = "middle"
    fnBtn.appendChild(fnImg)
  }

  // Inline code
  addButton(
    "</>",
    shortcutHint("Inline code", "E"),
    () => {
      if (editMode === "visual" && editorView) {
        toggleMark(schema.marks.code)(editorView.state, editorView.dispatch)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawWrapSelection(rawEditor, "`", "`")
      }
    },
    "code"
  )

  // Symbol picker toolbar button
  {
    const symWrap = document.createElement("span")
    symWrap.className = "gowiki-raw-menuitem gowiki-raw-menu-dropdown-wrap"
    {
      const mod = isMac ? "\u2318" : "Ctrl+"
      symWrap.title = `Insert symbol (${mod}:)`
    }
    symWrap.textContent = "\u03A9"
    symbolToolbarAnchor = symWrap
    symWrap.addEventListener("mousedown", (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (symbolPanelEl && symbolPanelAnchor === "toolbar") {
        closeSymbolPanel()
      } else {
        openSymbolPanel("toolbar")
      }
    })
    bar.appendChild(symWrap)
  }

  addSeparator()

  // Link
  addIconButton(icons.link, shortcutHint("Set or edit link", "K"), () => {
    if (editMode === "visual" && editorView) {
      setExternalLinkCommand()(editorView.state, editorView.dispatch, editorView)
    } else if (editMode === "raw" && rawEditor) {
      void rawInsertLink(rawEditor)
    }
  })

  addSeparator()

  // Undo
  addIconButton(icons.undo, "Undo", () => {
    if (editMode === "visual" && editorView) {
      undo(editorView.state, editorView.dispatch)
      editorView.focus()
    } else if (editMode === "raw" && rawEditor) {
      rawEditor.focus()
      document.execCommand("undo")
    }
  })

  // Redo
  addIconButton(icons.redo, "Redo", () => {
    if (editMode === "visual" && editorView) {
      redo(editorView.state, editorView.dispatch)
      editorView.focus()
    } else if (editMode === "raw" && rawEditor) {
      rawEditor.focus()
      document.execCommand("redo")
    }
  })

  addSeparator()

  // Table dropdown
  const tableWrap = document.createElement("span")
  tableWrap.className = "gowiki-raw-menuitem gowiki-raw-menu-dropdown-wrap"
  tableWrap.title = "Table"
  const tableIcon = document.createElement("img")
  tableIcon.src = "/icons/table.svg"
  tableIcon.alt = "Table"
  tableIcon.width = 14
  tableIcon.height = 14
  tableIcon.className = "gowiki-menu-icon"
  tableIcon.style.verticalAlign = "middle"
  tableWrap.appendChild(tableIcon)
  const tableDropMenu = document.createElement("div")
  tableDropMenu.className = "gowiki-raw-dropdown-menu"
  tableDropMenu.dataset.menuId = "table"
  const tableActions = [
    { name: "insert", label: "Insert table" },
    { name: "row.addBefore", label: "Add row above" },
    { name: "row.addAfter", label: "Add row below" },
    { name: "column.addBefore", label: "Add column left" },
    { name: "column.addAfter", label: "Add column right" },
    { name: "row.delete", label: "Delete row" },
    { name: "column.delete", label: "Delete column" },
    { name: "cell.properties", label: "Cell properties" },
    { name: "cell.merge", label: "Merge cells" },
    { name: "cell.split", label: "Unmerge cell" },
  ]
  const rawTableFns = {
    insert: rawInsertTable,
    "row.addBefore": rawTableAddRowAbove,
    "row.addAfter": rawTableAddRowBelow,
    "column.addBefore": rawTableAddColumnLeft,
    "column.addAfter": rawTableAddColumnRight,
    "row.delete": rawTableDeleteRow,
    "column.delete": rawTableDeleteColumn,
  }
  const visualOnlyActions = new Set(["cell.merge", "cell.split"])
  for (const action of tableActions) {
    const item = document.createElement("div")
    item.className = "gowiki-raw-dropdown-item"
    item.textContent = action.label
    if (visualOnlyActions.has(action.name)) item.dataset.visualOnly = "1"
    item.addEventListener("mousedown", (e) => {
      e.preventDefault()
      if (item.classList.contains("gowiki-raw-dropdown-item--disabled")) return
      tableDropMenu.style.display = "none"
      if (editMode === "visual" && editorView) {
        const cmd = tableCommands.get(action.name)
        if (cmd) cmd(editorView.state, editorView.dispatch)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const fn = rawTableFns[action.name]
        if (fn) fn(rawEditor)
      }
    })
    tableDropMenu.appendChild(item)
  }
  tableWrap.appendChild(tableDropMenu)
  tableWrap.addEventListener("mousedown", (e) => {
    e.preventDefault()
    const isOpen = tableDropMenu.style.display === "block"
    if (!isOpen) {
      for (const el of tableDropMenu.querySelectorAll("[data-visual-only]")) {
        el.classList.toggle("gowiki-raw-dropdown-item--disabled", editMode !== "visual")
      }
    }
    tableDropMenu.style.display = isOpen ? "none" : "block"
  })
  bar.appendChild(tableWrap)
  document.addEventListener("mousedown", (e) => {
    if (!tableWrap.contains(e.target)) {
      tableDropMenu.style.display = "none"
    }
  })

  // Unordered list
  addIconButton(icons.bulletList, "Unordered list", () => {
    if (editMode === "visual" && editorView) {
      wrapInList(schema.nodes.bullet_list)(editorView.state, editorView.dispatch)
      editorView.focus()
    } else if (editMode === "raw" && rawEditor) {
      rawToggleLinePrefix(rawEditor, "- ")
    }
  })

  // Ordered list
  addIconButton(icons.orderedList, "Ordered list", () => {
    if (editMode === "visual" && editorView) {
      wrapInList(schema.nodes.ordered_list)(editorView.state, editorView.dispatch)
      editorView.focus()
    } else if (editMode === "raw" && rawEditor) {
      rawToggleLinePrefix(rawEditor, "1. ")
      rawRenumberOrderedLists(rawEditor)
    }
  })

  // Code block
  addImgButton("/icons/codeblock.svg", "Code block", () => {
    if (editMode === "visual" && editorView) {
      const codeBlockType = schema.nodes.code_block
      if (codeBlockType) {
        const { state } = editorView
        const { from, to } = state.selection
        const text = from < to ? state.doc.textBetween(from, to, "\n") : ""
        const node = codeBlockType.create(null, text ? schema.text(text) : null)
        // Use delete + insert: replaceSelectionWith/replaceRangeWith
        // lose text content when selection spans block boundaries
        const tr = state.tr
        tr.deleteSelection()
        const pos = tr.selection.from
        tr.replaceWith(pos, pos, node)
        editorView.dispatch(tr.scrollIntoView())
      }
      editorView.focus()
    } else if (editMode === "raw" && rawEditor) {
      rawInsertCodeBlock(rawEditor)
    }
  })

  // Spoiler
  if (spoilerInsertCommand) {
    addImgButton("/icons/spoiler.svg", "Spoiler", () => {
      if (editMode === "visual" && editorView) {
        spoilerInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawInsertSpoiler(rawEditor)
      }
    })
  }

  // Chart
  if (chartInsertCommand) {
    addImgButton("/icons/chart.svg", "Chart", () => {
      if (editMode === "visual" && editorView) {
        chartInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawInsertChart(rawEditor)
      }
    })
  }

  // Mermaid diagram
  if (mermaidInsertCommand) {
    addImgButton("/icons/mermaid.svg", "Mermaid diagram", () => {
      if (editMode === "visual" && editorView) {
        mermaidInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet =
          "```mermaid\ngraph TD\n    A[Start] --> B{Decision}\n    B -->|Yes| C[Result 1]\n    B -->|No| D[Result 2]\n```"
        rawInsertText(rawEditor, snippet)
      }
    })
  }

  // Slides
  if (slidesInsertCommand) {
    addImgButton("/icons/slides.svg", "Slides", () => {
      if (editMode === "visual" && editorView) {
        slidesInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawInsertSlides(rawEditor)
      }
    })
  }

  // Include
  if (includeInsertCommand) {
    const includeBtn = addImgButton("/icons/include.svg", "Include", () => {
      if (editMode === "visual" && editorView) {
        includeInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawInsertInclude(rawEditor)
      }
    })
    includeBtn.querySelector(".gowiki-menu-icon").classList.add("gowiki-menu-icon--lg")
  }

  // Database Query
  if (databaseInsertQueryCommand) {
    const btn = addImgButton("/icons/database-query.svg", "Database Query", () => {
      if (editMode === "visual" && editorView) {
        databaseInsertQueryCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{database-query table=}"
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, snippet + "\n\n")
        const cursorPos = start + snippet.length - 1
        rawEditor.setSelectionRange(cursorPos, cursorPos)
      }
    })
    btn.querySelector(".gowiki-menu-icon").classList.add("gowiki-menu-icon--lg")
  }

  // Database New Row
  if (databaseInsertNewRowCommand) {
    const btn = addImgButton("/icons/database-newrow.svg", "Database New Row", () => {
      if (editMode === "visual" && editorView) {
        databaseInsertNewRowCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{database-newrow table=}"
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, snippet + "\n\n")
        const cursorPos = start + snippet.length - 1
        rawEditor.setSelectionRange(cursorPos, cursorPos)
      }
    })
    btn.querySelector(".gowiki-menu-icon").classList.add("gowiki-menu-icon--lg")
  }

  // Database Row
  if (databaseInsertRowCommand) {
    const btn = addImgButton("/icons/database-row.svg", "Database Row", () => {
      if (editMode === "visual" && editorView) {
        databaseInsertRowCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{database-row table=}"
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, snippet + "\n\n")
        const cursorPos = start + snippet.length - 1
        rawEditor.setSelectionRange(cursorPos, cursorPos)
      }
    })
    btn.querySelector(".gowiki-menu-icon").classList.add("gowiki-menu-icon--lg")
  }

  // Template Variable
  if (databaseInsertVarCommand) {
    addImgButton("/icons/variable.svg", "Template Variable", () => {
      if (editMode === "visual" && editorView) {
        databaseInsertVarCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{{NAME}}"
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, snippet)
        rawEditor.setSelectionRange(start + 2, start + 6)
      }
    })
  }

  // Blockquote
  addIconButton(icons.blockquote, "Quote block", () => {
    if (editMode === "visual" && editorView) {
      wrapIn(schema.nodes.blockquote)(editorView.state, editorView.dispatch)
      editorView.focus()
    } else if (editMode === "raw" && rawEditor) {
      rawToggleLinePrefix(rawEditor, "> ")
    }
  })

  // Tag
  if (tagInsertCommand) {
    addButton("#", "Insert tag", () => {
      if (editMode === "visual" && editorView) {
        tagInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{tag }"
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, snippet + "\n\n")
        const cursorPos = start + snippet.length - 1
        rawEditor.setSelectionRange(cursorPos, cursorPos)
      }
    })
  }

  // Tag query
  if (tagQueryInsertCommand) {
    addButton("Q#", "Insert tag query", () => {
      if (editMode === "visual" && editorView) {
        tagQueryInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{tag-query tag=}"
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, snippet + "\n\n")
        const cursorPos = start + snippet.length - 1
        rawEditor.setSelectionRange(cursorPos, cursorPos)
      }
    })
  }

  // Caption reference
  if (captionInsertRefCommand) {
    addButton("Ref", "Insert caption reference", () => {
      if (editMode === "visual" && editorView) {
        captionInsertRefCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{ref }"
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, snippet)
        const cursorPos = start + 5
        rawEditor.setSelectionRange(cursorPos, cursorPos)
      }
    })
  }

  // Paragraph below
  addImgButton("/icons/paragraphdown.svg", "Add paragraph below", () => {
    if (editMode === "visual" && editorView) {
      const paragraphType = schema.nodes.paragraph
      if (paragraphType) {
        const state = editorView.state
        const $from = state.selection.$from
        // Find the top-level block containing the cursor.
        const depth = $from.depth > 0 ? 1 : 0
        try {
          const afterBlock = $from.after(depth)
          const tr = state.tr.insert(afterBlock, paragraphType.create())
          tr.setSelection(TextSelection.near(tr.doc.resolve(afterBlock + 1)))
          editorView.dispatch(tr.scrollIntoView())
        } catch {
          // At end of document — append a paragraph.
          const tr = state.tr.insert(state.doc.content.size, paragraphType.create())
          tr.setSelection(TextSelection.near(tr.doc.resolve(tr.doc.content.size - 1)))
          editorView.dispatch(tr.scrollIntoView())
        }
      }
      editorView.focus()
    } else if (editMode === "raw" && rawEditor) {
      rawEditor.focus()
      // Insert a blank line after the current line.
      const val = rawEditor.value
      const pos = rawEditor.selectionStart
      const lineEnd = val.indexOf("\n", pos)
      const insertAt = lineEnd === -1 ? val.length : lineEnd
      rawEditor.setSelectionRange(insertAt, insertAt)
      rawInsertText(rawEditor, "\n\n")
    }
  })

  // Todo
  if (todoInsertCommand) {
    addImgButton("/icons/todo.svg", "Insert todo", () => {
      if (editMode === "visual" && editorView) {
        todoInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{todo title=}"
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, snippet + "\n\n")
        const cursorPos = start + snippet.length - 1
        rawEditor.setSelectionRange(cursorPos, cursorPos)
      }
    })
  }

  // Todo List
  if (todoListInsertCommand) {
    addImgButton("/icons/todo.svg", "Insert todo list", () => {
      if (editMode === "visual" && editorView) {
        todoListInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawEditor.focus()
        rawInsertText(rawEditor, "{todo-list}\n\n")
      }
    })
  }

  // Todo Calendar
  if (todoCalendarInsertCommand) {
    addImgButton("/icons/calendar.svg", "Insert todo calendar", () => {
      if (editMode === "visual" && editorView) {
        todoCalendarInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawEditor.focus()
        rawInsertText(rawEditor, "{todo-calendar}\n\n")
      }
    })
  }

  // Publication (bibliography citation)
  if (publicationInsertCommand) {
    addImgButton("/icons/publication.svg", "Insert citation (PubMed / DOI)", () => {
      if (editMode === "visual" && editorView) {
        publicationInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{publication pmid=}"
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, snippet)
        const cursorPos = start + snippet.length - 1
        rawEditor.setSelectionRange(cursorPos, cursorPos)
      }
    })
  }

  // References list
  if (referencesInsertCommand) {
    addImgButton("/icons/references.svg", "Insert references list", () => {
      if (editMode === "visual" && editorView) {
        referencesInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        rawEditor.focus()
        rawInsertText(rawEditor, "{references}\n\n")
      }
    })
  }

  // Reviewflow
  if (reviewflowInsertCommand) {
    addImgButton("/icons/reviewflow.svg", "Insert reviewflow", () => {
      if (editMode === "visual" && editorView) {
        reviewflowInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{reviewflow version=}"
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, snippet + "\n\n")
        const cursorPos = start + snippet.length - 1
        rawEditor.setSelectionRange(cursorPos, cursorPos)
      }
    })
  }

  // Reviewflow Link
  if (reviewflowLinkInsertCommand) {
    addImgButton("/icons/reviewflow-link.svg", "Insert reviewflow link", () => {
      if (editMode === "visual" && editorView) {
        reviewflowLinkInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{reviewflow-link version=}"
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, snippet + "\n\n")
        const cursorPos = start + snippet.length - 1
        rawEditor.setSelectionRange(cursorPos, cursorPos)
      }
    })
  }

  // Reviewflow Query
  if (reviewflowQueryInsertCommand) {
    addImgButton("/icons/reviewflow-query.svg", "Insert reviewflow query", () => {
      if (editMode === "visual" && editorView) {
        reviewflowQueryInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{reviewflow-query}"
        rawEditor.focus()
        rawInsertText(rawEditor, snippet + "\n\n")
      }
    })
  }

  // Version Link
  if (versionLinkInsertCommand) {
    addImgButton("/icons/version-link.svg", "Insert version link", () => {
      if (editMode === "visual" && editorView) {
        versionLinkInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{version-link version=}"
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, snippet + "\n\n")
        const cursorPos = start + snippet.length - 1
        rawEditor.setSelectionRange(cursorPos, cursorPos)
      }
    })
  }

  // Changes
  if (changesInsertCommand) {
    addImgButton("/icons/changes.svg", "Insert latest changes", () => {
      if (editMode === "visual" && editorView) {
        changesInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{changes count=10}"
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, snippet + "\n\n")
        rawEditor.setSelectionRange(start + snippet.length, start + snippet.length)
      }
    })
  }

  // Lifecycle — an admin-document directive that aggregates retention /
  // review / archival rules into a single panel. Lives next to the
  // regulatory family (reviewflow / version-link) in the toolbar.
  if (lifecycleInsertCommand) {
    addImgButton("/icons/lifecycle.svg", "Insert lifecycle", () => {
      if (editMode === "visual" && editorView) {
        lifecycleInsertCommand(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const snippet = "{lifecycle}"
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, snippet + "\n\n")
        rawEditor.setSelectionRange(start + snippet.length, start + snippet.length)
      }
    })
  }

  // Template family — cluster the four directives behind stroke icons
  // sharing a common page-with-folded-corner base so they read as one
  // group at a glance instead of four indistinguishable text buttons.
  const templateGroup = [
    {
      cmd: templateInsertCommand,
      icon: "template.svg",
      title: "Template marker (payload separator)",
      snippet: "{template}",
    },
    {
      cmd: templateTitleInsertCommand,
      icon: "template-title.svg",
      title: "Template title (prefix a heading)",
      snippet: "{template-title}",
    },
    {
      cmd: templateStampInsertCommand,
      icon: "template-stamp.svg",
      title: "Template stamp (frozen origin sentence at creation)",
      snippet: "{template-stamp}",
    },
    {
      cmd: templateReviewflowInsertCommand,
      icon: "template-reviewflow.svg",
      title: "Template reviewflow (resolved to {reviewflow} at creation)",
      snippet: "{template-reviewflow}",
    },
    {
      cmd: templateTodoInsertCommand,
      icon: "template-todo.svg",
      title: "Template todo (resolved to {todo} at creation)",
      snippet: "{template-todo}",
    },
  ]
  let templateGroupHasAny = false
  for (const entry of templateGroup) {
    if (!entry.cmd) continue
    if (!templateGroupHasAny) {
      addSeparator()
      templateGroupHasAny = true
    }
    addImgButton("/icons/" + entry.icon, entry.title, () => {
      if (editMode === "visual" && editorView) {
        entry.cmd(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      } else if (editMode === "raw" && rawEditor) {
        const start = rawEditor.selectionStart
        rawEditor.focus()
        rawInsertText(rawEditor, entry.snippet + "\n\n")
        rawEditor.setSelectionRange(start + entry.snippet.length, start + entry.snippet.length)
      }
    })
  }

  // Extra commands from plugins
  for (const { label, cmd } of extraCommands) {
    addButton(label, label, () => {
      if (editMode === "visual" && editorView) {
        cmd(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      }
    })
  }

  // AI Assistant button
  if (aiAssistantEnabled) {
    addSeparator()
    addButton("AI", "AI Assistant (Ctrl+L)", () => toggleAIPanel(), "aiBtn")
  }

  return { dom: bar, refs }
}

function renderEdit(nextEditMode) {
  clearContent()

  const wrapper = document.createElement("div")
  wrapper.className = "gowiki-raw-wrapper"

  const { dom: menubarDom, refs: menubarRefs } = buildMenubar()
  wrapper.appendChild(menubarDom)

  if (nextEditMode === "raw") {
    const holder = document.createElement("div")
    holder.className = "gowiki-raw-editor-holder"
    const overlay = document.createElement("div")
    overlay.className = "gowiki-raw-editor-overlay"
    overlay.setAttribute("aria-hidden", "true")
    holder.appendChild(overlay)
    const editorEl = document.createElement("textarea")
    editorEl.id = "gowiki-raw-editor"
    editorEl.className = "gowiki-raw-editor"
    editorEl.value = currentMarkdown
    updateRawOverlay(overlay, editorEl.value)

    editorEl.addEventListener("keydown", (e) => {
      const isMod = e.metaKey || e.ctrlKey
      // Save/publish shortcuts
      if ((e.key === "s" || e.key === "S") && isMod) {
        e.preventDefault()
        e.stopPropagation()
        if (e.shiftKey) {
          void publishDraft()
        } else {
          void saveDraftExplicit()
        }
        return
      }
      if (e.key === "Enter" && !e.shiftKey && !isMod) {
        if (rawHandleEnterInList(editorEl) || rawHandleEnterInBlockquote(editorEl)) {
          e.preventDefault()
          autoResizeRawEditor(editorEl)
        }
      } else if (e.key === "h" && isMod && !e.altKey) {
        e.preventDefault()
        const { lineStart, lineEnd } = rawGetCurrentLineRange(editorEl)
        const line = editorEl.value.substring(lineStart, lineEnd)
        const headMatch = line.match(/^(#{1,6})\s/)
        if (e.shiftKey) {
          // Shift+Cmd+H: toggle numbered
          if (headMatch) {
            const level = headMatch[1].length
            const isNumbered = /^#{1,6}\s+1\.\s/.test(line)
            rawSetHeadingLevel(editorEl, level, !isNumbered)
          } else {
            rawSetHeadingLevel(editorEl, 2, true)
          }
        } else {
          // Cmd+H: toggle heading
          if (headMatch) {
            // Remove heading entirely
            const stripped = line.replace(/^#{1,6}\s*(?:1\.\s)?/, "")
            editorEl.focus()
            editorEl.setSelectionRange(lineStart, lineEnd)
            rawInsertText(editorEl, stripped)
          } else {
            rawSetHeadingLevel(editorEl, 2, false)
          }
        }
        autoResizeRawEditor(editorEl)
      } else if (e.key === ";" && e.shiftKey && isMod) {
        e.preventDefault()
        openSymbolPanel("cursor")
      } else if (e.key === ":" && isMod) {
        e.preventDefault()
        openSymbolPanel("cursor")
      } else if (e.key === "Tab" && !e.ctrlKey && !e.metaKey) {
        // Tab on heading lines adjusts level
        const { lineStart, lineEnd } = rawGetCurrentLineRange(editorEl)
        const line = editorEl.value.substring(lineStart, lineEnd)
        const headMatch = line.match(/^(#{1,6})\s/)
        if (headMatch) {
          const level = headMatch[1].length
          const newLevel = e.shiftKey ? Math.max(level - 1, 1) : Math.min(level + 1, 6)
          if (newLevel !== level) {
            const isNumbered = /^#{1,6}\s+1\.\s/.test(line)
            rawSetHeadingLevel(editorEl, newLevel, isNumbered)
          }
          e.preventDefault()
          autoResizeRawEditor(editorEl)
        } else if (rawHandleTabInTable(editorEl, e.shiftKey ? -1 : 1)) {
          e.preventDefault()
          autoResizeRawEditor(editorEl)
        } else if (rawHandleTabInList(editorEl, e.shiftKey ? "out" : "in")) {
          e.preventDefault()
          autoResizeRawEditor(editorEl)
        }
      }
    })

    editorEl.addEventListener("input", () => {
      autoResizeRawEditor(editorEl)
      updateRawOverlay(overlay, editorEl.value)
    })

    editorEl.addEventListener("paste", (e) => {
      const imageFiles = extractImageFiles(e.clipboardData)
      if (imageFiles.length === 0) return
      e.preventDefault()
      void (async () => {
        for (const file of imageFiles) {
          try {
            const entry = await uploadMediaFile(file)
            const target = appendMediaVersion(buildMediaReferencePath(pageNamespace, entry.path), entry.version)
            const label = mediaLabelFromPath(entry.path)
            const snippet = `![${label}](${target})`
            editorEl.focus()
            const start = editorEl.selectionStart
            const end = editorEl.selectionEnd
            editorEl.setSelectionRange(start, end)
            rawInsertText(editorEl, snippet)
            setStatus("Pasted image " + target)
          } catch (err) {
            console.error("Image paste upload failed", err)
            setStatus("Image paste failed: " + err.message)
          }
        }
        autoResizeRawEditor(editorEl)
      })()
    })

    editorEl.addEventListener("blur", () => {
      if (mode !== "edit" || editMode !== "raw") return
      try {
        const normalized = normalizeMarkdownForStorage(editorEl.value)
        applyNormalizedEditState(normalized)
      } catch {
        // Keep invalid in-progress raw text unchanged.
      }
      validateDatabaseRows(editorEl.value).then((result) => {
        if (!result.valid) setStatus(result.errors.join("; "))
      })
    })

    // Notify collab session on raw edits + track cursor for presence.
    let rawCollabTimer = null
    editorEl.addEventListener("input", () => {
      if (!collabSession) return
      clearTimeout(rawCollabTimer)
      rawCollabTimer = setTimeout(() => {
        if (collabSession) collabSession.localChange(editorEl.value)
      }, 150)
      updateEditOffset()
    })
    editorEl.addEventListener("click", () => updateEditOffset())
    editorEl.addEventListener("keyup", (e) => {
      if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") updateEditOffset()
    })

    holder.appendChild(editorEl)
    wrapper.appendChild(holder)
    contentRoot.appendChild(wrapper)
    autoResizeRawEditor(editorEl)
    rawEditor = editorEl
    return
  }

  // Visual mode
  const editorEl = document.createElement("div")
  wrapper.appendChild(editorEl)
  contentRoot.appendChild(wrapper)

  const menubarStatePlugin = new Plugin({
    view() {
      return {
        update(view) {
          updateMenubarState(view.state, menubarRefs)
        },
      }
    },
  })

  const listKeymap = keymap({
    Enter: splitListItem(schema.nodes.list_item),
    Backspace: backspaceEmptyListItemCommand(),
    Tab: tabKeyCommand("in"),
    "Shift-Tab": tabKeyCommand("out"),
    "Alt-Enter": insertHardBreakCommand(),
  })

  const shortcutKeymap = keymap({
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
    "Mod-b": toggleMark(schema.marks.strong),
    "Mod-i": toggleMark(schema.marks.em),
    "Mod-u": toggleMark(schema.marks.underline),
    "Mod-Shift-x": toggleMark(schema.marks.strikethrough),
    "Mod-e": toggleMark(schema.marks.code),
    "Mod-k": (state, dispatch, view) => {
      setExternalLinkCommand()(state, dispatch, view)
      return true
    },
    "Mod-h": (state, dispatch) => {
      const node = state.selection.$from.parent
      if (node.type === schema.nodes.heading) {
        return setBlockType(schema.nodes.paragraph)(state, dispatch)
      }
      return setBlockType(schema.nodes.heading, { level: 2 })(state, dispatch)
    },
    "Mod-Shift-h": (state, dispatch) => {
      const node = state.selection.$from.parent
      if (node.type === schema.nodes.heading) {
        return setBlockType(schema.nodes.heading, {
          level: node.attrs.level,
          numbered: !node.attrs.numbered,
        })(state, dispatch)
      }
      return setBlockType(schema.nodes.heading, { level: 2, numbered: true })(state, dispatch)
    },
    "Mod-s": () => {
      void saveDraftExplicit()
      return true
    },
    "Mod-Shift-s": () => {
      void publishDraft()
      return true
    },
    "Mod-Shift-n": (state, dispatch) => {
      if (footnoteInsertCommand) {
        footnoteInsertCommand(state, dispatch)
      }
      return true
    },
    "Mod-Shift-;": () => {
      openSymbolPanel("cursor")
      return true
    },
  })

  // Plugin that notifies the collab session when the document changes,
  // and tracks which block the cursor is in for presence indicators.
  const collabNotifyPlugin = new Plugin({
    view() {
      return {
        update(view, prevState) {
          // Track block position on every selection change.
          if (!prevState || !view.state.selection.eq(prevState.selection)) {
            updateEditOffset()
          }
          // Track doc changes for collab sync.
          if (prevState && !view.state.doc.eq(prevState.doc)) {
            const isRemote = view.state.tr?.getMeta?.("collab-remote")
            if (!isRemote && collabSession) {
              clearTimeout(collabNotifyPlugin.spec._timer)
              collabNotifyPlugin.spec._timer = setTimeout(() => {
                if (collabSession && editorView) {
                  const md = pmToMarkdown(editorView.state.doc, registry)
                  collabSession.localChange(md)
                }
              }, 100)
            }
          }
        },
      }
    },
  })

  // Plugin that renders colored block indicators for remote users' cursor positions.
  const remoteBlockPlugin = new Plugin({
    state: {
      init() {
        return DecorationSet.empty
      },
      apply(tr, decos) {
        if (!tr.getMeta("remoteBlocksUpdate") && !tr.docChanged) return decos
        // Rebuild decorations from remoteBlockUsers.
        const doc = tr.doc
        const decorations = []
        for (const u of remoteBlockUsers) {
          if (u.block < 0 || u.block >= doc.content.childCount) continue
          let pos = 0
          for (let i = 0; i < u.block; i++) {
            pos += doc.content.child(i).nodeSize
          }
          const node = doc.content.child(u.block)
          const color = presenceColor(u.username)
          // Widget decoration: a small colored bar before the block.
          const widget = Decoration.widget(
            pos,
            () => {
              const bar = document.createElement("div")
              bar.className = "gowiki-remote-indicator"
              bar.style.cssText = `border-left:3px solid ${color};position:absolute;left:0;top:0;bottom:0;pointer-events:none`
              const label = document.createElement("div")
              label.className = "gowiki-remote-label"
              label.style.cssText = `position:absolute;left:6px;top:-10px;font-size:9px;color:${color};font-weight:600;white-space:nowrap;pointer-events:none;opacity:0.8`
              label.textContent = u.displayName
              const wrapper = document.createElement("div")
              wrapper.style.cssText =
                "position:absolute;left:0;top:0;bottom:0;width:0;overflow:visible;pointer-events:none"
              wrapper.appendChild(bar)
              wrapper.appendChild(label)
              return wrapper
            },
            { side: -1, key: "remote-" + u.username }
          )
          decorations.push(widget)
          // Also add a node decoration for the background tint.
          decorations.push(
            Decoration.node(pos, pos + node.nodeSize, {
              style: `background:${color}11;border-left:3px solid ${color};padding-left:8px`,
            })
          )
        }
        return DecorationSet.create(doc, decorations)
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)
      },
    },
  })

  const plugins = [
    shortcutKeymap,
    listKeymap,
    history(),
    // Plugin keymaps run before baseKeymap so a plugin can intercept keys
    // (e.g. Enter inside a table cell) before the generic split-paragraph
    // default consumes the event.
    ...registry.getEditorPlugins(),
    // Gap cursor: lets the caret sit BETWEEN block-level atoms (todos,
    // images, includes, mermaid, …) that otherwise sit flush against each
    // other with no text position between them. Without it, ArrowRight
    // over a todo NodeSelection snaps directly to the next todo, and
    // typing on a NodeSelection replaces the atom — the reported "select
    // between two todos" / "todo escaped when text added" bugs. Must go
    // before baseKeymap so its arrow-key handling wins over generic
    // selectNodeForward / selectNodeBackward.
    gapCursor(),
    keymap(baseKeymap),
    menubarStatePlugin,
    collabNotifyPlugin,
    remoteBlockPlugin,
    commentPmPlugin,
  ]

  // Restore stashed state (preserves undo history) or create fresh.
  let state
  if (stashedEditorState) {
    // Reconfigure with fresh plugins (new menubar refs) but keep doc + history.
    state = stashedEditorState.reconfigure({ plugins })
    stashedEditorState = null
  } else {
    state = EditorState.create({ doc: currentDoc, schema, plugins })
  }

  editorView = new EditorView(editorEl, {
    state,
    handleScrollToSelection(view) {
      return scrollSelectionIntoContentView(view)
    },
    handlePaste(view, event, slice) {
      const plainText = event.clipboardData?.getData("text/plain") ?? ""

      // When pasting table content (rows/cells) inside a table, let
      // ProseMirror's default handling (prosemirror-tables) manage it
      // so rows are inserted as siblings rather than nested.
      const { $from } = view.state.selection
      if (isInTableCell(view.state)) {
        let hasTableContent = false
        slice.content.forEach((node) => {
          if (node.type.name === "table" || node.type.name === "table_row") hasTableContent = true
        })
        if (hasTableContent) return false
      }

      // Inside a code_block: insert plain text literally
      if ($from.parent.type === schema.nodes.code_block) {
        view.dispatch(view.state.tr.insertText(plainText))
        return true
      }

      // Direct image paste (screenshot, "Copy Image" from browser)
      // Check both files and items for image blobs.
      // Skip if clipboard also has HTML with table content (e.g. Excel paste)
      // — prefer structured table data over the image representation.
      const imageFiles = extractImageFiles(event.clipboardData)
      if (imageFiles.length > 0) {
        const clipHtml = event.clipboardData?.getData("text/html") ?? ""
        if (!/<table[\s>]/i.test(clipHtml)) {
          void handleImageFilePaste(view, imageFiles)
          return true
        }
      }

      // Sanitize through serialize → parse → insert pipeline
      let md
      try {
        const tempDoc = schema.nodes.doc.create(null, slice.content)
        md = pmToMarkdown(tempDoc, registry)
      } catch {
        // Serialization failed (unknown node types) — use plain text as markdown
        md = plainText
      }

      // Clean up list-like patterns (·, •, numbered) from pasted content
      md = cleanupPastedMarkdown(md)

      // Handle images with non-local src (data:, file://, blob://, http(s)://)
      if (hasNonLocalImages(md)) {
        void handleNonLocalImagePaste(view, md, slice, plainText)
        return true
      }

      try {
        const cleanDoc = markdownToPM(md, registry)
        // Use openStart/openEnd=0 so block-level content (tables, lists, etc.)
        // is inserted as a complete block rather than being flattened.
        // Only preserve the original open depths for purely inline content
        // (single paragraph whose content can merge into the cursor paragraph).
        let openStart = 0
        let openEnd = 0
        const fc = cleanDoc.content.firstChild
        if (cleanDoc.content.childCount === 1 && fc && fc.type === schema.nodes.paragraph) {
          openStart = Math.min(slice.openStart, 1)
          openEnd = Math.min(slice.openEnd, 1)
        }
        const tr = view.state.tr.replaceSelection(new Slice(cleanDoc.content, openStart, openEnd))
        view.dispatch(tr)
      } catch {
        // Parse failed — insert as plain text
        view.dispatch(view.state.tr.insertText(plainText))
      }
      return true
    },
    handleDrop(view, event, slice, moved) {
      // Internal drag — let ProseMirror handle it
      if (moved) return false

      const plainText = event.dataTransfer?.getData("text/plain") ?? ""

      let md
      try {
        const tempDoc = schema.nodes.doc.create(null, slice.content)
        md = pmToMarkdown(tempDoc, registry)
      } catch {
        md = plainText
      }

      md = cleanupPastedMarkdown(md)

      try {
        const cleanDoc = markdownToPM(md, registry)
        let openStart = 0
        let openEnd = 0
        const fc = cleanDoc.content.firstChild
        if (cleanDoc.content.childCount === 1 && fc && fc.type === schema.nodes.paragraph) {
          openStart = Math.min(slice.openStart, 1)
          openEnd = Math.min(slice.openEnd, 1)
        }
        const tr = view.state.tr.replaceSelection(new Slice(cleanDoc.content, openStart, openEnd))
        view.dispatch(tr)
      } catch {
        view.dispatch(view.state.tr.insertText(plainText))
      }
      return true
    },
    handleDOMEvents: {
      blur(view, event) {
        if (mode !== "edit" || editMode !== "visual") return false
        // Focus moving to a dialog or to the edit actions bar is part of
        // the user's edit (insert a link, pick a file), not the end of it.
        // Tidying the document then would strip what they were typing
        // under the caret — a trailing space, for one.
        const next = event && event.relatedTarget
        if (
          linkDialogOpen ||
          (next instanceof Element &&
            (actionsRoot?.contains(next) || next.closest('[class*="modal-overlay"], .gowiki-raw-editor-overlay')))
        ) {
          return false
        }
        try {
          const serialized = pmToMarkdown(view.state.doc, registry)
          const normalized = normalizeMarkdownForStorage(serialized)
          if (normalized.roundTripError) {
            console.error("Round-trip validation failed on blur, skipping normalization")
            return false
          }
          applyNormalizedEditState(normalized)
        } catch {
          // Keep edit session live while user content is in progress.
        }
        return false
      },
      contextmenu(view, event) {
        // Show table context menu when right-clicking inside a table.
        const $pos = view.state.selection.$from
        let inTable = false
        for (let d = $pos.depth; d > 0; d--) {
          if ($pos.node(d).type.name === "table") {
            inTable = true
            break
          }
        }
        if (!inTable) return false
        event.preventDefault()

        // Remove any previous context menu clone.
        document.querySelector(".gowiki-ctx-menu")?.remove()

        // Build a standalone context menu (not a child of the toolbar).
        const ctxMenu = document.createElement("div")
        ctxMenu.className = "gowiki-raw-dropdown-menu gowiki-ctx-menu"
        ctxMenu.style.position = "fixed"
        ctxMenu.style.left = event.clientX + "px"
        ctxMenu.style.top = event.clientY + "px"
        ctxMenu.style.display = "block"
        ctxMenu.style.zIndex = "9999"
        // Safety net: if the menu ends up taller than the viewport, allow
        // internal scrolling rather than being silently clipped.
        ctxMenu.style.maxHeight = "calc(100vh - 8px)"
        ctxMenu.style.overflowY = "auto"

        const ctxActions = [
          { name: "row.addBefore", label: "Add row above" },
          { name: "row.addAfter", label: "Add row below" },
          { name: "column.addBefore", label: "Add column left" },
          { name: "column.addAfter", label: "Add column right" },
          { name: "row.delete", label: "Delete row" },
          { name: "column.delete", label: "Delete column" },
          { name: "cell.properties", label: "Cell properties" },
          { name: "cell.merge", label: "Merge cells" },
          { name: "cell.split", label: "Unmerge cell" },
          { name: "delete", label: "Delete table" },
        ]
        const visualOnly = new Set(["cell.merge", "cell.split"])
        for (const action of ctxActions) {
          const item = document.createElement("div")
          item.className = "gowiki-raw-dropdown-item"
          item.textContent = action.label
          if (visualOnly.has(action.name) && editMode !== "visual") {
            item.classList.add("gowiki-raw-dropdown-item--disabled")
          }
          item.addEventListener("mousedown", (e) => {
            e.preventDefault()
            e.stopPropagation()
            if (item.classList.contains("gowiki-raw-dropdown-item--disabled")) return
            ctxMenu.remove()
            if (editMode === "visual" && editorView) {
              const cmd = tableCommands.get(action.name)
              if (cmd) cmd(editorView.state, editorView.dispatch)
              editorView.focus()
            }
          })
          ctxMenu.appendChild(item)
        }

        document.body.appendChild(ctxMenu)

        // After layout, flip the menu up/left if it would overflow the
        // viewport. event.clientX/Y is the anchor — by default the menu
        // hangs down-right; we reposition if there isn't room.
        const menuRect = ctxMenu.getBoundingClientRect()
        const vw = window.innerWidth
        const vh = window.innerHeight
        const margin = 4
        let left = event.clientX
        let top = event.clientY
        if (left + menuRect.width + margin > vw) {
          left = Math.max(margin, vw - menuRect.width - margin)
        }
        if (top + menuRect.height + margin > vh) {
          top = Math.max(margin, vh - menuRect.height - margin)
        }
        ctxMenu.style.left = left + "px"
        ctxMenu.style.top = top + "px"

        // Close on any outside click.
        const closeCtx = (e) => {
          if (!ctxMenu.contains(e.target)) {
            ctxMenu.remove()
            document.removeEventListener("mousedown", closeCtx, true)
          }
        }
        document.addEventListener("mousedown", closeCtx, true)
        return true
      },
    },
  })

  // Auto-focus the editor so the user can start typing immediately.
  if (nextEditMode === "visual" && editorView) {
    editorView.focus()
  } else if (nextEditMode === "raw") {
    const ta = document.querySelector(".gowiki-raw-editor")
    if (ta) ta.focus()
  }

  // Initialize comments overlay in visual edit mode (raw mode has no PM view).
  if (nextEditMode === "visual" && editorView && !isNewPage) {
    initComments({
      pagePath: `/${pagePath}`,
      view: editorView,
      authFetch,
      username: currentUser?.username || null,
      isAdmin: currentUser?.groups?.includes("admin") || false,
    })
  }
}

// ── Action bar icon SVG paths (stroke-based, 24x24 viewBox) ──

const actionIcons = {
  // Pencil
  edit: "M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z",
  // Clock with arrow
  history: "M12 8v4l3 3m6-3a9 9 0 1 1-2.64-6.36",
  // Arrow bend left
  backlinks: "M9 17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m6 16 4-4-4-4m4 4H9",
  // File with plus
  newPage: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M12 18v-6m-3 3h6",
  // Tree/sitemap
  siteMap:
    "M6 9H4.5a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2V7a2 2 0 0 1-2 2H6Zm0 0v3m0 0c0 1.1.9 2 2 2h4c1.1 0 2-.9 2-2m-8 0c0 1.1-.9 2-2 2H4.5a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2v-1.5a2 2 0 0 0-2-2H6m8-2.5v3.5a2 2 0 0 0 2 2h1.5a2 2 0 0 0 2-2V17a2 2 0 0 0-2-2h-1.5a2 2 0 0 0-2 2Z",
  // File arrow down
  exportPdf: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M12 18v-6m-3 3 3 3 3-3",
  // Chat bubble
  comment: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
  // Arrows move
  move: "M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20",
  // Folder arrows
  convert: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2ZM9 15l3-3 3 3",
  // Trash
  delete: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6Z",
  // Image/photo
  media:
    "M21 3H3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1Zm-3 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM2 20l5.5-7L11 17l3.5-4.5L22 20Z",
  // Code brackets
  switchRaw: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  // Eye
  switchVisual: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  // Small floppy on the left + big right-arrow on the right — reads
  // as "save first, then continue". Floppy shape/size matches the one
  // in the saveDraft composite; arrow has a chevron large enough to
  // be legible at toolbar size, distinct from the plain (bigger)
  // floppy that means Publish.
  save: "M2 12h6.5l3.5 3.5v5a1.5 1.5 0 0 1-1.5 1.5h-7a1.5 1.5 0 0 1-1.5-1.5v-7a1.5 1.5 0 0 1 1.5-1.5ZM8.5 12v3.5H12M3 22v-4h5v4M3 12v3h4M13 17h10m-4-4 4 4-4 4",
  // Plain floppy — the "commit / publish" action. Reads as save at a
  // glance; the visual weight matches its permanence.
  publish: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2ZM17 21v-8H7v8M7 3v5h8",
  // X circle
  cancel: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm3.54 6.46L9.46 14.54m0-6.08 6.08 6.08",
  // Hourglass (main, shifted up-left) + small trash (nudged down-right)
  discard:
    "M2 1h10M2 17h10M7 9l2.5-3.5V2H4.5v3.5L7 9Zm0 0-2.5 3.5V16h5v-3.5L7 9ZM14 10h8M17 10V8.5a1.5 1.5 0 0 1 3 0V10m2.5 0v8.5a1.5 1.5 0 0 1-1.5 1.5h-5a1.5 1.5 0 0 1-1.5-1.5V10Z",
  // Expand arrows
  fullscreen: "M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3",
  // Contract arrows
  exitFullscreen: "M4 14h4v4M20 10h-4V6M14 10h4V6M10 14H6v4",
  // Lock
  lock: "M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2ZM7 11V7a5 5 0 0 1 10 0v4",
  // Hourglass (main, shifted up-left) + small floppy (nudged down-right)
  saveDraft:
    "M2 1h10M2 17h10M7 9l2.5-3.5V2H4.5v3.5L7 9Zm0 0-2.5 3.5V16h5v-3.5L7 9ZM14 12h6.5l3.5 3.5v5a1.5 1.5 0 0 1-1.5 1.5h-7a1.5 1.5 0 0 1-1.5-1.5v-7a1.5 1.5 0 0 1 1.5-1.5ZM20.5 12v3.5H24M15 22v-4h5v4M15 12v3h4",
  // Five-point star (outlined by stroke; filled state via CSS)
  star: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2Z",
  ai: null, // text-only button, no SVG path
}

function makeActionIconBtn(iconName, tooltip, onClick, extraClass) {
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "gowiki-action-btn gowiki-action-btn--stroke" + (extraClass ? " " + extraClass : "")
  btn.title = tooltip
  const pathData = actionIcons[iconName]
  if (pathData) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("viewBox", "0 0 24 24")
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path")
    p.setAttribute("d", pathData)
    svg.appendChild(p)
    btn.appendChild(svg)
  } else {
    // Text-only button (e.g. "AI")
    btn.textContent = iconName.toUpperCase()
    btn.style.fontSize = "11px"
    btn.style.fontWeight = "700"
    btn.style.letterSpacing = "0.5px"
  }
  btn.addEventListener("click", (e) => onClick(e))
  return btn
}

function makeActionSep() {
  const sep = document.createElement("div")
  sep.className = "gowiki-action-sep"
  return sep
}

// Text-button factory for in-content buttons (history Back, etc.)
function makeContentButton(label, onClick) {
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "gowiki-content-btn"
  btn.textContent = label
  btn.addEventListener("click", onClick)
  return btn
}

function promptNewPage() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div")
    overlay.className = "gowiki-link-modal-overlay"

    const dialog = document.createElement("div")
    dialog.className = "gowiki-link-modal"

    const title = document.createElement("div")
    title.className = "gowiki-link-modal-title"
    title.textContent = "Create new page"

    const pathLabel = document.createElement("label")
    pathLabel.className = "gowiki-link-modal-label"
    pathLabel.textContent = "Page path"

    const pathInput = document.createElement("input")
    pathInput.type = "text"
    pathInput.className = "gowiki-link-modal-input"
    pathInput.placeholder = "/namespace/page-name"

    const warning = document.createElement("div")
    warning.className = "gowiki-link-modal-warning"

    const buttons = document.createElement("div")
    buttons.className = "gowiki-link-modal-actions"

    const cancelBtn = document.createElement("button")
    cancelBtn.type = "button"
    cancelBtn.textContent = "Cancel"
    cancelBtn.className = "gowiki-link-modal-btn"

    const okBtn = document.createElement("button")
    okBtn.type = "button"
    okBtn.textContent = "Create"
    okBtn.className = "gowiki-link-modal-btn"

    function close(value) {
      overlay.remove()
      resolve(value)
    }

    function submit() {
      const raw = pathInput.value.trim()
      if (!raw) {
        warning.textContent = "Path cannot be empty."
        pathInput.focus()
        return
      }
      if (/\.\w+$/.test(raw)) {
        warning.textContent = "Page paths must not have a file extension."
        pathInput.focus()
        return
      }
      // Reject paths with invalid characters (colons, percent-encoding, etc.)
      if (/[:?#%]/.test(raw.replace(/^\/+/, ""))) {
        warning.textContent = "Invalid characters in path. Use only letters, numbers, hyphens, and slashes."
        pathInput.focus()
        return
      }
      const hasTrailingSlash = raw.endsWith("/")
      const cleaned = raw.replace(/^\/+/, "").replace(/\/+$/, "")
      if (!cleaned) {
        warning.textContent = "Invalid path."
        pathInput.focus()
        return
      }
      close(hasTrailingSlash ? cleaned + "/" : cleaned)
    }

    cancelBtn.addEventListener("click", () => close(null))
    okBtn.addEventListener("click", submit)
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(null)
    })
    pathInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        submit()
      } else if (event.key === "Escape") {
        event.preventDefault()
        close(null)
      }
    })

    buttons.appendChild(cancelBtn)
    buttons.appendChild(okBtn)
    dialog.appendChild(title)
    dialog.appendChild(pathLabel)
    dialog.appendChild(pathInput)
    dialog.appendChild(warning)
    dialog.appendChild(buttons)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    pathInput.focus()
  }).then((pagePath) => {
    if (pagePath) {
      window.location.href = "/" + pagePath + "?action=create"
    }
  })
}

function toggleFullscreen() {
  isFullscreen = !isFullscreen
  document.body.classList.toggle("gowiki-fullscreen", isFullscreen)
  if (isFullscreen) {
    // Request true browser fullscreen (hides browser chrome).
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {})
    }
    const exitBtn = document.createElement("button")
    exitBtn.className = "gowiki-fullscreen-exit"
    exitBtn.title = "Exit fullscreen (Esc)"
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("viewBox", "0 0 24 24")
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path")
    p.setAttribute("d", actionIcons.exitFullscreen)
    svg.appendChild(p)
    exitBtn.appendChild(svg)
    exitBtn.addEventListener("click", toggleFullscreen)
    document.body.appendChild(exitBtn)
  } else {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
    const existing = document.querySelector(".gowiki-fullscreen-exit")
    if (existing) existing.remove()
  }
}

// Sync state when browser exits fullscreen via its own Escape (before ours fires).
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && isFullscreen) {
    isFullscreen = false
    document.body.classList.remove("gowiki-fullscreen")
    const existing = document.querySelector(".gowiki-fullscreen-exit")
    if (existing) existing.remove()
  }
})

function renderActions() {
  actionsRoot.innerHTML = ""

  if (mode === "edit") {
    // ── Edit mode actions ──
    actionsRoot.appendChild(
      makeActionIconBtn("media", "Media manager", () => {
        openMediaManager(
          pageNamespace,
          (text) => setStatus(text),
          (kind, entry) => {
            if (editMode === "raw") {
              rawInsertMediaReference(kind, entry)
            } else {
              insertMediaReference(kind, entry)
            }
          }
        )
      })
    )

    if (editMode === "visual") {
      actionsRoot.appendChild(makeActionIconBtn("switchRaw", "Switch to raw", () => setEditMode("raw")))
    } else {
      actionsRoot.appendChild(makeActionIconBtn("switchVisual", "Switch to visual", () => setEditMode("visual")))
    }

    actionsRoot.appendChild(makeActionSep())

    if (isCollabGuest) {
      // Collab guest: can only leave the session.
      actionsRoot.appendChild(makeActionIconBtn("cancel", "Leave session (Esc)", () => cancelEdit()))
    } else {
      const saveHint = isMac ? "\u2318S" : "Ctrl+S"
      actionsRoot.appendChild(
        makeActionIconBtn("save", `Save & continue (${saveHint})`, () => void saveDraftExplicit())
      )
      actionsRoot.appendChild(makeActionIconBtn("saveDraft", "Save to draft", () => void saveDraftAndExit()))

      const pubHint = isMac ? "\u21E7\u2318S" : "Ctrl+Shift+S"
      actionsRoot.appendChild(makeActionIconBtn("publish", `Publish (${pubHint})`, () => void publishDraft()))

      actionsRoot.appendChild(makeActionSep())
      actionsRoot.appendChild(makeActionIconBtn("cancel", "Cancel editing", () => cancelEdit()))
      actionsRoot.appendChild(
        makeActionIconBtn("discard", "Discard draft", () => void discardDraft(), "gowiki-action-delete")
      )
    }

    actionsRoot.appendChild(makeActionSep())
    actionsRoot.appendChild(makeActionIconBtn("fullscreen", "Fullscreen (F11)", () => toggleFullscreen()))

    if (aiAssistantEnabled) {
      actionsRoot.appendChild(makeActionSep())
      actionsRoot.appendChild(makeActionIconBtn("ai", "AI Assistant (Ctrl+L)", () => toggleAIPanel()))
    }
  } else {
    // ── View mode actions ──

    // Edit button — varies by lock/draft state
    if (pageLockInfo && pageLockInfo.is_draft && pageLockInfo.locked_by === currentUser?.username) {
      const editBtn = makeActionIconBtn(
        "edit",
        "Resume editing \u2014 unpublished draft (Shift+click: raw mode)",
        (e) => {
          if (e?.shiftKey) editMode = "raw"
          void enterEditMode(true)
        }
      )
      const dot = document.createElement("span")
      dot.className = "gowiki-action-draft-dot"
      editBtn.appendChild(dot)
      actionsRoot.appendChild(editBtn)
      actionsRoot.appendChild(makeActionIconBtn("publish", "Publish draft", () => void publishFromView()))
      actionsRoot.appendChild(
        makeActionIconBtn("discard", "Discard draft", () => void discardDraft(), "gowiki-action-delete")
      )
    } else if (pageLockInfo && pageLockInfo.locked_by && pageLockInfo.locked_by !== currentUser?.username) {
      const foreignEditBtn = makeActionIconBtn(
        "edit",
        `Being edited by ${pageLockInfo.locked_by} — click to join session`,
        (e) => {
          if (e?.shiftKey) editMode = "raw"
          void joinCollabSession(pageLockInfo.locked_by)
        }
      )
      // Orange dot distinguishes "someone else is editing — join or wait"
      // from the yellow dot the user's own unpublished draft shows. The
      // tooltip above names the owner; the dot gives the at-a-glance cue
      // so the user doesn't need to hover to notice the state.
      const foreignDot = document.createElement("span")
      foreignDot.className = "gowiki-action-foreign-lock-dot"
      foreignEditBtn.appendChild(foreignDot)
      actionsRoot.appendChild(foreignEditBtn)
    } else {
      const editHint = isMac ? "\u2318E" : "Ctrl+E"
      actionsRoot.appendChild(
        makeActionIconBtn("edit", `Edit (${editHint}, Shift+click: raw mode)`, (e) => {
          if (e?.shiftKey) editMode = "raw"
          void enterEditMode(false)
        })
      )
    }

    actionsRoot.appendChild(makeActionSep())

    actionsRoot.appendChild(makeActionIconBtn("history", "History", () => void showHistory()))
    actionsRoot.appendChild(makeActionIconBtn("backlinks", "Backlinks", () => void showBacklinks()))

    actionsRoot.appendChild(makeActionSep())

    if (currentUser && !isNewPage) {
      const canonical = canonicalFavoritePath(pagePath)
      const favored = currentFavorites.has(canonical)
      const starBtn = makeActionIconBtn(
        "star",
        favored ? "Remove from favorites" : "Add to favorites",
        () => void toggleFavoriteCurrent()
      )
      starBtn.setAttribute("data-gowiki-star", "1")
      if (favored) starBtn.classList.add("gowiki-action-btn--filled")
      actionsRoot.appendChild(starBtn)
    }
    actionsRoot.appendChild(makeActionIconBtn("newPage", "New page", () => void promptNewPage()))
    actionsRoot.appendChild(
      makeActionIconBtn("siteMap", "Site map", () => {
        // Hand the sitemap the current path so it can auto-expand ancestor
        // namespaces. Falls back to a fully-collapsed tree when the param is
        // absent (direct navigation from the URL bar).
        const from = pagePath ? "/" + pagePath.replace(/^\/+/, "") : ""
        const qs = from ? `?from=${encodeURIComponent(from)}` : ""
        window.location.href = `/_sitemap${qs}`
      })
    )
    actionsRoot.appendChild(
      makeActionIconBtn("exportPdf", "Export PDF", () => window.open(`/api/export/pdf/${pagePath}`, "_blank"))
    )

    if (currentUser && !isNewPage) {
      actionsRoot.appendChild(makeActionSep())
      const commentCount = getCommentCount()
      const commentBtn = makeActionIconBtn("comment", "Comment (select text first)", () => addComment())
      commentBtn.disabled = true
      if (commentCount > 0) {
        const badge = document.createElement("span")
        badge.className = "gowiki-action-badge"
        badge.textContent = String(commentCount)
        commentBtn.appendChild(badge)
      }
      // Update button state based on text selection.
      const updateCommentBtnState = () => {
        const sel = window.getSelection()
        const hasSelection = sel && sel.toString().trim().length > 0
        commentBtn.disabled = !hasSelection
        const countLabel = commentCount > 0 ? ` (${commentCount})` : ""
        commentBtn.title = hasSelection ? `Comment${countLabel}` : `Comment (select text first)${countLabel}`
      }
      document.addEventListener("selectionchange", updateCommentBtnState)
      updateCommentBtnState()
      actionsRoot.appendChild(commentBtn)
      actionsRoot.appendChild(makeActionIconBtn("move", "Move page", () => void movePage()))
      if (isNamespaceIndex) {
        actionsRoot.appendChild(
          makeActionIconBtn("convert", "Convert to regular page", () => void convertPageType("to_regular_page"))
        )
      } else {
        actionsRoot.appendChild(
          makeActionIconBtn("convert", "Convert to namespace", () => void convertPageType("to_namespace_index"))
        )
      }
      actionsRoot.appendChild(
        makeActionIconBtn("delete", "Delete page", () => void deletePage(), "gowiki-action-delete")
      )
    }

    actionsRoot.appendChild(makeActionSep())
    actionsRoot.appendChild(makeActionIconBtn("fullscreen", "Fullscreen (F11)", () => toggleFullscreen()))

    if (aiAssistantEnabled && currentUser) {
      actionsRoot.appendChild(makeActionSep())
      actionsRoot.appendChild(makeActionIconBtn("ai", "AI Assistant (Ctrl+L)", () => toggleAIPanel()))
    }
  }
}

async function publishFromView() {
  // Quick-publish: enter edit, then immediately publish.
  // Use force=true since the user owns the draft and is explicitly publishing.
  const ok = await enterEditMode(true)
  if (!ok) return
  await publishDraft()
}

async function deletePage() {
  if (!confirm(`Delete page "${pageDisplayPath}"? This will archive the content.`)) {
    return
  }

  const resp = await authFetch(`/api/pages/${pagePath}`, { method: "DELETE" })
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    const msg = data.error || `Delete failed (${resp.status})`
    setStatus(msg)
    return
  }

  const data = await resp.json()

  // Warn about pages that include this page.
  if (data.included_by && data.included_by.length > 0) {
    alert(
      `Warning: this page was included by:\n${data.included_by.join("\n")}\n\nThose pages may now have broken includes.`
    )
  }

  // Navigate to parent namespace or root.
  const parent = pagePath.includes("/") ? "/" + pagePath.split("/").slice(0, -1).join("/") : "/"
  setStatus("Page deleted.")
  window.location.href = parent
}

async function movePage() {
  const newPath = prompt("Move page to:", `/${pagePath}`)
  if (!newPath || newPath.trim() === "" || newPath.trim() === `/${pagePath}`) return

  // Dry run first: always request preview with move_media=true to show all options.
  let preview
  try {
    const previewResp = await authFetch(`/api/move/${pagePath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: newPath.trim(), move_media: true, dry_run: true }),
    })
    if (!previewResp.ok) {
      const data = await previewResp.json().catch(() => ({}))
      setStatus(data.error || `Move preview failed (${previewResp.status})`)
      return
    }
    preview = await previewResp.json()
  } catch {
    setStatus("Move preview failed")
    return
  }

  const hasAffectedPages = preview.affected_pages && preview.affected_pages.length > 0
  const hasMedia = preview.media_to_move && preview.media_to_move.length > 0

  // Ask about optional actions first, before the final confirmation.
  let updateLinks = false
  if (hasAffectedPages) {
    updateLinks = confirm(
      `${preview.affected_pages.length} page(s) contain links to this page:\n\n` +
        preview.affected_pages.map((p) => `  - ${p}`).join("\n") +
        "\n\nUpdate their links to point to the new location?"
    )
  }

  let moveMedia = false
  if (hasMedia) {
    moveMedia = confirm(
      `${preview.media_to_move.length} media file(s) are exclusively referenced by this page:\n\n` +
        preview.media_to_move.map((m) => `  - ${m}`).join("\n") +
        "\n\nMove them alongside the page?"
    )
  }

  // Build final confirmation summarizing all actions.
  const lines = [`Move page "${pageDisplayPath}" to "${preview.new_path}"`, ""]
  lines.push("Actions:")
  lines.push(`  - Move page and its full history`)
  if (updateLinks) {
    lines.push(`  - Update links in ${preview.affected_pages.length} page(s)`)
  }
  if (moveMedia) {
    lines.push(`  - Co-move ${preview.media_to_move.length} media file(s)`)
  }
  lines.push("")
  lines.push("Apply?")
  if (!confirm(lines.join("\n"))) return

  // Execute the move.
  const resp = await authFetch(`/api/move/${pagePath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: newPath.trim(),
      move_media: moveMedia,
      update_links: updateLinks,
    }),
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    setStatus(data.error || `Move failed (${resp.status})`)
    return
  }

  const result = await resp.json()
  setStatus("Page moved.")
  window.location.href = result.new_path
}

async function convertPageType(flag) {
  const label = flag === "to_namespace_index" ? "Convert to namespace index?" : "Convert to regular page?"

  if (!confirm(label)) return

  const body = {}
  body[flag] = true

  const resp = await authFetch(`/api/move/${pagePath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    setStatus(data.error || `Conversion failed (${resp.status})`, true)
    return
  }

  setStatus("Page converted.")
  window.location.reload()
}

// ── History and Diff UI ──────────────────────────────

let inHistoryView = false // true when showing history/version/diff

function enterHistoryView() {
  if (!inHistoryView) {
    // Push a state so the browser back button returns to the page.
    window.history.pushState({ sargonHistory: true }, "", window.location.href)
    inHistoryView = true
  }
}

function exitHistoryView() {
  inHistoryView = false
  currentDoc = markdownToPM(currentMarkdown, registry)
  setMode("view")
}

// A click in the page margin beside the visual editor lands on one of
// its container elements, which takes focus away from the editor: the
// caret disappears and keyboard shortcuts such as Cmd+K stop reaching
// ProseMirror. Place the caret at the nearest document position at that
// height instead, as a word processor does.
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || mode !== "edit" || editMode !== "visual" || !editorView) return
  const target = e.target
  if (!(target instanceof Element) || !target.contains(editorView.dom) || editorView.dom.contains(target)) return
  const box = editorView.dom.getBoundingClientRect()
  if (e.clientY < box.top || e.clientY > box.bottom) return
  const left = Math.min(Math.max(e.clientX, box.left + 1), box.right - 1)
  const hit = editorView.posAtCoords({ left, top: e.clientY })
  if (!hit) return
  e.preventDefault()
  const sel = Selection.near(editorView.state.doc.resolve(hit.pos))
  editorView.dispatch(editorView.state.tr.setSelection(sel))
  editorView.focus()
})

window.addEventListener("popstate", (e) => {
  if (inHistoryView) {
    inHistoryView = false
    currentDoc = markdownToPM(currentMarkdown, registry)
    setMode("view")
  }
})

// When a row-bound page is updated via an inline edit anywhere on this tab
// (query view or admin management), and the history for that page is currently
// showing, refresh it so the new version appears without needing a manual
// close/reopen.
document.addEventListener("gowiki-database-row-updated", (e) => {
  if (!inHistoryView) return
  const rowPath = (e.detail?.pagePath || "").replace(/^\/+/, "")
  const currentPath = (pagePath || "").replace(/^\/+/, "")
  if (rowPath && rowPath === currentPath) void showHistory()
})

async function showHistory() {
  try {
    const [histResp, tombResp] = await Promise.all([
      fetch(`/api/history/${encodePagePath(pagePath)}`),
      fetch(`/api/tombstones/${encodePagePath(pagePath)}`),
    ])
    if (!histResp.ok) {
      setStatus("Failed to load history")
      return
    }
    const data = await histResp.json()
    const versions = data.versions || []
    // Tombstones endpoint is best-effort — a 404 or network error must
    // not block the live history view. Empty array if anything fails.
    let tombstones = []
    if (tombResp.ok) {
      try {
        const tombData = await tombResp.json()
        tombstones = tombData.tombstones || []
      } catch {
        tombstones = []
      }
    }
    enterHistoryView()
    renderHistoryPage(versions, data.draft || null, tombstones)
  } catch {
    setStatus("Failed to load history")
  }
}

async function showBacklinks() {
  try {
    const resp = await fetch(`/api/backlinks/${encodePagePath(pagePath)}`)
    if (!resp.ok) {
      setStatus("Failed to load backlinks")
      return
    }
    const data = await resp.json()
    const backlinks = data.backlinks || []
    enterHistoryView()
    renderBacklinksPage(backlinks)
  } catch {
    setStatus("Failed to load backlinks")
  }
}

function renderBacklinksPage(backlinks) {
  clearContent()
  mode = "view"
  appRoot.classList.remove("gowiki-editing")

  const container = document.createElement("div")
  container.className = "gowiki-history"

  const title = document.createElement("h2")
  title.textContent = `Backlinks: ${pageDisplayPath}`
  container.appendChild(title)

  if (backlinks.length === 0) {
    const empty = document.createElement("p")
    empty.textContent = "No pages link to this page."
    empty.style.color = "#666"
    container.appendChild(empty)
  } else {
    const list = document.createElement("ul")
    list.className = "gowiki-backlinks-list"
    for (const entry of backlinks) {
      const li = document.createElement("li")
      const link = document.createElement("a")
      const href = entry.path.startsWith("/") ? entry.path : "/" + entry.path
      link.href = href
      link.textContent = entry.path
      link.addEventListener("click", (e) => {
        e.preventDefault()
        window.location.href = href
      })
      li.appendChild(link)
      if (entry.title && entry.title !== entry.path) {
        const titleSpan = document.createElement("span")
        titleSpan.textContent = ` — ${entry.title}`
        titleSpan.style.color = "#888"
        li.appendChild(titleSpan)
      }
      list.appendChild(li)
    }
    container.appendChild(list)
  }

  const backBtn = document.createElement("button")
  backBtn.textContent = "Back to page"
  backBtn.className = "gowiki-content-btn"
  backBtn.style.marginTop = "16px"
  backBtn.addEventListener("click", () => {
    window.history.back()
  })
  container.appendChild(backBtn)

  contentRoot.appendChild(container)
}

function renderHistoryPage(versions, draft, tombstones) {
  clearContent()
  mode = "view"
  appRoot.classList.remove("gowiki-editing")

  const container = document.createElement("div")
  container.className = "gowiki-history"

  const title = document.createElement("h2")
  title.textContent = `History: ${pageDisplayPath}`
  container.appendChild(title)

  // Tombstone banner: previous lives of this URL exist.
  if (tombstones && tombstones.length > 0) {
    const banner = document.createElement("div")
    banner.className = "gowiki-tombstone-banner"
    const count = tombstones.length
    const label =
      count === 1
        ? "A previous page lived at this URL before and was deleted."
        : `${count} previous pages lived at this URL before and were deleted.`
    const text = document.createElement("span")
    text.textContent = label + " "
    banner.appendChild(text)
    const link = document.createElement("button")
    link.type = "button"
    link.className = "gowiki-tombstone-banner-link"
    link.textContent = count === 1 ? "View archived history" : "View archived histories"
    link.addEventListener("click", () => renderArchivedHistory(tombstones))
    banner.appendChild(link)
    container.appendChild(banner)
  }

  // Draft notice for non-owners.
  if (draft && draft.is_own === false) {
    const notice = document.createElement("div")
    notice.className = "gowiki-history-draft-notice"
    notice.textContent = `A draft by ${draft.owner} exists`

    // Admin users get a force-discard button.
    if (currentUser && currentUser.is_admin) {
      const forceBtn = document.createElement("button")
      forceBtn.textContent = "Force discard"
      forceBtn.className = "gowiki-history-btn gowiki-history-btn-discard"
      forceBtn.style.marginLeft = "12px"
      forceBtn.addEventListener("click", () => void adminForceDiscardDraft(draft.owner))
      notice.appendChild(forceBtn)
    }

    container.appendChild(notice)
  }

  if (versions.length === 0 && !(draft && draft.is_own)) {
    const empty = document.createElement("p")
    empty.textContent =
      tombstones && tombstones.length > 0
        ? "No current version of this page — see the archived history above for the previous life."
        : "No version history available."
    empty.style.color = "var(--gw-color-muted)"
    container.appendChild(empty)
  } else {
    const table = document.createElement("table")
    table.className = "gowiki-history-table"
    const thead = document.createElement("thead")
    thead.innerHTML = "<tr><th>Version</th><th>Date</th><th>Author</th><th>Status</th><th>Actions</th></tr>"
    table.appendChild(thead)
    const tbody = document.createElement("tbody")

    // Draft row for owner.
    if (draft && draft.is_own === true) {
      const tr = document.createElement("tr")
      tr.className = "gowiki-history-draft-row"

      const tdVer = document.createElement("td")
      tdVer.innerHTML = "<em>Draft</em>"
      tr.appendChild(tdVer)

      const tdDate = document.createElement("td")
      tdDate.textContent = draft.since ? new Date(draft.since).toLocaleString() : "—"
      tr.appendChild(tdDate)

      const tdAuthor = document.createElement("td")
      tdAuthor.textContent = draft.owner
      tr.appendChild(tdAuthor)

      const tdStatus = document.createElement("td")
      tdStatus.textContent = "—"
      tr.appendChild(tdStatus)

      const tdActions = document.createElement("td")
      tdActions.className = "gowiki-history-actions"

      const diffBtn = document.createElement("button")
      diffBtn.textContent = "Diff vs published"
      diffBtn.className = "gowiki-history-btn"
      diffBtn.addEventListener("click", () => void showDiff(0, -1))
      tdActions.appendChild(diffBtn)

      const publishBtn = document.createElement("button")
      publishBtn.textContent = "Publish"
      publishBtn.className = "gowiki-history-btn gowiki-history-btn-restore"
      publishBtn.addEventListener("click", () => void publishDraftFromHistory())
      tdActions.appendChild(publishBtn)

      const discardBtn = document.createElement("button")
      discardBtn.textContent = "Discard"
      discardBtn.className = "gowiki-history-btn gowiki-history-btn-discard"
      discardBtn.addEventListener("click", () => void discardDraftFromHistory(draft.has_changes))
      tdActions.appendChild(discardBtn)

      tr.appendChild(tdActions)
      tbody.appendChild(tr)
    }

    // Show newest first.
    if (versions.length > 0) {
      const sorted = [...versions].reverse()
      const latestVersion = sorted[0].version
      const oldestVersion = sorted[sorted.length - 1].version
      historyLatestVersion = latestVersion
      for (const v of sorted) {
        const tr = document.createElement("tr")

        const tdVer = document.createElement("td")
        tdVer.textContent = `v${v.version}`
        tr.appendChild(tdVer)

        const tdDate = document.createElement("td")
        tdDate.textContent = new Date(v.timestamp).toLocaleString()
        tr.appendChild(tdDate)

        const tdAuthor = document.createElement("td")
        tdAuthor.textContent = v.author || "—"
        tr.appendChild(tdAuthor)

        const tdStatus = document.createElement("td")
        const rfMeta = v.plugin_meta?.reviewflow
        if (rfMeta) {
          if (rfMeta.is_validated) {
            const badge = document.createElement("span")
            badge.className = "gowiki-history-validated-badge"
            badge.textContent = "Validated"
            tdStatus.appendChild(badge)
            if (rfMeta.version_tag) {
              const tag = document.createElement("a")
              tag.className = "gowiki-history-version-tag"
              tag.textContent = rfMeta.version_tag
              tag.href = `${window.location.pathname}?v=${v.version}`
              tag.title = `View validated version ${rfMeta.version_tag}`
              tag.addEventListener("click", (e) => {
                e.preventDefault()
                void viewVersion(v.version)
              })
              tdStatus.appendChild(tag)
            }
          } else {
            tdStatus.textContent = "—"
          }
        } else {
          tdStatus.textContent = "—"
        }
        tr.appendChild(tdStatus)

        const tdActions = document.createElement("td")
        tdActions.className = "gowiki-history-actions"

        const viewBtn = document.createElement("button")
        viewBtn.textContent = "View"
        viewBtn.className = "gowiki-history-btn"
        viewBtn.addEventListener("click", () => void viewVersion(v.version))
        tdActions.appendChild(viewBtn)

        if (v.version > oldestVersion) {
          const diffPrevBtn = document.createElement("button")
          diffPrevBtn.textContent = "Diff vs prev"
          diffPrevBtn.className = "gowiki-history-btn"
          const prevVersion = sorted[sorted.indexOf(v) + 1].version
          diffPrevBtn.addEventListener("click", () => void showDiff(prevVersion, v.version))
          tdActions.appendChild(diffPrevBtn)
        }

        if (v.version < latestVersion) {
          const diffCurBtn = document.createElement("button")
          diffCurBtn.textContent = "Diff vs current"
          diffCurBtn.className = "gowiki-history-btn"
          diffCurBtn.addEventListener("click", () => void showDiff(v.version, 0))
          tdActions.appendChild(diffCurBtn)

          const restoreBtn = document.createElement("button")
          restoreBtn.textContent = "Restore"
          restoreBtn.className = "gowiki-history-btn gowiki-history-btn-restore"
          restoreBtn.addEventListener("click", () => void restoreVersion(v.version))
          tdActions.appendChild(restoreBtn)
        }

        tr.appendChild(tdActions)
        tbody.appendChild(tr)
      }
    }
    table.appendChild(tbody)
    container.appendChild(table)
  }

  const backBtn = document.createElement("button")
  backBtn.textContent = "Back to page"
  backBtn.className = "gowiki-content-btn"
  backBtn.style.marginTop = "16px"
  backBtn.addEventListener("click", () => {
    window.history.back()
  })
  container.appendChild(backBtn)

  contentRoot.appendChild(container)
}

// rewriteMediaToVersioned rewrites <img> src attributes in a container
// to use versioned media URLs based on the media_refs map from the attic entry.
// media_refs maps media path (e.g. "images/photo.png") to version number.
// resolveMediaSrc resolves an image src (as it appears in the DOM) to
// the normalized media path used as key in media_refs.
// Handles: /media/path, ./relative, ../relative, /absolute
function resolveMediaSrc(src) {
  // Absolute /media/ URL
  const mediaMatch = src.match(/^\/media\/(.+)$/)
  if (mediaMatch) return mediaMatch[1]

  // Skip external URLs
  if (/^https?:\/\//i.test(src)) return null

  // Relative path (./file, ../dir/file) — resolve against current page namespace
  if (src.startsWith("./") || src.startsWith("../")) {
    const ns = pageNamespace // e.g. "" for root, "ns/sub" for nested
    const nsParts = ns ? ns.split("/") : []
    const refParts = src.split("/")
    const resolved = [...nsParts]
    for (const part of refParts) {
      if (part === ".") continue
      if (part === "..") {
        resolved.pop()
        continue
      }
      resolved.push(part)
    }
    return resolved.join("/")
  }

  // Absolute path starting with /
  if (src.startsWith("/")) return src.slice(1)

  return null
}

// rewriteMediaToVersioned rewrites <img> src attributes in a container
// to use versioned media URLs based on the media_refs map from an attic entry.
// Used for backward compat when viewing old archived page versions that have
// frozen media_refs but bare image URLs in their markdown.
function rewriteMediaToVersioned(container, mediaRefs) {
  if (!mediaRefs || typeof mediaRefs !== "object") return
  const imgs = container.querySelectorAll("img[src]")
  for (const img of imgs) {
    const src = img.getAttribute("src") || ""
    // Skip images that already have a ?v= parameter (new-style versioned URLs).
    if (/[?&]v=\d/.test(src)) continue
    const mediaPath = resolveMediaSrc(src)
    if (!mediaPath) continue
    const ver = mediaRefs[mediaPath]
    if (ver != null) {
      img.setAttribute("src", `/media/${mediaPath}?v=${ver}`)
    }
  }
}

// renderArchivedHistory shows the per-deletion snapshots of a page's
// previous lives. Called from the tombstone banner on the live history
// page.
function renderArchivedHistory(tombstones) {
  clearContent()
  mode = "view"
  appRoot.classList.remove("gowiki-editing")

  const container = document.createElement("div")
  container.className = "gowiki-history"

  const title = document.createElement("h2")
  title.textContent = `Archived history: ${pageDisplayPath}`
  container.appendChild(title)

  const intro = document.createElement("p")
  intro.className = "gowiki-tombstone-intro"
  intro.textContent =
    "These versions belong to one or more previous pages that lived at this URL and were deleted. " +
    "They are kept for audit purposes and are not part of the current page's history."
  container.appendChild(intro)

  // Oldest tombstone first (chronological), with each tombstone as its
  // own section. Inside each section, versions are shown newest-first to
  // match the live history convention.
  for (const tomb of tombstones) {
    const section = document.createElement("div")
    section.className = "gowiki-tombstone-section"

    const header = document.createElement("h3")
    header.className = "gowiki-tombstone-section-title"
    const when = tomb.deleted_at ? new Date(tomb.deleted_at).toLocaleString() : "unknown date"
    header.textContent = `Deleted on ${when}`
    section.appendChild(header)

    const versions = tomb.versions || []
    if (versions.length === 0) {
      const empty = document.createElement("p")
      empty.textContent = "No versions recorded in this tombstone."
      empty.style.color = "var(--gw-color-muted)"
      section.appendChild(empty)
    } else {
      const table = document.createElement("table")
      table.className = "gowiki-history-table"
      const thead = document.createElement("thead")
      thead.innerHTML = "<tr><th>Version</th><th>Date</th><th>Author</th><th>Summary</th><th>Actions</th></tr>"
      table.appendChild(thead)
      const tbody = document.createElement("tbody")
      const sorted = [...versions].sort((a, b) => b.version - a.version)
      for (const v of sorted) {
        const tr = document.createElement("tr")
        const tdVer = document.createElement("td")
        tdVer.textContent = `v${v.version}`
        tr.appendChild(tdVer)
        const tdDate = document.createElement("td")
        tdDate.textContent = v.timestamp ? new Date(v.timestamp).toLocaleString() : "—"
        tr.appendChild(tdDate)
        const tdAuthor = document.createElement("td")
        tdAuthor.textContent = v.author || "—"
        tr.appendChild(tdAuthor)
        const tdSummary = document.createElement("td")
        tdSummary.textContent = v.summary || "—"
        tr.appendChild(tdSummary)
        const tdActions = document.createElement("td")
        tdActions.className = "gowiki-history-actions"
        const viewBtn = document.createElement("button")
        viewBtn.textContent = "View"
        viewBtn.className = "gowiki-history-btn"
        viewBtn.addEventListener("click", () => void viewTombstonedVersion(tomb.id, v.version, when, tombstones))
        tdActions.appendChild(viewBtn)
        tr.appendChild(tdActions)
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      section.appendChild(table)
    }
    container.appendChild(section)
  }

  const backBtn = document.createElement("button")
  backBtn.textContent = "Back to history"
  backBtn.className = "gowiki-content-btn"
  backBtn.style.marginTop = "16px"
  backBtn.addEventListener("click", () => void showHistory())
  container.appendChild(backBtn)

  contentRoot.appendChild(container)
}

// viewTombstonedVersion renders a single version from a specific
// tombstone, read-only. No restore button — tombstoned content belongs
// to a different page life than the one currently at this URL, so
// restoring it would mix identities.
async function viewTombstonedVersion(tombID, version, deletedWhen, tombstones) {
  try {
    const url = `/api/tombstone-version/${encodePagePath(pagePath)}?tomb=${encodeURIComponent(tombID)}&v=${version}`
    const resp = await fetch(url)
    if (!resp.ok) {
      setStatus("Failed to load archived version")
      return
    }
    const data = await resp.json()
    clearContent()

    const container = document.createElement("div")
    container.className = "gowiki-version-view"

    const header = document.createElement("div")
    header.className = "gowiki-version-header"
    header.textContent = `Archived version v${version} — from a previous page deleted on ${deletedWhen}`

    const content = document.createElement("div")
    content.className = "gowiki-version-content"
    mountReadOnlyView(content, data.markdown, "gowiki-view")

    const actions = document.createElement("div")
    actions.style.marginTop = "16px"
    actions.style.display = "flex"
    actions.style.gap = "8px"

    const backBtn = document.createElement("button")
    backBtn.textContent = "Back to archived history"
    backBtn.className = "gowiki-content-btn"
    backBtn.addEventListener("click", () => renderArchivedHistory(tombstones))
    actions.appendChild(backBtn)

    const liveBtn = document.createElement("button")
    liveBtn.textContent = "Back to current history"
    liveBtn.className = "gowiki-content-btn"
    liveBtn.addEventListener("click", () => void showHistory())
    actions.appendChild(liveBtn)

    container.appendChild(header)
    container.appendChild(content)
    container.appendChild(actions)
    contentRoot.appendChild(container)
  } catch {
    setStatus("Failed to load archived version")
  }
}

async function viewVersion(version) {
  try {
    const resp = await fetch(`/api/versions/${encodePagePath(pagePath)}?v=${version}`)
    if (!resp.ok) {
      setStatus("Failed to load version")
      return
    }
    const data = await resp.json()
    clearContent()

    const container = document.createElement("div")
    container.className = "gowiki-version-view"

    const header = document.createElement("div")
    header.className = "gowiki-version-header"
    header.textContent = `Viewing version ${version} of ${pageDisplayPath}`

    const content = document.createElement("div")
    content.className = "gowiki-version-content"
    window.__sargonViewingVersion = version
    mountReadOnlyView(content, data.markdown, "gowiki-view")
    window.__sargonViewingVersion = null
    rewriteMediaToVersioned(content, data.media_refs)

    const actions = document.createElement("div")
    actions.style.marginTop = "16px"
    actions.style.display = "flex"
    actions.style.gap = "8px"

    const backBtn = document.createElement("button")
    backBtn.textContent = "Back to history"
    backBtn.className = "gowiki-content-btn"
    backBtn.addEventListener("click", () => void showHistory())
    actions.appendChild(backBtn)

    if (historyLatestVersion == null || version < historyLatestVersion) {
      const restoreBtn = document.createElement("button")
      restoreBtn.textContent = "Restore this version"
      restoreBtn.className = "gowiki-content-btn"
      restoreBtn.addEventListener("click", () => void restoreVersion(version))
      actions.appendChild(restoreBtn)
    }

    container.append(header, content, actions)
    contentRoot.appendChild(container)
  } catch {
    setStatus("Failed to load version")
  }
}

async function showDiff(fromVersion, toVersion) {
  try {
    const resp = await fetch(`/api/diff/${encodePagePath(pagePath)}?from=${fromVersion}&to=${toVersion}`)
    if (!resp.ok) {
      setStatus("Failed to load diff")
      return
    }
    const data = await resp.json()
    clearContent()
    renderDiffView(data.hunks, fromVersion, toVersion, data.from_media_refs, data.to_media_refs)
  } catch {
    setStatus("Failed to load diff")
  }
}
// Expose for plugins — the reviewflow node's "diff since your last
// signature" side link calls window.showDiff(lastSigned, 0) when a
// signature has been invalidated and the reviewer wants to see what
// content moved. Kept as a single global rather than an event because
// showDiff owns clearContent() + renderDiffView, which need main.js's
// module-local pagePath / pageDisplayPath state.
window.showDiff = showDiff

function renderDiffView(hunks, fromVersion, toVersion, fromMediaRefs, toMediaRefs) {
  const container = document.createElement("div")
  container.className = "gowiki-diff"

  const header = document.createElement("div")
  header.className = "gowiki-diff-header"
  const fromLabel = fromVersion === 0 ? "current" : `v${fromVersion}`
  const toLabel = toVersion === -1 ? "draft" : toVersion === 0 ? "current" : `v${toVersion}`
  header.textContent = `Diff: ${fromLabel} → ${toLabel} — ${pageDisplayPath}`

  const CONTEXT_LINES = 3
  let showFull = false

  const toggleBtn = document.createElement("button")
  toggleBtn.className = "gowiki-content-btn"
  toggleBtn.style.cssText = "margin-left:12px;font-size:0.85em"
  toggleBtn.textContent = "Show full"
  header.appendChild(toggleBtn)

  const diffContent = document.createElement("div")
  diffContent.className = "gowiki-diff-content"

  function rebuildDiff() {
    diffContent.innerHTML = ""
    toggleBtn.textContent = showFull ? "Show changes only" : "Show full"

    if (showFull) {
      // Full view: show all hunks
      for (const hunk of hunks) {
        const line = document.createElement("div")
        line.className = `gowiki-diff-line gowiki-diff-${hunk.op}`
        const prefix = hunk.op === "insert" ? "+" : hunk.op === "delete" ? "-" : " "
        line.textContent = prefix + (hunk.content.endsWith("\n") ? hunk.content.slice(0, -1) : hunk.content)
        diffContent.appendChild(line)
      }
    } else {
      // Compact view: show only changes with context lines
      // Mark which hunks are within CONTEXT_LINES of a change
      const isChange = hunks.map((h) => h.op !== "equal")
      const visible = new Array(hunks.length).fill(false)

      for (let i = 0; i < hunks.length; i++) {
        if (isChange[i]) {
          for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(hunks.length - 1, i + CONTEXT_LINES); j++) {
            visible[j] = true
          }
        }
      }

      let lastShown = -1
      for (let i = 0; i < hunks.length; i++) {
        if (!visible[i]) continue

        // Insert separator if there's a gap
        if (lastShown >= 0 && i - lastShown > 1) {
          const sep = document.createElement("div")
          sep.className = "gowiki-diff-separator"
          sep.textContent = "···"
          diffContent.appendChild(sep)
        }

        const hunk = hunks[i]
        const line = document.createElement("div")
        line.className = `gowiki-diff-line gowiki-diff-${hunk.op}`
        const prefix = hunk.op === "insert" ? "+" : hunk.op === "delete" ? "-" : " "
        line.textContent = prefix + (hunk.content.endsWith("\n") ? hunk.content.slice(0, -1) : hunk.content)
        diffContent.appendChild(line)

        lastShown = i
      }

      if (diffContent.children.length === 0) {
        const noChanges = document.createElement("div")
        noChanges.style.cssText = "color:var(--gw-color-muted);font-style:italic;padding:1em"
        noChanges.textContent = "No text changes."
        diffContent.appendChild(noChanges)
      }
    }
  }

  toggleBtn.addEventListener("click", () => {
    showFull = !showFull
    rebuildDiff()
  })

  rebuildDiff()
  container.append(header, diffContent)

  // Show media version changes between the two versions.
  const mediaChanges = buildMediaChanges(fromMediaRefs, toMediaRefs)
  if (mediaChanges) container.appendChild(mediaChanges)

  const actions = document.createElement("div")
  actions.style.marginTop = "16px"
  actions.style.display = "flex"
  actions.style.gap = "8px"

  const backToHistoryBtn = document.createElement("button")
  backToHistoryBtn.textContent = "Back to history"
  backToHistoryBtn.className = "gowiki-content-btn"
  backToHistoryBtn.addEventListener("click", () => void showHistory())
  actions.appendChild(backToHistoryBtn)

  // "Back to page" short-circuits the two-click dance a reviewflow
  // "diff since v{N}" visitor used to need (diff → history → page).
  // renderView() redraws the page in whatever mode it was last in,
  // without touching the browser history — history.back() would be
  // wrong when the diff was opened directly from the reviewflow link
  // (no sentinel on the stack to pop back to).
  const backToPageBtn = document.createElement("button")
  backToPageBtn.textContent = "Back to page"
  backToPageBtn.className = "gowiki-content-btn"
  backToPageBtn.addEventListener("click", () => renderView())
  actions.appendChild(backToPageBtn)

  container.appendChild(actions)
  contentRoot.appendChild(container)
}

function buildMediaChanges(fromRefs, toRefs) {
  if (!fromRefs && !toRefs) return null
  const from = fromRefs || {}
  const to = toRefs || {}

  // Collect all media paths that differ between versions.
  const allPaths = new Set([...Object.keys(from), ...Object.keys(to)])
  const changed = []
  for (const p of allPaths) {
    const fv = from[p] ?? null
    const tv = to[p] ?? null
    if (fv !== tv) changed.push({ path: p, fromVersion: fv, toVersion: tv })
  }
  if (changed.length === 0) return null

  const section = document.createElement("div")
  section.className = "gowiki-diff-media"

  const heading = document.createElement("div")
  heading.className = "gowiki-diff-media-heading"
  heading.textContent = "Media changes"
  section.appendChild(heading)

  for (const ch of changed) {
    const row = document.createElement("div")
    row.className = "gowiki-diff-media-row"

    const label = document.createElement("div")
    label.className = "gowiki-diff-media-label"
    label.textContent = ch.path
    row.appendChild(label)

    const compare = document.createElement("div")
    compare.className = "gowiki-diff-media-compare"

    if (ch.fromVersion != null) {
      const cell = document.createElement("div")
      cell.className = "gowiki-diff-media-cell gowiki-diff-media-old"
      const caption = document.createElement("div")
      caption.className = "gowiki-diff-media-caption"
      caption.textContent = `v${ch.fromVersion}`
      const img = document.createElement("img")
      img.src = `/media/${ch.path}?v=${ch.fromVersion}`
      img.alt = `${ch.path} v${ch.fromVersion}`
      cell.append(caption, img)
      compare.appendChild(cell)
    } else {
      const cell = document.createElement("div")
      cell.className = "gowiki-diff-media-cell gowiki-diff-media-old"
      cell.textContent = "(not present)"
      compare.appendChild(cell)
    }

    const arrow = document.createElement("div")
    arrow.className = "gowiki-diff-media-arrow"
    arrow.textContent = "→"
    compare.appendChild(arrow)

    if (ch.toVersion != null) {
      const cell = document.createElement("div")
      cell.className = "gowiki-diff-media-cell gowiki-diff-media-new"
      const caption = document.createElement("div")
      caption.className = "gowiki-diff-media-caption"
      caption.textContent = `v${ch.toVersion}`
      const img = document.createElement("img")
      img.src = `/media/${ch.path}?v=${ch.toVersion}`
      img.alt = `${ch.path} v${ch.toVersion}`
      cell.append(caption, img)
      compare.appendChild(cell)
    } else {
      const cell = document.createElement("div")
      cell.className = "gowiki-diff-media-cell gowiki-diff-media-new"
      cell.textContent = "(removed)"
      compare.appendChild(cell)
    }

    row.appendChild(compare)
    section.appendChild(row)
  }

  return section
}

async function restoreVersion(version) {
  try {
    stopAutoSave()
    const resp = await fetch(`/api/versions/${encodePagePath(pagePath)}?v=${version}`)
    if (!resp.ok) {
      setStatus("Failed to load version for restore")
      return
    }
    const data = await resp.json()
    const markdown = data.markdown

    // Acquire edit token (force to supersede any existing session).
    const editResp = await authFetch(`/api/edit/${encodePagePath(pagePath)}?force=true`, {
      method: "POST",
    })
    if (!editResp.ok) {
      setStatus("Failed to acquire edit lock for restore")
      return
    }
    const token = (await editResp.json()).edit_token

    // Save restored content as draft.
    const draftResp = await authFetch(`/api/draft/${encodePagePath(pagePath)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown, edit_token: token }),
    })
    if (!draftResp.ok) {
      setStatus("Failed to save restored version as draft")
      return
    }

    // Publish immediately.
    const pubResp = await authFetch(`/api/publish/${encodePagePath(pagePath)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edit_token: token }),
    })
    if (!pubResp.ok) {
      const body = await pubResp.json().catch(() => ({}))
      setStatus(body.error || "Failed to publish restored version")
      return
    }

    // Clean up edit state and show restored page.
    editToken = null
    pageLockInfo = null
    stashedEditorState = null
    inHistoryView = false
    await reloadPageContent()
    setStatus(`Restored version ${version}`)
  } catch {
    setStatus("Failed to restore version")
  }
}

function cancelEdit() {
  if (mode !== "edit") return

  // Collab guest: just leave the session, no draft to manage.
  if (isCollabGuest) {
    isCollabGuest = false
    currentMarkdown = editBaselineMarkdown
    try {
      currentDoc = markdownToPM(currentMarkdown, registry)
    } catch {
      currentDoc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create()])
    }
    setMode("view")
    setStatus("Left editing session")
    return
  }

  // A draft is preserved if EITHER we saved during this session OR we
  // opened edit mode to resume a draft that already existed on the server.
  // In both cases, "Cancel" means "throw away unsaved edits", never
  // "delete the draft" — deletion is what the explicit "Discard draft"
  // action is for.
  const preserveDraft = draftSavedThisSession || resumedPreexistingDraft
  if (preserveDraft) {
    stashEditorState()
    // Prefer the last saved-in-this-session content, then the resumed
    // draft content (which was captured into editBaselineMarkdown on
    // entry), then a bare fall-back to the baseline.
    currentMarkdown = lastSavedDraftMarkdown || editBaselineMarkdown
    try {
      currentDoc = markdownToPM(currentMarkdown, registry)
    } catch (err) {
      console.error("Cancel failed while rebuilding document", err)
      setStatus("Cancel failed")
      return
    }
    if (currentUser) {
      pageLockInfo = { locked_by: currentUser.username, is_draft: true }
    }
    setStatus(
      draftSavedThisSession ? "Draft preserved, exiting edit mode" : "Unsaved changes discarded — draft preserved"
    )
  } else {
    // No preexisting draft and nothing was saved — the draft is just a
    // copy of published content, so discarding it costs the user nothing.
    if (editToken) {
      authFetch(`/api/draft/${encodePagePath(pagePath)}?edit_token=${encodeURIComponent(editToken)}`, {
        method: "DELETE",
      }).catch(() => {})
    }
    editToken = null
    stashedEditorState = null
    pageLockInfo = null
    currentMarkdown = editBaselineMarkdown
    try {
      currentDoc = markdownToPM(currentMarkdown, registry)
    } catch (err) {
      console.error("Cancel failed while rebuilding document", err)
      setStatus("Cancel failed")
      return
    }
    setStatus("Edit cancelled")
  }
  resumedPreexistingDraft = false
  setMode("view")
}

// ── Banner: logo resolution ──────────────────────────

async function resolveSiteInfo() {
  try {
    const resp = await fetch("/api/site/info")
    if (resp.ok) {
      const data = await resp.json()
      window.__sargonSiteInfo = data
      if (data.title) {
        siteTitle = data.title
        document.getElementById("banner-title").textContent = siteTitle
        updatePageTitle()
      }
      if (data.version) {
        siteVersion = data.version
      }
      if (typeof data.toc_max_level === "number") {
        tocMaxLevel = data.toc_max_level
      }
      if (data.code_theme || data.code_theme_dark) {
        setHighlightThemes(data.code_theme, data.code_theme_dark)
      }
      if (data.ai_assistant_enabled) {
        aiAssistantEnabled = true
      }
      if (data.theme) {
        themeAllowUserOverride = data.theme.allow_user_override !== false
        // Re-resolve in case the admin default differs from what the
        // no-flash script assumed (the script only has access to OS / cookie).
        const pref =
          currentUserThemePref ||
          (typeof localStorage !== "undefined" ? localStorage.getItem("gowiki-theme") : "") ||
          ""
        applyTheme(resolveTheme(pref, data.theme.default))
      }
    }
  } catch {
    /* keep default */
  }
}

function updatePageTitle() {
  document.title = siteTitle
  if (!contentRoot) return
  const h = contentRoot.querySelector("h1, h2, h3, h4, h5, h6")
  if (h && h.textContent.trim()) {
    document.title = `[${siteTitle}] ${h.textContent.trim()}`
  }
}

async function resolveLogo() {
  try {
    const resp = await fetch("/api/site/logo")
    if (resp.ok) {
      const data = await resp.json()
      if (data.path) {
        document.getElementById("banner-logo-img").src = "/media/" + data.path
      }
    }
  } catch {
    /* keep default */
  }
}

// ── Banner: search ──────────────────────────────────

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function initSearch() {
  const input = document.getElementById("search-input")
  const resultsEl = document.getElementById("search-results")
  let debounceTimer = null
  let activeIndex = -1
  let currentResults = []

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer)
    const query = input.value.trim()
    if (!query) {
      hideResults()
      return
    }
    debounceTimer = setTimeout(() => runSearch(query), 200)
  })

  input.addEventListener("keydown", (e) => {
    if (resultsEl.classList.contains("search-results-hidden")) return

    if (e.key === "ArrowDown") {
      e.preventDefault()
      activeIndex = Math.min(activeIndex + 1, currentResults.length - 1)
      updateActiveResult()
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      activeIndex = Math.max(activeIndex - 1, 0)
      updateActiveResult()
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (activeIndex >= 0 && activeIndex < currentResults.length) {
        navigateToSearchResult(currentResults[activeIndex].path)
      } else {
        const query = input.value.trim()
        if (query) {
          hideResults()
          window.location.href = "/?q=" + encodeURIComponent(query)
        }
      }
    } else if (e.key === "Escape") {
      hideResults()
      input.blur()
    }
  })

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#banner-search")) hideResults()
  })

  function updateActiveResult() {
    const items = resultsEl.querySelectorAll(".search-result-item")
    items.forEach((el, i) => {
      el.classList.toggle("search-result-active", i === activeIndex)
    })
    if (items[activeIndex]) {
      items[activeIndex].scrollIntoView({ block: "nearest" })
    }
  }

  async function runSearch(query) {
    try {
      const parsed = parseTagQuery(query)
      let results
      if (parsed) {
        results = await fetchTagResults(parsed.tag, parsed.rest, 8)
      } else {
        const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=8`)
        if (!resp.ok) return
        const data = await resp.json()
        results = data.results || []
      }
      currentResults = results
      activeIndex = -1
      renderSearchResults(currentResults)
    } catch {
      /* ignore */
    }
  }

  function renderSearchResults(results) {
    resultsEl.innerHTML = ""
    if (results.length === 0) {
      resultsEl.innerHTML = '<div class="search-no-results">No results</div>'
      resultsEl.classList.remove("search-results-hidden")
      return
    }
    for (const r of results) {
      const item = document.createElement("a")
      const displayPath = r.path.startsWith("/") ? r.path : "/" + r.path
      item.href = displayPath
      item.className = "search-result-item gowiki-link-exists"
      item.innerHTML =
        `<div class="search-result-title">${escapeHtml(r.title || displayPath)}</div>` +
        `<div class="search-result-path">${escapeHtml(displayPath)}</div>` +
        (r.snippet ? `<div class="search-result-snippet">${r.snippet}</div>` : "")
      item.addEventListener("click", (e) => {
        e.preventDefault()
        navigateToSearchResult(r.path)
      })
      resultsEl.appendChild(item)
    }
    resultsEl.classList.remove("search-results-hidden")
  }

  function hideResults() {
    resultsEl.classList.add("search-results-hidden")
    activeIndex = -1
    currentResults = []
  }

  function navigateToSearchResult(path) {
    const query = input.value.trim()
    const qs = query ? "?highlight=" + encodeURIComponent(query) : ""
    const url = path.startsWith("/") ? path : "/" + path
    window.location.href = url + qs
  }
}

// ── Bootstrap ───────────────────────────────────────

async function renderSearchResultsPage(query) {
  clearContent()

  const parsed = parseTagQuery(query)
  const heading = document.createElement("h1")
  heading.textContent = parsed
    ? `Pages tagged "${parsed.tag}"${parsed.rest ? ` matching "${parsed.rest}"` : ""}`
    : `Search results for "${query}"`
  heading.className = "search-page-heading"
  contentRoot.appendChild(heading)

  const container = document.createElement("div")
  container.className = "search-page-results"
  contentRoot.appendChild(container)

  try {
    let results
    if (parsed) {
      results = await fetchTagResults(parsed.tag, parsed.rest, 50)
    } else {
      const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=50`)
      if (!resp.ok) {
        container.textContent = "Search failed."
        return
      }
      const data = await resp.json()
      results = data.results || []
    }

    if (results.length === 0) {
      container.innerHTML = '<div class="search-page-empty">No results found.</div>'
      return
    }

    for (const r of results) {
      const item = document.createElement("a")
      const displayPath = r.path.startsWith("/") ? r.path : "/" + r.path
      const qs = !parsed && query ? "?highlight=" + encodeURIComponent(query) : ""
      item.href = displayPath + qs
      item.className = "search-page-item gowiki-link-exists"
      item.innerHTML =
        `<div class="search-page-item-title">${escapeHtml(r.title || displayPath)}</div>` +
        `<div class="search-page-item-path">${escapeHtml(displayPath)}</div>` +
        (r.snippet ? `<div class="search-page-item-snippet">${r.snippet}</div>` : "")
      container.appendChild(item)
    }
  } catch {
    container.textContent = "Search failed."
  }
}

// Recognize "tag:NAME [rest]" in the search box. `rest`, if present, is a
// case-insensitive substring filter applied to the tagged pages' title/path.
function parseTagQuery(query) {
  const m = (query || "").match(/^tag:(\S+)\s*(.*)$/i)
  if (!m) return null
  return { tag: m[1], rest: m[2].trim() }
}

async function fetchTagResults(tag, rest, limit) {
  const resp = await fetch(`/api/tags?tag=${encodeURIComponent(tag)}`)
  if (!resp.ok) return []
  const data = await resp.json()
  let pages = Array.isArray(data?.pages) ? data.pages : []
  if (rest) {
    const needle = rest.toLowerCase()
    pages = pages.filter(
      (p) => (p.title || "").toLowerCase().includes(needle) || (p.path || "").toLowerCase().includes(needle)
    )
  }
  return pages.slice(0, limit).map((p) => ({
    path: p.path,
    title: p.title,
    snippet: "",
  }))
}

// ── Auth ─────────────────────────────────────────────

async function checkAuth() {
  try {
    const resp = await fetch("/api/auth/me")
    if (resp.ok) {
      currentUser = await resp.json()
    } else {
      currentUser = null
    }
  } catch {
    currentUser = null
  }
  window.__sargonCurrentUser = currentUser

  // Load the user's persisted theme preference and apply it. The
  // no-flash boot script already painted something reasonable; this
  // corrects it to the user's actual preference once we know them.
  if (currentUser) {
    try {
      const prefResp = await fetch("/api/auth/me/preferences")
      if (prefResp.ok) {
        const data = await prefResp.json()
        const serverPref = data.theme_preference || ""
        // Prefer the server's answer if it has one. If the server has never
        // persisted a preference for this user, keep whatever localStorage
        // holds so we don't clobber a client-only choice.
        let localPref = ""
        try {
          localPref = localStorage.getItem("gowiki-theme") || ""
        } catch {
          /* ignore */
        }
        currentUserThemePref = serverPref || localPref
        if (serverPref) {
          try {
            localStorage.setItem("gowiki-theme", serverPref)
          } catch {
            /* ignore */
          }
        } else if (localPref) {
          // Backfill the server with the client-only pref so future loads
          // are consistent across devices.
          try {
            await fetch("/api/auth/me/preferences", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ theme_preference: localPref }),
            })
          } catch {
            /* best effort */
          }
        }
        const adminDefault =
          (window.__sargonSiteInfo && window.__sargonSiteInfo.theme && window.__sargonSiteInfo.theme.default) || "auto"
        applyTheme(resolveTheme(currentUserThemePref, adminDefault))
      }
    } catch {
      /* best effort */
    }

    // Prime the favorites set — the star button and any {favorites} view
    // read from this. A network hiccup leaves the set empty, which is fine.
    try {
      const favResp = await fetch("/api/auth/me/favorites")
      if (favResp.ok) {
        const data = await favResp.json()
        currentFavorites.clear()
        for (const f of data.favorites || []) {
          if (f && f.path) currentFavorites.add(f.path)
        }
      }
    } catch {
      /* best effort */
    }
  }

  renderBannerUser()
}

// Canonical page-path form for favorites: leading slash, trailing slash on
// namespace indexes, "/index" segments stripped. Handed to the toggle API
// and used as the local cache key.
function canonicalFavoritePath(rawPagePath) {
  let p = (rawPagePath || "").trim()
  if (!p) return "/"
  if (!p.startsWith("/")) p = "/" + p
  if (p === "/" || p === "/index") return "/"
  if (p.endsWith("/index")) return p.slice(0, -"index".length)
  return p
}

async function toggleFavoriteCurrent() {
  if (!currentUser) return
  const p = canonicalFavoritePath(pagePath)
  try {
    const resp = await fetch("/api/auth/me/favorites/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    })
    if (!resp.ok) return
    const data = await resp.json()
    if (data.favorited) currentFavorites.add(p)
    else currentFavorites.delete(p)
    window.dispatchEvent(new CustomEvent("gowiki:favorites-changed"))
    // Refresh the star button's filled state in the current toolbar.
    for (const btn of document.querySelectorAll("[data-gowiki-star]")) {
      btn.classList.toggle("gowiki-action-btn--filled", currentFavorites.has(p))
      btn.title = currentFavorites.has(p) ? "Remove from favorites" : "Add to favorites"
    }
  } catch {
    /* best effort */
  }
}

function renderBannerUser() {
  const el = document.getElementById("banner-user")
  if (!el) return
  el.innerHTML = ""
  if (currentUser) {
    const wrapper = document.createElement("div")
    wrapper.className = "banner-user-menu"

    const toggle = document.createElement("button")
    toggle.className = "banner-user-toggle"
    toggle.textContent = currentUser.username + " ▾"
    wrapper.appendChild(toggle)

    const dropdown = document.createElement("div")
    dropdown.className = "banner-user-dropdown"
    dropdown.style.display = "none"

    if (currentUser.is_admin) {
      const adminLink = document.createElement("a")
      adminLink.textContent = "Admin"
      adminLink.href = "/_admin"
      adminLink.addEventListener("click", (e) => {
        e.preventDefault()
        dropdown.style.display = "none"
        window.location.href = "/_admin"
      })
      dropdown.appendChild(adminLink)
    }
    const tokensLink = document.createElement("a")
    tokensLink.textContent = "API Tokens"
    tokensLink.addEventListener("click", (e) => {
      e.preventDefault()
      dropdown.style.display = "none"
      showMyTokensModal()
    })
    dropdown.appendChild(tokensLink)
    const signingLink = document.createElement("a")
    signingLink.textContent = "Signing Key"
    signingLink.addEventListener("click", (e) => {
      e.preventDefault()
      dropdown.style.display = "none"
      showSigningKeyModal()
    })
    dropdown.appendChild(signingLink)

    // Appearance (light / dark / auto) — hidden when admin has disabled override.
    if (themeAllowUserOverride !== false) {
      const appearanceWrap = document.createElement("div")
      appearanceWrap.className = "banner-user-appearance"
      const label = document.createElement("div")
      label.className = "banner-user-appearance-label"
      label.textContent = "Appearance"
      appearanceWrap.appendChild(label)

      const options = [
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
        { value: "auto", label: "Auto" },
      ]
      // Resolve the "current" highlight from the strongest source available:
      // server-stored pref → localStorage (last client choice) → auto.
      // This covers the case where the server hasn't persisted the user's
      // click yet (e.g. earlier deploy or silent PUT failure) but localStorage
      // reflects what theme is actually active.
      let current = currentUserThemePref
      if (!current) {
        try {
          current = localStorage.getItem("gowiki-theme") || ""
        } catch {
          /* ignore */
        }
      }
      if (!current) current = "auto"
      const seg = document.createElement("div")
      seg.className = "banner-user-appearance-seg"
      for (const opt of options) {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = "banner-user-appearance-btn" + (opt.value === current ? " is-active" : "")
        btn.textContent = opt.label
        btn.addEventListener("click", async (e) => {
          e.preventDefault()
          await setThemePreference(opt.value)
          for (const b of seg.querySelectorAll(".banner-user-appearance-btn")) {
            b.classList.toggle("is-active", b.textContent === opt.label)
          }
        })
        seg.appendChild(btn)
      }
      appearanceWrap.appendChild(seg)
      dropdown.appendChild(appearanceWrap)
    }

    const logout = document.createElement("a")
    logout.textContent = "Logout"
    logout.addEventListener("click", async (e) => {
      e.preventDefault()
      dropdown.style.display = "none"
      await fetch("/api/auth/logout", { method: "POST" })
      currentUser = null
      window.__sargonCurrentUser = null
      pageLockInfo = null
      editToken = null
      stashedEditorState = null
      renderBannerUser()
      await reloadPageContent()
    })
    dropdown.appendChild(logout)

    toggle.addEventListener("click", () => {
      dropdown.style.display = dropdown.style.display === "none" ? "flex" : "none"
    })
    document.addEventListener("click", (e) => {
      if (!wrapper.contains(e.target)) dropdown.style.display = "none"
    })

    wrapper.appendChild(dropdown)
    el.appendChild(wrapper)
  } else {
    const login = document.createElement("a")
    login.textContent = "Login"
    login.addEventListener("click", (e) => {
      e.preventDefault()
      showLoginDialog()
    })
    el.appendChild(login)
  }
}

async function showMyTokensModal() {
  const overlay = document.createElement("div")
  overlay.className = "gowiki-login-overlay"
  const dialog = document.createElement("div")
  dialog.className = "gowiki-login-dialog"
  dialog.style.maxWidth = "500px"

  const title = document.createElement("h3")
  title.textContent = "API Tokens"
  dialog.appendChild(title)

  const content = document.createElement("div")
  dialog.appendChild(content)

  async function loadTokens() {
    content.innerHTML = "Loading..."
    try {
      const resp = await authFetch("/api/tokens")
      if (!resp.ok) {
        content.textContent = "Failed to load tokens."
        return
      }
      const data = await resp.json()
      content.innerHTML = ""

      const tokens = data.tokens || []
      if (tokens.length === 0) {
        const p = document.createElement("p")
        p.textContent = "No API tokens yet."
        p.style.color = "#666"
        content.appendChild(p)
      } else {
        for (const token of tokens) {
          const row = document.createElement("div")
          row.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #eee"
          const info = document.createElement("span")
          info.style.flex = "1"
          info.innerHTML =
            "<b>" +
            (token.name || "unnamed") +
            "</b><br><small style='color:#888'>" +
            (token.last_used_at ? "Last used: " + new Date(token.last_used_at).toLocaleString() : "Never used") +
            "</small>"
          row.appendChild(info)
          const del = document.createElement("button")
          del.className = "gowiki-admin-btn-small gowiki-admin-btn-danger"
          del.textContent = "Revoke"
          del.addEventListener("click", async () => {
            if (!confirm('Revoke token "' + token.name + '"?')) return
            const r = await authFetch("/api/tokens/" + token.id, { method: "DELETE" })
            if (r.ok) loadTokens()
            else alert("Failed to revoke token.")
          })
          row.appendChild(del)
          content.appendChild(row)
        }
      }

      // Create button
      const createBtn = document.createElement("button")
      createBtn.className = "gowiki-content-btn"
      createBtn.textContent = "Create New Token"
      createBtn.style.marginTop = "12px"
      createBtn.addEventListener("click", async () => {
        const name = prompt("Token name (e.g. 'Claude assistant'):")
        if (!name) return
        const r = await authFetch("/api/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        })
        if (!r.ok) {
          const err = await r.json().catch(() => ({}))
          alert(err.error || "Failed to create token.")
          return
        }
        const result = await r.json()
        // Show the plaintext token
        const tokenDisplay = document.createElement("div")
        tokenDisplay.style.cssText =
          "margin-top:12px;padding:12px;background:#e8f5e9;border:1px solid #c8e6c9;border-radius:6px"
        tokenDisplay.innerHTML = "<b>Token created! Copy it now — it will not be shown again:</b>"
        const code = document.createElement("code")
        code.style.cssText =
          "display:block;margin-top:8px;padding:8px;background:#fff;border:1px solid #ddd;border-radius:4px;word-break:break-all;font-size:13px;user-select:all"
        code.textContent = result.token
        tokenDisplay.appendChild(code)
        content.appendChild(tokenDisplay)
        // Reload the list above (but keep the token display visible)
        setTimeout(() => loadTokens(), 0)
        // Re-append the display since loadTokens clears content
        setTimeout(() => content.appendChild(tokenDisplay), 100)
      })
      content.appendChild(createBtn)
    } catch {
      content.textContent = "Failed to load tokens."
    }
  }

  await loadTokens()

  const closeBtn = document.createElement("button")
  closeBtn.className = "gowiki-content-btn"
  closeBtn.textContent = "Close"
  closeBtn.style.marginTop = "12px"
  closeBtn.addEventListener("click", () => overlay.remove())
  dialog.appendChild(closeBtn)

  overlay.appendChild(dialog)
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove()
  })
  document.body.appendChild(overlay)
}

async function showSigningKeyModal() {
  const username = currentUser?.username
  if (!username) return

  const overlay = document.createElement("div")
  overlay.className = "gowiki-login-overlay"
  const dialog = document.createElement("div")
  dialog.className = "gowiki-login-dialog"
  dialog.style.maxWidth = "520px"

  const title = document.createElement("h3")
  title.textContent = "Document Signing Key"
  dialog.appendChild(title)

  const content = document.createElement("div")
  dialog.appendChild(content)

  async function refresh() {
    content.innerHTML = ""
    const has = await signingHasKey(username)
    let certPEM = has ? await getCertificatePEM(username) : null
    const keyCreatedAt = has ? await getKeyCreatedAt(username) : null

    // Fetch server-side view: the local IndexedDB knows only about this
    // browser, while the server owns "is this cert still valid" and "is
    // there a newer cert an admin just signed for me".
    let serverPEM = null
    let serverRevoked = false
    let serverRevokedAt = ""
    if (has) {
      try {
        const resp = await authFetch("/api/plugin/reviewflow/v1/cert/" + username)
        if (resp.ok) {
          const data = await resp.json()
          if (data.certificate_pem) {
            serverPEM = data.certificate_pem
            serverRevoked = !!data.revoked
            serverRevokedAt = data.revoked_at || ""
          }
        }
      } catch {}
    }

    // Mirror the server cert to IndexedDB — but ONLY when it's valid.
    // Importing a revoked cert would overwrite an intentionally-empty
    // local slot (right after the user generated a fresh keypair) with
    // a useless PEM, hiding the fact that the new key has never been
    // signed yet.
    if (has && serverPEM && !serverRevoked && certPEM !== serverPEM) {
      await importCertificate(username, serverPEM)
      certPEM = serverPEM
    }

    // Detect "the local key is fresher than the server's revocation" —
    // i.e. the user has already generated a new keypair after the old
    // cert was revoked, and now just needs a signature on it. In that
    // case the revocation message would be misleading: the current key
    // was never the one that got revoked.
    const localKeyIsFresh =
      keyCreatedAt && serverRevokedAt && new Date(keyCreatedAt).getTime() > new Date(serverRevokedAt).getTime()

    // Purge a stale revoked cert from IndexedDB when the local key is
    // fresh. An earlier version of this refresh code auto-imported the
    // server cert even when it was revoked, poisoning IndexedDB with
    // cert #1's PEM. Without this cleanup the "Download SPKI" button
    // never re-appears because certPEM stays truthy.
    if (localKeyIsFresh && certPEM) {
      await clearCertificate(username)
      certPEM = null
    }

    // Status
    const statusDiv = document.createElement("div")
    statusDiv.style.cssText =
      "margin-bottom:12px;padding:8px;background:var(--gw-color-surface);border:1px solid var(--gw-color-border);border-radius:6px;font-size:13px;color:var(--gw-color-text)"
    if (!has) {
      statusDiv.innerHTML = "<b>No signing key.</b> Generate one to enable cryptographic confirmations."
    } else if (serverRevoked && localKeyIsFresh) {
      statusDiv.innerHTML =
        "<b>Key generated</b> — awaiting certificate. Your previous certificate was revoked; download the public key below and have your admin sign it."
    } else if (serverRevoked) {
      const when = serverRevokedAt ? new Date(serverRevokedAt).toLocaleString() : ""
      statusDiv.innerHTML =
        "<b>Certificate revoked" +
        (when ? " on " + when : "") +
        ".</b> Signing is refused until a new certificate is issued. Ask your admin to sign a fresh public key (or delete the local key and generate a new one)."
      statusDiv.style.background = "#fdecea"
    } else if (!certPEM) {
      statusDiv.innerHTML =
        "<b>Key generated</b> — awaiting certificate. Download the public key and have your admin sign it."
    } else {
      statusDiv.innerHTML = "<b>Key + Certificate ready.</b> You can sign reviewflow confirmations."
      statusDiv.style.background = "#e8f5e9"
    }
    content.appendChild(statusDiv)

    if (!has) {
      // Generate key button
      const genBtn = document.createElement("button")
      genBtn.className = "gowiki-content-btn"
      genBtn.textContent = "Generate Signing Key"
      genBtn.addEventListener("click", async () => {
        genBtn.disabled = true
        genBtn.textContent = "Generating..."
        try {
          await generateKeypair(username)
          await refresh()
        } catch (err) {
          alert("Key generation failed: " + err.message)
          genBtn.disabled = false
          genBtn.textContent = "Generate Signing Key"
        }
      })
      content.appendChild(genBtn)
    } else {
      const btnRow = document.createElement("div")
      btnRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"

      if (!certPEM) {
        // Download public key
        const dlBtn = document.createElement("button")
        dlBtn.className = "gowiki-content-btn"
        dlBtn.textContent = "Download Public Key (SPKI)"
        dlBtn.addEventListener("click", async () => {
          const spki = await getPublicKeySPKI(username)
          if (!spki) {
            alert("No public key found")
            return
          }
          const pem =
            "-----BEGIN PUBLIC KEY-----\n" + spki.match(/.{1,64}/g).join("\n") + "\n-----END PUBLIC KEY-----\n"
          const blob = new Blob([pem], { type: "application/x-pem-file" })
          const a = document.createElement("a")
          a.href = URL.createObjectURL(blob)
          a.download = username + "-public.pem"
          a.click()
          URL.revokeObjectURL(a.href)
        })
        btnRow.appendChild(dlBtn)

        // Import certificate from file
        const importBtn = document.createElement("button")
        importBtn.className = "gowiki-content-btn"
        importBtn.textContent = "Import Certificate (PEM)"
        importBtn.addEventListener("click", () => {
          const input = document.createElement("input")
          input.type = "file"
          input.accept = ".pem,.crt,.cer"
          input.addEventListener("change", async () => {
            const file = input.files?.[0]
            if (!file) return
            const pem = await file.text()
            try {
              await importCertificate(username, pem)
              // Upload to server
              const resp = await authFetch("/api/plugin/reviewflow/v1/cert", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ certificate_pem: pem }),
              })
              if (!resp.ok) {
                const err = await resp.json().catch(() => ({}))
                alert(err.error || "Certificate upload failed")
              }
              await refresh()
            } catch (err) {
              alert("Import failed: " + err.message)
            }
          })
          input.click()
        })
        btnRow.appendChild(importBtn)
      }

      // Delete key
      const delBtn = document.createElement("button")
      delBtn.className = "gowiki-admin-btn-small gowiki-admin-btn-danger"
      delBtn.textContent = "Delete Key"
      delBtn.addEventListener("click", async () => {
        if (!confirm("Delete your signing key? This cannot be undone.")) return
        await signingDeleteKey(username)
        await refresh()
      })
      btnRow.appendChild(delBtn)

      content.appendChild(btnRow)

      // Show certificate info if available
      if (certPEM) {
        const certInfo = document.createElement("div")
        certInfo.style.cssText =
          "font-size:12px;color:#666;font-family:monospace;white-space:pre-wrap;max-height:100px;overflow:auto;background:#f5f5f5;padding:6px;border-radius:4px"
        certInfo.textContent = certPEM.substring(0, 200) + (certPEM.length > 200 ? "..." : "")
        content.appendChild(certInfo)
      }
    }
  }

  await refresh()

  const closeBtn = document.createElement("button")
  closeBtn.className = "gowiki-content-btn"
  closeBtn.textContent = "Close"
  closeBtn.style.marginTop = "12px"
  closeBtn.addEventListener("click", () => overlay.remove())
  dialog.appendChild(closeBtn)

  overlay.appendChild(dialog)
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove()
  })
  document.body.appendChild(overlay)
}

function showLoginDialog(onSuccess) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div")
    overlay.className = "gowiki-login-overlay"

    const dialog = document.createElement("div")
    dialog.className = "gowiki-login-dialog"

    const title = document.createElement("h3")
    title.textContent = "Login"

    const errorEl = document.createElement("div")
    errorEl.className = "gowiki-login-error"

    const userLabel = document.createElement("label")
    userLabel.textContent = "Username"
    const userInput = document.createElement("input")
    userInput.type = "text"
    userInput.autocomplete = "username"

    const passLabel = document.createElement("label")
    passLabel.textContent = "Password"
    const passInput = document.createElement("input")
    passInput.type = "password"
    passInput.autocomplete = "current-password"

    const actions = document.createElement("div")
    actions.className = "gowiki-login-actions"
    const cancelBtn = document.createElement("button")
    cancelBtn.textContent = "Cancel"
    const loginBtn = document.createElement("button")
    loginBtn.textContent = "Login"
    loginBtn.className = "primary"

    function close(success) {
      overlay.remove()
      resolve(success)
    }

    async function submit() {
      errorEl.style.display = "none"
      const username = userInput.value.trim()
      const password = passInput.value
      if (!username || !password) {
        errorEl.textContent = "Username and password required"
        errorEl.style.display = "block"
        return
      }
      try {
        const resp = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        })
        if (resp.ok) {
          await checkAuth()
          if (onSuccess) onSuccess()
          close(true)
          await reloadPageContent()
        } else {
          errorEl.textContent = "Invalid credentials"
          errorEl.style.display = "block"
          passInput.value = ""
          passInput.focus()
        }
      } catch {
        errorEl.textContent = "Login failed"
        errorEl.style.display = "block"
      }
    }

    cancelBtn.addEventListener("click", () => close(false))
    loginBtn.addEventListener("click", submit)
    passInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit()
    })
    userInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") passInput.focus()
    })
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false)
    })

    actions.append(cancelBtn, loginBtn)
    dialog.append(title, errorEl, userLabel, userInput, passLabel, passInput, actions)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    // Fetch OAuth providers and add buttons if available.
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((data) => {
        if (data.providers && data.providers.length > 0) {
          const oauthSection = document.createElement("div")
          oauthSection.className = "gowiki-login-oauth"
          for (const provider of data.providers) {
            const btn = document.createElement("button")
            btn.className = "gowiki-login-oauth-btn"
            btn.textContent = "Sign in with " + provider.label
            btn.addEventListener("click", () => {
              const returnTo = encodeURIComponent(window.location.pathname)
              window.location.href = "/api/auth/oauth/login?return_to=" + returnTo
            })
            oauthSection.appendChild(btn)
          }
          const divider = document.createElement("div")
          divider.className = "gowiki-login-divider"
          divider.textContent = "or sign in with username"
          // Insert OAuth buttons before the local login form.
          dialog.insertBefore(oauthSection, errorEl)
          dialog.insertBefore(divider, errorEl)
        }
      })
      .catch(() => {
        /* OAuth not available, local-only login */
      })

    userInput.focus()
  })
}

// Wraps a write API call: if it returns 401, shows login dialog and retries.
async function authFetch(url, options) {
  let resp = await fetch(url, options)
  if (resp.status === 401) {
    const loggedIn = await showLoginDialog()
    if (loggedIn) {
      resp = await fetch(url, options)
    }
  }
  return resp
}
// Expose for media_manager.js
window.__sargonAuthFetch = authFetch
window.__sargonCurrentUser = null
window.__sargonCurrentMarkdown = () => currentMarkdown

// Expose global variable context for the template_var resolver.
window.__sargonGlobalVarContext = () => ({
  pagePath: "/" + pagePath,
  pageNamespace: pageNamespace ? "/" + pageNamespace : "/",
  pageName: pagePath.includes("/") ? pagePath.split("/").pop().replace(/_/g, " ") : pagePath.replace(/_/g, " "),
  pageMeta: currentPageMeta,
  siteTitle,
  siteVersion,
})

async function reloadPageContent() {
  // Admin page is a virtual route — re-render it instead of fetching a wiki page.
  if (pagePath === "_admin") {
    if (currentUser && currentUser.is_admin) {
      renderAdminPage()
    } else {
      contentRoot.innerHTML = ""
      actionsRoot.innerHTML = ""
      const msg = document.createElement("div")
      msg.style.padding = "40px 20px"
      msg.style.textAlign = "center"
      msg.style.color = "#666"
      msg.style.fontSize = "16px"
      msg.textContent = currentUser
        ? "Access denied. Admin privileges required."
        : "Please log in with an admin account to access this page."
      contentRoot.appendChild(msg)
    }
    return
  }

  const page = await fetchPage(pagePath)
  if (page) {
    currentMarkdown = page.markdown
    isNewPage = false
    hasTemplate = false
    currentPageVersion = page.meta?.version || 0
    currentPageMeta = page.meta || null
    pageLockInfo = null
    if (page.locked_by) {
      pageLockInfo = { locked_by: page.locked_by, is_draft: !!page.is_draft }
    }
    // Populate media version cache from page response.
    if (page.media_versions) {
      for (const [absPath, ver] of Object.entries(page.media_versions)) {
        window.__sargonUpdateMediaVersionCache(absPath, ver)
      }
    }
  } else {
    // Page doesn't exist — show the "does not exist" view. Templates are
    // offered only when the user enters edit mode (inside enterEditMode).
    currentMarkdown = defaultMarkdown
    hasTemplate = false
    isNewPage = true
    currentPageVersion = 0
    currentPageMeta = null
    pageLockInfo = null
  }

  isNamespaceIndex = !!(page && page.is_namespace_index)
  // Update pageNamespace based on authoritative backend flag.
  if (isNamespaceIndex) {
    pageNamespace = pagePath === "index" ? "" : pagePath
  }

  currentDoc = markdownToPM(currentMarkdown, registry)
  setMode("view")

  // Re-mount sidebar and footer so dynamic content (e.g. recent changes) refreshes.
  refreshZones()
}

// ── Draft / Edit mode API ────────────────────────────

let isCollabGuest = false // true when co-editing without owning the lock

async function joinCollabSession(lockOwner) {
  // Join an existing edit session without acquiring a lock.
  // Fetch the lock owner's draft so we start with the same content.
  isCollabGuest = true
  editToken = null
  stashedEditorState = null
  draftSavedThisSession = false
  lastSavedDraftMarkdown = null
  resumedPreexistingDraft = false

  // Fetch the current draft content so we start with the same document.
  try {
    const resp = await authFetch(`/api/collab/draft/${encodePagePath(pagePath)}`)
    if (resp.ok) {
      const data = await resp.json()
      if (data.markdown) {
        currentMarkdown = data.markdown
      }
    }
  } catch {
    // Fall back to published content if we can't read the draft.
  }

  try {
    currentDoc = markdownToPM(currentMarkdown, registry)
  } catch (err) {
    console.error("Failed to parse markdown for collab join:", err)
    currentDoc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create()])
    editMode = "raw"
  }
  setMode("edit")

  // Start the collab session with the draft content.
  startCollabSession(currentMarkdown)

  // Send initial position immediately (block 0) so the other user sees us.
  currentEditBlock = 0
  sendPresenceUpdate()

  // Focus the editor after it's mounted.
  setTimeout(() => {
    if (editMode === "visual" && editorView) {
      editorView.focus()
    } else if (editMode === "raw" && rawEditor) {
      rawEditor.focus()
      rawEditor.setSelectionRange(0, 0)
    }
    updateEditOffset()
  }, 500)

  // Check if the owner is actually online. If not, offer to reclaim after 3s.
  setTimeout(() => {
    if (!isCollabGuest) return // already promoted
    const ownerOnline = currentPresenceUsers.some((u) => u.username === lockOwner && u.mode === "edit")
    if (!ownerOnline) {
      handleOwnerLeft(lockOwner)
    }
  }, 3000)

  setStatus(`Joined ${lockOwner}'s editing session`)
  return true
}

function stashEditorState() {
  if (editorView) {
    stashedEditorState = editorView.state
  }
}

async function enterEditMode(force, asNamespaceIndex = false) {
  // Detect a preexisting draft we're about to resume — the page metadata
  // that fed pageLockInfo would have flagged is_draft when we loaded, and
  // if the lock is ours the /api/edit call will hand back that draft's
  // content, not a fresh copy of the published version. Cancel treats
  // "resumed" like "saved this session" so it never silently discards a
  // draft the user only opened to peek at.
  const willResumePreexistingDraft = !!(
    pageLockInfo &&
    pageLockInfo.is_draft &&
    currentUser &&
    pageLockInfo.locked_by === currentUser.username
  )

  // If we still have a valid edit token (saved-to-draft without exiting the session),
  // verify the token is still valid before resuming (draft may have been reclaimed).
  if (editToken && stashedEditorState) {
    const checkResp = await authFetch(`/api/draft/${encodePagePath(pagePath)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: currentMarkdown, edit_token: editToken }),
    })
    if (checkResp.ok) {
      draftSavedThisSession = true
      setMode("edit")
      return true
    }
    // Token is no longer valid — draft was reclaimed. Clear stale state and fall through.
    editToken = null
    stashedEditorState = null
    pageLockInfo = null
  }

  const forceParam = force ? "?force=true" : ""
  // If creating a namespace index, append trailing slash to signal the backend.
  // Detect from parameter or from current URL (user navigated to /path/ directly).
  const urlHasTrailingSlash = window.location.pathname.endsWith("/") && window.location.pathname !== "/"
  const createAsNamespace = asNamespaceIndex || (isNewPage && urlHasTrailingSlash)
  const editPath = createAsNamespace ? encodePagePath(pagePath) + "/" : encodePagePath(pagePath)

  // For a new page, let the user pick a template (if any apply) before we
  // ask the backend to set up the draft. The chosen markdown (or null for
  // a blank page) is passed to /api/edit so the backend doesn't re-resolve.
  let initialMarkdown = null
  let initialMarkdownChosen = false
  if (isNewPage) {
    initialMarkdown = await selectTemplateForNewPage(pagePath)
    initialMarkdownChosen = true
  }

  const fetchOpts = { method: "POST" }
  if (initialMarkdownChosen) {
    fetchOpts.headers = { "Content-Type": "application/json" }
    fetchOpts.body = JSON.stringify({ initial_markdown: initialMarkdown || "" })
  }
  const resp = await authFetch(`/api/edit/${editPath}${forceParam}`, fetchOpts)
  if (resp.status === 423) {
    const body = await resp.json()
    const lockOwner = body.locked_by || "another user"
    if (confirm(`Page is being edited by ${lockOwner}. Join their editing session?`)) {
      return joinCollabSession(lockOwner)
    }
    return false
  }
  if (resp.status === 409) {
    const body = await resp.json().catch(() => ({}))
    if (body.error === "namespace_conflict" && body.conflicting_page) {
      const convertOk = confirm(
        `Cannot create this page: "${body.conflicting_page}" exists as a regular page and blocks this namespace.\n\n` +
          `Convert "${body.conflicting_page}" to a namespace index?\n` +
          `(The page content will be preserved, only its internal path changes.)`
      )
      if (convertOk) {
        const moveResp = await authFetch(`/api/move/${encodePagePath(body.conflicting_page)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to_namespace_index: true }),
        })
        if (moveResp.ok) {
          setStatus(`Converted "${body.conflicting_page}" to namespace index`)
          // Retry entering edit mode now that the conflict is resolved.
          return enterEditMode(force)
        } else {
          const err = await moveResp.json().catch(() => ({}))
          setStatus(`Failed to convert: ${err.error || moveResp.status}`, true)
          return false
        }
      }
      return false
    }
    if (body.error && body.error.includes("conflict")) {
      setStatus(body.message || body.error)
      return false
    }
    const ok = confirm("You already have this page open in another session. Force edit?")
    if (ok) return enterEditMode(true)
    return false
  }
  if (resp.status === 401) {
    return false
  }
  if (!resp.ok) {
    setStatus("Failed to enter edit mode")
    return false
  }
  const data = await resp.json()
  editToken = data.edit_token
  stashedEditorState = null // new session — discard any old stash
  draftSavedThisSession = false
  lastSavedDraftMarkdown = willResumePreexistingDraft ? data.markdown : null
  resumedPreexistingDraft = willResumePreexistingDraft
  currentMarkdown = data.markdown

  // Update namespace index flag if we just created a namespace index.
  if (createAsNamespace) {
    isNamespaceIndex = true
  }

  try {
    currentDoc = markdownToPM(currentMarkdown, registry)
  } catch (err) {
    console.error("Failed to parse draft markdown:", err)
    currentDoc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create()])
    editMode = "raw"
  }
  setMode("edit")

  // Start collaborative editing session.
  startCollabSession(currentMarkdown)

  // Send initial cursor position.
  setTimeout(() => updateEditOffset(), 200)

  // Restore cursor position from a previous editing session.
  restoreCursorFromLocalStorage()
  return true
}

function getCurrentMarkdown() {
  if (mode !== "edit") return currentMarkdown
  if (editMode === "visual" && editorView) {
    return pmToMarkdown(editorView.state.doc, registry)
  }
  if (editMode === "raw" && rawEditor) {
    return rawEditor.value
  }
  return currentMarkdown
}

// Shows a modal when the edit session has been superseded by another tab.
// Returns "force" if the user wants to retake editing, "discard" otherwise.
function promptSupersededDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div")
    overlay.className = "gowiki-link-modal-overlay"

    const dialog = document.createElement("div")
    dialog.className = "gowiki-link-modal"

    const title = document.createElement("div")
    title.className = "gowiki-link-modal-title"
    title.textContent = "Edit session superseded"

    const msg = document.createElement("div")
    msg.style.cssText = "margin: 8px 0 16px; color: #b00020;"
    msg.textContent = "Another tab took over editing this page. Your changes here may be lost."

    const buttons = document.createElement("div")
    buttons.className = "gowiki-link-modal-actions"

    const forceBtn = document.createElement("button")
    forceBtn.type = "button"
    forceBtn.className = "gowiki-link-modal-btn"
    forceBtn.textContent = "Force save & continue"

    const discardBtn = document.createElement("button")
    discardBtn.type = "button"
    discardBtn.className = "gowiki-link-modal-btn"
    discardBtn.textContent = "Discard my changes"

    function close(value) {
      overlay.remove()
      resolve(value)
    }

    forceBtn.addEventListener("click", () => close("force"))
    discardBtn.addEventListener("click", () => close("discard"))
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close("discard")
    })

    buttons.appendChild(forceBtn)
    buttons.appendChild(discardBtn)
    dialog.appendChild(title)
    dialog.appendChild(msg)
    dialog.appendChild(buttons)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
  })
}

// Handles a 409 superseded response during editing.
// If the user chooses to force, retakes the edit token and saves the current
// editor content (without rebuilding the editor or losing unsaved work).
// Returns true if the user forced and the save succeeded, false if discarded.
async function handleSuperseded() {
  stopAutoSave()
  const choice = await promptSupersededDialog()
  if (choice !== "force") {
    editToken = null
    stashedEditorState = null
    await reloadPageContent()
    setMode("view")
    return false
  }
  // Force-retake the edit token via API — do NOT call enterEditMode()
  // which would rebuild the editor and lose the current unsaved content.
  const resp = await authFetch(`/api/edit/${encodePagePath(pagePath)}?force=true`, {
    method: "POST",
  })
  if (!resp.ok) {
    setStatus("Failed to retake edit session")
    editToken = null
    setMode("view")
    return false
  }
  const data = await resp.json()
  editToken = data.edit_token

  // Save the current editor content with the new token.
  const markdown = getCurrentMarkdown()
  const saveResp = await authFetch(`/api/draft/${encodePagePath(pagePath)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown, edit_token: editToken }),
  })
  if (!saveResp.ok) {
    setStatus("Failed to save after retaking edit session")
    editToken = null
    setMode("view")
    return false
  }
  draftSavedThisSession = true
  lastSavedDraftMarkdown = markdown
  startAutoSave()
  setStatus(`Edit session retaken — draft saved ${new Date().toLocaleTimeString()}`)
  return true
}

async function autoSaveDraft() {
  if (mode !== "edit" || !editToken) return
  const markdown = getCurrentMarkdown()
  try {
    const resp = await fetch(`/api/draft/${encodePagePath(pagePath)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown, edit_token: editToken }),
    })
    if (resp.status === 409) {
      await handleSuperseded()
      return
    }
    if (resp.ok) {
      draftSavedThisSession = true
      lastSavedDraftMarkdown = markdown
      saveCursorToLocalStorage()
      setStatus(`Draft auto-saved ${new Date().toLocaleTimeString()}`)
    }
  } catch {
    // silent failure for auto-save
  }
}

function startAutoSave() {
  stopAutoSave()
  autoSaveTimer = setInterval(autoSaveDraft, 2 * 60 * 1000)
}

function stopAutoSave() {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer)
    autoSaveTimer = null
  }
}

async function saveDraftExplicit() {
  if (mode !== "edit" || !editToken) return
  const markdown = getCurrentMarkdown()
  const dbValidation = await validateDatabaseRows(markdown)
  if (!dbValidation.valid) {
    setStatus(dbValidation.errors.join("; "))
    return
  }
  const resp = await authFetch(`/api/draft/${encodePagePath(pagePath)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown, edit_token: editToken }),
  })
  if (resp.status === 409) {
    await handleSuperseded()
    return
  }
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    setStatus(body.error || "Save failed")
    return
  }
  draftSavedThisSession = true
  lastSavedDraftMarkdown = markdown
  saveCursorToLocalStorage()
  setStatus(`Draft saved ${new Date().toLocaleTimeString()}`)
}

async function publishDraft() {
  if (mode !== "edit" || !editToken) return
  // Save draft content first
  const markdown = getCurrentMarkdown()
  let normalized
  try {
    normalized = normalizeMarkdownForStorage(markdown)
  } catch (err) {
    setStatus("Invalid Markdown — cannot publish: " + (err.message || err), true, err.stack || String(err))
    return
  }
  if (normalized.roundTripError) {
    const lineRef =
      normalized.roundTripFirstDiffLine > 0 ? ` (first diff at line ${normalized.roundTripFirstDiffLine})` : ""
    setStatus(
      "Document failed round-trip validation — cannot publish" + lineRef + ".",
      true,
      normalized.roundTripDiagnostics || "(no diagnostic captured)"
    )
    return
  }
  const dbValidation = await validateDatabaseRows(normalized.markdown)
  if (!dbValidation.valid) {
    setStatus(dbValidation.errors.join("; "))
    return
  }
  // Save draft with latest content
  const draftResp = await authFetch(`/api/draft/${encodePagePath(pagePath)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown: normalized.markdown, edit_token: editToken }),
  })
  if (!draftResp.ok) {
    if (draftResp.status === 409) {
      await handleSuperseded()
    } else {
      setStatus("Failed to save draft before publish")
    }
    return
  }
  // Publish
  const resp = await authFetch(`/api/publish/${encodePagePath(pagePath)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edit_token: editToken }),
  })
  if (resp.status === 409) {
    const body = await resp.json().catch(() => ({}))
    if (body.error === "database_row_conflict") {
      // A forced inline edit changed the published page while the draft was open.
      const msg = `The database row (table: ${body.table}) was modified by an inline edit while you were editing.\n\nForce publish with your values?`
      if (confirm(msg)) {
        // Retry publish with force_publish flag.
        const retryResp = await authFetch(`/api/publish/${encodePagePath(pagePath)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ edit_token: editToken, force_publish: true }),
        })
        if (retryResp.ok) {
          const result = await retryResp.json()
          editToken = null
          pageLockInfo = null
          stashedEditorState = null
          resumedPreexistingDraft = false
          clearCursorLocalStorage()
          applyNormalizedEditState(normalized)
          editBaselineMarkdown = normalized.markdown
          isNewPage = false
          hasTemplate = false
          if (result.page?.meta) {
            currentPageMeta = result.page.meta
            currentPageVersion = result.page.meta.version || 0
          }
          setStatus(`Published (forced) ${new Date().toLocaleTimeString()}`)
          if (result.orphaned_media && result.orphaned_media.length > 0) {
            promptOrphanDeletion(result.orphaned_media)
          }
          setMode("view")
        } else {
          setStatus("Force publish failed")
        }
      }
      return
    }
    // Retake token and retry publish if user chooses to force.
    const retook = await handleSuperseded()
    if (retook) {
      // Token was retaken and content saved as draft — now retry publish.
      await publishDraft()
    }
    return
  }
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    setStatus(body.error || "Publish failed")
    return
  }
  const result = await resp.json()
  editToken = null
  pageLockInfo = null
  stashedEditorState = null
  resumedPreexistingDraft = false
  clearCursorLocalStorage()
  applyNormalizedEditState(normalized)
  editBaselineMarkdown = normalized.markdown
  isNewPage = false
  hasTemplate = false
  // Update metadata from the publish response so global variables resolve immediately.
  if (result.page?.meta) {
    currentPageMeta = result.page.meta
    currentPageVersion = result.page.meta.version || 0
  }
  setStatus(`Published ${new Date().toLocaleTimeString()}`)
  // Strip AI comments on publish.
  clearAIComments()

  if (result.orphaned_media && result.orphaned_media.length > 0) {
    promptOrphanDeletion(result.orphaned_media)
  }
  setMode("view")
  refreshZones()
}

function refreshZones() {
  if (sidebarView) {
    sidebarView.destroy()
    sidebarView = null
  }
  sidebarRoot.innerHTML = ""
  fetchAndMountZone("sidebar", sidebarRoot, "gowiki-sidebar").then((v) => {
    sidebarView = v
  })
  if (footerView) {
    footerView.destroy()
    footerView = null
  }
  footerRoot.innerHTML = ""
  fetchAndMountZone("footer", footerRoot, "gowiki-footer").then((v) => {
    footerView = v
  })
}

async function discardDraft() {
  const hasChanges = currentMarkdown !== editBaselineMarkdown
  const msg = hasChanges
    ? "Discard draft and lose all unpublished changes?"
    : "The draft has no changes from the published version. Discard?"
  if (!confirm(msg)) return
  const tokenParam = editToken ? `?edit_token=${encodeURIComponent(editToken)}` : ""
  const resp = await authFetch(`/api/draft/${encodePagePath(pagePath)}${tokenParam}`, {
    method: "DELETE",
  })
  if (resp.status === 409) {
    setStatus("Another editing session is active — cannot discard")
    return
  }
  if (resp.ok) {
    editToken = null
    pageLockInfo = null
    stashedEditorState = null
    resumedPreexistingDraft = false
    clearCursorLocalStorage()
    // Reload published content.
    const page = await fetchPage(pagePath)
    if (page) {
      currentMarkdown = page.markdown
      currentDoc = markdownToPM(currentMarkdown, registry)
      if (page.media_versions) {
        for (const [absPath, ver] of Object.entries(page.media_versions)) {
          window.__sargonUpdateMediaVersionCache(absPath, ver)
        }
      }
    }
    setStatus("Draft discarded")
    setMode("view")
  }
}

async function publishDraftFromHistory() {
  // Enter edit mode to get a token, then immediately publish.
  const forceParam = "?force=true"
  const editResp = await authFetch(`/api/edit/${encodePagePath(pagePath)}${forceParam}`, {
    method: "POST",
  })
  if (!editResp.ok) {
    setStatus("Failed to enter edit mode for publish")
    return
  }
  const editData = await editResp.json()
  const token = editData.edit_token

  const resp = await authFetch(`/api/publish/${encodePagePath(pagePath)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edit_token: token }),
  })
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    setStatus(body.error || "Publish failed")
    return
  }

  editToken = null
  pageLockInfo = null
  stashedEditorState = null
  resumedPreexistingDraft = false
  clearCursorLocalStorage()
  await reloadPageContent()
  setStatus("Draft published")
  showHistory()
}

async function discardDraftFromHistory(hasChanges) {
  const msg =
    hasChanges === false
      ? "The draft has no changes from the published version. Discard?"
      : "Discard draft and lose all unpublished changes?"
  if (!confirm(msg)) return

  const tokenParam = editToken ? `?edit_token=${encodeURIComponent(editToken)}` : ""
  const resp = await authFetch(`/api/draft/${encodePagePath(pagePath)}${tokenParam}`, {
    method: "DELETE",
  })
  if (resp.status === 409) {
    setStatus("Another editing session is active — cannot discard")
    return
  }
  if (resp.ok) {
    editToken = null
    pageLockInfo = null
    stashedEditorState = null
    resumedPreexistingDraft = false
    clearCursorLocalStorage()
    await reloadPageContent()
    setStatus("Draft discarded")
    showHistory()
  }
}

async function adminForceDiscardDraft(draftOwner) {
  const msg = `Discard ${draftOwner}'s draft on ${pageDisplayPath}? This is irreversible and will be logged.`
  if (!confirm(msg)) return

  const resp = await authFetch(`/api/admin/drafts/${encodePagePath(pagePath)}`, {
    method: "DELETE",
  })
  if (resp.ok) {
    pageLockInfo = null
    await reloadPageContent()
    setStatus(`Draft by ${draftOwner} discarded (admin override)`)
    showHistory()
  } else {
    const body = await resp.json().catch(() => ({}))
    setStatus(body.error || "Force discard failed")
  }
}

async function saveDraftAndExit() {
  await saveDraftExplicit()
  // Overwrite the terse "Draft saved <time>" message from
  // saveDraftExplicit with something a first-time user actually finds
  // reassuring — the page is theirs now (locked) but nothing here is
  // visible to anyone else until they hit Publish. The bare status
  // otherwise reads as if the save were the final act.
  setStatus(
    `Draft saved ${new Date().toLocaleTimeString()} — page locked to you; changes stay private until you click Publish draft.`
  )
  // Stash editor state so undo survives resume.
  stashEditorState()
  // Keep editToken — we'll reuse it on resume.
  // Update currentMarkdown/currentDoc from editor so view mode shows latest content.
  if (lastSavedDraftMarkdown) {
    currentMarkdown = lastSavedDraftMarkdown
    try {
      currentDoc = markdownToPM(currentMarkdown, registry)
    } catch (err) {
      console.error("saveDraftAndExit: markdown parse failed", err)
      setStatus("Invalid Markdown in draft — " + (err.message || err), true, err.stack || String(err))
      return
    }
  }
  // Update lock info so the draft banner shows immediately.
  if (currentUser) {
    pageLockInfo = { locked_by: currentUser.username, is_draft: true }
  }
  setMode("view")
}

// ── Admin Page ────────────────────────────────────────

async function renderSitemapPage() {
  clearContent()
  const container = document.createElement("div")
  container.className = "gowiki-sitemap"

  const title = document.createElement("h2")
  title.textContent = "Site map"
  container.appendChild(title)

  // Parse ?from=… and build the set of ancestor namespaces to auto-expand.
  // /regulatory/suivi/livrables → we want to open regulatory and suivi (but
  // not livrables — it's a leaf, not a namespace). The set contains the
  // NAMESPACE paths as they appear in the sitemap tree (no trailing slash,
  // leading slash present).
  const fromRaw = new URLSearchParams(window.location.search).get("from") || ""
  const openNs = new Set()
  const targetLeaf = fromRaw
  if (fromRaw && fromRaw !== "/") {
    const parts = fromRaw.replace(/^\/+/, "").replace(/\/+$/, "").split("/").filter(Boolean)
    // For a page /a/b/c the ancestor namespaces are /a and /a/b. If the URL
    // ended with a slash (a namespace index page), the last segment is also
    // an ancestor that should be opened.
    const isNs = fromRaw.endsWith("/")
    const upto = isNs ? parts.length : parts.length - 1
    let acc = ""
    for (let i = 0; i < upto; i++) {
      acc += "/" + parts[i]
      openNs.add(acc)
    }
  }

  try {
    const resp = await fetch("/api/sitemap")
    if (!resp.ok) throw new Error("Failed to load sitemap")
    const data = await resp.json()
    const pages = data.pages || []

    function nodeUrl(node) {
      if (node.path === "/" || node.path === "/index" || node.path === "index") return "/"
      const hasChildren = node.children && node.children.length > 0
      // Namespace-index paths already end with "/" in canonical form, so
      // strip any trailing slash before appending — otherwise the URL
      // gets a double-slash like /regulatory/qms/qara/sop03//.
      if (node.is_namespace_index || hasChildren) {
        return node.path.replace(/\/+$/, "") + "/"
      }
      return node.path
    }

    function leafName(node) {
      if (node.path === "/" || node.path === "/index" || node.path === "index") return "/"
      // Same guard as nodeUrl — namespace-index paths carry a trailing
      // slash canonically, so split("/").pop() would give "" instead of
      // the last segment.
      const stripped = node.path.replace(/\/+$/, "")
      const leaf = stripped.split("/").pop()
      const hasChildren = node.children && node.children.length > 0
      if (node.is_namespace_index || hasChildren) return leaf + "/"
      return leaf
    }

    function buildTree(nodes, parentUl, depth) {
      // First pass: build all items, collect path elements for alignment.
      const pathElements = []

      for (const node of nodes) {
        // Skip namespace index children — they are merged into the parent namespace label.
        if (node.is_namespace_index && node.path !== "/") continue

        const li = document.createElement("li")
        const hasChildren = node.children && node.children.length > 0
        const isPhantom = !node.has_page
        const isRoot = node.path === "/"

        // Check if this namespace has an index page among its children.
        const nsIndex = hasChildren ? node.children.find((c) => c.is_namespace_index) : null
        // If the namespace has an index page, treat the namespace as having a page.
        const effectiveHasPage = node.has_page || !!nsIndex

        // Auto-expand ancestors of the referring page (?from=\u2026).
        const openInitially = isRoot || openNs.has(node.path)

        if (hasChildren) {
          const toggle = document.createElement("span")
          toggle.className = "gowiki-sitemap-toggle"
          toggle.textContent = openInitially ? "\u25BE" : "\u25B8"
          toggle.addEventListener("click", () => {
            const childUl = li.querySelector(":scope > ul")
            if (childUl) {
              const hidden = childUl.style.display === "none"
              childUl.style.display = hidden ? "" : "none"
              toggle.textContent = hidden ? "\u25BE" : "\u25B8"
            }
          })
          li.appendChild(toggle)
        } else {
          const spacer = document.createElement("span")
          spacer.className = "gowiki-sitemap-spacer"
          li.appendChild(spacer)
        }

        const row = document.createElement("span")
        row.className = "gowiki-sitemap-row"

        const label = leafName(node)
        if (isPhantom && !nsIndex) {
          const span = document.createElement("span")
          span.className = "gowiki-sitemap-path gowiki-sitemap-phantom"
          span.textContent = label
          pathElements.push(span)
          row.appendChild(span)
        } else {
          const url = nsIndex ? nodeUrl(nsIndex) : nodeUrl(node)
          const a = document.createElement("a")
          a.href = url
          a.className = "gowiki-sitemap-path gowiki-link-exists"
          a.textContent = label
          a.addEventListener("click", (e) => {
            e.preventDefault()
            window.location.href = url
          })
          pathElements.push(a)
          row.appendChild(a)
        }

        const displayTitle = nsIndex ? nsIndex.title || node.title || "" : node.title || ""
        if (effectiveHasPage && displayTitle) {
          const titleSpan = document.createElement("span")
          titleSpan.className = "gowiki-sitemap-title"
          titleSpan.textContent = displayTitle
          row.appendChild(titleSpan)
        }

        li.appendChild(row)

        if (hasChildren) {
          const childUl = document.createElement("ul")
          if (!openInitially) childUl.style.display = "none"
          buildTree(node.children, childUl, depth + 1)
          li.appendChild(childUl)
        }

        // Highlight the row that matches the referring page so the user's
        // eye lands where they came from.
        if (targetLeaf && (node.path === targetLeaf || node.path + "/" === targetLeaf)) {
          row.classList.add("gowiki-sitemap-current")
        }
        parentUl.appendChild(li)
      }

      // Second pass: align path column within this level.
      if (pathElements.length > 0) {
        let maxLen = 0
        for (const el of pathElements) maxLen = Math.max(maxLen, el.textContent.length)
        parentUl.style.setProperty("--path-width", maxLen + 2 + "ch")
      }
    }

    const ul = document.createElement("ul")
    buildTree(pages, ul, 0)
    container.appendChild(ul)
  } catch (err) {
    const msg = document.createElement("div")
    msg.style.color = "#d63031"
    msg.textContent = "Failed to load sitemap."
    container.appendChild(msg)
  }

  contentRoot.appendChild(container)
}

function renderAdminPage() {
  contentRoot.innerHTML = ""
  actionsRoot.innerHTML = ""

  actionsRoot.appendChild(
    makeActionIconBtn("backlinks", "Back to Wiki", () => {
      window.location.href = "/"
    })
  )

  // Tab bar
  const tabBar = document.createElement("div")
  tabBar.className = "gowiki-admin-tabs"

  const tabContent = document.createElement("div")
  tabContent.className = "gowiki-admin-content"

  const tabs = ["Users", "Groups", "ACL", "Locks", "Tokens", "Certificates", "Configuration", "Database", "Todo"]
  let activeTab = "Users"

  function renderTabBar() {
    tabBar.innerHTML = ""
    for (const name of tabs) {
      const btn = document.createElement("button")
      btn.className = "gowiki-admin-tab" + (name === activeTab ? " gowiki-admin-tab-active" : "")
      btn.textContent = name
      btn.addEventListener("click", () => switchTab(name))
      tabBar.appendChild(btn)
    }
  }

  function switchTab(name) {
    activeTab = name
    renderTabBar()
    loadTab(name)
  }

  function loadTab(name) {
    tabContent.innerHTML = ""
    switch (name) {
      case "Users":
        renderAdminUsersTab(tabContent)
        break
      case "Groups":
        renderAdminGroupsTab(tabContent)
        break
      case "ACL":
        renderAdminACLTab(tabContent)
        break
      case "Locks":
        renderAdminLocksTab(tabContent)
        break
      case "Tokens":
        renderAdminTokensTab(tabContent)
        break
      case "Certificates":
        renderAdminCertsTab(tabContent)
        break
      case "Configuration":
        renderAdminConfigTab(tabContent)
        break
      case "Database":
        renderAdminDatabaseTab(tabContent)
        break
      case "Todo":
        renderAdminTodoTab(tabContent)
        break
    }
  }

  renderTabBar()
  loadTab("Users")

  contentRoot.appendChild(tabBar)
  contentRoot.appendChild(tabContent)
}

// ── Admin: Modal helper ───────────────────────────────

function showAdminModal(title, buildContent) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div")
    overlay.className = "gowiki-admin-modal-overlay"

    const dialog = document.createElement("div")
    dialog.className = "gowiki-admin-modal"

    const h3 = document.createElement("h3")
    h3.textContent = title
    dialog.appendChild(h3)

    const errorEl = document.createElement("div")
    errorEl.className = "gowiki-admin-modal-error"
    dialog.appendChild(errorEl)

    function showError(msg) {
      errorEl.textContent = msg
      errorEl.style.display = "block"
    }

    function close(result) {
      overlay.remove()
      resolve(result)
    }

    const body = document.createElement("div")
    body.className = "gowiki-admin-modal-body"
    dialog.appendChild(body)

    buildContent(body, close, showError)

    overlay.appendChild(dialog)
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null)
    })
    document.addEventListener("keydown", function handler(e) {
      if (e.key === "Escape") {
        document.removeEventListener("keydown", handler)
        close(null)
      }
    })
    document.body.appendChild(overlay)
  })
}

function adminModalActions(parent, onCancel, onConfirm, confirmLabel) {
  const actions = document.createElement("div")
  actions.className = "gowiki-admin-modal-actions"
  const cancelBtn = document.createElement("button")
  cancelBtn.textContent = "Cancel"
  cancelBtn.addEventListener("click", onCancel)
  const confirmBtn = document.createElement("button")
  confirmBtn.textContent = confirmLabel || "Save"
  confirmBtn.className = "primary"
  confirmBtn.addEventListener("click", onConfirm)
  actions.append(cancelBtn, confirmBtn)
  parent.appendChild(actions)
  return { cancelBtn, confirmBtn }
}

function adminFormField(parent, labelText, type, value) {
  const label = document.createElement("label")
  label.textContent = labelText
  parent.appendChild(label)
  const input = document.createElement("input")
  input.type = type || "text"
  if (value !== undefined) input.value = value
  parent.appendChild(input)
  return input
}

function adminFormSelect(parent, labelText, options, selectedValue) {
  const label = document.createElement("label")
  label.textContent = labelText
  parent.appendChild(label)
  const select = document.createElement("select")
  for (const opt of options) {
    const o = document.createElement("option")
    o.value = opt.value
    o.textContent = opt.label
    if (opt.value === selectedValue) o.selected = true
    select.appendChild(o)
  }
  parent.appendChild(select)
  return select
}

// ── Admin: Users Tab ──────────────────────────────────

async function renderAdminUsersTab(container) {
  container.innerHTML = '<div class="gowiki-admin-loading">Loading users...</div>'

  try {
    const resp = await authFetch("/api/admin/users")
    if (!resp.ok) {
      container.innerHTML = '<div class="gowiki-admin-error">Failed to load users.</div>'
      return
    }
    const data = await resp.json()
    const users = data.users || []

    container.innerHTML = ""

    // Create user button
    const toolbar = document.createElement("div")
    toolbar.className = "gowiki-admin-toolbar"
    const createBtn = document.createElement("button")
    createBtn.className = "gowiki-admin-btn gowiki-admin-btn-primary"
    createBtn.textContent = "Create User"
    createBtn.addEventListener("click", async () => {
      const result = await showCreateUserModal()
      if (result) renderAdminUsersTab(container)
    })
    toolbar.appendChild(createBtn)
    container.appendChild(toolbar)

    if (users.length === 0) {
      const empty = document.createElement("div")
      empty.className = "gowiki-admin-empty"
      empty.textContent = "No users found."
      container.appendChild(empty)
      return
    }

    const table = document.createElement("table")
    table.className = "gowiki-admin-table"

    const thead = document.createElement("thead")
    const headerRow = document.createElement("tr")
    for (const col of ["Username", "Display Name", "Email", "Groups", "Status", "Last Login", "Actions"]) {
      const th = document.createElement("th")
      th.textContent = col
      headerRow.appendChild(th)
    }
    thead.appendChild(headerRow)
    table.appendChild(thead)

    const tbody = document.createElement("tbody")
    for (const user of users) {
      const tr = document.createElement("tr")

      const tdUsername = document.createElement("td")
      tdUsername.textContent = user.username
      tr.appendChild(tdUsername)

      const tdDisplay = document.createElement("td")
      tdDisplay.textContent = user.display_name || ""
      tr.appendChild(tdDisplay)

      const tdEmail = document.createElement("td")
      tdEmail.textContent = user.email || ""
      tr.appendChild(tdEmail)

      const tdGroups = document.createElement("td")
      const localGroups = user.groups || []
      const oauthGroups = user.oauth_groups || []
      const allGroupParts = []
      if (localGroups.length > 0) allGroupParts.push(localGroups.join(", "))
      if (oauthGroups.length > 0) allGroupParts.push(oauthGroups.map((g) => g + " (Azure)").join(", "))
      tdGroups.textContent = allGroupParts.join(", ") || ""
      tr.appendChild(tdGroups)

      const tdStatus = document.createElement("td")
      const badge = document.createElement("span")
      badge.className = user.disabled ? "gowiki-admin-badge-disabled" : "gowiki-admin-badge-active"
      badge.textContent = user.disabled ? "Disabled" : "Active"
      tdStatus.appendChild(badge)
      tr.appendChild(tdStatus)

      const tdLogin = document.createElement("td")
      tdLogin.textContent = user.last_login ? new Date(user.last_login).toLocaleString() : "Never"
      tr.appendChild(tdLogin)

      const tdActions = document.createElement("td")
      tdActions.className = "gowiki-admin-actions-cell"

      const editBtn = document.createElement("button")
      editBtn.className = "gowiki-admin-btn-small"
      editBtn.textContent = "Edit"
      editBtn.addEventListener("click", async () => {
        const result = await showEditUserModal(user)
        if (result) renderAdminUsersTab(container)
      })
      tdActions.appendChild(editBtn)

      const pwBtn = document.createElement("button")
      pwBtn.className = "gowiki-admin-btn-small"
      pwBtn.textContent = "Password"
      pwBtn.addEventListener("click", async () => {
        await showSetPasswordModal(user.username)
      })
      tdActions.appendChild(pwBtn)

      // Don't allow deleting yourself
      if (user.username !== currentUser.username) {
        const delBtn = document.createElement("button")
        delBtn.className = "gowiki-admin-btn-small gowiki-admin-btn-danger"
        delBtn.textContent = "Delete"
        delBtn.addEventListener("click", async () => {
          if (confirm('Delete user "' + user.username + '"? This cannot be undone.')) {
            const r = await authFetch("/api/admin/users/" + encodeURIComponent(user.username), { method: "DELETE" })
            if (r.ok) renderAdminUsersTab(container)
            else alert("Failed to delete user.")
          }
        })
        tdActions.appendChild(delBtn)
      }

      tr.appendChild(tdActions)
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    container.appendChild(table)
  } catch (err) {
    container.innerHTML = '<div class="gowiki-admin-error">Failed to load users.</div>'
  }
}

async function showCreateUserModal() {
  return showAdminModal("Create User", (body, close, showError) => {
    const usernameInput = adminFormField(body, "Username", "text")
    const passwordInput = adminFormField(body, "Password", "password")
    const emailInput = adminFormField(body, "Email", "email")
    const displayInput = adminFormField(body, "Display Name", "text")
    const groupsInput = adminFormField(body, "Groups (comma-separated)", "text")

    adminModalActions(
      body,
      () => close(null),
      async () => {
        const username = usernameInput.value.trim()
        const password = passwordInput.value
        if (!username || !password) {
          showError("Username and password are required.")
          return
        }
        const groups = groupsInput.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
        try {
          const resp = await authFetch("/api/admin/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username,
              password,
              email: emailInput.value.trim(),
              display_name: displayInput.value.trim(),
              groups,
            }),
          })
          if (resp.ok) {
            close(true)
          } else {
            const err = await resp.json().catch(() => ({}))
            showError(err.error || "Failed to create user.")
          }
        } catch {
          showError("Network error.")
        }
      },
      "Create"
    )
  })
}

async function showEditUserModal(user) {
  return showAdminModal("Edit User: " + user.username, (body, close, showError) => {
    const emailInput = adminFormField(body, "Email", "email", user.email || "")
    const displayInput = adminFormField(body, "Display Name", "text", user.display_name || "")
    const groupsInput = adminFormField(body, "Local groups (comma-separated)", "text", (user.groups || []).join(", "))

    const oauthGroups = user.oauth_groups || []
    if (oauthGroups.length > 0) {
      const oauthField = adminFormField(body, "Azure AD groups (synced on login)", "text", oauthGroups.join(", "))
      oauthField.disabled = true
      oauthField.style.opacity = "0.6"
    }

    const disabledLabel = document.createElement("label")
    disabledLabel.className = "gowiki-admin-checkbox-label"
    const disabledCheck = document.createElement("input")
    disabledCheck.type = "checkbox"
    disabledCheck.checked = !!user.disabled
    disabledLabel.appendChild(disabledCheck)
    disabledLabel.appendChild(document.createTextNode(" Disabled"))
    body.appendChild(disabledLabel)

    adminModalActions(
      body,
      () => close(null),
      async () => {
        const groups = groupsInput.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
        try {
          const resp = await authFetch("/api/admin/users/" + encodeURIComponent(user.username), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: emailInput.value.trim(),
              display_name: displayInput.value.trim(),
              groups,
              disabled: disabledCheck.checked,
            }),
          })
          if (resp.ok) {
            close(true)
          } else {
            const err = await resp.json().catch(() => ({}))
            showError(err.error || "Failed to update user.")
          }
        } catch {
          showError("Network error.")
        }
      },
      "Save"
    )
  })
}

async function showSetPasswordModal(username) {
  return showAdminModal("Set Password: " + username, (body, close, showError) => {
    const passwordInput = adminFormField(body, "New Password", "password")
    const confirmInput = adminFormField(body, "Confirm Password", "password")

    adminModalActions(
      body,
      () => close(null),
      async () => {
        const password = passwordInput.value
        if (!password) {
          showError("Password is required.")
          return
        }
        if (password !== confirmInput.value) {
          showError("Passwords do not match.")
          return
        }
        try {
          const resp = await authFetch("/api/admin/users/" + encodeURIComponent(username) + "/password", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          })
          if (resp.ok) {
            close(true)
          } else {
            const err = await resp.json().catch(() => ({}))
            showError(err.error || "Failed to set password.")
          }
        } catch {
          showError("Network error.")
        }
      },
      "Set Password"
    )
  })
}

// ── Admin: Groups Tab ─────────────────────────────────

async function renderAdminGroupsTab(container) {
  container.innerHTML = '<div class="gowiki-admin-loading">Loading groups...</div>'

  try {
    const resp = await authFetch("/api/admin/groups")
    if (!resp.ok) {
      container.innerHTML = '<div class="gowiki-admin-error">Failed to load groups.</div>'
      return
    }
    const data = await resp.json()
    const groups = data.groups || []

    container.innerHTML = ""

    const toolbar = document.createElement("div")
    toolbar.className = "gowiki-admin-toolbar"
    const createBtn = document.createElement("button")
    createBtn.className = "gowiki-admin-btn gowiki-admin-btn-primary"
    createBtn.textContent = "Create Group"
    createBtn.addEventListener("click", async () => {
      const result = await showCreateGroupModal()
      if (result) renderAdminGroupsTab(container)
    })
    toolbar.appendChild(createBtn)
    container.appendChild(toolbar)

    if (groups.length === 0) {
      const empty = document.createElement("div")
      empty.className = "gowiki-admin-empty"
      empty.textContent = "No groups found."
      container.appendChild(empty)
      return
    }

    const table = document.createElement("table")
    table.className = "gowiki-admin-table"

    const thead = document.createElement("thead")
    const headerRow = document.createElement("tr")
    for (const col of ["Name", "Description", "Actions"]) {
      const th = document.createElement("th")
      th.textContent = col
      headerRow.appendChild(th)
    }
    thead.appendChild(headerRow)
    table.appendChild(thead)

    const tbody = document.createElement("tbody")
    for (const group of groups) {
      const tr = document.createElement("tr")

      const tdName = document.createElement("td")
      tdName.textContent = group.name
      tr.appendChild(tdName)

      const tdDesc = document.createElement("td")
      tdDesc.textContent = group.description || ""
      tr.appendChild(tdDesc)

      const tdActions = document.createElement("td")
      tdActions.className = "gowiki-admin-actions-cell"

      const editBtn = document.createElement("button")
      editBtn.className = "gowiki-admin-btn-small"
      editBtn.textContent = "Edit"
      editBtn.addEventListener("click", async () => {
        const result = await showEditGroupModal(group)
        if (result) renderAdminGroupsTab(container)
      })
      tdActions.appendChild(editBtn)

      // Protect the admin group from deletion
      if (group.name !== "admin") {
        const delBtn = document.createElement("button")
        delBtn.className = "gowiki-admin-btn-small gowiki-admin-btn-danger"
        delBtn.textContent = "Delete"
        delBtn.addEventListener("click", async () => {
          if (confirm('Delete group "' + group.name + '"? This cannot be undone.')) {
            const r = await authFetch("/api/admin/groups/" + encodeURIComponent(group.name), { method: "DELETE" })
            if (r.ok) renderAdminGroupsTab(container)
            else alert("Failed to delete group.")
          }
        })
        tdActions.appendChild(delBtn)
      }

      tr.appendChild(tdActions)
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    container.appendChild(table)
  } catch {
    container.innerHTML = '<div class="gowiki-admin-error">Failed to load groups.</div>'
  }
}

async function showCreateGroupModal() {
  return showAdminModal("Create Group", (body, close, showError) => {
    const nameInput = adminFormField(body, "Name", "text")
    const descInput = adminFormField(body, "Description", "text")

    adminModalActions(
      body,
      () => close(null),
      async () => {
        const name = nameInput.value.trim()
        if (!name) {
          showError("Group name is required.")
          return
        }
        try {
          const resp = await authFetch("/api/admin/groups", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, description: descInput.value.trim() }),
          })
          if (resp.ok) {
            close(true)
          } else {
            const err = await resp.json().catch(() => ({}))
            showError(err.error || "Failed to create group.")
          }
        } catch {
          showError("Network error.")
        }
      },
      "Create"
    )
  })
}

async function showEditGroupModal(group) {
  return showAdminModal("Edit Group: " + group.name, (body, close, showError) => {
    const descInput = adminFormField(body, "Description", "text", group.description || "")

    adminModalActions(
      body,
      () => close(null),
      async () => {
        try {
          const resp = await authFetch("/api/admin/groups/" + encodeURIComponent(group.name), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ description: descInput.value.trim() }),
          })
          if (resp.ok) {
            close(true)
          } else {
            const err = await resp.json().catch(() => ({}))
            showError(err.error || "Failed to update group.")
          }
        } catch {
          showError("Network error.")
        }
      },
      "Save"
    )
  })
}

// ── Admin: ACL Tab ────────────────────────────────────

async function renderAdminACLTab(container) {
  container.innerHTML = '<div class="gowiki-admin-loading">Loading ACL rules...</div>'

  try {
    const resp = await authFetch("/api/admin/acl")
    if (!resp.ok) {
      container.innerHTML = '<div class="gowiki-admin-error">Failed to load ACL rules.</div>'
      return
    }
    const data = await resp.json()
    let rules = data.rules || []

    container.innerHTML = ""

    const toolbar = document.createElement("div")
    toolbar.className = "gowiki-admin-toolbar"

    const addBtn = document.createElement("button")
    addBtn.className = "gowiki-admin-btn gowiki-admin-btn-primary"
    addBtn.textContent = "Add Rule"
    addBtn.addEventListener("click", () => {
      collectRulesFromDOM()
      rules.push({ pattern: ".*", subject_type: "special", subject: "@all", permissions: ["view"] })
      renderRules()
      // Scroll the new row into view and focus its pattern field so the
      // admin can start typing the regex immediately.
      requestAnimationFrame(() => {
        const lastRow = tableContainer.querySelector(`tr[data-rule-index="${rules.length - 1}"]`)
        if (!lastRow) return
        lastRow.scrollIntoView({ behavior: "smooth", block: "center" })
        const patternInput = lastRow.querySelector('[data-field="pattern"]')
        if (patternInput) {
          patternInput.focus()
          patternInput.select()
        }
      })
    })
    toolbar.appendChild(addBtn)

    const saveBtn = document.createElement("button")
    saveBtn.className = "gowiki-admin-btn gowiki-admin-btn-primary"
    saveBtn.textContent = "Save ACL"
    saveBtn.addEventListener("click", async () => {
      collectRulesFromDOM()
      try {
        const r = await authFetch("/api/admin/acl", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rules }),
        })
        if (r.ok) {
          statusMsg.textContent = "ACL saved."
          statusMsg.style.color = "#155724"
          statusMsg.style.display = "inline"
          setTimeout(() => {
            statusMsg.style.display = "none"
          }, 3000)
        } else {
          const err = await r.json().catch(() => ({}))
          statusMsg.textContent = err.error || "Failed to save ACL."
          statusMsg.style.color = "#c33"
          statusMsg.style.display = "inline"
        }
      } catch {
        statusMsg.textContent = "Network error."
        statusMsg.style.color = "#c33"
        statusMsg.style.display = "inline"
      }
    })
    toolbar.appendChild(saveBtn)

    const statusMsg = document.createElement("span")
    statusMsg.className = "gowiki-admin-status-msg"
    statusMsg.style.display = "none"
    toolbar.appendChild(statusMsg)

    container.appendChild(toolbar)

    const tableContainer = document.createElement("div")
    container.appendChild(tableContainer)

    function collectRulesFromDOM() {
      const rows = tableContainer.querySelectorAll("tr[data-rule-index]")
      rules = []
      rows.forEach((row) => {
        const patternInput = row.querySelector("[data-field='pattern']")
        const typeSelect = row.querySelector("[data-field='subject_type']")
        const subjectInput = row.querySelector("[data-field='subject']")
        const viewCheck = row.querySelector("[data-perm='view']")
        const editCheck = row.querySelector("[data-perm='edit']")
        const deleteCheck = row.querySelector("[data-perm='delete']")
        const perms = []
        if (viewCheck && viewCheck.checked) perms.push("view")
        if (editCheck && editCheck.checked) perms.push("edit")
        if (deleteCheck && deleteCheck.checked) perms.push("delete")
        rules.push({
          pattern: patternInput ? patternInput.value : "",
          subject_type: typeSelect ? typeSelect.value : "special",
          subject: subjectInput ? subjectInput.value : "@all",
          permissions: perms,
        })
      })
    }

    function renderRules() {
      tableContainer.innerHTML = ""

      if (rules.length === 0) {
        const empty = document.createElement("div")
        empty.className = "gowiki-admin-empty"
        empty.textContent = "No ACL rules defined."
        tableContainer.appendChild(empty)
        return
      }

      const table = document.createElement("table")
      table.className = "gowiki-admin-table"

      const thead = document.createElement("thead")
      const headerRow = document.createElement("tr")
      for (const col of ["Pattern", "Subject Type", "Subject", "View", "Edit", "Delete", ""]) {
        const th = document.createElement("th")
        th.textContent = col
        headerRow.appendChild(th)
      }
      thead.appendChild(headerRow)
      table.appendChild(thead)

      const tbody = document.createElement("tbody")
      rules.forEach((rule, index) => {
        const tr = document.createElement("tr")
        tr.setAttribute("data-rule-index", index)

        const tdPattern = document.createElement("td")
        const patternInput = document.createElement("input")
        patternInput.type = "text"
        patternInput.value = rule.pattern || ""
        patternInput.className = "gowiki-admin-input-inline"
        patternInput.setAttribute("data-field", "pattern")
        tdPattern.appendChild(patternInput)
        tr.appendChild(tdPattern)

        const tdType = document.createElement("td")
        const typeSelect = document.createElement("select")
        typeSelect.className = "gowiki-admin-input-inline"
        typeSelect.setAttribute("data-field", "subject_type")
        for (const opt of [
          { value: "user", label: "User" },
          { value: "group", label: "Group" },
          { value: "special", label: "Special" },
        ]) {
          const o = document.createElement("option")
          o.value = opt.value
          o.textContent = opt.label
          if (opt.value === rule.subject_type) o.selected = true
          typeSelect.appendChild(o)
        }
        tdType.appendChild(typeSelect)
        tr.appendChild(tdType)

        const tdSubject = document.createElement("td")
        const subjectInput = document.createElement("input")
        subjectInput.type = "text"
        subjectInput.value = rule.subject || ""
        subjectInput.className = "gowiki-admin-input-inline"
        subjectInput.setAttribute("data-field", "subject")
        tdSubject.appendChild(subjectInput)
        tr.appendChild(tdSubject)

        const allPerms = ["view", "edit", "delete"]
        for (const perm of allPerms) {
          const td = document.createElement("td")
          td.style.textAlign = "center"
          const check = document.createElement("input")
          check.type = "checkbox"
          check.checked = (rule.permissions || []).includes(perm)
          check.setAttribute("data-perm", perm)
          td.appendChild(check)
          tr.appendChild(td)
        }

        const tdRemove = document.createElement("td")
        const removeBtn = document.createElement("button")
        removeBtn.className = "gowiki-admin-btn-small gowiki-admin-btn-danger"
        removeBtn.textContent = "Remove"
        removeBtn.addEventListener("click", () => {
          collectRulesFromDOM()
          rules.splice(index, 1)
          renderRules()
        })
        tdRemove.appendChild(removeBtn)
        tr.appendChild(tdRemove)

        tbody.appendChild(tr)
      })
      table.appendChild(tbody)
      tableContainer.appendChild(table)
    }

    renderRules()
  } catch {
    container.innerHTML = '<div class="gowiki-admin-error">Failed to load ACL rules.</div>'
  }
}

// ── Admin: Locks Tab ──────────────────────────────────

async function renderAdminLocksTab(container) {
  container.innerHTML = '<div class="gowiki-admin-loading">Loading drafts...</div>'

  try {
    const resp = await authFetch("/api/admin/locks")
    if (!resp.ok) {
      container.innerHTML = '<div class="gowiki-admin-error">Failed to load drafts.</div>'
      return
    }
    const data = await resp.json()
    const drafts = data.drafts || []

    container.innerHTML = ""

    const toolbar = document.createElement("div")
    toolbar.className = "gowiki-admin-toolbar"
    const refreshBtn = document.createElement("button")
    refreshBtn.className = "gowiki-admin-btn"
    refreshBtn.textContent = "Refresh"
    refreshBtn.addEventListener("click", () => renderAdminLocksTab(container))
    toolbar.appendChild(refreshBtn)
    container.appendChild(toolbar)

    if (drafts.length === 0) {
      const empty = document.createElement("div")
      empty.className = "gowiki-admin-empty"
      empty.textContent = "No drafts."
      container.appendChild(empty)
      return
    }

    const table = document.createElement("table")
    table.className = "gowiki-admin-table"

    const thead = document.createElement("thead")
    const headerRow = document.createElement("tr")
    for (const col of ["Page", "Owner", "Since", "Actions"]) {
      const th = document.createElement("th")
      th.textContent = col
      headerRow.appendChild(th)
    }
    thead.appendChild(headerRow)
    table.appendChild(thead)

    const tbody = document.createElement("tbody")
    for (const draft of drafts) {
      const tr = document.createElement("tr")

      const tdPage = document.createElement("td")
      const pageLink = document.createElement("a")
      pageLink.href = "/" + draft.page
      pageLink.textContent = draft.page
      pageLink.style.color = "#1565c0"
      tdPage.appendChild(pageLink)
      tr.appendChild(tdPage)

      const tdOwner = document.createElement("td")
      tdOwner.textContent = draft.owner
      tr.appendChild(tdOwner)

      const tdSince = document.createElement("td")
      tdSince.textContent = draft.since ? new Date(draft.since).toLocaleString() : ""
      tr.appendChild(tdSince)

      const tdActions = document.createElement("td")
      tdActions.className = "gowiki-admin-actions-cell"
      tdActions.style.cssText = "display:flex;gap:4px;flex-wrap:wrap"

      // View button
      const viewBtn = document.createElement("button")
      viewBtn.className = "gowiki-admin-btn-small"
      viewBtn.textContent = "View"
      viewBtn.addEventListener("click", async () => {
        const r = await authFetch(
          "/api/admin/drafts/" + encodePagePath(draft.page) + "?owner=" + encodeURIComponent(draft.owner)
        )
        if (!r.ok) {
          alert("Failed to read draft.")
          return
        }
        const d = await r.json()
        const modal = document.createElement("div")
        modal.className = "gowiki-admin-modal-overlay"
        modal.addEventListener("click", (e) => {
          if (e.target === modal) modal.remove()
        })
        const dialog = document.createElement("div")
        dialog.className = "gowiki-admin-modal"
        dialog.style.maxWidth = "800px"
        const title = document.createElement("h3")
        title.textContent = "Draft: " + draft.page + " (by " + draft.owner + ")"
        dialog.appendChild(title)
        const pre = document.createElement("pre")
        pre.style.cssText =
          "background:var(--gw-color-code-bg);color:var(--gw-color-code-text);border:1px solid var(--gw-color-border);border-radius:var(--gw-radius-sm);padding:12px;max-height:60vh;overflow:auto;font-size:12px;white-space:pre-wrap"
        if (d.markdown && d.markdown.length > 0) {
          pre.textContent = d.markdown
        } else {
          pre.style.fontStyle = "italic"
          pre.style.color = "var(--gw-color-muted)"
          pre.textContent = "(empty draft)"
        }
        dialog.appendChild(pre)
        const closeBtn = document.createElement("button")
        closeBtn.className = "gowiki-admin-btn"
        closeBtn.textContent = "Close"
        closeBtn.style.marginTop = "12px"
        closeBtn.addEventListener("click", () => modal.remove())
        dialog.appendChild(closeBtn)
        modal.appendChild(dialog)
        document.body.appendChild(modal)
      })
      tdActions.appendChild(viewBtn)

      // Reclaim button
      const reclaimBtn = document.createElement("button")
      reclaimBtn.className = "gowiki-admin-btn-small gowiki-admin-btn-primary"
      reclaimBtn.textContent = "Reclaim"
      reclaimBtn.addEventListener("click", async () => {
        if (
          !confirm(
            'Reclaim draft for "' +
              draft.page +
              '" from ' +
              draft.owner +
              "?\n\nThe draft will become yours and you can edit/publish it."
          )
        )
          return
        const r = await authFetch(
          "/api/admin/drafts/reclaim/" + encodePagePath(draft.page) + "?owner=" + encodeURIComponent(draft.owner),
          { method: "POST" }
        )
        if (r.ok) {
          renderAdminLocksTab(container)
        } else {
          alert("Failed to reclaim draft.")
        }
      })
      tdActions.appendChild(reclaimBtn)

      // Discard button
      const discardBtn = document.createElement("button")
      discardBtn.className = "gowiki-admin-btn-small gowiki-admin-btn-danger"
      discardBtn.textContent = "Discard"
      discardBtn.addEventListener("click", async () => {
        if (!confirm('Discard draft for "' + draft.page + '" owned by ' + draft.owner + "?\n\nThis cannot be undone."))
          return
        const r = await authFetch("/api/admin/drafts/" + encodePagePath(draft.page), { method: "DELETE" })
        if (r.ok) {
          renderAdminLocksTab(container)
        } else {
          alert("Failed to discard draft.")
        }
      })
      tdActions.appendChild(discardBtn)

      tr.appendChild(tdActions)
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    container.appendChild(table)
  } catch {
    container.innerHTML = '<div class="gowiki-admin-error">Failed to load drafts.</div>'
  }
}

// ── Admin: Tokens Tab ──────────────────────────────────

async function renderAdminTokensTab(container) {
  container.innerHTML = '<div class="gowiki-admin-loading">Loading tokens...</div>'

  try {
    const resp = await authFetch("/api/admin/tokens")
    if (!resp.ok) {
      container.innerHTML = '<div class="gowiki-admin-error">Failed to load tokens.</div>'
      return
    }
    const data = await resp.json()
    container.innerHTML = ""

    const refreshBtn = document.createElement("button")
    refreshBtn.className = "gowiki-admin-btn-small"
    refreshBtn.textContent = "Refresh"
    refreshBtn.addEventListener("click", () => renderAdminTokensTab(container))
    container.appendChild(refreshBtn)

    const tokens = data.tokens || []
    if (tokens.length === 0) {
      const p = document.createElement("p")
      p.textContent = "No API tokens."
      p.style.color = "#666"
      container.appendChild(p)
      return
    }

    const table = document.createElement("table")
    table.className = "gowiki-admin-table"
    const thead = document.createElement("thead")
    thead.innerHTML = "<tr><th>ID</th><th>User</th><th>Name</th><th>Created</th><th>Last Used</th><th>Actions</th></tr>"
    table.appendChild(thead)

    const tbody = document.createElement("tbody")
    for (const token of tokens) {
      const tr = document.createElement("tr")

      const tdID = document.createElement("td")
      tdID.textContent = token.id
      tdID.style.fontFamily = "monospace"
      tdID.style.fontSize = "0.85em"
      tr.appendChild(tdID)

      const tdUser = document.createElement("td")
      tdUser.textContent = token.user
      tr.appendChild(tdUser)

      const tdName = document.createElement("td")
      tdName.textContent = token.name
      tr.appendChild(tdName)

      const tdCreated = document.createElement("td")
      tdCreated.textContent = token.created_at ? new Date(token.created_at).toLocaleString() : ""
      tr.appendChild(tdCreated)

      const tdUsed = document.createElement("td")
      tdUsed.textContent = token.last_used_at ? new Date(token.last_used_at).toLocaleString() : "Never"
      tr.appendChild(tdUsed)

      const tdActions = document.createElement("td")
      tdActions.className = "gowiki-admin-actions-cell"
      const revokeBtn = document.createElement("button")
      revokeBtn.className = "gowiki-admin-btn-small gowiki-admin-btn-danger"
      revokeBtn.textContent = "Revoke"
      revokeBtn.addEventListener("click", async () => {
        if (confirm('Revoke token "' + token.name + '" for user ' + token.user + "?")) {
          const r = await authFetch("/api/admin/tokens/" + token.id, { method: "DELETE" })
          if (r.ok) {
            renderAdminTokensTab(container)
          } else {
            alert("Failed to revoke token.")
          }
        }
      })
      tdActions.appendChild(revokeBtn)
      tr.appendChild(tdActions)

      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    container.appendChild(table)
  } catch {
    container.innerHTML = '<div class="gowiki-admin-error">Failed to load tokens.</div>'
  }
}

// ── Admin: Certificates Tab ───────────────────────────

async function renderAdminCertsTab(container) {
  container.innerHTML = '<div class="gowiki-admin-loading">Loading certificates...</div>'

  try {
    // Get CA status
    const caResp = await authFetch("/api/plugin/reviewflow/v1/ca")
    const caData = caResp.ok ? await caResp.json() : { has_ca: false }

    // Get user certificates
    const certsResp = await authFetch("/api/admin/certs")
    const certsData = certsResp.ok ? await certsResp.json() : { certs: [] }

    container.innerHTML = ""

    // CA section
    const caHeading = document.createElement("h3")
    caHeading.textContent = "Company Certificate Authority"
    container.appendChild(caHeading)

    if (caData.has_ca) {
      const status = document.createElement("div")
      status.style.cssText =
        "padding:8px 12px;background:var(--gw-color-success-bg);border:1px solid var(--gw-color-success);border-radius:6px;color:var(--gw-color-success);font-size:13px;margin-bottom:12px"
      status.textContent = "Company CA is configured."
      container.appendChild(status)

      const dlBtn = document.createElement("button")
      dlBtn.className = "gowiki-admin-btn-small"
      dlBtn.textContent = "Download CA Certificate"
      dlBtn.addEventListener("click", () => {
        const blob = new Blob([caData.certificate_pem], { type: "application/x-pem-file" })
        const a = document.createElement("a")
        a.href = URL.createObjectURL(blob)
        a.download = "company-ca.crt"
        a.click()
        URL.revokeObjectURL(a.href)
      })
      container.appendChild(dlBtn)
    } else {
      const status = document.createElement("div")
      status.style.cssText =
        "padding:8px 12px;background:var(--gw-color-warning-bg);border:1px solid var(--gw-color-warning);border-radius:6px;color:var(--gw-color-warning);font-size:13px;margin-bottom:12px"
      status.textContent = "No company CA. Generate one to enable Level 2 (admin-signed) certificates."
      container.appendChild(status)

      const genDiv = document.createElement("div")
      genDiv.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:12px"
      const orgInput = document.createElement("input")
      orgInput.type = "text"
      orgInput.placeholder = "Organization name"
      orgInput.value = ""
      orgInput.style.width = "200px"
      genDiv.appendChild(orgInput)

      const genBtn = document.createElement("button")
      genBtn.className = "gowiki-admin-btn-small"
      genBtn.textContent = "Generate Company CA"
      genBtn.addEventListener("click", async () => {
        genBtn.disabled = true
        const resp = await authFetch("/api/plugin/reviewflow/v1/ca/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organization: orgInput.value, common_name: orgInput.value + " Document Signing CA" }),
        })
        if (resp.ok) {
          renderAdminCertsTab(container)
        } else {
          const err = await resp.json().catch(() => ({}))
          alert(err.error || "CA generation failed")
          genBtn.disabled = false
        }
      })
      genDiv.appendChild(genBtn)
      container.appendChild(genDiv)
    }

    // Sign user key section (only if CA exists)
    if (caData.has_ca) {
      const signHeading = document.createElement("h3")
      signHeading.textContent = "Sign User Certificate"
      signHeading.style.marginTop = "24px"
      container.appendChild(signHeading)

      const signNote = document.createElement("div")
      signNote.style.cssText = "font-size:13px;color:#666;margin-bottom:8px"
      signNote.textContent = "Paste the user's public key (base64 SPKI) to sign it with the company CA."
      container.appendChild(signNote)

      const signForm = document.createElement("div")
      signForm.style.cssText = "display:flex;flex-direction:column;gap:6px;max-width:500px"

      const userInput = document.createElement("input")
      userInput.type = "text"
      userInput.placeholder = "Username"
      signForm.appendChild(userInput)

      const spkiInput = document.createElement("textarea")
      spkiInput.placeholder = "Paste base64 SPKI public key here"
      spkiInput.rows = 3
      spkiInput.style.fontFamily = "monospace"
      spkiInput.style.fontSize = "12px"
      signForm.appendChild(spkiInput)

      const signBtn = document.createElement("button")
      signBtn.className = "gowiki-admin-btn-small"
      signBtn.textContent = "Sign & Issue Certificate"
      signBtn.style.alignSelf = "flex-start"
      signBtn.addEventListener("click", async () => {
        if (!userInput.value || !spkiInput.value) {
          alert("Username and public key are required")
          return
        }
        signBtn.disabled = true
        const resp = await authFetch("/api/plugin/reviewflow/v1/ca/sign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: userInput.value, public_key_spki: spkiInput.value.trim() }),
        })
        if (resp.ok) {
          const data = await resp.json()
          // If the admin just signed for themselves, mirror the new cert into
          // their own IndexedDB — without this the local keystore keeps the
          // previous cert PEM (revoked or otherwise) and every subsequent
          // sign attempt sends the stale one instead of the freshly-issued
          // certificate the server has.
          if (currentUser && userInput.value === currentUser.username) {
            try {
              await importCertificate(currentUser.username, data.certificate_pem)
            } catch (err) {
              console.warn("Failed to update local keystore with newly-issued cert:", err)
            }
          }
          // Show the certificate for the user to copy — replace the form content
          signForm.innerHTML = ""
          const resultDiv = document.createElement("div")
          resultDiv.style.cssText = "padding:12px;background:#e8f5e9;border:1px solid #c8e6c9;border-radius:6px"
          resultDiv.innerHTML = `<b>Certificate issued for ${userInput.value}!</b><br>The certificate has been saved on the server. The user can also import it manually:`
          const code = document.createElement("textarea")
          code.style.cssText =
            "display:block;margin-top:8px;width:100%;height:120px;padding:8px;background:#fff;border:1px solid #ddd;border-radius:4px;font-family:monospace;font-size:11px"
          code.value = data.certificate_pem
          code.readOnly = true
          code.addEventListener("click", () => {
            code.select()
          })
          resultDiv.appendChild(code)

          const dlBtn = document.createElement("button")
          dlBtn.className = "gowiki-admin-btn-small"
          dlBtn.textContent = "Download as file"
          dlBtn.style.marginTop = "8px"
          dlBtn.addEventListener("click", () => {
            const blob = new Blob([data.certificate_pem], { type: "application/x-pem-file" })
            const a = document.createElement("a")
            a.href = URL.createObjectURL(blob)
            a.download = userInput.value + "-cert.pem"
            a.click()
            URL.revokeObjectURL(a.href)
          })
          resultDiv.appendChild(dlBtn)

          signForm.appendChild(resultDiv)
        } else {
          const err = await resp.json().catch(() => ({}))
          alert(err.error || "Signing failed")
          signBtn.disabled = false
        }
      })
      signForm.appendChild(signBtn)
      container.appendChild(signForm)
    }

    // User certificates list
    const certHeading = document.createElement("h3")
    certHeading.textContent = "User Certificates"
    certHeading.style.marginTop = "24px"
    container.appendChild(certHeading)

    const certs = certsData.certs || []
    if (certs.length === 0) {
      const empty = document.createElement("p")
      empty.textContent = "No user certificates registered."
      empty.style.color = "#666"
      container.appendChild(empty)
    } else {
      const table = document.createElement("table")
      table.className = "gowiki-admin-table"
      const thead = document.createElement("thead")
      thead.innerHTML =
        "<tr><th>User</th><th>Subject</th><th>Issuer</th><th>Expires</th><th>Fingerprint</th><th>Actions</th></tr>"
      table.appendChild(thead)
      const tbody = document.createElement("tbody")
      for (const cert of certs) {
        const tr = document.createElement("tr")
        const tdUser = document.createElement("td")
        tdUser.textContent = cert.username
        const tdSubject = document.createElement("td")
        tdSubject.textContent = cert.subject || ""
        const tdIssuer = document.createElement("td")
        tdIssuer.style.fontSize = "11px"
        tdIssuer.textContent = cert.issuer || ""
        const tdExpires = document.createElement("td")
        tdExpires.textContent = cert.not_after ? new Date(cert.not_after).toLocaleDateString() : ""
        const tdFp = document.createElement("td")
        tdFp.style.cssText = "font-size:10px;font-family:monospace"
        tdFp.textContent = (cert.fingerprint || "").substring(0, 16) + "..."
        const tdActions = document.createElement("td")

        if (cert.revoked) {
          const badge = document.createElement("span")
          badge.style.cssText = "color:var(--gw-color-error);font-size:12px;font-weight:600"
          badge.textContent =
            "Revoked" + (cert.revoked_at ? " (" + new Date(cert.revoked_at).toLocaleDateString() + ")" : "")
          tdActions.appendChild(badge)
        } else {
          const revokeBtn = document.createElement("button")
          revokeBtn.className = "gowiki-admin-btn-small"
          revokeBtn.style.cssText = "background:#c62828;color:#fff;border:none"
          revokeBtn.textContent = "Revoke"
          revokeBtn.addEventListener("click", async () => {
            if (
              !confirm(
                `Revoke certificate for ${cert.username}?\n\nThis will prevent new signatures. Existing signatures made before revocation remain valid.`
              )
            )
              return
            revokeBtn.disabled = true
            revokeBtn.textContent = "Revoking..."
            const resp = await authFetch(`/api/plugin/reviewflow/v1/ca/revoke/${cert.username}`, { method: "POST" })
            if (resp.ok) {
              renderAdminCertsTab(container)
            } else {
              alert("Failed to revoke certificate")
              revokeBtn.disabled = false
              revokeBtn.textContent = "Revoke"
            }
          })
          tdActions.appendChild(revokeBtn)
        }

        tr.appendChild(tdUser)
        tr.appendChild(tdSubject)
        tr.appendChild(tdIssuer)
        tr.appendChild(tdExpires)
        tr.appendChild(tdFp)
        tr.appendChild(tdActions)
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      container.appendChild(table)
    }
  } catch {
    container.innerHTML = '<div class="gowiki-admin-error">Failed to load certificates.</div>'
  }
}

// ── Admin: Configuration Tab ──────────────────────────

async function renderAdminConfigTab(container) {
  container.innerHTML = '<div class="gowiki-admin-loading">Loading configuration...</div>'

  try {
    const resp = await authFetch("/api/admin/config")
    if (!resp.ok) {
      container.innerHTML = '<div class="gowiki-admin-error">Failed to load configuration.</div>'
      return
    }
    const config = await resp.json()

    container.innerHTML = ""

    const form = document.createElement("div")
    form.className = "gowiki-admin-config-form"

    // Site section
    const siteHeading = document.createElement("h3")
    siteHeading.textContent = "Site"
    form.appendChild(siteHeading)

    const titleInput = adminFormField(form, "Site Title", "text", (config.site && config.site.title) || "")
    const baseUrlInput = adminFormField(
      form,
      "Base URL (e.g. https://wiki.example.com)",
      "text",
      (config.site && config.site.base_url) || ""
    )
    const timezoneInput = adminFormField(
      form,
      "Time zone for printed timestamps (IANA name, e.g. Europe/Paris; empty = server time)",
      "text",
      (config.site && config.site.timezone) || ""
    )
    const sidebarInput = adminFormField(form, "Sidebar Page", "text", (config.site && config.site.sidebar_page) || "")
    const footerInput = adminFormField(form, "Footer Page", "text", (config.site && config.site.footer_page) || "")
    const tocMaxLevelInput = adminFormField(
      form,
      "TOC max heading level (0 = disabled, 1-6)",
      "number",
      String((config.site && config.site.toc_max_level) ?? 3)
    )
    tocMaxLevelInput.min = "0"
    tocMaxLevelInput.max = "6"
    const userDisplaySelect = adminFormSelect(
      form,
      "User display format",
      [
        { value: "", label: "Login (default)" },
        { value: "login", label: "Login" },
        { value: "fullname", label: "Full name" },
        { value: "email", label: "Email" },
      ],
      (config.site && config.site.user_display) || ""
    )

    const codeThemeOptions = [
      { value: "github", label: "GitHub (light)" },
      { value: "atom-one-light", label: "Atom One Light" },
      { value: "vs", label: "Visual Studio (light)" },
      { value: "xcode", label: "Xcode (light)" },
      { value: "idea", label: "IntelliJ IDEA (light)" },
      { value: "github-dark", label: "GitHub Dark" },
      { value: "atom-one-dark", label: "Atom One Dark" },
      { value: "monokai", label: "Monokai (dark)" },
      { value: "nord", label: "Nord (dark)" },
      { value: "vs2015", label: "VS 2015 (dark)" },
      { value: "tokyo-night-dark", label: "Tokyo Night (dark)" },
    ]
    const codeThemeSelect = adminFormSelect(
      form,
      "Code theme (light mode)",
      codeThemeOptions,
      (config.site && config.site.code_theme) || "github"
    )
    const codeThemeDarkSelect = adminFormSelect(
      form,
      "Code theme (dark mode)",
      codeThemeOptions,
      (config.site && config.site.code_theme_dark) || "github-dark"
    )

    codeThemeSelect.addEventListener("change", () => {
      setHighlightThemes(codeThemeSelect.value, codeThemeDarkSelect.value)
    })
    codeThemeDarkSelect.addEventListener("change", () => {
      setHighlightThemes(codeThemeSelect.value, codeThemeDarkSelect.value)
    })

    // Auth section
    const authHeading = document.createElement("h3")
    authHeading.textContent = "Authentication"
    form.appendChild(authHeading)

    const sessionTtlInput = adminFormField(
      form,
      "Session TTL (e.g. 24h, 168h)",
      "text",
      (config.auth && config.auth.session_ttl) || ""
    )

    // OAuth section
    const oauthHeading = document.createElement("h3")
    oauthHeading.textContent = "OAuth / Microsoft 365"
    form.appendChild(oauthHeading)

    const oauth = (config.auth && config.auth.oauth) || {}
    const oauthProviderSelect = adminFormSelect(
      form,
      "Provider",
      [
        { value: "", label: "(disabled)" },
        { value: "azure", label: "Azure AD / Microsoft 365" },
      ],
      oauth.provider || ""
    )
    const oauthTenantInput = adminFormField(form, "Tenant ID", "text", oauth.tenant_id || "")
    const oauthClientIdInput = adminFormField(form, "Client ID", "text", oauth.client_id || "")
    const oauthClientSecretInput = adminFormField(form, "Client Secret", "password", oauth.client_secret || "")
    const oauthAutoCreateCheckbox = document.createElement("input")
    oauthAutoCreateCheckbox.type = "checkbox"
    oauthAutoCreateCheckbox.checked = !!oauth.auto_create_users
    const oauthAutoCreateLabel = document.createElement("label")
    oauthAutoCreateLabel.style.display = "flex"
    oauthAutoCreateLabel.style.alignItems = "center"
    oauthAutoCreateLabel.style.gap = "8px"
    oauthAutoCreateLabel.style.margin = "8px 0"
    oauthAutoCreateLabel.appendChild(oauthAutoCreateCheckbox)
    oauthAutoCreateLabel.appendChild(document.createTextNode("Auto-create users on first OAuth login"))
    form.appendChild(oauthAutoCreateLabel)
    const oauthDefaultGroupsInput = adminFormField(
      form,
      "Default groups for auto-created users (comma-separated)",
      "text",
      (oauth.default_groups || []).join(", ")
    )

    // Drafts section
    const draftsHeading = document.createElement("h3")
    draftsHeading.textContent = "Drafts"
    form.appendChild(draftsHeading)

    const autoSaveInput = adminFormField(
      form,
      "Auto Save Interval (e.g. 30s, 1m)",
      "text",
      (config.drafts && config.drafts.auto_save_interval) || ""
    )
    const staleLockInput = adminFormField(
      form,
      "Stale Lock Timeout (e.g. 30m, 1h)",
      "text",
      (config.drafts && config.drafts.stale_lock_timeout) || ""
    )

    // Todo section
    const todoHeading = document.createElement("h3")
    todoHeading.textContent = "Todo Plugin"
    form.appendChild(todoHeading)

    const todoConfig = config.todo || {}

    const todoDisabledCheckbox = document.createElement("input")
    todoDisabledCheckbox.type = "checkbox"
    todoDisabledCheckbox.checked = !!todoConfig.disabled
    const todoDisabledLabel = document.createElement("label")
    todoDisabledLabel.style.display = "flex"
    todoDisabledLabel.style.alignItems = "center"
    todoDisabledLabel.style.gap = "8px"
    todoDisabledLabel.style.margin = "8px 0"
    todoDisabledLabel.appendChild(todoDisabledCheckbox)
    todoDisabledLabel.appendChild(document.createTextNode("Disable todo plugin (requires restart)"))
    form.appendChild(todoDisabledLabel)

    const todoNote = document.createElement("div")
    todoNote.style.fontSize = "0.85em"
    todoNote.style.color = "#666"
    todoNote.style.margin = "0 0 8px 0"
    todoNote.textContent = "Todo is active when a database is connected and this box is unchecked."
    form.appendChild(todoNote)

    const reminderHoursInput = adminFormField(
      form,
      "Reminder hours before due date (comma-separated, e.g. 24, 48, 168)",
      "text",
      (todoConfig.reminder_hours || []).join(", ")
    )

    // SMTP / Email Notifications section
    const smtpHeading = document.createElement("h3")
    smtpHeading.textContent = "Email Notifications (SMTP)"
    form.appendChild(smtpHeading)

    const emailConfig = (todoConfig.notify && todoConfig.notify.email) || {}
    const notifyConfig = todoConfig.notify || {}

    // Trailing-debounce window for grouping notifications. Every
    // trigger within the window gets folded into one email; a hard
    // 24h cap per (user, document) applies regardless. 0 disables
    // batching (notifications send immediately, cap still applies).
    const batchWindowInput = adminFormField(
      form,
      "Notification batch window (seconds — groups messages so a user gets at most one email per burst; " +
        "0 disables batching. A 24h-per-document cap applies regardless.)",
      "number",
      String(notifyConfig.batch_window_seconds ?? 300)
    )
    batchWindowInput.min = "0"
    batchWindowInput.max = "3600"

    const smtpEnabledCheckbox = document.createElement("input")
    smtpEnabledCheckbox.type = "checkbox"
    smtpEnabledCheckbox.checked = !!emailConfig.enabled
    const smtpEnabledLabel = document.createElement("label")
    smtpEnabledLabel.style.display = "flex"
    smtpEnabledLabel.style.alignItems = "center"
    smtpEnabledLabel.style.gap = "8px"
    smtpEnabledLabel.style.margin = "8px 0"
    smtpEnabledLabel.appendChild(smtpEnabledCheckbox)
    smtpEnabledLabel.appendChild(document.createTextNode("Enable email notifications"))
    form.appendChild(smtpEnabledLabel)

    const smtpFromInput = adminFormField(form, "From address", "text", emailConfig.from || "")
    const smtpHostInput = adminFormField(form, "SMTP Host", "text", emailConfig.smtp_host || "")
    const smtpPortInput = adminFormField(form, "SMTP Port", "number", String(emailConfig.smtp_port || 587))
    smtpPortInput.min = "1"
    smtpPortInput.max = "65535"
    const smtpUserInput = adminFormField(form, "SMTP Username", "text", emailConfig.smtp_user || "")
    const smtpPassInput = adminFormField(form, "SMTP Password", "password", emailConfig.smtp_pass || "")

    // Webhooks section
    const webhookHeading = document.createElement("h3")
    webhookHeading.textContent = "Webhooks"
    form.appendChild(webhookHeading)

    const webhooks = (todoConfig.notify && todoConfig.notify.webhook) || []
    const webhookContainer = document.createElement("div")
    webhookContainer.className = "gowiki-admin-webhooks"

    const webhookEntries = []

    function renderWebhookEntry(wh, index) {
      const entry = document.createElement("div")
      entry.className = "gowiki-admin-webhook-entry"
      entry.style.border = "1px solid #ddd"
      entry.style.borderRadius = "4px"
      entry.style.padding = "8px 12px"
      entry.style.marginBottom = "8px"
      entry.style.background = "#fafafa"

      const header = document.createElement("div")
      header.style.display = "flex"
      header.style.alignItems = "center"
      header.style.gap = "8px"
      header.style.marginBottom = "6px"

      const enabledCb = document.createElement("input")
      enabledCb.type = "checkbox"
      enabledCb.checked = !!wh.enabled

      const nameInput = document.createElement("input")
      nameInput.type = "text"
      nameInput.value = wh.name || ""
      nameInput.placeholder = "Hook name"
      nameInput.style.width = "10em"

      const removeBtn = document.createElement("button")
      removeBtn.className = "gowiki-admin-btn-small gowiki-admin-btn-danger"
      removeBtn.textContent = "Remove"
      removeBtn.addEventListener("click", () => {
        webhookEntries.splice(index, 1)
        rebuildWebhooks()
      })

      header.appendChild(enabledCb)
      header.appendChild(nameInput)
      header.appendChild(removeBtn)
      entry.appendChild(header)

      const urlInput = adminFormField(entry, "URL", "text", wh.url || "")
      urlInput.style.width = "100%"
      const secretInput = adminFormField(entry, "HMAC Secret (optional)", "password", wh.hmac_secret || "")

      webhookEntries[index] = { enabledCb, nameInput, urlInput, secretInput }
      return entry
    }

    function rebuildWebhooks() {
      webhookContainer.innerHTML = ""
      const current = webhookEntries.map((e) => ({
        enabled: e.enabledCb.checked,
        name: e.nameInput.value,
        url: e.urlInput.value,
        hmac_secret: e.secretInput.value,
      }))
      webhookEntries.length = 0
      current.forEach((wh, i) => {
        webhookContainer.appendChild(renderWebhookEntry(wh, i))
      })
    }

    webhooks.forEach((wh, i) => {
      webhookContainer.appendChild(renderWebhookEntry(wh, i))
    })

    form.appendChild(webhookContainer)

    const addWebhookBtn = document.createElement("button")
    addWebhookBtn.className = "gowiki-admin-btn-small"
    addWebhookBtn.textContent = "Add Webhook"
    addWebhookBtn.style.marginBottom = "12px"
    addWebhookBtn.addEventListener("click", () => {
      const idx = webhookEntries.length
      webhookContainer.appendChild(renderWebhookEntry({ enabled: true, name: "", url: "", hmac_secret: "" }, idx))
    })
    form.appendChild(addWebhookBtn)

    // AI API section
    const aiHeading = document.createElement("h3")
    aiHeading.textContent = "AI Content API"
    form.appendChild(aiHeading)

    const aiConfig = config.ai_api || {}

    const aiEnabledCheckbox = document.createElement("input")
    aiEnabledCheckbox.type = "checkbox"
    aiEnabledCheckbox.checked = !!aiConfig.enabled
    const aiEnabledLabel = document.createElement("label")
    aiEnabledLabel.style.display = "flex"
    aiEnabledLabel.style.alignItems = "center"
    aiEnabledLabel.style.gap = "8px"
    aiEnabledLabel.style.margin = "8px 0"
    aiEnabledLabel.appendChild(aiEnabledCheckbox)
    aiEnabledLabel.appendChild(document.createTextNode("Enable AI Content API (token-based access for AI assistants)"))
    form.appendChild(aiEnabledLabel)

    const aiRateLimitReadInput = adminFormField(
      form,
      "Read rate limit (requests/minute per token)",
      "number",
      String(aiConfig.rate_limit_read ?? 120)
    )
    aiRateLimitReadInput.min = "1"
    const aiRateLimitWriteInput = adminFormField(
      form,
      "Write rate limit (requests/minute per token)",
      "number",
      String(aiConfig.rate_limit_write ?? 30)
    )
    aiRateLimitWriteInput.min = "1"
    const aiMaxTokensInput = adminFormField(
      form,
      "Max tokens per user",
      "number",
      String(aiConfig.max_tokens_per_user ?? 5)
    )
    aiMaxTokensInput.min = "1"

    const aiRequireSummaryCheckbox = document.createElement("input")
    aiRequireSummaryCheckbox.type = "checkbox"
    aiRequireSummaryCheckbox.checked = aiConfig.require_summary !== false
    const aiRequireSummaryLabel = document.createElement("label")
    aiRequireSummaryLabel.style.display = "flex"
    aiRequireSummaryLabel.style.alignItems = "center"
    aiRequireSummaryLabel.style.gap = "8px"
    aiRequireSummaryLabel.style.margin = "8px 0"
    aiRequireSummaryLabel.appendChild(aiRequireSummaryCheckbox)
    aiRequireSummaryLabel.appendChild(document.createTextNode("Require summary for token-authenticated writes"))
    form.appendChild(aiRequireSummaryLabel)

    // AI Assistant section
    const aiaHeading = document.createElement("h3")
    aiaHeading.textContent = "Integrated AI Assistant"
    form.appendChild(aiaHeading)

    const aiaConfig = config.ai_assistant || {}
    const aiaCosts = aiaConfig.costs || {}

    const aiaEnabledCheckbox = document.createElement("input")
    aiaEnabledCheckbox.type = "checkbox"
    aiaEnabledCheckbox.checked = !!aiaConfig.enabled
    const aiaEnabledLabel = document.createElement("label")
    aiaEnabledLabel.style.display = "flex"
    aiaEnabledLabel.style.alignItems = "center"
    aiaEnabledLabel.style.gap = "8px"
    aiaEnabledLabel.style.margin = "8px 0"
    aiaEnabledLabel.appendChild(aiaEnabledCheckbox)
    aiaEnabledLabel.appendChild(
      document.createTextNode("Enable integrated AI assistant (browser-based, server-side LLM proxy)")
    )
    form.appendChild(aiaEnabledLabel)

    const aiaProviderSelect = adminFormSelect(
      form,
      "Provider",
      [{ value: "anthropic", label: "Anthropic (Claude)" }],
      aiaConfig.provider || "anthropic"
    )

    const aiaApiKeyInput = adminFormField(
      form,
      "API key (or set AI_ASSISTANT_API_KEY env var)",
      "password",
      aiaConfig.api_key || ""
    )
    const aiaModelInput = adminFormField(form, "Model", "text", aiaConfig.model || "claude-sonnet-4-20250514")
    const aiaMaxTokensInput = adminFormField(
      form,
      "Max response tokens per request",
      "number",
      String(aiaConfig.max_tokens ?? 4096)
    )
    aiaMaxTokensInput.min = "256"

    const aiaGroupsNote = document.createElement("div")
    aiaGroupsNote.style.cssText = "font-size:0.85em;color:#666;margin:8px 0 4px 0"
    aiaGroupsNote.textContent = "Allowed groups (comma-separated). Empty = all authenticated users."
    form.appendChild(aiaGroupsNote)
    const aiaGroupsInput = adminFormField(form, "Allowed groups", "text", (aiaConfig.allowed_groups || []).join(", "))

    const aiaCostHeading = document.createElement("h4")
    aiaCostHeading.textContent = "Cost control"
    aiaCostHeading.style.margin = "12px 0 4px 0"
    form.appendChild(aiaCostHeading)

    const aiaRateLimitInput = adminFormField(
      form,
      "Hourly rate limit per user (0 = unlimited)",
      "number",
      String(aiaCosts.rate_limit_per_user ?? 30)
    )
    aiaRateLimitInput.min = "0"
    const aiaDailyLimitInput = adminFormField(
      form,
      "Daily limit per user (0 = unlimited)",
      "number",
      String(aiaCosts.daily_limit_per_user ?? 100)
    )
    aiaDailyLimitInput.min = "0"
    const aiaMonthlyBudgetInput = adminFormField(
      form,
      "Monthly budget USD (0 = unlimited)",
      "number",
      String(aiaCosts.monthly_budget ?? 0)
    )
    aiaMonthlyBudgetInput.min = "0"
    aiaMonthlyBudgetInput.step = "0.01"

    // Tags section
    const tagsHeading = document.createElement("h3")
    tagsHeading.textContent = "Tags"
    form.appendChild(tagsHeading)

    const tagsConfig = config.tags || {}

    const tagMutNote = document.createElement("div")
    tagMutNote.style.cssText = "font-size:0.85em;color:#666;margin:0 0 4px 0"
    tagMutNote.textContent =
      'Template tag mutations: one per line. "tpl" removes the tag, "draft:review" replaces "draft" with "review". Applied when creating pages from templates.'
    form.appendChild(tagMutNote)

    const tagMutInput = document.createElement("textarea")
    tagMutInput.rows = 3
    tagMutInput.style.cssText = "width:100%;font-family:monospace;font-size:13px"
    tagMutInput.value = (tagsConfig.template_mutations || []).join("\n")
    const tagMutLabel = document.createElement("label")
    tagMutLabel.style.cssText = "display:block;margin:4px 0 4px 0;font-weight:500"
    tagMutLabel.textContent = "Template tag mutations"
    form.appendChild(tagMutLabel)
    form.appendChild(tagMutInput)

    // Reviewflow section
    const rfHeading = document.createElement("h3")
    rfHeading.textContent = "Reviewflow Plugin"
    form.appendChild(rfHeading)

    const rfConfig = config.reviewflow || {}

    const rfEnabledCheckbox = document.createElement("input")
    rfEnabledCheckbox.type = "checkbox"
    rfEnabledCheckbox.checked = !!rfConfig.enabled
    const rfEnabledLabel = document.createElement("label")
    rfEnabledLabel.style.display = "flex"
    rfEnabledLabel.style.alignItems = "center"
    rfEnabledLabel.style.gap = "8px"
    rfEnabledLabel.style.margin = "8px 0"
    rfEnabledLabel.appendChild(rfEnabledCheckbox)
    rfEnabledLabel.appendChild(document.createTextNode("Enable reviewflow plugin"))
    form.appendChild(rfEnabledLabel)

    const rfNote = document.createElement("div")
    rfNote.style.fontSize = "0.85em"
    rfNote.style.color = "#666"
    rfNote.style.margin = "0 0 8px 0"
    rfNote.textContent =
      "Deadlines: one per line as role=duration (e.g. reviewer=72h, _default=168h). _default applies to roles without a specific deadline."
    form.appendChild(rfNote)

    const rfDeadlinesRaw = rfConfig.deadlines || {}
    const rfDeadlinesInput = document.createElement("textarea")
    rfDeadlinesInput.rows = 4
    rfDeadlinesInput.style.width = "100%"
    rfDeadlinesInput.style.fontFamily = "monospace"
    rfDeadlinesInput.style.fontSize = "13px"
    rfDeadlinesInput.value = Object.entries(rfDeadlinesRaw)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")
    const rfDeadlinesLabel = document.createElement("label")
    rfDeadlinesLabel.style.display = "block"
    rfDeadlinesLabel.style.margin = "8px 0 4px 0"
    rfDeadlinesLabel.style.fontWeight = "500"
    rfDeadlinesLabel.textContent = "Deadlines"
    form.appendChild(rfDeadlinesLabel)
    form.appendChild(rfDeadlinesInput)

    const rfObserversNote = document.createElement("div")
    rfObserversNote.style.fontSize = "0.85em"
    rfObserversNote.style.color = "#666"
    rfObserversNote.style.margin = "12px 0 4px 0"
    rfObserversNote.textContent =
      "Observers: users or groups who can view all draft documents (one per line). Use group:name for groups."
    form.appendChild(rfObserversNote)

    const rfObserversInput = document.createElement("textarea")
    rfObserversInput.rows = 3
    rfObserversInput.style.width = "100%"
    rfObserversInput.style.fontFamily = "monospace"
    rfObserversInput.style.fontSize = "13px"
    rfObserversInput.value = (rfConfig.observers || []).join("\n")
    const rfObserversLabel = document.createElement("label")
    rfObserversLabel.style.display = "block"
    rfObserversLabel.style.margin = "4px 0 4px 0"
    rfObserversLabel.style.fontWeight = "500"
    rfObserversLabel.textContent = "Observers"
    form.appendChild(rfObserversLabel)
    form.appendChild(rfObserversInput)

    // Hide-drafts gate — opt-in strict visibility for regulated wikis.
    // When on, uninvolved readers are served the last validated version
    // (or a 404 if there is none) instead of the current draft.
    const rfHideDraftsCheckbox = document.createElement("input")
    rfHideDraftsCheckbox.type = "checkbox"
    rfHideDraftsCheckbox.checked = !!rfConfig.hide_drafts_from_uninvolved
    const rfHideDraftsLabel = document.createElement("label")
    rfHideDraftsLabel.style.display = "flex"
    rfHideDraftsLabel.style.alignItems = "center"
    rfHideDraftsLabel.style.gap = "8px"
    rfHideDraftsLabel.style.margin = "12px 0 4px 0"
    rfHideDraftsLabel.appendChild(rfHideDraftsCheckbox)
    rfHideDraftsLabel.appendChild(document.createTextNode("Hide drafts from uninvolved readers"))
    form.appendChild(rfHideDraftsLabel)

    const rfHideDraftsNote = document.createElement("div")
    rfHideDraftsNote.style.cssText = "font-size:0.85em;color:#666;margin:0 0 4px 20px"
    rfHideDraftsNote.textContent =
      "When on, readers not part of the review chain (or an observer) get the last validated version instead of the current draft. If a document has never been validated, they get 404. Involved readers see a link to the published version. Recommended for regulated wikis (QMS, SOP-heavy)."
    form.appendChild(rfHideDraftsNote)

    // Signing sub-section
    const signingConfig = rfConfig.signing || {}

    const signingHeading = document.createElement("div")
    signingHeading.style.cssText = "font-weight:600;margin:16px 0 8px 0;font-size:14px"
    signingHeading.textContent = "Document Signing (X.509)"
    form.appendChild(signingHeading)

    const sigEnabledCheckbox = document.createElement("input")
    sigEnabledCheckbox.type = "checkbox"
    sigEnabledCheckbox.checked = !!signingConfig.enabled
    const sigEnabledLabel = document.createElement("label")
    sigEnabledLabel.style.display = "flex"
    sigEnabledLabel.style.alignItems = "center"
    sigEnabledLabel.style.gap = "8px"
    sigEnabledLabel.style.margin = "4px 0"
    sigEnabledLabel.appendChild(sigEnabledCheckbox)
    sigEnabledLabel.appendChild(document.createTextNode("Enable document signing"))
    form.appendChild(sigEnabledLabel)

    const sigRequiredCheckbox = document.createElement("input")
    sigRequiredCheckbox.type = "checkbox"
    sigRequiredCheckbox.checked = !!signingConfig.required
    const sigRequiredLabel = document.createElement("label")
    sigRequiredLabel.style.display = "flex"
    sigRequiredLabel.style.alignItems = "center"
    sigRequiredLabel.style.gap = "8px"
    sigRequiredLabel.style.margin = "4px 0"
    sigRequiredLabel.appendChild(sigRequiredCheckbox)
    sigRequiredLabel.appendChild(document.createTextNode("Require signing for all confirmations"))
    form.appendChild(sigRequiredLabel)

    const sigNote = document.createElement("div")
    sigNote.style.cssText = "font-size:0.85em;color:#666;margin:4px 0 0 0"
    sigNote.textContent =
      'When enabled, users with a signing key see "Sign & Confirm". When required, users without a key cannot confirm at all.'
    form.appendChild(sigNote)

    // Themes section
    const themesHeading = document.createElement("h3")
    themesHeading.textContent = "Themes"
    form.appendChild(themesHeading)

    const themesConfig = config.themes || {}

    const themeDefaultSelect = adminFormSelect(
      form,
      "Default theme (when user has no preference)",
      [
        { value: "auto", label: "Follow system" },
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
      ],
      themesConfig.default || "auto"
    )

    const themeAllowOverrideCb = document.createElement("input")
    themeAllowOverrideCb.type = "checkbox"
    themeAllowOverrideCb.checked = themesConfig.allow_user_override !== false
    const themeAllowOverrideLabel = document.createElement("label")
    themeAllowOverrideLabel.style.cssText = "display:flex;align-items:center;gap:8px;margin:8px 0"
    themeAllowOverrideLabel.appendChild(themeAllowOverrideCb)
    themeAllowOverrideLabel.appendChild(
      document.createTextNode("Allow users to override the theme (show Appearance switcher in their profile menu)")
    )
    form.appendChild(themeAllowOverrideLabel)

    const themeOverridesNote = document.createElement("div")
    themeOverridesNote.style.cssText = "font-size:0.85em;color:#666;margin:8px 0 4px 0"
    themeOverridesNote.innerHTML =
      "Palette overrides applied to the light theme. One <code>key = #hex</code> per line (e.g. <code>primary = #2d5a47</code>). Keys: primary, primary_fg, link, accent, success, warning, error."
    form.appendChild(themeOverridesNote)
    const themeOverridesSerialized = Object.entries(themesConfig.palette_overrides || {})
      .map(([k, v]) => `${k} = ${v}`)
      .join("\n")
    const themeOverridesInput = document.createElement("textarea")
    themeOverridesInput.rows = 5
    themeOverridesInput.style.cssText =
      "width:100%;font-family:monospace;font-size:13px;padding:6px;box-sizing:border-box"
    themeOverridesInput.placeholder = "primary = #2d5a47\nlink = #1e7a5e"
    themeOverridesInput.value = themeOverridesSerialized
    form.appendChild(themeOverridesInput)

    // Save button
    const actions = document.createElement("div")
    actions.className = "gowiki-admin-config-actions"

    const statusMsg = document.createElement("span")
    statusMsg.className = "gowiki-admin-status-msg"
    statusMsg.style.display = "none"

    const saveBtn = document.createElement("button")
    saveBtn.className = "gowiki-admin-btn gowiki-admin-btn-primary"
    saveBtn.textContent = "Save Configuration"
    saveBtn.addEventListener("click", async () => {
      const defaultGroupsRaw = oauthDefaultGroupsInput.value.trim()
      const defaultGroups = defaultGroupsRaw
        ? defaultGroupsRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : []
      const reminderRaw = reminderHoursInput.value.trim()
      const reminderHours = reminderRaw
        ? reminderRaw
            .split(",")
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => n > 0)
        : []

      const savedWebhooks = webhookEntries
        .map((e) => ({
          name: e.nameInput.value.trim(),
          enabled: e.enabledCb.checked,
          url: e.urlInput.value.trim(),
          hmac_secret: e.secretInput.value,
          content_type: "application/json",
          payload_tmpl: "",
        }))
        .filter((w) => w.url)

      const payload = {
        data_dir: config.data_dir || "",
        server: config.server || {},
        site: {
          title: titleInput.value.trim(),
          base_url: baseUrlInput.value.trim(),
          timezone: timezoneInput.value.trim(),
          sidebar_page: sidebarInput.value.trim(),
          footer_page: footerInput.value.trim(),
          toc_max_level: parseInt(tocMaxLevelInput.value, 10) || 3,
          user_display: userDisplaySelect.value || "",
          code_theme: codeThemeSelect.value,
          code_theme_dark: codeThemeDarkSelect.value,
        },
        auth: {
          session_ttl: sessionTtlInput.value.trim(),
          oauth: {
            provider: oauthProviderSelect.value,
            tenant_id: oauthTenantInput.value.trim(),
            client_id: oauthClientIdInput.value.trim(),
            client_secret: oauthClientSecretInput.value.trim(),
            auto_create_users: oauthAutoCreateCheckbox.checked,
            default_groups: defaultGroups,
          },
        },
        drafts: {
          auto_save_interval: autoSaveInput.value.trim(),
          stale_lock_timeout: staleLockInput.value.trim(),
        },
        database: config.database || {},
        tags: {
          template_mutations: tagMutInput.value
            .trim()
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        },
        reviewflow: {
          enabled: rfEnabledCheckbox.checked,
          deadlines: (() => {
            const d = {}
            rfDeadlinesInput.value
              .trim()
              .split("\n")
              .filter(Boolean)
              .forEach((line) => {
                const eq = line.indexOf("=")
                if (eq > 0) d[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
              })
            return d
          })(),
          observers: rfObserversInput.value
            .trim()
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          hide_drafts_from_uninvolved: rfHideDraftsCheckbox.checked,
          signing: {
            enabled: sigEnabledCheckbox.checked,
            required: sigRequiredCheckbox.checked,
            trust_store: signingConfig.trust_store || [],
            revoked_certs: signingConfig.revoked_certs || [],
          },
        },
        ai_api: {
          enabled: aiEnabledCheckbox.checked,
          rate_limit_read: parseInt(aiRateLimitReadInput.value, 10) || 120,
          rate_limit_write: parseInt(aiRateLimitWriteInput.value, 10) || 30,
          max_tokens_per_user: parseInt(aiMaxTokensInput.value, 10) || 5,
          require_summary: aiRequireSummaryCheckbox.checked,
        },
        ai_assistant: {
          enabled: aiaEnabledCheckbox.checked,
          provider: aiaProviderSelect.value,
          api_key: aiaApiKeyInput.value,
          model: aiaModelInput.value.trim(),
          max_tokens: parseInt(aiaMaxTokensInput.value, 10) || 4096,
          allowed_groups: aiaGroupsInput.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          costs: {
            rate_limit_per_user: parseInt(aiaRateLimitInput.value, 10) || 0,
            daily_limit_per_user: parseInt(aiaDailyLimitInput.value, 10) || 0,
            monthly_budget: parseFloat(aiaMonthlyBudgetInput.value) || 0,
            max_tokens_per_request: parseInt(aiaMaxTokensInput.value, 10) || 4096,
            max_context_tokens: 16000,
            warn_at_percentage: 80,
          },
        },
        todo: {
          enabled: todoConfig.enabled || false,
          disabled: todoDisabledCheckbox.checked,
          reminder_hours: reminderHours,
          notify: {
            email: {
              enabled: smtpEnabledCheckbox.checked,
              from: smtpFromInput.value.trim(),
              smtp_host: smtpHostInput.value.trim(),
              smtp_port: parseInt(smtpPortInput.value, 10) || 587,
              smtp_user: smtpUserInput.value.trim(),
              smtp_pass: smtpPassInput.value,
            },
            webhook: savedWebhooks,
            batch_window_seconds: Math.max(0, parseInt(batchWindowInput.value, 10) || 0),
          },
        },
        bibliography: config.bibliography || {},
        themes: {
          default: themeDefaultSelect.value || "auto",
          allow_user_override: themeAllowOverrideCb.checked,
          palette_overrides: (() => {
            const out = {}
            themeOverridesInput.value.split("\n").forEach((line) => {
              const eq = line.indexOf("=")
              if (eq <= 0) return
              const k = line.slice(0, eq).trim()
              const v = line.slice(eq + 1).trim()
              if (k && v) out[k] = v
            })
            return out
          })(),
        },
      }
      try {
        const r = await authFetch("/api/admin/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        if (r.ok) {
          statusMsg.textContent = "Configuration saved."
          statusMsg.style.color = "#155724"
          statusMsg.style.display = "inline"
          setTimeout(() => {
            statusMsg.style.display = "none"
          }, 3000)
        } else {
          const err = await r.json().catch(() => ({}))
          statusMsg.textContent = err.error || "Failed to save configuration."
          statusMsg.style.color = "#c33"
          statusMsg.style.display = "inline"
        }
      } catch {
        statusMsg.textContent = "Network error."
        statusMsg.style.color = "#c33"
        statusMsg.style.display = "inline"
      }
    })

    actions.appendChild(saveBtn)
    actions.appendChild(statusMsg)
    form.appendChild(actions)
    container.appendChild(form)
  } catch {
    container.innerHTML = '<div class="gowiki-admin-error">Failed to load configuration.</div>'
  }
}

// ── Admin: Database Tab ──────────────────────────

async function renderAdminDatabaseTab(container) {
  container.innerHTML = '<div class="gowiki-admin-loading">Loading database status...</div>'

  try {
    const statusResp = await authFetch("/api/admin/database/status")
    if (!statusResp.ok) {
      container.innerHTML = '<div class="gowiki-admin-error">Failed to load database status.</div>'
      return
    }
    const status = await statusResp.json()

    // Also load current config to get DSN.
    const configResp = await authFetch("/api/admin/config")
    const config = configResp.ok ? await configResp.json() : {}
    const dbConfig = config.database || {}

    container.innerHTML = ""

    const form = document.createElement("div")
    form.className = "gowiki-admin-config-form"

    // ── Connection Status ──
    const connHeading = document.createElement("h3")
    connHeading.textContent = "Connection"
    form.appendChild(connHeading)

    const statusIndicator = document.createElement("div")
    statusIndicator.style.display = "flex"
    statusIndicator.style.alignItems = "center"
    statusIndicator.style.gap = "8px"
    statusIndicator.style.marginBottom = "12px"

    const dot = document.createElement("span")
    dot.style.width = "12px"
    dot.style.height = "12px"
    dot.style.borderRadius = "50%"
    dot.style.display = "inline-block"
    dot.style.background = status.connected ? "#40c057" : "#e03131"

    const statusText = document.createElement("span")
    statusText.textContent = status.connected ? "Connected" : "Not connected"

    statusIndicator.appendChild(dot)
    statusIndicator.appendChild(statusText)
    form.appendChild(statusIndicator)

    if (status.restart_required) {
      const warning = document.createElement("div")
      warning.style.cssText =
        "padding:8px 12px;background:#fff3e0;border:1px solid #ffb74d;border-radius:6px;color:#b45309;font-size:13px;margin:8px 0"
      warning.textContent = status.restart_message || "Server restart required to activate plugins."
      form.appendChild(warning)
    }

    const dsnInput = adminFormField(
      form,
      "DSN (e.g. postgres://user:pass@host:5432/db?sslmode=disable)",
      "text",
      dbConfig.dsn || ""
    )
    dsnInput.style.fontFamily = "monospace"
    dsnInput.style.fontSize = "12px"

    const connStatusMsg = document.createElement("span")
    connStatusMsg.className = "gowiki-admin-status-msg"
    connStatusMsg.style.display = "none"
    connStatusMsg.style.marginLeft = "8px"

    const btnRow = document.createElement("div")
    btnRow.style.display = "flex"
    btnRow.style.gap = "8px"
    btnRow.style.marginTop = "8px"

    const testBtn = document.createElement("button")
    testBtn.className = "gowiki-admin-btn"
    testBtn.textContent = "Test Connection"
    testBtn.addEventListener("click", async () => {
      connStatusMsg.style.display = "inline"
      connStatusMsg.style.color = "#636e72"
      connStatusMsg.textContent = "Testing..."
      try {
        const r = await authFetch("/api/admin/database/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dsn: dsnInput.value.trim() }),
        })
        const data = await r.json()
        if (data.success) {
          connStatusMsg.textContent = "Connection successful!"
          connStatusMsg.style.color = "#155724"
        } else {
          connStatusMsg.textContent = data.error || "Connection failed"
          connStatusMsg.style.color = "#c33"
        }
      } catch {
        connStatusMsg.textContent = "Network error"
        connStatusMsg.style.color = "#c33"
      }
    })

    const saveConnBtn = document.createElement("button")
    saveConnBtn.className = "gowiki-admin-btn gowiki-admin-btn-primary"
    saveConnBtn.textContent = "Save & Connect"
    saveConnBtn.addEventListener("click", async () => {
      connStatusMsg.style.display = "inline"
      connStatusMsg.style.color = "#636e72"
      connStatusMsg.textContent = "Saving..."
      try {
        // Update config with new DSN.
        const currentConfig = configResp.ok ? await (await authFetch("/api/admin/config")).json() : {}
        currentConfig.database = {
          dsn: dsnInput.value.trim(),
          enabled: true,
        }
        const saveResp = await authFetch("/api/admin/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(currentConfig),
        })
        if (!saveResp.ok) {
          const err = await saveResp.json().catch(() => ({}))
          connStatusMsg.textContent = err.error || "Failed to save config"
          connStatusMsg.style.color = "#c33"
          return
        }

        // Connect.
        const connResp = await authFetch("/api/admin/database/connect", { method: "POST" })
        const connData = await connResp.json()
        if (connData.success) {
          connStatusMsg.textContent = connData.message || "Connected!"
          connStatusMsg.style.color = connData.restart_required ? "#b45309" : "#155724"
          dot.style.background = "#40c057"
          statusText.textContent = "Connected"
          // Reload to show tables.
          setTimeout(() => renderAdminDatabaseTab(container), 1000)
        } else {
          connStatusMsg.textContent = connData.error || "Connection failed"
          connStatusMsg.style.color = "#c33"
        }
      } catch {
        connStatusMsg.textContent = "Network error"
        connStatusMsg.style.color = "#c33"
      }
    })

    btnRow.appendChild(testBtn)
    btnRow.appendChild(saveConnBtn)
    btnRow.appendChild(connStatusMsg)
    form.appendChild(btnRow)

    // ── Tables Section (only if connected) ──
    if (status.connected) {
      const tablesHeading = document.createElement("h3")
      tablesHeading.textContent = "Tables"
      tablesHeading.style.marginTop = "24px"
      form.appendChild(tablesHeading)

      const tablesContainer = document.createElement("div")
      form.appendChild(tablesContainer)

      await renderDatabaseTables(tablesContainer)
    }

    container.appendChild(form)
  } catch {
    container.innerHTML = '<div class="gowiki-admin-error">Failed to load database status.</div>'
  }
}

async function renderDatabaseTables(container) {
  container.innerHTML = '<div class="gowiki-admin-loading">Loading tables...</div>'

  try {
    const resp = await authFetch("/api/admin/database/tables")
    if (!resp.ok) {
      container.innerHTML = '<div class="gowiki-admin-error">Failed to load tables.</div>'
      return
    }
    const data = await resp.json()
    const tables = data.tables || []

    container.innerHTML = ""

    // New Table button.
    const newBtn = document.createElement("button")
    newBtn.className = "gowiki-admin-btn gowiki-admin-btn-primary"
    newBtn.textContent = "New Table"
    newBtn.style.marginBottom = "12px"
    newBtn.addEventListener("click", async () => {
      const result = await showDatabaseTableModal(null)
      if (result) await renderDatabaseTables(container)
    })
    container.appendChild(newBtn)

    if (tables.length === 0) {
      const empty = document.createElement("div")
      empty.style.color = "#636e72"
      empty.textContent = "No tables defined."
      container.appendChild(empty)
      return
    }

    // Table list.
    const tbl = document.createElement("table")
    tbl.className = "gowiki-admin-table"
    tbl.innerHTML = `<thead><tr><th>Name</th><th>Label</th><th>Scope</th><th>Actions</th></tr></thead>`
    const tbody = document.createElement("tbody")

    for (const t of tables) {
      const tr = document.createElement("tr")
      tr.innerHTML = `<td><code>${t.name}</code></td><td>${t.label || ""}</td><td>${t.scope_regexp || ".*"}</td><td></td>`
      const actionsTd = tr.querySelector("td:last-child")

      const editBtn = document.createElement("button")
      editBtn.className = "gowiki-admin-btn gowiki-admin-btn-sm"
      editBtn.textContent = "Edit"
      editBtn.addEventListener("click", async () => {
        const result = await showDatabaseTableModal(t)
        if (result) await renderDatabaseTables(container)
      })

      const fieldsBtn = document.createElement("button")
      fieldsBtn.className = "gowiki-admin-btn gowiki-admin-btn-sm"
      fieldsBtn.textContent = "Fields"
      fieldsBtn.addEventListener("click", async () => {
        await showDatabaseFieldsModal(t.id, t.name)
        await renderDatabaseTables(container)
      })

      const dataBtn = document.createElement("button")
      dataBtn.className = "gowiki-admin-btn gowiki-admin-btn-sm"
      dataBtn.textContent = "Data"
      dataBtn.addEventListener("click", async () => {
        await showDatabaseDataBrowser(t.name)
      })

      const deleteBtn = document.createElement("button")
      deleteBtn.className = "gowiki-admin-btn gowiki-admin-btn-sm gowiki-admin-btn-danger"
      deleteBtn.textContent = "Delete"
      deleteBtn.addEventListener("click", async () => {
        if (!confirm(`Delete table "${t.name}" and all its data? This is irreversible.`)) return
        const r = await authFetch(`/api/admin/database/tables/${t.id}`, { method: "DELETE" })
        if (r.ok) await renderDatabaseTables(container)
      })

      actionsTd.appendChild(editBtn)
      actionsTd.appendChild(fieldsBtn)
      actionsTd.appendChild(dataBtn)
      actionsTd.appendChild(deleteBtn)
      tbody.appendChild(tr)
    }
    tbl.appendChild(tbody)
    container.appendChild(tbl)
  } catch {
    container.innerHTML = '<div class="gowiki-admin-error">Failed to load tables.</div>'
  }
}

async function showDatabaseTableModal(existing) {
  return showAdminModal(existing ? "Edit Table" : "New Table", (body, close, showError) => {
    const nameInput = adminFormField(body, "Name (lowercase, underscores)", "text", existing ? existing.name : "")
    if (existing) nameInput.readOnly = true
    const labelInput = adminFormField(body, "Label", "text", existing ? existing.label : "")
    const scopeInput = adminFormField(body, "Scope Regexp", "text", existing ? existing.scope_regexp : ".*")
    const folderInput = adminFormField(body, "Page Folder", "text", existing ? existing.page_folder : "")
    const sortFieldInput = adminFormField(
      body,
      "Default Sort Field",
      "text",
      existing ? existing.default_sort_field : ""
    )
    const sortOrderSelect = adminFormSelect(
      body,
      "Default Sort Order",
      [
        { value: "asc", label: "Ascending" },
        { value: "desc", label: "Descending" },
      ],
      existing ? existing.default_sort_order : "asc"
    )
    const templateInput = adminFormField(
      body,
      "Page Template Path",
      "text",
      existing ? existing.page_template_path : ""
    )

    adminModalActions(
      body,
      close,
      async () => {
        const payload = {
          name: nameInput.value.trim(),
          label: labelInput.value.trim(),
          scope_regexp: scopeInput.value.trim() || ".*",
          page_folder: folderInput.value.trim(),
          default_sort_field: sortFieldInput.value.trim(),
          default_sort_order: sortOrderSelect.value,
          page_template_path: templateInput.value.trim(),
        }
        if (!payload.name) {
          showError("Name is required")
          return
        }

        const url = existing ? `/api/admin/database/tables/${existing.id}` : "/api/admin/database/tables"
        const method = existing ? "PUT" : "POST"
        const r = await authFetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        if (r.ok) {
          close(true)
        } else {
          const err = await r.json().catch(() => ({}))
          showError(err.error || "Failed to save table")
        }
      },
      existing ? "Save" : "Create"
    )
  })
}

async function showDatabaseFieldsModal(tableId, tableName) {
  return showAdminModal(`Fields: ${tableName}`, async (body, close) => {
    body.closest(".gowiki-admin-modal").classList.add("gowiki-admin-modal-wide")
    const resp = await authFetch(`/api/admin/database/tables/${tableId}`)
    if (!resp.ok) {
      body.innerHTML = '<div class="gowiki-admin-error">Failed to load table.</div>'
      return
    }
    const table = await resp.json()
    // Fetch current active-row count; drives whether name/type/hard-delete
    // are available. An empty table lets an admin fully edit any field.
    let rowCount = 0
    try {
      const cr = await authFetch(`/api/admin/database/tables/${tableId}/rows/count`)
      if (cr.ok) rowCount = (await cr.json()).count || 0
    } catch {
      /* keep default 0 */
    }

    async function refreshFields() {
      body.innerHTML = ""
      const r = await authFetch(`/api/admin/database/tables/${tableId}`)
      if (!r.ok) return
      const t = await r.json()
      try {
        const cr = await authFetch(`/api/admin/database/tables/${tableId}/rows/count`)
        if (cr.ok) rowCount = (await cr.json()).count || 0
      } catch {
        /* keep last */
      }
      renderFieldList(t.fields || [])
    }

    function renderFieldList(allFields) {
      const active = allFields.filter((f) => !f.archived_at)
      const empty = rowCount === 0

      // Status banner telling the admin the mode.
      const banner = document.createElement("div")
      banner.style.marginBottom = "8px"
      banner.style.fontSize = "12px"
      banner.style.color = "var(--gw-color-muted)"
      banner.textContent = empty
        ? "Table is empty — fields can be renamed, retyped, or fully deleted."
        : `Table has ${rowCount} active row${rowCount === 1 ? "" : "s"} — field name and type are immutable; use Archive to hide a field, or delete all rows first for a full edit.`
      body.appendChild(banner)

      if (active.length === 0) {
        const emptyMsg = document.createElement("div")
        emptyMsg.style.color = "#636e72"
        emptyMsg.textContent = "No fields defined."
        body.appendChild(emptyMsg)
      } else {
        const tbl = document.createElement("table")
        tbl.className = "gowiki-admin-table"
        tbl.innerHTML = `<thead><tr><th>Order</th><th>Name</th><th>Label</th><th>Type</th><th>Required</th><th>Actions</th></tr></thead>`
        const tbody = document.createElement("tbody")

        for (const f of active) {
          const tr = document.createElement("tr")
          tr.innerHTML = `<td>${f.display_order}</td><td><code>${f.name}</code></td><td>${f.label || ""}</td><td>${f.type}</td><td>${f.required ? "Yes" : "No"}</td><td></td>`
          const actionsTd = tr.querySelector("td:last-child")

          const editBtn = document.createElement("button")
          editBtn.className = "gowiki-admin-btn gowiki-admin-btn-sm"
          editBtn.textContent = "Edit"
          editBtn.addEventListener("click", async () => {
            await showDatabaseFieldEditModal(tableId, f, empty)
            await refreshFields()
          })

          const archiveBtn = document.createElement("button")
          archiveBtn.className = "gowiki-admin-btn gowiki-admin-btn-sm gowiki-admin-btn-danger"
          archiveBtn.textContent = "Archive"
          archiveBtn.addEventListener("click", async () => {
            if (!confirm(`Archive field "${f.name}"? The column will be preserved but hidden.`)) return
            await authFetch(`/api/admin/database/tables/${tableId}/fields/${f.id}`, { method: "DELETE" })
            await refreshFields()
          })

          actionsTd.appendChild(editBtn)
          actionsTd.appendChild(archiveBtn)

          if (empty) {
            const deleteBtn = document.createElement("button")
            deleteBtn.className = "gowiki-admin-btn gowiki-admin-btn-sm gowiki-admin-btn-danger"
            deleteBtn.textContent = "Delete"
            deleteBtn.title = "Hard-delete: drops the SQL column and removes the field row."
            deleteBtn.addEventListener("click", async () => {
              if (
                !confirm(
                  `Permanently delete field "${f.name}"? The SQL column will be dropped and the field row removed. Any historical row-bound pages will keep the value as a "(removed)" ghost entry.`
                )
              )
                return
              const r = await authFetch(`/api/admin/database/tables/${tableId}/fields/${f.id}?hard=true`, {
                method: "DELETE",
              })
              if (!r.ok) {
                const err = await r.json().catch(() => ({}))
                alert(err.error || "Failed to delete field")
              }
              await refreshFields()
            })
            actionsTd.appendChild(deleteBtn)
          }

          tbody.appendChild(tr)
        }
        tbl.appendChild(tbody)
        body.appendChild(tbl)
      }

      // Add Field button.
      const addBtn = document.createElement("button")
      addBtn.className = "gowiki-admin-btn gowiki-admin-btn-primary"
      addBtn.textContent = "Add Field"
      addBtn.style.marginTop = "12px"
      addBtn.addEventListener("click", async () => {
        await showDatabaseFieldEditModal(tableId, null, empty)
        await refreshFields()
      })
      body.appendChild(addBtn)

      // Close button.
      const closeBtn = document.createElement("button")
      closeBtn.className = "gowiki-admin-btn"
      closeBtn.textContent = "Close"
      closeBtn.style.marginTop = "12px"
      closeBtn.style.marginLeft = "8px"
      closeBtn.addEventListener("click", () => close())
      body.appendChild(closeBtn)
    }

    renderFieldList(table.fields || [])
  })
}

async function showDatabaseFieldEditModal(tableId, existing, tableIsEmpty) {
  const fieldTypes = [
    { value: "text", label: "Text" },
    { value: "integer", label: "Integer" },
    { value: "float", label: "Float" },
    { value: "boolean", label: "Boolean" },
    { value: "date", label: "Date" },
    { value: "datetime", label: "DateTime" },
    { value: "page_link", label: "Page Link" },
    { value: "enum", label: "Enum" },
    { value: "multi_enum", label: "Multi Enum" },
    { value: "auto_increment", label: "Auto Increment" },
    { value: "image", label: "Image" },
    { value: "color", label: "Color" },
    { value: "tag", label: "Tag" },
    { value: "lookup", label: "Lookup" },
  ]

  return showAdminModal(existing ? `Edit Field: ${existing.name}` : "Add Field", (body, close, showError) => {
    const nameInput = adminFormField(body, "Name (lowercase, underscores)", "text", existing ? existing.name : "")
    // Name is immutable when there are rows. On an empty table it can be
    // renamed — the SQL column is renamed alongside.
    if (existing && !tableIsEmpty) nameInput.readOnly = true
    const labelInput = adminFormField(body, "Label", "text", existing ? existing.label : "")
    const typeSelect = adminFormSelect(body, "Type", fieldTypes, existing ? existing.type : "text")
    // Type is immutable on non-empty tables; empty tables allow drop-and-
    // recreate.
    if (existing && !tableIsEmpty) typeSelect.disabled = true
    const requiredSelect = adminFormSelect(
      body,
      "Required",
      [
        { value: "false", label: "No" },
        { value: "true", label: "Yes" },
      ],
      existing ? String(existing.required) : "false"
    )
    const defaultInput = adminFormField(body, "Default Value", "text", existing ? existing.default_value : "")
    const orderInput = adminFormField(body, "Display Order", "number", existing ? String(existing.display_order) : "0")
    const placeholderInput = adminFormField(body, "Placeholder", "text", existing ? existing.placeholder : "")

    // Enum values section (shown for enum/multi_enum).
    const enumSection = document.createElement("div")
    enumSection.style.display = "none"
    enumSection.style.marginTop = "8px"

    const enumLabel = document.createElement("label")
    enumLabel.textContent = "Enum Values (one per line)"
    enumLabel.style.display = "block"
    enumLabel.style.fontWeight = "500"
    enumLabel.style.marginBottom = "4px"
    enumSection.appendChild(enumLabel)

    const enumArea = document.createElement("textarea")
    enumArea.rows = 4
    enumArea.style.width = "100%"
    enumArea.style.fontFamily = "monospace"
    if (existing && existing.enum_values) enumArea.value = existing.enum_values.join("\n")
    enumSection.appendChild(enumArea)
    body.appendChild(enumSection)

    // Tag table section (shown for tag type).
    const tagSection = document.createElement("div")
    tagSection.style.display = "none"
    tagSection.style.marginTop = "8px"

    const tagLabel = document.createElement("label")
    tagLabel.textContent = "Tag Table (name of table with label/icon/color columns)"
    tagLabel.style.display = "block"
    tagLabel.style.fontWeight = "500"
    tagLabel.style.marginBottom = "4px"
    tagSection.appendChild(tagLabel)

    const tagInput = document.createElement("input")
    tagInput.type = "text"
    tagInput.style.width = "100%"
    tagInput.placeholder = "e.g. tags"
    if (existing && existing.type === "tag" && existing.foreign_key) tagInput.value = existing.foreign_key
    tagSection.appendChild(tagInput)
    body.appendChild(tagSection)

    // Lookup section (shown for lookup type): target table + display column.
    const lookupSection = document.createElement("div")
    lookupSection.style.display = "none"
    lookupSection.style.marginTop = "8px"

    const lookupTableLabel = document.createElement("label")
    lookupTableLabel.textContent = "Target Table (name of the table to reference)"
    lookupTableLabel.style.display = "block"
    lookupTableLabel.style.fontWeight = "500"
    lookupTableLabel.style.marginBottom = "4px"
    lookupSection.appendChild(lookupTableLabel)

    const lookupTableInput = document.createElement("input")
    lookupTableInput.type = "text"
    lookupTableInput.style.width = "100%"
    lookupTableInput.placeholder = "e.g. customers"
    if (existing && existing.type === "lookup" && existing.foreign_key) lookupTableInput.value = existing.foreign_key
    lookupSection.appendChild(lookupTableInput)

    const lookupColLabel = document.createElement("label")
    lookupColLabel.textContent = "Display Column (field name from the target table shown in place of the row id)"
    lookupColLabel.style.display = "block"
    lookupColLabel.style.fontWeight = "500"
    lookupColLabel.style.marginTop = "8px"
    lookupColLabel.style.marginBottom = "4px"
    lookupSection.appendChild(lookupColLabel)

    const lookupColInput = document.createElement("input")
    lookupColInput.type = "text"
    lookupColInput.style.width = "100%"
    lookupColInput.placeholder = "e.g. name"
    if (existing && existing.display_column) lookupColInput.value = existing.display_column
    lookupSection.appendChild(lookupColInput)

    body.appendChild(lookupSection)

    function updateEnumVisibility() {
      const t = typeSelect.value
      enumSection.style.display = t === "enum" || t === "multi_enum" ? "block" : "none"
      tagSection.style.display = t === "tag" ? "block" : "none"
      lookupSection.style.display = t === "lookup" ? "block" : "none"
    }
    typeSelect.addEventListener("change", updateEnumVisibility)
    updateEnumVisibility()

    adminModalActions(
      body,
      close,
      async () => {
        const payload = {
          name: nameInput.value.trim(),
          label: labelInput.value.trim(),
          type: typeSelect.value,
          required: requiredSelect.value === "true",
          default_value: defaultInput.value.trim(),
          display_order: parseInt(orderInput.value) || 0,
          placeholder: placeholderInput.value.trim(),
        }
        if (!payload.name) {
          showError("Name is required")
          return
        }

        // Add enum values if applicable.
        if (payload.type === "enum" || payload.type === "multi_enum") {
          payload.enum_values = enumArea.value
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean)
        }

        // Add foreign_key for tag type.
        if (payload.type === "tag") {
          payload.foreign_key = tagInput.value.trim()
        }

        // Add foreign_key + display_column for lookup type.
        if (payload.type === "lookup") {
          payload.foreign_key = lookupTableInput.value.trim()
          payload.display_column = lookupColInput.value.trim()
          if (!payload.foreign_key) {
            showError("Target Table is required for lookup fields")
            return
          }
        }

        const url = existing
          ? `/api/admin/database/tables/${tableId}/fields/${existing.id}`
          : `/api/admin/database/tables/${tableId}/fields`
        const method = existing ? "PUT" : "POST"
        const r = await authFetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        if (r.ok) {
          close(true)
        } else {
          const err = await r.json().catch(() => ({}))
          showError(err.error || "Failed to save field")
        }
      },
      existing ? "Save" : "Add"
    )
  })
}

async function showDatabaseDataBrowser(tableName) {
  return showAdminModal(`Data: ${tableName}`, async (body, close) => {
    // Make this modal wide for data tables.
    body.closest(".gowiki-admin-modal").classList.add("gowiki-admin-modal-wide")

    let currentOffset = 0
    const limit = 50

    async function loadData() {
      body.innerHTML = '<div class="gowiki-admin-loading">Loading data...</div>'

      try {
        const schemaResp = await authFetch(`/api/database/${encodeURIComponent(tableName)}/schema`)
        if (!schemaResp.ok) {
          body.innerHTML = '<div class="gowiki-admin-error">Failed to load schema.</div>'
          return
        }
        const schema = await schemaResp.json()
        const fields = (schema.fields || []).filter((f) => !f.archived_at)

        const resp = await authFetch(
          `/api/database/${encodeURIComponent(tableName)}/rows?limit=${limit}&offset=${currentOffset}`
        )
        if (!resp.ok) {
          body.innerHTML = '<div class="gowiki-admin-error">Failed to load data.</div>'
          return
        }
        const data = await resp.json()
        const rows = data.rows || []
        const total = data.total || 0

        body.innerHTML = ""

        // Export CSV button.
        const exportBtn = document.createElement("button")
        exportBtn.className = "gowiki-admin-btn"
        exportBtn.textContent = "Export CSV"
        exportBtn.style.marginBottom = "12px"
        exportBtn.addEventListener("click", () => {
          window.open(`/api/database/${encodeURIComponent(tableName)}/export/csv`, "_blank")
        })
        body.appendChild(exportBtn)

        if (rows.length === 0) {
          const empty = document.createElement("div")
          empty.style.color = "#636e72"
          empty.textContent = "No data."
          body.appendChild(empty)
        } else {
          const tbl = document.createElement("table")
          tbl.className = "gowiki-admin-table"

          const thead = document.createElement("thead")
          const headerRow = document.createElement("tr")
          headerRow.innerHTML = "<th>ID</th><th>Page</th>"
          for (const f of fields) {
            const th = document.createElement("th")
            th.textContent = f.label || f.name
            headerRow.appendChild(th)
          }
          headerRow.innerHTML += "<th>Actions</th>"
          thead.appendChild(headerRow)
          tbl.appendChild(thead)

          const tbody = document.createElement("tbody")
          for (const row of rows) {
            const tr = document.createElement("tr")
            tr.innerHTML = `<td>${row.id}</td><td>${row.page_path || ""}</td>`
            for (const f of fields) {
              const td = document.createElement("td")
              const val = row.fields?.[f.name]
              if (Array.isArray(val)) {
                td.textContent = val.join(", ")
              } else if (val != null && (f.type === "date" || f.type === "datetime") && typeof val === "string") {
                // Format ISO dates: strip time/timezone for date fields, keep datetime readable.
                if (f.type === "date") {
                  td.textContent = val.slice(0, 10)
                } else {
                  td.textContent = val
                    .replace("T", " ")
                    .replace(/Z$/, "")
                    .replace(/\.\d+$/, "")
                }
              } else if (val != null && f.type === "text" && String(val).length > 60) {
                td.textContent = String(val)
                td.classList.add("gowiki-cell-wrap")
              } else {
                td.textContent = val != null ? String(val) : ""
              }
              td.contentEditable = "true"
              td.addEventListener("blur", async () => {
                const newVal = td.textContent.trim()
                const resp = await authFetch(`/api/database/${encodeURIComponent(tableName)}/rows/${row.id}`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ fields: { [f.name]: newVal } }),
                })
                if (resp && resp.ok) {
                  let pagePath = ""
                  try {
                    pagePath = (await resp.clone().json())?.page_path || ""
                  } catch {}
                  document.dispatchEvent(
                    new CustomEvent("gowiki-database-row-updated", {
                      detail: { table: tableName, rowId: row.id, fieldName: f.name, pagePath },
                    })
                  )
                }
              })
              tr.appendChild(td)
            }

            const actionsTd = document.createElement("td")
            const delBtn = document.createElement("button")
            delBtn.className = "gowiki-admin-btn gowiki-admin-btn-sm gowiki-admin-btn-danger"
            delBtn.textContent = "Delete"
            delBtn.addEventListener("click", async () => {
              if (!confirm("Delete this row?")) return
              await authFetch(`/api/database/${encodeURIComponent(tableName)}/rows/${row.id}`, { method: "DELETE" })
              await loadData()
            })
            actionsTd.appendChild(delBtn)
            tr.appendChild(actionsTd)
            tbody.appendChild(tr)
          }
          tbl.appendChild(tbody)
          body.appendChild(tbl)
        }

        // Pagination.
        if (total > limit) {
          const pag = document.createElement("div")
          pag.style.display = "flex"
          pag.style.gap = "8px"
          pag.style.alignItems = "center"
          pag.style.marginTop = "8px"

          const prevBtn = document.createElement("button")
          prevBtn.className = "gowiki-admin-btn"
          prevBtn.textContent = "Previous"
          prevBtn.disabled = currentOffset === 0
          prevBtn.addEventListener("click", () => {
            currentOffset = Math.max(0, currentOffset - limit)
            loadData()
          })
          pag.appendChild(prevBtn)

          const info = document.createElement("span")
          info.textContent = `${currentOffset + 1}-${Math.min(currentOffset + limit, total)} of ${total}`
          pag.appendChild(info)

          const nextBtn = document.createElement("button")
          nextBtn.className = "gowiki-admin-btn"
          nextBtn.textContent = "Next"
          nextBtn.disabled = currentOffset + limit >= total
          nextBtn.addEventListener("click", () => {
            currentOffset += limit
            loadData()
          })
          pag.appendChild(nextBtn)

          body.appendChild(pag)
        }

        // Close button.
        const closeBtn = document.createElement("button")
        closeBtn.className = "gowiki-admin-btn"
        closeBtn.textContent = "Close"
        closeBtn.style.marginTop = "12px"
        closeBtn.addEventListener("click", () => close())
        body.appendChild(closeBtn)
      } catch {
        body.innerHTML = '<div class="gowiki-admin-error">Failed to load data.</div>'
      }
    }

    await loadData()
  })
}

// ── Admin: Todo Tab ──────────────────────────────────

async function renderAdminTodoTab(container) {
  container.innerHTML = '<div class="gowiki-admin-loading">Loading tasks...</div>'

  // Filter state
  let filterStatus = ""
  let filterAssignee = ""
  let filterPriority = ""
  let filterPage = ""
  let cursor = ""

  async function loadAndRender() {
    const params = new URLSearchParams()
    if (filterStatus) params.set("status", filterStatus)
    if (filterAssignee) params.set("assignee", filterAssignee)
    if (filterPriority) params.set("priority", filterPriority)
    if (filterPage) params.set("page", filterPage)
    if (cursor) params.set("cursor", cursor)
    params.set("limit", "50")

    try {
      const resp = await authFetch("/api/plugin/todo/v1/tasks?" + params.toString())
      if (!resp.ok) {
        container.innerHTML = '<div class="gowiki-admin-error">Failed to load tasks.</div>'
        return
      }
      const data = await resp.json()
      const tasks = data.tasks || []
      const nextCursor = data.cursor || ""

      container.innerHTML = ""

      // Filter bar
      const filterBar = document.createElement("div")
      filterBar.className = "gowiki-admin-toolbar"
      filterBar.style.gap = "8px"
      filterBar.style.flexWrap = "wrap"

      const statusSelect = document.createElement("select")
      statusSelect.className = "gowiki-admin-input"
      statusSelect.style.width = "auto"
      for (const [val, label] of [
        ["", "All statuses"],
        ["open", "Open"],
        ["in_progress", "In progress"],
        ["done", "Done"],
        ["cancelled", "Cancelled"],
      ]) {
        const opt = document.createElement("option")
        opt.value = val
        opt.textContent = label
        if (val === filterStatus) opt.selected = true
        statusSelect.appendChild(opt)
      }
      statusSelect.addEventListener("change", () => {
        filterStatus = statusSelect.value
        cursor = ""
        loadAndRender()
      })
      filterBar.appendChild(statusSelect)

      const prioritySelect = document.createElement("select")
      prioritySelect.className = "gowiki-admin-input"
      prioritySelect.style.width = "auto"
      for (const [val, label] of [
        ["", "All priorities"],
        ["urgent", "Urgent"],
        ["high", "High"],
        ["normal", "Normal"],
        ["low", "Low"],
      ]) {
        const opt = document.createElement("option")
        opt.value = val
        opt.textContent = label
        if (val === filterPriority) opt.selected = true
        prioritySelect.appendChild(opt)
      }
      prioritySelect.addEventListener("change", () => {
        filterPriority = prioritySelect.value
        cursor = ""
        loadAndRender()
      })
      filterBar.appendChild(prioritySelect)

      const assigneeInput = document.createElement("input")
      assigneeInput.className = "gowiki-admin-input"
      assigneeInput.style.width = "140px"
      assigneeInput.placeholder = "Assignee..."
      assigneeInput.value = filterAssignee
      let assigneeTimer = null
      assigneeInput.addEventListener("input", () => {
        clearTimeout(assigneeTimer)
        assigneeTimer = setTimeout(() => {
          filterAssignee = assigneeInput.value.trim()
          cursor = ""
          loadAndRender()
        }, 400)
      })
      filterBar.appendChild(assigneeInput)

      const pageInput = document.createElement("input")
      pageInput.className = "gowiki-admin-input"
      pageInput.style.width = "160px"
      pageInput.placeholder = "Source page..."
      pageInput.value = filterPage
      let pageTimer = null
      pageInput.addEventListener("input", () => {
        clearTimeout(pageTimer)
        pageTimer = setTimeout(() => {
          filterPage = pageInput.value.trim()
          cursor = ""
          loadAndRender()
        }, 400)
      })
      filterBar.appendChild(pageInput)

      const refreshBtn = document.createElement("button")
      refreshBtn.className = "gowiki-admin-btn"
      refreshBtn.textContent = "Refresh"
      refreshBtn.addEventListener("click", () => {
        cursor = ""
        loadAndRender()
      })
      filterBar.appendChild(refreshBtn)

      container.appendChild(filterBar)

      // Empty state
      if (tasks.length === 0) {
        const empty = document.createElement("div")
        empty.className = "gowiki-admin-empty"
        empty.textContent = cursor ? "No more tasks." : "No tasks found."
        container.appendChild(empty)
        return
      }

      // Table
      const table = document.createElement("table")
      table.className = "gowiki-admin-table"

      const thead = document.createElement("thead")
      const headerRow = document.createElement("tr")
      for (const col of ["Title", "Assignee", "Status", "Priority", "Due", "Source", "Created by", "Created"]) {
        const th = document.createElement("th")
        th.textContent = col
        headerRow.appendChild(th)
      }
      thead.appendChild(headerRow)
      table.appendChild(thead)

      const tbody = document.createElement("tbody")
      const today = new Date().toISOString().slice(0, 10)

      for (const task of tasks) {
        const tr = document.createElement("tr")

        // Title
        const tdTitle = document.createElement("td")
        if (task.source_page) {
          const a = document.createElement("a")
          a.href = task.source_page
          a.textContent = task.title
          a.style.color = "var(--gowiki-link-color, #2563eb)"
          tdTitle.appendChild(a)
        } else {
          tdTitle.textContent = task.title
        }
        tr.appendChild(tdTitle)

        // Assignee
        const tdAssignee = document.createElement("td")
        if (task.assignee && task.assignee.target) {
          tdAssignee.textContent = (task.assignee.type === "group" ? "@" : "") + task.assignee.target
        }
        tr.appendChild(tdAssignee)

        // Status
        const tdStatus = document.createElement("td")
        const statusBadge = document.createElement("span")
        statusBadge.textContent = (task.status || "open").replace("_", " ")
        statusBadge.style.cssText = "padding:2px 6px;border-radius:3px;font-size:0.85em;"
        const statusStyles = {
          open: { bg: "var(--gw-color-info-bg)", fg: "var(--gw-color-info)" },
          in_progress: { bg: "var(--gw-color-warning-bg)", fg: "var(--gw-color-warning)" },
          done: { bg: "var(--gw-color-success-bg)", fg: "var(--gw-color-success)" },
          cancelled: { bg: "var(--gw-color-surface-alt)", fg: "var(--gw-color-muted)" },
        }
        const s = statusStyles[task.status] || statusStyles.cancelled
        statusBadge.style.background = s.bg
        statusBadge.style.color = s.fg
        tdStatus.appendChild(statusBadge)
        tr.appendChild(tdStatus)

        // Priority
        const tdPriority = document.createElement("td")
        if (task.priority && task.priority !== "normal") {
          const priBadge = document.createElement("span")
          priBadge.textContent = task.priority
          priBadge.style.cssText = "padding:2px 6px;border-radius:3px;font-size:0.85em;"
          const priStyles = {
            urgent: { bg: "var(--gw-color-error-bg)", fg: "var(--gw-color-error)" },
            high: { bg: "var(--gw-color-warning-bg)", fg: "var(--gw-color-warning)" },
            low: { bg: "var(--gw-color-surface-alt)", fg: "var(--gw-color-muted)" },
          }
          const p = priStyles[task.priority] || { bg: "transparent", fg: "inherit" }
          priBadge.style.background = p.bg
          priBadge.style.color = p.fg
          tdPriority.appendChild(priBadge)
        } else {
          tdPriority.textContent = task.priority || ""
        }
        tr.appendChild(tdPriority)

        // Due date
        const tdDue = document.createElement("td")
        if (task.due_date) {
          tdDue.textContent = task.due_date
          if (task.due_date < today && task.status !== "done" && task.status !== "cancelled") {
            tdDue.style.color = "#dc2626"
            tdDue.style.fontWeight = "600"
          }
        }
        tr.appendChild(tdDue)

        // Source page
        const tdSource = document.createElement("td")
        if (task.source_page) {
          const a = document.createElement("a")
          a.href = task.source_page
          a.textContent = task.source_page
          a.style.color = "var(--gowiki-link-color, #2563eb)"
          a.style.fontSize = "0.9em"
          tdSource.appendChild(a)
        }
        tr.appendChild(tdSource)

        // Created by
        const tdCreator = document.createElement("td")
        tdCreator.textContent = task.created_by || ""
        tr.appendChild(tdCreator)

        // Created at
        const tdCreated = document.createElement("td")
        tdCreated.textContent = task.created_at ? new Date(task.created_at).toLocaleDateString() : ""
        tdCreated.style.fontSize = "0.9em"
        tr.appendChild(tdCreated)

        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      container.appendChild(table)

      // Pagination
      if (nextCursor) {
        const pager = document.createElement("div")
        pager.style.cssText = "margin-top:12px;text-align:center;"
        const nextBtn = document.createElement("button")
        nextBtn.className = "gowiki-admin-btn"
        nextBtn.textContent = "Load more"
        nextBtn.addEventListener("click", () => {
          cursor = nextCursor
          loadAndRender()
        })
        pager.appendChild(nextBtn)
        container.appendChild(pager)
      }
    } catch {
      container.innerHTML = '<div class="gowiki-admin-error">Failed to load tasks.</div>'
    }
  }

  await loadAndRender()
}

async function bootstrap() {
  applyStyles(registry.getStyles())

  // Export mode: render page cleanly for PDF generation.
  const isExportMode = new URLSearchParams(window.location.search).get("export") === "pdf"
  if (isExportMode) {
    // Force light theme for PDF export — printed paper is light-on-white.
    document.documentElement.dataset.theme = "light"
    // Hide chrome, render page in view mode.
    document.getElementById("banner")?.remove()
    document.getElementById("left")?.remove()
    document.getElementById("footer")?.remove()
    actionsRoot.style.display = "none"
    document.body.classList.add("gowiki-export")

    let page
    let fetchErr = null
    try {
      page = await fetchPage(pagePath)
    } catch (err) {
      fetchErr = err
      console.error("[gowiki] export: fetchPage failed:", err)
    }
    if (page) {
      currentMarkdown = page.markdown
      currentDoc = markdownToPM(currentMarkdown, registry)
      mountReadOnlyView(contentRoot, currentMarkdown, "gowiki-view")
    } else {
      // Surface the failure in the PDF body rather than producing a blank
      // page — the Chrome printer otherwise leaves us with only headers.
      const msg = document.createElement("div")
      msg.style.cssText = "padding:40px; font-size:14pt; color:#c62828;"
      if (fetchErr) {
        msg.textContent = `Export failed: ${fetchErr.message || String(fetchErr)}`
      } else {
        msg.textContent = `Page not found: /${pagePath}`
      }
      contentRoot.appendChild(msg)
    }

    // Set document.title so Chrome's header template substitutes the .title
    // placeholder. Prefer the page's first heading; fall back to the page path
    // so the header never shows the default index.html title.
    const pageHeading = contentRoot.querySelector("h1, h2, h3, h4, h5, h6")
    if (pageHeading && pageHeading.textContent.trim()) {
      document.title = pageHeading.textContent.trim()
    } else {
      document.title = "/" + pagePath
    }

    // Append an end-of-document "Printed from …" block with a QR code linking
    // back to the live page. Uses the browser-visible URL stripped of the
    // ?export=pdf parameter.
    const originalURL = (() => {
      const u = new URL(window.location.href)
      u.searchParams.delete("export")
      return u.toString()
    })()
    const endBlock = document.createElement("div")
    endBlock.className = "gowiki-export-endblock"
    const link = document.createElement("a")
    link.className = "gowiki-export-endblock-link"
    link.href = originalURL
    link.textContent = originalURL
    const text = document.createElement("div")
    text.className = "gowiki-export-endblock-text"
    text.appendChild(document.createTextNode("Printed from "))
    text.appendChild(link)
    const qr = document.createElement("img")
    qr.className = "gowiki-export-endblock-qr"
    qr.src = "/api/qrcode?data=" + encodeURIComponent(originalURL) + "&size=144"
    qr.alt = "QR code"
    qr.width = 72
    qr.height = 72
    endBlock.appendChild(text)
    endBlock.appendChild(qr)
    contentRoot.appendChild(endBlock)

    // Wait for the DOM to settle before signalling readiness. This matters
    // for async renderers (mermaid, charts, images, includes) that finish
    // after mountReadOnlyView returns.
    await waitForQuietDOM(contentRoot, 750, 20000)

    document.body.setAttribute("data-export-ready", "true")
    return
  }

  renderActions()

  // Non-blocking banner setup
  resolveSiteInfo()
  resolveLogo()
  initSearch()

  // Global keyboard shortcuts that work even when focus is in a property panel input.
  document.addEventListener("keydown", (e) => {
    // "/" in view mode: focus search (GitHub-style)
    if (e.key === "/" && mode !== "edit" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const active = document.activeElement
      // Don't intercept if already in an input/textarea
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return
      e.preventDefault()
      const searchInput = document.getElementById("search-input")
      if (searchInput) searchInput.focus()
      return
    }
    // F11 (Windows/Linux) or Cmd+F11 (macOS): toggle fullscreen
    if (e.key === "F11") {
      e.preventDefault()
      toggleFullscreen()
      return
    }
    // Escape: context-dependent.
    if (
      e.key === "Escape" &&
      !document.querySelector(
        ".gowiki-link-modal-overlay, .gowiki-media-modal-overlay, .gowiki-admin-modal-overlay, .gowiki-login-overlay"
      )
    ) {
      if (isFullscreen) {
        e.preventDefault()
        toggleFullscreen()
        return
      }
      if (mode === "edit") {
        e.preventDefault()
        cancelEdit()
        return
      }
    }
    const isMod = e.metaKey || e.ctrlKey
    if (!isMod) return
    // CMD+Shift+E: force raw edit mode (recovery shortcut).
    if ((e.key === "e" || e.key === "E") && e.shiftKey && mode === "view" && currentUser) {
      e.preventDefault()
      editMode = "raw"
      void enterEditMode(true)
      return
    }
    // CMD+E: enter edit mode from view mode.
    if (e.key === "e" && !e.shiftKey && mode === "view" && currentUser) {
      e.preventDefault()
      void enterEditMode(true)
      return
    }
    // CMD+E while editing: toggle visual/raw mode.
    if (e.key === "e" && !e.shiftKey && mode === "edit") {
      e.preventDefault()
      void setEditMode(editMode === "visual" ? "raw" : "visual")
      return
    }
    // CMD+L: toggle AI panel (works in all modes).
    if (e.key === "l" && !e.shiftKey && aiAssistantEnabled) {
      e.preventDefault()
      toggleAIPanel()
      return
    }
    if (mode !== "edit") return
    // CMD+K: insert link in raw mode.
    if (e.key === "k" && !e.shiftKey && editMode === "raw" && rawEditor) {
      e.preventDefault()
      void rawInsertLink(rawEditor)
      return
    }
    // CMD+K in visual mode while the editor has lost focus (e.g. after a
    // click in the page margin): ProseMirror's own keymap never sees the
    // key, so refocus the editor and run the link command at its caret.
    // Only when ProseMirror did not handle the key itself: when it did, it
    // opened the dialog and moved focus there before this handler runs.
    if (
      e.key === "k" &&
      !e.shiftKey &&
      !e.defaultPrevented &&
      !linkDialogOpen &&
      editMode === "visual" &&
      editorView &&
      !editorView.hasFocus()
    ) {
      e.preventDefault()
      editorView.focus()
      setExternalLinkCommand()(editorView.state, editorView.dispatch, editorView)
      return
    }
    if (e.key === "s" && e.shiftKey) {
      e.preventDefault()
      void publishDraft()
    } else if (e.key === "s" && !e.shiftKey) {
      e.preventDefault()
      void saveDraftExplicit()
    } else if (e.key === "h" && !e.shiftKey && !e.altKey && editorView) {
      // CMD+H heading toggle — only when in visual mode and focus is NOT
      // inside ProseMirror (PM's own keymap already handles it there;
      // handling it again here would double-toggle).
      if (editMode === "visual" && !editorView.dom.contains(document.activeElement)) {
        e.preventDefault()
        const state = editorView.state
        const node = state.selection.$from.parent
        const schema = state.schema
        if (node.type === schema.nodes.heading) {
          setBlockType(schema.nodes.paragraph)(state, editorView.dispatch)
        } else {
          setBlockType(schema.nodes.heading, { level: 2 })(state, editorView.dispatch)
        }
        editorView.focus()
      }
    }
  })

  // Sitemap page: virtual route
  if (pagePath === "_sitemap") {
    await checkAuth()
    await renderSitemapPage()
    fetchAndMountZone("sidebar", sidebarRoot, "gowiki-sidebar").then((v) => {
      sidebarView = v
    })
    fetchAndMountZone("footer", footerRoot, "gowiki-footer").then((v) => {
      footerView = v
    })
    return
  }

  // Admin page: must await auth before rendering
  if (pagePath === "_admin") {
    await checkAuth()
    if (!currentUser || !currentUser.is_admin) {
      contentRoot.innerHTML = ""
      const msg = document.createElement("div")
      msg.style.padding = "40px 20px"
      msg.style.textAlign = "center"
      msg.style.color = "#666"
      msg.style.fontSize = "16px"
      msg.textContent = currentUser
        ? "Access denied. Admin privileges required."
        : "Please log in with an admin account to access this page."
      contentRoot.appendChild(msg)
      return
    }
    renderAdminPage()
    // Still mount sidebar and footer
    fetchAndMountZone("sidebar", sidebarRoot, "gowiki-sidebar").then((v) => {
      sidebarView = v
    })
    fetchAndMountZone("footer", footerRoot, "gowiki-footer").then((v) => {
      footerView = v
    })
    return
  }

  await checkAuth()

  // Check for search query in URL.
  const searchQuery = new URLSearchParams(window.location.search).get("q")
  if (searchQuery) {
    const input = document.getElementById("search-input")
    if (input) input.value = searchQuery
    await renderSearchResultsPage(searchQuery)
    // Still mount sidebar and footer.
    fetchAndMountZone("sidebar", sidebarRoot, "gowiki-sidebar").then((v) => {
      sidebarView = v
    })
    fetchAndMountZone("footer", footerRoot, "gowiki-footer").then((v) => {
      footerView = v
    })
    return
  }

  let page
  try {
    page = await fetchPage(pagePath)
  } catch (err) {
    if (err instanceof AccessDeniedError) {
      clearContent()
      actionsRoot.innerHTML = ""
      const banner = document.createElement("div")
      banner.className = "gowiki-access-denied"
      const msg = document.createElement("div")
      msg.textContent = `Access to ${pageDisplayPath} is forbidden.`
      banner.appendChild(msg)
      if (!currentUser) {
        const hint = document.createElement("div")
        hint.style.marginTop = "8px"
        const loginLink = document.createElement("a")
        loginLink.href = "#"
        loginLink.textContent = "Log in"
        loginLink.addEventListener("click", (e) => {
          e.preventDefault()
          showLoginDialog(() => {
            window.location.reload()
          })
        })
        hint.appendChild(loginLink)
        hint.appendChild(document.createTextNode(" to access this page."))
        banner.appendChild(hint)
      }
      contentRoot.appendChild(banner)
      // Still mount sidebar and footer.
      fetchAndMountZone("sidebar", sidebarRoot, "gowiki-sidebar").then((v) => {
        sidebarView = v
      })
      fetchAndMountZone("footer", footerRoot, "gowiki-footer").then((v) => {
        footerView = v
      })
      return
    }
    throw err
  }
  console.log("[gowiki] bootstrap: page =", page ? "exists" : "null", "pagePath =", pagePath)
  if (page) {
    currentMarkdown = page.markdown
    isNewPage = false
    hasTemplate = false
    currentPageVersion = page.meta?.version || 0
    currentPageMeta = page.meta || null
    // Capture lock/draft info from page response.
    pageLockInfo = null
    if (page.locked_by) {
      pageLockInfo = { locked_by: page.locked_by, is_draft: !!page.is_draft }
    }
    // Populate media version cache so the property panel dropdown knows the max version.
    if (page.media_versions) {
      for (const [absPath, ver] of Object.entries(page.media_versions)) {
        window.__sargonUpdateMediaVersionCache(absPath, ver)
      }
    }
  } else {
    // Page doesn't exist — show the "does not exist" view. Templates are
    // offered only when the user enters edit mode (inside enterEditMode).
    currentMarkdown = defaultMarkdown
    hasTemplate = false
    isNewPage = true
    currentPageVersion = 0
    currentPageMeta = null
    pageLockInfo = null
  }

  // Normalize URL: strip /index suffix and ensure namespace index pages end with /
  const rawPathname = window.location.pathname
  if (rawPathname === "/index" || rawPathname === "/index/") {
    window.history.replaceState(null, "", "/" + window.location.search + window.location.hash)
  } else if (/\/index\/?$/.test(rawPathname)) {
    const canonical = rawPathname.replace(/\/index\/?$/, "/")
    window.history.replaceState(null, "", canonical + window.location.search + window.location.hash)
  }

  isNamespaceIndex = !!(page && page.is_namespace_index)

  // If page is a namespace index, ensure URL ends with / so relative links resolve correctly.
  if (page && page.is_namespace_index) {
    const currentPathname = window.location.pathname
    if (!currentPathname.endsWith("/")) {
      window.history.replaceState(null, "", "/" + pagePath + "/" + window.location.search + window.location.hash)
    }
  }

  try {
    currentDoc = markdownToPM(currentMarkdown, registry)
  } catch (err) {
    console.error("Failed to parse page markdown:", err)
    // Create a minimal valid doc so setMode("view") doesn't crash.
    currentDoc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create()])
    // setMode will call mountReadOnlyView which will show the error.
  }
  setMode("view")

  // Auto-view a specific version when ?v=N is present.
  const versionParam = new URLSearchParams(window.location.search).get("v")
  if (versionParam && !isNewPage) {
    const vNum = parseInt(versionParam, 10)
    if (vNum > 0) {
      // Clean the URL so a refresh doesn't re-trigger.
      window.history.replaceState(null, "", window.location.pathname)
      void viewVersion(vNum)
    }
  }

  // Auto-enter edit mode only when the user explicitly chose "Create new page".
  // Navigating to a non-existing page by accident should not auto-create it.
  const actionParam = new URLSearchParams(window.location.search).get("action")
  if (isNewPage && currentUser && actionParam === "create") {
    // Detect if the user wants a namespace index (trailing slash in URL).
    const wantsNamespaceIndex = window.location.pathname.endsWith("/") && window.location.pathname !== "/"
    // Clean the URL so a refresh doesn't re-trigger auto-edit.
    window.history.replaceState(null, "", window.location.pathname)
    void enterEditMode(true, wantsNamespaceIndex)
  }

  // Fetch and mount sidebar and footer as read-only views (non-blocking)
  fetchAndMountZone("sidebar", sidebarRoot, "gowiki-sidebar").then((v) => {
    sidebarView = v
  })
  fetchAndMountZone("footer", footerRoot, "gowiki-footer").then((v) => {
    footerView = v
  })

  // Start presence tracking.
  initPresence()

  // Track recently viewed pages.
  trackRecentPage()
}

// ── Recent pages ────────────────────────────────────────

const RECENT_PAGES_MAX = 15
const RECENT_PAGES_COOKIE = "gowiki_recent"

function getRecentPages() {
  const cookie = document.cookie.split("; ").find((c) => c.startsWith(RECENT_PAGES_COOKIE + "="))
  if (!cookie) return []
  try {
    return JSON.parse(decodeURIComponent(cookie.split("=").slice(1).join("=")))
  } catch {
    return []
  }
}

function setRecentPages(pages) {
  const value = encodeURIComponent(JSON.stringify(pages))
  // Session cookie (no max-age) — persists until browser closes.
  // Use max-age=31536000 (1 year) so it survives restarts.
  document.cookie = `${RECENT_PAGES_COOKIE}=${value};path=/;max-age=31536000;SameSite=Lax`
}

function trackRecentPage() {
  // Skip virtual pages.
  if (pagePath.startsWith("_")) return

  const title = document.title.replace(/^\[.*?\]\s*/, "") || pageDisplayPath
  const entry = { path: pageDisplayPath, title }

  let recent = getRecentPages()
  // Remove duplicate if already in the list.
  recent = recent.filter((r) => r.path !== entry.path)
  // Add to front.
  recent.unshift(entry)
  // Trim to max.
  if (recent.length > RECENT_PAGES_MAX) recent = recent.slice(0, RECENT_PAGES_MAX)

  setRecentPages(recent)
  renderRecentPages(recent)
}

function renderRecentPages(recent) {
  const bar = document.getElementById("recent-pages")
  if (!bar) return
  bar.innerHTML = ""

  if (!recent || recent.length === 0) return

  for (let i = 0; i < recent.length; i++) {
    if (i > 0) {
      const sep = document.createElement("span")
      sep.className = "gowiki-recent-sep"
      sep.textContent = "›"
      bar.appendChild(sep)
    }
    const link = document.createElement("a")
    link.href = recent[i].path
    link.textContent = recent[i].title
    if (recent[i].path === pageDisplayPath) {
      link.className = "gowiki-recent-current"
    }
    link.addEventListener("click", (e) => {
      e.preventDefault()
      window.location.href = recent[i].path
    })
    bar.appendChild(link)
  }

  trimOverflowingBreadcrumbs(bar)
}

function trimOverflowingBreadcrumbs(bar) {
  const barRight = bar.getBoundingClientRect().right
  const children = Array.from(bar.children)
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i]
    const rect = child.getBoundingClientRect()
    if (rect.right > barRight + 1) {
      child.style.display = "none"
      if (i > 0 && children[i - 1].classList.contains("gowiki-recent-sep")) {
        children[i - 1].style.display = "none"
      }
    }
  }
}

// ── Collaborative editing ───────────────────────────────

/**
 * Apply a remote document update to the ProseMirror editor by diffing
 * top-level nodes and only replacing changed ones. This preserves the
 * cursor position when the cursor is in an unchanged block.
 */
function applyRemoteDocUpdate(view, newDoc) {
  const oldDoc = view.state.doc
  const tr = view.state.tr

  // Compare top-level nodes. Walk backwards so position offsets stay valid.
  const oldCount = oldDoc.content.childCount
  const newCount = newDoc.content.childCount
  const maxCount = Math.max(oldCount, newCount)

  // Find common prefix (unchanged top-level nodes from the start).
  let commonPrefix = 0
  while (commonPrefix < oldCount && commonPrefix < newCount) {
    const oldNode = oldDoc.content.child(commonPrefix)
    const newNode = newDoc.content.child(commonPrefix)
    if (!oldNode.eq(newNode)) break
    commonPrefix++
  }

  // Find common suffix (unchanged top-level nodes from the end).
  let commonSuffix = 0
  while (commonSuffix < oldCount - commonPrefix && commonSuffix < newCount - commonPrefix) {
    const oldNode = oldDoc.content.child(oldCount - 1 - commonSuffix)
    const newNode = newDoc.content.child(newCount - 1 - commonSuffix)
    if (!oldNode.eq(newNode)) break
    commonSuffix++
  }

  // If everything matches, nothing to do.
  if (commonPrefix + commonSuffix >= maxCount) return

  // Compute the range in the old doc that changed.
  let fromPos = 0
  for (let i = 0; i < commonPrefix; i++) {
    fromPos += oldDoc.content.child(i).nodeSize
  }
  let toPos = oldDoc.content.size
  for (let i = 0; i < commonSuffix; i++) {
    toPos -= oldDoc.content.child(oldCount - 1 - i).nodeSize
  }

  // Collect the new nodes for the changed range.
  const newNodes = []
  for (let i = commonPrefix; i < newCount - commonSuffix; i++) {
    newNodes.push(newDoc.content.child(i))
  }

  tr.replaceWith(fromPos, toPos, newNodes)
  tr.setMeta("addToHistory", false)
  tr.setMeta("collab-remote", true)
  view.dispatch(tr)
}

/**
 * Apply a remote text update to a textarea by diffing strings and
 * adjusting the cursor position based on where the change happened.
 */
function applyRemoteRawUpdate(textarea, newText) {
  const oldText = textarea.value
  if (oldText === newText) return

  const cursorPos = textarea.selectionStart
  const cursorEnd = textarea.selectionEnd

  // Find the changed region.
  let start = 0
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) {
    start++
  }
  let oldEnd = oldText.length
  let newEnd = newText.length
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--
    newEnd--
  }

  textarea.value = newText

  // Adjust cursor: if cursor was before the change, keep it.
  // If inside or after, shift by the length difference.
  const delta = newEnd - start - (oldEnd - start)
  let newCursorPos = cursorPos
  let newCursorEnd = cursorEnd
  if (cursorPos > oldEnd) {
    newCursorPos = cursorPos + delta
    newCursorEnd = cursorEnd + delta
  } else if (cursorPos > start) {
    // Cursor was inside the changed region — put it at the end of the new content.
    newCursorPos = newEnd
    newCursorEnd = newEnd
  }
  newCursorPos = Math.max(0, Math.min(newCursorPos, newText.length))
  newCursorEnd = Math.max(0, Math.min(newCursorEnd, newText.length))
  textarea.setSelectionRange(newCursorPos, newCursorEnd)
}

let remoteBlockUsers = [] // [{block, username, displayName}]

/**
 * Convert a markdown character offset to a block index (blank-line separated).
 */
function markdownOffsetToBlock(md, offset) {
  let block = 0
  let i = 0
  while (i < offset && i < md.length) {
    if (md[i] === "\n" && i + 1 < md.length && md[i + 1] === "\n") {
      block++
      // Skip consecutive blank lines.
      while (i + 1 < md.length && md[i + 1] === "\n") i++
    }
    i++
  }
  return block
}

function renderRemoteBlockIndicators() {
  const editingUsers = currentPresenceUsers
    .filter((u) => {
      if (u.mode !== "edit") return false
      const block = u.offset ?? u.block ?? -1
      return block >= 0
    })
    .map((u) => ({ ...u, _block: u.offset ?? u.block ?? -1 }))

  if (mode !== "edit") return

  if (editMode === "visual" && editorView) {
    // Block index maps directly to PM node index.
    const maxNode = editorView.state.doc.content.childCount - 1
    remoteBlockUsers = editingUsers.map((u) => {
      return {
        block: Math.min(Math.max(0, u._block), maxNode),
        username: u.username,
        displayName: u.display_name || u.username,
      }
    })
    const tr = editorView.state.tr.setMeta("remoteBlocksUpdate", true)
    tr.setMeta("addToHistory", false)
    editorView.dispatch(tr)
  } else if (editMode === "raw") {
    if (!rawEditor) return
    // Block index used directly.
    remoteBlockUsers = editingUsers.map((u) => ({
      block: u._block,
      username: u.username,
      displayName: u.display_name || u.username,
    }))
    renderRawRemoteIndicators()
  }
}

/**
 * Render colored indicators alongside the raw textarea showing
 * which "block" (separated by blank lines) remote users are in.
 */
function renderRawRemoteIndicators() {
  // Remove existing indicators.
  document.querySelectorAll(".gowiki-raw-remote-indicator").forEach((el) => el.remove())

  if (!rawEditor || remoteBlockUsers.length === 0) return

  const text = rawEditor.value
  const lines = text.split("\n")

  // Map block indices to line ranges. Blocks are separated by blank lines.
  const blockRanges = [] // [{startLine, endLine}]
  let blockStart = 0
  let inBlock = false
  for (let i = 0; i <= lines.length; i++) {
    const isBlank = i === lines.length || lines[i].trim() === ""
    if (!isBlank && !inBlock) {
      blockStart = i
      inBlock = true
    } else if (isBlank && inBlock) {
      blockRanges.push({ startLine: blockStart, endLine: i - 1 })
      inBlock = false
    }
  }

  const parent = rawEditor.parentElement
  if (!parent) return
  parent.style.position = "relative"

  // Compute character offset for the start of each line.
  const lineOffsets = [0]
  for (let i = 0; i < lines.length - 1; i++) {
    lineOffsets.push(lineOffsets[i] + lines[i].length + 1)
  }

  for (const u of remoteBlockUsers) {
    if (u.block < 0 || u.block >= blockRanges.length) continue
    const range = blockRanges[u.block]
    const color = presenceColor(u.username)

    // Get pixel Y for start and end of the block using the mirror div.
    const startCharPos = lineOffsets[range.startLine] || 0
    const endCharPos = lineOffsets[range.endLine + 1] || lineOffsets[range.endLine] || startCharPos
    const startY = getTextareaCursorOffset(rawEditor, startCharPos)
    const endY = getTextareaCursorOffset(rawEditor, endCharPos)

    // Offset by textarea's position within parent.
    const taTop = rawEditor.offsetTop
    const top = taTop + startY.y - rawEditor.scrollTop
    const height = Math.max(endY.y - startY.y, 16)

    const indicator = document.createElement("div")
    indicator.className = "gowiki-raw-remote-indicator"
    indicator.style.cssText = `position:absolute;left:0;top:${top}px;width:3px;height:${height}px;background:${color};pointer-events:none;border-radius:1px;z-index:5`

    const label = document.createElement("div")
    label.style.cssText = `position:absolute;left:6px;top:${Math.max(0, top - 12)}px;font-size:9px;color:${color};font-weight:600;white-space:nowrap;pointer-events:none;opacity:0.8;z-index:5`
    label.textContent = u.displayName
    label.className = "gowiki-raw-remote-indicator"

    parent.appendChild(indicator)
    parent.appendChild(label)
  }
}

async function handleOwnerLeft(previousOwner) {
  setStatus(`Draft owner (${previousOwner}) left. Taking over the draft...`)

  // Get current content from the editor.
  let markdown = currentMarkdown
  if (editMode === "visual" && editorView) {
    markdown = pmToMarkdown(editorView.state.doc, registry)
  } else if (editMode === "raw" && rawEditor) {
    markdown = rawEditor.value
  }

  // Promote ourselves: reclaim the draft and get an edit token.
  try {
    const resp = await authFetch(`/api/collab/promote/${encodePagePath(pagePath)}`, { method: "POST" })
    if (!resp.ok) {
      setStatus("Failed to take over draft")
      return
    }
    const data = await resp.json()
    editToken = data.edit_token
    isCollabGuest = false

    // Save the current content as our draft.
    await authFetch(`/api/draft/${encodePagePath(pagePath)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown, edit_token: editToken }),
    })

    // Update UI — show save/publish buttons.
    renderActions()
    sendPresenceUpdate()
    setStatus(`You are now the draft owner (${previousOwner} left)`)
  } catch (err) {
    console.error("Failed to promote to owner:", err)
    setStatus("Failed to take over draft")
  }
}

function startCollabSession(initialMarkdown) {
  stopCollabSession() // clean up any previous session

  collabSession = new CollabSession(
    pagePath,
    initialMarkdown,
    {
      getMarkdown() {
        if (editMode === "visual" && editorView) {
          return pmToMarkdown(editorView.state.doc, registry)
        } else if (editMode === "raw" && rawEditor) {
          return rawEditor.value
        }
        return currentMarkdown
      },
      setMarkdown(markdown, source) {
        if (source !== "remote") return
        currentMarkdown = markdown

        if (editMode === "visual" && editorView) {
          try {
            const newDoc = markdownToPM(markdown, registry)
            applyRemoteDocUpdate(editorView, newDoc)
          } catch (err) {
            console.warn("collab: failed to apply remote change to visual editor", err)
          }
        } else if (editMode === "raw" && rawEditor) {
          // Apply a surgical text diff to preserve cursor position.
          applyRemoteRawUpdate(rawEditor, markdown)
        }
      },
      getMode() {
        return editMode
      },
    },
    isCollabGuest
  )

  collabSession.connect()
}

function stopCollabSession() {
  if (collabSession) {
    collabSession.destroy()
    collabSession = null
  }
}

// ── Presence (real-time user tracking) ──────────────────

let presenceSocket = null
let presenceReconnectTimer = null
let currentPresenceUsers = []

function initPresence() {
  if (!currentUser) return // not logged in

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
  const url = `${proto}//${window.location.host}/api/ws/presence`

  function connect() {
    const ws = new WebSocket(url)
    presenceSocket = ws

    ws.addEventListener("open", () => {
      // Join current page.
      ws.send(JSON.stringify({ type: "join", page: pagePath, mode: mode === "edit" ? "edit" : "view" }))
    })

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === "presence" && msg.page === pagePath) {
          // Filter out self.
          currentPresenceUsers = (msg.users || []).filter((u) => u.username !== currentUser.username)
          renderPresenceBar()
          renderRemoteBlockIndicators()
        }
        if (msg.type === "owner_left" && msg.page === pagePath && isCollabGuest && mode === "edit") {
          handleOwnerLeft(msg.owner)
        }
        if (
          msg.type === "draft_reclaimed" &&
          msg.page === pageDisplayPath &&
          msg.previous_owner === currentUser?.username &&
          msg.new_owner !== currentUser?.username
        ) {
          // Someone took over our draft. Clear stale state and update UI immediately.
          editToken = null
          stashedEditorState = null
          pageLockInfo = { locked_by: msg.new_owner, is_draft: true }
          renderActions()
          setStatus(`Your draft was taken over by ${msg.new_owner}. Click "Join" to continue editing.`)
        }
      } catch {
        /* ignore */
      }
    })

    ws.addEventListener("close", () => {
      presenceSocket = null
      // Reconnect after 3 seconds.
      clearTimeout(presenceReconnectTimer)
      presenceReconnectTimer = setTimeout(connect, 3000)
    })

    ws.addEventListener("error", () => {
      ws.close()
    })

    // Client-side keepalive every 25s.
    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }))
      } else {
        clearInterval(keepalive)
      }
    }, 25000)
  }

  connect()
}

let currentEditBlock = -1 // markdown char offset where cursor is

function sendPresenceUpdate() {
  if (presenceSocket && presenceSocket.readyState === WebSocket.OPEN) {
    const msg = { type: "join", page: pagePath, mode: mode === "edit" ? "edit" : "view" }
    if (mode === "edit") {
      msg.offset = currentEditBlock
      msg.is_owner = !isCollabGuest
    }
    presenceSocket.send(JSON.stringify(msg))
  }
}

function updateEditOffset() {
  if (mode !== "edit") return
  let block = -1

  if (editMode === "raw" && rawEditor) {
    block = markdownOffsetToBlock(rawEditor.value, rawEditor.selectionStart)
  } else if (editMode === "visual" && editorView) {
    // Use PM node index directly — same coordinate system as visual decorations.
    const pos = editorView.state.selection.from
    let idx = 0
    editorView.state.doc.forEach((node, nodePos) => {
      if (pos > nodePos + node.nodeSize) idx++
    })
    block = idx
  }

  const charOffset = block

  if (charOffset !== currentEditBlock) {
    currentEditBlock = charOffset
    sendPresenceUpdate()
  }
}

// Call sendPresenceUpdate when mode changes.
const _originalSetMode = setMode
// eslint-disable-next-line no-func-assign -- Wrapping the declared function with a side effect. Function declarations are reassignable in JS; a hook system would be cleaner but not worth the refactor cost today.
setMode = function (nextMode) {
  _originalSetMode(nextMode)
  sendPresenceUpdate()
}

function renderPresenceBar() {
  let container = document.getElementById("gowiki-presence")
  if (currentPresenceUsers.length === 0) {
    if (container) container.remove()
    return
  }

  // Place in the banner, before the username.
  const bannerUser = document.getElementById("banner-user")
  if (!bannerUser) return

  if (!container) {
    container = document.createElement("span")
    container.id = "gowiki-presence"
    container.className = "gowiki-presence-container"
    // Insert at the beginning of banner-user (before user links).
    bannerUser.prepend(container)
  }

  container.innerHTML = ""
  for (const u of currentPresenceUsers) {
    const dot = document.createElement("span")
    dot.className = "gowiki-presence-dot"
    if (u.mode === "edit") dot.classList.add("gowiki-presence-editing")

    const initial = (u.display_name || u.username).charAt(0).toUpperCase()
    dot.textContent = initial
    dot.style.background = presenceColor(u.username)
    if (u.mode === "edit") {
      dot.style.boxShadow = "0 0 0 2px #fff, 0 0 0 4px #ff9800"
    }

    dot.title = (u.display_name || u.username) + (u.mode === "edit" ? " (editing)" : " (viewing)")
    container.appendChild(dot)
  }
}

const presenceColors = [
  "#e53935",
  "#d81b60",
  "#8e24aa",
  "#5e35b1",
  "#3949ab",
  "#1e88e5",
  "#00897b",
  "#43a047",
  "#7cb342",
  "#f4511e",
  "#6d4c41",
  "#546e7a",
]

function presenceColor(username) {
  let hash = 0
  for (let i = 0; i < username.length; i++) {
    hash = ((hash << 5) - hash + username.charCodeAt(i)) | 0
  }
  return presenceColors[Math.abs(hash) % presenceColors.length]
}

bootstrap().catch((err) => {
  console.error("Failed to start frontend", err)
  if (err instanceof InvalidPathError) {
    // Show a friendly message for invalid URLs — not a software error.
    const contentRoot = document.getElementById("content")
    if (contentRoot) {
      contentRoot.innerHTML = `<div style="padding:2em;text-align:center;color:#666"><h2>Invalid page path</h2><p>${err.message}</p><p>The URL contains characters that are not allowed in page paths.</p><p><a href="/">Go to home page</a></p></div>`
    }
  } else {
    setStatus("Startup failed")
  }
})
