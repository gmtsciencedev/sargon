package mcpserver

import (
	"context"
	"errors"
	"path"
	"strings"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"

	"sargon/backend/internal/storage"
)

// mapMoveError turns storage-package sentinel errors into user-facing MCP
// error text. Keeps every ok-but-refused case distinct.
func mapMoveError(err error) string {
	switch {
	case errors.Is(err, storage.ErrPageNotFound):
		return "source page not found"
	case errors.Is(err, storage.ErrDestinationExists):
		return "destination already exists"
	case errors.Is(err, storage.ErrNamespaceConflict):
		return "namespace conflict: a directory (or a page) already occupies that path"
	case errors.Is(err, storage.ErrNamespaceNotEmpty):
		return "namespace is not empty: cannot convert to a regular page while it has children"
	case errors.Is(err, storage.ErrPageHasLock):
		return "page has an active edit lock or draft: " + err.Error()
	default:
		return err.Error()
	}
}

// destinationFolder returns the parent folder of a destination path, used to
// check the caller's edit permission on the target namespace.
func destinationFolder(pagePath string) string {
	pagePath = strings.TrimSuffix(pagePath, "/")
	dir := path.Dir(pagePath)
	if dir == "." || dir == "/" {
		return "/"
	}
	return "/" + strings.TrimPrefix(dir, "/")
}

// ── move_page ──────────────────────────────────────────────────────────────

func registerMovePageTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("move_page",
		mcpgo.WithDescription(
			"Rename a page to a new path. Requires edit permission on the source "+
				"AND on the destination folder, for the caller AND the @ai subject. "+
				"With update_links=true (default) every incoming link across the wiki "+
				"is rewritten to the new path. Pass dry_run=true to preview what "+
				"would happen without touching anything. To flip a leaf page into a "+
				"namespace index (foo → foo/), use convert_page_to_namespace_index instead.",
		),
		mcpgo.WithString("from_path", mcpgo.Required(),
			mcpgo.Description("Current page path (leading slash optional). Namespace indexes end with '/'."),
		),
		mcpgo.WithString("to_path", mcpgo.Required(),
			mcpgo.Description("New page path. Must not already exist. Namespace indexes end with '/'."),
		),
		mcpgo.WithBoolean("update_links",
			mcpgo.Description("Rewrite incoming links across the wiki to point at the new path. Default true."),
		),
		mcpgo.WithBoolean("move_media",
			mcpgo.Description("Also move media files whose owning namespace matches the source page. Default false — media stays put and existing references still resolve."),
		),
		mcpgo.WithBoolean("dry_run",
			mcpgo.Description("If true, return a preview (source, target, incoming links that would be rewritten) without writing. Default false."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Mover == nil {
			return errorResult("move not supported by this store"), nil
		}
		fromPath := strings.TrimPrefix(strings.TrimSpace(req.GetString("from_path", "")), "/")
		toPath := strings.TrimPrefix(strings.TrimSpace(req.GetString("to_path", "")), "/")
		if fromPath == "" || toPath == "" {
			return errorResult("from_path and to_path are both required"), nil
		}
		if fromPath == toPath {
			return errorResult("from_path and to_path are identical"), nil
		}
		updateLinks := req.GetBool("update_links", true)
		moveMedia := req.GetBool("move_media", false)
		dryRun := req.GetBool("dry_run", false)

		// ACL: edit on source page.
		if !deps.canEdit(ctx, fromPath) {
			return errorResult("access denied on source page"), nil
		}
		// ACL: edit on destination folder (a page path's namespace).
		if !deps.canEdit(ctx, strings.TrimPrefix(destinationFolder(toPath), "/")) {
			return errorResult("access denied on destination folder"), nil
		}

		author := deps.ExtractUsername(ctx)

		if dryRun {
			preview, err := deps.Mover.PreviewMove(fromPath, toPath, moveMedia)
			if err != nil {
				return errorResult(mapMoveError(err)), nil
			}
			return jsonResult(map[string]any{
				"dry_run": true,
				"from":    "/" + fromPath,
				"to":      "/" + toPath,
				"preview": preview,
			}), nil
		}

		result, err := deps.Mover.Move(fromPath, toPath, moveMedia, updateLinks, author)
		if err != nil {
			return errorResult(mapMoveError(err)), nil
		}
		return jsonResult(map[string]any{
			"moved":         true,
			"from":          "/" + fromPath,
			"to":            result.Page.Path,
			"version":       result.Page.Meta.Version,
			"updated_pages": result.UpdatedPages,
			"moved_media":   result.MovedMedia,
			"is_ns_index":   result.Page.IsNamespaceIndex,
		}), nil
	})
}

// ── convert_page_to_namespace_index ────────────────────────────────────────

func registerConvertToNamespaceIndexTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("convert_page_to_namespace_index",
		mcpgo.WithDescription(
			"Turn a leaf page into a namespace index: content/foo.md becomes "+
				"content/foo/index.md, freeing up /foo/ as a namespace under which "+
				"child pages (e.g. /foo/rec01) can be created. Use this when "+
				"write_page is refusing with a namespace-conflict error because the "+
				"path you want to write to already exists as a leaf page. Requires "+
				"edit permission for the caller AND the @ai subject.",
		),
		mcpgo.WithString("page_path", mcpgo.Required(),
			mcpgo.Description("Path of the leaf page to convert (e.g. '/regulatory/qms/qara/sop14'). Leading slash optional."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Mover == nil {
			return errorResult("move not supported by this store"), nil
		}
		pagePath := strings.TrimPrefix(strings.TrimSpace(req.GetString("page_path", "")), "/")
		if strings.TrimSpace(req.GetString("page_path", "")) == "" {
			return errorResult("page_path is required"), nil
		}
		if !deps.canEdit(ctx, pagePath) {
			return errorResult("access denied"), nil
		}
		author := deps.ExtractUsername(ctx)
		result, err := deps.Mover.ConvertToNamespaceIndex(pagePath, author)
		if err != nil {
			return errorResult(mapMoveError(err)), nil
		}
		return jsonResult(map[string]any{
			"converted":   true,
			"from":        "/" + pagePath,
			"to":          result.Page.Path,
			"version":     result.Page.Meta.Version,
			"is_ns_index": result.Page.IsNamespaceIndex,
		}), nil
	})
}

// ── delete_page ────────────────────────────────────────────────────────────

func registerDeletePageTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("delete_page",
		mcpgo.WithDescription(
			"Delete a page. The page is archived to the attic (history preserved), "+
				"then removed from the live content tree; the changelog gets a "+
				"'delete' entry so list_recent_changes and list_page_history still "+
				"show the record. Requires DELETE permission on the page for the "+
				"caller AND the @ai subject.\n\n"+
				"Side effects: if the page is bound to a database row (its path "+
				"lives under a table's page_folder), the corresponding row is "+
				"removed too via the standard database-sync path. To clean up a "+
				"row *and* its bound page, prefer delete_database_row which is "+
				"symmetric with insert_database_row and checks referential integrity.",
		),
		mcpgo.WithString("page_path", mcpgo.Required(),
			mcpgo.Description("Path of the page to delete (leading slash optional). Namespace indexes end with '/'."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Store == nil {
			return errorResult("page store not available"), nil
		}
		pagePath := strings.TrimPrefix(strings.TrimSpace(req.GetString("page_path", "")), "/")
		if strings.TrimSpace(req.GetString("page_path", "")) == "" {
			return errorResult("page_path is required"), nil
		}
		if !deps.canDelete(ctx, pagePath) {
			return errorResult("access denied: no delete permission on /" + pagePath), nil
		}
		author := deps.ExtractUsername(ctx)
		result, err := deps.Store.Delete(pagePath, author)
		if err != nil {
			return errorResult(mapMoveError(err)), nil
		}
		return jsonResult(map[string]any{
			"deleted":        true,
			"page_path":      "/" + pagePath,
			"orphaned_media": result.OrphanedMedia,
		}), nil
	})
}

// ── convert_page_to_regular_page ───────────────────────────────────────────

func registerConvertToRegularPageTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("convert_page_to_regular_page",
		mcpgo.WithDescription(
			"Turn an empty namespace index back into a leaf page: content/foo/index.md "+
				"becomes content/foo.md. Refuses if the namespace still has other "+
				"pages under it (delete/move them first). Requires edit permission "+
				"for the caller AND the @ai subject.",
		),
		mcpgo.WithString("page_path", mcpgo.Required(),
			mcpgo.Description("Path of the namespace index to convert. Trailing slash optional (e.g. '/foo' or '/foo/' both work)."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Mover == nil {
			return errorResult("move not supported by this store"), nil
		}
		pagePath := strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(req.GetString("page_path", "")), "/"), "/")
		if pagePath == "" {
			return errorResult("page_path is required"), nil
		}
		if !deps.canEdit(ctx, pagePath) {
			return errorResult("access denied"), nil
		}
		author := deps.ExtractUsername(ctx)
		result, err := deps.Mover.ConvertToRegularPage(pagePath, author)
		if err != nil {
			return errorResult(mapMoveError(err)), nil
		}
		return jsonResult(map[string]any{
			"converted":   true,
			"from":        "/" + pagePath + "/",
			"to":          result.Page.Path,
			"version":     result.Page.Meta.Version,
			"is_ns_index": result.Page.IsNamespaceIndex,
		}), nil
	})
}
