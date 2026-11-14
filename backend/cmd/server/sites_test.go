package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeSite creates <dir>/<name>/config.yaml with the given body.
func writeSite(t *testing.T, dir, name, yaml string) string {
	t.Helper()
	siteDir := filepath.Join(dir, name)
	if err := os.MkdirAll(siteDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(siteDir, "config.yaml"), []byte(yaml), 0o644); err != nil {
		t.Fatal(err)
	}
	return siteDir
}

func TestLoadSites_HostsAndDataDirs(t *testing.T) {
	dir := t.TempDir()
	a := writeSite(t, dir, "alpha", "server:\n  tls_domain: Alpha.Example.org\n")
	writeSite(t, dir, "beta", "data_dir: /srv/beta-data\nserver:\n  tls_domain: beta.example.org\n")
	if err := os.MkdirAll(filepath.Join(dir, "certs"), 0o700); err != nil { // no config.yaml: skipped
		t.Fatal(err)
	}

	specs, err := loadSites(dir)
	if err != nil {
		t.Fatalf("loadSites: %v", err)
	}
	if len(specs) != 2 {
		t.Fatalf("want 2 wikis, got %d", len(specs))
	}
	if specs[0].host != "alpha.example.org" || !specs[0].tls || specs[0].dataRoot != filepath.Join(a, "data") {
		t.Errorf("alpha = %+v", specs[0])
	}
	if specs[1].host != "beta.example.org" || specs[1].dataRoot != "/srv/beta-data" {
		t.Errorf("beta = %+v", specs[1])
	}
	if _, err := os.Stat(filepath.Join(dir, "certs", "config.yaml")); err == nil {
		t.Errorf("a config.yaml was created in certs/")
	}
}

func TestLoadSites_BaseURLHostBehindProxy(t *testing.T) {
	dir := t.TempDir()
	writeSite(t, dir, "alpha", "site:\n  base_url: https://alpha.example.org/\n")
	specs, err := loadSites(dir)
	if err != nil {
		t.Fatalf("loadSites: %v", err)
	}
	if specs[0].host != "alpha.example.org" || specs[0].tls {
		t.Errorf("alpha = %+v", specs[0])
	}
}

func TestLoadSites_Refusals(t *testing.T) {
	cases := map[string]map[string]string{
		"no host name": {"alpha": "site:\n  title: A\n"},
		"same host": {
			"alpha": "server:\n  tls_domain: wiki.example.org\n",
			"beta":  "server:\n  tls_domain: WIKI.example.org\n",
		},
		"same data dir": {
			"alpha": "data_dir: /srv/shared\nserver:\n  tls_domain: a.example.org\n",
			"beta":  "data_dir: /srv/shared\nserver:\n  tls_domain: b.example.org\n",
		},
		"mixed TLS": {
			"alpha": "server:\n  tls_domain: a.example.org\n",
			"beta":  "site:\n  base_url: https://b.example.org\n",
		},
		"empty": {},
	}
	for name, sites := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			for n, y := range sites {
				writeSite(t, dir, n, y)
			}
			if _, err := loadSites(dir); err == nil {
				t.Errorf("loadSites accepted %v", sites)
			}
		})
	}
}

func TestHostDispatcher(t *testing.T) {
	d := hostDispatcher{
		"a.example.org": http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "A") }),
	}
	for host, want := range map[string]int{
		"a.example.org":      200,
		"A.EXAMPLE.ORG:8080": 200,
		"a.example.org.":     200,
		"b.example.org":      404,
	} {
		req := httptest.NewRequest("GET", "/", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		d.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("host %q: status %d, want %d", host, rec.Code, want)
		}
	}
}

// TestTwoWikisOneProcess builds two complete wikis in the same process and
// checks that each request reaches only the wiki its Host names.
func TestTwoWikisOneProcess(t *testing.T) {
	// Not t.TempDir(): the background index rebuild of each wiki may still
	// be writing when the test ends, and TempDir fails on a racing write.
	dir, err := os.MkdirTemp("", "sargon-sites-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	writeSite(t, dir, "alpha", "site:\n  title: Alpha\n  base_url: http://alpha.test\n")
	writeSite(t, dir, "beta", "site:\n  title: Beta\n  base_url: http://beta.test\n")
	page := filepath.Join(dir, "alpha", "data", "content", "only-in-alpha.md")
	if err := os.MkdirAll(filepath.Dir(page), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(page, []byte("# Alpha only\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	specs, err := loadSites(dir)
	if err != nil {
		t.Fatalf("loadSites: %v", err)
	}
	if len(specs) != 2 {
		t.Fatalf("want 2 wikis, got %d", len(specs))
	}
	d := hostDispatcher{}
	for _, spec := range specs {
		s, err := buildSite(siteOptions{
			name: spec.name, configPath: spec.configPath, configStore: spec.configStore,
			dataRoot: spec.dataRoot, webDir: "./frontend/dist",
		})
		if err != nil {
			t.Fatalf("buildSite %s: %v", spec.name, err)
		}
		t.Cleanup(s.shutdown)
		d[spec.host] = s.handler
	}

	get := func(host, path string) (int, string) {
		req := httptest.NewRequest("GET", path, nil)
		req.Host = host
		rec := httptest.NewRecorder()
		d.ServeHTTP(rec, req)
		return rec.Code, rec.Body.String()
	}

	if code, body := get("alpha.test", "/api/pages/only-in-alpha"); code != 200 || !strings.Contains(body, "Alpha only") {
		t.Errorf("alpha: status %d, body %.200s", code, body)
	}
	if code, _ := get("beta.test", "/api/pages/only-in-alpha"); code != 404 {
		t.Errorf("beta served alpha's page: status %d", code)
	}
	if _, err := os.Stat(filepath.Join(dir, "beta", "data", "meta")); err != nil {
		t.Errorf("beta has no data directory of its own: %v", err)
	}
}
