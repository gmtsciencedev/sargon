package mcpserver

import (
	"context"
	"fmt"
	"strings"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"
)

// wikiURIPrefix is the URI scheme we use to address pages as MCP resources.
// The full form is wiki:///path/to/page — clients can either list_resources
// or fetch any wiki URI directly through the template.
const wikiURIPrefix = "wiki:///"

func registerResources(srv *mcpsrv.MCPServer, deps Deps) {
	// Template: wiki:///{path} — covers every page.
	tmpl := mcpgo.NewResourceTemplate(
		wikiURIPrefix+"{path}",
		"Wiki page",
		mcpgo.WithTemplateDescription(
			"Any page on the wiki, addressed by its canonical path. "+
				"Use wiki:/// for the root, wiki:///docs/guide for a leaf, wiki:///docs/ for a namespace index.",
		),
		mcpgo.WithTemplateMIMEType("text/markdown"),
	)
	srv.AddResourceTemplate(tmpl, func(ctx context.Context, req mcpgo.ReadResourceRequest) ([]mcpgo.ResourceContents, error) {
		return readWikiResource(ctx, deps, req.Params.URI)
	})

	// A concrete resource for the root page gives clients a useful starting point.
	if deps.Store != nil {
		rootRes := mcpgo.NewResource(
			wikiURIPrefix,
			"Wiki root",
			mcpgo.WithResourceDescription("The wiki's root index page. Use list_namespace to discover more pages."),
			mcpgo.WithMIMEType("text/markdown"),
		)
		srv.AddResource(rootRes, func(ctx context.Context, req mcpgo.ReadResourceRequest) ([]mcpgo.ResourceContents, error) {
			return readWikiResource(ctx, deps, req.Params.URI)
		})
	}
}

// readWikiResource fetches a page by its wiki:/// URI, enforcing the same
// dual-ACL model as the tool handlers.
func readWikiResource(ctx context.Context, deps Deps, uri string) ([]mcpgo.ResourceContents, error) {
	if deps.Store == nil {
		return nil, fmt.Errorf("page store not available")
	}
	if !strings.HasPrefix(uri, wikiURIPrefix) {
		return nil, fmt.Errorf("unsupported URI %q — expected %s…", uri, wikiURIPrefix)
	}
	pagePath := canonicalPageArg(strings.TrimPrefix(uri, wikiURIPrefix))
	if pagePath == "" {
		pagePath = "/"
	}

	if !deps.canView(ctx, pagePath) {
		return nil, fmt.Errorf("access denied")
	}

	page, err := deps.Store.Get(pagePath)
	if err != nil {
		return nil, fmt.Errorf("page not found: %s", pagePath)
	}

	return []mcpgo.ResourceContents{
		mcpgo.TextResourceContents{
			URI:      uri,
			MIMEType: "text/markdown",
			Text:     page.Markdown,
		},
	}, nil
}
