package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"sargon/backend/internal/api"
	"sargon/backend/internal/config"
)

// siteSpec is one wiki found under the --sites directory, before it is built.
type siteSpec struct {
	name        string // subdirectory name
	host        string // host name requests are dispatched on
	configPath  string
	configStore *config.Store
	dataRoot    string
	tls         bool // host comes from server.tls_domain
	webDir      string
}

// loadSites reads every subdirectory of dir that holds a config.yaml.
// Subdirectories without one (the shared certs/ directory, for instance)
// are skipped.
//
// A wiki's host name is its server.tls_domain; without one, the host of
// site.base_url. Either every wiki has a tls_domain — the server then
// terminates TLS for all of them — or none has, and the server speaks
// plain HTTP behind whatever terminates TLS. A wiki's data lives in
// data_dir (relative paths resolve against the wiki's own directory),
// by default <wiki>/data.
func loadSites(dir string) ([]siteSpec, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("--sites: %w", err)
	}
	var specs []siteSpec
	hosts := map[string]string{}
	roots := map[string]string{}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		siteDir := filepath.Join(dir, e.Name())
		configPath := filepath.Join(siteDir, "config.yaml")
		if _, err := os.Stat(configPath); err != nil {
			continue
		}
		store, err := config.Load(configPath)
		if err != nil {
			return nil, fmt.Errorf("wiki %s: %w", e.Name(), err)
		}
		cfg := store.Get()

		spec := siteSpec{name: e.Name(), configPath: configPath, configStore: store, webDir: cfg.Server.WebDir}
		switch {
		case cfg.Server.TLSDomain != "":
			spec.host, spec.tls = normalizeHost(cfg.Server.TLSDomain), true
		case cfg.Site.BaseURL != "":
			u, err := url.Parse(cfg.Site.BaseURL)
			if err != nil || u.Hostname() == "" {
				return nil, fmt.Errorf("wiki %s: site.base_url %q has no host name", e.Name(), cfg.Site.BaseURL)
			}
			spec.host = normalizeHost(u.Hostname())
		default:
			return nil, fmt.Errorf("wiki %s: set server.tls_domain (or site.base_url behind a proxy) to give it a host name", e.Name())
		}
		if other, dup := hosts[spec.host]; dup {
			return nil, fmt.Errorf("wikis %s and %s both answer to %s", other, e.Name(), spec.host)
		}
		hosts[spec.host] = e.Name()

		spec.dataRoot = cfg.DataDir
		if spec.dataRoot == "" {
			spec.dataRoot = "data"
		}
		if !filepath.IsAbs(spec.dataRoot) {
			spec.dataRoot = filepath.Join(siteDir, spec.dataRoot)
		}
		spec.dataRoot = filepath.Clean(spec.dataRoot)
		if other, dup := roots[spec.dataRoot]; dup {
			return nil, fmt.Errorf("wikis %s and %s share the data directory %s", other, e.Name(), spec.dataRoot)
		}
		roots[spec.dataRoot] = e.Name()

		if cfg.Server.Addr != "" && cfg.Server.Addr != config.DefaultConfig().Server.Addr {
			log.Printf("[%s] server.addr is ignored with --sites; the listen address is shared", e.Name())
		}
		specs = append(specs, spec)
	}
	if len(specs) == 0 {
		return nil, fmt.Errorf("--sites: no subdirectory of %s holds a config.yaml", dir)
	}
	tlsCount := 0
	for _, s := range specs {
		if s.tls {
			tlsCount++
		}
	}
	if tlsCount != 0 && tlsCount != len(specs) {
		var without []string
		for _, s := range specs {
			if !s.tls {
				without = append(without, s.name)
			}
		}
		return nil, fmt.Errorf("--sites: either every wiki sets server.tls_domain or none does; missing on %s", strings.Join(without, ", "))
	}
	return specs, nil
}

// normalizeHost lowercases a host name and drops a port and a trailing dot.
func normalizeHost(h string) string {
	if host, _, err := net.SplitHostPort(h); err == nil {
		h = host
	}
	return strings.TrimSuffix(strings.ToLower(h), ".")
}

// hostDispatcher routes each request to the wiki that answers to its Host.
type hostDispatcher map[string]http.Handler

func (d hostDispatcher) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h, ok := d[normalizeHost(r.Host)]; ok {
		h.ServeHTTP(w, r)
		return
	}
	http.Error(w, "No wiki is served at this address.", http.StatusNotFound)
}

// runMultiSite builds every wiki under dir and serves them on one listener.
func runMultiSite(dir, addrFlag string, serveWebFlag bool, webDirFlag string) {
	specs, err := loadSites(dir)
	if err != nil {
		log.Fatalf("%v", err)
	}
	useTLS := specs[0].tls
	if !useTLS {
		startPprof()
	}

	browserCtx, browserCancel := api.InitBrowser()
	defer browserCancel()

	dispatch := hostDispatcher{}
	var sites []*site
	var domains []string
	for _, spec := range specs {
		webDir := spec.webDir
		if webDirFlag != "" {
			webDir = webDirFlag
		}
		serveWeb := serveWebFlag || webDir != ""
		if webDir == "" {
			webDir = "./frontend/dist"
		}
		log.Printf("[%s] host %s", spec.name, spec.host)
		s, err := buildSite(siteOptions{
			name:        spec.name,
			configPath:  spec.configPath,
			configStore: spec.configStore,
			dataRoot:    spec.dataRoot,
			serveWeb:    serveWeb,
			webDir:      webDir,
			browserCtx:  browserCtx,
		})
		if err != nil {
			log.Fatalf("[%s] %v", spec.name, err)
		}
		dispatch[spec.host] = s.handler
		sites = append(sites, s)
		domains = append(domains, spec.host)
	}
	sort.Strings(domains)
	log.Printf("serving %d wikis: %s", len(sites), strings.Join(domains, ", "))

	stopAll := func() {
		for _, s := range sites {
			s.shutdown()
		}
	}
	if useTLS {
		serveTLS(dispatch, filepath.Join(dir, "certs"), domains, stopAll)
	} else {
		addr := addrFlag
		if addr == "" {
			addr = ":8080"
		}
		serveHTTP(dispatch, addr, stopAll)
	}
	log.Printf("server stopped")
}
