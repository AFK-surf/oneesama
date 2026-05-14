package meetingagent

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/internalauth"
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

	createRequest := httptest.NewRequest(http.MethodPost, "/meetings/session", strings.NewReader(`{"id":"session_live","meeting_id":"meet_live","status":"joined","meeting_url":"https://meet.google.com/live","participant_count":2}`))
	createRequest.Header.Set(internalauth.HeaderName, "secret-key")
	createRequest.Header.Set("Content-Type", "application/json")
	createResponse := httptest.NewRecorder()
	router.ServeHTTP(createResponse, createRequest)
	if createResponse.Code != http.StatusOK {
		t.Fatalf("create status = %d, want 200", createResponse.Code)
	}

	listRequest := httptest.NewRequest(http.MethodGet, "/meetings/sessions", nil)
	listRequest.Header.Set(internalauth.HeaderName, "secret-key")
	listResponse := httptest.NewRecorder()
	router.ServeHTTP(listResponse, listRequest)
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200", listResponse.Code)
	}
	if !strings.Contains(listResponse.Body.String(), "session_live") {
		t.Fatalf("body = %s, want session_live", listResponse.Body.String())
	}

	getRequest := httptest.NewRequest(http.MethodGet, "/meetings/session?id=session_live", nil)
	getRequest.Header.Set(internalauth.HeaderName, "secret-key")
	getResponse := httptest.NewRecorder()
	router.ServeHTTP(getResponse, getRequest)
	if getResponse.Code != http.StatusOK {
		t.Fatalf("get status = %d, want 200", getResponse.Code)
	}
	if !strings.Contains(getResponse.Body.String(), `"status":"joined"`) {
		t.Fatalf("body = %s, want joined status", getResponse.Body.String())
	}

	updateRequest := httptest.NewRequest(http.MethodPost, "/meetings/session", strings.NewReader(`{"id":"session_live","title":"Runtime smoke","metadata":{"owner":"peng"}}`))
	updateRequest.Header.Set(internalauth.HeaderName, "secret-key")
	updateRequest.Header.Set("Content-Type", "application/json")
	updateResponse := httptest.NewRecorder()
	router.ServeHTTP(updateResponse, updateRequest)
	if updateResponse.Code != http.StatusOK {
		t.Fatalf("update status = %d, want 200", updateResponse.Code)
	}
	if !strings.Contains(updateResponse.Body.String(), `"status":"joined"`) {
		t.Fatalf("body = %s, want joined status preserved", updateResponse.Body.String())
	}
	if !strings.Contains(updateResponse.Body.String(), `"title":"Runtime smoke"`) {
		t.Fatalf("body = %s, want updated title", updateResponse.Body.String())
	}

	deleteRequest := httptest.NewRequest(http.MethodDelete, "/meetings/session?id=session_live", nil)
	deleteRequest.Header.Set(internalauth.HeaderName, "secret-key")
	deleteResponse := httptest.NewRecorder()
	router.ServeHTTP(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200", deleteResponse.Code)
	}
}
