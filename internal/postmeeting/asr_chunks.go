package postmeeting

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var asrAudioChunkExtensions = map[string]bool{
	".flac": true,
	".m4a":  true,
	".mp3":  true,
	".ogg":  true,
	".wav":  true,
}

func discoverASRAudioChunks(input PostProcessInput, artifactDir string) []string {
	candidates := make([]string, 0, len(input.AudioChunks))
	candidates = append(candidates, input.AudioChunks...)

	dirs := make([]string, 0, 2)
	if audioPath := strings.TrimSpace(input.AudioPath); audioPath != "" {
		dirs = append(dirs, filepath.Dir(audioPath))
	}
	if artifactDir := strings.TrimSpace(artifactDir); artifactDir != "" {
		dirs = append(dirs, artifactDir)
	}
	for _, dir := range uniqueStrings(dirs) {
		candidates = append(candidates, discoverASRAudioChunksInDir(dir)...)
	}
	return existingAudioChunkFiles(candidates)
}

func discoverASRAudioChunksInDir(dir string) []string {
	if strings.TrimSpace(dir) == "" {
		return nil
	}
	matches, err := filepath.Glob(filepath.Join(dir, "audio_chunk_*"))
	if err != nil {
		return nil
	}
	sort.Strings(matches)
	return matches
}

func existingAudioChunkFiles(paths []string) []string {
	out := make([]string, 0, len(paths))
	seen := map[string]bool{}
	for _, path := range paths {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		abs, err := filepath.Abs(path)
		if err == nil {
			path = abs
		}
		if seen[path] {
			continue
		}
		seen[path] = true
		if !asrAudioChunkExtensions[strings.ToLower(filepath.Ext(path))] {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || info.IsDir() || info.Size() == 0 {
			continue
		}
		out = append(out, path)
	}
	sort.Strings(out)
	return out
}

func transcribeAudioChunks(ctx context.Context, provider ASRProvider, base ASRRequest, chunks []string) (ASRTranscript, error) {
	chunks = existingAudioChunkFiles(chunks)
	if len(chunks) == 0 {
		return ASRTranscript{}, nil
	}

	textParts := make([]string, 0, len(chunks))
	segments := make([]NormalizedSegment, 0, len(chunks))
	errors := make([]string, 0)
	providerName := ""
	for index, chunk := range chunks {
		request := base
		request.AudioPath = chunk
		request.ParentAudioPath = firstNonEmpty(base.ParentAudioPath, base.AudioPath)
		request.ChunkIndex = index
		request.ChunkCount = len(chunks)
		transcript, err := provider.Transcribe(ctx, request)
		if err != nil {
			errors = append(errors, fmt.Sprintf("chunk %d: %v", index, err))
			continue
		}
		if providerName == "" {
			providerName = strings.TrimSpace(transcript.Provider)
		}
		text := strings.TrimSpace(transcript.Text)
		if text == "" && len(transcript.Segments) > 0 {
			text = renderTranscriptText(transcript.Segments)
		}
		if text == "" {
			continue
		}
		textParts = append(textParts, text)
		if err := writeASRChunkTranscript(base.ArtifactDir, index, text); err != nil {
			return ASRTranscript{}, err
		}
		chunkSegments := transcript.Segments
		if len(chunkSegments) == 0 {
			chunkSegments = transcriptSegmentsFromText(text, "asr_chunk")
		}
		for _, segment := range chunkSegments {
			if !strings.Contains(strings.ToLower(segment.Source), "chunk") {
				segment.Source = firstNonEmpty(segment.Source, "asr") + "_chunk"
			}
			segments = append(segments, segment)
		}
	}

	if len(textParts) == 0 {
		if len(errors) > 0 {
			return ASRTranscript{}, fmt.Errorf("asr chunk transcription failed: %s", strings.Join(errors, "; "))
		}
		return ASRTranscript{Provider: "chunked", AudioChunks: chunks}, nil
	}

	providerName = firstNonEmpty(providerName, "asr")
	if len(errors) > 0 {
		providerName += ":chunked_partial"
	} else {
		providerName += ":chunked"
	}
	return ASRTranscript{
		Provider:    providerName,
		Text:        strings.Join(textParts, "\n"),
		Segments:    segments,
		AudioChunks: chunks,
	}, nil
}

func writeASRChunkTranscript(artifactDir string, index int, text string) error {
	artifactDir = strings.TrimSpace(artifactDir)
	text = strings.TrimSpace(text)
	if artifactDir == "" || text == "" {
		return nil
	}
	if err := os.MkdirAll(artifactDir, 0o755); err != nil {
		return fmt.Errorf("create asr chunk artifact dir: %w", err)
	}
	path := filepath.Join(artifactDir, fmt.Sprintf("asr_chunk_%03d.txt", index))
	if err := os.WriteFile(path, []byte(text+"\n"), 0o644); err != nil {
		return fmt.Errorf("write asr chunk transcript: %w", err)
	}
	return nil
}

func uniqueStrings(values []string) []string {
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}
