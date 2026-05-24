package postmeeting

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestPipelinePostProcessWritesArtifacts(t *testing.T) {
	t.Parallel()

	pipeline := NewPipeline(t.TempDir())
	result := mustPostProcess(t, pipeline, PostProcessInput{
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
	assertFileContains(t, result.Artifact.Files.Summary, "Action item")
	assertFileContains(t, result.Artifact.Files.TranscriptText, "Peng: Decision: keep the Go rewrite incremental.")
}

func TestPipelineAcceptsLegacyCamelCaseInput(t *testing.T) {
	t.Parallel()

	audioPath := writeTestAudioFile(t, "audio.wav", "fake audio")
	var input PostProcessInput
	if err := json.Unmarshal([]byte(`{
		"artifactId":"legacy_artifact",
		"meetingId":"meet_legacy",
		"sessionId":"session_legacy",
		"meetUrl":"https://meet.google.com/legacy",
		"transcriptText":"Peng: Decision: keep legacy clients working.",
		"audioPath":`+strconv.Quote(audioPath)+`,
		"chatMessages":[{"sender":"Peng","text":"Legacy chat https://example.com/legacy"}],
		"skipAsr":true
	}`), &input); err != nil {
		t.Fatalf("UnmarshalJSON() error = %v", err)
	}
	pipeline := NewPipeline(t.TempDir())
	result := mustPostProcess(t, pipeline, input)
	if result.Artifact.ID != "legacy_artifact" || result.Artifact.MeetingID != "meet_legacy" || result.Artifact.SessionID != "session_legacy" {
		t.Fatalf("artifact = %#v, want legacy camelCase identifiers", result.Artifact)
	}
	if result.Artifact.Files.Audio != audioPath {
		t.Fatalf("manifest audio = %q, want %q", result.Artifact.Files.Audio, audioPath)
	}
	if len(result.Chat.Messages) != 1 || !strings.Contains(result.Chat.Messages[0].Text, "Legacy chat") {
		t.Fatalf("chat = %#v, want legacy chat message", result.Chat)
	}
}

func TestPipelineFallbackHighlightsSplitLongTranscriptIntoReadableBullets(t *testing.T) {
	t.Parallel()

	pipeline := NewPipeline(t.TempDir())
	result := mustPostProcess(t, pipeline, PostProcessInput{
		Title: "Android Debrief",
		Captions: []TranscriptSegmentInput{{
			Speaker: "Peng",
			Text:    "Android 17 looks incremental rather than a major redesign. Gemini polish is visible, but the OS value still feels unclear. The useful example is small context like rain and wind speed in the weather app.",
		}},
	})
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

	audioPath := writeTestAudioFile(t, "audio.mp3", "final mp3")
	sourceDir := filepath.Dir(audioPath)
	chunkA := filepath.Join(sourceDir, "audio_chunk_000.mp3")
	chunkB := filepath.Join(sourceDir, "audio_chunk_001.mp3")
	writeTestFile(t, chunkA, "chunk 0")
	writeTestFile(t, chunkB, "chunk 1")

	asr := &chunkRecordingASRProvider{}
	pipeline := NewPipeline(t.TempDir(), WithASRProvider(asr))
	result := mustPostProcess(t, pipeline, PostProcessInput{
		ArtifactID: "chunked-audio",
		Title:      "Chunked audio",
		AudioPath:  audioPath,
	})
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
		assertFileContains(t, filepath.Join(artifactDir, name), "audio_chunk_")
	}
}

func TestPipelineSkipASRPreservesAudioManifest(t *testing.T) {
	t.Parallel()

	audioPath := writeTestAudioFile(t, "audio.wav", "fake audio")
	asr := &fakeASRProvider{err: errors.New("asr should not be called")}
	pipeline := NewPipeline(t.TempDir(), WithASRProvider(asr))
	result := mustPostProcess(t, pipeline, PostProcessInput{
		ArtifactID: "captions-only-recovery",
		Title:      "Captions-only recovery",
		AudioPath:  audioPath,
		SkipASR:    true,
		Captions: []TranscriptSegmentInput{{
			Speaker: "Peng",
			Text:    "Captured captions should be enough for stale recovery.",
		}},
	})
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

	audioPath := writeTestAudioFile(t, "audio.mp3", "fake audio")
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

	result := mustPostProcess(t, pipeline, PostProcessInput{
		Title:     "原始标题",
		AudioPath: audioPath,
		Captions: []TranscriptSegmentInput{{
			Speaker: "Peng",
			Text:    "字幕误听内容",
		}},
	})
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
	result := mustPostProcess(t, pipeline, PostProcessInput{
		Title: "Fallback",
		Captions: []TranscriptSegmentInput{{
			Speaker: "Peng",
			Text:    "Decision: keep fallback reliable.",
		}},
	})
	if len(result.Summary.Decisions) == 0 {
		t.Fatalf("summary = %#v, want fallback decision extraction", result.Summary)
	}
	if len(result.Warnings) != 1 || result.Warnings[0].Code != "summary_failed" {
		t.Fatalf("warnings = %#v, want summary_failed", result.Warnings)
	}
	if len(result.Artifact.Warnings) != 1 || result.Artifact.Warnings[0].Code != "summary_failed" {
		t.Fatalf("manifest warnings = %#v, want summary_failed", result.Artifact.Warnings)
	}
	assertFileContains(t, result.Artifact.Files.Summary, "Processing Warnings", "summary_failed")
}

func TestPipelineRecordsASRAndCalibrationFallbackWarnings(t *testing.T) {
	t.Parallel()

	audioPath := writeTestAudioFile(t, "audio.mp3", "fake audio")
	asr := &fakeASRProvider{
		transcript: ASRTranscript{Provider: "openai", Text: "Peng: ASR backup"},
	}
	summarizer := &fakePipelineSummarizer{
		calibrateErr: errors.New(strings.Repeat("calibration unavailable ", 80)),
		summary:      Summary{Title: "Fallback warnings", Highlights: []string{"kept captions"}},
	}
	pipeline := NewPipeline(t.TempDir(), WithASRProvider(asr), WithSummarizer(summarizer))
	result := mustPostProcess(t, pipeline, PostProcessInput{
		Title:     "Fallback warnings",
		AudioPath: audioPath,
		Captions: []TranscriptSegmentInput{{
			Speaker: "Peng",
			Text:    "Caption text survives calibration failure.",
		}},
	})
	if len(result.Warnings) != 1 || result.Warnings[0].Code != "calibration_failed" {
		t.Fatalf("warnings = %#v, want calibration_failed", result.Warnings)
	}
	if len([]rune(result.Warnings[0].Detail)) > 515 {
		t.Fatalf("warning detail length = %d, want truncated detail", len([]rune(result.Warnings[0].Detail)))
	}
	if result.Transcript.Provider != "caption" || !strings.Contains(result.Transcript.Text, "Caption text survives") {
		t.Fatalf("transcript = %#v, want caption fallback", result.Transcript)
	}

	asr.err = errors.New("asr provider down")
	asr.transcript = ASRTranscript{}
	result = mustPostProcess(t, pipeline, PostProcessInput{
		Title:     "ASR fallback",
		AudioPath: audioPath,
		Captions: []TranscriptSegmentInput{{
			Speaker: "Peng",
			Text:    "Decision: captions still produce summary.",
		}},
	})
	if len(result.Warnings) != 1 || result.Warnings[0].Code != "asr_failed" {
		t.Fatalf("warnings = %#v, want asr_failed", result.Warnings)
	}
}

func TestPipelinePropagatesContextCancellation(t *testing.T) {
	t.Parallel()

	audioPath := writeTestAudioFile(t, "audio.mp3", "fake audio")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	pipeline := NewPipeline(t.TempDir(), WithASRProvider(&fakeASRProvider{err: context.Canceled}))
	if _, err := pipeline.PostProcess(ctx, PostProcessInput{
		ArtifactID: "cancelled-asr",
		AudioPath:  audioPath,
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("PostProcess() error = %v, want context.Canceled", err)
	}
}

func TestPipelinePropagatesSummaryDeadline(t *testing.T) {
	t.Parallel()

	pipeline := NewPipeline(t.TempDir(), WithSummarizer(&fakePipelineSummarizer{err: context.DeadlineExceeded}))
	if _, err := pipeline.PostProcess(context.Background(), PostProcessInput{
		ArtifactID: "summary-deadline",
		Captions: []TranscriptSegmentInput{{
			Speaker: "Peng",
			Text:    "Decision: deadline should not become ok artifact.",
		}},
	}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("PostProcess() error = %v, want context deadline", err)
	}
}

func TestPipelineListAndGetArtifacts(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	pipeline := NewPipeline(rootDir)
	result := mustPostProcess(t, pipeline, PostProcessInput{
		ArtifactID: "artifact_1",
		Title:      "Artifact One",
		Text:       "A compact transcript line",
	})

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

func TestPipelineGetArtifactChatRejectsManifestPathEscape(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	pipeline := NewPipeline(rootDir)
	artifactDir := filepath.Join(rootDir, "poisoned")
	if err := os.MkdirAll(artifactDir, 0o755); err != nil {
		t.Fatalf("mkdir artifact dir: %v", err)
	}
	outsideDir := t.TempDir()
	outsideChat := filepath.Join(outsideDir, "chat.json")
	writeTestFile(t, outsideChat, `{"schema":"oneesama.meet-chat.v1","id":"poisoned"}`)
	manifest := ArtifactManifest{
		Schema: "oneesama.meeting-artifact.v1",
		ID:     "poisoned",
		Files:  ArtifactFiles{Chat: outsideChat},
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	writeTestFile(t, filepath.Join(artifactDir, "manifest.json"), string(raw))

	if chat, err := pipeline.GetArtifactChat("poisoned"); err == nil || chat != nil {
		t.Fatalf("GetArtifactChat() = (%#v, %v), want path escape error", chat, err)
	}
}

func writeTestFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func writeTestAudioFile(t *testing.T, name string, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	writeTestFile(t, path, content)
	return path
}

func mustPostProcess(t *testing.T, pipeline *Pipeline, input PostProcessInput) PostProcessResult {
	t.Helper()
	result, err := pipeline.PostProcess(context.Background(), input)
	if err != nil {
		t.Fatalf("PostProcess() error = %v", err)
	}
	return result
}

func assertFileContains(t *testing.T, path string, wants ...string) {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s) error = %v", path, err)
	}
	for _, want := range wants {
		if !strings.Contains(string(body), want) {
			t.Fatalf("%s = %s, want %q", path, string(body), want)
		}
	}
}

func TestPipelineRejectsUnsafeArtifactID(t *testing.T) {
	t.Parallel()

	pipeline := NewPipeline(t.TempDir())
	for _, id := range []string{"../escape", "..", ".", "nested/path", `nested\path`, " artifact"} {
		if _, err := pipeline.PostProcess(context.Background(), PostProcessInput{
			ArtifactID: id,
			Title:      "Unsafe artifact",
			Text:       "body",
		}); !errors.As(err, new(InvalidArtifactIDError)) {
			t.Fatalf("PostProcess(%q) error = %v, want InvalidArtifactIDError", id, err)
		}
		if _, err := pipeline.GetArtifact(id); !errors.As(err, new(InvalidArtifactIDError)) {
			t.Fatalf("GetArtifact(%q) error = %v, want InvalidArtifactIDError", id, err)
		}
	}
}
