package mcpserver

import "sargon/backend/internal/storage"

// The tools normalise page paths by dropping the leading slash
// ("docs/guide"), which turns the root page "/" into "". rootSafeStore
// maps that empty key back to "/" before it reaches the page store, which
// rejects an empty path. Wrapped once in NewHandler, so every tool reads
// and writes the root page the same way it handles any other page.
type rootSafeStore struct{ PageStore }

func rootKey(p string) string {
	if p == "" {
		return "/"
	}
	return p
}

func (s rootSafeStore) Get(p string) (storage.Page, error) { return s.PageStore.Get(rootKey(p)) }
func (s rootSafeStore) Put(p, md, author string) (storage.PutResult, error) {
	return s.PageStore.Put(rootKey(p), md, author)
}
func (s rootSafeStore) PutWithSummary(p, md, author, summary string) (storage.PutResult, error) {
	return s.PageStore.PutWithSummary(rootKey(p), md, author, summary)
}
func (s rootSafeStore) Delete(p, author string) (storage.DeleteResult, error) {
	return s.PageStore.Delete(rootKey(p), author)
}
func (s rootSafeStore) Exists(p string) bool { return s.PageStore.Exists(rootKey(p)) }
