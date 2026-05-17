package slackagent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// newCanvasStubTransport returns a RoundTripper that handles files.info plus a
// stub canvas HTML download URL, so actionFetchCanvas tests can run without a
// live Slack endpoint. The single argument lets each test override the file
// body shape (mode, mimetype, error, etc.).
func newCanvasStubTransport(file slackCanvasFileBody, html string, status int) http.RoundTripper {
	return roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		if strings.Contains(req.URL.String(), "files.info") {
			body, _ := json.Marshal(map[string]any{
				"ok":   true,
				"file": file,
			})
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(strings.NewReader(string(body))),
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Request:    req,
			}, nil
		}
		return &http.Response{
			StatusCode: status,
			Body:       io.NopCloser(strings.NewReader(html)),
			Header:     http.Header{"Content-Type": []string{"text/html"}},
			Request:    req,
		}, nil
	})
}

func TestActionFetchCanvasReturnsMarkdownSnippet(t *testing.T) {
	transport := newCanvasStubTransport(
		slackCanvasFileBody{
			ID:                 "F12345",
			Title:              "Sprint plan",
			Mode:               "canvas",
			Filetype:           "canvas",
			Permalink:          "https://slack.example/permalink/F12345",
			URLPrivateDownload: "https://files.slack.example/canvas/F12345",
		},
		"<h1>Sprint plan</h1><p>Focus area: <strong>parity</strong>.</p>",
		200,
	)
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		httpTransport: transport,
	}
	result := tool.actionFetchCanvas(context.Background(), map[string]any{"file_id": "F12345"})
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Text)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Text), &decoded); err != nil {
		t.Fatalf("decode result: %v (%q)", err, result.Text)
	}
	markdown, _ := decoded["markdown"].(string)
	if !strings.Contains(markdown, "# Sprint plan") {
		t.Fatalf("expected markdown to contain heading, got %q", markdown)
	}
	if !strings.Contains(markdown, "**parity**") {
		t.Fatalf("expected markdown to preserve bold, got %q", markdown)
	}
}

func TestActionFetchCanvasRejectsNonCanvasFile(t *testing.T) {
	transport := newCanvasStubTransport(
		slackCanvasFileBody{
			ID:                 "F12345",
			Title:              "Spreadsheet",
			Mode:               "snippet",
			Filetype:           "csv",
			URLPrivateDownload: "https://files.slack.example/canvas/F12345",
		},
		"not used",
		200,
	)
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		httpTransport: transport,
	}
	result := tool.actionFetchCanvas(context.Background(), map[string]any{"file_id": "F12345"})
	if result.Success {
		t.Fatalf("expected non-canvas rejection, got success: %q", result.Text)
	}
	if !strings.Contains(result.Text, "not a Slack canvas") {
		t.Fatalf("expected rejection text to mention canvas, got %q", result.Text)
	}
}

func TestActionFetchCanvasRequiresFileID(t *testing.T) {
	tool := &slackAPITool{
		role:   slackAPIRoleAssistant,
		apiURL: "https://slack.example",
		token:  "xoxb-test",
	}
	result := tool.actionFetchCanvas(context.Background(), map[string]any{})
	if result.Success {
		t.Fatalf("expected missing file_id to fail")
	}
	if !strings.Contains(result.Text, "file_id is required") {
		t.Fatalf("expected actionable error, got %q", result.Text)
	}
}

func TestActionFetchCanvasTruncatesOversizedMarkdown(t *testing.T) {
	body := "<p>" + strings.Repeat("oneesama-canvas-line\n", 600) + "</p>"
	transport := newCanvasStubTransport(
		slackCanvasFileBody{
			ID:                 "F12345",
			Mode:               "canvas",
			URLPrivateDownload: "https://files.slack.example/canvas/F12345",
		},
		body,
		200,
	)
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		httpTransport: transport,
	}
	result := tool.actionFetchCanvas(context.Background(), map[string]any{
		"file_id": "F12345",
		"limit":   500,
	})
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Text)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Text), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if truncated, _ := decoded["truncated"].(bool); !truncated {
		t.Fatalf("expected truncated=true, got %+v", decoded["truncated"])
	}
	markdown, _ := decoded["markdown"].(string)
	if !strings.Contains(markdown, "[truncated") {
		t.Fatalf("expected truncation marker, got %q", markdown)
	}
}

func TestActionFetchCanvasFailsWhenDownloadReturnsNon200(t *testing.T) {
	transport := newCanvasStubTransport(
		slackCanvasFileBody{
			ID:                 "F12345",
			Mode:               "canvas",
			URLPrivateDownload: "https://files.slack.example/canvas/F12345",
		},
		"forbidden",
		403,
	)
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		httpTransport: transport,
	}
	result := tool.actionFetchCanvas(context.Background(), map[string]any{"file_id": "F12345"})
	if result.Success {
		t.Fatalf("expected non-200 download to fail, got success: %q", result.Text)
	}
	if !strings.Contains(strings.ToLower(result.Text), "download") {
		t.Fatalf("expected download-related error, got %q", result.Text)
	}
}

func TestCanvasFileBodyIsCanvasAcceptsModeAndFiletypeVariants(t *testing.T) {
	cases := []struct {
		file slackCanvasFileBody
		want bool
	}{
		{slackCanvasFileBody{Mode: "canvas"}, true},
		{slackCanvasFileBody{Mode: "channel_canvas"}, true},
		{slackCanvasFileBody{Filetype: "canvas"}, true},
		{slackCanvasFileBody{Filetype: "quip"}, true},
		{slackCanvasFileBody{Mimetype: "application/vnd.slack-canvas+json"}, true},
		{slackCanvasFileBody{Mode: "snippet", Filetype: "csv"}, false},
		{slackCanvasFileBody{}, false},
	}
	for _, tc := range cases {
		got := canvasFileBodyIsCanvas(tc.file)
		if got != tc.want {
			t.Errorf("canvasFileBodyIsCanvas(%+v) = %v, want %v", tc.file, got, tc.want)
		}
	}
}

func TestTruncateCanvasMarkdownHandlesShortInputAsNoop(t *testing.T) {
	got, trimmed := truncateCanvasMarkdown("short body", 1000)
	if got != "short body" || trimmed {
		t.Fatalf("expected short body to pass through, got %q trimmed=%v", got, trimmed)
	}
}
