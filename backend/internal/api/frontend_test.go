package api

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// canServeAsAttachmentPath is a pure helper — the frontend fallback
// only serves paths that have an extension AND aren't the app entry
// point. Everything else falls through to the SPA (index.html).
func TestCanServeAsAttachmentPath(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   string
		want bool
	}{
		{"", false},
		{"index.html", false},         // reserved app entry point
		{"page", false},               // no extension → not an attachment
		{"docs/guide", false},         // no extension
		{"docs/", false},              // no basename
		{"image.png", true},           // extension → serve as media
		{"docs/attachment.pdf", true}, // nested with extension
		{"path/with.dots/in-it/file.txt", true},
		{"trailing.", true}, // trailing "." IS an extension per path.Ext — the pass-through accepts it
	}
	for _, c := range cases {
		if got := canServeAsAttachmentPath(c.in); got != c.want {
			t.Errorf("canServeAsAttachmentPath(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

type fakeFavicon string

func (f fakeFavicon) ResolveLogo() (string, error) { return "", nil }
func (f fakeFavicon) ResolveFavicon() string       { return string(f) }

// A wiki with its own favicon file serves it under the bundle's icon
// paths; a wiki without one serves the bundle's icon.
func TestHandleFrontend_PerWikiFavicon(t *testing.T) {
	web := t.TempDir()
	if err := os.MkdirAll(filepath.Join(web, "icons"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"favicon-32.png", "favicon.ico", "apple-touch-icon.png"} {
		if err := os.WriteFile(filepath.Join(web, "icons", name), []byte("bundle"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	own := filepath.Join(t.TempDir(), "favicon.png")
	if err := os.WriteFile(own, []byte("wiki"), 0o644); err != nil {
		t.Fatal(err)
	}

	get := func(s *Server, path string) string {
		rec := httptest.NewRecorder()
		s.handleFrontend(rec, httptest.NewRequest("GET", path, nil))
		return rec.Body.String()
	}
	withOwn := &Server{serveWeb: true, webDirPath: web, logoResolver: fakeFavicon(own)}
	without := &Server{serveWeb: true, webDirPath: web, logoResolver: fakeFavicon("")}
	for _, p := range []string{"/icons/favicon-32.png", "/icons/favicon.ico", "/icons/apple-touch-icon.png"} {
		if got := get(withOwn, p); got != "wiki" {
			t.Errorf("with own favicon, %s served %q", p, got)
		}
		if got := get(without, p); got != "bundle" {
			t.Errorf("without own favicon, %s served %q", p, got)
		}
	}
}
