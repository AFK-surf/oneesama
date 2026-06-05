package meetingagent

import (
	"context"
	"strings"
	"time"
)

type FallbackAppControlBackend struct {
	primary  AppControlBackend
	fallback AppControlBackend
}

func NewFallbackAppControlBackend(primary AppControlBackend, fallback AppControlBackend) *FallbackAppControlBackend {
	return &FallbackAppControlBackend{primary: primary, fallback: fallback}
}

func (b *FallbackAppControlBackend) Name() string {
	names := make([]string, 0, 2)
	if b != nil && b.primary != nil && strings.TrimSpace(b.primary.Name()) != "" {
		names = append(names, b.primary.Name())
	}
	if b != nil && b.fallback != nil && strings.TrimSpace(b.fallback.Name()) != "" {
		names = append(names, b.fallback.Name())
	}
	if len(names) == 0 {
		return "app_control_fallback"
	}
	return strings.Join(names, "+")
}

func (b *FallbackAppControlBackend) ControlSharedApp(ctx context.Context, req AppControlRequest) (AppControlResult, error) {
	if b == nil || b.primary == nil {
		if b != nil && b.fallback != nil {
			return b.fallback.ControlSharedApp(ctx, req)
		}
		return AppControlResult{OK: false, Provider: "app_control", Status: appControlStatusFailed, Error: "app_control_backend_unavailable"}, nil
	}
	result, err := b.primary.ControlSharedApp(ctx, req)
	if err == nil && !appControlShouldFallback(result) {
		return result, nil
	}
	if b.fallback == nil {
		return result, err
	}
	fallbackResult, fallbackErr := b.fallback.ControlSharedApp(ctx, req)
	if fallbackErr != nil {
		if err != nil {
			return result, err
		}
		return fallbackResult, fallbackErr
	}
	if fallbackResult.Raw == nil {
		fallbackResult.Raw = map[string]any{
			"fallback_from":  result.Provider,
			"fallback_error": firstNonEmpty(result.Error, result.Blocker),
		}
	}
	return fallbackResult, nil
}

func (b *FallbackAppControlBackend) PrewarmAppControl(ctx context.Context, req AppControlPrewarmRequest) AppControlPrewarmResult {
	if b != nil {
		if prewarmer, ok := b.primary.(AppControlPrewarmBackend); ok {
			return prewarmer.PrewarmAppControl(ctx, req)
		}
		if prewarmer, ok := b.fallback.(AppControlPrewarmBackend); ok {
			return prewarmer.PrewarmAppControl(ctx, req)
		}
	}
	now := time.Now().UTC()
	return AppControlPrewarmResult{
		OK:         false,
		Provider:   firstNonEmpty(b.Name(), "app_control"),
		Status:     appControlStatusFailed,
		Error:      "app_control_prewarm_unavailable",
		Blocker:    "app_control_prewarm_unavailable",
		StartedAt:  now,
		FinishedAt: now,
	}
}

func (b *FallbackAppControlBackend) Shutdown(ctx context.Context) error {
	if backend, ok := b.primary.(shutdownRunner); ok {
		if err := backend.Shutdown(ctx); err != nil {
			return err
		}
	}
	if backend, ok := b.fallback.(shutdownRunner); ok {
		return backend.Shutdown(ctx)
	}
	return nil
}

func appControlShouldFallback(result AppControlResult) bool {
	if result.OK {
		return false
	}
	if appControlNeedsBackgroundAgent(result) {
		return true
	}
	reason := strings.ToLower(strings.TrimSpace(firstNonEmpty(result.Error, result.Blocker)))
	switch reason {
	case "kwwk_app_control_unconfigured", "kwwk_app_control_unavailable", "kwwk_app_control_start_failed":
		return true
	}
	return false
}

func appControlNeedsBackgroundAgent(result AppControlResult) bool {
	for _, value := range []string{result.Status, result.Blocker, result.Error} {
		if strings.EqualFold(strings.TrimSpace(value), "needs_background_agent") {
			return true
		}
	}
	return false
}
