# Themes — Specification

## 1. Overview

The theme system lets a Sargon instance look different — light or dark, with its own brand palette — without requiring CSS edits or a code change. Users pick their preferred appearance (light, dark, or follow OS) from their profile; admins pick the instance-wide default and can override specific palette values.

All themeable values are exposed as CSS custom properties (variables) at `:root`. A theme is a small block of `var` overrides applied via a `data-theme="..."` attribute on `<html>`. Plugins read from the same variables so they stay consistent.

### Design goals

- **No code change to switch themes** — palette and typography are pure CSS.
- **One source of truth** — every color/spacing decision lives in a documented set of custom properties.
- **User preference respected** — light / dark / auto, persisted per user, with OS fallback.
- **Admin brand control** — override individual palette values from `config.yaml` without touching CSS.
- **Plugin-safe** — plugins use the same variables; a plugin that follows the convention automatically works in every theme.
- **Print-stable** — PDF export always uses the light theme regardless of the viewing preference.

### Non-goals (v1)

- Per-user custom CSS or theme upload (security, maintenance burden)
- Per-namespace themes
- Live theme editor in the admin UI (edit `config.yaml`, restart if needed)
- Theme marketplace / sharing mechanism

### Acknowledged v1 limitations (to address in v2)

- **Typography customization** — font family, base size, and heading scale
  are exposed as CSS vars (`--gw-font-sans`, `--gw-font-size-base`,
  `--gw-font-size-h1-mult`) but the admin UI and config schema don't let
  admins override them. A v2 add would extend `palette_overrides` into a
  broader `overrides` block covering typography.
- **Density** — compact/comfortable/relaxed spacing presets are likewise
  defined as CSS vars (`--gw-space-*`) but not exposed to admins or users.
- **Per-user font-size adjustment** — a `-1 / 0 / +1` step in the profile
  menu (CSS `zoom` or `font-size` multiplier) would cover vision
  accessibility.
- **Auto-invert for transparent content images** — images with transparent
  backgrounds that assume a light canvas disappear in dark mode. A future
  `{image bg="light"}` opt-in would force a white backdrop.

---

## 11. v2 roadmap — richer theming without package bloat

### 11.1 Design stance

A "theme" in many wiki systems is a package of HTML templates, CSS, and
assets that the admin drops into a themes directory. That model has two
chronic problems: plugin compatibility breaks on every new plugin, and the
theme package rots on every Sargon upgrade because internal class names
change.

Sargon chooses a different shape: **every theme is a set of values for the
same CSS custom properties**. There's no separate code path, no alternate
template, no plugin-specific overrides layer. A theme is just data.

The three tiers below grow the expressiveness of that data without
breaking the invariant.

### 11.2 Tier 1 — Extended `overrides` block

Today `themes.palette_overrides` only covers the palette. v2 extends the
config schema to cover every documented CSS var:

```yaml
themes:
  default: auto
  allow_user_override: true
  overrides:
    palette:
      primary:    "#2d5a47"
      primary_fg: "#ffffff"
      link:       "#1e7a5e"
    typography:
      sans:       "Inter, system-ui, sans-serif"
      serif:      "Source Serif Pro, Georgia, serif"
      mono:       "JetBrains Mono, monospace"
      base_size:  "15px"
      line_height:"1.6"
      h1_mult:    "1.9"
    spacing:
      xs: "4px"
      sm: "8px"
      md: "20px"
      lg: "28px"
    radii:
      default: "8px"
      small:   "5px"
    shadows:
      sm: "0 1px 3px rgba(0,0,0,0.1)"
      md: "0 4px 20px rgba(0,0,0,0.15)"
```

The backend generates a single `/api/theme/overrides.css` that emits all
the vars the admin set, scoped to the light theme (same policy as v1 —
brand overrides rarely work unchanged in dark).

**Backward compatible**: the old `palette_overrides` key is kept as an
alias for `overrides.palette` indefinitely.

**Cost**: ~one evening. Config struct extension, generator update, admin
UI tab gets three additional sections (Typography / Spacing / Radii).

**Risk**: near zero. Any plugin that already reads from vars picks up the
change automatically.

### 11.3 Tier 2 — Named presets

A preset is a curated bundle of Tier-1 overrides shipped with Sargon. The
admin picks one by name; individual `overrides:` entries still merge on
top so admins can tune without losing the preset's flavour.

```yaml
themes:
  preset: "compact"
  overrides:
    palette:
      primary: "#2d5a47"   # still applied on top of the "compact" preset
```

Three or four built-in presets are enough:

| Preset | What changes |
|---|---|
| `default` | Current values — the baseline. |
| `compact` | Smaller base font, tighter line-height, reduced spacing, smaller radii. For information-dense QMS pages. |
| `serious` | Serif body, classic radii, conservative shadows. For formal documents. |
| `playful` | Larger radii, softer shadows, slightly brighter palette. For team/playground wikis. |

Implementation: a preset is just a `map[string]any` living in
`internal/config/themes/presets.go`, merged with `overrides` before
emitting the stylesheet. No new runtime behaviour.

**Cost**: Tier 1 + ~half a day per preset.

**Risk**: low. A preset is data.

### 11.4 Tier 3 — Custom CSS escape hatch

A single file at `data/meta/_custom.css` (or similar), editable via the
admin UI, served at `/api/theme/custom.css` after all other stylesheets.
Gives full CSS power for cases the var system can't express: layout
tweaks, plugin-specific polish, experimental ideas.

```
<link rel="stylesheet" href="/theme.css" />
<link rel="stylesheet" href="/api/theme/overrides.css" />
<link rel="stylesheet" href="/style.css" />
<link rel="stylesheet" href="/pm.css" />
<link rel="stylesheet" href="/menu.css" />
<link rel="stylesheet" href="/api/theme/custom.css" />   <!-- Tier 3, last -->
```

**Constraints (for safety):**
- Single file, not a directory.
- Editable only by admins.
- No external URL fetches allowed — the endpoint strips `@import` rules
  and external `url(...)` references to avoid information-leak attacks
  via background images.
- Content-Security-Policy headers prevent the served CSS from loading
  fonts/images from third-party hosts.

**Cost**: ~half a day.

**Risk**: moderate — the admin can break their own wiki, but the file is
trivially revertable by deleting or emptying it. Because we strip
external URLs at serve time, there's no exfiltration vector.

### 11.5 Explicit non-goals (still, in v2)

- **Full theme packages** with their own HTML templates / assets — too
  much maintenance burden for too little additional value over Tier 3.
- **Per-namespace themes** — high complexity, low demand.
- **User-uploadable themes or CSS** — CSS can exfiltrate data through
  `background-image: url(...)` calls even with CSP; admin-only editing
  keeps the risk acceptable.
- **Layout restructuring** (banner side, sidebar position, column count)
  — would require template changes + plugin coordination, reopens the
  whole compatibility problem.
- **Plugin-specific "theme hooks" API** — nice in theory, but each
  plugin's internals would need a deliberate public CSS contract; the
  var system already provides ~80% of that with zero extra API surface.

### 11.6 Image handling in dark mode

One of the most visible remaining issues in dark mode is images with
white backgrounds. They appear as bright rectangular blocks against a
dark page — ugly and distracting. This is a well-known problem (GitHub,
Notion, Confluence all struggle with it); there is no magic fix, only a
combination of heuristics and author controls that together get to a
"good enough" default.

#### 11.6.1 What doesn't work

- **Invert every image** — breaks photos, screenshots, and logos with
  specific brand hues. Safe only on line art.
- **Strip white pixels to transparent at upload** — destructive; wrong
  for any image where white is content (snow, light UI screenshots,
  logos with white elements); not retroactive.
- **Always wrap every image in a light frame** — creates a bright
  rectangle per image, effectively the same problem moved inward.

#### 11.6.2 What ships in v2

**Three layers combined.**

##### Layer 1 — Author directive attribute

Extend the `{image}` directive with a `bg` attribute:

| Value | Dark-mode treatment |
|---|---|
| `auto` (default) | Apply the heuristic in Layer 2 below |
| `light` | Always wrap in a subtle light frame |
| `invert` | Apply `filter: invert(1) hue-rotate(180deg)` — for line art |
| `none` | No treatment, image renders as-is |

Example:
```markdown
{image src=/media/diagram.png bg=light}
{image src=/media/linechart.svg bg=invert}
{image src=/media/dark-ok-screenshot.png bg=none}
```

Authors who know a given image's needs can lock in the right treatment
once and be done with it.

##### Layer 2 — Corner-sampling heuristic

On every `<img>` inside a `.gowiki-view` content area, when the page
theme resolves to dark, the frontend:

1. Waits for the image to load (`img.complete === true` or `load` event).
2. Draws it to an offscreen canvas.
3. Samples the pixel at each of the 4 corners.
4. Counts corners where `R + G + B ≥ 720` (near-white).
5. If ≥ 3 of 4 corners are near-white, adds the `gowiki-img-framed`
   class to the `<img>`.

The class applies a soft frame: a cream backdrop (`#f8f8f2`), `4px`
padding, and the theme's small radius. Result: images with white
canvases stop looking like bright holes and start looking like
intentional inserts.

Results are cached per image URL so each image is sampled at most once
per page load. Sampling is skipped when the image has an explicit
`data-bg` attribute (Layer 1 takes precedence).

**Limitations:**
- Requires same-origin images. External hotlinked images can't be
  sampled because canvas taints block pixel reads. They're left
  untreated.
- SVG with an internal `<style>` block won't be affected by the
  heuristic's class (which only changes the `<img>` wrapper). Authors
  who want perfectly dark-mode-safe SVGs should export with
  `currentColor` strokes.
- Photos with lots of sky or bright backgrounds will occasionally trip
  the heuristic. Authors can override with `bg=none` per image.

##### Layer 3 — Admin opt-out

`config.yaml`:

```yaml
themes:
  image_auto_frame: true   # default; set false to disable the heuristic
```

When off, only Layer 1 (explicit `bg=...` on the directive) applies.
Useful for wikis where admins find the heuristic misfires too often and
prefer per-image author control.

#### 11.6.3 Default policy

- **Auto-frame: ON by default.** Most existing wikis benefit; authors
  can opt out per image.
- **Frame color: cream `#f8f8f2`** rather than pure white — softer,
  distinguishes the frame visually from paper-white content.
- **No change in light mode.** Everything in §11.6 activates only when
  the effective theme is `dark`. Light mode renders images as-is.

#### 11.6.4 Documentation surface

`backend/internal/manual/images.md` (or the existing images manual) gets
a section on dark-mode behaviour:

- How the heuristic decides
- The four `bg=` values with visual examples
- When to explicitly set `bg=invert` (SVG diagrams, line drawings)
- Why the heuristic can't be perfect

---

### 11.7 Prerequisites before Tier 1 ships

v1 plugin migration is partial. Before extending the overrides system,
every plugin's CSS string must be audited for hardcoded hex values and
migrated to theme vars. A preset that promises "compact typography" is
only convincing if no plugin renders a hardcoded `#555` in the middle of
it.

Audit lives in `specs/themes-plugin-audit.md` (to be created as part of
the prereq work). Each plugin's row: name, audit status
(pending / clean / intentionally-exempt), last checked date.

---

## 2. CSS custom property contract

Every themeable value is a CSS custom property declared at `:root`. Naming convention: `--gw-<category>-<role>`. Using variables is mandatory in core CSS and all plugin CSS strings. Hardcoded colors outside `/styles/theme/*.css` are treated as a bug.

### 2.1 Color palette (12 vars)

| Variable | Light default | Dark default | Role |
|---|---|---|---|
| `--gw-color-bg` | `#ffffff` | `#1a1a1a` | Page background |
| `--gw-color-surface` | `#fafafa` | `#242424` | Cards, modals, admin panels |
| `--gw-color-text` | `#222222` | `#e6e6e6` | Body text |
| `--gw-color-muted` | `#666666` | `#999999` | Secondary/subtitle text |
| `--gw-color-border` | `#e0e0e0` | `#3a3a3a` | Dividers, card outlines |
| `--gw-color-primary` | `#2d5a47` | `#2e5ba8` | Banner background, accent fills |
| `--gw-color-primary-fg` | `#ffffff` | `#ffffff` | Text on `--gw-color-primary` |
| `--gw-color-link` | `#1e7a5e` | `#80b3ff` | Inline hyperlinks |
| `--gw-color-link-missing` | `#c62828` | `#ff7373` | Links to non-existent pages |
| `--gw-color-success` | `#2e7d32` | `#7fcf88` | Done-state indicators |
| `--gw-color-warning` | `#f57f17` | `#ffb74d` | High-priority chips, overdue |
| `--gw-color-error` | `#c62828` | `#ff6b6b` | Error text, cancelled items |
| `--gw-color-code-bg` | `#f6f8fa` | `#2d2d2d` | Code block backgrounds |
| `--gw-color-code-text` | `#24292e` | `#e6e6e6` | Code text fallback |
| `--gw-color-highlight` | `#fff3bf` | `#5b4e1c` | Search match, `==highlight==` |
| `--gw-color-selection` | `#b5d7ff` | `#264f78` | Text selection (editor) |

Semantic roles (not colors) — each plugin picks the right role rather than the hex.

### 2.2 Typography (6 vars)

| Variable | Default | Role |
|---|---|---|
| `--gw-font-sans` | system UI stack | Body + UI |
| `--gw-font-serif` | Georgia, serif | Optional, serif alternative |
| `--gw-font-mono` | `"JetBrains Mono", monospace` | Code |
| `--gw-font-size-base` | `14px` | Base `body` size |
| `--gw-font-size-h1-mult` | `1.8` | h1 = base × mult |
| `--gw-line-height-base` | `1.55` | Paragraph line-height |

### 2.3 Spacing / density (4 vars)

| Variable | Default | Role |
|---|---|---|
| `--gw-space-xs` | `4px` | Inline chip padding |
| `--gw-space-sm` | `8px` | Button padding, list gaps |
| `--gw-space-md` | `16px` | Default block margin |
| `--gw-space-lg` | `24px` | Section separators |
| `--gw-radius` | `6px` | Corner radius |

### 2.4 Shadows (2 vars)

| Variable | Default | Role |
|---|---|---|
| `--gw-shadow-sm` | `0 1px 3px rgba(0,0,0,0.08)` | Chip hover, tooltip |
| `--gw-shadow-md` | `0 4px 16px rgba(0,0,0,0.25)` | Modals, dropdowns |

---

## 3. Theme storage and application

### 3.1 File layout

```
frontend/
  styles/
    theme/
      base.css          ← declares every --gw-* var with light defaults
      light.css         ← no-op (confirms light is the baseline)
      dark.css          ← overrides the palette with dark values
      admin-overrides.css  ← (generated at runtime, see §4)
```

`base.css` is loaded unconditionally. Theme overrides are applied by attribute selector:

```css
/* In dark.css */
html[data-theme="dark"] {
  --gw-color-bg: #1a1a1a;
  --gw-color-text: #e6e6e6;
  ...
}
```

The frontend sets `html[data-theme]` at boot based on the resolved preference. Switching themes is a single attribute change — no reload, no flash.

### 3.2 Preference resolution

```
user preference  ∈ { light, dark, auto, (unset) }
admin default    ∈ { light, dark, auto }
effective theme  = resolve(user, admin, OS)
```

Resolution order:

1. If the user picked `light` or `dark` explicitly → use it.
2. If the user picked `auto` (or has no preference and admin default is `auto`) → read `window.matchMedia('(prefers-color-scheme: dark)')`.
3. Otherwise → admin default.

The resolver runs once at boot and again whenever:
- The user changes their preference in the profile menu.
- The OS-level `prefers-color-scheme` changes (listener on the media query).

### 3.3 Persistence

- **User preference**: stored on the User record as a string field `theme_preference`. Values: `"light" | "dark" | "auto" | ""`. Saved via `PUT /api/auth/me/preferences`.
- **Fallback for guests**: `localStorage["gowiki-theme"]`. When a guest logs in, the localStorage value is promoted to the user record on first authenticated write.

### 3.4 SSR flash avoidance

A tiny inline `<script>` at the top of `index.html` reads the preference (from localStorage; guests) or from a `user_theme` cookie (set at login) and sets `html[data-theme]` before the first paint. No framework needed — ~20 lines of vanilla JS.

---

## 4. Admin configuration

### 4.1 `config.yaml`

```yaml
themes:
  default: "auto"           # light | dark | auto — applied when user has no preference
  allow_user_override: true # if false, hide the profile toggle and pin default
  palette_overrides:        # any --gw-color-* value can be overridden
    primary: "#5a1a7a"
    primary_fg: "#ffffff"
    link: "#8a2be2"
```

`palette_overrides` accepts any of the keys from §2.1 (without the `--gw-color-` prefix). Keys not present use the built-in theme default.

### 4.2 Runtime injection

When `palette_overrides` is non-empty, the backend serves an additional stylesheet:

```
GET /api/theme/overrides.css
```

Body:

```css
html:not([data-theme="dark"]) {
  --gw-color-primary: #5a1a7a;
  --gw-color-primary-fg: #ffffff;
  --gw-color-link: #8a2be2;
}
```

Only the light theme is overridden by default; operators who want the override to apply to dark too can set `apply_to_dark: true` on each entry (future; v1 applies to light only — admin brand colors rarely work well in dark).

`index.html` pulls this stylesheet after `base.css` and after `dark.css` so its rules cascade last on the light theme.

### 4.3 Admin UI

A new **Themes** tab in the admin panel:
- Select default (light / dark / auto)
- Toggle "allow user override"
- Per-palette-key color picker (rendered from the §2.1 list)
- Live preview pane

Persists to `config.yaml` via the existing admin-config endpoints. No restart required — the frontend re-fetches `/api/theme/overrides.css` after save.

---

## 5. User preference UI

In the user dropdown menu (top-right), add a small radio group or segmented control:

```
Appearance:
  ( ) Light
  ( ) Dark
  (•) Follow system
```

Changing the setting:
1. Immediately updates `html[data-theme]`.
2. `PUT /api/auth/me/preferences` with `{ theme_preference: "..." }`.
3. Updates `localStorage["gowiki-theme"]` as a cache.

Hidden when `themes.allow_user_override == false`.

---

## 6. PDF export

PDF export forces the light theme:

```css
@media print {
  html { color-scheme: light; }
}
```

The frontend's export-mode bootstrap also sets `html.dataset.theme = "light"` before mounting the view, so CSS custom properties resolve to light values regardless of the session's user preference. This matches reader expectation: printed documents are almost always on light paper.

A future `themes.pdf_force_light: true/false` config can make this configurable, but the default is `true` and that's unlikely to change.

---

## 7. Plugin migration

Every plugin that currently registers CSS strings with hardcoded colors must be updated to reference CSS custom properties. Mechanical process:

1. Replace hex colors with the closest semantic var. Examples:
   - `color: #c62828` → `color: var(--gw-color-error)`
   - `background: #e8f0fe` → `background: var(--gw-color-surface)` (or a new dedicated var if the shade is plugin-specific)
2. Where a plugin truly needs its own color (e.g. priority chips with four distinct hues), declare a plugin-scoped var: `--gw-todo-priority-urgent-bg`, and include its default in `base.css`. This keeps the var contract centralized.
3. Fall back safely: `var(--gw-color-link, #1a56db)` so an older bundle without `base.css` still renders.

Migration can be incremental. Plugins that haven't been migrated simply render with hardcoded colors regardless of theme — they still work, just look out of place in dark mode. The core (banner, body, links, modals) must migrate in v1.

Plugin migration checklist per plugin:
- All hex colors replaced
- No new hex colors introduced
- Verified render in both light and dark themes

---

## 8. Edge cases

### 8.1 Syntax highlighting

Code blocks use `highlight.js` with a theme chosen by `site.code_theme`. This is a separate theming axis that survives as-is. The container (background, text color) uses `--gw-color-code-bg` / `--gw-color-code-text`; the syntax tokens use the `highlight.js` theme.

When dark mode is active, the frontend automatically swaps `site.code_theme` to its dark variant if a mapping exists (e.g. `github` → `github-dark`). The mapping is a small hardcoded table.

### 8.2 Embedded images and media

Pages can embed images with transparent backgrounds that were designed for a light canvas. In dark mode, such images can appear invisible or harsh. v1 does not attempt auto-invert; authors can opt into `{image bg="light"}` to force a white backdrop behind the image (future — not in v1).

### 8.3 ProseMirror editor chrome

Editor-specific elements (selection handles, gap cursor, drag-handle icons) need explicit dark-mode treatment. The editor CSS in `pm.css` gets the same var-based refactor as the rest.

### 8.4 Third-party content (mermaid, charts)

Mermaid has its own dark theme (`theme: "dark"`). The mermaid plugin detects the active theme via `document.documentElement.dataset.theme` at render time and passes the right option. Chart.js canvases must be re-rendered on theme change — a simple `window.addEventListener("gowiki:theme-changed", ...)` hook is added and the chart plugin subscribes.

### 8.5 PDF header/footer templates

These use inline CSS because Chrome's print template is isolated. They stay hardcoded to their current muted-gray palette — readable on white paper, unaffected by theme choice.

---

## 9. API surface

New endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/theme/overrides.css` | Serves palette overrides from `config.yaml` (public, cached) |
| `PUT` | `/api/auth/me/preferences` | Saves the user's `theme_preference` (requires auth) |
| `GET` | `/api/auth/me/preferences` | Returns the user's preferences (light/dark/auto) |

Extended endpoints:

| Method | Path | Change |
|---|---|---|
| `GET` | `/api/site/info` | Adds `{ theme: { default, allow_user_override } }` to the response |

---

## 10. Decisions

1. **CSS custom properties, one contract** — A single documented set of `--gw-*` vars. Plugins that respect it are theme-safe for free.

2. **Two built-in themes in v1: light + dark** — They cover 95% of user requests. A third "sepia" or similar can come later with zero breaking changes.

3. **User preference beats admin default** — Users expect to control their appearance. Admins can pin it with `allow_user_override: false` if needed.

4. **PDF always light** — Matches reader expectation; avoids a complete redesign of PDF layout for dark paper.

5. **No runtime theme editing UI in v1** — `config.yaml` edit + admin panel brand-color pickers is enough. A fuller editor (with per-variable live preview) can come after the migration settles.

6. **Theme migration is incremental** — The core ships theme-aware; plugins migrate one at a time. Un-migrated plugins still work, they just don't pick up dark mode.

7. **Brand overrides apply to light only (v1)** — Custom brand colors rarely look good against dark backgrounds without manual tuning. Dark theme remains the "clean dark" variant.

8. **System preference is the default default** — `themes.default: "auto"` is the recommended setting so new installations immediately match visitors' OS.
