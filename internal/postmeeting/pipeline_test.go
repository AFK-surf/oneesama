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

type chunkRecordingASRProvider struct {
	requests []ASRRequest
}

func (p *chunkRecordingASRProvider) Transcribe(_ context.Context, request ASRRequest) (ASRTranscript, error) {
	p.requests = append(p.requests, request)
	chunkName := filepath.Base(request.AudioPath)
	return ASRTranscript{
		Provider: "fake",
		Text:     "Peng: transcript from " + chunkName,
	}, nil
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

func TestPipelineTranscribesAudioChunksAndRecordsManifest(t *testing.T) {
	t.Parallel()

	sourceDir := t.TempDir()
	audioPath := filepath.Join(sourceDir, "audio.mp3")
	if err := os.WriteFile(audioPath, []byte("final mp3"), 0o644); err != nil {
		t.Fatalf("write audio: %v", err)
	}
	chunkA := filepath.Join(sourceDir, "audio_chunk_000.mp3")
	chunkB := filepath.Join(sourceDir, "audio_chunk_001.mp3")
	if err := os.WriteFile(chunkA, []byte("chunk 0"), 0o644); err != nil {
		t.Fatalf("write chunk A: %v", err)
	}
	if err := os.WriteFile(chunkB, []byte("chunk 1"), 0o644); err != nil {
		t.Fatalf("write chunk B: %v", err)
	}

	asr := &chunkRecordingASRProvider{}
	pipeline := NewPipeline(t.TempDir(), WithASRProvider(asr))
	result, err := pipeline.PostProcess(context.Background(), PostProcessInput{
		ArtifactID: "chunked-audio",
		Title:      "Chunked audio",
		AudioPath:  audioPath,
	})
	if err != nil {
		t.Fatalf("PostProcess() error = %v", err)
	}
	if len(asr.requests) != 2 {
		t.Fatalf("ASR requests = %d, want 2 chunk requests", len(asr.requests))
	}
	for index, request := range asr.requests {
		if request.AudioPath == audioPath {
			t.Fatalf("request %d used final audio path; want chunk path", index)
		}
		if request.ChunkIndex != index || request.ChunkCount != 2 {
			t.Fatalf("request %d chunk index/count = %d/%d, want %d/2", index, request.ChunkIndex, request.ChunkCount, index)
		}
		if request.ParentAudioPath != audioPath {
			t.Fatalf("request %d parent audio = %q, want %q", index, request.ParentAudioPath, audioPath)
		}
	}
	if !strings.Contains(result.Transcript.Provider, "fake:chunked") {
		t.Fatalf("transcript provider = %q, want fake:chunked marker", result.Transcript.Provider)
	}
	if !strings.Contains(result.Transcript.Text, "audio_chunk_000.mp3") || !strings.Contains(result.Transcript.Text, "audio_chunk_001.mp3") {
		t.Fatalf("transcript text = %q, want both chunk transcripts", result.Transcript.Text)
	}
	if len(result.Artifact.Files.AudioChunks) != 2 {
		t.Fatalf("manifest audio chunks = %#v, want 2", result.Artifact.Files.AudioChunks)
	}
	artifactDir := filepath.Dir(result.Artifact.Files.Manifest)
	for _, name := range []string{"asr_chunk_000.txt", "asr_chunk_001.txt"} {
		body, err := os.ReadFile(filepath.Join(artifactDir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if !strings.Contains(string(body), "audio_chunk_") {
			t.Fatalf("%s = %q, want chunk transcript text", name, string(body))
		}
	}
}

func TestPipelineSkipASRPreservesAudioManifest(t *testing.T) {
	t.Parallel()

	audioPath := filepath.Join(t.TempDir(), "audio.wav")
	if err := os.WriteFile(audioPath, []byte("fake audio"), 0o644); err != nil {
		t.Fatalf("write audio: %v", err)
	}
	asr := &fakeASRProvider{err: errors.New("asr should not be called")}
	pipeline := NewPipeline(t.TempDir(), WithASRProvider(asr))
	result, err := pipeline.PostProcess(context.Background(), PostProcessInput{
		ArtifactID: "captions-only-recovery",
		Title:      "Captions-only recovery",
		AudioPath:  audioPath,
		SkipASR:    true,
		Captions: []TranscriptSegmentInput{{
			Speaker: "Peng",
			Text:    "Captured captions should be enough for stale recovery.",
		}},
	})
	if err != nil {
		t.Fatalf("PostProcess() error = %v", err)
	}
	if asr.request.AudioPath != "" {
		t.Fatalf("ASR request = %+v, want no ASR call", asr.request)
	}
	if result.Artifact.Files.Audio != audioPath {
		t.Fatalf("manifest audio = %q, want %q", result.Artifact.Files.Audio, audioPath)
	}
	if result.Transcript.Provider != "caption" {
		t.Fatalf("transcript provider = %q, want caption", result.Transcript.Provider)
	}
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
