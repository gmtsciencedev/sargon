package mcpserver

import (
	"context"
	"fmt"
	"strings"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"
)

// pageFolderRoot returns the fixed-prefix portion of a page_folder template
// — everything before the first `@`-token. Used to check ACL on the parent
// namespace before the row's id/field values (and therefore the resolved page
// path) are known.
func pageFolderRoot(pageFolder string) string {
	if idx := strings.Index(pageFolder, "@"); idx >= 0 {
		pageFolder = pageFolder[:idx]
	}
	pageFolder = strings.TrimSuffix(pageFolder, "/")
	if !strings.HasPrefix(pageFolder, "/") {
		pageFolder = "/" + pageFolder
	}
	return pageFolder
}

// canDelete mirrors canEdit for the delete permission.
func (d Deps) canDelete(ctx context.Context, pagePath string) bool {
	if d.ACL == nil {
		return true
	}
	username := d.ExtractUsername(ctx)
	if !d.ACL.CheckPermission(username, d.effectiveGroups(username), pagePath, "delete") {
		return false
	}
	return d.ACL.CheckAIPermission(pagePath, "delete")
}

// ── insert_database_row ────────────────────────────────────────────────────

func registerInsertDatabaseRowTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("insert_database_row",
		mcpgo.WithDescription(
			"Insert a new row into a structured-data table. If the table has a "+
				"page_folder, the associated wiki page is created too (using the "+
				"table's page_template_path if set). Field types are coerced from "+
				"JSON to the column's SQL type. Fields not listed default per the "+
				"column definition (empty string, 0, false, or nil).\n\n"+
				"ACL: page-bound tables require the caller AND the @ai subject to "+
				"have edit permission on the page_folder namespace. Non-page-bound "+
				"tables require the caller to be in the admin group.",
		),
		mcpgo.WithString("table", mcpgo.Required(),
			mcpgo.Description("Table name (matches a value returned by list_database_tables)."),
		),
		mcpgo.WithObject("fields", mcpgo.Required(),
			mcpgo.Description("Column-name → value map. String, number, boolean, or array of strings for multi_enum fields. Omit fields to accept their default."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.RowWriter == nil || deps.SchemaStore == nil {
			return errorResult("database not connected"), nil
		}
		tableName := strings.TrimSpace(req.GetString("table", ""))
		if tableName == "" {
			return errorResult("table is required"), nil
		}
		args := req.GetArguments()
		rawFields, ok := args["fields"].(map[string]any)
		if !ok {
			return errorResult("fields must be a JSON object of column-name → value"), nil
		}

		table, err := deps.SchemaStore.GetTableByName(ctx, tableName)
		if err != nil {
			return errorResult("table not found: " + err.Error()), nil
		}

		// ACL gate.
		if table.PageFolder != "" {
			if !deps.canEdit(ctx, pageFolderRoot(table.PageFolder)) {
				return errorResult("access denied: no edit permission on " + pageFolderRoot(table.PageFolder)), nil
			}
		} else if !deps.isAdmin(ctx) {
			return errorResult("access denied: non-page-bound row inserts require admin"), nil
		}

		author := deps.ExtractUsername(ctx)
		// insert_database_row doesn't currently expose a `summary`
		// parameter — rows are usually created via a template whose
		// {template-stamp} already records provenance. Pass "" so the
		// attic entry carries only the username as author.
		result, err := deps.RowWriter.InsertRowWithPage(ctx, tableName, rawFields, author, "")
		if err != nil {
			return errorResult(err.Error()), nil
		}
		return jsonResult(map[string]any{
			"table":        tableName,
			"row":          result.Row,
			"page_path":    result.PagePath,
			"page_created": result.PageCreated,
		}), nil
	})
}

// ── update_database_row ────────────────────────────────────────────────────

func registerUpdateDatabaseRowTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("update_database_row",
		mcpgo.WithDescription(
			"Patch the listed fields on an existing row. Only the fields you "+
				"list are changed — every other column stays as it was, so this "+
				"is not a full-row replace.\n\n"+
				"For page-bound tables the row's {database-row} block on the "+
				"bound wiki page is rewritten in the same transaction so the "+
				"two representations stay in step — the same sync path the "+
				"visual editor uses when you double-click a cell.\n\n"+
				"Draft-lock guard: when the bound page has an active edit lock "+
				"or unpublished draft, the update is refused with a "+
				"`page_draft_conflict` (with the draft owner). Pass force=true "+
				"to override — the row is updated and the {database-row} block "+
				"is rewritten in-place, which may collide with the open draft; "+
				"prefer waiting for the draft to finish when you can.\n\n"+
				"ACL: page-bound rows require the caller AND the @ai subject "+
				"to have edit permission on the bound page (symmetric with "+
				"insert). Non-page-bound rows require the caller to be in the "+
				"admin group.",
		),
		mcpgo.WithString("table", mcpgo.Required(),
			mcpgo.Description("Table name (matches a value returned by list_database_tables)."),
		),
		mcpgo.WithNumber("row_id", mcpgo.Required(),
			mcpgo.Description("Numeric id of the row to update (the `id` column)."),
		),
		mcpgo.WithObject("fields", mcpgo.Required(),
			mcpgo.Description("Column-name → new value map. Partial: only listed fields are changed. String, number, boolean, or array of strings for multi_enum fields."),
		),
		mcpgo.WithBoolean("force",
			mcpgo.Description("If true, bypass the draft-lock refusal on a page-bound row. Default false."),
		),
		mcpgo.WithString("summary",
			mcpgo.Description("Change summary for audit. Format: '[AI: <tool-name>] <description>'. Required when the deployment sets require_summary."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.RowWriter == nil || deps.DataStore == nil || deps.SchemaStore == nil {
			return errorResult("database not connected"), nil
		}
		tableName := strings.TrimSpace(req.GetString("table", ""))
		if tableName == "" {
			return errorResult("table is required"), nil
		}
		rowID := req.GetInt("row_id", 0)
		if rowID <= 0 {
			return errorResult("row_id must be a positive integer"), nil
		}
		args := req.GetArguments()
		rawFields, ok := args["fields"].(map[string]any)
		if !ok || len(rawFields) == 0 {
			return errorResult("fields must be a non-empty JSON object of column-name → value"), nil
		}
		summary := strings.TrimSpace(req.GetString("summary", ""))
		if deps.RequireSummary && summary == "" {
			return errorResult("summary is required — format '[AI: <tool>] <description>'"), nil
		}

		row, err := deps.DataStore.GetRow(ctx, tableName, rowID)
		if err != nil {
			return errorResult("row not found: " + err.Error()), nil
		}
		if row.PagePath != "" {
			// Symmetric with insert/delete — a row's bound page is a
			// database projection, so its edit-permission is what gates
			// the row update.
			if !deps.canEdit(ctx, row.PagePath) {
				return errorResult("access denied: no edit permission on " + row.PagePath), nil
			}
		} else if !deps.isAdmin(ctx) {
			return errorResult("access denied: non-page-bound row updates require admin"), nil
		}

		force := req.GetBool("force", false)
		if row.PagePath != "" && !force && deps.DraftState != nil {
			if lock := deps.DraftState.GetLock(row.PagePath); lock.Owner != "" {
				return jsonResult(map[string]any{
					"error":       "page_draft_conflict",
					"draft_owner": lock.Owner,
					"since":       lock.Since,
					"page_path":   row.PagePath,
				}), nil
			}
			if draft, ok := deps.DraftState.FindAnyDraft(row.PagePath); ok {
				return jsonResult(map[string]any{
					"error":       "page_draft_conflict",
					"draft_owner": draft.Owner,
					"since":       draft.Since,
					"page_path":   row.PagePath,
				}), nil
			}
		}

		author := deps.ExtractUsername(ctx)
		// Pass summary separately — the attic stores them in different
		// fields; the earlier "author | summary" concatenation leaked
		// commit messages into {tag-query} and change-history author
		// columns.
		result, err := deps.RowWriter.UpdateRowWithPage(ctx, tableName, rowID, rawFields, author, summary)
		if err != nil {
			return errorResult(err.Error()), nil
		}
		return jsonResult(map[string]any{
			"table":        tableName,
			"row":          result.Row,
			"page_path":    result.PagePath,
			"page_updated": result.PageUpdated,
			"forced":       force,
		}), nil
	})
}

// ── delete_database_row ────────────────────────────────────────────────────

func registerDeleteDatabaseRowTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("delete_database_row",
		mcpgo.WithDescription(
			"Delete a row by its numeric id. If the row was page-bound, the wiki "+
				"page is deleted too — but the page's history stays in the attic, "+
				"so an auditor still sees both the creation and the deletion in the "+
				"page changelog. Use this to clean up test rows without leaving "+
				"orphaned pages in a regulatory register.\n\n"+
				"Referential-integrity guard: before deleting, the tool scans every "+
				"table's active lookup/tag fields whose foreign_key matches this "+
				"table. If any row anywhere still references this id, the delete is "+
				"refused and the offending references are listed. Pass force=true "+
				"to override — the delete then proceeds and the referencing rows "+
				"are left pointing at a non-existent id (dangling), so use with care.\n\n"+
				"ACL: page-bound rows require the caller AND the @ai subject to "+
				"have edit permission on the bound page (symmetric with insert). "+
				"Non-page-bound rows require the caller to be in the admin group.",
		),
		mcpgo.WithString("table", mcpgo.Required(),
			mcpgo.Description("Table name."),
		),
		mcpgo.WithNumber("row_id", mcpgo.Required(),
			mcpgo.Description("Numeric id of the row to delete (the `id` column)."),
		),
		mcpgo.WithBoolean("force",
			mcpgo.Description("If true, bypass the referential-integrity check and delete even when other rows reference this one. Default false."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.RowWriter == nil || deps.DataStore == nil {
			return errorResult("database not connected"), nil
		}
		tableName := strings.TrimSpace(req.GetString("table", ""))
		if tableName == "" {
			return errorResult("table is required"), nil
		}
		rowID := req.GetInt("row_id", 0)
		if rowID <= 0 {
			return errorResult("row_id must be a positive integer"), nil
		}
		force := req.GetBool("force", false)

		// Fetch the row to know whether it's page-bound and what path to
		// check ACL against.
		row, err := deps.DataStore.GetRow(ctx, tableName, rowID)
		if err != nil {
			return errorResult("row not found: " + err.Error()), nil
		}
		if row.PagePath != "" {
			// Row-bound pages are database projections, not hand-crafted
			// content. Treat their whole lifecycle as an edit-scoped
			// operation so `insert` and `delete` share one permission
			// boundary — anyone who can create a row can clean it up.
			if !deps.canEdit(ctx, row.PagePath) {
				return errorResult("access denied: no edit permission on " + row.PagePath), nil
			}
		} else if !deps.isAdmin(ctx) {
			return errorResult("access denied: non-page-bound row deletes require admin"), nil
		}

		// Referential-integrity guard.
		if !force {
			refs, err := deps.DataStore.FindReferencesTo(ctx, tableName, rowID)
			if err != nil {
				return errorResult("check references: " + err.Error()), nil
			}
			if len(refs) > 0 {
				return jsonResult(map[string]any{
					"deleted":    false,
					"reason":     fmt.Sprintf("row is referenced by %d other row(s); pass force=true to delete anyway (would leave dangling references)", len(refs)),
					"references": refs,
				}), nil
			}
		}

		author := deps.ExtractUsername(ctx)
		result, err := deps.RowWriter.DeleteRowWithPage(ctx, tableName, rowID, author)
		if err != nil {
			return errorResult(err.Error()), nil
		}
		return jsonResult(map[string]any{
			"deleted":      true,
			"table":        result.TableName,
			"row_id":       result.RowID,
			"page_path":    result.PagePath,
			"page_deleted": result.PageDeleted,
			"forced":       force,
		}), nil
	})
}
