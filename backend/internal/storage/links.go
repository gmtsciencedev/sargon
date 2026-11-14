package storage

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// LinkIndex tracks which pages link to which other pages (via internal hyperlinks).
// It is persisted as _links.json in the meta directory.
//
// Keys and link targets are canonical page paths ("/", "/docs/guide"):
// every method converts what it is given with CanonicalPath, because
// callers hand over storage-shaped paths ("/index", "/docs/index") as
// well as canonical ones, and the two shapes must meet on one key.
type LinkIndex struct {
	mu          sync.RWMutex
	basePath    string              // path to data/meta/ directory
	PageToLinks map[string][]string `json:"page_to_links"`
	// pageToQueryTables records, per page, the tables its
	// {database-query} directives list. Kept in memory only: it is
	// rebuilt with the rest of the index at startup.
	pageToQueryTables map[string][]string
}

// NewLinkIndex creates a new LinkIndex. basePath is the meta directory.
func NewLinkIndex(basePath string) *LinkIndex {
	return &LinkIndex{
		basePath:          basePath,
		PageToLinks:       make(map[string][]string),
		pageToQueryTables: make(map[string][]string),
	}
}

// UpdatePageQueries replaces the list of tables queried by a page.
func (idx *LinkIndex) UpdatePageQueries(pagePath string, tables []string) {
	idx.mu.Lock()
	defer idx.mu.Unlock()
	if idx.pageToQueryTables == nil {
		idx.pageToQueryTables = make(map[string][]string)
	}
	pagePath = CanonicalPath(pagePath)
	if len(tables) == 0 {
		delete(idx.pageToQueryTables, pagePath)
		return
	}
	idx.pageToQueryTables[pagePath] = append([]string(nil), tables...)
}

// GetQueryPages returns the pages whose {database-query} lists table,
// sorted.
func (idx *LinkIndex) GetQueryPages(table string) []string {
	idx.mu.RLock()
	defer idx.mu.RUnlock()
	var result []string
	for page, tables := range idx.pageToQueryTables {
		for _, t := range tables {
			if t == table {
				result = append(result, page)
				break
			}
		}
	}
	sort.Strings(result)
	return result
}

// Load reads the link index from disk (data/meta/_links.json).
// If the file doesn't exist, initializes an empty map (not an error).
func (idx *LinkIndex) Load() error {
	idx.mu.Lock()
	defer idx.mu.Unlock()

	filePath := filepath.Join(idx.basePath, "_links.json")
	data, err := os.ReadFile(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			idx.PageToLinks = make(map[string][]string)
			return nil
		}
		return err
	}

	var stored struct {
		PageToLinks map[string][]string `json:"page_to_links"`
	}
	if err := json.Unmarshal(data, &stored); err != nil {
		return err
	}

	if stored.PageToLinks == nil {
		stored.PageToLinks = make(map[string][]string)
	}
	// Indexes saved before keys were canonical may hold "/index"-shaped
	// entries; merge them onto their canonical key.
	idx.PageToLinks = make(map[string][]string, len(stored.PageToLinks))
	for page, links := range stored.PageToLinks {
		page = CanonicalPath(page)
		idx.PageToLinks[page] = canonicalLinks(append(idx.PageToLinks[page], links...))
	}
	return nil
}

// Save persists the link index to disk atomically.
func (idx *LinkIndex) Save() error {
	idx.mu.RLock()
	defer idx.mu.RUnlock()

	filePath := filepath.Join(idx.basePath, "_links.json")

	stored := struct {
		PageToLinks map[string][]string `json:"page_to_links"`
	}{
		PageToLinks: idx.PageToLinks,
	}

	data, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return err
	}
	return writeFileAtomic(filePath, data)
}

// GetBacklinks returns the list of pages that link to the given page.
// This is a reverse lookup across the PageToLinks map.
func (idx *LinkIndex) GetBacklinks(pagePath string) []string {
	idx.mu.RLock()
	defer idx.mu.RUnlock()

	target := CanonicalPath(pagePath)
	var result []string
	for page, links := range idx.PageToLinks {
		for _, link := range links {
			if link == target {
				result = append(result, page)
				break
			}
		}
	}
	sort.Strings(result)
	return result
}

// canonicalLinks converts link targets to canonical page paths, dropping
// duplicates and keeping first-seen order.
func canonicalLinks(links []string) []string {
	out := make([]string, 0, len(links))
	seen := make(map[string]bool, len(links))
	for _, l := range links {
		l = CanonicalPath(l)
		if !seen[l] {
			seen[l] = true
			out = append(out, l)
		}
	}
	return out
}

// RemovePage removes a page from the link index.
func (idx *LinkIndex) RemovePage(pagePath string) {
	idx.mu.Lock()
	defer idx.mu.Unlock()

	pagePath = CanonicalPath(pagePath)
	delete(idx.PageToLinks, pagePath)
	delete(idx.pageToQueryTables, pagePath)
}

// UpdatePage replaces the links for a page. If links is empty,
// the page entry is removed from the index.
func (idx *LinkIndex) UpdatePage(pagePath string, links []string) {
	idx.mu.Lock()
	defer idx.mu.Unlock()

	pagePath = CanonicalPath(pagePath)
	if len(links) == 0 {
		delete(idx.PageToLinks, pagePath)
		return
	}
	idx.PageToLinks[pagePath] = canonicalLinks(links)
}
