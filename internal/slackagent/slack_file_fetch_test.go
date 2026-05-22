package slackagent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newFileStubTransport(file slackImageFileBody, body []byte, status int, sawAuth *bool) http.RoundTripper {
	return roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		if strings.Contains(req.URL.String(), "files.info") {
			payload, _ := json.Marshal(map[string]any{"ok": true, "file": file})
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(strings.NewReader(string(payload))),
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Request:    req,
			}, nil
		}
		if sawAuth != nil && req.Header.Get("Authorization") == "Bearer xoxb-test" {
			*sawAuth = true
		}
		return &http.Response{
			StatusCode: status,
			Body:       io.NopCloser(strings.NewReader(string(body))),
			Header:     http.Header{"Content-Type": []string{firstNonEmpty(file.Mimetype, "application/octet-stream")}},
			Request:    req,
		}, nil
	})
}

func TestActionFetchFileDownloadsNonImageToWorkspaceArtifact(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	var sawAuth bool
	transport := newFileStubTransport(
		slackImageFileBody{
			ID:                 "FVID",
			Name:               "timeout.mov",
			Title:              "timeout.mov",
			Mimetype:           "video/quicktime",
			Filetype:           "mov",
			Size:               14,
			Permalink:          "https://slack.example/files/FVID",
			URLPrivateDownload: "https://files.slack.example/FVID.mov",
		},
		[]byte("fake-mov-bytes"),
		200,
		&sawAuth,
	)
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		workspaceDir:  workspaceDir,
		httpTransport: transport,
	}

	result := tool.actionFetchFile(context.Background(), map[string]any{"file_id": "FVID"})
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Text)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Text), &decoded); err != nil {
		t.Fatalf("decode: %v (%q)", err, result.Text)
	}
	if !sawAuth {
		t.Fatalf("expected protected file download to include bot token")
	}
	if decoded["file_id"] != "FVID" || decoded["mimetype"] != "video/quicktime" {
		t.Fatalf("decoded metadata = %#v", decoded)
	}
	if _, ok := decoded["url"]; ok {
		t.Fatalf("protected Slack URL should not be exposed to workers: %#v", decoded["url"])
	}
	if omitted, _ := decoded["protected_url_omitted"].(bool); !omitted {
		t.Fatalf("expected protected_url_omitted=true")
	}
	if access, _ := decoded["url_access"].(string); access != "slack_bot_token_required" {
		t.Fatalf("url_access = %q, want slack_bot_token_required", access)
	}
	localPath, _ := decoded["local_path"].(string)
	if localPath == "" {
		t.Fatalf("local_path missing from result: %#v", decoded)
	}
	if !pathWithinRoot(filepath.Join(workspaceDir, ".tmp", "slack-file-fetch"), localPath) {
		t.Fatalf("local_path %q not inside workspace file-fetch artifact dir", localPath)
	}
	raw, err := os.ReadFile(localPath)
	if err != nil {
		t.Fatalf("read artifact: %v", err)
	}
	if string(raw) != "fake-mov-bytes" {
		t.Fatalf("artifact bytes = %q", string(raw))
	}
	if inline, _ := decoded["inline"].(bool); inline {
		t.Fatalf("expected inline=false by default for generic files")
	}
}

func TestActionFetchFileCanInlineSmallFileWhenExplicitlyRequested(t *testing.T) {
	t.Parallel()

	transport := newFileStubTransport(
		slackImageFileBody{
			ID:                 "FTXT",
			Name:               "notes.txt",
			Mimetype:           "text/plain",
			Filetype:           "text",
			URLPrivateDownload: "https://files.slack.example/notes.txt",
		},
		[]byte("hello worker"),
		200,
		nil,
	)
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		workspaceDir:  t.TempDir(),
		httpTransport: transport,
	}

	result := tool.actionFetchFile(context.Background(), map[string]any{
		"file_id": "FTXT",
		"inline":  true,
	})
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Text)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Text), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if inline, _ := decoded["inline"].(bool); !inline {
		t.Fatalf("expected inline=true, got %#v", decoded)
	}
	encoded, _ := decoded["base64"].(string)
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("decode base64: %v", err)
	}
	if string(raw) != "hello worker" {
		t.Fatalf("decoded bytes = %q", string(raw))
	}
	if _, ok := decoded["url"]; ok {
		t.Fatalf("protected Slack URL should not be exposed to workers: %#v", decoded["url"])
	}
	if omitted, _ := decoded["protected_url_omitted"].(bool); !omitted {
		t.Fatalf("expected protected_url_omitted=true")
	}
}

func TestActionFetchFileDownloadFalseOmitsProtectedURL(t *testing.T) {
	t.Parallel()

	calls := 0
	transport := roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if strings.Contains(req.URL.String(), "files.info") {
			payload, _ := json.Marshal(map[string]any{
				"ok": true,
				"file": slackImageFileBody{
					ID:                 "FMETA",
					Name:               "notes.pdf",
					Mimetype:           "application/pdf",
					Filetype:           "pdf",
					URLPrivateDownload: "https://files.slack.example/notes.pdf",
				},
			})
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(strings.NewReader(string(payload))),
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Request:    req,
			}, nil
		}
		return &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(strings.NewReader("pdf")),
			Header:     http.Header{"Content-Type": []string{"application/pdf"}},
			Request:    req,
		}, nil
	})
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		workspaceDir:  t.TempDir(),
		httpTransport: transport,
	}

	result := tool.actionFetchFile(context.Background(), map[string]any{
		"file_id":  "FMETA",
		"download": false,
	})
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Text)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Text), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if downloaded, _ := decoded["downloaded"].(bool); downloaded {
		t.Fatalf("expected downloaded=false when download=false")
	}
	if _, ok := decoded["url"]; ok {
		t.Fatalf("protected Slack URL should not be exposed to workers: %#v", decoded["url"])
	}
	if omitted, _ := decoded["protected_url_omitted"].(bool); !omitted {
		t.Fatalf("expected protected_url_omitted=true")
	}
	if calls != 1 {
		t.Fatalf("expected exactly 1 HTTP call (files.info only), got %d", calls)
	}
}

func TestActionFetchFileRejectsOverCapDownload(t *testing.T) {
	t.Parallel()

	transport := newFileStubTransport(
		slackImageFileBody{
			ID:                 "FBIG",
			Name:               "big.mov",
			Mimetype:           "video/quicktime",
			Filetype:           "mov",
			URLPrivateDownload: "https://files.slack.example/big.mov",
		},
		[]byte(strings.Repeat("x", 16)),
		200,
		nil,
	)
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		workspaceDir:  t.TempDir(),
		httpTransport: transport,
	}

	result := tool.actionFetchFile(context.Background(), map[string]any{
		"file_id":   "FBIG",
		"max_bytes": 8,
	})
	if result.Success {
		t.Fatalf("expected over-cap file to fail, got %q", result.Text)
	}
	if !strings.Contains(result.Text, "safety cap") {
		t.Fatalf("expected safety cap error, got %q", result.Text)
	}
}

func TestActionFetchFileRequiresFileID(t *testing.T) {
	t.Parallel()

	tool := &slackAPITool{role: slackAPIRoleAssistant}
	result := tool.actionFetchFile(context.Background(), map[string]any{})
	if result.Success {
		t.Fatalf("expected missing file_id to fail")
	}
	if !strings.Contains(result.Text, "file_id is required") {
		t.Fatalf("expected actionable error, got %q", result.Text)
	}
}
