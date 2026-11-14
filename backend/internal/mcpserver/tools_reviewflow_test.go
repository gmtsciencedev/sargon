package mcpserver

import (
	"errors"
	"testing"

	"sargon/backend/internal/reviewflow"
)

// buildReviewflowList is the pure core of the list_reviewflows MCP tool.
// It stands in for a hand-rolled loop over the sitemap that would
// otherwise be untestable without spinning a whole server. The tool
// handler runs it after fetching the page corpus and hands the resulting
// {rows, scanned, skipped_access} into the JSON envelope.

func mkStatus(current, validated int64, isValidated bool, roles ...string) *reviewflow.Status {
	roleMap := map[string]string{}
	for _, r := range roles {
		roleMap[r] = "@" + r
	}
	return &reviewflow.Status{
		Roles:            roleMap,
		CurrentPageVer:   current,
		ValidatedVersion: validated,
		IsFullyValidated: isValidated,
		MissingRoles:     map[string]string{},
	}
}

// Baseline: three configured pages under the prefix, all viewable, none
// overdue. Response counts scanned but not skippedAcl.
func TestBuildReviewflowList_HappyPath(t *testing.T) {
	t.Parallel()
	statuses := map[string]*reviewflow.Status{
		"/a/one":   mkStatus(2, 2, true, "reviewer"),
		"/a/two":   mkStatus(3, 2, false, "reviewer", "validator"),
		"/a/three": mkStatus(1, 1, true, "reviewer"),
		"/other/x": mkStatus(1, 1, true, "reviewer"), // outside prefix
	}
	rows, scanned, skippedAcl := buildReviewflowList(reviewflowScanArgs{
		pages:  []string{"/a/one", "/a/two", "/a/three", "/other/x"},
		prefix: "/a",
		limit:  100,
		getStatus: func(p string) (*reviewflow.Status, error) {
			return statuses[p], nil
		},
	})
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3 (prefix filter should exclude /other/x)", len(rows))
	}
	if scanned != 3 {
		t.Errorf("scanned = %d, want 3", scanned)
	}
	if skippedAcl != 0 {
		t.Errorf("skippedAcl = %d, want 0 (nil canView means allow all)", skippedAcl)
	}
	// Preserve input order — the caller's sitemap already sorts.
	if rows[0].Path != "/a/one" || rows[1].Path != "/a/two" || rows[2].Path != "/a/three" {
		t.Errorf("row paths not in sitemap order: %+v", rows)
	}
	// The middle page is out of validation — validated_version < current_version.
	if rows[1].IsFullyValidated {
		t.Errorf("a/two: IsFullyValidated = true, want false (v=3 with validated=2)")
	}
	if rows[1].ValidatedVersion != 2 {
		t.Errorf("a/two: ValidatedVersion = %d, want 2", rows[1].ValidatedVersion)
	}
}

// Pages with no {reviewflow} directive have an empty Roles map.
// Default behavior: skip them so the response is a compact compliance
// list. include_unconfigured=true opts back in.
func TestBuildReviewflowList_UnconfiguredFilter(t *testing.T) {
	t.Parallel()
	statuses := map[string]*reviewflow.Status{
		"/a/configured":   mkStatus(1, 1, true, "reviewer"),
		"/a/unconfigured": {Roles: map[string]string{}, MissingRoles: map[string]string{}},
	}
	pages := []string{"/a/configured", "/a/unconfigured"}
	getStatus := func(p string) (*reviewflow.Status, error) { return statuses[p], nil }

	// Default: only configured page returned.
	rows, _, _ := buildReviewflowList(reviewflowScanArgs{
		pages: pages, prefix: "/a", limit: 100, getStatus: getStatus,
	})
	if len(rows) != 1 || rows[0].Path != "/a/configured" {
		t.Fatalf("default: rows=%+v, want single /a/configured", rows)
	}
	if !rows[0].HasReviewflow {
		t.Error("configured row has_reviewflow=false, want true")
	}

	// include_unconfigured=true: both rows returned, unconfigured marked.
	rows, _, _ = buildReviewflowList(reviewflowScanArgs{
		pages: pages, prefix: "/a", limit: 100, includeUnconfigured: true, getStatus: getStatus,
	})
	if len(rows) != 2 {
		t.Fatalf("include_unconfigured: rows=%d, want 2", len(rows))
	}
	var unconfigured *reviewflowRow
	for i := range rows {
		if rows[i].Path == "/a/unconfigured" {
			unconfigured = &rows[i]
		}
	}
	if unconfigured == nil {
		t.Fatal("include_unconfigured: /a/unconfigured missing from rows")
	}
	if unconfigured.HasReviewflow {
		t.Error("unconfigured row has_reviewflow=true, want false")
	}
}

// The ACL callback must be able to hide pages from the caller. Those
// pages count against skipped_access, NOT against scanned — so a caller
// can distinguish "no pages here" from "you can't see the pages here".
func TestBuildReviewflowList_ACLSkip(t *testing.T) {
	t.Parallel()
	statuses := map[string]*reviewflow.Status{
		"/a/visible": mkStatus(1, 1, true, "reviewer"),
		"/a/hidden":  mkStatus(1, 1, true, "reviewer"),
	}
	rows, scanned, skippedAcl := buildReviewflowList(reviewflowScanArgs{
		pages:     []string{"/a/visible", "/a/hidden"},
		prefix:    "/a",
		limit:     100,
		canView:   func(p string) bool { return p != "/a/hidden" },
		getStatus: func(p string) (*reviewflow.Status, error) { return statuses[p], nil },
	})
	if len(rows) != 1 || rows[0].Path != "/a/visible" {
		t.Fatalf("rows = %+v, want [/a/visible]", rows)
	}
	if scanned != 1 {
		t.Errorf("scanned = %d, want 1 (hidden page must not count as scanned)", scanned)
	}
	if skippedAcl != 1 {
		t.Errorf("skippedAcl = %d, want 1", skippedAcl)
	}
}

// A getStatus error on one page does not abort the whole scan — the
// caller doing a 500-page sweep would otherwise lose everything to a
// single bad sidecar file. The bad page is dropped, the rest survive,
// and it does not count as a row.
func TestBuildReviewflowList_ContinuesPastGetStatusError(t *testing.T) {
	t.Parallel()
	rows, scanned, _ := buildReviewflowList(reviewflowScanArgs{
		pages:  []string{"/a/ok", "/a/bad", "/a/ok2"},
		prefix: "/a",
		limit:  100,
		getStatus: func(p string) (*reviewflow.Status, error) {
			if p == "/a/bad" {
				return nil, errors.New("attic corrupt")
			}
			return mkStatus(1, 1, true, "reviewer"), nil
		},
	})
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2 (bad page dropped)", len(rows))
	}
	if scanned != 3 {
		t.Errorf("scanned = %d, want 3 (bad page still counts as scanned)", scanned)
	}
}

// The limit is a hard cap. When we reach it, subsequent pages are not
// scanned at all — cheap. The tool handler wraps this with truncated_at_limit.
func TestBuildReviewflowList_LimitStopsIteration(t *testing.T) {
	t.Parallel()
	pages := []string{"/a/1", "/a/2", "/a/3", "/a/4", "/a/5"}
	rows, scanned, _ := buildReviewflowList(reviewflowScanArgs{
		pages:  pages,
		prefix: "/a",
		limit:  2,
		getStatus: func(p string) (*reviewflow.Status, error) {
			return mkStatus(1, 1, true, "reviewer"), nil
		},
	})
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2 (hard cap)", len(rows))
	}
	if scanned != 2 {
		t.Errorf("scanned = %d, want 2 (must NOT scan past limit)", scanned)
	}
}

// Empty prefix scans the whole wiki — matches every page.
func TestBuildReviewflowList_EmptyPrefixMatchesAll(t *testing.T) {
	t.Parallel()
	rows, _, _ := buildReviewflowList(reviewflowScanArgs{
		pages:  []string{"/root", "/a/one", "/b/two"},
		prefix: "",
		limit:  100,
		getStatus: func(p string) (*reviewflow.Status, error) {
			return mkStatus(1, 1, true, "reviewer"), nil
		},
	})
	if len(rows) != 3 {
		t.Fatalf("empty prefix: rows = %d, want 3", len(rows))
	}
}

// Overdue roles are carried through — a compliance dashboard reads this
// to flag "reviewer overdue on /qms/sop07 for 8 days".
func TestBuildReviewflowList_CarriesOverdueRoles(t *testing.T) {
	t.Parallel()
	st := mkStatus(3, 2, false, "reviewer", "validator")
	st.OverdueRoles = []string{"reviewer"}
	rows, _, _ := buildReviewflowList(reviewflowScanArgs{
		pages: []string{"/a/x"}, prefix: "/a", limit: 10,
		getStatus: func(p string) (*reviewflow.Status, error) { return st, nil },
	})
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if len(rows[0].OverdueRoles) != 1 || rows[0].OverdueRoles[0] != "reviewer" {
		t.Errorf("OverdueRoles = %+v, want [reviewer]", rows[0].OverdueRoles)
	}
}

// Signatory fields: roles, confirmed_by, missing_roles, next_roles,
// signed_roles, version_tag, parallel. The caller must be able to answer
// "who signed, who still owes, who's up next" from one list_reviewflows
// response — the whole point of the batch tool.
func TestBuildReviewflowList_SurfacesSignatories(t *testing.T) {
	t.Parallel()
	// Parallel review on tag v1.2 — alice (author) signed, bob and cathy
	// still owe; bob signed cryptographically earlier (prior version) so
	// SignedRoles carries just [author] for the current page version.
	st := &reviewflow.Status{
		Roles:            map[string]string{"author": "alice", "reviewer": "bob", "validator": "cathy"},
		VersionTag:       "v1.2",
		Parallel:         true,
		CurrentPageVer:   5,
		ValidatedVersion: 4,
		MissingRoles:     map[string]string{"reviewer": "bob", "validator": "cathy"},
		NextRoles:        []string{"reviewer", "validator"},
		SignedRoles:      []string{"author"},
		IsFullyValidated: false,
	}
	rows, _, _ := buildReviewflowList(reviewflowScanArgs{
		pages: []string{"/qms/sop07"}, prefix: "/qms", limit: 10,
		getStatus: func(p string) (*reviewflow.Status, error) { return st, nil },
	})
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	r := rows[0]
	if r.VersionTag != "v1.2" {
		t.Errorf("VersionTag = %q, want v1.2", r.VersionTag)
	}
	if !r.Parallel {
		t.Error("Parallel = false, want true")
	}
	if r.Roles["author"] != "alice" || r.Roles["reviewer"] != "bob" || r.Roles["validator"] != "cathy" {
		t.Errorf("Roles = %+v", r.Roles)
	}
	// ConfirmedBy = Roles ∖ MissingRoles — the server derives it so callers
	// don't have to do the set subtraction themselves.
	if len(r.ConfirmedBy) != 1 || r.ConfirmedBy["author"] != "alice" {
		t.Errorf("ConfirmedBy = %+v, want {author: alice}", r.ConfirmedBy)
	}
	if r.MissingRoles["reviewer"] != "bob" || r.MissingRoles["validator"] != "cathy" {
		t.Errorf("MissingRoles = %+v", r.MissingRoles)
	}
	if len(r.NextRoles) != 2 {
		t.Errorf("NextRoles = %+v, want 2 entries (parallel review)", r.NextRoles)
	}
	if len(r.SignedRoles) != 1 || r.SignedRoles[0] != "author" {
		t.Errorf("SignedRoles = %+v, want [author]", r.SignedRoles)
	}
}

// Nothing signed yet: ConfirmedBy is nil (JSON omits the field), not an
// empty map that would clutter the response for the common "fresh
// reviewflow, no signatures" case.
func TestBuildReviewflowList_ConfirmedByNilWhenNothingSigned(t *testing.T) {
	t.Parallel()
	st := &reviewflow.Status{
		Roles:        map[string]string{"author": "alice", "reviewer": "bob"},
		MissingRoles: map[string]string{"author": "alice", "reviewer": "bob"},
	}
	rows, _, _ := buildReviewflowList(reviewflowScanArgs{
		pages: []string{"/x"}, prefix: "", limit: 10,
		getStatus: func(p string) (*reviewflow.Status, error) { return st, nil },
	})
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if rows[0].ConfirmedBy != nil {
		t.Errorf("ConfirmedBy = %+v, want nil when nothing is signed", rows[0].ConfirmedBy)
	}
}
