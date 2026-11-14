package mcpserver

import (
	"context"
	"fmt"
	"strings"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"

	"sargon/backend/internal/storage"
)

// editSpec is one anchored find-and-replace, parsed from the tool call's
// `edits` array.
type editSpec struct {
	Old        string
	New        string
	ReplaceAll bool
}

// trimHunksToContext filters a DiffLines() output to keep only non-equal
// hunks plus up to N equal hunks around each change. Returns the filtered
// slice and the count of equal hunks that were dropped, so the caller can
// report "and X more unchanged lines omitted" to the agent.
//
// When contextLines <= 0 the input is returned as-is (full diff, 0 omitted).
func trimHunksToContext(hunks []storage.DiffHunk, contextLines int) ([]storage.DiffHunk, int) {
	if contextLines <= 0 || len(hunks) == 0 {
		return hunks, 0
	}
	keep := make([]bool, len(hunks))
	for i, h := range hunks {
		if h.Op == "equal" {
			continue
		}
		lo := i - contextLines
		if lo < 0 {
			lo = 0
		}
		hi := i + contextLines
		if hi > len(hunks)-1 {
			hi = len(hunks) - 1
		}
		for j := lo; j <= hi; j++ {
			keep[j] = true
		}
	}
	out := make([]storage.DiffHunk, 0, len(hunks))
	omitted := 0
	for i, h := range hunks {
		if keep[i] {
			out = append(out, h)
			continue
		}
		if h.Op == "equal" {
			omitted++
		}
	}
	return out, omitted
}

// applyEdits walks edits in order, applying each one to `content` and
// returning the resulting buffer. The uniqueness rule is what makes this
// tool safe without line numbers: `old` must occur exactly once, unless the
// caller opted into `replace_all`. Any violation aborts the whole operation
// so a partially-applied edit can never reach the store.
func applyEdits(content string, edits []editSpec) (string, []map[string]any, error) {
	summary := make([]map[string]any, 0, len(edits))
	buf := content
	for i, e := range edits {
		if e.Old == "" {
			return "", nil, fmt.Errorf("edit %d: old must be non-empty (an empty anchor would match everywhere)", i)
		}
		occurrences := strings.Count(buf, e.Old)
		if occurrences == 0 {
			preview := e.Old
			if len(preview) > 60 {
				preview = preview[:57] + "…"
			}
			return "", nil, fmt.Errorf("edit %d: old not found in page — first 60 chars: %q", i, preview)
		}
		if occurrences > 1 && !e.ReplaceAll {
			preview := e.Old
			if len(preview) > 60 {
				preview = preview[:57] + "…"
			}
			return "", nil, fmt.Errorf("edit %d: old appears %d times — pass replace_all: true to modify every occurrence, or lengthen the anchor to make it unique — first 60 chars: %q", i, occurrences, preview)
		}

		var replaced int
		if e.ReplaceAll {
			replaced = occurrences
			buf = strings.ReplaceAll(buf, e.Old, e.New)
		} else {
			replaced = 1
			buf = strings.Replace(buf, e.Old, e.New, 1)
		}
		summary = append(summary, map[string]any{
			"index":        i,
			"old_len":      len(e.Old),
			"new_len":      len(e.New),
			"replacements": replaced,
		})
	}
	return buf, summary, nil
}

// ── edit_page ──────────────────────────────────────────────────────────────

func registerEditPageTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("edit_page",
		mcpgo.WithDescription(
			"Apply one or more anchored search-and-replace edits to a page. "+
				"Preferred over write_page for any change smaller than a full rewrite — "+
				"the edit set is self-locating (no line numbers) and self-validating "+
				"(uniqueness constraint), so a cosmetic tweak on a long regulatory page "+
				"cannot silently corrupt content outside the intended region.\n\n"+
				"Rules per edit `{old, new, replace_all?}`:\n"+
				"  • `old` must be non-empty and occur exactly once in the current buffer.\n"+
				"  • If `old` occurs zero times: refused (the anchor is wrong or already applied).\n"+
				"  • If `old` occurs 2+ times without `replace_all: true`: refused (ambiguous).\n"+
				"  • With `replace_all: true`, every occurrence is replaced.\n"+
				"  • Edits apply in array order, each on the buffer produced by the previous edit.\n"+
				"\n"+
				"Atomicity: if any single edit fails validation, the whole call is refused "+
				"and no version is written. Same permission gate as write_page (caller + @ai "+
				"edit permission). Optimistic locking via expected_version is honored. "+
				"Pass dry_run: true to see the resulting diff without writing.",
		),
		mcpgo.WithString("path", mcpgo.Required(),
			mcpgo.Description("Page path (leading slash optional). Namespace indexes end with '/'."),
		),
		mcpgo.WithArray("edits", mcpgo.Required(),
			mcpgo.Description("Array of edits, each a JSON object with keys `old` (required string), `new` (required string), and optional `replace_all` (boolean, default false). Edits apply sequentially."),
		),
		mcpgo.WithString("summary", mcpgo.Required(),
			mcpgo.Description("Change summary. Required for audit. Format: '[AI: <tool-name>] <description>'."),
		),
		mcpgo.WithNumber("expected_version",
			mcpgo.Description("Optional optimistic lock. If set, the edit fails when the current page version differs."),
		),
		mcpgo.WithBoolean("dry_run",
			mcpgo.Description("If true, validate all edits and return the resulting diff without saving. Default false."),
		),
		mcpgo.WithNumber("context",
			mcpgo.Description("For dry_run only: number of unchanged lines to keep around each change (like diff -U<N>). Default 0 returns the whole diff — appropriate for tiny pages, but a long page with a single-line change produces a huge equal-hunk tail. Pass e.g. 3 to keep only changes plus 3 lines of surrounding context; the number of omitted equal lines is returned as `diff.context_omitted`."),
		),
		mcpgo.WithBoolean("force",
			mcpgo.Description(
				"Bypass the fully-validated-page guard. Default false: an edit to a page that reviewflow considers fully validated (every role's signature is on the current version) is refused, because the edit would invalidate all signatures. Pass force=true when the change is deliberate and the reviewers will re-sign. Ignored when the page has no reviewflow directive."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Store == nil {
			return errorResult("page store not available"), nil
		}
		pagePath := canonicalPageArg(req.GetString("path", ""))
		if pagePath == "" {
			return errorResult("path is required"), nil
		}
		summary := strings.TrimSpace(req.GetString("summary", ""))
		if deps.RequireSummary && summary == "" {
			return errorResult("summary is required — format '[AI: <tool>] <description>'"), nil
		}
		expectedVersion := int64(req.GetInt("expected_version", 0))
		dryRun := req.GetBool("dry_run", false)
		force := req.GetBool("force", false)
		contextLines := req.GetInt("context", 0)
		if contextLines < 0 {
			contextLines = 0
		}

		// Parse edits array.
		args := req.GetArguments()
		rawEdits, ok := args["edits"].([]any)
		if !ok || len(rawEdits) == 0 {
			return errorResult("edits must be a non-empty array of {old, new, replace_all?} objects"), nil
		}
		edits := make([]editSpec, 0, len(rawEdits))
		for i, raw := range rawEdits {
			obj, ok := raw.(map[string]any)
			if !ok {
				return errorResult(fmt.Sprintf("edit %d: not a JSON object", i)), nil
			}
			oldStr, hasOld := obj["old"].(string)
			newStr, hasNew := obj["new"].(string)
			if !hasOld || !hasNew {
				return errorResult(fmt.Sprintf("edit %d: `old` and `new` are both required and must be strings", i)), nil
			}
			replaceAll, _ := obj["replace_all"].(bool)
			edits = append(edits, editSpec{Old: oldStr, New: newStr, ReplaceAll: replaceAll})
		}

		if !deps.canEdit(ctx, pagePath) {
			return errorResult("edit permission denied"), nil
		}

		// Fully-validated-page guard: refuse edits that would silently
		// invalidate every signature unless the caller opted in with
		// force=true. dry_run skips the guard so an agent can still
		// preview what an edit WOULD do without touching the page.
		if !dryRun {
			if refusal := refuseIfValidatedWithoutForce(deps.reviewflowGetter(), pagePath, force); refusal != nil {
				return refusal, nil
			}
		}

		// Draft-lock guard, same as write_page — refuse when someone else is
		// editing the page interactively to avoid clobbering their in-flight
		// work.
		if deps.DraftState != nil {
			if lock := deps.DraftState.GetLock(pagePath); lock.Owner != "" {
				return errorResult(fmt.Sprintf(
					"page is locked by %s (since %s) — wait for them to finish editing before editing",
					lock.Owner, lock.Since,
				)), nil
			}
			if draft, ok := deps.DraftState.FindAnyDraft(pagePath); ok {
				return errorResult(fmt.Sprintf(
					"page has an unpublished draft by %s (since %s) — wait for it to be published or discarded before editing",
					draft.Owner, draft.Since,
				)), nil
			}
		}

		page, err := deps.Store.Get(pagePath)
		if err != nil {
			return errorResult("read page: " + err.Error()), nil
		}
		if expectedVersion > 0 && page.Meta.Version != expectedVersion {
			return errorResult(fmt.Sprintf(
				"version conflict: page is at %d, expected %d — re-read before editing",
				page.Meta.Version, expectedVersion,
			)), nil
		}

		newMarkdown, editSummaries, err := applyEdits(page.Markdown, edits)
		if err != nil {
			return errorResult(err.Error()), nil
		}
		if newMarkdown == page.Markdown {
			return jsonResult(map[string]any{
				"path":    pagePath,
				"version": page.Meta.Version,
				"edits":   editSummaries,
				"noop":    true,
			}), nil
		}

		hunks := storage.DiffLines(page.Markdown, newMarkdown)
		added, removed := 0, 0
		for _, h := range hunks {
			switch h.Op {
			case "insert":
				added++
			case "delete":
				removed++
			}
		}

		if dryRun {
			trimmedHunks, omittedEqual := trimHunksToContext(hunks, contextLines)
			diff := map[string]any{
				"added":   added,
				"removed": removed,
				"hunks":   trimmedHunks,
			}
			if contextLines > 0 {
				diff["context_lines"] = contextLines
				diff["context_omitted"] = omittedEqual
			}
			return jsonResult(map[string]any{
				"dry_run": true,
				"path":    pagePath,
				"version": page.Meta.Version,
				"edits":   editSummaries,
				"diff":    diff,
			}), nil
		}

		username := deps.ExtractUsername(ctx)
		// Keep author and summary separate — see server.go PageStore
		// comment on why PutWithSummary is the right call for the
		// MCP write surfaces.
		result, err := deps.Store.PutWithSummary(pagePath, newMarkdown, username, summary)
		if err != nil {
			return errorResult("write failed: " + err.Error()), nil
		}
		return jsonResult(map[string]any{
			"path":    pagePath,
			"version": result.Page.Meta.Version,
			"edits":   editSummaries,
			"diff": map[string]any{
				"added":   added,
				"removed": removed,
			},
		}), nil
	})
}
