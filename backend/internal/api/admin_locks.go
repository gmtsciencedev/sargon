package api

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"sargon/backend/internal/storage"
)

// handleListLocks returns all current draft locks and drafts across the wiki.
// GET /api/admin/locks
func (s *Server) handleListLocks(w http.ResponseWriter, _ *http.Request) {
	locks := s.draftManager.ListLocks()
	if locks == nil {
		locks = []storage.LockInfo{}
	}
	drafts := s.draftManager.ListDrafts()
	if drafts == nil {
		drafts = []storage.DraftInfo{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"locks": locks, "drafts": drafts})
}

// handleAdminDiscardDraft forcefully discards any user's draft.
// DELETE /api/admin/drafts/{path}
func (s *Server) handleAdminDiscardDraft(w http.ResponseWriter, r *http.Request) {
	pagePath := strings.TrimSpace(chi.URLParam(r, "*"))
	if pagePath == "" {
		writeError(w, http.StatusBadRequest, "missing page path")
		return
	}

	adminUser := UsernameFromContext(r.Context())

	// The lock names the active editor. A draft can outlive its lock
	// (session crash, expired lock); it still blocks external writes, so
	// it is found by its file when no lock is left. Each call discards one
	// owner's draft; repeat until 404 to clear several.
	draftOwner := s.draftManager.GetLock(pagePath).Owner
	if draftOwner == "" {
		if draft, ok := s.draftManager.FindAnyDraft(pagePath); ok {
			draftOwner = draft.Owner
		}
	}
	if draftOwner == "" {
		writeError(w, http.StatusNotFound, "no draft exists for this page")
		return
	}

	// Force discard: admin discards another user's draft.
	err := s.draftManager.AdminDiscardDraft(pagePath, draftOwner)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Log to changelog — this is a destructive action.
	if s.changelog != nil {
		s.changelog.Append(pagePath, 0, adminUser,
			fmt.Sprintf("admin override: discarded draft by %s", draftOwner), "admin")
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"discarded":    pagePath,
		"draft_owner":  draftOwner,
		"discarded_by": adminUser,
	})
}

// handleAdminViewDraft reads any user's draft content.
// GET /api/admin/drafts/*?owner=username
func (s *Server) handleAdminViewDraft(w http.ResponseWriter, r *http.Request) {
	pagePath := strings.TrimSpace(chi.URLParam(r, "*"))
	if pagePath == "" {
		writeError(w, http.StatusBadRequest, "missing page path")
		return
	}

	owner := r.URL.Query().Get("owner")
	if owner == "" {
		// Try to get owner from lock.
		lock := s.draftManager.GetLock(pagePath)
		if lock.Owner != "" {
			owner = lock.Owner
		} else {
			writeError(w, http.StatusBadRequest, "missing owner parameter (no lock found for this page)")
			return
		}
	}

	content, err := s.draftManager.AdminReadDraft(pagePath, owner)
	if err != nil {
		writeError(w, http.StatusNotFound, "no draft found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"page":     pagePath,
		"owner":    owner,
		"markdown": content,
	})
}

// handleAdminReclaimDraft transfers a draft from one user to the requesting admin.
// POST /api/admin/drafts/reclaim/*?owner=username
func (s *Server) handleAdminReclaimDraft(w http.ResponseWriter, r *http.Request) {
	pagePath := strings.TrimSpace(chi.URLParam(r, "*"))
	if pagePath == "" {
		writeError(w, http.StatusBadRequest, "missing page path")
		return
	}

	adminUser := UsernameFromContext(r.Context())

	owner := r.URL.Query().Get("owner")
	if owner == "" {
		lock := s.draftManager.GetLock(pagePath)
		if lock.Owner != "" {
			owner = lock.Owner
		} else {
			writeError(w, http.StatusBadRequest, "missing owner parameter (no lock found for this page)")
			return
		}
	}

	if owner == adminUser {
		writeError(w, http.StatusBadRequest, "you already own this draft")
		return
	}

	err := s.draftManager.AdminReclaimDraft(pagePath, owner, adminUser)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if s.changelog != nil {
		s.changelog.Append(pagePath, 0, adminUser,
			fmt.Sprintf("admin override: reclaimed draft from %s", owner), "admin")
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"page":           pagePath,
		"previous_owner": owner,
		"new_owner":      adminUser,
	})
}
