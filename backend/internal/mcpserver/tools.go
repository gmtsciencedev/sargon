package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"

	"sargon/backend/internal/auth"
	"sargon/backend/internal/database"
	"sargon/backend/internal/markdown"
	"sargon/backend/internal/reviewflow"
	"sargon/backend/internal/storage"
	"sargon/backend/internal/todo"
)

func registerTools(srv *mcpsrv.MCPServer, deps Deps) {
	registerConventionsTool(srv, deps)
	registerListNamespaceTool(srv, deps)
	registerReadPagesBatchTool(srv, deps)
	registerGetPageMetaTool(srv, deps)
	registerSearchPagesTool(srv, deps)
	registerGetReviewflowStatusTool(srv, deps)
	registerListReviewflowsTool(srv, deps)
	registerListBrokenLinksTool(srv, deps)
	registerPreviewPageDiffTool(srv, deps)
	registerWritePageTool(srv, deps)
	registerListTodosTool(srv, deps)
	registerCompleteTodoTool(srv, deps)
	registerListDatabaseTablesTool(srv, deps)
	registerQueryDatabaseRowsTool(srv, deps)
	registerListPageHistoryTool(srv, deps)
	registerReadPageVersionTool(srv, deps)
	registerListRecentChangesTool(srv, deps)
	registerDiffPageVersionsTool(srv, deps)
	registerCreateDatabaseTableTool(srv, deps)
	registerCreateDatabaseFieldTool(srv, deps)
	registerUpdateDatabaseTableTool(srv, deps)
	registerUpdateDatabaseFieldTool(srv, deps)
	registerDeleteDatabaseFieldTool(srv, deps)
	registerMovePageTool(srv, deps)
	registerConvertToNamespaceIndexTool(srv, deps)
	registerConvertToRegularPageTool(srv, deps)
	registerInsertDatabaseRowTool(srv, deps)
	registerUpdateDatabaseRowTool(srv, deps)
	registerDeleteDatabaseRowTool(srv, deps)
	registerDeletePageTool(srv, deps)
	registerEditPageTool(srv, deps)
	registerListAttachmentsTool(srv, deps)
	registerListPageCommentsTool(srv, deps)
	registerReadAttachmentTool(srv, deps)
	registerUploadAttachmentTool(srv, deps)
	registerUploadAttachmentInstructionsTool(srv, deps)
	registerDeleteAttachmentTool(srv, deps)
	registerCreatePageFromTemplateTool(srv, deps)
	registerRenderPageTool(srv, deps)
	registerExportPagePDFTool(srv, deps)
	registerEnterEditSessionTool(srv, deps)
	registerSaveEditDraftTool(srv, deps)
	registerReadEditDraftTool(srv, deps)
	registerPublishEditDraftTool(srv, deps)
	registerDiscardEditDraftTool(srv, deps)
}

// ── ACL helpers ─────────────────────────────────────────────────────────

// canView enforces the dual-ACL model: the authenticated user plus the @ai
// pseudo-subject must both have view permission on the page.
func (d Deps) canView(ctx context.Context, pagePath string) bool {
	if d.ACL == nil {
		return true
	}
	username := d.ExtractUsername(ctx)
	aclPath := "/" + strings.TrimPrefix(pagePath, "/")
	if !d.ACL.CheckPermission(username, d.effectiveGroups(username), aclPath, "view") {
		return false
	}
	return d.ACL.CheckAIPermission(aclPath, "view")
}

// canEdit mirrors canView but for edit permission.
func (d Deps) canEdit(ctx context.Context, pagePath string) bool {
	if d.ACL == nil {
		return true
	}
	username := d.ExtractUsername(ctx)
	aclPath := "/" + strings.TrimPrefix(pagePath, "/")
	if !d.ACL.CheckPermission(username, d.effectiveGroups(username), aclPath, "edit") {
		return false
	}
	return d.ACL.CheckAIPermission(aclPath, "edit")
}

func (d Deps) effectiveGroups(username string) []string {
	if username == "" || d.UserStore == nil {
		return nil
	}
	u, err := d.UserStore.Get(username)
	if err != nil {
		return nil
	}
	return u.EffectiveGroups()
}

// jsonResult marshals v to JSON and wraps it as an MCP text result.
func jsonResult(v any) *mcpgo.CallToolResult {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return errorResult("internal: failed to marshal response: " + err.Error())
	}
	return textResult(string(b))
}

// reviewflowStatusGetter is the minimum subset of reviewflow.Service the
// validated-page guard needs. Split out so tests can drive the guard
// with a fake that returns a canned Status.
type reviewflowStatusGetter interface {
	GetStatus(pagePath string) (*reviewflow.Status, error)
}

// refuseIfValidatedWithoutForce is the "don't invalidate signatures by
// accident" gate shared by edit_page and write_page. When the target
// page is fully validated by reviewflow, both tools refuse unless the
// caller passed force=true — the writer opted in with eyes open. The
// error names the signed roles so the LLM can surface the actual cost
// (whose signature will disappear) to the human before retrying.
//
// Returns nil when the write is allowed to proceed.
// reviewflowGetter returns the reviewflow service as the guard's interface,
// or a nil interface when the deployment has none: a nil *Service wrapped
// in the interface would pass the guard's nil check and panic.
func (d Deps) reviewflowGetter() reviewflowStatusGetter {
	if d.Reviewflow == nil {
		return nil
	}
	return d.Reviewflow
}

func refuseIfValidatedWithoutForce(rf reviewflowStatusGetter, pagePath string, force bool) *mcpgo.CallToolResult {
	if force || rf == nil {
		return nil
	}
	st, err := rf.GetStatus(pagePath)
	if err != nil || st == nil || !st.IsFullyValidated {
		return nil
	}
	signedRoles := make([]string, 0, len(st.Roles))
	for role, user := range st.Roles {
		signedRoles = append(signedRoles, fmt.Sprintf("%s=%s", role, user))
	}
	sort.Strings(signedRoles)
	return errorResult(fmt.Sprintf(
		"page is fully validated by reviewflow (v%d, tag %q): editing will invalidate every signature (%s). "+
			"Pass force=true if the change is intentional and the reviewers will re-sign. "+
			"If the intent was to touch a nearby page instead, double-check the path.",
		st.CurrentPageVer,
		st.VersionTag,
		strings.Join(signedRoles, ", "),
	))
}

// ── get_conventions ─────────────────────────────────────────────────────

func registerConventionsTool(srv *mcpsrv.MCPServer, _ Deps) {
	tool := mcpgo.NewTool("get_conventions",
		mcpgo.WithDescription(
			"Return the Sargon Markdown dialect rules, content guidelines, and write conventions. "+
				"CALL THIS BEFORE your first content read or write — the dialect rejects several common "+
				"CommonMark constructs (underscore is underline, not italic; * is not a list marker; raw HTML is forbidden).",
		),
	)
	srv.AddTool(tool, func(_ context.Context, _ mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		return jsonResult(conventionsPayload()), nil
	})
}

// ── list_namespace ──────────────────────────────────────────────────────

func registerListNamespaceTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("list_namespace",
		mcpgo.WithDescription(
			"List the pages and sub-namespaces under a given namespace path. "+
				"Use depth=0 for a recursive listing, depth=1 for direct children only.",
		),
		mcpgo.WithString("path",
			mcpgo.Description("Namespace path, leading slash optional. Empty or '/' lists the root."),
		),
		mcpgo.WithNumber("depth",
			mcpgo.Description("1 = direct children only (default). 0 = unlimited recursion."),
		),
		mcpgo.WithBoolean("include_meta",
			mcpgo.Description("Include version, last_modified, author for each page."),
		),
		mcpgo.WithBoolean("include_comments",
			mcpgo.Description(
				"Include the count of unresolved top-level comment threads on each page ("+
					"open_comments field). Cheap: comments live in a per-page sidecar file "+
					"that is only opened when the page has ever had a comment.",
			),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Sitemap == nil {
			return errorResult("namespace listing not available"), nil
		}
		nsPath := strings.Trim(req.GetString("path", ""), "/")
		depth := req.GetInt("depth", 1)
		includeMeta := req.GetBool("include_meta", false)
		includeComments := req.GetBool("include_comments", false)

		allPages, err := deps.Sitemap.ListAllPages()
		if err != nil {
			return errorResult("list pages: " + err.Error()), nil
		}

		prefix := nsPath
		if prefix != "" {
			prefix += "/"
		}

		type pageInfo struct {
			Path         string `json:"path"`
			Title        string `json:"title"`
			Version      int64  `json:"version,omitempty"`
			LastModified string `json:"last_modified,omitempty"`
			Author       string `json:"author,omitempty"`
			OpenComments int    `json:"open_comments,omitempty"`
		}
		type nsInfo struct {
			Path      string `json:"path"`
			PageCount int    `json:"page_count"`
		}

		pages := []pageInfo{}
		nsCounts := map[string]int{}

		for _, p := range allPages {
			pagePath := strings.TrimPrefix(p.Path, "/")
			if prefix != "" && !strings.HasPrefix(pagePath, prefix) {
				continue
			}
			rel := strings.TrimPrefix(pagePath, prefix)

			if !deps.canView(ctx, pagePath) {
				continue
			}

			if depth == 1 && strings.Contains(rel, "/") {
				parts := strings.SplitN(rel, "/", 2)
				nsName := prefix + parts[0]
				nsCounts[nsName]++
				continue
			}

			pi := pageInfo{Path: "/" + pagePath, Title: p.Title}
			if includeMeta && deps.Store != nil {
				if page, err := deps.Store.Get(pagePath); err == nil {
					pi.Version = page.Meta.Version
					pi.LastModified = page.Meta.UpdatedAt.Format(time.RFC3339)
					pi.Author = page.Meta.Author
				}
			}
			if includeComments && deps.Comments != nil {
				// Pass the canonical page path (leading slash, plus the
				// trailing slash the sitemap already carries on ns-indexes)
				// so the comment store sees the same shape as the API.
				pi.OpenComments = deps.Comments.CountOpenThreads(p.Path)
			}
			pages = append(pages, pi)
		}

		namespaces := []nsInfo{}
		for ns, count := range nsCounts {
			namespaces = append(namespaces, nsInfo{Path: "/" + ns, PageCount: count})
		}

		return jsonResult(map[string]any{
			"namespace":  "/" + nsPath,
			"pages":      pages,
			"namespaces": namespaces,
		}), nil
	})
}

// ── read_pages_batch ────────────────────────────────────────────────────

func registerReadPagesBatchTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("read_pages_batch",
		mcpgo.WithDescription(
			"Read up to 20 pages in a single call. Returns the raw Markdown, title, and current version for each. "+
				"Always prefer this over multiple single-page reads.",
		),
		mcpgo.WithArray("paths",
			mcpgo.Required(),
			mcpgo.Description("Page paths (leading slash optional). Maximum 20."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		paths := req.GetStringSlice("paths", nil)
		if len(paths) == 0 {
			return errorResult("paths is required"), nil
		}
		if len(paths) > 20 {
			return errorResult("maximum 20 paths per batch"), nil
		}
		if deps.Store == nil {
			return errorResult("page store not available"), nil
		}

		type pageResult struct {
			Path     string `json:"path"`
			Title    string `json:"title,omitempty"`
			Markdown string `json:"markdown,omitempty"`
			Version  int64  `json:"version,omitempty"`
			OK       bool   `json:"ok"`
			Error    string `json:"error,omitempty"`
		}

		results := make([]pageResult, len(paths))
		for i, p := range paths {
			pagePath := strings.Trim(p, "/")
			results[i].Path = p

			if !deps.canView(ctx, pagePath) {
				results[i].Error = "access denied"
				continue
			}

			page, err := deps.Store.Get(pagePath)
			if err != nil {
				results[i].Error = "page not found"
				continue
			}
			results[i].OK = true
			results[i].Title = markdown.ExtractTitle(page.Markdown)
			results[i].Markdown = page.Markdown
			results[i].Version = page.Meta.Version
		}

		return jsonResult(map[string]any{"pages": results}), nil
	})
}

// ── get_page_meta ───────────────────────────────────────────────────────

func registerGetPageMetaTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("get_page_meta",
		mcpgo.WithDescription(
			"Return structured metadata for a page: title, version, last_modified, author, tags, backlinks, reviewflow status, "+
				"and edit state. If a `lock` field is present, a user is actively editing the page; if a `draft` field is "+
				"present, unpublished work exists (lock and draft are independent — drafts can outlive their lock). "+
				"write_page will refuse while either is present.",
		),
		mcpgo.WithString("path",
			mcpgo.Required(),
			mcpgo.Description("Page path, leading slash optional."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		pagePath := strings.TrimSpace(req.GetString("path", ""))
		pagePath = strings.TrimPrefix(pagePath, "/")
		if strings.TrimSpace(req.GetString("path", "")) == "" {
			return errorResult("path is required"), nil
		}
		if !deps.canView(ctx, pagePath) {
			return errorResult("access denied"), nil
		}
		if deps.Store == nil {
			return errorResult("page store not available"), nil
		}
		page, err := deps.Store.Get(pagePath)
		if err != nil {
			return errorResult("page not found"), nil
		}

		resp := map[string]any{
			"path":          "/" + pagePath,
			"title":         markdown.ExtractTitle(page.Markdown),
			"version":       page.Meta.Version,
			"last_modified": page.Meta.UpdatedAt,
			"author":        page.Meta.Author,
		}
		if deps.TagIndex != nil {
			resp["tags"] = deps.TagIndex.GetTagsForPage(path.Clean("/" + pagePath))
		}
		if deps.Backlinks != nil {
			resp["backlinks"] = deps.Backlinks.GetBacklinks(pagePath)
		}
		if deps.Reviewflow != nil {
			if status, err := deps.Reviewflow.GetStatus(pagePath); err == nil && status != nil {
				resp["reviewflow"] = status
			}
		}
		if deps.DraftState != nil {
			if lock := deps.DraftState.GetLock(pagePath); lock.Owner != "" {
				resp["lock"] = map[string]any{
					"owner": lock.Owner,
					"since": lock.Since,
				}
			}
			if draft, ok := deps.DraftState.FindAnyDraft(pagePath); ok {
				resp["draft"] = map[string]any{
					"owner": draft.Owner,
					"since": draft.Since,
				}
			}
		}
		return jsonResult(resp), nil
	})
}

// ── search_pages ────────────────────────────────────────────────────────

func registerSearchPagesTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("search_pages",
		mcpgo.WithDescription(
			"Search wiki pages. Three modes:\n"+
				"  • `query` — full-text search (typo-tolerant, ranked, returns snippets). "+
				"Human-oriented: good for 'find me the page about X'.\n"+
				"  • `pattern` — RE2 regex scanned across every page's markdown, grep-style. "+
				"Agent-oriented: exact substrings / structured directives are found reliably, "+
				"no fuzzy ranking. Returns one row per occurrence with path + line + column + "+
				"the matching text + the full line as context. Response includes "+
				"`scan_complete` (true iff every eligible page was walked), `eligible_pages` "+
				"(the universe size), and `total_matches` (the number collected before any cap) "+
				"so a caller can tell at a glance whether the result is partial. "+
				"Pass `count_only=true` for a cheap end-to-end count: scans every eligible "+
				"page regardless of `limit` and returns one `{path, count}` row per matching "+
				"page, no bodies — the right choice when the question is 'how many pages / "+
				"how many hits' rather than 'show me the hits'.\n"+
				"  • `tag` — list every page bearing a given tag. Composable with `query` "+
				"(narrows tag results by path/title substring) OR with `pattern` "+
				"(narrows the regex scan to tagged pages).\n"+
				"At least one of `query`, `pattern`, or `tag` is required. All results respect "+
				"the caller's ACL.",
		),
		mcpgo.WithString("query",
			mcpgo.Description("Full-text query string. Typo-tolerant. Mutually exclusive with `pattern`."),
		),
		mcpgo.WithString("pattern",
			mcpgo.Description(
				"RE2 regex (Go's regexp syntax) matched against every page's raw markdown. "+
					"Use for exact substrings (plain text is a valid regex), named directives "+
					"(e.g. `\\{template-stamp\\}`), or structural patterns. "+
					"Mutually exclusive with `query`."),
		),
		mcpgo.WithString("tag",
			mcpgo.Description("Tag name to filter by. When set alone, returns pages from the tag index. Composable with `query` or `pattern` to narrow the scope."),
		),
		mcpgo.WithString("path_prefix",
			mcpgo.Description("For `pattern` mode: namespace prefix to scope the scan (leading slash optional). Empty scans the whole wiki."),
		),
		mcpgo.WithBoolean("case_sensitive",
			mcpgo.Description("For `pattern` mode: default true. False wraps the pattern in `(?i)`."),
		),
		mcpgo.WithNumber("max_per_page",
			mcpgo.Description("For `pattern` mode: cap matches reported per page (0 = unlimited, default 0). The overall `limit` still applies across pages."),
		),
		mcpgo.WithBoolean("count_only",
			mcpgo.Description("For `pattern` mode: scan every eligible page regardless of `limit` and return one `{path, count}` row per page that matches, no bodies. Fast end-to-end — the right choice when the question is \"how many pages / how many hits\" rather than \"show me the hits\"."),
		),
		mcpgo.WithNumber("limit",
			mcpgo.Description("Maximum results (query/tag: default 20, max 100; pattern: default 50, max 500). Ignored in `count_only` mode."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		query := strings.TrimSpace(req.GetString("query", ""))
		pattern := strings.TrimSpace(req.GetString("pattern", ""))
		tag := strings.TrimSpace(req.GetString("tag", ""))
		if query == "" && pattern == "" && tag == "" {
			return errorResult("one of 'query', 'pattern' or 'tag' must be provided"), nil
		}
		if query != "" && pattern != "" {
			return errorResult("'query' and 'pattern' are mutually exclusive"), nil
		}

		// Pattern (grep) branch — handled before tag because tag can
		// narrow it as a scope filter.
		if pattern != "" {
			limit := req.GetInt("limit", 50)
			if limit < 1 {
				limit = 50
			}
			if limit > 500 {
				limit = 500
			}
			maxPerPage := req.GetInt("max_per_page", 0)
			if maxPerPage < 0 {
				maxPerPage = 0
			}
			caseSensitive := req.GetBool("case_sensitive", true)
			prefix := strings.Trim(req.GetString("path_prefix", ""), "/")
			raw := pattern
			if !caseSensitive {
				raw = "(?i)" + raw
			}
			re, err := regexp.Compile(raw)
			if err != nil {
				return errorResult("invalid pattern: " + err.Error()), nil
			}
			if deps.Sitemap == nil || deps.Store == nil {
				return errorResult("page corpus not available"), nil
			}
			// Scope: either the tag-filtered set or the whole sitemap.
			var paths []string
			if tag != "" {
				if deps.TagIndex == nil {
					return errorResult("tag index not available"), nil
				}
				entries := deps.TagIndex.GetPagesForTag(tag, "", nil)
				paths = make([]string, 0, len(entries))
				for _, e := range entries {
					paths = append(paths, e.Path)
				}
			} else {
				all, err := deps.Sitemap.ListAllPages()
				if err != nil {
					return errorResult("list pages: " + err.Error()), nil
				}
				paths = make([]string, 0, len(all))
				for _, p := range all {
					paths = append(paths, p.Path)
				}
			}
			countOnly := req.GetBool("count_only", false)
			res := grepPages(grepScanArgs{
				pages:      paths,
				prefix:     prefix,
				re:         re,
				limit:      limit,
				maxPerPage: maxPerPage,
				countOnly:  countOnly,
				canView:    func(p string) bool { return deps.canView(ctx, p) },
				getMarkdown: func(p string) (string, error) {
					page, err := deps.Store.Get(strings.TrimPrefix(p, "/"))
					if err != nil {
						return "", err
					}
					return page.Markdown, nil
				},
			})
			envelope := map[string]any{
				"pattern":        pattern,
				"path_prefix":    "/" + prefix,
				"scanned":        res.Scanned,
				"skipped_access": res.SkippedAccess,
				"eligible_pages": res.EligiblePages,
				"total_matches":  res.TotalMatches,
				"scan_complete":  res.ScanComplete,
			}
			if countOnly {
				envelope["match_counts"] = res.MatchCounts
				envelope["count_only"] = true
			} else {
				envelope["matches"] = res.Matches
				// Legacy name kept for clients that already read it;
				// scan_complete is the new, unambiguous signal.
				envelope["truncated_at_limit"] = res.TruncatedAtCap
			}
			return jsonResult(envelope), nil
		}

		limit := req.GetInt("limit", 20)
		if limit < 1 {
			limit = 20
		}
		if limit > 100 {
			limit = 100
		}

		// Tag branch: take pages from the tag index, narrow by query if both are set.
		if tag != "" {
			if deps.TagIndex == nil {
				return errorResult("tag index not available"), nil
			}
			entries := deps.TagIndex.GetPagesForTag(tag, "", nil)
			needle := strings.ToLower(query)
			out := make([]map[string]any, 0, len(entries))
			for _, e := range entries {
				if !deps.canView(ctx, e.Path) {
					continue
				}
				if needle != "" {
					if !strings.Contains(strings.ToLower(e.Path), needle) &&
						!strings.Contains(strings.ToLower(e.Title), needle) {
						continue
					}
				}
				out = append(out, map[string]any{
					"path":  e.Path,
					"title": e.Title,
				})
				if len(out) >= limit {
					break
				}
			}
			return jsonResult(map[string]any{"results": out, "tag": tag}), nil
		}

		// Full-text branch.
		if deps.Search == nil {
			return errorResult("search not available"), nil
		}
		results, err := deps.Search.Search(query, limit)
		if err != nil {
			return errorResult("search failed: " + err.Error()), nil
		}
		filtered := results[:0]
		for _, r := range results {
			if deps.canView(ctx, r.Path) {
				filtered = append(filtered, r)
			}
		}
		return jsonResult(map[string]any{"results": filtered}), nil
	})
}

// grepMatch is one occurrence in the grep (pattern) response.
type grepMatch struct {
	Path     string `json:"path"`
	Line     int    `json:"line"`      // 1-indexed
	Column   int    `json:"column"`    // 1-indexed, byte offset in the line
	Match    string `json:"match"`     // the exact substring the regex matched
	LineText string `json:"line_text"` // the full line as context
}

// grepScanArgs bundles the inputs to grepPages so the pure helper can
// be tested without wiring a server.
type grepScanArgs struct {
	pages       []string
	prefix      string
	re          *regexp.Regexp
	limit       int // overall cap across all pages (ignored when countOnly)
	maxPerPage  int // 0 = unlimited (ignored when countOnly)
	countOnly   bool
	canView     func(pagePath string) bool
	getMarkdown func(pagePath string) (string, error)
}

// grepPageCount is one row of the count_only response: a page and the
// number of regex matches it contains. Pages with zero matches are
// omitted — the result is a compact "pages that hit".
type grepPageCount struct {
	Path  string `json:"path"`
	Count int    `json:"count"`
}

// grepResult is the full response envelope. It bundles counters that
// let the caller detect a mid-scan truncation (ScanComplete==false)
// AND the universe size (EligiblePages) so a scanned<eligible result
// is unambiguous — the old shape made callers believe they'd seen
// every match when the scanner had actually stopped early.
type grepResult struct {
	Matches        []grepMatch     // nil when countOnly
	MatchCounts    []grepPageCount // nil when !countOnly
	Scanned        int             // pages that were actually read
	SkippedAccess  int             // pages ACL-filtered
	EligiblePages  int             // pages in-scope (post-prefix, pre-ACL)
	TotalMatches   int             // sum of per-page counts (countOnly) OR total matches found before any cap
	ScanComplete   bool            // iterator walked every eligible page (no early break)
	TruncatedAtCap bool            // Matches slice was cut off at `limit` (!countOnly only)
}

// grepPages scans every page under `prefix` (empty = all) and reports
// occurrences of the compiled regex. Two modes:
//
//   - Default: fill the Matches slice up to `limit` across the whole
//     scan, at most `maxPerPage` per page. May stop before every page
//     is seen when the overall limit is hit — set ScanComplete=false
//     so the caller can tell.
//   - countOnly==true: scan every page in scope regardless of counts,
//     fill MatchCounts with {path, count} for pages that match. No
//     match bodies, no limit, no early exit. Cheap end-to-end and
//     answers "which pages contain X" completely.
//
// ACL-filtered pages count toward SkippedAccess, not Scanned.
// EligiblePages is set in both modes so the caller can verify "every
// in-scope page was accounted for" without having to recompute the
// prefix filter themselves.
func grepPages(a grepScanArgs) grepResult {
	res := grepResult{
		Matches:      []grepMatch{},
		MatchCounts:  []grepPageCount{},
		ScanComplete: true,
	}
	matchPrefix := a.prefix
	if matchPrefix != "" {
		matchPrefix += "/"
	}
	for _, raw := range a.pages {
		pagePath := strings.TrimPrefix(raw, "/")
		if matchPrefix != "" && !strings.HasPrefix(pagePath, matchPrefix) && pagePath != a.prefix {
			continue
		}
		res.EligiblePages++
		// Default mode respects the limit — once it's hit, we stop
		// walking so a 10,000-page corpus doesn't burn I/O to produce
		// a result the caller only reads the first 50 lines of.
		// countOnly mode intentionally keeps going.
		if !a.countOnly && len(res.Matches) >= a.limit {
			res.ScanComplete = false
			continue
		}
		if a.canView != nil && !a.canView(pagePath) {
			res.SkippedAccess++
			continue
		}
		res.Scanned++
		md, err := a.getMarkdown(pagePath)
		if err != nil {
			continue
		}
		lines := strings.Split(md, "\n")
		pageCount := 0
		pagePerPageCap := a.maxPerPage
		if a.countOnly {
			pagePerPageCap = 0 // uncapped — we want the real total
		}
		for i, line := range lines {
			locs := a.re.FindAllStringIndex(line, -1)
			if locs == nil {
				continue
			}
			for _, loc := range locs {
				if pagePerPageCap > 0 && pageCount >= pagePerPageCap {
					break
				}
				pageCount++
				res.TotalMatches++
				if !a.countOnly {
					res.Matches = append(res.Matches, grepMatch{
						Path:     "/" + pagePath,
						Line:     i + 1,
						Column:   loc[0] + 1,
						Match:    line[loc[0]:loc[1]],
						LineText: line,
					})
					if len(res.Matches) >= a.limit {
						// Hit the overall cap mid-page; the current
						// page's remaining lines aren't scanned.
						// ScanComplete gets flipped on the next
						// iteration when another eligible page is
						// skipped.
						res.TruncatedAtCap = true
						goto nextPage
					}
				}
			}
			if pagePerPageCap > 0 && pageCount >= pagePerPageCap {
				break
			}
		}
	nextPage:
		if a.countOnly && pageCount > 0 {
			res.MatchCounts = append(res.MatchCounts, grepPageCount{
				Path:  "/" + pagePath,
				Count: pageCount,
			})
		}
	}
	return res
}

// ── get_reviewflow_status ───────────────────────────────────────────────

func registerGetReviewflowStatusTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("get_reviewflow_status",
		mcpgo.WithDescription(
			"Return the reviewflow state of a page: configured roles, confirmations on the current page version, and validation status.",
		),
		mcpgo.WithString("path",
			mcpgo.Required(),
			mcpgo.Description("Page path, leading slash optional."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Reviewflow == nil {
			return errorResult("reviewflow service not available"), nil
		}
		pagePath := strings.TrimPrefix(strings.TrimSpace(req.GetString("path", "")), "/")
		if strings.TrimSpace(req.GetString("path", "")) == "" {
			return errorResult("path is required"), nil
		}
		if !deps.canView(ctx, pagePath) {
			return errorResult("access denied"), nil
		}
		status, err := deps.Reviewflow.GetStatus(pagePath)
		if err != nil {
			return errorResult("reviewflow: " + err.Error()), nil
		}
		return jsonResult(status), nil
	})
}

// ── list_reviewflows ────────────────────────────────────────────────────

func registerListReviewflowsTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("list_reviewflows",
		mcpgo.WithDescription(
			"Batch reviewflow status across every page under a path prefix. One row per "+
				"reviewflow-configured page:\n"+
				"  path, is_fully_validated, current_version, validated_version, version_tag,\n"+
				"  parallel, roles (role→assigned user), confirmed_by (role→user that signed),\n"+
				"  missing_roles (role→user still owed), next_roles (actionable now; sequential\n"+
				"  reviews only populate the head of queue, parallel ones populate every missing\n"+
				"  role), signed_roles (roles with cryptographic signatures, not just click-\n"+
				"  through), overdue_roles, awaiting_release (manual_release=yes page that\n"+
				"  nobody has ticked \"Ready for signature\" on yet — no signer is alerted).\n"+
				"Skips pages the caller can't view. Use for corpus-wide compliance passes — the "+
				"single-page get_reviewflow_status would require one MCP call per page and burn "+
				"through the rate limit. The signatory fields answer \"who should sign, who did, "+
				"who still owes\" without a per-page follow-up.",
		),
		mcpgo.WithString("path_prefix",
			mcpgo.Description("Namespace prefix (leading slash optional). Empty scans the whole wiki."),
		),
		mcpgo.WithBoolean("include_unconfigured",
			mcpgo.Description(
				"Also return pages that have no reviewflow directive at all. Default false: "+
					"pages with an empty Roles map are skipped so the result is a compact "+
					"compliance list.",
			),
		),
		mcpgo.WithNumber("limit",
			mcpgo.Description("Maximum rows to return (default 500, max 2000). Sorted by path."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Reviewflow == nil {
			return errorResult("reviewflow service not available"), nil
		}
		if deps.Sitemap == nil {
			return errorResult("namespace listing not available"), nil
		}
		prefix := strings.Trim(req.GetString("path_prefix", ""), "/")
		includeUnconfigured := req.GetBool("include_unconfigured", false)
		limit := req.GetInt("limit", 500)
		if limit < 1 {
			limit = 500
		}
		if limit > 2000 {
			limit = 2000
		}

		allPages, err := deps.Sitemap.ListAllPages()
		if err != nil {
			return errorResult("list pages: " + err.Error()), nil
		}

		pagePaths := make([]string, 0, len(allPages))
		for _, p := range allPages {
			pagePaths = append(pagePaths, p.Path)
		}
		rows, scanned, skippedAcl := buildReviewflowList(reviewflowScanArgs{
			pages:               pagePaths,
			prefix:              prefix,
			includeUnconfigured: includeUnconfigured,
			limit:               limit,
			canView:             func(p string) bool { return deps.canView(ctx, p) },
			getStatus:           deps.Reviewflow.GetStatus,
		})

		return jsonResult(map[string]any{
			"path_prefix":        "/" + prefix,
			"rows":               rows,
			"scanned":            scanned,
			"skipped_access":     skippedAcl,
			"truncated_at_limit": len(rows) >= limit,
		}), nil
	})
}

// reviewflowRow is one row of the list_reviewflows response; kept at
// package scope so the pure buildReviewflowList helper (and its tests)
// can share the shape with the tool handler above.
//
// Signatory fields (Roles, ConfirmedBy, MissingRoles, SignedRoles,
// NextRoles) answer the "who should sign, who did, who still owes"
// question without a follow-up get_reviewflow_status call per page.
type reviewflowRow struct {
	Path             string            `json:"path"`
	IsFullyValidated bool              `json:"is_fully_validated"`
	CurrentVersion   int64             `json:"current_version"`
	ValidatedVersion int64             `json:"validated_version"`
	VersionTag       string            `json:"version_tag,omitempty"`
	Parallel         bool              `json:"parallel,omitempty"`
	Roles            map[string]string `json:"roles,omitempty"`
	ConfirmedBy      map[string]string `json:"confirmed_by,omitempty"`
	MissingRoles     map[string]string `json:"missing_roles,omitempty"`
	NextRoles        []string          `json:"next_roles,omitempty"`
	SignedRoles      []string          `json:"signed_roles,omitempty"`
	OverdueRoles     []string          `json:"overdue_roles,omitempty"`
	AwaitingRelease  bool              `json:"awaiting_release,omitempty"`
	HasReviewflow    bool              `json:"has_reviewflow"`
}

// reviewflowScanArgs bundles the inputs to buildReviewflowList. The
// getStatus callback returns the minimal subset of reviewflow.Status the
// scan reads, so the test can construct fakes without depending on the
// reviewflow package.
type reviewflowScanArgs struct {
	pages               []string
	prefix              string
	includeUnconfigured bool
	limit               int
	canView             func(pagePath string) bool
	getStatus           func(pagePath string) (*reviewflow.Status, error)
}

// buildReviewflowList is the pure core of the list_reviewflows tool. It
// takes the page corpus plus lookup callbacks and returns the filtered
// rows and counters for the response envelope. Side-effect free so tests
// can drive it with plain maps.
func buildReviewflowList(a reviewflowScanArgs) (rows []reviewflowRow, scanned int, skippedAcl int) {
	rows = []reviewflowRow{}
	matchPrefix := a.prefix
	if matchPrefix != "" {
		matchPrefix += "/"
	}
	for _, raw := range a.pages {
		if len(rows) >= a.limit {
			break
		}
		pagePath := strings.TrimPrefix(raw, "/")
		if matchPrefix != "" && !strings.HasPrefix(pagePath, matchPrefix) && pagePath != a.prefix {
			continue
		}
		if a.canView != nil && !a.canView(pagePath) {
			skippedAcl++
			continue
		}
		scanned++
		st, err := a.getStatus(pagePath)
		if err != nil {
			// Skip pages that fail to load rather than aborting the whole scan.
			continue
		}
		configured := st != nil && len(st.Roles) > 0
		if !configured && !a.includeUnconfigured {
			continue
		}
		// Derive confirmed_by = Roles ∖ MissingRoles so the caller
		// doesn't have to compute the difference. Nil map stays nil
		// (JSON omits the field) when nothing has been signed yet.
		var confirmed map[string]string
		if len(st.Roles) > 0 {
			confirmed = make(map[string]string, len(st.Roles))
			for role, user := range st.Roles {
				if _, pending := st.MissingRoles[role]; !pending {
					confirmed[role] = user
				}
			}
			if len(confirmed) == 0 {
				confirmed = nil
			}
		}
		rows = append(rows, reviewflowRow{
			Path:             "/" + pagePath,
			IsFullyValidated: st.IsFullyValidated,
			CurrentVersion:   st.CurrentPageVer,
			ValidatedVersion: st.ValidatedVersion,
			VersionTag:       st.VersionTag,
			Parallel:         st.Parallel,
			Roles:            st.Roles,
			ConfirmedBy:      confirmed,
			MissingRoles:     st.MissingRoles,
			NextRoles:        st.NextRoles,
			SignedRoles:      st.SignedRoles,
			OverdueRoles:     st.OverdueRoles,
			AwaitingRelease:  st.ManualRelease && !st.Released,
			HasReviewflow:    configured,
		})
	}
	return rows, scanned, skippedAcl
}

// ── list_broken_links ───────────────────────────────────────────────────

func registerListBrokenLinksTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("list_broken_links",
		mcpgo.WithDescription(
			"Scan every page under a path prefix and return every unresolved internal "+
				"reference. One row per occurrence: "+
				"{page, href, resolved, fragment, label, line, reason}. "+
				"`reason` is `missing_page` (target page does not exist) or "+
				"`missing_fragment` (target page exists, but the #anchor doesn't match "+
				"any of its headings — only emitted when check_fragments=true). "+
				"`fragment` is populated only on fragment misses.\n\n"+
				"By default fragment anchors are NOT checked, matching the editor's "+
				"gowiki-link-missing decorator — set check_fragments=true to turn the "+
				"extra pass on. The extra cost is one memoised Store.Get per unique "+
				"target page that has fragments pointing at it; well under a second on "+
				"a 200-page corpus.\n\n"+
				"Pages the caller can't view are skipped — the per-page markdown load "+
				"respects the dual-ACL model.",
		),
		mcpgo.WithString("path_prefix",
			mcpgo.Description("Namespace prefix (leading slash optional). Empty scans the whole wiki."),
		),
		mcpgo.WithNumber("limit",
			mcpgo.Description("Maximum rows to return (default 500, max 5000). The scan still walks every page under the prefix; `truncated_at_limit` is set when the limit was hit."),
		),
		mcpgo.WithBoolean("check_fragments",
			mcpgo.Description("When true, verify that `#anchor` fragments on links to existing pages match a heading slug in the target. Default false. Rows for fragment misses carry `reason: \"missing_fragment\"` and a `fragment` field with the unresolved anchor."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Store == nil {
			return errorResult("page store not available"), nil
		}
		if deps.Sitemap == nil {
			return errorResult("namespace listing not available"), nil
		}
		prefix := strings.Trim(req.GetString("path_prefix", ""), "/")
		limit := req.GetInt("limit", 500)
		if limit < 1 {
			limit = 500
		}
		if limit > 5000 {
			limit = 5000
		}

		allPages, err := deps.Sitemap.ListAllPages()
		if err != nil {
			return errorResult("list pages: " + err.Error()), nil
		}

		pagePaths := make([]string, 0, len(allPages))
		for _, p := range allPages {
			pagePaths = append(pagePaths, p.Path)
		}
		result := buildBrokenLinksList(brokenLinksScanArgs{
			pages:          pagePaths,
			prefix:         prefix,
			limit:          limit,
			checkFragments: req.GetBool("check_fragments", false),
			canView:        func(p string) bool { return deps.canView(ctx, p) },
			readMarkdown: func(p string) (string, bool) {
				page, err := deps.Store.Get(p)
				if err != nil {
					return "", false
				}
				return page.Markdown, true
			},
			exists: deps.Store.Exists,
		})

		return jsonResult(map[string]any{
			"path_prefix":        "/" + prefix,
			"broken":             result.Broken,
			"scanned":            result.Scanned,
			"pages_with_broken":  result.PagesWithBroken,
			"skipped_access":     result.SkippedAccess,
			"truncated_at_limit": result.TruncatedAtLimit,
		}), nil
	})
}

// brokenLinkRow is one dead-link occurrence in the list_broken_links
// response. Kept at package scope so the pure buildBrokenLinksList
// helper (and its tests) can share the shape with the tool handler.
// Reason distinguishes the two failure modes a caller may want to
// filter on separately: the target page is absent, or the page exists
// but the fragment anchor doesn't match any of its headings.
type brokenLinkRow struct {
	Page     string `json:"page"`
	Href     string `json:"href"`
	Resolved string `json:"resolved"`
	Fragment string `json:"fragment,omitempty"` // the #anchor part, when a fragment check was performed
	Label    string `json:"label"`
	Line     int    `json:"line"`
	Reason   string `json:"reason"` // "missing_page" or "missing_fragment"
}

// brokenLinksScanArgs bundles the inputs to buildBrokenLinksList. The
// callbacks let tests drive the scan with plain maps without touching
// Store or ACL plumbing. readMarkdown is used both for the page being
// scanned (links extracted) AND, when checkFragments is set, for the
// link's TARGET page (heading slugs extracted) — one memoised Store.Get
// per unique target.
type brokenLinksScanArgs struct {
	pages          []string // every page known to the sitemap (leading slash form)
	prefix         string   // trimmed path_prefix (no leading or trailing slash)
	limit          int
	checkFragments bool
	canView        func(pagePath string) bool                       // noLeading-slash pagePath → may view?
	readMarkdown   func(pagePath string) (markdown string, ok bool) // noLeading-slash → body
	exists         func(pagePath string) bool                       // noLeading-slash → page exists?
}

// brokenLinksScanResult is the aggregated response the handler wraps
// into the JSON envelope.
type brokenLinksScanResult struct {
	Broken           []brokenLinkRow
	Scanned          int
	PagesWithBroken  int
	SkippedAccess    int
	TruncatedAtLimit bool
}

// buildBrokenLinksList is the pure core of the list_broken_links tool.
// It walks the sitemap, applies prefix + ACL filtering, extracts page
// links from every readable page, and records occurrences whose
// resolved target is missing. Side-effect free so tests can drive it
// with plain maps.
//
// existsCache is local to the call — the same target page is often
// linked from many places (a central SOP), and the memo keeps that
// cheap. Also stabilises the response if the filesystem changes
// mid-scan: within one call every reference to the same target
// returns the same answer.
func buildBrokenLinksList(a brokenLinksScanArgs) brokenLinksScanResult {
	result := brokenLinksScanResult{Broken: []brokenLinkRow{}}
	matchPrefix := a.prefix
	if matchPrefix != "" {
		matchPrefix += "/"
	}
	existsCache := make(map[string]bool)
	// slugCache[target] = heading slug set for target page.
	// Only populated when checkFragments is on; keeps the Store.Get +
	// SlugifyHeading cost at one call per unique link target per scan.
	slugCache := make(map[string]map[string]struct{})

	for _, raw := range a.pages {
		if len(result.Broken) >= a.limit {
			break
		}
		pagePath := strings.TrimPrefix(raw, "/")
		if matchPrefix != "" && !strings.HasPrefix(pagePath, matchPrefix) && pagePath != a.prefix {
			continue
		}
		if a.canView != nil && !a.canView(pagePath) {
			result.SkippedAccess++
			continue
		}
		result.Scanned++
		md, ok := a.readMarkdown(pagePath)
		if !ok {
			continue
		}
		occurrences := markdown.ExtractLinkOccurrences(md, "/"+pagePath)
		if len(occurrences) == 0 {
			continue
		}
		hadBroken := false
		for _, occ := range occurrences {
			if len(result.Broken) >= a.limit {
				break
			}
			resolved := strings.TrimPrefix(occ.Resolved, "/")
			exists, cached := existsCache[resolved]
			if !cached {
				exists = a.exists(resolved)
				existsCache[resolved] = exists
			}
			if !exists {
				hadBroken = true
				result.Broken = append(result.Broken, brokenLinkRow{
					Page:     "/" + pagePath,
					Href:     occ.Href,
					Resolved: "/" + resolved,
					Label:    occ.Label,
					Line:     occ.Line,
					Reason:   "missing_page",
				})
				continue
			}
			// Target page exists — if checkFragments is on AND the
			// original href carried a #fragment, verify the fragment
			// matches a heading slug in the target. Pure fragment
			// refs (href="#x") resolve to the current page.
			if !a.checkFragments {
				continue
			}
			frag := extractFragment(occ.Href)
			if frag == "" {
				continue
			}
			slugs, cached := slugCache[resolved]
			if !cached {
				targetMd, ok := a.readMarkdown(resolved)
				if !ok {
					slugs = map[string]struct{}{}
				} else {
					slugs = markdown.ExtractHeadingSlugs(targetMd)
				}
				slugCache[resolved] = slugs
			}
			if _, hit := slugs[frag]; hit {
				continue
			}
			hadBroken = true
			result.Broken = append(result.Broken, brokenLinkRow{
				Page:     "/" + pagePath,
				Href:     occ.Href,
				Resolved: "/" + resolved,
				Fragment: frag,
				Label:    occ.Label,
				Line:     occ.Line,
				Reason:   "missing_fragment",
			})
		}
		if hadBroken {
			result.PagesWithBroken++
		}
	}
	result.TruncatedAtLimit = len(result.Broken) >= a.limit
	return result
}

// extractFragment pulls the `#frag` segment out of a raw href, stripping
// any query string. Returns "" for pure-fragment refs ("#x" → resolved
// to current page, scan skipped these) and for refs without a fragment.
func extractFragment(href string) string {
	// Trim query first — a href like "/x?y=1#z" has the fragment AFTER
	// the query. The link extractor already stripped the fragment and
	// query before resolving to a page path, but kept the raw href here
	// so we can read the fragment back off it.
	idx := strings.Index(href, "#")
	if idx < 0 || idx == 0 || idx == len(href)-1 {
		return ""
	}
	return href[idx+1:]
}

// ── preview_page_diff ───────────────────────────────────────────────────

func registerPreviewPageDiffTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("preview_page_diff",
		mcpgo.WithDescription(
			"Dry-run a page edit: returns the diff (hunks, added/removed line counts) without saving. "+
				"Use this to show the user what write_page would do before committing.",
		),
		mcpgo.WithString("path", mcpgo.Required(),
			mcpgo.Description("Page path, leading slash optional."),
		),
		mcpgo.WithString("markdown", mcpgo.Required(),
			mcpgo.Description("Proposed new markdown in the Sargon dialect."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		pagePath := strings.TrimPrefix(strings.TrimSpace(req.GetString("path", "")), "/")
		if strings.TrimSpace(req.GetString("path", "")) == "" {
			return errorResult("path is required"), nil
		}
		newMarkdown, err := req.RequireString("markdown")
		if err != nil {
			return errorResult("markdown is required"), nil
		}
		if !deps.canView(ctx, pagePath) {
			return errorResult("access denied"), nil
		}
		currentMarkdown := ""
		currentVersion := int64(0)
		if deps.Store != nil {
			if page, err := deps.Store.Get(pagePath); err == nil {
				currentMarkdown = page.Markdown
				currentVersion = page.Meta.Version
			}
		}
		hunks := storage.DiffLines(currentMarkdown, newMarkdown)
		added, removed := 0, 0
		for _, h := range hunks {
			switch h.Op {
			case "insert":
				added++
			case "delete":
				removed++
			}
		}
		return jsonResult(map[string]any{
			"path":            "/" + pagePath,
			"current_version": currentVersion,
			"diff": map[string]any{
				"added":   added,
				"removed": removed,
				"hunks":   hunks,
			},
		}), nil
	})
}

// ── write_page ──────────────────────────────────────────────────────────

func registerWritePageTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("write_page",
		mcpgo.WithDescription(
			"Create or update a page. Requires edit permission for the caller AND the @ai subject. "+
				"The summary must start with '[AI: <tool>]' (e.g. '[AI: Claude] Translate section 3'). "+
				"Always call preview_page_diff first and show the diff to the user.",
		),
		mcpgo.WithString("path", mcpgo.Required(),
			mcpgo.Description("Page path, leading slash optional. Namespace indexes end with '/'."),
		),
		mcpgo.WithString("markdown", mcpgo.Required(),
			mcpgo.Description("New markdown content in the Sargon dialect."),
		),
		mcpgo.WithString("summary", mcpgo.Required(),
			mcpgo.Description("Change summary. Required for audit. Format: '[AI: <tool-name>] <description>'."),
		),
		mcpgo.WithNumber("expected_version",
			mcpgo.Description("Optional optimistic lock. If set, the write fails when the current page version differs."),
		),
		mcpgo.WithBoolean("force",
			mcpgo.Description(
				"Bypass the fully-validated-page guard. Default false: a write to a page that reviewflow considers fully validated (every role's signature is on the current version) is refused, because the write would invalidate all signatures. Pass force=true when the change is deliberate and the reviewers will re-sign. Ignored when the page has no reviewflow directive."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		pagePath := strings.TrimPrefix(strings.TrimSpace(req.GetString("path", "")), "/")
		if strings.TrimSpace(req.GetString("path", "")) == "" {
			return errorResult("path is required"), nil
		}
		newMarkdown, err := req.RequireString("markdown")
		if err != nil {
			return errorResult("markdown is required"), nil
		}
		summary := strings.TrimSpace(req.GetString("summary", ""))
		if deps.RequireSummary && summary == "" {
			return errorResult("summary is required — format '[AI: <tool>] <description>'"), nil
		}
		expectedVersion := int64(req.GetInt("expected_version", 0))
		force := req.GetBool("force", false)

		if deps.Store == nil {
			return errorResult("page store not available"), nil
		}
		if !deps.canEdit(ctx, pagePath) {
			return errorResult("edit permission denied"), nil
		}

		// Fully-validated-page guard: refuse writes that would silently
		// invalidate every signature unless the caller opted in with
		// force=true.
		if refusal := refuseIfValidatedWithoutForce(deps.reviewflowGetter(), pagePath, force); refusal != nil {
			return refusal, nil
		}

		if deps.DraftState != nil {
			if lock := deps.DraftState.GetLock(pagePath); lock.Owner != "" {
				return errorResult(fmt.Sprintf(
					"page is locked by %s (since %s) — wait for them to finish editing before writing",
					lock.Owner, lock.Since,
				)), nil
			}
			if draft, ok := deps.DraftState.FindAnyDraft(pagePath); ok {
				return errorResult(fmt.Sprintf(
					"page has an unpublished draft by %s (since %s) — wait for it to be published or discarded before writing",
					draft.Owner, draft.Since,
				)), nil
			}
		}

		if expectedVersion > 0 {
			if page, err := deps.Store.Get(pagePath); err == nil {
				if page.Meta.Version != expectedVersion {
					return errorResult(fmt.Sprintf(
						"version conflict: page is at %d, expected %d — re-read before writing",
						page.Meta.Version, expectedVersion,
					)), nil
				}
			}
		}

		username := deps.ExtractUsername(ctx)
		// Author and summary are stored in SEPARATE fields of the
		// attic entry (see storage.AtticEntry). An earlier version
		// of this handler concatenated them into one `author` string
		// and called Put; that polluted PageMetadata.Author (what
		// {tag-query} and other author-facing surfaces read), so a
		// published QMS table ended up showing commit summaries in
		// its Author column. PutWithSummary keeps them separate end
		// to end.
		existedBefore := deps.Store.Exists(pagePath)
		result, err := deps.Store.PutWithSummary(pagePath, newMarkdown, username, summary)
		if err != nil {
			return errorResult("write failed: " + err.Error()), nil
		}
		return jsonResult(map[string]any{
			"path":    "/" + pagePath,
			"version": result.Page.Meta.Version,
			"created": !existedBefore,
			"updated": existedBefore,
		}), nil
	})
}

// ── list_todos ──────────────────────────────────────────────────────────

func registerListTodosTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("list_todos",
		mcpgo.WithDescription(
			"List todo tasks with optional filters. Fields: id, title, status, assignee, due_date, priority, source_page, tags.",
		),
		mcpgo.WithString("status",
			mcpgo.Description("Comma-separated: open,in_progress,done,cancelled. Default: open,in_progress."),
		),
		mcpgo.WithString("assignee",
			mcpgo.Description("Username or group name to filter by."),
		),
		mcpgo.WithString("page",
			mcpgo.Description("Exact page path to filter by."),
		),
		mcpgo.WithString("page_prefix",
			mcpgo.Description("Namespace prefix (e.g. '/projects/') to scope results."),
		),
		mcpgo.WithString("tag",
			mcpgo.Description("Filter by tag substring."),
		),
		mcpgo.WithString("due_before",
			mcpgo.Description("Only tasks due on or before YYYY-MM-DD."),
		),
		mcpgo.WithString("priority",
			mcpgo.Description("Comma-separated priorities: low, normal, high, urgent."),
		),
		mcpgo.WithNumber("limit",
			mcpgo.Description("Max tasks to return (default 50, max 100)."),
		),
	)
	srv.AddTool(tool, func(_ context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Todo == nil {
			return errorResult("todo plugin not available"), nil
		}
		opts := todo.ListOptions{
			Status:     todo.Status(req.GetString("status", "")),
			Assignee:   req.GetString("assignee", ""),
			Page:       req.GetString("page", ""),
			PagePrefix: req.GetString("page_prefix", ""),
			Tag:        req.GetString("tag", ""),
			DueBefore:  req.GetString("due_before", ""),
			Priority:   todo.Priority(req.GetString("priority", "")),
			Limit:      req.GetInt("limit", 50),
		}
		tasks, cursor, err := deps.Todo.Store().List(context.Background(), opts)
		if err != nil {
			return errorResult("list todos: " + err.Error()), nil
		}
		return jsonResult(map[string]any{
			"tasks":  tasks,
			"cursor": cursor,
		}), nil
	})
}

// ── complete_todo ───────────────────────────────────────────────────────

func registerCompleteTodoTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("complete_todo",
		mcpgo.WithDescription("Mark a todo task as done on behalf of the authenticated user."),
		mcpgo.WithString("id", mcpgo.Required(),
			mcpgo.Description("Task ID."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Todo == nil {
			return errorResult("todo plugin not available"), nil
		}
		id, err := req.RequireString("id")
		if err != nil {
			return errorResult("id is required"), nil
		}
		username := deps.ExtractUsername(ctx)
		var resolver todo.GroupResolver
		if deps.UserStore != nil {
			resolver = &mcpGroupResolver{userStore: deps.UserStore}
		}
		task, err := deps.Todo.CompleteTask(context.Background(), id, username, resolver)
		if err != nil {
			return errorResult("complete: " + err.Error()), nil
		}
		return jsonResult(task), nil
	})
}

// mcpGroupResolver is a minimal GroupResolver that iterates the UserStore.
// It mirrors the authGroupResolver used by the todo HTTP handlers so that
// "all members" group completion works identically over MCP.
type mcpGroupResolver struct {
	userStore *auth.UserStore
}

func (r *mcpGroupResolver) GroupMembers(groupName string) []string {
	if r.userStore == nil {
		return nil
	}
	users := r.userStore.List()
	var members []string
	for _, u := range users {
		for _, g := range u.EffectiveGroups() {
			if g == groupName {
				members = append(members, u.Username)
				break
			}
		}
	}
	return members
}

// ── list_database_tables ────────────────────────────────────────────────

func registerListDatabaseTablesTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("list_database_tables",
		mcpgo.WithDescription(
			"List all structured-data tables and their field definitions. Use this to discover queryable tables before calling query_database_rows.",
		),
	)
	srv.AddTool(tool, func(_ context.Context, _ mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.SchemaStore == nil {
			return errorResult("database not connected"), nil
		}
		tables, err := deps.SchemaStore.ListTables(context.Background())
		if err != nil {
			return errorResult("list tables: " + err.Error()), nil
		}
		out := make([]map[string]any, 0, len(tables))
		for _, t := range tables {
			full, err := deps.SchemaStore.GetTable(context.Background(), t.ID)
			if err != nil {
				continue
			}
			out = append(out, map[string]any{
				"name":   t.Name,
				"label":  t.Label,
				"fields": full.Fields,
			})
		}
		return jsonResult(map[string]any{"tables": out}), nil
	})
}

// ── query_database_rows ─────────────────────────────────────────────────

func registerQueryDatabaseRowsTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("query_database_rows",
		mcpgo.WithDescription(
			"Query rows from a structured-data table. Supports field filters, sorting, and pagination. "+
				"First call list_database_tables to discover table names and field definitions. "+
				"Filter syntax: each item is 'field<op>value' where <op> is one of =, !=, <>, <, >, <=, >=, ~ (ILIKE substring; % is wildcard). "+
				"The reserved value @null tests for SQL NULL: 'field=@null' matches rows where the column is unset/void, 'field!=@null' matches rows where it is set. "+
				"Lookup/tag joins: use 'parent.child<op>value' (one level only).\n\n"+
				"PIVOT MODE — pass any pivot_* parameter to switch the response shape from a flat row list to a cross-tabulation. Response then contains rows, cols, and cells arrays (see the returned JSON for the exact shape). "+
				"Required in pivot mode: pivot_rows (row axis field), pivot_cols (column axis field), pivot_cell (cell field). Optional: pivot_agg (single|list|count|first|last, default single), pivot_empty (text for empty cells), pivot_cols_sort (order the columns), pivot_cols_max (refusal threshold, default 40).",
		),
		mcpgo.WithString("table", mcpgo.Required(),
			mcpgo.Description("Table name."),
		),
		mcpgo.WithArray("filter",
			mcpgo.Description("Optional array of filter expressions, ANDed together. Examples: [\"status=active\", \"priority>=2\", \"authority_notified=@null\"]."),
		),
		mcpgo.WithString("sort",
			mcpgo.Description("Field name to sort by. In pivot mode, sorts the row axis."),
		),
		mcpgo.WithString("order",
			mcpgo.Description("asc or desc (default asc)."),
		),
		mcpgo.WithNumber("limit",
			mcpgo.Description("Max rows (default 50, max 500). Ignored in pivot mode."),
		),
		mcpgo.WithNumber("offset",
			mcpgo.Description("Pagination offset (default 0). Ignored in pivot mode."),
		),
		mcpgo.WithString("pivot_rows",
			mcpgo.Description("PIVOT MODE: field whose distinct values become the rows."),
		),
		mcpgo.WithString("pivot_cols",
			mcpgo.Description("PIVOT MODE: field whose distinct values become the columns."),
		),
		mcpgo.WithString("pivot_cell",
			mcpgo.Description("PIVOT MODE: field rendered inside each cell. Ignored when pivot_agg=count."),
		),
		mcpgo.WithString("pivot_agg",
			mcpgo.Description("PIVOT MODE: collision policy — single (default; render a Values array + Collision flag on collision), list, count, first, last."),
		),
		mcpgo.WithString("pivot_empty",
			mcpgo.Description("PIVOT MODE: text for empty cells. Default empty."),
		),
		mcpgo.WithString("pivot_cols_sort",
			mcpgo.Description("PIVOT MODE: field of the column axis's target table used to order columns. Defaults to the target table's own default sort for lookup/tag axes; alphabetical otherwise."),
		),
		mcpgo.WithNumber("pivot_cols_max",
			mcpgo.Description("PIVOT MODE: refusal threshold on distinct column count. Default 40."),
		),
		mcpgo.WithObject("pivot_rows_labels",
			mcpgo.Description("PIVOT MODE: raw-value → display-label map for the row axis. Distinct raw values that map to the same label MERGE into one row (counts summed). Use the key \"@null\" to relabel rows with an empty value; without an override those rows show as \"(empty)\". Example: {\"Y\":\"Archived\",\"N\":\"Active\",\"@null\":\"Active\"}."),
		),
		mcpgo.WithObject("pivot_cols_labels",
			mcpgo.Description("PIVOT MODE: raw-value → display-label map for the column axis. Same merging semantics as pivot_rows_labels. Use \"@null\" for the empty-value column."),
		),
	)
	srv.AddTool(tool, func(_ context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.DataStore == nil {
			return errorResult("database not connected"), nil
		}
		tableName, err := req.RequireString("table")
		if err != nil {
			return errorResult("table is required"), nil
		}
		order := req.GetString("order", "asc")
		if order != "asc" && order != "desc" {
			order = "asc"
		}
		params := database.QueryParams{
			Sort:  req.GetString("sort", ""),
			Order: order,
		}
		for _, raw := range req.GetStringSlice("filter", nil) {
			if f := parseFilterExpression(raw); f != nil {
				params.Filters = append(params.Filters, *f)
			}
		}

		// Pivot detection: any pivot_* param switches modes.
		pivotRows := strings.TrimSpace(req.GetString("pivot_rows", ""))
		pivotCols := strings.TrimSpace(req.GetString("pivot_cols", ""))
		pivotCell := strings.TrimSpace(req.GetString("pivot_cell", ""))
		pivotAgg := strings.TrimSpace(req.GetString("pivot_agg", ""))
		pivotEmpty := req.GetString("pivot_empty", "")
		pivotColsSort := strings.TrimSpace(req.GetString("pivot_cols_sort", ""))
		pivotColsMax := req.GetInt("pivot_cols_max", 0)
		args := req.GetArguments()
		rowLabels := coerceStringMap(args["pivot_rows_labels"])
		colLabels := coerceStringMap(args["pivot_cols_labels"])
		inPivot := pivotRows != "" || pivotCols != "" || pivotCell != "" ||
			pivotAgg != "" || pivotEmpty != "" || pivotColsSort != "" || pivotColsMax > 0 ||
			len(rowLabels) > 0 || len(colLabels) > 0
		if inPivot {
			pv := database.PivotParams{
				Rows:      pivotRows,
				Cols:      pivotCols,
				Cell:      pivotCell,
				Agg:       pivotAgg,
				Empty:     pivotEmpty,
				ColsSort:  pivotColsSort,
				ColsMax:   pivotColsMax,
				RowLabels: rowLabels,
				ColLabels: colLabels,
			}
			result, err := deps.DataStore.PivotRows(context.Background(), tableName, params, pv)
			if err != nil {
				var perr *database.PivotError
				if errors.As(err, &perr) {
					return errorResult(perr.Message), nil
				}
				return errorResult("pivot: " + err.Error()), nil
			}
			return jsonResult(result), nil
		}

		limit := req.GetInt("limit", 50)
		if limit > 500 {
			limit = 500
		}
		if limit < 1 {
			limit = 50
		}
		params.Limit = limit
		params.Offset = req.GetInt("offset", 0)

		rows, total, err := deps.DataStore.QueryRows(context.Background(), tableName, params)
		if err != nil {
			return errorResult("query: " + err.Error()), nil
		}
		return jsonResult(map[string]any{
			"rows":  rows,
			"total": total,
		}), nil
	})
}

// coerceStringMap turns an MCP argument value into a map[string]string.
// The client may hand us a real JSON object (map[string]any) or a
// stringified JSON blob (some agents don't emit nested objects); accept
// both. Non-string values are stringified via fmt.
func coerceStringMap(v any) map[string]string {
	if v == nil {
		return nil
	}
	if m, ok := v.(map[string]any); ok {
		out := make(map[string]string, len(m))
		for k, val := range m {
			if val == nil {
				out[k] = ""
				continue
			}
			if s, ok := val.(string); ok {
				out[k] = s
			} else {
				out[k] = fmt.Sprintf("%v", val)
			}
		}
		return out
	}
	if s, ok := v.(string); ok {
		s = strings.TrimSpace(s)
		if s == "" {
			return nil
		}
		var m map[string]string
		if err := json.Unmarshal([]byte(s), &m); err == nil {
			return m
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(s), &raw); err == nil {
			return coerceStringMap(raw)
		}
	}
	return nil
}

// parseFilterExpression parses a single filter string of the form
// "field<op>value" — mirrors api.parseFilter, kept here to avoid dragging the
// api package into mcpserver just for one helper.
func parseFilterExpression(raw string) *database.Filter {
	for _, op := range []string{"!=", "<>", "<=", ">="} {
		idx := strings.Index(raw, op)
		if idx > 0 {
			normalizedOp := op
			if op == "<>" {
				normalizedOp = "!="
			}
			return &database.Filter{
				Field:    strings.TrimSpace(raw[:idx]),
				Operator: normalizedOp,
				Value:    strings.TrimSpace(raw[idx+len(op):]),
			}
		}
	}
	for _, op := range []string{"~", "<", ">", "="} {
		idx := strings.Index(raw, op)
		if idx > 0 {
			return &database.Filter{
				Field:    strings.TrimSpace(raw[:idx]),
				Operator: op,
				Value:    strings.TrimSpace(raw[idx+len(op):]),
			}
		}
	}
	return nil
}
