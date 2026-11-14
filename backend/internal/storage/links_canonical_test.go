package storage

import (
	"reflect"
	"testing"
)

// The root page reaches the index as "/" from a save and as "/index"
// from an index rebuild; both must land on one canonical key, as link
// targets and as backlink sources.
func TestLinkIndex_CanonicalKeys(t *testing.T) {
	idx := NewLinkIndex(t.TempDir())
	idx.UpdatePage("/index", []string{"/docs/guide"})
	idx.UpdatePage("/", []string{"/docs/guide"})
	idx.UpdatePage("/docs/guide", []string{"/index", "/"})
	idx.UpdatePage("/docs/index", []string{"/"})

	if got := idx.GetBacklinks("/docs/guide"); !reflect.DeepEqual(got, []string{"/"}) {
		t.Errorf("backlinks of /docs/guide = %v, want [/]", got)
	}
	if got := idx.GetBacklinks("/"); !reflect.DeepEqual(got, []string{"/docs/", "/docs/guide"}) {
		t.Errorf("backlinks of / = %v, want [/docs/ /docs/guide]", got)
	}
	if got := idx.GetBacklinks("/index"); !reflect.DeepEqual(got, []string{"/docs/", "/docs/guide"}) {
		t.Errorf("backlinks of /index = %v", got)
	}
	idx.RemovePage("/docs/index")
	if got := idx.GetBacklinks("/"); !reflect.DeepEqual(got, []string{"/docs/guide"}) {
		t.Errorf("after removing /docs/, backlinks of / = %v", got)
	}
}
