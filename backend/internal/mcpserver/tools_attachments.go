package mcpserver

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpsrv "github.com/mark3labs/mcp-go/server"

	"sargon/backend/internal/storage"
)

// Upload / read caps. Keep them intentionally small: an agent that needs a
// bigger blob than this is almost certainly using the wrong tool — a page
// isn't the right place for a 25MB video, and stuffing megabytes of base64
// into a JSON-RPC frame chokes the transport well before the file matters.
const (
	maxAttachmentUploadBytes = 20 * 1024 * 1024 // 20 MB
	maxAttachmentReadBytes   = 512 * 1024       // 512 KB — cap for base64 return
	maxAttachmentTextBytes   = 128 * 1024       // 128 KB — cap for text return
)

// textExtensions lists file extensions that read_attachment will return as
// decoded text (with `format: "text"`). Anything else comes back as base64
// when include_content is set, and only if the file fits under the byte cap.
var textExtensions = map[string]bool{
	".txt":  true,
	".md":   true,
	".csv":  true,
	".tsv":  true,
	".json": true,
	".yaml": true,
	".yml":  true,
	".toml": true,
	".ini":  true,
	".log":  true,
	".xml":  true,
	".svg":  true,
	".html": true,
	".css":  true,
	".js":   true,
	".ts":   true,
	".sh":   true,
	".py":   true,
	".go":   true,
	".sql":  true,
	".conf": true,
	".env":  true,
}

// splitAttachmentPath cleans a caller-supplied attachment path and splits it
// into (namespace, filename). The namespace is canonical — leading and
// trailing slash, "/" at the root — so ns+name is the canonical attachment
// path; the filename is bare (no slashes).
// Refuses empty paths, paths without an extension, and paths that would
// escape the content root.
func splitAttachmentPath(raw string) (ns, name string, err error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", "", errors.New("path is required")
	}
	cleaned := path.Clean("/" + strings.TrimPrefix(trimmed, "/"))
	if cleaned == "/" || cleaned == "." {
		return "", "", errors.New("invalid attachment path")
	}
	name = path.Base(cleaned)
	if name == "" || name == "." || name == "/" {
		return "", "", errors.New("invalid attachment file name")
	}
	if path.Ext(name) == "" {
		return "", "", errors.New("attachments must have a file extension")
	}
	ns = strings.TrimSuffix(cleaned, name)
	return ns, name, nil
}

// The media store keys files and namespaces on paths without the leading
// slash, unlike pages, links and the media reference index. These two
// helpers convert a canonical path at the media-store call, and only there.

// mediaKey converts a canonical attachment path for the media store:
// "/docs/x.png" → "docs/x.png".
func mediaKey(attPath string) string { return strings.TrimPrefix(attPath, "/") }

// mediaNS converts a canonical namespace for the media store:
// "/docs/" → "docs", "/" → "".
func mediaNS(ns string) string { return strings.Trim(ns, "/") }

// detectMime returns a best-effort MIME type for the given filename and
// (optional) content sniff. Falls back to application/octet-stream.
func detectMime(filename string, sniff []byte) string {
	if mt := mimeByExt(filename); mt != "" {
		return mt
	}
	if len(sniff) > 0 {
		return http.DetectContentType(sniff)
	}
	return "application/octet-stream"
}

// mimeByExt covers the extensions the frontend actually serves. Missing entries
// fall through to content sniffing.
func mimeByExt(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".svg":
		return "image/svg+xml"
	case ".pdf":
		return "application/pdf"
	case ".zip":
		return "application/zip"
	case ".txt", ".md", ".log":
		return "text/plain; charset=utf-8"
	case ".csv":
		return "text/csv; charset=utf-8"
	case ".json":
		return "application/json"
	case ".xml":
		return "application/xml"
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".js":
		return "application/javascript"
	case ".mp4":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	}
	return ""
}

// ── list_attachments ──────────────────────────────────────────────────────

func registerListAttachmentsTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("list_attachments",
		mcpgo.WithDescription(
			"List the attachments (non-.md files with an extension) directly under a "+
				"namespace. Returns each file's name, canonical path, size, current "+
				"version, and how many pages currently reference it (0 = orphaned). "+
				"Only immediate children — this does NOT recurse. Namespace ACL is "+
				"honored: caller AND the @ai subject must have 'view' on the namespace.",
		),
		mcpgo.WithString("path",
			mcpgo.Description("Namespace path (leading slash optional). Empty or '/' lists the content root."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Media == nil {
			return errorResult("media store not available"), nil
		}
		nsPath := canonicalNamespaceArg(req.GetString("path", ""))
		if !deps.canView(ctx, nsPath) {
			return errorResult("access denied: no view permission on " + nsPath), nil
		}
		entries, err := deps.Media.List(mediaNS(nsPath))
		if err != nil {
			return errorResult("list attachments: " + err.Error()), nil
		}
		out := make([]map[string]any, 0, len(entries))
		for _, e := range entries {
			// The MediaStore's List returns both files and folders. This tool
			// is about attachments only — folders would just add noise for the
			// agent (list_namespace covers namespace traversal).
			if e.Kind != "file" {
				continue
			}
			row := map[string]any{
				"name":       e.Name,
				"path":       e.Path,
				"size":       e.Size,
				"updated_at": e.UpdatedAt,
				"version":    e.Version,
				"mime":       detectMime(e.Name, nil),
			}
			if deps.MediaRefs != nil {
				refs := deps.MediaRefs.GetReferencingPages(e.Path)
				row["referring_pages"] = refs
				row["referring_count"] = len(refs)
			}
			out = append(out, row)
		}
		return jsonResult(map[string]any{
			"namespace":   nsPath,
			"attachments": out,
			"count":       len(out),
		}), nil
	})
}

// ── read_attachment ───────────────────────────────────────────────────────

func registerReadAttachmentTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("read_attachment",
		mcpgo.WithDescription(
			"Return metadata for an attachment (size, MIME, sha256, current version, "+
				"and the pages that reference it) — always. Three optional ways to "+
				"also get the bytes back:\n"+
				"  • `include_content: true` — inline: UTF-8 text for text-like "+
				"    extensions (.txt, .md, .csv, .json, .yaml, .svg, .log, source "+
				"    files) up to 128 KB (`format: \"text\"`), or base64 for anything "+
				"    else up to 512 KB (`format: \"base64\"`). Over the cap returns "+
				"    metadata only with `content_omitted: true`.\n"+
				"  • `out_dir: \"/abs/path\"` — the server writes the file to disk "+
				"    (same filesystem it reads from) and returns `saved_to`. Preferred "+
				"    for binaries — no inflation, no character mutation through JSON. "+
				"    Combine with the returned `sha256` to verify locally.\n"+
				"  • Neither — metadata only.",
		),
		mcpgo.WithString("path", mcpgo.Required(),
			mcpgo.Description("Attachment path (leading slash optional; must include the file extension, e.g. '/foo/bar/image5.png')."),
		),
		mcpgo.WithBoolean("include_content",
			mcpgo.Description("If true, include the file bytes inline: text-decoded for text extensions, base64 otherwise. Default false = metadata only."),
		),
		mcpgo.WithString("out_dir",
			mcpgo.Description("Absolute directory path on the MCP server's filesystem. When set, the file is written to <out_dir>/<attachment name> and the response returns `saved_to`. Mutually exclusive with include_content."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Media == nil {
			return errorResult("media store not available"), nil
		}
		rawPath := req.GetString("path", "")
		ns, name, err := splitAttachmentPath(rawPath)
		if err != nil {
			return errorResult(err.Error()), nil
		}
		attPath := ns + name
		if !deps.canView(ctx, attPath) {
			return errorResult("access denied: no view permission on " + attPath), nil
		}
		diskPath, err := deps.Media.ResolvePath(mediaKey(attPath))
		if err != nil {
			return errorResult("resolve attachment: " + err.Error()), nil
		}
		info, statErr := os.Stat(diskPath)
		if errors.Is(statErr, os.ErrNotExist) {
			return errorResult("attachment not found: " + attPath), nil
		}
		if statErr != nil {
			return errorResult("stat attachment: " + statErr.Error()), nil
		}
		if info.IsDir() {
			return errorResult("path resolves to a namespace, not an attachment: " + attPath), nil
		}

		// Load the bytes once — we need them for the sha256 anyway. Skip when
		// the file exceeds the inline cap AND no on-disk out_dir was asked
		// for; in that case metadata-only is the best we can offer.
		outDir := strings.TrimSpace(req.GetString("out_dir", ""))
		includeContent := req.GetBool("include_content", false)
		if outDir != "" && includeContent {
			return errorResult("pass either include_content or out_dir, not both"), nil
		}

		result := map[string]any{
			"path":       attPath,
			"name":       name,
			"namespace":  ns,
			"size":       info.Size(),
			"updated_at": info.ModTime().UTC(),
			"mime":       detectMime(name, nil),
		}
		if deps.MediaVersions != nil {
			result["version"] = deps.MediaVersions.GetVersion(mediaKey(attPath))
		}
		if deps.MediaRefs != nil {
			// The ref index stores media keys canonically (leading slash);
			// MediaVersions stores them without. Pass the right shape to each.
			refs := deps.MediaRefs.GetReferencingPages(attPath)
			result["referring_pages"] = refs
			result["referring_count"] = len(refs)
		}

		// Reading the file once and hashing gives the caller a way to verify
		// any subsequent operation on the same bytes. The cap here is on the
		// server's own disk read — we always own the bytes, but a huge file
		// stat'd for sha256 should not block the request thread indefinitely.
		const sha256Cap = int64(64 * 1024 * 1024) // 64 MB
		var raw []byte
		if info.Size() <= sha256Cap {
			data, readErr := os.ReadFile(diskPath)
			if readErr != nil {
				return errorResult("read attachment: " + readErr.Error()), nil
			}
			raw = data
			digest := sha256.Sum256(raw)
			result["sha256"] = hex.EncodeToString(digest[:])
		}

		// out_dir path: server-side save, no bytes through JSON.
		if outDir != "" {
			if !filepath.IsAbs(outDir) {
				return errorResult("out_dir must be absolute"), nil
			}
			if err := os.MkdirAll(outDir, 0o755); err != nil {
				return errorResult("mkdir out_dir: " + err.Error()), nil
			}
			savedTo := filepath.Join(outDir, name)
			if raw == nil {
				// Very large file we didn't hash — stream copy.
				src, oe := os.Open(diskPath)
				if oe != nil {
					return errorResult("open source: " + oe.Error()), nil
				}
				dst, ce := os.Create(savedTo)
				if ce != nil {
					src.Close()
					return errorResult("create out_dir file: " + ce.Error()), nil
				}
				if _, ce = io.Copy(dst, src); ce != nil {
					src.Close()
					dst.Close()
					return errorResult("copy to out_dir: " + ce.Error()), nil
				}
				src.Close()
				if ce = dst.Close(); ce != nil {
					return errorResult("close out_dir file: " + ce.Error()), nil
				}
			} else if err := os.WriteFile(savedTo, raw, 0o644); err != nil {
				return errorResult("write out_dir file: " + err.Error()), nil
			}
			result["saved_to"] = savedTo
			return jsonResult(result), nil
		}

		if !includeContent {
			return jsonResult(result), nil
		}

		// Text vs binary decision. .svg is text-shaped despite the image/*
		// MIME, so it goes down the text path.
		isText := textExtensions[strings.ToLower(path.Ext(name))]
		cap := int64(maxAttachmentReadBytes)
		if isText {
			cap = maxAttachmentTextBytes
		}
		if info.Size() > cap {
			result["content_omitted"] = true
			result["content_omitted_reason"] = fmt.Sprintf(
				"file is %d bytes; over the %d-byte cap for %s content — call again with out_dir to save it to disk instead",
				info.Size(), cap,
				map[bool]string{true: "text", false: "binary"}[isText],
			)
			return jsonResult(result), nil
		}
		if raw == nil {
			data, readErr := os.ReadFile(diskPath)
			if readErr != nil {
				return errorResult("read attachment: " + readErr.Error()), nil
			}
			raw = data
		}
		if isText {
			if !utf8.Valid(raw) {
				result["content_omitted"] = true
				result["content_omitted_reason"] = "file has a text-like extension but is not valid UTF-8; call again with out_dir to save it as raw bytes"
				return jsonResult(result), nil
			}
			result["content"] = string(raw)
			result["format"] = "text"
		} else {
			result["content"] = base64.StdEncoding.EncodeToString(raw)
			result["format"] = "base64"
		}
		return jsonResult(result), nil
	})
}

// ── upload_attachment ─────────────────────────────────────────────────────

func registerUploadAttachmentTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("upload_attachment",
		mcpgo.WithDescription(
			"Create or replace an attachment at `path`. The body is sent as base64 "+
				"through this JSON-RPC call — that's the only MCP-native transport, "+
				"but the string channel is NOT reliable for binaries past a handful "+
				"of KB (a dropped multiple-of-4 run of characters stays syntactically "+
				"valid and decodes to a shorter file without any error). For anything "+
				"larger, call `upload_attachment_instructions` and use the returned "+
				"HTTP multipart command instead — same auth, real binary transport, "+
				"no size ceiling.\n"+
				"\n"+
				"Integrity gates: pass `sha256` (hex, decoded-bytes digest) and/or "+
				"`size_bytes` — the write is refused on mismatch. The response always "+
				"returns `sha256` and `size` so a caller can verify. Silent "+
				"truncation is what these are for; use them whenever you care about "+
				"byte-exactness.\n"+
				"\n"+
				"Rules: path must include a file extension (extension-less files "+
				"under content/ are forbidden). Refuses if a file exists unless "+
				"overwrite=true — the previous version is archived to the media "+
				"attic and the version counter increments. Same edit-permission "+
				"gate as write_page (caller + @ai edit on the target namespace). "+
				"Hard cap: 20 MB after decode.",
		),
		mcpgo.WithString("path", mcpgo.Required(),
			mcpgo.Description("Full attachment path with extension (e.g. '/regulatory/qms/qara/ins01/image21.png'). Leading slash optional."),
		),
		mcpgo.WithString("content_base64", mcpgo.Required(),
			mcpgo.Description("File body encoded as standard base64 (no data: prefix, no line wrapping required)."),
		),
		mcpgo.WithString("sha256",
			mcpgo.Description("Optional SHA-256 digest (hex) of the decoded bytes. The write is refused when it does not match."),
		),
		mcpgo.WithNumber("size_bytes",
			mcpgo.Description("Optional expected byte length after decode. The write is refused when it does not match."),
		),
		mcpgo.WithBoolean("overwrite",
			mcpgo.Description("Replace an existing file at this path. Default false — a call to an existing path is refused."),
		),
		mcpgo.WithString("summary", mcpgo.Required(),
			mcpgo.Description("Change summary. Required for audit. Format: '[AI: <tool-name>] <description>'."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Media == nil {
			return errorResult("media store not available"), nil
		}
		ns, name, err := splitAttachmentPath(req.GetString("path", ""))
		if err != nil {
			return errorResult(err.Error()), nil
		}
		summary := strings.TrimSpace(req.GetString("summary", ""))
		if deps.RequireSummary && summary == "" {
			return errorResult("summary is required — format '[AI: <tool>] <description>'"), nil
		}
		if !deps.canEdit(ctx, ns) {
			return errorResult("access denied: no edit permission on " + ns), nil
		}

		b64 := strings.TrimSpace(req.GetString("content_base64", ""))
		if b64 == "" {
			return errorResult("content_base64 is required — call upload_attachment_instructions for the HTTP multipart route on larger files"), nil
		}
		// Guard against absurd payloads BEFORE decoding to avoid a base64
		// blow-up doubling as an OOM. base64 encodes ~4/3 bytes per byte of
		// input, so cap the encoded length too.
		if int64(len(b64)) > int64(maxAttachmentUploadBytes)*2 {
			return errorResult(fmt.Sprintf("content_base64 too large (%d chars); cap is %d bytes after decode", len(b64), maxAttachmentUploadBytes)), nil
		}
		raw, decodeErr := base64.StdEncoding.DecodeString(b64)
		if decodeErr != nil {
			// Try URL-safe alphabet too — some clients emit it by default.
			raw, decodeErr = base64.URLEncoding.DecodeString(b64)
		}
		if decodeErr != nil {
			return errorResult("decode content_base64: " + decodeErr.Error()), nil
		}
		if int64(len(raw)) > int64(maxAttachmentUploadBytes) {
			return errorResult(fmt.Sprintf("decoded body is %d bytes; cap is %d bytes", len(raw), maxAttachmentUploadBytes)), nil
		}

		digest := sha256.Sum256(raw)
		digestHex := hex.EncodeToString(digest[:])

		// Integrity checks. Both are optional; if either is supplied it MUST
		// match. Silent truncation was the whole point of adding these.
		if expected := strings.ToLower(strings.TrimSpace(req.GetString("sha256", ""))); expected != "" {
			if expected != digestHex {
				return errorResult(fmt.Sprintf(
					"sha256 mismatch: server computed %s over %d decoded bytes; caller expected %s — the payload was corrupted in transit",
					digestHex, len(raw), expected,
				)), nil
			}
		}
		if expectedSize := req.GetInt("size_bytes", 0); expectedSize > 0 {
			if int64(expectedSize) != int64(len(raw)) {
				return errorResult(fmt.Sprintf(
					"size_bytes mismatch: server got %d decoded bytes; caller expected %d — the payload was corrupted in transit",
					len(raw), expectedSize,
				)), nil
			}
		}

		overwrite := req.GetBool("overwrite", false)
		author := deps.ExtractUsername(ctx)
		// The media attic (MediaAtticEntry) has no Summary field today,
		// so there's nowhere clean to store the caller's summary and
		// pre-concatenating it into `author` would pollute the author
		// column everywhere media history is displayed. Drop the summary
		// from the attic entry — accepted trade-off; a MediaAtticEntry.Summary
		// field + MediaAttic.ArchiveWithSummary is a separate refactor.
		_ = summary
		entry, putErr := deps.Media.Put(mediaNS(ns), name, bytes.NewReader(raw), overwrite, author)
		if errors.Is(putErr, storage.ErrMediaConflict) {
			return errorResult("attachment already exists at " + ns + name + " — pass overwrite: true to replace it"), nil
		}
		if putErr != nil {
			return errorResult("upload attachment: " + putErr.Error()), nil
		}
		sniffLen := 512
		if len(raw) < sniffLen {
			sniffLen = len(raw)
		}
		result := map[string]any{
			"path":       entry.Path,
			"name":       entry.Name,
			"namespace":  ns,
			"size":       entry.Size,
			"sha256":     digestHex,
			"version":    entry.Version,
			"updated_at": entry.UpdatedAt,
			"mime":       detectMime(entry.Name, raw[:sniffLen]),
			"overwrote":  overwrite,
		}
		return jsonResult(result), nil
	})
}

// ── upload_attachment_instructions ────────────────────────────────────────

func registerUploadAttachmentInstructionsTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("upload_attachment_instructions",
		mcpgo.WithDescription(
			"Return a ready-to-run HTTP multipart upload command for an attachment. "+
				"Use this instead of `upload_attachment` for any binary bigger than a "+
				"handful of KB — the MCP JSON channel isn't a reliable transport for "+
				"binary bytes, but the wiki's own /api/media endpoint is (same "+
				"bearer-token auth as MCP, no size ceiling apart from the 20 MB "+
				"backend cap).\n"+
				"\n"+
				"The tool doesn't upload anything — it validates the target path, "+
				"checks edit permission upfront, tells you whether a file already "+
				"exists at that path (so you know if you need overwrite=true), and "+
				"hands back the exact `curl -F` command you should run from your own "+
				"shell. Fill in your local file path and set SARGON_TOKEN with a "+
				"valid API bearer token (see /wiki/manual/admin-tokens).",
		),
		mcpgo.WithString("path", mcpgo.Required(),
			mcpgo.Description("Full attachment path with extension. The filename part becomes the target name in the wiki."),
		),
		mcpgo.WithBoolean("overwrite",
			mcpgo.Description("Include overwrite=true in the multipart form. Default false. Use when replacing an existing file."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		ns, name, err := splitAttachmentPath(req.GetString("path", ""))
		if err != nil {
			return errorResult(err.Error()), nil
		}
		attPath := ns + name
		overwrite := req.GetBool("overwrite", false)

		canWrite := deps.canEdit(ctx, ns)

		exists := false
		if deps.Media != nil {
			if disk, resolveErr := deps.Media.ResolvePath(mediaKey(attPath)); resolveErr == nil {
				if info, statErr := os.Stat(disk); statErr == nil && !info.IsDir() {
					exists = true
				}
			}
		}

		baseURL := strings.TrimRight(deps.SiteBaseURL, "/")
		hostNote := ""
		if baseURL == "" {
			baseURL = "https://<your-wiki-host>"
			hostNote = "the server's base_url is not configured; replace <your-wiki-host> with the hostname you use to reach the wiki"
		}
		uploadURL := baseURL + "/api/media/" + mediaNS(ns)

		// Build the curl command. We keep --fail-with-body so HTTP 4xx/5xx
		// causes a non-zero exit AND still prints the server's error body,
		// which makes agent retries actually diagnosable.
		var cmd strings.Builder
		cmd.WriteString("curl --fail-with-body \\\n")
		cmd.WriteString("  -H \"Authorization: Bearer $SARGON_TOKEN\" \\\n")
		cmd.WriteString("  -F \"file=@<local-path>;filename=" + name + "\" \\\n")
		if overwrite {
			cmd.WriteString("  -F \"overwrite=true\" \\\n")
		}
		cmd.WriteString("  " + shellQuote(uploadURL))

		warnings := []string{}
		if !canWrite {
			warnings = append(warnings, "you do not currently have edit permission on "+ns+" — the upload will 403")
		}
		if exists && !overwrite {
			warnings = append(warnings, "a file already exists at "+attPath+" — the upload will 409 unless you pass overwrite=true")
		}
		if !exists && overwrite {
			warnings = append(warnings, "overwrite=true was requested but no file exists at "+attPath+" yet — it will just be created")
		}
		if hostNote != "" {
			warnings = append(warnings, hostNote)
		}

		result := map[string]any{
			"target_path":    attPath,
			"target_name":    name,
			"namespace":      ns,
			"upload_url":     uploadURL,
			"method":         "POST",
			"form_field":     "file",
			"multipart_form": buildMultipartFormPreview(name, overwrite),
			"auth_header":    "Authorization: Bearer <api-token>",
			"curl_command":   cmd.String(),
			"can_write":      canWrite,
			"exists":         exists,
			"overwrite":      overwrite,
			"warnings":       warnings,
			"note": "The command uses --fail-with-body so a non-2xx response exits non-zero AND prints the server error. " +
				"After a successful upload the response body is JSON: {\"entry\": {\"path\": ..., \"version\": ..., \"size\": ...}}; " +
				"if you care about byte-exactness verify sha256 via read_attachment afterwards. " +
				"For files under a few KB the MCP-native upload_attachment tool is fine.",
		}
		return jsonResult(result), nil
	})
}

// buildMultipartFormPreview describes the fields the endpoint reads, so the
// caller can adapt the command to a language other than curl (Python's
// requests, etc.) without having to reverse-engineer the shape.
func buildMultipartFormPreview(filename string, overwrite bool) []map[string]any {
	fields := []map[string]any{
		{
			"name":     "file",
			"type":     "file",
			"filename": filename,
			"note":     "The multipart part's filename becomes the attachment name in the wiki — must match target_name.",
		},
	}
	if overwrite {
		fields = append(fields, map[string]any{
			"name":  "overwrite",
			"type":  "text",
			"value": "true",
			"note":  "Any truthy value (true/on/yes/1) enables overwrite; omit or set to false to refuse when a file already exists.",
		})
	}
	return fields
}

// shellQuote wraps a value in single quotes for safe pasting into a POSIX
// shell. Only used on the target URL, which we control — but we still guard
// against any embedded quote we might introduce someday.
func shellQuote(s string) string {
	if !strings.ContainsAny(s, " \t\n'\"$`\\") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

// ── delete_attachment ─────────────────────────────────────────────────────

func registerDeleteAttachmentTool(srv *mcpsrv.MCPServer, deps Deps) {
	tool := mcpgo.NewTool("delete_attachment",
		mcpgo.WithDescription(
			"Delete an attachment. By default the call is refused when any page "+
				"still references the file (the referring pages are returned so the "+
				"caller can rewrite them first). Pass force=true to delete a file "+
				"that is still referenced — links pointing at it will 404 until they "+
				"are rewritten or the file is restored from the media attic. Requires "+
				"'delete' permission on the target namespace for both the caller and "+
				"the @ai subject.",
		),
		mcpgo.WithString("path", mcpgo.Required(),
			mcpgo.Description("Attachment path with extension (leading slash optional)."),
		),
		mcpgo.WithBoolean("force",
			mcpgo.Description("Delete even if pages still reference this attachment. Default false — refusal returns the referring page list."),
		),
	)
	srv.AddTool(tool, func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
		if deps.Media == nil {
			return errorResult("media store not available"), nil
		}
		ns, name, err := splitAttachmentPath(req.GetString("path", ""))
		if err != nil {
			return errorResult(err.Error()), nil
		}
		attPath := ns + name
		if !deps.canDelete(ctx, ns) {
			return errorResult("access denied: no delete permission on " + ns), nil
		}
		force := req.GetBool("force", false)
		var referring []string
		if deps.MediaRefs != nil {
			// Ref index keys are canonical (leading slash).
			referring = deps.MediaRefs.GetReferencingPages(attPath)
		}
		if len(referring) > 0 && !force {
			return jsonResult(map[string]any{
				"deleted":         false,
				"path":            attPath,
				"referring_pages": referring,
				"reason":          "attachment is still referenced; rewrite those pages first, or pass force: true to delete anyway",
			}), nil
		}
		delErr := deps.Media.Delete(mediaKey(attPath))
		if errors.Is(delErr, os.ErrNotExist) {
			return errorResult("attachment not found: " + attPath), nil
		}
		if delErr != nil {
			return errorResult("delete attachment: " + delErr.Error()), nil
		}
		return jsonResult(map[string]any{
			"deleted":         true,
			"path":            attPath,
			"referring_pages": referring,
			"forced":          force && len(referring) > 0,
		}), nil
	})
}
