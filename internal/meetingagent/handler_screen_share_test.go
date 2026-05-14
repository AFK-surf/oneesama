package meetingagent

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/httpserver"
	"github.com/AFK-surf/oneesama/internal/internalauth"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
	"github.com/gin-gonic/gin"
)

func TestScreenShareRoutesProxyToMeetRunner(t *testing.T) {
	t.Parallel()

	router := newScreenShareTestRouter(t, t.TempDir())
	join := screenShareRequest(http.MethodPost, "/join/google-meet", `{"session_id":"session_screen","meeting_url":"https://meet.google.com/abc-defg-hij","dry_run":true}`)
	joinResponse := httptest.NewRecorder()
	router.ServeHTTP(joinResponse, join)
	if joinResponse.Code != http.StatusOK {
		t.Fatalf("join = %d %s, want 200", joinResponse.Code, joinResponse.Body.String())
	}

	start := screenShareRequest(http.MethodPost, "/screen-share/start", `{"title":"Deck","subtitle":"Demo","mode":"synthetic","preview":true}`)
	startResponse := httptest.NewRecorder()
	router.ServeHTTP(startResponse, start)
	if startResponse.Code != http.StatusOK || !strings.Contains(startResponse.Body.String(), `"title":"Deck"`) {
		t.Fatalf("start = %d %s, want proxied start", startResponse.Code, startResponse.Body.String())
	}

	stop := screenShareRequest(http.MethodPost, "/screen-share/stop", `{}`)
	stopResponse := httptest.NewRecorder()
	router.ServeHTTP(stopResponse, stop)
	if stopResponse.Code != http.StatusOK || !strings.Contains(stopResponse.Body.String(), `"stopped":true`) {
		t.Fatalf("stop = %d %s, want proxied stop", stopResponse.Code, stopResponse.Body.String())
	}
}

func TestScreenShareVideoLocalPathBecomesStageMediaURL(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	videoPath := filepath.Join(rootDir, "clip.mp4")
	if err := os.WriteFile(videoPath, []byte("fake video"), 0o600); err != nil {
		t.Fatalf("write video: %v", err)
	}
	router := newScreenShareTestRouter(t, rootDir)
	join := screenShareRequest(http.MethodPost, "/join/google-meet", `{"session_id":"session_video","meeting_url":"https://meet.google.com/abc-defg-hij","dry_run":true}`)
	router.ServeHTTP(httptest.NewRecorder(), join)

	body := `{"path":` + strconv.Quote(videoPath) + `,"title":"Clip","muted":false}`
	response := httptest.NewRecorder()
	request := screenShareRequest(http.MethodPost, "/screen-share/video", body)
	request.Host = "127.0.0.1:8781"
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `/stage-media/video?path=`) {
		t.Fatalf("video = %d %s, want stage-media URL", response.Code, response.Body.String())
	}
}

func TestStageMediaVideoServesAllowedFile(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	videoPath := filepath.Join(rootDir, "clip.webm")
	if err := os.WriteFile(videoPath, []byte("fake video"), 0o600); err != nil {
		t.Fatalf("write video: %v", err)
	}
	router := newScreenShareTestRouter(t, rootDir)
	request := httptest.NewRequest(http.MethodGet, "/stage-media/video?path="+url.QueryEscape(videoPath), nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "video/webm" || response.Body.String() != "fake video" {
		t.Fatalf("stage media = %d %q %q", response.Code, response.Header().Get("Content-Type"), response.Body.String())
	}
}

func newScreenShareTestRouter(t *testing.T, rootDir string) http.Handler {
	t.Helper()
	gin.SetMode(gin.ReleaseMode)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service := NewService(Config{
		Logger:           logger,
		Persistence:      appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir: rootDir,
		InternalAuthKey:  "secret-key",
		MeetRunner:       fakeMeetRunner{},
	})
	return httpserver.New("meeting-agent", logger, []string{"*"}, NewHandler(service))
}

func screenShareRequest(method string, path string, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set(internalauth.HeaderName, "secret-key")
	request.Header.Set("Content-Type", "application/json")
	return request
}
