package slackagent

import (
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

func TestShouldPublishWorkerResultAsCanvasWhenMentionRequestsCanvas(t *testing.T) {
	job := agentrunner.Job{
		Status: agentrunner.StatusCompleted,
		Task:   "看看这个，给一版本 what's new，写 canvas 里",
		Context: map[string]any{
			"slackAppMention": SlackAppMentionContext{
				MentionText: "看看这个，给一版本 what's new，写 canvas 里",
			},
		},
	}

	text := "# What's New\n\n- 新增 meeting avatar Canvas parity。\n"
	if !shouldPublishWorkerResultAsCanvas(job, text) {
		t.Fatal("expected explicit Canvas request to publish worker result as canvas")
	}
}

func TestShouldNotPublishShortWorkerResultAsCanvasWithoutIntent(t *testing.T) {
	job := agentrunner.Job{
		Status: agentrunner.StatusCompleted,
		Task:   "总结一下这个线程",
	}

	if shouldPublishWorkerResultAsCanvas(job, "我看完了，这里主要是在讨论发版节奏。") {
		t.Fatal("short worker result without Canvas intent should remain a thread reply")
	}
}

func TestWorkerResultCanvasInputReusesExistingCanvasFile(t *testing.T) {
	job := agentrunner.Job{
		ID: "job_123",
		Context: map[string]any{
			"slackAppMention": SlackAppMentionContext{
				CanvasFiles: []SlackThreadFile{{ID: "F0B4GEERALD", Title: "What's New"}},
			},
		},
	}

	input := workerResultCanvasInput(job, AssistantThreadRef{ChannelID: "C123", ThreadTS: "123.456"}, "# What's New\n\n- shipped", "job_123")
	if input.CanvasID != "F0B4GEERALD" {
		t.Fatalf("CanvasID = %q, want existing canvas file", input.CanvasID)
	}
	if input.Operation != "insert_at_end" {
		t.Fatalf("Operation = %q, want insert_at_end", input.Operation)
	}
	if input.Title != "What's New" {
		t.Fatalf("Title = %q, want existing canvas title", input.Title)
	}
}
