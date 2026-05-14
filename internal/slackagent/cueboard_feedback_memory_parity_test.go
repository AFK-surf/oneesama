//go:build cueboardparity

package slackagent

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParityLocalSlackMemoryCountsFeedbackSeed(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "legacy-slack-agent-seed.json"), `{
		"ok": true,
		"feedbackEntries": [
			{"id":"fb-old","action":"confirm","action_type":"create_issue","channel_id":"CENG","summary":"old issue","user_id":"U1"},
			{"id":"fb-new","action":"dismiss","action_type":"join_meeting","channel_id":"COPS","summary":"standup not needed","user_id":"U2"}
		]
	}`)

	memory := newLocalSlackMemory(appconfig.SlackMemoryConfig{Enabled: true, Dir: root})
	summary := memory.Summary()
	if !summary.Seed.OK || summary.Seed.FeedbackEntries != 2 {
		t.Fatalf("feedback seed summary = %#v, want ok with two feedback entries", summary.Seed)
	}
}

func TestCueboardParityLocalSlackMemorySearchesFeedbackRows(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "legacy-slack-agent-seed.json"), `{
		"ok": true,
		"feedbackEntries": [
			{"id":"fb-launch","action":"dismiss","action_type":"join_meeting","channel_id":"COPS","thread_ts":"177.123","summary":"launch notes should not join that meeting","user_id":"U2"}
		],
		"channelBrain": [
			{"channel_id":"CENG","summary":"unrelated deployment note"}
		]
	}`)

	results := newLocalSlackMemory(appconfig.SlackMemoryConfig{Enabled: true, Dir: root}).Search("launch notes", 5)
	if len(results) != 1 {
		t.Fatalf("results = %#v, want only matching feedback row", results)
	}
	result := results[0]
	if result.Kind != "feedback" || result.Source != "COPS:177.123:fb-launch" {
		t.Fatalf("feedback result = %#v", result)
	}
	for _, want := range []string{"dismiss", "join_meeting", "launch notes", "U2"} {
		if !strings.Contains(result.Content, want) {
			t.Fatalf("feedback content missing %q: %q", want, result.Content)
		}
	}
}

func TestCueboardParityMemoryEndpointReturnsFeedbackResults(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "legacy-slack-agent-seed.json"), `{
		"ok": true,
		"feedbackEntries": [
			{"id":"fb-1","action":"confirm","action_type":"create_issue","channel_id":"CENG","summary":"create launch checklist","user_id":"U1"}
		]
	}`)
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{Memory: appconfig.SlackMemoryConfig{Enabled: true, Dir: root}},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/memory?q=launch%20checklist&limit=3", nil)
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	for _, want := range []string{`"feedbackEntries":1`, `"kind":"feedback"`, `"source":"CENG:fb-1"`, "create launch checklist"} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %q:\n%s", want, body)
		}
	}
}
