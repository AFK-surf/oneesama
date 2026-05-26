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

type SlackReactionClientConfig struct {
	BotToken   string
	Mock       bool
	APIBaseURL string
	Client     *http.Client
}

type SlackReactionInput struct {
	Channel   string `json:"channel"`
	Timestamp string `json:"timestamp"`
	Name      string `json:"name"`
}

type SlackReactionResult struct {
	OK      bool                  `json:"ok"`
	Mock    bool                  `json:"mock,omitempty"`
	Status  int                   `json:"status,omitempty"`
	Method  string                `json:"method"`
	Error   string                `json:"error,omitempty"`
	Detail  string                `json:"detail,omitempty"`
	Payload map[string]any        `json:"payload,omitempty"`
	Body    *SlackReactionAPIBody `json:"body,omitempty"`
}

type SlackReactionAPIBody struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Mock  bool   `json:"mock,omitempty"`
}

type SlackReactionClient struct {
	botToken   string
	mock       bool
	apiBaseURL string
	client     *http.Client
}

func NewSlackReactionClient(config SlackReactionClientConfig) *SlackReactionClient {
	apiBaseURL := strings.TrimRight(strings.TrimSpace(config.APIBaseURL), "/")
	if apiBaseURL == "" {
		apiBaseURL = defaultSlackAPIBaseURL
	}
	client := config.Client
	if client == nil {
		client = httputil.NewHTTPClient(10 * time.Second)
	}
	mock := config.Mock
	if strings.TrimSpace(config.BotToken) == "" {
		mock = true
	}
	return &SlackReactionClient{
		botToken:   strings.TrimSpace(config.BotToken),
		mock:       mock,
		apiBaseURL: apiBaseURL,
		client:     client,
	}
}

func (c *SlackReactionClient) AddReaction(ctx context.Context, input SlackReactionInput) SlackReactionResult {
	return c.call(ctx, "reactions.add", input)
}

func (c *SlackReactionClient) RemoveReaction(ctx context.Context, input SlackReactionInput) SlackReactionResult {
	return c.call(ctx, "reactions.remove", input)
}

func (c *SlackReactionClient) call(ctx context.Context, method string, input SlackReactionInput) SlackReactionResult {
	payload := map[string]any{
		"channel":   strings.TrimSpace(input.Channel),
		"timestamp": strings.TrimSpace(input.Timestamp),
		"name":      strings.Trim(strings.TrimSpace(input.Name), ":"),
	}
	if c == nil {
		return SlackReactionResult{Method: method, Payload: payload, Error: "missing_reaction_client"}
	}
	if c.mock {
		return SlackReactionResult{
			OK:      true,
			Mock:    true,
			Status:  http.StatusOK,
			Method:  method,
			Payload: payload,
			Body:    &SlackReactionAPIBody{OK: true, Mock: true},
		}
	}
	if strings.TrimSpace(c.botToken) == "" {
		return SlackReactionResult{Method: method, Payload: payload, Error: "missing_slack_bot_token"}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return SlackReactionResult{Method: method, Payload: payload, Error: "encode_payload_failed", Detail: err.Error()}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/%s", c.apiBaseURL, method), bytes.NewReader(encoded))
	if err != nil {
		return SlackReactionResult{Method: method, Payload: payload, Error: "build_request_failed", Detail: err.Error()}
	}
	request.Header.Set("Authorization", "Bearer "+c.botToken)
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	response, err := c.client.Do(request)
	if err != nil {
		return SlackReactionResult{Method: method, Payload: payload, Error: "request_failed", Detail: err.Error()}
	}
	defer func() { _ = response.Body.Close() }()

	var body SlackReactionAPIBody
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		return SlackReactionResult{Status: response.StatusCode, Method: method, Payload: payload, Error: "decode_response_failed", Detail: err.Error(), Body: &body}
	}
	return SlackReactionResult{
		OK:      response.StatusCode >= 200 && response.StatusCode < 300 && body.OK,
		Status:  response.StatusCode,
		Method:  method,
		Payload: payload,
		Error:   slackReactionError(response.StatusCode, body),
		Body:    &body,
	}
}

func slackReactionError(status int, body SlackReactionAPIBody) string {
	if status < 200 || status >= 300 {
		return http.StatusText(status)
	}
	if !body.OK {
		return firstNonEmpty(body.Error, "slack_reaction_api_error")
	}
	return ""
}
