package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"

	_ "embed"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"sargon/backend/internal/aiassistant"
	"sargon/backend/internal/auth"
	"sargon/backend/internal/bibliography"
	"sargon/backend/internal/collab"
	"sargon/backend/internal/comment"
	"sargon/backend/internal/config"
	"sargon/backend/internal/database"
	"sargon/backend/internal/lifecycle"
	"sargon/backend/internal/markdown"
	"sargon/backend/internal/reviewflow"
	"sargon/backend/internal/storage"
	"sargon/backend/internal/todo"
)

//go:embed openapi.json
var openapiJSON []byte

// Version is the Sargon software version string. Bump before tagging a
// release; the site-info endpoint and any manifest ride on this constant.
const Version = "1.1.0-rc.2"

// BuildCommit and BuildDate are injected at build time via -ldflags:
//
//	go build -ldflags "-X sargon/backend/internal/api.BuildCommit=$(git rev-parse HEAD) -X sargon/backend/internal/api.BuildDate=$(date -u +%Y-%m-%dT%H:%M:%SZ)" ./cmd/server
//
// A dev build (plain `go build`) leaves them as "unknown", which is fine
// for local work but means `/api/version` can't tell you what's deployed.
// Production and CI builds MUST set both so the validated-vs-deployed
// gap is measurable.
var (
	BuildCommit = "unknown"
	BuildDate   = "unknown"
)

type PageStore interface {
	Get(pagePath string) (storage.Page, error)
	Put(pagePath, markdown, author string) (storage.PutResult, error)
	PutWithSummary(pagePath, markdown, author, summary string) (storage.PutResult, error)
	Delete(pagePath, author string) (storage.DeleteResult, error)
	CheckNamespaceConflict(pagePath string) error
	Exists(pagePath string) bool
}

type PageMover interface {
	Move(oldPath, newPath string, moveMedia, updateLinks bool, author string) (storage.MoveResult, error)
	ConvertToNamespaceIndex(pagePath, author string) (storage.MoveResult, error)
	ConvertToRegularPage(pagePath, author string) (storage.MoveResult, error)
	PreviewMove(oldPath, newPath string, moveMedia bool) (storage.MovePreview, error)
}

type OrphanDetector interface {
	FindOrphans() ([]string, error)
	GetReferencingPages(mediaPath string) []string
}

type MediaStore interface {
	List(namespacePath string) ([]storage.MediaEntry, error)
	Put(namespacePath, fileName string, content io.Reader, overwrite bool, author string) (storage.MediaEntry, error)
	Delete(mediaPath string) error
	ResolvePath(mediaPath string) (string, error)
}

type SearchStore interface {
	Search(query string, limit int) ([]storage.SearchResult, error)
}

type AtticStore interface {
	ListVersions(pagePath string) ([]storage.AtticEntry, error)
	ReadVersion(pagePath string, version int64) ([]byte, error)
	GetEntry(pagePath string, version int64) (*storage.AtticEntry, error)
	ListTombstones(pagePath string) ([]storage.TombstoneRecord, error)
	ReadTombstonedVersion(pagePath, tombID string, version int64) ([]byte, error)
}

type BacklinkProvider interface {
	GetBacklinks(pagePath string) []string
}

type LogoResolver interface {
	ResolveLogo() (string, error)
}

type MediaAtticStore interface {
	ReadVersion(mediaPath string, version int64) ([]byte, error)
}

type MediaVersionStoreReader interface {
	GetVersion(mediaPath string) int64
}

type Server struct {
	store             PageStore
	mediaStore        MediaStore
	orphanDetector    OrphanDetector
	searchStore       SearchStore
	atticStore        AtticStore
	draftManager      DraftManager
	logoResolver      LogoResolver
	mediaAtticStore   MediaAtticStore
	mediaVersionStore MediaVersionStoreReader
	configStore       *config.Store
	userStore         *auth.UserStore
	groupStore        *auth.GroupStore
	sessionStore      *auth.SessionStore
	aclStore          *auth.ACLStore
	changelog         *storage.Changelog
	dbPool            *database.Pool
	schemaStore       *database.SchemaStore
	dataStore         *database.DataStore
	backlinkProvider  BacklinkProvider
	tagIndex          *storage.TagIndex
	// Persistent browser context for PDF export (nil if Chrome not available).
	browserAllocCtx    context.Context
	browserAllocCancel context.CancelFunc
	// Tracks pages where a forced inline edit modified the published content
	// while a draft was open. Checked at publish time to warn the user.
	inlineEditConflicts sync.Map // map[pagePath string]tableName string
	databaseSync        *database.DatabaseSync
	caStore             *reviewflow.CAStore
	certStore           *reviewflow.CertStore
	tokenStore          *auth.TokenStore
	rateLimiter         *RateLimiter
	oauthClient         *auth.OAuthClient
	oauthServer         *auth.OAuthServer
	todoService         *todo.TodoService
	reviewflowService   *reviewflow.Service
	commentService      *comment.Service
	bibliographyService *bibliography.Service
	lifecycleStore      *lifecycle.Store
	lifecycleScanner    *lifecycle.Scanner
	presenceHub         *collab.Hub
	collabRelay         *collab.Relay
	aiProvider          aiassistant.Provider
	aiRateLimiter       *aiassistant.UserRateLimiter
	serveWeb            bool
	webDirPath          string
}

func NewRouter(store PageStore, mediaStore MediaStore, orphanDetector OrphanDetector, searchStore SearchStore, atticStore AtticStore, draftManager DraftManager, logoResolver LogoResolver, mediaAtticStore MediaAtticStore, mediaVersionStore MediaVersionStoreReader, configStore *config.Store, userStore *auth.UserStore, groupStore *auth.GroupStore, sessionStore *auth.SessionStore, aclStore *auth.ACLStore, changelog *storage.Changelog, dbPool *database.Pool, tagIndex *storage.TagIndex, backlinkProvider BacklinkProvider, browserAllocCtx context.Context, browserAllocCancel context.CancelFunc, serveWeb bool, webDirPath string, todoService *todo.TodoService, reviewflowService *reviewflow.Service, commentService *comment.Service, tokenStore *auth.TokenStore, caStore *reviewflow.CAStore, certStore *reviewflow.CertStore, bibliographyService *bibliography.Service, oauthServer *auth.OAuthServer, lifecycleStore *lifecycle.Store, lifecycleScanner *lifecycle.Scanner) http.Handler {
	s := &Server{
		store:               store,
		mediaStore:          mediaStore,
		orphanDetector:      orphanDetector,
		searchStore:         searchStore,
		atticStore:          atticStore,
		draftManager:        draftManager,
		logoResolver:        logoResolver,
		mediaAtticStore:     mediaAtticStore,
		mediaVersionStore:   mediaVersionStore,
		configStore:         configStore,
		userStore:           userStore,
		groupStore:          groupStore,
		sessionStore:        sessionStore,
		aclStore:            aclStore,
		changelog:           changelog,
		backlinkProvider:    backlinkProvider,
		tagIndex:            tagIndex,
		browserAllocCtx:     browserAllocCtx,
		browserAllocCancel:  browserAllocCancel,
		dbPool:              dbPool,
		todoService:         todoService,
		reviewflowService:   reviewflowService,
		commentService:      commentService,
		bibliographyService: bibliographyService,
		tokenStore:          tokenStore,
		oauthServer:         oauthServer,
		caStore:             caStore,
		certStore:           certStore,
		lifecycleStore:      lifecycleStore,
		lifecycleScanner:    lifecycleScanner,
		presenceHub:         collab.NewHub(),
		collabRelay:         collab.NewRelay(),
		rateLimiter:         NewRateLimiter(),
		serveWeb:            serveWeb,
		webDirPath:          webDirPath,
	}

	// If database pool is already connected, initialize stores.
	if dbPool != nil && dbPool.IsConnected() {
		s.schemaStore = database.NewSchemaStore(dbPool)
		s.dataStore = database.NewDataStore(dbPool, s.schemaStore)
		s.databaseSync = database.NewDatabaseSync(s.schemaStore, s.dataStore)
	}

	// Initialize AI assistant provider if configured.
	if cfg := configStore.Get(); cfg.AIAssistant.Enabled {
		apiKey := cfg.AIAssistant.EffectiveAPIKey()
		if apiKey != "" {
			switch cfg.AIAssistant.Provider {
			case "anthropic", "":
				s.aiProvider = aiassistant.NewAnthropicProvider(apiKey)
				s.aiRateLimiter = aiassistant.NewUserRateLimiter()
				log.Printf("ai assistant: Anthropic provider initialized (model: %s)", cfg.AIAssistant.Model)
			default:
				log.Printf("ai assistant: unknown provider %q, disabled", cfg.AIAssistant.Provider)
			}
		} else {
			log.Printf("ai assistant: enabled but no API key configured")
		}
	}

	// Initialize OAuth client if configured.
	if err := s.initOAuthClient(); err != nil {
		// Not an error — OAuth is simply not configured yet.
		log.Printf("oauth: %v (will initialize on first use if configured later)", err)
	} else {
		log.Printf("oauth: Azure AD provider initialized")
	}

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Logger)

	// Host filtering: if site.base_url is configured, reject requests for other hostnames.
	if baseURL := configStore.Get().Site.BaseURL; baseURL != "" {
		if parsed, err := url.Parse(baseURL); err == nil && parsed.Hostname() != "" {
			allowedHost := parsed.Hostname()
			log.Printf("host filter: accepting requests for %s only", allowedHost)
			r.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					host := r.Host
					// Strip port if present.
					if i := strings.LastIndex(host, ":"); i != -1 {
						host = host[:i]
					}
					if host != allowedHost {
						http.NotFound(w, r)
						return
					}
					next.ServeHTTP(w, r)
				})
			})
		}
	}

	// Auth endpoints (public).
	r.Post("/api/auth/login", s.handleLogin)
	r.Post("/api/auth/logout", s.handleLogout)
	r.Get("/api/auth/me", s.handleMe)
	r.Get("/api/auth/providers", s.handleAuthProviders)
	r.Get("/api/auth/oauth/login", s.handleOAuthLogin)
	r.Get("/api/auth/oauth/callback", s.handleOAuthCallback)

	// Per-user "me" endpoints — need the session cookie or bearer token to
	// resolve into a username, so they go through optionalAuth (the handlers
	// themselves 401 when unauthenticated).
	r.Group(func(r chi.Router) {
		r.Use(s.optionalAuth)
		r.Get("/api/auth/me/preferences", s.handleGetMePreferences)
		r.Put("/api/auth/me/preferences", s.handlePutMePreferences)
		r.Get("/api/auth/me/favorites", s.handleGetMeFavorites)
		r.Post("/api/auth/me/favorites/toggle", s.handleToggleMeFavorite)
	})

	r.Get("/api/health", s.handleHealth)
	r.Get("/api/version", s.handleVersion)
	r.Get("/api/openapi.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Write(openapiJSON)
	})

	// Read endpoints — optional auth + ACL "view" permission.
	r.Group(func(r chi.Router) {
		r.Use(s.optionalAuth)
		r.Use(s.requirePermission("view"))
		r.Get("/api/pages/*", s.handleGetPage)
		r.Get("/api/history/*", s.handlePageHistory)
		r.Get("/api/versions/*", s.handlePageVersion)
		r.Get("/api/diff/*", s.handlePageDiff)
		r.Get("/api/tombstones/*", s.handlePageTombstones)
		r.Get("/api/tombstone-version/*", s.handleTombstonedVersion)
		r.Get("/api/media", s.handleListMedia)
		r.Get("/api/media/", s.handleListMedia)
		r.Get("/api/media/*", s.handleListMedia)
		r.Get("/api/media-orphans", s.handleMediaOrphans)
		r.Get("/api/media-version/*", s.handleServeMediaVersion)
		r.Get("/api/export/pdf/*", s.handleExportPDF)
		r.Get("/api/render/*", s.handleRender)
		r.Get("/api/backlinks/*", s.handleBacklinks)
		r.Post("/api/pages/check", s.handleCheckPages)
		r.Get("/api/template/*", s.handleGetTemplate)
		r.Get("/api/templates/for/*", s.handleGetTemplatesFor)
		r.Get("/api/templates", s.handleListTemplates)
	})

	// Public read endpoints — no ACL check (search, logo, site info, sitemap).
	r.Group(func(r chi.Router) {
		r.Use(s.optionalAuth)
		r.Get("/api/search", s.handleSearch)
		r.Get("/api/sitemap", s.handleSitemap)
		r.Get("/api/tags", s.handleTagQuery)
		r.Get("/api/changes", s.handleRecentChanges)
		r.Get("/api/site/logo", s.handleSiteLogo)
		r.Get("/api/site/info", s.handleSiteInfo)
		r.Get("/api/users/display", s.handleUsersDisplay)
		r.Get("/api/users/list", s.handleUsersList)
		r.Get("/api/qrcode", s.handleQRCode)
		r.Get("/api/theme/overrides.css", s.handleThemeOverridesCSS)
	})

	// WebSocket endpoints + collab — require auth, no ACL.
	r.Group(func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Get("/api/ws/presence", s.handlePresenceWS)
		r.Get("/api/ws/collab/*", s.handleCollabWS)
		r.Get("/api/collab/draft/*", s.handleCollabDraftRead)
		r.Post("/api/collab/promote/*", s.handleCollabPromote)
	})

	// Write endpoints — require auth + ACL "edit" permission.
	r.Group(func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Use(s.requirePermission("edit"))
		r.Put("/api/pages/*", s.handlePutPage)
		r.Post("/api/edit/*", s.handleEnterEdit)
		r.Put("/api/draft/*", s.handleSaveDraft)
		r.Post("/api/publish/*", s.handlePublish)
		r.Delete("/api/draft/*", s.handleDiscardDraft)
		r.Post("/api/media", s.handleUploadMedia)
		r.Post("/api/media/", s.handleUploadMedia)
		r.Post("/api/media/*", s.handleUploadMedia)
		r.Post("/api/move/*", s.handleMovePage)
	})

	// Template creation — auth-only at the route level; the handler
	// checks ACL against the destination path in the request body
	// (which requirePermission cannot inspect).
	r.Group(func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Post("/api/pages/from-template", s.handleCreatePageFromTemplate)
	})

	// Delete endpoints — require auth + ACL "delete" permission.
	r.Group(func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Use(s.requirePermission("delete"))
		r.Delete("/api/pages/*", s.handleDeletePage)
		r.Delete("/api/media/*", s.handleDeleteMedia)
	})

	// Admin endpoints — require auth + admin group.
	r.Group(func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Use(s.requireAdmin)

		r.Get("/api/admin/users", s.handleListUsers)
		r.Post("/api/admin/users", s.handleCreateUser)
		r.Put("/api/admin/users/{username}", s.handleUpdateUser)
		r.Delete("/api/admin/users/{username}", s.handleDeleteUser)
		r.Put("/api/admin/users/{username}/password", s.handleSetPassword)

		r.Get("/api/admin/groups", s.handleListGroups)
		r.Post("/api/admin/groups", s.handleCreateGroup)
		r.Put("/api/admin/groups/{name}", s.handleUpdateGroup)
		r.Delete("/api/admin/groups/{name}", s.handleDeleteGroup)

		r.Get("/api/admin/config", s.handleGetConfig)
		r.Put("/api/admin/config", s.handleUpdateConfig)

		r.Get("/api/admin/acl", s.handleListACL)
		r.Put("/api/admin/acl", s.handleReplaceACL)

		r.Get("/api/admin/locks", s.handleListLocks)
		r.Get("/api/admin/drafts/*", s.handleAdminViewDraft)
		r.Post("/api/admin/drafts/reclaim/*", s.handleAdminReclaimDraft)
		r.Delete("/api/admin/drafts/*", s.handleAdminDiscardDraft)

		// Database admin endpoints.
		r.Get("/api/admin/database/status", s.handleDatabaseStatus)
		r.Post("/api/admin/database/test", s.handleDatabaseTest)
		r.Post("/api/admin/database/connect", s.handleDatabaseConnect)

		// Database schema admin endpoints.
		r.Get("/api/admin/database/tables", s.handleListDatabaseTables)
		r.Post("/api/admin/database/tables", s.handleCreateDatabaseTable)
		r.Get("/api/admin/database/tables/{id}", s.handleGetDatabaseTable)
		r.Put("/api/admin/database/tables/{id}", s.handleUpdateDatabaseTable)
		r.Delete("/api/admin/database/tables/{id}", s.handleDeleteDatabaseTable)
		r.Post("/api/admin/database/tables/{id}/migrate-page-paths", s.handleMigratePagePaths)
		r.Post("/api/admin/database/tables/{id}/fields", s.handleCreateDatabaseField)
		r.Put("/api/admin/database/tables/{id}/fields/{fid}", s.handleUpdateDatabaseField)
		r.Delete("/api/admin/database/tables/{id}/fields/{fid}", s.handleArchiveDatabaseField)
		r.Get("/api/admin/database/tables/{id}/rows/count", s.handleCountDatabaseRows)
		r.Get("/api/admin/database/tables/{id}/history", s.handleDatabaseTableHistory)
	})

	// Token management — session auth only (not API token).
	r.Group(func(r chi.Router) {
		r.Use(s.requireSessionAuth)
		r.Get("/api/tokens", s.handleListTokens)
		r.Post("/api/tokens", s.handleCreateToken)
		r.Delete("/api/tokens/{id}", s.handleDeleteToken)
	})

	// Admin token management.
	r.Group(func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Use(s.requireAdmin)
		r.Get("/api/admin/tokens", s.handleAdminListTokens)
		r.Delete("/api/admin/tokens/{id}", s.handleAdminDeleteToken)

		// Certificate management
		if s.certStore != nil {
			r.Get("/api/admin/certs", func(w http.ResponseWriter, _ *http.Request) {
				certs, err := s.certStore.List()
				if err != nil {
					writeError(w, http.StatusInternalServerError, err.Error())
					return
				}
				if certs == nil {
					certs = []reviewflow.UserCertificate{}
				}
				writeJSON(w, http.StatusOK, map[string]any{"certs": certs})
			})
		}
	})

	// AI conventions — public (no auth), like the OpenAPI spec.
	r.Get("/api/ai/v1/conventions", s.handleAIConventions)

	// AI API endpoints — require auth (session or token).
	r.Route("/api/ai/v1", func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Use(s.rateLimitToken)
		r.Get("/namespace/*", s.handleAINamespace)
		r.Post("/batch/read", s.handleAIBatchRead)
		r.Post("/preview/*", s.handleAIPreview)
		r.Get("/meta/*", s.handleAIMeta)
	})

	// OAuth 2.0 authorization-server endpoints for MCP client onboarding.
	// Registered before /api/mcp/v1 so the discovery metadata is reachable.
	s.registerOAuthServerRoutes(r)

	// MCP (Model Context Protocol) server — the AI API re-exposed as tools,
	// resources, and prompts over Streamable HTTP. Auth reuses the same
	// bearer token middleware as the AI Content API; 401 responses carry a
	// WWW-Authenticate header pointing MCP clients at the OAuth discovery
	// metadata (RFC 9728 § 5.1).
	mcpHandler := s.buildMCPHandler()
	r.Route("/api/mcp/v1", func(r chi.Router) {
		r.Use(s.mcpAuthChallenge)
		r.Use(s.requireAuth)
		r.Use(s.rateLimitToken)
		r.Handle("/*", http.StripPrefix("/api/mcp/v1", mcpHandler))
		r.Handle("/", mcpHandler)
	})

	// Integrated AI assistant — session auth + allowed_groups check.
	r.Route("/api/ai/assistant", func(r chi.Router) {
		r.Use(s.requireSessionAuth)
		r.Use(s.requireAIAssistantAccess)
		r.Post("/chat", s.handleAIChat)
	})

	// Database data endpoints — read (optional auth).
	r.Group(func(r chi.Router) {
		r.Use(s.optionalAuth)
		r.Get("/api/database/{table}/schema", s.handleDatabaseSchema)
		r.Get("/api/database/{table}/rows", s.handleDatabaseQueryRows)
		r.Get("/api/database/{table}/rows/{id}", s.handleDatabaseGetRow)
		r.Get("/api/database/{table}/page/*", s.handleDatabaseGetRowByPage)
		r.Get("/api/database/{table}/export/csv", s.handleDatabaseExportCSV)
	})

	// Database data endpoints — write (require auth).
	r.Group(func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Post("/api/database/{table}/rows", s.handleDatabaseInsertRow)
		r.Put("/api/database/{table}/rows/{id}", s.handleDatabaseUpdateRow)
		r.Delete("/api/database/{table}/rows/{id}", s.handleDatabaseDeleteRow)
		r.Put("/api/database/{table}/page/*", s.handleDatabaseUpsertRowByPage)
	})

	// Todo plugin endpoints.
	if s.todoService != nil {
		extractUsername := func(r *http.Request) string {
			return UsernameFromContext(r.Context())
		}
		// Build a reviewflow checker for todo inactivation (nil-safe if no reviewflow service).
		var rfChecker todo.ReviewflowChecker
		if s.reviewflowService != nil {
			rfChecker = s.reviewflowService
		}
		r.Route("/api/plugin/todo/v1", func(r chi.Router) {
			// Read-only endpoints: accessible to anyone who can read the page.
			r.Group(func(r chi.Router) {
				r.Use(s.optionalAuth)
				todo.RegisterReadRoutes(r, s.todoService, s.userStore, s.groupStore, extractUsername, &pageCheckerAdapter{store: s.store}, rfChecker)
			})
			// Write endpoints: require authentication.
			r.Group(func(r chi.Router) {
				r.Use(s.requireAuth)
				todo.RegisterWriteRoutes(r, s.todoService, s.userStore, s.groupStore, extractUsername, &pageCheckerAdapter{store: s.store}, rfChecker)
			})
		})
	}

	// Bibliography plugin endpoints.
	if s.bibliographyService != nil {
		r.Route("/api/plugin/bibliography/v1", func(r chi.Router) {
			r.Use(s.optionalAuth)
			bibliography.RegisterRoutes(r, s.bibliographyService)
		})
	}

	// Reviewflow plugin endpoints.
	{
		extractUsername := func(r *http.Request) string {
			return UsernameFromContext(r.Context())
		}
		r.Route("/api/plugin/reviewflow/v1", func(r chi.Router) {
			r.Group(func(r chi.Router) {
				r.Use(s.optionalAuth)
				reviewflow.RegisterReadRoutes(r, s.reviewflowService, extractUsername)
			})
			r.Group(func(r chi.Router) {
				r.Use(s.requireAuth)
				reviewflow.RegisterWriteRoutes(r, s.reviewflowService, extractUsername)
			})
			// Audit export — requires auth + ACL "view" on the page.
			r.Group(func(r chi.Router) {
				r.Use(s.requireAuth)
				reviewflow.RegisterAuditRoutes(r, s.reviewflowService, extractUsername, s.aclStore.CheckPermission, s.getUserGroups)
			})
			// "Ready for signature" toggle — auth + ACL (edit rights are
			// one of the two ways to be allowed to toggle).
			r.Group(func(r chi.Router) {
				r.Use(s.requireAuth)
				reviewflow.RegisterReleaseRoutes(r, s.reviewflowService, extractUsername, s.aclStore.CheckPermission, s.getUserGroups)
			})
			// CA management — admin only.
			if s.caStore != nil {
				r.Group(func(r chi.Router) {
					r.Use(s.requireAuth)
					r.Use(s.requireAdmin)
					reviewflow.RegisterCARoutes(r, s.caStore, s.certStore, s.reviewflowService, extractUsername)
				})
			}
		})
	}

	// Lifecycle plugin endpoints — reader-facing status for the
	// {lifecycle} rendering box. Optional auth so the NodeView can
	// render on public pages; the endpoint exposes no data that
	// isn't already in the page markdown itself.
	if s.lifecycleStore != nil {
		r.Route("/api/plugin/lifecycle/v1", func(r chi.Router) {
			r.Use(s.optionalAuth)
			lifecycle.RegisterRoutes(r, s.lifecycleStore, s.lifecycleScanner)
		})
	}

	// Comment plugin endpoints.
	if s.commentService != nil {
		extractUsername := func(r *http.Request) string {
			return UsernameFromContext(r.Context())
		}
		isAdmin := func(r *http.Request) bool {
			username := UsernameFromContext(r.Context())
			if username == "" {
				return false
			}
			user, err := s.userStore.Get(username)
			if err != nil {
				return false
			}
			for _, g := range user.Groups {
				if g == "admin" {
					return true
				}
			}
			return false
		}
		r.Route("/api/plugin/comment/v1", func(r chi.Router) {
			r.Group(func(r chi.Router) {
				r.Use(s.optionalAuth)
				comment.RegisterReadRoutes(r, s.commentService)
			})
			r.Group(func(r chi.Router) {
				r.Use(s.requireAuth)
				comment.RegisterWriteRoutes(r, s.commentService, extractUsername, isAdmin)
			})
		})
	}

	r.Get("/media/*", s.handleServeMedia)
	r.Get(`/{path:[^/]*\.[^/]*}`, s.handleFilePath)

	if serveWeb {
		r.NotFound(s.handleFrontend)
	} else {
		// Dev mode: Vite proxies attachment-like paths to the backend.
		// The regex route above only matches single-segment paths, so
		// register a NotFound handler to catch multi-segment file paths
		// (e.g. /ns/image.png).
		r.NotFound(s.handleFilePath)
	}
	return r
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "ok",
	})
}

// handleVersion returns the software version, build commit, build date,
// and Go runtime version. Public (no auth) — the whole point is to let
// CI, deploy verifiers, and the reviewflow audit trail read what is
// actually running against what was validated. Never cache this.
func (s *Server) handleVersion(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{
		"version":    Version,
		"commit":     BuildCommit,
		"build_date": BuildDate,
		"go_version": runtime.Version(),
	})
}

func (s *Server) handleGetPage(w http.ResponseWriter, r *http.Request) {
	pagePath := strings.TrimSpace(chi.URLParam(r, "*"))
	if pagePath == "" {
		writeError(w, http.StatusBadRequest, "missing page path")
		return
	}

	// Page content and meta.Version change on every save (including row-driven
	// writes). Prevent browsers from serving a stale copy from HTTP cache.
	w.Header().Set("Cache-Control", "no-store")

	page, err := s.store.Get(pagePath)
	if errors.Is(err, storage.ErrPageNotFound) {
		writeError(w, http.StatusNotFound, "page not found")
		return
	}
	if err != nil {
		if strings.Contains(err.Error(), "invalid page path") || strings.Contains(err.Error(), "forbidden characters") {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Check draft/lock state.
	username := UsernameFromContext(r.Context())
	lock := s.draftManager.GetLock(pagePath)

	// Backfill created_by from changelog if not already set in metadata.
	if page.Meta.CreatedBy == "" && s.changelog != nil {
		if author := s.changelog.FirstAuthor(page.Path); author != "" {
			page.Meta.CreatedBy = author
		}
	}

	// Draft-visibility gate — see draftGate in draft_gate.go for the
	// full decision table. Feature is off by default; when on and the
	// requester is uninvolved with a draft, we either swap the served
	// markdown for the last validated version or 404 if there isn't
	// one yet.
	servedValidatedVersion := int64(0)
	if s.reviewflowService != nil {
		cfg := s.configStore.Get().Reviewflow
		if cfg.HideDraftsFromUninvolved {
			st, _ := s.reviewflowService.GetStatus(pagePath)
			groups := s.getUserGroups(username)
			involved := s.reviewflowService.IsInvolved(pagePath, username, groups)
			decision := draftGate(cfg, st, involved)
			if decision.Return404 {
				writeError(w, http.StatusNotFound, "page not found")
				return
			}
			if decision.SwapToVersion > 0 {
				content, aerr := s.atticStore.ReadVersion(pagePath, decision.SwapToVersion)
				if aerr == nil {
					page.Markdown = string(content)
					servedValidatedVersion = decision.SwapToVersion
				}
				// Attic read failure falls through to serving current
				// content — better than a 500 on a read request.
			}
		}
	}

	resp := map[string]any{
		"path":               page.Path,
		"markdown":           page.Markdown,
		"meta":               page.Meta,
		"is_namespace_index": page.IsNamespaceIndex,
	}
	if servedValidatedVersion > 0 {
		// Signals to the frontend that this response was swapped for
		// the validated version — useful for a subtle UI marker on the
		// reader side and for auditability. Involved readers never see
		// this key.
		resp["served_validated_version"] = servedValidatedVersion
	}

	// Include current version numbers for all referenced media files.
	if s.mediaVersionStore != nil {
		refs := markdown.ExtractMediaRefs(page.Markdown, page.Path)
		mediaVersions := make(map[string]int64, len(refs))
		for _, ref := range refs {
			ver := s.mediaVersionStore.GetVersion(ref)
			if ver > 0 {
				mediaVersions[ref] = ver
			}
		}
		if len(mediaVersions) > 0 {
			resp["media_versions"] = mediaVersions
		}
	}

	if lock.Owner != "" {
		resp["locked_by"] = lock.Owner
		// If the requester is the draft owner, return draft content.
		if username == lock.Owner {
			if draft, err := s.draftManager.ReadDraft(pagePath, username); err == nil {
				resp["markdown"] = draft
				resp["is_draft"] = true
			}
		}
	}

	// Read-action tasks now require explicit acknowledgement (no auto-complete).

	writeJSON(w, http.StatusOK, resp)
}

type putPageRequest struct {
	Markdown string `json:"markdown"`
}

func (s *Server) handlePutPage(w http.ResponseWriter, r *http.Request) {
	pagePath := strings.TrimSpace(chi.URLParam(r, "*"))
	if pagePath == "" {
		writeError(w, http.StatusBadRequest, "missing page path")
		return
	}

	var req putPageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}

	// Reject external writes that would race against an in-progress edit or
	// clobber unpublished work. The editor publishes via /api/publish/* (which
	// clears the lock first), so reaching this endpoint with either a lock
	// or a draft file present means an API-token caller is about to lose
	// someone else's work. Lock and draft are independent — a draft file can
	// outlive its lock (admin discard, session crash).
	if s.draftManager != nil {
		if lock := s.draftManager.GetLock(pagePath); lock.Owner != "" {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":      "page_locked",
				"lock_owner": lock.Owner,
				"lock_since": lock.Since,
				"message":    "page is locked by " + lock.Owner + " — wait for them to finish editing before writing",
			})
			return
		}
		if draft, ok := s.draftManager.FindAnyDraft(pagePath); ok {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":       "draft_exists",
				"draft_owner": draft.Owner,
				"draft_since": draft.Since,
				"message":     "page has an unpublished draft by " + draft.Owner + " — wait for it to be published or discarded before writing",
			})
			return
		}
	}

	author := UsernameFromContext(r.Context())
	result, err := s.store.Put(pagePath, req.Markdown, author)
	if errors.Is(err, storage.ErrNamespaceConflict) {
		var nce *storage.NamespaceConflictError
		if errors.As(err, &nce) {
			writeJSON(w, http.StatusConflict, map[string]string{
				"error":            "namespace_conflict",
				"conflicting_page": nce.ConflictingPage,
				"message":          "Page " + nce.ConflictingPage + " must be converted to a namespace index first",
			})
		} else {
			writeError(w, http.StatusConflict, "a namespace directory exists at this path")
		}
		return
	}
	var cycleErr *storage.CircularIncludeError
	if errors.As(err, &cycleErr) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error": cycleErr.Error(),
			"cycle": cycleErr.Cycle,
		})
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Auto-complete of read / edit / create action tasks happens via
	// store.OnPageSaved (set in main.go). We used to fire the three
	// calls here, but that left the MCP write paths (write_page,
	// edit_page, create_page_from_template, row writers) silent —
	// moving the dispatch into the storage layer means every write
	// path fires the same hook regardless of transport.

	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleDeletePage(w http.ResponseWriter, r *http.Request) {
	pagePath := strings.TrimSpace(chi.URLParam(r, "*"))
	if pagePath == "" {
		writeError(w, http.StatusBadRequest, "missing page path")
		return
	}

	username := UsernameFromContext(r.Context())
	result, err := s.store.Delete(pagePath, username)
	if errors.Is(err, storage.ErrPageNotFound) {
		writeError(w, http.StatusNotFound, "page not found")
		return
	}
	if errors.Is(err, storage.ErrPageHasLock) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": err.Error(),
		})
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"deleted":        pagePath,
		"orphaned_media": result.OrphanedMedia,
		"included_by":    result.IncludedBy,
	})
}

func (s *Server) handleListMedia(w http.ResponseWriter, r *http.Request) {
	nsPath := strings.TrimSpace(chi.URLParam(r, "*"))
	entries, err := s.mediaStore.List(nsPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":    nsPath,
		"entries": entries,
	})
}

func parseBoolFlag(raw string) bool {
	if raw == "" {
		return false
	}
	ok, err := strconv.ParseBool(raw)
	if err == nil {
		return ok
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "on", "yes", "y":
		return true
	default:
		return false
	}
}

func (s *Server) handleUploadMedia(w http.ResponseWriter, r *http.Request) {
	nsPath := strings.TrimSpace(chi.URLParam(r, "*"))
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing file field")
		return
	}
	defer file.Close()

	overwrite := parseBoolFlag(r.FormValue("overwrite"))
	author := UsernameFromContext(r.Context())
	entry, err := s.mediaStore.Put(nsPath, header.Filename, file, overwrite, author)
	if errors.Is(err, storage.ErrMediaConflict) {
		writeError(w, http.StatusConflict, "media file already exists")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"entry": entry})
}

func (s *Server) handleDeleteMedia(w http.ResponseWriter, r *http.Request) {
	mediaPath := strings.TrimSpace(chi.URLParam(r, "*"))
	if mediaPath == "" {
		writeError(w, http.StatusBadRequest, "missing media path")
		return
	}

	// Check if the media is still referenced by any pages. The ref index
	// stores media keys canonically (leading slash); the chi URL param does
	// not carry one, so add it here.
	if pages := s.orphanDetector.GetReferencingPages("/" + mediaPath); len(pages) > 0 {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":             "media is still referenced",
			"referencing_pages": pages,
		})
		return
	}

	err := s.mediaStore.Delete(mediaPath)
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "media file not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": mediaPath})
}

func (s *Server) handleMediaOrphans(w http.ResponseWriter, _ *http.Request) {
	orphans, err := s.orphanDetector.FindOrphans()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"orphans": orphans})
}

func (s *Server) handleServeMedia(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimSpace(chi.URLParam(r, "*"))
	if raw == "" {
		http.NotFound(w, r)
		return
	}

	cleaned := path.Clean("/" + raw)

	s.serveMediaWithVersioning(w, r, cleaned)
}

func (s *Server) handleServeMediaVersion(w http.ResponseWriter, r *http.Request) {
	mediaPath := strings.TrimSpace(chi.URLParam(r, "*"))
	if mediaPath == "" {
		http.NotFound(w, r)
		return
	}

	cleaned := path.Clean("/" + mediaPath)

	vStr := r.URL.Query().Get("v")
	version, err := strconv.ParseInt(vStr, 10, 64)
	if err != nil || version < 1 {
		writeError(w, http.StatusBadRequest, "invalid version number")
		return
	}

	if s.mediaAtticStore == nil {
		writeError(w, http.StatusNotFound, "media versioning not available")
		return
	}

	content, err := s.mediaAtticStore.ReadVersion(cleaned, version)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	// Set Content-Type based on file extension.
	ext := filepath.Ext(cleaned)
	ct := "application/octet-stream"
	switch strings.ToLower(ext) {
	case ".png":
		ct = "image/png"
	case ".jpg", ".jpeg":
		ct = "image/jpeg"
	case ".gif":
		ct = "image/gif"
	case ".svg":
		ct = "image/svg+xml"
	case ".webp":
		ct = "image/webp"
	case ".pdf":
		ct = "application/pdf"
	case ".txt":
		ct = "text/plain"
	case ".html", ".htm":
		ct = "text/html"
	case ".css":
		ct = "text/css"
	case ".js":
		ct = "application/javascript"
	case ".json":
		ct = "application/json"
	case ".xml":
		ct = "application/xml"
	case ".zip":
		ct = "application/zip"
	case ".mp4":
		ct = "video/mp4"
	case ".webm":
		ct = "video/webm"
	case ".mp3":
		ct = "audio/mpeg"
	case ".ogg":
		ct = "audio/ogg"
	}

	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	w.WriteHeader(http.StatusOK)
	w.Write(content)
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, map[string]any{"results": []any{}})
		return
	}

	limit := 10
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 50 {
		limit = 50
	}

	results, err := s.searchStore.Search(q, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (s *Server) handleRecentChanges(w http.ResponseWriter, r *http.Request) {
	count := 10
	if raw := r.URL.Query().Get("count"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			count = n
		}
	}

	// The public "recent changes" page shows one entry per page (most
	// recent). MCP consumers who want the un-deduped stream use the
	// list_recent_changes tool instead, which passes Dedupe: false.
	opts := storage.ReadOptions{Count: count, Dedupe: true}

	// Parse path filter: comma-separated prefixes, "-" prefix for exclusion.
	if raw := r.URL.Query().Get("path"); raw != "" {
		for _, p := range strings.Split(raw, ",") {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			if strings.HasPrefix(p, "-") {
				opts.ExcludePaths = append(opts.ExcludePaths, strings.TrimPrefix(p, "-"))
			} else {
				// Strip leading slash — backend paths don't use them.
				opts.IncludePaths = append(opts.IncludePaths, strings.TrimPrefix(p, "/"))
			}
		}
	}

	if raw := r.URL.Query().Get("type"); raw != "" {
		for _, t := range strings.Split(raw, ",") {
			t = strings.TrimSpace(t)
			if t != "" {
				opts.Types = append(opts.Types, t)
			}
		}
	}

	if raw := r.URL.Query().Get("user"); raw != "" {
		for _, u := range strings.Split(raw, ",") {
			u = strings.TrimSpace(u)
			if u != "" {
				opts.Users = append(opts.Users, u)
			}
		}
	}

	entries, err := s.changelog.Read(opts)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

func (s *Server) handleSiteInfo(w http.ResponseWriter, _ *http.Request) {
	cfg := s.configStore.Get()
	themeDefault := cfg.Themes.Default
	if themeDefault == "" {
		themeDefault = "auto"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"title":                cfg.Site.Title,
		"version":              Version,
		"toc_max_level":        cfg.Site.TOCMaxLevel,
		"user_display":         cfg.Site.UserDisplay,
		"code_theme":           cfg.Site.CodeTheme,
		"code_theme_dark":      cfg.Site.CodeThemeDark,
		"ai_assistant_enabled": cfg.AIAssistant.Enabled,
		"theme": map[string]any{
			"default":             themeDefault,
			"allow_user_override": cfg.Themes.AllowUserOverride,
			"image_auto_frame":    cfg.Themes.ImageAutoFrameEnabled(),
		},
	})
}

func (s *Server) handleSiteLogo(w http.ResponseWriter, _ *http.Request) {
	logoPath, err := s.logoResolver.ResolveLogo()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if logoPath == "" {
		writeError(w, http.StatusNotFound, "no logo found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": logoPath})
}

// handleUsersDisplay returns display information for a list of usernames.
// Query: ?users=alice,bob,carol
// Returns: { "users": { "alice": { "display_name": "...", "email": "..." }, ... } }
func (s *Server) handleUsersDisplay(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimSpace(r.URL.Query().Get("users"))
	if raw == "" {
		writeJSON(w, http.StatusOK, map[string]any{"users": map[string]any{}})
		return
	}

	cfg := s.configStore.Get()
	displayMode := cfg.Site.UserDisplay
	if displayMode == "" {
		displayMode = "login"
	}

	names := strings.Split(raw, ",")
	result := make(map[string]any, len(names))
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		entry := map[string]string{"username": name, "label": name}
		if user, err := s.userStore.Get(name); err == nil {
			entry["display_name"] = user.DisplayName
			entry["email"] = user.Email
			switch displayMode {
			case "fullname":
				if user.DisplayName != "" {
					entry["label"] = user.DisplayName
				}
			case "email":
				if user.Email != "" {
					entry["label"] = user.Email
				}
			}
		}
		result[name] = entry
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": result})
}

// handleUsersList returns all active users with username and display name.
// Used by the database plugin's "user" field type for dropdown population.
func (s *Server) handleUsersList(w http.ResponseWriter, _ *http.Request) {
	users := s.userStore.List()
	result := make([]map[string]string, 0, len(users))
	for _, u := range users {
		if u.Disabled {
			continue
		}
		result = append(result, map[string]string{
			"username":     u.Username,
			"display_name": u.DisplayName,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": result})
}

func (s *Server) handleBacklinks(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimSpace(chi.URLParam(r, "*"))
	if raw == "" {
		writeError(w, http.StatusBadRequest, "missing page path")
		return
	}
	pagePath := path.Clean("/" + raw)

	if s.backlinkProvider == nil {
		writeJSON(w, http.StatusOK, map[string]any{"backlinks": []any{}})
		return
	}

	paths := s.backlinkProvider.GetBacklinks(pagePath)
	type backlinkEntry struct {
		Path  string `json:"path"`
		Title string `json:"title"`
	}
	var backlinks []backlinkEntry
	for _, p := range paths {
		title := p
		if page, err := s.store.Get(p); err == nil {
			if t := markdown.ExtractTitle(page.Markdown); t != "" {
				title = t
			}
		}
		backlinks = append(backlinks, backlinkEntry{Path: p, Title: title})
	}
	if backlinks == nil {
		backlinks = []backlinkEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"backlinks": backlinks})
}

// pageCheckerAdapter implements todo.PageChecker using the page store.
type pageCheckerAdapter struct {
	store PageStore
}

func (a *pageCheckerAdapter) PageExists(pagePath string) bool {
	return a.store.Exists(pagePath)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
