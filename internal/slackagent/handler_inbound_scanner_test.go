package slackagent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestSlackHistoryScannerPostsPendingActionCard(t *testing.T) {
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
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U123","text":"please follow up with Alice tomorrow","ts":"1778765842.000000"}]}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	defer func() { slackScannerAPIBaseURL = previousBaseURL }()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_card",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"Alice follow-up requested","actions":[{"type":"follow_up","title":"Follow up with Alice","message":"Confirm whether to follow up with Alice tomorrow.","channelId":"C123","threadTs":"1778765842.000000","confidence":0.94,"reason":"The user explicitly asked for a follow-up.","requiresConfirmation":true}]}`,
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
				PostActions:       true,
				HeuristicFallback: true,
			},
			PilotUserID: "U_PENG",
		},
		Poster: poster,
		Runner: runner,
	})
	service.operatorFallback.DM.CacheDM("U_PENG", "D_PENG")
	service.inbound.SetCursor("C123", "1778765800.000000")

	result, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("scanSlackHistoryOnce: %v", err)
	}
	if !result.OK || len(result.Sweeps) != 1 || result.Sweeps[0].Flushed == nil {
		t.Fatalf("result = %#v, want flushed scanner result", result)
	}
	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 {
		t.Fatalf("poster calls = %d, want 1", len(calls))
	}
	call := calls[0]
	if call.Channel != "C123" || call.ThreadTS != "1778765842.000000" || !strings.Contains(call.Text, "Triage suggestion: Follow up with Alice") {
		t.Fatalf("post call = %#v, want pending action card in source thread", call)
	}
	if len(call.Blocks) == 0 || !strings.Contains(call.DedupKey, "slack-triage-action:") {
		t.Fatalf("post call = %#v, want blocks and triage dedup key", call)
	}
}

func TestSlackHistoryScannerPostsDirectReadOnlyReplyForExternalLink(t *testing.T) {
	reader := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`Title: Peter Steinberger on X: codex review loop

Markdown Content:
Wrote a skill that runs codex /review in a loop until there's no booboos anymore.
Caveat: It won't fix system architecture for ya, so you still need BRAIN as master model.`))
	}))
	defer reader.Close()
	previousReaderURL := slackExternalLinkReaderURL
	slackExternalLinkReaderURL = func(rawURL string) string {
		return reader.URL + "/?url=" + url.QueryEscape(rawURL)
	}
	defer func() { slackExternalLinkReaderURL = previousReaderURL }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.list":
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"C123","name":"drylab","is_member":true,"is_channel":true}]}`))
		case "/conversations.history":
			if r.Form.Get("latest") != "" {
				_, _ = w.Write([]byte(`{"ok":true,"messages":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U123","text":"https://x.com/steipete/status/2054850632067019173","ts":"1778767510.917049"}]}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	defer func() { slackScannerAPIBaseURL = previousBaseURL }()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_x_link",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"X link summarized","actions":[{"type":"post_thread_reply","title":"X link summary","message":"这条 X 主要在讨论一个开发工具观察，值得留意。","channelId":"C123","threadTs":"1778767510.917049","confidence":0.86,"reason":"Public external links are read-only and should be answered directly.","requiresConfirmation":false}]}`,
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
				PostActions:       true,
				HeuristicFallback: true,
			},
			PilotUserID: "U_PENG",
		},
		Poster: poster,
		Runner: runner,
	})
	service.operatorFallback.DM.CacheDM("U_PENG", "D_PENG")
	service.inbound.SetCursor("C123", "1778767000.000000")

	result, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("scanSlackHistoryOnce: %v", err)
	}
	if !result.OK || len(result.Sweeps) != 1 || result.Sweeps[0].Flushed == nil {
		t.Fatalf("result = %#v, want flushed scanner result", result)
	}
	if !strings.Contains(runner.startInput.Task, "Fetched external links") || !strings.Contains(runner.startInput.Task, "codex /review") {
		t.Fatalf("runner task missing fetched external link context:\n%s", runner.startInput.Task)
	}
	externalLinks, ok := runner.startInput.Context["externalLinks"].([]SlackExternalLinkContext)
	if !ok || len(externalLinks) != 1 || !strings.Contains(externalLinks[0].Excerpt, "codex /review") {
		t.Fatalf("externalLinks context = %#v, want fetched X content", runner.startInput.Context["externalLinks"])
	}
	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 {
		t.Fatalf("poster calls = %d, want 1 direct thread reply", len(calls))
	}
	call := calls[0]
	if call.Channel != "C123" || call.ThreadTS != "1778767510.917049" || !strings.Contains(call.Text, "这条 X") {
		t.Fatalf("post call = %#v, want direct thread reply", call)
	}
	if len(call.Blocks) == 0 || strings.Contains(call.Text, "待确认回复") || strings.Contains(call.DedupKey, "pilot_dm:") {
		t.Fatalf("post call = %#v, want public reply blocks without approval card", call)
	}
	status, err := service.TriageStatus(context.Background(), 10)
	if err != nil {
		t.Fatalf("TriageStatus: %v", err)
	}
	if len(status.PendingActions) != 0 {
		t.Fatalf("pending actions = %#v, want no read-only reply pending action", status.PendingActions)
	}
}

func TestSlackHistoryScannerDoesNotOverrideExplicitNoActionForExternalLink(t *testing.T) {
	reader := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`Title: Fiachra on X: the era of discomorphism has arrived

Markdown Content:
Log in
Sign up
Post
Conversation
the era of discomorphism has arrived
Trending now`))
	}))
	defer reader.Close()
	previousReaderURL := slackExternalLinkReaderURL
	slackExternalLinkReaderURL = func(rawURL string) string {
		return reader.URL + "/?url=" + url.QueryEscape(rawURL)
	}
	defer func() { slackExternalLinkReaderURL = previousReaderURL }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.list":
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"C123","name":"bridge-app","is_member":true,"is_channel":true}]}`))
		case "/conversations.history":
			if r.Form.Get("latest") != "" {
				_, _ = w.Write([]byte(`{"ok":true,"messages":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U123","text":"https://x.com/FiachraRM/status/2056172311620075824?s=20 今天都在发这个 蹭一下？","ts":"1779090616.617509"}]}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	defer func() { slackScannerAPIBaseURL = previousBaseURL }()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_x_link_no_action",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"casual trend link; no action needed","actions":[]}`,
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
				PostActions:       true,
				HeuristicFallback: true,
			},
		},
		Poster: poster,
		Runner: runner,
	})
	service.inbound.SetCursor("C123", "1779090000.000000")

	result, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("scanSlackHistoryOnce: %v", err)
	}
	if !result.OK || len(result.Sweeps) != 1 || result.Sweeps[0].Flushed == nil {
		t.Fatalf("result = %#v, want flushed scanner result", result)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want explicit no-action to remain silent", calls)
	}
	status, err := service.TriageStatus(context.Background(), 10)
	if err != nil {
		t.Fatalf("TriageStatus: %v", err)
	}
	if len(status.Runs) == 0 || len(status.Runs[0].Actions) != 0 || status.Runs[0].Mutations != 0 {
		t.Fatalf("recent run = %#v, want no fallback direct reply", status.Runs)
	}
}

func TestSlackHistoryScannerDoesNotAskBeforeReadingExternalLink(t *testing.T) {
	reader := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`Title: Peter Steinberger on X: codex review loop

Markdown Content:
Wrote a skill that runs codex /review in a loop until there's no booboos anymore.`))
	}))
	defer reader.Close()
	previousReaderURL := slackExternalLinkReaderURL
	slackExternalLinkReaderURL = func(rawURL string) string {
		return reader.URL + "/?url=" + url.QueryEscape(rawURL)
	}
	defer func() { slackExternalLinkReaderURL = previousReaderURL }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.list":
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"C123","name":"drylab","is_member":true,"is_channel":true}]}`))
		case "/conversations.history":
			if r.Form.Get("latest") != "" {
				_, _ = w.Write([]byte(`{"ok":true,"messages":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U123","text":"https://x.com/steipete/status/2054850632067019173","ts":"1778767510.917049"}]}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	defer func() { slackScannerAPIBaseURL = previousBaseURL }()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_x_link_confirm",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"X link needs reading","actions":[{"type":"follow_up","title":"核实并总结 X 链接","message":"是否读取这条 @steipete 的 X 动态，并提炼可以回复什么？","channelId":"C123","threadTs":"1778767510.917049","confidence":0.7,"reason":"需要先读链接。","requiresConfirmation":true}]}`,
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
				PostActions:       true,
				HeuristicFallback: true,
			},
		},
		Poster: poster,
		Runner: runner,
	})
	service.inbound.SetCursor("C123", "1778767000.000000")

	result, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("scanSlackHistoryOnce: %v", err)
	}
	if !result.OK || len(result.Sweeps) != 1 || result.Sweeps[0].Flushed == nil {
		t.Fatalf("result = %#v, want flushed scanner result", result)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want no confirmation card asking whether to read an external link", calls)
	}
	status, err := service.TriageStatus(context.Background(), 10)
	if err != nil {
		t.Fatalf("TriageStatus: %v", err)
	}
	if len(status.PendingActions) != 0 {
		t.Fatalf("pending actions = %#v, want external-link read confirmation suppressed", status.PendingActions)
	}
}

func TestSlackHistoryScannerDoesNotSynthesizeSharedArticleWhenModelSkips(t *testing.T) {
	reader := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`Title: 大语言模型为什么能像人一样说话和思考？

Markdown Content:
本文讨论 LLM 的语言和思考能力是怎样形成的。主要观点是：LLM 学习到的不只是词汇和语法的低阶模式，也包括语义、语用、世界知识和推理的高阶模式；NTP 只是表层形式，整体能力来自数据、Transformer、SGD、预训练、后训练和推理时搜索共同作用。文章也提醒幻觉、具身认知和严谨数学推理仍是局限。`))
	}))
	defer reader.Close()
	previousReaderURL := slackExternalLinkReaderURL
	slackExternalLinkReaderURL = func(rawURL string) string {
		return reader.URL + "/?url=" + url.QueryEscape(rawURL)
	}
	defer func() { slackExternalLinkReaderURL = previousReaderURL }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.list":
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"C123","name":"drylab","is_member":true,"is_channel":true}]}`))
		case "/conversations.history":
			if r.Form.Get("latest") != "" {
				_, _ = w.Write([]byte(`{"ok":true,"messages":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U123","text":"https://github.com/hangli-hl/AI-Articles/blob/main/llm-thinking.pdf","ts":"1779076415.945449"}]}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	defer func() { slackScannerAPIBaseURL = previousBaseURL }()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_shared_article_skip",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   "No action.\n\n只是分享链接，无需助手介入。",
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
				PostActions:       true,
				HeuristicFallback: true,
			},
		},
		Poster: poster,
		Runner: runner,
	})
	service.inbound.SetCursor("C123", "1779076000.000000")

	result, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("scanSlackHistoryOnce: %v", err)
	}
	if !result.OK || len(result.Sweeps) != 1 || result.Sweeps[0].Flushed == nil {
		t.Fatalf("result = %#v, want flushed scanner result", result)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want explicit model skip to stay silent", calls)
	}
}

func TestSlackHistoryScannerKeepsLowSignalLinksSilentWhenModelSkips(t *testing.T) {
	reader := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`Title: hi

Markdown Content:
lol`))
	}))
	defer reader.Close()
	previousReaderURL := slackExternalLinkReaderURL
	slackExternalLinkReaderURL = func(rawURL string) string {
		return reader.URL + "/?url=" + url.QueryEscape(rawURL)
	}
	defer func() { slackExternalLinkReaderURL = previousReaderURL }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.list":
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"C123","name":"drylab","is_member":true,"is_channel":true}]}`))
		case "/conversations.history":
			if r.Form.Get("latest") != "" {
				_, _ = w.Write([]byte(`{"ok":true,"messages":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U123","text":"https://example.com/u/1","ts":"1779076415.945449"}]}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	defer func() { slackScannerAPIBaseURL = previousBaseURL }()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_low_signal_link_skip",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   "No action.\n\n低信号链接，无需助手介入。",
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
				PostActions:       true,
				HeuristicFallback: true,
			},
		},
		Poster: poster,
		Runner: runner,
	})
	service.inbound.SetCursor("C123", "1779076000.000000")

	result, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("scanSlackHistoryOnce: %v", err)
	}
	if !result.OK || len(result.Sweeps) != 1 || result.Sweeps[0].Flushed == nil {
		t.Fatalf("result = %#v, want flushed scanner result", result)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want low-signal link to remain silent", calls)
	}
}

func TestSlackHistoryScannerIgnoresBareSlackPermalinkActions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.list":
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"C123","name":"drylab","is_member":true,"is_channel":true}]}`))
		case "/conversations.history":
			if r.Form.Get("latest") != "" {
				_, _ = w.Write([]byte(`{"ok":true,"messages":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U123","text":"https://cue-3kl2780.slack.com/archives/C0AQ0C0KVMH/p1778767624846809","ts":"1778767624.846809"}]}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	defer func() { slackScannerAPIBaseURL = previousBaseURL }()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_slack_permalink",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"Bare Slack permalink only","actions":[{"type":"follow_up","title":"核实并总结 Slack 链接","message":"是否读取这条 Slack 链接并总结？","channelId":"C123","threadTs":"1778767624.846809","confidence":0.58,"reason":"消息只有内部 Slack 链接。","requiresConfirmation":true}]}`,
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
				PostActions:       true,
				HeuristicFallback: true,
			},
		},
		Poster: poster,
		Runner: runner,
	})
	service.inbound.SetCursor("C123", "1778767000.000000")

	result, err := service.scanSlackHistoryOnce(context.Background(), time.Hour)
	if err != nil {
		t.Fatalf("scanSlackHistoryOnce: %v", err)
	}
	if !result.OK || len(result.Sweeps) != 1 || result.Sweeps[0].Flushed == nil {
		t.Fatalf("result = %#v, want flushed scanner result", result)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want no reply or confirmation card for bare Slack permalink", calls)
	}
	status, err := service.TriageStatus(context.Background(), 10)
	if err != nil {
		t.Fatalf("TriageStatus: %v", err)
	}
	if len(status.PendingActions) != 0 {
		t.Fatalf("pending actions = %#v, want bare Slack permalink suppressed", status.PendingActions)
	}
	if len(status.Runs) == 0 || len(status.Runs[0].Actions) != 0 {
		t.Fatalf("runs = %#v, want suppressed action recorded as no-op", status.Runs)
	}
}

func TestSlackHistoryScannerAddsCueboardContextAndThreadFetchAudit(t *testing.T) {
	var sawContextHistory bool
	var sawNewHistory bool
	var sawThreadFetch bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.list":
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"C123","name":"drylab","is_member":true,"is_channel":true}]}`))
		case "/conversations.history":
			if latest := r.Form.Get("latest"); latest != "" {
				sawContextHistory = true
				if latest != "1778765800.000000" || r.Form.Get("limit") != "3" || r.Form.Get("inclusive") != "false" {
					t.Fatalf("context history form = %s", r.Form.Encode())
				}
				_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U000","text":"previous context matters","ts":"1778765799.000000"}]}`))
				return
			}
			sawNewHistory = true
			if got := r.Form.Get("oldest"); got != "1778765800.000000" {
				t.Fatalf("oldest = %q, want stored cursor", got)
			}
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U123","text":"this reply needs full thread","ts":"1778765842.164299","thread_ts":"1778765700.000000"}]}`))
		case "/conversations.replies":
			sawThreadFetch = true
			if r.URL.Query().Get("channel") != "C123" || r.URL.Query().Get("ts") != "1778765700.000000" {
				t.Fatalf("replies query = %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U111","text":"thread root has the actual ask","ts":"1778765700.000000"},{"type":"message","user":"U123","text":"this reply needs full thread","ts":"1778765842.164299","thread_ts":"1778765700.000000"}]}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	previousThreadBaseURL := slackThreadFetchAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	slackThreadFetchAPIBaseURL = server.URL
	defer func() {
		slackScannerAPIBaseURL = previousBaseURL
		slackThreadFetchAPIBaseURL = previousThreadBaseURL
	}()

	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_context",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"thread context fetched","actions":[]}`,
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
	if !result.OK || len(result.Sweeps) != 1 || result.Sweeps[0].Flushed == nil {
		t.Fatalf("result = %#v, want flushed scanner result", result)
	}
	if !sawContextHistory || !sawNewHistory || !sawThreadFetch {
		t.Fatalf("saw context=%v new=%v thread=%v, want all true", sawContextHistory, sawNewHistory, sawThreadFetch)
	}
	task := runner.startInput.Task
	for _, want := range []string{
		`(context) <@U000>: "previous context matters"`,
		`• [ref:m1 msg_ts:1778765842.164299] <@U123>: "this reply needs full thread" [reply in thread_ts:1778765700.000000]`,
		"Fetched Slack thread context:",
		"thread root has the actual ask",
	} {
		if !strings.Contains(task, want) {
			t.Fatalf("runner task missing %q:\n%s", want, task)
		}
	}
	threadContexts, ok := runner.startInput.Context["threadContexts"].([]SlackTriageThreadContext)
	if !ok || len(threadContexts) != 1 || !threadContexts[0].FetchOK || threadContexts[0].MessageCount != 2 {
		t.Fatalf("threadContexts = %#v", runner.startInput.Context["threadContexts"])
	}
	run := result.Sweeps[0].Flushed.Triage.Finalization.Run
	if run.Metadata["thread_context_fetched"] != true || run.Metadata["thread_context_messages"] != 2 {
		t.Fatalf("metadata = %#v, want thread context audit", run.Metadata)
	}
	if run.Metadata["input_context_chars"] == nil || run.Metadata["suppressed_reason"] != "no_actions" {
		t.Fatalf("metadata = %#v, want input chars and no_actions suppression", run.Metadata)
	}
}

func TestSlackTriageExpandsLowContextStandaloneMessages(t *testing.T) {
	var sawHistoryContext bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conversations.history":
			sawHistoryContext = true
			if r.Form.Get("channel") != "C123" || r.Form.Get("latest") != "1778765842.164299" || r.Form.Get("limit") != "3" || r.Form.Get("inclusive") != "false" {
				t.Fatalf("history context form = %s", r.Form.Encode())
			}
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U111","text":"previous channel context that disambiguates the short reply","ts":"1778765800.000000"}]}`))
		default:
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	previousBaseURL := slackScannerAPIBaseURL
	slackScannerAPIBaseURL = server.URL
	defer func() { slackScannerAPIBaseURL = previousBaseURL }()

	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_low_context",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"short message skipped after channel context","actions":[]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotToken: "xoxb-test",
			Triage:   appconfig.SlackTriageConfig{HeuristicFallback: true},
		},
		Runner: runner,
	})

	started, err := service.StartSlackTriage(context.Background(), "C123", []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "？？",
		TS:        "1778765842.164299",
	}}, "？？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	if !sawHistoryContext {
		t.Fatal("expected low-context standalone triage to fetch channel history context")
	}
	task := runner.startInput.Task
	for _, want := range []string{
		`(context) <@U111>: "previous channel context that disambiguates the short reply"`,
		`--- new messages ---`,
		`[ref:m1 msg_ts:1778765842.164299] <@U123>: "？？"`,
	} {
		if !strings.Contains(task, want) {
			t.Fatalf("runner task missing %q:\n%s", want, task)
		}
	}
	run := started.Finalization.Run
	if run.Metadata["channel_context_fetched"] != true || run.Metadata["channel_context_messages"] != 1 {
		t.Fatalf("metadata = %#v, want channel context audit", run.Metadata)
	}
	if got := run.Metadata["input_context_chars"]; got == nil || got == 0 {
		t.Fatalf("metadata = %#v, want input_context_chars", run.Metadata)
	}
}

func TestSlackTriageActionlessDecisionPersistsThreadMemory(t *testing.T) {
	workspaceDir := t.TempDir()
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_memory",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"decision: cueboard drag upload work was already handled by another bot; no office-helper action needed.","actions":[]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Triage:       appconfig.SlackTriageConfig{HeuristicFallback: true},
			Memory:       appconfig.SlackMemoryConfig{Enabled: true, Dir: t.TempDir()},
		},
		Runner: runner,
	})

	started, err := service.StartSlackTriage(context.Background(), "C123", []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "cueboard drag upload is already being handled",
		TS:        "1778765842.164299",
		ThreadTS:  "1778765700.000000",
	}}, `#cueboard (C123): cueboard drag upload is already being handled`)
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	if started.Finalization == nil || started.Finalization.Run == nil {
		t.Fatalf("started = %#v, want finalization", started)
	}
	records, err := service.cognition.ListRecentThreadLedgers(context.Background(), "T123", "C123", 5)
	if err != nil {
		t.Fatalf("ListRecentThreadLedgers: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("records = %#v, want one thread memory record", records)
	}
	record := records[0]
	if record.ThreadTS != "1778765700.000000" || record.LastActionType != "triage" || record.LastActionStatus != "no_action" {
		t.Fatalf("record = %#v, want triage no_action thread record", record)
	}
	if !strings.Contains(record.Summary, "cueboard drag upload work") {
		t.Fatalf("record summary = %q, want triage summary", record.Summary)
	}
	brain, err := service.cognition.GetChannelBrain(context.Background(), "T123", "C123")
	if err != nil {
		t.Fatalf("GetChannelBrain: %v", err)
	}
	if brain == nil || !strings.Contains(brain.Summary, "cueboard drag upload work") {
		t.Fatalf("brain = %#v, want channel brain to retain triage memory", brain)
	}
	results := service.SearchLocalMemory("cueboard drag upload", 5)
	foundProjection := false
	for _, result := range results {
		if result.Kind == "triage_projection" && strings.Contains(result.Content, "already handled by another bot") {
			foundProjection = true
		}
	}
	if !foundProjection {
		t.Fatalf("results = %#v, want searchable triage projection", results)
	}
}

func signedSlackEventRequest(t *testing.T, router http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	timestamp, signature := signedSlackJSONBody("secret", body)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	router.ServeHTTP(response, request)
	return response
}
