import { Plugin as PMPlugin, PluginKey, NodeSelection, EditorState } from "prosemirror-state"
import type { Node as PMNode, Schema } from "prosemirror-model"
import { EditorView } from "prosemirror-view"
import type { Plugin as WikiPlugin } from "../compiler/registry"
import type { Registry } from "../compiler/registry"
import { enablePropertiesPanel, requestInputFocus } from "../compiler/core_ui"
import { openMediaManager } from "../media_manager.js"

// ── Properties ──

const databaseQueryProperties = [
  {
    name: "table",
    label: "Table",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
  },
  {
    name: "fields",
    label: "Fields",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
  },
  {
    name: "filter",
    label: "Filter",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
  },
  {
    name: "sort",
    label: "Sort Field",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
  },
  {
    name: "order",
    label: "Sort Order",
    default: "asc",
    parse: (raw: string) => raw.trim() || "asc",
    serialize: (value: string | null) => String(value ?? "asc"),
    options: [
      { value: "asc", label: "Ascending" },
      { value: "desc", label: "Descending" },
    ],
  },
  {
    name: "limit",
    label: "Limit",
    default: "20",
    parse: (raw: string) => raw.trim() || "20",
    serialize: (value: string | null) => String(value ?? "20"),
  },
  {
    name: "pivot_rows",
    label: "Pivot rows",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
    helpText: "Field whose distinct values become rows (pivot mode).",
  },
  {
    name: "pivot_cols",
    label: "Pivot columns",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
    helpText: "Field whose distinct values become columns (pivot mode).",
  },
  {
    name: "pivot_cell",
    label: "Pivot cell",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
    helpText: "Field rendered inside each cell (pivot mode).",
  },
  {
    name: "pivot_agg",
    label: "Pivot aggregation",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
    options: [
      { value: "", label: "single (default — flag collisions)" },
      { value: "single", label: "single" },
      { value: "list", label: "list" },
      { value: "count", label: "count" },
      { value: "first", label: "first" },
      { value: "last", label: "last" },
    ],
  },
  {
    name: "pivot_empty",
    label: "Pivot empty text",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
  },
  {
    name: "pivot_cols_sort",
    label: "Pivot column sort",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
  },
  {
    name: "pivot_cols_max",
    label: "Pivot columns max",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
    helpText: "Refuse when distinct columns exceed this. Default 40.",
  },
  {
    name: "pivot_rows_labels",
    label: "Row labels (JSON)",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
    helpText:
      'Raw-value → display-label JSON for the row axis; keys sharing a label MERGE. Use "@null" for empty values. Example: {"Y":"Archived","N":"Active","@null":"Active"}.',
  },
  {
    name: "pivot_cols_labels",
    label: "Column labels (JSON)",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
    helpText: "Same as pivot_rows_labels but for the column axis.",
  },
]

const databaseRowProperties = [
  {
    name: "table",
    label: "Table",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
  },
]

const databaseNewRowProperties = [
  {
    name: "table",
    label: "Table",
    default: "",
    parse: (raw: string) => raw.trim() || null,
    serialize: (value: string | null) => String(value ?? ""),
  },
  {
    name: "fields",
    label: "Fields (comma-separated whitelist, empty = all)",
    default: "",
    parse: (raw: string) =>
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .join(","),
    serialize: (value: string | null) => String(value ?? ""),
    helpText:
      "Which columns to show in the form, in that order. Pinned (foo=val) and default (foo=~val) fields are always shown even when omitted here.",
  },
]

// applyPinnedValue writes `value` into whatever input the newrow form
// mapped for a given field name and locks it. Handles the three
// shapes the form emits: real HTMLInputElement / HTMLSelectElement,
// and the div-wrappers used for image and multi_enum (which expose a
// `.value` accessor).
//
// For a SELECT whose target option hasn't loaded yet (async foreign-key
// populations), prepend a synthetic option so the reader sees SOMETHING
// while the real options load. A MutationObserver then watches for the
// real option to arrive and rewrites the synthetic's LABEL to match
// it, so the reader sees "Sargon" instead of the row id "1". The
// duplicate real option is hidden — the select is locked anyway, so
// it would just be a duplicate in a dropdown nobody can open.
//
// Select locking: uses pointer-events + aria to *look* disabled, but
// leaves the DOM `disabled` attribute OFF so the select's `.value`
// still exposes the pinned value to JS-driven submits. (The caller's
// pinnedForSubmit override already forces the value regardless — this
// is belt-and-braces.)
// valueHasContent reports whether a stored row value is worth showing.
// The row NodeView drops archived-field rows whose value is empty (an
// archived column that never held anything is just noise), but keeps
// rows whose value is historical data.
//
// Handles the shapes _fields cells arrive in: null, "", "0"-for-refs,
// arrays for multi-enum, and objects for the rare complex column.
function valueHasContent(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === "string") return v.trim() !== ""
  if (typeof v === "number") return v !== 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === "object") return Object.keys(v as object).length > 0
  return !!v
}

export function applyPinnedValue(el: HTMLInputElement | HTMLSelectElement | HTMLDivElement, value: string): void {
  el.classList.add("gowiki-database-pinned")
  if (el instanceof HTMLSelectElement) {
    const select = el
    const existing = Array.from(select.options).find((o) => o.value === value)
    let synthetic: HTMLOptionElement | null = null
    if (existing) {
      existing.selected = true
    } else {
      synthetic = document.createElement("option")
      synthetic.value = value
      // Fallback label: use the raw value until the real option loads.
      // Real options that also match `value` will overwrite this
      // synthetic's textContent below via the MutationObserver.
      synthetic.textContent = value
      synthetic.selected = true
      synthetic.dataset.pinnedSynthetic = "1"
      select.insertBefore(synthetic, select.firstChild)

      // Watch for the async loader to append the real option. When it
      // shows up (matching value), copy its label onto the synthetic
      // and hide it so the reader sees the right name.
      const observer = new MutationObserver(() => {
        for (const opt of Array.from(select.options)) {
          if (opt === synthetic) continue
          if (opt.value === value) {
            if (synthetic) synthetic.textContent = opt.textContent || value
            opt.hidden = true
            observer.disconnect()
            return
          }
        }
      })
      observer.observe(select, { childList: true })
      // Safety net: async loaders that never fire (dead network) would
      // leave the observer running forever. Drop it after 15s — the
      // synthetic keeps the fallback (bare value) label but the
      // submit is still correct.
      setTimeout(() => observer.disconnect(), 15_000)
    }
    select.value = value
    // Lock via CSS + ARIA, not the disabled attribute — so `.value`
    // still returns the pinned option to JS submitters.
    select.setAttribute("aria-disabled", "true")
    select.setAttribute("tabindex", "-1")
    select.style.pointerEvents = "none"
    // Also prevent keyboard/programmatic mutation via the change
    // event: any change that isn't the pinned value snaps back.
    select.addEventListener("change", () => {
      if (select.value !== value) select.value = value
    })
    return
  }
  if (el instanceof HTMLInputElement) {
    el.value = value
    el.readOnly = true
    // readOnly is honoured by text/date/number inputs; still snap the
    // value back on change events so anything that bypasses readOnly
    // (drag-and-drop, IME) can't leak a different value in.
    el.addEventListener("change", () => {
      if (el.value !== value) el.value = value
    })
    return
  }
  // Div wrappers (image, multi_enum) — set the exposed .value, then
  // grey out interactive children. The wrapper doesn't have a real
  // "disabled" concept, so we intercept clicks with pointer-events.
  ;(el as unknown as { value: string }).value = value
  el.style.pointerEvents = "none"
  el.style.opacity = "0.6"
}

// ── Styles ──

const databaseStyles = `
.gowiki-database-query,
.gowiki-database-newrow,
.gowiki-database-row {
  margin: 0.5em 0;
  user-select: none;
  -webkit-user-select: none;
}

#app.gowiki-editing .gowiki-database-query,
#app.gowiki-editing .gowiki-database-newrow,
#app.gowiki-editing .gowiki-database-row {
  background: var(--gw-color-surface);
  border: 1px solid var(--gw-color-border);
  border-radius: 4px;
  padding: 8px;
}

#app.gowiki-editing .gowiki-database-query.ProseMirror-selectednode,
#app.gowiki-editing .gowiki-database-newrow.ProseMirror-selectednode,
#app.gowiki-editing .gowiki-database-row.ProseMirror-selectednode {
  outline: 2px solid #ffd43b;
  outline-offset: 1px;
}

.gowiki-database-query-label,
.gowiki-database-newrow-label,
.gowiki-database-row-label {
  font-size: 11px;
  color: var(--gw-color-muted);
  margin-bottom: 4px;
  font-family: monospace;
}

.gowiki-database-loading {
  color: var(--gw-color-muted);
  font-style: italic;
  padding: 8px;
}

.gowiki-database-error {
  color: var(--gw-color-error);
  font-style: italic;
  padding: 8px;
}

/* Ghost row: field present in the historical page but not in the current
   schema (hard-deleted after this page version was saved). The label reads
   "<name> (removed)" and the whole row is dimmed. */
.gowiki-database-row-ghost {
  color: var(--gw-color-muted);
  font-style: italic;
}
.gowiki-database-row-ghost td:first-child {
  font-weight: 400 !important;
}

/* Archived row: field soft-deleted from the schema but the row still
   carries a historical value. Rendered read-only with a subtle marker
   so the reader keeps the data in view without being invited to edit
   a column the backend refuses to write. Rows with an EMPTY archived
   value are dropped entirely by the render loop. */
.gowiki-database-row-archived {
  color: var(--gw-color-muted);
}
.gowiki-database-row-archived td:first-child {
  font-weight: 400 !important;
}

/* Query result table */
.gowiki-database-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 4px;
}

.gowiki-database-table th,
.gowiki-database-table td {
  border: 1px solid var(--gw-color-border);
  padding: 4px 8px;
  text-align: left;
  font-size: 13px;
}

.gowiki-database-table th {
  background: var(--gw-color-table-head-bg);
  color: var(--gw-color-table-head-fg);
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}

.gowiki-database-table th:hover {
  background: var(--gw-color-table-head-bg);
  filter: brightness(1.1);
}

.gowiki-database-table tr:nth-child(even) {
  background: var(--gw-color-surface);
}

.gowiki-database-pagination {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 4px;
  font-size: 12px;
  color: var(--gw-color-muted);
}

.gowiki-database-pagination button {
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

/* New row form */
.gowiki-database-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}

.gowiki-database-form-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gowiki-database-form-field label {
  min-width: 120px;
  font-size: 13px;
  font-weight: 500;
}

.gowiki-database-form-field input,
.gowiki-database-form-field select {
  flex: 1;
  padding: 4px 6px;
  font-size: 13px;
  border: 1px solid var(--gw-color-border);
  border-radius: 3px;
  background: var(--gw-color-bg);
  color: var(--gw-color-text);
  user-select: text;
  -webkit-user-select: text;
}

/* A field the directive text pinned (e.g. software={{id}}). Read-only
   for the reader; the visible cue is a lock glyph in the label and a
   muted background so it doesn't look like an editable field the
   author simply forgot to fill. */
.gowiki-database-pinned {
  background: var(--gw-color-surface, #f5f5f5) !important;
  color: var(--gw-color-muted, #666) !important;
  cursor: not-allowed !important;
}
.gowiki-database-form-field:has(.gowiki-database-pinned) label::after {
  content: " \u{1F512}";
  color: var(--gw-color-muted, #666);
  font-size: 11px;
}

.gowiki-database-form-actions {
  margin-top: 4px;
}

.gowiki-database-form-actions button {
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
  background: var(--gw-color-link);
  color: var(--gw-color-primary-fg);
  border: 1px solid var(--gw-color-link);
  border-radius: 3px;
}

.gowiki-database-form-actions button:hover {
  background: var(--gw-color-link-hover);
}

/* Inline editable values */
.gowiki-database-editable-value {
  cursor: pointer;
}

.gowiki-database-editable-value:hover {
  background: var(--gw-color-highlight);
}

.gowiki-database-page-link,
.ProseMirror a.gowiki-database-page-link {
  color: var(--gw-color-link-internal);
  text-decoration: none;
  cursor: pointer;
}

.gowiki-database-page-link:hover {
  text-decoration: underline;
}

/* Pivot mode. The row-header column carries the row axis label (or a link
   when the row resolves to a page-bound target). Empty cells stay quiet;
   collisions get a warning tint so a duplicate never reads as clean data. */
.gowiki-database-pivot th[scope="row"] {
  text-align: left;
  font-weight: 600;
  background: var(--gw-color-surface, transparent);
}

.gowiki-database-pivot-corner {
  font-weight: 500;
  font-size: 0.85em;
  color: var(--gw-color-muted);
  white-space: nowrap;
}

.gowiki-database-pivot-empty {
  color: var(--gw-color-muted);
}

.gowiki-database-pivot-empty-text {
  color: var(--gw-color-muted);
  font-style: italic;
}

.gowiki-database-pivot-collision {
  background: var(--gw-color-warning-bg, rgba(255, 212, 59, 0.25));
}

.db-image-cell {
  max-height: 24px;
  vertical-align: middle;
}

.db-image-input-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
}

.db-image-input-wrap input {
  flex: 1;
  min-width: 0;
}

.db-image-input-wrap button {
  white-space: nowrap;
  padding: 2px 6px;
  font-size: 12px;
  cursor: pointer;
}

.db-image-preview {
  max-height: 24px;
  vertical-align: middle;
  margin-left: 4px;
}

.db-color-swatch {
  display: inline-block;
  width: 20px;
  height: 20px;
  border-radius: 3px;
  border: 1px solid var(--gw-color-border);
  vertical-align: middle;
}

.db-multi-enum-input {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
}

.db-multi-enum-option {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: inherit;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.db-multi-enum-option input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}

.db-tag-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 12px;
  font-size: 12px;
  line-height: 18px;
  vertical-align: middle;
  white-space: nowrap;
}

.db-tag-icon {
  width: 14px;
  height: 14px;
  vertical-align: middle;
}

/* Template variables — resolved styled in edit mode only */
#app.gowiki-editing .gowiki-template-var {
  background: var(--gw-color-accent);
  border-radius: 3px;
  padding: 0 3px;
  font-style: normal;
}

/* Error state: unknown variable */
.gowiki-template-var-error {
  background: var(--gw-color-warning-bg);
  color: var(--gw-color-warning);
  border-radius: 3px;
  padding: 0 3px;
  font-weight: 600;
}
`

// ── Helpers ──

// Prevent ProseMirror from intercepting pointer/focus events on form inputs
// within the ProseMirror DOM tree (used for edit-mode inputs that live inside
// NodeViews and DON'T need cursor-click positioning — e.g. dropdowns).
function isolateInput(el: HTMLElement) {
  for (const evt of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const) {
    el.addEventListener(evt, (e) => e.stopPropagation())
  }
}

// Parse a multi_enum stored value into a Set of selected tokens.
// Tolerates legacy corrupted forms with surrounding brackets, e.g. "[France]".
function parseMultiEnumValue(raw: string): Set<string> {
  const cleaned = String(raw ?? "").replace(/^\s*\[(.*)\]\s*$/, "$1")
  return new Set(
    cleaned
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  )
}

// Build a checkbox-based multi-enum widget. The wrapper exposes a `value`
// property whose getter returns the canonical comma-joined CSV form and whose
// setter accepts the same form (used for programmatic resets). The widget
// dispatches a bubbling `change` event whenever any checkbox toggles, so the
// host can listen on the wrapper itself.
function createMultiEnumWidget(enumValues: string[], initial: string): HTMLDivElement {
  const wrap = document.createElement("div")
  wrap.className = "db-multi-enum-input"
  const selected = parseMultiEnumValue(initial)
  const checkboxes: HTMLInputElement[] = []
  for (const v of enumValues || []) {
    const lbl = document.createElement("label")
    lbl.className = "db-multi-enum-option"
    const cb = document.createElement("input")
    cb.type = "checkbox"
    cb.value = v
    cb.checked = selected.has(v)
    isolateInput(cb)
    cb.addEventListener("change", () => {
      wrap.dispatchEvent(new Event("change", { bubbles: true }))
    })
    checkboxes.push(cb)
    lbl.appendChild(cb)
    lbl.appendChild(document.createTextNode(" " + v))
    wrap.appendChild(lbl)
  }
  Object.defineProperty(wrap, "value", {
    get: () =>
      checkboxes
        .filter((c) => c.checked)
        .map((c) => c.value)
        .join(", "),
    set: (val: string) => {
      const set = parseMultiEnumValue(val)
      for (const cb of checkboxes) cb.checked = set.has(cb.value)
    },
  })
  return wrap
}

// ── Tag helpers ──

const tagTableCache = new Map<
  string,
  { data: Map<number, { label: string; icon: string; color: string }>; timestamp: number }
>()
const tagTableInflight = new Map<string, Promise<Map<number, { label: string; icon: string; color: string }>>>()

async function getTagOptions(tableName: string): Promise<Map<number, { label: string; icon: string; color: string }>> {
  const cached = tagTableCache.get(tableName)
  if (cached && Date.now() - cached.timestamp < 30000) return cached.data

  // Deduplicate in-flight requests: if a fetch for this table is already
  // in progress, reuse its promise instead of firing another request.
  const inflight = tagTableInflight.get(tableName)
  if (inflight) return inflight

  const promise = (async () => {
    const resp = await fetch(`/api/database/${encodeURIComponent(tableName)}/rows?limit=500`)
    if (!resp.ok) return new Map<number, { label: string; icon: string; color: string }>()
    const body = await resp.json()
    const rows: any[] = body.rows || []
    const result = new Map<number, { label: string; icon: string; color: string }>()
    for (const r of rows) {
      result.set(r.id, {
        label: String(r.fields?.label ?? ""),
        icon: String(r.fields?.icon ?? ""),
        color: String(r.fields?.color ?? ""),
      })
    }
    tagTableCache.set(tableName, { data: result, timestamp: Date.now() })
    return result
  })()

  tagTableInflight.set(tableName, promise)
  promise.finally(() => tagTableInflight.delete(tableName))
  return promise
}

function isLightColor(hex: string): boolean {
  const c = hex.replace("#", "")
  if (c.length < 6) return true
  const r = parseInt(c.substring(0, 2), 16)
  const g = parseInt(c.substring(2, 4), 16)
  const b = parseInt(c.substring(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 > 150
}

function renderTagBadge(tag: { label: string; icon: string; color: string }): HTMLSpanElement {
  const span = document.createElement("span")
  span.className = "db-tag-badge"
  if (tag.color) {
    span.style.backgroundColor = tag.color
    span.style.color = isLightColor(tag.color) ? "#333" : "#fff"
  } else {
    span.style.backgroundColor = "#e9ecef"
    span.style.color = "#333"
  }
  if (tag.icon) {
    const img = document.createElement("img")
    img.src = tag.icon
    img.className = "db-tag-icon"
    span.appendChild(img)
  }
  const text = document.createTextNode(tag.label || "(no label)")
  span.appendChild(text)
  return span
}

// ── Lookup helpers ──

const lookupTableCache = new Map<string, { data: Map<number, string>; timestamp: number }>()
const lookupTableInflight = new Map<string, Promise<Map<number, string>>>()

// lookupLabel names a referenced row: the declared display column when the
// row carries a value for it, else its `name` field, else its id. A display
// column that was archived or renamed is absent from the row, so the label
// falls through to `name` or the id.
export function lookupLabel(fields: Record<string, unknown>, id: number, displayColumn?: string): string {
  for (const col of [displayColumn, "name"]) {
    if (!col) continue
    const v = fields[col]
    if (v != null && v !== "") return String(v)
  }
  return String(id)
}

async function getLookupOptions(tableName: string, displayColumn?: string): Promise<Map<number, string>> {
  const key = tableName + "\x00" + (displayColumn || "")
  const cached = lookupTableCache.get(key)
  if (cached && Date.now() - cached.timestamp < 30000) return cached.data

  const inflight = lookupTableInflight.get(key)
  if (inflight) return inflight

  const promise = (async () => {
    const resp = await fetch(`/api/database/${encodeURIComponent(tableName)}/rows?limit=500`)
    if (!resp.ok) return new Map<number, string>()
    const body = await resp.json()
    const rows: any[] = body.rows || []
    const result = new Map<number, string>()
    for (const r of rows) {
      const fields = r.fields || {}
      result.set(r.id, lookupLabel(fields, r.id, displayColumn))
    }
    lookupTableCache.set(key, { data: result, timestamp: Date.now() })
    return result
  })()

  lookupTableInflight.set(key, promise)
  promise.finally(() => lookupTableInflight.delete(key))
  return promise
}

// ── User helpers ──

let userListCache: { data: { username: string; display_name: string }[]; timestamp: number } | null = null
let userListInflight: Promise<{ username: string; display_name: string }[]> | null = null

async function getUserList(): Promise<{ username: string; display_name: string }[]> {
  if (userListCache && Date.now() - userListCache.timestamp < 30000) return userListCache.data
  if (userListInflight) return userListInflight

  const promise = (async () => {
    const resp = await fetch("/api/users/list")
    if (!resp.ok) return []
    const body = await resp.json()
    const users = body.users || []
    userListCache = { data: users, timestamp: Date.now() }
    return users
  })()

  userListInflight = promise
  promise.finally(() => {
    userListInflight = null
  })
  return promise
}

function renderColorSwatch(color: string): HTMLSpanElement {
  const span = document.createElement("span")
  span.className = "db-color-swatch"
  if (color) span.style.backgroundColor = color
  return span
}

// Creates an overlay select that uses {value, label} option objects.
function createOverlaySelectKeyed(
  anchor: HTMLElement,
  opts: {
    options: { value: string; label: string }[]
    value: string
    onSave: (newValue: string) => void
    onCancel: () => void
  }
) {
  const rect = anchor.getBoundingClientRect()
  const sel = document.createElement("select")
  sel.style.position = "fixed"
  sel.style.left = rect.left + "px"
  sel.style.top = rect.top + "px"
  sel.style.width = Math.max(rect.width, 150) + "px"
  sel.style.height = rect.height + "px"
  sel.style.boxSizing = "border-box"
  sel.style.fontSize = "13px"
  sel.style.border = "2px solid var(--gw-color-link)"
  sel.style.borderRadius = "2px"
  sel.style.outline = "none"
  sel.style.zIndex = "10000"
  sel.style.background = "var(--gw-color-bg)"

  const emptyOpt = document.createElement("option")
  emptyOpt.value = ""
  emptyOpt.textContent = "-- Select --"
  sel.appendChild(emptyOpt)
  for (const o of opts.options) {
    const opt = document.createElement("option")
    opt.value = o.value
    opt.textContent = o.label
    if (o.value === opts.value) opt.selected = true
    sel.appendChild(opt)
  }

  const cleanup = () => {
    if (sel.parentNode) sel.remove()
  }

  sel.addEventListener("change", () => {
    opts.onSave(sel.value)
    cleanup()
  })
  sel.addEventListener("blur", () => {
    cleanup()
    opts.onCancel()
  })

  document.body.appendChild(sel)
  sel.focus()
  return sel
}

// Preset pastel colors suitable for tag/badge backgrounds.
const colorPresets = [
  "#adb5bd", // gray
  "#ffa8a8", // red
  "#fcc2d7", // pink
  "#eebefa", // purple
  "#b197fc", // violet
  "#91a7ff", // indigo
  "#74c0fc", // blue
  "#66d9e8", // cyan
  "#63e6be", // teal
  "#8ce99a", // green
  "#c0eb75", // lime
  "#ffe066", // yellow
  "#ffc078", // orange
  "#e9ecef", // light gray
  "#868e96", // dark gray
  "#ff6b6b", // saturated red
  "#cc5de8", // saturated purple
  "#5c7cfa", // saturated indigo
  "#22b8cf", // saturated cyan
  "#51cf66", // saturated green
  "#fcc419", // saturated yellow
  "#ff922b", // saturated orange
  "#f06595", // saturated pink
  "#845ef7", // saturated violet
]

// Creates a color picker overlay with preset swatches and a custom color input.
function createOverlayColorPicker(
  anchor: HTMLElement,
  opts: {
    value: string
    onSave: (newValue: string) => void
    onCancel: () => void
  }
) {
  const rect = anchor.getBoundingClientRect()
  const wrap = document.createElement("div")
  wrap.style.position = "fixed"
  wrap.style.left = rect.left + "px"
  wrap.style.top = rect.bottom + 2 + "px"
  wrap.style.zIndex = "10000"
  wrap.style.background = "var(--gw-color-bg)"
  wrap.style.border = "2px solid var(--gw-color-link)"
  wrap.style.borderRadius = "4px"
  wrap.style.padding = "8px"
  wrap.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)"
  wrap.style.width = "220px"

  // Preset grid.
  const grid = document.createElement("div")
  grid.style.display = "grid"
  grid.style.gridTemplateColumns = "repeat(8, 1fr)"
  grid.style.gap = "3px"
  grid.style.marginBottom = "6px"

  let saved = false
  const cleanup = () => {
    if (wrap.parentNode) wrap.remove()
  }

  for (const c of colorPresets) {
    const swatch = document.createElement("div")
    swatch.style.width = "22px"
    swatch.style.height = "22px"
    swatch.style.borderRadius = "3px"
    swatch.style.backgroundColor = c
    swatch.style.border = c === opts.value ? "2px solid var(--gw-color-link)" : "1px solid var(--gw-color-border)"
    swatch.style.cursor = "pointer"
    swatch.style.boxSizing = "border-box"
    swatch.addEventListener("click", () => {
      saved = true
      opts.onSave(c)
      cleanup()
    })
    grid.appendChild(swatch)
  }
  wrap.appendChild(grid)

  // Custom color row.
  const customRow = document.createElement("div")
  customRow.style.display = "flex"
  customRow.style.alignItems = "center"
  customRow.style.gap = "4px"

  const colorInput = document.createElement("input")
  colorInput.type = "color"
  colorInput.value = opts.value || "#adb5bd"
  colorInput.style.width = "30px"
  colorInput.style.height = "24px"
  colorInput.style.padding = "0"
  colorInput.style.border = "1px solid var(--gw-color-border)"
  colorInput.style.cursor = "pointer"
  customRow.appendChild(colorInput)

  const textInput = document.createElement("input")
  textInput.type = "text"
  textInput.value = opts.value || ""
  textInput.placeholder = "#rrggbb"
  textInput.style.flex = "1"
  textInput.style.fontSize = "12px"
  textInput.style.padding = "2px 4px"
  textInput.style.border = "1px solid var(--gw-color-border)"
  textInput.style.borderRadius = "2px"
  textInput.style.minWidth = "0"
  customRow.appendChild(textInput)

  const okBtn = document.createElement("button")
  okBtn.textContent = "OK"
  okBtn.style.fontSize = "12px"
  okBtn.style.padding = "2px 8px"
  okBtn.style.cursor = "pointer"
  customRow.appendChild(okBtn)

  colorInput.addEventListener("input", () => {
    textInput.value = colorInput.value
  })
  textInput.addEventListener("input", () => {
    if (/^#[0-9a-fA-F]{6}$/.test(textInput.value)) {
      colorInput.value = textInput.value
    }
  })
  okBtn.addEventListener("click", () => {
    saved = true
    opts.onSave(textInput.value || colorInput.value)
    cleanup()
  })
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault()
      saved = true
      opts.onSave(textInput.value || colorInput.value)
      cleanup()
    }
    if (e.key === "Escape") {
      e.preventDefault()
      saved = true
      opts.onCancel()
      cleanup()
    }
  })

  wrap.appendChild(customRow)

  // Close on outside click.
  const onOutside = (e: MouseEvent) => {
    if (!wrap.contains(e.target as Node)) {
      document.removeEventListener("mousedown", onOutside, true)
      if (!saved) {
        saved = true
        opts.onCancel()
      }
      cleanup()
    }
  }
  setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0)

  document.body.appendChild(wrap)
  return wrap
}

// Creates an inline edit overlay input OUTSIDE the ProseMirror DOM tree.
// ProseMirror's DOMObserver registers a document-level selectionchange handler
// that interferes with cursor positioning inside inputs that are descendants of
// view.dom. Rendering the input on document.body avoids this entirely.
function createOverlayInput(
  anchor: HTMLElement,
  opts: {
    type?: string
    value: string
    onSave: (newValue: string) => void
    onCancel: () => void
  }
) {
  const rect = anchor.getBoundingClientRect()
  const input = document.createElement("input")
  input.type = opts.type || "text"
  input.value = opts.value
  input.style.position = "fixed"
  input.style.left = rect.left + "px"
  input.style.top = rect.top + "px"
  input.style.width = rect.width + "px"
  input.style.height = rect.height + "px"
  input.style.boxSizing = "border-box"
  input.style.padding = "2px 4px"
  input.style.fontSize = "13px"
  input.style.border = "2px solid var(--gw-color-link)"
  input.style.borderRadius = "2px"
  input.style.outline = "none"
  input.style.zIndex = "10000"
  input.style.background = "var(--gw-color-bg)"

  let saved = false
  const cleanup = () => {
    if (input.parentNode) input.remove()
  }

  input.addEventListener("blur", () => {
    if (!saved) {
      saved = true
      opts.onSave(input.value)
    }
    cleanup()
  })
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault()
      saved = true
      opts.onSave(input.value)
      cleanup()
      input.blur()
    }
    if (e.key === "Escape") {
      e.preventDefault()
      saved = true
      opts.onCancel()
      cleanup()
      input.blur()
    }
  })

  document.body.appendChild(input)
  input.focus()
  input.select()
  return input
}

// Creates an inline edit overlay select OUTSIDE the ProseMirror DOM tree.
function createOverlaySelect(
  anchor: HTMLElement,
  opts: {
    options: string[]
    value: string
    onSave: (newValue: string) => void
    onCancel: () => void
  }
) {
  const rect = anchor.getBoundingClientRect()
  const sel = document.createElement("select")
  sel.style.position = "fixed"
  sel.style.left = rect.left + "px"
  sel.style.top = rect.top + "px"
  sel.style.width = rect.width + "px"
  sel.style.height = rect.height + "px"
  sel.style.boxSizing = "border-box"
  sel.style.fontSize = "13px"
  sel.style.border = "2px solid var(--gw-color-link)"
  sel.style.borderRadius = "2px"
  sel.style.outline = "none"
  sel.style.zIndex = "10000"
  sel.style.background = "var(--gw-color-bg)"

  const emptyOpt = document.createElement("option")
  emptyOpt.value = ""
  emptyOpt.textContent = "-- Select --"
  sel.appendChild(emptyOpt)
  for (const v of opts.options) {
    const opt = document.createElement("option")
    opt.value = v
    opt.textContent = v
    if (v === opts.value) opt.selected = true
    sel.appendChild(opt)
  }

  const cleanup = () => {
    if (sel.parentNode) sel.remove()
  }

  sel.addEventListener("change", () => {
    opts.onSave(sel.value)
    cleanup()
  })
  sel.addEventListener("blur", () => {
    cleanup()
    opts.onCancel()
  })

  document.body.appendChild(sel)
  sel.focus()
  return sel
}

// Creates a popover multi-enum picker anchored to a table cell. Saves on
// blur outside the popover (commit-on-close), cancels on Escape.
function createOverlayMultiEnum(
  anchor: HTMLElement,
  opts: {
    options: string[]
    value: string
    onSave: (newValue: string) => void
    onCancel: () => void
  }
) {
  const rect = anchor.getBoundingClientRect()
  const pop = document.createElement("div")
  pop.tabIndex = -1
  pop.style.position = "fixed"
  pop.style.left = rect.left + "px"
  pop.style.top = rect.bottom + 2 + "px"
  pop.style.minWidth = rect.width + "px"
  pop.style.maxWidth = "560px"
  pop.style.padding = "8px 10px"
  pop.style.border = "2px solid var(--gw-color-link)"
  pop.style.borderRadius = "4px"
  pop.style.zIndex = "10000"
  pop.style.background = "var(--gw-color-bg)"
  pop.style.color = "var(--gw-color-text)"
  pop.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)"
  pop.style.outline = "none"

  const widget = createMultiEnumWidget(opts.options, opts.value)
  pop.appendChild(widget)

  let saved = false
  const cleanup = () => {
    if (pop.parentNode) pop.remove()
  }

  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault()
      saved = true // mark as handled so blur doesn't double-fire onSave
      cleanup()
      opts.onCancel()
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (saved) return
      saved = true
      opts.onSave((widget as any).value)
      cleanup()
    }
  })

  pop.addEventListener("focusout", (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null
    if (next && pop.contains(next)) return
    if (saved) return
    saved = true
    opts.onSave((widget as any).value)
    cleanup()
  })

  document.body.appendChild(pop)
  pop.focus()
  return pop
}

// Creates an inline edit overlay with text input + browse button for image fields.
function createOverlayImageInput(
  anchor: HTMLElement,
  opts: {
    value: string
    onSave: (newValue: string) => void
    onCancel: () => void
  }
) {
  const rect = anchor.getBoundingClientRect()
  const wrap = document.createElement("div")
  wrap.style.position = "fixed"
  wrap.style.left = rect.left + "px"
  wrap.style.top = rect.top + "px"
  wrap.style.width = Math.max(rect.width, 250) + "px"
  wrap.style.height = rect.height + "px"
  wrap.style.boxSizing = "border-box"
  wrap.style.display = "flex"
  wrap.style.gap = "4px"
  wrap.style.alignItems = "center"
  wrap.style.zIndex = "10000"
  wrap.style.background = "var(--gw-color-bg)"
  wrap.style.border = "2px solid var(--gw-color-link)"
  wrap.style.borderRadius = "2px"
  wrap.style.padding = "0 4px"

  const input = document.createElement("input")
  input.type = "text"
  input.value = opts.value
  input.placeholder = "/path/to/image.png"
  input.style.flex = "1"
  input.style.minWidth = "0"
  input.style.border = "none"
  input.style.outline = "none"
  input.style.fontSize = "13px"
  input.style.padding = "2px 4px"
  wrap.appendChild(input)

  const btn = document.createElement("button")
  btn.type = "button"
  btn.textContent = "Browse"
  btn.style.whiteSpace = "nowrap"
  btn.style.padding = "2px 6px"
  btn.style.fontSize = "12px"
  btn.style.cursor = "pointer"
  wrap.appendChild(btn)

  let saved = false
  const cleanup = () => {
    if (wrap.parentNode) wrap.remove()
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation()
    const ns = window.location.pathname.replace(/^\/+/, "").replace(/\/[^/]*$/, "") || ""
    openMediaManager(
      ns,
      () => {},
      (_type: string, entry: any) => {
        const insertedPath = entry.path
        input.value = insertedPath
        saved = true
        opts.onSave(input.value)
        cleanup()
      }
    )
  })

  input.addEventListener("blur", () => {
    // Delay to allow browse button click to fire first.
    setTimeout(() => {
      if (!saved && wrap.parentNode) {
        saved = true
        opts.onSave(input.value)
        cleanup()
      }
    }, 150)
  })
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault()
      saved = true
      opts.onSave(input.value)
      cleanup()
    }
    if (e.key === "Escape") {
      e.preventDefault()
      saved = true
      opts.onCancel()
      cleanup()
    }
  })

  document.body.appendChild(wrap)
  input.focus()
  input.select()
}

// Custom event name for cross-NodeView communication.
const DATABASE_ROW_CREATED = "gowiki-database-row-created"
const DATABASE_ROW_UPDATED = "gowiki-database-row-updated"

// Module-wide guard against concurrent PUTs targeting the same field. A stuck
// row-bound page version-state bug in production was traced to two PUTs racing
// for the same field (widget double-fire on native date inputs). Serialize here
// so the backend never sees interleaved writes for the same key.
const inflightSaveKeys = new Set<string>()

// ── NodeViews ──

class DatabaseQueryNodeView {
  dom: HTMLElement
  private node: PMNode
  private view: EditorView
  private currentSort: string
  private currentOrder: string
  private initialLimit: number
  private displayLimit: number
  private refreshHandler: ((e: Event) => void) | null = null

  constructor(node: PMNode, view: EditorView, _getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.currentSort = node.attrs.sort === "id" ? "__title__" : node.attrs.sort || ""
    this.currentOrder = node.attrs.order || "asc"
    this.initialLimit = parseInt(node.attrs.limit) || 20
    this.displayLimit = this.initialLimit

    this.dom = document.createElement("div")
    this.dom.className = "gowiki-database-query"
    this.dom.contentEditable = "false"

    // Listen for row creation events from DatabaseNewRowNodeView.
    this.refreshHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.table === this.node.attrs.table) {
        this.fetchData()
      }
    }
    document.addEventListener(DATABASE_ROW_CREATED, this.refreshHandler)

    this.render()
  }

  private render() {
    this.dom.innerHTML = ""
    const table = this.node.attrs.table
    if (!table) {
      this.dom.innerHTML = '<div class="gowiki-database-error">No table specified</div>'
      return
    }

    const label = document.createElement("div")
    label.className = "gowiki-database-query-label"
    label.textContent = `Database: ${table}`
    this.dom.appendChild(label)

    this.fetchData()
  }

  private isPivotMode(): boolean {
    const a = this.node.attrs
    return !!(
      a.pivot_rows ||
      a.pivot_cols ||
      a.pivot_cell ||
      a.pivot_agg ||
      a.pivot_empty ||
      a.pivot_cols_sort ||
      a.pivot_cols_max ||
      a.pivot_rows_labels ||
      a.pivot_cols_labels
    )
  }

  private async fetchData() {
    const table = this.node.attrs.table
    // Expand {{name}} references before we hand the filter to the backend.
    // The backend has no idea about the current page's template context,
    // so `filter="id={{id}}"` on a database-row-bound page only works if
    // we resolve {{id}} to the row's value here. Same policy as the
    // template-var NodeView: try globals first (TITLE, VERSION, …),
    // then database-row fields; leave unresolved names literal so a
    // typo shows up in the request rather than silently becoming "".
    const filter = expandTemplateVars(this.node.attrs.filter || "", this.view)

    const params = new URLSearchParams()
    if (filter) {
      for (const f of filter.split("&")) {
        params.append("filter", f)
      }
    }
    if (this.currentSort) params.set("sort", this.currentSort === "__title__" ? "id" : this.currentSort)
    if (this.currentOrder) params.set("order", this.currentOrder)

    if (this.isPivotMode()) {
      const a = this.node.attrs
      if (a.pivot_rows) params.set("pivot_rows", a.pivot_rows)
      if (a.pivot_cols) params.set("pivot_cols", a.pivot_cols)
      if (a.pivot_cell) params.set("pivot_cell", a.pivot_cell)
      if (a.pivot_agg) params.set("pivot_agg", a.pivot_agg)
      if (a.pivot_empty) params.set("pivot_empty", a.pivot_empty)
      if (a.pivot_cols_sort) params.set("pivot_cols_sort", a.pivot_cols_sort)
      if (a.pivot_cols_max) params.set("pivot_cols_max", a.pivot_cols_max)
      if (a.pivot_rows_labels) params.set("pivot_rows_labels", a.pivot_rows_labels)
      if (a.pivot_cols_labels) params.set("pivot_cols_labels", a.pivot_cols_labels)

      try {
        const resp = await fetch(`/api/database/${encodeURIComponent(table)}/rows?${params}`)
        if (resp.status === 400) {
          const body = await resp.json().catch(() => ({}))
          this.showError(body.error || "Pivot: invalid parameters")
          return
        }
        if (!resp.ok) {
          this.showError("Failed to load pivot")
          return
        }
        const data = await resp.json()
        this.renderPivot(data)
        document.dispatchEvent(new Event("gowiki:node-rendered"))
      } catch {
        this.showError("Network error")
      }
      return
    }

    params.set("limit", String(this.displayLimit))
    params.set("offset", "0")

    try {
      const schemaResp = await fetch(`/api/database/${encodeURIComponent(table)}/schema`)
      if (!schemaResp.ok) {
        this.showError("Table not found: " + table)
        return
      }
      const schema = await schemaResp.json()

      const resp = await fetch(`/api/database/${encodeURIComponent(table)}/rows?${params}`)
      if (!resp.ok) {
        this.showError("Failed to load data")
        return
      }
      const data = await resp.json()
      this.renderTable(schema, data.rows || [], data.total || 0)
      document.dispatchEvent(new Event("gowiki:node-rendered"))
    } catch (err) {
      this.showError("Network error")
    }
  }

  private renderPivot(result: any) {
    // Clean previous.
    const existing = this.dom.querySelector(".gowiki-database-loading")
    if (existing) existing.remove()
    const existingTable = this.dom.querySelector(".gowiki-database-table")
    if (existingTable) existingTable.remove()
    const existingPag = this.dom.querySelector(".gowiki-database-pagination")
    if (existingPag) existingPag.remove()
    const existingErr = this.dom.querySelector(".gowiki-database-error")
    if (existingErr) existingErr.remove()

    const rows: any[] = result.rows || []
    const cols: any[] = result.cols || []
    const cells: any[][] = result.cells || []
    const emptyText: string = result.empty || ""

    const tbl = document.createElement("table")
    tbl.className = "gowiki-database-table gowiki-database-pivot"

    // Header.
    const thead = document.createElement("thead")
    const htr = document.createElement("tr")
    const corner = document.createElement("th")
    corner.textContent = `${result.row_field || ""} \\ ${result.col_field || ""}`
    corner.className = "gowiki-database-pivot-corner"
    htr.appendChild(corner)
    for (const c of cols) {
      const th = document.createElement("th")
      if (c.page_path) {
        const a = document.createElement("a")
        a.className = "gowiki-database-page-link"
        a.href = c.page_path
        a.textContent = String(c.label ?? c.key ?? "")
        th.appendChild(a)
      } else {
        th.textContent = String(c.label ?? c.key ?? "")
      }
      htr.appendChild(th)
    }
    thead.appendChild(htr)
    tbl.appendChild(thead)

    // Body.
    const tbody = document.createElement("tbody")
    for (let i = 0; i < rows.length; i++) {
      const tr = document.createElement("tr")
      const rh = document.createElement("th")
      rh.scope = "row"
      const rv = rows[i]
      if (rv?.page_path) {
        const a = document.createElement("a")
        a.className = "gowiki-database-page-link"
        a.href = rv.page_path
        a.textContent = String(rv.label ?? rv.key ?? "")
        rh.appendChild(a)
      } else {
        rh.textContent = String(rv?.label ?? rv?.key ?? "")
      }
      tr.appendChild(rh)

      const line = cells[i] || []
      for (let j = 0; j < cols.length; j++) {
        const cell = line[j] || { empty: true }
        const td = document.createElement("td")
        if (cell.empty) {
          if (emptyText) {
            td.textContent = emptyText
            td.className = "gowiki-database-pivot-empty-text"
          } else {
            td.className = "gowiki-database-pivot-empty"
          }
        } else if (cell.collision) {
          td.className = "gowiki-database-pivot-collision"
          td.title = "Collision — multiple rows fell in this cell"
          td.textContent = (cell.values || []).join(" · ")
        } else if (cell.values && cell.values.length > 0) {
          td.textContent = cell.values.join(", ")
        } else if (cell.page_path) {
          const a = document.createElement("a")
          a.className = "gowiki-database-page-link"
          a.href = cell.page_path
          a.textContent = String(cell.value ?? "")
          td.appendChild(a)
        } else {
          td.textContent = String(cell.value ?? "")
        }
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    tbl.appendChild(tbody)

    this.dom.appendChild(tbl)
  }

  private renderTable(schema: any, rows: any[], total: number) {
    // Remove loading, keep label.
    const existing = this.dom.querySelector(".gowiki-database-loading")
    if (existing) existing.remove()
    const existingTable = this.dom.querySelector(".gowiki-database-table")
    if (existingTable) existingTable.remove()
    const existingPag = this.dom.querySelector(".gowiki-database-pagination")
    if (existingPag) existingPag.remove()

    const allFields = (schema.fields || []).filter((f: any) => !f.archived_at)
    const idField = { name: "__title__", label: "ID", type: "text", _isTitle: true }

    // Apply fields filter: select and order columns by the fields attribute.
    // %title% is a special token: positions the ID column explicitly.
    // If %title% is not used, the ID column is always prepended as the first column.
    const fieldsAttr = this.node.attrs.fields || ""
    let fields: any[]
    let hasExplicitTitle = false
    if (fieldsAttr) {
      const colNames = fieldsAttr
        .split(",")
        .map((c: string) => c.trim())
        .filter((c: string) => c)
      fields = []
      for (const col of colNames) {
        if (col === "%title%") {
          hasExplicitTitle = true
          fields.push(idField)
        } else {
          // Match by field name or label (case-insensitive).
          const lower = col.toLowerCase()
          const f = allFields.find(
            (f: any) => f.name === col || f.name === lower || (f.label && f.label.toLowerCase() === lower)
          )
          if (f && !fields.some((ef: any) => ef.name === f.name)) {
            fields.push(f)
          }
        }
      }
      if (!hasExplicitTitle) fields.unshift(idField)
    } else {
      fields = [idField, ...allFields]
    }

    const tbl = document.createElement("table")
    tbl.className = "gowiki-database-table"

    // Header.
    const thead = document.createElement("thead")
    const tr = document.createElement("tr")
    for (const f of fields) {
      const th = document.createElement("th")
      th.textContent = f.label || f.name
      if (this.currentSort === f.name) {
        th.textContent += this.currentOrder === "asc" ? " \u25B2" : " \u25BC"
      }
      th.addEventListener("click", () => {
        if (this.currentSort === f.name) {
          this.currentOrder = this.currentOrder === "asc" ? "desc" : "asc"
        } else {
          this.currentSort = f.name
          this.currentOrder = "asc"
        }
        this.displayLimit = this.initialLimit
        this.fetchData()
      })
      tr.appendChild(th)
    }
    thead.appendChild(tr)
    tbl.appendChild(thead)

    // Body.
    const tableName = this.node.attrs.table
    const tbody = document.createElement("tbody")
    for (const row of rows) {
      const rtr = document.createElement("tr")
      for (const f of fields) {
        const td = document.createElement("td")
        const val = f.name === "__title__" ? row.id : row.fields?.[f.name]
        if (f._isTitle && row.page_path) {
          // %title%: row id as a clickable link to the page.
          const a = document.createElement("a")
          a.className = "gowiki-database-page-link"
          a.textContent = String(row.id)
          a.href = row.page_path
          td.appendChild(a)
        } else if (f.type === "page_link" && val) {
          const a = document.createElement("a")
          a.className = "gowiki-database-page-link"
          a.textContent = String(val)
          a.href = String(val)
          td.appendChild(a)
        } else if (f.type === "image" && val) {
          const img = document.createElement("img")
          img.src = String(val)
          img.className = "db-image-cell"
          td.appendChild(img)
        } else if (f.type === "color" && val) {
          td.appendChild(renderColorSwatch(String(val)))
        } else if (f.type === "tag" && f.foreign_key) {
          if (val && Number(val) !== 0) {
            td.textContent = "..."
            getTagOptions(f.foreign_key).then((tags) => {
              td.textContent = ""
              const tag = tags.get(Number(val))
              if (tag) td.appendChild(renderTagBadge(tag))
              else td.textContent = String(val)
            })
          }
        } else if (f.type === "lookup" && f.foreign_key) {
          if (val && Number(val) !== 0) {
            td.textContent = "..."
            getLookupOptions(f.foreign_key, f.display_column).then((opts) => {
              td.textContent = opts.get(Number(val)) || String(val)
            })
          }
        } else if (f.type === "user" && val) {
          td.textContent = String(val)
          fetchUserInfo(String(val)).then((info) => {
            if (info.label) td.textContent = info.label
          })
        } else if ((f.type === "date" || f.type === "datetime") && val) {
          // Format ISO dates as YYYY-MM-DD.
          const s = String(val)
          td.textContent = s.length >= 10 ? s.substring(0, 10) : s
        } else if (Array.isArray(val)) {
          td.textContent = val.join(", ")
        } else {
          td.textContent = val != null ? String(val) : ""
        }

        // Double-click inline editing — forbidden for auto_increment and %title% synthetic fields.
        if (f.type !== "auto_increment" && !f._isTitle) {
          td.className = "gowiki-database-editable-value"
          ;(td as any).__gwVal = val
          td.addEventListener("dblclick", () => {
            this.inlineEditCell(td, tableName, row.id, f, (td as any).__gwVal)
          })
        }

        rtr.appendChild(td)
      }
      tbody.appendChild(rtr)
    }
    tbl.appendChild(tbody)
    this.dom.appendChild(tbl)

    // Show more.
    if (total > rows.length) {
      const pag = document.createElement("div")
      pag.className = "gowiki-database-pagination"

      const info = document.createElement("span")
      info.textContent = `Showing ${rows.length} of ${total}`
      pag.appendChild(info)

      const more = document.createElement("button")
      more.textContent = "Show more"
      more.addEventListener("click", () => {
        this.displayLimit += this.initialLimit
        this.fetchData()
      })
      pag.appendChild(more)

      this.dom.appendChild(pag)
    }
  }

  private async saveInlineEdit(
    tableName: string,
    rowId: number,
    fieldName: string,
    newVal: string,
    force = false
  ): Promise<boolean> {
    const key = `${tableName}:${rowId}:${fieldName}`
    if (inflightSaveKeys.has(key)) return false // another PUT for this key is already in flight
    inflightSaveKeys.add(key)
    try {
      const url = `/api/database/${encodeURIComponent(tableName)}/rows/${rowId}${force ? "?force=true" : ""}`
      const resp = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { [fieldName]: newVal } }),
      })
      if (resp.status === 409) {
        const body = await resp.json().catch(() => ({}))
        if (body.error === "page_draft_conflict") {
          const ok = confirm(`A draft by "${body.draft_owner}" exists for this row's page. Force the edit?`)
          // Release the guard before recursing so the retry can acquire it.
          inflightSaveKeys.delete(key)
          if (ok) return this.saveInlineEdit(tableName, rowId, fieldName, newVal, true)
          return false
        }
      }
      if (resp.ok) {
        // Notify listeners (e.g. the history modal) that a row was updated so
        // they can invalidate any cached read of the row-bound page.
        let pagePath = ""
        try {
          const body = await resp
            .clone()
            .json()
            .catch(() => ({}))
          pagePath = (body as any)?.page_path || ""
        } catch {}
        document.dispatchEvent(
          new CustomEvent(DATABASE_ROW_UPDATED, {
            detail: { table: tableName, rowId, fieldName, pagePath },
          })
        )
      }
      return resp.ok
    } finally {
      inflightSaveKeys.delete(key)
    }
  }

  // Saves an inline edit and, on success, updates the cached value stashed on
  // the cell so the next dblclick opens with the fresh data instead of the
  // original render-time closure value.
  private async saveInlineEditAndCache(
    td: HTMLElement,
    tableName: string,
    rowId: number,
    fieldName: string,
    newVal: any
  ): Promise<boolean> {
    const ok = await this.saveInlineEdit(
      tableName,
      rowId,
      fieldName,
      typeof newVal === "string" ? newVal : String(newVal)
    )
    if (ok) (td as any).__gwVal = newVal
    return ok
  }

  private inlineEditCell(td: HTMLElement, tableName: string, rowId: number, field: any, currentValue: any) {
    const displayValue = Array.isArray(currentValue)
      ? currentValue.join(", ")
      : currentValue != null
        ? String(currentValue)
        : ""

    if (field.type === "enum") {
      createOverlaySelect(td, {
        options: field.enum_values || [],
        value: displayValue,
        onSave: async (newVal) => {
          td.textContent = newVal
          const ok = await this.saveInlineEditAndCache(td, tableName, rowId, field.name, newVal)
          if (!ok) {
            td.textContent = displayValue
          }
        },
        onCancel: () => {},
      })
    } else if (field.type === "multi_enum") {
      createOverlayMultiEnum(td, {
        options: field.enum_values || [],
        value: displayValue,
        onSave: async (newVal) => {
          td.textContent = newVal
          const ok = await this.saveInlineEditAndCache(td, tableName, rowId, field.name, newVal)
          if (!ok) {
            td.textContent = displayValue
          }
        },
        onCancel: () => {},
      })
    } else if (field.type === "boolean") {
      const newVal = currentValue === true || currentValue === "true" ? "false" : "true"
      td.textContent = newVal
      this.saveInlineEditAndCache(td, tableName, rowId, field.name, newVal).then((ok) => {
        if (!ok) td.textContent = displayValue
      })
    } else if (field.type === "color") {
      createOverlayColorPicker(td, {
        value: displayValue || "#adb5bd",
        onSave: async (newVal) => {
          td.textContent = ""
          td.appendChild(renderColorSwatch(newVal))
          td.className = "gowiki-database-editable-value"
          const ok = await this.saveInlineEditAndCache(td, tableName, rowId, field.name, newVal)
          if (!ok) {
            td.textContent = ""
            td.appendChild(renderColorSwatch(displayValue))
          }
        },
        onCancel: () => {},
      })
    } else if (field.type === "tag" && field.foreign_key) {
      getTagOptions(field.foreign_key).then((tags) => {
        const options: { value: string; label: string }[] = []
        tags.forEach((t, id) => options.push({ value: String(id), label: t.label || String(id) }))
        createOverlaySelectKeyed(td, {
          options,
          value: displayValue,
          onSave: async (newVal) => {
            td.textContent = ""
            const tag = tags.get(Number(newVal))
            if (tag) td.appendChild(renderTagBadge(tag))
            else td.textContent = newVal
            td.className = "gowiki-database-editable-value"
            const ok = await this.saveInlineEditAndCache(td, tableName, rowId, field.name, newVal)
            if (!ok) {
              td.textContent = ""
              const oldTag = tags.get(Number(displayValue))
              if (oldTag) td.appendChild(renderTagBadge(oldTag))
              else td.textContent = displayValue
            }
          },
          onCancel: () => {},
        })
      })
    } else if (field.type === "lookup" && field.foreign_key) {
      getLookupOptions(field.foreign_key, field.display_column).then((opts) => {
        const options: { value: string; label: string }[] = []
        opts.forEach((label, id) => options.push({ value: String(id), label }))
        createOverlaySelectKeyed(td, {
          options,
          value: displayValue,
          onSave: async (newVal) => {
            td.textContent = opts.get(Number(newVal)) || newVal
            td.className = "gowiki-database-editable-value"
            const ok = await this.saveInlineEditAndCache(td, tableName, rowId, field.name, newVal)
            if (!ok) td.textContent = opts.get(Number(displayValue)) || displayValue
          },
          onCancel: () => {},
        })
      })
    } else if (field.type === "user") {
      getUserList().then((users) => {
        const options = users.map((u) => ({ value: u.username, label: u.display_name || u.username }))
        createOverlaySelectKeyed(td, {
          options,
          value: displayValue,
          onSave: async (newVal) => {
            const u = users.find((u) => u.username === newVal)
            td.textContent = u?.display_name || newVal
            td.className = "gowiki-database-editable-value"
            const ok = await this.saveInlineEditAndCache(td, tableName, rowId, field.name, newVal)
            if (!ok) {
              const old = users.find((u) => u.username === displayValue)
              td.textContent = old?.display_name || displayValue
            }
          },
          onCancel: () => {},
        })
      })
    } else if (field.type === "image") {
      createOverlayImageInput(td, {
        value: displayValue,
        onSave: async (newVal) => {
          td.textContent = ""
          if (newVal) {
            const img = document.createElement("img")
            img.src = newVal
            img.className = "db-image-cell"
            td.appendChild(img)
          }
          td.className = "gowiki-database-editable-value"
          const ok = await this.saveInlineEditAndCache(td, tableName, rowId, field.name, newVal)
          if (!ok) {
            td.textContent = ""
            if (displayValue) {
              const img = document.createElement("img")
              img.src = displayValue
              img.className = "db-image-cell"
              td.appendChild(img)
            }
          }
        },
        onCancel: () => {},
      })
    } else {
      createOverlayInput(td, {
        type: field.type === "date" ? "date" : field.type === "integer" || field.type === "float" ? "number" : "text",
        value: displayValue,
        onSave: async (newVal) => {
          td.textContent = newVal
          td.className = "gowiki-database-editable-value"
          const ok = await this.saveInlineEditAndCache(td, tableName, rowId, field.name, newVal)
          if (!ok) {
            td.textContent = displayValue
            td.style.color = "var(--gw-color-error)"
            setTimeout(() => {
              td.style.color = ""
            }, 2000)
          }
        },
        onCancel: () => {},
      })
    }
  }

  private showError(message: string) {
    const el = document.createElement("div")
    el.className = "gowiki-database-error"
    el.textContent = message
    this.dom.appendChild(el)
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    const pivotChanged =
      node.attrs.pivot_rows !== this.node.attrs.pivot_rows ||
      node.attrs.pivot_cols !== this.node.attrs.pivot_cols ||
      node.attrs.pivot_cell !== this.node.attrs.pivot_cell ||
      node.attrs.pivot_agg !== this.node.attrs.pivot_agg ||
      node.attrs.pivot_empty !== this.node.attrs.pivot_empty ||
      node.attrs.pivot_cols_sort !== this.node.attrs.pivot_cols_sort ||
      node.attrs.pivot_cols_max !== this.node.attrs.pivot_cols_max ||
      node.attrs.pivot_rows_labels !== this.node.attrs.pivot_rows_labels ||
      node.attrs.pivot_cols_labels !== this.node.attrs.pivot_cols_labels
    if (
      node.attrs.table !== this.node.attrs.table ||
      node.attrs.fields !== this.node.attrs.fields ||
      node.attrs.filter !== this.node.attrs.filter ||
      pivotChanged
    ) {
      this.node = node
      this.currentSort = node.attrs.sort === "id" ? "__title__" : node.attrs.sort || ""
      this.currentOrder = node.attrs.order || "asc"
      this.initialLimit = parseInt(node.attrs.limit) || 20
      this.displayLimit = this.initialLimit
      this.render()
      return true
    }
    this.node = node
    return true
  }

  stopEvent(event: Event): boolean {
    // Stop mouse events to prevent ProseMirror from creating text selections
    // across the document when clicking inside database tables.
    const type = event.type
    if (type === "mousedown" || type === "mouseup" || type === "click" || type === "dblclick") return true
    const tag = (event.target as HTMLElement)?.tagName
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return true
    return false
  }
  ignoreMutation(): boolean {
    return true
  }
  destroy() {
    if (this.refreshHandler) {
      document.removeEventListener(DATABASE_ROW_CREATED, this.refreshHandler)
      this.refreshHandler = null
    }
  }
}

class DatabaseNewRowNodeView {
  dom: HTMLElement
  private node: PMNode
  private view: EditorView

  constructor(node: PMNode, view: EditorView, _getPos: () => number | undefined) {
    this.node = node
    this.view = view

    this.dom = document.createElement("div")
    this.dom.className = "gowiki-database-newrow"
    this.dom.contentEditable = "false"

    this.render()
  }

  // resolvedPinned parses the JSON blob and interpolates {{name}}
  // tokens against the current document's template context (globals
  // + database-row _fields). Called once per render — mirroring the
  // same policy database-query uses for its filter attr.
  private resolvedPinned(): Record<string, string> {
    return this.resolveJSONMap(this.node.attrs._pinned)
  }

  // resolvedDefaults does the same for the `_defaults` blob — field
  // prefills written with the `foo=~value` modifier. Semantics match
  // _pinned up to editability: the user is free to overwrite.
  private resolvedDefaults(): Record<string, string> {
    return this.resolveJSONMap(this.node.attrs._defaults)
  }

  private resolveJSONMap(raw: string | undefined): Record<string, string> {
    let parsed: Record<string, string> = {}
    try {
      parsed = JSON.parse(raw || "{}") as Record<string, string>
    } catch {
      parsed = {}
    }
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      out[k] = expandTemplateVars(String(v ?? ""), this.view)
    }
    return out
  }

  private render() {
    this.dom.innerHTML = ""
    const table = this.node.attrs.table
    if (!table) {
      this.dom.innerHTML = '<div class="gowiki-database-error">No table specified</div>'
      return
    }

    const label = document.createElement("div")
    label.className = "gowiki-database-newrow-label"
    label.textContent = `New row: ${table}`
    this.dom.appendChild(label)

    this.fetchSchemaAndRenderForm()
  }

  private async fetchSchemaAndRenderForm() {
    const table = this.node.attrs.table
    try {
      const resp = await fetch(`/api/database/${encodeURIComponent(table)}/schema`)
      if (!resp.ok) {
        this.showError("Table not found: " + table)
        return
      }
      const schema = await resp.json()
      this.renderForm(schema)
      document.dispatchEvent(new Event("gowiki:node-rendered"))
    } catch {
      this.showError("Network error")
    }
  }

  private renderForm(schema: any) {
    const allFields = (schema.fields || []).filter((f: any) => !f.archived_at && f.type !== "auto_increment")
    // Apply the `fields=` whitelist when present. Pinned + default
    // fields are always included even if the whitelist omits them —
    // the author's intent to pre-fill a field implies they want it
    // in the form. Order: whitelist order first, then any remaining
    // forced-visible fields appended.
    const whitelistCSV = String(this.node.attrs.fields || "").trim()
    const pinnedMap = this.resolvedPinned()
    const defaultMap = this.resolvedDefaults()
    let fields: any[]
    if (whitelistCSV === "") {
      fields = allFields
    } else {
      const whitelist = whitelistCSV
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
      const forced = new Set([...Object.keys(pinnedMap), ...Object.keys(defaultMap)])
      const byName = new Map<string, any>(allFields.map((f: any) => [f.name, f]))
      const picked: any[] = []
      const pickedNames = new Set<string>()
      for (const name of whitelist) {
        const f = byName.get(name)
        if (f && !pickedNames.has(name)) {
          picked.push(f)
          pickedNames.add(name)
        }
      }
      for (const f of allFields) {
        if (forced.has(f.name) && !pickedNames.has(f.name)) {
          picked.push(f)
          pickedNames.add(f.name)
        }
      }
      fields = picked
    }
    const form = document.createElement("div")
    form.className = "gowiki-database-form"

    const inputs: Map<string, HTMLInputElement | HTMLSelectElement | HTMLDivElement> = new Map()

    for (const f of fields) {
      const row = document.createElement("div")
      row.className = "gowiki-database-form-field"

      const lbl = document.createElement("label")
      lbl.textContent = f.label || f.name
      row.appendChild(lbl)

      if (f.type === "image") {
        const wrap = document.createElement("div")
        wrap.className = "db-image-input-wrap"
        const inp = document.createElement("input")
        inp.type = "text"
        inp.placeholder = f.placeholder || "/path/to/image.png"
        if (f.default_value) inp.value = f.default_value
        wrap.appendChild(inp)
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = "Browse"
        btn.addEventListener("click", () => {
          const ns = window.location.pathname.replace(/^\/+/, "").replace(/\/[^/]*$/, "") || ""
          openMediaManager(
            ns,
            () => {},
            (_type: string, entry: any) => {
              const insertedPath = entry.path
              inp.value = insertedPath
            }
          )
        })
        wrap.appendChild(btn)
        Object.defineProperty(wrap, "value", {
          get: () => inp.value,
          set: (v: string) => {
            inp.value = v
          },
        })
        inputs.set(f.name, wrap)
        row.appendChild(wrap)
      } else if (f.type === "enum") {
        const sel = document.createElement("select")
        const empty = document.createElement("option")
        empty.value = ""
        empty.textContent = "-- Select --"
        sel.appendChild(empty)
        for (const v of f.enum_values || []) {
          const opt = document.createElement("option")
          opt.value = v
          opt.textContent = v
          sel.appendChild(opt)
        }
        inputs.set(f.name, sel)
        row.appendChild(sel)
      } else if (f.type === "multi_enum") {
        const wrap = createMultiEnumWidget(f.enum_values || [], f.default_value || "")
        inputs.set(f.name, wrap)
        row.appendChild(wrap)
      } else if (f.type === "color") {
        const inp = document.createElement("input")
        inp.type = "color"
        inp.value = f.default_value || "#adb5bd"
        inputs.set(f.name, inp)
        row.appendChild(inp)
      } else if (f.type === "tag" && f.foreign_key) {
        const sel = document.createElement("select")
        const empty = document.createElement("option")
        empty.value = ""
        empty.textContent = "-- Select --"
        sel.appendChild(empty)
        inputs.set(f.name, sel)
        row.appendChild(sel)
        // Populate async.
        getTagOptions(f.foreign_key).then((tags) => {
          tags.forEach((t, id) => {
            const opt = document.createElement("option")
            opt.value = String(id)
            opt.textContent = t.label || String(id)
            sel.appendChild(opt)
          })
        })
      } else if (f.type === "lookup" && f.foreign_key) {
        const sel = document.createElement("select")
        const empty = document.createElement("option")
        empty.value = ""
        empty.textContent = "-- Select --"
        sel.appendChild(empty)
        inputs.set(f.name, sel)
        row.appendChild(sel)
        getLookupOptions(f.foreign_key, f.display_column).then((opts) => {
          opts.forEach((label, id) => {
            const opt = document.createElement("option")
            opt.value = String(id)
            opt.textContent = label
            sel.appendChild(opt)
          })
        })
      } else if (f.type === "user") {
        const sel = document.createElement("select")
        const empty = document.createElement("option")
        empty.value = ""
        empty.textContent = "-- Select --"
        sel.appendChild(empty)
        inputs.set(f.name, sel)
        row.appendChild(sel)
        getUserList().then((users) => {
          for (const u of users) {
            const opt = document.createElement("option")
            opt.value = u.username
            opt.textContent = u.display_name || u.username
            sel.appendChild(opt)
          }
        })
      } else if (f.type === "boolean") {
        const sel = document.createElement("select")
        for (const v of [
          { val: "", label: "-- Select --" },
          { val: "true", label: "Yes" },
          { val: "false", label: "No" },
        ]) {
          const opt = document.createElement("option")
          opt.value = v.val
          opt.textContent = v.label
          sel.appendChild(opt)
        }
        inputs.set(f.name, sel)
        row.appendChild(sel)
      } else {
        const inp = document.createElement("input")
        inp.type =
          f.type === "date"
            ? "date"
            : f.type === "datetime"
              ? "datetime-local"
              : f.type === "integer" || f.type === "float"
                ? "number"
                : "text"
        inp.placeholder = f.placeholder || ""
        if (f.default_value) inp.value = f.default_value
        inputs.set(f.name, inp)
        row.appendChild(inp)
      }

      form.appendChild(row)
    }

    // Apply pinned field values from the directive's extra attrs.
    // Pinned = the author wrote `{database-newrow table=X foo={{id}}}`
    // — foo becomes read-only pre-filled with the resolved value.
    // A pinned key referencing an unknown field is silently ignored;
    // the schema check on submit will already say "no such column"
    // if the author typo'd, and rendering an error inline for every
    // typo would be a lot of noise on the common case of a stale
    // directive.
    const pinned = pinnedMap
    const pinnedForSubmit: Record<string, string> = {}
    for (const [key, value] of Object.entries(pinned)) {
      const el = inputs.get(key)
      if (!el) continue
      pinnedForSubmit[key] = value
      applyPinnedValue(el, value)
    }
    // Apply default field values (`foo=~value` modifier) — pre-filled
    // but editable. Pinned always wins when both maps carry the same
    // key (shouldn't happen in a sane directive; defensive). Values
    // flow through the schema default_value fallback inputs got in
    // the main loop, so we unconditionally overwrite — the directive's
    // default takes precedence over the schema's.
    for (const [key, value] of Object.entries(defaultMap)) {
      if (key in pinnedForSubmit) continue
      const el = inputs.get(key)
      if (!el) continue
      el.value = value
    }

    const actions = document.createElement("div")
    actions.className = "gowiki-database-form-actions"

    const statusEl = document.createElement("span")
    statusEl.style.marginLeft = "8px"
    statusEl.style.fontSize = "12px"

    const createBtn = document.createElement("button")
    createBtn.textContent = "Create"
    createBtn.addEventListener("click", async () => {
      const fieldValues: Record<string, any> = {}
      for (const f of fields) {
        const el = inputs.get(f.name)
        if (el) fieldValues[f.name] = el.value
      }
      // Belt-and-braces: pinned values always win on submit — even if
      // some hostile UI trick changed a "disabled" input's value in
      // between apply and submit. The directive is a rule.
      for (const [k, v] of Object.entries(pinnedForSubmit)) {
        fieldValues[k] = v
      }

      try {
        const resp = await fetch(`/api/database/${encodeURIComponent(this.node.attrs.table)}/rows`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: fieldValues }),
        })
        if (resp.ok) {
          statusEl.textContent = "Created!"
          statusEl.style.color = "var(--gw-color-success)"
          // Clear form.
          for (const el of inputs.values()) el.value = ""
          setTimeout(() => {
            statusEl.textContent = ""
          }, 3000)
          // Notify query NodeViews on the same page to refresh.
          document.dispatchEvent(
            new CustomEvent(DATABASE_ROW_CREATED, {
              detail: { table: this.node.attrs.table },
            })
          )
        } else {
          const err = await resp.json().catch(() => ({}))
          statusEl.textContent = err.error || "Failed"
          statusEl.style.color = "var(--gw-color-error)"
        }
      } catch {
        statusEl.textContent = "Network error"
        statusEl.style.color = "var(--gw-color-error)"
      }
    })

    actions.appendChild(createBtn)
    actions.appendChild(statusEl)
    form.appendChild(actions)
    this.dom.appendChild(form)
  }

  private showError(message: string) {
    const el = document.createElement("div")
    el.className = "gowiki-database-error"
    el.textContent = message
    this.dom.appendChild(el)
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    // Re-render on any attr change the form depends on: table swap,
    // whitelist edit, pin / default edit. Previously only `table`
    // triggered a re-render, so editing the field whitelist in the
    // properties panel left the form showing the OLD shape until the
    // next page load.
    if (
      node.attrs.table !== this.node.attrs.table ||
      node.attrs.fields !== this.node.attrs.fields ||
      node.attrs._pinned !== this.node.attrs._pinned ||
      node.attrs._defaults !== this.node.attrs._defaults
    ) {
      this.node = node
      this.render()
      return true
    }
    this.node = node
    return true
  }

  stopEvent(): boolean {
    return true
  }
  ignoreMutation(): boolean {
    return true
  }
  destroy() {}
}

class DatabaseRowNodeView {
  dom: HTMLElement
  private node: PMNode
  private view: EditorView
  private getPos: () => number | undefined
  private registry: Registry
  private schemaFields: any[] = []
  private selfUpdate = false // flag to skip re-render on our own attr changes

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, registry: Registry) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.registry = registry

    this.dom = document.createElement("div")
    this.dom.className = "gowiki-database-row"
    this.dom.contentEditable = "false"

    this.render()
  }

  private render() {
    this.dom.innerHTML = ""
    const table = this.node.attrs.table
    if (!table) {
      this.dom.innerHTML = '<div class="gowiki-database-error">No table specified</div>'
      return
    }

    const label = document.createElement("div")
    label.className = "gowiki-database-row-label"
    label.textContent = `Row: ${table}`
    this.dom.appendChild(label)

    this.fetchSchemaAndRender()
  }

  private async fetchSchemaAndRender() {
    const table = this.node.attrs.table
    try {
      const resp = await fetch(`/api/database/${encodeURIComponent(table)}/schema`)
      if (resp.ok) {
        const schema = await resp.json()
        // Keep archived fields in the map so a historical row value
        // is recognised as belonging to a real (soft-deleted) column
        // rather than a genuine ghost. Rendering decides how to
        // present each shape (skip when empty, read-only otherwise).
        this.schemaFields = schema.fields || []
      }
    } catch {
      /* ignore */
    }

    if (this.view.editable) {
      this.renderEditMode()
    } else {
      this.renderViewMode()
    }
    document.dispatchEvent(new Event("gowiki:node-rendered"))
  }

  // ── Edit mode: inputs that update node attrs (synced to DB on publish) ──

  private renderEditMode() {
    const tbl = document.createElement("table")
    tbl.className = "gowiki-database-table"

    const fields = this.node.attrs._fields || {}
    const fieldMap = new Map<string, any>()
    for (const f of this.schemaFields) fieldMap.set(f.name, f)

    for (const [key, val] of Object.entries(fields)) {
      const f = fieldMap.get(key)
      // Ghost = key not in the current schema at all (someone
      // hard-deleted the field). Archived = key still in the schema
      // but soft-deleted (archived_at set); the value is historical.
      const isGhost = !f && key !== "id"
      const isArchived = !!(f && f.archived_at)
      // Skip archived fields whose row has no meaningful value — an
      // empty archived column is just noise on the reader's page. A
      // value still worth preserving keeps its row but renders
      // read-only below.
      if (isArchived && !valueHasContent(val)) continue

      const tr = document.createElement("tr")
      if (isGhost) tr.className = "gowiki-database-row-ghost"
      if (isArchived) tr.className = "gowiki-database-row-archived"

      const tdKey = document.createElement("td")
      tdKey.style.fontWeight = "600"
      if (isGhost) tdKey.textContent = `${key} (removed)`
      else if (isArchived) tdKey.textContent = `${f.label || key} (archived)`
      else tdKey.textContent = f?.label || key
      tr.appendChild(tdKey)

      const tdVal = document.createElement("td")

      if ((f && f.type === "auto_increment") || key === "id" || isArchived) {
        // auto_increment / system id / archived column: read-only.
        // Archived columns must never accept edits — the backend
        // refuses updates on them and a stale write here would just
        // 400 back at the user on save.
        tdVal.textContent = String(val)
      } else {
        // Editable input, type-aware.
        const input = this.createFieldInput(f, String(val))
        const commitChange = () => {
          const newVal = (input as any).value
          this.updateField(key, newVal)
        }
        if (input instanceof HTMLDivElement) {
          // Wrapper widget (image, multi-enum): the wrapper itself bubbles
          // a `change` event when any inner control toggles. Also listen on
          // the inner text input's blur so image-path edits commit on tab-out.
          input.addEventListener("change", commitChange)
          const innerInput = input.querySelector("input")
          if (innerInput && innerInput.type !== "checkbox") {
            innerInput.addEventListener("blur", commitChange)
          }
        } else {
          input.addEventListener("change", commitChange)
          if (input instanceof HTMLInputElement) {
            input.addEventListener("blur", commitChange)
          }
        }
        tdVal.appendChild(input)
      }

      tr.appendChild(tdVal)
      tbl.appendChild(tr)
    }

    if (Object.keys(fields).length === 0) {
      const empty = document.createElement("div")
      empty.className = "gowiki-database-loading"
      empty.textContent = "No fields"
      this.dom.appendChild(empty)
    } else {
      this.dom.appendChild(tbl)
    }
  }

  private createFieldInput(f: any, value: string): HTMLInputElement | HTMLSelectElement | HTMLDivElement {
    if (f && f.type === "image") {
      const wrap = document.createElement("div")
      wrap.className = "db-image-input-wrap"
      const inp = document.createElement("input")
      inp.type = "text"
      inp.value = value
      inp.placeholder = "/path/to/image.png"
      inp.style.fontSize = "inherit"
      isolateInput(inp)
      wrap.appendChild(inp)
      if (value) {
        const preview = document.createElement("img")
        preview.src = value
        preview.className = "db-image-preview"
        wrap.appendChild(preview)
      }
      const btn = document.createElement("button")
      btn.type = "button"
      btn.textContent = "Browse"
      isolateInput(btn)
      btn.addEventListener("click", () => {
        const ns = window.location.pathname.replace(/^\/+/, "").replace(/\/[^/]*$/, "") || ""
        openMediaManager(
          ns,
          () => {},
          (_type: string, entry: any) => {
            const insertedPath = entry.path
            inp.value = insertedPath
            inp.dispatchEvent(new Event("change"))
            // Update or add preview.
            const existing = wrap.querySelector(".db-image-preview")
            if (existing) {
              ;(existing as HTMLImageElement).src = insertedPath
            } else {
              const img = document.createElement("img")
              img.src = insertedPath
              img.className = "db-image-preview"
              wrap.insertBefore(img, btn)
            }
          }
        )
      })
      wrap.appendChild(btn)
      // Expose .value on the wrapper for the commitChange handler.
      Object.defineProperty(wrap, "value", {
        get: () => inp.value,
        set: (v: string) => {
          inp.value = v
        },
      })
      return wrap
    }
    if (f && f.type === "color") {
      const inp = document.createElement("input")
      inp.type = "color"
      inp.value = value || "#adb5bd"
      inp.style.width = "50px"
      inp.style.height = "30px"
      inp.style.padding = "0"
      inp.style.border = "1px solid var(--gw-color-border)"
      inp.style.cursor = "pointer"
      isolateInput(inp)
      return inp
    }
    if (f && f.type === "tag" && f.foreign_key) {
      const sel = document.createElement("select")
      sel.style.width = "100%"
      sel.style.fontSize = "inherit"
      const emptyOpt = document.createElement("option")
      emptyOpt.value = ""
      emptyOpt.textContent = "-- Select --"
      sel.appendChild(emptyOpt)
      isolateInput(sel)
      // Populate async.
      getTagOptions(f.foreign_key).then((tags) => {
        tags.forEach((t, id) => {
          const opt = document.createElement("option")
          opt.value = String(id)
          opt.textContent = t.label || String(id)
          if (String(id) === value) opt.selected = true
          sel.appendChild(opt)
        })
      })
      return sel
    }
    if (f && f.type === "lookup" && f.foreign_key) {
      const sel = document.createElement("select")
      sel.style.width = "100%"
      sel.style.fontSize = "inherit"
      const emptyOpt = document.createElement("option")
      emptyOpt.value = ""
      emptyOpt.textContent = "-- Select --"
      sel.appendChild(emptyOpt)
      isolateInput(sel)
      getLookupOptions(f.foreign_key, f.display_column).then((opts) => {
        opts.forEach((label, id) => {
          const opt = document.createElement("option")
          opt.value = String(id)
          opt.textContent = label
          if (String(id) === value) opt.selected = true
          sel.appendChild(opt)
        })
      })
      return sel
    }
    if (f && f.type === "user") {
      const sel = document.createElement("select")
      sel.style.width = "100%"
      sel.style.fontSize = "inherit"
      const emptyOpt = document.createElement("option")
      emptyOpt.value = ""
      emptyOpt.textContent = "-- Select --"
      sel.appendChild(emptyOpt)
      isolateInput(sel)
      getUserList().then((users) => {
        for (const u of users) {
          const opt = document.createElement("option")
          opt.value = u.username
          opt.textContent = u.display_name || u.username
          if (u.username === value) opt.selected = true
          sel.appendChild(opt)
        }
      })
      return sel
    }
    if (f && f.type === "multi_enum") {
      return createMultiEnumWidget(f.enum_values || [], value)
    }
    if (f && f.type === "enum") {
      const sel = document.createElement("select")
      sel.style.width = "100%"
      sel.style.fontSize = "inherit"
      const emptyOpt = document.createElement("option")
      emptyOpt.value = ""
      emptyOpt.textContent = "-- Select --"
      sel.appendChild(emptyOpt)
      for (const v of f.enum_values || []) {
        const opt = document.createElement("option")
        opt.value = v
        opt.textContent = v
        if (v === value) opt.selected = true
        sel.appendChild(opt)
      }
      isolateInput(sel)
      return sel
    }
    if (f && f.type === "boolean") {
      const sel = document.createElement("select")
      sel.style.width = "100%"
      sel.style.fontSize = "inherit"
      for (const v of [
        { val: "", label: "-- Select --" },
        { val: "true", label: "Yes" },
        { val: "false", label: "No" },
      ]) {
        const opt = document.createElement("option")
        opt.value = v.val
        opt.textContent = v.label
        if (v.val === value) opt.selected = true
        sel.appendChild(opt)
      }
      isolateInput(sel)
      return sel
    }
    const inp = document.createElement("input")
    inp.style.width = "100%"
    inp.style.boxSizing = "border-box"
    inp.style.padding = "2px 4px"
    inp.style.fontSize = "inherit"
    inp.type =
      f?.type === "date"
        ? "date"
        : f?.type === "datetime"
          ? "datetime-local"
          : f?.type === "integer" || f?.type === "float"
            ? "number"
            : "text"
    inp.value = value
    isolateInput(inp)
    return inp
  }

  private updateField(fieldName: string, newValue: string) {
    const pos = this.getPos()
    if (pos === undefined) return
    const newFields = { ...this.node.attrs._fields, [fieldName]: newValue }
    this.selfUpdate = true
    const tr = this.view.state.tr.setNodeMarkup(pos, null, {
      ...this.node.attrs,
      _fields: newFields,
    })
    this.view.dispatch(tr)
  }

  // ── View mode: static text with dblclick inline edit (immediate API sync) ──

  private renderViewMode() {
    const tbl = document.createElement("table")
    tbl.className = "gowiki-database-table"

    const fields = this.node.attrs._fields || {}
    const fieldMap = new Map<string, any>()
    for (const f of this.schemaFields) fieldMap.set(f.name, f)

    for (const [key, val] of Object.entries(fields)) {
      const f = fieldMap.get(key)
      const isGhost = !f && key !== "id"
      const isArchived = !!(f && f.archived_at)
      if (isArchived && !valueHasContent(val)) continue

      const tr = document.createElement("tr")
      if (isGhost) tr.className = "gowiki-database-row-ghost"
      if (isArchived) tr.className = "gowiki-database-row-archived"

      const tdKey = document.createElement("td")
      tdKey.style.fontWeight = "600"
      if (isGhost) tdKey.textContent = `${key} (removed)`
      else if (isArchived) tdKey.textContent = `${f.label || key} (archived)`
      else tdKey.textContent = f?.label || key
      tr.appendChild(tdKey)

      const tdVal = document.createElement("td")
      if (f && f.type === "page_link" && val) {
        // Same clickable-link rendering as the query view — a
        // page_link column must reach its target in one click from
        // the row-bound view, not sit as inert grey text.
        const a = document.createElement("a")
        a.className = "gowiki-database-page-link"
        a.textContent = String(val)
        a.href = String(val)
        tdVal.appendChild(a)
      } else if (f && f.type === "image" && val) {
        const img = document.createElement("img")
        img.src = String(val)
        img.className = "db-image-cell"
        tdVal.appendChild(img)
      } else if (f && f.type === "color" && val) {
        tdVal.appendChild(renderColorSwatch(String(val)))
      } else if (f && f.type === "tag" && f.foreign_key) {
        if (val && Number(val) !== 0) {
          tdVal.textContent = "..."
          getTagOptions(f.foreign_key).then((tags) => {
            tdVal.textContent = ""
            const tag = tags.get(Number(val))
            if (tag) tdVal.appendChild(renderTagBadge(tag))
            else tdVal.textContent = String(val)
          })
        }
      } else if (f && f.type === "lookup" && f.foreign_key) {
        if (val && Number(val) !== 0) {
          tdVal.textContent = "..."
          getLookupOptions(f.foreign_key, f.display_column).then((opts) => {
            tdVal.textContent = opts.get(Number(val)) || String(val)
          })
        }
      } else if (f && f.type === "user" && val) {
        tdVal.textContent = String(val)
        fetchUserInfo(String(val)).then((info) => {
          if (info.label) tdVal.textContent = info.label
        })
      } else {
        tdVal.textContent = String(val)
      }

      // Inline editing forbidden for auto_increment / system id and
      // for archived columns (the backend refuses writes to archived
      // fields, and a dbl-click that opened an editor would just
      // 400 on save).
      if (!(f && f.type === "auto_increment") && key !== "id" && !isArchived) {
        tdVal.className = "gowiki-database-editable-value"
        tdVal.addEventListener("dblclick", () => {
          this.inlineEdit(tdVal, f, String(key), String(val))
        })
      }

      tr.appendChild(tdVal)
      tbl.appendChild(tr)
    }

    if (Object.keys(fields).length === 0) {
      const empty = document.createElement("div")
      empty.className = "gowiki-database-loading"
      empty.textContent = "No fields"
      this.dom.appendChild(empty)
    } else {
      this.dom.appendChild(tbl)
    }
  }

  /** Update _fields in PM state so template_var refresh plugin picks it up. */
  private syncFieldToState(fieldName: string, newValue: string) {
    const pos = this.getPos()
    if (pos === undefined) return
    const newFields = { ...this.node.attrs._fields, [fieldName]: newValue }
    this.selfUpdate = true
    const tr = this.view.state.tr.setNodeMarkup(pos, null, {
      ...this.node.attrs,
      _fields: newFields,
    })
    this.view.dispatch(tr)
  }

  private async inlineEdit(td: HTMLElement, fieldDef: any, fieldName: string, currentValue: string) {
    const table = this.node.attrs.table
    if (!table) return

    const saveToApi = async (newValue: string, force = false): Promise<boolean> => {
      try {
        const pagePath = window.location.pathname.replace(/^\/+/, "")
        const url = `/api/database/${encodeURIComponent(table)}/page/${pagePath}${force ? "?force=true" : ""}`
        const resp = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { [fieldName]: newValue } }),
        })
        if (resp.status === 409) {
          const body = await resp.json().catch(() => ({}))
          if (body.error === "page_draft_conflict") {
            const ok = confirm(`A draft by "${body.draft_owner}" exists for this page. Force the edit?`)
            if (ok) return saveToApi(newValue, true)
            return false
          }
        }
        if (!resp.ok) {
          td.style.color = "var(--gw-color-error)"
          setTimeout(() => {
            td.style.color = ""
          }, 2000)
          return false
        }
        this.syncFieldToState(fieldName, newValue)
        return true
      } catch {
        td.style.color = "var(--gw-color-error)"
        setTimeout(() => {
          td.style.color = ""
        }, 2000)
        return false
      }
    }

    if (fieldDef && fieldDef.type === "enum") {
      createOverlaySelect(td, {
        options: fieldDef.enum_values || [],
        value: currentValue,
        onSave: async (newVal) => {
          td.textContent = newVal
          td.className = "gowiki-database-editable-value"
          await saveToApi(newVal)
        },
        onCancel: () => {},
      })
    } else if (fieldDef && fieldDef.type === "multi_enum") {
      createOverlayMultiEnum(td, {
        options: fieldDef.enum_values || [],
        value: currentValue,
        onSave: async (newVal) => {
          td.textContent = newVal
          td.className = "gowiki-database-editable-value"
          await saveToApi(newVal)
        },
        onCancel: () => {},
      })
    } else if (fieldDef && fieldDef.type === "boolean") {
      const newVal = currentValue === "true" ? "false" : "true"
      td.textContent = newVal
      const ok = await saveToApi(newVal)
      if (!ok) {
        td.textContent = currentValue
      }
    } else if (fieldDef && fieldDef.type === "color") {
      createOverlayColorPicker(td, {
        value: currentValue || "#adb5bd",
        onSave: async (newVal) => {
          td.textContent = ""
          td.appendChild(renderColorSwatch(newVal))
          td.className = "gowiki-database-editable-value"
          const ok = await saveToApi(newVal)
          if (!ok) {
            td.textContent = ""
            td.appendChild(renderColorSwatch(currentValue))
          }
        },
        onCancel: () => {
          td.textContent = ""
          td.appendChild(renderColorSwatch(currentValue))
          td.className = "gowiki-database-editable-value"
        },
      })
    } else if (fieldDef && fieldDef.type === "tag" && fieldDef.foreign_key) {
      getTagOptions(fieldDef.foreign_key).then((tags) => {
        const options: { value: string; label: string }[] = []
        tags.forEach((t, id) => options.push({ value: String(id), label: t.label || String(id) }))
        createOverlaySelectKeyed(td, {
          options,
          value: currentValue,
          onSave: async (newVal) => {
            td.textContent = ""
            const tag = tags.get(Number(newVal))
            if (tag) td.appendChild(renderTagBadge(tag))
            else td.textContent = newVal
            td.className = "gowiki-database-editable-value"
            await saveToApi(newVal)
          },
          onCancel: () => {},
        })
      })
    } else if (fieldDef && fieldDef.type === "lookup" && fieldDef.foreign_key) {
      getLookupOptions(fieldDef.foreign_key, fieldDef.display_column).then((opts) => {
        const options: { value: string; label: string }[] = []
        opts.forEach((label, id) => options.push({ value: String(id), label }))
        createOverlaySelectKeyed(td, {
          options,
          value: currentValue,
          onSave: async (newVal) => {
            td.textContent = opts.get(Number(newVal)) || newVal
            td.className = "gowiki-database-editable-value"
            await saveToApi(newVal)
          },
          onCancel: () => {},
        })
      })
    } else if (fieldDef && fieldDef.type === "user") {
      getUserList().then((users) => {
        const options = users.map((u) => ({ value: u.username, label: u.display_name || u.username }))
        createOverlaySelectKeyed(td, {
          options,
          value: currentValue,
          onSave: async (newVal) => {
            const u = users.find((u) => u.username === newVal)
            td.textContent = u?.display_name || newVal
            td.className = "gowiki-database-editable-value"
            await saveToApi(newVal)
          },
          onCancel: () => {},
        })
      })
    } else if (fieldDef && fieldDef.type === "image") {
      const restoreImage = (path: string) => {
        td.textContent = ""
        td.className = "gowiki-database-editable-value"
        if (path) {
          const img = document.createElement("img")
          img.src = path
          img.className = "db-image-cell"
          td.appendChild(img)
        }
      }
      createOverlayImageInput(td, {
        value: currentValue,
        onSave: async (newVal) => {
          restoreImage(newVal)
          const ok = await saveToApi(newVal)
          if (!ok) {
            restoreImage(currentValue)
          }
        },
        onCancel: () => {
          restoreImage(currentValue)
        },
      })
    } else {
      createOverlayInput(td, {
        type:
          fieldDef?.type === "date"
            ? "date"
            : fieldDef?.type === "integer" || fieldDef?.type === "float"
              ? "number"
              : "text",
        value: currentValue,
        onSave: async (newVal) => {
          td.textContent = newVal
          td.className = "gowiki-database-editable-value"
          const ok = await saveToApi(newVal)
          if (!ok) {
            td.textContent = currentValue
          }
        },
        onCancel: () => {
          td.textContent = currentValue
          td.className = "gowiki-database-editable-value"
        },
      })
    }
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    if (this.selfUpdate) {
      // Our own attr change — don't re-render (would destroy inputs).
      this.selfUpdate = false
      return true
    }
    this.render()
    return true
  }

  stopEvent(event: Event): boolean {
    // Stop mouse events to prevent ProseMirror from creating text selections
    // across the document when clicking inside database tables.
    const type = event.type
    if (type === "mousedown" || type === "mouseup" || type === "click" || type === "dblclick") return true
    const tag = (event.target as HTMLElement)?.tagName
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return true
    return false
  }

  ignoreMutation(): boolean {
    return true
  }
  destroy() {}
}

// ── Global Variable Resolution ──

const ALL_CAPS_RE = /^[A-Z_]+$/

// Cache for user display info: username -> { display_name, email, label }
const userInfoCache: Record<string, { display_name: string; email: string; label: string }> = {}

async function fetchUserInfo(username: string): Promise<{ display_name: string; email: string; label: string }> {
  if (!username) return { display_name: "", email: "", label: "" }
  if (userInfoCache[username]) return userInfoCache[username]
  try {
    const resp = await fetch(`/api/users/display?users=${encodeURIComponent(username)}`)
    if (resp.ok) {
      const data = await resp.json()
      const info = data.users?.[username]
      if (info) {
        userInfoCache[username] = {
          display_name: info.display_name || username,
          email: info.email || "",
          label: info.label || username,
        }
        return userInfoCache[username]
      }
    }
  } catch {
    /* best effort */
  }
  return { display_name: username, email: "", label: username }
}

function extractTitle(view: EditorView): string {
  let title = ""
  view.state.doc.descendants((node) => {
    if (!title && node.type.name === "heading") {
      title = node.textContent
      return false
    }
  })
  return title
}

/**
 * Resolve a global variable synchronously from available context.
 *
 * Return values:
 *   null      — not an ALL_CAPS name → fall back to database template resolution
 *   undefined — ALL_CAPS but not a recognized global variable → ERROR
 *   ""        — recognized, but data unavailable → show fallback or nothing
 *   "value"   — resolved value
 */
function resolveGlobalVar(name: string, view: EditorView): string | null | undefined {
  if (!ALL_CAPS_RE.test(name)) return null

  const ctx = (window as any).__sargonGlobalVarContext?.()
  if (!ctx) return ""

  const meta = ctx.pageMeta

  switch (name) {
    // Page variables
    case "ID":
      return ctx.pagePath || ""
    case "PATH":
      return ctx.pageNamespace || ""
    case "PAGE":
      return ctx.pageName || ""
    case "TITLE":
      return extractTitle(view)

    // Link variables
    case "EXTID":
      return `${window.location.origin}${ctx.pagePath || ""}`
    case "EXTPATH":
      return `${window.location.origin}${ctx.pageNamespace || ""}${ctx.pageNamespace?.endsWith("/") ? "" : "/"}`
    case "SERVER":
      return window.location.hostname

    // Version variables
    case "VERSION":
      return meta?.version != null ? String(meta.version) : ""
    case "VERSIONDATE": {
      if (!meta?.updated_at) return ""
      const d = new Date(meta.updated_at)
      return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10)
    }
    case "VERSIONTAG":
      return meta?.version_tag || ""
    case "YEAR": {
      if (!meta?.updated_at) return ""
      const d = new Date(meta.updated_at)
      return isNaN(d.getTime()) ? "" : String(d.getFullYear())
    }
    case "MONTH": {
      if (!meta?.updated_at) return ""
      const d = new Date(meta.updated_at)
      return isNaN(d.getTime()) ? "" : String(d.getMonth() + 1).padStart(2, "0")
    }
    case "SMONTH": {
      if (!meta?.updated_at) return ""
      const d = new Date(meta.updated_at)
      return isNaN(d.getTime()) ? "" : String(d.getMonth() + 1)
    }
    case "DAY": {
      if (!meta?.updated_at) return ""
      const d = new Date(meta.updated_at)
      return isNaN(d.getTime()) ? "" : String(d.getDate()).padStart(2, "0")
    }
    case "SDAY": {
      if (!meta?.updated_at) return ""
      const d = new Date(meta.updated_at)
      return isNaN(d.getTime()) ? "" : String(d.getDate())
    }

    // Creation date variable
    case "CREATIONDATE": {
      if (!meta?.created_at) return ""
      const d = new Date(meta.created_at)
      return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10)
    }

    // Author variables (sync: return username, trigger async display name fetch)
    case "AUTHOR":
      return meta?.created_by || ""
    case "AUTHORNAME":
      return userInfoCache[meta?.created_by]?.display_name || meta?.created_by || ""
    case "AUTHORMAIL":
      return userInfoCache[meta?.created_by]?.email || ""
    case "LASTAUTHOR":
      return meta?.author || ""
    case "LASTAUTHORNAME":
      return userInfoCache[meta?.author]?.display_name || meta?.author || ""
    case "LASTAUTHORMAIL":
      return userInfoCache[meta?.author]?.email || ""

    // Wiki variables
    case "WIKI":
      return ctx.siteTitle || ""
    case "WIKIVERSION":
      return ctx.siteVersion || ""
  }

  return undefined // ALL_CAPS but not a recognized global variable → ERROR
}

// ── Template Variable NodeView ──

// Cache table field types for template variable user resolution.
const tableFieldTypeCache: Map<string, Map<string, string>> = new Map()

async function getFieldTypes(tableName: string): Promise<Map<string, string>> {
  if (tableFieldTypeCache.has(tableName)) return tableFieldTypeCache.get(tableName)!
  try {
    const resp = await fetch(`/api/database/${encodeURIComponent(tableName)}/schema`)
    if (!resp.ok) return new Map()
    const schema = await resp.json()
    const types = new Map<string, string>()
    for (const f of schema.fields || []) {
      if (!f.archived_at) types.set(f.name, f.type)
    }
    tableFieldTypeCache.set(tableName, types)
    return types
  } catch {
    return new Map()
  }
}

function resolveTemplateFields(state: EditorState): { fields: Record<string, string>; table: string } {
  const fields: Record<string, string> = {}
  let table = ""
  state.doc.descendants((node) => {
    if (node.type.name === "database_row" && node.attrs._fields) {
      if (node.attrs.table && !table) table = node.attrs.table
      for (const [k, v] of Object.entries(node.attrs._fields as Record<string, any>)) {
        if (!(k in fields)) fields[k] = String(v)
      }
    }
  })
  return { fields, table }
}

/**
 * interpolateVars replaces `{{name}}` occurrences in `s` using the
 * supplied `resolve` function. The resolver returns:
 *   - `undefined` → the name is unknown; leave `{{name}}` literal so
 *     the caller notices (e.g. a typo shows up in the failing request
 *     rather than silently becoming `""`).
 *   - a string     → substituted verbatim (even the empty string).
 * Kept pure so it can be tested without an EditorView. The view-aware
 * wrapper `expandTemplateVars` composes this with `resolveGlobalVar` +
 * database-row fields.
 */
export function interpolateVars(s: string, resolve: (name: string) => string | undefined): string {
  if (!s || s.indexOf("{{") === -1) return s
  return s.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, rawName) => {
    const name = String(rawName).trim()
    if (!name) return whole
    const value = resolve(name)
    return value === undefined ? whole : value
  })
}

// expandTemplateVars replaces {{name}} references in a string using the
// same two-source resolution the template-var NodeView uses:
// ALL_CAPS globals (TITLE, VERSION, ID, …) first, then database-row
// _fields from the current document. Unknown names stay literal (see
// interpolateVars). Called from directive-attr paths (filter=, …) that
// reach the backend directly — the backend has no template context of
// its own.
export function expandTemplateVars(s: string, view: EditorView): string {
  if (!s || s.indexOf("{{") === -1) return s
  const { fields } = resolveTemplateFields(view.state)
  return interpolateVars(s, (name) => {
    const g = resolveGlobalVar(name, view)
    // resolveGlobalVar returns undefined for unknown ALL_CAPS (error case),
    // null for "not an ALL_CAPS name at all", or the value.
    if (g !== undefined && g !== null) return g
    if (name in fields) return fields[name]
    return undefined
  })
}

class TemplateVarNodeView {
  dom: HTMLElement
  private node: PMNode
  private view: EditorView

  constructor(node: PMNode, view: EditorView, _getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.dom = document.createElement("span")
    this.dom.contentEditable = "false"
    const { fields, table } = resolveTemplateFields(view.state)
    this.renderResolved(fields, table)
  }

  private renderResolved(fields: Record<string, string>, table: string) {
    const name = this.node.attrs.name || ""
    const fallback = this.node.attrs.fallback || ""

    // Empty name = user is still typing — show placeholder, not error
    if (!name) {
      this.dom.className = "gowiki-template-var"
      this.dom.textContent = "{{…}}"
      this.dom.title = "Variable (empty name)"
      return
    }

    // Try global variable resolution first (ALL_CAPS names)
    const globalResolved = resolveGlobalVar(name, this.view)
    if (globalResolved === undefined) {
      // Unknown ALL_CAPS variable → error
      this.dom.className = "gowiki-template-var gowiki-template-var-error"
      this.dom.textContent = `ERR: {{${name}}}`
      this.dom.title = `Unknown variable: ${name}`
      return
    }
    if (globalResolved !== null) {
      // Known global variable
      if (globalResolved) {
        // Has a value → show it
        this.dom.className = "gowiki-template-var"
        this.dom.textContent = globalResolved
        this.dom.title = `{{${name}}}`
      } else if (fallback) {
        // Empty value, has fallback → show fallback
        this.dom.className = "gowiki-template-var"
        this.dom.textContent = fallback
        this.dom.title = `{{${name}}} (default)`
      } else {
        // Empty value, no fallback → invisible
        this.dom.className = "gowiki-template-var"
        this.dom.textContent = ""
        this.dom.title = `{{${name}}} (empty)`
      }
      this.resolveAuthorDisplayAsync(name)
      return
    }

    // Fall back to database template variable resolution
    const resolved = fields[name]
    if (resolved !== undefined) {
      this.dom.className = "gowiki-template-var"
      this.dom.textContent = resolved
      this.dom.title = `{{${name}}}`
      // If the field is a user type, resolve to display label
      this.resolveUserFieldAsync(table, name, resolved)
    } else if (fallback) {
      // Unresolved database var with fallback → show fallback
      this.dom.className = "gowiki-template-var"
      this.dom.textContent = fallback
      this.dom.title = `{{${name}}} (default)`
    } else {
      // Unresolved database var, no fallback → error
      this.dom.className = "gowiki-template-var gowiki-template-var-error"
      this.dom.textContent = `ERR: {{${name}}}`
      this.dom.title = `Unresolved variable: ${name}`
    }
  }

  private resolveUserFieldAsync(table: string, fieldName: string, username: string) {
    if (!table || !username) return
    getFieldTypes(table).then((types) => {
      if (types.get(fieldName) !== "user") return
      fetchUserInfo(username).then((info) => {
        if (info.label && info.label !== username) {
          this.dom.textContent = info.label
        }
      })
    })
  }

  private resolveAuthorDisplayAsync(name: string) {
    const ctx = (window as any).__sargonGlobalVarContext?.()
    if (!ctx?.pageMeta) return

    let username = ""
    if (name === "AUTHORNAME" || name === "AUTHORMAIL") {
      username = ctx.pageMeta.created_by || ""
    } else if (name === "LASTAUTHORNAME" || name === "LASTAUTHORMAIL") {
      username = ctx.pageMeta.author || ""
    }
    if (!username || userInfoCache[username]) return

    // Fetch user info and re-render once available
    fetchUserInfo(username).then(() => {
      const val = resolveGlobalVar(name, this.view)
      if (val) {
        this.dom.textContent = val
      }
    })
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    const { fields, table } = resolveTemplateFields(this.view.state)
    this.renderResolved(fields, table)
    return true
  }

  ignoreMutation(): boolean {
    return true
  }
  destroy() {}
}

// ── Plugin Registration ──

export const databasePlugin: WikiPlugin = {
  register(reg) {
    // ── Schema nodes ──

    reg.registerSchema({
      nodes: {
        database_query: {
          group: "block",
          atom: true,
          attrs: {
            table: { default: "" },
            fields: { default: "" },
            filter: { default: "" },
            sort: { default: "" },
            order: { default: "asc" },
            limit: { default: "20" },
            pivot_rows: { default: "" },
            pivot_cols: { default: "" },
            pivot_cell: { default: "" },
            pivot_agg: { default: "" },
            pivot_empty: { default: "" },
            pivot_cols_sort: { default: "" },
            pivot_cols_max: { default: "" },
            pivot_rows_labels: { default: "" },
            pivot_cols_labels: { default: "" },
          },
          toDOM(node: PMNode) {
            return [
              "div",
              {
                class: "gowiki-database-query",
                "data-table": node.attrs.table ?? "",
              },
              `Database query: ${node.attrs.table || "(no table)"}`,
            ]
          },
          parseDOM: [
            {
              tag: "div.gowiki-database-query",
              getAttrs(dom: HTMLElement) {
                return { table: dom.getAttribute("data-table") || "" }
              },
            },
          ],
        },
        database_newrow: {
          group: "block",
          atom: true,
          attrs: {
            table: { default: "" },
            // JSON-encoded map of field_name -> raw value string. Values
            // may carry `{{name}}` tokens that resolve at render time
            // against the current document's template context (globals
            // and database-row fields). Pinned fields render as the
            // pre-selected option and are locked read-only so the
            // author's intent — "on THIS page you create against
            // THIS row" — becomes a rule, not a suggestion.
            _pinned: { default: "{}" },
            // Same shape as _pinned but editable: the field is pre-
            // filled with the default so the user starts from a
            // reasonable baseline, but is free to change it. Written
            // in the directive with the `=~` modifier
            // (`field=~value`). Complements _pinned for workflows
            // where a row has multiple entry paths and each path
            // seeds different fields with different starting values.
            _defaults: { default: "{}" },
            // Comma-separated whitelist of field names to show in the
            // form, in the given order. Empty = show every field
            // (today's behaviour). Pinned and defaulted fields are
            // ALWAYS shown even if the whitelist omits them — the
            // author's intent to pre-fill a field implies they want
            // it in the form.
            fields: { default: "" },
          },
          toDOM(node: PMNode) {
            return [
              "div",
              {
                class: "gowiki-database-newrow",
                "data-table": node.attrs.table ?? "",
                "data-pinned": node.attrs._pinned || "{}",
                "data-defaults": node.attrs._defaults || "{}",
                "data-fields": node.attrs.fields || "",
              },
              `New row form: ${node.attrs.table || "(no table)"}`,
            ]
          },
          parseDOM: [
            {
              tag: "div.gowiki-database-newrow",
              getAttrs(dom: HTMLElement) {
                return {
                  table: dom.getAttribute("data-table") || "",
                  _pinned: dom.getAttribute("data-pinned") || "{}",
                  _defaults: dom.getAttribute("data-defaults") || "{}",
                  fields: dom.getAttribute("data-fields") || "",
                }
              },
            },
          ],
        },
        database_row: {
          group: "block",
          atom: true,
          attrs: {
            table: { default: "" },
            _fields: { default: {} },
          },
          toDOM(node: PMNode) {
            return [
              "div",
              {
                class: "gowiki-database-row",
                "data-table": node.attrs.table ?? "",
              },
              `Database row: ${node.attrs.table || "(no table)"}`,
            ]
          },
          parseDOM: [
            {
              tag: "div.gowiki-database-row",
              getAttrs(dom: HTMLElement) {
                return { table: dom.getAttribute("data-table") || "" }
              },
            },
          ],
        },
        template_var: {
          group: "inline",
          inline: true,
          atom: true,
          attrs: {
            name: { default: "" },
            fallback: { default: "" },
          },
          toDOM(node: PMNode) {
            const fb = node.attrs.fallback ? `:${node.attrs.fallback}` : ""
            return [
              "span",
              {
                class: "gowiki-template-var",
                "data-var": node.attrs.name,
                "data-var-fallback": node.attrs.fallback || "",
              },
              `{{${node.attrs.name}${fb}}}`,
            ]
          },
          parseDOM: [
            {
              tag: "span.gowiki-template-var",
              getAttrs(dom: HTMLElement) {
                return {
                  name: dom.getAttribute("data-var") || "",
                  fallback: dom.getAttribute("data-var-fallback") || "",
                }
              },
            },
          ],
        },
      },
    })

    // ── Self-contained directives ──

    reg.registerSelfContainedDirective("database-query", {
      tokenType: "database_query",
      nodeType: "database_query",
      properties: databaseQueryProperties,
    })

    reg.registerSelfContainedDirective("database-newrow", {
      tokenType: "database_newrow",
      nodeType: "database_newrow",
      properties: databaseNewRowProperties,
      // Every non-`table` attribute is a pinned field value —
      // arbitrary column names, so we can't enumerate them ahead of
      // time. collectExtra passes them through to the token's attrs
      // map; registerText below packs them into the `_pinned` JSON.
      collectExtra: true,
    })

    // database-row is handled by a custom markdown-it block rule (see below)
    // because it needs to consume the following table block.

    // ── Markdown-it plugin for {database-row ...} + table ──

    reg.registerMarkdownItPlugin((md: any) => {
      md.block.ruler.before(
        "table",
        "database_row_block",
        (state: any, startLine: number, endLine: number, silent: boolean) => {
          const start = state.bMarks[startLine] + state.tShift[startLine]
          const max = state.eMarks[startLine]
          const line = state.src.slice(start, max).trim()

          // Match {database-row table=...} or bare {database-row} (template placeholder)
          const fullMatch = line.match(/^\{database-row\s+table=(?:"([^"]+)"|'([^']+)'|(\S+?))\s*\}$/)
          const bareMatch = !fullMatch && /^\{database-row\s*\}$/.test(line)
          if (!fullMatch && !bareMatch) return false
          if (silent) return true

          const tableName = fullMatch ? fullMatch[1] || fullMatch[2] || fullMatch[3] : ""

          // Bare placeholder — just emit the node, don't consume a following table.
          if (bareMatch) {
            const token = state.push("database_row_block", "", 0)
            token.block = true
            token.map = [startLine, startLine + 1]
            token.meta = { tableName: "", fields: {} }
            state.line = startLine + 1
            return true
          }

          // Look ahead for a 2-column table (Field | Value).
          let nextLine = startLine + 1
          // Skip blank lines.
          while (nextLine < endLine && state.src.slice(state.bMarks[nextLine], state.eMarks[nextLine]).trim() === "") {
            nextLine++
          }

          const fields: Record<string, string> = {}
          const tableRowRe = /^\s*\|(.+)\|(.+)\|\s*$/
          const tableSepRe = /^\s*\|[\s:|-]+\|\s*$/

          // Try to parse header row.
          if (nextLine < endLine && tableRowRe.test(state.src.slice(state.bMarks[nextLine], state.eMarks[nextLine]))) {
            nextLine++ // skip header
          }
          // Try to parse separator row.
          if (nextLine < endLine && tableSepRe.test(state.src.slice(state.bMarks[nextLine], state.eMarks[nextLine]))) {
            nextLine++ // skip separator
          }
          // Parse data rows.
          while (nextLine < endLine) {
            const rowLine = state.src.slice(state.bMarks[nextLine], state.eMarks[nextLine])
            const rowMatch = tableRowRe.exec(rowLine)
            if (!rowMatch) break
            const key = rowMatch[1].trim()
            const val = rowMatch[2].trim()
            if (key && key !== "---" && key !== "Field") {
              fields[key] = val
            }
            nextLine++
          }

          const token = state.push("database_row_block", "", 0)
          token.block = true
          token.map = [startLine, nextLine]
          token.meta = { tableName, fields }

          state.line = nextLine
          return true
        }
      )
    })

    // ── Markdown → PM: handle synthetic tokens ──

    reg.registerText("database_query", {
      run(ctx, tok) {
        const attrs = tok.meta?.attrs ?? {}
        ctx.push(
          ctx.schema.nodes.database_query.create({
            table: attrs.table ?? "",
            fields: attrs.fields ?? "",
            filter: attrs.filter ?? "",
            sort: attrs.sort ?? "",
            order: attrs.order ?? "asc",
            limit: attrs.limit ?? "20",
            pivot_rows: attrs.pivot_rows ?? "",
            pivot_cols: attrs.pivot_cols ?? "",
            pivot_cell: attrs.pivot_cell ?? "",
            pivot_agg: attrs.pivot_agg ?? "",
            pivot_empty: attrs.pivot_empty ?? "",
            pivot_cols_sort: attrs.pivot_cols_sort ?? "",
            pivot_cols_max: attrs.pivot_cols_max ?? "",
            pivot_rows_labels: attrs.pivot_rows_labels ?? "",
            pivot_cols_labels: attrs.pivot_cols_labels ?? "",
          })
        )
      },
    })

    reg.registerText("database_newrow", {
      run(ctx, tok) {
        const attrs = tok.meta?.attrs ?? {}
        // Three reserved attribute slots: `table`, `fields` (the
        // whitelist CSV), and `_args` (positional carry-over). Every
        // other key is a field prefill. A leading `~` on the value is
        // the "default" modifier — `foo=~bar` seeds the form field
        // with `bar` but leaves it editable, whereas plain `foo=bar`
        // locks the field. Pinned values that start with a literal
        // `~` character cannot be expressed via the directive
        // (documented limitation); use `{{var}}` interpolation to
        // inject such values from the template context.
        const pinned: Record<string, string> = {}
        const defaults: Record<string, string> = {}
        for (const [k, v] of Object.entries(attrs)) {
          if (k === "table" || k === "fields" || k === "_args" || v == null) continue
          const value = String(v)
          if (value.startsWith("~")) {
            defaults[k] = value.slice(1)
          } else {
            pinned[k] = value
          }
        }
        ctx.push(
          ctx.schema.nodes.database_newrow.create({
            table: attrs.table ?? "",
            fields: attrs.fields ?? "",
            _pinned: JSON.stringify(pinned),
            _defaults: JSON.stringify(defaults),
          })
        )
      },
    })

    reg.registerText("database_row_block", {
      run(ctx, tok) {
        const meta = tok.meta ?? {}
        ctx.push(
          ctx.schema.nodes.database_row.create({
            table: meta.tableName ?? "",
            _fields: meta.fields ?? {},
          })
        )
      },
    })

    reg.registerText("template_var", {
      run(ctx, tok) {
        ctx.push(
          ctx.schema.nodes.template_var.create({
            name: tok.meta?.name ?? "",
            fallback: tok.meta?.fallback ?? "",
          })
        )
      },
    })

    // ── PM → Markdown: serialize back ──

    reg.registerPMNode("database_query", {
      print(node) {
        const parts = [`table=${node.attrs.table}`]
        if (node.attrs.fields) {
          const c = node.attrs.fields
          parts.push(c.includes(" ") ? `fields="${c}"` : `fields=${c}`)
        }
        if (node.attrs.filter) {
          const f = node.attrs.filter
          parts.push(f.includes("=") || f.includes(">") || f.includes("<") ? `filter="${f}"` : `filter=${f}`)
        }
        if (node.attrs.sort) parts.push(`sort=${node.attrs.sort}`)
        if (node.attrs.order && node.attrs.order !== "asc") parts.push(`order=${node.attrs.order}`)
        if (node.attrs.limit && node.attrs.limit !== "20") parts.push(`limit=${node.attrs.limit}`)
        // Pivot params — quote when they contain spaces (rare) or operators.
        const quoteIfNeeded = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v)
        if (node.attrs.pivot_rows) parts.push(`pivot_rows=${quoteIfNeeded(node.attrs.pivot_rows)}`)
        if (node.attrs.pivot_cols) parts.push(`pivot_cols=${quoteIfNeeded(node.attrs.pivot_cols)}`)
        if (node.attrs.pivot_cell) parts.push(`pivot_cell=${quoteIfNeeded(node.attrs.pivot_cell)}`)
        if (node.attrs.pivot_agg) parts.push(`pivot_agg=${node.attrs.pivot_agg}`)
        if (node.attrs.pivot_empty) parts.push(`pivot_empty=${quoteIfNeeded(node.attrs.pivot_empty)}`)
        if (node.attrs.pivot_cols_sort) parts.push(`pivot_cols_sort=${quoteIfNeeded(node.attrs.pivot_cols_sort)}`)
        if (node.attrs.pivot_cols_max) parts.push(`pivot_cols_max=${node.attrs.pivot_cols_max}`)
        // Label maps are JSON blobs; always quote to preserve braces/colons.
        if (node.attrs.pivot_rows_labels)
          parts.push(`pivot_rows_labels="${String(node.attrs.pivot_rows_labels).replace(/"/g, '\\"')}"`)
        if (node.attrs.pivot_cols_labels)
          parts.push(`pivot_cols_labels="${String(node.attrs.pivot_cols_labels).replace(/"/g, '\\"')}"`)
        return `{database-query ${parts.join(" ")}}\n\n`
      },
    })

    reg.registerPMNode("database_newrow", {
      print(node) {
        const parts = [`table=${node.attrs.table}`]
        const fields = String(node.attrs.fields || "").trim()
        if (fields) {
          const needsQuote = /[\s"]/.test(fields)
          parts.push(`fields=${needsQuote ? `"${fields.replace(/"/g, '\\"')}"` : fields}`)
        }
        // Pinned + default field attrs emit in sorted-key order so
        // identical directives serialize identically (deterministic
        // round-trip). Pinned wins when the same key appears in both
        // maps (shouldn't happen in a sane directive; here as a
        // safety net).
        let pinned: Record<string, string> = {}
        let defaults: Record<string, string> = {}
        try {
          pinned = JSON.parse(node.attrs._pinned || "{}") as Record<string, string>
        } catch {
          pinned = {}
        }
        try {
          defaults = JSON.parse(node.attrs._defaults || "{}") as Record<string, string>
        } catch {
          defaults = {}
        }
        for (const k of Object.keys(pinned).sort()) {
          const v = pinned[k]
          if (v == null || v === "") continue
          const needsQuote = /[\s"]/.test(v)
          parts.push(`${k}=${needsQuote ? `"${v.replace(/"/g, '\\"')}"` : v}`)
        }
        for (const k of Object.keys(defaults).sort()) {
          if (k in pinned) continue
          const v = defaults[k]
          if (v == null) continue
          // The `=~` modifier marks the value as a default (editable
          // prefill). Quoting rules identical to pinned.
          const needsQuote = /[\s"]/.test(v)
          parts.push(`${k}=~${needsQuote ? `"${v.replace(/"/g, '\\"')}"` : v}`)
        }
        return `{database-newrow ${parts.join(" ")}}\n\n`
      },
    })

    reg.registerPMNode("database_row", {
      print(node) {
        const table = node.attrs.table || ""
        const fields = node.attrs._fields || {}
        const entries = Object.entries(fields)

        // Bare placeholder (template) — no table attribute, no field table
        if (!table) {
          return `{database-row}\n\n`
        }

        let md = `{database-row table=${table}}\n`
        if (entries.length > 0) {
          md += `| Field | Value |\n`
          md += `| --- | --- |\n`
          for (const [k, v] of entries) {
            md += `| ${k} | ${v} |\n`
          }
        }
        md += "\n"
        return md
      },
    })

    reg.registerPMNode("template_var", {
      print(node) {
        const name = node.attrs.name || "NAME"
        const fb = node.attrs.fallback ? `:${node.attrs.fallback}` : ""
        return `{{${name}${fb}}}`
      },
    })

    // ── Editor plugin: NodeViews ──

    reg.registerEditorPlugin((_schema: Schema) => {
      return new PMPlugin({
        key: new PluginKey("gowiki.database"),
        filterTransaction(tr, state) {
          if (!tr.docChanged) return true
          let oldBound = 0
          state.doc.descendants((n) => {
            if (n.type.name === "database_row" && n.attrs.table) oldBound++
          })
          if (oldBound === 0) return true
          // A bound row can become a placeholder (table cleared), but must not be deleted.
          let newTotal = 0
          tr.doc.descendants((n) => {
            if (n.type.name === "database_row") newTotal++
          })
          return newTotal >= oldBound
        },
        props: {
          nodeViews: {
            database_query(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new DatabaseQueryNodeView(node, view, getPos)
            },
            database_newrow(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new DatabaseNewRowNodeView(node, view, getPos)
            },
            database_row(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new DatabaseRowNodeView(node, view, getPos, reg)
            },
            template_var(node: PMNode, view: EditorView, getPos: () => number | undefined) {
              return new TemplateVarNodeView(node, view, getPos)
            },
          },
        },
      })
    })

    // Refresh all template_var NodeViews when database_row fields change.
    reg.registerEditorPlugin((_schema: Schema) => {
      let lastFields: Record<string, string> = {}
      return new PMPlugin({
        key: new PluginKey("gowiki.templateVarRefresh"),
        view() {
          return {
            update(view: EditorView) {
              const { fields, table } = resolveTemplateFields(view.state)
              const changed =
                Object.keys(fields).length !== Object.keys(lastFields).length ||
                Object.entries(fields).some(([k, v]) => lastFields[k] !== v)
              if (!changed) return
              lastFields = fields
              // Re-render all template_var NodeViews by updating their DOM
              view.state.doc.descendants((node, pos) => {
                if (node.type.name === "template_var") {
                  const domNode = view.nodeDOM(pos)
                  if (domNode instanceof HTMLElement) {
                    const name = node.attrs.name || ""
                    const fallback = node.attrs.fallback || ""

                    // Empty name = placeholder state
                    if (!name) return

                    // Global variables: three-state resolution
                    const globalVal = resolveGlobalVar(name, view)
                    if (globalVal === undefined) {
                      // Unknown ALL_CAPS variable → error
                      domNode.className = "gowiki-template-var gowiki-template-var-error"
                      domNode.textContent = `ERR: {{${name}}}`
                      domNode.title = `Unknown variable: ${name}`
                      return
                    }
                    if (globalVal !== null) {
                      if (globalVal) {
                        domNode.className = "gowiki-template-var"
                        domNode.textContent = globalVal
                        domNode.title = `{{${name}}}`
                      } else if (fallback) {
                        domNode.className = "gowiki-template-var"
                        domNode.textContent = fallback
                        domNode.title = `{{${name}}} (default)`
                      } else {
                        domNode.className = "gowiki-template-var"
                        domNode.textContent = ""
                        domNode.title = `{{${name}}} (empty)`
                      }
                      return
                    }

                    // Database template variables
                    const resolved = fields[name]
                    if (resolved !== undefined) {
                      domNode.className = "gowiki-template-var"
                      domNode.textContent = resolved
                      domNode.title = `{{${name}}}`
                      // Resolve user fields to display label
                      if (table && resolved) {
                        getFieldTypes(table).then((types) => {
                          if (types.get(name) !== "user") return
                          fetchUserInfo(resolved).then((info) => {
                            if (info.label && info.label !== resolved) {
                              domNode.textContent = info.label
                            }
                          })
                        })
                      }
                    } else if (fallback) {
                      domNode.className = "gowiki-template-var"
                      domNode.textContent = fallback
                      domNode.title = `{{${name}}} (default)`
                    } else {
                      domNode.className = "gowiki-template-var gowiki-template-var-error"
                      domNode.textContent = `ERR: {{${name}}}`
                      domNode.title = `Unresolved variable: ${name}`
                    }
                  }
                }
              })
            },
          }
        },
      })
    })

    // ── Commands ──

    reg.registerCommand("database", "insertQuery", (state, dispatch) => {
      const type = reg.schema.nodes.database_query
      if (!type) return false
      if (dispatch) {
        requestInputFocus("table")
        const node = type.create({ table: "" })
        let tr = state.tr.replaceSelectionWith(node)
        const approxPos = tr.mapping.map(state.selection.from)
        let insertedAt: number | null = null
        tr.doc.nodesBetween(Math.max(0, approxPos - 5), Math.min(tr.doc.content.size, approxPos + 5), (n, pos) => {
          if (n.type === type && insertedAt === null) {
            insertedAt = pos
            return false
          }
        })
        if (insertedAt !== null) {
          try {
            tr = tr.setSelection(NodeSelection.create(tr.doc, insertedAt))
            tr = enablePropertiesPanel(tr)
          } catch {}
        }
        dispatch(tr.scrollIntoView())
      }
      return true
    })

    reg.registerCommand("database", "insertNewRow", (state, dispatch) => {
      const type = reg.schema.nodes.database_newrow
      if (!type) return false
      if (dispatch) {
        requestInputFocus("table")
        const node = type.create({ table: "" })
        let tr = state.tr.replaceSelectionWith(node)
        const approxPos = tr.mapping.map(state.selection.from)
        let insertedAt: number | null = null
        tr.doc.nodesBetween(Math.max(0, approxPos - 5), Math.min(tr.doc.content.size, approxPos + 5), (n, pos) => {
          if (n.type === type && insertedAt === null) {
            insertedAt = pos
            return false
          }
        })
        if (insertedAt !== null) {
          try {
            tr = tr.setSelection(NodeSelection.create(tr.doc, insertedAt))
            tr = enablePropertiesPanel(tr)
          } catch {}
        }
        dispatch(tr.scrollIntoView())
      }
      return true
    })

    reg.registerCommand("database", "insertRow", (state, dispatch) => {
      const type = reg.schema.nodes.database_row
      if (!type) return false
      // Disallow if a bound database_row (with table attr) already exists.
      let hasBoundRow = false
      state.doc.descendants((n) => {
        if (n.type.name === "database_row" && n.attrs.table) hasBoundRow = true
      })
      if (hasBoundRow) return false
      if (dispatch) {
        requestInputFocus("table")
        const node = type.create({ table: "", _fields: {} })
        let tr = state.tr.replaceSelectionWith(node)
        const approxPos = tr.mapping.map(state.selection.from)
        let insertedAt: number | null = null
        tr.doc.nodesBetween(Math.max(0, approxPos - 5), Math.min(tr.doc.content.size, approxPos + 5), (n, pos) => {
          if (n.type === type && insertedAt === null) {
            insertedAt = pos
            return false
          }
        })
        if (insertedAt !== null) {
          try {
            tr = tr.setSelection(NodeSelection.create(tr.doc, insertedAt))
            tr = enablePropertiesPanel(tr)
          } catch {}
        }
        dispatch(tr.scrollIntoView())
      }
      return true
    })

    reg.registerCommand("database", "insertVar", (state, dispatch) => {
      const type = reg.schema.nodes.template_var
      if (!type) return false
      if (dispatch) {
        const node = type.create({ name: "" })
        let tr = state.tr.replaceSelectionWith(node)
        const approxPos = tr.mapping.map(state.selection.from)
        // Find the freshly inserted node: it has name="" which is unique to a new insert.
        let insertedAt: number | null = null
        let bestDist = Infinity
        tr.doc.nodesBetween(Math.max(0, approxPos - 10), Math.min(tr.doc.content.size, approxPos + 10), (n, pos) => {
          if (n.type === type && n.attrs.name === "") {
            const dist = Math.abs(pos - approxPos)
            if (dist < bestDist) {
              bestDist = dist
              insertedAt = pos
            }
          }
        })
        if (insertedAt !== null) {
          try {
            tr = tr.setSelection(NodeSelection.create(tr.doc, insertedAt))
            tr = enablePropertiesPanel(tr)
            requestInputFocus("name")
          } catch {}
        }
        dispatch(tr.scrollIntoView())
      }
      return true
    })

    // ── Node properties ──

    // database_query and database_newrow properties are already registered
    // by registerSelfContainedDirective above. Only database_row needs
    // explicit registration since it uses a custom markdown-it block rule.
    reg.registerNodeProperties("database_row", databaseRowProperties)

    reg.registerNodeProperties("template_var", [
      {
        name: "name",
        label: "Variable",
        default: "",
        parse: (raw: string) => raw.trim(),
        serialize: (value: string | null) => String(value ?? ""),
      },
      {
        name: "fallback",
        label: "Default",
        default: "",
        parse: (raw: string) => raw,
        serialize: (value: string | null) => String(value ?? ""),
      },
    ])

    // ── Styles ──

    reg.registerStyle("database", databaseStyles)
  },
}
