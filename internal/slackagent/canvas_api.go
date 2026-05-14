package slackagent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

const defaultSlackAPIBaseURL = "https://slack.com/api"

type SlackCanvasAPIResult struct {
	OK        bool
	Status    int
	Method    string
	Error     string
	Detail    string
	CanvasID  string
	TeamID    string
	Permalink string
	Body      *SlackCanvasAPIBody
}

type SlackCanvasAPIBody struct {
	OK       bool             `json:"ok"`
	Error    string           `json:"error,omitempty"`
	CanvasID string           `json:"canvas_id,omitempty"`
	Canvas   *SlackCanvasMeta `json:"canvas,omitempty"`
	TeamID   string           `json:"team_id,omitempty"`
	URL      string           `json:"url,omitempty"`
}

type SlackCanvasMeta struct {
	ID string `json:"id,omitempty"`
}

func CallSlackAPI(ctx context.Context, client *http.Client, botToken string, apiBaseURL string, method string, payload map[string]any) SlackCanvasAPIResult {
	if strings.TrimSpace(botToken) == "" {
		return SlackCanvasAPIResult{Method: method, Error: "missing_slack_bot_token"}
	}

	baseURL := strings.TrimRight(strings.TrimSpace(apiBaseURL), "/")
	if baseURL == "" {
		baseURL = defaultSlackAPIBaseURL
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		return SlackCanvasAPIResult{Method: method, Error: "encode_payload_failed", Detail: err.Error()}
	}

	httpClient := client
	if httpClient == nil {
		httpClient = httputil.NewHTTPClient(10 * time.Second)
	}

	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		fmt.Sprintf("%s/%s", baseURL, method),
		bytes.NewReader(encoded),
	)
	if err != nil {
		return SlackCanvasAPIResult{Method: method, Error: "build_request_failed", Detail: err.Error()}
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(botToken))
	request.Header.Set("Content-Type", "application/json; charset=utf-8")

	response, err := httpClient.Do(request)
	if err != nil {
		return SlackCanvasAPIResult{Method: method, Error: "request_failed", Detail: err.Error()}
	}
	defer response.Body.Close()

	var body SlackCanvasAPIBody
	if decodeErr := json.NewDecoder(response.Body).Decode(&body); decodeErr != nil {
		body = SlackCanvasAPIBody{}
	}

	return SlackCanvasAPIResult{
		OK:       response.StatusCode >= 200 && response.StatusCode < 300 && body.OK,
		Status:   response.StatusCode,
		Method:   method,
		Error:    slackCanvasError(response.StatusCode, body),
		CanvasID: canvasIDFromBody(&body),
		TeamID:   strings.TrimSpace(body.TeamID),
		Body:     &body,
	}
}

func CreateSlackCanvas(ctx context.Context, client *http.Client, botToken string, apiBaseURL string, title string, markdown string, channel string) SlackCanvasAPIResult {
	payload := map[string]any{
		"title": strings.TrimSpace(title),
		"document_content": map[string]any{
			"type":     "markdown",
			"markdown": markdown,
		},
	}
	if strings.TrimSpace(channel) != "" {
		payload["channel_id"] = channel
	}
	return CallSlackAPI(ctx, client, botToken, apiBaseURL, "canvases.create", payload)
}

func EditSlackCanvas(ctx context.Context, client *http.Client, botToken string, apiBaseURL string, canvasID string, markdown string, operation string, sectionID string) SlackCanvasAPIResult {
	if strings.TrimSpace(canvasID) == "" {
		return SlackCanvasAPIResult{Method: "canvases.edit", Error: "missing_canvas_id"}
	}

	change := map[string]any{
		"operation": strings.TrimSpace(operation),
		"document_content": map[string]any{
			"type":     "markdown",
			"markdown": markdown,
		},
	}
	if change["operation"] == "" {
		change["operation"] = "insert_at_end"
	}
	if strings.TrimSpace(sectionID) != "" {
		change["section_id"] = sectionID
	}

	return CallSlackAPI(ctx, client, botToken, apiBaseURL, "canvases.edit", map[string]any{
		"canvas_id": strings.TrimSpace(canvasID),
		"changes":   []map[string]any{change},
	})
}

func SlackAuthTest(ctx context.Context, client *http.Client, botToken string, apiBaseURL string) SlackCanvasAPIResult {
	return CallSlackAPI(ctx, client, botToken, apiBaseURL, "auth.test", map[string]any{})
}

func slackCanvasPermalink(teamID string, canvasID string) string {
	teamID = strings.TrimSpace(teamID)
	canvasID = strings.TrimSpace(canvasID)
	if teamID == "" || canvasID == "" {
		return ""
	}
	return fmt.Sprintf("https://app.slack.com/docs/%s/%s", teamID, canvasID)
}

func canvasIDFromBody(body *SlackCanvasAPIBody) string {
	if body == nil {
		return ""
	}
	if strings.TrimSpace(body.CanvasID) != "" {
		return body.CanvasID
	}
	if body.Canvas != nil {
		return strings.TrimSpace(body.Canvas.ID)
	}
	return ""
}

func slackCanvasError(status int, body SlackCanvasAPIBody) string {
	if status >= 200 && status < 300 && body.OK {
		return ""
	}
	if body.Error != "" {
		return body.Error
	}
	if status == 0 {
		return "request_failed"
	}
	return fmt.Sprintf("http_%d", status)
}
