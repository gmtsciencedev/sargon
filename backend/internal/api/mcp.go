package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"

	"sargon/backend/internal/database"
	"sargon/backend/internal/mcpserver"
)

// buildMCPHandler wires the MCP server with dependencies drawn from the
// api.Server. The returned http.Handler speaks MCP Streamable HTTP and
// expects to receive requests already authenticated by requireAuth.
func (s *Server) buildMCPHandler() http.Handler {
	var sitemap mcpserver.SitemapLister
	if lister, ok := s.store.(SitemapLister); ok {
		sitemap = lister
	}
	var mover mcpserver.PageMover
	if m, ok := s.store.(PageMover); ok {
		mover = m
	}

	deps := mcpserver.Deps{
		Store:           s.store, // api.PageStore is a superset of mcpserver.PageStore
		Sitemap:         sitemap,
		Search:          s.searchStore,
		ACL:             s.aclStore,
		UserStore:       s.userStore,
		Backlinks:       s.backlinkProvider,
		TagIndex:        s.tagIndex,
		Reviewflow:      s.reviewflowService,
		Comments:        s.commentService,
		DraftState:      s.draftManager,
		Todo:            s.todoService,
		SchemaStore:     s.schemaStore,
		DataStore:       s.dataStore,
		Attic:           s.atticStore,
		Changelog:       s.changelog,
		Mover:           mover,
		RowWriter:       &mcpRowWriter{s: s},
		TemplateCreator: &mcpTemplateCreator{s: s},
		DraftEditor:     s.draftManager,
		DraftPublisher:  &mcpDraftPublisher{s: s},
		Presence:        s.presenceHub,
		Media:           s.mediaStore,
		MediaRefs:       s.orphanDetector,
		MediaVersions:   s.mediaVersionStore,
		Renderer:        s,
		PDFExporter:     s,
		SiteBaseURL:     siteBaseURL(s),
		ExtractUsername: UsernameFromContext,
		RequireSummary:  s.configStore != nil && s.configStore.Get().AIAPI.RequireSummary,
	}
	return mcpserver.NewHandler(deps)
}

// siteBaseURL pulls the configured public origin, if any, from the config
// store. Used by upload_attachment_instructions to render a curl command
// with a real hostname instead of a placeholder.
func siteBaseURL(s *Server) string {
	if s == nil || s.configStore == nil {
		return ""
	}
	return s.configStore.Get().Site.BaseURL
}

// mcpRowWriter adapts the API Server's row-write internals to the
// mcpserver.RowWriter interface — reuses resolvePageFolder, buildPageContent,
// store.Put, store.Delete, so MCP writes go through the same code path as the
// HTTP handlers.
type mcpRowWriter struct{ s *Server }

func (w *mcpRowWriter) InsertRowWithPage(ctx context.Context, tableName string, fields map[string]any, author, summary string) (*mcpserver.RowInsertResult, error) {
	if w.s.dataStore == nil || w.s.schemaStore == nil {
		return nil, errors.New("database not connected")
	}
	table, err := w.s.schemaStore.GetTableByName(ctx, tableName)
	if err != nil {
		return nil, fmt.Errorf("table lookup: %w", err)
	}
	row := database.Row{Fields: fields}
	if err := w.s.dataStore.InsertRow(ctx, tableName, &row); err != nil {
		return nil, fmt.Errorf("insert row: %w", err)
	}
	result := &mcpserver.RowInsertResult{Row: &row}
	if table.PageFolder == "" {
		return result, nil
	}
	pagePath := resolvePageFolder(table.PageFolder, row.ID, row.Fields)
	if err := w.s.dataStore.UpdatePagePath(ctx, tableName, row.ID, pagePath); err != nil {
		return result, fmt.Errorf("set page_path: %w", err)
	}
	row.PagePath = pagePath
	markdown := w.s.buildPageContent(table, &row)
	// PutWithSummary keeps author and summary in SEPARATE attic fields;
	// the pre-rc.3-polish concatenation leaked commit messages into
	// PageMetadata.Author and polluted tag-query / history author
	// columns on row-bound pages.
	if _, err := w.s.store.PutWithSummary(pagePath, markdown, author, summary); err != nil {
		return result, fmt.Errorf("write bound page: %w", err)
	}
	result.PagePath = pagePath
	result.PageCreated = true
	return result, nil
}

func (w *mcpRowWriter) UpdateRowWithPage(ctx context.Context, tableName string, rowID int, fields map[string]any, author, summary string) (*mcpserver.RowUpdateResult, error) {
	if w.s.dataStore == nil || w.s.schemaStore == nil {
		return nil, errors.New("database not connected")
	}
	table, err := w.s.schemaStore.GetTableByName(ctx, tableName)
	if err != nil {
		return nil, fmt.Errorf("table lookup: %w", err)
	}
	if err := w.s.dataStore.UpdateRow(ctx, tableName, rowID, fields); err != nil {
		return nil, fmt.Errorf("update row: %w", err)
	}
	row, err := w.s.dataStore.GetRow(ctx, tableName, rowID)
	if err != nil {
		return nil, fmt.Errorf("re-read row: %w", err)
	}
	result := &mcpserver.RowUpdateResult{Row: row}
	if row.PagePath != "" {
		w.s.syncRowToPage(table, row, author, summary)
		result.PagePath = row.PagePath
		result.PageUpdated = true
	}
	return result, nil
}

func (w *mcpRowWriter) DeleteRowWithPage(ctx context.Context, tableName string, rowID int, author string) (*mcpserver.RowDeleteResult, error) {
	if w.s.dataStore == nil {
		return nil, errors.New("database not connected")
	}
	row, err := w.s.dataStore.GetRow(ctx, tableName, rowID)
	if err != nil {
		return nil, fmt.Errorf("row lookup: %w", err)
	}
	result := &mcpserver.RowDeleteResult{TableName: tableName, RowID: rowID}
	if row.PagePath != "" {
		result.PagePath = row.PagePath
		if _, err := w.s.store.Delete(row.PagePath, author); err != nil {
			// Log but don't fail the whole delete — a missing page is fine,
			// and other page-store errors shouldn't block the row cleanup.
			log.Printf("mcp: delete bound page %s for %s#%d: %v", row.PagePath, tableName, rowID, err)
		} else {
			result.PageDeleted = true
		}
	}
	if err := w.s.dataStore.DeleteRow(ctx, tableName, rowID); err != nil {
		return result, fmt.Errorf("delete row: %w", err)
	}
	return result, nil
}

// mcpTemplateCreator adapts Server.createPageFromTemplate to the
// mcpserver.TemplateCreator interface so the MCP tool and the HTTP
// endpoint share one code path.
type mcpTemplateCreator struct{ s *Server }

func (w *mcpTemplateCreator) CreatePageFromTemplate(_ context.Context, templatePath, dstPath, title string, reviewflow map[string]string, author, summary string) (*mcpserver.TemplateCreateResult, error) {
	res, err := w.s.createPageFromTemplate(TemplateCreateRequest{
		TemplatePath:       templatePath,
		Path:               dstPath,
		Title:              title,
		ReviewflowOverride: reviewflow,
		Summary:            summary,
	}, author)
	if err != nil {
		return nil, err
	}
	return &mcpserver.TemplateCreateResult{
		Path:               res.Path,
		Version:            res.Version,
		TemplatePath:       res.TemplatePath,
		TemplateVersion:    res.TemplateVersion,
		TemplateVersionTag: res.TemplateVersionTag,
		Stamp:              res.Stamp,
		ReviewflowResolved: res.ReviewflowResolved,
	}, nil
}

// TemplateErrorKind lets mcpserver classify a create failure without
// importing the api package.
func (e *TemplateCreateError) TemplateErrorKind() string { return e.Kind }

// mcpDraftPublisher adapts Server.PublishDraft to the mcpserver
// DraftPublisher interface. HTTP handler and MCP tool both route through
// PublishDraft, so the pipeline (inline-edit guard, draft.Publish, flow
// markers, database validation, page store, todo auto-complete) is
// executed once per publish, regardless of caller.
type mcpDraftPublisher struct{ s *Server }

func (p *mcpDraftPublisher) PublishDraft(_ context.Context, pagePath, username, editToken string, force bool) (*mcpserver.DraftPublishResult, mcpserver.DraftPublisherError) {
	result, err := p.s.PublishDraft(pagePath, username, editToken, force)
	if err != nil {
		return nil, err
	}
	return &mcpserver.DraftPublishResult{
		Path:    result.Page.Path,
		Version: result.Page.Meta.Version,
	}, nil
}

// PublishErrorKind maps PublishDraftError.Kind onto the mcpserver enum so
// the MCP layer can classify refusals without matching strings.
func (e *PublishDraftError) PublishErrorKind() mcpserver.DraftPublisherErrorKind {
	switch e.Kind {
	case PublishErrDatabaseRowConflict:
		return mcpserver.PublishKindDatabaseRowConflict
	case PublishErrEditSuperseded:
		return mcpserver.PublishKindEditSuperseded
	case PublishErrNoDraft:
		return mcpserver.PublishKindNoDraft
	case PublishErrValidation:
		return mcpserver.PublishKindValidation
	default:
		return mcpserver.PublishKindInternal
	}
}

// ConflictTable exposes the offending table for database_row_conflict; empty
// for every other kind.
func (e *PublishDraftError) ConflictTable() string { return e.Table }
