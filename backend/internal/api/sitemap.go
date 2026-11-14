package api

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"sargon/backend/internal/storage"
)

// SitemapLister is implemented by storage.FileStore.
type SitemapLister interface {
	ListAllPages() ([]storage.PageEntry, error)
}

type sitemapTreeNode struct {
	Path             string             `json:"path"`
	Title            string             `json:"title"`
	IsNamespaceIndex bool               `json:"is_namespace_index,omitempty"`
	HasPage          bool               `json:"has_page"`
	Children         []*sitemapTreeNode `json:"children,omitempty"`
}

func (s *Server) handleSitemap(w http.ResponseWriter, r *http.Request) {
	lister, ok := s.store.(SitemapLister)
	if !ok {
		http.Error(w, "sitemap not supported", http.StatusNotImplemented)
		return
	}

	pages, err := lister.ListAllPages()
	if err != nil {
		http.Error(w, "failed to list pages", http.StatusInternalServerError)
		return
	}

	sort.Slice(pages, func(i, j int) bool {
		return pages[i].Path < pages[j].Path
	})

	// Build tree structure. The root node represents "/".
	root := &sitemapTreeNode{Path: "/", Title: "/"}
	nodeMap := map[string]*sitemapTreeNode{"/": root}

	for _, p := range pages {
		// Root page populates the root node directly.
		if p.Path == "/" {
			root.Title = p.Title
			root.HasPage = true
			root.IsNamespaceIndex = p.IsNamespaceIndex
			continue
		}

		// Split without the leading slash or a namespace index's trailing
		// one; node paths stay canonical: namespaces end with "/".
		trimmed := strings.Trim(p.Path, "/")
		parts := strings.Split(trimmed, "/")
		parent := root

		// Ensure all intermediate namespace nodes exist.
		for i := 0; i < len(parts)-1; i++ {
			prefix := "/" + strings.Join(parts[:i+1], "/") + "/"
			if existing, ok := nodeMap[prefix]; ok {
				parent = existing
			} else {
				ns := &sitemapTreeNode{
					Path:  prefix,
					Title: parts[i],
				}
				parent.Children = append(parent.Children, ns)
				nodeMap[prefix] = ns
				parent = ns
			}
		}

		// Check if a tree node already exists for this path (namespace node created earlier).
		if existing, ok := nodeMap[p.Path]; ok {
			existing.Title = p.Title
			existing.IsNamespaceIndex = p.IsNamespaceIndex
			existing.HasPage = true
			if existing.Title == "" {
				existing.Title = parts[len(parts)-1]
			}
		} else {
			title := p.Title
			if title == "" {
				title = parts[len(parts)-1]
			}
			node := &sitemapTreeNode{
				Path:             p.Path,
				Title:            title,
				IsNamespaceIndex: p.IsNamespaceIndex,
				HasPage:          true,
			}
			parent.Children = append(parent.Children, node)
			nodeMap[p.Path] = node
		}
	}

	// Return root as the single top-level element so "/" is the parent of all pages.
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"pages": []*sitemapTreeNode{root},
	})
}
