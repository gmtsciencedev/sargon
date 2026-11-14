package mcpserver

import (
	"context"
	"fmt"
	"strings"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"

	"golang.org/x/net/html"
)

// Caps for render_page output. Text mode is the default because 32 KB
// covers a normal wiki page comfortably while staying well under the
// context sizes most agents are comfortable with. HTML mode returns the
// raw #content DOM — up to 100 KB by default, which fits most pages but
// truncates the very large ones.
const (
	renderTextDefaultCap = 32 * 1024
	renderHTMLDefaultCap = 100 * 1024
	renderHardCap        = 1024 * 1024 // hard ceiling regardless of caller request
)

func registerRenderPageTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("render_page",
		mcpgo.WithDescription(
			"Return the FULLY-RENDERED page as a browser sees it — every "+
				"dynamic directive resolved: {database-query}, {tag-query} "+
				"(including grouped output), {reviewflow}, {template-stamp}, "+
				"resolved {{field}} placeholders on row-bound pages, and so on. "+
				"Reading raw Markdown via read_pages_batch skips all of that.\n\n"+
				"Use this to see what a human sees when the answer depends on "+
				"resolved data (database views, template stamps, live tag "+
				"queries) rather than the raw source.\n\n"+
				"Formats:\n"+
				"  • `text` (default) — structured text: headings marked (#, ##…), "+
				"lists as - item, links as [label](url), tables as pipe-tables. "+
				"Compact (~5–20 KB for a typical page). Default cap 32 KB.\n"+
				"  • `html` — the raw #content DOM (post-render). Larger; use only "+
				"when text isn't sufficient. Default cap 100 KB.\n\n"+
				"Over the cap the body is omitted (content_omitted: true) and the "+
				"metadata is returned instead. This is a heavy call (headless "+
				"Chrome per invocation, ~0.5–2s), not a bulk-scan tool.",
		),
		mcpgo.WithString("path", mcpgo.Required(),
			mcpgo.Description("Page path (leading slash optional). Namespace indexes end with '/'."),
		),
		mcpgo.WithString("format",
			mcpgo.Description("'text' (default) or 'html'."),
		),
		mcpgo.WithNumber("max_bytes",
			mcpgo.Description("Cap the returned body. Defaults: 32768 for text, 102400 for html. Hard ceiling: 1 MB."),
		),
	)

	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Renderer == nil {
			return errorResult("render_page: rendering not available on this deployment (no Chrome/Chromium)"), nil
		}
		pagePath := canonicalPageArg(req.GetString("path", ""))
		if pagePath == "" {
			return errorResult("path is required"), nil
		}
		if !deps.canView(ctx, pagePath) {
			return errorResult("access denied: no view permission on " + pagePath), nil
		}

		format := strings.ToLower(strings.TrimSpace(req.GetString("format", "text")))
		if format == "" {
			format = "text"
		}
		if format != "text" && format != "html" {
			return errorResult("format must be 'text' or 'html'"), nil
		}

		cap := req.GetInt("max_bytes", 0)
		if cap <= 0 {
			if format == "html" {
				cap = renderHTMLDefaultCap
			} else {
				cap = renderTextDefaultCap
			}
		}
		if cap > renderHardCap {
			cap = renderHardCap
		}

		username := deps.ExtractUsername(ctx)
		htmlSrc, jsErrors, err := deps.Renderer.RenderPageHTML(ctx, pagePath, username)
		if err != nil {
			return errorResult("render failed: " + err.Error()), nil
		}

		// Fetch version metadata alongside the render so the caller can
		// pin the answer to a specific version.
		var version int64
		if deps.Store != nil {
			if page, err := deps.Store.Get(pagePath); err == nil {
				version = page.Meta.Version
			}
		}

		var body string
		if format == "html" {
			body = htmlSrc
		} else {
			body = htmlToStructuredText(htmlSrc)
		}

		result := map[string]any{
			"path":         pagePath,
			"format":       format,
			"page_version": version,
			"size":         len(body),
		}
		if len(jsErrors) > 0 {
			result["js_errors"] = jsErrors
		}
		if len(body) > cap {
			result["content_omitted"] = true
			result["content_omitted_reason"] = fmt.Sprintf(
				"rendered body is %d bytes; cap is %d — pass max_bytes to raise it (hard ceiling %d), or use format=text for a smaller extraction",
				len(body), cap, renderHardCap,
			)
			return jsonResult(result), nil
		}
		result["body"] = body
		return jsonResult(result), nil
	})
}

// ── HTML → structured text ────────────────────────────────────────────────

// htmlToStructuredText walks the parsed HTML tree and emits a compact
// text form that preserves headings, lists, links, and tables. Invisible
// elements (script, style, template, [hidden]) are dropped entirely. The
// output is meant for an agent to read, not for round-tripping.
func htmlToStructuredText(src string) string {
	if strings.TrimSpace(src) == "" {
		return ""
	}
	doc, err := html.Parse(strings.NewReader("<div>" + src + "</div>"))
	if err != nil {
		return src // best effort — the caller sees raw HTML rather than nothing
	}
	var b strings.Builder
	renderNode(&b, doc, renderCtx{})
	// Collapse triple+ newlines to double, trim edges.
	out := b.String()
	for strings.Contains(out, "\n\n\n") {
		out = strings.ReplaceAll(out, "\n\n\n", "\n\n")
	}
	return strings.TrimSpace(out) + "\n"
}

type renderCtx struct {
	listDepth int
	inList    string // "ul" or "ol"
	inTable   bool
}

// isInvisible returns true for elements that should never contribute to
// the text output — scripts, styles, template scaffolding, hidden nodes.
func isInvisible(n *html.Node) bool {
	if n.Type != html.ElementNode {
		return false
	}
	switch n.Data {
	case "script", "style", "template", "noscript", "svg", "math":
		return true
	}
	for _, a := range n.Attr {
		if a.Key == "hidden" {
			return true
		}
		if a.Key == "style" && strings.Contains(a.Val, "display:none") {
			return true
		}
		if a.Key == "aria-hidden" && a.Val == "true" {
			return true
		}
	}
	return false
}

func renderNode(b *strings.Builder, n *html.Node, ctx renderCtx) {
	if isInvisible(n) {
		return
	}
	switch n.Type {
	case html.TextNode:
		b.WriteString(collapseWS(n.Data))
		return
	case html.ElementNode:
		switch n.Data {
		case "h1", "h2", "h3", "h4", "h5", "h6":
			level := int(n.Data[1] - '0')
			b.WriteString("\n\n")
			b.WriteString(strings.Repeat("#", level))
			b.WriteByte(' ')
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				renderNode(b, c, ctx)
			}
			b.WriteString("\n")
			return
		case "p":
			b.WriteString("\n\n")
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				renderNode(b, c, ctx)
			}
			return
		case "br":
			b.WriteString("\n")
			return
		case "hr":
			b.WriteString("\n\n---\n\n")
			return
		case "ul", "ol":
			// Enumerate <li> children ourselves — passing renderCtx by value
			// means mutating orderedIdx inside a child li wouldn't survive
			// across siblings.
			childCtx := ctx
			childCtx.inList = n.Data
			childCtx.listDepth = ctx.listDepth + 1
			b.WriteString("\n")
			idx := 0
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				if c.Type == html.ElementNode && c.Data == "li" {
					idx++
					b.WriteString("\n")
					b.WriteString(strings.Repeat("  ", max0(childCtx.listDepth-1)))
					if childCtx.inList == "ol" {
						fmt.Fprintf(b, "%d. ", idx)
					} else {
						b.WriteString("- ")
					}
					for gc := c.FirstChild; gc != nil; gc = gc.NextSibling {
						renderNode(b, gc, childCtx)
					}
					continue
				}
				renderNode(b, c, childCtx)
			}
			return
		case "li":
			// Bare <li> (no ancestor <ul>/<ol> handled it) — render as a
			// dash-prefixed bullet on its own line.
			b.WriteString("\n- ")
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				renderNode(b, c, ctx)
			}
			return
		case "a":
			href := getAttr(n, "href")
			var inner strings.Builder
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				renderNode(&inner, c, ctx)
			}
			label := strings.TrimSpace(inner.String())
			if href == "" {
				b.WriteString(label)
			} else if label == "" || label == href {
				b.WriteString(href)
			} else {
				fmt.Fprintf(b, "[%s](%s)", label, href)
			}
			return
		case "img":
			alt := getAttr(n, "alt")
			src := getAttr(n, "src")
			if alt == "" {
				alt = "image"
			}
			if src != "" {
				fmt.Fprintf(b, "![%s](%s)", alt, src)
			} else {
				fmt.Fprintf(b, "![%s]", alt)
			}
			return
		case "code":
			b.WriteByte('`')
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				renderNode(b, c, ctx)
			}
			b.WriteByte('`')
			return
		case "pre":
			b.WriteString("\n\n```\n")
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				renderNode(b, c, renderCtx{}) // reset context inside code
			}
			b.WriteString("\n```\n\n")
			return
		case "strong", "b":
			b.WriteString("**")
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				renderNode(b, c, ctx)
			}
			b.WriteString("**")
			return
		case "em", "i":
			b.WriteByte('*')
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				renderNode(b, c, ctx)
			}
			b.WriteByte('*')
			return
		case "table":
			renderTable(b, n)
			return
		case "blockquote":
			var inner strings.Builder
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				renderNode(&inner, c, ctx)
			}
			for _, line := range strings.Split(strings.TrimSpace(inner.String()), "\n") {
				b.WriteString("\n> ")
				b.WriteString(line)
			}
			b.WriteString("\n")
			return
		}
	}
	// Default: recurse into children.
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		renderNode(b, c, ctx)
	}
}

// renderTable emits a pipe-table for a <table>. Uses text collected from
// each <th>/<td>, one column at a time. Assumes the first <tr> in the
// table is the header row (or a header row found inside <thead>).
func renderTable(b *strings.Builder, table *html.Node) {
	var rows [][]string
	var header []string

	var walk func(n *html.Node, inHead bool)
	walk = func(n *html.Node, inHead bool) {
		if n == nil {
			return
		}
		if n.Type == html.ElementNode {
			switch n.Data {
			case "thead":
				for c := n.FirstChild; c != nil; c = c.NextSibling {
					walk(c, true)
				}
				return
			case "tbody", "tfoot":
				for c := n.FirstChild; c != nil; c = c.NextSibling {
					walk(c, false)
				}
				return
			case "tr":
				var row []string
				allHeader := true
				for cell := n.FirstChild; cell != nil; cell = cell.NextSibling {
					if cell.Type != html.ElementNode {
						continue
					}
					if cell.Data != "th" && cell.Data != "td" {
						continue
					}
					if cell.Data != "th" {
						allHeader = false
					}
					var text strings.Builder
					for c := cell.FirstChild; c != nil; c = c.NextSibling {
						renderNode(&text, c, renderCtx{inTable: true})
					}
					s := strings.TrimSpace(text.String())
					s = strings.ReplaceAll(s, "\n", " ")
					s = strings.ReplaceAll(s, "|", "\\|")
					row = append(row, s)
				}
				if len(header) == 0 && (inHead || allHeader) {
					header = row
				} else {
					rows = append(rows, row)
				}
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, inHead)
		}
	}
	walk(table, false)

	if len(header) == 0 && len(rows) > 0 {
		// Synthesize a blank header so the pipe-table stays well-formed.
		header = make([]string, len(rows[0]))
	}
	if len(header) == 0 {
		return
	}
	b.WriteString("\n\n")
	b.WriteString("| " + strings.Join(header, " | ") + " |\n")
	sep := make([]string, len(header))
	for i := range sep {
		sep[i] = "---"
	}
	b.WriteString("| " + strings.Join(sep, " | ") + " |\n")
	for _, row := range rows {
		// Pad short rows.
		for len(row) < len(header) {
			row = append(row, "")
		}
		if len(row) > len(header) {
			row = row[:len(header)]
		}
		b.WriteString("| " + strings.Join(row, " | ") + " |\n")
	}
	b.WriteString("\n")
}

func getAttr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func collapseWS(s string) string {
	// Collapse runs of any whitespace (including newlines) to a single
	// space so paragraph text doesn't inherit the source HTML's line
	// breaks. Real breaks come from block-level renderers.
	var b strings.Builder
	space := false
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			if !space {
				b.WriteByte(' ')
				space = true
			}
			continue
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

func max0(x int) int {
	if x < 0 {
		return 0
	}
	return x
}
