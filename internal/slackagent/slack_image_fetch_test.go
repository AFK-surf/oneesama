package slackagent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func newImageStubTransport(file slackImageFileBody, body []byte, status int) http.RoundTripper {
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
		return &http.Response{
			StatusCode: status,
			Body:       io.NopCloser(strings.NewReader(string(body))),
			Header:     http.Header{"Content-Type": []string{file.Mimetype}},
			Request:    req,
		}, nil
	})
}

func TestActionFetchImageReturnsInlineBase64ForSmallFile(t *testing.T) {
	transport := newImageStubTransport(
		slackImageFileBody{
			ID:                 "F1",
			Name:               "screenshot.png",
			Title:              "Screenshot",
			Mimetype:           "image/png",
			Filetype:           "png",
			Size:               12,
			Permalink:          "https://slack.example/files/F1",
			URLPrivateDownload: "https://files.slack.example/F1.png",
		},
		[]byte("png-bytes-12"),
		200,
	)
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		httpTransport: transport,
		workspaceDir:  t.TempDir(),
	}
	result := tool.actionFetchImage(context.Background(), map[string]any{"file_id": "F1"})
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Text)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Text), &decoded); err != nil {
		t.Fatalf("decode: %v (%q)", err, result.Text)
	}
	if inline, _ := decoded["inline"].(bool); !inline {
		t.Fatalf("expected inline=true, got %+v", decoded["inline"])
	}
	if decoded["mimetype"] != "image/png" {
		t.Fatalf("mimetype = %v, want image/png", decoded["mimetype"])
	}
	encoded, _ := decoded["base64"].(string)
	if encoded == "" {
		t.Fatalf("expected base64 to be populated")
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("decode base64: %v", err)
	}
	if string(raw) != "png-bytes-12" {
		t.Fatalf("decoded bytes = %q, want png-bytes-12", string(raw))
	}
	if dataURL, _ := decoded["mime_data_url"].(string); !strings.HasPrefix(dataURL, "data:image/png;base64,") {
		t.Fatalf("mime_data_url missing image/png prefix: %q", dataURL)
	}
	if localPath, _ := decoded["local_path"].(string); strings.TrimSpace(localPath) == "" {
		t.Fatalf("expected downloaded local_path to be populated")
	}
}

func TestActionFetchImageDownloadsLocalArtifactWhenOverInlineBudget(t *testing.T) {
	big := strings.Repeat("x", 4096)
	workspaceDir := t.TempDir()
	transport := newImageStubTransport(
		slackImageFileBody{
			ID:                 "F2",
			Name:               "large image.png",
			Mimetype:           "image/png",
			Filetype:           "png",
			URLPrivateDownload: "https://files.slack.example/F2.png",
		},
		[]byte(big),
		200,
	)
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		httpTransport: transport,
		workspaceDir:  workspaceDir,
	}
	result := tool.actionFetchImage(context.Background(), map[string]any{
		"file_id":      "F2",
		"inline_limit": 256,
	})
	if !result.Success {
		t.Fatalf("expected success even when inline budget overflows, got %q", result.Text)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Text), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if inline, _ := decoded["inline"].(bool); inline {
		t.Fatalf("expected inline=false for over-budget download, got %+v", decoded["inline"])
	}
	if downloaded, _ := decoded["downloaded"].(bool); !downloaded {
		t.Fatalf("expected downloaded=true for over-budget image")
	}
	localPath, _ := decoded["local_path"].(string)
	if !strings.Contains(localPath, "/.tmp/slack-file-fetch/") {
		t.Fatalf("expected local_path inside slack-file-fetch artifact dir, got %q", localPath)
	}
	raw, err := os.ReadFile(localPath)
	if err != nil {
		t.Fatalf("read local_path: %v", err)
	}
	if string(raw) != big {
		t.Fatalf("downloaded bytes mismatch")
	}
	if access, _ := decoded["url_access"].(string); access != "slack_bot_token_required" {
		t.Fatalf("url_access = %q, want slack_bot_token_required", access)
	}
	reason, _ := decoded["inline_skipped_reason"].(string)
	if !strings.Contains(reason, "inline budget") || !strings.Contains(reason, "local_path") {
		t.Fatalf("expected reason to mention inline budget and local_path, got %q", reason)
	}
}

func TestActionFetchImageRejectsNonImageMimetype(t *testing.T) {
	transport := newImageStubTransport(
		slackImageFileBody{
			ID:                 "F3",
			Mimetype:           "application/pdf",
			Filetype:           "pdf",
			URLPrivateDownload: "https://files.slack.example/F3",
		},
		[]byte("pdf"),
		200,
	)
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		httpTransport: transport,
		workspaceDir:  t.TempDir(),
	}
	result := tool.actionFetchImage(context.Background(), map[string]any{"file_id": "F3"})
	if result.Success {
		t.Fatalf("expected non-image rejection, got success: %q", result.Text)
	}
	if !strings.Contains(result.Text, "is not an image") {
		t.Fatalf("expected error to mention non-image, got %q", result.Text)
	}
}

func TestActionFetchImageHonorsInlineFalseFlag(t *testing.T) {
	calls := 0
	transport := roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if strings.Contains(req.URL.String(), "files.info") {
			payload, _ := json.Marshal(map[string]any{
				"ok": true,
				"file": slackImageFileBody{
					ID:                 "F4",
					Mimetype:           "image/jpeg",
					Filetype:           "jpg",
					URLPrivateDownload: "https://files.slack.example/F4.jpg",
				},
			})
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(payload))), Header: http.Header{}}, nil
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("jpeg-bytes")), Header: http.Header{}}, nil
	})
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		httpTransport: transport,
	}
	result := tool.actionFetchImage(context.Background(), map[string]any{
		"file_id": "F4",
		"inline":  false,
	})
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Text)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Text), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if inline, _ := decoded["inline"].(bool); inline {
		t.Fatalf("expected inline=false when explicitly opted out")
	}
	if _, ok := decoded["base64"]; ok {
		t.Fatalf("expected base64 to be absent when inline=false")
	}
	if downloaded, _ := decoded["downloaded"].(bool); !downloaded {
		t.Fatalf("expected inline=false to still download a local_path")
	}
	if localPath, _ := decoded["local_path"].(string); strings.TrimSpace(localPath) == "" {
		t.Fatalf("local_path missing from result: %#v", decoded)
	}
	if calls != 2 {
		t.Fatalf("expected files.info + image download, got %d", calls)
	}
}

func TestActionFetchImageDownloadFalseReturnsMetadataOnly(t *testing.T) {
	calls := 0
	transport := roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if strings.Contains(req.URL.String(), "files.info") {
			payload, _ := json.Marshal(map[string]any{
				"ok": true,
				"file": slackImageFileBody{
					ID:                 "F5",
					Mimetype:           "image/jpeg",
					Filetype:           "jpg",
					URLPrivateDownload: "https://files.slack.example/F5.jpg",
				},
			})
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(payload))), Header: http.Header{}}, nil
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("jpeg-bytes")), Header: http.Header{}}, nil
	})
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		httpTransport: transport,
		workspaceDir:  t.TempDir(),
	}
	result := tool.actionFetchImage(context.Background(), map[string]any{
		"file_id":  "F5",
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
	if localPath, _ := decoded["local_path"].(string); strings.TrimSpace(localPath) != "" {
		t.Fatalf("expected local_path empty when download=false, got %q", localPath)
	}
	if calls != 1 {
		t.Fatalf("expected exactly 1 HTTP call (files.info only), got %d", calls)
	}
}

func TestImageFileBodyIsImageHandlesMimeAndExtensionVariants(t *testing.T) {
	cases := []struct {
		file slackImageFileBody
		want bool
	}{
		{slackImageFileBody{Mimetype: "image/png"}, true},
		{slackImageFileBody{Mimetype: "IMAGE/JPEG"}, true},
		{slackImageFileBody{Filetype: "gif"}, true},
		{slackImageFileBody{Name: "photo.HEIC"}, true},
		{slackImageFileBody{Mimetype: "application/pdf", Filetype: "pdf"}, false},
		{slackImageFileBody{}, false},
	}
	for _, tc := range cases {
		if got := imageFileBodyIsImage(tc.file); got != tc.want {
			t.Errorf("imageFileBodyIsImage(%+v) = %v, want %v", tc.file, got, tc.want)
		}
	}
}

func TestActionFetchImageRequiresFileID(t *testing.T) {
	tool := &slackAPITool{role: slackAPIRoleAssistant}
	result := tool.actionFetchImage(context.Background(), map[string]any{})
	if result.Success {
		t.Fatalf("expected missing file_id to fail")
	}
	if !strings.Contains(result.Text, "file_id is required") {
		t.Fatalf("expected actionable error, got %q", result.Text)
	}
}
