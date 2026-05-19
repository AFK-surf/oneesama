package slackagent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestSlackAPIToolCreateCanvasCallsSlackAPI(t *testing.T) {
	var gotPath string
	var gotPayload map[string]any
	transport := roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		gotPath = req.URL.Path
		body, _ := io.ReadAll(req.Body)
		if err := json.Unmarshal(body, &gotPayload); err != nil {
			t.Fatalf("decode request payload: %v", err)
		}
		response := `{"ok":true,"canvas_id":"F0CANVAS","team_id":"T123","url":"https://app.slack.com/docs/T123/F0CANVAS"}`
		return &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(strings.NewReader(response)),
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Request:    req,
		}, nil
	})
	tool := &slackAPITool{role: slackAPIRoleAssistant, apiURL: "https://slack.example/api", token: "xoxb-test", httpTransport: transport}

	result, err := tool.Execute(context.Background(), map[string]any{
		"action": "create_canvas",
		"params": map[string]any{
			"title":    "Launch notes",
			"markdown": "# Launch\n\n- shipped",
			"channel":  "C123",
		},
	})
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Text)
	}
	if gotPath != "/api/canvases.create" {
		t.Fatalf("path = %q, want /api/canvases.create", gotPath)
	}
	if gotPayload["title"] != "Launch notes" || gotPayload["channel_id"] != "C123" {
		t.Fatalf("payload = %+v, want title and channel_id", gotPayload)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Text), &decoded); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if decoded["canvas_id"] != "F0CANVAS" || decoded["permalink"] != "https://app.slack.com/docs/T123/F0CANVAS" {
		t.Fatalf("result = %+v, want canvas id and permalink", decoded)
	}
}

func TestSlackAPIToolEditCanvasCallsSlackAPI(t *testing.T) {
	var gotPayload map[string]any
	transport := roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/api/canvases.edit" {
			t.Fatalf("path = %q, want /api/canvases.edit", req.URL.Path)
		}
		body, _ := io.ReadAll(req.Body)
		if err := json.Unmarshal(body, &gotPayload); err != nil {
			t.Fatalf("decode request payload: %v", err)
		}
		return &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Request:    req,
		}, nil
	})
	tool := &slackAPITool{role: slackAPIRoleAssistant, apiURL: "https://slack.example/api", token: "xoxb-test", httpTransport: transport}

	result, err := tool.Execute(context.Background(), map[string]any{
		"action": "edit_canvas",
		"params": map[string]any{
			"canvas_id":  "F0CANVAS",
			"markdown":   "## Update\n\nNew section",
			"operation":  "insert_at_end",
			"section_id": "S123",
		},
	})
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Text)
	}
	if gotPayload["canvas_id"] != "F0CANVAS" {
		t.Fatalf("payload = %+v, want canvas_id", gotPayload)
	}
	changes, _ := gotPayload["changes"].([]any)
	if len(changes) != 1 {
		t.Fatalf("changes = %+v, want one change", gotPayload["changes"])
	}
	change, _ := changes[0].(map[string]any)
	if change["operation"] != "insert_at_end" || change["section_id"] != "S123" {
		t.Fatalf("change = %+v, want operation and section_id", change)
	}
}

func TestSlackAPIToolCreateCanvasRetriesWithSanitizedMarkdown(t *testing.T) {
	requests := 0
	var retryMarkdown string
	transport := roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		requests++
		body, _ := io.ReadAll(req.Body)
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("decode request payload: %v", err)
		}
		doc, _ := payload["document_content"].(map[string]any)
		if requests == 1 {
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(strings.NewReader(`{"ok":false,"error":"invalid_markdown"}`)),
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Request:    req,
			}, nil
		}
		retryMarkdown, _ = doc["markdown"].(string)
		return &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(strings.NewReader(`{"ok":true,"canvas_id":"F0CANVAS"}`)),
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Request:    req,
		}, nil
	})
	tool := &slackAPITool{role: slackAPIRoleAssistant, apiURL: "https://slack.example/api", token: "xoxb-test", httpTransport: transport}

	result, err := tool.Execute(context.Background(), map[string]any{
		"action": "create_canvas",
		"params": map[string]any{
			"title":    "Needs sanitize",
			"markdown": "<p>body</p>\n\n```go\nfmt.Println(1)\n```",
		},
	})
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Text)
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want validation retry", requests)
	}
	if strings.Contains(retryMarkdown, "<p>") || strings.Contains(retryMarkdown, "```go") {
		t.Fatalf("retry markdown was not sanitized: %q", retryMarkdown)
	}
}
