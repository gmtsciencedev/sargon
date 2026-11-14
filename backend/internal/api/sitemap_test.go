package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"sargon/backend/internal/storage"
)

// newSitemapTestServer wires a real FileStore under t.TempDir. The
// sitemap tree-builder just needs ListAllPages to return a real slice
// of PageEntry; no ACL, no auth, no other machinery involved.
func newSitemapTestServer(t *testing.T) (*Server, *storage.FileStore) {
	t.Helper()
	fs, err := storage.NewFileStore(t.TempDir() + "/content")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	return &Server{store: fs}, fs
}

func seedSitemapPage(t *testing.T, fs *storage.FileStore, pagePath, content string) {
	t.Helper()
	if _, err := fs.Put(pagePath, content, "seed"); err != nil {
		t.Fatalf("Put %s: %v", pagePath, err)
	}
}

// callSitemap invokes the handler and decodes the tree payload.
func callSitemap(t *testing.T, s *Server) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/sitemap", nil)
	rec := httptest.NewRecorder()
	s.handleSitemap(rec, req)
	var body map[string]any
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v — %s", err, rec.Body.String())
		}
	}
	return rec.Code, body
}

// TestSitemap_Empty — no pages → response contains a single root node
// with no children. The frontend renders this as an empty tree, not an
// error.
func TestSitemap_Empty(t *testing.T) {
	t.Parallel()
	s, _ := newSitemapTestServer(t)
	code, body := callSitemap(t, s)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	pages, _ := body["pages"].([]any)
	if len(pages) != 1 {
		t.Fatalf("expected exactly one top-level entry (the root), got %d", len(pages))
	}
	root, _ := pages[0].(map[string]any)
	if root["path"] != "/" {
		t.Errorf("root path = %v, want /", root["path"])
	}
	// No children when there are no pages.
	if _, has := root["children"]; has {
		t.Errorf("empty sitemap should not surface a `children` key on the root")
	}
}

// TestSitemap_SinglePage — one page → the root node has one child leaf.
func TestSitemap_SinglePage(t *testing.T) {
	t.Parallel()
	s, fs := newSitemapTestServer(t)
	seedSitemapPage(t, fs, "/hello", "# Hello\n\nbody")
	_, body := callSitemap(t, s)
	root := body["pages"].([]any)[0].(map[string]any)
	kids, _ := root["children"].([]any)
	if len(kids) != 1 {
		t.Fatalf("root children = %d, want 1", len(kids))
	}
	leaf := kids[0].(map[string]any)
	if leaf["path"] != "/hello" {
		t.Errorf("child path = %v, want /hello", leaf["path"])
	}
	if leaf["has_page"] != true {
		t.Errorf("leaf has_page = %v, want true", leaf["has_page"])
	}
}

// TestSitemap_NestedNamespace — a page under a namespace creates the
// namespace node as an intermediate ancestor even if the namespace
// itself has no index page.
func TestSitemap_NestedNamespace(t *testing.T) {
	t.Parallel()
	s, fs := newSitemapTestServer(t)
	seedSitemapPage(t, fs, "/docs/guide", "# Guide\n")
	_, body := callSitemap(t, s)
	root := body["pages"].([]any)[0].(map[string]any)
	kids, _ := root["children"].([]any)
	// The `docs` namespace node must exist even though /docs/ itself is
	// not a page.
	var docs map[string]any
	for _, k := range kids {
		m := k.(map[string]any)
		if m["path"] == "/docs/" {
			docs = m
			break
		}
	}
	if docs == nil {
		t.Fatalf("expected intermediate /docs/ node in %v", kids)
	}
	if has, _ := docs["has_page"].(bool); has {
		t.Errorf("intermediate /docs should have has_page=false; got true")
	}
	// The guide leaf lives under docs.
	docsKids, _ := docs["children"].([]any)
	if len(docsKids) != 1 || docsKids[0].(map[string]any)["path"] != "/docs/guide" {
		t.Errorf("expected /docs/guide as sole child of /docs, got %v", docsKids)
	}
}

// TestSitemap_NamespaceIndexHasPage — a namespace-index page
// (content/docs/index.md → canonical /docs/) surfaces as an entry
// with has_page=true. The is_namespace_index flag depends on
// FileStore's discovery pass; keep this assertion loose to what we
// know the sitemap tree guarantees, which is that the node exists
// and reports has_page.
func TestSitemap_NamespaceIndexHasPage(t *testing.T) {
	t.Parallel()
	s, fs := newSitemapTestServer(t)
	seedSitemapPage(t, fs, "/docs/", "# Docs index\n")
	_, body := callSitemap(t, s)
	root := body["pages"].([]any)[0].(map[string]any)
	kids, _ := root["children"].([]any)
	if len(kids) < 1 {
		t.Fatalf("expected at least one child, got %v", kids)
	}
	found := false
	for _, k := range kids {
		m := k.(map[string]any)
		p, _ := m["path"].(string)
		if p == "/docs/" {
			found = true
			if hp, _ := m["has_page"].(bool); !hp {
				t.Errorf("%s: has_page = false, want true", p)
			}
		}
	}
	if !found {
		t.Errorf("did not find /docs/ among root children: %v", kids)
	}
	if len(kids) != 1 {
		t.Errorf("want the single node /docs/ under the root, got %v", kids)
	}
}

// TestSitemap_RootPage — a root page (content/index.md → canonical /)
// populates the root node directly rather than adding a child.
func TestSitemap_RootPage(t *testing.T) {
	t.Parallel()
	s, fs := newSitemapTestServer(t)
	seedSitemapPage(t, fs, "/", "# Welcome\n")
	_, body := callSitemap(t, s)
	root := body["pages"].([]any)[0].(map[string]any)
	if root["path"] != "/" {
		t.Fatalf("root path = %v, want /", root["path"])
	}
	if hp, _ := root["has_page"].(bool); !hp {
		t.Errorf("root should have has_page=true when / exists; got %v", root["has_page"])
	}
	// Root page should NOT itself appear as a child.
	kids, _ := root["children"].([]any)
	for _, k := range kids {
		if k.(map[string]any)["path"] == "/" {
			t.Errorf("root should not be its own child")
		}
	}
}
