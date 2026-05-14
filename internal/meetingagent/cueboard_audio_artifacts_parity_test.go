//go:build cueboardparity

package meetingagent

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCueboardParityPreferredMeetingAudioArtifactPathPrefersMP3(t *testing.T) {
	dir := t.TempDir()
	mp3Path := filepath.Join(dir, finalMeetingAudioFilename)
	wavPath := filepath.Join(dir, rawMeetingAudioFilename)
	if err := os.WriteFile(mp3Path, []byte("mp3"), 0o644); err != nil {
		t.Fatalf("write mp3: %v", err)
	}
	if err := os.WriteFile(wavPath, []byte("wav"), 0o644); err != nil {
		t.Fatalf("write wav: %v", err)
	}

	got := preferredMeetingAudioArtifactPath(dir)
	if got != mp3Path {
		t.Fatalf("preferredMeetingAudioArtifactPath() = %q, want %q", got, mp3Path)
	}
}

func TestCueboardParityFinalizeMeetingAudioArtifactDeletesRawByDefault(t *testing.T) {
	dir := t.TempDir()
	rawPath := filepath.Join(dir, rawMeetingAudioFilename)
	mp3Path := filepath.Join(dir, finalMeetingAudioFilename)
	if err := os.WriteFile(rawPath, []byte("wav"), 0o644); err != nil {
		t.Fatalf("write wav: %v", err)
	}

	orig := transcodeMeetingAudioToMP3
	transcodeMeetingAudioToMP3 = func(ctx context.Context, inputPath, outputPath string) error {
		return os.WriteFile(outputPath, []byte("mp3"), 0o644)
	}
	defer func() { transcodeMeetingAudioToMP3 = orig }()

	got := finalizeMeetingAudioArtifact(context.Background(), dir, 0)
	if got != mp3Path {
		t.Fatalf("finalizeMeetingAudioArtifact() = %q, want %q", got, mp3Path)
	}
	if _, err := os.Stat(mp3Path); err != nil {
		t.Fatalf("expected mp3 to exist: %v", err)
	}
	if _, err := os.Stat(rawPath); !os.IsNotExist(err) {
		t.Fatalf("expected raw wav to be removed, stat err = %v", err)
	}
}

func TestCueboardParityFinalizeMeetingAudioArtifactKeepsRawUntilRetentionExpires(t *testing.T) {
	dir := t.TempDir()
	rawPath := filepath.Join(dir, rawMeetingAudioFilename)
	mp3Path := filepath.Join(dir, finalMeetingAudioFilename)
	if err := os.WriteFile(rawPath, []byte("wav"), 0o644); err != nil {
		t.Fatalf("write wav: %v", err)
	}

	orig := transcodeMeetingAudioToMP3
	transcodeMeetingAudioToMP3 = func(ctx context.Context, inputPath, outputPath string) error {
		return os.WriteFile(outputPath, []byte("mp3"), 0o644)
	}
	defer func() { transcodeMeetingAudioToMP3 = orig }()

	got := finalizeMeetingAudioArtifact(context.Background(), dir, 24*time.Hour)
	if got != mp3Path {
		t.Fatalf("finalizeMeetingAudioArtifact() = %q, want %q", got, mp3Path)
	}
	if _, err := os.Stat(rawPath); err != nil {
		t.Fatalf("expected raw wav to be retained: %v", err)
	}
}
