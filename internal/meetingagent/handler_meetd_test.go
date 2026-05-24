package meetingagent

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestMeetdCreateGetListAndCancelMeeting(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	start := time.Now().UTC().Truncate(time.Second)
	body := fmt.Sprintf(`{"event_id":"test-event","meet_url":"https://meet.google.com/test","title":"Test Meeting","start_at":%q,"end_at":%q}`, start.Format(time.RFC3339), start.Add(time.Hour).Format(time.RFC3339))

	createResponse := performMeetingRequest(router, http.MethodPost, "/meetings", body)
	if createResponse.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", createResponse.Code, createResponse.Body.String())
	}
	var createBody struct {
		MeetingID int64 `json:"meeting_id"`
	}
	if err := json.Unmarshal(createResponse.Body.Bytes(), &createBody); err != nil {
		t.Fatalf("decode create body: %v", err)
	}
	if createBody.MeetingID == 0 {
		t.Fatal("meeting_id = 0, want non-zero")
	}

	getResponse := performMeetingRequest(router, http.MethodGet, fmt.Sprintf("/meetings/%d", createBody.MeetingID), "")
	if getResponse.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", getResponse.Code, getResponse.Body.String())
	}
	if !strings.Contains(getResponse.Body.String(), `"title":"Test Meeting"`) || !strings.Contains(getResponse.Body.String(), `"status":"pending"`) {
		t.Fatalf("get body = %s, want title and pending status", getResponse.Body.String())
	}

	listResponse := performMeetingRequest(router, http.MethodGet, "/meetings?status=pending", "")
	if listResponse.Code != http.StatusOK || !strings.Contains(listResponse.Body.String(), `"meetings"`) || !strings.Contains(listResponse.Body.String(), `"test-event"`) {
		t.Fatalf("list body = %s, want test-event", listResponse.Body.String())
	}

	cancelResponse := performMeetingRequest(router, http.MethodPost, fmt.Sprintf("/meetings/%d/cancel", createBody.MeetingID), "")
	if cancelResponse.Code != http.StatusOK || !strings.Contains(cancelResponse.Body.String(), `"status":"cancelled"`) {
		t.Fatalf("cancel body = %s, want cancelled", cancelResponse.Body.String())
	}

	conflictResponse := performMeetingRequest(router, http.MethodPost, fmt.Sprintf("/meetings/%d/cancel", createBody.MeetingID), "")
	if conflictResponse.Code != http.StatusConflict {
		t.Fatalf("conflict status = %d, want 409", conflictResponse.Code)
	}
	if strings.TrimSpace(conflictResponse.Body.String()) != `{"error":"cannot cancel meeting in \"cancelled\" state"}` {
		t.Fatalf("conflict body = %s, want cueboard conflict error", conflictResponse.Body.String())
	}
}

func TestMeetdCreateRejectsArtifactsDirOutsideRoot(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	start := time.Now().UTC().Truncate(time.Second)
	outsideDir := t.TempDir()
	body := fmt.Sprintf(`{
		"event_id":"outside-artifacts",
		"meet_url":"https://meet.google.com/test",
		"title":"Outside Artifacts",
		"start_at":%q,
		"end_at":%q,
		"artifacts_dir":%s
	}`, start.Format(time.RFC3339), start.Add(time.Hour).Format(time.RFC3339), quoteJSONString(t, outsideDir))

	createResponse := performMeetingRequest(router, http.MethodPost, "/meetings", body)
	if createResponse.Code != http.StatusBadRequest {
		t.Fatalf("create status = %d body=%s, want 400", createResponse.Code, createResponse.Body.String())
	}
}

func TestMeetdCreateIsIdempotentByEventID(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	start := time.Now().UTC().Truncate(time.Second)
	body := fmt.Sprintf(`{"event_id":"idempotent-event","meet_url":"https://meet.google.com/same","title":"Same Meeting","start_at":%q,"end_at":%q}`, start.Format(time.RFC3339), start.Add(time.Hour).Format(time.RFC3339))
	firstID := createMeetdMeetingForTest(t, router, body)
	secondID := createMeetdMeetingForTest(t, router, body)
	if firstID != secondID {
		t.Fatalf("idempotent create first=%d second=%d, want same id", firstID, secondID)
	}
}

func TestMeetdCreateValidationErrorsMatchCueboard(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	for _, tc := range []struct {
		name string
		body string
		want string
	}{
		{
			name: "missing meet URL and event ID",
			body: `{"title":"Missing URL"}`,
			want: `{"error":"meet_url or event_id is required"}`,
		},
		{
			name: "missing time range",
			body: `{"event_id":"missing-time","meet_url":"https://meet.google.com/missing-time","title":"Missing Time"}`,
			want: `{"error":"start_at and end_at are required"}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := performMeetingRequest(router, http.MethodPost, "/meetings", tc.body)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", response.Code)
			}
			if strings.TrimSpace(response.Body.String()) != tc.want {
				t.Fatalf("body = %s, want %s", response.Body.String(), tc.want)
			}
		})
	}
}

func TestMeetdGetMissingMeetingMatchesCueboard(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	response := performMeetingRequest(router, http.MethodGet, "/meetings/999", "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}
	if strings.TrimSpace(response.Body.String()) != `{"error":"meeting not found"}` {
		t.Fatalf("body = %s, want cueboard missing meeting error", response.Body.String())
	}
}

func TestMeetdCaptionsMatchCueboardShape(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	start := time.Now().UTC().Truncate(time.Second)
	body := fmt.Sprintf(`{
		"event_id":"caption-event",
		"meet_url":"https://meet.google.com/caption",
		"title":"Caption Meeting",
		"start_at":%q,
		"end_at":%q,
		"captions":[
			{"speaker":"Operator","text":"live first","timestamp":%q,"source":"live_caption"},
			{"speaker":"ASR","text":"asr second","timestamp":%q,"source":"asr"}
		]
	}`, start.Format(time.RFC3339), start.Add(time.Hour).Format(time.RFC3339), start.Add(10*time.Second).Format(time.RFC3339), start.Add(20*time.Second).Format(time.RFC3339))
	meetingID := createMeetdMeetingForTest(t, router, body)

	liveResponse := performMeetingRequest(router, http.MethodGet, fmt.Sprintf("/meetings/%d/captions?limit=1", meetingID), "")
	if liveResponse.Code != http.StatusOK {
		t.Fatalf("live captions status = %d, body = %s", liveResponse.Code, liveResponse.Body.String())
	}
	if !strings.Contains(liveResponse.Body.String(), `"source":"live_caption"`) || !strings.Contains(liveResponse.Body.String(), `"returned_captions":1`) {
		t.Fatalf("live captions body = %s, want live_caption and returned count", liveResponse.Body.String())
	}
	if !strings.Contains(liveResponse.Body.String(), `"timestamp":"00:00:10"`) || !strings.Contains(liveResponse.Body.String(), `"Operator"`) {
		t.Fatalf("live captions body = %s, want relative timestamp and speaker", liveResponse.Body.String())
	}

	allResponse := performMeetingRequest(router, http.MethodGet, fmt.Sprintf("/meetings/%d/captions?source=all", meetingID), "")
	if allResponse.Code != http.StatusOK {
		t.Fatalf("all captions status = %d, body = %s", allResponse.Code, allResponse.Body.String())
	}
	if !strings.Contains(allResponse.Body.String(), `"source":"all"`) || !strings.Contains(allResponse.Body.String(), `"total_captions":2`) {
		t.Fatalf("all captions body = %s, want all source and two captions", allResponse.Body.String())
	}
	if !strings.Contains(allResponse.Body.String(), `"timestamp":"00:00:20"`) {
		t.Fatalf("all captions body = %s, want relative second caption timestamp", allResponse.Body.String())
	}
}

func TestMeetdCaptionSeedsPreferCueboardInputAliases(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	start := time.Now().UTC().Truncate(time.Second)
	body := fmt.Sprintf(`{
		"event_id":"caption-alias-event",
		"meet_url":"https://meet.google.com/caption-alias",
		"title":"Caption Alias Meeting",
		"start_at":%q,
		"end_at":%q,
		"caption_segments":[
			{"user":"Alice","caption":"first alias","ts":%q,"source":"live_caption"}
		],
		"segments":[
			{"speaker":"Ignored","text":"segments fallback should not win","timestamp":%q,"source":"live_caption"}
		]
	}`, start.Format(time.RFC3339), start.Add(time.Hour).Format(time.RFC3339), start.Add(10*time.Second).Format(time.RFC3339), start.Add(20*time.Second).Format(time.RFC3339))
	meetingID := createMeetdMeetingForTest(t, router, body)

	response := performMeetingRequest(router, http.MethodGet, fmt.Sprintf("/meetings/%d/captions", meetingID), "")
	if response.Code != http.StatusOK {
		t.Fatalf("caption status = %d, body = %s", response.Code, response.Body.String())
	}
	bodyText := response.Body.String()
	for _, want := range []string{`"speaker":"Alice"`, `"text":"first alias"`, `"timestamp":"00:00:10"`} {
		if !strings.Contains(bodyText, want) {
			t.Fatalf("caption body missing %q:\n%s", want, bodyText)
		}
	}
	if strings.Contains(bodyText, "segments fallback should not win") {
		t.Fatalf("caption_segments should take precedence over segments:\n%s", bodyText)
	}
}

func TestMeetdCaptionsRejectInvalidSource(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	start := time.Now().UTC().Truncate(time.Second)
	body := fmt.Sprintf(`{"event_id":"bad-caption-source","meet_url":"https://meet.google.com/caption-bad","title":"Bad Caption Source","start_at":%q,"end_at":%q}`, start.Format(time.RFC3339), start.Add(time.Hour).Format(time.RFC3339))
	meetingID := createMeetdMeetingForTest(t, router, body)

	response := performMeetingRequest(router, http.MethodGet, fmt.Sprintf("/meetings/%d/captions?source=bad", meetingID), "")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
	if strings.TrimSpace(response.Body.String()) != `{"error":"invalid caption source \"bad\""}` {
		t.Fatalf("body = %s, want invalid source error", response.Body.String())
	}
}

func TestMeetdChatFailsClosedWithoutActiveJoiner(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	start := time.Now().UTC().Truncate(time.Second)
	body := fmt.Sprintf(`{"event_id":"chat-event","meet_url":"https://meet.google.com/chat","title":"Chat Meeting","start_at":%q,"end_at":%q}`, start.Format(time.RFC3339), start.Add(time.Hour).Format(time.RFC3339))
	meetingID := createMeetdMeetingForTest(t, router, body)

	response := performMeetingRequest(router, http.MethodPost, fmt.Sprintf("/meetings/%d/chat", meetingID), `{"text":"hello"}`)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}
	if strings.TrimSpace(response.Body.String()) != `{"error":"no active joiner for this meeting"}` {
		t.Fatalf("body = %s, want no active joiner error", response.Body.String())
	}
}

func createMeetdMeetingForTest(t *testing.T, router http.Handler, body string) int64 {
	t.Helper()
	response := performMeetingRequest(router, http.MethodPost, "/meetings", body)
	if response.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload struct {
		MeetingID int64 `json:"meeting_id"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	return payload.MeetingID
}
