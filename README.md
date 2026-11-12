# Sargon

Sargon (formerly Gowiki) is a modern wiki engine inspired by [DokuWiki](https://www.dokuwiki.org/), one of the best wikis in the world. It aims to preserve what DokuWiki got right — plain-text storage, versioning, extensibility — while replacing the pieces that could not evolve within the original codebase.

Current release: **v1.0.0-rc.6**. See [`CHANGELOG.md`](CHANGELOG.md) for the full history.

## The name and the logo

The project is named after **Sargon of Akkad** (reigned c. 2334–2279 BC), who united the Sumerian city-states into the first empire of Mesopotamia. Writing had been invented in Sumer a few centuries earlier, and under Sargon cuneiform and its scribes spread across the whole region. His daughter Enheduanna, high priestess of the moon god at Ur, is the first author in history known by name. A wiki is a corpus of written text held in common, and Sargon's court was one of the first places where such a corpus existed at that scale.

The logo is a **lamassu**, the winged guardian with a human head and the body of a bull or lion that stood at the gates of Assyrian palaces. It belongs to a later king: **Sargon II** of Assyria (reigned 722–705 BC), who took the name of his Akkadian predecessor — *Šarru-kīn*, "the legitimate king" — and lined the gates of his capital, Dur-Šarrukīn (Khorsabad), with lamassu. Several of them stand today in the Louvre. The name honours the first Sargon; the logo borrows from the second.

## What it borrows from DokuWiki

- **Plain text storage** — content is stored as human-readable Markdown files, not in a database. Backup and version-control the `data/` directory and you're done.
- **Version history** — every save produces an attic entry; diff and rollback are first-class.
- **Full-text search** — incremental, immediate, typo-tolerant (backed by Bleve).
- **Namespaces** — pages organise into namespaces mirrored on disk. Namespace indexes are just pages named `index.md` in that directory.
- **Extensibility** — plugins own vertical slices (schema, editor behaviour, parser/serializer, rendering). DokuWiki's Struct plugin was a particular inspiration for the `database` plugin.

## What it does differently

- **Bijective Markdown dialect** — one canonical syntax per element. Round-trips between raw text, ProseMirror, and rendered HTML are lossless by construction, which is what makes the dual-mode editor honest. The dialect intentionally diverges from CommonMark in a few places (`_underline_` rather than italic, `- item` only for lists, no raw HTML, single-newline hard breaks in paragraphs). See [`specs/`](specs/) for the specification.
- **ProseMirror-native editor** — visual and raw modes work on the same document. Every feature is available in both modes; there is no separate rendering pipeline for view mode.
- **Go backend** — chi-based REST API, cross-compiled to a single static binary. No PHP runtime, no dependency chain to maintain in production.
- **Clean frontend/backend split** — the backend is authoritative for storage, identity, ACL, indexing, search, and export. The frontend owns document semantics, editing UX, and rendering. HTTP REST is the only boundary.
- **AI Content API + MCP server** — a personal-token REST API and a Streamable-HTTP MCP endpoint let AI assistants (Claude, ChatGPT, …) read, edit, and publish content on behalf of the user they are authenticated as. ACLs apply to both the caller and the `@ai` subject. See [MCP tools](#mcp-tools) below.
- **Fewer but more powerful plugins** — `database`, `reviewflow`, `todo`, `comment`, `signing`, `bibliography`, `slide`, `chart`, `mermaid`, `tag`, `blockquote` (wraps + figures), `code_expand` (`@\`...\``), plus first-class table extensions (formulas, column rules, cell merging).

These changes — particularly the switch to Markdown and the ProseMirror-first architecture — are too fundamental to be contributed back to DokuWiki. Sargon is a separate project that stands on DokuWiki's shoulders.

## Features at a glance

**Editing.** Dual mode (raw Markdown + ProseMirror visual) sharing one document. Copy/paste enforces the dialect. Includes render as read-only zones in visual mode. Tables have Tab navigation, drag-resize on images (Shift to constrain), inline properties panels.

**Collaboration.** WebSocket presence with live badges. Co-edition via Yjs. Drafts with edit tokens, publish/discard cycle, auto-save. Stale-lock reclaim gated on presence — never cuts a live editor out of their own session.

**Structure and reuse.** Templates with variables. Namespaces. Includes (whole page or section). Backlinks. Tags with query + grouping. Sitemap.

**History and audit.** Attic per-page. Diff view (compact + side-by-side). Rollback / restore-from-history. Reviewflow with author / reviewer / validator roles and X.509 signing (per-user certificates issued from a company CA, revocation with cascade, observers, per-version audit trail). Todos plugin with assignments and email notifications.

**Structured data.** `{database-row}` binds a wiki page to a table row (bidirectional sync). `{database-query}` renders queries with filters, pivots, and typed fields (image, tag, user, lookup with nested filtering).

**Media.** Media manager (upload, insert, download-link icons). Versioning (edit-session competition handled cleanly).

**Export.** PDF via headless Chrome (with charts and mermaid diagrams rendered). Slides plugin. Bibliography (PubMed integration).

**Auth.** Local passwords + OAuth (Azure AD tested) with group syncing. Session cookies + personal API tokens (rate-limited). ACLs by user, group, and `@self` / `@ai` subjects. Admin UI for users, groups, ACLs, and configuration.

**Import.** DokuWiki importer: pages, users + ACLs, struct blocks → database tables, reviewflow validation migration, monoline tables, UTF-8 picker.

## Repository layout

```
frontend/       Vite + ProseMirror document/editor engine (TypeScript/ESM)
backend/        Go API server (chi), authoritative for all storage
scripts/        Local orchestration helpers
specs/          Markdown dialect specification and per-feature specs
data/
  content/      All user-managed files: .md pages and media attachments (same root)
  meta/         Metadata mirroring content/ structure, .json files only
```

## Development

Run backend and frontend together:

```sh
make dev
```

Or separately:

```sh
make dev-backend      # Go server on :8080 (API only)
make dev-frontend     # Vite dev server on :5173 (HMR, proxies /api/* to :8080)
```

Backend has no Node.js dependency. Frontend has no Go dependency. This is an invariant, not a convention.

## Production

Cross-compile the backend and build the frontend statically:

```sh
cd backend && GOOS=linux GOARCH=amd64 go build -o sargon-server ./cmd/server
cd frontend && npm install && npx vite build
```

Serve everything from the Go binary — it embeds the frontend `dist/` and serves it as static assets alongside the API:

```sh
./sargon-server --config /path/to/config.yaml
```

`config.yaml` covers data root, listening address (HTTP or HTTPS with automatic Let's Encrypt), auth backends, plugin toggles, AI provider keys, rate limits, and email/SMTP.

The reference production deployment is at `wiki.gmt.bio` (single binary on a Debian host behind systemd, TLS terminated by the binary).

For a first installation, follow [`docs/deploy.md`](docs/deploy.md). To upgrade an existing installation to a newer release, follow [`UPGRADE.md`](UPGRADE.md).

## HTTP API

Read the OpenAPI spec at `/api/openapi.json` on a running instance. High-level:

- **Pages** — `GET/PUT /api/pages/{path}`, `POST /api/edit/{path}` (draft lock), `PUT /api/draft/{path}` (save), `DELETE /api/draft/{path}` (discard), `POST /api/publish/{path}` (publish).
- **History** — `GET /api/history/{path}`, `GET /api/attic/{path}?version=N`, `POST /api/restore/{path}`.
- **Media** — `POST /api/media/{path}` (multipart), `GET /api/media/{path}` (download), `DELETE /api/media/{path}`.
- **Search** — `GET /api/search?q=…&limit=…`.
- **Move / rename** — `POST /api/move/{path}` (with link updates), plus convert-to-namespace-index and back.
- **Admin** — users, groups, ACLs, tokens, config; all under `/api/admin/`.
- **AI** — `/api/ai/*` uses personal API tokens (`gwk_...`), same ACL as the browser session.
- **MCP** — `/api/mcp/v1` speaks Streamable HTTP MCP; token-authenticated.
- **Collab** — `/api/ws/collab` for WebSocket presence + Yjs sync.

## MCP tools

Every write tool requires an `@ai` ACL grant on the target page in addition to the caller's own permission, and every write requires a summary of the form `[AI: <tool>] <description>` when the server enforces summaries.

- **Reading** — `read_pages_batch`, `search_pages`, `list_namespace` (optional `include_comments` adds an `open_comments` count per page), `get_page_meta`, `read_attachment`, `list_attachments`, `list_page_comments`, `render_page`, `export_page_pdf`, `list_page_history`, `read_page_version`, `diff_page_versions`, `preview_page_diff`, `list_recent_changes`.
- **Writing** — `write_page`, `edit_page`, `create_page_from_template`, `delete_page`, `move_page`, `convert_page_to_namespace_index`, `convert_page_to_regular_page`, `upload_attachment` (+ `upload_attachment_instructions`), `delete_attachment`.
- **Draft sessions** — `enter_edit_session`, `save_edit_draft`, `read_edit_draft`, `publish_edit_draft`, `discard_edit_draft`. Presence-gated: any live editor blocks the takeover regardless of identity, so an agent can pick up a stale lock but never interrupts an active human.
- **Databases** — `list_database_tables`, `create_database_table`, `update_database_table`, `create_database_field`, `update_database_field`, `delete_database_field`, `query_database_rows` (with pivots), `insert_database_row`, `update_database_row`, `delete_database_row`.
- **Reviewflow** — `get_reviewflow_status`.
- **Todos** — `list_todos`, `complete_todo`.
- **Conventions** — `get_conventions` returns the dialect rules; AI clients should load this once before writing.

## Running tests

Two suites, two invocations. The unit suites run without any external dependency; the integration suites need a live Postgres.

### Unit tests (no dependencies)

Backend:

```sh
cd backend && go test ./...
```

Frontend (Vitest, jsdom):

```sh
cd frontend && npm install && npx vitest run
```

Or from the repo root:

```sh
make test-backend
make test-frontend
```

### Integration tests (need Postgres)

Two backend packages ship integration tests behind the `integration` build tag: `internal/database` (schema + data-store + sync) and `internal/todo` (store + scheduler + acknowledgement). They read `DATABASE_URL` and create per-test databases so runs are isolated.

Start a local Postgres — the containerised default the tests look for is on port 5432, but any URL you point `DATABASE_URL` at works:

```sh
docker run --rm -d -p 55432:5432 \
  -e POSTGRES_USER=gowiki -e POSTGRES_PASSWORD=gowiki -e POSTGRES_DB=gowiki_test \
  postgres:16-alpine
```

Run the full integration suite:

```sh
DATABASE_URL="postgres://gowiki:gowiki@localhost:55432/gowiki_test?sslmode=disable" \
  make test-integration
```

Or one specific test:

```sh
cd backend
DATABASE_URL="postgres://gowiki:gowiki@localhost:55432/gowiki_test?sslmode=disable" \
  go test -tags=integration -count=1 -run TestTodoScheduler_CheckReminders_FiresInsideWindow ./internal/todo/...
```

Without a reachable Postgres, integration tests `t.Skipf` (they don't fail); unit tests are unaffected.

### CI

Every push runs `make test-backend`, `make test-frontend`, `make test-integration`, `golangci-lint`, ESLint and Prettier via GitHub Actions. A red CI blocks merges to `main`.

## License

Sargon is licensed under the **GNU General Public License v3.0** (GPL-3.0). In tribute to DokuWiki's open-source tradition, we chose the GPL family to ensure this project remains open.

## Acknowledgments

This software was designed and built with the help of AI agents: ChatGPT (OpenAI) for the initial architecture, design discussions and audit of security and trust aspects, and Claude (Anthropic) for implementation and coding. The author directed all design decisions and takes full responsibility for the result.

Many thanks to the DokuWiki team for creating the wiki that made this one possible.
