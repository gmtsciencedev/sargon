package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"strings"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"

	"sargon/backend/internal/database"
)

// isAdmin returns true when the caller's user is in the admin group.
// Non-admins are refused by schema-management tools with a clear error rather
// than silently seeing an empty tool set — MCP does not filter tools/list
// per-caller, so all users see the tool names.
func (d Deps) isAdmin(ctx context.Context) bool {
	if d.UserStore == nil {
		return false
	}
	username := d.ExtractUsername(ctx)
	if username == "" {
		return false
	}
	return d.UserStore.IsAdmin(username)
}

// hasArg reports whether the caller explicitly set an argument (present in the
// JSON payload). Necessary for partial updates: absence must mean "keep the
// current value", which is different from "clear it".
func hasArg(args map[string]any, name string) bool {
	_, ok := args[name]
	return ok
}

// ── create_database_table ──────────────────────────────────────────────────

func registerCreateDatabaseTableTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("create_database_table",
		mcpgo.WithDescription(
			"Create a new structured-data table. Admin-only. The table's dynamic "+
				"data table is created empty (page_path column + timestamps); add "+
				"fields with create_database_field. Choose the table name carefully — "+
				"it is used verbatim in {database-query table=NAME} directives and "+
				"cannot be renamed after creation.",
		),
		mcpgo.WithString("name", mcpgo.Required(),
			mcpgo.Description("Machine name. Must match [a-z][a-z0-9_]* (lowercase, digits, underscore; letter first). Immutable."),
		),
		mcpgo.WithString("label", mcpgo.Required(),
			mcpgo.Description("Human-readable label shown in the admin UI."),
		),
		mcpgo.WithString("page_folder",
			mcpgo.Description("If set, rows in this table get a wiki page under this folder. Supports @field substitution — see the docs on page-bound rows. Example: '/regulatory/qms/soft/server/@server_name'."),
		),
		mcpgo.WithString("page_template_path",
			mcpgo.Description("Optional path to a template page whose markdown seeds the body of each new row-bound page. Leave empty for the default '# <id>' body."),
		),
		mcpgo.WithString("default_sort_field",
			mcpgo.Description("Field name used to sort database-query results when the directive doesn't specify sort=. Optional."),
		),
		mcpgo.WithString("default_sort_order",
			mcpgo.Description("'asc' or 'desc'. Default 'asc'."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.SchemaStore == nil {
			return errorResult("database not connected"), nil
		}
		if !deps.isAdmin(ctx) {
			return errorResult("access denied: schema management is admin-only"), nil
		}
		t := &database.TableDef{
			Name:             strings.TrimSpace(req.GetString("name", "")),
			Label:            strings.TrimSpace(req.GetString("label", "")),
			PageFolder:       strings.TrimSpace(req.GetString("page_folder", "")),
			PageTemplatePath: strings.TrimSpace(req.GetString("page_template_path", "")),
			DefaultSortField: strings.TrimSpace(req.GetString("default_sort_field", "")),
			DefaultSortOrder: strings.TrimSpace(req.GetString("default_sort_order", "")),
		}
		if t.Name == "" {
			return errorResult("name is required"), nil
		}
		if t.Label == "" {
			return errorResult("label is required"), nil
		}
		author := deps.ExtractUsername(ctx)
		if err := deps.SchemaStore.CreateTable(ctx, t, author); err != nil {
			return errorResult("create table: " + err.Error()), nil
		}
		return jsonResult(map[string]any{
			"id":                 t.ID,
			"name":               t.Name,
			"label":              t.Label,
			"page_folder":        t.PageFolder,
			"page_template_path": t.PageTemplatePath,
			"default_sort_field": t.DefaultSortField,
			"default_sort_order": t.DefaultSortOrder,
			"created_at":         t.CreatedAt,
		}), nil
	})
}

// ── create_database_field ──────────────────────────────────────────────────

func registerCreateDatabaseFieldTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("create_database_field",
		mcpgo.WithDescription(
			"Add a new field (column) to an existing table. Admin-only. "+
				"Field name must match [a-z][a-z0-9_]*; type is one of text, integer, "+
				"float, boolean, date, datetime, page_link, enum, multi_enum, "+
				"auto_increment, image, color, tag, lookup, user. Field name and type "+
				"are immutable — you cannot rename or retype a field afterwards.",
		),
		mcpgo.WithString("table_name", mcpgo.Required(),
			mcpgo.Description("Name of the table to add the field to."),
		),
		mcpgo.WithString("name", mcpgo.Required(),
			mcpgo.Description("Machine name of the field. Must match [a-z][a-z0-9_]*. Immutable."),
		),
		mcpgo.WithString("label", mcpgo.Required(),
			mcpgo.Description("Human-readable label shown in the admin UI."),
		),
		mcpgo.WithString("type", mcpgo.Required(),
			mcpgo.Description("Field type. Immutable. One of: text, integer, float, boolean, date, datetime, page_link, enum, multi_enum, auto_increment, image, color, tag, lookup, user."),
		),
		mcpgo.WithBoolean("required",
			mcpgo.Description("If true, newrow forms reject blank values for this field. Default false."),
		),
		mcpgo.WithString("default_value",
			mcpgo.Description("Default value pre-filled in newrow forms. Optional."),
		),
		mcpgo.WithNumber("display_order",
			mcpgo.Description("Sort order in the admin UI (lower = earlier). Optional."),
		),
		mcpgo.WithString("placeholder",
			mcpgo.Description("Placeholder text in newrow forms. Optional."),
		),
		mcpgo.WithString("foreign_key",
			mcpgo.Description("For tag/lookup fields: the target table's name. Ignored for other types."),
		),
		mcpgo.WithString("display_column",
			mcpgo.Description("For lookup fields: the target-table column whose value renders in the cell. When it is empty, archived or unset on a row, the cell shows the row's `name` field, else its id. Ignored for other types."),
		),
		mcpgo.WithArray("enum_values",
			mcpgo.Description("For enum/multi_enum: list of allowed string values. Ignored for other types."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.SchemaStore == nil {
			return errorResult("database not connected"), nil
		}
		if !deps.isAdmin(ctx) {
			return errorResult("access denied: schema management is admin-only"), nil
		}
		tableName := strings.TrimSpace(req.GetString("table_name", ""))
		if tableName == "" {
			return errorResult("table_name is required"), nil
		}
		table, err := deps.SchemaStore.GetTableByName(ctx, tableName)
		if err != nil {
			return errorResult("table not found: " + err.Error()), nil
		}
		f := &database.FieldDef{
			TableID:       table.ID,
			Name:          strings.TrimSpace(req.GetString("name", "")),
			Label:         strings.TrimSpace(req.GetString("label", "")),
			Type:          strings.TrimSpace(req.GetString("type", "")),
			Required:      req.GetBool("required", false),
			DefaultValue:  req.GetString("default_value", ""),
			DisplayOrder:  req.GetInt("display_order", 0),
			Placeholder:   req.GetString("placeholder", ""),
			ForeignKey:    strings.TrimSpace(req.GetString("foreign_key", "")),
			DisplayColumn: strings.TrimSpace(req.GetString("display_column", "")),
			EnumValues:    req.GetStringSlice("enum_values", nil),
		}
		if f.Name == "" || f.Label == "" || f.Type == "" {
			return errorResult("name, label, and type are all required"), nil
		}
		author := deps.ExtractUsername(ctx)
		if err := deps.SchemaStore.CreateField(ctx, f, author); err != nil {
			return errorResult("create field: " + err.Error()), nil
		}
		return jsonResult(map[string]any{
			"id":             f.ID,
			"table_name":     tableName,
			"name":           f.Name,
			"label":          f.Label,
			"type":           f.Type,
			"required":       f.Required,
			"default_value":  f.DefaultValue,
			"display_order":  f.DisplayOrder,
			"placeholder":    f.Placeholder,
			"foreign_key":    f.ForeignKey,
			"display_column": f.DisplayColumn,
			"enum_values":    f.EnumValues,
		}), nil
	})
}

// ── update_database_table ──────────────────────────────────────────────────

func registerUpdateDatabaseTableTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("update_database_table",
		mcpgo.WithDescription(
			"Update a table's metadata (label, page_folder, sort defaults, template). "+
				"Admin-only. Only supplied fields are updated; omitted fields are kept "+
				"as-is. The table `name` is immutable and used only to identify the "+
				"target table. No destructive operations — use the admin UI to delete a table.",
		),
		mcpgo.WithString("name", mcpgo.Required(),
			mcpgo.Description("Name of the table to update. Immutable identifier."),
		),
		mcpgo.WithString("label",
			mcpgo.Description("New human-readable label. Optional."),
		),
		mcpgo.WithString("page_folder",
			mcpgo.Description("New page_folder pattern (empty string clears it). Optional."),
		),
		mcpgo.WithString("page_template_path",
			mcpgo.Description("New page-template path. Optional."),
		),
		mcpgo.WithString("default_sort_field",
			mcpgo.Description("New default sort field. Optional."),
		),
		mcpgo.WithString("default_sort_order",
			mcpgo.Description("'asc' or 'desc'. Optional."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.SchemaStore == nil {
			return errorResult("database not connected"), nil
		}
		if !deps.isAdmin(ctx) {
			return errorResult("access denied: schema management is admin-only"), nil
		}
		tableName := strings.TrimSpace(req.GetString("name", ""))
		if tableName == "" {
			return errorResult("name is required"), nil
		}
		current, err := deps.SchemaStore.GetTableByName(ctx, tableName)
		if err != nil {
			return errorResult("table not found: " + err.Error()), nil
		}
		args := req.GetArguments()
		if hasArg(args, "label") {
			current.Label = strings.TrimSpace(req.GetString("label", ""))
		}
		if hasArg(args, "page_folder") {
			current.PageFolder = strings.TrimSpace(req.GetString("page_folder", ""))
		}
		if hasArg(args, "page_template_path") {
			current.PageTemplatePath = strings.TrimSpace(req.GetString("page_template_path", ""))
		}
		if hasArg(args, "default_sort_field") {
			current.DefaultSortField = strings.TrimSpace(req.GetString("default_sort_field", ""))
		}
		if hasArg(args, "default_sort_order") {
			order := strings.TrimSpace(req.GetString("default_sort_order", ""))
			if order != "" && order != "asc" && order != "desc" {
				return errorResult("default_sort_order must be 'asc' or 'desc'"), nil
			}
			current.DefaultSortOrder = order
		}
		author := deps.ExtractUsername(ctx)
		if err := deps.SchemaStore.UpdateTable(ctx, current, author); err != nil {
			return errorResult("update table: " + err.Error()), nil
		}
		return jsonResult(map[string]any{
			"id":                 current.ID,
			"name":               current.Name,
			"label":              current.Label,
			"page_folder":        current.PageFolder,
			"page_template_path": current.PageTemplatePath,
			"default_sort_field": current.DefaultSortField,
			"default_sort_order": current.DefaultSortOrder,
			"updated_at":         current.UpdatedAt,
		}), nil
	})
}

// ── update_database_field ──────────────────────────────────────────────────

func registerUpdateDatabaseFieldTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("update_database_field",
		mcpgo.WithDescription(
			"Update a field's metadata (label, required, default_value, "+
				"display_order, placeholder, enum_values). Admin-only. Only supplied "+
				"fields are updated.\n\n"+
				"For an EMPTY table (zero active rows) the tool also accepts `new_name` "+
				"and `new_type` — the underlying SQL column is renamed or dropped-and-"+
				"recreated. When the table has rows, both requests are refused with a "+
				"clear message; the workaround is `delete_database_row` on every row "+
				"first (or `delete_database_field` when you no longer need the field).",
		),
		mcpgo.WithString("table_name", mcpgo.Required(),
			mcpgo.Description("Name of the table the field belongs to."),
		),
		mcpgo.WithString("field_name", mcpgo.Required(),
			mcpgo.Description("Current machine name of the field."),
		),
		mcpgo.WithString("new_name",
			mcpgo.Description("New machine name (empty tables only). Must match [a-z][a-z0-9_]*. Renames the SQL column too."),
		),
		mcpgo.WithString("new_type",
			mcpgo.Description("New field type (empty tables only). One of: text, integer, float, boolean, date, datetime, page_link, enum, multi_enum, auto_increment, image, color, tag, lookup, user. Drops and recreates the SQL column."),
		),
		mcpgo.WithString("label",
			mcpgo.Description("New human-readable label. Optional."),
		),
		mcpgo.WithBoolean("required",
			mcpgo.Description("New required flag. Optional."),
		),
		mcpgo.WithString("default_value",
			mcpgo.Description("New default value. Optional."),
		),
		mcpgo.WithNumber("display_order",
			mcpgo.Description("New display order. Optional."),
		),
		mcpgo.WithString("placeholder",
			mcpgo.Description("New placeholder text. Optional."),
		),
		mcpgo.WithString("foreign_key",
			mcpgo.Description("New foreign_key target (tag/lookup only). Optional."),
		),
		mcpgo.WithString("display_column",
			mcpgo.Description("New display_column (lookup only). Optional."),
		),
		mcpgo.WithArray("enum_values",
			mcpgo.Description("New complete list of enum values (enum/multi_enum only). Replaces the entire list. Optional."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.SchemaStore == nil {
			return errorResult("database not connected"), nil
		}
		if !deps.isAdmin(ctx) {
			return errorResult("access denied: schema management is admin-only"), nil
		}
		tableName := strings.TrimSpace(req.GetString("table_name", ""))
		fieldName := strings.TrimSpace(req.GetString("field_name", ""))
		if tableName == "" || fieldName == "" {
			return errorResult("table_name and field_name are both required"), nil
		}
		table, err := deps.SchemaStore.GetTableByName(ctx, tableName)
		if err != nil {
			return errorResult("table not found: " + err.Error()), nil
		}
		var target *database.FieldDef
		for i := range table.Fields {
			if table.Fields[i].Name == fieldName && table.Fields[i].ArchivedAt == nil {
				target = &table.Fields[i]
				break
			}
		}
		if target == nil {
			return errorResult(fmt.Sprintf("field %q not found in table %q", fieldName, tableName)), nil
		}
		author := deps.ExtractUsername(ctx)
		args := req.GetArguments()

		// Rename first (empty-table only).
		if hasArg(args, "new_name") {
			newName := strings.TrimSpace(req.GetString("new_name", ""))
			if newName != "" && newName != target.Name {
				if err := deps.SchemaStore.RenameField(ctx, target.ID, newName, author); err != nil {
					if errors.Is(err, database.ErrTableNotEmpty) {
						return errorResult("cannot rename field: table has active rows"), nil
					}
					return errorResult("rename field: " + err.Error()), nil
				}
				target.Name = newName
			}
		}

		// Retype next (empty-table only).
		if hasArg(args, "new_type") {
			newType := strings.TrimSpace(req.GetString("new_type", ""))
			if newType != "" && newType != target.Type {
				if err := deps.SchemaStore.RetypeField(ctx, target.ID, newType, author); err != nil {
					if errors.Is(err, database.ErrTableNotEmpty) {
						return errorResult("cannot change field type: table has active rows"), nil
					}
					return errorResult("retype field: " + err.Error()), nil
				}
				target.Type = newType
			}
		}

		if hasArg(args, "label") {
			target.Label = strings.TrimSpace(req.GetString("label", ""))
		}
		if hasArg(args, "required") {
			target.Required = req.GetBool("required", false)
		}
		if hasArg(args, "default_value") {
			target.DefaultValue = req.GetString("default_value", "")
		}
		if hasArg(args, "display_order") {
			target.DisplayOrder = req.GetInt("display_order", 0)
		}
		if hasArg(args, "placeholder") {
			target.Placeholder = req.GetString("placeholder", "")
		}
		if hasArg(args, "foreign_key") {
			target.ForeignKey = strings.TrimSpace(req.GetString("foreign_key", ""))
		}
		if hasArg(args, "display_column") {
			target.DisplayColumn = strings.TrimSpace(req.GetString("display_column", ""))
		}
		if hasArg(args, "enum_values") {
			target.EnumValues = req.GetStringSlice("enum_values", nil)
		}
		if err := deps.SchemaStore.UpdateField(ctx, target, author); err != nil {
			return errorResult("update field: " + err.Error()), nil
		}
		return jsonResult(map[string]any{
			"id":             target.ID,
			"table_name":     tableName,
			"name":           target.Name,
			"label":          target.Label,
			"type":           target.Type,
			"required":       target.Required,
			"default_value":  target.DefaultValue,
			"display_order":  target.DisplayOrder,
			"placeholder":    target.Placeholder,
			"foreign_key":    target.ForeignKey,
			"display_column": target.DisplayColumn,
			"enum_values":    target.EnumValues,
		}), nil
	})
}

// ── delete_database_field ─────────────────────────────────────────────────

func registerDeleteDatabaseFieldTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("delete_database_field",
		mcpgo.WithDescription(
			"Permanently delete a field: drops the SQL column (or junction table / "+
				"sequence for multi_enum / auto_increment) and removes the field row. "+
				"Admin-only. Requires the table to have zero active rows — refuses "+
				"otherwise; the alternative is `update_database_field` with only "+
				"metadata changes, or the archive route from the admin UI. Historical "+
				"row-bound pages that still reference the field render its value as a "+
				"muted \"(removed)\" ghost entry — the value stays in the page attic.",
		),
		mcpgo.WithString("table_name", mcpgo.Required(),
			mcpgo.Description("Name of the table the field belongs to."),
		),
		mcpgo.WithString("field_name", mcpgo.Required(),
			mcpgo.Description("Machine name of the field to delete."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.SchemaStore == nil {
			return errorResult("database not connected"), nil
		}
		if !deps.isAdmin(ctx) {
			return errorResult("access denied: schema management is admin-only"), nil
		}
		tableName := strings.TrimSpace(req.GetString("table_name", ""))
		fieldName := strings.TrimSpace(req.GetString("field_name", ""))
		if tableName == "" || fieldName == "" {
			return errorResult("table_name and field_name are both required"), nil
		}
		table, err := deps.SchemaStore.GetTableByName(ctx, tableName)
		if err != nil {
			return errorResult("table not found: " + err.Error()), nil
		}
		var target *database.FieldDef
		for i := range table.Fields {
			if table.Fields[i].Name == fieldName && table.Fields[i].ArchivedAt == nil {
				target = &table.Fields[i]
				break
			}
		}
		if target == nil {
			return errorResult(fmt.Sprintf("field %q not found in table %q", fieldName, tableName)), nil
		}
		author := deps.ExtractUsername(ctx)
		if err := deps.SchemaStore.DeleteField(ctx, target.ID, author); err != nil {
			if errors.Is(err, database.ErrTableNotEmpty) {
				return errorResult("cannot delete field: table has active rows"), nil
			}
			return errorResult("delete field: " + err.Error()), nil
		}
		return jsonResult(map[string]any{
			"deleted":    true,
			"table_name": tableName,
			"field_name": fieldName,
		}), nil
	})
}
