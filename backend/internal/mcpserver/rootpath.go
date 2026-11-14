package mcpserver

import "strings"

// Page paths are canonical everywhere in this package: they start with
// "/", namespace indexes end with "/", and the root page is "/" — the
// same shape the HTTP API, links and the page store use. Tools accept a
// path with or without the leading slash and convert it once, on entry,
// with canonicalPageArg; everything after that, ACL checks, store calls
// and the paths returned to the client, uses the canonical form.

// canonicalPageArg converts a tool argument to a canonical page path:
// "docs/guide" → "/docs/guide", "docs/" → "/docs/", "/" → "/". An empty
// argument stays empty, so callers can report it as missing.
func canonicalPageArg(raw string) string {
	p := strings.TrimSpace(raw)
	if p == "" {
		return ""
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return p
}

// canonicalNamespaceArg converts a namespace argument to its canonical
// prefix: "" or "/" → "/", "docs" or "/docs/" → "/docs/".
func canonicalNamespaceArg(raw string) string {
	p := strings.Trim(strings.TrimSpace(raw), "/")
	if p == "" {
		return "/"
	}
	return "/" + p + "/"
}

// canonicalPrefixArg converts a path_prefix argument to a canonical page
// path without trailing slash ("docs" or "/docs/" → "/docs"), or "" for
// the whole wiki ("" or "/").
func canonicalPrefixArg(raw string) string {
	p := strings.Trim(strings.TrimSpace(raw), "/")
	if p == "" {
		return ""
	}
	return "/" + p
}

// inPrefix reports whether a canonical page path lies under a prefix from
// canonicalPrefixArg: the page itself, its namespace index, or anything
// below it. An empty prefix admits every page.
func inPrefix(pagePath, prefix string) bool {
	return prefix == "" || pagePath == prefix || strings.HasPrefix(pagePath, prefix+"/")
}

// prefixLabel is the prefix as reported back to the client.
func prefixLabel(prefix string) string {
	if prefix == "" {
		return "/"
	}
	return prefix
}
