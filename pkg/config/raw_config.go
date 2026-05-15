package config

import (
	"path/filepath"
	"strings"
)

type rawConfig struct {
	SlackAgent   rawServiceConfig `json:"slack_agent"`
	MeetingAgent rawServiceConfig `json:"meeting_agent"`
	Slack        rawSlackConfig   `json:"slack"`
	AgentRunner  rawAgentRunner   `json:"agent_runner"`
	Meetd        rawMeetdConfig   `json:"meetd"`
	OpenAI       rawOpenAIConfig  `json:"openai"`
	Dialog       rawDialogConfig  `json:"dialog"`
	Logging      rawLoggingConfig `json:"logging"`
	Paths        rawPathsConfig   `json:"paths"`
	Persistence  rawPersistence   `json:"persistence"`
}

type rawServiceConfig struct {
	Listen         string   `json:"listen"`
	AllowedOrigins []string `json:"allowed_origins"`
}

type rawLoggingConfig struct {
	Level  string `json:"level"`
	Format string `json:"format"`
}

type rawSlackConfig struct {
	SigningSecret   string                    `json:"signing_secret"`
	BotToken        string                    `json:"bot_token"`
	AppToken        string                    `json:"app_token"`
	BotUserID       string                    `json:"bot_user_id"`
	ClientID        string                    `json:"client_id"`
	ClientSecret    string                    `json:"client_secret"`
	RedirectURI     string                    `json:"redirect_uri"`
	WorkspaceDir    string                    `json:"workspace_dir"`
	InternalAuthKey string                    `json:"internal_auth_key"`
	PublicBaseURL   string                    `json:"public_base_url"`
	EventBuffer     rawSlackEventBufferConfig `json:"event_buffer"`
	Triage          rawSlackTriageConfig      `json:"triage"`
	Memory          rawSlackMemoryConfig      `json:"memory"`
}

type rawSlackEventBufferConfig struct {
	Enabled  bool   `json:"enabled"`
	Triage   bool   `json:"triage"`
	MaxBatch int    `json:"max_batch"`
	Debounce string `json:"debounce"`
}

type rawSlackTriageConfig struct {
	PostActions       *bool `json:"post_actions"`
	HeuristicFallback *bool `json:"heuristic_fallback"`
}

type rawSlackMemoryConfig struct {
	Enabled bool   `json:"enabled"`
	Dir     string `json:"dir"`
}

type rawAgentRunner struct {
	Provider   string                `json:"provider"`
	DryRun     bool                  `json:"dry_run"`
	JobTimeout string                `json:"job_timeout"`
	Codex      rawCodexRunnerConfig  `json:"codex"`
	Claude     rawClaudeRunnerConfig `json:"claude"`
	Ollama     rawOllamaRunnerConfig `json:"ollama"`
}

type rawMeetdConfig struct {
	WatchInterval   string `json:"watch_interval"`
	WebhookURL      string `json:"webhook_url"`
	WebhookSecret   string `json:"webhook_secret"`
	CaptureCaptions bool   `json:"capture_captions"`
	CaptionLanguage string `json:"caption_language"`
	SummaryModel    string `json:"summary_model"`
	CalibrateModel  string `json:"calibrate_model"`
	ASRProvider     string `json:"asr_provider"`
	ASRModel        string `json:"asr_model"`
	ASRLanguage     string `json:"asr_language"`
	GeminiASRModel  string `json:"gemini_asr_model"`
}

type rawOpenAIConfig struct {
	APIKey                     string `json:"api_key"`
	BaseURL                    string `json:"base_url"`
	AudioTranscriptionsURL     string `json:"audio_transcriptions_url"`
	RealtimeClientSecretsURL   string `json:"realtime_client_secrets_url"`
	RealtimeSDPURL             string `json:"realtime_sdp_url"`
	RealtimeModel              string `json:"realtime_model"`
	RealtimeReasoningEffort    string `json:"realtime_reasoning_effort"`
	RealtimeVoice              string `json:"realtime_voice"`
	RealtimeTurnDetection      string `json:"realtime_turn_detection"`
	RealtimeSessionSchema      string `json:"realtime_session_schema"`
	RealtimeAgentRuntime       string `json:"realtime_agent_runtime"`
	RealtimePersonalityContext string `json:"realtime_personality_context"`
	BotName                    string `json:"bot_name"`
	CurrentUserName            string `json:"current_user_name"`
	CurrentUserEnglishName     string `json:"current_user_english_name"`
	CurrentUserEmail           string `json:"current_user_email"`
	CurrentUserLinear          string `json:"current_user_linear"`
	CurrentUserGitHub          string `json:"current_user_github"`
	CurrentUserRole            string `json:"current_user_role"`
}

type rawDialogConfig struct {
	STTProvider string `json:"stt_provider"`
	TTSProvider string `json:"tts_provider"`
	TTSVoice    string `json:"tts_voice"`
	TTSCommand  string `json:"tts_command"`
	TTSHTTPURL  string `json:"tts_http_url"`
}

type rawCodexRunnerConfig struct {
	Bin           string `json:"bin"`
	Model         string `json:"model"`
	Sandbox       string `json:"sandbox"`
	ModelProvider string `json:"model_provider"`
	BaseURL       string `json:"base_url"`
	EnvKey        string `json:"env_key"`
	WireAPI       string `json:"wire_api"`
}

type rawClaudeRunnerConfig struct {
	Bin                 string `json:"bin"`
	Model               string `json:"model"`
	ReadPermissionMode  string `json:"read_permission_mode"`
	WritePermissionMode string `json:"write_permission_mode"`
	MaxBudgetUSD        string `json:"max_budget_usd"`
}

type rawOllamaRunnerConfig struct {
	BaseURL string `json:"base_url"`
	Model   string `json:"model"`
}

type rawPathsConfig struct {
	MeetRunnerDir string `json:"meet_runner_dir"`
}

type rawPersistence struct {
	Provider   string `json:"provider"`
	DataDir    string `json:"data_dir"`
	SQLitePath string `json:"sqlite_path"`
}

func (r rawConfig) toConfig(path string) Config {
	return Config{
		SlackAgent: ServiceConfig{
			Listen:         stringOrDefault(r.SlackAgent.Listen, defaultSlackListen),
			AllowedOrigins: sliceOrDefault(r.SlackAgent.AllowedOrigins, []string{"*"}),
		},
		MeetingAgent: ServiceConfig{
			Listen:         stringOrDefault(r.MeetingAgent.Listen, defaultMeetingListen),
			AllowedOrigins: sliceOrDefault(r.MeetingAgent.AllowedOrigins, []string{"*"}),
		},
		Slack: SlackConfig{
			SigningSecret:   strings.TrimSpace(r.Slack.SigningSecret),
			BotToken:        strings.TrimSpace(r.Slack.BotToken),
			AppToken:        strings.TrimSpace(r.Slack.AppToken),
			BotUserID:       strings.TrimSpace(r.Slack.BotUserID),
			ClientID:        strings.TrimSpace(r.Slack.ClientID),
			ClientSecret:    strings.TrimSpace(r.Slack.ClientSecret),
			RedirectURI:     strings.TrimSpace(r.Slack.RedirectURI),
			WorkspaceDir:    stringOrDefault(r.Slack.WorkspaceDir, defaultSlackWorkspaceDir),
			InternalAuthKey: strings.TrimSpace(r.Slack.InternalAuthKey),
			PublicBaseURL:   strings.TrimSpace(r.Slack.PublicBaseURL),
			EventBuffer: SlackEventBufferConfig{
				Enabled:  r.Slack.EventBuffer.Enabled,
				Triage:   r.Slack.EventBuffer.Triage,
				MaxBatch: intOrDefault(r.Slack.EventBuffer.MaxBatch, defaultSlackEventMaxBatch),
				Debounce: durationOrDefault(r.Slack.EventBuffer.Debounce, defaultSlackEventDebounce),
			},
			Triage: SlackTriageConfig{
				PostActions:       boolPtrOrDefault(r.Slack.Triage.PostActions, defaultSlackTriagePostActions),
				HeuristicFallback: boolPtrOrDefault(r.Slack.Triage.HeuristicFallback, defaultSlackTriageHeuristicFallback),
			},
			Memory: SlackMemoryConfig{
				Enabled: r.Slack.Memory.Enabled,
				Dir:     stringOrDefault(r.Slack.Memory.Dir, defaultSlackMemoryDir),
			},
		},
		AgentRunner: buildAgentRunnerConfig(r.AgentRunner),
		Meetd: MeetdConfig{
			WatchInterval:   durationOrDefault(r.Meetd.WatchInterval, defaultMeetdWatch),
			WebhookURL:      strings.TrimSpace(r.Meetd.WebhookURL),
			WebhookSecret:   strings.TrimSpace(r.Meetd.WebhookSecret),
			CaptureCaptions: r.Meetd.CaptureCaptions,
			CaptionLanguage: strings.TrimSpace(r.Meetd.CaptionLanguage),
			SummaryModel:    strings.TrimSpace(r.Meetd.SummaryModel),
			CalibrateModel:  strings.TrimSpace(r.Meetd.CalibrateModel),
			ASRProvider:     strings.TrimSpace(r.Meetd.ASRProvider),
			ASRModel:        strings.TrimSpace(r.Meetd.ASRModel),
			ASRLanguage:     strings.TrimSpace(r.Meetd.ASRLanguage),
			GeminiASRModel:  strings.TrimSpace(r.Meetd.GeminiASRModel),
		},
		OpenAI: buildOpenAIConfig(r.OpenAI),
		Dialog: DialogConfig{
			STTProvider: stringOrDefault(r.Dialog.STTProvider, defaultSTTProvider),
			TTSProvider: stringOrDefault(r.Dialog.TTSProvider, defaultTTSProvider),
			TTSVoice:    stringOrDefault(r.Dialog.TTSVoice, defaultTTSVoice),
			TTSCommand:  strings.TrimSpace(r.Dialog.TTSCommand),
			TTSHTTPURL:  strings.TrimSpace(r.Dialog.TTSHTTPURL),
		},
		Logging: LoggingConfig{
			Level:  stringOrDefault(r.Logging.Level, defaultLogLevel),
			Format: stringOrDefault(r.Logging.Format, defaultLogFormat),
		},
		Paths: PathsConfig{
			MeetRunnerDir: stringOrDefault(r.Paths.MeetRunnerDir, defaultMeetRunnerDir),
		},
		Persistence: buildPersistenceConfig(
			r.Persistence.Provider,
			r.Persistence.DataDir,
			r.Persistence.SQLitePath,
		),
		ConfigFilePath: path,
	}
}

func applyEnvOverrides(cfg *Config) {
	applyCoreEnvOverrides(cfg)
	applySlackEnvOverrides(cfg)
	applySlackEventBufferEnvOverrides(cfg)
	applySlackTriageEnvOverrides(cfg)
	applySlackMemoryEnvOverrides(cfg)
	applyAgentRunnerEnvOverrides(cfg)
	applyMeetdEnvOverrides(cfg)
	applyOpenAIEnvOverrides(cfg)
	applyDialogEnvOverrides(cfg)
	applyLoggingEnvOverrides(cfg)
	applyPathEnvOverrides(cfg)
	applyPersistenceEnvOverrides(cfg)
}

func stringOrDefault(value string, fallback string) string {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return trimmed
	}
	return fallback
}

func intOrDefault(value int, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}

func boolPtrOrDefault(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func sliceOrDefault(values []string, fallback []string) []string {
	if len(values) == 0 {
		return append([]string(nil), fallback...)
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	if len(out) == 0 {
		return append([]string(nil), fallback...)
	}
	return out
}

func buildPersistenceConfig(provider string, dataDir string, sqlitePath string) PersistenceConfig {
	resolvedDataDir := stringOrDefault(dataDir, defaultPersistenceDataDir)
	resolvedSQLitePath := strings.TrimSpace(sqlitePath)
	if resolvedSQLitePath == "" {
		resolvedSQLitePath = filepath.Join(resolvedDataDir, defaultPersistenceSQLiteFile)
	}

	return PersistenceConfig{
		Provider:   stringOrDefault(provider, defaultPersistenceProvider),
		DataDir:    resolvedDataDir,
		SQLitePath: resolvedSQLitePath,
	}
}

func buildOpenAIConfig(raw rawOpenAIConfig) OpenAIConfig {
	baseURL := strings.TrimRight(stringOrDefault(raw.BaseURL, defaultOpenAIBaseURL), "/")
	clientSecretsURL := strings.TrimSpace(raw.RealtimeClientSecretsURL)
	if clientSecretsURL == "" {
		clientSecretsURL = baseURL + "/realtime/client_secrets"
	}
	sdpURL := strings.TrimSpace(raw.RealtimeSDPURL)
	if sdpURL == "" {
		sdpURL = baseURL + "/realtime/calls"
	}

	return OpenAIConfig{
		APIKey:                     strings.TrimSpace(raw.APIKey),
		BaseURL:                    baseURL,
		AudioTranscriptionsURL:     strings.TrimSpace(raw.AudioTranscriptionsURL),
		RealtimeClientSecretsURL:   clientSecretsURL,
		RealtimeSDPURL:             sdpURL,
		RealtimeModel:              stringOrDefault(raw.RealtimeModel, defaultOpenAIRealtimeModel),
		RealtimeReasoningEffort:    stringOrDefault(raw.RealtimeReasoningEffort, defaultOpenAIRealtimeReasoning),
		RealtimeVoice:              stringOrDefault(raw.RealtimeVoice, defaultOpenAIRealtimeVoice),
		RealtimeTurnDetection:      stringOrDefault(raw.RealtimeTurnDetection, defaultOpenAIRealtimeTurnDetection),
		RealtimeSessionSchema:      stringOrDefault(raw.RealtimeSessionSchema, defaultOpenAIRealtimeSessionSchema),
		RealtimeAgentRuntime:       stringOrDefault(raw.RealtimeAgentRuntime, defaultOpenAIRealtimeAgentRuntime),
		RealtimePersonalityContext: strings.TrimSpace(raw.RealtimePersonalityContext),
		BotName:                    stringOrDefault(raw.BotName, defaultRealtimeBotName),
		CurrentUserName:            strings.TrimSpace(raw.CurrentUserName),
		CurrentUserEnglishName:     strings.TrimSpace(raw.CurrentUserEnglishName),
		CurrentUserEmail:           strings.TrimSpace(raw.CurrentUserEmail),
		CurrentUserLinear:          strings.TrimSpace(raw.CurrentUserLinear),
		CurrentUserGitHub:          strings.TrimSpace(raw.CurrentUserGitHub),
		CurrentUserRole:            strings.TrimSpace(raw.CurrentUserRole),
	}
}
