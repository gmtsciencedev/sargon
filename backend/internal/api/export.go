package api

import (
	"context"
	"fmt"
	"html"
	"net/http"
	"strings"
	"time"

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"

	"sargon/backend/internal/auth"
)

func (s *Server) handleExportPDF(w http.ResponseWriter, r *http.Request) {
	if s.browserAllocCtx == nil {
		http.Error(w, "PDF export is not available — no Chrome/Chromium found. Check server logs.", http.StatusServiceUnavailable)
		return
	}

	pagePath := "/" + strings.TrimPrefix(r.URL.Path, "/api/export/pdf/")

	baseURL, host := s.renderBaseAndHost(r)

	// Forward the session cookie when present. A caller authenticated by
	// API token has none, so give the headless browser a temporary session
	// for that user — otherwise the frontend's /api/pages fetch runs
	// anonymously and 403s on any ACL-protected page.
	sessionID := ""
	if cookie, err := r.Cookie(auth.CookieName); err == nil {
		sessionID = cookie.Value
	} else if username := UsernameFromContext(r.Context()); username != "" {
		sessionID = s.sessionStore.Create(username)
		defer s.sessionStore.Delete(sessionID)
	}

	pdfBuf, err := s.printPagePDF(r.Context(), pagePath, sessionID, baseURL, host)
	if err != nil {
		http.Error(w, fmt.Sprintf("PDF generation failed: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.pdf"`, pagePath))
	w.Write(pdfBuf)
}

// ExportPagePDF implements mcpserver.PDFExporter. Called from the
// export_page_pdf MCP tool: a temporary session for `username` lets the
// headless browser open ACL-gated pages exactly as that user would.
func (s *Server) ExportPagePDF(ctx context.Context, pagePath, username string) ([]byte, error) {
	if s.browserAllocCtx == nil {
		return nil, fmt.Errorf("PDF export not available on this deployment (no Chrome/Chromium)")
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
	return s.printPagePDF(ctx, pagePath, sessionID, baseURL, host)
}

// printPagePDF is the chromedp path shared by the HTTP export endpoint and
// the MCP tool: it opens <baseURL><pagePath>?export=pdf with the given
// session, waits for the [data-export-ready] marker, and prints A4 with the
// running header and footer.
func (s *Server) printPagePDF(baseCtx context.Context, pagePath, sessionID, baseURL, host string) ([]byte, error) {
	pageURL := fmt.Sprintf("%s%s?export=pdf", baseURL, pagePath)

	ctx, cancel := chromedp.NewContext(s.browserAllocCtx)
	defer cancel()
	ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	var tasks chromedp.Tasks
	if sessionID != "" {
		tasks = append(tasks, chromedp.ActionFunc(func(ctx context.Context) error {
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

	// Determine the wiki's site title for the running header. Falls back to
	// "Sargon" if no configuration is loaded (e.g. dev mode without a store).
	siteTitle := "Sargon"
	loc := time.Local
	if s.configStore != nil {
		site := s.configStore.Get().Site
		if t := strings.TrimSpace(site.Title); t != "" {
			siteTitle = t
		}
		loc = site.Location()
	}
	// The footer timestamp is written here rather than through Chrome's
	// .date class, which prints the browser locale's short form
	// (11/12/26, 5:31 PM) in the server's zone without naming it.
	generated := pdfTimestamp(time.Now(), loc)

	var pdfBuf []byte
	tasks = append(tasks, chromedp.ActionFunc(func(ctx context.Context) error {
		var err error
		pdfBuf, _, err = page.PrintToPDF().
			WithPrintBackground(true).
			WithMarginTop(0.7).
			WithMarginBottom(0.7).
			WithMarginLeft(0.5).
			WithMarginRight(0.5).
			WithPaperWidth(8.27). // A4
			WithPaperHeight(11.69).
			WithDisplayHeaderFooter(true).
			WithHeaderTemplate(pdfHeaderTemplate(siteTitle)).
			WithFooterTemplate(pdfFooterTemplate(generated)).
			Do(ctx)
		return err
	}))

	if err := chromedp.Run(ctx, tasks); err != nil {
		return nil, err
	}
	return pdfBuf, nil
}

// pdfHeaderTemplate returns the running-header HTML Chrome injects on every
// printed page. Chrome only respects a handful of classes in these templates
// (.title, .date, .url, .pageNumber, .totalPages); any inline CSS must be
// explicit as @media print rules don't apply here.
//
// The page title is substituted by Chrome from document.title; the frontend
// sets that to the page's first heading in export mode.
func pdfHeaderTemplate(siteTitle string) string {
	return `<div style="font-size:9px; color:#888; width:100%; padding:4px 0.5in 0; -webkit-print-color-adjust:exact; box-sizing:border-box; font-family:-apple-system,BlinkMacSystemFont,sans-serif; display:flex; justify-content:space-between; align-items:center;">
  <span class="title" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:60%;"></span>
  <span>` + html.EscapeString(siteTitle) + `</span>
</div>`
}

// pdfFooterTemplate returns the running-footer HTML: the generation
// timestamp (see pdfTimestamp) on the left and the page count on the right.
// Chrome substitutes `.pageNumber` and `.totalPages` at print time.
func pdfFooterTemplate(generated string) string {
	return `<div style="font-size:9px; color:#888; width:100%; padding:0 0.5in 4px; -webkit-print-color-adjust:exact; box-sizing:border-box; font-family:-apple-system,BlinkMacSystemFont,sans-serif; display:flex; justify-content:space-between;">
  <span>Generated ` + html.EscapeString(generated) + `</span>
  <span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`
}

// pdfTimestamp formats the "Generated" footer stamp: ISO date, 24-hour
// time, and the zone abbreviation (CET, CEST, UTC…), so a printed record
// reads the same to every reader.
func pdfTimestamp(t time.Time, loc *time.Location) string {
	return t.In(loc).Format("2006-01-02 15:04 MST")
}
