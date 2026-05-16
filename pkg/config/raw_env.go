package config

import (
	"os"
	"strings"
)

func applyCoreEnvOverrides(cfg *Config) {
	if value := strings.TrimSpace(getenv("ONEESAMA_SLACK_LISTEN", "ONEESAMA_SLACK_ADDR")); value != "" {
		cfg.SlackAgent.Listen = value
	} else if value := legacyPortListen("MAB_SLACK_PORT"); value != "" {
		cfg.SlackAgent.Listen = value
	}

	if value := strings.TrimSpace(getenv("ONEESAMA_MEETING_LISTEN", "ONEESAMA_MEETING_ADDR")); value != "" {
		cfg.MeetingAgent.Listen = value
	} else if value := legacyPortListen("MAB_MEETING_PORT"); value != "" {
		cfg.MeetingAgent.Listen = value
	}

	if value := strings.TrimSpace(getenv("ONEESAMA_ALLOWED_ORIGINS")); value != "" {
		cfg.SlackAgent.AllowedOrigins = parseCSV(value)
		cfg.MeetingAgent.AllowedOrigins = parseCSV(value)
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_SLACK_ALLOWED_ORIGINS")); value != "" {
		cfg.SlackAgent.AllowedOrigins = parseCSV(value)
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_MEETING_ALLOWED_ORIGINS")); value != "" {
		cfg.MeetingAgent.AllowedOrigins = parseCSV(value)
	}
}

func applySlackEnvOverrides(cfg *Config) {
	if value := strings.TrimSpace(getenv("ONEESAMA_SLACK_SIGNING_SECRET", "SLACK_SIGNING_SECRET", "MAB_SLACK_SIGNING_SECRET")); value != "" {
		cfg.Slack.SigningSecret = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_SLACK_BOT_TOKEN", "SLACK_BOT_TOKEN", "MAB_SLACK_BOT_TOKEN")); value != "" {
		cfg.Slack.BotToken = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_SLACK_APP_TOKEN", "SLACK_APP_TOKEN", "MAB_SLACK_APP_TOKEN")); value != "" {
		cfg.Slack.AppToken = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_SLACK_BOT_USER_ID", "SLACK_BOT_USER_ID", "MAB_SLACK_BOT_USER_ID")); value != "" {
		cfg.Slack.BotUserID = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_SLACK_CLIENT_ID", "SLACK_CLIENT_ID", "MAB_SLACK_CLIENT_ID")); value != "" {
		cfg.Slack.ClientID = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_SLACK_CLIENT_SECRET", "SLACK_CLIENT_SECRET", "MAB_SLACK_CLIENT_SECRET")); value != "" {
		cfg.Slack.ClientSecret = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_SLACK_REDIRECT_URI", "SLACK_REDIRECT_URI", "MAB_SLACK_REDIRECT_URI")); value != "" {
		cfg.Slack.RedirectURI = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_SLACK_WORKSPACE_DIR", "MAB_SLACK_WORKSPACE_DIR")); value != "" {
		cfg.Slack.WorkspaceDir = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_INTERNAL_AUTH_KEY", "MAB_INTERNAL_AUTH_KEY")); value != "" {
		cfg.Slack.InternalAuthKey = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_PUBLIC_BASE_URL", "MAB_PUBLIC_BASE_URL")); value != "" {
		cfg.Slack.PublicBaseURL = value
	}
}

func applySlackEventBufferEnvOverrides(cfg *Config) {
	if value, ok := getenvBool("ONEESAMA_SLACK_EVENT_BUFFER", "MAB_SLACK_EVENT_BUFFER"); ok {
		cfg.Slack.EventBuffer.Enabled = value
	}
	if value, ok := getenvBool("ONEESAMA_SLACK_EVENT_TRIAGE", "MAB_SLACK_EVENT_TRIAGE"); ok {
		cfg.Slack.EventBuffer.Triage = value
	}
	if value, ok := getenvInt("ONEESAMA_SLACK_EVENT_MAX_BATCH", "MAB_SLACK_EVENT_MAX_BATCH", "SCAN_MAX_BATCH"); ok {
		cfg.Slack.EventBuffer.MaxBatch = value
	}
	if value, ok := getenvDuration("ONEESAMA_SLACK_EVENT_DEBOUNCE", "MAB_SLACK_EVENT_DEBOUNCE", "SCAN_DEBOUNCE"); ok {
		cfg.Slack.EventBuffer.Debounce = value
	}
}

func applySlackTriageEnvOverrides(cfg *Config) {
	if value, ok := getenvBool("ONEESAMA_SLACK_TRIAGE_POST_ACTIONS", "MAB_SLACK_TRIAGE_POST_ACTIONS"); ok {
		cfg.Slack.Triage.PostActions = value
	}
	if value, ok := getenvBool("ONEESAMA_SLACK_TRIAGE_HEURISTIC_FALLBACK", "MAB_SLACK_TRIAGE_HEURISTIC_FALLBACK"); ok {
		cfg.Slack.Triage.HeuristicFallback = value
	}
}

func applySlackMemoryEnvOverrides(cfg *Config) {
	if value, ok := getenvBool("ONEESAMA_SLACK_MEMORY_ENABLED", "MAB_SLACK_MEMORY_ENABLED"); ok {
		cfg.Slack.Memory.Enabled = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_SLACK_MEMORY_DIR", "MAB_SLACK_MEMORY_DIR")); value != "" {
		cfg.Slack.Memory.Dir = value
	}
}

func applyMeetdEnvOverrides(cfg *Config) {
	if value, ok := getenvDuration("ONEESAMA_MEETD_WATCH_INTERVAL", "MEET_WATCH_INTERVAL", "MAB_MEET_WATCH_INTERVAL"); ok {
		cfg.Meetd.WatchInterval = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_MEETD_WEBHOOK_URL", "MEET_WEBHOOK_URL", "MAB_MEET_WEBHOOK_URL")); value != "" {
		cfg.Meetd.WebhookURL = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_MEETD_WEBHOOK_SECRET", "MEET_WEBHOOK_SECRET", "MAB_MEET_WEBHOOK_SECRET")); value != "" {
		cfg.Meetd.WebhookSecret = value
	}
	if value, ok := getenvBool("ONEESAMA_CAPTURE_CAPTIONS", "MAB_CAPTURE_CAPTIONS", "MAB_ENABLE_CAPTIONS"); ok {
		cfg.Meetd.CaptureCaptions = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CAPTION_LANGUAGE", "MAB_CAPTION_LANGUAGE")); value != "" {
		cfg.Meetd.CaptionLanguage = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_MEETING_SUMMARY_MODEL", "ONEESAMA_MEET_SUMMARY_MODEL", "MEET_SUMMARY_MODEL", "LLM_MODEL")); value != "" {
		cfg.Meetd.SummaryModel = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_MEETING_CALIBRATE_MODEL", "ONEESAMA_MEET_CALIBRATE_MODEL", "MEET_CALIBRATE_MODEL")); value != "" {
		cfg.Meetd.CalibrateModel = value
	}
	if strings.TrimSpace(cfg.Meetd.CalibrateModel) == "" {
		cfg.Meetd.CalibrateModel = cfg.Meetd.SummaryModel
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_MEETING_ASR_PROVIDER", "MEET_ASR_PROVIDER", "MAB_ASR_PROVIDER")); value != "" {
		cfg.Meetd.ASRProvider = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_MEETING_ASR_MODEL", "MEET_ASR_MODEL", "MAB_ASR_MODEL")); value != "" {
		cfg.Meetd.ASRModel = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_MEETING_ASR_LANGUAGE", "MEET_ASR_LANGUAGE", "MAB_ASR_LANGUAGE")); value != "" {
		cfg.Meetd.ASRLanguage = value
	}
	if value := strings.TrimSpace(getenv("GEMINI_API_KEY")); value != "" {
		cfg.Meetd.GeminiAPIKey = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_GEMINI_ASR_MODEL", "GEMINI_ASR_MODEL")); value != "" {
		cfg.Meetd.GeminiASRModel = value
	}
}

func applyOpenAIEnvOverrides(cfg *Config) {
	if value := strings.TrimSpace(getenv("ONEESAMA_OPENAI_API_KEY", "MAB_OPENAI_API_KEY", "OPENAI_API_KEY")); value != "" {
		cfg.OpenAI.APIKey = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_OPENAI_BASE_URL", "MAB_OPENAI_BASE_URL", "OPENAI_BASE_URL")); value != "" {
		cfg.OpenAI.BaseURL = strings.TrimRight(value, "/")
		cfg.OpenAI.RealtimeClientSecretsURL = cfg.OpenAI.BaseURL + "/realtime/client_secrets"
		cfg.OpenAI.RealtimeSDPURL = cfg.OpenAI.BaseURL + "/realtime/calls"
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_OPENAI_AUDIO_TRANSCRIPTIONS_URL", "MAB_OPENAI_AUDIO_TRANSCRIPTIONS_URL")); value != "" {
		cfg.OpenAI.AudioTranscriptionsURL = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_OPENAI_REALTIME_CLIENT_SECRETS_URL", "MAB_OPENAI_REALTIME_CLIENT_SECRETS_URL")); value != "" {
		cfg.OpenAI.RealtimeClientSecretsURL = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_OPENAI_REALTIME_SDP_URL", "MAB_OPENAI_REALTIME_SDP_URL")); value != "" {
		cfg.OpenAI.RealtimeSDPURL = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_OPENAI_REALTIME_MODEL", "MAB_OPENAI_REALTIME_MODEL", "OPENAI_REALTIME_MODEL")); value != "" {
		cfg.OpenAI.RealtimeModel = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_OPENAI_REALTIME_REASONING_EFFORT", "MAB_OPENAI_REALTIME_REASONING_EFFORT")); value != "" {
		cfg.OpenAI.RealtimeReasoningEffort = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_OPENAI_REALTIME_VOICE", "MAB_OPENAI_REALTIME_VOICE")); value != "" {
		cfg.OpenAI.RealtimeVoice = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_OPENAI_REALTIME_TURN_DETECTION", "MAB_OPENAI_REALTIME_TURN_DETECTION")); value != "" {
		cfg.OpenAI.RealtimeTurnDetection = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_OPENAI_REALTIME_SESSION_SCHEMA", "MAB_OPENAI_REALTIME_SESSION_SCHEMA")); value != "" {
		cfg.OpenAI.RealtimeSessionSchema = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_OPENAI_REALTIME_AGENT_RUNTIME", "MAB_OPENAI_REALTIME_AGENT_RUNTIME", "MAB_REALTIME_AGENT_RUNTIME")); value != "" {
		cfg.OpenAI.RealtimeAgentRuntime = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_REALTIME_PERSONALITY_CONTEXT", "MAB_REALTIME_PERSONALITY_CONTEXT")); value != "" {
		cfg.OpenAI.RealtimePersonalityContext = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_BOT_NAME", "MAB_BOT_NAME")); value != "" {
		cfg.OpenAI.BotName = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CURRENT_USER_NAME", "MAB_CURRENT_USER_NAME", "KNOWN_USER")); value != "" {
		cfg.OpenAI.CurrentUserName = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CURRENT_USER_ENGLISH_NAME", "MAB_CURRENT_USER_ENGLISH_NAME")); value != "" {
		cfg.OpenAI.CurrentUserEnglishName = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CURRENT_USER_EMAIL", "MAB_CURRENT_USER_EMAIL")); value != "" {
		cfg.OpenAI.CurrentUserEmail = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CURRENT_USER_LINEAR", "MAB_CURRENT_USER_LINEAR")); value != "" {
		cfg.OpenAI.CurrentUserLinear = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CURRENT_USER_GITHUB", "MAB_CURRENT_USER_GITHUB")); value != "" {
		cfg.OpenAI.CurrentUserGitHub = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CURRENT_USER_ROLE", "MAB_CURRENT_USER_ROLE")); value != "" {
		cfg.OpenAI.CurrentUserRole = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_CURRENT_USER_ALIASES", "MAB_CURRENT_USER_ALIASES")); value != "" {
		cfg.OpenAI.CurrentUserAliases = splitConfigCSV(value)
	}
}

func applyDialogEnvOverrides(cfg *Config) {
	if value := strings.TrimSpace(getenv("ONEESAMA_STT_PROVIDER", "MAB_STT_PROVIDER")); value != "" {
		cfg.Dialog.STTProvider = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_TTS_PROVIDER", "MAB_TTS_PROVIDER")); value != "" {
		cfg.Dialog.TTSProvider = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_TTS_VOICE", "MAB_TTS_VOICE")); value != "" {
		cfg.Dialog.TTSVoice = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_TTS_COMMAND", "MAB_TTS_COMMAND")); value != "" {
		cfg.Dialog.TTSCommand = value
	}
	if value := strings.TrimSpace(getenv("ONEESAMA_TTS_HTTP_URL", "MAB_TTS_HTTP_URL")); value != "" {
		cfg.Dialog.TTSHTTPURL = value
	}
}

func applyLoggingEnvOverrides(cfg *Config) {
	if value := strings.TrimSpace(os.Getenv("ONEESAMA_LOG_LEVEL")); value != "" {
		cfg.Logging.Level = value
	}
	if value := strings.TrimSpace(os.Getenv("ONEESAMA_LOG_FORMAT")); value != "" {
		cfg.Logging.Format = value
	}
}

func applyPathEnvOverrides(cfg *Config) {
	if value := strings.TrimSpace(os.Getenv("ONEESAMA_MEET_RUNNER_DIR")); value != "" {
		cfg.Paths.MeetRunnerDir = value
	}
}

func applyPersistenceEnvOverrides(cfg *Config) {
	provider := strings.TrimSpace(getenv("ONEESAMA_STATE_PROVIDER", "ONEESAMA_PERSISTENCE_PROVIDER", "MAB_STATE_PROVIDER"))
	dataDir := strings.TrimSpace(getenv("ONEESAMA_STATE_DATA_DIR", "ONEESAMA_PERSISTENCE_DATA_DIR", "ONEESAMA_DATA_DIR", "MAB_DATA_DIR"))
	sqlitePath := strings.TrimSpace(getenv("ONEESAMA_STATE_SQLITE_PATH", "ONEESAMA_PERSISTENCE_SQLITE_PATH", "MAB_STATE_SQLITE_PATH"))
	if provider == "" && dataDir == "" && sqlitePath == "" {
		return
	}

	current := cfg.Persistence
	if provider == "" {
		provider = current.Provider
	}
	if dataDir == "" {
		dataDir = current.DataDir
	}
	if sqlitePath == "" {
		if dataDir != current.DataDir {
			sqlitePath = ""
		} else {
			sqlitePath = current.SQLitePath
		}
	}
	cfg.Persistence = buildPersistenceConfig(provider, dataDir, sqlitePath)
}
