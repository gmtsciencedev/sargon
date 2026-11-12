# Changelog

All notable changes to Sargon (named Gowiki up to `v1.0.0-rc.5`). Format
loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Dates are ISO-8601.

Sargon is a from-scratch DokuWiki replacement built on a bijective Markdown
dialect with a ProseMirror-backed dual-mode editor. See `CLAUDE.md` for the
project's design invariants and `specs/` for the dialect specification.

## [Unreleased]

### Added

- **`export_page_pdf` MCP tool.** An agent can export a page to PDF —
  the same document the Export PDF button produces — opened as the
  calling user, so ACLs apply. The PDF comes back as an embedded
  `application/pdf` resource with its size and sha256.

### Fixed

- **PDF footer showed a double slash** in the "Printed from" address
  (`https://host//page`) on every export; the export URL was joined
  with an extra `/`. The root page now exports under its canonical
  `/` rather than `/index`.
- **PDF export with an API token printed an error page for protected
  pages.** The headless browser only received a login cookie; callers
  authenticated by token now get a temporary session, as the render
  endpoint already did.

## [1.0.0-rc.6] — 2026-10-30

Sixth release candidate, and the first under the name **Sargon**. The
project leaves its working title before v1.0.0, while no one outside
the first deployment depends on it. Alongside the rename, the RC adds
signing-order control for reviewflow, notification throttling, and
multi-series charts, and fixes a restart loop that flooded signers
with duplicate emails.

### Changed

- **Gowiki is now Sargon.** The repository lives at
  `github.com/sargonwiki/sargon` (GitHub redirects the old
  `delahondes/gowiki` URLs); the Go module is `sargon/backend`; release
  artifacts are `sargon-server-*` and `sargon-frontend-dist-*`; the MCP
  server announces itself as `sargon-mcp`. New signing CAs default to
  `O=Sargon` and self-signed certificates carry `O=Sargon Self-Signed`;
  certificates and signatures issued under the old name stay valid,
  since the organisation field is never checked. New logo — a
  lamassu — and favicons; the README explains the name. Persisted
  identifiers keep their `gowiki` prefix (CSS classes, which double as
  parse hooks; the `gowiki_session` and `gowiki_theme` cookies; browser
  storage keys), so sessions and preferences carry over.

### Added

- **Signers are alerted one at a time.** A reviewflow now notifies each
  signer only when it is their turn, in the order the roles are written
  in the directive; `parallel=true` restores everyone-at-once. With
  `manual_release=yes`, a "Ready for signature" checkbox holds the
  first alert until the first signer, or anyone with edit rights, ticks
  it. The tick is stored in the reviewflow state and can be undone
  until the first signature.
- **Notification throttling.** Task notifications to one user are
  grouped into a single email over a debounce window set in the admin
  UI, and a user receives at most one email per document per day,
  across every task notification channel.
- **Multi-series charts.** `|`-separated values in a chart table give
  grouped bars and multi-line charts.
- **Backlinks of row-bound pages** now list the pages whose
  `{database-query}` reads that row's table.

### Fixed

- **Signers received the same email again after every restart.** The
  startup reconciler recreated open review tasks instead of comparing
  them with the ones already there, and each recreated task sent a
  fresh notification — 19 emails overnight in one reported case. It
  now reconciles by difference and reports only the pages it changed.
- **Links and attachments landed at the bottom of the page.** The
  tidy-up the editor runs when it loses focus replaced the whole
  document, which moved the caret to the end; opening the link dialog
  or the media manager triggered it. The tidy-up now replaces only the
  changed range, and waits while a dialog is open.
- **Cmd+K swallowed the previous word.** With nothing selected, Cmd+K
  now inserts a new link at the caret showing the target page's title,
  keeps a just-typed space, and opens exactly one dialog; a selection
  still becomes the link text. Shipped across three mid-rc fixes.
- **Long lines in the diff viewer** wrap with a hanging indent instead
  of scrolling sideways.

### Internal

- Locally built binaries (about 132 MB) are no longer tracked in git.

## [1.0.0-rc.5] — 2026-10-09

Fifth release candidate. Two user-visible additions (tombstone-on-delete
with archived-history UI; calendar-recurrence modes + tolerance) sit
alongside a dense pass of correctness fixes against reviewflow drift
and signature-trust bugs the live QMS corpus continues to turn up as
pages age through multiple edits, moves, and deletes.

### Added

- **Tombstone-on-delete.** `FileStore.Delete` now moves the entire
  page history (attic entries + every meta sidecar: `meta.json`,
  `reviewflow.json`, `comments.json`, …) into
  `data/attic/<path>/@tombstones/@deleted-<ISO-ts>/` before removing
  live content. A page recreated at the same URL afterwards starts
  from a clean slate — Version=1, no inherited reviewflow deadlines,
  no attic-version collision. Previous lives are recoverable through
  `Attic.ListTombstones` / `ReadTombstonedVersion`; regulatory audit
  guarantee preserved. One-shot `FileStore.ReconcileTombstones`
  startup sweep drains pre-fix drift. Multiple deletions on the same
  path pile up multiple `@deleted-<ts>` subdirs.
- **Archived-history banner + view.** The history page of a page
  that lived here before (one or more tombstones present) shows a
  blue info banner above the version table ("A previous page lived
  at this URL before and was deleted — [View archived history]").
  The archived view renders one section per tombstone (deleted-on
  header + version table matching the live-history shape); each row
  has a View button that opens the archived markdown read-only. No
  restore button — restoring would mix identities with the current
  page's life. Also surfaced on the "page does not exist" view
  through the "consult older versions" link, so a page deleted and
  not recreated is still discoverable.
- **Calendar recurrence modes + tolerance.** `recur=1y` and
  friends now accept `mode=at-least` (default) or `mode=fixed`, and
  an optional `tolerance=N%` (default 10% of period, floor 1 day)
  or `tolerance=Nd`. `at-least` guarantees max gap ≤ N units
  (early-beyond-tolerance re-anchors to completion); `fixed` keeps
  the schedule sacred (early-beyond-tolerance records the completion
  but leaves the next instance's due date unchanged, so the user
  still gets the alert on the scheduled day). Behaviour change: the
  previous implicit semantic was "advance by N units regardless of
  when completion landed"; new default re-anchors on genuinely early
  completions and is the regulatorily-safer choice for QMS cycles.
  Delay recurrences (`+Nd`, bare `N`) remain unchanged — completion
  is the only anchor they know about. Spec section 3.3.1-3.3.2 and
  the user manual have the full matrix and worked examples.
- **Relative due dates in `{template-todo}`.** `due=+30d`,
  `due=+3m`, `due=+1y` resolve to an absolute YYYY-MM-DD at page
  creation time, so a template that says "due 30 days after the
  document is created" works without the author doing calendar
  math. Pure `due=YYYY-MM-DD` continues to pass through verbatim.
- **`{database-newrow fields=}` whitelist + `=~` default modifier.**
  `fields=a,b,c` restricts the insert form to the listed columns in
  the order given; `fields=a=~alice` sets a default without
  disabling the field (`=` alone makes the field read-only, as
  before). Lets a template say "the author field defaults to the
  current user but the user can still change it" in one directive.
- **`search_pages` `scan_complete` + `count_only`.** The MCP tool
  now surfaces `scan_complete`, `eligible_pages`, and `total_matches`
  on every response so a caller can tell "we're done" from "we hit
  the limit, there's more". `count_only=true` returns the counts
  without the page bodies, cheap enough to use for the common
  "roughly how many hits" question before deciding to paginate.
- **Diff view: Back-to-page button.** Next to the existing "Back to
  history" button on the diff view, so a reviewer who clicked
  through from history to inspect a change can return directly to
  the live page without bouncing through history.

### Fixed

- **Signed signatures survived content changes under the same
  version.** `SyncFromMarkdown` only invalidated signatures when the
  version changed; a write path that landed new content under the
  SAME version number (buggy, racy, or bypassing the normal path)
  left the signatures claiming to cover content they no longer
  matched. New belt-and-suspenders digest check at the top of
  `SyncFromMarkdown` enforces the invariant on every call. One-shot
  `ReconcileStaleSignatures` startup sweep drains pre-fix states.
  The signed Confirmation goes to the version snapshot (audit trail
  preserved) and the live Confirmations are rebuilt from re-attach
  — exactly what the version-bump branch already does.
- **`GetStatusForVersion` fabricated "validated" for partial
  snapshots.** User-reported bug: `/qara/sop09` at v67 displayed
  the reviewflow panel as "✓ Validated" with all three roles
  Confirmed, but the live state said `validated_page_version=0`
  and only one role had signed. The historical-view code short-
  circuited on any `VersionHistory` entry, ignoring the
  `IsValidated` flag that distinguishes genuine validations from
  partial-signature bookkeeping snapshots. Gate the short-circuit
  on `IsValidated=true`; fall-through reads `ConfirmedBy` from the
  snapshot (not the live Confirmations, which have been wiped by
  the newer version). Historical versions now report the shape
  they actually had.
- **Reviewflow todos stayed open after signing.** User-reported
  drift on `/regulatory/qms/dir/sop02/` and several QMS pages: open
  "Review (1.1): raynald as author" tasks on pages where raynald had
  already signed. Root cause: historical tasks persisted their
  `source_page` without a trailing slash, while namespace indexes
  canonicalise to the slash form. `TodoStore.ListForPage` and
  `CompleteReviewTasks`' node-key check now accept both slash
  forms. Companion `ReconcileStatelessReviewTasks` reconciler
  walks tasks (not state files), cancels any whose page AND state
  file have both vanished — zombie-task cleanup from pages deleted
  before the OnPageDelete hook existed.
- **MCP write paths skipped action triggers.** A `write_page` or
  `edit_page` through the MCP server that satisfied an action
  todo (`action="read:..."`, `action="edit:..."`, `action="create:..."`)
  left the todo open — the auto-complete hook ran only from the
  REST handlers. Moved the hook to `storage.FileStore.OnPageSaved`
  so every write path (HTTP, MCP, migration tool) fires it.
- **Deleted-then-recreated pages carried the old page's identity
  forward.** Delete+Put at the same URL gave the recreated page
  the previous life's version numbering (v12+ instead of v1) and
  silently resurrected its reviewflow state with 2024-stamped
  deadlines on 2026 content. Fixed by the tombstone-on-delete work
  above; the sweep cleared one page of pre-fix drift
  (`CPM/SOP01/REC01`) on first startup after the fix shipped.
- **Lock-key drift across URL forms.** A page accessed as `/foo/`
  (namespace index) and `/foo` (its leaf form) would acquire two
  separate draft locks, each invisible to the other. New
  `LockKeyResolver` interface canonicalises the lock key so
  concurrent edits from the two forms contend on the same key.
- **Nested emphasis grew by two asterisks per round-trip.** 
  Serialiser used a fixed reversed mark order; corrected to
  dynamic ordering based on PM's schema rank, matching the
  parser's reconstruction order. (Shipped as a mid-rc fix after
  publish-time validation started refusing some re-serialised
  documents.)
- **todo-calendar labels truncated too aggressively; hover tooltip
  flaky.** The calendar chip's single-line `white-space: nowrap`
  cut labels at ~10-12 characters; the native `title` tooltip
  only fired intermittently inside the PM editor. Chip label now
  wraps up to 3 lines (`-webkit-line-clamp: 3`) with the status
  icon aligned to the first line, and the tooltip is a custom CSS
  pseudo-element driven by `data-tooltip` — fires reliably on
  hover, carries title + status + assignee + due date.
- **`search_pages` scanner stopped silently at the first non-match
  prefix.** A keyword with no hits in the first batch of pages
  returned early; combined with the lack of a `scan_complete`
  signal, the caller had no way to tell "no results" from "hit
  the batch limit". Scan now completes the full eligible set
  before returning (unless `limit` fires), and `scan_complete`
  tells the caller which outcome they got.
- **Docs: `page_folder` naming semantics tightened.** The database
  spec and admin manual mentioned `@id`/`@field` tokens but left
  readers guessing on the slug rules, the per-token (not
  per-segment) behaviour, the empty-value fallback to row-id, and
  the `migrate-page-paths` endpoint for after-the-fact renames.
  Full matrix now in `specs/database.md` section 3.3 and
  `backend/internal/manual/admin-database.md` with worked examples
  (`"John Doe"` → `john-doe`, `"R&D (2024)"` → `r-d-2024`).

### Internal

- `reviewflow.OnPageDelete` hook split out from the generic
  delete path and wired to `FileStore.Delete`; cancels review
  tasks and removes the state file in one place rather than
  letting the todo-sync and state-file cleanup drift.
- `storage.ReconcileTombstones`, `reviewflow.ReconcileStaleSignatures`,
  and `reviewflow.ReconcileStatelessReviewTasks` run at startup
  alongside the existing `ReconcileValidatedTasks` and
  `ReconcileOrphanTasks` — one-shot sweeps for each class of
  known drift, all idempotent.
- `OnPageSaved` and `OnPageDelete` hooks on `storage.FileStore`
  let plugins observe writes and deletes without routing through
  HTTP; action-todo auto-complete and reviewflow task cancellation
  both ride on them now.

## [1.0.0-rc.4] — 2026-10-03

Fourth release candidate. Four new MCP / editor surfaces plus a
dense pass of correctness fixes against bugs the live corpus
turned up after rc.3 shipped. Nothing in the RC window has
required a reroll of a prior fix; the base version candidate
remains viable.

### Added

- **Implicit templates** — an `_template.md` file carrying a
  `{template}` marker now runs through the full template
  resolution pipeline when a new page is created in its
  namespace. `{template-title}` substitutes the heading,
  `{template-stamp}` emits the frozen origin sentence,
  `{template-reviewflow}` becomes `{reviewflow}` with merged
  args, `{template-todo}` becomes `{todo}`. An `_template.md`
  WITHOUT the marker still pre-fills raw (keeps imported
  DokuWiki templates working untouched). Validation gate and
  target-pattern enforcement are the same as the explicit
  Create-from-template action — pre-filling can't bypass the
  "fully validated before issuing" rule. The split/merge/
  resolve pipeline is factored into one helper
  (`(*Server).resolveTemplateDoc`) so both entry points call
  the same code.
- **`{template-todo}` directive.** Mirrors `{todo}`'s attribute
  surface (title, assign, action, due, priority, …) and resolves
  to a real `{todo}` on the created document. Prevents the trap
  where a `{todo}` placed on the template page would fire against
  every reader of the template itself. Toolbar icon in both edit
  modes (page-with-folded-corner base + checkbox payload). The
  properties panel for `{template-reviewflow}` now also surfaces
  the roles map (multiline `rolename=username` per line, same
  shape as `{reviewflow}`'s panel — previously roles could only
  be edited by dropping to raw mode).
- **`list_broken_links` MCP tool.** One pass over the corpus,
  one row per unresolved internal reference:
  `{page, href, resolved, fragment, label, line, reason}`.
  `check_fragments=true` turns on `#anchor` validation — each
  fragment is compared against the target page's heading slugs
  (numbered-heading `N.` prefix stripped so an auto-numbered
  heading matches both its slug and its anchor). Default off
  for the cheap-and-fast case. Pages the caller can't view are
  skipped — the dual-ACL model is honoured.
- **`list_reviewflows` surfaces signatories.** Each row now
  carries `roles` (role → assigned user), `confirmed_by`
  (role → user that signed, derived server-side as
  `roles ∖ missing_roles`), `missing_roles`, `next_roles`,
  `signed_roles` (cryptographic signatures only), `version_tag`,
  and `parallel`. Answers "who signed, who still owes, who's
  up next" from one batch call rather than one `get_reviewflow_status`
  per page. `confirmed_by` is nil (JSON-omitted) when nothing is
  signed, so the fresh-reviewflow case stays compact.
- **`{reviewflow-query user=X signed_by=Y}` filter.** Mirror of
  `when=missing`: `signed_by` lists pages where Y has signed —
  useful for compliance ("show me every doc Etienne has
  endorsed"). Pairs cleanly with `user=@me` for the personal
  dashboard case.
- **Orange-dot visual cue on the Edit icon** when the current
  page is locked by someone ELSE. Same 7×7 shape as the yellow
  own-draft dot but `var(--gw-color-warning)` so dark mode flips
  cleanly, and the two states stay visually distinct at a
  glance. Tooltip promoted to `Being edited by X — click to
  join session`.
- **Toolbar icon for `{lifecycle}`.** The plugin already
  registered an insert command but main.js had no capture
  branch, so it fell through to the generic text-button fallback.
  Capture branch added + distinct triangular 3-arrow recycle
  symbol (solid-filled, respects `currentColor`) so it doesn't
  read like the clock-based `{changes}` icon.
- **`split-polluted-author` migration tool.** One-shot cleanup
  of `data/meta/.../page.json` + `data/attic/.../index.json`
  entries whose Author field held `"username | summary"` from
  the pre-rc.4 MCP write path. Splits at the first ` | `; the
  suffix moves into `AtticEntry.Summary` only when it was
  empty. Idempotent — a second pass reports zero. Ran on prod
  2026-10-01: 184 meta files + 798 attic entries fixed, no
  errors, backup kept.

### Fixed

- **Reviewflow todos survived page delete, tag change, and
  validation.** 23 stale tasks out of 88 on the live corpus
  with no matching reviewflow state. Four drift sources closed:
  `storage.FileStore.Delete` now calls a new
  `ReviewflowSyncer.OnPageDelete` hook (cancels tasks + removes
  state file); `SyncFromMarkdown`'s version-bump branch always
  cancels then recreates missing-role tasks when the directive
  changed between versions (was skipped whenever any
  confirmation re-attached, leaving dangling tasks for
  reassigned roles); `finalizeValidatedVersion` adds a belt-
  and-suspenders `CancelReviewTasks` after `Complete`;
  `ReconcileOrphanTasks(exists)` runs at startup and sweeps
  historical drift (page gone / page fully validated / live
  state rebuild). Signature-preservation path intact — "same
  directive + re-attach = don't touch tasks" is preserved via
  a byte-compare on the directive's roles / tag / order /
  parallel.
- **Nested emphasis round-trip grew by two asterisks per pass.**
  `*italic **strong** italic*` serialised to
  `*italic ***strong*** italic*`, which re-parsed with one
  extra mark level and re-serialised to five asterisks, then
  seven, until publish-time validation refused the save. Root
  cause: both inline mark serializers reversed PM's mark set
  under the (wrong) assumption that reversed order means
  outer-first. PM order is schema-rank order — for
  `em + strong` that reversal made strong appear outer, so em
  got closed and re-opened AROUND strong at every text-node
  boundary. The fix picks mark order dynamically: marks already
  active that are also on this node come first (in
  `activeMarks` order), new marks go after. em stays open
  across the boundary, strong opens cleanly inside. Mirror of
  the fix in both `pm_to_markdown.ts:serializeInlineFragment`
  and `core_nodes.ts:serializeInline`. The "bold wrapping
  italic" direction was never affected because strong sorts
  after em in schema order (the reversed order happened to
  match reality for that case).
- **`author` field polluted with the commit summary.** The
  `{tag-query}` Author column showed
  `raynald.delahondes | [AI: edit_page] Change history: …` —
  the five MCP write surfaces concatenated
  `username + " | " + summary` into one string before calling
  `Store.Put`, writing the whole mess into
  `PageMetadata.Author`. Switched to `PutWithSummary`
  end-to-end: `PageStore` grows the method, `RowWriter`'s
  Insert / Update grow a summary parameter,
  `syncRowToPage` forwards it to `Store.PutWithSummary`.
  Attachment uploads drop the summary (the media attic has no
  Summary field — follow-up refactor).
- **Partial-signature snapshots wrongly flagged as "already
  validated".** The rc.3 snapshot-before-wipe path stored
  partial-signature records in `VersionHistory`, which then
  tripped the "version tag X was already validated" warning on
  the next tag bump. `isVersionTagAlreadyValidated` now requires
  `is_validated === true` or legacy full-coverage, treating
  partial-signature snapshots as bookkeeping, not completed
  validations.
- **Numbered-heading `N.` prefix leaked into
  `list_broken_links`'s slug set.** `#documentation-effort` on
  a page with `## 1. Documentation effort` was flagged as a
  broken fragment because the slugifier kept the `1. ` prefix
  (`1-documentation-effort`). `SlugifyHeading` now strips the
  prefix before slug generation, matching the renderer.
- **`{template-title}`, `{template-stamp}`,
  `{template-reviewflow}`, `{template-todo}` could not be
  selected in the visual editor** — their NodeView `stopEvent`
  returned `true` for every event, including `mousedown`, so
  PM couldn't form a `NodeSelection` and the properties panel
  never opened. Let mouse events through, keep keyboard /
  paste blocked. `{template-stamp}` in template context was
  also visually indistinguishable from body text (bare italic
  muted span); given the same `border-left + background`
  styling as the other template-aux panels and promoted the
  inner note to `display:block`.

### Changed

- **MCP write surfaces no longer concatenate author + summary.**
  Call sites: `write_page`, `edit_page`, `template_create`,
  `update_database_row`. All go through
  `PageStore.PutWithSummary`. (The migration tool above cleans
  historical records.)

### Tests

- Backend: 9 new in `task_lifecycle_test.go` (OnPageDelete,
  role reassignment, content-edit-no-reattach, finalize cancel,
  reconcile deleted / validated / live / dormant / idempotent);
  2 new for `list_reviewflows` signatories (parallel review
  with partial signatures, nil-vs-empty-map for the no-signatures
  case); 6 new for `_template.md` prefill (raw fallback,
  resolved payload, validation gate, target-pattern mismatch,
  target-pattern match, title helper); 1 for the migration
  tool's `splitAuthor` helper; 2 for the fragment-check slug
  stripping; 7 extracted direct tests for `list_broken_links`.
- Frontend: 2 for the nested-emphasis round-trip
  (`*italic **strong** italic*`, `*italic _under_ italic*`);
  template plugin test suite extended to 29 cases covering the
  new `template-todo` command / properties / toolbar wiring.
- **493 frontend tests, 10 backend packages, all green.
  `golangci-lint` 0 issues, `gofmt`, `prettier` clean.**

### Infra

- Release workflow now has a `prepare-release` job that
  auto-creates the GitHub Release before the upload jobs run —
  prevents the "release not found" failure that cost us the
  rc.3 cut.
- CI cleanups: `gofmt`, `prettier`, `staticcheck` QF1001
  rewrites, one unused `fakeCorpus.allPaths` helper removed.

## [1.0.0-rc.3] — 2026-09-30

Third release candidate. The bulk of rc.3 is a coordinated hardening
of the reviewflow signing surface after a mass invalidation incident
on the QMS corpus (37 pages' signatures wiped in a single AI-driven
cleanup pass). Signatures now survive discard-draft and restore-from-
history, the write tools refuse fully-validated pages by default, and
the reviewflow query directive grows the filters needed to run a
"what should I sign right now?" personal dashboard. Adjacent polish
across MCP (batched compliance scans, RFC-compliant rate-limit
headers) and the editor (gap cursor, cell pipes, formula copy/paste).

### Added

- **Signature preservation across version bumps.** Signatures are
  computed over the page content's SHA-256 digest, not the page-
  version integer, but the app used to wipe every confirmation on
  version bump. Now: `SyncFromMarkdown` snapshots the outgoing
  Confirmations set to `VersionHistory` before wiping (so an audit
  can trace who signed what content at every step, not only at
  fully-validated milestones), then re-attaches any historical
  confirmation whose stored digest matches the new content. Discard
  a draft that returned to last-published bytes → signatures back.
  Restore-from-history to a prior signed version → signatures back.
  When the re-attach covers every role, the page returns to fully-
  validated in one action, no re-signing round.
- **"Diff since your last signature" side link.** Next to the Sign
  button, when a role is missing AND the current user was a signer
  at an earlier version, a `diff since v{N}` link opens the standard
  page diff between the version the user signed and current. Crypto-
  signatures only (not click-only confirmations) — the whole point
  is showing what changed against the specific content endorsed.
- **Fully-validated-page guard on `edit_page` and `write_page`.**
  Both MCP write tools now refuse when the target page is fully
  validated by reviewflow — because the write would invalidate every
  signature at once — unless the call passes `force=true`. The
  refusal names every signed role so the LLM can surface the cost
  to the human before retrying. `dry_run: true` on `edit_page` skips
  the guard (a preview writes nothing). This is the root-cause fix
  for the incident that motivated the rc.
- **`{reviewflow-query user=X when=Y}`.** Personal to-do lists per
  reviewer. `user=@me` resolves to the current viewer; `user=<login>`
  makes a fixed dashboard someone else can consult. `when` narrows
  the match: `any` (has an assigned role), `missing` (role unsigned),
  `next` (queue-actionable now — head of the sequential queue, or
  any missing role in parallel mode), `overdue` (deadline passed).
  Answers "what must I sign right now?" as a one-liner directive.
- **`list_reviewflows` MCP tool.** Batched form of
  `get_reviewflow_status`: `path_prefix` scans a namespace and returns
  one row per configured page — `{path, is_fully_validated,
  current_version, validated_version, overdue_roles}`. A 143-page
  compliance sweep now costs one MCP call rather than 143.
- **`list_page_comments` MCP tool + `include_comments` on
  `list_namespace`.** Comment threads on a page, grouped with replies
  under their parent; per-page unresolved-count opt-in on the
  namespace listing for a quick "where are the open conversations"
  scan.
- **Gap cursor between block atoms.** ProseMirror `gapCursor` plugin
  is now in the editor plugin stack. Arrow keys past a selected block
  atom (todo, image, include, mermaid, database block) land a caret
  in the gap between two adjacent atoms — building a list of todos
  with commentary between them no longer needs the click / undo /
  click ritual.
- **Typing beside a selected block atom preserves the atom.** With
  a todo NodeSelection, typing a character used to replace the atom
  with the character; now the character extends a fresh paragraph
  after the atom, and the atom is never lost to an accidental key.
- **Excel-style formula copy/paste in tables.** Copying a formula
  cell rewrites refs by the destination-source delta on paste, same
  as a spreadsheet. `A1` shifts both axes; `$A1` pins the column;
  `A$1` pins the row; `$A$1` fully absolute. Off-grid targets become
  `#REF`. Classic `=SUM($A$1:A5)` growing-anchor pattern works.
  `LEFT` / `ABOVE` are already position-relative, so they carry
  through unchanged.
- **Literal `|` in a table cell.** Typing `|` in a cell in visual
  mode now serialises as `\|` (the standard CommonMark escape) and
  round-trips as literal text — the visual editor shows the bare
  `|`, raw mode shows the escape. Prevents accidentally splitting
  a row when a cell needs a pipe (URLs, choice notation, regex-like
  text).
- **Comments auto-collapse when every top-level thread is resolved.**
  A reader shouldn't have to hunt for actionable state on a doc
  whose whole comment history is settled. The sidebar starts
  collapsed as a small corner chip (`▶ ✓`); any single unresolved
  thread keeps it open. Companion `{lifecycle when=comments_open}`
  rule surfaces the same count as an alert on the QARA managing
  page.
- **Reviewflow-query header banner** reflects the active `user` and
  `when` filters so a reader recognises the dashboard's scope at
  a glance ("Documents pending validation (/qms) — Etienne
  Formstecher · ready to sign now").

### Changed

- **MCP traffic bucketed against the read rate limit.** MCP is
  JSON-RPC over POST, so a plain verb-based classification routed
  every read tool (get_page, list_namespace, list_reviewflows, …)
  through the tight write bucket and made corpus-scale scans
  impossible. All `/api/mcp/v1/*` requests now count against the
  read limit; per-tool write authorisation still gates mutation at
  each handler.
- **`Retry-After` header on 429 is now RFC 9110 integer seconds.**
  Was `time.Duration.String()` output (e.g. `15.644403776s`) — no
  compliant HTTP client parses that, so every client dropped to
  blind exponential backoff and waited much longer than the server
  asked for. Rounded up, floored to 1.
- **Sidebar visibility respects the "resolved" default-collapse
  rule** even when the reader opens the page fresh: the collapsed
  chip is the reader-facing signal that the archive is there but
  demands no attention.

### Fixed

- **Publish crash on tables with a footnote carrying a hard break.**
  The `gowiki_hardbreak_escape` parse rule replaced `\n` with real
  newlines in every inline token — including the text captured by
  `^[…]`. Serialising the footnote back emitted the raw newline
  mid-row, splitting the enclosing table row and blowing up
  `resolveMerges` on the next parse ("cannot access property
  content, t is undefined"). The footnote serialiser now escapes
  real newlines back to `\n` literal; `resolveMerges` guards against
  uneven rows as a defence in depth.
- **Comment highlight drifts when a block is inserted before the
  anchor.** Structural anchor was captured after the insert instead
  of before it, so the highlight landed on the wrong slice.
- **Comment on deleted text places its highlight on wrong slice.**
  When the anchored text was removed from the doc, the fuzzy search
  returned `null` but the code kept the structural position with
  confidence `fuzzy` — so the sidebar entry pointed at unrelated
  content. Now returns `lost`, and the caller marks the comment
  orphaned.
- **Comment `statePath` misplaces the file for namespace-index
  pages.** ns-index paths produced `foo/.comments.json` (dotfile)
  instead of `foo.comments.json` (sibling), so comments on `sop01/`
  weren't detected.
- **"Show resolved" toggle appears to do nothing when the archive
  is below the fold.** The anchored-comments stack could push the
  toggle far down the sidebar; expanding the archive added boxes
  immediately below, often past the viewport. `scrollIntoView` on
  expand pulls the container into view.
- **`hide_drafts_from_uninvolved` gate 404s every page without
  `{reviewflow}`.** The gate applied unconditionally; now short-
  circuits when a page has no reviewflow roles.
- **`comments_open` lifecycle rule flagged as "not yet configured"**
  even after the plugin was wired up.
- **Pinned values on `{database-newrow}` and `{template}`
  destinations, archived fields on row-bound pages,
  `page_link` field rendering on row-bound pages** — the
  cluster of database-plumbing fixes that landed alongside rc.2's
  aftermath.

### Docs

- New "Signatures that survive a discard-draft or a restore" and
  "Diff since your last signature" sections in the reviewflow
  manual. Digest-bound re-attach explained, seat-holder-changed
  caveat called out, first-time-review case ruled out.
- New "Copy/paste — refs shift like a spreadsheet" section in the
  tables manual, with the `$`-pinning cheat table and the growing-
  anchor pattern. Companion "Type `|` inside a cell" note.
- New "Editing around block atoms" section in the visual-editor
  manual describing gap-cursor navigation and typing-preserves-
  atom.
- New "Common `user` + `when` patterns" section in the reviewflow
  query documentation.
- New "Rate limits and 429 handling" section in the MCP manual
  documenting the read-bucket policy, the RFC-compliant
  `Retry-After` contract, and a nudge toward batched tools for
  corpus-scale scans. `list_reviewflows` and `list_page_comments`
  documented alongside their single-page counterparts.
- SMTP setup examples for Google Workspace and Microsoft 365 in
  admin-config, with the vendor-specific gotchas (Gmail app
  passwords, MS 365 SMTP AUTH + MFA).
- README gains a "Running tests" section documenting unit vs
  integration test invocation.
- New `ROADMAP.md` at repo root carrying deferred items (fenced
  grouping block for the div-like usage that overloads `>`;
  paste-side acceptance of CommonMark alignment syntax on
  tables).

### Tests

- Backend: 6 cases for the fully-validated-page guard; 7 for
  signature preservation (snapshot, re-attach, finalize, wipe,
  unsigned skip, dedup); 3 for `NextRoles` (sequential /
  parallel / fully-validated); 5 for the rate-limiter and MCP
  bucket classification; 7 for `list_reviewflows`; new coverage
  for the comment statePath fix and the hide-drafts short-circuit.
- Frontend: 4 for gap-cursor + typing guard; 13 for Excel-style
  formula shift (all axes, `$` pinning modes, ranges, off-grid,
  dedup, Z→AA); 3 for cell-pipe escape; 1 for the footnote hard-
  break regression; 4 for `{reviewflow-query user + when}` round-
  trip and 7 for the `rowMatchesUser` predicate; extra anchor
  regression coverage (deleted-text, moved paragraph, rewritten
  context, duplicated insertion).
- **467 frontend tests, 10 backend packages, all green.**

## [1.0.0-rc.2] — 2026-09-27

Second release candidate. rc.1 was a stabilisation cut; rc.2 lands one
sizeable new feature (`{lifecycle}` rules) plus polish across
reviewflow visibility, tag queries, and the test suite.

### Added

- **`{lifecycle}` rule framework.** A single directive on an admin
  document declaring "if a document in scope satisfies a condition,
  fan out a todo (or an alert) per matching document." Two condition
  kinds today: `stale:<duration>` (creates one todo per stale target)
  and `reviewflow_overdue` (panel-only alert — reviewflow already
  owns its notification chain). Selectors: `scope=` (path regex) +
  `tags=` (OR of at least one) + `exclude_tags=` (NAND). Rendering
  aggregates all `{lifecycle}` directives on a document into ONE
  discreet panel that turns red only when something fires; each
  firing rule carries a `▸ show N documents` disclosure listing
  the flagged paths as clickable links. Backend scanner runs at
  startup and every 6 h; ID hash is deterministic so todos survive
  restarts without duplication.
- **Directive rendering spec** (`specs/directive-general-rendering.md`).
  Codifies the visual grammar every directive follows: grey / pale
  red / pale green rendering box; yellow reserved for the property
  panel; passive-first wording; hover for detail.
- **Reviewflow draft-visibility gate.** Opt-in config
  `reviewflow.hide_drafts_from_uninvolved: bool` (default `false`,
  admin UI checkbox). When on and a document has an unsigned
  reviewflow, uninvolved readers are transparently served the last
  validated version — or 404 if the document has never been
  validated. Involved readers see the draft with a prominent
  inline pointer next to the DRAFT badge: `→ See VALID VERSION`
  (green, same size as DRAFT).
- **Sequential reviewflow notifications by default.** A save on a
  reviewflow-bearing document only creates the first role's todo;
  each confirmation advances the chain. Legacy parallel behaviour
  stays available via `parallel=true`.
- **`{tag-query tag=…}` accepts CSV** for OR-of-tags — same
  semantics as `{lifecycle tags=…}`. Single-tag calls unchanged;
  `tag=sop,rec,tpl` unions the three, dedupes by path.
- **`{database-query}` filter expands `{{page.title}}` etc.** —
  same template-variable resolver as the other rendering paths.

### Changed

- **Template "Create document" button** now uses `--gw-color-primary`
  tokens instead of `--gw-color-accent`, which resolves to a pale
  chip tint under the default theme (white text on light blue was
  nearly invisible). Disabled styling on unvalidated templates
  unchanged.
- **Alert-only lifecycle rules skip todo creation.** The scanner
  still surfaces the count on the panel (for `reviewflow_overdue`);
  reviewflow's own deadline / email chain owns the actual alert.
  Assignee on alert-only rules is optional but preserved end-to-end
  so future notification channels can address it.
- **Save-and-continue / draft-exit copy** clarified; toolbar
  icons rebalanced (small floppy + prominent right-arrow).

### Fixed

- **Underline after `\n` inside a table cell or list item**
  (`_word_` refusing to open because markdown-it's `snake_case`
  guard saw two word chars around the delimiter). The dialect
  `\n` → newline rewrite now runs before the inline core rule.
- **`RefIndex.Save` race**: `RLock` held across `MarshalIndent`
  so a concurrent `UpdatePage` can't corrupt the in-flight
  snapshot.
- **`SchemaStore.DeleteTable` ordering**: table drops before its
  sequences to avoid `DEFAULT nextval(seq)` referencing an
  already-removed sequence.
- **`parseDirective`** handles `\"`-escaped quotes so pivot label
  JSON blobs no longer truncate mid-value.
- **HTML entities stay literal** in the dialect — the earlier
  markdown-it default decoded them.
- **`TokenStore.Verify` async goroutine race** with test cleanup:
  synchronous `updateLastUsed` call.

### Testing / CI

- **~200 new tests** across the affected surfaces: storage core
  (pages, canonical paths, links, media, media_versions, diff,
  RefIndex, tag OR union), API (admin: acl / config / database /
  locks / tokens / drafts, auth: login / logout / me / oauth
  client + server, misc handlers, history + reviewflow-history
  integration, template handlers, tag-query CSV, draft-gate
  decision table), reviewflow (sequential notifications,
  IsInvolved), todo (parse, model, recurrence, service, hooks,
  handlers, notify), lifecycle (parse, selector, evaluator,
  scanner, HTTP status endpoint, dialect round-trip, NodeView
  jsdom integration with the three visible states + aggregate
  path), reviewflow NodeView draft-pointer.
- Frontend Vitest coverage extended to blockquote, code_expand,
  spoiler, highlight, image, medialink, mermaid, include, slide,
  table_formulas, comment, reviewflow, todo, lifecycle. **410
  frontend tests total, all backend packages green.**
- CI: `golangci-lint-action` bumped to v7 for v2 linter support;
  ESLint `no-extra-semi` disabled (Prettier is authoritative on
  semis).

## [1.0.0-rc.1] — 2026-09-26

Release candidate for v1.0.0. No new features versus the v0.95 line; the RC
exists to stabilise the surface before cutting v1.0.0. Recent hardening in
this window:

### Added

- MCP draft-session tools: `enter_edit_session`, `save_edit_draft`,
  `read_edit_draft`, `publish_edit_draft`, `discard_edit_draft`. An AI
  agent can join a collaborative edit, iterate on the draft, and publish
  through the same server-side pipeline the HTTP handler uses (inline
  row-edit guard, flow-marker strip, database validation, page store,
  todo auto-complete).
- MCP `update_database_row` tool: partial patch that syncs the bound page.
- MCP `render_page` tool: returns the fully-rendered HTML the way a
  browser would see it (dynamic directives resolved).
- MCP attachment tools: `upload_attachment`, `upload_attachment_instructions`,
  `read_attachment`, `list_attachments`, `delete_attachment`. HTTP multipart
  is the primary transport; base64 is a small-file fallback with SHA-256 +
  size verification.
- Pivot tables: keep empty-axis rows via the `@null` sentinel, and remap
  or merge axis labels via `pivot_rows_labels` / `pivot_cols_labels`.
- Tag queries: `groupby=folder` renders group headings.
- Sitemap: auto-expand and `{favorites}` component.

### Changed

- `enter_edit_session` gates lock takeover on WebSocket presence rather
  than caller identity. Any live editor blocks the reclaim; a truly
  stale lock (closed tab, crashed session) is reclaimable regardless
  of who owned it. This replaces the earlier same-user `force=true`
  parameter.
- Disabling an account now revokes every live session for that user
  immediately (belt-and-braces: also blocked per-request in `requireAuth`).
- Save-and-continue toolbar icons rebalanced (small floppy + prominent
  right-arrow); draft-exit status message clarified.
- Search index tokenises directive names, keys, and values; index is
  rebuilt on startup.
- Reviewflow versions normalised via dot-tuple padding so `1` and `1.0`
  round-trip identically.

### Fixed

- Cancel-edit no longer deletes a pre-existing draft — it only discards
  unsaved changes since edit-mode entry. Deletion stays reachable via
  the explicit "Discard draft" action.
- Underscore-delimited underline (`_word_`) after a `\n` literal hard
  break inside a table cell or list item now opens as expected. Root
  cause: markdown-it's `_`-em rule refused to open between word
  characters (its `snake_case` guard) because the `\n` literal was still
  two plain characters at inline-parse time. Fix promotes `\n` literals
  to real newlines before the inline core rule runs.
- `render_page` MCP tool cookie bug: now uses `auth.CookieName` instead
  of a stale `"session"` literal.
- Highlighter un-highlight: fixed for the "caret inside a mark" case by
  detecting the run around the caret and removing the whole mark.
- Table column-color and formula-color rules no longer shade header
  cells (they hid the header's semantic contrast).
- Sitemap: leaf URLs for namespace-index pages no longer double up their
  trailing slash.
- Signing certificate revocation: profile respects server-side
  revocation; distinguishes "revoked" from "fresh key awaiting a new
  certificate"; stale IndexedDB PEMs are purged so the download button
  reappears.
- Emoji rendering: added Apple/Segoe/Noto colour emoji to theme font
  stacks so the highlighter icon renders on Linux.
- `RefIndex` media key shape: lookups now consistently use the leading
  slash the index stores with.

## [0.9.x] — 2026-04 → 2026-09

The v0.9 line consolidated the platform into something that could
credibly replace a live DokuWiki installation. Milestone-level work:

### Reviewflow (author / reviewer / validator)

- Reviewflow directive with configurable roles and version tags.
- X.509 signing pipeline with per-user certificates issued from a
  company CA; certificate revocation with cascade.
- Observers: named accounts that see draft states without being in
  the review chain.
- Version history recorded per validated version; version links
  (`{version-link}`, `{reviewflow-link}`) resolve to stable snapshots.
- Todo integration: reviewflow assignments become todos.

### AI integration

- AI Content API: token-authenticated read/write endpoints with
  rate limiting and `require_summary` enforcement.
- MCP server (Model Context Protocol) exposing page, database,
  attachment, and (in v1.0.0-rc.1) draft-session tools over
  Streamable HTTP. Same ACL as the HTTP API, with an additional
  `@ai` subject check on every tool call.
- Integrated AI assistant (browser-side, server-proxied) with quick
  actions and per-page context.
- HTML rendering endpoint for AI check paths.

### Collaboration

- WebSocket presence (`/api/ws/collab`): live badges showing who is
  viewing / editing each page.
- Co-edition: multiple users on the same draft, backed by Yjs.
- Draft reclaim on stale/crashed sessions (raw-edit escape hatch,
  admin override, and now presence-gated takeover).
- Persistent error messages so a lost network doesn't hide state.

### Structured data — polish

- Database types (image, tag, user, lookup) with nested filtering.
- Inline row editing with conflict detection versus draft edits.
- Row-bound pages: restoring a page updates its bound row.
- Row-name indexing so bound pages can address rows by name.
- Database queries with vertical text, cell colours, and column
  alignment properties.
- Import: DokuWiki `struct` blocks converted to database tables +
  rows, with status/tag migration.

### Extended tables

- Formulas (spreadsheet-style, with `ABOVE`/`LEFT` ranges).
- Column properties: colour, alignment, width, decimals, vertical
  align — properties travel with columns when the column is moved.
- Cell merging (`<<`, `^^`) with menu entries.
- Vertical text and vertical align, including inside merged cells.
- Backticks protect cell content from directive/formula parsing.

### Templates and variables

- Multiple templates per page family; per-template variable defaults.
- Template stamping with reviewflow version pinning.
- Global variables and immediate rendering.

### Blocks and content

- Slides plugin (`{slide}` blocks with themes).
- Charts plugin (Chart.js) and mermaid diagrams; both support
  captions and PDF export.
- Bibliography (PubMed integration with API key).
- Spoilers (folded content).
- Multi-image figures with `image-width` and wrap properties on
  blockquotes.
- Footnotes (inline `^[…]` and referenced).
- Comments plugin: threaded, replies, anchoring to selection ranges;
  survives edits and remains visible on database-query rows.

### Site and platform

- Theming: light / dark modes with per-user override (allowed by
  admin) and code-block themes that follow the site theme.
- PDF export via headless Chrome (chromedp).
- Sitemap with folder/leaf distinction; forbidden pages honoured.
- Todos plugin with assignments, email notifications, per-page
  todo lists, admin panel.
- Backlinks index.
- Tags with query, exclusion, groupby, clickable rendering.
- OAuth Azure AD + group syncing.
- Persistent sessions with `Secure` cookies on HTTPS.
- Canonical page paths: leading `/`, trailing `/` for namespace
  indexes, `/index` never appears — enforced everywhere in the API.
- `@self` ACL subject.
- DokuWiki importer with users + ACLs, code-block conversion,
  monoline tables, reviewflow validation migration, UTF-8 picker,
  fallback-admin option.

## [0.8] — 2026-02 → 2026-03

Feature-completeness for a documentation wiki.

- PDF export.
- Sitemap and site map plugin.
- Tags plugin (`{tag}`, `{tag-query}`) with page/namespace guarding.
- Numbered headings (`## 1. Title`) surfacing in the TOC.
- Todo plugin (`{todo}`, `{todo-list}`) with target/assignee checks.
- Extended tables (formulas + cell merging).
- Templates fully working (variables, insertion).
- Reviewflow (initial cut, later matured in 0.9).
- Latest-change and backlinks plugins.
- Move plugin: page rename with link updates.
- OAuth (Azure) provider working with group sync.

## [0.7] — 2026-01

Structured data.

- Database plugin: schema store, data store, and `{database-row}` +
  `{database-query}` directives.
- Inline editing with edit-vs-draft conflict handling.
- Row-bound pages: restore a page → table row updates too.
- Property panels for database node types.

## [0.6] — late 2025

Admin and access control.

- Admin UI: users, groups, ACL, configuration, tokens.
- Local authentication with password hashing.
- Multi-provider ACL model.
- Media versioning (downloads and edit-session competition).
- Locks: same-user competing edits handled cleanly.
- Icons for download links, filename spaces supported.

## [0.5] — late 2025

Page history and drafts.

- Attic-backed page history with per-version storage.
- Rollback / restore-from-history flow.
- Drafts: durable per-user drafts with edit tokens.
- Publish / discard / auto-save cycle validated.
- History diff view (compact and side-by-side).

## [0.4] — mid 2025

Editing robustness.

- Copy/paste dialect enforcement in visual mode.
- Round-trip validation gate on save (serialize → parse → serialize).
- Blockquote wraps.
- Image resize, insertion, and copy/paste of large images.

## [0.3] — mid 2025

Search and syntax highlighting.

- Full-text search: incremental, typo-tolerant (Bleve).
- Language-specific code-block highlighting (highlight.js).
- Instant language change; language detection.
- Banner / header polish.

## [0.2] — mid 2025

Site-level consistency.

- Reference tracking (page → media map, updated on every write).
- Orphan detection.
- Nested includes with circular-include forbidden.

## [0.1] — early 2025

Single-page correctness.

- Editor foundation on ProseMirror with a bijective Markdown dialect.
- Save / reload cycle validated.
- Sidebar, footer, and included content rendered as read-only zones.
- Raw and visual edit modes with the same underlying document.
- Line breaks (soft, hard, Alt-Enter).
- Links (internal and external, external opens in new tab with icon).
- Tables (pipe syntax with directives).
- Media manager (upload, insert, downloadable link).
- Images with size property + drag-resize.
- Code blocks with tab/shift-tab indentation.
- Include directive.
- Property panels for image, table, include nodes.

---

[Unreleased]: /
[1.0.0-rc.4]: /
[1.0.0-rc.3]: /
[1.0.0-rc.2]: /
[1.0.0-rc.1]: /
