//go:build cueboardparity

package slackagent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCueboardParityIncrementalTranscript(t *testing.T) {
	t.Parallel()

	previous := "[10:00:00] A: hello\n[10:00:05] B: hi"
	current := previous + "\n[10:00:10] A: status?"

	if got := incrementalTranscript(previous, previous); got != "" {
		t.Fatalf("incrementalTranscript(same) = %q, want empty", got)
	}
	if got := incrementalTranscript(previous, current); got != "[10:00:10] A: status?" {
		t.Fatalf("incrementalTranscript(delta) = %q", got)
	}
}

func TestCueboardParityMeetingCopilotCompletionSummary(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		effects meetingCopilotToolEffects
		want    string
	}{
		{name: "no action", want: "no action"},
		{name: "checked without chat", effects: meetingCopilotToolEffects{checkedSources: []string{"GitHub", "Linear"}}, want: "checked without chat via GitHub, Linear"},
		{name: "sent meeting chat", effects: meetingCopilotToolEffects{sentMeetingChatText: "PR #128 ready to merge"}, want: "sent meeting chat: PR #128 ready to merge"},
		{name: "sent meeting chat and external side effect", effects: meetingCopilotToolEffects{sentMeetingChatText: "PR #128 ready to merge", otherSideEffects: []string{"created Linear issue CUE-123"}}, want: "sent meeting chat: PR #128 ready to merge; created Linear issue CUE-123"},
		{name: "notify slack", effects: meetingCopilotToolEffects{notifiedSlack: true}, want: "notified linked Slack thread"},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := meetingCopilotCompletionSummary(tt.effects); got != tt.want {
				t.Fatalf("meetingCopilotCompletionSummary() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestCueboardParityMeetingCopilotHasVerboseFinalText(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{name: "empty content is fine"},
		{name: "short one-liner is fine", content: "No action needed"},
		{name: "multiline prose is verbose", content: "### Summary\n- item 1", want: true},
		{name: "long prose is verbose", content: strings.Repeat("a", meetingCopilotMaxFinalLineLen+1), want: true},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := meetingCopilotHasVerboseFinalText(tt.content); got != tt.want {
				t.Fatalf("meetingCopilotHasVerboseFinalText(%q) = %v, want %v", tt.content, got, tt.want)
			}
		})
	}
}

func TestCueboardParityMeetingCopilotLinearMutationSummary(t *testing.T) {
	t.Parallel()

	result := meetingCopilotToolResult{Success: true, Text: `{"data":{"issueCreate":{"issue":{"id":"issue-1","identifier":"CUE-123"}}}}`}
	summary := meetingCopilotLinearMutationSummary(map[string]any{
		"body": `{"query":"mutation { issueCreate(input: { title: \"Bug\" }) { issue { id identifier } } }"}`,
	}, result)
	if summary != "created Linear issue CUE-123" {
		t.Fatalf("summary = %q, want created issue identifier", summary)
	}
	if summary := meetingCopilotLinearMutationSummary(map[string]any{
		"body": `{"query":"{ issue(id: \"CUE-123\") { id } }"}`,
	}, result); summary != "" {
		t.Fatalf("query-only linear call should not count as mutation, got %q", summary)
	}
}

func TestCueboardParityMeetingCopilotHooksTrackChecksAndSideEffects(t *testing.T) {
	t.Parallel()

	effects := &meetingCopilotToolEffects{}
	recordMeetingCopilotToolExecution(effects, "run_command", map[string]any{"command": "gh pr view 1"}, meetingCopilotToolResult{Success: true, Text: "ok"})
	recordMeetingCopilotToolExecution(effects, "linear_api", map[string]any{
		"body": `{"query":"mutation { issueCreate(input: { title: \"Bug\" }) { issue { id identifier } } }"}`,
	}, meetingCopilotToolResult{Success: true, Text: `{"data":{"issueCreate":{"issue":{"id":"issue-1","identifier":"CUE-123"}}}}`})

	if len(effects.checkedSources) != 1 || effects.checkedSources[0] != "GitHub" {
		t.Fatalf("checkedSources = %+v, want GitHub", effects.checkedSources)
	}
	if len(effects.otherSideEffects) != 1 || effects.otherSideEffects[0] != "created Linear issue CUE-123" {
		t.Fatalf("otherSideEffects = %+v, want created issue summary", effects.otherSideEffects)
	}
	if !effects.hasSideEffects() {
		t.Fatal("expected mutation to count as side effect")
	}
}

func TestCueboardParityContainsExplicitMeetingFollowUp(t *testing.T) {
	t.Parallel()

	if !containsExplicitMeetingFollowUp("Peng: 帮我查一下这个 PR 什么状态") {
		t.Fatal("expected explicit Chinese follow-up cue to match")
	}
	if !containsExplicitMeetingFollowUp("Haowen: notetaker, can you check the status?") {
		t.Fatal("expected explicit English follow-up cue to match")
	}
	if !containsExplicitMeetingFollowUp("Zijian: 这个你来设计一下，周三再对一下") {
		t.Fatal("expected explicit action-item assignment to match")
	}
	if containsExplicitMeetingFollowUp("Haowen: 竟然还会发言，那个 NoteTaker") {
		t.Fatal("unexpected match for third-person mention")
	}
}

func TestCueboardParityMaterializeMeetingArtifactPrefersReadableLocalPath(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	localPath := filepath.Join(dir, "transcript.txt")
	if err := os.WriteFile(localPath, []byte("local transcript"), 0o644); err != nil {
		t.Fatalf("write local artifact: %v", err)
	}

	materializer := meetingArtifactMaterializer{}
	path, cleanup, err := materializer.materializeMeetingArtifact(context.Background(), 42, localPath, "transcript")
	if err != nil {
		t.Fatalf("materializeMeetingArtifact: %v", err)
	}
	defer cleanup()
	if path != localPath {
		t.Fatalf("path = %q, want %q", path, localPath)
	}
}

func TestCueboardParityMaterializeMeetingArtifactFallsBackToMeetdDownload(t *testing.T) {
	t.Parallel()

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/meetings/42/artifacts/transcript" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte("remote transcript"))
	}))
	defer ts.Close()

	materializer := meetingArtifactMaterializer{meetAgentURL: ts.URL}
	path, cleanup, err := materializer.materializeMeetingArtifact(context.Background(), 42, filepath.Join(t.TempDir(), "missing.txt"), "transcript")
	if err != nil {
		t.Fatalf("materializeMeetingArtifact: %v", err)
	}
	defer cleanup()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read temp artifact: %v", err)
	}
	if string(body) != "remote transcript" {
		t.Fatalf("body = %q, want remote transcript", string(body))
	}
}

func TestCueboardParityMaterializeMeetingArtifactStagesRemoteDownloadInsideWorkspace(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/meetings/42/artifacts/transcript" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte("remote transcript"))
	}))
	defer ts.Close()

	materializer := meetingArtifactMaterializer{workspaceDir: workspaceDir, meetAgentURL: ts.URL}
	path, cleanup, err := materializer.materializeMeetingArtifact(context.Background(), 42, filepath.Join(t.TempDir(), "missing.txt"), "transcript")
	if err != nil {
		t.Fatalf("materializeMeetingArtifact: %v", err)
	}
	defer cleanup()
	if err := materializer.ensurePathWithinWorkspace(path); err != nil {
		t.Fatalf("artifact path should stay within workspace: %v", err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read staged artifact: %v", err)
	}
	if string(body) != "remote transcript" {
		t.Fatalf("body = %q, want remote transcript", string(body))
	}
}

func TestCueboardParityMaterializeMeetingArtifactStagesReadableLocalPathOutsideWorkspace(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	externalDir := t.TempDir()
	localPath := filepath.Join(externalDir, "transcript.txt")
	if err := os.WriteFile(localPath, []byte("external transcript"), 0o644); err != nil {
		t.Fatalf("write local artifact: %v", err)
	}

	materializer := meetingArtifactMaterializer{workspaceDir: workspaceDir}
	path, cleanup, err := materializer.materializeMeetingArtifact(context.Background(), 42, localPath, "transcript")
	if err != nil {
		t.Fatalf("materializeMeetingArtifact: %v", err)
	}
	defer cleanup()
	if path == localPath {
		t.Fatal("expected local artifact outside workspace to be staged")
	}
	if err := materializer.ensurePathWithinWorkspace(path); err != nil {
		t.Fatalf("staged artifact path should stay within workspace: %v", err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read staged artifact: %v", err)
	}
	if string(body) != "external transcript" {
		t.Fatalf("body = %q, want external transcript", string(body))
	}
}
