package persona

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const (
	maxHTTPRuntimeResponseBytes int64 = 1 << 20
	maxOneesamaPIResponseBytes  int64 = 2 << 20
	maxPersonaRuntimeErrorRunes       = 500
)

var personaSensitivePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._~+/=-]+`),
	regexp.MustCompile(`xox[baprs]-[A-Za-z0-9-]+`),
	regexp.MustCompile(`(?i)(api[_-]?key|token|authorization|secret)["'\s:=]+[^"',\s}]+`),
	regexp.MustCompile(`https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+`),
}

func personaRequestContext(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	if timeout <= 0 {
		return ctx, func() {}
	}
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) <= timeout {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, timeout)
}

func readPersonaBody(r io.Reader, maxBytes int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, fmt.Errorf("persona response body exceeds %d bytes", maxBytes)
	}
	return body, nil
}

func doPersonaHTTP(ctx context.Context, client *http.Client, method string, url string, payload []byte, headers map[string]string, maxBytes int64, label string) ([]byte, error) {
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, personaHTTPError{stage: "request", err: err}
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, personaHTTPError{stage: "call", err: err}
	}
	defer resp.Body.Close()
	raw, err := readPersonaBody(resp.Body, maxBytes)
	if err != nil {
		return nil, personaHTTPError{stage: "read", err: err}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, personaHTTPError{stage: "status", err: personaRemoteStatusError(label, resp.Status, raw)}
	}
	return raw, nil
}

type personaHTTPError struct {
	stage string
	err   error
}

func (e personaHTTPError) Error() string {
	if e.err == nil {
		return ""
	}
	return e.err.Error()
}

func (e personaHTTPError) Unwrap() error {
	return e.err
}

func personaHTTPCallError(err error, callMessage string, readMessage string) error {
	var httpErr personaHTTPError
	if !errors.As(err, &httpErr) {
		return fmt.Errorf("%s: %w", callMessage, err)
	}
	switch httpErr.stage {
	case "request":
		return httpErr.err
	case "call":
		return fmt.Errorf("%s: %w", callMessage, httpErr.err)
	case "read":
		return fmt.Errorf("%s: %w", readMessage, httpErr.err)
	case "status":
		return httpErr.err
	default:
		return fmt.Errorf("%s: %w", callMessage, httpErr.err)
	}
}

func personaRemoteStatusError(label string, status string, body []byte) error {
	message := sanitizePersonaRuntimeError(body)
	if message == "" {
		return fmt.Errorf("%s returned %s", label, status)
	}
	return fmt.Errorf("%s returned %s: %s", label, status, message)
}

func sanitizePersonaRuntimeError(body []byte) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return ""
	}
	message := extractPersonaRuntimeErrorMessage(body)
	if message == "" {
		message = text
	}
	return sanitizePersonaRuntimeErrorText(message)
}

func sanitizePersonaRuntimeErrorText(message string) string {
	for _, pattern := range personaSensitivePatterns {
		message = pattern.ReplaceAllString(message, "[redacted]")
	}
	runes := []rune(strings.TrimSpace(message))
	if len(runes) <= maxPersonaRuntimeErrorRunes {
		return string(runes)
	}
	return string(runes[:maxPersonaRuntimeErrorRunes]) + "..."
}

func extractPersonaRuntimeErrorMessage(body []byte) string {
	var raw struct {
		Error   any    `json:"error"`
		Message string `json:"message"`
		Code    string `json:"code"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	parts := make([]string, 0, 2)
	switch value := raw.Error.(type) {
	case string:
		parts = append(parts, value)
	case map[string]any:
		if code, ok := value["code"].(string); ok && strings.TrimSpace(code) != "" {
			parts = append(parts, code)
		}
		if message, ok := value["message"].(string); ok && strings.TrimSpace(message) != "" {
			parts = append(parts, message)
		}
	}
	if strings.TrimSpace(raw.Code) != "" {
		parts = append(parts, raw.Code)
	}
	if strings.TrimSpace(raw.Message) != "" {
		parts = append(parts, raw.Message)
	}
	return strings.Join(parts, ": ")
}
