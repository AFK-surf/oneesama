package persona

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

type HTTPConfig struct {
	Provider   string
	Mode       string
	BaseURL    string
	Timeout    time.Duration
	ShadowOnly bool
	Client     *http.Client
}

type HTTPRuntime struct {
	mu            sync.Mutex
	provider      string
	mode          string
	baseURL       string
	shadowOnly    bool
	client        *http.Client
	lastRequestAt time.Time
	lastLatency   time.Duration
	lastError     string
}

func NewHTTPRuntime(cfg HTTPConfig) (*HTTPRuntime, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if baseURL == "" {
		return nil, fmt.Errorf("persona runtime base_url is required for %s provider", stringOrDefault(cfg.Provider, ProviderHTTP))
	}
	client := cfg.Client
	if client == nil {
		timeout := cfg.Timeout
		if timeout <= 0 {
			timeout = 10 * time.Second
		}
		client = httputil.NewHTTPClient(timeout)
	}
	return &HTTPRuntime{
		provider:   stringOrDefault(cfg.Provider, ProviderHTTP),
		mode:       stringOrDefault(cfg.Mode, ModeShadow),
		baseURL:    baseURL,
		shadowOnly: cfg.ShadowOnly || !strings.EqualFold(cfg.Mode, ModeLive),
		client:     client,
	}, nil
}

func (r *HTTPRuntime) Decide(ctx context.Context, req Request) (Response, error) {
	start := time.Now()
	req.Mode = stringOrDefault(req.Mode, r.mode)
	payload, err := json.Marshal(req)
	if err != nil {
		r.record(start, err)
		return Response{}, fmt.Errorf("marshal persona request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+"/persona/decide", bytes.NewReader(payload))
	if err != nil {
		r.record(start, err)
		return Response{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := r.client.Do(httpReq)
	if err != nil {
		r.record(start, err)
		return Response{}, fmt.Errorf("call persona runtime: %w", err)
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if readErr != nil {
		r.record(start, readErr)
		return Response{}, fmt.Errorf("read persona response: %w", readErr)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		err := fmt.Errorf("persona runtime returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
		r.record(start, err)
		return Response{}, err
	}
	var decoded Response
	if err := json.Unmarshal(body, &decoded); err != nil {
		r.record(start, err)
		return Response{}, fmt.Errorf("decode persona response: %w", err)
	}
	if strings.TrimSpace(decoded.Runtime) == "" {
		decoded.Runtime = r.provider
	}
	if strings.TrimSpace(decoded.Decision) == "" {
		decoded.Decision = DecisionStaySilent
	}
	if r.shadowOnly || strings.EqualFold(req.Mode, ModeShadow) {
		decoded.ShadowOnly = true
	}
	r.record(start, nil)
	return decoded, nil
}

func (r *HTTPRuntime) Status(ctx context.Context) Status {
	status := Status{
		Provider:   r.provider,
		Mode:       r.mode,
		Healthy:    false,
		Ready:      false,
		ShadowOnly: r.shadowOnly,
	}
	r.mu.Lock()
	status.LastRequestAt = formatTime(r.lastRequestAt)
	status.LastLatencyMS = r.lastLatency.Milliseconds()
	status.LastError = r.lastError
	r.mu.Unlock()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, r.baseURL+"/persona/status", nil)
	if err != nil {
		status.LastError = err.Error()
		return status
	}
	resp, err := r.client.Do(httpReq)
	if err != nil {
		status.LastError = err.Error()
		return status
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if readErr != nil {
		status.LastError = readErr.Error()
		return status
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		status.LastError = fmt.Sprintf("persona runtime returned %s", resp.Status)
		return status
	}
	var remote Status
	if err := json.Unmarshal(body, &remote); err != nil {
		status.LastError = err.Error()
		return status
	}
	if strings.TrimSpace(remote.Provider) == "" {
		remote.Provider = r.provider
	}
	if strings.TrimSpace(remote.Mode) == "" {
		remote.Mode = r.mode
	}
	remote.ShadowOnly = remote.ShadowOnly || r.shadowOnly
	remote.LastRequestAt = firstNonEmpty(remote.LastRequestAt, status.LastRequestAt)
	if remote.LastLatencyMS == 0 {
		remote.LastLatencyMS = status.LastLatencyMS
	}
	if remote.LastError == "" {
		remote.LastError = status.LastError
	}
	return remote
}

func (r *HTTPRuntime) record(start time.Time, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lastRequestAt = time.Now().UTC()
	r.lastLatency = time.Since(start)
	if err != nil {
		r.lastError = err.Error()
	} else {
		r.lastError = ""
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
