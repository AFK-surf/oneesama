package slackagent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

const defaultSlackPosterEndpoint = "https://slack.com/api/chat.postMessage"

type PosterConfig struct {
	BotToken    string
	Mock        bool
	Endpoint    string
	MaxAttempts int
	RetryDelay  time.Duration
	Client      *http.Client
}

type PostMessageInput struct {
	Channel  string
	Text     string
	ThreadTS string
	DedupKey string
	Blocks   []map[string]any
}

type PostMessageResult struct {
	OK       bool                  `json:"ok"`
	Mock     bool                  `json:"mock"`
	Channel  string                `json:"channel"`
	TS       string                `json:"ts"`
	ThreadTS string                `json:"thread_ts"`
	DedupKey string                `json:"dedup_key"`
	Attempts int                   `json:"attempts"`
	Status   int                   `json:"status"`
	Error    string                `json:"error,omitempty"`
	Detail   string                `json:"detail,omitempty"`
	Deduped  bool                  `json:"deduped"`
	Body     *SlackPostMessageBody `json:"body,omitempty"`
}

type SlackPostMessageBody struct {
	OK      bool                  `json:"ok"`
	Error   string                `json:"error,omitempty"`
	TS      string                `json:"ts,omitempty"`
	Message *SlackPostMessageMeta `json:"message,omitempty"`
}

type SlackPostMessageMeta struct {
	ThreadTS string `json:"thread_ts,omitempty"`
}

type Poster struct {
	botToken    string
	mock        bool
	endpoint    string
	maxAttempts int
	retryDelay  time.Duration
	client      *http.Client

	mu            sync.Mutex
	postedByDedup map[string]PostMessageResult
}

func NewPoster(config PosterConfig) *Poster {
	endpoint := strings.TrimSpace(config.Endpoint)
	if endpoint == "" {
		endpoint = defaultSlackPosterEndpoint
	}

	maxAttempts := config.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = 3
	}

	retryDelay := config.RetryDelay
	if retryDelay <= 0 {
		retryDelay = 250 * time.Millisecond
	}

	client := config.Client
	if client == nil {
		client = httputil.NewHTTPClient(10 * time.Second)
	}

	mock := config.Mock
	if strings.TrimSpace(config.BotToken) == "" {
		mock = true
	}

	return &Poster{
		botToken:      strings.TrimSpace(config.BotToken),
		mock:          mock,
		endpoint:      endpoint,
		maxAttempts:   maxAttempts,
		retryDelay:    retryDelay,
		client:        client,
		postedByDedup: make(map[string]PostMessageResult),
	}
}

func (p *Poster) PostMessage(ctx context.Context, input PostMessageInput) PostMessageResult {
	input = sanitizeSlackPostMessageInput(input)
	channel := strings.TrimSpace(input.Channel)
	text := strings.TrimSpace(input.Text)
	if channel == "" {
		return PostMessageResult{Error: "missing_channel", Channel: input.Channel, ThreadTS: input.ThreadTS, DedupKey: input.DedupKey}
	}
	if text == "" {
		return PostMessageResult{Error: "missing_text", Channel: channel, ThreadTS: input.ThreadTS, DedupKey: input.DedupKey}
	}

	if previous, ok := p.lookupDedup(input.DedupKey); ok {
		previous.Deduped = true
		return previous
	}

	if p.mock {
		result := PostMessageResult{
			OK:       true,
			Mock:     true,
			Channel:  channel,
			TS:       fmt.Sprintf("mock.%d", time.Now().UnixMilli()),
			ThreadTS: input.ThreadTS,
			DedupKey: input.DedupKey,
			Attempts: 1,
			Body: &SlackPostMessageBody{
				OK: true,
				Message: &SlackPostMessageMeta{
					ThreadTS: input.ThreadTS,
				},
			},
		}
		p.storeDedup(input.DedupKey, result)
		return result
	}

	requestBody := map[string]any{
		"channel":      channel,
		"text":         text,
		"unfurl_links": false,
		"unfurl_media": false,
	}
	if input.ThreadTS != "" {
		requestBody["thread_ts"] = input.ThreadTS
	}
	if len(input.Blocks) > 0 {
		requestBody["blocks"] = input.Blocks
	}

	var last PostMessageResult
	for attempt := 1; attempt <= p.maxAttempts; attempt++ {
		last = p.postOnce(ctx, requestBody, input, attempt)
		if last.OK {
			p.storeDedup(input.DedupKey, last)
			return last
		}
		if attempt == p.maxAttempts || !shouldRetrySlackPost(last) {
			return last
		}
		select {
		case <-ctx.Done():
			return PostMessageResult{
				Channel:  channel,
				ThreadTS: input.ThreadTS,
				DedupKey: input.DedupKey,
				Attempts: attempt,
				Error:    "request_cancelled",
				Detail:   ctx.Err().Error(),
			}
		case <-time.After(p.retryDelay * time.Duration(attempt)):
		}
	}

	return last
}

func (p *Poster) postOnce(ctx context.Context, payload map[string]any, input PostMessageInput, attempt int) PostMessageResult {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return PostMessageResult{
			Channel:  input.Channel,
			ThreadTS: input.ThreadTS,
			DedupKey: input.DedupKey,
			Attempts: attempt,
			Error:    "encode_payload_failed",
			Detail:   err.Error(),
		}
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint, bytes.NewReader(encoded))
	if err != nil {
		return PostMessageResult{
			Channel:  input.Channel,
			ThreadTS: input.ThreadTS,
			DedupKey: input.DedupKey,
			Attempts: attempt,
			Error:    "build_request_failed",
			Detail:   err.Error(),
		}
	}
	request.Header.Set("Authorization", "Bearer "+p.botToken)
	request.Header.Set("Content-Type", "application/json; charset=utf-8")

	response, err := p.client.Do(request)
	if err != nil {
		return PostMessageResult{
			Channel:  input.Channel,
			ThreadTS: input.ThreadTS,
			DedupKey: input.DedupKey,
			Attempts: attempt,
			Error:    "request_failed",
			Detail:   err.Error(),
		}
	}
	defer func() { _ = response.Body.Close() }()

	var body SlackPostMessageBody
	if decodeErr := json.NewDecoder(response.Body).Decode(&body); decodeErr != nil {
		body = SlackPostMessageBody{}
	}

	return PostMessageResult{
		OK:       response.StatusCode >= 200 && response.StatusCode < 300 && body.OK,
		Channel:  input.Channel,
		TS:       body.TS,
		ThreadTS: threadTSForResult(input.ThreadTS, &body),
		DedupKey: input.DedupKey,
		Attempts: attempt,
		Status:   response.StatusCode,
		Error:    slackPostError(response.StatusCode, body),
		Body:     &body,
	}
}

func (p *Poster) lookupDedup(dedupKey string) (PostMessageResult, bool) {
	if strings.TrimSpace(dedupKey) == "" {
		return PostMessageResult{}, false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	result, ok := p.postedByDedup[dedupKey]
	return result, ok
}

func (p *Poster) storeDedup(dedupKey string, result PostMessageResult) {
	if strings.TrimSpace(dedupKey) == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.postedByDedup[dedupKey] = result
}
