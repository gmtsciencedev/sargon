package storage

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// A write to "/docs/" creates the namespace index docs/index.md, even when
// the docs/ directory does not exist yet.
func TestFileStore_PutTrailingSlashCreatesNamespaceIndex(t *testing.T) {
	s := newTestFileStore(t)
	if _, err := s.Put("/docs/", "# Docs\n", "alice"); err != nil {
		t.Fatalf("Put /docs/: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.contentRoot, "docs", "index.md")); err != nil {
		t.Fatalf("docs/index.md not created: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.contentRoot, "docs.md")); err == nil {
		t.Fatalf("docs.md created for /docs/")
	}
	if !s.IsNamespaceIndex("/docs/") {
		t.Errorf("/docs/ is not reported as a namespace index")
	}
	// A page under it is now allowed.
	if _, err := s.Put("/docs/guide", "# Guide\n", "alice"); err != nil {
		t.Fatalf("Put /docs/guide: %v", err)
	}
	// "/" stays the root page.
	if _, err := s.Put("/", "# Home\n", "alice"); err != nil {
		t.Fatalf("Put /: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.contentRoot, "index.md")); err != nil {
		t.Fatalf("index.md not created for /: %v", err)
	}
}

// A write to "/docs/" while the leaf docs.md exists is a namespace conflict,
// not a silent write into the leaf.
func TestFileStore_PutTrailingSlashOnLeafIsConflict(t *testing.T) {
	s := newTestFileStore(t)
	if _, err := s.Put("/docs", "# Leaf\n", "alice"); err != nil {
		t.Fatalf("Put /docs: %v", err)
	}
	_, err := s.Put("/docs/", "# Index\n", "alice")
	if !errors.Is(err, ErrNamespaceConflict) {
		t.Fatalf("Put /docs/ over leaf: err = %v, want namespace conflict", err)
	}
	if err := s.CheckNamespaceConflict("/docs/"); !errors.Is(err, ErrNamespaceConflict) {
		t.Errorf("CheckNamespaceConflict /docs/: %v", err)
	}
}
