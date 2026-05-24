package meetingagent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/internalauth"
)

func TestWorkerReportPollAndMarkSlackDelivered(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	report := performMeetingRequest(router, http.MethodPost, "/worker/report", `{"id":"job_done","status":"completed","provider":"codex","mode":"analysis","task":"summarize","result":"done"}`)
	if report.Code != http.StatusOK || !strings.Contains(report.Body.String(), `"id":"job_done"`) {
		t.Fatalf("report response = %d %s, want stored job", report.Code, report.Body.String())
	}

	poll := performMeetingRequest(router, http.MethodPost, "/worker/poll-slack", `{"limit":10,"markDelivered":false}`)
	if poll.Code != http.StatusOK || !strings.Contains(poll.Body.String(), `"job_done"`) {
		t.Fatalf("poll response = %d %s, want ready job", poll.Code, poll.Body.String())
	}

	mark := performMeetingRequest(router, http.MethodPost, "/worker/mark-slack-delivered", `{"jobId":"job_done","channel":"C123","threadTs":"123.456","ts":"123.789","dedupKey":"worker-result:job_done"}`)
	if mark.Code != http.StatusOK || !strings.Contains(mark.Body.String(), `"deliveredToSlack":true`) {
		t.Fatalf("mark response = %d %s, want deliveredToSlack", mark.Code, mark.Body.String())
	}

	pollAgain := performMeetingRequest(router, http.MethodPost, "/worker/poll-slack", `{"limit":10}`)
	if pollAgain.Code != http.StatusOK || strings.Contains(pollAgain.Body.String(), `"job_done"`) {
		t.Fatalf("poll again = %d %s, want delivered job hidden", pollAgain.Code, pollAgain.Body.String())
	}
}

func TestWorkerReportStoresBoundedResultEnvelope(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	longResult := strings.Repeat("worker scratch line ", 900)
	report := performMeetingRequest(router, http.MethodPost, "/worker/report", `{"id":"job_long","status":"completed","provider":"codex","mode":"analysis","task":"summarize","result":`+strconv.Quote(longResult)+`}`)
	if report.Code != http.StatusOK {
		t.Fatalf("report response = %d %s, want stored job", report.Code, report.Body.String())
	}
	var body struct {
		Job WorkerReport `json:"job"`
	}
	if err := json.Unmarshal(report.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode report: %v", err)
	}
	if body.Job.ResultEnvelope == nil {
		t.Fatalf("ResultEnvelope nil in body %#v", body.Job)
	}
	if body.Job.ResultEnvelope.Schema != agentrunner.WorkerResultEnvelopeSchema {
		t.Fatalf("schema = %q, want worker result envelope", body.Job.ResultEnvelope.Schema)
	}
	if len([]rune(body.Job.Result)) > 12000 {
		t.Fatalf("Result length = %d, want bounded", len([]rune(body.Job.Result)))
	}
	if !body.Job.ResultEnvelope.Truncated || !strings.Contains(body.Job.Result, "[worker result truncated]") {
		t.Fatalf("report result/envelope = %#v, want truncated bounded result", body.Job.ResultEnvelope)
	}
}

func TestWorkerDelegateCreatesReportForDryRunJob(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	response := performMeetingRequest(router, http.MethodPost, "/worker/delegate", `{"task":"summarize meeting","mode":"analysis","context":{"source":"test"}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("delegate status = %d body=%s, want 200", response.Code, response.Body.String())
	}
	var body WorkerDelegateResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode delegate: %v", err)
	}
	if !body.OK || body.Report == nil || body.Report.ID != body.Job.ID {
		t.Fatalf("delegate body = %#v, want immediate dry-run report", body)
	}

	jobs := performMeetingRequest(router, http.MethodGet, "/worker/jobs", "")
	if jobs.Code != http.StatusOK || !strings.Contains(jobs.Body.String(), body.Job.ID) {
		t.Fatalf("jobs body = %d %s, want delegated report", jobs.Code, jobs.Body.String())
	}
}

func TestWorkerPollRealtimeMarksDeliveryByDefault(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	performMeetingRequest(router, http.MethodPost, "/worker/report", `{"id":"job_realtime","status":"failed","task":"answer","error":"boom"}`)

	first := performMeetingRequest(router, http.MethodPost, "/worker/poll-realtime", `{}`)
	if first.Code != http.StatusOK || !strings.Contains(first.Body.String(), `"job_realtime"`) || !strings.Contains(first.Body.String(), `"deliveredToRealtime":true`) {
		t.Fatalf("first realtime poll = %d %s, want delivered job", first.Code, first.Body.String())
	}

	second := performMeetingRequest(router, http.MethodPost, "/worker/poll-realtime", `{}`)
	if second.Code != http.StatusOK || strings.Contains(second.Body.String(), `"job_realtime"`) {
		t.Fatalf("second realtime poll = %d %s, want no duplicate delivery", second.Code, second.Body.String())
	}
}

func TestWorkerReportInjectsRealtimeWhenJoinActive(t *testing.T) {
	t.Parallel()

	router, service := newScreenShareTestRouterWithService(t, t.TempDir())
	join := httptest.NewRequest(http.MethodPost, "/join/google-meet", strings.NewReader(`{"session_id":"session_worker","meeting_url":"https://meet.google.com/abc-defg-hij","dry_run":true}`))
	join.Header.Set(internalauth.HeaderName, "secret-key")
	join.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(httptest.NewRecorder(), join)
	markSessionJoined(t, service, "session_worker")

	report := performMeetingRequest(router, http.MethodPost, "/worker/report", `{"id":"job_bridge","status":"completed","task":"answer","result":"done"}`)
	if report.Code != http.StatusOK ||
		!strings.Contains(report.Body.String(), `"realtimeDelivery":{"ok":true`) ||
		!strings.Contains(report.Body.String(), `"deliveredToRealtime":true`) {
		t.Fatalf("report response = %d %s, want realtime injected", report.Code, report.Body.String())
	}
}

func TestWorkerReportSuppressesNoActionRealtimeDelivery(t *testing.T) {
	t.Parallel()

	router, service := newScreenShareTestRouterWithService(t, t.TempDir())
	join := httptest.NewRequest(http.MethodPost, "/join/google-meet", strings.NewReader(`{"session_id":"session_worker_noop","meeting_url":"https://meet.google.com/abc-defg-hij","dry_run":true}`))
	join.Header.Set(internalauth.HeaderName, "secret-key")
	join.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(httptest.NewRecorder(), join)
	markSessionJoined(t, service, "session_worker_noop")

	report := httptest.NewRecorder()
	reportRequest := httptest.NewRequest(http.MethodPost, "/worker/report", strings.NewReader(`{"id":"job_noop","status":"completed","task":"answer","result":"No action needed."}`))
	reportRequest.Header.Set(internalauth.HeaderName, "secret-key")
	reportRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(report, reportRequest)
	if report.Code != http.StatusOK ||
		!strings.Contains(report.Body.String(), `"channel":"realtime_noop_suppressed"`) ||
		!strings.Contains(report.Body.String(), `"deliveredToRealtime":true`) {
		t.Fatalf("report response = %d %s, want suppressed realtime delivery", report.Code, report.Body.String())
	}

	poll := httptest.NewRecorder()
	pollRequest := httptest.NewRequest(http.MethodPost, "/worker/poll-realtime", strings.NewReader(`{"markDelivered":false}`))
	pollRequest.Header.Set(internalauth.HeaderName, "secret-key")
	pollRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(poll, pollRequest)
	if poll.Code != http.StatusOK || strings.Contains(poll.Body.String(), `"job_noop"`) {
		t.Fatalf("poll response = %d %s, want no-op report hidden from realtime poll", poll.Code, poll.Body.String())
	}
}
