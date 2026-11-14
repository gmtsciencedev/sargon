package mcpserver

import (
	"context"
	"strings"
	"time"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"

	"sargon/backend/internal/storage"
)

// ── list_page_history ──────────────────────────────────────────────────────

func registerListPageHistoryTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("list_page_history",
		mcpgo.WithDescription(
			"List every archived version of a page (attic). Returns the metadata "+
				"for each version — version number, timestamp, author, summary, md5 — "+
				"so an agent can drill in via read_page_version or diff_page_versions.",
		),
		mcpgo.WithString("page_path", mcpgo.Required(),
			mcpgo.Description("Page path (leading slash optional). Namespace indexes end with '/'."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		pagePath := canonicalPageArg(req.GetString("page_path", ""))
		if pagePath == "" {
			return errorResult("page_path is required"), nil
		}
		if deps.Attic == nil {
			return errorResult("attic not available"), nil
		}
		if !deps.canView(ctx, pagePath) {
			return errorResult("access denied"), nil
		}
		entries, err := deps.Attic.ListVersions(pagePath)
		if err != nil {
			return errorResult("read history: " + err.Error()), nil
		}
		if entries == nil {
			entries = []storage.AtticEntry{}
		}
		return jsonResult(map[string]any{
			"page_path": pagePath,
			"versions":  entries,
		}), nil
	})
}

// ── read_page_version ──────────────────────────────────────────────────────

func registerReadPageVersionTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("read_page_version",
		mcpgo.WithDescription(
			"Read the markdown of a specific archived version of a page. "+
				"Combine with list_page_history to find valid version numbers.",
		),
		mcpgo.WithString("page_path", mcpgo.Required(),
			mcpgo.Description("Page path (leading slash optional)."),
		),
		mcpgo.WithNumber("version", mcpgo.Required(),
			mcpgo.Description("Version number. Must be one of the versions returned by list_page_history."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		pagePath := canonicalPageArg(req.GetString("page_path", ""))
		if pagePath == "" {
			return errorResult("page_path is required"), nil
		}
		version := int64(req.GetInt("version", 0))
		if version <= 0 {
			return errorResult("version must be a positive integer"), nil
		}
		if deps.Attic == nil {
			return errorResult("attic not available"), nil
		}
		if !deps.canView(ctx, pagePath) {
			return errorResult("access denied"), nil
		}
		content, err := deps.Attic.ReadVersion(pagePath, version)
		if err != nil {
			return errorResult("read version: " + err.Error()), nil
		}
		// Attach the metadata that goes with this version, if we can find it.
		meta := findAtticEntry(deps.Attic, pagePath, version)
		result := map[string]any{
			"page_path": pagePath,
			"version":   version,
			"markdown":  string(content),
		}
		if meta != nil {
			result["timestamp"] = meta.Timestamp
			result["author"] = meta.Author
			result["summary"] = meta.Summary
			result["md5"] = meta.MD5
		}
		return jsonResult(result), nil
	})
}

func findAtticEntry(a AtticStore, pagePath string, version int64) *storage.AtticEntry {
	entries, err := a.ListVersions(pagePath)
	if err != nil {
		return nil
	}
	for i := range entries {
		if entries[i].Version == version {
			return &entries[i]
		}
	}
	return nil
}

// ── list_recent_changes ────────────────────────────────────────────────────

func registerListRecentChangesTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("list_recent_changes",
		mcpgo.WithDescription(
			"Cross-page changelog: list recent edits filtered by author, date "+
				"window, and/or path prefix. Every returned entry has been ACL-checked "+
				"against the caller — you only see changes to pages you can view. "+
				"For a per-page timeline of a single page, use list_page_history instead.",
		),
		mcpgo.WithString("since",
			mcpgo.Description("Only include changes at or after this RFC3339 timestamp (e.g. '2026-08-01T00:00:00Z'). Optional."),
		),
		mcpgo.WithString("until",
			mcpgo.Description("Only include changes at or before this RFC3339 timestamp. Optional."),
		),
		mcpgo.WithString("author",
			mcpgo.Description("Only include changes by this username (exact match, e.g. 'raynald.delahondes'). Optional."),
		),
		mcpgo.WithString("path_prefix",
			mcpgo.Description("Only include pages under this path prefix (e.g. '/regulatory/qms/'). Leading slash optional. Optional."),
		),
		mcpgo.WithNumber("limit",
			mcpgo.Description("Maximum entries to return. Default 50, hard cap 200. Paginate by passing a later `until` on the next call."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Changelog == nil {
			return errorResult("changelog not available"), nil
		}

		opts := storage.ReadOptions{Dedupe: false, MaxCount: 200}
		opts.Count = req.GetInt("limit", 50)
		if opts.Count <= 0 {
			opts.Count = 50
		}
		if opts.Count > 200 {
			opts.Count = 200
		}

		if raw := strings.TrimSpace(req.GetString("since", "")); raw != "" {
			t, err := time.Parse(time.RFC3339, raw)
			if err != nil {
				return errorResult("since: expected RFC3339 timestamp — " + err.Error()), nil
			}
			opts.Since = t
		}
		if raw := strings.TrimSpace(req.GetString("until", "")); raw != "" {
			t, err := time.Parse(time.RFC3339, raw)
			if err != nil {
				return errorResult("until: expected RFC3339 timestamp — " + err.Error()), nil
			}
			opts.Until = t
		}
		if author := strings.TrimSpace(req.GetString("author", "")); author != "" {
			opts.Users = []string{author}
		}
		if prefix := strings.TrimSpace(req.GetString("path_prefix", "")); prefix != "" {
			// Changelog paths carry a leading slash; normalize the filter to
			// match. Stripping the slash — as this used to do — meant that
			// `/regulatory/qms/` filtered on `regulatory/qms/` and matched
			// nothing.
			if !strings.HasPrefix(prefix, "/") {
				prefix = "/" + prefix
			}
			opts.IncludePaths = []string{prefix}
		}

		entries, err := deps.Changelog.Read(opts)
		if err != nil {
			return errorResult("read changelog: " + err.Error()), nil
		}

		// ACL-filter results: only surface entries whose page the caller can view.
		type outEntry struct {
			PagePath   string    `json:"page_path"`
			Version    int64     `json:"version"`
			Timestamp  time.Time `json:"timestamp"`
			Author     string    `json:"author"`
			Summary    string    `json:"summary"`
			ChangeType string    `json:"type"`
		}
		out := make([]outEntry, 0, len(entries))
		for _, e := range entries {
			pagePath := e.PagePath
			if !deps.canView(ctx, pagePath) {
				continue
			}
			out = append(out, outEntry{
				PagePath:   pagePath,
				Version:    e.Version,
				Timestamp:  e.Timestamp,
				Author:     e.Author,
				Summary:    e.Summary,
				ChangeType: e.ChangeType,
			})
		}

		return jsonResult(map[string]any{
			"entries": out,
			"count":   len(out),
			"filter": map[string]any{
				"since":       nullableTime(opts.Since),
				"until":       nullableTime(opts.Until),
				"author":      firstOrEmpty(opts.Users),
				"path_prefix": firstOrEmpty(opts.IncludePaths),
				"limit":       opts.Count,
			},
		}), nil
	})
}

func nullableTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.Format(time.RFC3339)
}

func firstOrEmpty(s []string) string {
	if len(s) == 0 {
		return ""
	}
	return s[0]
}

// ── diff_page_versions ─────────────────────────────────────────────────────

func registerDiffPageVersionsTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("diff_page_versions",
		mcpgo.WithDescription(
			"Return a line-level diff between two archived versions of the same page. "+
				"Output shape matches preview_page_diff: an array of hunks with op "+
				"equal/insert/delete plus added/removed counts.",
		),
		mcpgo.WithString("page_path", mcpgo.Required(),
			mcpgo.Description("Page path (leading slash optional)."),
		),
		mcpgo.WithNumber("from_version", mcpgo.Required(),
			mcpgo.Description("Older version to compare. Content at this version becomes the 'before' side."),
		),
		mcpgo.WithNumber("to_version", mcpgo.Required(),
			mcpgo.Description("Newer version to compare. Content at this version becomes the 'after' side."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		pagePath := canonicalPageArg(req.GetString("page_path", ""))
		if pagePath == "" {
			return errorResult("page_path is required"), nil
		}
		fromV := int64(req.GetInt("from_version", 0))
		toV := int64(req.GetInt("to_version", 0))
		if fromV <= 0 || toV <= 0 {
			return errorResult("from_version and to_version must be positive integers"), nil
		}
		if deps.Attic == nil {
			return errorResult("attic not available"), nil
		}
		if !deps.canView(ctx, pagePath) {
			return errorResult("access denied"), nil
		}
		fromBytes, err := deps.Attic.ReadVersion(pagePath, fromV)
		if err != nil {
			return errorResult("read from_version: " + err.Error()), nil
		}
		toBytes, err := deps.Attic.ReadVersion(pagePath, toV)
		if err != nil {
			return errorResult("read to_version: " + err.Error()), nil
		}

		hunks := storage.DiffLines(string(fromBytes), string(toBytes))
		added, removed := 0, 0
		for _, h := range hunks {
			switch h.Op {
			case "insert":
				added++
			case "delete":
				removed++
			}
		}

		fromMeta := findAtticEntry(deps.Attic, pagePath, fromV)
		toMeta := findAtticEntry(deps.Attic, pagePath, toV)

		versionMeta := func(v int64, m *storage.AtticEntry) map[string]any {
			out := map[string]any{"version": v}
			if m != nil {
				out["timestamp"] = m.Timestamp
				out["author"] = m.Author
				out["summary"] = m.Summary
			}
			return out
		}

		return jsonResult(map[string]any{
			"page_path": pagePath,
			"from":      versionMeta(fromV, fromMeta),
			"to":        versionMeta(toV, toMeta),
			"diff": map[string]any{
				"added":   added,
				"removed": removed,
				"hunks":   hunks,
			},
		}), nil
	})
}
