package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"time"

	"sargon/backend/internal/api"
	"sargon/backend/internal/auth"
	"sargon/backend/internal/bibliography"
	"sargon/backend/internal/comment"
	"sargon/backend/internal/config"
	"sargon/backend/internal/database"
	"sargon/backend/internal/lifecycle"
	"sargon/backend/internal/manual"
	"sargon/backend/internal/reviewflow"
	"sargon/backend/internal/storage"
	"sargon/backend/internal/todo"
)

// siteOptions is everything one wiki needs to start. Several wikis can be
// built in the same process: each owns its config, data root, database,
// indexes and background jobs; they share only the headless Chrome
// allocator and the listener.
type siteOptions struct {
	// name tags every log line this site writes from main ("[name] ...").
	// Empty in single-site mode, where the log stays as it always was.
	name        string
	configPath  string
	configStore *config.Store
	dataRoot    string
	serveWeb    bool
	webDir      string
	browserCtx  context.Context
}

// site is one running wiki.
type site struct {
	name    string
	handler http.Handler
	// shutdown flushes pending work (queued notification digests) and
	// closes the search index. Called once, after the listener stopped.
	shutdown func()
}

// buildSite opens one wiki's stores, runs its startup reconciliations,
// starts its background jobs and returns its HTTP handler.
func buildSite(opts siteOptions) (*site, error) {
	logf := log.Printf
	if opts.name != "" {
		prefix := "[" + opts.name + "] "
		logf = func(format string, args ...any) { log.Printf(prefix+format, args...) }
	}
	configStore := opts.configStore
	cfg := configStore.Get()
	dataRoot := opts.dataRoot
	contentRoot := filepath.Join(dataRoot, "content")
	metaRoot := filepath.Join(dataRoot, "meta")
	logf("config: %s", opts.configPath)

	store, err := storage.NewFileStore(contentRoot)
	if err != nil {
		return nil, fmt.Errorf("init page storage: %w", err)
	}

	// Bootstrap embedded user manual. Wipes and regenerates wiki/manual/ on
	// every binary upgrade (detected by embed content hash); no-op otherwise.
	if n := manual.Bootstrap(contentRoot, metaRoot); n > 0 {
		logf("manual: regenerated %d files under wiki/manual/ from embed", n)
	}

	// Open search index.
	searchIndexPath := filepath.Join(metaRoot, "_search")
	searchIndex, err := storage.OpenSearchIndex(searchIndexPath)
	if err != nil {
		return nil, fmt.Errorf("init search index: %w", err)
	}
	store.SearchIndex = searchIndex

	mediaStore, err := storage.NewMediaFileStore(contentRoot)
	if err != nil {
		return nil, fmt.Errorf("init media storage: %w", err)
	}

	// Initialize media version tracking.
	mediaVersionStore := storage.NewMediaVersionStore(metaRoot)
	if err := mediaVersionStore.Load(); err != nil {
		return nil, fmt.Errorf("init media version store: %w", err)
	}
	mediaStore.VersionStore = mediaVersionStore
	store.MediaVersionStore = mediaVersionStore

	// Initialize media attic for archiving old media versions.
	mediaAttic := storage.NewMediaAttic(dataRoot)
	mediaStore.MediaAttic = mediaAttic

	userStore, err := auth.NewUserStore(metaRoot)
	if err != nil {
		return nil, fmt.Errorf("init user store: %w", err)
	}
	groupStore, err := auth.NewGroupStore(metaRoot)
	if err != nil {
		return nil, fmt.Errorf("init group store: %w", err)
	}
	aclStore, err := auth.NewACLStore(metaRoot)
	if err != nil {
		return nil, fmt.Errorf("init acl store: %w", err)
	}

	// Session store — uses TTL from config.
	sessionTTL := auth.DefaultSessionTTL
	if cfg.Auth.SessionTTL != "" {
		if parsed, err := time.ParseDuration(cfg.Auth.SessionTTL); err == nil {
			sessionTTL = parsed
		}
	}
	sessionStore, err := auth.NewSessionStore(metaRoot, sessionTTL)
	if err != nil {
		return nil, fmt.Errorf("init session store: %w", err)
	}

	// Initialize database pool.
	dbPool := database.NewPool()
	if cfg.Database.Enabled && cfg.Database.DSN != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := dbPool.Connect(ctx, cfg.Database.DSN); err != nil {
			logf("WARNING: database connection failed: %v", err)
		} else {
			logf("database: connected")
			if err := database.RunMigrations(ctx, dbPool); err != nil {
				logf("WARNING: database migration failed: %v", err)
			} else {
				logf("database: migrations applied")
				schemaStore := database.NewSchemaStore(dbPool)
				dataStore := database.NewDataStore(dbPool, schemaStore)
				store.DatabaseSync = database.NewDatabaseSync(schemaStore, dataStore)
			}
		}
		cancel()
	}

	// Initialize todo plugin: auto-enabled when database is connected,
	// unless explicitly disabled via todo.disabled config flag.
	var todoService *todo.TodoService
	var todoDispatcher *todo.Dispatcher
	todoEnabled := dbPool.IsConnected() && (cfg.Todo.Enabled || !cfg.Todo.Disabled)
	if todoEnabled {
		todoCtx, todoCancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := todo.RunMigrations(todoCtx, dbPool); err != nil {
			logf("WARNING: todo migration failed: %v", err)
		} else {
			logf("todo plugin: migrations applied")
			todoStore := todo.NewTodoStore(dbPool)
			todoHub := todo.NewHub()
			dispatcher := todo.NewDispatcher(configStore, func(username string) string {
				u, err := userStore.Get(username)
				if err != nil {
					return ""
				}
				return u.Email
			})
			// Throttle outbound notifications: trailing debounce +
			// 24h per-(user, page) cap. The window reads live from
			// config.yaml so an admin UI edit takes effect without a
			// restart; a 0 or negative value disables batching, in
			// which case the cap still applies on the single-event
			// path.
			capStore := todo.NewDBCapStore(dbPool)
			batcher := todo.NewNotificationBatcher(
				func() time.Duration {
					sec := configStore.Get().Todo.Notify.BatchWindowSeconds
					return time.Duration(sec) * time.Second
				},
				capStore,
				dispatcher,
			)
			dispatcher.AttachBatcher(batcher)
			todoDispatcher = dispatcher
			todoService = todo.NewService(todoStore, todoHub, dispatcher)
			store.TodoSync = todo.NewTodoSyncer(todoStore, todoHub, dispatcher)
			// Wire the post-save hook so EVERY write path (HTTP save,
			// MCP write_page / edit_page / create_page_from_template,
			// database row insert / update that touches a bound page)
			// fires the action-trigger fan-out. Fire-and-forget: the
			// handler path shouldn't wait for todo bookkeeping.
			savedTodoService := todoService
			store.OnPageSaved = func(pagePath, author string) {
				go savedTodoService.AutoCompleteWikiAction(context.Background(), "edit", pagePath, author)
				go savedTodoService.AutoCompleteCreateAction(context.Background(), pagePath, author)
				go savedTodoService.ReopenReadTasks(context.Background(), pagePath)
			}
			go todo.RunScheduler(context.Background(), todoStore, dispatcher)
			logf("todo plugin: active")
		}
		todoCancel()
	}

	// Initialize tag index.
	tagIndex := storage.NewTagIndex(metaRoot)
	if err := tagIndex.Load(); err != nil {
		logf("WARNING: tag index load failed: %v", err)
	}
	store.TagIndex = tagIndex

	// Initialize reviewflow plugin (always available; config controls behavior).
	rfStore := reviewflow.NewStore(metaRoot)
	reviewflowService := reviewflow.NewService(rfStore, store.Attic, configStore)
	reviewflowService.SetPageReader(store)
	certStore := reviewflow.NewCertStore(metaRoot)
	caStore := reviewflow.NewCAStore(metaRoot)
	signingVerifier := reviewflow.NewSigningVerifier(configStore, certStore)
	reviewflowService.SetSigningVerifier(signingVerifier)
	reviewflowService.SetCertStore(certStore)
	// Cascade revocation on re-issue: the moment CertStore.Save overwrites
	// a prior cert, the prior fingerprint gets added to the config
	// revocation list. Admins don't have to remember a separate revoke
	// step, and a re-issue that follows an ordinary revoke keeps the old
	// fingerprint blacklisted (the certstore file that carried the
	// Revoked flag is about to be overwritten by the new cert).
	certStore.OnPreviousCertOverwritten = func(fingerprint string) {
		reviewflowService.AddRevokedFingerprint(fingerprint, time.Now())
		logf("reviewflow: cert re-issue cascaded revocation of previous fingerprint %s", fingerprint)
	}
	reviewflowService.SetCAStore(caStore)
	if cfg.Reviewflow.Signing.Enabled {
		logf("reviewflow plugin: X.509 signing enabled")
	}
	if todoService != nil {
		reviewflowService.SetTodoIntegrator(reviewflow.NewTodoAdapter(todoService))
		logf("reviewflow plugin: todo integration active")
		if n, err := reviewflowService.ReconcileValidatedTasks(); err != nil {
			logf("reviewflow plugin: task reconciliation failed: %v", err)
		} else if n > 0 {
			logf("reviewflow plugin: reconciled %d review task(s) — marked done on validated pages", n)
		}
		// Orphan sweep: pages deleted, pages fully validated, pages whose
		// directive changed role assignments between tags. Historical
		// drift accumulated before the lifecycle cleanups were in place
		// (storage.Delete hook, always-cancel on version bump,
		// finalize-also-cancels). Idempotent — a second run is a no-op.
		if n, err := reviewflowService.ReconcileOrphanTasks(store.Exists); err != nil {
			logf("reviewflow plugin: orphan reconciliation failed: %v", err)
		} else if n > 0 {
			logf("reviewflow plugin: reconciled orphan review tasks for %d page(s)", n)
		}
		// Stateless-task sweep: catches reviewflow tasks whose page AND
		// state file have both disappeared (page deleted before the
		// OnPageDelete hook was wired). The state-file reconciler can
		// never see these because there's no state file left to anchor
		// them to. Walks tasks instead. Idempotent.
		if n, err := reviewflowService.ReconcileStatelessReviewTasks(store.Exists); err != nil {
			logf("reviewflow plugin: stateless-task reconciliation failed: %v", err)
		} else if n > 0 {
			logf("reviewflow plugin: cancelled stateless review tasks on %d page(s)", n)
		}
	}
	// Stale-signature sweep: catches signatures whose stored digest no
	// longer matches current page content. SyncFromMarkdown enforces
	// the invariant on every write going forward, but states already
	// in the stale shape need the one-shot. Idempotent.
	if n, err := reviewflowService.ReconcileStaleSignatures(); err != nil {
		logf("reviewflow plugin: stale-signature reconciliation failed: %v", err)
	} else if n > 0 {
		logf("reviewflow plugin: invalidated stale signatures on %d page(s)", n)
	}
	// Tombstone-drift sweep: catches pages that were deleted before
	// Delete() learned to tombstone and then had new content created
	// at the same path (or whose sidecars survived their deletion for
	// any other reason). Delete() enforces the invariant on every
	// deletion going forward; this one-shot drains the pre-fix drift.
	// Idempotent.
	if n, err := store.ReconcileTombstones(); err != nil {
		logf("storage: tombstone reconciliation failed: %v", err)
	} else if n > 0 {
		logf("storage: tombstoned drift history for %d page(s)", n)
	}
	reviewflowService.SetGroupResolver(func(username string) []string {
		u, err := userStore.Get(username)
		if err != nil {
			return nil
		}
		return u.EffectiveGroups()
	})
	store.ReviewflowSync = reviewflowService
	logf("reviewflow plugin: active")

	// Initialize lifecycle plugin: {lifecycle} directives on pages
	// declare "if a page in scope satisfies a condition (today: stale),
	// spawn a todo targeting it." The Store persists the index of
	// rules per source page; the page-save hook keeps it current; the
	// Scanner runs periodically to reconcile todos with the current
	// (rule × page × condition) set.
	lifecycleStore, err := lifecycle.NewStore(metaRoot)
	if err != nil {
		return nil, fmt.Errorf("init lifecycle store: %w", err)
	}
	store.LifecycleSync = lifecycle.NewSyncer(lifecycleStore)
	var lifecycleScanner *lifecycle.Scanner
	if todoService != nil {
		// Reviewflow attestation source: the latest VersionRecord's
		// timestamp from the reviewflow state for a page. Zero-time
		// for pages that have no reviewflow (or none validated yet).
		reviewflowAttester := func(pagePath string) time.Time {
			st, err := rfStore.Load(pagePath)
			if err != nil || st == nil {
				return time.Time{}
			}
			var latest time.Time
			for _, vr := range st.VersionHistory {
				if vr.Timestamp.After(latest) {
					latest = vr.Timestamp
				}
			}
			return latest
		}
		// Page-updated attestation source: the page's own meta.UpdatedAt.
		pageEditAttester := func(pagePath string) time.Time {
			p, err := store.Get(pagePath)
			if err != nil {
				return time.Time{}
			}
			return p.Meta.UpdatedAt
		}
		// Reviewflow overdue probe: the OverdueRoles list from the
		// reviewflow status — the same signal the reviewflow panel
		// renders as "⚠ Overdue" on affected roles. Feeds the
		// reviewflow_overdue lifecycle condition (alert-only rule).
		overdueProbe := func(pagePath string) []string {
			if reviewflowService == nil {
				return nil
			}
			st, err := reviewflowService.GetStatus(pagePath)
			if err != nil || st == nil {
				return nil
			}
			return st.OverdueRoles
		}
		lifecycleScanner = lifecycle.NewScanner(lifecycle.Deps{
			Rules: lifecycleStore.AllRules,
			ListPages: func() []string {
				entries, err := store.ListAllPages()
				if err != nil {
					return nil
				}
				paths := make([]string, 0, len(entries))
				for _, e := range entries {
					paths = append(paths, e.Path)
				}
				return paths
			},
			PageTags:  tagIndex.GetTagsForPage,
			Attesters: []lifecycle.AttestationSource{pageEditAttester, reviewflowAttester},
			Overdue:   overdueProbe,
			CreateTodo: func(ctx context.Context, req lifecycle.TodoRequest) error {
				// Idempotency lives in the scanner (it consults
				// ExistingLifecycleTodos before calling us), so this
				// path is a straight create with no dedup pre-check.
				_, cerr := todoService.CreateTask(ctx, todo.CreateRequest{
					Title:      req.Title,
					Source:     todo.SourceAPI,
					SourcePage: req.SourcePage,
					NodeKey:    req.NodeKey,
					Assignee: todo.Assignee{
						Type:       "user",
						Target:     req.Assign,
						Resolution: "any",
					},
					Tags:      req.Tags,
					Priority:  todo.Priority(req.Priority),
					CreatedBy: "lifecycle",
				})
				return cerr
			},
			ExistingLifecycleTodos: func(ctx context.Context) ([]lifecycle.ExistingLifecycleTodo, error) {
				lst, _, err := todoService.Store().List(ctx, todo.ListOptions{Tag: "lifecycle", Limit: 2000})
				if err != nil {
					return nil, err
				}
				out := make([]lifecycle.ExistingLifecycleTodo, 0, len(lst))
				for _, t := range lst {
					if t.Status == todo.StatusCancelled || t.Status == todo.StatusDone {
						continue
					}
					out = append(out, lifecycle.ExistingLifecycleTodo{ID: t.ID, NodeKey: t.NodeKey})
				}
				return out, nil
			},
			CancelTodo: func(ctx context.Context, id string) error {
				_, err := todoService.Store().Cancel(ctx, id)
				return err
			},
		})
		// Run a scan once at startup so a freshly-deployed binary
		// picks up any rules whose target pages went stale while the
		// process was down. Then every 6 hours; the interval is a
		// balance between "todos appear soon after a page goes stale"
		// and "don't hammer the DB for a slow-moving signal."
		go func() {
			ctx := context.Background()
			created, cancelled, err := lifecycleScanner.Run(ctx)
			if err != nil {
				logf("lifecycle: initial scan: %v", err)
			} else {
				logf("lifecycle: initial scan — created=%d cancelled=%d", created, cancelled)
			}
			ticker := time.NewTicker(6 * time.Hour)
			defer ticker.Stop()
			for range ticker.C {
				created, cancelled, err := lifecycleScanner.Run(ctx)
				if err != nil {
					logf("lifecycle: scan: %v", err)
					continue
				}
				if created > 0 || cancelled > 0 {
					logf("lifecycle: scan — created=%d cancelled=%d", created, cancelled)
				}
			}
		}()
		logf("lifecycle plugin: active (scan every 6h)")
	} else {
		logf("lifecycle plugin: rules indexed but scanner disabled (no todo service)")
	}

	// Initialize comment plugin.
	commentStore := comment.NewStore(metaRoot)
	commentService := comment.NewService(commentStore)
	store.CommentStore = commentStore
	// Late-wire the lifecycle scanner's comments_open probe: comment
	// service is initialised AFTER the scanner (order-of-init) but
	// the probe is only consulted at scan time, so patching the Deps
	// via a small setter works fine.
	if lifecycleScanner != nil {
		lifecycleScanner.SetOpenCommentsProbe(commentService.CountOpenThreads)
	}
	logf("comment plugin: active")

	// Initialize bibliography plugin (PubMed + DOI citation resolver).
	var bibliographyService *bibliography.Service
	if cfg.Bibliography.Enabled {
		publicURL := ""
		if cfg.Server.TLSDomain != "" {
			publicURL = "https://" + cfg.Server.TLSDomain
		}
		bibliographyService = bibliography.NewService(metaRoot, cfg.Bibliography, publicURL)
		logf("bibliography plugin: active (PubMed api_key=%v)", cfg.Bibliography.PubmedAPIKey != "")
	}

	// Initialize API token store for AI Content API.
	tokenStore, err := auth.NewTokenStore(metaRoot)
	if err != nil {
		return nil, fmt.Errorf("init token store: %w", err)
	}
	if cfg.AIAPI.Enabled {
		logf("ai api: enabled (token auth active)")
	}

	// OAuth 2.0 authorization server for MCP clients that discover via the
	// standard well-known metadata (Claude.ai, Claude Desktop "Add connector"
	// UI, etc). Backed by the same TokenStore for issued access tokens.
	oauthServer, err := auth.NewOAuthServer(metaRoot)
	if err != nil {
		return nil, fmt.Errorf("init oauth server: %w", err)
	}
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			oauthServer.GCCodes()
		}
	}()

	router := api.NewRouter(store, mediaStore, store, searchIndex, store.Attic, store.Drafts, store, mediaAttic, mediaVersionStore, configStore, userStore, groupStore, sessionStore, aclStore, store.Changelog, dbPool, tagIndex, store, opts.browserCtx, func() {}, opts.serveWeb, filepath.Clean(opts.webDir), todoService, reviewflowService, commentService, tokenStore, caStore, certStore, bibliographyService, oauthServer, lifecycleStore, lifecycleScanner)
	if opts.serveWeb {
		logf("serving frontend assets from %s", opts.webDir)
	}
	logf("data root: %s", dataRoot)
	logf("content root: %s", contentRoot)
	logf("meta root: %s", metaRoot)

	// Rebuild indexes and run attic migration in the background.
	go func() {
		logf("rebuilding indexes...")
		if err := store.RebuildIndexes(); err != nil {
			logf("WARNING: rebuild indexes failed: %v", err)
		} else {
			logf("indexes rebuilt")
		}

		// Rebuild the full-text search index too — the ref/link/tag
		// indexes above cover metadata but leave the bleve body index
		// untouched, so any change to StripMarkdown (e.g. new directives
		// becoming searchable) would otherwise wait for each page to be
		// individually rewritten before it lands in search.
		if searchIndex != nil {
			logf("rebuilding search index...")
			if err := searchIndex.RebuildFromDir(contentRoot); err != nil {
				logf("WARNING: rebuild search index failed: %v", err)
			} else {
				logf("search index rebuilt")
			}
		}

		logf("running attic migration (if needed)...")
		if err := store.Attic.MigrateExistingPages(contentRoot, metaRoot, store.Changelog); err != nil {
			logf("WARNING: attic migration failed: %v", err)
		} else {
			logf("attic migration complete")
		}
	}()

	return &site{
		name:    opts.name,
		handler: router,
		shutdown: func() {
			if todoDispatcher != nil {
				todoDispatcher.Shutdown()
			}
			searchIndex.Close()
		},
	}, nil
}
