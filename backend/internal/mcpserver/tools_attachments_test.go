package mcpserver

import "testing"

func TestSplitAttachmentPath(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		wantNs  string
		wantFn  string
		wantErr string
	}{
		{name: "flat file", in: "/foo/bar.png", wantNs: "/foo/", wantFn: "bar.png"},
		{name: "deep file", in: "/a/b/c/d.jpg", wantNs: "/a/b/c/", wantFn: "d.jpg"},
		{name: "leading slash optional", in: "foo/bar.png", wantNs: "/foo/", wantFn: "bar.png"},
		{name: "root-level file", in: "/logo.svg", wantNs: "/", wantFn: "logo.svg"},
		{name: "collapses double slashes", in: "//a///b.png", wantNs: "/a/", wantFn: "b.png"},
		{name: "empty rejected", in: "", wantErr: "path is required"},
		{name: "root rejected", in: "/", wantErr: "invalid attachment path"},
		{name: "trailing-slash-only rejected", in: "/foo/", wantErr: "must have a file extension"},
		{name: "no-extension rejected", in: "/foo/bar", wantErr: "must have a file extension"},
		{name: "dot-only name normalizes to no-extension error", in: "/foo/.", wantErr: "must have a file extension"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ns, fn, err := splitAttachmentPath(tc.in)
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("want error containing %q, got nil (ns=%q fn=%q)", tc.wantErr, ns, fn)
				}
				if !contains(err.Error(), tc.wantErr) {
					t.Fatalf("want error containing %q, got %q", tc.wantErr, err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if ns != tc.wantNs || fn != tc.wantFn {
				t.Fatalf("got (ns=%q, fn=%q), want (ns=%q, fn=%q)", ns, fn, tc.wantNs, tc.wantFn)
			}
		})
	}
}

func TestShellQuote(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"https://wiki.example.com/api/media/foo/bar", "https://wiki.example.com/api/media/foo/bar"},
		{"has space", "'has space'"},
		{"tricky ' quote", `'tricky '"'"' quote'`},
		{"backtick`inside", "'backtick`inside'"},
	}
	for _, tc := range cases {
		if got := shellQuote(tc.in); got != tc.want {
			t.Errorf("shellQuote(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestDetectMime(t *testing.T) {
	cases := []struct {
		name  string
		file  string
		sniff []byte
		want  string
	}{
		{name: "png by extension", file: "foo.png", want: "image/png"},
		{name: "jpg by extension", file: "IMG.JPG", want: "image/jpeg"},
		{name: "csv by extension", file: "data.csv", want: "text/csv; charset=utf-8"},
		{name: "unknown ext, no sniff", file: "blob.xyz", want: "application/octet-stream"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := detectMime(tc.file, tc.sniff)
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func contains(haystack, needle string) bool {
	if needle == "" {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
