package persona

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

type RuntimeFactory func(Config) (Runtime, error)

type Config struct {
	Provider   string
	Mode       string
	BaseURL    string
	Timeout    time.Duration
	ShadowOnly bool
}

var (
	runtimeFactoryMu sync.RWMutex
	runtimeFactories = map[string]RuntimeFactory{}
)

func init() {
	mustRegisterRuntimeFactory(ProviderLegacy, func(cfg Config) (Runtime, error) {
		return NewLegacyRuntime(LocalConfig{Provider: ProviderLegacy, Mode: cfg.Mode, ShadowOnly: cfg.ShadowOnly}), nil
	})
	mustRegisterRuntimeFactory(ProviderFake, func(cfg Config) (Runtime, error) {
		return NewFakeRuntime(LocalConfig{Provider: ProviderFake, Mode: cfg.Mode, ShadowOnly: cfg.ShadowOnly}), nil
	})
	mustRegisterRuntimeFactory(ProviderHTTP, newHTTPRuntimeFromConfig)
	mustRegisterRuntimeFactory(ProviderPi, newHTTPRuntimeFromConfig)
}

func RegisterRuntimeFactory(provider string, factory RuntimeFactory) error {
	name := NormalizeProvider(provider)
	if factory == nil {
		return fmt.Errorf("persona runtime factory for %q is nil", name)
	}
	runtimeFactoryMu.Lock()
	defer runtimeFactoryMu.Unlock()
	if _, exists := runtimeFactories[name]; exists {
		return fmt.Errorf("persona runtime provider is already registered: %q", name)
	}
	runtimeFactories[name] = factory
	return nil
}

func NewRuntime(cfg Config) (Runtime, error) {
	provider := NormalizeProvider(cfg.Provider)
	mode := NormalizeMode(cfg.Mode)
	shadowOnly := cfg.ShadowOnly || mode != ModeLive
	factory := lookupRuntimeFactory(provider)
	if factory == nil {
		return nil, fmt.Errorf("persona runtime provider is unsupported: %q", cfg.Provider)
	}
	cfg.Provider = provider
	cfg.Mode = mode
	cfg.ShadowOnly = shadowOnly
	return factory(cfg)
}

func NormalizeProvider(value string) string {
	normalized := strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(value)))
	if normalized == "" {
		return ProviderLegacy
	}
	return normalized
}

func lookupRuntimeFactory(provider string) RuntimeFactory {
	runtimeFactoryMu.RLock()
	defer runtimeFactoryMu.RUnlock()
	return runtimeFactories[NormalizeProvider(provider)]
}

func mustRegisterRuntimeFactory(provider string, factory RuntimeFactory) {
	if err := RegisterRuntimeFactory(provider, factory); err != nil {
		panic(err)
	}
}

func newHTTPRuntimeFromConfig(cfg Config) (Runtime, error) {
	return NewHTTPRuntime(HTTPConfig{
		Provider:   cfg.Provider,
		Mode:       cfg.Mode,
		BaseURL:    cfg.BaseURL,
		Timeout:    cfg.Timeout,
		ShadowOnly: cfg.ShadowOnly,
	})
}

func NormalizeMode(value string) string {
	normalized := strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(value)))
	if normalized == "" {
		return ModeShadow
	}
	return normalized
}
