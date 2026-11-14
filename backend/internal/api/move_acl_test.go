package api

import (
	"net/http"
	"path/filepath"
	"testing"

	"sargon/backend/internal/auth"
)

// A user who may edit only /playground/ cannot move a page out of it: the
// move writes the destination, so it needs edit there too.
func TestMove_DestinationNeedsEditPermission(t *testing.T) {
	t.Parallel()
	s, fs := newMoveTestServer(t)
	meta := t.TempDir()
	acl, err := auth.NewACLStore(filepath.Join(meta, "acl"))
	if err != nil {
		t.Fatal(err)
	}
	if err := acl.Replace([]auth.ACLRule{
		{Pattern: ".*", SubjectType: "special", Subject: "@all", Permissions: []string{"view"}},
		{Pattern: "/playground/.*", SubjectType: "user", Subject: "guest", Permissions: []string{"view", "edit", "delete"}},
	}); err != nil {
		t.Fatal(err)
	}
	users, err := auth.NewUserStore(filepath.Join(meta, "users"))
	if err != nil {
		t.Fatal(err)
	}
	if err := users.Create(auth.User{Username: "guest"}, "guest-password"); err != nil {
		t.Fatal(err)
	}
	s.aclStore, s.userStore = acl, users
	seedMovePage(t, fs, "/playground/note", "content")

	rec := callMove(s.handleMovePage, "playground/note", map[string]any{"to": "/escaped"}, "guest")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("move out of /playground/: status %d, want 403: %s", rec.Code, rec.Body.String())
	}
	if fs.Exists("/escaped") || !fs.Exists("/playground/note") {
		t.Errorf("the page moved despite the refusal")
	}

	rec = callMove(s.handleMovePage, "playground/note", map[string]any{"to": "/playground/renamed"}, "guest")
	if rec.Code != http.StatusOK {
		t.Fatalf("move inside /playground/: status %d, want 200: %s", rec.Code, rec.Body.String())
	}
}
