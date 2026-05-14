//go:build cueboardparity

package meetingagent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCueboardParityNormalizeWhisperLanguage(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "default", input: "", want: "zh"},
		{name: "locale", input: "zh-CN", want: "zh"},
		{name: "underscore", input: "en_US", want: "en"},
		{name: "simple", input: "ja", want: "ja"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeWhisperLanguage(tt.input); got != tt.want {
				t.Fatalf("normalizeWhisperLanguage(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestCueboardParityReadWhisperCPPOutput(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "transcript.json")
	writeASRParityTestFile(t, path, `{
  "transcription": [
    {"text": "  first line  ", "offsets": {"from": 120, "to": 980}},
    {"text": "second line", "offsets": {"from": 1000, "to": 2200}}
  ]
}`)

	result, err := readWhisperCPPOutput(path)
	if err != nil {
		t.Fatalf("readWhisperCPPOutput: %v", err)
	}
	if len(result.Segments) != 2 {
		t.Fatalf("segments = %d, want 2", len(result.Segments))
	}
	if result.Segments[0].Start != 0.12 {
		t.Fatalf("first segment start = %v, want 0.12", result.Segments[0].Start)
	}
	if result.FullText != "first line second line" {
		t.Fatalf("full text = %q, want %q", result.FullText, "first line second line")
	}
}

func TestCueboardParityFindWhisperCPPModelExplicitPath(t *testing.T) {
	dir := t.TempDir()
	modelPath := filepath.Join(dir, "ggml-base.bin")
	writeASRParityTestFile(t, modelPath, "model")

	got, err := findWhisperCPPModel(modelPath)
	if err != nil {
		t.Fatalf("findWhisperCPPModel returned error: %v", err)
	}
	if got != modelPath {
		t.Fatalf("findWhisperCPPModel = %q, want %q", got, modelPath)
	}
}

func TestCueboardParityFindWhisperCPPBinaryExplicitPathMissing(t *testing.T) {
	_, err := findWhisperCPPBinary("/tmp/does-not-exist-whisper-cli")
	if err == nil {
		t.Fatal("findWhisperCPPBinary should fail for a missing explicit path")
	}
}

func writeASRParityTestFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}
