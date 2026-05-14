package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestAppMentionBuildsRichThreadContextForDelegate(t *testing.T) {
	runner := &fakeRunner{
		job: agentrunner.Job{
			ID:       "job_rich_context",
			Provider: "codex",
			Status:   agentrunner.StatusRunning,
			Task:     "please summarize",
		},
	}
	router := newTestRouter(t, Config{
		Slack:  appconfig.SlackConfig{SigningSecret: "secret"},
		Runner: runner,
		Poster: &recordingPoster{callCh: make(chan struct{}, 1)},
	})

	body := `{
		"type":"event_callback",
		"event_id":"EvRichContext",
		"team_id":"T123",
		"event":{
			"type":"app_mention",
			"user":"U123",
			"text":"<@UBOT> please summarize",
			"channel":"C123",
			"ts":"123.456",
			"thread_messages":[
				{"ts":"123.000","user":"U999","user_name":"peng","text":"Parent message https://meet.google.com/abc-defg-hij","files":[{"id":"F1","name":"diagram.png","mimetype":"image/png","size":42,"permalink":"https://slack/files/F1"}]},
				{"ts":"123.456","user":"U123","user_name":"peng","text":"<@UBOT> please summarize"}
			],
			"meeting_context":"live meeting is running",
			"thread_permalink":"https://slack/thread/123"
		}
	}`
	response := postSignedEvent(t, router, "secret", body)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if runner.startInput.Task != "please summarize" {
		t.Fatalf("task = %q, want rich mention text task", runner.startInput.Task)
	}
	rich, ok := runner.startInput.Context["slackAppMention"].(*SlackAppMentionContext)
	if !ok || rich == nil {
		t.Fatalf("slackAppMention = %#v, want rich context", runner.startInput.Context["slackAppMention"])
	}
	if rich.MentionText != "please summarize" || !rich.ContainsMeetURL {
		t.Fatalf("rich context = %#v, want mention text and meet-url detection", rich)
	}
	if !strings.Contains(rich.Transcript, "Parent message") || !strings.Contains(rich.Prompt, "Live meeting status:") {
		t.Fatalf("rich prompt/transcript missing expected context: %#v", rich)
	}
	memory, ok := runner.startInput.Context["localSlackMemory"].(SlackMemoryAgentContext)
	if !ok || memory.Enabled {
		t.Fatalf("localSlackMemory = %#v, want disabled local memory context", runner.startInput.Context["localSlackMemory"])
	}
}

func TestJobsCommandIncludesMeetingWorkerPoll(t *testing.T) {
	meetingServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/worker/jobs":
			_ = json.NewEncoder(w).Encode(meetingWorkerJobsResponse{
				OK: true,
				Jobs: []meetingWorkerJob{{
					ID: "meeting_job_1", Status: "running", Task: "meeting task",
				}},
			})
		case "/worker/poll-slack":
			_ = json.NewEncoder(w).Encode(meetingWorkerPollResponse{
				OK: true,
				Jobs: []meetingWorkerJob{{
					ID: "meeting_job_done", Status: "completed", Task: "meeting summary", Result: "summary done",
				}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer meetingServer.Close()

	service := NewService(Config{
		Persistence:           appconfig.PersistenceConfig{Provider: "memory"},
		MeetingAgentURL:       meetingServer.URL,
		Runner:                &fakeRunner{job: agentrunner.Job{ID: "job_local", Provider: "codex", Status: agentrunner.StatusCompleted, Task: "local task"}},
		Slack:                 appconfig.SlackConfig{InternalAuthKey: "key"},
		Poster:                &recordingPoster{},
		Assistant:             &recordingAssistant{},
		ScheduleManager:       nil,
		OAuthExchanger:        nil,
		CanvasPublisher:       nil,
		AgentRunner:           appconfig.AgentRunnerConfig{Provider: "codex"},
		CanvasPublisherConfig: CanvasPublisherConfig{},
	})

	response := service.RunAvatarCommand(context.Background(), AvatarCommandInput{
		Text:      "jobs",
		TeamID:    "T123",
		ChannelID: "C123",
		ThreadTS:  "123.456",
		UserID:    "U123",
		Command:   "app_mention",
	})
	if !response.OK {
		t.Fatalf("response = %#v, want ok", response)
	}
	if !strings.Contains(response.Text, "Worker jobs: local=1, meeting=1") {
		t.Fatalf("text = %q, want local/meeting count", response.Text)
	}
	if !strings.Contains(response.Text, "Worker meeting_job_done completed: meeting summary\nsummary done") {
		t.Fatalf("text = %q, want ready meeting worker output", response.Text)
	}
	if response.Metadata["slack_context"] == nil || response.Metadata["ready_for_slack"] == nil {
		t.Fatalf("metadata = %#v, want slack context and ready_for_slack", response.Metadata)
	}
}

func TestEventTextToAvatarCommandDoesNotTreatGoOnlyCommandsAsExplicit(t *testing.T) {
	if got := eventTextToAvatarCommand(SlackEventPayload{Text: "<@UBOT> cancel job_1"}); got != "delegate cancel job_1" {
		t.Fatalf("cancel command = %q, want delegate fallback", got)
	}
	if got := eventTextToAvatarCommand(SlackEventPayload{Text: "<@UBOT> schedule list"}); got != "delegate schedule list" {
		t.Fatalf("schedule command = %q, want delegate fallback", got)
	}
}

func TestTerminalWorkerJobReportsToMeetingAgent(t *testing.T) {
	var reportBody map[string]any
	meetingServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/worker/report" {
			t.Fatalf("path = %q, want /worker/report", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&reportBody); err != nil {
			t.Fatalf("decode report body: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "job": reportBody})
	}))
	defer meetingServer.Close()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		MeetingAgentURL: meetingServer.URL,
		Poster:          poster,
		Assistant:       &recordingAssistant{},
	})
	service.handleAgentRunnerUpdate(context.Background(), agentrunner.Job{
		ID:               "job_terminal",
		Provider:         "codex",
		Status:           agentrunner.StatusCompleted,
		Mode:             "analysis",
		Task:             "terminal task",
		Result:           "terminal result",
		AllowCodeChanges: true,
		Context: map[string]any{
			"slack": map[string]any{"channelId": "C123", "threadTs": "123.456"},
		},
	})
	poster.WaitForCalls(t, 1)
	if reportBody["id"] != "job_terminal" || reportBody["result"] != "terminal result" {
		t.Fatalf("report body = %#v, want terminal job payload", reportBody)
	}
}
