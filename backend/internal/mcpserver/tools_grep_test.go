package mcpserver

import (
	"regexp"
	"testing"
)

// grepPages is the pure core of search_pages' pattern (grep) branch.
// Covers the shape agents care about: exact matching, line+column,
// per-page and total caps, ACL filtering, path-prefix scoping,
// scan-complete signalling, count-only mode.

// Helper: build a page corpus as a map so the getMarkdown callback is
// easy to configure per test. Map keys are canonical page paths, as
// Sitemap.ListAllPages returns them and as grepPages passes them on.
func newCorpus(pages map[string]string) (paths []string, getMarkdown func(string) (string, error)) {
	for p := range pages {
		paths = append(paths, p)
	}
	getMarkdown = func(p string) (string, error) { return pages[p], nil }
	return paths, getMarkdown
}

func TestGrepPages_LiteralMatch_LineAndColumn(t *testing.T) {
	t.Parallel()
	paths, getMarkdown := newCorpus(map[string]string{
		"/docs/a": "first line\nhere is TOKEN in line 2\nthird line\n",
	})
	re := regexp.MustCompile(`TOKEN`)
	res := grepPages(grepScanArgs{
		pages: paths, re: re, limit: 100,
		getMarkdown: getMarkdown,
	})
	if res.Scanned != 1 {
		t.Errorf("scanned = %d, want 1", res.Scanned)
	}
	if len(res.Matches) != 1 {
		t.Fatalf("matches = %d, want 1", len(res.Matches))
	}
	m := res.Matches[0]
	if m.Path != "/docs/a" {
		t.Errorf("Path = %q", m.Path)
	}
	if m.Line != 2 {
		t.Errorf("Line = %d, want 2", m.Line)
	}
	if m.Column != 9 { // "here is TOKEN..." → T is at byte 9 (1-indexed)
		t.Errorf("Column = %d, want 9", m.Column)
	}
	if m.Match != "TOKEN" {
		t.Errorf("Match = %q", m.Match)
	}
	if m.LineText != "here is TOKEN in line 2" {
		t.Errorf("LineText = %q", m.LineText)
	}
	// Full-corpus scan completed, no truncation.
	if !res.ScanComplete {
		t.Errorf("ScanComplete = false, want true (no truncation hit)")
	}
	if res.TruncatedAtCap {
		t.Errorf("TruncatedAtCap = true, want false")
	}
}

func TestGrepPages_MultipleOccurrencesOnOneLine(t *testing.T) {
	t.Parallel()
	paths, getMarkdown := newCorpus(map[string]string{
		"/p": "foo foo foo\n",
	})
	re := regexp.MustCompile(`foo`)
	res := grepPages(grepScanArgs{
		pages: paths, re: re, limit: 100,
		getMarkdown: getMarkdown,
	})
	if len(res.Matches) != 3 {
		t.Fatalf("matches = %d, want 3", len(res.Matches))
	}
	if res.Matches[0].Column != 1 || res.Matches[1].Column != 5 || res.Matches[2].Column != 9 {
		t.Errorf("columns = [%d %d %d], want [1 5 9]",
			res.Matches[0].Column, res.Matches[1].Column, res.Matches[2].Column)
	}
}

func TestGrepPages_RespectsLimit(t *testing.T) {
	t.Parallel()
	paths, getMarkdown := newCorpus(map[string]string{
		"/a": "hit\nhit\nhit\n",
		"/b": "hit\nhit\n",
	})
	re := regexp.MustCompile(`hit`)
	res := grepPages(grepScanArgs{
		pages: paths, re: re, limit: 2,
		getMarkdown: getMarkdown,
	})
	if len(res.Matches) != 2 {
		t.Errorf("matches = %d, want 2 (hard cap)", len(res.Matches))
	}
	if !res.TruncatedAtCap {
		t.Errorf("TruncatedAtCap = false, want true (we hit the cap)")
	}
}

func TestGrepPages_MaxPerPage_CapsEachPageIndependently(t *testing.T) {
	t.Parallel()
	paths, getMarkdown := newCorpus(map[string]string{
		"/a": "x\nx\nx\nx\n", // 4 hits
		"/b": "x\nx\n",       // 2 hits
	})
	re := regexp.MustCompile(`x`)
	res := grepPages(grepScanArgs{
		pages: paths, re: re, limit: 100, maxPerPage: 2,
		getMarkdown: getMarkdown,
	})
	// 2 per page, two pages → 4 total.
	if len(res.Matches) != 4 {
		t.Fatalf("matches = %d, want 4 (2 per page × 2 pages)", len(res.Matches))
	}
}

func TestGrepPages_ACLSkip(t *testing.T) {
	t.Parallel()
	paths, getMarkdown := newCorpus(map[string]string{
		"/public":  "token\n",
		"/private": "token\n",
	})
	re := regexp.MustCompile(`token`)
	res := grepPages(grepScanArgs{
		pages: paths, re: re, limit: 100,
		canView:     func(p string) bool { return p != "/private" },
		getMarkdown: getMarkdown,
	})
	if len(res.Matches) != 1 {
		t.Fatalf("matches = %d, want 1 (private hidden)", len(res.Matches))
	}
	if res.Matches[0].Path != "/public" {
		t.Errorf("Path = %q, want /public", res.Matches[0].Path)
	}
	if res.Scanned != 1 {
		t.Errorf("scanned = %d, want 1", res.Scanned)
	}
	if res.SkippedAccess != 1 {
		t.Errorf("skipped = %d, want 1", res.SkippedAccess)
	}
	if res.EligiblePages != 2 {
		t.Errorf("eligible = %d, want 2 (ACL filter is downstream of eligibility)", res.EligiblePages)
	}
}

func TestGrepPages_PathPrefixScope(t *testing.T) {
	t.Parallel()
	paths, getMarkdown := newCorpus(map[string]string{
		"/qms/sop01":  "hit\n",
		"/qms/sop02":  "hit\n",
		"/other/page": "hit\n",
	})
	re := regexp.MustCompile(`hit`)
	res := grepPages(grepScanArgs{
		pages: paths, re: re, prefix: "/qms", limit: 100,
		getMarkdown: getMarkdown,
	})
	if len(res.Matches) != 2 {
		t.Fatalf("matches = %d, want 2 (prefix excludes /other)", len(res.Matches))
	}
	if res.Scanned != 2 {
		t.Errorf("scanned = %d, want 2", res.Scanned)
	}
	if res.EligiblePages != 2 {
		t.Errorf("eligible = %d, want 2 (/other filtered by prefix, not counted)", res.EligiblePages)
	}
}

func TestGrepPages_Regex_StructuredDirective(t *testing.T) {
	t.Parallel()
	paths, getMarkdown := newCorpus(map[string]string{
		"/t1": "{template-stamp}\nbody\n",
		"/t2": "no directive here\n",
		"/t3": "a line with {template-stamp foo=bar} on it\n",
	})
	// Classic agent query: find every page using the {template-stamp}
	// directive. Fuzzy full-text would miss the directive-as-literal
	// shape and would also match the word "template" elsewhere.
	re := regexp.MustCompile(`\{template-stamp(?:\s[^{}]*)?\}`)
	res := grepPages(grepScanArgs{
		pages: paths, re: re, limit: 100,
		getMarkdown: getMarkdown,
	})
	if len(res.Matches) != 2 {
		t.Fatalf("matches = %d, want 2 (t1 + t3)", len(res.Matches))
	}
	// Go map iteration order isn't deterministic, so look up matches by
	// path rather than asserting a specific slice index. t1 → bare
	// directive; t3 → directive with trailing args (grep -o keeps them).
	byPath := map[string]string{}
	for _, m := range res.Matches {
		byPath[m.Path] = m.Match
	}
	if byPath["/t1"] != "{template-stamp}" {
		t.Errorf("Match on t1 = %q, want '{template-stamp}'", byPath["/t1"])
	}
	if byPath["/t3"] != "{template-stamp foo=bar}" {
		t.Errorf("Match on t3 = %q, want '{template-stamp foo=bar}'", byPath["/t3"])
	}
}

func TestGrepPages_CaseInsensitiveViaFlag(t *testing.T) {
	t.Parallel()
	paths, getMarkdown := newCorpus(map[string]string{
		"/p": "Hello world\nHELLO again\n",
	})
	re := regexp.MustCompile(`(?i)hello`)
	res := grepPages(grepScanArgs{
		pages: paths, re: re, limit: 100,
		getMarkdown: getMarkdown,
	})
	if len(res.Matches) != 2 {
		t.Errorf("matches = %d, want 2 (case-insensitive)", len(res.Matches))
	}
}

func TestGrepPages_NoMatches_EmptyResult(t *testing.T) {
	t.Parallel()
	paths, getMarkdown := newCorpus(map[string]string{
		"/p": "nothing here\n",
	})
	re := regexp.MustCompile(`absent`)
	res := grepPages(grepScanArgs{
		pages: paths, re: re, limit: 100,
		getMarkdown: getMarkdown,
	})
	if len(res.Matches) != 0 {
		t.Errorf("matches = %+v, want empty", res.Matches)
	}
	if res.Scanned != 1 {
		t.Errorf("scanned = %d, want 1 (page was scanned even with no hit)", res.Scanned)
	}
	if res.Matches == nil {
		t.Errorf("matches must be a non-nil empty slice so the JSON renders as [] not null")
	}
	if !res.ScanComplete {
		t.Errorf("ScanComplete = false, want true")
	}
}

// User-reported bug: limit=50 on a 311-page corpus returned 50 results,
// scanned 72 pages, STOPPED, and the caller couldn't tell the scan was
// interrupted from the response alone. ScanComplete + EligiblePages
// are the signal.

func TestGrepPages_LimitReached_ScanCompleteIsFalse(t *testing.T) {
	t.Parallel()
	// Three pages, each with one match. Cap at 2.
	paths, getMarkdown := newCorpus(map[string]string{
		"/a": "hit\n",
		"/b": "hit\n",
		"/c": "hit\n",
	})
	re := regexp.MustCompile(`hit`)
	res := grepPages(grepScanArgs{
		pages: paths, re: re, limit: 2,
		getMarkdown: getMarkdown,
	})
	if len(res.Matches) != 2 {
		t.Fatalf("matches = %d, want 2", len(res.Matches))
	}
	if res.EligiblePages != 3 {
		t.Errorf("EligiblePages = %d, want 3 (all three pages in scope)", res.EligiblePages)
	}
	if res.ScanComplete {
		t.Errorf("ScanComplete = true, want false — scan stopped before every eligible page was walked")
	}
	if !res.TruncatedAtCap {
		t.Errorf("TruncatedAtCap = false, want true")
	}
}

// count_only mode: the user's suggested fix. Scan every eligible page
// regardless of limit, return per-page counts, no bodies.

func TestGrepPages_CountOnly_ReturnsPerPageCounts(t *testing.T) {
	t.Parallel()
	paths, getMarkdown := newCorpus(map[string]string{
		"/a": "hit\nhit\nhit\n", // 3 hits
		"/b": "miss\n",          // 0 hits
		"/c": "hit here\n",      // 1 hit
	})
	re := regexp.MustCompile(`hit`)
	res := grepPages(grepScanArgs{
		pages: paths, re: re, limit: 1 /* ignored */, countOnly: true,
		getMarkdown: getMarkdown,
	})
	if len(res.Matches) != 0 {
		t.Errorf("Matches should be empty in count_only mode, got %d", len(res.Matches))
	}
	byPath := map[string]int{}
	for _, c := range res.MatchCounts {
		byPath[c.Path] = c.Count
	}
	// Only pages with ≥1 hit are returned.
	if byPath["/a"] != 3 {
		t.Errorf("/a count = %d, want 3", byPath["/a"])
	}
	if byPath["/c"] != 1 {
		t.Errorf("/c count = %d, want 1", byPath["/c"])
	}
	if _, has := byPath["/b"]; has {
		t.Errorf("/b has 0 matches and should be omitted; got %+v", byPath)
	}
	// Total matches is the sum.
	if res.TotalMatches != 4 {
		t.Errorf("TotalMatches = %d, want 4 (3 + 1)", res.TotalMatches)
	}
	// count_only never stops early, even with limit=1.
	if !res.ScanComplete {
		t.Errorf("ScanComplete = false, want true — count_only must scan everything")
	}
	if res.EligiblePages != 3 {
		t.Errorf("EligiblePages = %d, want 3", res.EligiblePages)
	}
}

func TestGrepPages_CountOnly_IgnoresMaxPerPage(t *testing.T) {
	t.Parallel()
	// A page with 5 matches; maxPerPage=2 would cap the Matches
	// slice in default mode but count_only wants the TRUE total.
	paths, getMarkdown := newCorpus(map[string]string{
		"/busy": "x\nx\nx\nx\nx\n",
	})
	re := regexp.MustCompile(`x`)
	res := grepPages(grepScanArgs{
		pages: paths, re: re, limit: 100, maxPerPage: 2, countOnly: true,
		getMarkdown: getMarkdown,
	})
	if len(res.MatchCounts) != 1 || res.MatchCounts[0].Count != 5 {
		t.Errorf("MatchCounts = %+v, want [{/busy 5}] (maxPerPage must be ignored in count_only)", res.MatchCounts)
	}
}
