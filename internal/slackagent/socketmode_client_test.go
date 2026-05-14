package slackagent

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSlackSocketModeClientOpenConnection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer app-token" {
			t.Fatalf("authorization = %q, want bearer app-token", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"url":"wss://example.com/socket"}`))
	}))
	defer server.Close()

	client := &SlackSocketModeClient{
		appToken: "app-token",
		openURL:  server.URL,
		client:   server.Client(),
	}

	socketURL, err := client.OpenConnection(t.Context())
	if err != nil {
		t.Fatalf("open connection: %v", err)
	}
	if socketURL != "wss://example.com/socket" {
		t.Fatalf("socket url = %q, want wss://example.com/socket", socketURL)
	}
}
