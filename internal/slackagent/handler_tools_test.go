package slackagent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleSlackToolsParityReportsCueboardSurface(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{InternalAuthKey: "secret-key", WorkspaceDir: t.TempDir()},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/slack/tools/parity", nil)
	request.Header.Set(internalAuthHeader, "secret-key")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	for _, want := range []string{
		`"schema":"oneesama.slack-tools-parity.v1"`,
		`"name":"exa_search"`,
		`"name":"exa_contents"`,
		`"name":"read_doc"`,
		`"name":"memory_search"`,
		`"name":"slack_api"`,
		`"method":"conversations.replies"`,
		`"method":"slack.uploadFile"`,
		`"status":"product_excluded"`,
		`"name":"linear_api"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("parity report missing %q:\n%s", want, body)
		}
	}
}

func TestHandleSlackToolCallExaContentsUsesReader(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/reader" {
			t.Fatalf("path = %q, want /reader", r.URL.Path)
		}
		_, _ = w.Write([]byte("Title: Launch note\n\nMarkdown Content:\nPeng wrote a detailed thread about the bot replying to X links."))
	}))
	defer server.Close()
	oldClient := slackExternalLinkHTTPClient
	oldReaderURL := slackExternalLinkReaderURL
	slackExternalLinkHTTPClient = server.Client()
	slackExternalLinkReaderURL = func(rawURL string) string { return server.URL + "/reader" }
	t.Cleanup(func() {
		slackExternalLinkHTTPClient = oldClient
		slackExternalLinkReaderURL = oldReaderURL
	})

	router := newTestRouter(t, Config{Slack: appconfig.SlackConfig{InternalAuthKey: "secret-key"}})
	response := postInternalJSON(t, router, "/slack/tools/call", `{"tool":"exa_contents","args":{"url":"https://x.com/bridge_surf/status/123"}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, `"ok":true`) || !strings.Contains(body, `"source":"jina_reader"`) || !strings.Contains(body, "bot replying to X links") {
		t.Fatalf("body = %s, want reader result", body)
	}
}

func TestHandleSlackToolCallExaSearchUsesSearchReader(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/search" || r.URL.Query().Get("q") != "oneesama twitter bot" {
			t.Fatalf("url = %s, want /search?q=oneesama twitter bot", r.URL.String())
		}
		_, _ = w.Write([]byte("Title: Search results\n\n- Oneesama Twitter reply bot R0\n- Cueboard triage parity"))
	}))
	defer server.Close()
	oldClient := slackExternalSearchHTTPClient
	oldSearchURL := slackExternalSearchURL
	slackExternalSearchHTTPClient = server.Client()
	slackExternalSearchURL = func(query string) string { return server.URL + "/search?q=" + url.QueryEscape(query) }
	t.Cleanup(func() {
		slackExternalSearchHTTPClient = oldClient
		slackExternalSearchURL = oldSearchURL
	})

	router := newTestRouter(t, Config{Slack: appconfig.SlackConfig{InternalAuthKey: "secret-key"}})
	response := postInternalJSON(t, router, "/tools/call", `{"tool":"exa_search","args":{"query":"oneesama twitter bot"}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, `"ok":true`) || !strings.Contains(body, `"source":"jina_search"`) || !strings.Contains(body, "Cueboard triage parity") {
		t.Fatalf("body = %s, want search result", body)
	}
}

func TestHandleSlackToolCallReadDocRestrictsWorkspacePaths(t *testing.T) {
	workspaceDir := t.TempDir()
	writeTestFile(t, filepath.Join(workspaceDir, "README.md"), "# Workspace\n\nVisible doc.\n")
	writeTestFile(t, filepath.Join(workspaceDir, ".env"), "SECRET=not-for-tools\n")
	router := newTestRouter(t, Config{Slack: appconfig.SlackConfig{InternalAuthKey: "secret-key", WorkspaceDir: workspaceDir}})

	allowed := postInternalJSON(t, router, "/slack/tools/call", `{"tool":"read_doc","args":{"path":"README.md"}}`)
	if allowed.Code != http.StatusOK || !strings.Contains(allowed.Body.String(), "Visible doc") {
		t.Fatalf("allowed read = %d %s, want README content", allowed.Code, allowed.Body.String())
	}

	blocked := postInternalJSON(t, router, "/slack/tools/call", `{"tool":"read_doc","args":{"path":".env"}}`)
	if blocked.Code != http.StatusBadRequest || !strings.Contains(blocked.Body.String(), `"error":"path_not_allowed"`) {
		t.Fatalf("blocked read = %d %s, want path_not_allowed", blocked.Code, blocked.Body.String())
	}
}

func TestHandleSlackToolCallReadDocFallsBackToRepoCWD(t *testing.T) {
	repoDir := t.TempDir()
	writeTestFile(t, filepath.Join(repoDir, "README.md"), "# Repo\n\nFallback visible doc.\n")
	t.Chdir(repoDir)
	router := newTestRouter(t, Config{Slack: appconfig.SlackConfig{InternalAuthKey: "secret-key"}})

	response := postInternalJSON(t, router, "/slack/tools/call", `{"tool":"read_doc","args":{"path":"README.md"}}`)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Fallback visible doc") {
		t.Fatalf("read = %d %s, want cwd README content", response.Code, response.Body.String())
	}
}

func TestHandleSlackToolCallMemorySearchGetAndWrite(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "workspace", "MEMORY.md"), "# Memory\n\nLaunch plan mentions bridge.\n")
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{
			InternalAuthKey: "secret-key",
			Memory:          appconfig.SlackMemoryConfig{Enabled: true, Dir: root},
		},
	})

	search := postInternalJSON(t, router, "/slack/tools/call", `{"tool":"memory_search","args":{"query":"bridge","limit":3}}`)
	if search.Code != http.StatusOK || !strings.Contains(search.Body.String(), `"source":"MEMORY.md"`) {
		t.Fatalf("search = %d %s, want memory result", search.Code, search.Body.String())
	}

	write := postInternalJSON(t, router, "/slack/tools/call", `{"tool":"memory_write","args":{"path":"memory/notes/tool-surface.md","content":"Tool surface parity note."}}`)
	if write.Code != http.StatusOK || !strings.Contains(write.Body.String(), `"ok":true`) {
		t.Fatalf("write = %d %s, want ok", write.Code, write.Body.String())
	}

	get := postInternalJSON(t, router, "/slack/tools/call", `{"tool":"memory_get","args":{"path":"memory/notes/tool-surface.md"}}`)
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), "Tool surface parity note") {
		t.Fatalf("get = %d %s, want written note", get.Code, get.Body.String())
	}
}

func TestHandleSlackToolCallSlackAPIConversationsReplies(t *testing.T) {
	var gotMethod string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		if r.URL.Path != "/conversations.replies" {
			t.Fatalf("path = %q, want /conversations.replies", r.URL.Path)
		}
		if r.URL.Query().Get("channel") != "C123" || r.URL.Query().Get("ts") != "177.123" {
			t.Fatalf("query = %s, want channel/ts", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true,
			"messages": []map[string]any{
				{"ts": "177.123", "user": "U1", "text": "parent"},
				{"ts": "177.124", "user": "U2", "text": "reply"},
			},
		})
	}))
	defer server.Close()
	oldBase := slackThreadFetchAPIBaseURL
	slackThreadFetchAPIBaseURL = server.URL
	t.Cleanup(func() { slackThreadFetchAPIBaseURL = oldBase })

	router := newTestRouter(t, Config{Slack: appconfig.SlackConfig{InternalAuthKey: "secret-key", BotToken: "xoxb-test"}})
	response := postInternalJSON(t, router, "/slack/tools/call", `{"tool":"slack_api","role":"planner","args":{"method":"conversations.replies","params":{"channel":"C123","thread_ts":"177.123"}}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if gotMethod != http.MethodGet {
		t.Fatalf("method = %s, want GET", gotMethod)
	}
	if !strings.Contains(response.Body.String(), `"messages"`) || !strings.Contains(response.Body.String(), "reply") {
		t.Fatalf("body = %s, want thread messages", response.Body.String())
	}
}
