package api

import (
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

// FaviconResolver finds a wiki's own favicon file. Implemented by the
// page store alongside ResolveLogo.
type FaviconResolver interface {
	ResolveFavicon() string
}

// bundleIconPaths are the icons index.html links. A wiki that has its own
// favicon file serves it under every one of these paths, so the browser
// tab, bookmarks and home-screen icon all show it.
var bundleIconPaths = map[string]bool{
	"/icons/favicon-32.png":       true,
	"/icons/favicon.ico":          true,
	"/icons/apple-touch-icon.png": true,
}

func (s *Server) handleFrontend(w http.ResponseWriter, r *http.Request) {
	if !s.serveWeb {
		http.NotFound(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		http.NotFound(w, r)
		return
	}

	if bundleIconPaths[r.URL.Path] {
		if fr, ok := s.logoResolver.(FaviconResolver); ok {
			if fp := fr.ResolveFavicon(); fp != "" {
				// Revalidate on every load so a replaced favicon shows
				// up without waiting for the browser cache to expire.
				w.Header().Set("Cache-Control", "no-cache")
				http.ServeFile(w, r, fp)
				return
			}
		}
	}

	requestPath := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if requestPath == "." {
		requestPath = "index.html"
	}

	fullPath := filepath.Join(s.webDirPath, requestPath)
	if info, err := os.Stat(fullPath); err == nil && !info.IsDir() {
		http.ServeFile(w, r, fullPath)
		return
	}

	// Redirect trailing-slash URLs to non-trailing-slash ONLY for existing leaf pages.
	// Namespace index pages keep the trailing slash.
	// Non-existent pages keep the trailing slash (the user may intend to create a namespace index).
	if strings.HasSuffix(r.URL.Path, "/") && r.URL.Path != "/" {
		trimmed := strings.TrimRight(strings.TrimPrefix(r.URL.Path, "/"), "/")
		if trimmed != "" {
			if store, ok := s.store.(interface {
				IsNamespaceIndex(string) bool
				PageExists(string) bool
			}); ok {
				// Only redirect if the page exists AND is a leaf (not a namespace index).
				if store.PageExists(trimmed) && !store.IsNamespaceIndex(trimmed) {
					target := "/" + trimmed
					if r.URL.RawQuery != "" {
						target += "?" + r.URL.RawQuery
					}
					http.Redirect(w, r, target, http.StatusMovedPermanently)
					return
				}
			}
		}
	}

	if canServeAsAttachmentPath(requestPath) {
		if resolved, err := s.mediaStore.ResolvePath(requestPath); err == nil {
			if info, statErr := os.Stat(resolved); statErr == nil && !info.IsDir() {
				s.serveMediaWithVersioning(w, r, requestPath)
				return
			}
		}
	}

	indexPath := filepath.Join(s.webDirPath, "index.html")
	http.ServeFile(w, r, indexPath)
}

func canServeAsAttachmentPath(requestPath string) bool {
	if requestPath == "" || requestPath == "index.html" {
		return false
	}
	base := path.Base(strings.TrimSpace(requestPath))
	return path.Ext(base) != ""
}

func (s *Server) handleFilePath(w http.ResponseWriter, r *http.Request) {
	if bundleIconPaths[r.URL.Path] {
		if fr, ok := s.logoResolver.(FaviconResolver); ok {
			if fp := fr.ResolveFavicon(); fp != "" {
				// Revalidate on every load so a replaced favicon shows
				// up without waiting for the browser cache to expire.
				w.Header().Set("Cache-Control", "no-cache")
				http.ServeFile(w, r, fp)
				return
			}
		}
	}

	requestPath := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if requestPath == "." || requestPath == "" {
		http.NotFound(w, r)
		return
	}

	if s.serveWeb {
		webPath := filepath.Join(s.webDirPath, requestPath)
		if info, err := os.Stat(webPath); err == nil && !info.IsDir() {
			http.ServeFile(w, r, webPath)
			return
		}
	}

	if !canServeAsAttachmentPath(requestPath) {
		http.NotFound(w, r)
		return
	}

	s.serveMediaWithVersioning(w, r, requestPath)
}

// serveMediaWithVersioning implements the 3-way version dispatch for media files:
//   - ?v=latest  → serve from disk (current file)
//   - ?v=N       → serve from attic (via serveVersionedMedia)
//   - bare (no ?v=) → if current version > 1, serve v=1 from attic; otherwise serve from disk
func (s *Server) serveMediaWithVersioning(w http.ResponseWriter, r *http.Request, mediaPath string) {
	vStr := r.URL.Query().Get("v")

	if strings.EqualFold(vStr, "latest") {
		// Explicit ?v=latest — always serve current file from disk.
		s.serveFromDisk(w, r, mediaPath)
		return
	}

	if vStr != "" {
		// Explicit ?v=N — serve that version.
		s.serveVersionedMedia(w, r, mediaPath, vStr)
		return
	}

	// Bare URL (no ?v=). Semantics: bare = v=1 (the original).
	// If the file has been overwritten (current version > 1), serve v=1 from attic.
	if s.mediaVersionStore != nil {
		current := s.mediaVersionStore.GetVersion(mediaPath)
		if current > 1 {
			s.serveVersionedMedia(w, r, mediaPath, "1")
			return
		}
	}

	// Current version is 0 or 1 — the file on disk IS v=1.
	s.serveFromDisk(w, r, mediaPath)
}

// serveFromDisk resolves and serves a media file directly from disk.
func (s *Server) serveFromDisk(w http.ResponseWriter, r *http.Request, mediaPath string) {
	resolved, err := s.mediaStore.ResolvePath(mediaPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	info, statErr := os.Stat(resolved)
	if statErr != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, resolved)
}

// serveVersionedMedia serves a specific version of a media file from the attic.
func (s *Server) serveVersionedMedia(w http.ResponseWriter, r *http.Request, mediaPath, vStr string) {
	version, err := strconv.ParseInt(vStr, 10, 64)
	if err != nil || version < 1 {
		http.NotFound(w, r)
		return
	}
	if s.mediaAtticStore == nil {
		http.NotFound(w, r)
		return
	}

	// If this is the current version, serve from disk (supports range requests, caching).
	if s.mediaVersionStore != nil {
		current := s.mediaVersionStore.GetVersion(mediaPath)
		if current == version || (current == 0 && version == 1) {
			if resolved, resolveErr := s.mediaStore.ResolvePath(mediaPath); resolveErr == nil {
				if info, statErr := os.Stat(resolved); statErr == nil && !info.IsDir() {
					http.ServeFile(w, r, resolved)
					return
				}
			}
		}
	}

	content, err := s.mediaAtticStore.ReadVersion(mediaPath, version)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	ct := mime.TypeByExtension(filepath.Ext(mediaPath))
	if ct == "" {
		ct = "application/octet-stream"
	}
	filename := path.Base(mediaPath)

	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition", "inline; filename=\""+filename+"\"")
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	w.Write(content)
}
