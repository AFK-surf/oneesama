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
	report := httptest.NewRecorder()
	reportRequest := httptest.NewRequest(http.MethodPost, "/worker/report", strings.NewReader(`{"id":"job_done","status":"completed","provider":"codex","mode":"analysis","task":"summarize","result":"done"}`))
	reportRequest.Header.Set(internalauth.HeaderName, "secret-key")
	reportRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(report, reportRequest)
	if report.Code != http.StatusOK || !strings.Contains(report.Body.String(), `"id":"job_done"`) {
		t.Fatalf("report response = %d %s, want stored job", report.Code, report.Body.String())
	}

	poll := httptest.NewRecorder()
	pollRequest := httptest.NewRequest(http.MethodPost, "/worker/poll-slack", strings.NewReader(`{"limit":10,"markDelivered":false}`))
	pollRequest.Header.Set(internalauth.HeaderName, "secret-key")
	pollRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(poll, pollRequest)
	if poll.Code != http.StatusOK || !strings.Contains(poll.Body.String(), `"job_done"`) {
		t.Fatalf("poll response = %d %s, want ready job", poll.Code, poll.Body.String())
	}

	mark := httptest.NewRecorder()
	markRequest := httptest.NewRequest(http.MethodPost, "/worker/mark-slack-delivered", strings.NewReader(`{"jobId":"job_done","channel":"C123","threadTs":"123.456","ts":"123.789","dedupKey":"worker-result:job_done"}`))
	markRequest.Header.Set(internalauth.HeaderName, "secret-key")
	markRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(mark, markRequest)
	if mark.Code != http.StatusOK || !strings.Contains(mark.Body.String(), `"deliveredToSlack":true`) {
		t.Fatalf("mark response = %d %s, want deliveredToSlack", mark.Code, mark.Body.String())
	}

	pollAgain := httptest.NewRecorder()
	pollAgainRequest := httptest.NewRequest(http.MethodPost, "/worker/poll-slack", strings.NewReader(`{"limit":10}`))
	pollAgainRequest.Header.Set(internalauth.HeaderName, "secret-key")
	pollAgainRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(pollAgain, pollAgainRequest)
	if pollAgain.Code != http.StatusOK || strings.Contains(pollAgain.Body.String(), `"job_done"`) {
		t.Fatalf("poll again = %d %s, want delivered job hidden", pollAgain.Code, pollAgain.Body.String())
	}
}

func TestWorkerReportStoresBoundedResultEnvelope(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	report := httptest.NewRecorder()
	longResult := strings.Repeat("worker scratch line ", 900)
	reportRequest := httptest.NewRequest(http.MethodPost, "/worker/report", strings.NewReader(`{"id":"job_long","status":"completed","provider":"codex","mode":"analysis","task":"summarize","result":`+strconv.Quote(longResult)+`}`))
	reportRequest.Header.Set(internalauth.HeaderName, "secret-key")
	reportRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(report, reportRequest)
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
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/worker/delegate", strings.NewReader(`{"task":"summarize meeting","mode":"analysis","context":{"source":"test"}}`))
	request.Header.Set(internalauth.HeaderName, "secret-key")
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(response, request)
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

	jobs := httptest.NewRecorder()
	jobsRequest := httptest.NewRequest(http.MethodGet, "/worker/jobs", nil)
	jobsRequest.Header.Set(internalauth.HeaderName, "secret-key")
	router.ServeHTTP(jobs, jobsRequest)
	if jobs.Code != http.StatusOK || !strings.Contains(jobs.Body.String(), body.Job.ID) {
		t.Fatalf("jobs body = %d %s, want delegated report", jobs.Code, jobs.Body.String())
	}
}

func TestWorkerPollRealtimeMarksDeliveryByDefault(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	report := httptest.NewRecorder()
	reportRequest := httptest.NewRequest(http.MethodPost, "/worker/report", strings.NewReader(`{"id":"job_realtime","status":"failed","task":"answer","error":"boom"}`))
	reportRequest.Header.Set(internalauth.HeaderName, "secret-key")
	reportRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(report, reportRequest)

	first := httptest.NewRecorder()
	firstRequest := httptest.NewRequest(http.MethodPost, "/worker/poll-realtime", strings.NewReader(`{}`))
	firstRequest.Header.Set(internalauth.HeaderName, "secret-key")
	firstRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(first, firstRequest)
	if first.Code != http.StatusOK || !strings.Contains(first.Body.String(), `"job_realtime"`) || !strings.Contains(first.Body.String(), `"deliveredToRealtime":true`) {
		t.Fatalf("first realtime poll = %d %s, want delivered job", first.Code, first.Body.String())
	}

	second := httptest.NewRecorder()
	secondRequest := httptest.NewRequest(http.MethodPost, "/worker/poll-realtime", strings.NewReader(`{}`))
	secondRequest.Header.Set(internalauth.HeaderName, "secret-key")
	secondRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(second, secondRequest)
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

	report := httptest.NewRecorder()
	reportRequest := httptest.NewRequest(http.MethodPost, "/worker/report", strings.NewReader(`{"id":"job_bridge","status":"completed","task":"answer","result":"done"}`))
	reportRequest.Header.Set(internalauth.HeaderName, "secret-key")
	reportRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(report, reportRequest)
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
