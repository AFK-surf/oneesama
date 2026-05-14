package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/httpserver"
	"github.com/AFK-surf/oneesama/internal/internalauth"
	"github.com/AFK-surf/oneesama/internal/slackagent"
)

func newListener(t *testing.T) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	return listener
}

func serveManagedServer(t *testing.T, managed *httpserver.ManagedServer, listener net.Listener) string {
	t.Helper()
	errCh := make(chan error, 1)
	go func() {
		if err := managed.Server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = managed.Server.Shutdown(ctx)
		if managed.Shutdown != nil {
			_ = managed.Shutdown(ctx)
		}
		select {
		case err := <-errCh:
			if err != nil {
				t.Errorf("serve %s: %v", listener.Addr().String(), err)
			}
		case <-time.After(5 * time.Second):
			t.Errorf("timed out waiting for server shutdown: %s", listener.Addr().String())
		}
	})
	return "http://" + listener.Addr().String()
}

func postJSON(t *testing.T, url string, body string, headers map[string]string) *http.Response {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, url, bytes.NewBufferString(body))
	if err != nil {
		t.Fatalf("build json request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	return doRequest(t, request)
}

func postSignedForm(t *testing.T, url string, secret string, body string) *http.Response {
	t.Helper()
	timestampString := strconv.FormatInt(time.Now().UTC().Unix(), 10)
	signature := slackagent.SignSlackRequestBody(secret, timestampString, body)
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, url, bytes.NewBufferString(body))
	if err != nil {
		t.Fatalf("build form request: %v", err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("X-Slack-Request-Timestamp", timestampString)
	request.Header.Set("X-Slack-Signature", signature)
	return doRequest(t, request)
}

func get(t *testing.T, url string, headers map[string]string) *http.Response {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("build get request: %v", err)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	return doRequest(t, request)
}

func doRequest(t *testing.T, request *http.Request) *http.Response {
	t.Helper()
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
	if err != nil {
		t.Fatalf("do request %s %s: %v", request.Method, request.URL.String(), err)
	}
	t.Cleanup(func() {
		_ = response.Body.Close()
	})
	return response
}

func decodeJSON(t *testing.T, response *http.Response, target any) {
	t.Helper()
	body := readBody(t, response)
	if err := json.Unmarshal(body, target); err != nil {
		t.Fatalf("decode json %s: %v", body, err)
	}
}

func readBody(t *testing.T, response *http.Response) []byte {
	t.Helper()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return body
}

func repoPath(t *testing.T, relative string) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve integration test filename")
	}
	return filepath.Join(filepath.Dir(filename), "..", "..", relative)
}

func packagePath(t *testing.T, relative string) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve integration test filename")
	}
	return filepath.Join(filepath.Dir(filename), relative)
}

func requireMeetRunnerRuntime(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}
	if _, err := os.Stat(repoPath(t, filepath.Join("node_modules", "typescript", "package.json"))); err != nil {
		t.Skip("meet-runner JS deps missing; run npm install")
	}
}

func waitForCanvasPublished(t *testing.T, slackBaseURL string, needles ...string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	var body []byte
	for time.Now().Before(deadline) {
		response := get(t, slackBaseURL+"/canvas/published", map[string]string{
			internalauth.HeaderName: "integration-key",
		})
		if response.StatusCode != http.StatusOK {
			t.Fatalf("canvas status = %d, want 200", response.StatusCode)
		}
		body = readBody(t, response)
		matched := true
		for _, needle := range needles {
			if !bytes.Contains(body, []byte(needle)) {
				matched = false
				break
			}
		}
		if matched {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("canvas body = %s, want %v", body, needles)
}
