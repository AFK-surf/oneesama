package config

import "time"

const (
	DefaultPath = "config.json"

	oneesamaConfigEnvOverrideKey  = "ONEESAMA_CONFIG_PATH"
	oneesamaSecretsEnvOverrideKey = "ONEESAMA_SECRETS_FILE"

	defaultSlackListen                      = ":8780"
	defaultMeetingListen                    = ":8781"
	defaultLogLevel                         = "info"
	defaultLogFormat                        = "json"
	defaultMeetRunnerDir                    = "./meet-runner"
	defaultSlackWorkspaceDir                = "./runtime/slack-workspace"
	defaultSlackMemoryDir                   = "./runtime/slack-memory"
	defaultSlackEventMaxBatch               = 10
	defaultSlackEventDebounce               = 5 * time.Minute
	defaultSlackTriagePostActions           = true
	defaultSlackTriageHeuristicFallback     = true
	defaultSlackTriageForegroundChain       = "codex_only"
	defaultSlackMeetingScannerInterval      = time.Minute
	defaultSlackDailyReportTimeOfDay        = "18:00"
	defaultSlackDailyReportTimezone         = "Asia/Shanghai"
	defaultSlackDailyReportWindow           = 24 * time.Hour
	defaultGoogleCalendarID                 = "primary"
	defaultGoogleCalendarAPIBaseURL         = "https://www.googleapis.com/calendar/v3"
	defaultGoogleOAuthTokenURL              = "https://oauth2.googleapis.com/token"
	defaultMeetdWatch                       = time.Minute
	defaultDemoSurfaceMode                  = "off"
	defaultDemoSurfaceAdapter               = "fake"
	defaultDemoSurfaceRootDir               = "./runtime/demo-surfaces"
	defaultDemoSurfaceDryRun                = true
	defaultDemoSurfaceExternalWriteApproval = true
	defaultDemoSurfaceApprovalTokenTTL      = 10 * time.Minute
	defaultOpenAIBaseURL                    = "https://api.openai.com/v1"
	defaultOpenAIRealtimeModel              = "gpt-realtime-2"
	defaultOpenAIRealtimeReasoning          = "high"
	defaultOpenAIRealtimeVoice              = "marin"
	defaultOpenAIRealtimeTurnDetection      = "steady"
	defaultOpenAIRealtimeSessionSchema      = "realtime-2"
	defaultOpenAIRealtimeAgentRuntime       = "agents-sdk"
	defaultOpenAIRealtimeRuntimePlacement   = "sidecar"
	defaultRealtimeBotName                  = "Meeting Avatar Bot"
	defaultSTTProvider                      = "event"
	defaultTTSProvider                      = "tone-wav"
	defaultTTSVoice                         = "default"
	defaultAgentRunner                      = "dry-run"
	defaultAgentJobTimeout                  = 10 * time.Minute
	defaultAppControlProvider               = "kwwk"
	defaultAppControlTimeout                = 15 * time.Second
	defaultAppControlCodexFallback          = false
	defaultPersonaRuntimeProvider           = "legacy"
	defaultPersonaRuntimeMode               = "shadow"
	defaultPersonaRuntimeTimeout            = 90 * time.Second
	defaultCodexBin                         = "codex"
	defaultCodexModel                       = "gpt-5.5"
	defaultClaudeBin                        = "claude"
	defaultClaudeModel                      = "sonnet"
	defaultClaudeReadMode                   = "dontAsk"
	defaultClaudeWriteMode                  = "acceptEdits"
	defaultOllamaBaseURL                    = "http://127.0.0.1:11434"
	defaultOllamaModel                      = "llama3.2"

	defaultPersistenceProvider   = "json-file"
	defaultPersistenceDataDir    = "./runtime/state"
	defaultPersistenceSQLiteFile = "state.sqlite3"
)
