package lifecycle

import (
	"regexp"
	"sync"
)

// selectorCache memoises compiled regexes so the scanner doesn't
// re-compile on every page in every scan pass. Keyed by the regex text,
// which is what gets compiled; the cache is shared by every wiki the
// process serves. Guarded by a mutex — the
// scanner is single-goroutine today, but tests hit selectors in parallel.
var selectorCache = struct {
	sync.Mutex
	m map[string]*regexp.Regexp
}{m: make(map[string]*regexp.Regexp)}

// compiledScope returns the cached (or freshly compiled) regex for a rule.
// Returns nil when the rule has no scope regex (meaning "path is not a
// constraint" — every path matches).
func compiledScope(r Rule) *regexp.Regexp {
	if r.ScopeRegex == "" {
		return nil
	}
	selectorCache.Lock()
	defer selectorCache.Unlock()
	if re, ok := selectorCache.m[r.ScopeRegex]; ok {
		return re
	}
	// Parse errors were rejected at parse time, so MustCompile is safe
	// against valid rules. If somehow an invalid regex reaches here
	// (corrupt on-disk state, hand-edited JSON), we fall back to "no
	// match" rather than panic — better a rule that fires on nothing
	// than a crashed scanner.
	re, err := regexp.Compile(r.ScopeRegex)
	if err != nil {
		re = regexp.MustCompile(`\z\A`) // never matches
	}
	selectorCache.m[r.ScopeRegex] = re
	return re
}

// PageMatches reports whether a rule's selectors admit the given page.
// The scanner calls this once per (rule, page) pair. `pageTags` is the
// set of tags carried by the page — the caller resolves it (via
// TagIndex or a bound closure over one) so this package stays free of
// a hard dependency on the storage layer.
func PageMatches(r Rule, pagePath string, pageTags map[string]struct{}) bool {
	// Path selector: if provided, must match.
	if re := compiledScope(r); re != nil {
		if !re.MatchString(pagePath) {
			return false
		}
	}
	// Tags selector (OR): if provided, page must carry at least one.
	if len(r.Tags) > 0 {
		hit := false
		for _, t := range r.Tags {
			if _, ok := pageTags[t]; ok {
				hit = true
				break
			}
		}
		if !hit {
			return false
		}
	}
	// Exclude tags (NAND): if any is present, the page is out.
	for _, t := range r.ExcludeTags {
		if _, ok := pageTags[t]; ok {
			return false
		}
	}
	return true
}

// TagSet is a small helper to turn a []string into the map form
// PageMatches expects. Handy for callers that already have the slice
// (from TagIndex.GetTagsForPage) and for tests.
func TagSet(tags []string) map[string]struct{} {
	m := make(map[string]struct{}, len(tags))
	for _, t := range tags {
		m[t] = struct{}{}
	}
	return m
}
