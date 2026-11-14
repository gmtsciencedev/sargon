package mcpserver

import (
	"context"
	"errors"
	"strings"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"
)

// ── create_page_from_template ─────────────────────────────────────────────
//
// The MCP twin of the "Create document" button. It resolves the three
// payload directives ({template-title}, {template-stamp},
// {template-reviewflow}) with the SAME rules and refuses under the SAME
// conditions as the HTTP endpoint — the guarantee is that a template only
// reachable from a browser is a template written out by hand.

func registerCreatePageFromTemplateTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("create_page_from_template",
		mcpgo.WithDescription(
			"Create a new page from a Sargon template. The template must carry a "+
				"{template} directive and, if it declares a reviewflow, be fully "+
				"validated; otherwise the tool refuses (a document must not carry "+
				"the version of a form still under review).\n\n"+
				"Every {template-*} directive in the payload is resolved:\n"+
				"  • {template-title} → the heading it prefixes is rewritten to `title`.\n"+
				"  • {template-stamp} → 'Created from template [<title>](<path>?v=<N>), version <tag>'. "+
				"    The version is FROZEN at creation — the stamp is a record of what was issued, "+
				"    not a live pointer at the template's current state.\n"+
				"  • {template-reviewflow …} → {reviewflow …} with defaults filled in "+
				"    (version=1.0; actors from the template's own {reviewflow} unless overridden here).\n\n"+
				"Refuses when: template is not a template, template's reviewflow has open roles, "+
				"destination `path` already exists.",
		),
		mcpgo.WithString("template_path", mcpgo.Required(),
			mcpgo.Description("Canonical path of the template page."),
		),
		mcpgo.WithString("path", mcpgo.Required(),
			mcpgo.Description("Destination path for the new document. Must not already exist."),
		),
		mcpgo.WithString("title", mcpgo.Required(),
			mcpgo.Description("The new document's H1 title. Replaces the pattern heading below {template-title}."),
		),
		mcpgo.WithObject("reviewflow",
			mcpgo.Description("Optional overrides for the resulting {reviewflow} directive. Keys: version, author, reviewer, validation. Any missing key falls back to the template-reviewflow arg, then to the template's own reviewflow value, then to '1.0' for version."),
		),
		mcpgo.WithString("summary", mcpgo.Required(),
			mcpgo.Description("Change summary. Format: '[AI: <tool-name>] <description>'."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.TemplateCreator == nil {
			return errorResult("template creation not wired on this server"), nil
		}
		if deps.Store == nil {
			return errorResult("page store not available"), nil
		}

		templatePath := canonicalPageArg(req.GetString("template_path", ""))
		dstPath := canonicalPageArg(req.GetString("path", ""))
		title := strings.TrimSpace(req.GetString("title", ""))
		summary := strings.TrimSpace(req.GetString("summary", ""))
		if templatePath == "" || dstPath == "" || title == "" {
			return errorResult("template_path, path and title are all required"), nil
		}
		if deps.RequireSummary && summary == "" {
			return errorResult("summary is required — format '[AI: <tool>] <description>'"), nil
		}

		// Reviewflow overrides — accept the standard four keys.
		override := map[string]string{}
		if raw, ok := req.GetArguments()["reviewflow"].(map[string]any); ok {
			for _, k := range []string{"version", "author", "reviewer", "validation"} {
				if v, ok := raw[k].(string); ok && v != "" {
					override[k] = v
				}
			}
		}

		// ACL: view on template, edit on destination namespace. canEdit
		// already tests both the caller and the @ai subject.
		dstNS := dstPath
		if idx := strings.LastIndex(dstPath, "/"); idx > 0 {
			dstNS = dstPath[:idx+1]
		}
		if !deps.canView(ctx, templatePath) {
			return errorResult("view permission denied on template " + templatePath), nil
		}
		if !deps.canEdit(ctx, dstNS) {
			return errorResult("edit permission denied on destination " + dstPath), nil
		}
		if deps.DraftState != nil {
			// Draft on the destination would be unusual (it doesn't exist
			// yet) but guard for the case where someone opened a new-page
			// draft on it.
			if lock := deps.DraftState.GetLock(dstPath); lock.Owner != "" {
				return errorResult("destination page is locked by " + lock.Owner), nil
			}
			if draft, ok := deps.DraftState.FindAnyDraft(dstPath); ok {
				return errorResult("destination page has an unpublished draft by " + draft.Owner), nil
			}
		}

		author := deps.ExtractUsername(ctx)
		result, err := deps.TemplateCreator.CreatePageFromTemplate(
			ctx, templatePath, dstPath, title, override, author, summary,
		)
		if err != nil {
			var kerr TemplateCreateKindedError
			if errors.As(err, &kerr) {
				return errorResult(kerr.Error()), nil
			}
			return errorResult("create failed: " + err.Error()), nil
		}
		return jsonResult(result), nil
	})
}
