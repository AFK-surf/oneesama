package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestMeetingScannerStatusExplainsDisabledState(t *testing.T) {
	service := NewService(Config{})

	status := service.meetingScannerStatus()

	if status.Enabled || status.Running || status.Configured {
		t.Fatalf("status = %#v, want disabled scanner", status)
	}
	if status.DisabledReason != "disabled" || status.ExternalToolExposed {
		t.Fatalf("status = %#v, want explicit disabled reason and no external tool exposure", status)
	}
}

func TestMeetingScannerFetchesGoogleEventsWithMeetURL(t *testing.T) {
	now := time.Date(2026, 5, 18, 1, 0, 0, 0, time.UTC)
	restore := stubSlackTimeNow(now)
	defer restore()

	calendar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/calendars/primary/events" {
			t.Fatalf("calendar path = %s, want /calendars/primary/events", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer token-calendar" {
			t.Fatalf("authorization = %q, want bearer token", got)
		}
		if r.URL.Query().Get("singleEvents") != "true" || r.URL.Query().Get("orderBy") != "startTime" {
			t.Fatalf("query = %s, want calendar event query", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{
				{
					"id":          "evt-1",
					"summary":     "Weekly sync",
					"htmlLink":    "https://calendar.google.com/event?eid=evt-1",
					"hangoutLink": "https://meet.google.com/abc-defg-hij",
					"start":       map[string]any{"dateTime": now.Add(45 * time.Second).Format(time.RFC3339)},
					"end":         map[string]any{"dateTime": now.Add(30 * time.Minute).Format(time.RFC3339)},
					"attendees": []map[string]any{
						{"displayName": "Peng Xiao", "email": "peng@example.com"},
					},
				},
				{
					"id":      "evt-no-meet",
					"summary": "Calendar hold",
					"start":   map[string]any{"dateTime": now.Add(45 * time.Second).Format(time.RFC3339)},
					"end":     map[string]any{"dateTime": now.Add(30 * time.Minute).Format(time.RFC3339)},
				},
			},
		})
	}))
	defer calendar.Close()

	service := NewService(Config{
		Slack: appconfig.SlackConfig{
			MeetingScanner: appconfig.SlackMeetingScannerConfig{
				Enabled:         true,
				ApprovalChannel: "COPS",
				AccessToken:     "token-calendar",
				APIBaseURL:      calendar.URL,
			},
		},
	})
	events, err := service.fetchMeetingScannerEvents(context.Background(), now, now.Add(2*time.Minute))
	if err != nil {
		t.Fatalf("fetchMeetingScannerEvents: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %#v, want only meet event", events)
	}
	event := events[0]
	if event.ID != "evt-1" || event.MeetURL != "https://meet.google.com/abc-defg-hij" || event.Title != "Weekly sync" {
		t.Fatalf("event = %#v, want parsed meet event", event)
	}
	if len(event.Attendees) != 1 || !strings.Contains(event.Attendees[0], "peng@example.com") {
		t.Fatalf("attendees = %#v, want attendee name/email", event.Attendees)
	}
}

func TestMeetingScannerPostsDedupedApprovalCard(t *testing.T) {
	now := time.Date(2026, 5, 18, 1, 0, 0, 0, time.UTC)
	restore := stubSlackTimeNow(now)
	defer restore()

	calendar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{{
				"id":          "evt-join",
				"summary":     "Design review",
				"htmlLink":    "https://calendar.google.com/event?eid=evt-join",
				"hangoutLink": "https://meet.google.com/yuf-wnes-yqt",
				"start":       map[string]any{"dateTime": now.Add(45 * time.Second).Format(time.RFC3339)},
				"end":         map[string]any{"dateTime": now.Add(30 * time.Minute).Format(time.RFC3339)},
			}},
		})
	}))
	defer calendar.Close()

	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Poster:      poster,
		Slack: appconfig.SlackConfig{
			MeetingScanner: appconfig.SlackMeetingScannerConfig{
				Enabled:         true,
				ApprovalChannel: "COPS",
				AccessToken:     "token-calendar",
				APIBaseURL:      calendar.URL,
				Interval:        time.Minute,
			},
		},
	})

	first, err := service.runMeetingApprovalScannerOnce(context.Background())
	if err != nil {
		t.Fatalf("first scanner tick: %v", err)
	}
	second, err := service.runMeetingApprovalScannerOnce(context.Background())
	if err != nil {
		t.Fatalf("second scanner tick: %v", err)
	}

	if first.Posted != 1 || first.Scanned != 1 {
		t.Fatalf("first = %#v, want one posted approval", first)
	}
	if second.Posted != 0 || second.Skipped != 1 {
		t.Fatalf("second = %#v, want deduped skip", second)
	}
	calls := poster.Calls()
	if len(calls) != 2 {
		t.Fatalf("poster calls = %#v, want anchor + approval card", calls)
	}
	if calls[0].Channel != "COPS" || calls[0].ThreadTS != "" {
		t.Fatalf("anchor post = %#v, want root approval channel message", calls[0])
	}
	if calls[0].DedupKey != "slack-meeting-approval-anchor:evt-join" {
		t.Fatalf("anchor dedup key = %q, want meeting approval anchor contract", calls[0].DedupKey)
	}
	if !strings.Contains(calls[0].Text, "Upcoming meeting: *Design review*") || !strings.Contains(calls[0].Text, "https://meet.google.com/yuf-wnes-yqt") {
		t.Fatalf("anchor text = %q, want meeting approval anchor", calls[0].Text)
	}
	if calls[1].Channel != "COPS" || calls[1].ThreadTS != formatSlackTimestamp(now) {
		t.Fatalf("approval card = %#v, want card in real root message thread", calls[1])
	}
	if !strings.Contains(calls[1].Text, "Join meeting: Design review") || !strings.Contains(calls[1].Text, "https://meet.google.com/yuf-wnes-yqt") {
		t.Fatalf("card text = %q, want join meeting approval", calls[1].Text)
	}
	status, err := service.SlackFollowupStatus(context.Background(), "", 10)
	if err != nil {
		t.Fatalf("SlackFollowupStatus: %v", err)
	}
	if len(status.ThreadRecommendations) != 1 {
		t.Fatalf("recommendations = %#v, want one pending action recommendation", status.ThreadRecommendations)
	}
}

func TestMeetingScannerRefreshesAccessToken(t *testing.T) {
	now := time.Date(2026, 5, 18, 1, 0, 0, 0, time.UTC)
	restore := stubSlackTimeNow(now)
	defer restore()

	var tokenCalled bool
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tokenCalled = true
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse token form: %v", err)
		}
		if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "refresh-me" {
			t.Fatalf("token form = %#v, want refresh token grant", r.Form)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fresh-token"})
	}))
	defer tokenServer.Close()
	calendar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer fresh-token" {
			t.Fatalf("authorization = %q, want refreshed token", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []map[string]any{}})
	}))
	defer calendar.Close()

	service := NewService(Config{
		Slack: appconfig.SlackConfig{
			MeetingScanner: appconfig.SlackMeetingScannerConfig{
				Enabled:         true,
				ApprovalChannel: "COPS",
				RefreshToken:    "refresh-me",
				ClientID:        "client-id",
				ClientSecret:    "client-secret",
				TokenURL:        tokenServer.URL,
				APIBaseURL:      calendar.URL,
			},
		},
	})

	if _, err := service.fetchMeetingScannerEvents(context.Background(), now, now.Add(time.Minute)); err != nil {
		t.Fatalf("fetchMeetingScannerEvents: %v", err)
	}
	if !tokenCalled {
		t.Fatal("token endpoint was not called")
	}
}

func stubSlackTimeNow(now time.Time) func() {
	previous := timeNow
	timeNow = func() time.Time { return now }
	return func() { timeNow = previous }
}
