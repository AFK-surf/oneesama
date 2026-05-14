package meetingagent

import (
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

func TestHandlePostProcessAndArtifactReads(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)

	body := `{
	  "artifact_id": "artifact_test",
	  "title": "Weekly Sync",
	  "captions": [
	    {"speaker":"Peng","text":"Decision: keep the rewrite incremental."},
	    {"speaker":"Miao","text":"Action item: send the digest webhook."}
	  ],
	  "chat_messages": [
	    {"sender":"Peng","text":"Spec https://example.com/spec"}
	  ]
	}`
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/meetings/post-process", strings.NewReader(body))
	request.Header.Set(internalauth.HeaderName, "secret-key")
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("post-process status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"artifact_test"`) {
		t.Fatalf("body = %s, want artifact id", response.Body.String())
	}

	listResponse := httptest.NewRecorder()
	listRequest := httptest.NewRequest(http.MethodGet, "/meetings/artifacts", nil)
	listRequest.Header.Set(internalauth.HeaderName, "secret-key")
	router.ServeHTTP(listResponse, listRequest)
	if listResponse.Code != http.StatusOK || !strings.Contains(listResponse.Body.String(), `"artifact_test"`) {
		t.Fatalf("list body = %s, want artifact_test", listResponse.Body.String())
	}

	chatResponse := httptest.NewRecorder()
	chatRequest := httptest.NewRequest(http.MethodGet, "/meetings/artifact/chat?id=artifact_test", nil)
	chatRequest.Header.Set(internalauth.HeaderName, "secret-key")
	router.ServeHTTP(chatResponse, chatRequest)
	if chatResponse.Code != http.StatusOK || !strings.Contains(chatResponse.Body.String(), `https://example.com/spec`) {
		t.Fatalf("chat body = %s, want spec link", chatResponse.Body.String())
	}
}

func TestHandleDigestWebhook(t *testing.T) {
	t.Parallel()

	attempts := 0
	webhook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if r.Header.Get("X-Webhook-Signature") == "" {
			http.Error(w, "missing signature", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer webhook.Close()

	router := newTestRouter(t)
	body := `{"url":"` + webhook.URL + `","payload":{"event":"meeting.digest","summary":"hello"}}`
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/meetings/digest-webhook", strings.NewReader(body))
	request.Header.Set(internalauth.HeaderName, "secret-key")
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("digest status = %d, want 200", response.Code)
	}
	if attempts != 1 {
		t.Fatalf("attempts = %d, want 1", attempts)
	}
	if !strings.Contains(response.Body.String(), `"ok":true`) {
		t.Fatalf("body = %s, want ok=true", response.Body.String())
	}
}

func TestHandleStatusIncludesArtifactsRoot(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/meetings/status", nil)
	request.Header.Set(internalauth.HeaderName, "secret-key")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"root_dir"`) {
		t.Fatalf("body = %s, want artifacts root", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"internal_auth_configured":true`) {
		t.Fatalf("body = %s, want internal auth state", response.Body.String())
	}
}

func newTestRouter(t *testing.T) http.Handler {
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
	})
	handler := NewHandler(service)
	return httpserver.New("meeting-agent", logger, []string{"*"}, handler)
}
