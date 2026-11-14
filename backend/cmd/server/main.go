package main

import (
	"context"
	"crypto/tls"
	"flag"
	"log"
	"net/http"
	_ "net/http/pprof"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/crypto/acme/autocert"

	"sargon/backend/internal/api"
	"sargon/backend/internal/config"
)

func main() {
	var (
		configFile = flag.String("config", "", "path to config file (YAML)")
		sitesDir   = flag.String("sites", "", "serve several wikis: one subdirectory per wiki, each holding its config.yaml")
		addr       = flag.String("addr", "", "HTTP listen address (overrides config)")
		dataDir    = flag.String("data-dir", "", "data root directory (overrides config)")
		serveWeb   = flag.Bool("serve-web", false, "serve built frontend assets from disk")
		webDir     = flag.String("web-dir", "", "directory containing built frontend assets (overrides config)")
		tlsDomain  = flag.String("tls-domain", "", "domain for automatic TLS via Let's Encrypt (overrides config)")
	)
	flag.Parse()

	if *sitesDir != "" {
		if *configFile != "" || *dataDir != "" || *tlsDomain != "" {
			log.Fatalf("--sites: --config, --data-dir and --tls-domain are per wiki; set them in each wiki's config.yaml")
		}
		runMultiSite(filepath.Clean(*sitesDir), *addr, *serveWeb, *webDir)
		return
	}

	// Load config: from -config flag, or from data-dir/config.yaml (legacy), or defaults.
	var configPath string
	var configStore *config.Store
	if *configFile != "" {
		configPath = filepath.Clean(*configFile)
		var err error
		configStore, err = config.Load(configPath)
		if err != nil {
			log.Fatalf("init config: %v", err)
		}
	}

	// Resolve data root: CLI flag > config > legacy default.
	dataRoot := *dataDir
	if dataRoot == "" && configStore != nil {
		dataRoot = configStore.Get().DataDir
	}
	if dataRoot == "" {
		// Legacy default: ./backend/data (content root was ./backend/data/content).
		dataRoot = "./backend/data"
	}
	dataRoot = filepath.Clean(dataRoot)

	// If no -config was given, load config from data root (legacy behavior).
	if configStore == nil {
		configPath = filepath.Join(dataRoot, "config.yaml")
		var err error
		configStore, err = config.Load(configPath)
		if err != nil {
			log.Fatalf("init config: %v", err)
		}
	}

	cfg := configStore.Get()

	// Resolve server settings: CLI flags override config.
	listenAddr := cfg.Server.Addr
	if *addr != "" {
		listenAddr = *addr
	}
	if listenAddr == "" {
		listenAddr = ":8080"
	}

	resolvedTLSDomain := cfg.Server.TLSDomain
	if *tlsDomain != "" {
		resolvedTLSDomain = *tlsDomain
	}

	resolvedWebDir := cfg.Server.WebDir
	if *webDir != "" {
		resolvedWebDir = *webDir
	}
	if resolvedWebDir == "" {
		resolvedWebDir = "./frontend/dist"
	}

	if resolvedTLSDomain == "" {
		startPprof()
	}

	browserCtx, browserCancel := api.InitBrowser()
	defer browserCancel()

	s, err := buildSite(siteOptions{
		configPath:  configPath,
		configStore: configStore,
		dataRoot:    dataRoot,
		serveWeb:    *serveWeb || cfg.Server.WebDir != "",
		webDir:      resolvedWebDir,
		browserCtx:  browserCtx,
	})
	if err != nil {
		log.Fatalf("%v", err)
	}

	if resolvedTLSDomain != "" {
		serveTLS(s.handler, filepath.Join(dataRoot, "certs"), []string{resolvedTLSDomain}, s.shutdown)
	} else {
		serveHTTP(s.handler, listenAddr, s.shutdown)
	}
	log.Printf("server stopped")
}

// startPprof exposes the profiler on :6060. Only in plain-HTTP mode: a
// TLS deployment is public and must not expose debug endpoints.
func startPprof() {
	go func() {
		log.Printf("pprof: listening on :6060")
		log.Println(http.ListenAndServe(":6060", nil))
	}()
}

// serveTLS serves handler on :443 with Let's Encrypt certificates for the
// given domains, and ACME challenges plus an HTTPS redirect on :80. It
// returns after SIGINT/SIGTERM, once the listeners stopped and onStop ran.
func serveTLS(handler http.Handler, certDir string, domains []string, onStop func()) {
	if err := os.MkdirAll(certDir, 0o700); err != nil {
		log.Fatalf("create cert dir: %v", err)
	}
	m := &autocert.Manager{
		Cache:      autocert.DirCache(certDir),
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist(domains...),
	}

	httpServer := &http.Server{
		Addr:    ":80",
		Handler: m.HTTPHandler(nil), // nil = redirect non-ACME to HTTPS
	}
	go func() {
		log.Printf("http: listening on :80 (ACME + redirect)")
		if err := httpServer.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatalf("http server failed: %v", err)
		}
	}()

	// autocert's TLS config advertises acme-tls/1 next to h2 and
	// http/1.1, so Let's Encrypt can validate over TLS-ALPN-01 on :443
	// instead of logging a refused handshake before falling back to
	// HTTP-01 on :80.
	tlsConfig := m.TLSConfig()
	tlsConfig.MinVersion = tls.VersionTLS12
	httpsServer := &http.Server{
		Addr:      ":443",
		Handler:   handler,
		TLSConfig: tlsConfig,
	}
	go func() {
		log.Printf("https: listening on :443 (domains: %v)", domains)
		if err := httpsServer.ListenAndServeTLS("", ""); err != http.ErrServerClosed {
			log.Fatalf("https server failed: %v", err)
		}
	}()

	waitForSignal()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	httpsServer.Shutdown(ctx)
	httpServer.Shutdown(ctx)
	onStop()
}

// serveHTTP serves handler in plain HTTP on addr until SIGINT/SIGTERM.
func serveHTTP(handler http.Handler, addr string, onStop func()) {
	log.Printf("http: listening on %s", addr)
	server := &http.Server{Addr: addr, Handler: handler}
	go func() {
		if err := server.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatalf("http server failed: %v", err)
		}
	}()

	waitForSignal()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	server.Shutdown(ctx)
	onStop()
}

func waitForSignal() {
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt, syscall.SIGTERM)
	<-shutdown
	log.Printf("shutting down...")
}
