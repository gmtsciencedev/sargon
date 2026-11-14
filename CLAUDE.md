# CLAUDE.md — Sargon

## Project overview

Sargon is a rewrite of Dokuwiki with three fundamental changes:
- Storage format is a custom bijective Markdown dialect (not Dokuwiki's syntax)
- The editor is tightly and natively integrated with ProseMirror (dual mode: raw Markdown + visual)
- The backend is Go; the frontend is TypeScript/ESM centered on ProseMirror

The canonical document format is Markdown (the custom dialect). The ProseMirror document model is a projection of it, not a source of truth.

## Repository layout

```
frontend/       Vite + ProseMirror document/editor engine (TypeScript/ESM)
backend/        Go API server (chi), authoritative for all storage
scripts/        Local orchestration helpers
data/
  content/      All user-managed files: .md pages and media attachments (same root)
  meta/         Metadata mirroring content/ structure, .json files only
```

## Architecture invariants — never violate these

- The Go backend never depends on Node.js, Vite, or the TypeScript toolchain.
- The backend is authoritative for: storage, document identity, document relationships, media lifecycle, indexing, search, access control, and export.
- The frontend is responsible for: document semantics, editing UX, rendering. It never enforces backend rules locally.
- The communication boundary between frontend and backend is HTTP REST only.
- Markdown is the ground truth. The backend only knows Markdown. The backend never encodes editor-specific semantics.
- The frontend never "fixes" backend inconsistencies.

## Development vs production

**Development:** frontend served by Vite (HMR, unbundled ESM), backend exposes API only. Run with `make dev` or separately via `make dev-backend` / `make dev-frontend`. Frontend proxies `/api/*` to `http://localhost:8080`.

**Production:** frontend bundled (core bundle + one bundle per plugin), served as static assets by the Go backend. Build with `make build-frontend`, serve with `make run-prod`.

## Custom Markdown dialect — key rules

The dialect is **bijective**: one canonical syntax per node type. No alternative syntaxes. CommonMark alternatives are explicitly rejected. When importing foreign Markdown, non-canonical syntax may be transformed on import.

Key divergences from CommonMark:
- `*italic*` only — `_italic_` is **underline**, not italic
- `**bold**` only — `__bold__` rejected
- `_underline_` — not italic
- ATX headings only (`#`) — setext headings rejected
- `- item` for unordered lists — `*` rejected
- Raw HTML forbidden — `<` and `>` are plain characters
- HTML entities not interpreted — use UTF-8 directly
- Single newline in a top-level paragraph = hard line break (`<br>`)
- Trailing spaces have no meaning — two-space line break rule does not exist
- `\n` literal = explicit hard line break (valid in lists and tables only, not in paragraphs where a bare newline already produces a hard break)
- Properties syntax: `{pluginname key=value}` on its own line before the target block
- No column alignment syntax in tables
- Multi-body tables (`<tbody>`) are not supported and must be rejected

Round-trip between raw, visual, and view modes must be lossless. Deterministic serialization is a hard requirement.

## ProseMirror visual feedback

All visual feedback in the editor (selection highlights, status indicators, cursor position markers) MUST be implemented as ProseMirror decorations (DecorationSet in plugin state), NEVER as direct DOM class manipulation. Direct DOM mutation inside PM's update cycle causes infinite loops. Decorations rebuild from state on every transaction and are managed by PM's rendering pipeline. Rebuild decorations when `tr.selectionSet` or `tr.docChanged` in the plugin's `state.apply()`.

## Content and link resolution

All user content (pages and attachments) lives under `data/content/`. Metadata lives under `data/meta/` mirroring the same folder structure.

### Canonical page paths

Every page has exactly one canonical path. This path is used in URLs, API responses, WebSocket messages, link targets, and all internal references. **The word `index` never appears in a canonical path.**

| Storage file | Canonical path |
|---|---|
| `content/page.md` | `/page` |
| `content/index.md` | `/` |
| `content/docs/index.md` | `/docs/` |
| `content/docs/guide.md` | `/docs/guide` |

Rules:
- All canonical paths start with `/`
- Leaf pages have no trailing slash: `/page`
- Namespace index pages have a trailing slash: `/docs/`
- The root page is `/`

Conversions must go through `storage.CanonicalPath()` (Go) or `canonicalPagePath()` (JS). Never inline `/index` stripping — use the helper. See `specs/canonical_page_names.md` for the full specification.

**Page links** (resolve to rendered page):
- `/path/to/page` → `content/path/to/page.md`
- `/path/to/namespace/` → `content/path/to/namespace/index.md`
- `./page` → adjacent `page.md` relative to current page

**Attachment links** (resolve to raw file):
- `/path/to/file.ext` → `content/path/to/file.ext`
- Attachments **must have an extension** — extension-less files under content/ are forbidden
- `./page.md` is the raw attachment of `page.md`; `./page` is the rendered page

**Namespace constraint:** if `content/path/to/ns/` exists, `content/path/to/ns.md` must not exist.

Metadata file path derivation: replace `content/` with `meta/`, replace `.md` with `.json`.

## Plugin architecture

Plugins are TypeScript only. Each plugin owns its full vertical slice:
- ProseMirror node/mark schema extension
- Editor behavior (commands, keymaps, input rules)
- Markdown parser rules (dialect → PM)
- Markdown serializer rules (PM → dialect) — must be bijective
- HTML rendering rules
- Export/print CSS (optional)

Plugins are loaded as independent bundles at runtime. Disabling a plugin must never corrupt documents or break loading/editing/storage. It may cause loss of specialized semantics for nodes owned by that plugin.

Plugins do **not** own: authentication, access control, configuration, document identity, storage layout, search indexing, export mechanisms.

## Backend API (current)

```
GET  /api/health
GET  /api/pages/{path}          returns raw Markdown + page metadata
PUT  /api/pages/{path}          body: { "markdown": "..." }, atomic write, returns page payload
```

## Current implementation state

### Plugin and registry architecture
The plugin/core boundary is largely implemented. The canonical reference for how the registry works is `frontend/compiler/registry.ts`. The canonical reference for how a plugin is structured is `frontend/plugins/table.ts` — read this before writing or modifying any plugin.

Known smell: `frontend/compiler/core_nodes.ts` lines 114–129 contain a specific entry about the table plugin that may be a hardcoded reference leaking through the plugin boundary. This should be investigated and resolved as part of any work touching the plugin architecture.

### Visual editor — functional today
- Bold, italic
- Headings (ATX)
- Unordered and ordered lists, including nested sublists, with Tab/Shift-Tab to increase/decrease nesting
- Tables, with Tab to navigate between cells
- Images with drag-resize (Shift to constrain proportions), live-updating size property in both the node and the Markdown source
- Internal and external links (external links display a distinct icon and open in a new tab)
- Media manager: fully implemented frontend and backend, handles file upload and storage, inserts image nodes or download links. Currently limited to a flat file listing (no image thumbnails, no file-type icons in listing or rendering).
- Code blocks with Tab/Shift-Tab indent/deindent support and language specifier (syntax highlighting per language).
- Include nodes: implemented, renders as read-only zone in visual mode with property panel (yellow, consistent with other property panels). Include button in toolbar (visual and raw).
- Full-text search: incremental, typo-tolerant.
- Save/reload cycle is implemented and validated.
- Navigation between pages is implemented.
- New page creation is functional but minimal (creates a base .md, editing tested).

### Properties system
- Defined and working for: image nodes (size, drag-resize updates property live), table nodes (size property defined, drag-resize not yet implemented), include nodes (path property)
- Numbered headings use `1.` prefix syntax (`## 1. Title`), not a property directive

### Rendering model
Rendering is done entirely by ProseMirror. There is no separate rendering pipeline for view mode — the visual editor output and the rendered view are identical by construction. This is a deliberate architectural choice and should not be changed.

### Release status

**v1.0.0** is released (2026-11-14), after six release candidates. **v1.1.0-rc.2** (2026-11-14) adds serving several wikis from one process (`--sites`) and per-wiki favicons. See `CHANGELOG.md` for the full journey. Versioning and the RC rule for later releases are in `DEV.md`.

## Milestone targets

Shipped (short form — the full list is in `CHANGELOG.md`):

- **v0.1** ✓ — Single-page correctness: edit and persist page content, render sidebar/footer/included content, save/reload reliably.
- **v0.2** ✓ — Site-level consistency: reference tracking, orphan detection, circular include detection.
- **v0.3** ✓ — Full-text search (incremental, typo-tolerant), code-block syntax highlighting.
- **v0.4** ✓ — Editing robustness: copy/paste dialect enforcement, document validity after any edit, round-trip stability.
- **v0.5** ✓ — Page history, rollback, drafts, media versioning, competing edits (same user).
- **v0.6** ✓ — Admin UI, authentication backends (local + OAuth Azure), ACL, group management.
- **v0.7** ✓ — Structured data: database tables, `{database-row}` binding, `{database-query}` with filters and pivots, includes and templates.
- **v0.8** ✓ — Templates with variables, extended tables (formulas, column properties, cell merging, vertical text/align), tags with query and grouping, PDF export, sitemap, todos with assignment and email, numbered headings.
- **v0.9** ✓ — Reviewflow (author/reviewer/validator + X.509 signing + observers), comments, backlinks, move/rename with link updates, image drag-resize, captions, spoilers, charts, mermaid, slides, bibliography, footnotes, DokuWiki importer, coedition with presence badges, AI Content API + integrated AI assistant, MCP server (page + database + attachment + draft-session tools), theming (light/dark), template stamping with reviewflow pinning.

**v1.0.0-rc.1** — Release candidate. No new features versus v0.9x; the RC exists to stabilise the surface for a v1.0.0 tag. If the RC ages a week without a regression severe enough to reroll, tag v1.0.0 unchanged. Bug fixes accepted during the RC window; feature additions push the RC number (rc.2, …) rather than the base version.

## v0.2 detailed scope (reference)

### Reference tracking
The backend maintains a map of which pages reference which media files. This map is updated immediately on every write (not batch-based). It is the foundation for orphan detection.

### Orphan detection
When a media file becomes unreferenced (no page links to it), the backend detects it immediately. The frontend may prompt the user for deletion. Orphan handling is backend-driven. Media versioning is out of scope.

### Circular include detection
The backend detects and rejects circular includes at save time (not render time). If saving a page would create a direct or transitive include loop, the backend returns an error. The frontend displays the error to the user. No partial saves, no silent failures. The frontend does not attempt to detect or prevent cycles locally.

## Dialect implementation status (reference)

| Feature | Status |
|---|---|
| `*italic*`, `**bold**`, `` `code` `` | implemented |
| `~~strikethrough~~` | implemented |
| `_underline_` | implemented |
| `~subscript~`, `^superscript^` | implemented |
| `==highlight==`, `=={color=VALUE}highlight==` | implemented |
| `^[inline footnote]` | implemented (content supports inline markdown: links, bold, italic, code, strikethrough) |
| ATX headings | implemented |
| `- unordered list` | implemented |
| `1. ordered list` | implemented |
| Numbered headings (`## 1. Title`) | implemented |
| Pipe tables + directives | implemented |
| Multi-body tables | rejected |
| Properties/directives `{name key=value}` | implemented |
| Raw HTML forbidden | implemented |
| Single newline → hard break in paragraphs | implemented |
| `\n` literal → `<br>` (lists and tables only) | implemented |
| Code block language specifier + highlighting | implemented |
| `{version-link version=N page=/path}` | implemented |
| `{reviewflow-link version=X page=/path}` | implemented |
| `` @`code with {{VAR}} expansion` `` | implemented |
| Backticks protect table cells from directive/formula parsing | implemented |
| Deterministic round-trip | partial |
| HTML entities not interpreted | implemented |

## Do not

- Do not introduce alternative Markdown syntaxes — bijectivity is non-negotiable
- Do not store metadata under `data/content/`
- Do not create extension-less files under `data/content/`
- Do not create `content/path/to/ns.md` if `content/path/to/ns/` exists
- Do not make the backend depend on Node.js or the TS toolchain
- Do not encode editor semantics in the backend
- Do not let plugins touch authentication, ACL, storage layout, or search indexing
- Do not bundle core and plugins together — they must remain independently loadable
- Do not detect include cycles in the frontend — this is a backend responsibility
- Do not silently store invalid document states — enforce at the ProseMirror schema level
- Do not process cell content (directives, formulas, or any `{...}` / `=...` pattern) when the cell text is inside a `code` or `code_expand` mark — backticks protect cell content from all in-cell parsing. This is a critical invariant: every new cell-level feature must check `hasCodeMark` before processing.