package mcpserver

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"

	"sargon/backend/internal/auth"
	"sargon/backend/internal/storage"
)

// The root page "/" normalises to "" inside the tools; reading, describing
// and writing it must work like any other page.
func TestRootPage_ReadMetaWrite(t *testing.T) {
	deps, ctxFor := depsForTest(t)
	rules := append(deps.ACL.List(),
		auth.ACLRule{Pattern: ".*", SubjectType: "special", Subject: "@ai", Permissions: []string{"view", "edit"}})
	if err := deps.ACL.Replace(rules); err != nil {
		t.Fatal(err)
	}
	content := t.TempDir()
	if err := os.WriteFile(filepath.Join(content, "index.md"), []byte("# Home\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fs, err := storage.NewFileStore(content)
	if err != nil {
		t.Fatal(err)
	}
	deps.Store = fs

	srv := mcpsrv.NewMCPServer("test", "0")
	registerTools(srv, deps)
	call := func(name string, args map[string]any) *mcpgo.CallToolResult {
		t.Helper()
		req := mcpgo.CallToolRequest{}
		req.Params.Name = name
		req.Params.Arguments = args
		res, err := srv.GetTool(name).Handler(ctxFor("admin_user"), req)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return res
	}
	text := func(res *mcpgo.CallToolResult) string { return res.Content[0].(mcpgo.TextContent).Text }

	if res := call("read_pages_batch", map[string]any{"paths": []any{"/"}}); !strings.Contains(text(res), "# Home") {
		t.Errorf("read_pages_batch(/) = %s", text(res))
	}
	if res := call("get_page_meta", map[string]any{"path": "/"}); res.IsError {
		t.Errorf("get_page_meta(/) = %s", text(res))
	}
	if res := call("write_page", map[string]any{"path": "/", "markdown": "# Home\n\nMore.\n", "summary": "[AI: test] extend"}); res.IsError {
		t.Fatalf("write_page(/) = %s", text(res))
	}
	got, err := os.ReadFile(filepath.Join(content, "index.md"))
	if err != nil || !strings.Contains(string(got), "More.") {
		t.Errorf("root page after write = %q, %v", got, err)
	}
	if res := call("get_page_meta", map[string]any{"path": ""}); !res.IsError {
		t.Errorf("an empty path must still be refused as missing")
	}
}
