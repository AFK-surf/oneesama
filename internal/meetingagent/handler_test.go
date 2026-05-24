package meetingagent

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/httpserver"
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
	response := performMeetingRequest(router, http.MethodPost, "/meetings/post-process", body)
	if response.Code != http.StatusOK {
		t.Fatalf("post-process status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"artifact_test"`) {
		t.Fatalf("body = %s, want artifact id", response.Body.String())
	}

	listResponse := performMeetingRequest(router, http.MethodGet, "/meetings/artifacts", "")
	if listResponse.Code != http.StatusOK || !strings.Contains(listResponse.Body.String(), `"artifact_test"`) {
		t.Fatalf("list body = %s, want artifact_test", listResponse.Body.String())
	}

	chatResponse := performMeetingRequest(router, http.MethodGet, "/meetings/artifact/chat?id=artifact_test", "")
	if chatResponse.Code != http.StatusOK || !strings.Contains(chatResponse.Body.String(), `https://example.com/spec`) {
		t.Fatalf("chat body = %s, want spec link", chatResponse.Body.String())
	}
}

func TestHandlePostProcessAcceptsLegacyCamelCase(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)

	body := `{
	  "artifactId": "legacy_handler_artifact",
	  "meetingId": "meet_legacy",
	  "sessionId": "session_legacy",
	  "transcriptText": "Peng: Decision: keep camelCase clients working.",
	  "chatMessages": [
	    {"sender":"Peng","text":"Legacy chat https://example.com/legacy"}
	  ],
	  "skipAsr": true
	}`
	response := performMeetingRequest(router, http.MethodPost, "/meetings/post-process", body)
	if response.Code != http.StatusOK {
		t.Fatalf("post-process status = %d body=%s, want 200", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"legacy_handler_artifact"`) ||
		!strings.Contains(response.Body.String(), `meet_legacy`) ||
		!strings.Contains(response.Body.String(), `Legacy chat`) {
		t.Fatalf("body = %s, want camelCase fields preserved", response.Body.String())
	}
}

func TestHandleArtifactRejectsUnsafeID(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)

	postResponse := performMeetingRequest(router, http.MethodPost, "/meetings/post-process", `{
	  "artifact_id": "../escape",
	  "text": "unsafe"
	}`)
	if postResponse.Code != http.StatusBadRequest {
		t.Fatalf("post-process status = %d body=%s, want 400", postResponse.Code, postResponse.Body.String())
	}

	getResponse := performMeetingRequest(router, http.MethodGet, "/meetings/artifact?id=../escape", "")
	if getResponse.Code != http.StatusBadRequest {
		t.Fatalf("get artifact status = %d body=%s, want 400", getResponse.Code, getResponse.Body.String())
	}

	chatResponse := performMeetingRequest(router, http.MethodGet, "/meetings/artifact/chat?id=../escape", "")
	if chatResponse.Code != http.StatusBadRequest {
		t.Fatalf("get artifact chat status = %d body=%s, want 400", chatResponse.Code, chatResponse.Body.String())
	}
}

func TestHandlePostProcessIgnoresRootDirOverride(t *testing.T) {
	t.Parallel()

	router, configuredRoot := newTestRouterWithRootDir(t)
	overrideRoot := t.TempDir()

	body := `{
	  "artifact_id": "root_override_guard",
	  "rootDir": ` + quoteJSONString(t, overrideRoot) + `,
	  "transcriptText": "Peng: external root overrides should be ignored."
	}`
	response := performMeetingRequest(router, http.MethodPost, "/meetings/post-process", body)
	if response.Code != http.StatusOK {
		t.Fatalf("post-process status = %d body=%s, want 200", response.Code, response.Body.String())
	}
	configuredManifest := filepath.Join(configuredRoot, "root_override_guard", "manifest.json")
	if _, err := os.Stat(configuredManifest); err != nil {
		t.Fatalf("configured manifest stat error = %v, want artifact in configured root", err)
	}
	overrideManifest := filepath.Join(overrideRoot, "root_override_guard", "manifest.json")
	if _, err := os.Stat(overrideManifest); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("override manifest stat error = %v, want no artifact in request root", err)
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
	response := performMeetingRequest(router, http.MethodPost, "/meetings/digest-webhook", body)
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
	response := performMeetingRequest(router, http.MethodGet, "/meetings/status", "")
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
	router, _ := newTestRouterWithRootDir(t)
	return router
}

func newTestRouterWithRootDir(t *testing.T) (http.Handler, string) {
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
	return httpserver.New("meeting-agent", logger, []string{"*"}, handler), rootDir
}
