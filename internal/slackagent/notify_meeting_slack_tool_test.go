package slackagent

import (
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

// Tests pin the safety contract:
//   - meeting_id is required; no meeting_id → tool refuses to post
//   - the channel + thread come from MeetingThreadRecord, not from
//     model-supplied args
//   - model-supplied channel / thread MUST match the stored record
//     if present (mismatch → refuse, do not silently overwrite)
//   - missing thread record → refuse with `meeting_thread_lookup_missing`
//   - empty text → refuse
//   - happy path: posts to the stored channel/thread regardless of
//     what the model said about channel/thread (since the args were
//     either absent or matched)

func newNotifyMeetingSlackTestService(t *testing.T) *Service {
	t.Helper()
	dir := t.TempDir()
	store := newMeetingWebhookStore(appconfig.PersistenceConfig{
		Provider: "json-file",
		DataDir:  filepath.Join(dir, "state"),
	}, slog.New(slog.NewTextHandler(testDiscardWriter{}, nil)))
	if store == nil {
		t.Fatalf("meeting webhook store init failed")
	}
	return &Service{
		logger:          slog.New(slog.NewTextHandler(testDiscardWriter{}, nil)),
		meetingWebhooks: store,
		poster:          &fakeNotifyMeetingSlackPoster{},
	}
}

type fakeNotifyMeetingSlackPoster struct {
	lastInput PostMessageInput
}

func (f *fakeNotifyMeetingSlackPoster) PostMessage(_ context.Context, input PostMessageInput) PostMessageResult {
	f.lastInput = input
	return PostMessageResult{OK: true, TS: "1779099999.000"}
}

func seedMeetingThread(t *testing.T, s *Service, meetingID int64, channel, thread string) {
	t.Helper()
	payload := NormalizedMeetingWebhookPayload{MeetingID: meetingID}
	if _, err := s.meetingWebhooks.InsertThread(context.Background(), payload, MeetingSlackRef{ChannelID: channel, ThreadTS: thread}, ""); err != nil {
		t.Fatalf("InsertThread: %v", err)
	}
}

func TestNotifyMeetingSlackRejectsWithoutMeetingID(t *testing.T) {
	s := newNotifyMeetingSlackTestService(t)
	resp := s.executeNotifyMeetingSlackTool(context.Background(), map[string]any{
		"channel":   "C_HALLUCINATED",
		"thread_ts": "999.000",
		"text":      "model trying to ping a random channel",
	})
	if resp.OK {
		t.Fatalf("expected refuse when meeting_id missing, got OK: %+v", resp)
	}
	if !strings.Contains(resp.Error, "missing_meeting_id") {
		t.Errorf("error = %q, want missing_meeting_id", resp.Error)
	}
}

func TestNotifyMeetingSlackRejectsWithoutText(t *testing.T) {
	s := newNotifyMeetingSlackTestService(t)
	resp := s.executeNotifyMeetingSlackTool(context.Background(), map[string]any{
		"meeting_id": int64(42),
		"text":       "   ",
	})
	if resp.OK {
		t.Fatalf("expected refuse on empty text, got OK: %+v", resp)
	}
	if !strings.Contains(resp.Error, notifyMeetingSlackMissingTextReason) {
		t.Errorf("error = %q, want missing_message_text", resp.Error)
	}
}

func TestNotifyMeetingSlackRejectsWhenMeetingHasNoThread(t *testing.T) {
	s := newNotifyMeetingSlackTestService(t)
	// No thread record seeded for meeting 99.
	resp := s.executeNotifyMeetingSlackTool(context.Background(), map[string]any{
		"meeting_id": int64(99),
		"text":       "post anywhere please",
	})
	if resp.OK {
		t.Fatal("expected refuse when meeting has no thread record")
	}
	if !strings.Contains(resp.Error, notifyMeetingSlackMissingThreadReason) {
		t.Errorf("error = %q, want meeting_thread_lookup_missing", resp.Error)
	}
}

func TestNotifyMeetingSlackUsesStoredThreadIgnoringModelArgs(t *testing.T) {
	s := newNotifyMeetingSlackTestService(t)
	seedMeetingThread(t, s, 42, "C_REAL", "100.000")
	// Model provides NO channel/thread; tool resolves from store.
	resp := s.executeNotifyMeetingSlackTool(context.Background(), map[string]any{
		"meeting_id": int64(42),
		"text":       "Meeting summary ready",
	})
	if !resp.OK {
		t.Fatalf("expected OK, got %+v", resp)
	}
	poster := s.poster.(*fakeNotifyMeetingSlackPoster)
	if poster.lastInput.Channel != "C_REAL" {
		t.Errorf("posted Channel = %q, want C_REAL (from stored record)", poster.lastInput.Channel)
	}
	if poster.lastInput.ThreadTS != "100.000" {
		t.Errorf("posted ThreadTS = %q, want 100.000 (from stored record)", poster.lastInput.ThreadTS)
	}
}

func TestNotifyMeetingSlackAcceptsMatchingModelConfirmation(t *testing.T) {
	s := newNotifyMeetingSlackTestService(t)
	seedMeetingThread(t, s, 42, "C_REAL", "100.000")
	// Model confirms the stored values — must succeed.
	resp := s.executeNotifyMeetingSlackTool(context.Background(), map[string]any{
		"meeting_id": int64(42),
		"channel":    "C_REAL",
		"thread_ts":  "100.000",
		"text":       "Meeting summary ready",
	})
	if !resp.OK {
		t.Fatalf("expected OK with matching args, got %+v", resp)
	}
}

func TestNotifyMeetingSlackRejectsHallucinatedChannel(t *testing.T) {
	s := newNotifyMeetingSlackTestService(t)
	seedMeetingThread(t, s, 42, "C_REAL", "100.000")
	resp := s.executeNotifyMeetingSlackTool(context.Background(), map[string]any{
		"meeting_id": int64(42),
		"channel":    "C_HALLUCINATED",
		"text":       "wrong channel; tool should refuse not redirect",
	})
	if resp.OK {
		t.Fatal("expected refuse on channel mismatch")
	}
	if !strings.Contains(resp.Error, "target_mismatch:channel") {
		t.Errorf("error = %q, want target_mismatch:channel", resp.Error)
	}
}

func TestNotifyMeetingSlackRejectsHallucinatedThread(t *testing.T) {
	s := newNotifyMeetingSlackTestService(t)
	seedMeetingThread(t, s, 42, "C_REAL", "100.000")
	resp := s.executeNotifyMeetingSlackTool(context.Background(), map[string]any{
		"meeting_id": int64(42),
		"thread_ts":  "999.999",
		"text":       "wrong thread",
	})
	if resp.OK {
		t.Fatal("expected refuse on thread_ts mismatch")
	}
	if !strings.Contains(resp.Error, "target_mismatch:thread") {
		t.Errorf("error = %q, want target_mismatch:thread", resp.Error)
	}
}

// String-encoded meeting_id (model sometimes emits "42" instead of 42)
// must still resolve. This pins int64FromAny's string handling.
func TestNotifyMeetingSlackAcceptsStringEncodedMeetingID(t *testing.T) {
	s := newNotifyMeetingSlackTestService(t)
	seedMeetingThread(t, s, 42, "C_REAL", "100.000")
	resp := s.executeNotifyMeetingSlackTool(context.Background(), map[string]any{
		"meeting_id": "42",
		"text":       "Meeting summary ready",
	})
	if !resp.OK {
		t.Fatalf("expected OK with string meeting_id, got %+v", resp)
	}
}

// Camel-case alias (`meetingId`) must also work — Slack-style and
// JS-style emitters both call the tool.
func TestNotifyMeetingSlackAcceptsCamelCaseAlias(t *testing.T) {
	s := newNotifyMeetingSlackTestService(t)
	seedMeetingThread(t, s, 42, "C_REAL", "100.000")
	resp := s.executeNotifyMeetingSlackTool(context.Background(), map[string]any{
		"meetingId": int64(42),
		"text":      "Meeting summary ready",
	})
	if !resp.OK {
		t.Fatalf("expected OK with camelCase meetingId, got %+v", resp)
	}
}
