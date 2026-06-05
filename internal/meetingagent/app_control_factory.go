package meetingagent

import appconfig "github.com/AFK-surf/oneesama/pkg/config"

func NewConfiguredAppControlBackend(cfg appconfig.AppControlConfig, service *Service) AppControlBackend {
	codex := NewCodexAppControlBackend(service)
	codexFallback := cfg.CodexFallback
	switch appconfig.NormalizeAppControlProvider(cfg.Provider) {
	case "codex":
		return codex
	case "kwwk":
		kwwk := NewKWWKStdioAppControlBackend(KWWKStdioAppControlConfig{
			Command:       cfg.KWWK.Command,
			EnsureCommand: cfg.KWWK.EnsureCommand,
			Dir:           cfg.KWWK.Dir,
			Timeout:       cfg.Timeout,
		})
		if codexFallback {
			return NewFallbackAppControlBackend(kwwk, codex)
		}
		return kwwk
	default:
		return codex
	}
}
