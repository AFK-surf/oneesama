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

const defaultSlackAssistantAPIBaseURL = defaultSlackAPIBaseURL

type AssistantClientConfig struct {
	BotToken   string
	Mock       bool
	APIBaseURL string
	Client     *http.Client
}

type AssistantStatusInput struct {
	ChannelID string
	ThreadTS  string
	Status    string
}

type AssistantSuggestedPromptsInput struct {
	ChannelID string
	ThreadTS  string
}

type AssistantPrompt struct {
	Title   string `json:"title"`
	Message string `json:"message"`
}

type AssistantAPIResult struct {
	OK      bool                   `json:"ok"`
	Mock    bool                   `json:"mock,omitempty"`
	Status  int                    `json:"status,omitempty"`
	Method  string                 `json:"method"`
	Error   string                 `json:"error,omitempty"`
	Detail  string                 `json:"detail,omitempty"`
	Skipped bool                   `json:"skipped,omitempty"`
	Queued  bool                   `json:"queued,omitempty"`
	Reason  string                 `json:"reason,omitempty"`
	Payload map[string]any         `json:"payload,omitempty"`
	Body    *SlackAssistantAPIBody `json:"body,omitempty"`
}

type SlackAssistantAPIBody struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Mock  bool   `json:"mock,omitempty"`
}

type SlackAssistantClient struct {
	botToken   string
	mock       bool
	apiBaseURL string
	client     *http.Client
}

func NewSlackAssistantClient(config AssistantClientConfig) *SlackAssistantClient {
	apiBaseURL := strings.TrimRight(strings.TrimSpace(config.APIBaseURL), "/")
	if apiBaseURL == "" {
		apiBaseURL = defaultSlackAssistantAPIBaseURL
	}
	client := config.Client
	if client == nil {
		client = httputil.NewHTTPClient(10 * time.Second)
	}
	mock := config.Mock
	if strings.TrimSpace(config.BotToken) == "" {
		mock = true
	}
	return &SlackAssistantClient{
		botToken:   strings.TrimSpace(config.BotToken),
		mock:       mock,
		apiBaseURL: apiBaseURL,
		client:     client,
	}
}

func (c *SlackAssistantClient) SetStatus(ctx context.Context, input AssistantStatusInput) AssistantAPIResult {
	status := strings.TrimSpace(input.Status)
	payload := map[string]any{
		"channel_id": strings.TrimSpace(input.ChannelID),
		"thread_ts":  strings.TrimSpace(input.ThreadTS),
		"status":     status,
	}
	if status != "" {
		payload["loading_messages"] = []string{status}
	}
	return c.call(ctx, "assistant.threads.setStatus", payload)
}

func (c *SlackAssistantClient) SetSuggestedPrompts(ctx context.Context, input AssistantSuggestedPromptsInput) AssistantAPIResult {
	payload := map[string]any{
		"channel_id": strings.TrimSpace(input.ChannelID),
		"thread_ts":  strings.TrimSpace(input.ThreadTS),
		"title":      "试试这些：",
		"prompts": []AssistantPrompt{
			{Title: "今天日程", Message: "今天有什么会议和日程安排？"},
			{Title: "未读消息", Message: "帮我看看有什么重要的未读消息？"},
			{Title: "处理任务", Message: "请帮我查清楚这件事，并把结果发回这个线程。"},
		},
	}
	return c.call(ctx, "assistant.threads.setSuggestedPrompts", payload)
}

func (c *SlackAssistantClient) call(ctx context.Context, method string, payload map[string]any) AssistantAPIResult {
	if c == nil {
		return AssistantAPIResult{Method: method, Payload: payload, Error: "missing_assistant_client"}
	}
	if c.mock {
		return AssistantAPIResult{
			OK:      true,
			Mock:    true,
			Status:  http.StatusOK,
			Method:  method,
			Payload: payload,
			Body:    &SlackAssistantAPIBody{OK: true, Mock: true},
		}
	}
	if strings.TrimSpace(c.botToken) == "" {
		return AssistantAPIResult{Method: method, Payload: payload, Error: "missing_slack_bot_token"}
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		return AssistantAPIResult{Method: method, Payload: payload, Error: "encode_payload_failed", Detail: err.Error()}
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		fmt.Sprintf("%s/%s", c.apiBaseURL, method),
		bytes.NewReader(encoded),
	)
	if err != nil {
		return AssistantAPIResult{Method: method, Payload: payload, Error: "build_request_failed", Detail: err.Error()}
	}
	request.Header.Set("Authorization", "Bearer "+c.botToken)
	request.Header.Set("Content-Type", "application/json; charset=utf-8")

	response, err := c.client.Do(request)
	if err != nil {
		return AssistantAPIResult{Method: method, Payload: payload, Error: "request_failed", Detail: err.Error()}
	}
	defer response.Body.Close()

	var body SlackAssistantAPIBody
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		return AssistantAPIResult{
			OK:      false,
			Status:  response.StatusCode,
			Method:  method,
			Payload: payload,
			Error:   "decode_response_failed",
			Detail:  err.Error(),
			Body:    &body,
		}
	}
	return AssistantAPIResult{
		OK:      response.StatusCode >= 200 && response.StatusCode < 300 && body.OK,
		Status:  response.StatusCode,
		Method:  method,
		Payload: payload,
		Error:   slackAssistantError(response.StatusCode, body),
		Body:    &body,
	}
}

func slackAssistantError(status int, body SlackAssistantAPIBody) string {
	if status < 200 || status >= 300 {
		return http.StatusText(status)
	}
	if !body.OK {
		return firstNonEmpty(body.Error, "slack_assistant_api_error")
	}
	return ""
}
