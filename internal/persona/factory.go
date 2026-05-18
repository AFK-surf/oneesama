package persona

import (
	"fmt"
	"strings"
	"time"
)

type Config struct {
	Provider   string
	Mode       string
	BaseURL    string
	Timeout    time.Duration
	ShadowOnly bool
}

func NewRuntime(cfg Config) (Runtime, error) {
	provider := NormalizeProvider(cfg.Provider)
	mode := NormalizeMode(cfg.Mode)
	shadowOnly := cfg.ShadowOnly || mode != ModeLive
	switch provider {
	case "", ProviderLegacy:
		return NewLegacyRuntime(LocalConfig{Provider: ProviderLegacy, Mode: mode, ShadowOnly: shadowOnly}), nil
	case ProviderFake:
		return NewFakeRuntime(LocalConfig{Provider: ProviderFake, Mode: mode, ShadowOnly: shadowOnly}), nil
	case ProviderHTTP, ProviderPi:
		return NewHTTPRuntime(HTTPConfig{
			Provider:   provider,
			Mode:       mode,
			BaseURL:    cfg.BaseURL,
			Timeout:    cfg.Timeout,
			ShadowOnly: shadowOnly,
		})
	default:
		return nil, fmt.Errorf("persona runtime provider is unsupported: %q", cfg.Provider)
	}
}

func NormalizeProvider(value string) string {
	normalized := strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(value)))
	if normalized == "" {
		return ProviderLegacy
	}
	return normalized
}

func NormalizeMode(value string) string {
	normalized := strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(value)))
	if normalized == "" {
		return ModeShadow
	}
	return normalized
}
