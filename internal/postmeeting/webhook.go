package postmeeting

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

type WebhookSender struct {
	client *http.Client
}

func NewWebhookSender(client *http.Client) *WebhookSender {
	if client == nil {
		client = httputil.NewHTTPClient(10 * time.Second)
	}
	return &WebhookSender{client: client}
}

func ComputeDigestWebhookSignature(body string, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(body))
	return hex.EncodeToString(mac.Sum(nil))
}

func VerifyDigestWebhookSignature(body string, signature string, secret string) bool {
	if secret == "" {
		return true
	}
	expected := ComputeDigestWebhookSignature(body, secret)
	return hmac.Equal([]byte(expected), []byte(signature))
}

func (s *WebhookSender) Send(ctx context.Context, request DigestWebhookRequest) (DigestWebhookResult, error) {
	if firstNonEmpty(request.URL) == "" {
		return DigestWebhookResult{OK: false, Error: "webhook_url_required"}, nil
	}

	payload := request.Payload
	if payload == nil {
		payload = map[string]any{}
	}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return DigestWebhookResult{}, fmt.Errorf("marshal digest webhook payload: %w", err)
	}
	body := string(bodyBytes)
	signature := ComputeDigestWebhookSignature(body, request.Secret)

	maxAttempts := request.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = 5
	}
	retryDelay := time.Duration(request.RetryDelayMS) * time.Millisecond
	if retryDelay <= 0 {
		retryDelay = time.Second
	}

	history := make([]DigestWebhookAttempt, 0, maxAttempts)
	var last DigestWebhookAttempt
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		last = s.sendOnce(ctx, request, bodyBytes, signature, attempt)
		history = append(history, last)
		if last.OK || attempt == maxAttempts {
			break
		}
		select {
		case <-ctx.Done():
			return DigestWebhookResult{
				OK:           false,
				Attempts:     len(history),
				Status:       0,
				Error:        ctx.Err().Error(),
				Signature:    signature,
				PayloadBytes: len(bodyBytes),
				History:      history,
			}, nil
		case <-time.After(retryDelay * time.Duration(attempt)):
		}
	}

	result := DigestWebhookResult{
		OK:           last.OK,
		Attempts:     len(history),
		Status:       last.Status,
		Signature:    signature,
		PayloadBytes: len(bodyBytes),
		History:      history,
	}
	if !last.OK {
		result.Error = firstNonEmpty(last.Error, fmt.Sprintf("webhook_status_%d", last.Status))
	}
	return result, nil
}

func (s *WebhookSender) sendOnce(ctx context.Context, request DigestWebhookRequest, body []byte, signature string, attempt int) DigestWebhookAttempt {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, request.URL, bytes.NewReader(body))
	if err != nil {
		return DigestWebhookAttempt{Attempt: attempt, OK: false, Status: 0, Error: "build_request_failed", Detail: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Webhook-Signature", signature)
	if event := firstNonEmpty(stringValue(request.Payload["event"])); event != "" {
		req.Header.Set("X-Meeting-Avatar-Event", event)
	}

	response, err := s.client.Do(req)
	if err != nil {
		return DigestWebhookAttempt{Attempt: attempt, OK: false, Status: 0, Error: "request_failed", Detail: err.Error()}
	}
	defer func() { _ = response.Body.Close() }()

	payload, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if readErr != nil {
		return DigestWebhookAttempt{Attempt: attempt, OK: false, Status: response.StatusCode, Error: "read_response_failed", Detail: readErr.Error()}
	}
	return DigestWebhookAttempt{
		Attempt: attempt,
		OK:      response.StatusCode >= 200 && response.StatusCode < 300,
		Status:  response.StatusCode,
		Body:    string(payload),
	}
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	if stringer, ok := value.(string); ok {
		return stringer
	}
	return fmt.Sprint(value)
}
