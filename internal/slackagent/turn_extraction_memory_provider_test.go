package slackagent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestTurnExtractionMemoryProviderWritesReviewCandidate(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	provider := newTurnExtractionMemoryProvider(appconfig.SlackMemoryConfig{Enabled: true})
	if err := provider.Initialize(context.Background(), SlackMemoryProviderInit{WorkspaceDir: workspaceDir}); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	err := provider.SyncTurn(context.Background(), SlackMemoryProviderTurn{
		SessionID:        "session_test_004",
		UserContent:      "@bot 注意一下，Cumora 那个项目的 contact 是 yetone，他人在 Isoform，跟 Alma 那条产品线没关系。",
		AssistantContent: "记下来：Cumora 关联人是 yetone，组织 Isoform，与 Alma 无产品线关系。",
		Metadata: map[string]any{
			"channel_id": "C123",
			"thread_ts":  "177.123",
		},
	})
	if err != nil {
		t.Fatalf("SyncTurn: %v", err)
	}
	files := listDirectWorkspaceMemoryFiles(workspaceDir)
	if len(files) != 1 {
		t.Fatalf("memory files = %#v, want one candidate", files)
	}
	if !strings.HasPrefix(files[0], "memory/extractions/candidates/") {
		t.Fatalf("candidate path = %q, want extraction candidate path", files[0])
	}
	raw, err := os.ReadFile(filepath.Join(workspaceDir, filepath.FromSlash(files[0])))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	body := string(raw)
	for _, want := range []string{
		"oneesama.memory-extraction-candidate.v1",
		"review_candidate",
		"Cumora",
		"yetone",
		"Isoform",
		"Alma",
		"Review Guidance",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("candidate missing %q:\n%s", want, body)
		}
	}

	err = provider.SyncTurn(context.Background(), SlackMemoryProviderTurn{
		SessionID:        "session_test_004",
		UserContent:      "@bot 注意一下，Cumora 那个项目的 contact 是 yetone，他人在 Isoform，跟 Alma 那条产品线没关系。",
		AssistantContent: "记下来：Cumora 关联人是 yetone，组织 Isoform，与 Alma 无产品线关系。",
	})
	if err != nil {
		t.Fatalf("second SyncTurn: %v", err)
	}
	if files := listDirectWorkspaceMemoryFiles(workspaceDir); len(files) != 1 {
		t.Fatalf("memory files after duplicate = %#v, want still one candidate", files)
	}
}

func TestSlackWorkerResultSyncsMemoryTurn(t *testing.T) {
	t.Parallel()

	provider := &simpleRecordingMemoryProvider{name: "turn_fake", available: true}
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Slack:           appconfig.SlackConfig{WorkspaceDir: t.TempDir()},
		MemoryProviders: []SlackMemoryProvider{provider},
		Poster:          poster,
	})
	service.handleAgentRunnerUpdate(context.Background(), completedWorkerJob("job_turn_sync", "session_turn_sync", "Cumora contact 是谁？", "记下来：Cumora 关联人是 yetone，组织 Isoform。"))

	if len(provider.turns) != 1 {
		t.Fatalf("provider turns = %#v, want one SyncTurn", provider.turns)
	}
	got := provider.turns[0]
	if got.SessionID != "session_turn_sync" || !strings.Contains(got.UserContent, "Cumora contact") || !strings.Contains(got.AssistantContent, "yetone") {
		t.Fatalf("turn = %#v, want worker request/result mirrored", got)
	}
	if got.Metadata["source"] != "slack_worker_result" || got.Metadata["job_id"] != "job_turn_sync" || got.Metadata["delivery"] != "thread_reply" {
		t.Fatalf("turn metadata = %#v, want worker source metadata", got.Metadata)
	}
}

func completedWorkerJob(id string, sessionID string, userText string, assistantText string) agentrunner.Job {
	return agentrunner.Job{
		ID:       id,
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Mode:     "analysis",
		Task:     userText,
		Result:   assistantText,
		Context: map[string]any{
			"sessionId": sessionID,
			"source":    "slack-agent",
			"slack": map[string]any{
				"channelId": "C123",
				"threadTs":  "177.123",
			},
			"slackAppMention": SlackAppMentionContext{
				MentionText: userText,
			},
		},
	}
}
