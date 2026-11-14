package mcpserver

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"path"
	"strings"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"
)

// exportPDFHardCap bounds the PDF returned inline. Base64 inflates it by a
// third inside the JSON-RPC response.
const exportPDFHardCap = 20 * 1024 * 1024

func registerExportPagePDFTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("export_page_pdf",
		mcpgo.WithDescription(
			"Export a page to PDF — the same document the \"Export PDF\" button "+
				"produces: A4, running header with the site title, page numbers, "+
				"charts and mermaid diagrams rendered, every dynamic directive "+
				"resolved. The page is opened as the calling user, so ACLs apply.\n\n"+
				"Returns two content items: a JSON summary (path, page_version, "+
				"filename, size, sha256) and the PDF itself as an embedded "+
				"resource (mimeType application/pdf, base64 blob). Save the blob "+
				"under `filename` and check it against `sha256`.\n\n"+
				"Heavy call (headless Chrome per invocation, ~1–3 s). PDFs over "+
				"20 MB are refused.",
		),
		mcpgo.WithString("path", mcpgo.Required(),
			mcpgo.Description("Page path (leading slash optional). Namespace indexes end with '/'."),
		),
	)

	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.PDFExporter == nil {
			return errorResult("export_page_pdf: PDF export not available on this deployment (no Chrome/Chromium)"), nil
		}
		pagePath := canonicalPageArg(req.GetString("path", ""))
		if pagePath == "" {
			return errorResult("path is required"), nil
		}
		if !deps.canView(ctx, pagePath) {
			return errorResult("access denied: no view permission on " + pagePath), nil
		}

		var version int64
		if deps.Store != nil {
			page, err := deps.Store.Get(pagePath)
			if err != nil {
				return errorResult("page not found: " + pagePath), nil
			}
			version = page.Meta.Version
		}

		pdf, err := deps.PDFExporter.ExportPagePDF(ctx, pagePath, deps.ExtractUsername(ctx))
		if err != nil {
			return errorResult("PDF export failed: " + err.Error()), nil
		}
		if len(pdf) > exportPDFHardCap {
			return errorResult(fmt.Sprintf("PDF is %d bytes; the inline limit is %d", len(pdf), exportPDFHardCap)), nil
		}

		sum := sha256.Sum256(pdf)
		filename := pdfFilename(pagePath)
		summary := map[string]any{
			"path":         pagePath,
			"page_version": version,
			"filename":     filename,
			"mime":         "application/pdf",
			"size":         len(pdf),
			"sha256":       hex.EncodeToString(sum[:]),
		}
		result := jsonResult(summary)
		result.Content = append(result.Content, mcpgo.NewEmbeddedResource(mcpgo.BlobResourceContents{
			URI:      "wiki://" + pagePath + ".pdf",
			MIMEType: "application/pdf",
			Blob:     base64.StdEncoding.EncodeToString(pdf),
		}))
		return result, nil
	})
}

// pdfFilename names the export after the page: the last path segment, the
// namespace name for a namespace index ("/docs/" → "docs.pdf"), "index.pdf"
// for the root page "/".
func pdfFilename(pagePath string) string {
	name := path.Base(strings.TrimSuffix(pagePath, "/"))
	if name == "" || name == "." || name == "/" {
		name = "index"
	}
	return name + ".pdf"
}
