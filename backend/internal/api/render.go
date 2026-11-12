package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"

	"sargon/backend/internal/auth"
)

func (s *Server) handleRender(w http.ResponseWriter, r *http.Request) {
	if s.browserAllocCtx == nil {
		http.Error(w, "Render endpoint is not available — no Chrome/Chromium found.", http.StatusServiceUnavailable)
		return
	}

	pagePath := "/" + strings.TrimPrefix(r.URL.Path, "/api/render/")

	baseURL, host := s.renderBaseAndHost(r)

	sessionID := ""
	tempSession := false
	if cookie, err := r.Cookie(auth.CookieName); err == nil {
		sessionID = cookie.Value
	} else {
		username := UsernameFromContext(r.Context())
		if username != "" {
			sessionID = s.sessionStore.Create(username)
			tempSession = true
		}
	}
	if tempSession {
		defer s.sessionStore.Delete(sessionID)
	}

	html, jsErrors, err := s.renderPageHTMLWithSession(r.Context(), pagePath, sessionID, baseURL, host)
	if err != nil {
		if len(jsErrors) > 0 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"page":      pagePath,
				"errors":    jsErrors,
				"html":      "",
				"rendering": "failed",
			})
			return
		}
		http.Error(w, fmt.Sprintf("Render failed: %v", err), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"page":      pagePath,
		"html":      html,
		"errors":    jsErrors,
		"rendering": "ok",
	})
}

// renderBaseAndHost computes the same base URL and cookie host that
// handleRender / handleExportPDF use, based on the incoming request. MCP
// calls have no browser request to read from; they use configBaseAndHost.
func (s *Server) renderBaseAndHost(r *http.Request) (baseURL, host string) {
	if s.serveWeb {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		if fwd := r.Header.Get("X-Forwarded-Proto"); fwd != "" {
			scheme = fwd
		}
		baseURL = fmt.Sprintf("%s://%s", scheme, r.Host)
	} else {
		baseURL = "http://localhost:5173"
	}
	host = r.Host
	if idx := strings.Index(host, ":"); idx != -1 {
		host = host[:idx]
	}
	return baseURL, host
}

// renderPageHTMLWithSession is the shared chromedp path used by both the
// HTTP /api/render/* endpoint and the MCP render_page tool. It navigates
// the headless browser to <baseURL><pagePath>?export=pdf, waits for the
// [data-export-ready] marker, and returns the OuterHTML of #content plus
// any JS console errors observed during navigation.
func (s *Server) renderPageHTMLWithSession(baseCtx context.Context, pagePath, sessionID, baseURL, host string) (string, []string, error) {
	if s.browserAllocCtx == nil {
		return "", nil, fmt.Errorf("chrome not available for rendering")
	}

	pageURL := fmt.Sprintf("%s%s?export=pdf", baseURL, pagePath)

	ctx, cancel := chromedp.NewContext(s.browserAllocCtx)
	defer cancel()
	ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	var tasks chromedp.Tasks
	var jsErrors []string
	chromedp.ListenTarget(ctx, func(ev interface{}) {
		if e, ok := ev.(*runtime.EventExceptionThrown); ok {
			msg := e.ExceptionDetails.Text
			if e.ExceptionDetails.Exception != nil && e.ExceptionDetails.Exception.Description != "" {
				msg = e.ExceptionDetails.Exception.Description
			}
			jsErrors = append(jsErrors, msg)
		}
	})

	if sessionID != "" {
		tasks = append(tasks, chromedp.ActionFunc(func(ctx context.Context) error {
			// Cookie name must match auth.CookieName ("gowiki_session"), not
			// a bare "session" — the auth middleware only recognizes that
			// exact name, so a mismatch means the frontend's /api/pages
			// fetch fires anonymously and 403s on any ACL-gated page.
			return network.SetCookie(auth.CookieName, sessionID).
				WithDomain(host).
				WithPath("/").
				Do(ctx)
		}))
	}
	tasks = append(tasks,
		chromedp.Navigate(pageURL),
		chromedp.WaitVisible(`[data-export-ready]`, chromedp.ByQuery),
	)

	var html string
	tasks = append(tasks, chromedp.OuterHTML(`#content`, &html, chromedp.ByID))
	if err := chromedp.Run(ctx, tasks); err != nil {
		return "", jsErrors, err
	}
	return html, jsErrors, nil
}

// RenderPageHTML implements mcpserver.PageRenderer. Called from the
// render_page MCP tool. Creates a temporary session for `username` so the
// headless browser can access ACL-gated pages, then hits the shared
// chromedp path. baseURL falls back to the configured site.base_url when
// present.
func (s *Server) RenderPageHTML(ctx context.Context, pagePath, username string) (string, []string, error) {
	if s.browserAllocCtx == nil {
		return "", nil, fmt.Errorf("render_page: Chrome not available on this deployment")
	}
	if !strings.HasPrefix(pagePath, "/") {
		pagePath = "/" + pagePath
	}

	baseURL, host := s.configBaseAndHost()

	sessionID := ""
	if username != "" && s.sessionStore != nil {
		sessionID = s.sessionStore.Create(username)
		defer s.sessionStore.Delete(sessionID)
	}
	return s.renderPageHTMLWithSession(ctx, pagePath, sessionID, baseURL, host)
}

// configBaseAndHost returns the base URL and cookie host for headless
// renders that do not come from a browser request (the MCP tools): the
// configured site.base_url, or the Vite dev server when none is set.
func (s *Server) configBaseAndHost() (baseURL, host string) {
	baseURL, host = "http://localhost:5173", "localhost"
	if s.configStore != nil {
		if cfg := s.configStore.Get(); cfg.Site.BaseURL != "" {
			if u, err := url.Parse(cfg.Site.BaseURL); err == nil && u.Host != "" {
				baseURL = strings.TrimRight(cfg.Site.BaseURL, "/")
				host = u.Hostname()
			}
		}
	}
	return baseURL, host
}
