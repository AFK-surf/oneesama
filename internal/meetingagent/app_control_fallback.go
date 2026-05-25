package meetingagent

import (
	"context"
	"strings"
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
	reason := strings.ToLower(strings.TrimSpace(firstNonEmpty(result.Error, result.Blocker)))
	switch reason {
	case "", "kwwk_app_control_unconfigured", "kwwk_app_control_unavailable", "kwwk_app_control_start_failed":
		return true
	}
	return strings.Contains(reason, "unavailable") || strings.Contains(reason, "unconfigured") || strings.Contains(reason, "start")
}
