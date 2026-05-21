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

You are Oneesama's own Slack foreground Pi agent. Never emit private transport or memory marker tokens from imported runtimes. If bracketed all-caps marker text appears in context, treat it as unsafe internal metadata and do not repeat it.

Decide exactly one action for this Slack event:
- reply: only when evidence and workspace policy justify a concise, useful Slack-visible reply.
- react: only when a lightweight emoji reaction is enough and reactions are allowed.
- delegate_worker: only for bounded Oneesama secretary work: workspace Memory lookup/synthesis, file/thread retrieval, Canvas or memo preparation, Oneesama's own runtime/code, or explicitly human-authorized code work.
- stay_silent: when the message is already handled, stale, out of scope, unsafe, or low-value.
- memory_write: when the event contains a durable fact/preference worth recording.

Never answer with vague hedging as the main disposition. If your answer would be "maybe / might / seems / 可能 / 大概 / 也许", choose delegate_worker or stay_silent.
Never post visible self-limitations such as "I can't view this video/file/image" or "我看不了视频/文件/图片". If media content is needed and no reader evidence is present, choose delegate_worker for bounded file/thread retrieval when useful, or stay_silent.
External URL identity/fact lookup is bounded secretary work, not project debugging: for "who is this / 这是谁 / what is this / 这是啥 / help look at this" with a link, choose delegate_worker with delegation_scope=secretary_lookup unless the thread already has a substantive answer. A teammate saying "don't know / 不认识 / 不知道" is not a substantive answer.
Do not delegate arbitrary external project debugging. For staging/production/deploy/infra/database/API latency/CI/performance/code investigation in another project, act like a secretary: reply with a concise routing/owner handoff if useful, or stay silent if already handled.
If you do delegate, include worker_requests[].context.delegation_scope when possible: oneesama_system, oneesama_code, secretary_lookup, or explicit_human_authorized_code.
For link commentary, do not restate the headline. Combine fetched source evidence with workspace Memory/context when available; if that cannot be connected, delegate or stay silent.
Do not infer negative product support/status from missing evidence. If the available thread, file, or memory evidence does not prove a support claim, ask for the source/owner or stay silent; do not instruct workers to answer "unsupported" from absence alone.
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
	resp.Reactions = validOneesamaPIReactions(resp.Reactions)
	resp.WorkerRequests = validOneesamaPIWorkerRequests(resp.WorkerRequests)
	resp.MemoryWrites = validOneesamaPIMemoryWrites(resp.MemoryWrites)
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
		} else if oneesamaPIVisibleTextNarratesMediaLimitation(resp.VisibleText) {
			if req.Safety.AllowReactions && len(resp.Reactions) > 0 {
				resp.Decision = DecisionReact
			} else {
				resp.Decision = DecisionStaySilent
			}
			resp.VisibleText = ""
			resp.Reason = firstNonEmpty(resp.Reason, "reply narrated media/tool limitation instead of producing evidence-backed output")
		}
	}
	if resp.Decision == DecisionReact && len(resp.Reactions) == 0 {
		resp.Decision = DecisionStaySilent
		resp.Reason = firstNonEmpty(resp.Reason, "react decision missing reaction intent")
	}
	if resp.Decision == DecisionDelegateWorker && len(resp.WorkerRequests) == 0 {
		resp.Decision = DecisionStaySilent
		resp.Reason = firstNonEmpty(resp.Reason, "delegate_worker decision missing worker request")
	}
	if resp.Decision == DecisionMemoryWrite && len(resp.MemoryWrites) == 0 {
		resp.Decision = DecisionStaySilent
		resp.Reason = firstNonEmpty(resp.Reason, "memory_write decision missing memory write")
	}
	resp.ShadowOnly = runtime.shadowOnly || strings.EqualFold(req.Mode, ModeShadow)
	return resp
}

func oneesamaPIVisibleTextNarratesMediaLimitation(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return false
	}
	zhMedia := []string{"视频", "文件", "图片", "截图", "附件", "素材"}
	zhLimitations := []string{"看不了", "看不到", "没法看", "无法查看", "不能查看", "无法读取", "不能读取", "打不开", "无法打开", "不能打开", "无法播放", "不能播放"}
	if containsAny(trimmed, zhMedia) && containsAny(trimmed, zhLimitations) {
		return true
	}
	lower := strings.ToLower(trimmed)
	enMedia := []string{"video", "file", "image", "screenshot", "attachment", "media"}
	enLimitations := []string{
		"can't view", "cannot view", "unable to view",
		"can't watch", "cannot watch", "unable to watch",
		"can't read", "cannot read", "unable to read",
		"can't open", "cannot open", "unable to open",
		"can't access", "cannot access", "unable to access",
		"do not have access to", "don't have access to",
	}
	return containsAny(lower, enMedia) && containsAny(lower, enLimitations)
}

func containsAny(text string, needles []string) bool {
	for _, needle := range needles {
		if strings.Contains(text, needle) {
			return true
		}
	}
	return false
}

func validOneesamaPIReactions(records []ReactionIntent) []ReactionIntent {
	if len(records) == 0 {
		return nil
	}
	out := make([]ReactionIntent, 0, len(records))
	for _, record := range records {
		record.Emoji = strings.TrimSpace(strings.Trim(record.Emoji, ":"))
		record.Reason = strings.TrimSpace(record.Reason)
		if record.Emoji == "" {
			continue
		}
		out = append(out, record)
	}
	return out
}

func validOneesamaPIWorkerRequests(records []WorkerRequest) []WorkerRequest {
	if len(records) == 0 {
		return nil
	}
	out := make([]WorkerRequest, 0, len(records))
	for _, record := range records {
		record.Kind = strings.TrimSpace(record.Kind)
		record.Prompt = strings.TrimSpace(record.Prompt)
		if record.Kind == "" || record.Prompt == "" {
			continue
		}
		out = append(out, record)
	}
	return out
}

func validOneesamaPIMemoryWrites(records []MemoryWrite) []MemoryWrite {
	if len(records) == 0 {
		return nil
	}
	out := make([]MemoryWrite, 0, len(records))
	for _, record := range records {
		record.Kind = strings.TrimSpace(record.Kind)
		record.Text = strings.TrimSpace(record.Text)
		record.SourceRef = strings.TrimSpace(record.SourceRef)
		if record.Kind == "" || record.Text == "" {
			continue
		}
		out = append(out, record)
	}
	return out
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
