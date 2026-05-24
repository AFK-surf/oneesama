package persona

import (
	"context"
	"encoding/json"
	"fmt"
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
	timeout       time.Duration
	lastRequestAt time.Time
	lastLatency   time.Duration
	lastError     string
}

func NewHTTPRuntime(cfg HTTPConfig) (*HTTPRuntime, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if baseURL == "" {
		return nil, fmt.Errorf("persona runtime base_url is required for %s provider", stringOrDefault(cfg.Provider, ProviderHTTP))
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	client := cfg.Client
	if client == nil {
		client = httputil.NewHTTPClient(timeout)
	}
	return &HTTPRuntime{
		provider:   stringOrDefault(cfg.Provider, ProviderHTTP),
		mode:       stringOrDefault(cfg.Mode, ModeShadow),
		baseURL:    baseURL,
		shadowOnly: cfg.ShadowOnly || !strings.EqualFold(cfg.Mode, ModeLive),
		client:     client,
		timeout:    timeout,
	}, nil
}

func (r *HTTPRuntime) Decide(ctx context.Context, req Request) (Response, error) {
	start := time.Now()
	ctx, cancel := personaRequestContext(ctx, r.timeout)
	defer cancel()
	req.Mode = stringOrDefault(req.Mode, r.mode)
	payload, err := json.Marshal(req)
	if err != nil {
		r.record(start, err)
		return Response{}, fmt.Errorf("marshal persona request: %w", err)
	}
	body, err := doPersonaHTTP(ctx, r.client, http.MethodPost, r.baseURL+"/persona/decide", payload, map[string]string{
		"Content-Type": "application/json",
	}, maxHTTPRuntimeResponseBytes, "persona runtime")
	if err != nil {
		err = httpRuntimeDecideError(err)
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
	ctx, cancel := personaRequestContext(ctx, r.timeout)
	defer cancel()
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
	status.LastError = sanitizePersonaRuntimeErrorText(r.lastError)
	r.mu.Unlock()

	body, err := doPersonaHTTP(ctx, r.client, http.MethodGet, r.baseURL+"/persona/status", nil, nil, maxHTTPRuntimeResponseBytes, "persona runtime")
	if err != nil {
		status.LastError = sanitizePersonaRuntimeErrorText(err.Error())
		return status
	}
	var remote Status
	if err := json.Unmarshal(body, &remote); err != nil {
		status.LastError = sanitizePersonaRuntimeErrorText(err.Error())
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
	} else {
		remote.LastError = sanitizePersonaRuntimeErrorText(remote.LastError)
	}
	return remote
}

func httpRuntimeDecideError(err error) error {
	return personaHTTPCallError(err, "call persona runtime", "read persona response")
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
