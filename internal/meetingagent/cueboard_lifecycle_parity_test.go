//go:build cueboardparity

package meetingagent

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"
)

func TestCueboardParityParticipantCountOneMeansEmptyRoom(t *testing.T) {
	t.Parallel()

	state := runtimeJoinState(map[string]any{
		"meetPage": map[string]any{
			"inMeeting":        true,
			"participantCount": 1,
		},
	})
	if state.Reason != "empty_room" {
		t.Fatalf("runtimeJoinState reason = %q, want empty_room for participant_count=1", state.Reason)
	}
}

func TestCueboardParityMeetdEmptyTranscriptSendsFailedResult(t *testing.T) {
	t.Parallel()

	webhooks := make(chan MeetdWebhookPayload, 4)
	webhookURL := meetdWebhookTestServer(t, "secret", webhooks)
	service, router := newMeetdRuntimeTestRouter(t, runtimeMeetRunner{}, webhookURL, "secret")
	now := time.Now().UTC().Truncate(time.Second)
	body := fmt.Sprintf(`{
		"event_id":"runtime-empty-transcript",
		"meet_url":"https://meet.google.com/runtime-empty",
		"title":"Runtime Empty",
		"start_at":%q,
		"end_at":%q,
		"status":"processing"
	}`, now.Format(time.RFC3339), now.Add(time.Hour).Format(time.RFC3339))
	meetingID := createMeetdMeetingForTest(t, router, body)
	meeting, _ := service.GetMeetdMeeting(context.Background(), meetingID)

	service.ProcessMeetdMeetingEnd(context.Background(), *meeting, true)
	waitMeetdWebhook(t, webhooks, "meeting.processing")
	result := waitMeetdWebhook(t, webhooks, "meeting.result")
	if result.Status != "failed" || result.Error != "no transcript captured" {
		t.Fatalf("result payload = %+v, want failed no transcript captured", result)
	}

	updated := performMeetdRequest(router, http.MethodGet, fmt.Sprintf("/meetings/%d", meetingID), "")
	if updated.Code != http.StatusOK {
		t.Fatalf("meeting get status = %d body=%s", updated.Code, updated.Body.String())
	}
}
