package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"testing"

	"sargon/backend/internal/storage"
)

// locksStubDraftManager records what admin operations were called and
// lets tests wire specific responses. Kept in this file so the unit
// suite has its own stub — the sibling integration file has its own
// stub scoped to the //go:build integration tag.
type locksStubDraftManager struct {
	mu             sync.Mutex
	locks          []storage.LockInfo
	drafts         []storage.DraftInfo
	lockByPath     map[string]storage.DraftLock
	draftContent   map[string]string
	adminDiscardOK bool
	adminReclaimOK bool
	adminReadErr   error
	discardCalls   []string
	reclaimCalls   []locksReclaimCall
}

type locksReclaimCall struct{ path, from, to string }

func newLocksStub() *locksStubDraftManager {
	return &locksStubDraftManager{
		lockByPath:     map[string]storage.DraftLock{},
		draftContent:   map[string]string{},
		adminDiscardOK: true,
		adminReclaimOK: true,
	}
}

func (m *locksStubDraftManager) EnterEditMode(pagePath, username string, force bool, currentPublished string) (string, string, error) {
	return "", "", nil
}
func (m *locksStubDraftManager) SaveDraft(pagePath, username, editToken, markdown string) error {
	return nil
}
func (m *locksStubDraftManager) ReadDraft(pagePath, username string) (string, error) { return "", nil }
func (m *locksStubDraftManager) DiscardDraft(pagePath, username, editToken string) error {
	return nil
}
func (m *locksStubDraftManager) Publish(pagePath, username, editToken string) (string, error) {
	return "", nil
}
func (m *locksStubDraftManager) GetLock(pagePath string) storage.DraftLock {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lockByPath[pagePath]
}
func (m *locksStubDraftManager) FindAnyDraft(pagePath string) (storage.DraftInfo, bool) {
	for _, d := range m.drafts {
		if d.Page == pagePath {
			return d, true
		}
	}
	return storage.DraftInfo{}, false
}
func (m *locksStubDraftManager) ListLocks() []storage.LockInfo   { return m.locks }
func (m *locksStubDraftManager) ListDrafts() []storage.DraftInfo { return m.drafts }
func (m *locksStubDraftManager) AdminDiscardDraft(pagePath, draftOwner string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.adminDiscardOK {
		return errors.New("stub: admin discard refused")
	}
	m.discardCalls = append(m.discardCalls, pagePath+"|"+draftOwner)
	delete(m.lockByPath, pagePath)
	delete(m.draftContent, pagePath)
	return nil
}
func (m *locksStubDraftManager) AdminReadDraft(pagePath, owner string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.adminReadErr != nil {
		return "", m.adminReadErr
	}
	content, ok := m.draftContent[pagePath]
	if !ok {
		return "", errors.New("no draft")
	}
	return content, nil
}
func (m *locksStubDraftManager) AdminReclaimDraft(pagePath, fromUser, toUser string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.adminReclaimOK {
		return errors.New("stub: admin reclaim refused")
	}
	m.reclaimCalls = append(m.reclaimCalls, locksReclaimCall{pagePath, fromUser, toUser})
	if lock, ok := m.lockByPath[pagePath]; ok {
		lock.Owner = toUser
		m.lockByPath[pagePath] = lock
	}
	return nil
}
func (m *locksStubDraftManager) TakeoverDraft(pagePath, newOwner, currentPublished string) (string, string, error) {
	return "", "", nil
}

func newLocksTestServer(t *testing.T) (*Server, *locksStubDraftManager) {
	t.Helper()
	stub := newLocksStub()
	return &Server{draftManager: stub}, stub
}

// TestListLocks_EmptyListsRenderAsArrays — nil slices from the stub
// must become "[]" (not JSON null) in the response so the admin UI
// can call .length on them without a guard.
func TestListLocks_EmptyListsRenderAsArrays(t *testing.T) {
	t.Parallel()
	s, _ := newLocksTestServer(t)
	rec := callAdmin(s.handleListLocks, http.MethodGet, "/api/admin/locks", nil, nil, "root")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Locks  []storage.LockInfo  `json:"locks"`
		Drafts []storage.DraftInfo `json:"drafts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v — %s", err, rec.Body.String())
	}
	// Empty is fine; nil-as-null would fail to decode into these slice types.
	// The bytes must contain [] not null.
	raw := rec.Body.String()
	if !contains(raw, `"locks":[]`) || !contains(raw, `"drafts":[]`) {
		t.Errorf("expected empty arrays in body, got: %s", raw)
	}
}

// TestListLocks_ReturnsStoredLocksAndDrafts — the handler surfaces
// whatever ListLocks / ListDrafts return, unchanged.
func TestListLocks_ReturnsStoredLocksAndDrafts(t *testing.T) {
	t.Parallel()
	s, stub := newLocksTestServer(t)
	stub.locks = []storage.LockInfo{{Page: "/a", Owner: "alice", Since: "2026-01-01T00:00:00Z"}}
	stub.drafts = []storage.DraftInfo{{Page: "/b", Owner: "bob", Since: "2026-01-02T00:00:00Z"}}
	rec := callAdmin(s.handleListLocks, http.MethodGet, "/api/admin/locks", nil, nil, "root")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Locks  []storage.LockInfo  `json:"locks"`
		Drafts []storage.DraftInfo `json:"drafts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Locks) != 1 || body.Locks[0].Owner != "alice" {
		t.Errorf("locks = %+v, want [alice]", body.Locks)
	}
	if len(body.Drafts) != 1 || body.Drafts[0].Owner != "bob" {
		t.Errorf("drafts = %+v, want [bob]", body.Drafts)
	}
}

// TestAdminDiscardDraft_MissingPath_400.
func TestAdminDiscardDraft_MissingPath_400(t *testing.T) {
	t.Parallel()
	s, _ := newLocksTestServer(t)
	rec := callAdmin(s.handleAdminDiscardDraft, http.MethodDelete, "/api/admin/drafts/", map[string]string{"*": ""}, nil, "root")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

// TestAdminDiscardDraft_NoLock_404 — no lock for the page means
// nothing to discard.
func TestAdminDiscardDraft_NoLock_404(t *testing.T) {
	t.Parallel()
	s, _ := newLocksTestServer(t)
	rec := callAdmin(s.handleAdminDiscardDraft, http.MethodDelete, "/api/admin/drafts/x", map[string]string{"*": "x"}, nil, "root")
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404: %s", rec.Code, rec.Body.String())
	}
}

// TestAdminDiscardDraft_HappyPath — with a lock recorded, discard
// calls AdminDiscardDraft with the recorded owner and returns the
// echo body.
func TestAdminDiscardDraft_HappyPath(t *testing.T) {
	t.Parallel()
	s, stub := newLocksTestServer(t)
	stub.lockByPath["/page"] = storage.DraftLock{Owner: "alice"}
	rec := callAdmin(s.handleAdminDiscardDraft, http.MethodDelete, "/api/admin/drafts/page", map[string]string{"*": "/page"}, nil, "root")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Discarded   string `json:"discarded"`
		DraftOwner  string `json:"draft_owner"`
		DiscardedBy string `json:"discarded_by"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Discarded != "/page" || body.DraftOwner != "alice" || body.DiscardedBy != "root" {
		t.Errorf("body = %+v, want /page|alice|root", body)
	}
	if len(stub.discardCalls) != 1 || stub.discardCalls[0] != "/page|alice" {
		t.Errorf("discardCalls = %v, want [/page|alice]", stub.discardCalls)
	}
}

// TestAdminDiscardDraft_OrphanDraft — a draft whose lock is gone still
// blocks external writes; admin discard finds its owner from the file.
func TestAdminDiscardDraft_OrphanDraft(t *testing.T) {
	t.Parallel()
	s, stub := newLocksTestServer(t)
	stub.drafts = []storage.DraftInfo{{Page: "/page", Owner: "bob"}}
	rec := callAdmin(s.handleAdminDiscardDraft, http.MethodDelete, "/api/admin/drafts/page", map[string]string{"*": "/page"}, nil, "root")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if len(stub.discardCalls) != 1 || stub.discardCalls[0] != "/page|bob" {
		t.Errorf("discardCalls = %v, want [/page|bob]", stub.discardCalls)
	}
}

// TestAdminViewDraft_QueryOwnerWins — when ?owner is set, that owner
// is used directly, not derived from the lock. Useful for reading
// orphan drafts (lock cleared but draft file lingers).
func TestAdminViewDraft_QueryOwnerWins(t *testing.T) {
	t.Parallel()
	s, stub := newLocksTestServer(t)
	stub.draftContent["/page"] = "# hello"
	rec := callAdmin(s.handleAdminViewDraft, http.MethodGet, "/api/admin/drafts/page?owner=bob", map[string]string{"*": "/page"}, nil, "root")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Owner    string `json:"owner"`
		Markdown string `json:"markdown"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Owner != "bob" {
		t.Errorf("owner = %q, want bob (from query)", body.Owner)
	}
	if body.Markdown != "# hello" {
		t.Errorf("markdown = %q, want # hello", body.Markdown)
	}
}

// TestAdminViewDraft_NoOwnerAndNoLock_400.
func TestAdminViewDraft_NoOwnerAndNoLock_400(t *testing.T) {
	t.Parallel()
	s, _ := newLocksTestServer(t)
	rec := callAdmin(s.handleAdminViewDraft, http.MethodGet, "/api/admin/drafts/page", map[string]string{"*": "/page"}, nil, "root")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

// TestAdminReclaimDraft_SelfReclaim_400 — reclaiming your own draft
// is a UI mistake; the handler refuses.
func TestAdminReclaimDraft_SelfReclaim_400(t *testing.T) {
	t.Parallel()
	s, stub := newLocksTestServer(t)
	stub.lockByPath["/page"] = storage.DraftLock{Owner: "root"}
	rec := callAdmin(s.handleAdminReclaimDraft, http.MethodPost, "/api/admin/drafts/reclaim/page", map[string]string{"*": "/page"}, nil, "root")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

// TestAdminReclaimDraft_HappyPath — reclaim from bob to root; stub
// records the call, response echoes previous+new.
func TestAdminReclaimDraft_HappyPath(t *testing.T) {
	t.Parallel()
	s, stub := newLocksTestServer(t)
	stub.lockByPath["/page"] = storage.DraftLock{Owner: "bob"}
	rec := callAdmin(s.handleAdminReclaimDraft, http.MethodPost, "/api/admin/drafts/reclaim/page", map[string]string{"*": "/page"}, nil, "root")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Page          string `json:"page"`
		PreviousOwner string `json:"previous_owner"`
		NewOwner      string `json:"new_owner"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.PreviousOwner != "bob" || body.NewOwner != "root" || body.Page != "/page" {
		t.Errorf("body = %+v, want /page|bob→root", body)
	}
	if len(stub.reclaimCalls) != 1 || stub.reclaimCalls[0].from != "bob" || stub.reclaimCalls[0].to != "root" {
		t.Errorf("reclaimCalls = %+v, want [bob→root]", stub.reclaimCalls)
	}
}

// contains is a helper — the stdlib has one but this avoids importing
// strings just for a byte-match on a small body.
func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
