package slackagent

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

func TestUploadSlackFileUsesExternalUploadAndReturnsPermalink(t *testing.T) {
	t.Parallel()

	var sawUpload bool
	var completedThread string
	var completedChannel string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/files.getUploadURLExternal":
			if err := r.ParseForm(); err != nil {
				t.Fatalf("parse get upload: %v", err)
			}
			if r.Form.Get("filename") != "transcript.txt" || r.Form.Get("length") == "" {
				t.Fatalf("get upload form = %#v", r.Form)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":         true,
				"file_id":    "F123",
				"upload_url": serverURL(r, "/upload/F123"),
			})
		case "/upload/F123":
			if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
				t.Fatalf("upload content-type = %q", r.Header.Get("Content-Type"))
			}
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Fatalf("parse upload multipart: %v", err)
			}
			file, _, err := r.FormFile("file")
			if err != nil {
				t.Fatalf("upload file missing: %v", err)
			}
			_ = file.Close()
			sawUpload = true
			_, _ = w.Write([]byte(`ok`))
		case "/files.completeUploadExternal":
			if err := r.ParseForm(); err != nil {
				t.Fatalf("parse complete: %v", err)
			}
			completedChannel = r.Form.Get("channel_id")
			completedThread = r.Form.Get("thread_ts")
			if !strings.Contains(r.Form.Get("files"), `"id":"F123"`) {
				t.Fatalf("complete files = %q", r.Form.Get("files"))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "files": []map[string]any{{"id": "F123", "title": "transcript.txt"}}})
		case "/files.info":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "file": map[string]any{"permalink": "https://files.slack.com/F123"}})
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	}))
	defer server.Close()

	path := filepath.Join(t.TempDir(), "transcript.txt")
	if err := os.WriteFile(path, []byte("Peng: hello"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	result := UploadSlackFile(context.Background(), server.Client(), "xoxb-test", server.URL, SlackFileUploadInput{
		Path:     path,
		Filename: "transcript.txt",
		Title:    "transcript.txt",
		Channel:  "C123",
		ThreadTS: "123.456",
	})
	if !result.OK || result.Permalink != "https://files.slack.com/F123" || !sawUpload {
		t.Fatalf("UploadSlackFile() = %#v, sawUpload=%v", result, sawUpload)
	}
	if completedChannel != "C123" || completedThread != "123.456" {
		t.Fatalf("complete channel/thread = %q/%q", completedChannel, completedThread)
	}
}

func serverURL(r *http.Request, path string) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host + path
}
