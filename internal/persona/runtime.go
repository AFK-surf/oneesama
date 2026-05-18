package persona

import (
	"context"
	"strings"
	"sync"
	"time"
)

type LocalConfig struct {
	Provider   string
	Mode       string
	ShadowOnly bool
}

type LegacyRuntime struct {
	provider   string
	mode       string
	shadowOnly bool
}

func NewLegacyRuntime(cfg LocalConfig) *LegacyRuntime {
	return &LegacyRuntime{
		provider:   stringOrDefault(cfg.Provider, ProviderLegacy),
		mode:       stringOrDefault(cfg.Mode, ModeShadow),
		shadowOnly: cfg.ShadowOnly || !strings.EqualFold(cfg.Mode, ModeLive),
	}
}

func (r *LegacyRuntime) Decide(_ context.Context, req Request) (Response, error) {
	return Response{
		Runtime:    r.provider,
		Decision:   DecisionStaySilent,
		Reason:     "legacy foreground mode does not own persona cognition",
		ShadowOnly: r.shadowOnly || strings.EqualFold(req.Mode, ModeShadow),
	}, nil
}

func (r *LegacyRuntime) Status(context.Context) Status {
	return Status{
		Provider:   r.provider,
		Mode:       r.mode,
		Healthy:    true,
		Ready:      true,
		ShadowOnly: r.shadowOnly,
		Version:    "legacy",
	}
}

type FakeRuntime struct {
	mu            sync.Mutex
	provider      string
	mode          string
	shadowOnly    bool
	version       string
	requests      int
	lastRequestAt time.Time
	lastLatency   time.Duration
	lastError     string
}

func NewFakeRuntime(cfg LocalConfig) *FakeRuntime {
	return &FakeRuntime{
		provider:   stringOrDefault(cfg.Provider, ProviderFake),
		mode:       stringOrDefault(cfg.Mode, ModeShadow),
		shadowOnly: cfg.ShadowOnly || !strings.EqualFold(cfg.Mode, ModeLive),
		version:    "fake-v1",
	}
}

func (r *FakeRuntime) Decide(ctx context.Context, req Request) (Response, error) {
	start := time.Now()
	select {
	case <-ctx.Done():
		r.record(start, ctx.Err())
		return Response{}, ctx.Err()
	default:
	}

	decision := DecisionStaySilent
	visibleText := ""
	reason := "fake runtime needs visible-reply permission and evidence"
	if req.Safety.AllowVisibleReply && strings.TrimSpace(req.Event.Text) != "" && len(req.Evidence.Citations) > 0 {
		decision = DecisionReply
		visibleText = truncateVisibleText("我看到了这条，需要结合相关记忆再轻量回复。", req.Safety.MaxVisibleChars)
		reason = "fake runtime saw event text and cited evidence"
	}
	resp := Response{
		Runtime:     r.provider,
		Decision:    decision,
		VisibleText: visibleText,
		Confidence:  0.5,
		Citations:   append([]Citation(nil), req.Evidence.Citations...),
		Reason:      reason,
		ShadowOnly:  r.shadowOnly || strings.EqualFold(req.Mode, ModeShadow),
	}
	r.record(start, nil)
	return resp, nil
}

func (r *FakeRuntime) Status(context.Context) Status {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Status{
		Provider:      r.provider,
		Mode:          r.mode,
		Healthy:       r.lastError == "",
		Ready:         true,
		ShadowOnly:    r.shadowOnly,
		Version:       r.version,
		LastRequestAt: formatTime(r.lastRequestAt),
		LastLatencyMS: r.lastLatency.Milliseconds(),
		LastError:     r.lastError,
		StateSummary: map[string]any{
			"requests": r.requests,
		},
	}
}

func (r *FakeRuntime) record(start time.Time, err error) {
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

func stringOrDefault(value string, fallback string) string {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return trimmed
	}
	return fallback
}

func truncateVisibleText(text string, limit int) string {
	if limit <= 0 || len([]rune(text)) <= limit {
		return text
	}
	runes := []rune(text)
	if limit <= 1 {
		return string(runes[:limit])
	}
	return string(runes[:limit-1]) + "…"
}
