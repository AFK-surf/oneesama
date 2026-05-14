package meetingagent

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const defaultASRLanguage = "zh"

type ASRResult struct {
	Segments []ASRSegment `json:"segments"`
	FullText string       `json:"full_text"`
}

type ASRSegment struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

type whisperCPPOutput struct {
	Transcription []struct {
		Text    string `json:"text"`
		Offsets struct {
			From int64 `json:"from"`
			To   int64 `json:"to"`
		} `json:"offsets"`
	} `json:"transcription"`
}

func normalizeWhisperLanguage(locale string) string {
	language := strings.TrimSpace(locale)
	if language == "" {
		return defaultASRLanguage
	}
	language = strings.ReplaceAll(language, "_", "-")
	if i := strings.Index(language, "-"); i > 0 {
		language = language[:i]
	}
	return strings.ToLower(language)
}

func readWhisperCPPOutput(outputPath string) (*ASRResult, error) {
	data, err := os.ReadFile(outputPath)
	if err != nil {
		return nil, fmt.Errorf("read whisper.cpp output: %w", err)
	}

	var raw whisperCPPOutput
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse whisper.cpp output: %w", err)
	}

	segments := make([]ASRSegment, 0, len(raw.Transcription))
	texts := make([]string, 0, len(raw.Transcription))
	for _, segment := range raw.Transcription {
		text := strings.TrimSpace(segment.Text)
		if text == "" {
			continue
		}
		segments = append(segments, ASRSegment{
			Start: float64(segment.Offsets.From) / 1000.0,
			End:   float64(segment.Offsets.To) / 1000.0,
			Text:  text,
		})
		texts = append(texts, text)
	}

	return &ASRResult{
		Segments: segments,
		FullText: strings.Join(texts, " "),
	}, nil
}

func findWhisperCPPBinary(configPath string) (string, error) {
	if configPath != "" {
		if path, err := exec.LookPath(configPath); err == nil {
			return path, nil
		}
		if _, err := os.Stat(configPath); err == nil {
			return configPath, nil
		}
		return "", fmt.Errorf("whisper.cpp CLI not found at %s", configPath)
	}

	candidates := []string{
		"whisper-cli",
		"/opt/homebrew/bin/whisper-cli",
		"/usr/local/bin/whisper-cli",
		"main",
	}
	for _, candidate := range candidates {
		if path, err := exec.LookPath(candidate); err == nil {
			return path, nil
		}
	}

	return "", fmt.Errorf("whisper.cpp CLI not found (install whisper-cpp or set WHISPER_CPP_PATH)")
}

func findWhisperCPPModel(configPath string) (string, error) {
	if configPath != "" {
		if _, err := os.Stat(configPath); err == nil {
			return configPath, nil
		}
		return "", fmt.Errorf("whisper.cpp model not found at %s", configPath)
	}

	for _, candidate := range whisperModelCandidates() {
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}

	return "", fmt.Errorf("whisper.cpp model not found (set WHISPER_MODEL_PATH)")
}

func whisperModelCandidates() []string {
	names := []string{
		"ggml-base.bin",
		"ggml-small.bin",
		"ggml-medium.bin",
		"ggml-large-v3-turbo.bin",
	}
	candidates := make([]string, 0, len(names)*5)

	if cwd, err := os.Getwd(); err == nil {
		for _, name := range names {
			candidates = append(candidates,
				filepath.Join(cwd, "models", name),
				filepath.Join(cwd, "agent-framework", "models", name),
				filepath.Join(cwd, "whisper.cpp", "models", name),
			)
		}
	}

	if home := os.Getenv("HOME"); home != "" {
		for _, name := range names {
			candidates = append(candidates,
				filepath.Join(home, ".cache", "whisper.cpp", "models", name),
				filepath.Join(home, "whisper.cpp", "models", name),
			)
		}
	}

	return candidates
}
