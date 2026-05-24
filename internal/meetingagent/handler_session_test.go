package meetingagent

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMeetingRoutesRequireInternalAuth(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)
	request := httptest.NewRequest(http.MethodGet, "/meetings/status", nil)
	request.RemoteAddr = "203.0.113.10:1234"
	request.Header.Set("X-Forwarded-For", "127.0.0.1")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
}

func TestHandleSessionCRUD(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t)

	createResponse := performMeetingRequest(router, http.MethodPost, "/meetings/session", `{"id":"session_live","meeting_id":"meet_live","status":"joined","meeting_url":"https://meet.google.com/live","participant_count":2}`)
	if createResponse.Code != http.StatusOK {
		t.Fatalf("create status = %d, want 200", createResponse.Code)
	}

	listResponse := performMeetingRequest(router, http.MethodGet, "/meetings/sessions", "")
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200", listResponse.Code)
	}
	if !strings.Contains(listResponse.Body.String(), "session_live") {
		t.Fatalf("body = %s, want session_live", listResponse.Body.String())
	}

	getResponse := performMeetingRequest(router, http.MethodGet, "/meetings/session?id=session_live", "")
	if getResponse.Code != http.StatusOK {
		t.Fatalf("get status = %d, want 200", getResponse.Code)
	}
	if !strings.Contains(getResponse.Body.String(), `"status":"joined"`) {
		t.Fatalf("body = %s, want joined status", getResponse.Body.String())
	}

	updateResponse := performMeetingRequest(router, http.MethodPost, "/meetings/session", `{"id":"session_live","title":"Runtime smoke","metadata":{"owner":"peng"}}`)
	if updateResponse.Code != http.StatusOK {
		t.Fatalf("update status = %d, want 200", updateResponse.Code)
	}
	if !strings.Contains(updateResponse.Body.String(), `"status":"joined"`) {
		t.Fatalf("body = %s, want joined status preserved", updateResponse.Body.String())
	}
	if !strings.Contains(updateResponse.Body.String(), `"title":"Runtime smoke"`) {
		t.Fatalf("body = %s, want updated title", updateResponse.Body.String())
	}

	deleteResponse := performMeetingRequest(router, http.MethodDelete, "/meetings/session?id=session_live", "")
	if deleteResponse.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200", deleteResponse.Code)
	}
}
