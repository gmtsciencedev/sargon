package mcpserver

import (
	"context"
	"strings"
	"time"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"

	"sargon/backend/internal/comment"
)

// ── list_page_comments ─────────────────────────────────────────────────────

func registerListPageCommentsTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("list_page_comments",
		mcpgo.WithDescription(
			"List every comment on a page — the sidebar annotations authors "+
				"leave on selected text without modifying the page content. "+
				"Returns top-level threads with their replies grouped under each; "+
				"an unresolved thread is one that still needs someone's attention. "+
				"Use include_resolved=false (default) to focus on what's actionable.",
		),
		mcpgo.WithString("page_path", mcpgo.Required(),
			mcpgo.Description("Page path (leading slash optional). Namespace indexes end with '/'."),
		),
		mcpgo.WithBoolean("include_resolved",
			mcpgo.Description("Include resolved threads too. Default false — most callers want the open work."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Comments == nil {
			return errorResult("comments service not available"), nil
		}
		raw := strings.TrimSpace(req.GetString("page_path", ""))
		if raw == "" {
			return errorResult("page_path is required"), nil
		}
		// Preserve the trailing slash — it distinguishes a namespace-index
		// page from a leaf. The store's statePath normalises it correctly
		// on both shapes since the comment-store fix.
		pagePath := canonicalPageArg(raw)
		if !deps.canView(ctx, pagePath) {
			return errorResult("access denied"), nil
		}
		includeResolved := req.GetBool("include_resolved", false)

		comments, err := deps.Comments.List(pagePath)
		if err != nil {
			return errorResult("list comments: " + err.Error()), nil
		}
		threads, open, total := buildCommentThreadView(comments, includeResolved)
		return jsonResult(map[string]any{
			"page_path":         pagePath,
			"open_threads":      open,
			"total_threads":     total,
			"threads":           threads,
			"includes_resolved": includeResolved,
		}), nil
	})
}

// replyView is the flat, LLM-friendly reply shape emitted under a thread.
type replyView struct {
	ID        string `json:"id"`
	Author    string `json:"author"`
	Text      string `json:"text"`
	CreatedAt string `json:"created_at"`
	AI        bool   `json:"ai,omitempty"`
}

// threadView is one top-level thread with its replies grouped under it.
type threadView struct {
	ID        string      `json:"id"`
	Anchor    string      `json:"anchor"`
	Author    string      `json:"author"`
	Text      string      `json:"text"`
	CreatedAt string      `json:"created_at"`
	UpdatedAt string      `json:"updated_at,omitempty"`
	Resolved  bool        `json:"resolved"`
	AI        bool        `json:"ai,omitempty"`
	Replies   []replyView `json:"replies,omitempty"`
}

// buildCommentThreadView groups replies under their parent thread, counts
// unresolved top-level threads, and optionally drops resolved threads
// from the returned slice. Extracted so the shaping rules can be unit
// tested independently of the MCP request plumbing. Returns
// (threads, open, total) where open is unresolved top-level thread
// count and total is total top-level thread count (regardless of
// includeResolved).
func buildCommentThreadView(comments []comment.Comment, includeResolved bool) ([]threadView, int, int) {
	replies := map[string][]replyView{}
	var tops []comment.Comment
	for _, c := range comments {
		if c.ParentID == "" {
			tops = append(tops, c)
			continue
		}
		replies[c.ParentID] = append(replies[c.ParentID], replyView{
			ID:        c.ID,
			Author:    c.Author,
			Text:      c.Text,
			CreatedAt: c.CreatedAt.Format(time.RFC3339),
			AI:        c.AI,
		})
	}
	open := 0
	threads := make([]threadView, 0, len(tops))
	for _, c := range tops {
		if !c.Resolved {
			open++
		}
		if c.Resolved && !includeResolved {
			continue
		}
		t := threadView{
			ID:        c.ID,
			Anchor:    c.Anchor.Selected,
			Author:    c.Author,
			Text:      c.Text,
			CreatedAt: c.CreatedAt.Format(time.RFC3339),
			Resolved:  c.Resolved,
			AI:        c.AI,
			Replies:   replies[c.ID],
		}
		if !c.UpdatedAt.IsZero() && !c.UpdatedAt.Equal(c.CreatedAt) {
			t.UpdatedAt = c.UpdatedAt.Format(time.RFC3339)
		}
		threads = append(threads, t)
	}
	return threads, open, len(tops)
}
