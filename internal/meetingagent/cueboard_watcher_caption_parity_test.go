//go:build cueboardparity

package meetingagent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCueboardParityMeetdLiveCaptionsTrackSpeakersIndependently(t *testing.T) {
	t.Parallel()

	service := newCueboardCaptionParityService(t)
	meetingID := scheduleCueboardCaptionParityMeeting(t, service, "caption-track-speakers")
	base := time.Date(2026, 3, 20, 10, 0, 0, 0, time.UTC)

	addCueboardCaption(t, service, meetingID, "stream-a", "Alice", "hello", base)
	addCueboardCaption(t, service, meetingID, "stream-b", "Bob", "hi", base.Add(time.Second))
	addCueboardCaption(t, service, meetingID, "stream-a", "Alice", "hello there", base.Add(2*time.Second))

	captions := listCueboardCaptions(t, service, meetingID)
	if len(captions) != 2 {
		t.Fatalf("captions = %#v, want 2 speakers", captions)
	}
	assertCaptionText(t, captions, "Alice", "hello there")
	assertCaptionText(t, captions, "Bob", "hi")
}

func TestCueboardParityMeetdLiveCaptionsIgnoreExactDuplicatesWithinWindow(t *testing.T) {
	t.Parallel()

	service := newCueboardCaptionParityService(t)
	meetingID := scheduleCueboardCaptionParityMeeting(t, service, "caption-exact-duplicate")
	base := time.Date(2026, 3, 20, 10, 0, 0, 0, time.UTC)

	addCueboardCaption(t, service, meetingID, "stream-a", "Alice", "same line", base)
	addCueboardCaption(t, service, meetingID, "stream-a", "Alice", "same line", base.Add(2*time.Second))

	captions := listCueboardCaptions(t, service, meetingID)
	if len(captions) != 1 {
		t.Fatalf("captions = %#v, want exact duplicate collapsed", captions)
	}
}

func TestCueboardParityMeetdLiveCaptionsDoNotMergeSameSpeakerLongGapWithoutStream(t *testing.T) {
	t.Parallel()

	service := newCueboardCaptionParityService(t)
	meetingID := scheduleCueboardCaptionParityMeeting(t, service, "caption-long-gap")
	base := time.Date(2026, 3, 20, 10, 0, 0, 0, time.UTC)

	addCueboardCaption(t, service, meetingID, "", "Alice", "今天先讲方案", base)
	addCueboardCaption(t, service, meetingID, "", "Alice", "今天先讲方案，再讲落地", base.Add(15*time.Second))

	captions := listCueboardCaptions(t, service, meetingID)
	if len(captions) != 2 {
		t.Fatalf("captions = %#v, want two separate long-gap captions", captions)
	}
}

func TestCueboardParityMeetdLiveCaptionsTreatPunctuationVariantsAsSameLine(t *testing.T) {
	t.Parallel()

	service := newCueboardCaptionParityService(t)
	meetingID := scheduleCueboardCaptionParityMeeting(t, service, "caption-punctuation")
	base := time.Date(2026, 3, 20, 10, 0, 0, 0, time.UTC)

	addCueboardCaption(t, service, meetingID, "stream-a", "Alice", "这个方案已经跑通了", base)
	addCueboardCaption(t, service, meetingID, "stream-a", "Alice", "这个方案，已经跑通了。", base.Add(2*time.Second))

	captions := listCueboardCaptions(t, service, meetingID)
	if len(captions) != 1 || captions[0].Text != "这个方案，已经跑通了。" {
		t.Fatalf("captions = %#v, want updated punctuation variant", captions)
	}
}

func TestCueboardParityMeetdLiveCaptionsSeparateConcurrentStreamsForSameSpeaker(t *testing.T) {
	t.Parallel()

	service := newCueboardCaptionParityService(t)
	meetingID := scheduleCueboardCaptionParityMeeting(t, service, "caption-concurrent-streams")
	base := time.Date(2026, 3, 20, 10, 0, 0, 0, time.UTC)

	addCueboardCaption(t, service, meetingID, "stream-a", "Alice", "第一段", base)
	addCueboardCaption(t, service, meetingID, "stream-b", "Alice", "第二段", base.Add(500*time.Millisecond))
	addCueboardCaption(t, service, meetingID, "stream-a", "Alice", "第一段完整版", base.Add(time.Second))

	captions := listCueboardCaptions(t, service, meetingID)
	if len(captions) != 2 {
		t.Fatalf("captions = %#v, want concurrent streams preserved", captions)
	}
	foundSecond := false
	for _, caption := range captions {
		if caption.Text == "第二段" {
			foundSecond = true
		}
	}
	if !foundSecond {
		t.Fatalf("captions = %#v, want second stream preserved", captions)
	}
}

func TestCueboardParityMeetdLiveCaptionsKeepLongRunningStreamUpdatesMerged(t *testing.T) {
	t.Parallel()

	service := newCueboardCaptionParityService(t)
	meetingID := scheduleCueboardCaptionParityMeeting(t, service, "caption-long-stream")
	base := time.Date(2026, 3, 20, 10, 0, 0, 0, time.UTC)

	addCueboardCaption(t, service, meetingID, "stream-a", "Alice", "这一句还没说完", base)
	addCueboardCaption(t, service, meetingID, "stream-a", "Alice", "这一句还没说完，后面又继续补上来了", base.Add(12*time.Second))

	captions := listCueboardCaptions(t, service, meetingID)
	if len(captions) != 1 || captions[0].Text != "这一句还没说完，后面又继续补上来了" {
		t.Fatalf("captions = %#v, want long stream merged", captions)
	}
}

func TestCueboardParityMeetdLiveCaptionsReuseCaptionWhenStreamIDChanges(t *testing.T) {
	t.Parallel()

	service := newCueboardCaptionParityService(t)
	meetingID := scheduleCueboardCaptionParityMeeting(t, service, "caption-reuse-stream")
	base := time.Date(2026, 3, 20, 10, 0, 0, 0, time.UTC)
	initial := "这个 RFC 先把评估架构讲清楚"
	updated := "这个 RFC 先把评估架构讲清楚，然后再讲怎么接进现有系统"

	addCueboardCaption(t, service, meetingID, "stream-a", "Alice", initial, base)
	addCueboardCaption(t, service, meetingID, "stream-b", "Alice", updated, base.Add(90*time.Second))

	captions := listCueboardCaptions(t, service, meetingID)
	if len(captions) != 1 || captions[0].Text != updated {
		t.Fatalf("captions = %#v, want rebound stream reused", captions)
	}
}

func TestCueboardParityMeetdCaptionTranscriptInRangeFiltersAndDeduplicates(t *testing.T) {
	t.Parallel()

	base := time.Date(2026, 3, 23, 2, 0, 0, 0, time.UTC)
	transcript := meetdCaptionTranscriptInRange([]MeetdCaptionRecord{
		{Speaker: "Alice", Text: "第一句", Timestamp: base},
		{Speaker: "Alice", Text: "第一句完整版", Timestamp: base.Add(2 * time.Second)},
		{Speaker: "Bob", Text: "第二句", Timestamp: base.Add(6 * time.Minute)},
	}, base, base, base.Add(5*time.Minute))

	if strings.Contains(transcript, "第二句") {
		t.Fatalf("transcript leaked out-of-window text: %q", transcript)
	}
	if !strings.Contains(transcript, "[00:00:02] Alice: 第一句完整版") {
		t.Fatalf("transcript = %q, want deduped relative first caption", transcript)
	}
}

func TestCueboardParityMeetdCaptionTranscriptDropsInterleavedIncrementalRepeats(t *testing.T) {
	t.Parallel()

	base := time.Date(2026, 3, 23, 2, 0, 0, 0, time.UTC)
	transcript := meetdCaptionTranscript([]MeetdCaptionRecord{
		{Speaker: "Alice", Text: "这个评估器现在还不太完整", Timestamp: base},
		{Speaker: "Bob", Text: "嗯", Timestamp: base.Add(2 * time.Second)},
		{Speaker: "Alice", Text: "这个评估器现在还不太完整，需要把确定性评分器补上", Timestamp: base.Add(20 * time.Second)},
	}, base)

	if strings.Contains(transcript, "[00:00:00] Alice: 这个评估器现在还不太完整\n") {
		t.Fatalf("transcript kept stale shorter caption: %q", transcript)
	}
	if !strings.Contains(transcript, "[00:00:20] Alice: 这个评估器现在还不太完整，需要把确定性评分器补上") {
		t.Fatalf("transcript missing final incremental caption: %q", transcript)
	}
	if !strings.Contains(transcript, "[00:00:02] Bob: 嗯") {
		t.Fatalf("transcript dropped interleaved other speaker: %q", transcript)
	}
}

func TestCueboardParityMeetdCaptionTranscriptNormalizesAggregateSpeakerLabels(t *testing.T) {
	t.Parallel()

	base := time.Date(2026, 3, 23, 2, 0, 0, 0, time.UTC)
	transcript := meetdCaptionTranscriptInRange([]MeetdCaptionRecord{
		{Speaker: "Shenglan Huang & 1 others", Text: "先记一下这个 action item", Timestamp: base},
	}, base, base.Add(-time.Minute), base.Add(time.Minute))

	if strings.Contains(transcript, "& 1 others") {
		t.Fatalf("transcript kept aggregate speaker label: %q", transcript)
	}
	if !strings.Contains(transcript, "Shenglan Huang") {
		t.Fatalf("transcript missing normalized speaker: %q", transcript)
	}
}

func TestCueboardParityMeetdCaptionSpeakersNormalizeAggregateLabels(t *testing.T) {
	t.Parallel()

	got := meetdCaptionSpeakers([]MeetdCaptionRecord{
		{Speaker: "Shenglan Huang & 1 others"},
		{Speaker: "Shenglan Huang"},
		{Speaker: "Haowen Sun"},
	})
	if len(got) != 2 {
		t.Fatalf("speakers = %v, want 2 unique normalized speakers", got)
	}
	if got[0] != "Shenglan Huang" || got[1] != "Haowen Sun" {
		t.Fatalf("speakers = %v, want stable normalized names", got)
	}
}

func TestCueboardParityPickArtifactTranscriptPrefersCaptionOverRawASRWhenUncalibrated(t *testing.T) {
	t.Parallel()

	got := pickArtifactTranscript(transcriptCalibrationResult{}, "[02:00:00] Alice: 真实字幕", "[02:00:00] Alice: 幻觉 ASR")
	if got != "[02:00:00] Alice: 真实字幕" {
		t.Fatalf("pickArtifactTranscript = %q", got)
	}
}

func TestCueboardParityPickArtifactTranscriptRejectsPartialChunkCalibration(t *testing.T) {
	t.Parallel()

	got := pickArtifactTranscript(transcriptCalibrationResult{
		text:             "[00:00:10] Alice: 部分校准稿",
		calibratedChunks: 1,
		totalChunks:      2,
	}, "[00:00:10] Alice: 原始字幕", "[00:00:10] Alice: 原始 ASR")
	if got != "[00:00:10] Alice: 原始字幕" {
		t.Fatalf("pickArtifactTranscript = %q", got)
	}
}

func TestCueboardParitySummaryTranscriptSourcesRejectsPartialChunkCalibration(t *testing.T) {
	t.Parallel()

	caption, asr := summaryTranscriptSources(transcriptCalibrationResult{
		text:             "[00:00:10] Alice: 部分校准稿",
		calibratedChunks: 1,
		totalChunks:      3,
	}, "[00:00:10] Alice: 原始字幕", "[00:00:10] Alice: 原始 ASR")
	if caption != "[00:00:10] Alice: 原始字幕" || asr != "[00:00:10] Alice: 原始 ASR" {
		t.Fatalf("summaryTranscriptSources = (%q, %q)", caption, asr)
	}
}

func TestCueboardParityShouldChunkTranscriptCalibration(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		caption string
		asr     string
		want    bool
	}{
		{name: "small inputs stay direct", caption: strings.Repeat("a", 8000), asr: strings.Repeat("b", 9000), want: false},
		{name: "large captions chunk", caption: strings.Repeat("a", transcriptCalibrationCaptionLimit+1), asr: strings.Repeat("b", 1000), want: true},
		{name: "large asr chunks", caption: strings.Repeat("a", 15000), asr: strings.Repeat("b", transcriptCalibrationCaptionLimit+1), want: true},
		{name: "combined size chunks", caption: strings.Repeat("a", 15000), asr: strings.Repeat("b", 16001), want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldChunkTranscriptCalibration(tt.caption, tt.asr); got != tt.want {
				t.Fatalf("shouldChunkTranscriptCalibration(...) = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestCueboardParityCalibrateTranscriptInChunksUsesChunkWindowsAndFallbacks(t *testing.T) {
	t.Parallel()

	artifactsDir := t.TempDir()
	base := time.Date(2026, 3, 23, 2, 0, 0, 0, time.UTC)
	writeCueboardASRChunk(t, artifactsDir, 0, "# chunk_start: 2026-03-23T02:00:00Z\n[00:00] Speaker 1: ASR 第一段\n")
	writeCueboardASRChunk(t, artifactsDir, 1, "# chunk_start: 2026-03-23T02:05:00Z\n[00:00] Speaker 2: ASR 第二段\n")

	captions := []MeetdCaptionRecord{
		{Speaker: "Alice", Text: "字幕第一段", Timestamp: base.Add(10 * time.Second)},
		{Speaker: "Bob", Text: "字幕第二段", Timestamp: base.Add(5*time.Minute + 10*time.Second)},
	}

	calibrateCalls := 0
	got, calibratedChunks, totalChunks, err := calibrateTranscriptInChunks(
		context.Background(),
		11,
		captions,
		artifactsDir,
		base,
		func(_ context.Context, captionTranscript, asrTranscript string) (string, error) {
			calibrateCalls++
			if strings.Contains(captionTranscript, "字幕第一段") {
				return "[00:00:10] Alice: 校对第一段", nil
			}
			return "", context.DeadlineExceeded
		},
	)
	if err != nil {
		t.Fatalf("calibrateTranscriptInChunks: %v", err)
	}
	if calibrateCalls != 2 || calibratedChunks != 1 || totalChunks != 2 {
		t.Fatalf("calls/calibrated/total = %d/%d/%d, want 2/1/2", calibrateCalls, calibratedChunks, totalChunks)
	}
	if !strings.Contains(got, "[00:00:10] Alice: 校对第一段") {
		t.Fatalf("missing calibrated chunk in output: %q", got)
	}
	if !strings.Contains(got, "[00:05:10] Bob: 字幕第二段") {
		t.Fatalf("missing caption fallback chunk in output: %q", got)
	}
	if strings.Contains(got, "ASR 第二段") {
		t.Fatalf("unexpected raw ASR fallback in output: %q", got)
	}
}

func TestCueboardParityCalibrateTranscriptInChunksSkipsRawASROnlyChunksWithoutCaptions(t *testing.T) {
	t.Parallel()

	artifactsDir := t.TempDir()
	base := time.Date(2026, 3, 23, 2, 0, 0, 0, time.UTC)
	writeCueboardASRChunk(t, artifactsDir, 0, "# chunk_start: 2026-03-23T02:00:00Z\n[00:00] Speaker 1: ASR 第一段\n")
	writeCueboardASRChunk(t, artifactsDir, 1, "# chunk_start: 2026-03-23T02:05:00Z\n[00:00] Speaker 1: 這段沒有字幕支撐的幻覺內容\n")

	got, calibratedChunks, totalChunks, err := calibrateTranscriptInChunks(
		context.Background(),
		11,
		[]MeetdCaptionRecord{{Speaker: "Alice", Text: "字幕第一段", Timestamp: base.Add(10 * time.Second)}},
		artifactsDir,
		base,
		func(_ context.Context, captionTranscript, asrTranscript string) (string, error) {
			return "[00:00:10] Alice: 校对第一段", nil
		},
	)
	if err != nil {
		t.Fatalf("calibrateTranscriptInChunks: %v", err)
	}
	if calibratedChunks != 1 || totalChunks != 2 {
		t.Fatalf("calibrated/total = %d/%d, want 1/2", calibratedChunks, totalChunks)
	}
	if strings.Contains(got, "沒有字幕支撐") {
		t.Fatalf("unexpected ASR-only fallback in output: %q", got)
	}
}

func TestCueboardParityReadAndMergeChunkTranscriptsUsesMeetingRelativeTimestamps(t *testing.T) {
	t.Parallel()

	artifactsDir := t.TempDir()
	joinedAt := time.Date(2026, 3, 23, 2, 0, 0, 0, time.UTC)
	writeCueboardASRChunk(t, artifactsDir, 0, "# chunk_start: 2026-03-23T02:00:00Z\n[00:30] Alice: 第一段\n")
	writeCueboardASRChunk(t, artifactsDir, 1, "# chunk_start: 2026-03-23T02:05:00Z\n[00:10] Bob: 第二段\n")

	got, err := readAndMergeChunkTranscripts(artifactsDir, joinedAt)
	if err != nil {
		t.Fatalf("readAndMergeChunkTranscripts: %v", err)
	}
	if !strings.Contains(got, "[00:00:30] Alice: 第一段") || !strings.Contains(got, "[00:05:10] Bob: 第二段") {
		t.Fatalf("merged transcript = %q, want meeting-relative chunk timestamps", got)
	}
	if strings.Contains(got, "[02:05:10]") {
		t.Fatalf("kept absolute timestamp in merged ASR transcript: %q", got)
	}
}

func TestCueboardParityNormalizeTranscriptToMeetingRelativeTimeRewritesAbsoluteClockTimes(t *testing.T) {
	t.Parallel()

	origin := time.Date(2026, 3, 24, 9, 59, 10, 0, time.FixedZone("CST", 8*3600))
	end := origin.Add(18 * time.Minute)
	input := "[02:01:48] Heyang Zhou: 第一段\n[02:17:22] Shenglan Huang: 第二段"

	got := normalizeTranscriptToMeetingRelativeTime(input, origin, end)
	if !strings.Contains(got, "[00:02:38] Heyang Zhou: 第一段") {
		t.Fatalf("missing normalized first timestamp: %q", got)
	}
	if !strings.Contains(got, "[00:18:12] Shenglan Huang: 第二段") {
		t.Fatalf("missing normalized second timestamp: %q", got)
	}
	if strings.Contains(got, "[02:17:22]") {
		t.Fatalf("kept absolute clock timestamp: %q", got)
	}
}

func TestCueboardParityNormalizeTranscriptToMeetingRelativeTimeKeepsAlreadyRelativeTranscript(t *testing.T) {
	t.Parallel()

	origin := time.Date(2026, 3, 24, 9, 59, 10, 0, time.FixedZone("CST", 8*3600))
	end := origin.Add(30 * time.Minute)
	input := "[00:02:38] Heyang Zhou: 第一段\n[00:18:12] Shenglan Huang: 第二段"

	got := normalizeTranscriptToMeetingRelativeTime(input, origin, end)
	if got != input {
		t.Fatalf("normalizeTranscriptToMeetingRelativeTime changed already-relative transcript: %q", got)
	}
}

func newCueboardCaptionParityService(t *testing.T) *Service {
	t.Helper()
	service, _ := newMeetdOpsTestRouter(t, nil)
	return service
}

func scheduleCueboardCaptionParityMeeting(t *testing.T, service *Service, eventID string) int64 {
	t.Helper()
	base := time.Date(2026, 3, 20, 10, 0, 0, 0, time.UTC)
	meetingID, err := service.ScheduleMeetdMeeting(context.Background(), MeetdMeetingBrief{
		EventID: eventID,
		MeetURL: "https://meet.google.com/" + eventID,
		Title:   "Caption Test",
		StartAt: base.Format(time.RFC3339),
		EndAt:   base.Add(30 * time.Minute).Format(time.RFC3339),
		Status:  "active",
	})
	if err != nil {
		t.Fatalf("ScheduleMeetdMeeting: %v", err)
	}
	return meetingID
}

func addCueboardCaption(t *testing.T, service *Service, meetingID int64, streamID, speaker, text string, ts time.Time) {
	t.Helper()
	if _, err := service.AddMeetdCaption(context.Background(), meetingID, MeetdCaptionInput{
		StreamID:  streamID,
		Speaker:   speaker,
		Text:      text,
		Timestamp: ts.Format(time.RFC3339Nano),
		Source:    "live_caption",
	}); err != nil {
		t.Fatalf("AddMeetdCaption(%q, %q): %v", speaker, text, err)
	}
}

func listCueboardCaptions(t *testing.T, service *Service, meetingID int64) []MeetdCaptionRecord {
	t.Helper()
	captions, err := service.ListMeetdCaptions(context.Background(), meetingID, "live_caption")
	if err != nil {
		t.Fatalf("ListMeetdCaptions: %v", err)
	}
	return captions
}

func assertCaptionText(t *testing.T, captions []MeetdCaptionRecord, speaker, text string) {
	t.Helper()
	for _, caption := range captions {
		if caption.Speaker == speaker {
			if caption.Text != text {
				t.Fatalf("%s caption text = %q, want %q", speaker, caption.Text, text)
			}
			return
		}
	}
	t.Fatalf("speaker %q not found in captions %#v", speaker, captions)
}

func writeCueboardASRChunk(t *testing.T, dir string, index int, body string) {
	t.Helper()
	path := filepath.Join(dir, "asr_chunk_"+fmt.Sprintf("%03d", index)+".txt")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write chunk %d: %v", index, err)
	}
}
