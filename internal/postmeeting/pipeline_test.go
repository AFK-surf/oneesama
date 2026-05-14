package postmeeting

import (
	"context"
	"errors"
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

type fakeASRProvider struct {
	transcript ASRTranscript
	err        error
	request    ASRRequest
}

func (p *fakeASRProvider) Transcribe(_ context.Context, request ASRRequest) (ASRTranscript, error) {
	p.request = request
	return p.transcript, p.err
}

type fakePipelineSummarizer struct {
	summary           Summary
	err               error
	calibrated        string
	calibrateErr      error
	summarizeInput    PostProcessInput
	summarizeSegments []NormalizedSegment
	calibrateCaption  string
	calibrateASR      string
}

func (s *fakePipelineSummarizer) Summarize(_ context.Context, input PostProcessInput, segments []NormalizedSegment, _ []string) (Summary, error) {
	s.summarizeInput = input
	s.summarizeSegments = append([]NormalizedSegment(nil), segments...)
	if s.err != nil {
		return Summary{}, s.err
	}
	return s.summary, nil
}

func (s *fakePipelineSummarizer) Calibrate(_ context.Context, captionTranscript, asrTranscript string) (string, error) {
	s.calibrateCaption = captionTranscript
	s.calibrateASR = asrTranscript
	if s.calibrateErr != nil {
		return "", s.calibrateErr
	}
	return s.calibrated, nil
}

func TestPipelineUsesConfiguredASRCalibrationAndLLMSummary(t *testing.T) {
	t.Parallel()

	audioPath := filepath.Join(t.TempDir(), "audio.mp3")
	if err := os.WriteFile(audioPath, []byte("fake audio"), 0o644); err != nil {
		t.Fatalf("write audio: %v", err)
	}
	asr := &fakeASRProvider{transcript: ASRTranscript{
		Provider: "openai",
		Text:     "[00:00] Peng: ASR 更完整内容",
	}}
	summarizer := &fakePipelineSummarizer{
		calibrated: "Peng: 校准后的高质量文本",
		summary: Summary{
			Title:       "高质量总结",
			Highlights:  []string{"校准后再总结"},
			ActionItems: []string{"继续接 provider"},
		},
	}
	pipeline := NewPipeline(t.TempDir(), WithASRProvider(asr), WithSummarizer(summarizer))

	result, err := pipeline.PostProcess(context.Background(), PostProcessInput{
		Title:     "原始标题",
		AudioPath: audioPath,
		Captions: []TranscriptSegmentInput{{
			Speaker: "Peng",
			Text:    "字幕误听内容",
		}},
	})
	if err != nil {
		t.Fatalf("PostProcess() error = %v", err)
	}
	if asr.request.AudioPath != audioPath {
		t.Fatalf("ASR audio path = %q, want %q", asr.request.AudioPath, audioPath)
	}
	if !strings.Contains(summarizer.calibrateCaption, "Peng: 字幕误听内容") || !strings.Contains(summarizer.calibrateASR, "ASR 更完整内容") {
		t.Fatalf("calibration inputs caption=%q asr=%q", summarizer.calibrateCaption, summarizer.calibrateASR)
	}
	if summarizer.summarizeInput.ASRTranscriptText == "" || summarizer.summarizeInput.ASRProvider != "openai" {
		t.Fatalf("summary input ASR fields = %#v", summarizer.summarizeInput)
	}
	if len(summarizer.summarizeSegments) != 1 || summarizer.summarizeSegments[0].Text != "校准后的高质量文本" {
		t.Fatalf("summary segments = %#v, want calibrated transcript", summarizer.summarizeSegments)
	}
	if result.Transcript.Provider != "calibrated" || !strings.Contains(result.Transcript.Text, "校准后的高质量文本") {
		t.Fatalf("transcript = %#v, want calibrated provider/text", result.Transcript)
	}
	if result.Summary.Title != "高质量总结" || len(result.Summary.Highlights) != 1 {
		t.Fatalf("summary = %#v, want LLM summary", result.Summary)
	}
}

func TestPipelineFallsBackWhenConfiguredLLMSummaryFails(t *testing.T) {
	t.Parallel()

	pipeline := NewPipeline(t.TempDir(), WithSummarizer(&fakePipelineSummarizer{err: errors.New("llm down")}))
	result, err := pipeline.PostProcess(context.Background(), PostProcessInput{
		Title: "Fallback",
		Captions: []TranscriptSegmentInput{{
			Speaker: "Peng",
			Text:    "Decision: keep fallback reliable.",
		}},
	})
	if err != nil {
		t.Fatalf("PostProcess() error = %v", err)
	}
	if len(result.Summary.Decisions) == 0 {
		t.Fatalf("summary = %#v, want fallback decision extraction", result.Summary)
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
