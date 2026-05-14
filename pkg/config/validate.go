package config

import (
	"errors"
	"fmt"
	"strings"
)

func Validate(cfg Config) error {
	var errs error

	if strings.TrimSpace(cfg.SlackAgent.Listen) == "" {
		errs = errors.Join(errs, errors.New("slack_agent.listen is required"))
	}
	if strings.TrimSpace(cfg.MeetingAgent.Listen) == "" {
		errs = errors.Join(errs, errors.New("meeting_agent.listen is required"))
	}
	if strings.TrimSpace(cfg.Logging.Level) == "" {
		errs = errors.Join(errs, errors.New("logging.level is required"))
	}
	if strings.TrimSpace(cfg.Logging.Format) == "" {
		errs = errors.Join(errs, errors.New("logging.format is required"))
	}
	if strings.TrimSpace(cfg.Paths.MeetRunnerDir) == "" {
		errs = errors.Join(errs, errors.New("paths.meet_runner_dir is required"))
	}
	if err := validatePersistence(cfg.Persistence); err != nil {
		errs = errors.Join(errs, err)
	}
	if err := validateAgentRunner(cfg.AgentRunner); err != nil {
		errs = errors.Join(errs, err)
	}
	if cfg.Meetd.WatchInterval <= 0 {
		errs = errors.Join(errs, errors.New("meetd.watch_interval must be positive"))
	}
	if strings.TrimSpace(cfg.OpenAI.BaseURL) == "" {
		errs = errors.Join(errs, errors.New("openai.base_url is required"))
	}
	if strings.TrimSpace(cfg.OpenAI.RealtimeClientSecretsURL) == "" {
		errs = errors.Join(errs, errors.New("openai.realtime_client_secrets_url is required"))
	}
	if strings.TrimSpace(cfg.OpenAI.RealtimeSDPURL) == "" {
		errs = errors.Join(errs, errors.New("openai.realtime_sdp_url is required"))
	}
	if strings.TrimSpace(cfg.OpenAI.RealtimeModel) == "" {
		errs = errors.Join(errs, errors.New("openai.realtime_model is required"))
	}
	if strings.TrimSpace(cfg.OpenAI.BotName) == "" {
		errs = errors.Join(errs, errors.New("openai.bot_name is required"))
	}
	if strings.TrimSpace(cfg.Dialog.STTProvider) == "" {
		errs = errors.Join(errs, errors.New("dialog.stt_provider is required"))
	}
	if strings.TrimSpace(cfg.Dialog.TTSProvider) == "" {
		errs = errors.Join(errs, errors.New("dialog.tts_provider is required"))
	}
	if strings.TrimSpace(cfg.Dialog.TTSVoice) == "" {
		errs = errors.Join(errs, errors.New("dialog.tts_voice is required"))
	}
	if cfg.Slack.EventBuffer.MaxBatch <= 0 {
		errs = errors.Join(errs, errors.New("slack.event_buffer.max_batch must be positive"))
	}
	if cfg.Slack.EventBuffer.Debounce <= 0 {
		errs = errors.Join(errs, errors.New("slack.event_buffer.debounce must be positive"))
	}

	return errs
}

func validatePersistence(cfg PersistenceConfig) error {
	var errs error
	provider := normalizeProvider(cfg.Provider)

	switch provider {
	case "memory", "json-file", "sqlite":
	default:
		errs = errors.Join(errs, fmt.Errorf("persistence.provider must be one of memory, json-file, sqlite; got %q", cfg.Provider))
	}

	if provider == "json-file" && strings.TrimSpace(cfg.DataDir) == "" {
		errs = errors.Join(errs, errors.New("persistence.data_dir is required for json-file provider"))
	}
	if provider == "sqlite" && strings.TrimSpace(cfg.SQLitePath) == "" {
		errs = errors.Join(errs, errors.New("persistence.sqlite_path is required for sqlite provider"))
	}

	return errs
}

func normalizeProvider(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func validateAgentRunner(cfg AgentRunnerConfig) error {
	var errs error
	provider := normalizeAgentRunnerProvider(cfg.Provider)

	switch provider {
	case "dry-run", "codex", "claude", "claude-code", "ollama", "ollama-http", "local-ollama":
	default:
		errs = errors.Join(errs, fmt.Errorf("agent_runner.provider is unsupported: %q", cfg.Provider))
	}

	if provider == "ollama" || provider == "ollama-http" || provider == "local-ollama" {
		if strings.TrimSpace(cfg.Ollama.BaseURL) == "" {
			errs = errors.Join(errs, errors.New("agent_runner.ollama.base_url is required for ollama provider"))
		}
		if strings.TrimSpace(cfg.Ollama.Model) == "" {
			errs = errors.Join(errs, errors.New("agent_runner.ollama.model is required for ollama provider"))
		}
	}
	if cfg.JobTimeout <= 0 {
		errs = errors.Join(errs, errors.New("agent_runner.job_timeout must be greater than zero"))
	}

	return errs
}
