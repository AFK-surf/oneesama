package postmeeting

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultOpenAIASRModel  = "gpt-4o-mini-transcribe"
	defaultGeminiASRModel  = "gemini-3-flash-preview"
	defaultGeminiUploadURL = "https://generativelanguage.googleapis.com/upload/v1beta/files"
	defaultGeminiGenURL    = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent"
	defaultGeminiDeleteURL = "https://generativelanguage.googleapis.com/v1beta/%s"
)

type ASRProvider interface {
	Transcribe(ctx context.Context, request ASRRequest) (ASRTranscript, error)
}

type ASRRequest struct {
	AudioPath       string
	ArtifactDir     string
	Language        string
	Participants    []string
	ParentAudioPath string
	ChunkIndex      int
	ChunkCount      int
}

type ASRTranscript struct {
	Provider    string
	Text        string
	Segments    []NormalizedSegment
	AudioChunks []string
}

type ASRProviderConfig struct {
	Provider                     string
	Model                        string
	Language                     string
	OpenAIAPIKey                 string
	OpenAIBaseURL                string
	OpenAIAudioTranscriptionsURL string
	GeminiAPIKey                 string
	GeminiModel                  string
	GeminiUploadURL              string
	GeminiGenerateURL            string
	GeminiDeleteURL              string
	HTTPClient                   *http.Client
}

func NewConfiguredASRProvider(config ASRProviderConfig) ASRProvider {
	provider := strings.ToLower(firstNonEmpty(config.Provider))
	switch provider {
	case "", "caption", "captions", "none", "off", "disabled":
		return nil
	case "openai", "openai-audio", "gpt":
		return &OpenAIASRProvider{
			APIKey:                 config.OpenAIAPIKey,
			BaseURL:                config.OpenAIBaseURL,
			AudioTranscriptionsURL: config.OpenAIAudioTranscriptionsURL,
			Model:                  firstNonEmpty(config.Model, defaultOpenAIASRModel),
			Language:               config.Language,
			HTTPClient:             config.HTTPClient,
		}
	case "gemini", "google", "google-gemini":
		return &GeminiASRProvider{
			APIKey:      config.GeminiAPIKey,
			Model:       firstNonEmpty(config.GeminiModel, config.Model, defaultGeminiASRModel),
			UploadURL:   firstNonEmpty(config.GeminiUploadURL, defaultGeminiUploadURL),
			GenerateURL: firstNonEmpty(config.GeminiGenerateURL, defaultGeminiGenURL),
			DeleteURL:   firstNonEmpty(config.GeminiDeleteURL, defaultGeminiDeleteURL),
			HTTPClient:  config.HTTPClient,
		}
	default:
		return nil
	}
}

type OpenAIASRProvider struct {
	APIKey                 string
	BaseURL                string
	AudioTranscriptionsURL string
	Model                  string
	Language               string
	HTTPClient             *http.Client
}

func (p *OpenAIASRProvider) Transcribe(ctx context.Context, request ASRRequest) (ASRTranscript, error) {
	if firstNonEmpty(p.APIKey) == "" {
		return ASRTranscript{}, fmt.Errorf("openai asr api key is not configured")
	}
	audioPath := firstNonEmpty(request.AudioPath)
	if audioPath == "" {
		return ASRTranscript{}, fmt.Errorf("audio path is empty")
	}
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if err := writer.WriteField("model", firstNonEmpty(p.Model, defaultOpenAIASRModel)); err != nil {
		return ASRTranscript{}, err
	}
	if language := firstNonEmpty(request.Language, p.Language); language != "" && strings.ToLower(language) != "auto" {
		if err := writer.WriteField("language", normalizeASRLanguage(language)); err != nil {
			return ASRTranscript{}, err
		}
	}
	file, err := os.Open(audioPath)
	if err != nil {
		return ASRTranscript{}, fmt.Errorf("open audio: %w", err)
	}
	defer file.Close()
	part, err := writer.CreateFormFile("file", filepath.Base(audioPath))
	if err != nil {
		return ASRTranscript{}, fmt.Errorf("create audio part: %w", err)
	}
	if _, err := io.Copy(part, file); err != nil {
		return ASRTranscript{}, fmt.Errorf("copy audio: %w", err)
	}
	if err := writer.Close(); err != nil {
		return ASRTranscript{}, fmt.Errorf("close multipart body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint(), body)
	if err != nil {
		return ASRTranscript{}, err
	}
	req.Header.Set("Authorization", "Bearer "+firstNonEmpty(p.APIKey))
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := httpClient(p.HTTPClient).Do(req)
	if err != nil {
		return ASRTranscript{}, fmt.Errorf("openai asr request: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ASRTranscript{}, fmt.Errorf("openai asr failed (%d): %s", resp.StatusCode, string(respBody))
	}
	transcript := parseOpenAIASRResponse(respBody)
	transcript.Provider = "openai"
	if len(transcript.Segments) == 0 && firstNonEmpty(transcript.Text) != "" {
		transcript.Segments = transcriptSegmentsFromText(transcript.Text, "asr")
	}
	return transcript, nil
}

func (p *OpenAIASRProvider) endpoint() string {
	if endpoint := firstNonEmpty(p.AudioTranscriptionsURL); endpoint != "" {
		return endpoint
	}
	baseURL := strings.TrimRight(firstNonEmpty(p.BaseURL, "https://api.openai.com/v1"), "/")
	return baseURL + "/audio/transcriptions"
}

func parseOpenAIASRResponse(body []byte) ASRTranscript {
	var raw struct {
		Text     string `json:"text"`
		Segments []struct {
			Start float64 `json:"start"`
			End   float64 `json:"end"`
			Text  string  `json:"text"`
		} `json:"segments"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return ASRTranscript{Text: strings.TrimSpace(string(body))}
	}
	segments := make([]NormalizedSegment, 0, len(raw.Segments))
	texts := make([]string, 0, len(raw.Segments))
	for _, segment := range raw.Segments {
		text := firstNonEmpty(segment.Text)
		if text == "" {
			continue
		}
		startMS := int64(segment.Start * 1000)
		endMS := int64(segment.End * 1000)
		segments = append(segments, NormalizedSegment{
			Speaker: "ASR",
			Text:    text,
			StartMS: &startMS,
			EndMS:   &endMS,
			Source:  "asr",
		})
		texts = append(texts, text)
	}
	text := firstNonEmpty(raw.Text, strings.Join(texts, " "))
	return ASRTranscript{Text: text, Segments: segments}
}

type GeminiASRProvider struct {
	APIKey      string
	Model       string
	UploadURL   string
	GenerateURL string
	DeleteURL   string
	HTTPClient  *http.Client
}

func (p *GeminiASRProvider) Transcribe(ctx context.Context, request ASRRequest) (ASRTranscript, error) {
	if firstNonEmpty(p.APIKey) == "" {
		return ASRTranscript{}, fmt.Errorf("gemini asr api key is not configured")
	}
	audioPath := firstNonEmpty(request.AudioPath)
	if audioPath == "" {
		return ASRTranscript{}, fmt.Errorf("audio path is empty")
	}
	fileURI, fileName, err := p.uploadFile(ctx, audioPath)
	if err != nil {
		return ASRTranscript{}, err
	}
	defer func() {
		_ = p.deleteFile(context.Background(), fileName)
	}()
	text, err := p.generateTranscript(ctx, fileURI, mimeTypeForAudio(audioPath), buildGeminiASRPrompt(request.Participants))
	if err != nil {
		return ASRTranscript{}, err
	}
	text = firstNonEmpty(text)
	return ASRTranscript{
		Provider: "gemini",
		Text:     text,
		Segments: transcriptSegmentsFromText(text, "asr"),
	}, nil
}

func (p *GeminiASRProvider) uploadFile(ctx context.Context, audioPath string) (string, string, error) {
	file, err := os.Open(audioPath)
	if err != nil {
		return "", "", fmt.Errorf("open audio: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", "", fmt.Errorf("stat audio: %w", err)
	}
	pr, pw := io.Pipe()
	writer := multipart.NewWriter(pw)
	var writeErr error
	go func() {
		defer pw.Close()
		defer writer.Close()
		metaPart, err := writer.CreatePart(map[string][]string{
			"Content-Disposition": {"form-data; name=\"metadata\""},
			"Content-Type":        {"application/json"},
		})
		if err != nil {
			writeErr = err
			return
		}
		_ = json.NewEncoder(metaPart).Encode(map[string]any{"file": map[string]string{"display_name": filepath.Base(audioPath)}})
		filePart, err := writer.CreatePart(map[string][]string{
			"Content-Disposition": {fmt.Sprintf("form-data; name=\"file\"; filename=\"%s\"", filepath.Base(audioPath))},
			"Content-Type":        {mimeTypeForAudio(audioPath)},
		})
		if err != nil {
			writeErr = err
			return
		}
		_, writeErr = io.Copy(filePart, file)
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, firstNonEmpty(p.UploadURL, defaultGeminiUploadURL)+"?key="+firstNonEmpty(p.APIKey), pr)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("X-Goog-Upload-Protocol", "multipart")
	req.Header.Set("X-Goog-Upload-Header-Content-Length", fmt.Sprintf("%d", info.Size()))
	req.Header.Set("X-Goog-Upload-Header-Content-Type", mimeTypeForAudio(audioPath))
	resp, err := httpClient(p.HTTPClient).Do(req)
	if err != nil {
		return "", "", fmt.Errorf("gemini upload request: %w", err)
	}
	defer resp.Body.Close()
	if writeErr != nil {
		return "", "", fmt.Errorf("gemini upload body: %w", writeErr)
	}
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", fmt.Errorf("gemini upload failed (%d): %s", resp.StatusCode, string(respBody))
	}
	var uploadResp struct {
		File struct {
			Name string `json:"name"`
			URI  string `json:"uri"`
		} `json:"file"`
	}
	if err := json.Unmarshal(respBody, &uploadResp); err != nil {
		return "", "", fmt.Errorf("parse gemini upload response: %w", err)
	}
	return uploadResp.File.URI, uploadResp.File.Name, nil
}

func (p *GeminiASRProvider) generateTranscript(ctx context.Context, fileURI, mimeType, prompt string) (string, error) {
	endpoint := fmt.Sprintf(firstNonEmpty(p.GenerateURL, defaultGeminiGenURL), firstNonEmpty(p.Model, defaultGeminiASRModel)) + "?key=" + firstNonEmpty(p.APIKey)
	body, err := json.Marshal(map[string]any{
		"contents": []map[string]any{{
			"role": "user",
			"parts": []map[string]any{
				{"file_data": map[string]string{"mime_type": mimeType, "file_uri": fileURI}},
				{"text": prompt},
			},
		}},
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient(p.HTTPClient).Do(req)
	if err != nil {
		return "", fmt.Errorf("gemini generate request: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("gemini generate failed (%d): %s", resp.StatusCode, string(respBody))
	}
	text, _ := parseGeminiTextResponse(respBody)
	if text == "" {
		return "", fmt.Errorf("empty response from gemini")
	}
	return text, nil
}

func (p *GeminiASRProvider) deleteFile(ctx context.Context, fileName string) error {
	if firstNonEmpty(fileName) == "" {
		return nil
	}
	endpoint := fmt.Sprintf(firstNonEmpty(p.DeleteURL, defaultGeminiDeleteURL), fileName) + "?key=" + firstNonEmpty(p.APIKey)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	resp, err := httpClient(p.HTTPClient).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("delete gemini file failed (%d): %s", resp.StatusCode, string(body))
	}
	return nil
}

func parseGeminiTextResponse(body []byte) (string, bool) {
	var raw struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(body, &raw); err != nil || len(raw.Candidates) == 0 {
		return "", false
	}
	var out strings.Builder
	for _, part := range raw.Candidates[0].Content.Parts {
		out.WriteString(part.Text)
	}
	return strings.TrimSpace(out.String()), raw.Candidates[0].FinishReason == "MAX_TOKENS"
}

func buildGeminiASRPrompt(participants []string) string {
	base := `Transcribe the following meeting audio recording. Output plain transcript lines only.
Rules:
- Transcribe in the language spoken.
- Preserve Chinese as Chinese; do not translate.
- Include speaker changes when distinguishable.
- Output format: [MM:SS] Speaker Name: text
- Do not add commentary, markdown, or explanations.`
	if len(participants) == 0 {
		return base + "\n- Label speakers as \"Speaker 1\", \"Speaker 2\", etc."
	}
	return base + "\n- Use these speaker names when the audio supports them: " + strings.Join(participants, ", ")
}

func transcriptSegmentsFromText(text string, source string) []NormalizedSegment {
	lines := strings.Split(strings.ReplaceAll(strings.TrimSpace(text), "\r\n", "\n"), "\n")
	segments := make([]NormalizedSegment, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		line = trimTranscriptClock(line)
		speaker := ""
		if before, after, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(after) != "" && len([]rune(before)) <= 48 {
			speaker = strings.TrimSpace(before)
			line = strings.TrimSpace(after)
		}
		segments = append(segments, NormalizedSegment{
			Speaker: speaker,
			Text:    line,
			Source:  firstNonEmpty(source, "asr"),
		})
	}
	return segments
}

func trimTranscriptClock(line string) string {
	if !strings.HasPrefix(line, "[") {
		return line
	}
	if end := strings.Index(line, "]"); end >= 0 && end+1 < len(line) {
		return strings.TrimSpace(line[end+1:])
	}
	return line
}

func normalizeASRLanguage(language string) string {
	language = strings.TrimSpace(language)
	if language == "" {
		return ""
	}
	language = strings.ReplaceAll(language, "_", "-")
	if i := strings.Index(language, "-"); i > 0 {
		language = language[:i]
	}
	return strings.ToLower(language)
}

func mimeTypeForAudio(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	case ".ogg":
		return "audio/ogg"
	case ".flac":
		return "audio/flac"
	default:
		return "application/octet-stream"
	}
}

func httpClient(client *http.Client) *http.Client {
	if client != nil {
		return client
	}
	return http.DefaultClient
}
