package postmeeting

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPipelinePostProcessWritesArtifacts(t *testing.T) {
	t.Parallel()

	pipeline := NewPipeline(t.TempDir())
	result, err := pipeline.PostProcess(context.Background(), PostProcessInput{
		MeetingID: "meet_123",
		SessionID: "session_123",
		Title:     "Weekly Sync",
		MeetURL:   "https://meet.google.com/abc-defg-hij",
		Captions: []TranscriptSegmentInput{
			{Speaker: "Peng", Text: "Decision: keep the Go rewrite incremental."},
			{Speaker: "Miao", Text: "Action item: wire digest webhook after post-meeting summary."},
		},
		ChatMessages: []ChatMessageInput{
			{Sender: "Peng", Text: "See doc https://example.com/spec"},
		},
		Source: "meeting-agent-test",
	})
	if err != nil {
		t.Fatalf("PostProcess() error = %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true")
	}
	if len(result.Summary.Decisions) == 0 {
		t.Fatalf("summary decisions = %#v, want extracted decision", result.Summary)
	}
	if len(result.Summary.ActionItems) == 0 {
		t.Fatalf("summary action items = %#v, want extracted action item", result.Summary)
	}
	if len(result.Chat.Links) != 1 || result.Chat.Links[0] != "https://example.com/spec" {
		t.Fatalf("chat links = %#v, want example.com/spec", result.Chat.Links)
	}
	for _, path := range []string{
		result.Artifact.Files.Transcript,
		result.Artifact.Files.TranscriptText,
		result.Artifact.Files.Summary,
		result.Artifact.Files.Manifest,
		result.Artifact.Files.Chat,
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("expected artifact file %s: %v", path, err)
		}
	}
	summaryBody, err := os.ReadFile(result.Artifact.Files.Summary)
	if err != nil {
		t.Fatalf("ReadFile(summary) error = %v", err)
	}
	if !strings.Contains(string(summaryBody), "Action item") {
		t.Fatalf("summary markdown = %s, want action item line", string(summaryBody))
	}
	transcriptBody, err := os.ReadFile(result.Artifact.Files.TranscriptText)
	if err != nil {
		t.Fatalf("ReadFile(transcript text) error = %v", err)
	}
	if !strings.Contains(string(transcriptBody), "Peng: Decision: keep the Go rewrite incremental.") {
		t.Fatalf("transcript text = %s, want speaker-prefixed text", string(transcriptBody))
	}
}

func TestPipelineFallbackHighlightsSplitLongTranscriptIntoReadableBullets(t *testing.T) {
	t.Parallel()

	pipeline := NewPipeline(t.TempDir())
	result, err := pipeline.PostProcess(context.Background(), PostProcessInput{
		Title: "Android Debrief",
		Captions: []TranscriptSegmentInput{{
			Speaker: "Peng",
			Text:    "Android 17 looks incremental rather than a major redesign. Gemini polish is visible, but the OS value still feels unclear. The useful example is small context like rain and wind speed in the weather app.",
		}},
	})
	if err != nil {
		t.Fatalf("PostProcess() error = %v", err)
	}
	if len(result.Summary.Highlights) < 2 {
		t.Fatalf("highlights = %#v, want sentence-level bullets", result.Summary.Highlights)
	}
	for _, item := range result.Summary.Highlights {
		if len([]rune(item)) > 243 {
			t.Fatalf("highlight %q too long", item)
		}
	}
}

func TestPipelineListAndGetArtifacts(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	pipeline := NewPipeline(rootDir)
	result, err := pipeline.PostProcess(context.Background(), PostProcessInput{
		ArtifactID: "artifact_1",
		Title:      "Artifact One",
		Text:       "A compact transcript line",
	})
	if err != nil {
		t.Fatalf("PostProcess() error = %v", err)
	}

	artifacts, err := pipeline.ListArtifacts()
	if err != nil {
		t.Fatalf("ListArtifacts() error = %v", err)
	}
	if len(artifacts) != 1 || artifacts[0].ID != "artifact_1" {
		t.Fatalf("artifacts = %#v, want artifact_1", artifacts)
	}

	manifest, err := pipeline.GetArtifact("artifact_1")
	if err != nil {
		t.Fatalf("GetArtifact() error = %v", err)
	}
	if manifest == nil || manifest.Title != "Artifact One" {
		t.Fatalf("manifest = %#v, want title Artifact One", manifest)
	}

	chat, err := pipeline.GetArtifactChat("artifact_1")
	if err != nil {
		t.Fatalf("GetArtifactChat() error = %v", err)
	}
	if chat == nil {
		t.Fatalf("chat = nil, want chat artifact")
	}
	if !strings.HasPrefix(chat.Schema, "oneesama.meet-chat") {
		t.Fatalf("chat schema = %q, want oneesama.meet-chat.*", chat.Schema)
	}
	if filepath.Dir(result.Artifact.Files.Manifest) != filepath.Join(rootDir, "artifact_1") {
		t.Fatalf("artifact dir = %q, want %q", filepath.Dir(result.Artifact.Files.Manifest), filepath.Join(rootDir, "artifact_1"))
	}
}
