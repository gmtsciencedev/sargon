import { Plugin as SargonPlugin, NodePropertySpec } from "../compiler/registry"
import {
  tableNodes,
  tableEditing,
  goToNextCell,
  isInTable,
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  mergeCells,
  splitCell,
  TableMap,
} from "prosemirror-tables"
import { Node, Schema } from "prosemirror-model"
import type { Command } from "prosemirror-state"
import { Plugin as PMPlugin, Transaction, NodeSelection, TextSelection, Selection } from "prosemirror-state"
import { Decoration, DecorationSet } from "prosemirror-view"
import { keymap } from "prosemirror-keymap"
import markdownItMultiMdTable from "markdown-it-multimd-table"
import { formulaSyncPlugin, formulaColorPlugin, shiftFormula } from "./table_formulas"
import { enablePropertiesPanel, requestInputFocus } from "../compiler/core_ui"

// ─── Named color presets ─────────────────────────────────
//
// These resolve to saturated mid-tone hex values. The cell decoration
// passes the value through to a CSS color-mix() that blends it with the
// current page background at low alpha, so a single saturated source
// renders as a pastel in light mode and as a dark tint in dark mode.

const NAMED_COLORS: Record<string, string> = {
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  orange: "#f97316",
  grey: "#737373",
  blue: "#3b82f6",
  none: "",
}

function resolveColor(name: string): string {
  if (name.startsWith("#")) return name
  return NAMED_COLORS[name.toLowerCase()] ?? name
}

// ─── Color rules engine ─────────────────────────────────

export type ColorRule = {
  op: string
  operand?: string
  color: string
}

export function parseColorRules(spec: string): ColorRule[] {
  const rules: ColorRule[] = []
  for (const part of spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const tokens = part.split(/\s+/)
    if (tokens.length < 2) continue

    const raw = tokens[0]
    const color = tokens[tokens.length - 1]

    if (raw === "else") {
      rules.push({ op: "else", color })
      continue
    }
    if (raw === "empty") {
      rules.push({ op: "empty", color })
      continue
    }
    if (raw === "!empty") {
      rules.push({ op: "!empty", color })
      continue
    }

    const opMatch = raw.match(/^(>=|<=|!=|>|<|=|~)(.+)$/)
    if (opMatch) {
      rules.push({ op: opMatch[1], operand: opMatch[2], color })
      continue
    }

    rules.push({ op: "=", operand: raw, color })
  }
  return rules
}

export function evaluateColorRules(rules: ColorRule[], text: string): string | null {
  const trimmed = text.trim()
  const num = Number(trimmed)
  const isNum = trimmed !== "" && !isNaN(num)

  for (const rule of rules) {
    let match = false
    switch (rule.op) {
      case ">":
        match = isNum && num > Number(rule.operand)
        break
      case ">=":
        match = isNum && num >= Number(rule.operand)
        break
      case "<":
        match = isNum && num < Number(rule.operand)
        break
      case "<=":
        match = isNum && num <= Number(rule.operand)
        break
      case "=":
        match = trimmed === rule.operand
        break
      case "!=":
        match = trimmed !== rule.operand
        break
      case "~":
        try {
          match = new RegExp(rule.operand!).test(trimmed)
        } catch {
          match = false
        }
        break
      case "empty":
        match = trimmed === ""
        break
      case "!empty":
        match = trimmed !== ""
        break
      case "else":
        match = true
        break
    }
    if (match) {
      const resolved = resolveColor(rule.color)
      return resolved || null
    }
  }
  return null
}

// ─── Cell text helpers ───────────────────────────────────

export function getCellText(cell: Node): string {
  let text = ""
  cell.content.forEach((block) => {
    block.content.forEach((inline) => {
      if (inline.isText) {
        text += inline.text
      } else if (inline.type.name === "formula_display") {
        text += inline.attrs.result ?? ""
      }
    })
  })
  return text
}

// Mirrors the check at the top of processCellFeatures: cells whose first
// inline child is wrapped in `code` / `code_expand` opt out of every in-cell
// transformation, including column-rule formatting like `decimals`.
function cellIsCodeMarked(cell: Node): boolean {
  if (cell.childCount === 0) return false
  const firstBlock = cell.child(0)
  if (firstBlock.type.name !== "paragraph") return false
  if (firstBlock.childCount === 0) return false
  const firstChild = firstBlock.child(0)
  if (!firstChild.isText) return false
  return firstChild.marks.some((m) => m.type.name === "code" || m.type.name === "code_expand")
}

// ─── Header variants ────────────────────────────────────

// NrMc syntax: "1r" (default), "2r", "1c", "2c", "1r1c", "2r1c", "1r2c", "2r2c", "none"
// Also accepts legacy values for backward compat during parse.
const HEADER_VALUES = ["1r", "2r", "1c", "2c", "1r1c", "2r1c", "1r2c", "2r2c", "none"] as const
type HeaderVariant = (typeof HEADER_VALUES)[number]

const LEGACY_HEADER_MAP: Record<string, HeaderVariant> = {
  "1st_row": "1r",
  "2_rows": "2r",
  "1st_col": "1c",
  "2_cols": "2c",
  both: "1r1c",
}

function parseHeaderValue(raw: string): HeaderVariant {
  if ((HEADER_VALUES as readonly string[]).includes(raw)) return raw as HeaderVariant
  if (raw in LEGACY_HEADER_MAP) return LEGACY_HEADER_MAP[raw]
  throw new Error(`Invalid headers value: ${raw}`)
}

function headerRows(h: HeaderVariant): number {
  if (h === "none" || h === "1c" || h === "2c") return 0
  if (h === "2r" || h === "2r1c" || h === "2r2c") return 2
  return 1 // "1r", "1r1c", "1r2c"
}

function headerCols(h: HeaderVariant): number {
  if (h === "none" || h === "1r" || h === "2r") return 0
  if (h === "2c" || h === "2r2c" || h === "1r2c") return 2
  return 1 // "1c", "1r1c", "2r1c"
}

function applyHeaderVariant(tableNode: Node, schema: Schema): Node {
  const headers: HeaderVariant = tableNode.attrs.headers ?? "1r"

  const hRows = headerRows(headers)
  const hCols = headerCols(headers)

  function shouldBeHeader(r: number, gridCol: number): boolean {
    return r < hRows || gridCol < hCols
  }

  // Use TableMap for correct grid column (accounts for rowspan/colspan).
  const map = TableMap.get(tableNode)

  // Build a lookup: cell offset → grid column.
  // map.map is a flat array [row0col0, row0col1, ..., row1col0, ...] of cell offsets.
  const offsetToGridCol = new Map<number, number>()
  for (let r = 0; r < map.height; r++) {
    for (let col = 0; col < map.width; col++) {
      const offset = map.map[r * map.width + col]
      if (!offsetToGridCol.has(offset)) {
        offsetToGridCol.set(offset, col)
      }
    }
  }

  const rows: Node[][] = []
  tableNode.content.forEach((row) => {
    const cells: Node[] = []
    row.content.forEach((cell) => cells.push(cell))
    rows.push(cells)
  })

  if (rows.length === 0) return tableNode

  // Compute each cell's offset within the table node.
  const newRows: Node[] = []
  let offset = 0
  for (let r = 0; r < rows.length; r++) {
    const newCells: Node[] = []
    offset += 1 // table_row open

    for (let c = 0; c < rows[r].length; c++) {
      const cell = rows[r][c]
      const gridCol = offsetToGridCol.get(offset) ?? c
      const wantHeader = shouldBeHeader(r, gridCol)
      const isHeader = cell.type === schema.nodes.table_header

      if (wantHeader === isHeader) {
        newCells.push(cell)
      } else {
        const targetType = wantHeader ? schema.nodes.table_header : schema.nodes.table_cell
        newCells.push(targetType.create(cell.attrs, cell.content, cell.marks))
      }
      offset += cell.nodeSize
    }
    offset += 1 // table_row close
    newRows.push(schema.nodes.table_row.create(null, newCells))
  }

  return tableNode.type.create(tableNode.attrs, newRows)
}

// ─── Cell merging ────────────────────────────────────────

function resolveMerges(tableNode: Node, schema: Schema): Node {
  const rows: Node[][] = []
  tableNode.content.forEach((row) => {
    const cells: Node[] = []
    row.content.forEach((cell) => cells.push(cell))
    rows.push(cells)
  })

  const numRows = rows.length
  if (numRows === 0) return tableNode
  // A well-formed pipe table has the same column count on every row, but
  // recovery from malformed markdown (or from a serializer bug that lets a
  // newline slip into an inline atom's stored text — see the footnote
  // serializer for the concrete case that led to this guard) can leave rows
  // with mismatched lengths. Use the WIDEST row as the target so we never
  // index past the end of any row, and treat missing positions as empty.
  let numCols = 0
  for (const row of rows) if (row.length > numCols) numCols = row.length

  // Quick check: any merges?
  let hasMerges = false
  for (const row of rows) {
    for (const cell of row) {
      const text = getCellText(cell).trim()
      if (text === "<<" || text === "^^") {
        hasMerges = true
        break
      }
    }
    if (hasMerges) break
  }
  if (!hasMerges) return tableNode

  // Owner grid: tracks which real cell owns each position
  const owner: { r: number; c: number }[][] = Array.from({ length: numRows }, (_, r) =>
    Array.from({ length: numCols }, (_, c) => ({ r, c }))
  )
  const spans: { colspan: number; rowspan: number }[][] = Array.from({ length: numRows }, () =>
    Array.from({ length: numCols }, () => ({ colspan: 1, rowspan: 1 }))
  )
  const removed = new Set<string>()

  // First pass: << (colspan)
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cell = rows[r][c]
      if (!cell) continue
      if (getCellText(cell).trim() === "<<" && c > 0) {
        const o = owner[r][c - 1]
        spans[o.r][o.c].colspan++
        owner[r][c] = o
        removed.add(`${r},${c}`)
      }
    }
  }

  // Second pass: ^^ (rowspan)
  for (let r = 0; r < numRows; r++) {
    const extended = new Set<string>()
    for (let c = 0; c < numCols; c++) {
      if (removed.has(`${r},${c}`)) continue
      const cell = rows[r][c]
      if (!cell) continue
      if (getCellText(cell).trim() === "^^" && r > 0) {
        const o = owner[r - 1][c]
        const oKey = `${o.r},${o.c}`
        if (!extended.has(oKey)) {
          spans[o.r][o.c].rowspan++
          extended.add(oKey)
        }
        owner[r][c] = o
        removed.add(`${r},${c}`)
      }
    }
  }

  // Rebuild table
  const newRows: Node[] = []
  for (let r = 0; r < numRows; r++) {
    const cells: Node[] = []
    for (let c = 0; c < numCols; c++) {
      if (removed.has(`${r},${c}`)) continue
      const cell = rows[r][c]
      if (!cell) continue
      const { colspan, rowspan } = spans[r][c]
      if (colspan > 1 || rowspan > 1) {
        cells.push(cell.type.create({ ...cell.attrs, colspan, rowspan }, cell.content, cell.marks))
      } else {
        cells.push(cell)
      }
    }
    newRows.push(schema.nodes.table_row.create(null, cells))
  }

  return tableNode.type.create(tableNode.attrs, newRows)
}

// ─── Cell directive parsing ──────────────────────────────

// Generic cell directive: {key=value key=value ...} at start of cell text.
// Supported keys: color, text-color, valign, vtext
const CELL_DIRECTIVE_RE = /^\{([^}]+)\}\s*/
const CELL_KV_RE = /([a-z-]+)=([^\s}]+)/g

function applyCellFeatures(tableNode: Node, schema: Schema): Node {
  let changed = false

  const newRows: Node[] = []
  tableNode.content.forEach((row) => {
    const newCells: Node[] = []
    row.content.forEach((cell) => {
      const result = processCellFeatures(cell, schema)
      if (result !== cell) changed = true
      newCells.push(result)
    })
    newRows.push(schema.nodes.table_row.create(null, newCells))
  })

  return changed ? tableNode.type.create(tableNode.attrs, newRows) : tableNode
}

// INVARIANT: Backticks (code mark) protect cell content from ALL in-cell parsing.
// Every feature that processes cell text (directives, formulas, or any future
// pattern like {... } or =...) MUST check hasCodeMark and skip if true.
// Violation caused: `{{ID}}` in backticks was parsed as a cell directive,
// stripping the variable name and leaving just `}`.
function processCellFeatures(cell: Node, schema: Schema): Node {
  if (cell.childCount === 0) return cell
  const firstBlock = cell.child(0)
  if (firstBlock.type !== schema.nodes.paragraph) return cell
  if (firstBlock.childCount === 0) return cell

  const firstChild = firstBlock.child(0)
  if (!firstChild.isText) return cell
  const text = firstChild.text ?? ""

  // Code marks protect cell content from all in-cell parsing.
  const hasCodeMark = firstChild.marks.some((m) => m.type.name === "code" || m.type.name === "code_expand")
  if (hasCodeMark) return cell

  const newAttrs = { ...cell.attrs }
  let newText = text
  let changed = false

  // Cell directive: {color=X text-color=Y valign=Z vtext=W}
  const directiveMatch = newText.match(CELL_DIRECTIVE_RE)
  if (directiveMatch) {
    const inner = directiveMatch[1]
    let m: RegExpExecArray | null
    const kvRe = new RegExp(CELL_KV_RE.source, "g")
    while ((m = kvRe.exec(inner)) !== null) {
      const [, key, val] = m
      if (key === "color") newAttrs.cellColor = val
      else if (key === "text-color") newAttrs.cellTextColor = val
      else if (key === "align") newAttrs.cellAlign = val
      else if (key === "valign") newAttrs.cellValign = val
      else if (key === "vtext") newAttrs.cellVtext = val
    }
    newText = newText.slice(directiveMatch[0].length)
    changed = true
  }

  // Formula detection — store formula in attr, empty cell text.
  if (newText.trimStart().startsWith("=") && newText.trim().length > 1) {
    newAttrs.formula = newText.trim().slice(1)
    newText = ""
    changed = true
  }

  if (!changed) return cell

  // Rebuild cell with modified text and attrs
  let newFirstBlock: Node
  if (newText === "") {
    if (firstBlock.childCount === 1) {
      newFirstBlock = schema.nodes.paragraph.create()
    } else {
      const children: Node[] = []
      for (let i = 1; i < firstBlock.childCount; i++) {
        children.push(firstBlock.child(i))
      }
      newFirstBlock = schema.nodes.paragraph.create(null, children)
    }
  } else if (newText !== text) {
    const children: Node[] = [schema.text(newText, firstChild.marks)]
    for (let i = 1; i < firstBlock.childCount; i++) {
      children.push(firstBlock.child(i))
    }
    newFirstBlock = schema.nodes.paragraph.create(null, children)
  } else {
    newFirstBlock = firstBlock
  }

  const cellChildren: Node[] = [newFirstBlock]
  for (let i = 1; i < cell.childCount; i++) {
    cellChildren.push(cell.child(i))
  }

  return cell.type.create(newAttrs, cellChildren, cell.marks)
}

// ─── Column attribute aggregation ────────────────────────

export type ColumnPropEntry = {
  align?: string
  width?: string
  color?: string
  decimals?: string
  valign?: string
}
export type ColumnProps = Record<string, ColumnPropEntry>

/**
 * Resolve column properties for a given column number (1-based).
 * Priority: "*" (lowest) < "N-" < "N+" < exact "N" (highest).
 */
export function resolveColumnProps(columns: ColumnProps, colNum: number): ColumnPropEntry | null {
  const merged: ColumnPropEntry = {}
  let found = false

  // 1. "*" — all columns (lowest priority)
  const star = columns["*"]
  if (star) {
    if (star.align) merged.align = star.align
    if (star.width) merged.width = star.width
    if (star.color) merged.color = star.color
    if (star.decimals) merged.decimals = star.decimals
    if (star.valign) merged.valign = star.valign
    found = true
  }

  // 2. "N-" where colNum <= N
  for (const key of Object.keys(columns)) {
    const m = key.match(/^(\d+)-$/)
    if (m && colNum <= parseInt(m[1])) {
      const props = columns[key]
      if (props.align) merged.align = props.align
      if (props.width) merged.width = props.width
      if (props.color) merged.color = props.color
      if (props.decimals) merged.decimals = props.decimals
      if (props.valign) merged.valign = props.valign
      found = true
    }
  }

  // 3. "N+" where colNum >= N
  for (const key of Object.keys(columns)) {
    const m = key.match(/^(\d+)\+$/)
    if (m && colNum >= parseInt(m[1])) {
      const props = columns[key]
      if (props.align) merged.align = props.align
      if (props.width) merged.width = props.width
      if (props.color) merged.color = props.color
      if (props.decimals) merged.decimals = props.decimals
      if (props.valign) merged.valign = props.valign
      found = true
    }
  }

  // 4. Exact "N" (highest priority)
  const exact = columns[String(colNum)]
  if (exact) {
    if (exact.align) merged.align = exact.align
    if (exact.width) merged.width = exact.width
    if (exact.color) merged.color = exact.color
    if (exact.decimals) merged.decimals = exact.decimals
    if (exact.valign) merged.valign = exact.valign
    found = true
  }

  return found ? merged : null
}

function aggregateTableAttrs(raw: Record<string, any>): Record<string, any> {
  const clean: Record<string, any> = {}
  let columns: ColumnProps | null = null

  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("_colge.")) {
      const m = key.match(/^_colge\.(\d+)\.(\w+)$/)
      if (m) {
        columns = columns ?? {}
        const colKey = `${m[1]}+`
        const prop = m[2]
        columns[colKey] = columns[colKey] ?? {}
        ;(columns[colKey] as any)[prop] = value
      }
    } else if (key.startsWith("_colle.")) {
      const m = key.match(/^_colle\.(\d+)\.(\w+)$/)
      if (m) {
        columns = columns ?? {}
        const colKey = `${m[1]}-`
        const prop = m[2]
        columns[colKey] = columns[colKey] ?? {}
        ;(columns[colKey] as any)[prop] = value
      }
    } else if (key.startsWith("_colall.")) {
      const m = key.match(/^_colall\.(\w+)$/)
      if (m) {
        columns = columns ?? {}
        const prop = m[1]
        columns["*"] = columns["*"] ?? {}
        ;(columns["*"] as any)[prop] = value
      }
    } else if (key.startsWith("_col.")) {
      const m = key.match(/^_col\.(\d+)\.(\w+)$/)
      if (m) {
        columns = columns ?? {}
        const colKey = m[1]
        const prop = m[2]
        columns[colKey] = columns[colKey] ?? {}
        ;(columns[colKey] as any)[prop] = value
      }
    } else if (key.startsWith("_colrange.")) {
      const m = key.match(/^_colrange\.(\d+)\.(\d+)\.(\w+)$/)
      if (m) {
        columns = columns ?? {}
        const start = parseInt(m[1])
        const end = parseInt(m[2])
        const prop = m[3]
        for (let i = start; i <= end; i++) {
          const colKey = String(i)
          columns[colKey] = columns[colKey] ?? {}
          ;(columns[colKey] as any)[prop] = value
        }
      }
    } else {
      clean[key] = value
    }
  }

  if (columns) clean.columns = columns
  return clean
}

// ─── Width normalization ─────────────────────────────────

function normalizeTableWidth(raw: string): string | null {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase()
  if (!value) return null

  const pct = value.match(/^(\d+)%$/)
  if (pct) {
    const n = Number(pct[1])
    if (n > 0) return `${n}%`
    throw new Error("Table width percent must be > 0")
  }

  const px = value.match(/^(\d+)px$/)
  if (px) {
    const n = Number(px[1])
    if (n > 0) return `${n}px`
    throw new Error("Table width in px must be > 0")
  }

  throw new Error(`Invalid table width "${raw}". Expected 80% or 800px.`)
}

// ─── Column rules text serialization/parsing ─────────────

function serializeColumnRulesText(columns: ColumnProps | null): string {
  if (!columns) return ""
  return serializeColumnSpecs(columns).join("\n")
}

function parseColumnRulesText(raw: string): ColumnProps | null {
  const text = raw.trim()
  if (!text) return null

  const lines = text.split("\n")
  const flatAttrs: Record<string, any> = {}

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    // Match: col[spec].[prop]=[value]
    const m = line.match(/^col(\d+(?:-\d+)?|\d+[+-]|)\.(align|width|color|decimals|valign)=(.+)$/)
    if (!m) {
      throw new Error(`Line ${i + 1}: invalid syntax`)
    }

    const spec = m[1]
    const prop = m[2]
    let value = m[3]

    // Unquote value if quoted
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }

    // Validate prop values
    if (prop === "align" && !["left", "center", "right"].includes(value)) {
      throw new Error(`Line ${i + 1}: align must be left, center, or right`)
    }
    if (prop === "width" && !/^\d+(%|px)$/.test(value)) {
      throw new Error(`Line ${i + 1}: width must be Npx or N%`)
    }
    if (prop === "color" && !value) {
      throw new Error(`Line ${i + 1}: color must be non-empty`)
    }
    if (prop === "decimals" && !/^\d+$/.test(value)) {
      throw new Error(`Line ${i + 1}: decimals must be a non-negative integer`)
    }
    if (prop === "valign" && !["top", "centered", "bottom"].includes(value)) {
      throw new Error(`Line ${i + 1}: valign must be top, centered, or bottom`)
    }

    // Convert to internal flat attr keys
    if (spec === "") {
      // col.prop → all columns
      flatAttrs[`_colall.${prop}`] = value
    } else if (spec.endsWith("+")) {
      // colN+.prop → >= N
      const n = spec.slice(0, -1)
      flatAttrs[`_colge.${n}.${prop}`] = value
    } else if (spec.endsWith("-") && !/^\d+-\d+$/.test(spec)) {
      // colN-.prop → <= N (but not colN-M range)
      const n = spec.slice(0, -1)
      flatAttrs[`_colle.${n}.${prop}`] = value
    } else if (/^\d+-\d+$/.test(spec)) {
      // colN-M.prop → range
      const [start, end] = spec.split("-")
      flatAttrs[`_colrange.${start}.${end}.${prop}`] = value
    } else if (/^\d+$/.test(spec)) {
      // colN.prop → single
      flatAttrs[`_col.${spec}.${prop}`] = value
    } else {
      throw new Error(`Line ${i + 1}: invalid column spec "${spec}"`)
    }
  }

  return aggregateTableAttrs(flatAttrs).columns ?? null
}

// ─── Table properties ────────────────────────────────────

const tableProperties: NodePropertySpec[] = [
  {
    name: "width",
    label: "Width",
    default: null,
    parse: (raw: string) => normalizeTableWidth(raw),
    serialize: (value: string | null) => String(value ?? ""),
  },
  {
    name: "headers",
    label: "Headers",
    default: "1r",
    parse: (raw: string) => parseHeaderValue(raw),
    options: [
      { value: "1r", label: "1 row" },
      { value: "2r", label: "2 rows" },
      { value: "1c", label: "1 column" },
      { value: "2c", label: "2 columns" },
      { value: "1r1c", label: "1 row, 1 column" },
      { value: "2r1c", label: "2 rows, 1 column" },
      { value: "1r2c", label: "1 row, 2 columns" },
      { value: "2r2c", label: "2 rows, 2 columns" },
      { value: "none", label: "None" },
    ],
  },
  {
    name: "columns",
    label: "Column rules",
    default: null,
    multiline: true,
    helpText: 'col2.align=center  col2-5.width=100px  col2+.color="rule"  col3.decimals=2  col.valign=centered',
    parse: (raw: string) => parseColumnRulesText(raw) as any,
    serialize: (value: any) => serializeColumnRulesText(value as ColumnProps | null),
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
]

// ─── DOM helpers ─────────────────────────────────────────

function addStyleToDOM(spec: any, style: string): any {
  if (!style || !Array.isArray(spec)) return spec
  const [tag, maybeAttrs, ...rest] = spec
  const hasAttrs = maybeAttrs && typeof maybeAttrs === "object" && !Array.isArray(maybeAttrs)
  const attrs = hasAttrs ? maybeAttrs : {}
  const existing = attrs.style ? String(attrs.style) : ""
  const newStyle = existing ? `${existing}${existing.trim().endsWith(";") ? " " : "; "}${style}` : style
  const newAttrs = { ...attrs, style: newStyle }
  const children = hasAttrs ? rest : [maybeAttrs, ...rest]
  return [tag, newAttrs, ...children]
}

// ─── Column spec serialization with range collapsing ─────

function serializeColumnSpecs(columns: ColumnProps): string[] {
  const parts: string[] = []

  // Serialize special keys first
  for (const prop of ["align", "width", "color", "decimals", "valign"] as const) {
    // "*" → col.prop
    if (columns["*"]?.[prop]) {
      const formatted = prop === "color" ? `"${columns["*"][prop]}"` : columns["*"][prop]
      parts.push(`col.${prop}=${formatted}`)
    }
    // "N-" → colN-.prop
    for (const key of Object.keys(columns)) {
      const mle = key.match(/^(\d+)-$/)
      if (mle && columns[key][prop]) {
        const formatted = prop === "color" ? `"${columns[key][prop]}"` : columns[key][prop]
        parts.push(`col${mle[1]}-.${prop}=${formatted}`)
      }
    }
    // "N+" → colN+.prop
    for (const key of Object.keys(columns)) {
      const mge = key.match(/^(\d+)\+$/)
      if (mge && columns[key][prop]) {
        const formatted = prop === "color" ? `"${columns[key][prop]}"` : columns[key][prop]
        parts.push(`col${mge[1]}+.${prop}=${formatted}`)
      }
    }
  }

  // Numeric keys — existing range-collapsing logic
  const sortedKeys = Object.keys(columns)
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b)

  // Group by property type, collecting which columns have each (prop, value) pair
  const propGroups: Record<string, { col: number; value: string }[]> = {}

  for (const col of sortedKeys) {
    const props = columns[String(col)]
    for (const prop of ["align", "width", "color", "decimals", "valign"] as const) {
      const value = props[prop]
      if (value) {
        const key = prop
        propGroups[key] = propGroups[key] ?? []
        propGroups[key].push({ col, value })
      }
    }
  }

  // For each property type, group consecutive columns with identical values into ranges
  for (const prop of ["align", "width", "color", "decimals", "valign"]) {
    const entries = propGroups[prop]
    if (!entries) continue

    // Group by value, preserving order
    const byValue: { value: string; cols: number[] }[] = []
    const valueMap = new Map<string, number[]>()
    for (const e of entries) {
      if (!valueMap.has(e.value)) {
        const cols: number[] = []
        valueMap.set(e.value, cols)
        byValue.push({ value: e.value, cols })
      }
      valueMap.get(e.value)!.push(e.col)
    }

    for (const { value, cols } of byValue) {
      cols.sort((a, b) => a - b)
      // Find runs of consecutive columns
      let i = 0
      while (i < cols.length) {
        let j = i
        while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++
        const runLen = j - i + 1
        const formatted = prop === "color" ? `"${value}"` : value
        if (runLen >= 2) {
          parts.push(`col${cols[i]}-${cols[j]}.${prop}=${formatted}`)
        } else {
          parts.push(`col${cols[i]}.${prop}=${formatted}`)
        }
        i = j + 1
      }
    }
  }

  return parts
}

// ─── Serialization grid ──────────────────────────────────

type GridCell = { type: "cell"; node: Node } | { type: "<<" } | { type: "^^" }

function buildSerializationGrid(tableNode: Node): {
  grid: GridCell[][]
  totalCols: number
} {
  const rows: Node[][] = []
  tableNode.content.forEach((row) => {
    const cells: Node[] = []
    row.content.forEach((cell) => cells.push(cell))
    rows.push(cells)
  })

  if (rows.length === 0) return { grid: [], totalCols: 0 }

  // Determine total columns (max across all rows, accounting for spans)
  let totalCols = 0
  for (const row of rows) {
    let rowCols = 0
    for (const cell of row) {
      rowCols += cell.attrs.colspan ?? 1
    }
    totalCols = Math.max(totalCols, rowCols)
  }

  const grid: (GridCell | null)[][] = Array.from({ length: rows.length }, () => new Array(totalCols).fill(null))

  for (let r = 0; r < rows.length; r++) {
    let c = 0
    for (const cell of rows[r]) {
      while (c < totalCols && grid[r][c] !== null) c++
      if (c >= totalCols) break

      const colspan = cell.attrs.colspan ?? 1
      const rowspan = cell.attrs.rowspan ?? 1

      grid[r][c] = { type: "cell", node: cell }

      for (let dc = 1; dc < colspan; dc++) {
        if (c + dc < totalCols) grid[r][c + dc] = { type: "<<" }
      }

      for (let dr = 1; dr < rowspan; dr++) {
        if (r + dr < rows.length) {
          for (let dc = 0; dc < colspan; dc++) {
            if (c + dc < totalCols) grid[r + dr][c + dc] = { type: "^^" }
          }
        }
      }

      c += colspan
    }
  }

  const finalGrid: GridCell[][] = grid.map((row) => row.map((cell) => cell ?? { type: "cell", node: null as any }))

  return { grid: finalGrid, totalCols }
}

// ─── Serialize cell content ──────────────────────────────

function serializeCellContent(cell: Node, recurse: (node: Node) => string): string {
  if (!cell) return ""
  let prefix = ""
  const dirParts: string[] = []
  if (cell.attrs.cellColor) dirParts.push(`color=${cell.attrs.cellColor}`)
  if (cell.attrs.cellTextColor) dirParts.push(`text-color=${cell.attrs.cellTextColor}`)
  if (cell.attrs.cellAlign && cell.attrs.cellAlign !== "left") dirParts.push(`align=${cell.attrs.cellAlign}`)
  if (cell.attrs.cellValign && cell.attrs.cellValign !== "top") dirParts.push(`valign=${cell.attrs.cellValign}`)
  if (cell.attrs.cellVtext && cell.attrs.cellVtext !== "horizontal") dirParts.push(`vtext=${cell.attrs.cellVtext}`)
  if (dirParts.length > 0) prefix = `{${dirParts.join(" ")}} `

  if (cell.attrs.formula) {
    return prefix + `=${cell.attrs.formula}`
  }

  let txt = ""
  cell.content.forEach((p) => {
    txt += recurse(p).trim()
  })

  // Cell boundaries are pipes — any literal `|` in the serialized content
  // would prematurely close the cell. Escape as `\|` so markdown-it's
  // pipe-table parser sees it as literal text (and the round-trip is
  // stable — parse produces a text node with `|`, serialize turns it back
  // to `\|`). Backslashes in `recurse` output are already doubled up by
  // escapeMarkdownText, so no `\|` can appear here from another escape
  // chain — a simple global replace is safe.
  txt = txt.replace(/\|/g, "\\|")

  return prefix + txt
}

// ─── Styles ──────────────────────────────────────────────

const tableStyles = `
.ProseMirror table {
  border-collapse: collapse;
  margin: 0.3em 0;
}

.ProseMirror th,
.ProseMirror td {
  border: 1px solid var(--gw-color-border);
  padding: 0.25em 0.5em;
  vertical-align: top;
  color: var(--gw-color-text);
}

.ProseMirror th {
  background: var(--gw-color-table-head-bg);
  color: var(--gw-color-table-head-fg);
  font-weight: 600;
  text-align: left;
}

/* Cells with an explicit user-chosen background color were designed
   assuming dark text on a light background. In dark mode the cell
   text would inherit white, which is often unreadable against bright
   greens/yellows/cyans. Force dark text for those cells unless the
   author has also set an explicit text color. Rule-colored cells
   (data-cell-color="rule") are handled below — they blend with the
   page background. */
html[data-theme="dark"] .ProseMirror td[data-cell-color]:not([data-cell-color="rule"]):not([data-cell-text-color]),
html[data-theme="dark"] .ProseMirror th[data-cell-color]:not([data-cell-color="rule"]):not([data-cell-text-color]) {
  color: #222 !important;
}

/* Column-rule colored cells: render the saturated rule color at low
   alpha over the page background, in both light and dark modes. The
   page bg dilutes the saturated source — pastel on white, dark tint
   on a dark page — so the same source color works in both themes. */
.ProseMirror td[data-cell-color="rule"],
.ProseMirror th[data-cell-color="rule"] {
  background: color-mix(in srgb, var(--gw-cell-rule-bg, transparent) 30%, var(--gw-color-bg)) !important;
}

.ProseMirror td > p,
.ProseMirror th > p {
  margin: 0;
}

.ProseMirror .selectedCell {
  background: var(--gw-color-selection);
}

/* Formula display atom — inline result shown in formula cells */
.ProseMirror .formula-display {
  display: inline;
  margin: 0;
  padding: 0;
}

/* In edit mode, show a subtle indicator on formula display text */
#app.gowiki-editing .ProseMirror .formula-display {
  background: var(--gw-color-info-bg);
  color: var(--gw-color-text);
  border-radius: 3px;
  padding: 0 3px;
}

/* Error values styled like unresolved template variables */
.ProseMirror .formula-display-error {
  background: var(--gw-color-warning-bg);
  color: var(--gw-color-warning);
  border-radius: 3px;
  padding: 0 3px;
}

/* Vertical text in cells: styles applied to inner <p>, not the <td>,
   so that rowspan cells size correctly in the table layout algorithm. */
.ProseMirror td[data-cell-vtext] > p,
.ProseMirror th[data-cell-vtext] > p {
  writing-mode: vertical-rl;
  text-orientation: sideways;
  white-space: nowrap;
}
.ProseMirror td[data-cell-vtext="upward"] > p,
.ProseMirror th[data-cell-vtext="upward"] > p {
  transform: rotate(180deg);
}
`

// ─── Formula display keyboard / clipboard plugin ────────

// Custom clipboard MIME carrying the source cell's visual row/col alongside
// the formula. Read on paste to shift refs Excel-style (delta between src
// and dst). text/plain is set in parallel as a fallback so cross-tool copy
// still works — pasting into a text editor gives "=formula" verbatim, and
// pasting from an outside source without this MIME gives the literal
// formula (no shift).
const FORMULA_MIME = "application/x-gowiki-formula"

function formulaDisplayPlugin(schema: Schema): PMPlugin {
  function findParentCell(state: any, atomPos: number) {
    const $pos = state.doc.resolve(atomPos)
    for (let d = $pos.depth; d > 0; d--) {
      const n = $pos.node(d)
      if (n.type === schema.nodes.table_cell || n.type === schema.nodes.table_header) {
        return { cellNode: n, cellPos: $pos.before(d) }
      }
    }
    return null
  }

  function getFormulaText(state: any, atomPos: number): string {
    const parent = findParentCell(state, atomPos)
    if (!parent) return ""
    const formula = parent.cellNode.attrs.formula
    return formula != null ? `=${formula}` : ""
  }

  // Visual row/col for the cell containing atomPos, or null if not in a
  // table. Visual col accounts for colspans in earlier cells of the row.
  function getCellCoords(state: any, atomPos: number): { row: number; col: number } | null {
    const $pos = state.doc.resolve(atomPos)
    for (let d = $pos.depth; d > 0; d--) {
      if ($pos.node(d).type === schema.nodes.table) {
        const table = $pos.node(d)
        const tableStart = $pos.before(d) + 1
        let rowStart = tableStart
        for (let r = 0; r < table.childCount; r++) {
          const row = table.child(r)
          const rowEnd = rowStart + row.nodeSize
          if (atomPos >= rowStart && atomPos < rowEnd) {
            let cellStart = rowStart + 1
            let visualCol = 0
            for (let c = 0; c < row.childCount; c++) {
              const cell = row.child(c)
              const cellEnd = cellStart + cell.nodeSize
              if (atomPos >= cellStart && atomPos < cellEnd) {
                return { row: r, col: visualCol }
              }
              cellStart = cellEnd
              visualCol += cell.attrs.colspan ?? 1
            }
          }
          rowStart = rowEnd
        }
      }
    }
    return null
  }

  function writeFormulaClipboard(clipboardData: DataTransfer | null, state: any, atomPos: number) {
    if (!clipboardData) return
    const text = getFormulaText(state, atomPos)
    clipboardData.setData("text/plain", text)
    const coords = getCellCoords(state, atomPos)
    if (coords && text.startsWith("=")) {
      // Payload is the raw formula (no leading "=") plus the source cell
      // coords, so the paste handler can compute the shift delta and rewrite
      // refs. Kept separate from text/plain so a paste into a plain text
      // target still gets exactly "=formula".
      clipboardData.setData(
        FORMULA_MIME,
        JSON.stringify({ formula: text.slice(1), srcRow: coords.row, srcCol: coords.col })
      )
    }
  }

  function clearFormula(view: any, sel: NodeSelection) {
    const parent = findParentCell(view.state, sel.from)
    if (!parent) return
    // Delete the atom, then clear formula attr
    const tr = view.state.tr.delete(sel.from, sel.from + sel.node.nodeSize)
    const mappedCellPos = tr.mapping.map(parent.cellPos)
    const liveCell = tr.doc.nodeAt(mappedCellPos)
    if (liveCell) {
      tr.setNodeMarkup(mappedCellPos, undefined, { ...liveCell.attrs, formula: null })
    }
    const cursorPos = tr.mapping.map(sel.from)
    tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPos)))
    view.dispatch(tr)
  }

  return new PMPlugin({
    // When Tab (or any navigation) lands in a paragraph whose only child
    // is a formula_display atom, convert the TextSelection to NodeSelection.
    // But if the old state already had a NodeSelection on the same atom,
    // the user is navigating away — don't snap back.
    appendTransaction(_transactions, oldState, newState) {
      if (!(newState.selection instanceof TextSelection)) return null
      const $from = newState.selection.$from
      const para = $from.parent
      if (para.type !== schema.nodes.paragraph) return null
      if (para.childCount !== 1) return null
      if (para.child(0).type !== schema.nodes.formula_display) return null
      const atomPos = $from.start() // position of first inline child

      // If old state had NodeSelection on the same formula atom, user is
      // navigating away (e.g. arrow keys) — let them leave.
      if (
        oldState.selection instanceof NodeSelection &&
        oldState.selection.node.type === schema.nodes.formula_display &&
        oldState.selection.from === atomPos
      ) {
        return null
      }

      return newState.tr.setSelection(NodeSelection.create(newState.doc, atomPos))
    },

    props: {
      // Copy → put "=formula_expression" on clipboard
      clipboardTextSerializer(slice, view) {
        const node = slice.content.firstChild
        if (node?.type === schema.nodes.formula_display) {
          const sel = view.state.selection
          if (sel instanceof NodeSelection && sel.node.type === schema.nodes.formula_display) {
            return getFormulaText(view.state, sel.from)
          }
          return String(node.attrs.result ?? "")
        }
        return undefined as any
      },

      // All DOM event handlers run BEFORE handleKeyDown / handlePaste from
      // any plugin, so they take priority over baseKeymap's deleteSelection.
      handleDOMEvents: {
        keydown(view, event) {
          const sel = view.state.selection
          if (!(sel instanceof NodeSelection)) return false
          if (sel.node.type !== schema.nodes.formula_display) return false

          // Backspace / Delete → remove formula
          if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault()
            clearFormula(view, sel)
            return true
          }

          // "=" → open properties panel with formula input focused
          if (event.key === "=") {
            event.preventDefault()
            requestInputFocus("formula")
            view.dispatch(enablePropertiesPanel(view.state.tr))
            return true
          }

          // ArrowLeft → move to previous cell
          if (event.key === "ArrowLeft") {
            event.preventDefault()
            const parent = findParentCell(view.state, sel.from)
            if (!parent) return true
            const $cell = view.state.doc.resolve(parent.cellPos)
            const newSel = Selection.near($cell, -1)
            view.dispatch(view.state.tr.setSelection(newSel))
            return true
          }

          // ArrowRight → move to next cell
          if (event.key === "ArrowRight") {
            event.preventDefault()
            const parent = findParentCell(view.state, sel.from)
            if (!parent) return true
            const afterCell = parent.cellPos + parent.cellNode.nodeSize
            const $after = view.state.doc.resolve(Math.min(afterCell, view.state.doc.content.size))
            const newSel = Selection.near($after, 1)
            view.dispatch(view.state.tr.setSelection(newSel))
            return true
          }

          // Other printable chars → consume (don't replace the atom with text)
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault()
            return true
          }

          return false
        },

        // Paste "=formula" into a table cell → set formula attr.
        // Using handleDOMEvents.paste so it fires before other plugins'
        // handlePaste (e.g. prosemirror-tables).
        //
        // If the clipboard carries the gowiki-formula MIME (a formula copied
        // from another gowiki cell in the same session), rewrite refs by the
        // delta between the source cell and the destination — Excel behavior.
        // Refs pinned with $ (per-axis: $A1, A$1, $A$1) don't shift. Falls
        // back to a literal paste when the payload is missing (an outside
        // "=…" clipboard, or a formula written by hand into text/plain).
        paste(view, event) {
          const payloadJSON = event.clipboardData?.getData(FORMULA_MIME) || ""
          const plain = event.clipboardData?.getData("text/plain") || ""
          let formula: string | null = null
          let src: { row: number; col: number } | null = null
          if (payloadJSON) {
            try {
              const p = JSON.parse(payloadJSON)
              if (typeof p.formula === "string") {
                formula = p.formula
                if (typeof p.srcRow === "number" && typeof p.srcCol === "number") {
                  src = { row: p.srcRow, col: p.srcCol }
                }
              }
            } catch {
              // Fall through to plain text handling
            }
          }
          if (formula == null) {
            if (!plain.startsWith("=")) return false
            formula = plain.slice(1)
          }

          const $from = view.state.selection.$from
          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d)
            if (node.type === schema.nodes.table_cell || node.type === schema.nodes.table_header) {
              event.preventDefault()
              const cellPos = $from.before(d)

              let shifted = formula
              if (src) {
                const dst = getCellCoords(view.state, cellPos + 1)
                if (dst) shifted = shiftFormula(formula, dst.row - src.row, dst.col - src.col)
              }

              const tr = view.state.tr.setNodeMarkup(cellPos, undefined, {
                ...node.attrs,
                formula: shifted,
              })
              // Clear any existing text in the paragraph
              const para = node.child(0)
              const paraContentStart = cellPos + 2
              if (para.content.size > 0) {
                const mappedStart = tr.mapping.map(paraContentStart)
                const mappedEnd = tr.mapping.map(paraContentStart + para.content.size)
                tr.delete(mappedStart, mappedEnd)
              }
              view.dispatch(tr)
              return true
            }
          }
          return false
        },

        // Cut → put "=formula_expression" on clipboard, then clear formula
        cut(view, event) {
          const sel = view.state.selection
          if (!(sel instanceof NodeSelection)) return false
          if (sel.node.type !== schema.nodes.formula_display) return false

          event.preventDefault()
          writeFormulaClipboard(event.clipboardData, view.state, sel.from)
          clearFormula(view, sel)
          return true
        },

        // Copy via DOM event → put "=formula_expression" on clipboard
        copy(view, event) {
          const sel = view.state.selection
          if (!(sel instanceof NodeSelection)) return false
          if (sel.node.type !== schema.nodes.formula_display) return false

          event.preventDefault()
          writeFormulaClipboard(event.clipboardData, view.state, sel.from)
          return true
        },
      },
    },
  })
}

// ─── Column decoration plugin ────────────────────────────

function columnDecoPlugin(schema: Schema): PMPlugin {
  return new PMPlugin({
    props: {
      decorations(state) {
        const decos: Decoration[] = []

        state.doc.descendants((node, pos) => {
          if (node.type !== schema.nodes.table) return true

          const columns: ColumnProps | null = node.attrs.columns
          if (!columns) return true

          // Use TableMap for correct column resolution (accounts for
          // colspan/rowspan cells that shift positions in the PM node).
          const map = TableMap.get(node)

          for (let row = 0; row < map.height; row++) {
            for (let col = 0; col < map.width; col++) {
              const cellOffset = map.map[row * map.width + col]
              // Skip cells that are continuations of a colspan/rowspan
              // (they share the same offset as the origin cell).
              if (col > 0 && map.map[row * map.width + col - 1] === cellOffset) continue
              if (row > 0 && map.map[(row - 1) * map.width + col] === cellOffset) continue

              const cellPos = pos + 1 + cellOffset
              const cell = node.nodeAt(cellOffset)
              if (!cell) continue

              const colNum = col + 1
              const props = resolveColumnProps(columns, colNum)

              if (props) {
                let style = ""
                let ruleColored = false
                let formatted: string | null = null
                if (props.align) style += `text-align: ${props.align}; `
                if (props.width) style += `width: ${props.width}; `

                // Column vertical align: only apply when the cell doesn't
                // already carry its own — cell-level overrides column-level,
                // mirroring how color precedence works.
                if (props.valign && !cell.attrs.cellValign) {
                  const cssValue = props.valign === "centered" ? "middle" : props.valign
                  style += `vertical-align: ${cssValue}; `
                }

                // Column color (only if cell doesn't have its own color).
                // Skip header cells — a column rule shading its own header
                // reads as noise and hides the header's semantic contrast.
                // Explicit per-cell colors on a header still apply (they were
                // set by hand).
                const isHeaderCell = cell.type === schema.nodes.table_header
                if (props.color && !cell.attrs.cellColor && !isHeaderCell) {
                  const rules = parseColorRules(props.color)
                  const text = getCellText(cell)
                  const bg = evaluateColorRules(rules, text)
                  if (bg) {
                    // Expose the rule color as a CSS variable so dark-mode
                    // CSS can reuse it with reduced alpha (the dark page bg
                    // shows through, naturally darkening the pastel while
                    // preserving its hue).
                    style += `--gw-cell-rule-bg: ${bg}; background: var(--gw-cell-rule-bg); `
                    ruleColored = true
                  }
                }

                // Column decimals: format numeric content. The raw text
                // stays in the doc (round-trip safe); CSS swaps the visual
                // via a ::before pseudo reading --gw-format-num. We omit the
                // data-format flag on the cell that currently holds the
                // selection so the user sees and edits the raw value while
                // they are working in it — spreadsheet-style.
                if (props.decimals && !cellIsCodeMarked(cell)) {
                  const n = parseFloat(getCellText(cell).trim())
                  if (Number.isFinite(n)) {
                    const digits = Math.max(0, parseInt(props.decimals, 10) || 0)
                    formatted = n.toFixed(digits)
                    // Escape single quotes — extremely unlikely for a number
                    // but cheap insurance.
                    const safe = formatted.replace(/'/g, "\\'")
                    style += `--gw-format-num: '${safe}'; `
                  }
                }

                const cellFrom = cellPos
                const cellTo = cellPos + cell.nodeSize
                const selOverlapsCell = state.selection.from < cellTo && state.selection.to > cellFrom

                if (style) {
                  const attrs: Record<string, string> = { style }
                  if (ruleColored) attrs["data-cell-color"] = "rule"
                  if (formatted !== null && !selOverlapsCell) {
                    attrs["data-format"] = "num"
                  }
                  decos.push(Decoration.node(cellPos, cellPos + cell.nodeSize, attrs))
                }
              }
            }
          }

          return false
        })

        return DecorationSet.create(state.doc, decos)
      },
    },
  })
}

// ─── Cell coordinate tooltip plugin ──────────────────────

function cellTooltipPlugin(schema: Schema): PMPlugin {
  return new PMPlugin({
    props: {
      decorations(state) {
        // A1/B2 addresses are useful when writing formulas, but noise when
        // reading — they'd shadow any real cell content the browser would
        // otherwise tooltip (e.g. link href, image alt). Only emit them
        // while the app is in edit mode. The mode switch rebuilds the PM
        // view, so this evaluates at the right moment.
        const app = document.getElementById("app")
        if (!app || !app.classList.contains("gowiki-editing")) {
          return DecorationSet.empty
        }

        const decos: Decoration[] = []

        state.doc.descendants((node, pos) => {
          if (node.type !== schema.nodes.table) return true

          let rowIdx = 0
          node.content.forEach((row, rowOffset) => {
            const rowPos = pos + 1 + rowOffset
            let colIdx = 0

            row.content.forEach((cell, cellOffset) => {
              const cellPos = rowPos + 1 + cellOffset
              const label = `cell ${indexToColLetter(colIdx)}${rowIdx + 1}`
              decos.push(
                Decoration.node(cellPos, cellPos + cell.nodeSize, {
                  title: label,
                })
              )
              colIdx += cell.attrs.colspan ?? 1
            })

            rowIdx++
          })

          return false
        })

        return DecorationSet.create(state.doc, decos)
      },
    },
  })
}

// ─── Formula reference adjustment ────────────────────────

function colLetterToIndex(letter: string): number {
  let index = 0
  for (const ch of letter.toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64)
  }
  return index - 1
}

function indexToColLetter(index: number): string {
  let letter = ""
  let n = index + 1
  while (n > 0) {
    n--
    letter = String.fromCharCode(65 + (n % 26)) + letter
    n = Math.floor(n / 26)
  }
  return letter
}

/**
 * Adjust a single cell reference (0-based row/col) for a structural change.
 * Returns the adjusted index, or -1 if the ref is deleted (#REF).
 */
function adjustIndex(idx: number, changeType: "insert" | "delete", changeIdx: number): number {
  if (changeType === "insert") {
    return idx >= changeIdx ? idx + 1 : idx
  } else {
    if (idx === changeIdx) return -1 // deleted
    return idx > changeIdx ? idx - 1 : idx
  }
}

export function adjustFormula(
  formula: string,
  changeType: "insertRow" | "deleteRow" | "insertCol" | "deleteCol",
  changeIdx: number // 0-based row/col where the change occurs
): string {
  const isRow = changeType === "insertRow" || changeType === "deleteRow"
  const isInsert = changeType === "insertRow" || changeType === "insertCol"
  const op = isInsert ? "insert" : "delete"

  // Match ranges (A1:B3) and individual refs (A1).
  // Ranges are matched first by the alternation order.
  return formula.replace(/([A-Z]+)(\d+):([A-Z]+)(\d+)|([A-Z]+)(\d+)/g, (_full, rC1, rR1, rC2, rR2, sC, sR) => {
    if (rC1 !== undefined) {
      // Range match: rC1+rR1 : rC2+rR2
      let sCol = colLetterToIndex(rC1)
      let sRow = parseInt(rR1) - 1
      let eCol = colLetterToIndex(rC2)
      let eRow = parseInt(rR2) - 1

      if (isRow) {
        if (isInsert) {
          // Expand range when insert is inside the range or right after
          // the end. This supports the common "total on last line" pattern:
          // =SUM(B2:B4) with insert at row 4 → =SUM(B2:B5).
          if (changeIdx > sRow && changeIdx <= eRow) {
            eRow++
          } else {
            if (sRow >= changeIdx) sRow++
            if (eRow >= changeIdx) eRow++
          }
        } else {
          // Delete inside range → shrink
          if (changeIdx >= sRow && changeIdx <= eRow) {
            if (sRow === eRow) return "#REF"
            eRow--
          } else {
            if (sRow > changeIdx) sRow--
            if (eRow > changeIdx) eRow--
          }
        }
      } else {
        // Column operations — same logic on col axis
        if (isInsert) {
          if (changeIdx > sCol && changeIdx <= eCol) {
            eCol++
          } else {
            if (sCol >= changeIdx) sCol++
            if (eCol >= changeIdx) eCol++
          }
        } else {
          if (changeIdx >= sCol && changeIdx <= eCol) {
            if (sCol === eCol) return "#REF"
            eCol--
          } else {
            if (sCol > changeIdx) sCol--
            if (eCol > changeIdx) eCol--
          }
        }
      }

      return indexToColLetter(sCol) + String(sRow + 1) + ":" + indexToColLetter(eCol) + String(eRow + 1)
    } else {
      // Single ref: sC + sR
      let col = colLetterToIndex(sC)
      let row = parseInt(sR) - 1

      if (isRow) {
        const newRow = adjustIndex(row, op, changeIdx)
        if (newRow < 0) return "#REF"
        row = newRow
      } else {
        const newCol = adjustIndex(col, op, changeIdx)
        if (newCol < 0) return "#REF"
        col = newCol
      }

      return indexToColLetter(col) + String(row + 1)
    }
  })
}

/**
 * Adjust column specs when columns are inserted or deleted.
 * changeIdx is 0-based column index.
 */
export function adjustColumnSpecs(
  columns: ColumnProps | null,
  changeType: "insertCol" | "deleteCol",
  changeIdx: number
): ColumnProps | null {
  if (!columns) return null

  const oneBasedIdx = changeIdx + 1
  const isInsert = changeType === "insertCol"
  const result: ColumnProps = {}

  for (const [keyStr, props] of Object.entries(columns)) {
    // Skip special keys ("*", "N+", "N-") — handled in the special-key section below
    if (!/^\d+$/.test(keyStr)) {
      result[keyStr] = props
      continue
    }
    const key = parseInt(keyStr)

    if (isInsert) {
      const newKey = key >= oneBasedIdx ? key + 1 : key
      result[String(newKey)] = props
    } else {
      // Delete
      if (key === oneBasedIdx) continue // drop this column's spec
      const newKey = key > oneBasedIdx ? key - 1 : key
      result[String(newKey)] = props
    }
  }

  // On insert: fill gap at oneBasedIdx if both neighbors have matching properties
  if (isInsert) {
    const leftKey = String(oneBasedIdx - 1)
    const rightKey = String(oneBasedIdx + 1)
    const left = result[leftKey]
    const right = result[rightKey]
    if (left && right) {
      const fill: ColumnPropEntry = {}
      for (const prop of ["align", "width", "color", "decimals", "valign"] as const) {
        if (left[prop] && left[prop] === right[prop]) {
          fill[prop] = left[prop]
        }
      }
      if (fill.align || fill.width || fill.color || fill.decimals || fill.valign) {
        result[String(oneBasedIdx)] = fill
      }
    }
  }

  // Adjust special keys ("N+", "N-")
  for (const keyStr of Object.keys(result)) {
    const geMatch = keyStr.match(/^(\d+)\+$/)
    if (geMatch) {
      const n = parseInt(geMatch[1])
      if (isInsert) {
        if (oneBasedIdx < n) {
          result[`${n + 1}+`] = result[keyStr]
          delete result[keyStr]
        }
      } else {
        if (oneBasedIdx < n) {
          result[`${n - 1}+`] = result[keyStr]
          delete result[keyStr]
        } else if (oneBasedIdx === n) {
          // Deleted exactly the boundary column — keep same N
        }
      }
      continue
    }
    const leMatch = keyStr.match(/^(\d+)-$/)
    if (leMatch) {
      const n = parseInt(leMatch[1])
      if (isInsert) {
        if (oneBasedIdx <= n) {
          result[`${n + 1}-`] = result[keyStr]
          delete result[keyStr]
        }
      } else {
        if (oneBasedIdx <= n) {
          const newN = n - 1
          if (newN < 1) {
            delete result[keyStr]
          } else {
            result[`${newN}-`] = result[keyStr]
            delete result[keyStr]
          }
        }
      }
    }
    // "*" never changes — no action needed
  }

  return Object.keys(result).length > 0 ? result : null
}

function tableHasFormulas(tableNode: Node): boolean {
  let found = false
  tableNode.descendants((node) => {
    if (found) return false
    if ((node.type.name === "table_cell" || node.type.name === "table_header") && node.attrs.formula) {
      found = true
      return false
    }
    return true
  })
  return found
}

function getTableAndSelection(
  state: any,
  schema: Schema
): {
  tablePos: number
  tableNode: Node
  rowIndex: number
  colIndex: number
} | null {
  const $from = state.selection.$from
  for (let depth = $from.depth; depth >= 0; depth--) {
    if ($from.node(depth).type === schema.nodes.table) {
      const tableNode = $from.node(depth)
      const tablePos = $from.before(depth)

      let rowIndex = 0
      let colIndex = 0
      let rowStart = tablePos + 1

      for (let r = 0; r < tableNode.childCount; r++) {
        const row = tableNode.child(r)
        const rowEnd = rowStart + row.nodeSize

        if ($from.pos >= rowStart && $from.pos < rowEnd) {
          rowIndex = r

          let cellStart = rowStart + 1
          let visualCol = 0
          for (let c = 0; c < row.childCount; c++) {
            const cell = row.child(c)
            const cellEnd = cellStart + cell.nodeSize
            if ($from.pos >= cellStart && $from.pos < cellEnd) {
              colIndex = visualCol
              break
            }
            cellStart = cellEnd
            visualCol += cell.attrs.colspan ?? 1
          }
          break
        }
        rowStart = rowEnd
      }

      return { tablePos, tableNode, rowIndex, colIndex }
    }
  }
  return null
}

function wrapTableCmd(
  cmd: Command,
  changeType: "insertRow" | "deleteRow" | "insertCol" | "deleteCol",
  indexOffset: number
): Command {
  return (state, dispatch, view) => {
    if (!dispatch) return cmd(state, undefined, view)

    const info = getTableAndSelection(state, state.schema)
    if (!info) return cmd(state, dispatch, view)

    const hasFormulas = tableHasFormulas(info.tableNode)
    const isColChange = changeType === "insertCol" || changeType === "deleteCol"
    const hasColumns = !!info.tableNode.attrs.columns

    if (!hasFormulas && !(isColChange && hasColumns)) return cmd(state, dispatch, view)

    const isRow = changeType === "insertRow" || changeType === "deleteRow"
    const changeIndex = isRow ? info.rowIndex + indexOffset : info.colIndex + indexOffset

    // Intercept dispatch to inject formula + column spec adjustments into the same
    // transaction, so we don't need `view` and it's a single undo step.
    const augmentedDispatch = (tr: any) => {
      // Pass 1: adjust formula references
      if (hasFormulas) {
        tr.doc.descendants((node: Node, pos: number) => {
          if (node.type !== state.schema.nodes.table) return true

          node.content.forEach((row: Node, rowOffset: number) => {
            const rowPos = pos + 1 + rowOffset
            let cellStart = rowPos + 1

            row.content.forEach((cell: Node) => {
              const formula = cell.attrs.formula
              if (formula) {
                const adjusted = adjustFormula(formula, changeType, changeIndex)
                if (adjusted !== formula) {
                  tr.setNodeMarkup(cellStart, undefined, {
                    ...cell.attrs,
                    formula: adjusted,
                  })
                }
              }
              cellStart += cell.nodeSize
            })
          })

          return false
        })
      }

      // Pass 2: adjust column specs on column insert/delete
      if (isColChange && hasColumns) {
        tr.doc.descendants((node: Node, pos: number) => {
          if (node.type !== state.schema.nodes.table) return true

          const newColumns = adjustColumnSpecs(node.attrs.columns, changeType as "insertCol" | "deleteCol", changeIndex)
          if (newColumns !== node.attrs.columns) {
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              columns: newColumns,
            })
          }

          return false
        })
      }

      dispatch(tr)
    }

    return cmd(state, augmentedDispatch, view)
  }
}

// ─── Public API ──────────────────────────────────────────

export function makeTable(schema: any, rows: number, cols: number, withHeader = true): Node {
  const { table, table_row, table_cell, table_header } = schema.nodes

  const rowNodes: Node[] = []

  for (let r = 0; r < rows; r++) {
    const cells: Node[] = []
    for (let c = 0; c < cols; c++) {
      const cellType = withHeader && r === 0 ? table_header : table_cell
      cells.push(cellType.createAndFill()!)
    }
    rowNodes.push(table_row.create(null, cells))
  }

  return table.create(null, rowNodes)
}

/**
 * Table plugin — enhanced with headers, column properties,
 * cell color, cell merging, and formula support.
 */
export const tablePlugin: SargonPlugin = {
  register(reg) {
    reg.registerMarkdownItPlugin((md) => {
      md.use(markdownItMultiMdTable, {
        multiline: false,
        rowspan: false,
        headerless: false,
        multibody: false,
      })

      // Protect formula content in table cells from inline markdown parsing.
      // Formulas start with "=" and may contain *, _, ~, ^, ` which would
      // otherwise be interpreted as markdown formatting (italic, underline, etc.).
      // This core rule runs BEFORE the "inline" core rule, escaping those chars
      // so that markdown-it's inline parser treats them as literals.
      md.core.ruler.before("inline", "formula_protect", (state: any) => {
        const tokens = state.tokens
        for (let i = 1; i < tokens.length; i++) {
          if (tokens[i].type !== "inline") continue
          const prev = tokens[i - 1]
          if (prev.type !== "td_open" && prev.type !== "th_open") continue

          const content: string = tokens[i].content
          // Skip optional cell directive {key=value ...} at the start
          let formulaStart = 0
          const dirMatch = content.match(/^\{[^}]+\}\s*/)
          if (dirMatch) formulaStart = dirMatch[0].length

          if (content.charAt(formulaStart) !== "=" || content.length <= formulaStart + 1) continue
          // Skip highlight syntax (==text== or =={color=VALUE}text==) — not a formula.
          if (content.charAt(formulaStart + 1) === "=") continue

          // Escape markdown-significant chars in the formula part
          const prefix = content.slice(0, formulaStart)
          const formula = content.slice(formulaStart)
          tokens[i].content = prefix + formula.replace(/([*_~^`[\]])/g, "\\$1")
        }
      })
    })

    const nodes: Record<string, any> = tableNodes({
      tableGroup: "block",
      cellContent: "block+",
      cellAttributes: {
        cellColor: {
          default: null,
          getFromDOM: (dom: HTMLElement) => dom.getAttribute("data-cell-color") || null,
          setDOMAttr(value: any, attrs: any) {
            if (value) {
              attrs["data-cell-color"] = value
              const existing = attrs.style || ""
              attrs.style = existing + `background: ${resolveColor(value)}; `
            }
          },
        },
        cellTextColor: {
          default: null,
          getFromDOM: (dom: HTMLElement) => dom.getAttribute("data-cell-text-color") || null,
          setDOMAttr(value: any, attrs: any) {
            if (value) {
              attrs["data-cell-text-color"] = value
              const existing = attrs.style || ""
              attrs.style = existing + `color: ${resolveColor(value)}; `
            }
          },
        },
        cellAlign: {
          default: null,
          getFromDOM: (dom: HTMLElement) => dom.getAttribute("data-cell-align") || null,
          setDOMAttr(value: any, attrs: any) {
            if (value) {
              attrs["data-cell-align"] = value
              const existing = attrs.style || ""
              attrs.style = existing + `text-align: ${value}; `
            }
          },
        },
        cellValign: {
          default: null,
          getFromDOM: (dom: HTMLElement) => dom.getAttribute("data-cell-valign") || null,
          setDOMAttr(value: any, attrs: any) {
            if (value) {
              attrs["data-cell-valign"] = value
              const existing = attrs.style || ""
              attrs.style = existing + `vertical-align: ${value === "centered" ? "middle" : value}; `
            }
          },
        },
        cellVtext: {
          default: null,
          getFromDOM: (dom: HTMLElement) => dom.getAttribute("data-cell-vtext") || null,
          setDOMAttr(value: any, attrs: any) {
            if (value) {
              attrs["data-cell-vtext"] = value
            }
          },
        },
        formula: {
          default: null,
          getFromDOM: (dom: HTMLElement) => dom.getAttribute("data-formula") || null,
          setDOMAttr(value: any, attrs: any) {
            if (value) {
              attrs["data-formula"] = value
            }
          },
        },
      },
    })

    // Inline atom for displaying formula results (like template_var)
    nodes["formula_display"] = {
      inline: true,
      atom: true,
      selectable: true,
      group: "inline",
      attrs: {
        result: { default: "" },
      },
      toDOM(node: Node) {
        const r = String(node.attrs.result ?? "")
        const isError = r.startsWith("#")
        return [
          "span",
          {
            class: isError ? "formula-display formula-display-error" : "formula-display",
            contenteditable: "false",
          },
          r,
        ]
      },
      parseDOM: [
        {
          tag: "span.formula-display",
          getAttrs(dom: HTMLElement) {
            return { result: dom.textContent || "" }
          },
        },
      ],
    }

    const baseTable = nodes.table
    nodes.table = {
      ...baseTable,
      attrs: {
        ...baseTable.attrs,
        width: { default: null },
        headers: { default: "1r" },
        columns: { default: null },
        caption: { default: null },
        label: { default: null },
      },
      toDOM(node: Node) {
        const domSpec = baseTable.toDOM ? baseTable.toDOM(node) : ["table", ["tbody", 0]]
        const width = node.attrs.width ?? null
        return width ? addStyleToDOM(domSpec, `width: ${width};`) : domSpec
      },
    }

    reg.registerSchema({ nodes })

    // Register formula property for cell types (visible in property panel)
    const formulaProperty: NodePropertySpec = {
      name: "formula",
      label: "Formula",
      default: "",
      parse: (raw: string) => raw.trim(),
      serialize: (value: string | null) => String(value ?? ""),
      visible: (attrs: Record<string, any>) => attrs.formula != null,
      backspaceEmpty: null,
    }
    const cellColorProperty: NodePropertySpec = {
      name: "cellColor",
      label: "Color",
      default: null,
      parse: (raw: string) => raw.trim() || null,
      serialize: (value: string | null) => String(value ?? ""),
      visible: (attrs: Record<string, any>) => !!attrs.cellColor,
    }
    const cellTextColorProperty: NodePropertySpec = {
      name: "cellTextColor",
      label: "Text color",
      default: null,
      parse: (raw: string) => raw.trim() || null,
      serialize: (value: string | null) => String(value ?? ""),
      visible: (attrs: Record<string, any>) => !!attrs.cellTextColor,
    }
    // Show align/valign/vtext whenever any cell property is active.
    const anyCellProp = (attrs: Record<string, any>) =>
      !!attrs.cellColor ||
      !!attrs.cellTextColor ||
      !!attrs.formula ||
      !!attrs.cellAlign ||
      !!attrs.cellValign ||
      !!attrs.cellVtext
    const cellAlignProperty: NodePropertySpec = {
      name: "cellAlign",
      label: "Align",
      default: null,
      parse: (raw: string) => raw.trim() || null,
      serialize: (value: string | null) => String(value ?? ""),
      visible: anyCellProp,
      options: [
        { value: "left", label: "Left (default)" },
        { value: "center", label: "Center" },
        { value: "right", label: "Right" },
      ],
    }
    const cellValignProperty: NodePropertySpec = {
      name: "cellValign",
      label: "Vertical align",
      default: null,
      parse: (raw: string) => raw.trim() || null,
      serialize: (value: string | null) => String(value ?? ""),
      visible: anyCellProp,
      options: [
        { value: "top", label: "Top (default)" },
        { value: "centered", label: "Centered" },
        { value: "bottom", label: "Bottom" },
      ],
    }
    const cellVtextProperty: NodePropertySpec = {
      name: "cellVtext",
      label: "Vertical text",
      default: null,
      parse: (raw: string) => raw.trim() || null,
      serialize: (value: string | null) => String(value ?? ""),
      visible: anyCellProp,
      options: [
        { value: "horizontal", label: "Horizontal (default)" },
        { value: "upward", label: "Upward" },
        { value: "downward", label: "Downward" },
      ],
    }
    reg.registerNodeProperties("table_cell", [
      formulaProperty,
      cellColorProperty,
      cellTextColorProperty,
      cellAlignProperty,
      cellValignProperty,
      cellVtextProperty,
    ])
    reg.registerNodeProperties("table_header", [
      formulaProperty,
      cellColorProperty,
      cellTextColorProperty,
      cellAlignProperty,
      cellValignProperty,
      cellVtextProperty,
    ])

    reg.registerDirective("table", {
      nodeType: "table",
      appliesTo: ["table_open"],
      properties: tableProperties,
      parseUnknownAttr(key, value) {
        // Open-ended: col2+.align (>= N)
        const mge = key.match(/^col(\d+)\+\.(align|width|color|decimals|valign)$/)
        if (mge) return [`_colge.${mge[1]}.${mge[2]}`, value]
        // Open-ended: col2-.align (<= N) — note: `-\.` distinguishes from range `col2-5.`
        const mle = key.match(/^col(\d+)-\.(align|width|color|decimals|valign)$/)
        if (mle) return [`_colle.${mle[1]}.${mle[2]}`, value]
        // All columns: col.align
        const mall = key.match(/^col\.(align|width|color|decimals|valign)$/)
        if (mall) return [`_colall.${mall[1]}`, value]
        // Single column: col3.align
        const m = key.match(/^col(\d+)\.(align|width|color|decimals|valign)$/)
        if (m) return [`_col.${m[1]}.${m[2]}`, value]
        // Range: col2-10.align
        const mr = key.match(/^col(\d+)-(\d+)\.(align|width|color|decimals|valign)$/)
        if (mr) return [`_colrange.${mr[1]}.${mr[2]}.${mr[3]}`, value]
        return null
      },
    })

    /* ----------------------------
     * Markdown -> PM
     * ---------------------------- */

    reg.registerNode("table_open", {
      open(ctx) {
        const rawAttrs = ctx.token?.meta?.directives?.table ?? null
        const attrs = rawAttrs ? aggregateTableAttrs(rawAttrs) : null
        ctx.open(reg.schema.nodes.table.create(attrs))
      },
    })

    reg.registerNode("table_close", {
      close(ctx) {
        ctx.close()
        let tableNode = ctx.popLast()!
        tableNode = resolveMerges(tableNode, reg.schema)
        tableNode = applyHeaderVariant(tableNode, reg.schema)
        tableNode = applyCellFeatures(tableNode, reg.schema)
        ctx.push(tableNode)
      },
    })

    reg.registerNode("thead_open", { open() {} })
    reg.registerNode("thead_close", { close() {} })
    reg.registerNode("tbody_open", { open() {} })
    reg.registerNode("tbody_close", { close() {} })

    reg.registerNode("tr_open", {
      open(ctx) {
        ctx.open(reg.schema.nodes.table_row.create())
      },
    })

    reg.registerNode("tr_close", {
      close(ctx) {
        ctx.close()
      },
    })

    reg.registerNode("th_open", {
      open(ctx) {
        ctx.open(reg.schema.nodes.table_header.create())
        ctx.open(reg.schema.nodes.paragraph.create())
      },
    })

    reg.registerNode("th_close", {
      close(ctx) {
        ctx.close()
        ctx.close()
      },
    })

    reg.registerNode("td_open", {
      open(ctx) {
        ctx.open(reg.schema.nodes.table_cell.create())
        ctx.open(reg.schema.nodes.paragraph.create())
      },
    })

    reg.registerNode("td_close", {
      close(ctx) {
        ctx.close()
        ctx.close()
      },
    })

    /* ----------------------------
     * PM -> Markdown
     * ---------------------------- */

    reg.registerPMNode("table", {
      print(node, _ctx, recurse) {
        const { grid, totalCols } = buildSerializationGrid(node)
        if (grid.length === 0) return ""

        // Build directive line
        const directiveParts: string[] = []

        const headers = node.attrs.headers ?? "1r"
        if (headers !== "1r") {
          directiveParts.push(`headers=${headers}`)
        }

        const width = node.attrs.width ?? null
        if (width) {
          directiveParts.push(`width=${width}`)
        }

        const columns: ColumnProps | null = node.attrs.columns
        if (columns) {
          directiveParts.push(...serializeColumnSpecs(columns))
        }

        const caption = node.attrs.caption ?? null
        if (caption) {
          directiveParts.push(`caption="${String(caption).replace(/"/g, '\\"')}"`)
        }
        const label = node.attrs.label ?? null
        if (label) {
          directiveParts.push(`label=${label}`)
        }

        let out = ""
        if (directiveParts.length > 0) {
          out += `{table ${directiveParts.join(" ")}}\n`
        }

        // Serialize rows
        for (let r = 0; r < grid.length; r++) {
          const cells: string[] = []
          for (let c = 0; c < totalCols; c++) {
            const entry = grid[r][c]
            if (entry.type === "<<") {
              cells.push("<<")
            } else if (entry.type === "^^") {
              cells.push("^^")
            } else {
              cells.push(serializeCellContent(entry.node, recurse))
            }
          }
          out += "| " + cells.join(" | ") + " |\n"

          // Separator after first row
          if (r === 0) {
            out += "| " + Array(totalCols).fill("---").join(" | ") + " |\n"
          }
        }

        return out + "\n"
      },
    })

    // table_row: produces a complete single-row table (used when copying a row)
    reg.registerPMNode("table_row", {
      print(node, _ctx, recurse) {
        const cells: string[] = []
        node.forEach((cell) => {
          cells.push(serializeCellContent(cell, recurse))
        })
        const row = "| " + cells.join(" | ") + " |"
        const sep = "| " + cells.map(() => "---").join(" | ") + " |"
        return row + "\n" + sep + "\n\n"
      },
    })

    // table_cell / table_header: serialize inline content (used when copying a cell)
    reg.registerPMNode("table_cell", {
      print(node, _ctx, recurse) {
        let txt = ""
        node.content.forEach((p) => {
          txt += recurse(p).trim()
        })
        return txt
      },
    })
    reg.registerPMNode("table_header", {
      print(node, _ctx, recurse) {
        let txt = ""
        node.content.forEach((p) => {
          txt += recurse(p).trim()
        })
        return txt
      },
    })

    // formula_display is ephemeral (managed by appendTransaction), not serialized
    reg.registerPMNode("formula_display", {
      print() {
        return ""
      },
    })

    /* ----------------------------
     * Editor integration
     * ---------------------------- */

    const tabInTable = (state: any, dispatch: any, view: any) => {
      if (goToNextCell(1)(state, dispatch)) return true
      if (!isInTable(state)) return false
      if (dispatch) {
        addRowAfter(state, dispatch)
        if (view) {
          goToNextCell(1)(view.state, view.dispatch)
        }
      }
      return true
    }

    // Enter inside a table cell inserts a hard break (\n in markdown). The
    // dialect's pipe-table syntax keeps each cell on a single source line, so
    // splitting into a second paragraph cannot be serialized — it would be
    // silently dropped on publish. Falling through to baseKeymap is what
    // produces that bug; intercepting here makes Enter equivalent to
    // Alt-Enter when the selection sits in a cell.
    const enterInCell: Command = (state, dispatch) => {
      const { $from } = state.selection
      let inCell = false
      for (let d = $from.depth; d > 0; d--) {
        const name = $from.node(d).type.name
        if (name === "table_cell" || name === "table_header") {
          inCell = true
          break
        }
      }
      if (!inCell) return false
      const hardBreak = state.schema.nodes.hard_break
      if (!hardBreak) return false
      if (dispatch) {
        dispatch(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView())
      }
      return true
    }

    reg.registerEditorPlugin(() =>
      keymap({
        Tab: tabInTable,
        "Shift-Tab": goToNextCell(-1),
        Enter: enterInCell,
      })
    )

    reg.registerEditorPlugin(() => tableEditing())

    // Formula display keyboard/clipboard (Backspace, =, copy, cut)
    reg.registerEditorPlugin((schema) => formulaDisplayPlugin(schema))

    // Column property decorations
    reg.registerEditorPlugin((schema) => columnDecoPlugin(schema))

    // Formula sync (manages formula_display atoms via appendTransaction)
    reg.registerEditorPlugin((schema) => formulaSyncPlugin(schema))

    // Formula color decorations (column colors on formula cells)
    reg.registerEditorPlugin((schema) => formulaColorPlugin(schema))

    // Cell coordinate tooltips
    reg.registerEditorPlugin((schema) => cellTooltipPlugin(schema))

    // Dynamic headers: reactively convert cells to th/td when headers attr changes
    reg.registerEditorPlugin(
      (schema) =>
        new PMPlugin({
          appendTransaction(_trs, _oldState, newState) {
            let tr: Transaction | null = null

            newState.doc.descendants((node, pos) => {
              if (node.type !== schema.nodes.table) return true

              const fixed = applyHeaderVariant(node, schema)
              if (!fixed.eq(node)) {
                if (!tr) tr = newState.tr
                tr.replaceWith(pos, pos + node.nodeSize, fixed)
              }

              return false
            })

            return tr
          },
        })
    )

    // Formula creation via "=" in empty cell
    reg.registerEditorPlugin(
      (schema) =>
        new PMPlugin({
          props: {
            handleTextInput(view, _from, _to, text) {
              if (text !== "=") return false

              const $from = view.state.selection.$from
              for (let depth = $from.depth; depth > 0; depth--) {
                const node = $from.node(depth)
                if (node.type === schema.nodes.table_cell || node.type === schema.nodes.table_header) {
                  // If cell already has a formula, just open the panel
                  if (node.attrs.formula != null) {
                    const tr = enablePropertiesPanel(view.state.tr)
                    requestInputFocus("formula")
                    view.dispatch(tr)
                    return true
                  }

                  // Check: cell has exactly one paragraph child with no content
                  if (node.childCount !== 1) return false
                  const para = node.child(0)
                  if (para.type !== schema.nodes.paragraph) return false
                  if (para.content.size !== 0) return false

                  const cellPos = $from.before(depth)
                  let tr = view.state.tr.setNodeMarkup(cellPos, undefined, {
                    ...node.attrs,
                    formula: "",
                  })
                  tr = enablePropertiesPanel(tr)
                  requestInputFocus("formula")
                  view.dispatch(tr)
                  return true
                }
              }
              return false
            },
          },
        })
    )

    /* ----------------------------
     * Styles
     * ---------------------------- */

    reg.registerStyle("table", tableStyles)

    /* ----------------------------
     * Commands
     * ---------------------------- */

    reg.registerCommand("table", "insert", (state, dispatch) => {
      const tableNode = makeTable(reg.schema, 3, 3, true)
      if (!tableNode) return false
      if (dispatch) {
        dispatch(state.tr.replaceSelectionWith(tableNode))
      }
      return true
    })

    reg.registerCommand("table", "row.addBefore", wrapTableCmd(addRowBefore, "insertRow", 0))
    reg.registerCommand("table", "row.addAfter", wrapTableCmd(addRowAfter, "insertRow", 1))
    reg.registerCommand("table", "column.addBefore", wrapTableCmd(addColumnBefore, "insertCol", 0))
    reg.registerCommand("table", "column.addAfter", wrapTableCmd(addColumnAfter, "insertCol", 1))
    reg.registerCommand("table", "row.delete", wrapTableCmd(deleteRow, "deleteRow", 0))
    reg.registerCommand("table", "column.delete", wrapTableCmd(deleteColumn, "deleteCol", 0))
    reg.registerCommand("table", "cell.merge", mergeCells)
    reg.registerCommand("table", "cell.split", splitCell)
    reg.registerCommand("table", "delete", deleteTable)

    // Add cell property — sets cellColor to a default value so the panel shows it
    reg.registerCommand("table", "cell.properties", (state, dispatch) => {
      const $from = state.selection.$from
      for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth)
        if (node.type === reg.schema.nodes.table_cell || node.type === reg.schema.nodes.table_header) {
          if (dispatch) {
            const cellPos = $from.before(depth)
            // Set defaults to make properties visible in panel
            let tr = state.tr.setNodeMarkup(cellPos, undefined, {
              ...node.attrs,
              cellColor: node.attrs.cellColor || "none",
              cellAlign: node.attrs.cellAlign || "left",
              cellValign: node.attrs.cellValign || "top",
              cellVtext: node.attrs.cellVtext || "horizontal",
            })
            tr = enablePropertiesPanel(tr)
            dispatch(tr)
          }
          return true
        }
      }
      return false
    })
  },
}
