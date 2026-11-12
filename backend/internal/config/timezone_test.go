package config

import (
	"strings"
	"testing"
	"time"
)

func TestValidate_SiteTimezone(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Site.Timezone = "Europe/Paris"
	if err := validate(cfg); err != nil {
		t.Errorf("Europe/Paris rejected: %v", err)
	}
	cfg.Site.Timezone = "Paris"
	if err := validate(cfg); err == nil || !strings.Contains(err.Error(), "site.timezone") {
		t.Errorf("unknown zone accepted or wrong error: %v", err)
	}
}

func TestSiteLocation(t *testing.T) {
	if got := (SiteConfig{}).Location(); got != time.Local {
		t.Errorf("empty timezone = %v, want server zone", got)
	}
	if got := (SiteConfig{Timezone: "Europe/Paris"}).Location().String(); got != "Europe/Paris" {
		t.Errorf("Location() = %q", got)
	}
}
