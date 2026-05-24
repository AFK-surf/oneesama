package slackagent

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleMemorySearchUsesLocalSlackMemory(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "workspace", "MEMORY.md"), "# Memory\n\nDeploy plan mentions codex.\n")
	writeTestFile(t, filepath.Join(root, "legacy-slack-agent-seed.json"), `{"ok":true,"channelBrain":[{"channel_id":"C123","summary":"codex deployment"}]}`)
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{Memory: appconfig.SlackMemoryConfig{Enabled: true, Dir: root}},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/memory?q=codex&limit=3", nil)
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"fileCount":1`) || !strings.Contains(response.Body.String(), `"channelBrain":1`) {
		t.Fatalf("body = %s, want memory summary counts", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"source":"MEMORY.md"`) {
		t.Fatalf("body = %s, want memory file result", response.Body.String())
	}
}

func TestHandleMemorySearchIncludesLiveWorkspaceTriageProjection(t *testing.T) {
	localRoot := t.TempDir()
	workspaceDir := t.TempDir()
	persistTriageContext(workspaceDir, SlackTriageContext{
		SessionID: "triage:C123:1",
		Timestamp: "2026-05-17T05:00:00Z",
		Status:    "ok",
		Channels:  []string{"C123"},
		Summary:   "Cueboard thread was already handled by another bot; no office-helper action needed.",
		Digest:    `#cueboard (C123): current work was already handled by another bot`,
		Steps:     1,
	})
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true, Dir: localRoot},
		},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/memory?q=Cueboard&limit=3", nil)
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, `"workspaceTriageContexts":1`) {
		t.Fatalf("body = %s, want workspace triage summary count", body)
	}
	if !strings.Contains(body, `"kind":"triage_projection"`) || !strings.Contains(body, "already handled by another bot") {
		t.Fatalf("body = %s, want triage projection memory result", body)
	}
}

func TestFollowupCreateStatusAndSurface(t *testing.T) {
	previousClock := timeNow
	timeNow = func() time.Time { return time.Date(2026, 3, 24, 11, 0, 0, 0, shanghaiLocation()) }
	t.Cleanup(func() { timeNow = previousClock })
	poster := &recordingPoster{callCh: make(chan struct{}, 2)}
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Poster:      poster,
	})
	body := `{"channel_id":"C123","thread_ts":"123.456","title":"Follow up owner","summary":"Ask owner for update","recommendation_type":"reply","outbound_action_type":"dm","metadata":{"allow_public_heartbeat_surface":true}}`
	create := postInternalJSON(t, router, "/slack/followups/create", body)
	if create.Code != http.StatusOK {
		t.Fatalf("create status = %d, want 200: %s", create.Code, create.Body.String())
	}
	var created SlackFollowupCreateResponse
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if created.Followup == nil || created.Surface == nil || created.Recommendation == nil || created.Outbound == nil {
		t.Fatalf("created = %#v, want followup/surface/recommendation/outbound", created)
	}

	status := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/slack/followups/status?limit=5", nil)
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(status, request)
	if !strings.Contains(status.Body.String(), `"heartbeatFollowups"`) || !strings.Contains(status.Body.String(), `"outboundActions"`) {
		t.Fatalf("status body = %s, want followup status arrays", status.Body.String())
	}

	surface := postInternalJSON(t, router, "/slack/followups/surface", `{"followup_id":`+heartbeatKey(created.Followup.ID)+`}`)
	if surface.Code != http.StatusOK {
		t.Fatalf("surface status = %d, want 200: %s", surface.Code, surface.Body.String())
	}
	poster.WaitForCalls(t, 1)
	if calls := poster.Calls(); len(calls) != 1 || calls[0].Channel != "C123" || calls[0].ThreadTS != "123.456" {
		t.Fatalf("poster calls = %#v, want heartbeat post to thread", poster.Calls())
	}
	contextResponse := httptest.NewRecorder()
	contextRequest := httptest.NewRequest(http.MethodGet, "/slack/heartbeat/context", nil)
	contextRequest.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(contextResponse, contextRequest)
	if !strings.Contains(contextResponse.Body.String(), "Open follow-ups:") || !strings.Contains(contextResponse.Body.String(), "Follow up owner") {
		t.Fatalf("heartbeat context = %s, want followup digest", contextResponse.Body.String())
	}
}

func postInternalJSON(t *testing.T, router http.Handler, path string, body string) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)
	return response
}

func writeTestFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
