package config

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
	_ "time/tzdata" // zone database for site.timezone on hosts without tzdata

	"gopkg.in/yaml.v3"
)

// Config holds the full site configuration.
type Config struct {
	DataDir      string             `yaml:"data_dir" json:"data_dir"` // root data directory (contains content/, meta/, attic/, etc.)
	Server       ServerConfig       `yaml:"server" json:"server"`
	Site         SiteConfig         `yaml:"site" json:"site"`
	Auth         AuthConfig         `yaml:"auth" json:"auth"`
	Drafts       DraftsConfig       `yaml:"drafts" json:"drafts"`
	Database     DatabaseConfig     `yaml:"database" json:"database"`
	Todo         TodoConfig         `yaml:"todo" json:"todo"`
	Tags         TagConfig          `yaml:"tags" json:"tags"`
	Reviewflow   ReviewflowConfig   `yaml:"reviewflow" json:"reviewflow"`
	AIAPI        AIAPIConfig        `yaml:"ai_api" json:"ai_api"`
	AIAssistant  AIAssistantConfig  `yaml:"ai_assistant" json:"ai_assistant"`
	Bibliography BibliographyConfig `yaml:"bibliography" json:"bibliography"`
	Themes       ThemeConfig        `yaml:"themes" json:"themes"`
}

// ThemeConfig controls the appearance/theme system.
type ThemeConfig struct {
	// Default applied when a user has no saved preference. Values:
	// "light" | "dark" | "auto" (follows OS). Default "auto".
	Default string `yaml:"default" json:"default"`
	// When false, the user-facing theme switcher is hidden and the default
	// is pinned for everyone.
	AllowUserOverride bool `yaml:"allow_user_override" json:"allow_user_override"`
	// PaletteOverrides maps palette var names (without the "--gw-color-"
	// prefix) to CSS color values. Applied to the light theme only.
	// Example: {"primary": "#2d5a47", "link": "#1e7a5e"}.
	PaletteOverrides map[string]string `yaml:"palette_overrides" json:"palette_overrides"`
	// ImageAutoFrame controls the dark-mode image-frame heuristic. When
	// true (default), images with near-white backgrounds are wrapped in a
	// subtle cream frame so they don't appear as bright blocks against a
	// dark page. See specs/themes.md §11.6 for the full mechanism.
	// Authors can override per image via `{image bg=...}`.
	ImageAutoFrame *bool `yaml:"image_auto_frame" json:"image_auto_frame"`
}

// ImageAutoFrameEnabled returns the effective auto-frame setting, defaulting
// to true when the admin hasn't explicitly set the field.
func (t ThemeConfig) ImageAutoFrameEnabled() bool {
	if t.ImageAutoFrame == nil {
		return true
	}
	return *t.ImageAutoFrame
}

// BibliographyConfig controls the bibliography (PubMed/DOI citation) plugin.
type BibliographyConfig struct {
	Enabled           bool   `yaml:"enabled" json:"enabled"`
	PubmedAPIKey      string `yaml:"pubmed_api_key" json:"pubmed_api_key"`           // optional NCBI API key (raises rate limit to 10/s)
	AdminContactEmail string `yaml:"admin_contact_email" json:"admin_contact_email"` // included in the User-Agent header per NIH etiquette
}

// ServerConfig holds network/serving settings.
type ServerConfig struct {
	Addr      string `yaml:"addr" json:"addr"`             // HTTP listen address (default ":8080")
	TLSDomain string `yaml:"tls_domain" json:"tls_domain"` // domain for Let's Encrypt auto-TLS
	WebDir    string `yaml:"web_dir" json:"web_dir"`       // directory containing built frontend assets
}

// ReviewflowConfig holds document validation workflow settings.
type ReviewflowConfig struct {
	Enabled   bool              `yaml:"enabled" json:"enabled"`
	Deadlines map[string]string `yaml:"deadlines" json:"deadlines"` // role name -> duration string (e.g. "72h")
	Observers []string          `yaml:"observers" json:"observers"` // users/groups who can view all drafts (e.g. "alice", "group:quality")
	Signing   SigningConfig     `yaml:"signing" json:"signing"`
	// HideDraftsFromUninvolved gates uninvolved readers away from
	// unsigned drafts. When true and a document has a {reviewflow}
	// directive, viewers who are not an assigned role or a global
	// observer get redirected to the last validated version (302 to
	// ?v=N), or 404 if there is no validated version yet. Default
	// false: everything visible, preserving pre-existing behaviour.
	// Regulatory installations (QMS, SOP-heavy wikis) flip this on.
	HideDraftsFromUninvolved bool `yaml:"hide_drafts_from_uninvolved" json:"hide_drafts_from_uninvolved"`
}

// SigningConfig holds X.509 document signing settings.
type SigningConfig struct {
	Enabled      bool          `yaml:"enabled" json:"enabled"`
	Required     bool          `yaml:"required" json:"required"`
	TrustStore   []string      `yaml:"trust_store" json:"trust_store"`     // paths to trusted CA PEM files
	RevokedCerts []RevokedCert `yaml:"revoked_certs" json:"revoked_certs"` // revoked certificate entries
}

// RevokedCert represents a revoked certificate with its fingerprint and revocation date.
// Signatures made before the revocation date remain valid; only signatures after are rejected.
type RevokedCert struct {
	Fingerprint string `yaml:"fingerprint" json:"fingerprint"` // SHA-256 fingerprint
	RevokedAt   string `yaml:"revoked_at" json:"revoked_at"`   // RFC 3339 timestamp (e.g. "2026-03-15T00:00:00Z")
}

// IsRevoked returns true if the given fingerprint is in the revocation list.
// Used for server-side rejection of new confirmations (date is irrelevant for new signatures).
func (sc SigningConfig) IsRevoked(fingerprint string) bool {
	for _, rc := range sc.RevokedCerts {
		if rc.Fingerprint == fingerprint {
			return true
		}
	}
	return false
}

// TodoConfig holds task management plugin settings.
// Todo is automatically enabled when a database connection is active,
// unless explicitly disabled via the "disabled" flag.
type TodoConfig struct {
	Enabled       bool             `yaml:"enabled" json:"enabled"`
	Disabled      bool             `yaml:"disabled" json:"disabled"`
	ReminderHours []int            `yaml:"reminder_hours" json:"reminder_hours"`
	Notify        TodoNotifyConfig `yaml:"notify" json:"notify"`
}

// TodoNotifyConfig holds notification channel settings.
//
// BatchWindowSeconds is a trailing debounce + daily cap on outgoing
// notifications. When a trigger lands, the dispatcher waits
// BatchWindowSeconds (default 300 = 5 min) before sending; another
// trigger for the same user within the window resets the clock and
// is folded into the same email. A hard cap of 24h per (user, page)
// stops the same document re-notifying the same person more than
// once per day.
//
// 0 disables batching — notifications send immediately with no cap.
type TodoNotifyConfig struct {
	Email              TodoEmailConfig     `yaml:"email" json:"email"`
	Webhooks           []TodoWebhookConfig `yaml:"webhook" json:"webhook"`
	BatchWindowSeconds int                 `yaml:"batch_window_seconds" json:"batch_window_seconds"`
}

// TodoEmailConfig holds SMTP email notification settings.
type TodoEmailConfig struct {
	Enabled  bool   `yaml:"enabled" json:"enabled"`
	From     string `yaml:"from" json:"from"`
	SMTPHost string `yaml:"smtp_host" json:"smtp_host"`
	SMTPPort int    `yaml:"smtp_port" json:"smtp_port"`
	SMTPUser string `yaml:"smtp_user" json:"smtp_user"`
	SMTPPass string `yaml:"smtp_pass" json:"smtp_pass"`
}

// TodoWebhookConfig holds a single outbound webhook configuration.
type TodoWebhookConfig struct {
	Name        string `yaml:"name" json:"name"`
	Enabled     bool   `yaml:"enabled" json:"enabled"`
	URL         string `yaml:"url" json:"url"`
	ContentType string `yaml:"content_type" json:"content_type"`
	PayloadTmpl string `yaml:"payload_tmpl" json:"payload_tmpl"`
	HMACSecret  string `yaml:"hmac_secret" json:"hmac_secret"`
}

// DatabaseConfig holds PostgreSQL connection settings.
type DatabaseConfig struct {
	DSN     string `yaml:"dsn" json:"dsn"`
	Enabled bool   `yaml:"enabled" json:"enabled"`
}

// TagConfig holds tag-related settings.
type TagConfig struct {
	// TemplateMutations defines tag transformations applied when creating a page from a template.
	// Each entry is either "tag" (remove the tag) or "tag:replacement" (replace with another tag).
	// Example: ["tpl", "draft:review"] removes "tpl" tags and replaces "draft" with "review".
	TemplateMutations []string `yaml:"template_mutations" json:"template_mutations"`
}

// SiteConfig holds site-wide display settings.
type SiteConfig struct {
	Title         string `yaml:"title" json:"title"`
	BaseURL       string `yaml:"base_url" json:"base_url"` // e.g. "https://wiki.example.com"
	FooterPage    string `yaml:"footer_page" json:"footer_page"`
	SidebarPage   string `yaml:"sidebar_page" json:"sidebar_page"`
	TOCMaxLevel   int    `yaml:"toc_max_level" json:"toc_max_level"`     // 0 = disabled, 1-6 = show headings up to this level
	UserDisplay   string `yaml:"user_display" json:"user_display"`       // "login" (default), "fullname", "email"
	CodeTheme     string `yaml:"code_theme" json:"code_theme"`           // highlight.js theme name (light mode)
	CodeThemeDark string `yaml:"code_theme_dark" json:"code_theme_dark"` // highlight.js theme name (dark mode)
	Timezone      string `yaml:"timezone" json:"timezone"`               // IANA zone for printed timestamps, e.g. "Europe/Paris"; empty = server's zone
}

// Location returns the site's time zone for timestamps shown to readers
// (PDF footers): the configured IANA zone, or the server's own zone when
// none is set. validate rejects unknown zones, so the fallback only covers
// configs loaded without validation.
func (s SiteConfig) Location() *time.Location {
	if s.Timezone == "" {
		return time.Local
	}
	loc, err := time.LoadLocation(s.Timezone)
	if err != nil {
		return time.Local
	}
	return loc
}

// AuthConfig holds authentication settings.
type AuthConfig struct {
	SessionTTL string      `yaml:"session_ttl" json:"session_ttl"` // duration string, e.g. "24h"
	OAuth      OAuthConfig `yaml:"oauth" json:"oauth"`
}

// OAuthConfig holds external OAuth/OIDC provider settings.
type OAuthConfig struct {
	Provider        string   `yaml:"provider" json:"provider"`                   // "azure" or "" (disabled)
	TenantID        string   `yaml:"tenant_id" json:"tenant_id"`                 // Azure AD tenant ID
	ClientID        string   `yaml:"client_id" json:"client_id"`                 // Application (client) ID
	ClientSecret    string   `yaml:"client_secret" json:"client_secret"`         // Client secret value
	AutoCreateUsers bool     `yaml:"auto_create_users" json:"auto_create_users"` // Create user on first OAuth login
	DefaultGroups   []string `yaml:"default_groups" json:"default_groups"`       // Groups for auto-created users
}

// AIAPIConfig holds settings for the AI Content API (token-based access).
type AIAPIConfig struct {
	Enabled          bool `yaml:"enabled" json:"enabled"`
	RateLimitRead    int  `yaml:"rate_limit_read" json:"rate_limit_read"`
	RateLimitWrite   int  `yaml:"rate_limit_write" json:"rate_limit_write"`
	MaxTokensPerUser int  `yaml:"max_tokens_per_user" json:"max_tokens_per_user"`
	RequireSummary   bool `yaml:"require_summary" json:"require_summary"`
}

// AIAssistantConfig holds settings for the integrated AI assistant (browser-based).
type AIAssistantConfig struct {
	Enabled       bool             `yaml:"enabled" json:"enabled"`
	Provider      string           `yaml:"provider" json:"provider"`             // "anthropic" | "openai" (future)
	APIKey        string           `yaml:"api_key" json:"api_key"`               // provider API key (overridden by AI_ASSISTANT_API_KEY env var)
	Model         string           `yaml:"model" json:"model"`                   // model identifier
	MaxTokens     int              `yaml:"max_tokens" json:"max_tokens"`         // max response tokens per request
	AllowedGroups []string         `yaml:"allowed_groups" json:"allowed_groups"` // groups that can use the assistant (empty = all authenticated)
	Costs         AIAssistantCosts `yaml:"costs" json:"costs"`
}

// AIAssistantCosts holds cost control settings for the integrated AI assistant.
type AIAssistantCosts struct {
	RateLimitPerUser    int     `yaml:"rate_limit_per_user" json:"rate_limit_per_user"`       // max requests/hour/user (0 = unlimited)
	MaxTokensPerRequest int     `yaml:"max_tokens_per_request" json:"max_tokens_per_request"` // max output tokens per request
	MaxContextTokens    int     `yaml:"max_context_tokens" json:"max_context_tokens"`         // max input tokens (page + system prompt)
	DailyLimitPerUser   int     `yaml:"daily_limit_per_user" json:"daily_limit_per_user"`     // max requests/day/user (0 = unlimited)
	MonthlyBudget       float64 `yaml:"monthly_budget" json:"monthly_budget"`                 // USD cap across all users (0 = unlimited)
	WarnAtPercentage    int     `yaml:"warn_at_percentage" json:"warn_at_percentage"`         // admin warning threshold (0 = no warning)
}

// EffectiveAPIKey returns the API key, preferring the environment variable.
func (c AIAssistantConfig) EffectiveAPIKey() string {
	if envKey := os.Getenv("AI_ASSISTANT_API_KEY"); envKey != "" {
		return envKey
	}
	return c.APIKey
}

// DraftsConfig holds draft/lock settings.
type DraftsConfig struct {
	AutoSaveInterval string `yaml:"auto_save_interval" json:"auto_save_interval"` // e.g. "2m"
	StaleLockTimeout string `yaml:"stale_lock_timeout" json:"stale_lock_timeout"` // e.g. "24h"
}

// DefaultConfig returns the configuration with all default values.
func DefaultConfig() Config {
	return Config{
		Server: ServerConfig{
			Addr: ":8080",
		},
		Site: SiteConfig{
			Title:         "Sargon",
			FooterPage:    "footer",
			SidebarPage:   "sidebar",
			TOCMaxLevel:   3,
			CodeTheme:     "github",
			CodeThemeDark: "github-dark",
		},
		Auth: AuthConfig{
			SessionTTL: "24h",
		},
		Drafts: DraftsConfig{
			AutoSaveInterval: "2m",
			StaleLockTimeout: "24h",
		},
		AIAPI: AIAPIConfig{
			Enabled:          false,
			RateLimitRead:    120,
			RateLimitWrite:   30,
			MaxTokensPerUser: 5,
			RequireSummary:   true,
		},
		AIAssistant: AIAssistantConfig{
			Enabled:   false,
			Provider:  "anthropic",
			Model:     "claude-sonnet-4-20250514",
			MaxTokens: 4096,
			Costs: AIAssistantCosts{
				RateLimitPerUser:    30,
				MaxTokensPerRequest: 4096,
				MaxContextTokens:    16000,
				DailyLimitPerUser:   100,
				MonthlyBudget:       0,
				WarnAtPercentage:    80,
			},
		},
		Bibliography: BibliographyConfig{
			Enabled: false,
		},
		Themes: ThemeConfig{
			Default:           "auto",
			AllowUserOverride: true,
		},
	}
}

// Store manages configuration state, backed by a YAML file on disk.
// The file is the source of truth; the in-memory copy is a cache.
type Store struct {
	mu     sync.RWMutex
	config Config
	path   string
}

// Load reads configuration from a YAML file at the given path.
// If the file does not exist, it is created with default values.
func Load(path string) (*Store, error) {
	s := &Store{path: path}

	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		// File doesn't exist — create with defaults.
		s.config = DefaultConfig()
		if err := s.save(); err != nil {
			return nil, fmt.Errorf("config: create default file: %w", err)
		}
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("config: read file: %w", err)
	}

	// Start from defaults so that any missing keys get their default value.
	cfg := DefaultConfig()
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("config: parse yaml: %w", err)
	}
	s.config = cfg
	return s, nil
}

// Get returns a snapshot of the current configuration.
func (s *Store) Get() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.config
}

// Update validates the new configuration, writes it atomically to disk,
// and updates the in-memory state.
func (s *Store) Update(newConfig Config) error {
	if err := validate(newConfig); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	s.config = newConfig
	if err := s.save(); err != nil {
		return fmt.Errorf("config: save: %w", err)
	}
	return nil
}

// save marshals the current config to YAML and writes it atomically
// using a temporary file + rename.
func (s *Store) save() error {
	data, err := yaml.Marshal(s.config)
	if err != nil {
		return fmt.Errorf("marshal yaml: %w", err)
	}

	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}

	tmp, err := os.CreateTemp(dir, "config-*.yaml.tmp")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpName := tmp.Name()

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("close temp file: %w", err)
	}

	if err := os.Rename(tmpName, s.path); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("rename temp file: %w", err)
	}
	return nil
}

// validate checks that all duration strings are parseable and that
// required fields are non-empty.
func validate(cfg Config) error {
	if cfg.Site.Title == "" {
		return fmt.Errorf("site.title must not be empty")
	}

	if cfg.Site.Timezone != "" {
		if _, err := time.LoadLocation(cfg.Site.Timezone); err != nil {
			return fmt.Errorf("site.timezone: unknown time zone %q (use an IANA name such as Europe/Paris)", cfg.Site.Timezone)
		}
	}

	if cfg.Auth.SessionTTL != "" {
		if _, err := time.ParseDuration(cfg.Auth.SessionTTL); err != nil {
			return fmt.Errorf("auth.session_ttl: invalid duration %q: %w", cfg.Auth.SessionTTL, err)
		}
	}
	if cfg.Drafts.AutoSaveInterval != "" {
		if _, err := time.ParseDuration(cfg.Drafts.AutoSaveInterval); err != nil {
			return fmt.Errorf("drafts.auto_save_interval: invalid duration %q: %w", cfg.Drafts.AutoSaveInterval, err)
		}
	}
	if cfg.Drafts.StaleLockTimeout != "" {
		if _, err := time.ParseDuration(cfg.Drafts.StaleLockTimeout); err != nil {
			return fmt.Errorf("drafts.stale_lock_timeout: invalid duration %q: %w", cfg.Drafts.StaleLockTimeout, err)
		}
	}
	for role, dur := range cfg.Reviewflow.Deadlines {
		if _, err := time.ParseDuration(dur); err != nil {
			return fmt.Errorf("reviewflow.deadlines.%s: invalid duration %q: %w", role, dur, err)
		}
	}
	return nil
}
