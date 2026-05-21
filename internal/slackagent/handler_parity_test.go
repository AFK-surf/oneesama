package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
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

func TestAppMentionContextIncludesRelatedMemoryEvidence(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/team/meetings/jc-case-study.md", strings.Join([]string{
		"# Meeting 45",
		"Jc discussed a product launch video with five use case demos.",
		"It was a promo video project, not a recorded Case Study video set.",
	}, "\n"))

	service := NewService(Config{
		Slack: appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})
	context := service.buildAgentRunnerContext(context.Background(), AvatarCommandInput{
		ChannelName: "xp-test",
		UserName:    "vincent",
		RichThreadContext: &SlackAppMentionContext{
			MentionText: "jc说之前录制了5个Case Study的视频，这个有吗？",
			Transcript:  "[1779155703.395489] <@U1>: jc说之前录制了5个Case Study的视频，这个有吗？",
			Prompt:      "Thread context:\njc说之前录制了5个Case Study的视频，这个有吗？",
		},
	}, parsedAvatarCommand{Action: "work"}, nil)

	related, ok := context["relatedMemory"].(SlackRelatedMemorySearchResult)
	if !ok {
		t.Fatalf("relatedMemory = %#v, want search result", context["relatedMemory"])
	}
	if len(related.Results) == 0 {
		t.Fatalf("relatedMemory = %#v, want evidence for mixed CJK/English query", related)
	}
	evidence, ok := context["relatedMemoryEvidence"].(string)
	if !ok || !strings.Contains(evidence, "memory/team/meetings/jc-case-study.md") || !strings.Contains(evidence, "not a recorded Case Study") {
		t.Fatalf("relatedMemoryEvidence = %q, want cited meeting memory", evidence)
	}
}

func TestAppMentionExternalLinkContextDrivesConceptualRelatedMemory(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/2026-03-30.md", strings.Join([]string{
		"# 2026-03-30",
		"",
		"## Multi-agent architecture (PR #1223, still draft)",
		"Peng and codex-3720 discussed the botarena IM agent picker design.",
		"The direction was a runtime/VM-isolated multi-agent system rather than hand-written prompt templates.",
	}, "\n"))

	service := NewService(Config{
		Slack: appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})
	context := service.buildAgentRunnerContext(context.Background(), AvatarCommandInput{
		ChannelName: "bridge-app",
		UserName:    "kagami",
		RichThreadContext: &SlackAppMentionContext{
			MentionText: "<https://github.com/msitarzewski/agency-agents> 我们讨论过这个嘛",
			Transcript:  "[1779165766.771209] <@U1>: <https://github.com/msitarzewski/agency-agents> <@UBOT> 我们讨论过这个嘛",
			Prompt:      "Thread context:\n<https://github.com/msitarzewski/agency-agents> 我们讨论过这个嘛",
			ExternalLinks: []SlackExternalLinkContext{{
				URL:   "https://github.com/msitarzewski/agency-agents",
				Title: "GitHub - msitarzewski/agency-agents: A complete AI agency at your fingertips",
				Excerpt: strings.Join([]string{
					"A complete AI agency at your fingertips.",
					"Each agent is a specialized expert with personality, processes, workflows, and deliverables.",
					"The project packages frontend wizards, Reddit community operators, and other AI agents into a team.",
				}, " "),
				Source: "jina_reader",
			}},
		},
	}, parsedAvatarCommand{Action: "work"}, nil)

	related, ok := context["relatedMemory"].(SlackRelatedMemorySearchResult)
	if !ok {
		t.Fatalf("relatedMemory = %#v, want search result", context["relatedMemory"])
	}
	if !strings.Contains(related.Query, "external link context:") {
		t.Fatalf("relatedMemory query = %q, want supplemental external link query", related.Query)
	}
	evidence, ok := context["relatedMemoryEvidence"].(string)
	if !ok || !strings.Contains(evidence, "memory/2026-03-30.md") || !strings.Contains(evidence, "PR #1223") || !strings.Contains(evidence, "agent picker") {
		t.Fatalf("relatedMemoryEvidence = %q, want conceptual memory from link context", evidence)
	}
}

func TestAppMentionContextIncludesFirstClassFreshSearchEvidence(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/search" || !strings.Contains(r.URL.Query().Get("q"), "Zyphra Labs") {
			t.Fatalf("url = %s, want first-class exa_search query for Zyphra Labs", r.URL.String())
		}
		_, _ = w.Write([]byte("Title: Search results\n\nZyphra Labs builds audio and voice AI models."))
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

	service := NewService(Config{})
	rich := &SlackAppMentionContext{
		MentionText: "Zyphra Labs 是什么？",
		Transcript:  "[1779155703.395489] <@U1>: Zyphra Labs 是什么？",
		Prompt:      "Thread context:\nZyphra Labs 是什么？",
	}
	context := service.buildAgentRunnerContext(context.Background(), AvatarCommandInput{
		ChannelName:       "xp-test",
		UserName:          "vincent",
		RichThreadContext: rich,
	}, parsedAvatarCommand{Action: "work"}, nil)

	evidence, ok := context["slackToolEvidence"].(string)
	if !ok || !strings.Contains(evidence, "exa_search") || !strings.Contains(evidence, "Zyphra Labs builds audio") {
		t.Fatalf("slackToolEvidence = %q, want first-class exa_search evidence", evidence)
	}
	if len(rich.ToolEvidence) != 1 || rich.ToolEvidence[0].Tool != "exa_search" || !rich.ToolEvidence[0].OK {
		t.Fatalf("rich.ToolEvidence = %#v, want successful exa_search evidence", rich.ToolEvidence)
	}
	prompt, ok := context["slackAssistantPrompt"].(string)
	if !ok || !strings.Contains(prompt, "First-class tool evidence:") || !strings.Contains(prompt, "Zyphra Labs builds audio") {
		t.Fatalf("slackAssistantPrompt = %q, want first-class tool evidence", prompt)
	}
}

func TestAppMentionMediaRequestAddsFileContextEvidence(t *testing.T) {
	service := NewService(Config{})
	rich := &SlackAppMentionContext{
		ChannelID:      "CVIDEO",
		ThreadTS:       "1779166071.849179",
		UserID:         "UASK",
		MentionText:    "你看一下这个 channel 里哪些视频可以当作素材库整理起来用",
		RawMentionText: "<@UBOT> 你看一下这个 channel 里哪些视频可以当作素材库整理起来用",
		Transcript: strings.Join([]string{
			"[1779166071.849179] <@UASK>: <@UBOT> 你看一下这个 channel 里哪些视频可以当作素材库整理起来用",
			"  [file: bridge_cold_open_montage_v15.mp4 type=mp4 size=123 <https://slack.example/FVID>]",
			"  [image: poster.png file_id=FIMG type=image/png size=10 <https://slack.example/FIMG>]",
		}, "\n"),
		Prompt: "Thread context:\n你看一下这个 channel 里哪些视频可以当作素材库整理起来用",
		Files: []SlackThreadFile{
			{ID: "FVID", Name: "bridge_cold_open_montage_v15.mp4", Filetype: "mp4", Mimetype: "video/mp4", Size: 123, Permalink: "https://slack.example/FVID"},
			{ID: "FIMG", Name: "poster.png", Filetype: "png", Mimetype: "image/png", Size: 10, Permalink: "https://slack.example/FIMG"},
		},
	}
	context := service.buildAgentRunnerContext(context.Background(), AvatarCommandInput{
		ChannelName:       "bridge-social-media",
		UserName:          "peng",
		RichThreadContext: rich,
	}, parsedAvatarCommand{Action: "work"}, nil)

	evidence, ok := context["slackToolEvidence"].(string)
	if !ok || !strings.Contains(evidence, "slack_file_context (ok)") || !strings.Contains(evidence, "1 video(s)") || !strings.Contains(evidence, "bridge_cold_open_montage_v15.mp4") {
		t.Fatalf("slackToolEvidence = %q, want media file-context evidence", evidence)
	}
	if !strings.Contains(evidence, "Do not claim to have watched videos") || !strings.Contains(evidence, "non-image file_ids can be fetched with slack.fetchFile") {
		t.Fatalf("slackToolEvidence = %q, want explicit media content boundary", evidence)
	}
	if len(rich.ToolEvidence) != 1 || rich.ToolEvidence[0].Tool != "slack_file_context" || !rich.ToolEvidence[0].OK {
		t.Fatalf("rich.ToolEvidence = %#v, want successful slack_file_context evidence", rich.ToolEvidence)
	}
	prompt, ok := context["slackAssistantPrompt"].(string)
	if !ok || !strings.Contains(prompt, "First-class tool evidence:") || !strings.Contains(prompt, "slack.fetchFile") {
		t.Fatalf("slackAssistantPrompt = %q, want file-context evidence in worker prompt", prompt)
	}
}

func TestAppMentionFileMetadataDoesNotAddMediaEvidenceWithoutMediaIntent(t *testing.T) {
	service := NewService(Config{})
	rich := &SlackAppMentionContext{
		ChannelID:      "CVIDEO",
		ThreadTS:       "1779166071.849179",
		UserID:         "UASK",
		MentionText:    "谢谢，先这样",
		RawMentionText: "<@UBOT> 谢谢，先这样",
		Transcript: strings.Join([]string{
			"[1779166071.849179] <@UASK>: <@UBOT> 谢谢，先这样",
			"  [file: bridge_cold_open_montage_v15.mp4 type=mp4 size=123 <https://slack.example/FVID>]",
		}, "\n"),
		Prompt: "Thread context:\n谢谢，先这样",
		Files: []SlackThreadFile{
			{ID: "FVID", Name: "bridge_cold_open_montage_v15.mp4", Filetype: "mp4", Mimetype: "video/mp4", Size: 123, Permalink: "https://slack.example/FVID"},
		},
	}
	context := service.buildAgentRunnerContext(context.Background(), AvatarCommandInput{
		ChannelName:       "bridge-social-media",
		UserName:          "peng",
		RichThreadContext: rich,
	}, parsedAvatarCommand{Action: "work"}, nil)

	if evidence, ok := context["slackToolEvidence"].(string); ok && strings.Contains(evidence, "slack_file_context") {
		t.Fatalf("slackToolEvidence = %q, want no file-context evidence without media request intent", evidence)
	}
	if len(rich.ToolEvidence) != 0 {
		t.Fatalf("rich.ToolEvidence = %#v, want no media evidence without media request intent", rich.ToolEvidence)
	}
}

func TestAppMentionOperationalPRAddsWorkflowEvidence(t *testing.T) {
	service := NewService(Config{})
	rich := &SlackAppMentionContext{
		ChannelID:      "CWORK",
		ThreadTS:       "1779079538.775449",
		UserID:         "UASK",
		MentionText:    "https://github.com/AFK-surf/cueboard/pull/1917 <@U0ALY77RMJL> <@U0AMN6TKVJ8> 来 review，没问题就 approve 然后推进到合并",
		RawMentionText: "<@UBOT> https://github.com/AFK-surf/cueboard/pull/1917 <@U0ALY77RMJL> <@U0AMN6TKVJ8> 来 review，没问题就 approve 然后推进到合并",
		Transcript:     "[1779079538.775449] <@UASK>: <@UBOT> https://github.com/AFK-surf/cueboard/pull/1917 <@U0ALY77RMJL> <@U0AMN6TKVJ8> 来 review，没问题就 approve 然后推进到合并",
		Prompt:         "Thread context:\nhttps://github.com/AFK-surf/cueboard/pull/1917 <@U0ALY77RMJL> <@U0AMN6TKVJ8> 来 review，没问题就 approve 然后推进到合并",
	}
	context := service.buildAgentRunnerContext(context.Background(), AvatarCommandInput{
		ChannelName:       "bridge-dev",
		UserName:          "peng",
		RichThreadContext: rich,
	}, parsedAvatarCommand{Action: "work"}, nil)

	evidence, ok := context["slackToolEvidence"].(string)
	if !ok || !strings.Contains(evidence, "slack_workflow_context (ok)") || !strings.Contains(evidence, "operational_github_work") || !strings.Contains(evidence, "review_or_delivery_request") {
		t.Fatalf("slackToolEvidence = %q, want workflow evidence for operational PR review request", evidence)
	}
	for _, want := range []string{
		"not a general link/article share",
		"identify the requested owner/action/status",
		"Do not summarize the link as reading material",
		"https://github.com/AFK-surf/cueboard/pull/1917",
		"<@U0ALY77RMJL>",
	} {
		if !strings.Contains(evidence, want) {
			t.Fatalf("slackToolEvidence = %q, missing workflow boundary %q", evidence, want)
		}
	}
	if len(rich.ToolEvidence) != 1 || rich.ToolEvidence[0].Tool != "slack_workflow_context" || !rich.ToolEvidence[0].OK {
		t.Fatalf("rich.ToolEvidence = %#v, want successful slack_workflow_context evidence", rich.ToolEvidence)
	}
	prompt, ok := context["slackAssistantPrompt"].(string)
	if !ok || !strings.Contains(prompt, "First-class tool evidence:") || !strings.Contains(prompt, "Do not summarize the link as reading material") {
		t.Fatalf("slackAssistantPrompt = %q, want workflow evidence in worker prompt", prompt)
	}
}

func TestAppMentionExplicitRememberWritesDurableMemory(t *testing.T) {
	workspaceDir := t.TempDir()
	service := NewService(Config{
		Slack: appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})
	rich := &SlackAppMentionContext{
		ChannelID:       "C123",
		ThreadTS:        "1779160000.123456",
		UserID:          "UASK",
		MentionText:     "这个 Discord 永久邀请链接帮我记一下: https://discord.gg/bridge",
		RawMentionText:  "<@UBOT> 这个 Discord 永久邀请链接帮我记一下: https://discord.gg/bridge",
		Transcript:      "[1779160000.123456] <@UASK>: <@UBOT> 这个 Discord 永久邀请链接帮我记一下: https://discord.gg/bridge",
		Prompt:          "Thread context:\n这个 Discord 永久邀请链接帮我记一下: https://discord.gg/bridge",
		ThreadPermalink: "https://cue-3kl2780.slack.com/archives/C123/p1779160000123456",
	}
	context := service.buildAgentRunnerContext(context.Background(), AvatarCommandInput{
		ChannelName:       "bridge-app",
		UserName:          "peng",
		RichThreadContext: rich,
	}, parsedAvatarCommand{Action: "work"}, nil)

	evidence, ok := context["slackToolEvidence"].(string)
	if !ok || !strings.Contains(evidence, "memory_write (ok)") || !strings.Contains(evidence, "slack-app-mentions/c123-1779160000-123456.md") {
		t.Fatalf("slackToolEvidence = %q, want successful memory_write evidence", evidence)
	}
	if len(rich.ToolEvidence) != 1 || rich.ToolEvidence[0].Tool != "memory_write" || !rich.ToolEvidence[0].OK {
		t.Fatalf("rich.ToolEvidence = %#v, want successful memory_write evidence", rich.ToolEvidence)
	}
	path := filepath.Join(workspaceDir, "memory/team/facts/slack-app-mentions/c123-1779160000-123456.md")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read memory write %s: %v", path, err)
	}
	body := string(raw)
	for _, want := range []string{"# Slack explicit memory", "Discord 永久邀请链接", "https://discord.gg/bridge", "Thread permalink"} {
		if !strings.Contains(body, want) {
			t.Fatalf("memory body missing %q:\n%s", want, body)
		}
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

	response := service.runJobsCommand(context.Background(), AvatarCommandInput{
		Text:      "jobs",
		TeamID:    "T123",
		ChannelID: "C123",
		ThreadTS:  "123.456",
		UserID:    "U123",
		Command:   "app_mention",
	}, parsedAvatarCommand{Action: "jobs"})
	if !response.OK {
		t.Fatalf("response = %#v, want ok", response)
	}
	if !strings.Contains(response.Text, "Background tasks: local=1, meeting=1") {
		t.Fatalf("text = %q, want local/meeting count", response.Text)
	}
	if !strings.Contains(response.Text, "Task meeting_job_done completed: meeting summary\nsummary done") {
		t.Fatalf("text = %q, want ready meeting worker output", response.Text)
	}
	if response.Metadata["slack_context"] == nil || response.Metadata["ready_for_slack"] == nil {
		t.Fatalf("metadata = %#v, want slack context and ready_for_slack", response.Metadata)
	}
}

func TestEventTextToAvatarCommandDoesNotTreatGoOnlyCommandsAsExplicit(t *testing.T) {
	if got := eventTextToAvatarCommand(SlackEventPayload{Text: "<@UBOT> cancel job_1"}); got != "work cancel job_1" {
		t.Fatalf("cancel command = %q, want worker fallback", got)
	}
	if got := eventTextToAvatarCommand(SlackEventPayload{Text: "<@UBOT> schedule list"}); got != "work schedule list" {
		t.Fatalf("schedule command = %q, want worker fallback", got)
	}
	if got := eventTextToAvatarCommand(SlackEventPayload{Text: "<@UBOT> delegate summarize"}); got != "work delegate summarize" {
		t.Fatalf("delegate command = %q, want worker fallback", got)
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
