package config

import "time"

const (
	DefaultPath = "config.json"

	oneesamaConfigEnvOverrideKey  = "ONEESAMA_CONFIG_PATH"
	oneesamaSecretsEnvOverrideKey = "ONEESAMA_SECRETS_FILE"

	defaultSlackListen                  = ":8780"
	defaultMeetingListen                = ":8781"
	defaultLogLevel                     = "info"
	defaultLogFormat                    = "json"
	defaultMeetRunnerDir                = "./meet-runner"
	defaultSlackWorkspaceDir            = "./runtime/slack-workspace"
	defaultSlackMemoryDir               = "./runtime/slack-memory"
	defaultSlackEventMaxBatch           = 10
	defaultSlackEventDebounce           = 5 * time.Minute
	defaultSlackTriagePostActions       = true
	defaultSlackTriageHeuristicFallback = true
	defaultSlackMeetingScannerInterval  = time.Minute
	defaultGoogleCalendarID             = "primary"
	defaultGoogleCalendarAPIBaseURL     = "https://www.googleapis.com/calendar/v3"
	defaultGoogleOAuthTokenURL          = "https://oauth2.googleapis.com/token"
	defaultMeetdWatch                   = time.Minute
	defaultOpenAIBaseURL                = "https://api.openai.com/v1"
	defaultOpenAIRealtimeModel          = "gpt-realtime-2"
	defaultOpenAIRealtimeReasoning      = "high"
	defaultOpenAIRealtimeVoice          = "marin"
	defaultOpenAIRealtimeTurnDetection  = "semantic_vad"
	defaultOpenAIRealtimeSessionSchema  = "realtime-2"
	defaultOpenAIRealtimeAgentRuntime   = "agents-sdk"
	defaultRealtimeBotName              = "Meeting Avatar Bot"
	defaultSTTProvider                  = "event"
	defaultTTSProvider                  = "tone-wav"
	defaultTTSVoice                     = "default"
	defaultAgentRunner                  = "dry-run"
	defaultAgentJobTimeout              = 10 * time.Minute
	defaultCodexBin                     = "codex"
	defaultCodexModel                   = "gpt-5.5"
	defaultClaudeBin                    = "claude"
	defaultClaudeModel                  = "sonnet"
	defaultClaudeReadMode               = "dontAsk"
	defaultClaudeWriteMode              = "acceptEdits"
	defaultOllamaBaseURL                = "http://127.0.0.1:11434"
	defaultOllamaModel                  = "llama3.2"

	defaultPersistenceProvider   = "json-file"
	defaultPersistenceDataDir    = "./runtime/state"
	defaultPersistenceSQLiteFile = "state.sqlite3"
)
