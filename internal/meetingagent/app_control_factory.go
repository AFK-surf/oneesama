package meetingagent

import (
	"strings"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func NewConfiguredAppControlBackend(cfg appconfig.AppControlConfig, service *Service) AppControlBackend {
	codex := NewCodexAppControlBackend(service)
	codexFallback := cfg.CodexFallback
	if strings.TrimSpace(cfg.Provider) == "" {
		codexFallback = true
	}
	switch appconfig.NormalizeAppControlProvider(cfg.Provider) {
	case "codex":
		return codex
	case "kwwk":
		kwwk := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
			Command: cfg.KWWK.Command,
			Dir:     cfg.KWWK.Dir,
			Timeout: cfg.Timeout,
		})
		if codexFallback {
			return NewFallbackAppControlBackend(kwwk, codex)
		}
		return kwwk
	default:
		return codex
	}
}
