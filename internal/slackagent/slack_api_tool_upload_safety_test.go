package slackagent

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// recordingTransport records every outbound request body so tests can confirm
// the upload path that reached the Slack API after the workspace resolver ran.
type recordingTransport struct {
	mu       sync.Mutex
	requests []recordedRequest
	server   http.RoundTripper
}

type recordedRequest struct {
	URL      string
	BodyText string
	Headers  http.Header
}

func (rt *recordingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	var bodyText string
	if req.Body != nil {
		raw, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		_ = req.Body.Close()
		bodyText = string(raw)
		req.Body = io.NopCloser(bytes.NewReader(raw))
	}
	rt.requests = append(rt.requests, recordedRequest{
		URL:      req.URL.String(),
		BodyText: bodyText,
		Headers:  req.Header.Clone(),
	})
	return rt.server.RoundTrip(req)
}

func newSlackUploadStubServer(t *testing.T) (apiBase string, transport http.RoundTripper, uploadedBytes *[]byte) {
	t.Helper()
	uploaded := []byte{}
	var uploadedMu sync.Mutex
	uploadHost := "https://files.slack.example/upload"
	getUploadURL := ""
	mux := http.NewServeMux()
	mux.HandleFunc("/files.getUploadURLExternal", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":         true,
			"upload_url": getUploadURL,
			"file_id":    "F12345",
		})
	})
	mux.HandleFunc("/files.completeUploadExternal", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true,
			"files": []map[string]any{{
				"id":        "F12345",
				"title":     "uploaded",
				"name":      "uploaded.bin",
				"permalink": "https://slack.example/permalink/F12345",
			}},
		})
	})
	mux.HandleFunc("/files.info", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true,
			"file": map[string]any{
				"id":        "F12345",
				"permalink": "https://slack.example/permalink/F12345",
			},
		})
	})

	stub := &uploadStubServer{
		mux:        mux,
		uploadHost: uploadHost,
		uploaded:   &uploaded,
		uploadedMu: &uploadedMu,
	}
	getUploadURL = uploadHost
	return "https://slack.example", stub, &uploaded
}

type uploadStubServer struct {
	mux        *http.ServeMux
	uploadHost string
	uploaded   *[]byte
	uploadedMu *sync.Mutex
}

func (s *uploadStubServer) RoundTrip(req *http.Request) (*http.Response, error) {
	if strings.HasPrefix(req.URL.String(), s.uploadHost) {
		if req.Body != nil {
			raw, err := io.ReadAll(req.Body)
			if err != nil {
				return nil, err
			}
			_ = req.Body.Close()
			s.uploadedMu.Lock()
			*s.uploaded = append((*s.uploaded)[:0], raw...)
			s.uploadedMu.Unlock()
		}
		return &http.Response{
			StatusCode: 200,
			Status:     "200 OK",
			Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Request:    req,
		}, nil
	}
	rec := &recordResponseWriter{header: http.Header{}, body: &bytes.Buffer{}}
	s.mux.ServeHTTP(rec, req)
	if rec.code == 0 {
		rec.code = 200
	}
	return &http.Response{
		StatusCode: rec.code,
		Status:     http.StatusText(rec.code),
		Body:       io.NopCloser(rec.body),
		Header:     rec.header,
		Request:    req,
	}, nil
}

type recordResponseWriter struct {
	header http.Header
	body   *bytes.Buffer
	code   int
}

func (w *recordResponseWriter) Header() http.Header { return w.header }
func (w *recordResponseWriter) Write(p []byte) (int, error) {
	return w.body.Write(p)
}
func (w *recordResponseWriter) WriteHeader(statusCode int) { w.code = statusCode }

// TestSlackAPIToolUploadFileRoutesThroughWorkspaceResolverForWorkspaceFile
// confirms a file inside the configured workspace uploads successfully and the
// resolver-passed path is exactly what UploadSlackFile reads off disk.
func TestSlackAPIToolUploadFileRoutesThroughWorkspaceResolverForWorkspaceFile(t *testing.T) {
	workspaceDir := t.TempDir()
	filePath := filepath.Join(workspaceDir, "artifacts", "result.txt")
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := []byte("hello-from-workspace")
	if err := os.WriteFile(filePath, body, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	apiBase, transport, uploaded := newSlackUploadStubServer(t)
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        apiBase,
		token:         "xoxb-test",
		workspaceDir:  workspaceDir,
		httpTransport: transport,
	}

	result := tool.actionUploadFile(context.Background(), map[string]any{
		"path":    filePath,
		"channel": "C123",
	})
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Text)
	}
	if !strings.Contains(result.Text, "File uploaded:") {
		t.Fatalf("expected upload confirmation, got %q", result.Text)
	}
	if !bytes.Contains(*uploaded, body) {
		t.Fatalf("uploaded payload missing original body bytes: %q", string(*uploaded))
	}
}

// TestSlackAPIToolUploadFileRejectsOutsideWorkspaceAbsolutePath asserts that
// an absolute path outside the workspace (and outside the temp staging dirs)
// is blocked by the resolver before any HTTP traffic is generated.
func TestSlackAPIToolUploadFileRejectsOutsideWorkspaceAbsolutePath(t *testing.T) {
	baseDir := t.TempDir()
	workspaceDir := filepath.Join(baseDir, "workspace")
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}
	outside := filepath.Join(baseDir, "outside.txt")
	if err := os.WriteFile(outside, []byte("nope"), 0o644); err != nil {
		t.Fatalf("write outside: %v", err)
	}

	apiBase, transport, _ := newSlackUploadStubServer(t)
	rec := &recordingTransport{server: transport}
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        apiBase,
		token:         "xoxb-test",
		workspaceDir:  workspaceDir,
		httpTransport: rec,
	}

	result := tool.actionUploadFile(context.Background(), map[string]any{
		"path":    outside,
		"channel": "C123",
	})
	if result.Success {
		t.Fatalf("expected rejection, got success: %q", result.Text)
	}
	if !strings.Contains(result.Text, "Slack-triggered file uploads must stay within the Slack agent workspace") {
		t.Fatalf("expected workspace-boundary error, got %q", result.Text)
	}
	if len(rec.requests) != 0 {
		t.Fatalf("expected zero HTTP calls for rejected path, got %d (%+v)", len(rec.requests), rec.requests)
	}
}

// TestSlackAPIToolUploadFileStagesTmpPathThroughWorkspaceStagingDir checks that
// uploads from /tmp are auto-staged into the workspace staging dir and the
// uploaded bytes still match the original temp artifact.
func TestSlackAPIToolUploadFileStagesTmpPathThroughWorkspaceStagingDir(t *testing.T) {
	workspaceDir := filepath.Join(t.TempDir(), "workspace")
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	tmpFile, err := os.CreateTemp("/tmp", "oneesama-upload-*.bin")
	if err != nil {
		t.Fatalf("create temp: %v", err)
	}
	tmpPath := tmpFile.Name()
	t.Cleanup(func() { _ = os.Remove(tmpPath) })
	body := []byte("staged-bytes")
	if _, err := tmpFile.Write(body); err != nil {
		t.Fatalf("write temp: %v", err)
	}
	if err := tmpFile.Close(); err != nil {
		t.Fatalf("close temp: %v", err)
	}

	apiBase, transport, uploaded := newSlackUploadStubServer(t)
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        apiBase,
		token:         "xoxb-test",
		workspaceDir:  workspaceDir,
		httpTransport: transport,
	}

	result := tool.actionUploadFile(context.Background(), map[string]any{
		"path":    tmpPath,
		"channel": "C123",
	})
	if !result.Success {
		t.Fatalf("expected staged upload to succeed, got %q", result.Text)
	}
	if !bytes.Contains(*uploaded, body) {
		t.Fatalf("uploaded payload missing staged body bytes: %q", string(*uploaded))
	}
	stagingRoot := filepath.Join(workspaceDir, ".tmp", "slack-upload-staging")
	entries, err := os.ReadDir(stagingRoot)
	if err != nil {
		t.Fatalf("read staging dir: %v", err)
	}
	if len(entries) == 0 {
		t.Fatalf("expected at least one staged artifact under %q", stagingRoot)
	}
}

// TestSlackAPIToolUploadFileMissingPathReturnsActionableError keeps the
// "path is required" contract stable for clients that omit the parameter.
func TestSlackAPIToolUploadFileMissingPathReturnsActionableError(t *testing.T) {
	workspaceDir := t.TempDir()
	apiBase, transport, _ := newSlackUploadStubServer(t)
	rec := &recordingTransport{server: transport}
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        apiBase,
		token:         "xoxb-test",
		workspaceDir:  workspaceDir,
		httpTransport: rec,
	}

	result := tool.actionUploadFile(context.Background(), map[string]any{
		"channel": "C123",
	})
	if result.Success {
		t.Fatalf("expected failure for missing path, got success: %q", result.Text)
	}
	if !strings.Contains(strings.ToLower(result.Text), "path is required") {
		t.Fatalf("expected 'path is required' guidance, got %q", result.Text)
	}
	if len(rec.requests) != 0 {
		t.Fatalf("expected zero HTTP calls for missing path, got %d", len(rec.requests))
	}
}
