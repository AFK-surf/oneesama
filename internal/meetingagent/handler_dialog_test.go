package meetingagent

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/httpserver"
	"github.com/AFK-surf/oneesama/internal/internalauth"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
	"github.com/gin-gonic/gin"
)

func TestDialogProvidersRouteMatchesOldShape(t *testing.T) {
	t.Parallel()

	router := newDialogTestRouter(t, appconfig.DialogConfig{STTProvider: "event", TTSProvider: "tone-wav", TTSVoice: "default"})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, dialogRequest(http.MethodGet, "/dialog/providers", ""))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var body map[string]any
	decodeRealtimeBody(t, response.Body.String(), &body)
	tts := body["tts"].(map[string]any)
	if body["ok"] != true || tts["provider"] != "tone-wav" || tts["route"] != "/tts/synthesize" {
		t.Fatalf("body = %#v, want old dialog provider shape", body)
	}
}

func TestTTSSynthesizeToneWav(t *testing.T) {
	t.Parallel()

	router := newDialogTestRouter(t, appconfig.DialogConfig{STTProvider: "event", TTSProvider: "tone-wav", TTSVoice: "default"})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, dialogRequest(http.MethodPost, "/tts/synthesize", `{"text":"hello","durationMs":500,"frequency":440,"gain":0.1}`))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var body map[string]any
	decodeRealtimeBody(t, response.Body.String(), &body)
	if body["provider"] != "tone-wav" || body["mimeType"] != "audio/wav" || body["textLength"] != float64(5) {
		t.Fatalf("body = %#v, want tone wav response", body)
	}
	encoded := strings.TrimPrefix(body["audioDataUrl"].(string), "data:audio/wav;base64,")
	wav, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || string(wav[:4]) != "RIFF" || string(wav[8:12]) != "WAVE" {
		t.Fatalf("audioDataUrl did not decode to WAV: len=%d err=%v", len(wav), err)
	}
}

func TestTTSSynthesizeTextRequired(t *testing.T) {
	t.Parallel()

	router := newDialogTestRouter(t, appconfig.DialogConfig{STTProvider: "event", TTSProvider: "tone-wav", TTSVoice: "default"})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, dialogRequest(http.MethodPost, "/tts/synthesize", `{}`))

	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"text_required"`) {
		t.Fatalf("response = %d %s, want text_required", response.Code, response.Body.String())
	}
}

func TestTTSSynthesizeHTTPProvider(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		if payload["text"] != "hello" || payload["voice"] != "default" {
			t.Fatalf("payload = %#v, want normalized text/voice", payload)
		}
		_, _ = w.Write([]byte(`{"ok":true,"audioDataUrl":"data:audio/wav;base64,AA==","provider":"http-test"}`))
	}))
	defer upstream.Close()

	router := newDialogTestRouter(t, appconfig.DialogConfig{STTProvider: "event", TTSProvider: "http", TTSVoice: "default", TTSHTTPURL: upstream.URL})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, dialogRequest(http.MethodPost, "/tts/synthesize", `{"text":"hello"}`))

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"provider":"http-test"`) {
		t.Fatalf("response = %d %s, want upstream provider response", response.Code, response.Body.String())
	}
}

func TestTTSSynthesizeCommandProvider(t *testing.T) {
	t.Parallel()

	command := `printf '{"ok":true,"provider":"command-test","audioDataUrl":"data:audio/wav;base64,AA=="}'`
	router := newDialogTestRouter(t, appconfig.DialogConfig{STTProvider: "event", TTSProvider: "command", TTSVoice: "default", TTSCommand: command})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, dialogRequest(http.MethodPost, "/tts/synthesize", `{"text":"hello"}`))

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"provider":"command-test"`) {
		t.Fatalf("response = %d %s, want command provider response", response.Code, response.Body.String())
	}
}

func TestDialogTurnRunsAgentRunnerAndReports(t *testing.T) {
	t.Parallel()

	router := newDialogTestRouter(t, appconfig.DialogConfig{STTProvider: "event", TTSProvider: "tone-wav", TTSVoice: "default"})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, dialogRequest(http.MethodPost, "/dialog/turn", `{"sessionId":"meet_123","utterance":"summarize this","context":{"source":"test"},"timeoutMs":100}`))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var body map[string]any
	decodeRealtimeBody(t, response.Body.String(), &body)
	if body["ok"] != true || body["status"] != "completed" || !strings.Contains(body["responseText"].(string), "Dry-run agent runner accepted") {
		t.Fatalf("body = %#v, want completed dry-run dialog turn", body)
	}
	if body["report"] == nil {
		t.Fatalf("body = %#v, want worker report", body)
	}
}

func TestDialogTurnRequiresUtterance(t *testing.T) {
	t.Parallel()

	router := newDialogTestRouter(t, appconfig.DialogConfig{STTProvider: "event", TTSProvider: "tone-wav", TTSVoice: "default"})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, dialogRequest(http.MethodPost, "/dialog/turn", `{}`))

	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"utterance_required"`) {
		t.Fatalf("response = %d %s, want utterance_required", response.Code, response.Body.String())
	}
}

func newDialogTestRouter(t *testing.T, dialog appconfig.DialogConfig) http.Handler {
	t.Helper()
	gin.SetMode(gin.ReleaseMode)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	rootDir := t.TempDir()
	service := NewService(Config{
		Logger:           logger,
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		Pipeline:         postmeeting.NewPipeline(rootDir),
		Dialog:           dialog,
	})
	return httpserver.New("meeting-agent", logger, []string{"*"}, NewHandler(service))
}

func dialogRequest(method string, path string, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set(internalauth.HeaderName, "secret-key")
	request.Header.Set("Content-Type", "application/json")
	return request
}
