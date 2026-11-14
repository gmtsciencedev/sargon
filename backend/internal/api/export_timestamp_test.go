package api

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"sargon/backend/internal/storage"
)

func TestPDFTimestamp(t *testing.T) {
	paris, err := time.LoadLocation("Europe/Paris")
	if err != nil {
		t.Fatal(err)
	}
	winter := time.Date(2026, 11, 12, 17, 31, 0, 0, time.UTC)
	summer := time.Date(2026, 7, 1, 8, 5, 0, 0, time.UTC)
	cases := []struct {
		t    time.Time
		loc  *time.Location
		want string
	}{
		{winter, paris, "2026-11-12 18:31 CET"},
		{summer, paris, "2026-07-01 10:05 CEST"},
		{winter, time.UTC, "2026-11-12 17:31 UTC"},
	}
	for _, c := range cases {
		if got := pdfTimestamp(c.t, c.loc); got != c.want {
			t.Errorf("pdfTimestamp(%v, %v) = %q, want %q", c.t, c.loc, got, c.want)
		}
	}
}

func TestPDFFooterTemplate_CarriesTimestamp(t *testing.T) {
	got := pdfFooterTemplate("2026-11-12 18:31 CET")
	if !strings.Contains(got, "Generated 2026-11-12 18:31 CET") || strings.Contains(got, `class="date"`) {
		t.Errorf("footer does not carry the server-side timestamp: %s", got)
	}
}

// A missing page is refused before Chrome starts, instead of waiting out
// the 30-second ready-marker timeout.
func TestPrintPagePDF_MissingPageFailsFast(t *testing.T) {
	store, err := storage.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{store: store}
	start := time.Now()
	_, err = s.printPagePDF(context.Background(), "/no/such/page", "", "http://localhost", "localhost")
	if !errors.Is(err, errExportPageNotFound) {
		t.Fatalf("err = %v, want errExportPageNotFound", err)
	}
	if time.Since(start) > time.Second {
		t.Errorf("took %v", time.Since(start))
	}
}
