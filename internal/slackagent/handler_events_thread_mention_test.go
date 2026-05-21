package slackagent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleEventsMessageMentionFallbackUsesThreadMeetURLJoinCard(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	meetingAgent := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		t.Fatalf("meeting agent should not be called before thread join options are selected: %s", request.URL.Path)
	}))
	defer meetingAgent.Close()
	router := newTestRouter(t, Config{
		MeetingAgentURL:        meetingAgent.URL,
		DefaultCaptionLanguage: "English",
		Slack:                  appconfig.SlackConfig{SigningSecret: "secret", BotUserID: "UBOT"},
		Poster:                 poster,
		AgentRunner:            appconfig.AgentRunnerConfig{Provider: "codex", DryRun: true},
	})

	body := `{
		"type":"event_callback",
		"event_id":"EvThreadMessageMention",
		"team_id":"T123",
		"event":{
			"type":"message",
			"channel_type":"channel",
			"user":"U123",
			"text":"<@UBOT>",
			"channel":"C123",
			"ts":"124.000",
			"thread_ts":"123.000"
		},
		"replies":[
			{"ts":"123.000","user":"U123","text":"https://meet.google.com/abc-defg-hij"},
			{"ts":"124.000","user":"U123","text":"<@UBOT>","thread_ts":"123.000"}
		]
	}`
	timestamp, signature := signedSlackJSONBody("secret", body)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var payload SlackEventResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.OK || !payload.Handled || payload.Mode != "message_mention" {
		t.Fatalf("payload = %#v, want handled message_mention", payload)
	}
	if payload.Response == nil || payload.Response.Text != "Join Google Meet: https://meet.google.com/abc-defg-hij" {
		t.Fatalf("response = %#v, want join setup card from thread Meet URL", payload.Response)
	}

	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 {
		t.Fatalf("poster calls = %d, want 1", len(calls))
	}
	if calls[0].Channel != "C123" || calls[0].ThreadTS != "123.000" {
		t.Fatalf("post input = %#v, want parent thread", calls[0])
	}
	if !strings.Contains(calls[0].Text, "Join Google Meet") {
		t.Fatalf("posted text = %q, want join setup card", calls[0].Text)
	}
}

func TestHandleEventsMessageRepliedMentionUsesThreadMeetURLJoinCard(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	meetingAgent := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		t.Fatalf("meeting agent should not be called before thread join options are selected: %s", request.URL.Path)
	}))
	defer meetingAgent.Close()
	router := newTestRouter(t, Config{
		MeetingAgentURL:        meetingAgent.URL,
		DefaultCaptionLanguage: "English",
		Slack:                  appconfig.SlackConfig{SigningSecret: "secret", BotUserID: "UBOT"},
		Poster:                 poster,
		AgentRunner:            appconfig.AgentRunnerConfig{Provider: "codex", DryRun: true},
	})

	body := `{
		"type":"event_callback",
		"event_id":"EvThreadMessageRepliedMention",
		"team_id":"T123",
		"event":{
			"type":"message",
			"subtype":"message_replied",
			"channel_type":"channel",
			"channel":"C123",
			"ts":"123.000",
			"event_ts":"124.001",
			"message":{
				"type":"message",
				"channel":"C123",
				"user":"U123",
				"text":"https://meet.google.com/rbq-ysvc-qxb",
				"ts":"123.000",
				"thread_ts":"123.000",
				"latest_reply":"124.000",
				"replies":[
					{"ts":"124.000","user":"U123","text":"<@UBOT>","thread_ts":"123.000"}
				]
			}
		}
	}`
	timestamp, signature := signedSlackJSONBody("secret", body)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var payload SlackEventResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.OK || !payload.Handled || payload.Mode != "message_mention" {
		t.Fatalf("payload = %#v, want handled message_mention", payload)
	}
	if payload.Response == nil || payload.Response.Text != "Join Google Meet: https://meet.google.com/rbq-ysvc-qxb" {
		t.Fatalf("response = %#v, want join setup card from message_replied thread", payload.Response)
	}

	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 {
		t.Fatalf("poster calls = %d, want 1", len(calls))
	}
	if calls[0].Channel != "C123" || calls[0].ThreadTS != "123.000" {
		t.Fatalf("post input = %#v, want parent thread", calls[0])
	}
	if !strings.Contains(calls[0].Text, "Join Google Meet") {
		t.Fatalf("posted text = %q, want join setup card", calls[0].Text)
	}
}

func TestHandleEventsMessageRepliedIgnoresUnrelatedThreadAfterOlderBotMention(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	router := newTestRouter(t, Config{
		DefaultCaptionLanguage: "English",
		Slack: appconfig.SlackConfig{
			SigningSecret: "secret",
			BotUserID:     "UBOT",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled: true,
			},
		},
		Poster:      poster,
		AgentRunner: appconfig.AgentRunnerConfig{Provider: "codex", DryRun: true},
	})

	body := `{
		"type":"event_callback",
		"event_id":"EvThreadMessageRepliedUnrelated",
		"team_id":"T123",
		"event":{
			"type":"message",
			"subtype":"message_replied",
			"channel_type":"channel",
			"channel":"C123",
			"ts":"123.000",
			"event_ts":"125.001",
			"message":{
				"type":"message",
				"channel":"C123",
				"user":"U123",
				"text":"讨论一下现有架构",
				"ts":"123.000",
				"thread_ts":"123.000",
				"latest_reply":"125.000",
				"replies":[
					{"ts":"124.000","user":"U123","text":"<@UBOT> 看下这里","thread_ts":"123.000"},
					{"ts":"125.000","user":"U456","text":"我补一句无关信息，不需要 bot 回","thread_ts":"123.000"}
				]
			}
		}
	}`
	timestamp, signature := signedSlackJSONBody("secret", body)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var payload SlackEventResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.OK || !payload.Ignored || payload.Mode != "event_buffer" {
		t.Fatalf("payload = %#v, want unrelated thread continuation ignored by mention fallback and only passed to scanner/buffer", payload)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want no direct bot reply for unrelated thread continuation", calls)
	}
}

func TestHandleEventsShortThreadMentionExpandsWorkerTaskFromThreadContext(t *testing.T) {
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_thread_context",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
		Mode:     "analysis",
	}}
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	router := newTestRouter(t, Config{
		DefaultCaptionLanguage: "English",
		Slack: appconfig.SlackConfig{
			SigningSecret: "secret",
			BotUserID:     "UBOT",
		},
		Poster: poster,
		Runner: runner,
	})

	body := `{
		"type":"event_callback",
		"event_id":"EvShortThreadMentionContext",
		"team_id":"T123",
		"event":{
			"type":"message",
			"channel_type":"channel",
			"user":"U123",
			"text":"<@UBOT> 你来试试",
			"channel":"C123",
			"ts":"124.000",
			"thread_ts":"123.000"
		},
		"replies":[
			{"ts":"123.000","user":"U456","text":"刚刚会议最后 JC 讲了 Bridge 作为 managed agent 和 Manus 的区别，帮忙摘出来"},
			{"ts":"124.000","user":"U123","text":"<@UBOT> 你来试试","thread_ts":"123.000"}
		]
	}`
	timestamp, signature := signedSlackJSONBody("secret", body)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if runner.startCount != 1 {
		t.Fatalf("runner starts = %d, want 1", runner.startCount)
	}
	if !strings.Contains(runner.startInput.Task, "Use the Slack thread context to infer and complete the concrete request") ||
		!strings.Contains(runner.startInput.Task, "Latest mention: 你来试试") {
		t.Fatalf("worker task = %q, want contextual task expansion", runner.startInput.Task)
	}
	prompt, _ := runner.startInput.Context["slackAssistantPrompt"].(string)
	if !strings.Contains(prompt, "managed agent") || !strings.Contains(prompt, "Manus") {
		t.Fatalf("slackAssistantPrompt = %q, want parent thread request", prompt)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want no immediate visible ack for running worker", calls)
	}
}

func TestHandleEventsMessageMentionFallbackIgnoresOtherUserMention(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	router := newTestRouter(t, Config{
		DefaultCaptionLanguage: "English",
		Slack: appconfig.SlackConfig{
			SigningSecret: "secret",
			BotUserID:     "UBOT",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled: true,
			},
		},
		Poster:      poster,
		AgentRunner: appconfig.AgentRunnerConfig{Provider: "codex", DryRun: true},
	})

	body := `{
		"type":"event_callback",
		"event_id":"EvMessageMentionsSomeoneElse",
		"team_id":"T123",
		"event":{
			"type":"message",
			"channel_type":"channel",
			"user":"U123",
			"text":"prod Willow/control DB 里查到了吗 <@UOTHER> ` + "`" + `name = 'onboarding-bot-hourly'` + "`" + ` 查 schedules",
			"channel":"C123",
			"ts":"1778808469.644499",
			"thread_ts":"1778779797.697749"
		}
	}`
	timestamp, signature := signedSlackJSONBody("secret", body)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var payload SlackEventResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.OK || !payload.Handled || payload.Mode != "event_buffer" {
		t.Fatalf("payload = %#v, want ordinary message buffered, not treated as bot mention", payload)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want no direct bot mention response", calls)
	}
}
