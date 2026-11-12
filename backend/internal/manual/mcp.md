# MCP (Model Context Protocol) Server

Sargon exposes its AI-oriented API as a full MCP server at `/api/mcp/v1`. An MCP client (Claude Desktop, Claude.ai, Cursor, any MCP-compatible agent) can connect to the wiki as a tool provider, giving the LLM structured access to your pages, todos, structured-data tables, and reviewflow state.

The MCP server is a thin wrapper around the existing AI Content API (`/api/ai/v1/…`). Everything it does is subject to the same ACL model: the authenticated user AND the `@ai` pseudo-subject must both have permission to view (or edit) a page for the operation to succeed.

## Connection

- **URL:** @`https://{{SERVER}}/api/mcp/v1`
- **Transport:** Streamable HTTP (MCP 2025-03-26 spec)
- **Auth:** OAuth 2.0 with browser-based login and consent (no token to copy-paste)

Discovery is handled by the client — the server publishes:

- `/.well-known/oauth-protected-resource` (RFC 9728)
- `/.well-known/oauth-authorization-server` (RFC 8414)
- Dynamic client registration at `/oauth/register` (RFC 7591)

On first use the client is redirected to a wiki login page, then to a consent screen, and finally receives an access token bound to your identity. Revoke it any time under **Admin → Tokens**. Only S256 PKCE is accepted.

### Claude Desktop

Claude Desktop's stable config schema does not yet accept remote HTTP MCP servers directly, so the path is to run Anthropic's `mcp-remote` proxy locally — it speaks stdio to Claude Desktop and forwards to the wiki over HTTP. Requires Node.js on the machine (any recent LTS).

The config file lives at:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Open it directly, or from Claude Desktop go to **Settings → Developer → Edit Config** (**Application bureau → Développeur → Modifier la config** in French).

![Claude Desktop → Developer → Modifier la config](./screenshots/42.png)

For this wiki the URL is @`https://{{SERVER}}/api/mcp/v1`.

Pick one of the two auth flows below, save the file, then **fully quit** Claude Desktop (Cmd-Q on macOS, right-click → Quit on Windows — closing the window is not enough) and relaunch.

**Option A — Bearer token (recommended):** deterministic, no browser step, tools appear immediately.

1. Create an API token: **Admin → Tokens → New token** on the wiki. Copy the `gwk_...` value shown once.
2. Add the entry with a hard-coded `Authorization` header:

   ```json
   {
     "mcpServers": {
       "sargon": {
         "command": "npx",
         "args": [
           "-y",
           "mcp-remote",
           "https://YOUR-WIKI-HOST/api/mcp/v1",
           "--header",
           "Authorization: Bearer gwk_YOUR_TOKEN"
         ]
       }
     }
   }
   ```

   The `--header` value must be a single string in `"Name: Value"` form. Keep the token secret — this file is plaintext on your machine.

**Option B — OAuth (browser consent flow):** no token in the config, but relies on `mcp-remote` opening a browser tab on first launch and completing an OAuth callback back to a local port. Prone to silent failure on Desktop (blocked popups, callback port collisions, sandbox restrictions).

```json
{
  "mcpServers": {
    "sargon": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://YOUR-WIKI-HOST/api/mcp/v1"]
    }
  }
}
```

![Editing claude_desktop_config.json with the mcp-remote proxy entry](./screenshots/43.png)

On the first tool call a browser tab opens on the wiki asking you to sign in and approve. Once approved the tab closes and `mcp-remote` caches the token in `~/.mcp-auth/` for future runs. If nothing happens on the first call — no browser tab, no tools appearing — switch to Option A. Logs are at `~/Library/Logs/Claude/mcp*.log` (macOS) or `%APPDATA%\Claude\logs\` (Windows).

### Claude.ai (web, Pro / Team / Enterprise)

Claude.ai's web app supports remote MCP servers natively — no local proxy, no token to copy. The OAuth handshake described above happens in the browser and the tools appear directly in the workspace, scoped to your wiki identity.

1. In claude.ai, open **Settings** → **Connectors** (labelled **Integrations** in some workspaces). Click **Add custom connector**.
2. Paste `https://YOUR-WIKI-HOST/api/mcp/v1`. For this wiki that's @`https://{{SERVER}}/api/mcp/v1`. Confirm.
3. A wiki page opens asking you to sign in (if you're not already) and approve access. Approve.
4. Return to Claude — `sargon` tools are now available in every conversation.

**Per-user vs org-wide.** On a Team or Enterprise plan an admin can add the connector once at the workspace level so every member inherits it, or each user can add it individually — both work. Either way, each user's session gets **their own** OAuth token bound to their own wiki identity, so page-level ACLs still apply per user (the `@ai` pseudo-subject gates it further).

**Revocation.** OAuth-issued tokens appear under **Admin → Tokens** on the wiki alongside static bearer tokens. Revoke any one to cut off the corresponding Claude.ai session; the next tool call will re-prompt for consent.

### Claude Code (CLI)

Claude Code supports remote HTTP MCP servers natively. Two paths:

**With a bearer token (simplest, no browser step):**

1. Create an API token: **Admin → Tokens → New token** on the wiki. Copy the `gwk_...` value shown once.
2. Register the connector — pick a scope:

   ```bash
   claude mcp add sargon --transport http https://YOUR-WIKI-HOST/api/mcp/v1 \
     --header "Authorization: Bearer gwk_YOUR_TOKEN" -s local
   ```

   For this wiki the URL is @`https://{{SERVER}}/api/mcp/v1`.

   Scope choices (`-s` flag):

   - `local` (default) — this project only, private to you (stored in `.claude/settings.local.json`)
   - `user` — every project on this machine, private to you
   - `project` — this project, shared with teammates (stored in `.mcp.json`, commit to git)

3. Verify with `claude mcp list` or `claude mcp get sargon`. In a fresh `claude` session the `mcp__gowiki__*` tools appear directly.

**With OAuth (browser consent flow):**

Omit the `--header` flag and Claude Code will fall back to OAuth on first use — it prints an authorization URL you open in a browser, log in on the wiki, click Approve, and Claude Code receives the token via a `http://localhost:PORT/callback` handoff. Same experience as Claude.ai's UI, just driven from the CLI.

**Troubleshooting — connector stuck on auth stubs:**

If `mcp__gowiki__authenticate` shows up instead of the real tool list, Claude Code has cached a failed handshake. In the running session type `/mcp` to open the MCP panel and pick **Reconnect** on `sargon` — it clears the state and re-does the handshake with the current stored auth. Faster than restarting the whole CLI. Only fall back to `claude mcp remove sargon && claude mcp add ...` when `/mcp` reconnect doesn't recover.

### mcp-inspector or any raw MCP client

If your client cannot do OAuth (older mcp-inspector, custom scripts, CI), fall back to a personal API token. Create one under **Admin → Tokens** and pass it in the Authorization header. For this wiki the URL is @`https://{{SERVER}}/api/mcp/v1`:

```
npx @modelcontextprotocol/inspector \
  --transport streamable-http \
  --url https://YOUR-WIKI-HOST/api/mcp/v1 \
  --header "Authorization=Bearer gwk_..."
```

## Tools

| Tool | Purpose |
|---|---|
| `get_conventions` | Markdown dialect rules and content guidelines. **Call first.** |
| `list_namespace` | Enumerate pages and sub-namespaces under a path |
| `read_pages_batch` | Read up to 20 pages in one call |
| `get_page_meta` | Page title, version, tags, backlinks, reviewflow status |
| `search_pages` | Three modes: `query` for fuzzy full-text, `pattern` for grep-style RE2 regex (literal / structured matches, line + column), `tag` for tag listing. Composable: `tag` can scope `query` or `pattern`. |
| `get_reviewflow_status` | Reviewflow roles, confirmations, validation state — single page |
| `list_reviewflows` | Batch reviewflow status across every page under a `path_prefix`. One MCP call for a whole namespace — use this instead of a loop of `get_reviewflow_status` for corpus-wide compliance passes. |
| `list_broken_links` | Scan every page under a `path_prefix` and return unresolved internal references as `{page, href, resolved, fragment, label, line, reason}` rows. One call for a whole subtree; cheaper than rendering each page to HTML and scraping `gowiki-link-missing`. Fragment anchors are not checked by default; pass `check_fragments=true` to also report `#heading` references whose target page exists but whose anchor doesn't match any heading. |
| `preview_page_diff` | Dry-run edit — returns diff without saving |
| `write_page` | Create/update a page (full rewrite) — requires a summary; refuses fully-validated pages unless `force=true` (see the fully-validated-page guard below) |
| `edit_page` | Anchored search-and-replace edits — safer than `write_page` for any change smaller than a full rewrite (uniqueness constraint prevents accidental corruption); same fully-validated-page guard as `write_page` |
| `create_page_from_template` | Create a new page from a `{template}`-marked template. Resolves `{template-title}`/`{template-stamp}`/`{template-reviewflow}`/`{template-todo}`; refuses when the template's reviewflow has open roles or when the destination exists. |
| `render_page` | Return the FULLY rendered page as a browser sees it — every dynamic directive resolved. `format=text` (default, structured extraction) or `format=html`. Use when the answer depends on resolved data (databases, tag queries, template stamps) rather than raw source. Heavy call; not for bulk scans. |
| `export_page_pdf` | Export a page to PDF — the same document as the **Export PDF** button (A4, running header, page numbers, charts and diagrams rendered), opened as the calling user so ACLs apply. Returns a JSON summary (`filename`, `size`, `sha256`, `page_version`) and the PDF as an embedded `application/pdf` resource. Heavy call; PDFs over 20 MB are refused. |
| `list_todos` | Todo tasks, filterable by status/assignee/namespace/due |
| `complete_todo` | Mark a todo as done |
| `list_database_tables` | Structured-data tables with field definitions |
| `query_database_rows` | Query rows from a structured-data table (accepts `filter=[…]`; use `@null` for IS NULL tests). Pass `pivot_rows`/`pivot_cols`/`pivot_cell` for a cross-tabulation instead of a flat row list. |
| `insert_database_row` | Insert a row (page-bound tables also get their wiki page created) |
| `update_database_row` | Patch fields on a row (page-bound rows also have their `{database-row}` block rewritten; refuses on an active draft lock unless `force=true`) |
| `delete_database_row` | Delete a row (page-bound rows also have their page removed; refuses when other rows still reference this one — pass `force=true` to override; page history stays in the attic) |
| `delete_page` | Delete a page (archived to attic; row-bound pages also drop their DB row) |
| `create_database_table` | Create a new structured-data table (admin only) |
| `create_database_field` | Add a field to an existing table (admin only) |
| `update_database_table` | Update a table's metadata — label, page_folder, sort defaults, template (admin only, non-destructive) |
| `update_database_field` | Update a field's metadata; on an empty table also rename (`new_name`) or retype (`new_type`) — admin only |
| `delete_database_field` | Hard-delete a field (drops the SQL column); refused when the table has active rows — admin only |
| `move_page` | Rename a page to a new path (updates incoming links; supports `dry_run`) |
| `convert_page_to_namespace_index` | Turn a leaf page (`foo`) into a namespace index (`foo/`) — unblocks writes under it |
| `convert_page_to_regular_page` | Turn an empty namespace index (`foo/`) back into a leaf page (`foo`) |
| `list_page_history` | Every archived version of a page (version, timestamp, author, summary, md5) |
| `read_page_version` | Markdown of a specific historical version, with its metadata |
| `list_recent_changes` | Cross-page changelog, filterable by `since`/`until`/`author`/`path_prefix` — every entry ACL-checked |
| `diff_page_versions` | Line-level diff between two archived versions of the same page (same hunk shape as `preview_page_diff`) |
| `list_attachments` | Files (with extension) directly under a namespace, with size, current version, and referring pages |
| `list_page_comments` | Comment threads on a page — unresolved by default, `include_resolved=true` to also return the archive. Each thread carries its selected-text anchor plus grouped replies. Complements the `open_comments` count that `list_namespace` can emit. |
| `read_attachment` | Attachment metadata (mime, size, sha256, version, referring pages); optionally inline body (text ≤128 KB / base64 ≤512 KB) or `out_dir` to save to disk |
| `upload_attachment` | Create or replace an attachment via base64 (small files only); optional sha256/size_bytes verification catches transport corruption |
| `upload_attachment_instructions` | Return a ready-to-run `curl -F` command for the wiki's HTTP multipart endpoint — use this for anything bigger than a few KB |
| `delete_attachment` | Delete an attachment; refuses when pages still reference it unless `force=true` |
| `enter_edit_session` | Take part in a collaborative edit — acquire (or resume) the lock and get the draft markdown + edit_token. `force=true` reclaims the caller's OWN earlier session (never steals another user's) |
| `save_edit_draft` | Checkpoint work-in-progress on a draft you own (needs the edit_token). Non-publishing |
| `read_edit_draft` | Peek at the current draft for a page regardless of owner — the same view collaborative editors see. Requires view permission |
| `publish_edit_draft` | Publish the draft: full server-side pipeline (inline-row-edit guard, validation, page store, todo auto-complete). Requires the edit_token from `enter_edit_session` |
| `discard_edit_draft` | Throw away the caller's own draft and clear the lock |

## Searching — three modes

`search_pages` carries three mutually-informative modes. At least one of `query`, `pattern`, or `tag` must be set.

- **`query` — fuzzy full-text.** Typo-tolerant FTS over page bodies. Returns ranked snippets. Right choice for the vague-recall case ("the page about reviewflow validation").
- **`pattern` — grep-style regex.** The RE2 regex is scanned against every page's raw markdown. One row per occurrence: `{path, line, column, match, line_text}`. Agent-oriented: literal strings and structured directives match exactly, no ranking, no stemming. The right choice when you need to **find every page using `{template-stamp}`**, locate every `TODO(` marker, or confirm no page still carries a deprecated syntax. Options: `path_prefix` to scope the scan, `case_sensitive` (default true), `max_per_page` to cap per-page occurrences. Response envelope carries `scan_complete` (true iff every eligible page was walked), `eligible_pages` (universe size), and `total_matches` so a caller can detect at a glance when the result is partial — `scan_complete=false` means `limit` was hit mid-scan and additional matches exist beyond the ones returned. Pass **`count_only=true`** for a cheap end-to-end tally: scans every eligible page regardless of `limit`, returns one `{path, count}` row per matching page, no bodies — the right call when the question is "how many pages / how many hits" rather than "show me the hits".
- **`tag` — tag listing.** Every page bearing that tag. Composable: `tag` + `query` narrows by path/title substring; `tag` + `pattern` scopes the regex scan to tagged pages (useful for "find every TODO on `tag:sop` pages").

`query` and `pattern` are mutually exclusive — pick fuzzy or exact; `tag` composes with either.

All results are filtered by the caller's ACL.

Examples:

```json
{ "query": "reviewflow validation" }
{ "pattern": "\\{template-stamp(?:\\s[^{}]*)?\\}" }
{ "pattern": "TODO\\(", "path_prefix": "/regulatory/qms", "case_sensitive": false }
{ "pattern": "DEPRECATED", "count_only": true, "path_prefix": "/regulatory/qms" }
{ "tag": "sop" }
{ "tag": "sop", "query": "biomscope" }
{ "tag": "sop", "pattern": "DEPRECATED" }
```

`query` + `tag` is the same syntax the wiki search bar exposes as `tag:NAME [substring]`. See [Tags](/wiki/manual/tags) and [Search](/wiki/manual/search) for the user-facing equivalent. `pattern` is MCP-only — the user search bar stays fuzzy.

## Editing pages — prefer `edit_page` over `write_page`

`write_page` replaces the entire markdown of a page. Cost aside, that means **every edit's risk is proportional to page size, not to the change** — retyping 300 lines to fix one word gives you 300 lines of opportunity to introduce truncations, forbidden HTML entities, or shifted heading levels. On a regulatory document, that turns a cosmetic tweak into a corruption vector.

**`edit_page(path, edits[], summary, expected_version?, dry_run?)`** is the safer default for anything short of a full rewrite. Each edit is `{old, new, replace_all?}`, and the tool enforces one strict rule:

- **`old` must occur exactly once in the current buffer.**
  - Zero occurrences → refused (the anchor is wrong, or the change is already applied).
  - Two or more without `replace_all: true` → refused (ambiguous).
  - With `replace_all: true` → every occurrence is replaced.

This uniqueness constraint is what makes the tool safe without line numbers: the anchor self-locates and self-validates. There's no line-number drift the way a unified diff would give you.

**Atomicity.** Edits apply in array order — edit *n+1* sees the buffer produced by edit *n*, letting you chain rewrites. If any single edit fails validation, the whole call is refused and no version is written. Never partial.

**Same gates as `write_page`.** Caller + `@ai` need `edit` permission. Optimistic locking via `expected_version` is honored. Draft locks by other users refuse the call. Summary follows the `[AI: <tool>] <description>` convention.

**Fully-validated-page guard.** Both `edit_page` and `write_page` refuse when the target page is currently fully validated by reviewflow — i.e. every role's signature is on the current version — because the write would invalidate every signature at once. This is the "an innocuous overnight cleanup pass silently broke 37 signatures on the QMS" case; the guard exists precisely to prevent it. Pass `force=true` on the call when the change is deliberate and the reviewers are ready to re-sign. The refusal names the signed roles so the agent can surface the cost to the human before retrying. `dry_run: true` on `edit_page` skips the guard (no state change, so nothing to protect).

**Preview.** Pass `dry_run: true` to get the resulting diff (added/removed lines + hunks, same shape as `preview_page_diff`) without writing.

Typical uses where `edit_page` is right:
- Fix a typo, a link, a broken directive — one edit with a unique anchor.
- Rename a field across many mentions on one page — one edit with `replace_all: true`.
- Migrate `@@table.field@@` placeholders to `{{field}}` in template pages — one edit per placeholder, each anchored on the unique occurrence.

Use `write_page` only when you truly do want to replace the whole page (creating from scratch, wholesale reorganizations).

## Draft sessions — joining an edit in flight

`write_page` and `edit_page` publish immediately. Sometimes that's the wrong shape: the user is co-editing the page in a browser tab and wants the agent to contribute inside the same draft, or wants to review the agent's work-in-progress before it goes live. The draft-session tools mirror the collaborative-edit flow the frontend uses:

1. **`enter_edit_session(path, force?, initial_markdown?)`** — acquire or resume the edit lock. Returns `{edit_token, markdown, page_version}` (plus `locked_by` on refusal). The markdown is the current draft file — or the published page if no draft exists yet. `initial_markdown` seeds a brand-new page only; it is ignored when a draft or published version exists.
   - **`force=true` supersedes the caller's OWN earlier session** (a second tab, or a session left open). It NEVER overrides another user's lock — that's admin territory and is refused with `error: "page_locked"`, `locked_by: <username>`.
   - Requires edit permission for the caller AND the `@ai` subject on this page.

2. **`save_edit_draft(path, edit_token, markdown, summary?)`** — checkpoint work-in-progress. Non-publishing. The edit_token must match the current lock; if another tab has reclaimed the session, the save returns `error: "edit_superseded"` and the agent should re-enter.

3. **`read_edit_draft(path)`** — peek at the current draft for a page regardless of who owns it. This is the same view collaborative editors see. Requires view permission. Returns `{markdown, owner, since, is_own_draft}`, or `{error: "no_draft"}` when nothing exists (with a `lock` field if a bare lock is present without a draft file).

4. **`publish_edit_draft(path, edit_token, summary?, force_publish?)`** — run the full server-side publish pipeline: inline-row-edit conflict guard, flow-marker strip, database validation, page store write (which handles archiving + indexes), auto-complete of "edit" wiki-action todos. Clears the lock and draft on success. Returns `{path, version, edit_token_cleared: true}`.
   - **`force_publish=true` is a targeted override** for the `error: "database_row_conflict"` case (a row bound to this page was edited inline while the draft was open). Confirm the choice with the user; otherwise re-enter the session to pick up the inline change.
   - `error: "validation"` means the draft failed database system-column validation — fix the markdown, save again, retry.
   - `error: "edit_superseded"` / `"no_draft"` mean the session was reclaimed or never existed.

5. **`discard_edit_draft(path, edit_token?)`** — throw away the caller's own draft and clear the lock. The token is optional; when omitted, the call is refused if a token-bearing session still exists (belt-and-braces against accidentally discarding another tab's work).

Typical agent workflow:

```
1. get_page_meta(path) → confirm no other user holds a lock
2. enter_edit_session(path) → { edit_token, markdown, page_version }
3. (apply edits to markdown in memory)
4. save_edit_draft(path, edit_token, new_markdown, "[AI: Claude] draft translation")
5. show diff to the user (preview_page_diff, or human review of the draft)
6. publish_edit_draft(path, edit_token, "[AI: Claude] publish translation")
```

Or, to help a human editor mid-session:

```
1. read_edit_draft(path) → { markdown, owner, is_own_draft: false }
2. (agent proposes edits inline in chat, or the human asks for a rewrite)
3. Human editor pastes the agent's version into their own session and saves.
```

Or, when the human has walked away from an open tab and the agent needs to finish:

```
1. read_edit_draft(path) → { owner: "raynald", is_own_draft: false }
2. enter_edit_session(path)  # refused: page_locked
3. (Ask the human to close their tab, or admin unlocks first.)
```

The tools never break the "one active edit per page" invariant: taking part in an edit is a coordinated hand-off, not a race.

## Template stamps

Templates that carry a `{template}` directive expose a dedicated creation path — `create_page_from_template` — that resolves origin metadata into the created document instead of leaving the author to write it out by hand. The version that gets stamped is **frozen at creation** (the `?v=N` link points at the template's page-version at that moment); a document from 2024 does not later claim today's form.

- **`create_page_from_template(template_path, path, title, reviewflow?, summary)`** — reads the template, splits the payload from below `{template}`, resolves the three payload directives, and writes the result to `path`.
  - `{template-title}` → the H1 heading below it is rewritten to `title`.
  - `{template-stamp}` → `Created from template [<title>](<template_path>?v=<N>), version <tag>`. When the template has no reviewflow, the sentence reads `revision <N>` instead — the wording deliberately differs, because a wiki revision number and a reviewflow version tag name different things.
  - `{template-reviewflow …}` → `{reviewflow …}` with defaults filled in: version defaults to `1.0`; unspecified actors inherit from the template's own `{reviewflow}`. `reviewflow` arg to this tool overrides those defaults.
  - `{template-todo …}` → `{todo …}` with the same args carried verbatim. Several `{template-todo}` lines coexist on one template and become the same number of live `{todo}` directives on the created document, in the same order. The template itself never fires the task — the trap that motivated this directive was the "escape the `{todo}` on the template, un-escape after every copy" workaround, which nobody remembered.
- **Refusal rules:**
  - The source is not a template (no `{template}` marker) — `kind: "not_template"`.
  - The template's reviewflow has open roles — `kind: "not_validated"`, with the missing role names in the message. Issuing a document from an unvalidated form contradicts the whole point of the stamp.
  - The destination `path` already exists — `kind: "destination_exists"`.

The response returns the created page's path + version AND the frozen template version, so callers can record what was issued without re-reading the page.

Row-bound templates (`page_template_path` on a database table) get `{template-stamp}` resolved at row-insert time via the same rule; `{template-title}` and `{template-reviewflow}` are ignored in that path because the row supplies the title and page-bound rows carry no reviewflow of their own.

## Renaming and namespace conversion

Three tools cover the page-move plumbing that `write_page` alone can't handle:

- **`move_page(from_path, to_path, update_links?, move_media?, dry_run?)`** — rename a page. `update_links` defaults true (rewrites every incoming link across the wiki); `move_media` defaults false (shared media stays put); `dry_run` returns the preview (affected pages, media that would move) without writing. Requires edit permission on both source and destination folder, for the caller AND `@ai`.
- **`convert_page_to_namespace_index(page_path)`** — turns a leaf page (`foo`) into a namespace index (`foo/index.md`). Use this when `write_page` refuses with a namespace-conflict error because the parent path already exists as a leaf. Typical case: creating `/regulatory/qms/qara/sop14/rec01` fails because `sop14.md` exists; convert first, then write.
- **`convert_page_to_regular_page(page_path)`** — the inverse. Refuses if the namespace still has children.

All three refuse cleanly when the page has an active edit lock or draft (`ErrPageHasLock` surfaces as `page has an active edit lock or draft: …`), when the destination already exists, or when a namespace/leaf naming collision would violate the "one canonical path per page" invariant.

## Row inserts, updates and deletes

`insert_database_row(table, fields)`, `update_database_row(table, row_id, fields, force?)` and `delete_database_row(table, row_id)` mirror the row-write side of the HTTP API but with two important guarantees on top:

- **Symmetric page handling.** When the table has a `page_folder`, insert creates the associated wiki page (respecting the table's `page_template_path` if any); update rewrites the page's `{database-row}` block so the two representations stay in step; delete removes it. The HTTP delete alone leaves an orphan page — the MCP tool doesn't.
- **Audit-safe deletion.** The page is removed from the live content but its history stays in the attic and `list_recent_changes` shows both the creation and the deletion as page changelog entries (`change_type: "edit"` at write, `"delete"` at removal). Test rows in a regulatory register can be cleaned up without erasing the trail an auditor might inspect.

**Update is a partial patch** — only the fields you list change; every other column stays as it was. To clear a value, pass an explicit empty string / null / `[]` as the new value.

**Draft-lock guard on update.** When a page-bound row's page has an active edit lock or an unpublished draft, `update_database_row` refuses with `page_draft_conflict` (naming the draft owner). Wait for the draft to be published or discarded, or pass `force=true` to override — the row is updated and the `{database-row}` block is rewritten in-place, which may collide with the open draft; prefer waiting when you can.

**ACL:**
- Page-bound tables — the caller AND `@ai` need edit permission on the `page_folder` namespace (insert) or on the specific bound page (update, delete).
- Non-page-bound tables — the caller must be in the `admin` group. This is deliberately strict: agent-driven row writes to schema-only tables can't be gated per-row via the page ACL, so admin is the only safe default.

Typical clean-up flow for a test round-trip: `insert_database_row` → verify the created page — `read_pages_batch` on the returned `page_path` — → `delete_database_row(row.id)`.

## Pivot queries — cross-tabulation on `{database-query}`

Some registers are naturally read as a matrix: one axis is a released version, the other a software component, and the cell is the version of that component embedded in that release. Storing that as a wide table means schema changes every time a dependency appears; storing it normalized ("one row per (release, component)") means the register is unreadable as a list of ninety rows. Pivot mode makes the normalized shape render as the matrix.

**Syntax** — pass any `pivot_*` parameter and the directive (or the `query_database_rows` MCP tool) switches from a flat row list to a cross-tabulation:

```markdown
{database-query table=release_component pivot_rows=release pivot_cols=component
                pivot_cell=version filter="component.kind=SOUP" sort=release order=desc}
```

| Parameter | Required | Description |
|---|---|---|
| `pivot_rows` | yes | Field whose distinct values become rows |
| `pivot_cols` | yes | Field whose distinct values become columns |
| `pivot_cell` | yes | Field rendered inside each cell (ignored for `pivot_agg=count`) |
| `pivot_agg` | no | Collision policy: `single` (default; flags collisions), `list`, `count`, `first`, `last` |
| `pivot_empty` | no | Text for a cell with no matching row. Default empty |
| `pivot_cols_sort` | no | Field of the column axis's target table used to order columns |
| `pivot_cols_max` | no | Refusal threshold on distinct column count. Default 40 |
| `pivot_rows_labels` | no | JSON map of raw row value → display label. Distinct raw values sharing a label MERGE into one row. Use `"@null"` as the key for the empty-value bucket |
| `pivot_cols_labels` | no | Same for the column axis |

`sort` / `order` apply to the **row axis**. `fields` and `limit` are ignored — the column set comes from the data.

**Empty values are preserved.** Rows whose row-axis or column-axis value is empty (SQL NULL or empty string) land in the `@null` bucket instead of being silently dropped. Its default column/row label is `(empty)`. Use `pivot_cols_labels: {"@null":"Active"}` to give it a meaningful name — or to merge it with other buckets (`{"N":"Active","@null":"Active"}` collapses the two into one column).

**Loud failure by design.** An unknown field in `pivot_rows`, `pivot_cols`, or `pivot_cell` refuses with a `400` and a `PivotError` naming the missing field. Cell collisions under `pivot_agg=single` render both values with a warning tint rather than silently picking one. Beyond `pivot_cols_max` distinct columns the pivot refuses instead of truncating — a silently-truncated matrix would read as complete. The column-count check uses the MERGED count when a `pivot_cols_labels` map collapses synonyms, so a mapping can bring an otherwise-too-wide pivot back under the ceiling.

**Links follow the existing convention.** Axis labels that resolve to page-bound rows render as links; cells whose value resolves to a page-bound row do too. Same as `%field%` in normal mode. When a label mapping merges several page-bound rows into one axis entry, the link is dropped (ambiguous target).

**Out of scope:** aggregations beyond `pivot_agg`; more than two axes; editing from the pivot view. The pivot is a view — storage stays normalized, and CSV export stays row-oriented.

## Attachments

Attachments are non-`.md` files under `data/content/`, referenced from pages via `./file.ext` (same namespace) or absolute `/path/to/file.ext` links. The four tools cover the full lifecycle:

- **`list_attachments(path)`** — files (with extension) directly under a namespace. Returns each file's size, current version, MIME, and the pages that currently link to it (`referring_pages` + `referring_count`; `0` means orphaned). Does not recurse — call it per namespace.
- **`read_attachment(path, include_content?, out_dir?)`** — metadata (size, MIME, sha256, current version, referring pages) is always returned. Three body-delivery modes:
  - `include_content: true` — inline: UTF-8 text for text-like extensions up to 128 KB (`format: "text"`), base64 for anything else up to 512 KB (`format: "base64"`). Over the cap returns `content_omitted: true`.
  - `out_dir: "/abs/path"` — the server writes the file to disk at `<out_dir>/<name>` and returns `saved_to`. **Preferred for binaries** — no inflation, no JSON string mutation. Combine with the returned `sha256` to verify locally.
  - Neither — metadata only.
- **`upload_attachment(path, content_base64, summary, overwrite?, sha256?, size_bytes?)`** — MCP-native upload for small files. The body travels as base64 through JSON-RPC, which is **not reliable** for binaries past a handful of KB — a dropped multiple-of-4 run of characters stays syntactically valid and decodes to a shorter file without any error. Optional integrity gates catch this: pass `sha256` (hex, decoded-bytes digest) and/or `size_bytes` and the write is refused on mismatch. The response always returns `sha256` and `size`, so a caller can verify. Refuses if the file exists unless `overwrite: true`; hard cap 20 MB after decode.
- **`upload_attachment_instructions(path, overwrite?)`** — **the right path for anything bigger than a few KB.** Doesn't upload itself: it validates the target, checks edit permission upfront, warns if a file already exists or if `overwrite` mismatches, and hands back a ready-to-run `curl -F "file=@..." <site>/api/media/<ns>` command. The wiki's multipart endpoint is real binary transport (no base64), uses the same bearer-token auth as MCP, and has no size ceiling below the 20 MB backend cap. Runs from the agent's own shell — no bytes touch the JSON channel.
- **`delete_attachment(path, force?)`** — deletes an attachment. By default a call is refused when any page still references the file; the response lists the referring pages so the caller can rewrite them first. Pass `force: true` to delete anyway — the file goes; links pointing at it will 404 until they're rewritten or restored.

**ACL:** attachment reads use view permission on the target path (or namespace, for `list_attachments`); uploads use edit; deletions use delete. Both the caller and the `@ai` subject must have the required permission — same dual-gate as page tools.

**Version model.** Attachments are versioned exactly like pages: v1 on first upload, incremented on overwrite, previous bytes preserved in the media attic. The frontend serves the current file for `/path/to/file.ext`, and older versions via `?v=N` — unchanged by the MCP layer.

## Broken-link scan

`render_page` with `format=html` marks each unresolved reference with the `gowiki-link-missing` CSS class — exploitable page by page, but a 200-page corpus scan that way is 20 MB of HTML round-tripped for information the engine already has at render time. `list_broken_links(path_prefix, limit?, check_fragments?)` returns the same answer directly, in one call.

- **One row per dead-link OCCURRENCE** — `{page, href, resolved, fragment, label, line, reason}`. No dedup within a page: the same href appearing twice reports twice, so the "which spot do I fix?" question has one answer per row. `href` is the raw link as written in the markdown; `resolved` is the absolute page path that was looked up; `label` is the visible link text; `line` is the 1-based source line of the hit.
- **`reason`** distinguishes the two failure modes:
  - `missing_page` — the target page itself doesn't exist (default behaviour, always on).
  - `missing_fragment` — the target page exists but the `#anchor` after the href doesn't match any of its heading slugs. Only emitted when `check_fragments=true`. `fragment` carries the unresolved anchor so a human knows exactly which section they meant to link.
- **Envelope counters** — `scanned` (pages actually opened), `pages_with_broken` (distinct pages with ≥ 1 broken row, so "how many SOPs need fixing?" is a single number), `skipped_access` (pages hidden by ACL — the dual-ACL model is respected), `truncated_at_limit` (set when the row cap was hit; narrow the prefix or raise `limit` up to the 5000 hard cap and re-run).
- **Default `limit` is 500.** Once the cap is hit, remaining pages are not even opened — the scan is cheap even on a wiki with 10 000 pages where a few handfuls are enough to fix.

**Fragment check cost.** Each unique target page with fragment references is opened once per scan (memoised); the heading-slug set is extracted via `ExtractHeadingSlugs` which agrees byte-for-byte with the frontend's slug rule (same lowercase / non-alnum-to-hyphen / `-N` suffixing on duplicates). On a QMS-sized corpus the extra pass adds a handful of `Store.Get` calls over the pre-check cost — well under a second.

**Typical invocations:**

```json
{
  "tool": "list_broken_links",
  "arguments": { "path_prefix": "/regulatory/qms", "limit": 500 }
}
```

With fragment checks on:

```json
{
  "tool": "list_broken_links",
  "arguments": {
    "path_prefix": "/regulatory/qms",
    "check_fragments": true,
    "limit": 500
  }
}
```

A sample row from a real QMS scan, each failure mode:

```json
{
  "page": "/regulatory/qms/soft/sop01",
  "href": "./tpl14",
  "resolved": "/regulatory/qms/soft/sop01/tpl14",
  "label": "SOFT/SOP01/TPL14 : Review checklist",
  "line": 128,
  "reason": "missing_page"
}
```

```json
{
  "page": "/regulatory/qms/soft/sop01",
  "href": "/regulatory/qms/soft/sop01/tpl02#risk-matrix",
  "resolved": "/regulatory/qms/soft/sop01/tpl02",
  "fragment": "risk-matrix",
  "label": "the risk matrix section",
  "line": 42,
  "reason": "missing_fragment"
}
```

Use alongside the other two batched compliance scanners: `list_reviewflows` for signature state, `list_page_comments` for open discussions, and `list_broken_links` for integrity of internal cross-references. Together they answer the three questions an auditor opens with: *is it signed, is it discussed, does it still point at what it says it points at?*

## Comments

Comments are sidebar annotations authors leave on a specific text selection in a page, without touching the page content. They live in a per-page JSON sidecar under `data/meta/`; the wiki manual has the full workflow at [Comments](./comments).

- **`list_page_comments(page_path, include_resolved?)`** — every top-level thread on a page, with its replies grouped underneath. Each thread carries the anchor's selected text (`anchor`), the author, the body, timestamps, its `resolved` flag, and a nested `replies` array. The response also reports `open_threads` and `total_threads` so an agent can pick a next action from one call. Defaults to unresolved-only; pass `include_resolved: true` to also get the archive (still counted the same). Requires view permission on the page.
- **`list_namespace(path, include_comments?)`** — set `include_comments: true` to add an `open_comments` field to every page in the result, straight from `CountOpenThreads`. Cheap: the store no-ops for pages that never had a comment sidecar. Combine with `depth: 0` to sweep a whole namespace for pages that still carry unresolved reader feedback.

The lifecycle plugin's `{lifecycle when=comments_open}` rule surfaces the same count on-wiki, so agents and readers see one source of truth. Use `list_page_comments` when you want to read what's actually being asked; use `list_namespace(include_comments: true)` when you want a quick scan of where the open conversations sit.

## Diagrams and charts (mermaid / chart)

Before generating a diagram or chart as an image and uploading it as an attachment, check whether the wiki can render it natively — both surfaces read as first-class content, edit in place, and don't need a media file:

- **Mermaid** — fence with `` ```mermaid `` (optionally `size=500px caption="…"`) and put Mermaid 11 source in the body. Covers flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, journey, timeline, mindmap, quadrantChart, gitGraph. Renders live in the visual editor.
- **Chart** — fence with `` ```chart <type> [WxH] ["title"] [nolegend|legend] [values] [left|right] [#RRGGBB …] ``. Types: `pie`, `doughnut`, `bar`, `hbar`, `line`, `radar`, `polar`. Body is `label = value` lines, `#` for comments. Defaults: 400x250, legend on. Rendered via Chart.js.

When to fall back to an image: complex multi-panel figures, precise scientific plots, anything Chart.js can't express (dual axes, log scales, error bars, annotations, statistical overlays). For those, generate the image locally and use `upload_attachment_instructions`. The full syntax and examples are also returned by `get_conventions` under `fenced_blocks`.

**Schema defaults.** On insert, any active field the caller doesn't supply falls back to the column's `default_value` (from the field definition, same value that pre-fills the `{database-newrow}` form), and only then to the SQL column default. So API inserts now behave like form inserts — you don't have to re-list defaults.

**Referential integrity on delete.** Before deleting, the tool scans every active `lookup` / `tag` field with `foreign_key` pointing at this table. If any row anywhere references the id being deleted, the tool returns `{"deleted": false, "references": […]}` listing the offenders and does not delete. Pass `force=true` to override — the referencing rows are then left dangling, so use only for cleanup where you know the references are stale.

**Standalone page deletion.** `delete_page(page_path)` covers pages that aren't row-bound. For row-bound pages, prefer `delete_database_row` — it goes through the RI check and gives you the symmetric insert/delete lifecycle.

## Schema management (admin only)

Four tools let an admin bootstrap and evolve structured-data tables from an agent, mirroring what the **Admin → Database** UI exposes:

- **`create_database_table`** — new table with name, label, and optional `page_folder`/`page_template_path`/sort defaults. The table's `name` and each field's `name`+`type` are **immutable** — pick carefully. `page_folder` may include `@field` substitution (e.g. `/regulatory/qms/soft/server/@server_name`).
- **`create_database_field`** — add a field. Types: `text`, `integer`, `float`, `boolean`, `date`, `datetime`, `page_link`, `enum`, `multi_enum`, `auto_increment`, `image`, `color`, `tag`, `lookup`, `user`. `enum_values` for `enum`/`multi_enum`; `foreign_key` for `tag`/`lookup`; `display_column` for `lookup`.
- **`update_database_table`** — non-destructive: change label, `page_folder`, template, sort defaults. Only supplied fields are updated. No renames.
- **`update_database_field`** — always accepts metadata (label, `required`, `default_value`, `display_order`, `placeholder`, `enum_values`, `foreign_key`, `display_column`). On an **empty table** (zero active rows) it also accepts `new_name` (rename the SQL column) and `new_type` (drop and recreate the column with a new type). On a table with rows, `new_name`/`new_type` are refused with a clear message — clear the table first via `delete_database_row`.
- **`delete_database_field`** — hard-deletes a field: drops the SQL column (or junction table for `multi_enum` / sequence for `auto_increment`), removes the field row, records history. Requires an empty table. Historical row-bound pages that still reference the deleted field continue to render — their inline value stays in the page attic, and the row NodeView marks the label with a muted `(removed)` suffix.

Every call is gated behind the caller's membership in the `admin` group — non-admin users get `access denied: schema management is admin-only`. All changes are recorded in `database_schema_history`. Table deletion still lives in the web admin UI.

Typical bootstrap flow for a new SOP record: `create_database_table(name=…, label=…, page_folder=…)` → one `create_database_field` per column → write the record page with `{database-query table=NAME}` and `{database-newrow table=NAME}` directives via `write_page`.

## History and audit

Four tools give agents access to the page-history plumbing behind the wiki's own **History** view:

- **`list_recent_changes`** is the entry point for cross-page audit questions. Filter by any combination of `since` / `until` (RFC3339 timestamps), `author` (exact username), and `path_prefix`. Each returned entry is ACL-checked against the caller — pages you can't view are silently dropped.
- **`list_page_history`** returns the full version list of a single page.
- **`read_page_version`** returns the markdown of a specific archived version, plus its metadata.
- **`diff_page_versions`** returns a structured line-level diff between two versions (same hunk shape as `preview_page_diff` — `equal`/`insert`/`delete` with `added`/`removed` counts).

Typical audit flow: `list_recent_changes(author=X, since=…)` → pick an entry → `diff_page_versions(page, entry.version-1, entry.version)` to see what changed in that revision.

## Resources

Pages are exposed as `wiki:///path/to/page` URIs via a resource template. Clients can:

- List `wiki:///` as the starting entry point
- Fetch any page path directly through the template

`read_pages_batch` is generally faster for the LLM than issuing multiple `resources/read` calls, so resources are most useful when the client pins a URI as conversation context.

## Prompts

| Prompt | Arguments | Purpose |
|---|---|---|
| `summarize_page` | `path`, `max_bullets` | Bullet summary of a page |
| `draft_review_checklist` | `path` | Reviewer checklist — includes reviewflow state |
| `suggest_tags` | `path` | Propose tags, preferring existing ones |

## Conventions the client must follow

The server advertises these in its instructions and re-exposes them through `get_conventions`. In short:

1. Call `get_conventions` once at session start.
2. Always `preview_page_diff` before `write_page`, and show the diff to the user.
3. Every write requires a summary formatted `[AI: <tool>] <description>`.
4. Optimistic locking: read → preview → write with `expected_version` set to the read version.

## Rate limits and 429 handling

MCP calls are token-authenticated, and each token has a per-minute
budget. The whole `/api/mcp/v1/*` surface counts against the READ
bucket (defaults: `rate_limit_read: 120` requests per minute for the
whole `ai_api` section, configurable in `config.yaml`). MCP is
JSON-RPC over POST, so counting POSTs as writes the way the REST API
does would quietly bucket every read tool — `read_page`,
`list_namespace`, `get_reviewflow_status`, `list_reviewflows`, … —
into the tighter write budget, and any corpus-scale scan would 429 a
few tool calls in. Per-tool write authorization still enforces
mutation gates at each handler.

When the budget is exhausted, the server returns:

- HTTP status `429 Too Many Requests`
- Body `{"error":"rate limit exceeded"}`
- `Retry-After` header carrying an integer count of seconds
  (per RFC 9110 §10.2.3), rounded up and floored to 1.

Clients that read the header get the exact wait; clients that fall
back to exponential backoff still recover but overshoot. A single
`initialize` counts as one request — a client that reconnects after a
429 without waiting the announced delay just digs its own hole.

For corpus-wide scans that would otherwise blow the budget, prefer
batched tools: `read_pages_batch` for page content,
`list_reviewflows` for compliance state, `list_namespace` (with
`include_meta` / `include_comments`) for one-shot inventory.

## Relationship to the HTTP AI API

The MCP server reuses the same handlers conceptually but is a separate entry point. If you already integrate via `/api/ai/v1/…`, nothing changes — both paths stay available. New agent integrations should prefer MCP because:

- The tool contract is explicit (JSON Schema inputs, typed outputs).
- Resources give clients a native way to include pages as conversation context.
- Prompts centralize ready-made workflows instead of duplicating prompt templates across clients.
