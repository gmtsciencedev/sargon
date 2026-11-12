package api

import (
	"strings"
	"testing"
	"time"
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
