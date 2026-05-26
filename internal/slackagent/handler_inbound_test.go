package slackagent

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleEventsBuffersChannelMessageWhenEnabled(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{
			SigningSecret: "secret",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
		},
	})

	body := `{"type":"event_callback","event_id":"EvInbound","team_id":"T123","event":{"type":"message","channel_type":"channel","user":"U123","text":"ship the thing","channel":"C123","ts":"123.456"}}`
	response := signedSlackEventRequest(t, router, body)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}

	var payload SlackEventResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.Handled || payload.Mode != "event_buffer" || payload.Inbound == nil || !payload.Inbound.Buffered {
		t.Fatalf("payload = %#v, want buffered event", payload)
	}
	if payload.Inbound.Pending != 1 || payload.Inbound.ChannelID != "C123" {
		t.Fatalf("inbound = %#v, want pending C123", payload.Inbound)
	}

	status := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/slack/inbound/status", nil)
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(status, request)
	if status.Code != http.StatusOK {
		t.Fatalf("status route = %d, want 200", status.Code)
	}
	if !strings.Contains(status.Body.String(), `"pending":1`) {
		t.Fatalf("status body = %s, want pending message", status.Body.String())
	}
}

func TestSlackHistoryScannerIntervalMatchesCueboardDefault(t *testing.T) {
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken: "xoxb-test",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				Triage:   true,
				MaxBatch: 10,
				Debounce: 30 * time.Second,
			},
		},
	})
	if got := service.slackHistoryScannerInterval(); got != 3*time.Minute {
		t.Fatalf("scanner interval = %s, want cueboard poll-mode fixture 3m not event debounce", got)
	}
}

func TestSlackEventBufferDefaultDebounceWaitsForHumanReplyWindow(t *testing.T) {
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled: true,
			},
		},
	})
	if service.inbound == nil {
		t.Fatal("service inbound buffer is nil")
	}
	if got := service.inbound.debounce; got != 5*time.Minute {
		t.Fatalf("event buffer debounce = %s, want Cueboard-style 5m wait-for-human window", got)
	}
}

func TestHandleInboundFlushReturnsDigest(t *testing.T) {
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			SigningSecret: "secret",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				Triage:   true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
			Triage: appconfig.SlackTriageConfig{
				HeuristicFallback: true,
			},
		},
	})
	body := `{"type":"event_callback","event_id":"EvFlush","team_id":"T123","event":{"type":"message","channel_type":"channel","user":"U123","text":"need a digest","channel":"C123","ts":"123.456"}}`
	_ = signedSlackEventRequest(t, router, body)

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/inbound/flush", strings.NewReader(`{"channel_id":"C123"}`))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("flush status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "=== Slack Activity ===") || !strings.Contains(response.Body.String(), "need a digest") {
		t.Fatalf("flush body = %s, want digest", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"status":"ok"`) || !strings.Contains(response.Body.String(), `"slack-triage"`) {
		t.Fatalf("flush body = %s, want completed triage job", response.Body.String())
	}
}

func TestHandleScannerSweepFlushesFixtureMessages(t *testing.T) {
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
		},
	})

	body := `{"workspace_id":"T123","channels":[{"id":"C123","type":"channel","messages":[{"user":"U1","text":"first","ts":"2026-05-13T01:00:00Z"},{"user":"U2","text":"second","event_ts":"2026-05-13T01:00:01Z"}]}]}`
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/scanner/sweep", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("sweep status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"buffered":2`) || !strings.Contains(response.Body.String(), `"count":2`) {
		t.Fatalf("sweep body = %s, want buffered and flushed counts", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "first") || !strings.Contains(response.Body.String(), "second") {
		t.Fatalf("sweep body = %s, want fixture messages", response.Body.String())
	}

	retry := httptest.NewRecorder()
	retryRequest := httptest.NewRequest(http.MethodPost, "/slack/scanner/sweep", bytes.NewBufferString(body))
	retryRequest.Header.Set("Content-Type", "application/json")
	retryRequest.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(retry, retryRequest)
	if retry.Code != http.StatusOK {
		t.Fatalf("retry sweep status = %d, want 200: %s", retry.Code, retry.Body.String())
	}
	if !strings.Contains(retry.Body.String(), `"previousCursor":"2026-05-13T01:00:01Z"`) || !strings.Contains(retry.Body.String(), `"buffered":0`) {
		t.Fatalf("retry sweep body = %s, want cursor dedupe", retry.Body.String())
	}
}

func TestHandleScannerSweepIgnoresCurrentBotMentions(t *testing.T) {
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotUserID: "UBOT",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
		},
	})

	body := `{"workspace_id":"T123","channels":[{"id":"C123","type":"channel","messages":[{"user":"U1","text":"<@UBOT> https://meet.google.com/yuf-wnes-yqt","ts":"1778810550.773349"},{"user":"U2","text":"normal background chatter","ts":"1778810551.000000"}]}]}`
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/scanner/sweep", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("sweep status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"buffered":1`) || strings.Contains(response.Body.String(), "yuf-wnes-yqt") {
		t.Fatalf("sweep body = %s, want scanner to ignore current bot mentions and only buffer background chatter", response.Body.String())
	}
}

func TestScannerSweepReconcilesMissedAppMention(t *testing.T) {
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_scanner_mention",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotUserID: "UBOT",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
		},
		Runner: runner,
	})

	result := service.SweepSlackScanner(context.Background(), SlackScannerSweepRequest{
		WorkspaceID: "T123",
		Flush:       boolPtr(true),
		Channels: []SlackScannerChannel{{
			ID:   "C123",
			Name: "xp-test",
			Type: "channel",
			Messages: []SlackInboundMessage{{
				UserID: "U123",
				Text:   "<@UBOT> 给一版 what's new，写 canvas 里",
				TS:     "1779158086.310079",
			}},
		}},
	})

	if !result.OK || len(result.Sweeps) != 1 {
		t.Fatalf("result = %#v, want one successful sweep", result)
	}
	sweep := result.Sweeps[0]
	if sweep.Buffered != 0 || sweep.MentionReconciled != 1 || sweep.MentionSkipped != 0 {
		t.Fatalf("sweep = %#v, want mention reconciled without triage buffer", sweep)
	}
	if runner.startCount != 1 {
		t.Fatalf("runner start count = %d, want 1", runner.startCount)
	}
	if !strings.Contains(runner.startInput.Task, "what's new") || strings.Contains(runner.startInput.Task, "<@UBOT>") {
		t.Fatalf("runner task = %q, want stripped app mention text", runner.startInput.Task)
	}
}

func TestScannerSweepSkipsMentionAlreadyHandledBeforeRestart(t *testing.T) {
	dir := t.TempDir()
	cfg := Config{
		Persistence: appconfig.PersistenceConfig{
			Provider: "json-file",
			DataDir:  dir,
		},
		Slack: appconfig.SlackConfig{
			BotUserID: "UBOT",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
		},
	}
	firstRunner := &fakeRunner{job: agentrunner.Job{ID: "job_socket_mention", Provider: "codex", Status: agentrunner.StatusRunning}}
	first := NewService(cfg)
	first.runner = firstRunner
	first.handleEventAvatarCommand(context.Background(), SlackEventEnvelope{
		Type:    "event_callback",
		EventID: "EvSocketMention",
		TeamID:  "T123",
		Event: SlackEventPayload{
			Type:    "app_mention",
			User:    "U123",
			Text:    "<@UBOT> summarize this",
			Channel: "C123",
			TS:      "1779158086.310079",
		},
	}, "app_mention")
	if firstRunner.startCount != 1 {
		t.Fatalf("first runner start count = %d, want socket event to start once", firstRunner.startCount)
	}

	secondRunner := &fakeRunner{job: agentrunner.Job{ID: "job_scanner_duplicate", Provider: "codex", Status: agentrunner.StatusRunning}}
	second := NewService(cfg)
	second.runner = secondRunner
	result := second.SweepSlackScanner(context.Background(), SlackScannerSweepRequest{
		WorkspaceID: "T123",
		Flush:       boolPtr(true),
		Channels: []SlackScannerChannel{{
			ID:   "C123",
			Type: "channel",
			Messages: []SlackInboundMessage{{
				UserID: "U123",
				Text:   "<@UBOT> summarize this",
				TS:     "1779158086.310079",
			}},
		}},
	})
	if !result.OK || len(result.Sweeps) != 1 {
		t.Fatalf("result = %#v, want one successful sweep", result)
	}
	sweep := result.Sweeps[0]
	if sweep.MentionReconciled != 0 || sweep.MentionSkipped != 1 || secondRunner.startCount != 0 {
		t.Fatalf("sweep = %#v startCount=%d, want persisted handled mention skipped", sweep, secondRunner.startCount)
	}
}

func TestScannerSweepSkipsMentionWhenAssistantAlreadyAnsweredThread(t *testing.T) {
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_scanner_duplicate_join",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotUserID: "UBOT",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
		},
		Runner: runner,
	})
	if err := service.cognition.RecordOutbound(context.Background(), "T123", "C123", "100.000", "Joined: Google Meet"); err != nil {
		t.Fatalf("record outbound: %v", err)
	}

	result := service.SweepSlackScanner(context.Background(), SlackScannerSweepRequest{
		WorkspaceID: "T123",
		Flush:       boolPtr(true),
		Channels: []SlackScannerChannel{{
			ID:   "C123",
			Type: "channel",
			Messages: []SlackInboundMessage{{
				UserID: "U123",
				Text:   "<@UBOT> https://meet.google.com/abc-defg-hij",
				TS:     "100.000",
			}},
		}},
	})
	if !result.OK || len(result.Sweeps) != 1 {
		t.Fatalf("result = %#v, want one successful sweep", result)
	}
	sweep := result.Sweeps[0]
	if sweep.MentionReconciled != 0 || sweep.MentionSkipped != 1 || runner.startCount != 0 {
		t.Fatalf("sweep = %#v startCount=%d, want scanner mention skipped after assistant activity", sweep, runner.startCount)
	}
}

func TestSlackHistoryScannerBootstrapsCursorWithoutFloodingHistory(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.list":
			if r.Form.Get("types") != "public_channel,private_channel" {
				t.Fatalf("types = %q, want public/private channels", r.Form.Get("types"))
			}
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"C123","name":"xp-test","is_member":true,"is_channel":true}]}`))
		case "/conversations.history":
			if r.Form.Get("channel") != "C123" {
				t.Fatalf("channel = %q, want C123", r.Form.Get("channel"))
			}
			if r.Form.Get("oldest") == "" {
				t.Fatal("history request should use a bootstrap oldest cursor")
			}
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U123","text":"old message should not flood triage","ts":"1778765800.000000"}]}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	defer func() { slackScannerAPIBaseURL = previousBaseURL }()

	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_poll",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"scanner saw a follow-up request","actions":[{"type":"none","title":"No action","message":"test","channelId":"C123","threadTs":"1778765842.164299","confidence":0.9,"reason":"test","requiresConfirmation":false}]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken: "xoxb-test",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				Triage:   true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
			Triage: appconfig.SlackTriageConfig{
				HeuristicFallback: true,
			},
		},
		Runner: runner,
	})

	result, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("scanSlackHistoryOnce: %v", err)
	}
	if !result.OK || len(result.Sweeps) != 1 {
		t.Fatalf("result = %#v, want one successful sweep", result)
	}
	sweep := result.Sweeps[0]
	if sweep.Source != "slack_web_api" || sweep.Scanned != 1 || sweep.Buffered != 0 || sweep.Flushed != nil {
		t.Fatalf("sweep = %#v, want bootstrap scan without buffering old history", sweep)
	}
	status := service.InboundStatus().EventBuffer
	if status.Flushes != 0 || status.BufferedMessages != 0 {
		t.Fatalf("inbound status = %#v, want bootstrap cursor only", status)
	}
	if cursor := service.inbound.Cursor("C123"); cursor != "1778765800.000000" {
		t.Fatalf("cursor = %q, want latest historical message", cursor)
	}
	if runner.startInput.Task != "" {
		t.Fatalf("runner should not start during bootstrap, got task:\n%s", runner.startInput.Task)
	}
}

func TestSlackHistoryScannerPollsJoinedChannelMessages(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.list":
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"C123","name":"xp-test","is_member":true,"is_channel":true}]}`))
		case "/conversations.history":
			if r.Form.Get("latest") != "" {
				_, _ = w.Write([]byte(`{"ok":true,"messages":[]}`))
				return
			}
			if got := r.Form.Get("oldest"); got != "1778765800.000000" {
				t.Fatalf("oldest = %q, want stored cursor", got)
			}
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U123","text":"please create a follow-up","ts":"1778765842.164299"}]}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	defer func() { slackScannerAPIBaseURL = previousBaseURL }()

	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_poll",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"scanner saw a follow-up request","actions":[{"type":"none","title":"No action","message":"test","channelId":"C123","threadTs":"1778765842.164299","confidence":0.9,"reason":"test","requiresConfirmation":false}]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken: "xoxb-test",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				Triage:   true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
			Triage: appconfig.SlackTriageConfig{
				HeuristicFallback: true,
			},
		},
		Runner: runner,
	})
	service.inbound.SetCursor("C123", "1778765800.000000")

	result, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("scanSlackHistoryOnce: %v", err)
	}
	if !result.OK || len(result.Sweeps) != 1 {
		t.Fatalf("result = %#v, want one successful sweep", result)
	}
	sweep := result.Sweeps[0]
	if sweep.Source != "slack_web_api" || sweep.Buffered != 1 || sweep.Flushed == nil || sweep.Flushed.Count != 1 {
		t.Fatalf("sweep = %#v, want Slack history message buffered and flushed", sweep)
	}
	status := service.InboundStatus().EventBuffer
	if status.Flushes != 1 || status.LastTriageJobID != "job_triage_poll" {
		t.Fatalf("inbound status = %#v, want flush and triage job", status)
	}
	if !strings.Contains(runner.startInput.Task, "please create a follow-up") {
		t.Fatalf("runner task missing scanned message:\n%s", runner.startInput.Task)
	}
}

func TestSlackHistoryScannerBacksOffRateLimitedChannel(t *testing.T) {
	historyCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.list":
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"C123","name":"xp-test","is_member":true,"is_channel":true}]}`))
		case "/conversations.history":
			historyCalls++
			w.Header().Set("Retry-After", "120")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"ok":false,"error":"ratelimited"}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	defer func() { slackScannerAPIBaseURL = previousBaseURL }()

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken: "xoxb-test",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				Triage:   true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
		},
		Runner: &fakeRunner{job: agentrunner.Job{ID: "job_triage_poll", Provider: "codex", Status: agentrunner.StatusCompleted}},
	})
	service.inbound.SetCursor("C123", "1778765800.000000")

	first, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("first scan error = %v, want per-channel 429 recorded in result", err)
	}
	if !first.OK || len(first.Sweeps) != 1 || first.Sweeps[0].OK || !strings.Contains(first.Sweeps[0].Error, "slack_history_rate_limited_until") {
		t.Fatalf("first sweep = %#v, want channel backoff after rate limit", first)
	}
	second, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("second scan error = %v, want backoff skip without error", err)
	}
	if !second.OK || len(second.Sweeps) != 1 || second.Sweeps[0].OK || !strings.Contains(second.Sweeps[0].Error, "slack_history_rate_limited_until") {
		if !strings.Contains(second.Sweeps[0].Error, "slack_history_global_rate_limited_until") {
			t.Fatalf("second sweep = %#v, want channel/global backoff", second)
		}
	}
	if historyCalls != 1 {
		t.Fatalf("history calls = %d, want second scan to skip rate-limited channel", historyCalls)
	}
	if cursor := service.inbound.Cursor("C123"); cursor != "1778765800.000000" {
		t.Fatalf("cursor = %q, want unchanged while rate limited", cursor)
	}
}

func TestSlackHistoryScannerStopsSweepOnGlobalRateLimit(t *testing.T) {
	listCalls := 0
	historyCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.list":
			listCalls++
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"C123","name":"xp-test","is_member":true,"is_channel":true},{"id":"C456","name":"xp-second","is_member":true,"is_channel":true}]}`))
		case "/conversations.history":
			historyCalls++
			w.Header().Set("Retry-After", "120")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"ok":false,"error":"ratelimited"}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	defer func() { slackScannerAPIBaseURL = previousBaseURL }()

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken: "xoxb-test",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				Triage:   true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
		},
		Runner: &fakeRunner{job: agentrunner.Job{ID: "job_triage_poll", Provider: "codex", Status: agentrunner.StatusCompleted}},
	})
	service.inbound.SetCursor("C123", "1778765800.000000")
	service.inbound.SetCursor("C456", "1778765800.000000")

	first, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("first scan error = %v, want rate limit captured in sweep", err)
	}
	if !first.OK || len(first.Sweeps) != 1 || first.Sweeps[0].ChannelID != "C123" {
		t.Fatalf("first sweep = %#v, want scan to stop after first rate-limited channel", first)
	}
	if historyCalls != 1 {
		t.Fatalf("history calls = %d, want no fan-out after method rate limit", historyCalls)
	}
	if listCalls != 1 {
		t.Fatalf("list calls = %d, want first scan to list once", listCalls)
	}

	second, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("second scan error = %v, want global backoff skip", err)
	}
	if !second.OK || len(second.Sweeps) != 1 || second.Sweeps[0].ChannelID != "*" || !strings.Contains(second.Sweeps[0].Error, "slack_history_global_rate_limited_until") {
		t.Fatalf("second sweep = %#v, want global backoff", second)
	}
	if historyCalls != 1 {
		t.Fatalf("history calls = %d, want global backoff to skip history calls", historyCalls)
	}
	if listCalls != 1 {
		t.Fatalf("list calls = %d, want global backoff to skip list calls too", listCalls)
	}
}

func TestSlackHistoryScannerIgnoresBotAndSubtypeMessages(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.list":
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"C123","name":"xp-test","is_member":true,"is_channel":true}]}`))
		case "/conversations.history":
			if r.Form.Get("latest") != "" {
				_, _ = w.Write([]byte(`{"ok":true,"messages":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","bot_id":"B123","text":"bot noise","ts":"1778765844.000000"},{"type":"message","subtype":"channel_join","user":"U123","text":"joined","ts":"1778765843.000000"},{"type":"message","user":"U123","text":"human signal","ts":"1778765842.000000"}]}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	defer func() { slackScannerAPIBaseURL = previousBaseURL }()

	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_filter",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"scanner saw a human signal","actions":[{"type":"none","title":"No action","message":"test","channelId":"C123","threadTs":"1778765842.000000","confidence":0.9,"reason":"test","requiresConfirmation":false}]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken: "xoxb-test",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				Triage:   true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
			Triage: appconfig.SlackTriageConfig{HeuristicFallback: true},
		},
		Runner: runner,
	})
	service.inbound.SetCursor("C123", "1778765800.000000")

	result, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("scanSlackHistoryOnce: %v", err)
	}
	if !result.OK || len(result.Sweeps) != 1 {
		t.Fatalf("result = %#v, want one successful sweep", result)
	}
	sweep := result.Sweeps[0]
	if sweep.Scanned != 3 || sweep.Buffered != 1 || sweep.Flushed == nil || sweep.Flushed.Count != 1 {
		t.Fatalf("sweep = %#v, want only human message buffered", sweep)
	}
	if strings.Contains(runner.startInput.Task, "bot noise") || strings.Contains(runner.startInput.Task, "joined") {
		t.Fatalf("runner task included ignored messages:\n%s", runner.startInput.Task)
	}
	if !strings.Contains(runner.startInput.Task, "human signal") {
		t.Fatalf("runner task missing human message:\n%s", runner.startInput.Task)
	}
}
