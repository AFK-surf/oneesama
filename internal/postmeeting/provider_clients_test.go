package postmeeting

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenAIASRProviderPostsAudioToTranscriptionsEndpoint(t *testing.T) {
	t.Parallel()

	audioPath := filepath.Join(t.TempDir(), "audio.mp3")
	if err := os.WriteFile(audioPath, []byte("fake mp3"), 0o644); err != nil {
		t.Fatalf("write audio: %v", err)
	}
	var sawModel, sawLanguage, sawFile bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audio/transcriptions" {
			t.Fatalf("path = %s, want /v1/audio/transcriptions", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("Authorization = %q", got)
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Fatalf("ParseMultipartForm: %v", err)
		}
		sawModel = r.FormValue("model") == "asr-model"
		sawLanguage = r.FormValue("language") == "zh"
		if files := r.MultipartForm.File["file"]; len(files) == 1 && files[0].Filename == "audio.mp3" {
			sawFile = true
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"text": "转写文本",
		})
	}))
	defer server.Close()

	provider := &OpenAIASRProvider{
		APIKey:  "test-key",
		BaseURL: server.URL + "/v1",
		Model:   "asr-model",
	}
	transcript, err := provider.Transcribe(context.Background(), ASRRequest{AudioPath: audioPath, Language: "zh-CN"})
	if err != nil {
		t.Fatalf("Transcribe() error = %v", err)
	}
	if !sawModel || !sawLanguage || !sawFile {
		t.Fatalf("multipart fields model=%v language=%v file=%v", sawModel, sawLanguage, sawFile)
	}
	if transcript.Provider != "openai" || transcript.Text != "转写文本" || len(transcript.Segments) != 1 {
		t.Fatalf("transcript = %#v", transcript)
	}
}

func TestOpenAIChatClientPostsSummaryMessages(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %s, want /v1/chat/completions", r.URL.Path)
		}
		var payload struct {
			Model    string              `json:"model"`
			Messages []SummaryLLMMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		if payload.Model != "summary-model" || len(payload.Messages) != 2 || payload.Messages[0].Role != "system" {
			t.Fatalf("payload = %#v", payload)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message": map[string]string{"content": `{"title":"OK","highlights":["ship"]}`},
			}},
		})
	}))
	defer server.Close()

	client := &OpenAIChatClient{APIKey: "test-key", BaseURL: server.URL + "/v1", Model: "summary-model"}
	response, err := client.Chat(context.Background(), []SummaryLLMMessage{{Role: "system", Content: "s"}, {Role: "user", Content: "u"}})
	if err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
	if !strings.Contains(response.Content, `"title":"OK"`) {
		t.Fatalf("response = %#v", response)
	}
}
