package storage

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"sargon/backend/internal/markdown"
)

var ErrPageNotFound = errors.New("page not found")
var ErrNamespaceConflict = errors.New("namespace conflict: a directory exists at this path")

// NamespaceConflictError is a detailed version of ErrNamespaceConflict that includes
// the conflicting page path.
type NamespaceConflictError struct {
	ConflictingPage string // the page that must be converted to a namespace index
}

func (e *NamespaceConflictError) Error() string {
	return "namespace conflict: page " + e.ConflictingPage + " blocks this path"
}

func (e *NamespaceConflictError) Is(target error) bool {
	return target == ErrNamespaceConflict
}

var ErrPageHasLock = errors.New("page is locked by a draft")
var ErrDestinationExists = errors.New("destination already exists")
var ErrNamespaceNotEmpty = errors.New("namespace not empty")
var ErrNoTemplate = errors.New("no template found")

// IsTemplatePath reports whether a normalized page path refers to a template
// file. Matches the default `_template` as well as named variants like
// `_template1` or `_template_sop`.
func IsTemplatePath(pagePath string) bool {
	base := path.Base(pagePath)
	if !strings.HasPrefix(base, "_template") {
		return false
	}
	// Reuse the filename parser by appending the .md suffix it expects.
	_, _, ok := parseTemplateFilename(base + ".md")
	return ok
}

// CircularIncludeError is returned when saving a page would create a cycle
// in the include graph.
type CircularIncludeError struct {
	Cycle []string // the cycle path, e.g. ["a", "b", "a"]
}

func (e *CircularIncludeError) Error() string {
	return fmt.Sprintf("circular include detected: %s", strings.Join(e.Cycle, " → "))
}

// PutResult is the result of a page write, including side-effect information.
type PutResult struct {
	Page          Page     `json:"page"`
	OrphanedMedia []string `json:"orphaned_media,omitempty"`
}

// MoveResult is returned by Move with information about the move operation.
type MoveResult struct {
	Page         Page     `json:"page"`
	OldPath      string   `json:"old_path"`
	NewPath      string   `json:"new_path"`
	UpdatedPages []string `json:"updated_pages"`
	MovedMedia   []string `json:"moved_media,omitempty"`
}

// MovePreview describes what a move operation would do, without applying changes.
type MovePreview struct {
	OldPath       string   `json:"old_path"`
	NewPath       string   `json:"new_path"`
	AffectedPages []string `json:"affected_pages"`
	MediaToMove   []string `json:"media_to_move,omitempty"`
}

// DeleteResult is returned by Delete with side-effect information.
type DeleteResult struct {
	OrphanedMedia []string `json:"orphaned_media,omitempty"`
	IncludedBy    []string `json:"included_by,omitempty"`
}

type PageMetadata struct {
	ID        string           `json:"id"`
	CreatedAt time.Time        `json:"created_at"`
	UpdatedAt time.Time        `json:"updated_at"`
	Version   int64            `json:"version"`
	Author    string           `json:"author,omitempty"`
	CreatedBy string           `json:"created_by,omitempty"`
	MediaRefs map[string]int64 `json:"media_refs,omitempty"`
}

type Page struct {
	Path             string       `json:"path"`
	Markdown         string       `json:"markdown"`
	Meta             PageMetadata `json:"meta"`
	IsNamespaceIndex bool         `json:"-"` // not serialized directly; API handler includes it
}

// DatabaseSyncer is an optional hook for syncing page content to the database.
type DatabaseSyncer interface {
	SyncPageRows(pagePath, markdown string)
	RemovePageRows(pagePath string)
}

// PageRenamer is an optional capability a DatabaseSyncer may also implement.
// When present, Move() calls RenamePageRows in place of RemovePageRows so
// row ids stay stable through a rename. Currently implemented by the
// database sync; the todo sync does not need it (todo rows are naturally
// re-derived from content).
type PageRenamer interface {
	RenamePageRows(oldPath, newPath string)
}

// ReviewflowSyncer is an optional hook for syncing reviewflow state on page
// save and delete. OnPageDelete runs on every page removal so stale open
// review tasks and the reviewflow state file don't survive the page itself.
type ReviewflowSyncer interface {
	SyncFromMarkdown(pagePath string, pageVersion int64, markdown string) error
	OnPageDelete(pagePath string) error
}

// LifecycleSyncer is an optional hook for extracting {lifecycle} directives
// from a page's markdown and updating the lifecycle rules index. Called on
// every page save; the rules index drives the periodic lifecycle scanner
// that fans out per-target-page todos. Symmetric RemovePageRules is
// called on page delete so the rules disappear from the index too.
type LifecycleSyncer interface {
	SyncFromMarkdown(sourcePage, markdown string) error
	RemovePageRules(sourcePage string) error
}

// CommentRenamer is an optional hook for moving comment sidecar files during page move.
type CommentRenamer interface {
	Rename(oldPath, newPath string) error
}

// PageWriteHook is a post-save side-effect fired by Put / PutWithSummary
// after a page is written. Receives the canonical page path AND the
// author of the save, so downstream consumers (today: the todo
// service's AutoCompleteWikiAction / AutoCompleteCreateAction /
// ReopenReadTasks fan-out) can act with full context.
//
// The hook runs AFTER every successful write regardless of transport
// — direct HTTP save, MCP write_page, MCP edit_page, MCP
// create_page_from_template, database row inserts and updates that
// touch a bound page. Previously these auto-completes were wired
// per-handler and only the browser-save path fired them; moving the
// hook into the storage layer closes the gap so adding a new write
// surface picks it up automatically.
//
// The hook is called synchronously; implementations wanting fire-and-
// forget semantics (e.g. the todo fan-out) start their own goroutine.
type PageWriteHook func(pagePath, author string)

type FileStore struct {
	contentRoot       string
	metaRoot          string
	dataDir           string
	RefIndex          *RefIndex
	IncludeIndex      *IncludeIndex
	LinkIndex         *LinkIndex
	TagIndex          *TagIndex
	SearchIndex       *SearchIndex
	Attic             *Attic
	Changelog         *Changelog
	Drafts            *DraftStore
	MediaVersionStore *MediaVersionStore
	DatabaseSync      DatabaseSyncer
	TodoSync          DatabaseSyncer
	ReviewflowSync    ReviewflowSyncer
	LifecycleSync     LifecycleSyncer
	CommentStore      CommentRenamer
	// OnPageSaved runs after every successful page write. See
	// PageWriteHook for the contract.
	OnPageSaved PageWriteHook

	// Per-page write mutex. Serializes concurrent Put/Move on the same path
	// so we can't observe a state where content is written but meta.Version
	// isn't bumped (or vice-versa). Keyed by normalized page path.
	pageLocks sync.Map // pagePath (string) → *sync.Mutex
}

// lockPage acquires the write lock for a page and returns the unlock function.
// Use with defer.
func (s *FileStore) lockPage(pagePath string) func() {
	v, _ := s.pageLocks.LoadOrStore(pagePath, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func NewFileStore(contentRoot string) (*FileStore, error) {
	content := filepath.Clean(contentRoot)
	dataDir := filepath.Dir(content)
	meta := filepath.Join(dataDir, "meta")
	if err := os.MkdirAll(content, 0o755); err != nil {
		return nil, fmt.Errorf("create content root: %w", err)
	}
	if err := os.MkdirAll(meta, 0o755); err != nil {
		return nil, fmt.Errorf("create meta root: %w", err)
	}
	fs := &FileStore{
		contentRoot:  content,
		metaRoot:     meta,
		dataDir:      dataDir,
		RefIndex:     NewRefIndex(meta),
		IncludeIndex: NewIncludeIndex(meta),
		LinkIndex:    NewLinkIndex(meta),
		Attic:        NewAttic(dataDir),
		Changelog:    NewChangelog(dataDir),
		Drafts:       NewDraftStore(dataDir, meta),
	}
	// The draft store needs a disk-backed resolver to collapse the two
	// URL forms of a namespace index onto a single lock file. Wire the
	// FileStore (which can inspect the content tree) as that resolver —
	// otherwise /foo and /foo/ would key under different lock files and
	// one caller could clobber another's in-flight edit.
	fs.Drafts.SetLockKeyResolver(fs)
	return fs, nil
}

// LockKey implements storage.LockKeyResolver — folds any surface form
// of a page path into the single storage-tree path the draft lock
// files use. A leaf page foo.md keys under "foo"; a namespace index
// foo/index.md keys under "foo/index". URL forms "/foo", "/foo/", or
// a mix of leading slashes all resolve the same way.
//
// Mirrors the content-tree layout: lock file at
// metaRoot/<LockKey>.lock.json lives next to the content file it
// locks.
func (s *FileStore) LockKey(pagePath string) string {
	normalized, err := normalizePagePath(pagePath)
	if err != nil {
		return ""
	}
	trimmed := strings.TrimPrefix(normalized, "/")
	// Prefer the resolved storage form when the page actually exists:
	// it unambiguously says whether this is a leaf or an index, with no
	// filename ambiguity.
	if _, isIndex, resolveErr := s.resolveExistingContentPath(normalized); resolveErr == nil {
		if isIndex {
			return trimmed + "/index"
		}
		return trimmed
	}
	// Page doesn't exist yet (new-page edit). Fall back to the input
	// form's intent: a trailing slash means the caller is creating a
	// namespace index. normalizePagePath strips it, so look at the
	// raw input.
	if strings.HasSuffix(strings.TrimSpace(pagePath), "/") {
		return trimmed + "/index"
	}
	return trimmed
}

func (s *FileStore) Get(pagePath string) (Page, error) {
	normalized, err := normalizePagePath(pagePath)
	if err != nil {
		return Page{}, err
	}

	contentPath, isIndex, err := s.resolveExistingContentPath(normalized)
	if errors.Is(err, os.ErrNotExist) {
		return Page{}, ErrPageNotFound
	}
	if err != nil {
		return Page{}, err
	}

	// If the resolved content path is an index.md, it is a namespace index
	// regardless of how the path was resolved (e.g. "test/index" resolves
	// via contentPagePath but is still a namespace index file).
	if strings.HasSuffix(contentPath, string(filepath.Separator)+"index.md") {
		isIndex = true
	}

	// Normalize path: strip trailing /index so the returned path is canonical.
	if isIndex && strings.HasSuffix(normalized, "/index") {
		normalized = CanonicalPath(normalized)
	}

	content, err := os.ReadFile(contentPath)
	if err != nil {
		return Page{}, fmt.Errorf("read page: %w", err)
	}

	metaPath, err := s.metadataPathForContent(contentPath)
	if err != nil {
		return Page{}, err
	}
	meta, err := s.readOrInitMeta(normalized, contentPath, metaPath)
	if err != nil {
		return Page{}, err
	}

	return Page{
		Path:             normalized,
		Markdown:         string(content),
		Meta:             meta,
		IsNamespaceIndex: isIndex,
	}, nil
}

// PageExists returns true if a page exists at the given path (either as a leaf page or namespace index).
func (s *FileStore) PageExists(pagePath string) bool {
	normalized, err := normalizePagePath(pagePath)
	if err != nil {
		return false
	}
	_, _, err = s.resolveExistingContentPath(normalized)
	return err == nil
}

// EnsureNamespaceDir creates the content directory for a namespace so that
// subsequent writes create index.md instead of path.md.
func (s *FileStore) EnsureNamespaceDir(pagePath string) error {
	normalized, err := normalizePagePath(pagePath)
	if err != nil {
		return err
	}
	dirPath := filepath.Join(s.contentRoot, filepath.FromSlash(strings.TrimPrefix(normalized, "/")))
	return os.MkdirAll(dirPath, 0o755)
}

// IsNamespaceIndex returns true if the given page path resolves to a namespace index
// (i.e. the file on disk is content/{path}/index.md rather than content/{path}.md).
func (s *FileStore) IsNamespaceIndex(pagePath string) bool {
	normalized, err := normalizePagePath(pagePath)
	if err != nil {
		return false
	}
	_, isIndex, err := s.resolveExistingContentPath(normalized)
	if err != nil {
		return false
	}
	return isIndex
}

// CheckNamespaceConflict checks whether creating or writing a page at the given
// path would violate namespace constraints, without performing any write.
// Returns ErrNamespaceConflict if the path is forbidden, nil otherwise.
func (s *FileStore) CheckNamespaceConflict(pagePath string) error {
	normalized, err := normalizePagePath(pagePath)
	if err != nil {
		return err
	}

	contentPath, _, err := s.resolveWritableContentPath(normalized)
	if err != nil {
		return err
	}

	return s.checkNamespaceConstraints(contentPath)
}

// checkNamespaceConstraints performs both forward and reverse namespace checks
// on a resolved content path.
func (s *FileStore) checkNamespaceConstraints(contentPath string) error {
	// Forward: if the resolved content path is a non-index page file (e.g. ns.md),
	// check that a directory ns/ does not already exist.
	if !strings.HasSuffix(contentPath, string(filepath.Separator)+"index.md") {
		dirPath := strings.TrimSuffix(contentPath, ".md")
		if info, statErr := os.Stat(dirPath); statErr == nil && info.IsDir() {
			rel, _ := filepath.Rel(s.contentRoot, contentPath)
			conflictPage := CanonicalPath(strings.TrimSuffix(filepath.ToSlash(rel), ".md"))
			return &NamespaceConflictError{ConflictingPage: conflictPage}
		}
	}

	// Reverse: creating ns/child.md is forbidden if ns.md exists.
	// Walk up from the content file's parent directory toward contentRoot, checking
	// that no .md page file conflicts with any directory that must exist.
	dir := filepath.Dir(contentPath)
	for dir != s.contentRoot && len(dir) > len(s.contentRoot) {
		conflictFile := dir + ".md"
		if info, statErr := os.Stat(conflictFile); statErr == nil && !info.IsDir() {
			rel, _ := filepath.Rel(s.contentRoot, conflictFile)
			conflictPage := CanonicalPath(strings.TrimSuffix(filepath.ToSlash(rel), ".md"))
			return &NamespaceConflictError{ConflictingPage: conflictPage}
		}
		dir = filepath.Dir(dir)
	}

	return nil
}

func (s *FileStore) Put(pagePath, markdownContent, author string) (PutResult, error) {
	return s.putWithSummary(pagePath, markdownContent, author, "")
}

// PutWithSummary is Put with an explicit changelog summary. Row-driven writes
// pass a per-field diff here so history entries are readable.
func (s *FileStore) PutWithSummary(pagePath, markdownContent, author, summary string) (PutResult, error) {
	return s.putWithSummary(pagePath, markdownContent, author, summary)
}

func (s *FileStore) putWithSummary(pagePath, markdownContent, author, summary string) (PutResult, error) {
	normalized, err := normalizePagePath(pagePath)
	if err != nil {
		return PutResult{}, err
	}

	unlock := s.lockPage(normalized)
	defer unlock()

	contentPath, isIndex, err := s.resolveWritableContentPath(normalized)
	if err != nil {
		return PutResult{}, err
	}

	if err := s.checkNamespaceConstraints(contentPath); err != nil {
		return PutResult{}, err
	}

	// For namespace index pages, relative paths resolve against the namespace
	// directory (e.g. "./foo" in /test/index.md resolves to /test/foo).
	// We use a separate resolvePath for extraction functions.
	resolvePath := normalized
	if isIndex {
		resolvePath = normalized + "/index"
	}

	// --- Include cycle detection (before writing) ---
	newIncludes := markdown.ExtractIncludes(markdownContent, resolvePath)
	if cycle, hasCycle := s.IncludeIndex.DetectCycle(normalized, newIncludes); hasCycle {
		return PutResult{}, &CircularIncludeError{Cycle: cycle}
	}

	// --- Extract media refs ---
	newMediaRefs := markdown.ExtractMediaRefs(markdownContent, resolvePath)
	oldMediaRefs := s.RefIndex.PageToMediaSnapshot(normalized)

	// --- Write page and metadata ---
	if err := os.MkdirAll(filepath.Dir(contentPath), 0o755); err != nil {
		return PutResult{}, fmt.Errorf("create page directory: %w", err)
	}

	metaPath, err := s.metadataPathForContent(contentPath)
	if err != nil {
		return PutResult{}, err
	}
	if err := os.MkdirAll(filepath.Dir(metaPath), 0o755); err != nil {
		return PutResult{}, fmt.Errorf("create metadata directory: %w", err)
	}

	// Read current content for MD5 dedup and archiving.
	oldContent, _ := os.ReadFile(contentPath)

	// If content is identical to current published version, skip creating a new version.
	// Media version changes are reflected in the URL (?v=N), so MD5 dedup is sufficient.
	if len(oldContent) > 0 && md5sum(oldContent) == md5sum([]byte(markdownContent)) {
		meta, metaErr := s.loadMeta(metaPath)
		if metaErr == nil {
			return PutResult{
				Page: Page{Path: normalized, Markdown: markdownContent, Meta: meta},
			}, nil
		}
	}

	now := time.Now().UTC()
	meta, err := s.loadMeta(metaPath)
	switch {
	case err == nil:
		// Archive the current published content before overwriting.
		// Use the media_refs frozen in the old metadata (not the version store),
		// so the archive reflects media as they were when this version was published.
		if len(oldContent) > 0 && s.Attic != nil {
			if err := s.Attic.Archive(normalized, meta.Version, oldContent, meta.Author, "", meta.MediaRefs); err != nil {
				return PutResult{}, fmt.Errorf("archive prior version: %w", err)
			}
		}
		meta.UpdatedAt = now
		meta.Version++
		meta.Author = author
	case errors.Is(err, os.ErrNotExist):
		meta = PageMetadata{
			ID:        makePageID(normalized),
			CreatedAt: now,
			UpdatedAt: now,
			Version:   1,
			Author:    author,
			CreatedBy: author,
		}
	default:
		return PutResult{}, fmt.Errorf("load metadata: %w", err)
	}

	// Clear MediaRefs — version info is now tracked in the markdown URL (?v=N).
	meta.MediaRefs = nil

	if err := writeFileAtomic(contentPath, []byte(markdownContent)); err != nil {
		return PutResult{}, fmt.Errorf("write page: %w", err)
	}

	metaBytes, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return PutResult{}, fmt.Errorf("encode metadata: %w", err)
	}
	metaBytes = append(metaBytes, '\n')
	if err := writeFileAtomic(metaPath, metaBytes); err != nil {
		return PutResult{}, fmt.Errorf("write metadata: %w", err)
	}

	// Archive the new version (media versions are in the markdown URLs now).
	if s.Attic != nil {
		if err := s.Attic.Archive(normalized, meta.Version, []byte(markdownContent), author, summary, nil); err != nil {
			return PutResult{}, fmt.Errorf("archive new version: %w", err)
		}
	}

	// Append to global changelog.
	if s.Changelog != nil {
		s.Changelog.Append(normalized, meta.Version, author, summary, "edit")
	}

	// Canonicalize path for namespace indices before updating indexes.
	if isIndex {
		normalized = CanonicalPath(strings.TrimSuffix(normalized, "/") + "/index")
	}

	// Templates are excluded from indexes and syncs (but not changelog or search).
	isTemplate := IsTemplatePath(normalized)

	// --- Update indexes ---
	if !isTemplate {
		s.RefIndex.UpdatePage(normalized, newMediaRefs)
		s.IncludeIndex.UpdatePage(normalized, newIncludes)

		if s.LinkIndex != nil {
			newLinks := markdown.ExtractPageLinks(markdownContent, resolvePath)
			s.LinkIndex.UpdatePage(normalized, newLinks)
			s.LinkIndex.UpdatePageQueries(normalized, markdown.ExtractDatabaseQueryTables(markdownContent))
		}

		if s.TagIndex != nil {
			tags := markdown.ExtractTags(markdownContent)
			title := markdown.ExtractTitle(markdownContent)
			s.TagIndex.UpdatePage(normalized, tags, title)
		}

		if s.DatabaseSync != nil {
			s.DatabaseSync.SyncPageRows(normalized, markdownContent)
		}

		if s.TodoSync != nil {
			s.TodoSync.SyncPageRows(normalized, markdownContent)
		}

		if s.ReviewflowSync != nil {
			_ = s.ReviewflowSync.SyncFromMarkdown(normalized, meta.Version, markdownContent)
		}

		if s.LifecycleSync != nil {
			_ = s.LifecycleSync.SyncFromMarkdown(normalized, markdownContent)
		}
	}

	// Always index templates for search so they can be found.
	if s.SearchIndex != nil {
		title := markdown.ExtractTitle(markdownContent)
		plaintext := markdown.StripMarkdown(markdownContent)
		_ = s.SearchIndex.IndexPage(normalized, title, plaintext)
	}

	if !isTemplate {
		_ = s.RefIndex.Save()
		_ = s.IncludeIndex.Save()
		if s.LinkIndex != nil {
			_ = s.LinkIndex.Save()
		}
		if s.TagIndex != nil {
			_ = s.TagIndex.Save()
		}
	}

	// --- Compute newly orphaned media ---
	orphaned := s.RefIndex.FindNewlyOrphaned(oldMediaRefs, newMediaRefs)

	// Post-save hook: fired AFTER every write regardless of caller.
	// The hook implementation is responsible for making itself async
	// (the todo fan-out does `go` internally); storage keeps the call
	// synchronous so a test that writes a page can observe the hook
	// in the same goroutine.
	if s.OnPageSaved != nil {
		s.OnPageSaved(normalized, author)
	}

	return PutResult{
		Page: Page{
			Path:     normalized,
			Markdown: markdownContent,
			Meta:     meta,
		},
		OrphanedMedia: orphaned,
	}, nil
}

// Delete removes a page, archiving its content first. It returns information
// about orphaned media and pages that included the deleted page.
func (s *FileStore) Delete(pagePath, author string) (DeleteResult, error) {
	normalized, err := normalizePagePath(pagePath)
	if err != nil {
		return DeleteResult{}, err
	}

	contentPath, _, err := s.resolveExistingContentPath(normalized)
	if errors.Is(err, os.ErrNotExist) {
		return DeleteResult{}, ErrPageNotFound
	}
	if err != nil {
		return DeleteResult{}, err
	}

	// Check for draft lock — cannot delete a page being edited.
	if s.Drafts != nil {
		lock := s.Drafts.GetLock(normalized)
		if lock.Owner != "" {
			return DeleteResult{}, fmt.Errorf("%w: locked by %s", ErrPageHasLock, lock.Owner)
		}
	}

	// Read current content for archiving.
	content, err := os.ReadFile(contentPath)
	if err != nil {
		return DeleteResult{}, fmt.Errorf("read page for archiving: %w", err)
	}

	// Load metadata for version number.
	metaPath, err := s.metadataPathForContent(contentPath)
	if err != nil {
		return DeleteResult{}, err
	}
	meta, err := s.readOrInitMeta(normalized, contentPath, metaPath)
	if err != nil {
		return DeleteResult{}, fmt.Errorf("load metadata: %w", err)
	}

	// Archive current version with summary "deleted", preserving frozen media refs.
	// Archive first so the "deleted" marker lands as the final live entry
	// before Tombstone moves everything into the per-deletion subdir.
	if s.Attic != nil {
		if archiveErr := s.Attic.Archive(normalized, meta.Version, content, author, "deleted", meta.MediaRefs); archiveErr != nil {
			return DeleteResult{}, fmt.Errorf("archive before delete: %w", archiveErr)
		}
	}

	// Append to global changelog with type "delete".
	if s.Changelog != nil {
		s.Changelog.Append(normalized, meta.Version, author, "deleted", "delete")
	}

	// Tombstone the attic + meta sidecars BEFORE wiping live content.
	// A page recreated at this path later must start from a clean
	// namespace — its own version 1, empty attic, no stale reviewflow
	// state. The tombstone directory preserves everything the old page
	// carried so a future UI can surface "a previous page lived here".
	//
	// Must run before os.Remove(contentPath) so a crash between the
	// archive and the tombstone leaves the content in place — the next
	// reconcile sweep will finish the job rather than hand the user a
	// deleted content file with no attic to show for it.
	//
	// Must run before ReviewflowSync.OnPageDelete so the reviewflow
	// state file is tombstoned instead of deleted (OnPageDelete's
	// internal state-file delete then no-ops; the task cancellation it
	// also performs still runs).
	var tombDir string
	if s.Attic != nil {
		td, tombErr := s.Attic.Tombstone(normalized, time.Now())
		if tombErr != nil {
			return DeleteResult{}, fmt.Errorf("tombstone attic: %w", tombErr)
		}
		tombDir = td
	}
	if tombDir != "" {
		if err := tombstoneMetaSidecars(metaPath, tombDir); err != nil {
			return DeleteResult{}, fmt.Errorf("tombstone meta: %w", err)
		}
	}

	// Remove the .md file.
	if err := os.Remove(contentPath); err != nil {
		return DeleteResult{}, fmt.Errorf("remove page file: %w", err)
	}

	// Meta file already moved into the tombstone (if tombstoning
	// happened). On the off-chance Attic is nil (tests only), fall back
	// to the old behaviour: just remove it.
	if tombDir == "" {
		os.Remove(metaPath)
	}

	// Clean up empty parent directories for content and meta paths.
	cleanEmptyParents(filepath.Dir(contentPath), s.contentRoot)
	cleanEmptyParents(filepath.Dir(metaPath), s.metaRoot)

	// Sync database: remove rows for deleted page.
	if s.DatabaseSync != nil {
		s.DatabaseSync.RemovePageRows(normalized)
	}

	// Sync todo: cancel tasks for deleted page.
	if s.TodoSync != nil {
		s.TodoSync.RemovePageRows(normalized)
	}

	// Sync lifecycle: drop any rules that were declared on the deleted
	// page. Orphan todos the rules spawned get reconciled away on the
	// next scan pass.
	if s.LifecycleSync != nil {
		_ = s.LifecycleSync.RemovePageRules(normalized)
	}

	// Sync reviewflow: cancel pending review tasks and remove the state
	// file. Without this the signature todos survive the page itself
	// and show up forever in `list_todos` with a dead source_page.
	if s.ReviewflowSync != nil {
		_ = s.ReviewflowSync.OnPageDelete(normalized)
	}

	// Snapshot old media refs before removing from index.
	oldMediaRefs := s.RefIndex.PageToMediaSnapshot(normalized)

	// Update RefIndex: remove all refs from this page.
	s.RefIndex.RemovePage(normalized)

	// Update IncludeIndex: find pages that include this page (for warning), then remove.
	includedBy := s.IncludeIndex.GetIncluders(normalized)
	s.IncludeIndex.RemovePage(normalized)

	// Update LinkIndex: remove this page.
	if s.LinkIndex != nil {
		s.LinkIndex.RemovePage(normalized)
	}

	// Update TagIndex: remove this page.
	if s.TagIndex != nil {
		s.TagIndex.RemovePage(normalized)
	}

	// Update SearchIndex: remove this page.
	if s.SearchIndex != nil {
		_ = s.SearchIndex.DeletePage(normalized)
	}

	// Persist indexes (best effort).
	_ = s.RefIndex.Save()
	_ = s.IncludeIndex.Save()
	if s.LinkIndex != nil {
		_ = s.LinkIndex.Save()
	}
	if s.TagIndex != nil {
		_ = s.TagIndex.Save()
	}

	// Compute newly orphaned media: all old refs that now have zero references.
	orphaned := s.RefIndex.FindNewlyOrphaned(oldMediaRefs, nil)

	return DeleteResult{
		OrphanedMedia: orphaned,
		IncludedBy:    includedBy,
	}, nil
}

// ConvertToNamespaceIndex converts a regular page to a namespace index.
// Moves content/{path}.md → content/{path}/index.md (and meta).
// The page path is unchanged so no link rewriting is needed.
func (s *FileStore) ConvertToNamespaceIndex(pagePath, author string) (MoveResult, error) {
	normalized, err := normalizePagePath(pagePath)
	if err != nil {
		return MoveResult{}, err
	}

	contentPath, isIndex, err := s.resolveExistingContentPath(normalized)
	if errors.Is(err, os.ErrNotExist) {
		return MoveResult{}, ErrPageNotFound
	}
	if err != nil {
		return MoveResult{}, err
	}
	if isIndex {
		return MoveResult{}, fmt.Errorf("page is already a namespace index")
	}

	// Compute new paths.
	newContentPath := filepath.Join(strings.TrimSuffix(contentPath, ".md"), "index.md")
	metaPath, err := s.metadataPathForContent(contentPath)
	if err != nil {
		return MoveResult{}, err
	}

	if err := os.MkdirAll(filepath.Dir(newContentPath), 0o755); err != nil {
		return MoveResult{}, fmt.Errorf("create namespace dir: %w", err)
	}

	// Move content file.
	if err := os.Rename(contentPath, newContentPath); err != nil {
		return MoveResult{}, fmt.Errorf("move content to namespace index: %w", err)
	}

	// Co-move media files that are exclusively referenced by this page.
	// Read from the new location since content file was already moved.
	pageContent, _ := os.ReadFile(newContentPath)
	if len(pageContent) > 0 {
		resolvePath := normalized
		mediaRefs := markdown.ExtractMediaRefs(string(pageContent), resolvePath)
		nsDir := filepath.Dir(newContentPath) // the new namespace dir
		for _, mediaPath := range mediaRefs {
			// Only move media exclusively referenced by this page.
			refPages := s.RefIndex.GetReferencingPages(mediaPath)
			if len(refPages) > 1 || (len(refPages) == 1 && refPages[0] != normalized) {
				continue
			}
			oldAbsPath := filepath.Join(s.contentRoot, filepath.FromSlash(strings.TrimPrefix(mediaPath, "/")))
			if !fileExists(oldAbsPath) {
				continue
			}
			// Move into the new namespace directory.
			newAbsPath := filepath.Join(nsDir, filepath.Base(oldAbsPath))
			_ = os.Rename(oldAbsPath, newAbsPath)
		}
	}

	// Move ALL metadata files (page.json, page.reviewflow.json, page.comments.json, etc.)
	// from meta/{path}.X.json to meta/{path}/index.X.json
	oldMetaBase := strings.TrimSuffix(metaPath, ".json")
	newMetaBase := filepath.Join(strings.TrimSuffix(metaPath, ".json"), "index")
	metaDir := filepath.Dir(metaPath)
	metaPrefix := filepath.Base(oldMetaBase)
	entries, _ := os.ReadDir(metaDir)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasPrefix(name, metaPrefix+".") {
			suffix := strings.TrimPrefix(name, metaPrefix)
			oldFile := filepath.Join(metaDir, name)
			newFile := newMetaBase + suffix
			if err := os.MkdirAll(filepath.Dir(newFile), 0o755); err == nil {
				_ = os.Rename(oldFile, newFile)
			}
		}
	}

	// Log to changelog.
	if s.Changelog != nil {
		s.Changelog.Append(normalized, 0, author, "converted to namespace index", "move")
	}

	page, _ := s.Get(normalized)
	return MoveResult{
		Page:    page,
		OldPath: normalized,
		NewPath: normalized,
	}, nil
}

// ConvertToRegularPage converts a namespace index to a regular page.
// Only allowed if the namespace directory contains only index.md.
func (s *FileStore) ConvertToRegularPage(pagePath, author string) (MoveResult, error) {
	normalized, err := normalizePagePath(pagePath)
	if err != nil {
		return MoveResult{}, err
	}

	contentPath, isIndex, err := s.resolveExistingContentPath(normalized)
	if errors.Is(err, os.ErrNotExist) {
		return MoveResult{}, ErrPageNotFound
	}
	if err != nil {
		return MoveResult{}, err
	}
	if !isIndex {
		return MoveResult{}, fmt.Errorf("page is not a namespace index")
	}

	// Check that the namespace dir contains no sub-pages or sub-directories.
	// The index page's own files (index.md, media) are allowed.
	nsDir := filepath.Dir(contentPath)
	entries, err := os.ReadDir(nsDir)
	if err != nil {
		return MoveResult{}, fmt.Errorf("read namespace dir: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() {
			// Sub-directory = sub-namespace, not empty.
			return MoveResult{}, ErrNamespaceNotEmpty
		}
		name := e.Name()
		// Allow index.md and any non-.md files (media/attachments).
		if name != "index.md" && strings.HasSuffix(name, ".md") {
			// Another .md page in this namespace.
			return MoveResult{}, ErrNamespaceNotEmpty
		}
	}

	metaPath, err := s.metadataPathForContent(contentPath)
	if err != nil {
		return MoveResult{}, err
	}
	metaNsDir := filepath.Dir(metaPath)
	// Check meta dir: only reject if there are sub-directories (sub-namespaces).
	if metaEntries, readErr := os.ReadDir(metaNsDir); readErr == nil {
		for _, e := range metaEntries {
			if e.IsDir() {
				return MoveResult{}, ErrNamespaceNotEmpty
			}
		}
	}

	// Compute new paths: content/{path}/index.md → content/{path}.md
	newContentPath := nsDir + ".md"

	// Move content file.
	if err := os.Rename(contentPath, newContentPath); err != nil {
		return MoveResult{}, fmt.Errorf("move content from namespace index: %w", err)
	}

	// Move any co-located media files from the namespace dir to the parent dir.
	for _, e := range entries {
		if e.IsDir() || e.Name() == "index.md" {
			continue
		}
		oldMediaFile := filepath.Join(nsDir, e.Name())
		newMediaFile := filepath.Join(filepath.Dir(nsDir), e.Name())
		_ = os.Rename(oldMediaFile, newMediaFile)
	}

	// Remove the now-empty namespace dir.
	_ = os.Remove(nsDir)

	// Move ALL metadata files (index.json, index.reviewflow.json, etc.)
	// from meta/{path}/index.X.json to meta/{path}.X.json
	if metaEntries, readErr := os.ReadDir(metaNsDir); readErr == nil {
		for _, e := range metaEntries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			if strings.HasPrefix(name, "index.") {
				suffix := strings.TrimPrefix(name, "index")
				oldFile := filepath.Join(metaNsDir, name)
				newFile := metaNsDir + suffix
				_ = os.Rename(oldFile, newFile)
			}
		}
		_ = os.Remove(metaNsDir)
	}

	if s.Changelog != nil {
		s.Changelog.Append(normalized, 0, author, "converted to regular page", "move")
	}

	page, _ := s.Get(normalized)
	return MoveResult{
		Page:    page,
		OldPath: normalized,
		NewPath: normalized,
	}, nil
}

// PreviewMove computes what a move operation would do without applying changes.
func (s *FileStore) PreviewMove(oldPath, newPath string, moveMedia bool) (MovePreview, error) {
	oldNorm, err := normalizePagePath(oldPath)
	if err != nil {
		return MovePreview{}, err
	}
	newNorm, err := normalizePagePath(newPath)
	if err != nil {
		return MovePreview{}, err
	}
	if oldNorm == newNorm {
		return MovePreview{}, fmt.Errorf("source and destination are the same")
	}

	srcPage, err := s.Get(oldNorm)
	if err != nil {
		return MovePreview{}, err
	}

	// Check destination doesn't exist.
	if _, destErr := s.Get(newNorm); destErr == nil {
		return MovePreview{}, ErrDestinationExists
	}
	if err := s.CheckNamespaceConflict(newNorm); err != nil {
		return MovePreview{}, err
	}

	oldResolvePath := oldNorm
	if srcPage.IsNamespaceIndex {
		oldResolvePath = oldNorm + "/index"
	}

	// Gather affected pages.
	var affectedPages []string
	seen := make(map[string]bool)
	if s.LinkIndex != nil {
		for _, p := range s.LinkIndex.GetBacklinks(oldNorm) {
			if p != oldNorm && !seen[p] {
				seen[p] = true
				affectedPages = append(affectedPages, p)
			}
		}
	}
	for _, p := range s.IncludeIndex.GetIncluders(oldNorm) {
		if p != oldNorm && !seen[p] {
			seen[p] = true
			affectedPages = append(affectedPages, p)
		}
	}

	// Gather media that would be moved.
	var mediaToMove []string
	if moveMedia {
		mediaRefs := markdown.ExtractMediaRefs(srcPage.Markdown, oldResolvePath)
		for _, mediaPath := range mediaRefs {
			refPages := s.RefIndex.GetReferencingPages(mediaPath)
			if len(refPages) == 1 && refPages[0] == oldNorm {
				mediaToMove = append(mediaToMove, mediaPath)
			}
		}
	}

	return MovePreview{
		OldPath:       oldNorm,
		NewPath:       newNorm,
		AffectedPages: affectedPages,
		MediaToMove:   mediaToMove,
	}, nil
}

// Move relocates a page from oldPath to newPath, rewriting all inbound references
// in other pages. If moveMedia is true, exclusively-referenced media files are
// co-moved to the new namespace.
func (s *FileStore) Move(oldPath, newPath string, moveMedia, updateLinks bool, author string) (MoveResult, error) {
	oldNorm, err := normalizePagePath(oldPath)
	if err != nil {
		return MoveResult{}, err
	}
	newNorm, err := normalizePagePath(newPath)
	if err != nil {
		return MoveResult{}, err
	}
	if oldNorm == newNorm {
		return MoveResult{}, fmt.Errorf("source and destination are the same")
	}

	// 1. Validate source exists.
	srcPage, err := s.Get(oldNorm)
	if err != nil {
		return MoveResult{}, err
	}

	// Check draft lock on source.
	if s.Drafts != nil {
		lock := s.Drafts.GetLock(oldNorm)
		if lock.Owner != "" {
			return MoveResult{}, fmt.Errorf("%w: locked by %s", ErrPageHasLock, lock.Owner)
		}
	}

	// 2. Validate destination doesn't exist.
	if _, destErr := s.Get(newNorm); destErr == nil {
		return MoveResult{}, ErrDestinationExists
	}

	// Check namespace constraints for destination.
	if err := s.CheckNamespaceConflict(newNorm); err != nil {
		return MoveResult{}, err
	}

	// Determine resolve paths for relative ref handling.
	oldResolvePath := oldNorm
	if srcPage.IsNamespaceIndex {
		oldResolvePath = oldNorm + "/index"
	}

	// 3. Gather pages that reference the old path (backlinkers + includers).
	var backlinkers []string
	if updateLinks {
		seen := make(map[string]bool)
		if s.LinkIndex != nil {
			for _, p := range s.LinkIndex.GetBacklinks(oldNorm) {
				if p != oldNorm && !seen[p] {
					seen[p] = true
					backlinkers = append(backlinkers, p)
				}
			}
		}
		for _, p := range s.IncludeIndex.GetIncluders(oldNorm) {
			if p != oldNorm && !seen[p] {
				seen[p] = true
				backlinkers = append(backlinkers, p)
			}
		}
	}

	// 4. Handle media co-moving.
	type mediaMove struct {
		oldPath string
		newPath string
	}
	var mediaMoves []mediaMove
	var movedMediaPaths []string

	if moveMedia {
		// Find all media referenced by the source page.
		mediaRefs := markdown.ExtractMediaRefs(srcPage.Markdown, oldResolvePath)
		oldNamespace := path.Dir(oldNorm)
		newNamespace := path.Dir(newNorm)

		for _, mediaPath := range mediaRefs {
			// Only move media that is exclusively referenced by this page.
			refPages := s.RefIndex.GetReferencingPages(mediaPath)
			if len(refPages) == 1 && refPages[0] == oldNorm {
				// Compute new media path: replace old namespace prefix with new.
				mediaRel := strings.TrimPrefix(mediaPath, oldNamespace)
				newMediaPath := path.Clean(newNamespace + mediaRel)

				// Physically move the file.
				oldAbsPath := filepath.Join(s.contentRoot, filepath.FromSlash(strings.TrimPrefix(mediaPath, "/")))
				newAbsPath := filepath.Join(s.contentRoot, filepath.FromSlash(strings.TrimPrefix(newMediaPath, "/")))
				if err := os.MkdirAll(filepath.Dir(newAbsPath), 0o755); err != nil {
					return MoveResult{}, fmt.Errorf("create media dir: %w", err)
				}
				if err := os.Rename(oldAbsPath, newAbsPath); err != nil {
					// Skip this media file if it can't be moved.
					continue
				}

				// Rename version store entry.
				if s.MediaVersionStore != nil {
					_ = s.MediaVersionStore.RenamePath(mediaPath, newMediaPath)
				}

				mediaMoves = append(mediaMoves, mediaMove{oldPath: mediaPath, newPath: newMediaPath})
				movedMediaPaths = append(movedMediaPaths, newMediaPath)

				// Clean empty parent dirs of old media location.
				cleanEmptyParents(filepath.Dir(oldAbsPath), s.contentRoot)
			}
		}
	}

	// 5. Rebase the moved page's own content.
	rebasedContent := markdown.RebaseRelativeRefs(srcPage.Markdown, oldResolvePath, newNorm)
	// Rewrite media refs in the moved page for co-moved media.
	for _, mm := range mediaMoves {
		rebasedContent = markdown.RewriteMediaRef(rebasedContent, mm.oldPath, mm.newPath, newNorm)
	}

	// 6. Rewrite each backlinker/includer.
	var updatedPages []string
	for _, bp := range backlinkers {
		bPage, bErr := s.Get(bp)
		if bErr != nil {
			continue
		}
		// Use the resolve path (with /index suffix for namespace index pages)
		// so that ResolvePath correctly resolves relative references.
		bpResolvePath := bp
		if bPage.IsNamespaceIndex {
			bpResolvePath = bp + "/index"
		}
		newContent := markdown.RewritePageRef(bPage.Markdown, oldNorm, newNorm, bpResolvePath)
		for _, mm := range mediaMoves {
			newContent = markdown.RewriteMediaRef(newContent, mm.oldPath, mm.newPath, bpResolvePath)
		}
		if newContent != bPage.Markdown {
			if _, putErr := s.Put(bp, newContent, author); putErr == nil {
				updatedPages = append(updatedPages, bp)
			}
		}
	}

	// 7. Move the page files directly (preserving history).
	// Resolve the old content path.
	oldContentPath, _, err := s.resolveExistingContentPath(oldNorm)
	if err != nil {
		return MoveResult{}, fmt.Errorf("resolve old content path: %w", err)
	}
	oldMetaPath, err := s.metadataPathForContent(oldContentPath)
	if err != nil {
		return MoveResult{}, fmt.Errorf("resolve old meta path: %w", err)
	}

	// Resolve the new content path.
	newContentPath, newIsIndex, err := s.resolveWritableContentPath(newNorm)
	if err != nil {
		return MoveResult{}, fmt.Errorf("resolve new content path: %w", err)
	}
	newMetaPath, err := s.metadataPathForContent(newContentPath)
	if err != nil {
		return MoveResult{}, fmt.Errorf("resolve new meta path: %w", err)
	}

	// Load and bump metadata.
	meta, err := s.readOrInitMeta(oldNorm, oldContentPath, oldMetaPath)
	if err != nil {
		return MoveResult{}, fmt.Errorf("load metadata: %w", err)
	}

	// Archive the pre-move content at old version (so there's a record of the last state
	// before the move, under the old path's history which will be transferred).
	if s.Attic != nil {
		_ = s.Attic.Archive(oldNorm, meta.Version, []byte(srcPage.Markdown), meta.Author, "", meta.MediaRefs)
	}

	meta.Version++
	meta.UpdatedAt = time.Now().UTC()
	meta.Author = author
	meta.MediaRefs = nil

	// Create destination directories.
	if err := os.MkdirAll(filepath.Dir(newContentPath), 0o755); err != nil {
		return MoveResult{}, fmt.Errorf("create destination dir: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(newMetaPath), 0o755); err != nil {
		return MoveResult{}, fmt.Errorf("create destination meta dir: %w", err)
	}

	// Write rebased content at new path.
	if err := writeFileAtomic(newContentPath, []byte(rebasedContent)); err != nil {
		return MoveResult{}, fmt.Errorf("write page at new path: %w", err)
	}

	// Write updated metadata at new path.
	metaBytes, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return MoveResult{}, fmt.Errorf("encode metadata: %w", err)
	}
	metaBytes = append(metaBytes, '\n')
	if err := writeFileAtomic(newMetaPath, metaBytes); err != nil {
		return MoveResult{}, fmt.Errorf("write metadata at new path: %w", err)
	}

	// Remove old content file.
	_ = os.Remove(oldContentPath)
	cleanEmptyParents(filepath.Dir(oldContentPath), s.contentRoot)

	// Move ALL meta files associated with the old page (reviewflow, comments, lock, etc.).
	oldMetaBase := strings.TrimSuffix(oldMetaPath, ".json")
	newMetaBase := strings.TrimSuffix(newMetaPath, ".json")
	metaDir := filepath.Dir(oldMetaPath)
	metaPrefix := filepath.Base(oldMetaBase)
	entries, _ := os.ReadDir(metaDir)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		// Match files like: page.json, page.reviewflow.json, page.comments.json, page.lock.json
		if strings.HasPrefix(name, metaPrefix+".") {
			suffix := strings.TrimPrefix(name, metaPrefix)
			oldFile := filepath.Join(metaDir, name)
			newFile := newMetaBase + suffix
			if err := os.MkdirAll(filepath.Dir(newFile), 0o755); err == nil {
				_ = os.Rename(oldFile, newFile)
			}
		}
	}
	cleanEmptyParents(filepath.Dir(oldMetaPath), s.metaRoot)

	// 8. Move attic history from old path to new path.
	if s.Attic != nil {
		_ = s.Attic.RenamePage(oldNorm, newNorm)
		// Archive the move as a new version under the new path.
		_ = s.Attic.Archive(newNorm, meta.Version, []byte(rebasedContent), author,
			fmt.Sprintf("moved from %s", oldNorm), nil)
	}

	// 9. Update indexes: remove old, add new.
	newResolvePath := newNorm
	if newIsIndex {
		newResolvePath = newNorm + "/index"
	}

	s.RefIndex.RemovePage(oldNorm)
	newMediaRefs := markdown.ExtractMediaRefs(rebasedContent, newResolvePath)
	s.RefIndex.UpdatePage(newNorm, newMediaRefs)

	s.IncludeIndex.RemovePage(oldNorm)
	newIncludes := markdown.ExtractIncludes(rebasedContent, newResolvePath)
	s.IncludeIndex.UpdatePage(newNorm, newIncludes)

	if s.LinkIndex != nil {
		s.LinkIndex.RemovePage(oldNorm)
		newLinks := markdown.ExtractPageLinks(rebasedContent, newResolvePath)
		s.LinkIndex.UpdatePage(newNorm, newLinks)
		s.LinkIndex.UpdatePageQueries(newNorm, markdown.ExtractDatabaseQueryTables(rebasedContent))
	}

	if s.TagIndex != nil {
		s.TagIndex.RemovePage(oldNorm)
		tags := markdown.ExtractTags(rebasedContent)
		title := markdown.ExtractTitle(rebasedContent)
		s.TagIndex.UpdatePage(newNorm, tags, title)
	}

	if s.SearchIndex != nil {
		_ = s.SearchIndex.DeletePage(oldNorm)
		title := markdown.ExtractTitle(rebasedContent)
		plaintext := markdown.StripMarkdown(rebasedContent)
		_ = s.SearchIndex.IndexPage(newNorm, title, plaintext)
	}

	// Persist indexes.
	_ = s.RefIndex.Save()
	_ = s.IncludeIndex.Save()
	if s.LinkIndex != nil {
		_ = s.LinkIndex.Save()
	}
	if s.TagIndex != nil {
		_ = s.TagIndex.Save()
	}

	// Sync database/todo/reviewflow.
	if s.DatabaseSync != nil {
		// Prefer in-place rename so DB row ids stay stable (URLs like
		// /server/24 keep pointing at row 24). Fall back to remove+sync for
		// syncers that don't implement PageRenamer.
		if renamer, ok := s.DatabaseSync.(PageRenamer); ok {
			renamer.RenamePageRows(oldNorm, newNorm)
			s.DatabaseSync.SyncPageRows(newNorm, rebasedContent)
		} else {
			s.DatabaseSync.RemovePageRows(oldNorm)
			s.DatabaseSync.SyncPageRows(newNorm, rebasedContent)
		}
	}
	if s.TodoSync != nil {
		s.TodoSync.RemovePageRows(oldNorm)
		s.TodoSync.SyncPageRows(newNorm, rebasedContent)
	}
	if s.ReviewflowSync != nil {
		_ = s.ReviewflowSync.SyncFromMarkdown(newNorm, meta.Version, rebasedContent)
	}

	// Move comment sidecar file.
	if s.CommentStore != nil {
		_ = s.CommentStore.Rename(oldNorm, newNorm)
	}

	// 10. Log move to changelog.
	if s.Changelog != nil {
		s.Changelog.Append(newNorm, meta.Version, author,
			fmt.Sprintf("moved from %s", oldNorm), "move")
	}

	return MoveResult{
		Page: Page{
			Path:             newNorm,
			Markdown:         rebasedContent,
			Meta:             meta,
			IsNamespaceIndex: newIsIndex,
		},
		OldPath:      oldNorm,
		NewPath:      newNorm,
		UpdatedPages: updatedPages,
		MovedMedia:   movedMediaPaths,
	}, nil
}

// tombstoneMetaSidecars moves every meta file belonging to a page
// (`<prefix>.json` and every `<prefix>.<kind>.json`) into tombDir with
// a stable, prefix-stripped name: `.json` becomes `meta.json`, every
// `.<kind>.json` becomes `<kind>.json`. The result in the tombstone
// directory is self-contained — reading it back later doesn't require
// knowing whether the page lived at `foo.md` or `foo/index.md`.
//
// Only files are moved; a sibling directory inside metaDir (a sub-
// namespace's meta tree) is left alone. Best-effort per file: a rename
// error aborts and bubbles up so Delete() can roll back.
func tombstoneMetaSidecars(metaPath, tombDir string) error {
	metaDir := filepath.Dir(metaPath)
	oldBase := strings.TrimSuffix(metaPath, ".json")
	prefix := filepath.Base(oldBase)
	entries, err := os.ReadDir(metaDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read meta dir: %w", err)
	}
	if err := os.MkdirAll(tombDir, 0o755); err != nil {
		return fmt.Errorf("create tombstone dir: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasPrefix(name, prefix+".") {
			continue
		}
		suffix := strings.TrimPrefix(name, prefix) // ".json" or ".reviewflow.json"
		destName := strings.TrimPrefix(suffix, ".")
		if destName == "json" {
			destName = "meta.json"
		}
		src := filepath.Join(metaDir, name)
		dst := filepath.Join(tombDir, destName)
		if err := os.Rename(src, dst); err != nil {
			return fmt.Errorf("tombstone meta sidecar %s: %w", name, err)
		}
	}
	return nil
}

// cleanEmptyParents removes empty directories from dir up to (but not including) stopAt.
func cleanEmptyParents(dir, stopAt string) {
	for dir != stopAt && dir != "." && dir != "/" {
		if err := os.Remove(dir); err != nil {
			break // directory not empty or other error
		}
		dir = filepath.Dir(dir)
	}
}

// FindOrphans returns media files under contentRoot with zero page references.
func (s *FileStore) FindOrphans() ([]string, error) {
	return s.RefIndex.FindOrphans(s.contentRoot)
}

// GetBacklinks returns pages that link to the given page: pages with an
// internal hyperlink to it, plus — when the page is bound to a database
// row by {database-row table=T} — the pages whose {database-query}
// lists table T, since they link to every row page of T when rendered.
func (s *FileStore) GetBacklinks(pagePath string) []string {
	result := s.LinkIndex.GetBacklinks(pagePath)
	page, err := s.Get(pagePath)
	if err != nil {
		return result
	}
	seen := make(map[string]bool, len(result))
	for _, p := range result {
		seen[p] = true
	}
	added := false
	for _, row := range markdown.ExtractDatabaseRows(page.Markdown) {
		for _, q := range s.LinkIndex.GetQueryPages(row.TableName) {
			if q == page.Path || seen[q] {
				continue
			}
			seen[q] = true
			result = append(result, q)
			added = true
		}
	}
	if added {
		sort.Strings(result)
	}
	return result
}

// GetReferencingPages returns the list of pages that reference a given media file.
func (s *FileStore) GetReferencingPages(mediaPath string) []string {
	return s.RefIndex.GetReferencingPages(mediaPath)
}

// RebuildIndexes walks all .md pages under contentRoot, extracts media refs
// and include directives, and rebuilds both RefIndex and IncludeIndex from scratch.
// Called on server startup.
func (s *FileStore) RebuildIndexes() error {
	refIdx := NewRefIndex(s.metaRoot)
	incIdx := NewIncludeIndex(s.metaRoot)
	linkIdx := NewLinkIndex(s.metaRoot)
	// Reuse the existing TagIndex (clear and repopulate) so that API handlers
	// that hold a pointer to it see the updated data immediately.
	tagIdx := s.TagIndex
	if tagIdx == nil {
		tagIdx = NewTagIndex(s.metaRoot)
	} else {
		tagIdx.Clear()
	}

	err := filepath.Walk(s.contentRoot, func(absPath string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(absPath, ".md") {
			return nil
		}
		// Skip template files (default and named variants).
		if _, _, ok := parseTemplateFilename(filepath.Base(absPath)); ok {
			return nil
		}

		rel, relErr := filepath.Rel(s.contentRoot, absPath)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)

		// Derive the logical page path from the file path.
		// resolvePath keeps /index suffix so ResolvePath resolves relative
		// links correctly for namespace index pages.
		resolvePath := "/" + strings.TrimSuffix(rel, ".md")
		pagePath := CanonicalPath(strings.TrimSuffix(rel, ".md"))

		content, readErr := os.ReadFile(absPath)
		if readErr != nil {
			return readErr
		}

		contentStr := string(content)
		mediaRefs := markdown.ExtractMediaRefs(contentStr, resolvePath)
		refIdx.UpdatePage(pagePath, mediaRefs)

		includes := markdown.ExtractIncludes(contentStr, resolvePath)
		incIdx.UpdatePage(pagePath, includes)

		pageLinks := markdown.ExtractPageLinks(contentStr, resolvePath)
		linkIdx.UpdatePage(pagePath, pageLinks)
		linkIdx.UpdatePageQueries(pagePath, markdown.ExtractDatabaseQueryTables(contentStr))

		tags := markdown.ExtractTags(contentStr)
		title := markdown.ExtractTitle(contentStr)
		tagIdx.UpdatePage(pagePath, tags, title)

		// Sync todo and reviewflow from existing content.
		if s.TodoSync != nil {
			s.TodoSync.SyncPageRows(pagePath, contentStr)
		}
		if s.ReviewflowSync != nil {
			// Read the actual page version from metadata so we don't
			// accidentally invalidate already-validated reviewflow state.
			pageVersion := int64(0)
			if metaFile, err := s.metadataPathForContent(absPath); err == nil {
				if meta, err := s.loadMeta(metaFile); err == nil {
					pageVersion = meta.Version
				}
			}
			_ = s.ReviewflowSync.SyncFromMarkdown(pagePath, pageVersion, contentStr)
		}

		return nil
	})
	if err != nil {
		return fmt.Errorf("rebuild indexes: %w", err)
	}

	s.RefIndex = refIdx
	s.IncludeIndex = incIdx
	s.LinkIndex = linkIdx
	s.TagIndex = tagIdx

	if err := s.RefIndex.Save(); err != nil {
		return fmt.Errorf("save ref index: %w", err)
	}
	if err := s.IncludeIndex.Save(); err != nil {
		return fmt.Errorf("save include index: %w", err)
	}
	if err := s.LinkIndex.Save(); err != nil {
		return fmt.Errorf("save link index: %w", err)
	}
	if err := s.TagIndex.Save(); err != nil {
		return fmt.Errorf("save tag index: %w", err)
	}

	// Rebuild search index if available.
	if s.SearchIndex != nil {
		if err := s.SearchIndex.RebuildFromDir(s.contentRoot); err != nil {
			return fmt.Errorf("rebuild search index: %w", err)
		}
	}

	return nil
}

// TemplateMatch is a single template applicable to a target page path.
type TemplateMatch struct {
	// Slug is the filename slug that differentiates this template from the
	// default. Empty for `_template.md`, or the suffix for `_template<suffix>.md`
	// / `_template_<slug>.md`.
	Slug string `json:"slug"`
	// Label is the display label the picker shows. Defaults to the slug (or
	// "Default" for the bare template).
	Label string `json:"label"`
	// Markdown is the raw template content.
	Markdown string `json:"markdown"`
	// TemplatePath is the logical path of the template file (no extension),
	// useful for display or edit links — e.g. "/docs/_template_sop".
	TemplatePath string `json:"template_path"`
	// Constrained is true when the template name encoded a filename-prefix
	// constraint (i.e. `_template_<slug>.md`) that narrowed the match set.
	Constrained bool `json:"constrained"`
}

// parseTemplateFilename extracts the slug and the filename-prefix constraint
// from a `_template*.md` filename. Returns ok=false for any other filename.
//
// Rules (underscore = constraint):
//
//	_template.md           → slug="", constrained=false    (default)
//	_template1.md          → slug="1", constrained=false   (unconstrained variant)
//	_templatefoo.md        → slug="foo", constrained=false
//	_template_sop.md       → slug="sop", constrained=true
//	_template_foo_bar.md   → slug="foo_bar", constrained=true
func parseTemplateFilename(name string) (slug string, constrained bool, ok bool) {
	const prefix = "_template"
	if !strings.HasSuffix(name, ".md") {
		return "", false, false
	}
	stem := strings.TrimSuffix(name, ".md")
	if !strings.HasPrefix(stem, prefix) {
		return "", false, false
	}
	rest := stem[len(prefix):]
	if rest == "" {
		return "", false, true
	}
	if rest[0] == '_' {
		slug = rest[1:]
		if slug == "" {
			// "_template_.md" is malformed — treat as no template.
			return "", false, false
		}
		return slug, true, true
	}
	return rest, false, true
}

// ResolveTemplate walks up from the target page's namespace looking for the
// default `_template.md` and returns its content and logical path. Kept for
// backward compatibility; new callers should use ResolveTemplates.
func (s *FileStore) ResolveTemplate(pagePath string) (string, string, error) {
	matches, err := s.ResolveTemplates(pagePath)
	if err != nil {
		return "", "", err
	}
	for _, m := range matches {
		if m.Slug == "" {
			return m.Markdown, m.TemplatePath, nil
		}
	}
	if len(matches) == 0 {
		return "", "", ErrNoTemplate
	}
	// No bare default — fall back to the first match so the legacy endpoint
	// still returns something useful.
	return matches[0].Markdown, matches[0].TemplatePath, nil
}

// ResolveTemplates returns every `_template*.md` applicable to the given
// target page path. The list is ordered with the default (if any) first,
// followed by named templates sorted by slug. When the same slug appears at
// multiple levels of the namespace tree, the closest (deepest) wins.
func (s *FileStore) ResolveTemplates(pagePath string) ([]TemplateMatch, error) {
	normalized, err := normalizePagePath(pagePath)
	if err != nil {
		return nil, err
	}
	leaf := strings.ToLower(path.Base(normalized))

	ns := path.Dir(normalized)
	if ns == "." {
		ns = "/"
	}

	seen := make(map[string]TemplateMatch) // slug → nearest match
	// Walk up from the namespace to root, reading every _template*.md at each level.
	for {
		dir := filepath.Join(s.contentRoot, filepath.FromSlash(ns))
		entries, err := os.ReadDir(dir)
		if err == nil {
			for _, e := range entries {
				if e.IsDir() {
					continue
				}
				slug, constrained, ok := parseTemplateFilename(e.Name())
				if !ok {
					continue
				}
				// Apply the filename-prefix constraint, if any.
				if constrained && !strings.HasPrefix(leaf, strings.ToLower(slug)) {
					continue
				}
				// Nearest wins — skip if a closer namespace already defined this slug.
				if _, already := seen[slug]; already {
					continue
				}
				content, readErr := os.ReadFile(filepath.Join(dir, e.Name()))
				if readErr != nil {
					continue
				}
				label := slug
				if slug == "" {
					label = "Default"
				}
				logicalStem := strings.TrimSuffix(e.Name(), ".md")
				tmplPath := path.Join(ns, logicalStem)
				seen[slug] = TemplateMatch{
					Slug:         slug,
					Label:        label,
					Markdown:     string(content),
					TemplatePath: tmplPath,
					Constrained:  constrained,
				}
			}
		}
		if ns == "/" {
			break
		}
		ns = path.Dir(ns)
	}

	if len(seen) == 0 {
		return nil, nil
	}

	// Sort: default first, then named alphabetically.
	keys := make([]string, 0, len(seen))
	for k := range seen {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i] == "" {
			return true
		}
		if keys[j] == "" {
			return false
		}
		return keys[i] < keys[j]
	})
	out := make([]TemplateMatch, 0, len(keys))
	for _, k := range keys {
		out = append(out, seen[k])
	}
	return out, nil
}

// TemplateEntry describes a template file for listing purposes.
type TemplateEntry struct {
	Namespace string `json:"namespace"`
	Path      string `json:"path"`
}

// ListTemplates returns every _template*.md file found under content/,
// including named variants (e.g. _template_sop.md).
func (s *FileStore) ListTemplates() ([]TemplateEntry, error) {
	var templates []TemplateEntry
	err := filepath.Walk(s.contentRoot, func(absPath string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		base := filepath.Base(absPath)
		if _, _, ok := parseTemplateFilename(base); !ok {
			return nil
		}
		rel, relErr := filepath.Rel(s.contentRoot, absPath)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		// Namespace: directory of the template file.
		relDir := path.Dir(rel)
		ns := "/" + relDir
		if relDir == "." || relDir == "" {
			ns = "/"
		}
		tmplPath := "/" + strings.TrimSuffix(rel, ".md")
		templates = append(templates, TemplateEntry{Namespace: ns, Path: tmplPath})
		return nil
	})
	return templates, err
}

// PageEntry is a summary for sitemap / listing purposes.
type PageEntry struct {
	Path             string `json:"path"`
	Title            string `json:"title"`
	IsNamespaceIndex bool   `json:"is_namespace_index"`
}

// ListAllPages walks content/ and returns all pages with titles.
func (s *FileStore) ListAllPages() ([]PageEntry, error) {
	var pages []PageEntry

	err := filepath.Walk(s.contentRoot, func(absPath string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(absPath, ".md") {
			return nil
		}
		// Skip template files (default and named variants).
		if _, _, ok := parseTemplateFilename(filepath.Base(absPath)); ok {
			return nil
		}

		rel, relErr := filepath.Rel(s.contentRoot, absPath)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)

		isNsIndex := strings.HasSuffix(rel, "/index.md")
		pagePath := CanonicalPath(strings.TrimSuffix(rel, ".md"))

		content, readErr := os.ReadFile(absPath)
		if readErr != nil {
			return readErr
		}

		contentStr := string(content)
		title := markdown.ExtractTitle(contentStr)
		title = markdown.ResolveTemplateVars(title, contentStr)
		pages = append(pages, PageEntry{Path: pagePath, Title: title, IsNamespaceIndex: isNsIndex})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return pages, nil
}

func (s *FileStore) readOrInitMeta(pagePath, contentPath, metaPath string) (PageMetadata, error) {
	meta, err := s.loadMeta(metaPath)
	if err == nil {
		return meta, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return PageMetadata{}, fmt.Errorf("read metadata: %w", err)
	}

	info, statErr := os.Stat(contentPath)
	if statErr != nil {
		return PageMetadata{}, fmt.Errorf("stat page file: %w", statErr)
	}
	t := info.ModTime().UTC()
	bootstrap := PageMetadata{
		ID:        makePageID(pagePath),
		CreatedAt: t,
		UpdatedAt: t,
		Version:   1,
	}
	bytes, marshalErr := json.MarshalIndent(bootstrap, "", "  ")
	if marshalErr != nil {
		return PageMetadata{}, fmt.Errorf("encode bootstrap metadata: %w", marshalErr)
	}
	bytes = append(bytes, '\n')
	if err := os.MkdirAll(filepath.Dir(metaPath), 0o755); err != nil {
		return PageMetadata{}, fmt.Errorf("create metadata directory: %w", err)
	}
	if writeErr := writeFileAtomic(metaPath, bytes); writeErr != nil {
		return PageMetadata{}, fmt.Errorf("write bootstrap metadata: %w", writeErr)
	}
	return bootstrap, nil
}

func (s *FileStore) loadMeta(metaPath string) (PageMetadata, error) {
	b, err := os.ReadFile(metaPath)
	if err != nil {
		return PageMetadata{}, err
	}
	var meta PageMetadata
	if err := json.Unmarshal(b, &meta); err != nil {
		return PageMetadata{}, fmt.Errorf("decode metadata: %w", err)
	}
	return meta, nil
}

// Exists checks whether a page exists without reading its content.
func (s *FileStore) Exists(pagePath string) bool {
	normalized, err := normalizePagePath(pagePath)
	if err != nil {
		return false
	}
	_, _, err = s.resolveExistingContentPath(normalized)
	return err == nil
}

func (s *FileStore) resolveExistingContentPath(pagePath string) (string, bool, error) {
	pageFile, err := s.contentPagePath(pagePath)
	if err != nil {
		return "", false, err
	}
	indexFile, err := s.contentNamespaceIndexPath(pagePath)
	if err != nil {
		return "", false, err
	}

	pageExists := fileExists(pageFile)
	indexExists := fileExists(indexFile)
	if pageExists && indexExists {
		return "", false, fmt.Errorf("ambiguous page path %q: both page and namespace index exist", pagePath)
	}
	if indexExists {
		return indexFile, true, nil
	}
	if pageExists {
		return pageFile, false, nil
	}
	return "", false, os.ErrNotExist
}

func (s *FileStore) resolveWritableContentPath(pagePath string) (string, bool, error) {
	pageFile, err := s.contentPagePath(pagePath)
	if err != nil {
		return "", false, err
	}
	indexFile, err := s.contentNamespaceIndexPath(pagePath)
	if err != nil {
		return "", false, err
	}

	pageExists := fileExists(pageFile)
	indexExists := fileExists(indexFile)
	if pageExists && indexExists {
		return "", false, fmt.Errorf("ambiguous page path %q: both page and namespace index exist", pagePath)
	}
	if indexExists {
		return indexFile, true, nil
	}
	if pageExists {
		return pageFile, false, nil
	}

	// When the namespace directory already exists, the logical page path is the namespace index.
	indexDir := strings.TrimSuffix(indexFile, string(filepath.Separator)+"index.md")
	if info, err := os.Stat(indexDir); err == nil && info.IsDir() {
		return indexFile, true, nil
	}

	return pageFile, false, nil
}

func (s *FileStore) contentPagePath(pagePath string) (string, error) {
	return s.safeJoinContent(pagePath + ".md")
}

func (s *FileStore) contentNamespaceIndexPath(pagePath string) (string, error) {
	return s.safeJoinContent(filepath.ToSlash(filepath.Join(pagePath, "index.md")))
}

func (s *FileStore) metadataPathForContent(contentPath string) (string, error) {
	rel, err := filepath.Rel(s.contentRoot, contentPath)
	if err != nil {
		return "", fmt.Errorf("derive metadata path: %w", err)
	}
	if strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("invalid content path")
	}
	rel = filepath.ToSlash(rel)
	if !strings.HasSuffix(rel, ".md") {
		return "", fmt.Errorf("invalid page content extension")
	}
	metaRel := strings.TrimSuffix(rel, ".md") + ".json"
	metaPath := filepath.Join(s.metaRoot, filepath.FromSlash(metaRel))
	check, err := filepath.Rel(s.metaRoot, metaPath)
	if err != nil {
		return "", fmt.Errorf("build metadata path: %w", err)
	}
	if strings.HasPrefix(check, "..") {
		return "", fmt.Errorf("invalid metadata path")
	}
	return metaPath, nil
}

func (s *FileStore) safeJoinContent(rel string) (string, error) {
	p := filepath.Join(s.contentRoot, filepath.FromSlash(rel))
	r, err := filepath.Rel(s.contentRoot, p)
	if err != nil {
		return "", fmt.Errorf("build page path: %w", err)
	}
	if strings.HasPrefix(r, "..") {
		return "", fmt.Errorf("invalid page path")
	}
	return p, nil
}

func normalizePagePath(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", fmt.Errorf("page path cannot be empty")
	}
	// Reject paths with dangerous or invalid characters.
	if strings.ContainsAny(trimmed, ":?#%\\") {
		return "", fmt.Errorf("invalid page path: contains forbidden characters")
	}
	cleaned := path.Clean("/" + trimmed)
	if cleaned == "." {
		return "", fmt.Errorf("invalid page path")
	}
	// "/" is valid — it maps to content/index.md (the root page).
	if cleaned == "/" {
		return "/index", nil
	}
	return cleaned, nil
}

func writeFileAtomic(targetPath string, content []byte) error {
	dir := filepath.Dir(targetPath)
	base := filepath.Base(targetPath)
	tmp, err := os.CreateTemp(dir, base+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, targetPath)
}

func makePageID(pagePath string) string {
	h := sha1.Sum([]byte(pagePath))
	return hex.EncodeToString(h[:])
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return !info.IsDir()
}

// faviconExtensions is the ordered list of file extensions checked for a
// wiki's own favicon.
var faviconExtensions = []string{".png", ".ico", ".svg"}

// ResolveFavicon returns the filesystem path of the wiki's own favicon
// (favicon.{png,ico,svg} at the content root), or "" when it has none.
func (s *FileStore) ResolveFavicon() string {
	for _, ext := range faviconExtensions {
		fp := filepath.Join(s.contentRoot, "favicon"+ext)
		if fileExists(fp) {
			return fp
		}
	}
	return ""
}

// logoExtensions is the ordered list of file extensions to check for a site logo.
var logoExtensions = []string{".png", ".svg", ".jpg", ".jpeg", ".gif", ".webp"}

// ResolveLogo scans the content root for a logo file (logo.{png,svg,jpg,jpeg,gif,webp}).
// Returns the relative path of the first match, or empty string if none found.
func (s *FileStore) ResolveLogo() (string, error) {
	for _, ext := range logoExtensions {
		name := "logo" + ext
		fp := filepath.Join(s.contentRoot, name)
		if fileExists(fp) {
			return name, nil
		}
	}
	return "", nil
}
