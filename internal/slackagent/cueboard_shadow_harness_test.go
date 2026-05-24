package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestTask147ShadowHarnessSilencesPlainChannelObservation(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_shadow_plain_observation",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"plain bot-noise observation","actions":[{"type":"post_thread_reply","title":"bot noise","message":"看到了，确实在刷屏。","channelId":"C09KVPBMLJ3","threadTs":"1778779797.697749","confidence":0.82,"reason":"Casual short reply.","requiresConfirmation":false}]}`,
	}}
	service, cleanup := newShadowScannerService(t, shadowScannerFixture{
		ChannelID: "C09KVPBMLJ3",
		Name:      "cueboard-shadow",
		Messages:  []string{`{"type":"message","user":"U123","text":"这个onboarding-bot-hourly刷屏了","ts":"1778779797.697749"}`},
	}, poster, runner)
	defer cleanup()
	service.inbound.SetCursor("C09KVPBMLJ3", "1778779000.000000")

	result, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("scanSlackHistoryOnce: %v", err)
	}
	if !result.OK || len(result.Sweeps) != 1 || result.Sweeps[0].Flushed == nil {
		t.Fatalf("result = %#v, want one flushed shadow sweep", result)
	}
	if !strings.Contains(runner.startInput.Task, "这个onboarding-bot-hourly刷屏了") {
		t.Fatalf("runner task missing shadow stimulus:\n%s", runner.startInput.Task)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want Cueboard-style silence for plain observation", calls)
	}
	status, err := service.TriageStatus(context.Background(), 10)
	if err != nil {
		t.Fatalf("TriageStatus: %v", err)
	}
	if len(status.PendingActions) != 0 {
		t.Fatalf("pending actions = %#v, want no confirmation/action card for plain observation", status.PendingActions)
	}
}

func TestTask147ShadowHarnessRecognizesExplicitBotMention(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_shadow_explicit_mention",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
		Task:     "你在吗",
	}}
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{
			SigningSecret: "secret",
			BotUserID:     "UBOT",
		},
		Poster: poster,
		Runner: runner,
	})

	response := postSignedEvent(t, router, "secret", `{"type":"event_callback","event_id":"EvShadowExplicitMention","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> 你在吗","channel":"C123","ts":"1778810926.574949"}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var payload SlackEventResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.OK || !payload.Handled || payload.Ignored || payload.Mode != "app_mention" {
		t.Fatalf("payload = %#v, want explicit bot mention handled", payload)
	}
	if got := strings.TrimSpace(runner.startInput.Task); got != "你在吗" {
		t.Fatalf("runner task = %q, want mention stripped to user request", got)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want no extra channel noise while worker is running", calls)
	}
}

func TestTask147ShadowHarnessReadsExternalLinkWithoutConfirmation(t *testing.T) {
	reader := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`Title: Peter Steinberger on X: codex review loop

Markdown Content:
Wrote a skill that runs codex /review in a loop until there are no issues left.
It is a public read-only link, so the assistant should read first and answer directly.`))
	}))
	defer reader.Close()
	previousReaderURL := slackExternalLinkReaderURL
	slackExternalLinkReaderURL = func(rawURL string) string {
		return reader.URL + "/?url=" + url.QueryEscape(rawURL)
	}
	defer func() { slackExternalLinkReaderURL = previousReaderURL }()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_shadow_external_link",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"external link summarized","actions":[{"type":"post_thread_reply","title":"X link summary","message":"这条 X 主要在讲 codex /review 循环。","channelId":"C09LNPCGU3E","threadTs":"1778767510.917049","confidence":0.86,"reason":"Public external links are read-only and should be answered directly.","requiresConfirmation":false}]}`,
	}}
	service, cleanup := newShadowScannerService(t, shadowScannerFixture{
		ChannelID: "C09LNPCGU3E",
		Name:      "twitter-shadow",
		Messages:  []string{`{"type":"message","user":"U123","text":"https://x.com/steipete/status/2054850632067019173","ts":"1778767510.917049"}`},
	}, poster, runner)
	defer cleanup()
	service.operatorFallback.PilotUserID = "U_PENG"
	service.operatorFallback.DM.CacheDM("U_PENG", "D_PENG")
	service.inbound.SetCursor("C09LNPCGU3E", "1778767000.000000")

	result, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("scanSlackHistoryOnce: %v", err)
	}
	if !result.OK || len(result.Sweeps) != 1 || result.Sweeps[0].Flushed == nil {
		t.Fatalf("result = %#v, want one flushed external-link sweep", result)
	}
	if !strings.Contains(runner.startInput.Task, "Fetched external links") || !strings.Contains(runner.startInput.Task, "codex /review") {
		t.Fatalf("runner task missing fetched link context:\n%s", runner.startInput.Task)
	}
	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 {
		t.Fatalf("poster calls = %d, want one direct thread reply", len(calls))
	}
	if call := calls[0]; call.Channel != "C09LNPCGU3E" || call.ThreadTS != "1778767510.917049" || !strings.Contains(call.Text, "这条 X") {
		t.Fatalf("post call = %#v, want direct thread reply", call)
	}
	status, err := service.TriageStatus(context.Background(), 10)
	if err != nil {
		t.Fatalf("TriageStatus: %v", err)
	}
	if len(status.PendingActions) != 0 {
		t.Fatalf("pending actions = %#v, want no read-confirmation card", status.PendingActions)
	}
}

func TestTask147ShadowHarnessSilencesAssistantSelfComment(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_shadow_self_comment",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"assistant self-comment","actions":[{"type":"post_thread_reply","title":"self comment","message":"诶嘿，被发现了。","channelId":"C09KVPBMLJ3","threadTs":"1778779797.697749","confidence":0.79,"reason":"Casual personality reply.","requiresConfirmation":false}]}`,
	}}
	service, cleanup := newShadowScannerService(t, shadowScannerFixture{
		ChannelID: "C09KVPBMLJ3",
		Name:      "cueboard-shadow",
		Messages:  []string{`{"type":"message","user":"U123","text":"转生后的oneesama味道有点不对","ts":"1778779801.000000","thread_ts":"1778779797.697749"}`},
	}, poster, runner)
	defer cleanup()
	service.inbound.SetCursor("C09KVPBMLJ3", "1778779000.000000")

	result, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("scanSlackHistoryOnce: %v", err)
	}
	if !result.OK || len(result.Sweeps) != 1 || result.Sweeps[0].Flushed == nil {
		t.Fatalf("result = %#v, want one flushed shadow sweep", result)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want Cueboard-style silence for assistant self-comment", calls)
	}
}

type shadowScannerFixture struct {
	ChannelID string
	Name      string
	Messages  []string
}

func newShadowScannerService(t *testing.T, fixture shadowScannerFixture, poster *recordingPoster, runner *fakeRunner) (*Service, func()) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.list":
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"` + fixture.ChannelID + `","name":"` + fixture.Name + `","is_member":true,"is_channel":true}]}`))
		case "/conversations.history":
			if got := r.Form.Get("channel"); got != fixture.ChannelID {
				t.Fatalf("channel = %q, want %s", got, fixture.ChannelID)
			}
			_, _ = w.Write([]byte(`{"ok":true,"messages":[` + strings.Join(fixture.Messages, ",") + `]}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	cleanup := func() {
		slackScannerAPIBaseURL = previousBaseURL
		server.Close()
	}

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken:  "xoxb-test",
			BotUserID: "UBOT",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				Triage:   true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
			Triage: appconfig.SlackTriageConfig{
				PostActions:       true,
				HeuristicFallback: true,
			},
		},
		Poster: poster,
		Runner: runner,
	})
	return service, cleanup
}
