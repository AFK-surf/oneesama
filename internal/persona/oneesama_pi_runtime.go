package persona

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

const (
	defaultOneesamaPIBaseURL = "https://openrouter.ai/api/v1"
	defaultOneesamaPIModel   = "deepseek/deepseek-v4-pro"
)

type OneesamaPIConfig struct {
	Provider   string
	Mode       string
	BaseURL    string
	Timeout    time.Duration
	ShadowOnly bool
	APIKey     string
	Model      string
	Client     *http.Client
}

type OneesamaPIRuntime struct {
	mu            sync.Mutex
	provider      string
	mode          string
	baseURL       string
	apiKey        string
	model         string
	shadowOnly    bool
	client        *http.Client
	requests      int
	lastRequestAt time.Time
	lastLatency   time.Duration
	lastError     string
}

func NewOneesamaPIRuntime(cfg OneesamaPIConfig) (*OneesamaPIRuntime, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(firstNonEmpty(
		os.Getenv("ONEESAMA_PI_BASE_URL"),
		cfg.BaseURL,
		os.Getenv("PI_BASE_URL"),
		os.Getenv("OPENROUTER_BASE_URL"),
		defaultOneesamaPIBaseURL,
	)), "/")
	apiKey := strings.TrimSpace(firstNonEmpty(
		cfg.APIKey,
		os.Getenv("ONEESAMA_PI_API_KEY"),
		os.Getenv("PI_API_KEY"),
		os.Getenv("OPENROUTER_API_KEY"),
	))
	if apiKey == "" {
		return nil, fmt.Errorf("oneesama Pi runtime API key is required; set ONEESAMA_PI_API_KEY, PI_API_KEY, or OPENROUTER_API_KEY")
	}
	model := strings.TrimSpace(firstNonEmpty(
		cfg.Model,
		os.Getenv("ONEESAMA_PI_MODEL"),
		os.Getenv("PI_MODEL_ID"),
		os.Getenv("PI_MODEL"),
		defaultOneesamaPIModel,
	))
	client := cfg.Client
	if client == nil {
		timeout := cfg.Timeout
		if timeout <= 0 {
			timeout = 90 * time.Second
		}
		client = httputil.NewHTTPClient(timeout)
	}
	return &OneesamaPIRuntime{
		provider:   stringOrDefault(cfg.Provider, ProviderOneesamaPi),
		mode:       stringOrDefault(cfg.Mode, ModeShadow),
		baseURL:    baseURL,
		apiKey:     apiKey,
		model:      model,
		shadowOnly: cfg.ShadowOnly || !strings.EqualFold(cfg.Mode, ModeLive),
		client:     client,
	}, nil
}

func (r *OneesamaPIRuntime) Decide(ctx context.Context, req Request) (Response, error) {
	start := time.Now()
	req.Mode = stringOrDefault(req.Mode, r.mode)
	payload, err := json.Marshal(oneesamaPIChatRequest{
		Model: r.model,
		Messages: []oneesamaPIChatMessage{
			{Role: "system", Content: oneesamaPISystemPrompt(req)},
			{Role: "user", Content: mustMarshalPersonaRequest(req)},
		},
		Temperature: 0.2,
		ResponseFormat: map[string]string{
			"type": "json_object",
		},
	})
	if err != nil {
		r.record(start, err)
		return Response{}, fmt.Errorf("marshal oneesama Pi request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		r.record(start, err)
		return Response{}, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+r.apiKey)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("HTTP-Referer", "https://github.com/AFK-surf/oneesama")
	httpReq.Header.Set("X-Title", "Oneesama")
	resp, err := r.client.Do(httpReq)
	if err != nil {
		r.record(start, err)
		return Response{}, fmt.Errorf("call oneesama Pi model: %w", err)
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if readErr != nil {
		r.record(start, readErr)
		return Response{}, fmt.Errorf("read oneesama Pi response: %w", readErr)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		err := fmt.Errorf("oneesama Pi model returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
		r.record(start, err)
		return Response{}, err
	}
	var completion oneesamaPIChatResponse
	if err := json.Unmarshal(body, &completion); err != nil {
		r.record(start, err)
		return Response{}, fmt.Errorf("decode oneesama Pi response envelope: %w", err)
	}
	if len(completion.Choices) == 0 {
		err := fmt.Errorf("oneesama Pi response contained no choices")
		r.record(start, err)
		return Response{}, err
	}
	content := strings.TrimSpace(completion.Choices[0].Message.Content)
	var decoded Response
	if err := json.Unmarshal([]byte(stripJSONFence(content)), &decoded); err != nil {
		r.record(start, err)
		return Response{}, fmt.Errorf("decode oneesama Pi decision JSON: %w", err)
	}
	decoded = normalizeOneesamaPIResponse(req, decoded, r)
	r.record(start, nil)
	return decoded, nil
}

func (r *OneesamaPIRuntime) Status(context.Context) Status {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Status{
		Provider:      r.provider,
		Mode:          r.mode,
		Healthy:       r.lastError == "",
		Ready:         r.apiKey != "" && r.model != "",
		ShadowOnly:    r.shadowOnly,
		Version:       "oneesama-pi-openai-compatible-v1",
		LastRequestAt: formatTime(r.lastRequestAt),
		LastLatencyMS: r.lastLatency.Milliseconds(),
		LastError:     r.lastError,
		StateSummary: map[string]any{
			"requests": r.requests,
			"model":    r.model,
			"base_url": r.baseURL,
		},
	}
}

func (r *OneesamaPIRuntime) record(start time.Time, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.requests++
	r.lastRequestAt = time.Now().UTC()
	r.lastLatency = time.Since(start)
	if err != nil {
		r.lastError = err.Error()
	} else {
		r.lastError = ""
	}
}

type oneesamaPIChatRequest struct {
	Model          string                  `json:"model"`
	Messages       []oneesamaPIChatMessage `json:"messages"`
	Temperature    float64                 `json:"temperature,omitempty"`
	ResponseFormat map[string]string       `json:"response_format,omitempty"`
}

type oneesamaPIChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type oneesamaPIChatResponse struct {
	Choices []struct {
		Message oneesamaPIChatMessage `json:"message"`
	} `json:"choices"`
}

func oneesamaPISystemPrompt(req Request) string {
	return strings.TrimSpace(`You are the dedicated Oneesama Pi agent for Slack foreground triage.

You are Oneesama's own Slack foreground Pi agent. Never emit private transport or memory markers such as [[MSG_BREAK]], [[MSGBREAK]], [[REACT]], [[WORLD_BRIEF]], or [[KNOWLEDGE_BRIEF]].

Decide exactly one action for this Slack event:
- reply: only when evidence and workspace policy justify a concise, useful Slack-visible reply.
- react: only when a lightweight emoji reaction is enough and reactions are allowed.
- delegate_worker: only for bounded Oneesama secretary work: workspace Memory lookup/synthesis, file/thread retrieval, Canvas or memo preparation, Oneesama's own runtime/code, or explicitly human-authorized code work.
- stay_silent: when the message is already handled, stale, out of scope, unsafe, or low-value.
- memory_write: when the event contains a durable fact/preference worth recording.

Never answer with vague hedging as the main disposition. If your answer would be "maybe / might / seems / 可能 / 大概 / 也许", choose delegate_worker or stay_silent.
Do not delegate arbitrary external project debugging. For staging/production/deploy/infra/database/API latency/CI/performance/code investigation in another project, act like a secretary: reply with a concise routing/owner handoff if useful, or stay silent if already handled.
If you do delegate, include worker_requests[].context.delegation_scope when possible: oneesama_system, oneesama_code, secretary_lookup, or explicit_human_authorized_code.
For link commentary, do not restate the headline. Combine fetched source evidence with workspace Memory/context when available; if that cannot be connected, delegate or stay silent.
Use workspace custom emoji from context when choosing reactions. Do not invent custom emoji names.

Return only one JSON object matching:
{
  "runtime": "oneesama-pi",
  "decision": "reply|react|delegate_worker|stay_silent|memory_write",
  "visible_text": "Slack-visible text, only for reply",
  "reactions": [{"emoji":"emoji_name","reason":"why","confidence":0.8}],
  "worker_requests": [{"kind":"codex","prompt":"specific delegated task","context":{"delegation_scope":"secretary_lookup"}}],
  "memory_writes": [{"kind":"episode|preference|fact|lesson","text":"durable memory","source_ref":"..."}],
  "confidence": 0.0,
  "citations": [{"kind":"memory|link|thread","source_ref":"...","snippet":"..."}],
  "reason": "short private audit reason"
}`)
}

func mustMarshalPersonaRequest(req Request) string {
	payload, err := json.MarshalIndent(req, "", "  ")
	if err != nil {
		return fmt.Sprintf(`{"id":%q,"event":{"text":%q}}`, req.ID, req.Event.Text)
	}
	return string(payload)
}

func stripJSONFence(text string) string {
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(trimmed, "```") {
		trimmed = strings.TrimPrefix(trimmed, "```json")
		trimmed = strings.TrimPrefix(trimmed, "```JSON")
		trimmed = strings.TrimPrefix(trimmed, "```")
		trimmed = strings.TrimSuffix(trimmed, "```")
	}
	return strings.TrimSpace(trimmed)
}

func normalizeOneesamaPIResponse(req Request, resp Response, runtime *OneesamaPIRuntime) Response {
	resp.Runtime = stringOrDefault(resp.Runtime, ProviderOneesamaPi)
	switch resp.Decision {
	case DecisionReply, DecisionReact, DecisionDelegateWorker, DecisionMemoryWrite, DecisionStaySilent:
	default:
		resp.Decision = DecisionStaySilent
	}
	if !req.Safety.AllowVisibleReply && resp.Decision == DecisionReply {
		resp.Decision = DecisionStaySilent
		resp.VisibleText = ""
	}
	if !req.Safety.AllowReactions && resp.Decision == DecisionReact {
		resp.Decision = DecisionStaySilent
		resp.Reactions = nil
	}
	if !req.Safety.AllowWorkerRequest && resp.Decision == DecisionDelegateWorker {
		resp.Decision = DecisionStaySilent
		resp.WorkerRequests = nil
	}
	if resp.Decision == DecisionReply {
		resp.VisibleText = truncateVisibleText(strings.TrimSpace(resp.VisibleText), req.Safety.MaxVisibleChars)
		if resp.VisibleText == "" {
			resp.Decision = DecisionStaySilent
		}
	}
	resp.ShadowOnly = runtime.shadowOnly || strings.EqualFold(req.Mode, ModeShadow)
	return resp
}

func newOneesamaPIRuntimeFromConfig(cfg Config) (Runtime, error) {
	return NewOneesamaPIRuntime(OneesamaPIConfig{
		Provider:   cfg.Provider,
		Mode:       cfg.Mode,
		BaseURL:    cfg.BaseURL,
		Timeout:    cfg.Timeout,
		ShadowOnly: cfg.ShadowOnly,
	})
}
