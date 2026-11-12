package mcpserver

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"testing"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"
)

type fakePDFExporter struct {
	pdf         []byte
	gotPath     string
	gotUsername string
}

func (f *fakePDFExporter) ExportPagePDF(_ context.Context, pagePath, username string) ([]byte, error) {
	f.gotPath, f.gotUsername = pagePath, username
	return f.pdf, nil
}

func callExportPDF(t *testing.T, deps Deps, ctx context.Context, path string) *mcpgo.CallToolResult {
	t.Helper()
	srv := mcpsrv.NewMCPServer("test", "0")
	registerExportPagePDFTool(srv, deps)
	req := mcpgo.CallToolRequest{}
	req.Params.Name = "export_page_pdf"
	req.Params.Arguments = map[string]any{"path": path}
	res, err := srv.GetTool("export_page_pdf").Handler(ctx, req)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	return res
}

func TestExportPagePDF_ReturnsSummaryAndBlob(t *testing.T) {
	deps, ctxFor := depsForTest(t)
	seedAIRule(t, deps.ACL, "view")
	pdf := []byte("%PDF-1.7 fake body")
	exp := &fakePDFExporter{pdf: pdf}
	deps.PDFExporter = exp

	res := callExportPDF(t, deps, ctxFor("editor_user"), "docs/guide")
	if res.IsError {
		t.Fatalf("unexpected error result: %+v", res.Content)
	}
	if exp.gotPath != "/docs/guide" || exp.gotUsername != "editor_user" {
		t.Errorf("exporter called with (%q, %q), want (/docs/guide, editor_user)", exp.gotPath, exp.gotUsername)
	}
	if len(res.Content) != 2 {
		t.Fatalf("want 2 content items (summary + PDF), got %d", len(res.Content))
	}

	var summary map[string]any
	if err := json.Unmarshal([]byte(res.Content[0].(mcpgo.TextContent).Text), &summary); err != nil {
		t.Fatalf("summary is not JSON: %v", err)
	}
	sum := sha256.Sum256(pdf)
	if summary["sha256"] != hex.EncodeToString(sum[:]) || summary["filename"] != "guide.pdf" || summary["path"] != "/docs/guide" {
		t.Errorf("summary = %v", summary)
	}

	blob, ok := res.Content[1].(mcpgo.EmbeddedResource).Resource.(mcpgo.BlobResourceContents)
	if !ok {
		t.Fatalf("second item is not a blob resource: %#v", res.Content[1])
	}
	if blob.MIMEType != "application/pdf" {
		t.Errorf("mime = %q", blob.MIMEType)
	}
	if got, _ := base64.StdEncoding.DecodeString(blob.Blob); string(got) != string(pdf) {
		t.Errorf("blob does not decode to the exported PDF")
	}
}

func TestExportPagePDF_RefusesWithoutViewPermission(t *testing.T) {
	deps, ctxFor := depsForTest(t) // no @ai rule: every view is refused
	exp := &fakePDFExporter{pdf: []byte("%PDF")}
	deps.PDFExporter = exp

	res := callExportPDF(t, deps, ctxFor("editor_user"), "/secret")
	if !res.IsError {
		t.Fatalf("expected an access-denied error")
	}
	if exp.gotPath != "" {
		t.Errorf("exporter ran despite the denial")
	}
}

func TestPDFFilename(t *testing.T) {
	for in, want := range map[string]string{
		"docs/guide": "guide.pdf",
		"docs/":      "docs.pdf",
		"":           "index.pdf",
		"page":       "page.pdf",
	} {
		if got := pdfFilename(in); got != want {
			t.Errorf("pdfFilename(%q) = %q, want %q", in, got, want)
		}
	}
}
