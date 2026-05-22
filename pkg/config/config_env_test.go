package config

import (
	"os"
	"testing"
	"time"
)

func TestLoadHonorsSlackEventBufferEnvOverrides(t *testing.T) {
	t.Setenv(oneesamaConfigEnvOverrideKey, "")
	t.Setenv("ONEESAMA_SLACK_EVENT_BUFFER", "true")
	t.Setenv("ONEESAMA_SLACK_EVENT_TRIAGE", "true")
	t.Setenv("ONEESAMA_SLACK_EVENT_MAX_BATCH", "2")
	t.Setenv("ONEESAMA_SLACK_EVENT_DEBOUNCE", "5s")
	t.Setenv("ONEESAMA_SLACK_TRIAGE_POST_ACTIONS", "false")
	t.Setenv("ONEESAMA_SLACK_TRIAGE_HEURISTIC_FALLBACK", "false")
	t.Setenv("ONEESAMA_SLACK_TRIAGE_WORKSPACE_POLICY", "Reply to source-backed product-adjacent articles in this workspace.")
	t.Setenv("ONEESAMA_SLACK_TRIAGE_FOREGROUND_CHAIN", "pi_first_live")
	t.Setenv("ONEESAMA_SLACK_MEMORY_ENABLED", "true")
	t.Setenv("ONEESAMA_SLACK_MEMORY_DIR", "/tmp/oneesama-slack-memory")
	t.Setenv("ONEESAMA_SLACK_MEMORY_SEMANTIC_ENABLED", "true")
	t.Setenv("ONEESAMA_SLACK_MEMORY_SEMANTIC_INDEX_PATH", "/tmp/oneesama-semantic-memory.json")
	t.Setenv("ONEESAMA_SLACK_DAILY_REPORT_ENABLED", "true")
	t.Setenv("ONEESAMA_SLACK_DAILY_REPORT_CHANNEL", "C_REPORT")
	t.Setenv("ONEESAMA_SLACK_DAILY_REPORT_TIME", "19:30")
	t.Setenv("ONEESAMA_SLACK_DAILY_REPORT_TIMEZONE", "Asia/Tokyo")
	t.Setenv("ONEESAMA_SLACK_DAILY_REPORT_WINDOW", "12h")
	t.Setenv("ONEESAMA_SLACK_DAILY_REPORT_LEGACY_DB_PATH", "/tmp/slackd.sqlite3")
	t.Setenv("ONEESAMA_SLACK_DAILY_REPORT_LEGACY_TRIAGE_ARCHIVE_DIR", "/tmp/slackd-triage")

	cfg := loadInTempDir(t)
	if !cfg.Slack.EventBuffer.Enabled || !cfg.Slack.EventBuffer.Triage {
		t.Fatalf("Slack.EventBuffer = %#v, want enabled triage", cfg.Slack.EventBuffer)
	}
	if cfg.Slack.EventBuffer.MaxBatch != 2 || cfg.Slack.EventBuffer.Debounce != 5*time.Second {
		t.Fatalf("Slack.EventBuffer = %#v, want env max_batch/debounce", cfg.Slack.EventBuffer)
	}
	if cfg.Slack.Triage.PostActions || cfg.Slack.Triage.HeuristicFallback {
		t.Fatalf("Slack.Triage = %#v, want env false overrides", cfg.Slack.Triage)
	}
	if cfg.Slack.Triage.WorkspacePolicy != "Reply to source-backed product-adjacent articles in this workspace." {
		t.Fatalf("Slack.Triage.WorkspacePolicy = %q, want env value", cfg.Slack.Triage.WorkspacePolicy)
	}
	if cfg.Slack.Triage.ForegroundChain != "pi_first_live" {
		t.Fatalf("Slack.Triage.ForegroundChain = %q, want env value", cfg.Slack.Triage.ForegroundChain)
	}
	if !cfg.Slack.Memory.Enabled || cfg.Slack.Memory.Dir != "/tmp/oneesama-slack-memory" {
		t.Fatalf("Slack.Memory = %#v, want env overrides", cfg.Slack.Memory)
	}
	if !cfg.Slack.Memory.SemanticEnabled || cfg.Slack.Memory.SemanticIndexPath != "/tmp/oneesama-semantic-memory.json" {
		t.Fatalf("Slack.Memory = %#v, want semantic env overrides", cfg.Slack.Memory)
	}
	if !cfg.Slack.DailyReport.Enabled || cfg.Slack.DailyReport.ChannelID != "C_REPORT" || cfg.Slack.DailyReport.TimeOfDay != "19:30" || cfg.Slack.DailyReport.Timezone != "Asia/Tokyo" {
		t.Fatalf("Slack.DailyReport = %#v, want env schedule values", cfg.Slack.DailyReport)
	}
	if cfg.Slack.DailyReport.Window != 12*time.Hour || cfg.Slack.DailyReport.LegacySlackDBPath != "/tmp/slackd.sqlite3" || cfg.Slack.DailyReport.LegacyTriageArchiveDir != "/tmp/slackd-triage" {
		t.Fatalf("Slack.DailyReport = %#v, want env window/source values", cfg.Slack.DailyReport)
	}
}

func TestLoadIgnoresLegacySlackEventBufferMillisecondDebounce(t *testing.T) {
	t.Setenv(oneesamaConfigEnvOverrideKey, "")
	t.Setenv("ONEESAMA_SLACK_EVENT_DEBOUNCE", "")
	t.Setenv("MAB_SLACK_EVENT_DEBOUNCE", "")
	t.Setenv("SCAN_DEBOUNCE", "")
	t.Setenv("MAB_SLACK_EVENT_DEBOUNCE_MS", "5000")

	cfg := loadInTempDir(t)
	if cfg.Slack.EventBuffer.Debounce != 5*time.Minute {
		t.Fatalf("Slack.EventBuffer.Debounce = %v, want Cueboard-style default instead of stale _MS override", cfg.Slack.EventBuffer.Debounce)
	}
}

func TestLoadRebuildsSQLitePathWhenDataDirOverrideChanges(t *testing.T) {
	t.Setenv(oneesamaConfigEnvOverrideKey, "")
	t.Setenv("ONEESAMA_STATE_PROVIDER", "")
	t.Setenv("MAB_STATE_PROVIDER", "")
	t.Setenv("ONEESAMA_STATE_SQLITE_PATH", "")
	t.Setenv("MAB_STATE_SQLITE_PATH", "")
	t.Setenv("ONEESAMA_STATE_DATA_DIR", "/tmp/oneesama-state")

	cfg := loadInTempDir(t)
	if cfg.Persistence.DataDir != "/tmp/oneesama-state" {
		t.Fatalf("Persistence.DataDir = %q, want %q", cfg.Persistence.DataDir, "/tmp/oneesama-state")
	}
	if cfg.Persistence.SQLitePath != "/tmp/oneesama-state/state.sqlite3" {
		t.Fatalf("Persistence.SQLitePath = %q, want %q", cfg.Persistence.SQLitePath, "/tmp/oneesama-state/state.sqlite3")
	}
}

func TestLoadHonorsSlackSecretEnvOverrides(t *testing.T) {
	t.Setenv(oneesamaConfigEnvOverrideKey, "")
	t.Setenv("ONEESAMA_SLACK_SIGNING_SECRET", "env-signing-secret")
	t.Setenv("ONEESAMA_SLACK_BOT_TOKEN", "env-bot-token")
	t.Setenv("ONEESAMA_SLACK_APP_TOKEN", "env-app-token")
	t.Setenv("ONEESAMA_SLACK_CLIENT_ID", "env-client-id")
	t.Setenv("ONEESAMA_SLACK_CLIENT_SECRET", "env-client-secret")
	t.Setenv("ONEESAMA_SLACK_REDIRECT_URI", "https://env.oneesama.dev/slack/oauth")
	t.Setenv("ONEESAMA_SLACK_WORKSPACE_DIR", "/tmp/oneesama-slack-workspace")
	t.Setenv("ONEESAMA_INTERNAL_AUTH_KEY", "env-internal-key")
	t.Setenv("ONEESAMA_PUBLIC_BASE_URL", "https://env.oneesama.dev")

	cfg := loadInTempDir(t)
	if cfg.Slack.SigningSecret != "env-signing-secret" {
		t.Fatalf("Slack.SigningSecret = %q, want %q", cfg.Slack.SigningSecret, "env-signing-secret")
	}
	if cfg.Slack.BotToken != "env-bot-token" {
		t.Fatalf("Slack.BotToken = %q, want %q", cfg.Slack.BotToken, "env-bot-token")
	}
	if cfg.Slack.AppToken != "env-app-token" {
		t.Fatalf("Slack.AppToken = %q, want %q", cfg.Slack.AppToken, "env-app-token")
	}
	if cfg.Slack.ClientID != "env-client-id" {
		t.Fatalf("Slack.ClientID = %q, want %q", cfg.Slack.ClientID, "env-client-id")
	}
	if cfg.Slack.ClientSecret != "env-client-secret" {
		t.Fatalf("Slack.ClientSecret = %q, want %q", cfg.Slack.ClientSecret, "env-client-secret")
	}
	if cfg.Slack.RedirectURI != "https://env.oneesama.dev/slack/oauth" {
		t.Fatalf("Slack.RedirectURI = %q, want %q", cfg.Slack.RedirectURI, "https://env.oneesama.dev/slack/oauth")
	}
	if cfg.Slack.WorkspaceDir != "/tmp/oneesama-slack-workspace" {
		t.Fatalf("Slack.WorkspaceDir = %q, want %q", cfg.Slack.WorkspaceDir, "/tmp/oneesama-slack-workspace")
	}
	if cfg.Slack.InternalAuthKey != "env-internal-key" {
		t.Fatalf("Slack.InternalAuthKey = %q, want %q", cfg.Slack.InternalAuthKey, "env-internal-key")
	}
	if cfg.Slack.PublicBaseURL != "https://env.oneesama.dev" {
		t.Fatalf("Slack.PublicBaseURL = %q, want %q", cfg.Slack.PublicBaseURL, "https://env.oneesama.dev")
	}
}

func TestLoadHonorsMeetdEnvOverrides(t *testing.T) {
	t.Setenv(oneesamaConfigEnvOverrideKey, "")
	t.Setenv("MEET_WATCH_INTERVAL", "45s")
	t.Setenv("MEET_WEBHOOK_URL", "https://env.oneesama.dev/meeting-webhook")
	t.Setenv("MEET_WEBHOOK_SECRET", "env-meetd-secret")
	t.Setenv("MAB_CAPTURE_CAPTIONS", "1")
	t.Setenv("MAB_CAPTION_LANGUAGE", "English")
	t.Setenv("LLM_MODEL", "summary-fallback-model")
	t.Setenv("MEET_SUMMARY_MODEL", "summary-env-model")
	t.Setenv("MEET_CALIBRATE_MODEL", "calibrate-env-model")
	t.Setenv("MEET_ASR_PROVIDER", "gemini")
	t.Setenv("MAB_ASR_MODEL", "asr-env-model")
	t.Setenv("MEET_ASR_LANGUAGE", "zh")
	t.Setenv("GEMINI_API_KEY", "gemini-env-key")
	t.Setenv("GEMINI_ASR_MODEL", "gemini-env-model")

	cfg := loadInTempDir(t)
	if cfg.Meetd.WatchInterval != 45*time.Second {
		t.Fatalf("Meetd.WatchInterval = %s, want 45s", cfg.Meetd.WatchInterval)
	}
	if cfg.Meetd.WebhookURL != "https://env.oneesama.dev/meeting-webhook" {
		t.Fatalf("Meetd.WebhookURL = %q, want env value", cfg.Meetd.WebhookURL)
	}
	if cfg.Meetd.WebhookSecret != "env-meetd-secret" {
		t.Fatalf("Meetd.WebhookSecret = %q, want env value", cfg.Meetd.WebhookSecret)
	}
	if !cfg.Meetd.CaptureCaptions || cfg.Meetd.CaptionLanguage != "English" {
		t.Fatalf("Meetd caption config = %#v, want capture captions in English", cfg.Meetd)
	}
	if cfg.Meetd.SummaryModel != "summary-env-model" || cfg.Meetd.CalibrateModel != "calibrate-env-model" {
		t.Fatalf("Meetd summary models = %#v, want explicit env values", cfg.Meetd)
	}
	if cfg.Meetd.ASRProvider != "gemini" || cfg.Meetd.ASRModel != "asr-env-model" || cfg.Meetd.ASRLanguage != "zh" || cfg.Meetd.GeminiAPIKey != "gemini-env-key" || cfg.Meetd.GeminiASRModel != "gemini-env-model" {
		t.Fatalf("Meetd ASR = %#v, want env values", cfg.Meetd)
	}
}

func TestLoadHonorsDemoSurfaceEnvOverrides(t *testing.T) {
	t.Setenv(oneesamaConfigEnvOverrideKey, "")
	t.Setenv("ONEESAMA_DEMO_SURFACE_ENABLED", "true")
	t.Setenv("ONEESAMA_DEMO_SURFACE_ADAPTER", "fake")
	t.Setenv("ONEESAMA_DEMO_SURFACE_ROOT_DIR", "/tmp/oneesama-demo")
	t.Setenv("ONEESAMA_DEMO_SURFACE_URL_ALLOWLIST", "https://example.test/, https://docs.example.test/path")
	t.Setenv("ONEESAMA_DEMO_SURFACE_DRY_RUN", "false")
	t.Setenv("ONEESAMA_DEMO_SURFACE_ALLOW_ACTIVE_CONTROL", "true")
	t.Setenv("ONEESAMA_DEMO_SURFACE_REQUIRE_EXTERNAL_WRITE_APPROVAL", "false")
	t.Setenv("ONEESAMA_DEMO_SURFACE_APPROVAL_TOKEN_TTL", "2m")

	cfg := loadInTempDir(t)
	if !cfg.DemoSurface.Enabled {
		t.Fatal("DemoSurface.Enabled = false, want true")
	}
	if cfg.DemoSurface.Adapter != "fake" || cfg.DemoSurface.RootDir != "/tmp/oneesama-demo" {
		t.Fatalf("DemoSurface adapter/root = %#v, want env values", cfg.DemoSurface)
	}
	if len(cfg.DemoSurface.URLAllowlistPatterns) != 2 || cfg.DemoSurface.URLAllowlistPatterns[0] != "https://example.test/" {
		t.Fatalf("DemoSurface.URLAllowlistPatterns = %#v, want parsed env list", cfg.DemoSurface.URLAllowlistPatterns)
	}
	if cfg.DemoSurface.DryRun || !cfg.DemoSurface.AllowActiveControl {
		t.Fatalf("DemoSurface dry/control = %#v, want dry_run=false active_control=true", cfg.DemoSurface)
	}
	if cfg.DemoSurface.RequireExternalWriteApproval || cfg.DemoSurface.ExternalWriteApprovalTokenTTL != 2*time.Minute {
		t.Fatalf("DemoSurface approval config = %#v, want approval disabled with 2m TTL", cfg.DemoSurface)
	}
}

func TestLoadHonorsDemoSurfaceModePresets(t *testing.T) {
	cases := []struct {
		name              string
		mode              string
		wantEnabled       bool
		wantAdapter       string
		wantDryRun        bool
		wantActiveControl bool
	}{
		{
			name:              "safe",
			mode:              "safe",
			wantEnabled:       true,
			wantAdapter:       "agent_browser",
			wantDryRun:        true,
			wantActiveControl: false,
		},
		{
			name:              "active",
			mode:              "active",
			wantEnabled:       true,
			wantAdapter:       "agent_browser",
			wantDryRun:        false,
			wantActiveControl: true,
		},
		{
			name:              "off",
			mode:              "off",
			wantEnabled:       false,
			wantAdapter:       "fake",
			wantDryRun:        true,
			wantActiveControl: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(oneesamaConfigEnvOverrideKey, "")
			t.Setenv("ONEESAMA_DEMO_SURFACE_MODE", tc.mode)

			cfg := loadInTempDir(t)
			if cfg.DemoSurface.Mode != tc.mode {
				t.Fatalf("DemoSurface.Mode = %q, want %q", cfg.DemoSurface.Mode, tc.mode)
			}
			if cfg.DemoSurface.Enabled != tc.wantEnabled ||
				cfg.DemoSurface.Adapter != tc.wantAdapter ||
				cfg.DemoSurface.DryRun != tc.wantDryRun ||
				cfg.DemoSurface.AllowActiveControl != tc.wantActiveControl {
				t.Fatalf("DemoSurface = %#v, want enabled=%v adapter=%q dryRun=%v active=%v",
					cfg.DemoSurface, tc.wantEnabled, tc.wantAdapter, tc.wantDryRun, tc.wantActiveControl)
			}
		})
	}
}

func TestLoadDemoSurfaceModeKeepsLowLevelOverrides(t *testing.T) {
	t.Setenv(oneesamaConfigEnvOverrideKey, "")
	t.Setenv("ONEESAMA_DEMO_SURFACE_MODE", "safe")
	t.Setenv("ONEESAMA_DEMO_SURFACE_ADAPTER", "fake")
	t.Setenv("ONEESAMA_DEMO_SURFACE_DRY_RUN", "false")

	cfg := loadInTempDir(t)
	if cfg.DemoSurface.Mode != "safe" {
		t.Fatalf("DemoSurface.Mode = %q, want safe", cfg.DemoSurface.Mode)
	}
	if cfg.DemoSurface.Adapter != "fake" || cfg.DemoSurface.DryRun {
		t.Fatalf("DemoSurface = %#v, want low-level env override after mode preset", cfg.DemoSurface)
	}
}

func TestLoadMeetdSummaryModelFallbackStaysEnvOnly(t *testing.T) {
	t.Setenv(oneesamaConfigEnvOverrideKey, "")
	t.Setenv("LLM_MODEL", "summary-fallback-model")
	t.Setenv("MEET_SUMMARY_MODEL", "")
	t.Setenv("MEET_CALIBRATE_MODEL", "")

	cfg := loadInTempDir(t)
	if cfg.Meetd.SummaryModel != "summary-fallback-model" {
		t.Fatalf("Meetd.SummaryModel = %q, want LLM_MODEL fallback", cfg.Meetd.SummaryModel)
	}
	if cfg.Meetd.CalibrateModel != "summary-fallback-model" {
		t.Fatalf("Meetd.CalibrateModel = %q, want summary fallback", cfg.Meetd.CalibrateModel)
	}
}

func TestLoadHonorsOpenAIRealtimeEnvOverrides(t *testing.T) {
	t.Setenv(oneesamaConfigEnvOverrideKey, "")
	t.Setenv("MAB_OPENAI_API_KEY", "env-openai-key")
	t.Setenv("MAB_OPENAI_BASE_URL", "https://env.openai.example/v1/")
	t.Setenv("MAB_OPENAI_AUDIO_TRANSCRIPTIONS_URL", "https://env.openai.example/custom/audio/transcriptions")
	t.Setenv("MAB_OPENAI_REALTIME_CLIENT_SECRETS_URL", "https://env.openai.example/custom/client_secrets")
	t.Setenv("MAB_OPENAI_REALTIME_SDP_URL", "https://env.openai.example/custom/calls")
	t.Setenv("MAB_OPENAI_REALTIME_MODEL", "gpt-realtime-2-env")
	t.Setenv("MAB_OPENAI_REALTIME_REASONING_EFFORT", "medium")
	t.Setenv("MAB_OPENAI_REALTIME_VOICE", "cedar")
	t.Setenv("MAB_OPENAI_REALTIME_TURN_DETECTION", "server_vad")
	t.Setenv("MAB_OPENAI_REALTIME_SESSION_SCHEMA", "legacy")
	t.Setenv("MAB_OPENAI_REALTIME_AGENT_RUNTIME", "raw")
	t.Setenv("MAB_REALTIME_PERSONALITY_CONTEXT", "env personality")
	t.Setenv("MAB_BOT_NAME", "Env Onee-sama")
	t.Setenv("MAB_CURRENT_USER_NAME", "Peng")
	t.Setenv("MAB_CURRENT_USER_ENGLISH_NAME", "Peng Xiao")
	t.Setenv("MAB_CURRENT_USER_EMAIL", "peng@example.com")
	t.Setenv("MAB_CURRENT_USER_LINEAR", "peng-linear")
	t.Setenv("MAB_CURRENT_USER_GITHUB", "peng-gh")
	t.Setenv("MAB_CURRENT_USER_ROLE", "founder")
	t.Setenv("MAB_CURRENT_USER_ALIASES", "彭潇, 肖鹏, Operator")
	t.Setenv("MAB_STT_PROVIDER", "event")
	t.Setenv("MAB_TTS_PROVIDER", "http")
	t.Setenv("MAB_TTS_VOICE", "warm")
	t.Setenv("MAB_TTS_COMMAND", "tts-command")
	t.Setenv("MAB_TTS_HTTP_URL", "http://127.0.0.1:9001/tts")

	cfg := loadInTempDir(t)
	if cfg.OpenAI.APIKey != "env-openai-key" {
		t.Fatalf("OpenAI.APIKey = %q, want env value", cfg.OpenAI.APIKey)
	}
	if cfg.OpenAI.BaseURL != "https://env.openai.example/v1" {
		t.Fatalf("OpenAI.BaseURL = %q, want trimmed env value", cfg.OpenAI.BaseURL)
	}
	if cfg.OpenAI.AudioTranscriptionsURL != "https://env.openai.example/custom/audio/transcriptions" {
		t.Fatalf("OpenAI.AudioTranscriptionsURL = %q, want explicit env value", cfg.OpenAI.AudioTranscriptionsURL)
	}
	if cfg.OpenAI.RealtimeClientSecretsURL != "https://env.openai.example/custom/client_secrets" {
		t.Fatalf("OpenAI.RealtimeClientSecretsURL = %q, want explicit env value", cfg.OpenAI.RealtimeClientSecretsURL)
	}
	if cfg.OpenAI.RealtimeSDPURL != "https://env.openai.example/custom/calls" {
		t.Fatalf("OpenAI.RealtimeSDPURL = %q, want explicit env value", cfg.OpenAI.RealtimeSDPURL)
	}
	if cfg.OpenAI.RealtimeModel != "gpt-realtime-2-env" || cfg.OpenAI.RealtimeReasoningEffort != "medium" || cfg.OpenAI.RealtimeVoice != "cedar" {
		t.Fatalf("OpenAI realtime = %#v, want env values", cfg.OpenAI)
	}
	if cfg.OpenAI.RealtimeTurnDetection != "server_vad" || cfg.OpenAI.RealtimeSessionSchema != "legacy" {
		t.Fatalf("OpenAI realtime = %#v, want env turn/schema", cfg.OpenAI)
	}
	if cfg.OpenAI.RealtimeAgentRuntime != "raw" {
		t.Fatalf("OpenAI.RealtimeAgentRuntime = %q, want env value", cfg.OpenAI.RealtimeAgentRuntime)
	}
	if cfg.OpenAI.RealtimePersonalityContext != "env personality" || cfg.OpenAI.BotName != "Env Onee-sama" {
		t.Fatalf("OpenAI persona = %#v, want env persona", cfg.OpenAI)
	}
	if cfg.OpenAI.CurrentUserName != "Peng" || cfg.OpenAI.CurrentUserEnglishName != "Peng Xiao" || cfg.OpenAI.CurrentUserEmail != "peng@example.com" {
		t.Fatalf("OpenAI current user = %#v, want env identity", cfg.OpenAI)
	}
	if cfg.OpenAI.CurrentUserLinear != "peng-linear" || cfg.OpenAI.CurrentUserGitHub != "peng-gh" || cfg.OpenAI.CurrentUserRole != "founder" {
		t.Fatalf("OpenAI current user = %#v, want env workspace IDs", cfg.OpenAI)
	}
	if len(cfg.OpenAI.CurrentUserAliases) != 3 || cfg.OpenAI.CurrentUserAliases[0] != "彭潇" {
		t.Fatalf("OpenAI current user aliases = %#v, want parsed aliases", cfg.OpenAI.CurrentUserAliases)
	}
	if cfg.Dialog.TTSProvider != "http" || cfg.Dialog.TTSVoice != "warm" || cfg.Dialog.TTSCommand != "tts-command" || cfg.Dialog.TTSHTTPURL != "http://127.0.0.1:9001/tts" {
		t.Fatalf("Dialog = %#v, want env dialog provider values", cfg.Dialog)
	}
}

func loadInTempDir(t *testing.T) Config {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	tempDir := t.TempDir()
	if err := os.Chdir(tempDir); err != nil {
		t.Fatalf("chdir temp: %v", err)
	}
	defer func() {
		if err := os.Chdir(cwd); err != nil {
			t.Fatalf("restore cwd: %v", err)
		}
	}()

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	return cfg
}
