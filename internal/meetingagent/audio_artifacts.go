package meetingagent

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	rawMeetingAudioFilename   = "audio.wav"
	finalMeetingAudioFilename = "audio.mp3"
	meetingCaptionsFilename   = "captions.json"
	meetingTranscriptFilename = "transcript.txt"

	// Two legacy artifact root path conventions the redelivery path falls
	// back to when the manifest / session.Metadata do not point at the
	// canonical artifact location. Centralised here so adding a new
	// candidate root only requires one edit, and the regression test pins
	// both prefixes. Task #274.
	legacyMeetdArtifactRoot     = "/tmp/meeting-avatar-bot-data/meeting-artifacts"
	legacyRunnerArtifactRoot    = "runtime/meeting-artifacts"
	legacyRunnerSessionDirInfix = "runner-"
)

// meetingArtifactCandidatePaths returns the ordered list of file paths a
// redelivery path should try for the given session ID and artifact filename
// (rawMeetingAudioFilename / finalMeetingAudioFilename /
// meetingCaptionsFilename / meetingTranscriptFilename). The first entry is
// the canonical meetd artifacts root; the second is the runner-side fallback
// that pre-dates the meetd cutover. Callers should iterate in order and pick
// the first that satisfies usableMeetingAudioArtifactPath (for audio) or
// os.Stat (for captions / transcript). Task #274.
func meetingArtifactCandidatePaths(sessionID string, filename string) []string {
	if strings.TrimSpace(sessionID) == "" || strings.TrimSpace(filename) == "" {
		return nil
	}
	return []string{
		filepath.Join(legacyMeetdArtifactRoot, sessionID, filename),
		filepath.Join(legacyRunnerArtifactRoot, legacyRunnerSessionDirInfix+sessionID, filename),
	}
}

var transcodeMeetingAudioToMP3 = func(ctx context.Context, inputPath, outputPath string) error {
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-y", "-i", inputPath,
		"-ac", "1", "-ar", "16000",
		"-codec:a", "libmp3lame", "-b:a", "64k",
		outputPath,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg transcode: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

var inspectMeetingAudioSignal = func(ctx context.Context, path string) (bool, bool) {
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner", "-nostats",
		"-i", path,
		"-af", "astats=metadata=1:reset=0",
		"-f", "null",
		"-",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return true, false
	}
	return parseMeetingAudioSignal(string(out))
}

func parseMeetingAudioSignal(output string) (bool, bool) {
	sawMaxLevel := false
	sawSilentPeak := false
	for _, line := range strings.Split(output, "\n") {
		if strings.Contains(line, "Peak level dB:") && strings.Contains(line, "-inf") {
			sawSilentPeak = true
		}
		if !strings.Contains(line, "Max level:") {
			continue
		}
		_, raw, ok := strings.Cut(line, "Max level:")
		if !ok {
			continue
		}
		value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
		if err != nil {
			continue
		}
		sawMaxLevel = true
		if value > 0.000001 || value < -0.000001 {
			return true, true
		}
	}
	if sawMaxLevel || sawSilentPeak {
		return false, true
	}
	return true, false
}

func meetingAudioArtifactHasSignal(ctx context.Context, path string) bool {
	probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	hasSignal, ok := inspectMeetingAudioSignal(probeCtx, path)
	if !ok {
		return true
	}
	return hasSignal
}

func usableMeetingAudioArtifactPath(ctx context.Context, path string) string {
	path = existingRuntimePath(path)
	if path == "" {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Size() == 0 {
		return ""
	}
	if !meetingAudioArtifactHasSignal(ctx, path) {
		return ""
	}
	return path
}

func preferredMeetingAudioArtifactPath(artifactsDir string) string {
	rawPath, mp3Path := meetingAudioArtifactPaths(artifactsDir)
	if rawPath == "" {
		return ""
	}
	for _, candidate := range []string{mp3Path, rawPath} {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func finalizeMeetingAudioArtifact(ctx context.Context, artifactsDir string, rawRetention time.Duration) string {
	rawPath, mp3Path := meetingAudioArtifactPaths(artifactsDir)
	if rawPath == "" {
		return ""
	}

	if info, err := os.Stat(mp3Path); err == nil && !info.IsDir() {
		maybeRemoveRawMeetingAudio(rawPath, rawRetention, time.Now())
		return mp3Path
	}

	info, err := os.Stat(rawPath)
	if err != nil || info.IsDir() {
		return ""
	}

	if err := transcodeMeetingAudioToMP3(ctx, rawPath, mp3Path); err != nil {
		return rawPath
	}

	maybeRemoveRawMeetingAudio(rawPath, rawRetention, time.Now())
	return mp3Path
}

func maybeRemoveRawMeetingAudio(rawPath string, retention time.Duration, now time.Time) {
	info, err := os.Stat(rawPath)
	if err != nil || info.IsDir() {
		return
	}
	if retention > 0 && now.Sub(info.ModTime()) < retention {
		return
	}
	_ = os.Remove(rawPath)
}

func meetingAudioArtifactPaths(artifactsDir string) (string, string) {
	artifactsDir = strings.TrimSpace(artifactsDir)
	if artifactsDir == "" {
		return "", ""
	}
	return filepath.Join(artifactsDir, rawMeetingAudioFilename), filepath.Join(artifactsDir, finalMeetingAudioFilename)
}
