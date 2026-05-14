package meetingagent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const transcriptCalibrationCaptionLimit = 30000

type transcriptCalibrationResult struct {
	text             string
	calibratedChunks int
	totalChunks      int
}

func (r transcriptCalibrationResult) complete() bool {
	return strings.TrimSpace(r.text) != "" && r.totalChunks > 0 && r.calibratedChunks == r.totalChunks
}

func pickArtifactTranscript(calibration transcriptCalibrationResult, captionTranscript, asrTranscript string) string {
	if calibration.complete() {
		return strings.TrimSpace(calibration.text)
	}
	if caption := strings.TrimSpace(captionTranscript); caption != "" {
		return caption
	}
	return strings.TrimSpace(asrTranscript)
}

func summaryTranscriptSources(calibration transcriptCalibrationResult, captionTranscript, asrTranscript string) (string, string) {
	if calibration.complete() {
		return strings.TrimSpace(calibration.text), ""
	}
	return strings.TrimSpace(captionTranscript), strings.TrimSpace(asrTranscript)
}

func shouldChunkTranscriptCalibration(captionTranscript, asrTranscript string) bool {
	return len(captionTranscript) > transcriptCalibrationCaptionLimit ||
		len(asrTranscript) > transcriptCalibrationCaptionLimit ||
		len(captionTranscript)+len(asrTranscript) > transcriptCalibrationCaptionLimit
}

type transcriptCalibrator func(context.Context, string, string) (string, error)

func calibrateTranscriptInChunks(
	ctx context.Context,
	meetingID int64,
	captions []MeetdCaptionRecord,
	artifactsDir string,
	origin time.Time,
	calibrate transcriptCalibrator,
) (string, int, int, error) {
	chunks, err := readMeetdASRChunks(artifactsDir)
	if err != nil {
		return "", 0, 0, err
	}
	if len(chunks) == 0 {
		return "", 0, 0, nil
	}

	output := make([]string, 0, len(chunks))
	calibratedChunks := 0
	for index, chunk := range chunks {
		start := chunk.start
		end := time.Time{}
		if index+1 < len(chunks) {
			end = chunks[index+1].start
		}
		captionTranscript := meetdCaptionTranscriptInRange(captions, origin, start, end)
		if strings.TrimSpace(captionTranscript) == "" {
			continue
		}
		asrTranscript := normalizeChunkTranscriptToMeetingRelativeTime(chunk.text, chunk.start, origin)
		calibrated, err := calibrate(ctx, captionTranscript, asrTranscript)
		if err == nil && strings.TrimSpace(calibrated) != "" {
			output = append(output, strings.TrimSpace(calibrated))
			calibratedChunks++
			continue
		}
		output = append(output, captionTranscript)
	}
	return strings.Join(output, "\n"), calibratedChunks, len(chunks), nil
}

func readAndMergeChunkTranscripts(artifactsDir string, joinedAt time.Time) (string, error) {
	chunks, err := readMeetdASRChunks(artifactsDir)
	if err != nil {
		return "", err
	}
	parts := make([]string, 0, len(chunks))
	for _, chunk := range chunks {
		if normalized := normalizeChunkTranscriptToMeetingRelativeTime(chunk.text, chunk.start, joinedAt); normalized != "" {
			parts = append(parts, normalized)
		}
	}
	return strings.Join(parts, "\n"), nil
}

type meetdASRChunk struct {
	path  string
	start time.Time
	text  string
}

func readMeetdASRChunks(artifactsDir string) ([]meetdASRChunk, error) {
	matches, err := filepath.Glob(filepath.Join(artifactsDir, "asr_chunk_*.txt"))
	if err != nil {
		return nil, err
	}
	sort.Strings(matches)
	chunks := make([]meetdASRChunk, 0, len(matches))
	for _, path := range matches {
		body, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read asr chunk %s: %w", path, err)
		}
		start, text := parseMeetdASRChunk(body)
		chunks = append(chunks, meetdASRChunk{path: path, start: start, text: text})
	}
	return chunks, nil
}

func parseMeetdASRChunk(body []byte) (time.Time, string) {
	lines := strings.Split(strings.ReplaceAll(string(body), "\r\n", "\n"), "\n")
	start := time.Time{}
	contentStart := 0
	if len(lines) > 0 && strings.HasPrefix(strings.TrimSpace(lines[0]), "# chunk_start:") {
		raw := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(lines[0]), "# chunk_start:"))
		if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			start = parsed
			contentStart = 1
		}
	}
	return start, strings.TrimSpace(strings.Join(lines[contentStart:], "\n"))
}

var meetdTranscriptLineRE = regexp.MustCompile(`^\[(\d{2}):(\d{2})(?::(\d{2}))?\]\s*(.*)$`)

func normalizeTranscriptToMeetingRelativeTime(input string, origin, end time.Time) string {
	lines := strings.Split(strings.ReplaceAll(strings.TrimSpace(input), "\r\n", "\n"), "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		match := meetdTranscriptLineRE.FindStringSubmatch(trimmed)
		if match == nil {
			out = append(out, trimmed)
			continue
		}
		seconds := parseMeetdTranscriptClock(match[1], match[2], match[3])
		relative := seconds
		if !origin.IsZero() && !looksLikeRelativeTranscriptClock(seconds, origin, end) {
			relative = secondsFromOriginClock(seconds, origin)
		}
		out = append(out, fmt.Sprintf("[%s] %s", formatSecondsHMS(relative), strings.TrimSpace(match[4])))
	}
	return strings.Join(out, "\n")
}

func normalizeChunkTranscriptToMeetingRelativeTime(input string, chunkStart, origin time.Time) string {
	lines := strings.Split(strings.ReplaceAll(strings.TrimSpace(input), "\r\n", "\n"), "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		match := meetdTranscriptLineRE.FindStringSubmatch(trimmed)
		if match == nil || chunkStart.IsZero() || origin.IsZero() {
			out = append(out, trimmed)
			continue
		}
		offset := parseMeetdTranscriptClock(match[1], match[2], match[3])
		absolute := chunkStart.Add(time.Duration(offset) * time.Second)
		relative := int(absolute.Sub(origin) / time.Second)
		out = append(out, fmt.Sprintf("[%s] %s", formatSecondsHMS(relative), strings.TrimSpace(match[4])))
	}
	return strings.Join(out, "\n")
}

func looksLikeRelativeTranscriptClock(seconds int, origin, end time.Time) bool {
	if seconds < 0 {
		return true
	}
	duration := 0
	if !origin.IsZero() && !end.IsZero() && end.After(origin) {
		duration = int(end.Sub(origin) / time.Second)
	}
	if duration <= 0 {
		duration = 12 * 60 * 60
	}
	return seconds <= duration+60
}

func secondsFromOriginClock(seconds int, origin time.Time) int {
	clockOrigin := origin.UTC()
	originClockSeconds := clockOrigin.Hour()*3600 + clockOrigin.Minute()*60 + clockOrigin.Second()
	relative := seconds - originClockSeconds
	if relative < 0 {
		relative += 24 * 3600
	}
	return relative
}

func parseMeetdTranscriptClock(hours, minutes, seconds string) int {
	h := parseTwoDigitInt(hours)
	m := parseTwoDigitInt(minutes)
	s := parseTwoDigitInt(seconds)
	if seconds == "" {
		return h*60 + m
	}
	return h*3600 + m*60 + s
}

func parseTwoDigitInt(value string) int {
	total := 0
	for _, r := range value {
		if r < '0' || r > '9' {
			return total
		}
		total = total*10 + int(r-'0')
	}
	return total
}

func formatSecondsHMS(seconds int) string {
	if seconds < 0 {
		seconds = 0
	}
	hours := seconds / 3600
	minutes := (seconds % 3600) / 60
	secs := seconds % 60
	return fmt.Sprintf("%02d:%02d:%02d", hours, minutes, secs)
}
