package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"sargon/backend/internal/storage"
)

type movePageRequest struct {
	To               string `json:"to"`
	MoveMedia        bool   `json:"move_media"`
	UpdateLinks      bool   `json:"update_links"`
	ToNamespaceIndex bool   `json:"to_namespace_index"`
	ToRegularPage    bool   `json:"to_regular_page"`
	DryRun           bool   `json:"dry_run"`
}

func (s *Server) handleMovePage(w http.ResponseWriter, r *http.Request) {
	pagePath := strings.TrimSpace(chi.URLParam(r, "*"))
	if pagePath == "" {
		writeError(w, http.StatusBadRequest, "missing page path")
		return
	}

	var req movePageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}

	// Validate: exactly one operation.
	flagCount := 0
	if req.To != "" {
		flagCount++
	}
	if req.ToNamespaceIndex {
		flagCount++
	}
	if req.ToRegularPage {
		flagCount++
	}
	if flagCount != 1 {
		writeError(w, http.StatusBadRequest, "exactly one of 'to', 'to_namespace_index', or 'to_regular_page' must be set")
		return
	}

	author := UsernameFromContext(r.Context())

	// The route checked edit on the source. A move also writes the
	// destination, so the caller needs edit there too — or a user confined
	// to one namespace could move pages out of it.
	if req.To != "" && s.aclStore != nil {
		dest := "/" + strings.TrimPrefix(strings.TrimSpace(req.To), "/")
		if !s.aclStore.CheckPermission(author, s.getUserGroups(author), dest, "edit") {
			writeError(w, http.StatusForbidden, "access denied: no edit permission on "+dest)
			return
		}
	}

	mover, ok := s.store.(PageMover)
	if !ok {
		writeError(w, http.StatusNotImplemented, "move not supported")
		return
	}

	// Dry-run: return a preview of what would happen.
	if req.DryRun && req.To != "" {
		preview, err := mover.PreviewMove(pagePath, req.To, req.MoveMedia)
		if err != nil {
			handleMoveError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, preview)
		return
	}

	var result storage.MoveResult
	var err error

	switch {
	case req.ToNamespaceIndex:
		result, err = mover.ConvertToNamespaceIndex(pagePath, author)
	case req.ToRegularPage:
		result, err = mover.ConvertToRegularPage(pagePath, author)
	default:
		result, err = mover.Move(pagePath, req.To, req.MoveMedia, req.UpdateLinks, author)
	}

	if err != nil {
		handleMoveError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, result)
}

func handleMoveError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, storage.ErrPageNotFound):
		writeError(w, http.StatusNotFound, "page not found")
	case errors.Is(err, storage.ErrDestinationExists):
		writeError(w, http.StatusConflict, "destination already exists")
	case errors.Is(err, storage.ErrNamespaceConflict):
		writeError(w, http.StatusConflict, "namespace conflict")
	case errors.Is(err, storage.ErrNamespaceNotEmpty):
		writeError(w, http.StatusConflict, "namespace is not empty; cannot convert to regular page")
	case errors.Is(err, storage.ErrPageHasLock):
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error()})
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}
