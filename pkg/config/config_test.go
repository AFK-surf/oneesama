package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadUsesDefaultsWithoutConfigFile(t *testing.T) {
	clearAmbientEnvOverrides(t)
	t.Setenv(oneesamaConfigEnvOverrideKey, "")
	t.Setenv("ONEESAMA_SLACK_LISTEN", "")
	t.Setenv("ONEESAMA_MEETING_LISTEN", "")
	t.Setenv("ONEESAMA_LOG_LEVEL", "")
	t.Setenv("ONEESAMA_LOG_FORMAT", "")

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
	if cfg.SlackAgent.Listen != defaultSlackListen {
		t.Fatalf("SlackAgent.Listen = %q, want %q", cfg.SlackAgent.Listen, defaultSlackListen)
	}
	if cfg.MeetingAgent.Listen != defaultMeetingListen {
		t.Fatalf("MeetingAgent.Listen = %q, want %q", cfg.MeetingAgent.Listen, defaultMeetingListen)
	}
	if cfg.Slack.SigningSecret != "" {
		t.Fatalf("Slack.SigningSecret = %q, want empty default", cfg.Slack.SigningSecret)
	}
	if cfg.Persistence.Provider != defaultPersistenceProvider {
		t.Fatalf("Persistence.Provider = %q, want %q", cfg.Persistence.Provider, defaultPersistenceProvider)
	}
	if cfg.Persistence.DataDir != defaultPersistenceDataDir {
		t.Fatalf("Persistence.DataDir = %q, want %q", cfg.Persistence.DataDir, defaultPersistenceDataDir)
	}
	wantSQLitePath := filepath.Join(defaultPersistenceDataDir, defaultPersistenceSQLiteFile)
	if cfg.Persistence.SQLitePath != wantSQLitePath {
		t.Fatalf("Persistence.SQLitePath = %q, want %q", cfg.Persistence.SQLitePath, wantSQLitePath)
	}
	if cfg.Meetd.WatchInterval != defaultMeetdWatch {
		t.Fatalf("Meetd.WatchInterval = %s, want %s", cfg.Meetd.WatchInterval, defaultMeetdWatch)
	}
	if cfg.Meetd.WebhookURL != "http://127.0.0.1:8780/webhooks/meeting-result" {
		t.Fatalf("Meetd.WebhookURL = %q, want local slack-agent webhook", cfg.Meetd.WebhookURL)
	}
	if len(cfg.Meetd.WebhookSecret) != 64 {
		t.Fatalf("Meetd.WebhookSecret length = %d, want 64 hex chars", len(cfg.Meetd.WebhookSecret))
	}
	data, err := os.ReadFile(filepath.Join(defaultPersistenceDataDir, meetdInternalSecretsFile))
	if err != nil {
		t.Fatalf("read generated secret file: %v", err)
	}
	var secrets runtimeSecrets
	if err := json.Unmarshal(data, &secrets); err != nil {
		t.Fatalf("decode generated secret file: %v", err)
	}
	if secrets.MeetdWebhookSecret != cfg.Meetd.WebhookSecret {
		t.Fatalf("generated secret = %q, want loaded secret", secrets.MeetdWebhookSecret)
	}
}

func TestLoadHonorsConfigPathOverride(t *testing.T) {
	clearAmbientEnvOverrides(t)
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "override.json")
	if err := os.WriteFile(configPath, []byte(`{
  "slack_agent": {"listen": ":19080"},
  "meeting_agent": {"listen": ":19081"},
  "slack": {"signing_secret": "cfg-secret", "bot_token": "cfg-token", "app_token": "cfg-app-token", "client_id": "cfg-client-id", "client_secret": "cfg-client-secret", "redirect_uri": "https://oneesama.example.com/slack/oauth", "workspace_dir": "./workspace", "internal_auth_key": "cfg-auth-key", "public_base_url": "https://oneesama.example.com", "event_buffer": {"enabled": true, "triage": true, "max_batch": 3, "debounce": "4s"}, "triage": {"post_actions": false, "heuristic_fallback": false}, "memory": {"enabled": true, "dir": "./memory-seed"}},
  "meetd": {"watch_interval": "2m", "webhook_url": "https://oneesama.example.com/meeting-webhook", "webhook_secret": "cfg-meetd-secret", "summary_model": "summary-file-model", "calibrate_model": "calibrate-file-model", "asr_provider": "gemini", "asr_model": "asr-file-model", "asr_language": "zh", "gemini_asr_model": "gemini-file-model"},
  "openai": {"api_key": "cfg-openai-key", "base_url": "https://openai.example.com/v1/", "audio_transcriptions_url": "https://openai.example.com/v1/audio/transcriptions-custom", "realtime_model": "gpt-realtime-2-test", "realtime_reasoning_effort": "medium", "realtime_voice": "verse", "realtime_turn_detection": "server_vad", "realtime_session_schema": "legacy", "realtime_personality_context": "local context", "bot_name": "Onee-sama", "current_user_name": "Peng", "current_user_email": "peng@example.com"},
  "dialog": {"stt_provider": "event", "tts_provider": "command", "tts_voice": "local", "tts_command": "say-json", "tts_http_url": "http://127.0.0.1:9001/tts"},
  "logging": {"level": "debug", "format": "text"},
  "paths": {"meet_runner_dir": "./custom-meet-runner"},
  "persistence": {"provider": "sqlite", "data_dir": "./state", "sqlite_path": "./state/custom.sqlite3"}
}`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	t.Setenv(oneesamaConfigEnvOverrideKey, configPath)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ConfigFilePath != configPath {
		t.Fatalf("ConfigFilePath = %q, want %q", cfg.ConfigFilePath, configPath)
	}
	if cfg.Logging.Format != "text" {
		t.Fatalf("Logging.Format = %q, want %q", cfg.Logging.Format, "text")
	}
	if cfg.Persistence.Provider != "sqlite" {
		t.Fatalf("Persistence.Provider = %q, want %q", cfg.Persistence.Provider, "sqlite")
	}
	if cfg.Persistence.SQLitePath != "./state/custom.sqlite3" {
		t.Fatalf("Persistence.SQLitePath = %q, want %q", cfg.Persistence.SQLitePath, "./state/custom.sqlite3")
	}
	if cfg.Slack.SigningSecret != "cfg-secret" {
		t.Fatalf("Slack.SigningSecret = %q, want %q", cfg.Slack.SigningSecret, "cfg-secret")
	}
	if cfg.Slack.AppToken != "cfg-app-token" {
		t.Fatalf("Slack.AppToken = %q, want %q", cfg.Slack.AppToken, "cfg-app-token")
	}
	if cfg.Slack.ClientID != "cfg-client-id" {
		t.Fatalf("Slack.ClientID = %q, want %q", cfg.Slack.ClientID, "cfg-client-id")
	}
	if cfg.Slack.ClientSecret != "cfg-client-secret" {
		t.Fatalf("Slack.ClientSecret = %q, want %q", cfg.Slack.ClientSecret, "cfg-client-secret")
	}
	if cfg.Slack.RedirectURI != "https://oneesama.example.com/slack/oauth" {
		t.Fatalf("Slack.RedirectURI = %q, want %q", cfg.Slack.RedirectURI, "https://oneesama.example.com/slack/oauth")
	}
	if cfg.Slack.WorkspaceDir != "./workspace" {
		t.Fatalf("Slack.WorkspaceDir = %q, want %q", cfg.Slack.WorkspaceDir, "./workspace")
	}
	if cfg.Slack.InternalAuthKey != "cfg-auth-key" {
		t.Fatalf("Slack.InternalAuthKey = %q, want %q", cfg.Slack.InternalAuthKey, "cfg-auth-key")
	}
	if cfg.Slack.PublicBaseURL != "https://oneesama.example.com" {
		t.Fatalf("Slack.PublicBaseURL = %q, want %q", cfg.Slack.PublicBaseURL, "https://oneesama.example.com")
	}
	if cfg.Meetd.WatchInterval != 2*time.Minute {
		t.Fatalf("Meetd.WatchInterval = %s, want 2m", cfg.Meetd.WatchInterval)
	}
	if cfg.Meetd.WebhookURL != "https://oneesama.example.com/meeting-webhook" {
		t.Fatalf("Meetd.WebhookURL = %q, want config value", cfg.Meetd.WebhookURL)
	}
	if cfg.Meetd.WebhookSecret != "cfg-meetd-secret" {
		t.Fatalf("Meetd.WebhookSecret = %q, want config value", cfg.Meetd.WebhookSecret)
	}
	if cfg.Meetd.SummaryModel != "summary-file-model" || cfg.Meetd.CalibrateModel != "calibrate-file-model" {
		t.Fatalf("Meetd summary models = %#v, want config values", cfg.Meetd)
	}
	if cfg.Meetd.ASRProvider != "gemini" || cfg.Meetd.ASRModel != "asr-file-model" || cfg.Meetd.ASRLanguage != "zh" || cfg.Meetd.GeminiASRModel != "gemini-file-model" {
		t.Fatalf("Meetd ASR = %#v, want config values", cfg.Meetd)
	}
	if cfg.OpenAI.APIKey != "cfg-openai-key" {
		t.Fatalf("OpenAI.APIKey = %q, want config value", cfg.OpenAI.APIKey)
	}
	if cfg.OpenAI.BaseURL != "https://openai.example.com/v1" {
		t.Fatalf("OpenAI.BaseURL = %q, want trimmed config value", cfg.OpenAI.BaseURL)
	}
	if cfg.OpenAI.AudioTranscriptionsURL != "https://openai.example.com/v1/audio/transcriptions-custom" {
		t.Fatalf("OpenAI.AudioTranscriptionsURL = %q, want config value", cfg.OpenAI.AudioTranscriptionsURL)
	}
	if cfg.OpenAI.RealtimeClientSecretsURL != "https://openai.example.com/v1/realtime/client_secrets" {
		t.Fatalf("OpenAI.RealtimeClientSecretsURL = %q, want derived URL", cfg.OpenAI.RealtimeClientSecretsURL)
	}
	if cfg.OpenAI.RealtimeSDPURL != "https://openai.example.com/v1/realtime/calls" {
		t.Fatalf("OpenAI.RealtimeSDPURL = %q, want derived URL", cfg.OpenAI.RealtimeSDPURL)
	}
	if cfg.OpenAI.RealtimeModel != "gpt-realtime-2-test" || cfg.OpenAI.RealtimeVoice != "verse" {
		t.Fatalf("OpenAI realtime = %#v, want config values", cfg.OpenAI)
	}
	if cfg.OpenAI.CurrentUserName != "Peng" || cfg.OpenAI.CurrentUserEmail != "peng@example.com" {
		t.Fatalf("OpenAI current user = %#v, want config values", cfg.OpenAI)
	}
	if cfg.Dialog.TTSProvider != "command" || cfg.Dialog.TTSCommand != "say-json" || cfg.Dialog.TTSHTTPURL != "http://127.0.0.1:9001/tts" {
		t.Fatalf("Dialog = %#v, want config values", cfg.Dialog)
	}
	if !cfg.Slack.EventBuffer.Enabled || !cfg.Slack.EventBuffer.Triage {
		t.Fatalf("Slack.EventBuffer = %#v, want enabled triage", cfg.Slack.EventBuffer)
	}
	if cfg.Slack.EventBuffer.MaxBatch != 3 || cfg.Slack.EventBuffer.Debounce != 4*time.Second {
		t.Fatalf("Slack.EventBuffer = %#v, want max_batch=3 debounce=4s", cfg.Slack.EventBuffer)
	}
	if cfg.Slack.Triage.PostActions || cfg.Slack.Triage.HeuristicFallback {
		t.Fatalf("Slack.Triage = %#v, want file false overrides", cfg.Slack.Triage)
	}
	if !cfg.Slack.Memory.Enabled || cfg.Slack.Memory.Dir != "./memory-seed" {
		t.Fatalf("Slack.Memory = %#v, want enabled dir", cfg.Slack.Memory)
	}
}

func TestLoadReusesGeneratedMeetdWebhookSecret(t *testing.T) {
	clearAmbientEnvOverrides(t)
	t.Setenv(oneesamaConfigEnvOverrideKey, "")

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

	first, err := Load()
	if err != nil {
		t.Fatalf("first Load() error = %v", err)
	}
	second, err := Load()
	if err != nil {
		t.Fatalf("second Load() error = %v", err)
	}
	if first.Meetd.WebhookSecret == "" || first.Meetd.WebhookSecret != second.Meetd.WebhookSecret {
		t.Fatalf("Meetd webhook secrets = %q / %q, want generated secret reused", first.Meetd.WebhookSecret, second.Meetd.WebhookSecret)
	}
}

func clearAmbientEnvOverrides(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"OPENAI_API_KEY",
		"OPENAI_BASE_URL",
		"OPENAI_REALTIME_MODEL",
		"ONEESAMA_OPENAI_API_KEY",
		"MAB_OPENAI_API_KEY",
		"ONEESAMA_OPENAI_AUDIO_TRANSCRIPTIONS_URL",
		"MAB_OPENAI_AUDIO_TRANSCRIPTIONS_URL",
		"ONEESAMA_MEETD_WEBHOOK_URL",
		"MEET_WEBHOOK_URL",
		"MAB_MEET_WEBHOOK_URL",
		"ONEESAMA_MEETD_WEBHOOK_SECRET",
		"MEET_WEBHOOK_SECRET",
		"MAB_MEET_WEBHOOK_SECRET",
		"ONEESAMA_MEETING_SUMMARY_MODEL",
		"ONEESAMA_MEET_SUMMARY_MODEL",
		"MEET_SUMMARY_MODEL",
		"LLM_MODEL",
		"ONEESAMA_MEETING_CALIBRATE_MODEL",
		"ONEESAMA_MEET_CALIBRATE_MODEL",
		"MEET_CALIBRATE_MODEL",
		"ONEESAMA_MEETING_ASR_PROVIDER",
		"MEET_ASR_PROVIDER",
		"MAB_ASR_PROVIDER",
		"ONEESAMA_MEETING_ASR_MODEL",
		"MEET_ASR_MODEL",
		"MAB_ASR_MODEL",
		"ONEESAMA_MEETING_ASR_LANGUAGE",
		"MEET_ASR_LANGUAGE",
		"MAB_ASR_LANGUAGE",
		"GEMINI_API_KEY",
		"ONEESAMA_GEMINI_ASR_MODEL",
		"GEMINI_ASR_MODEL",
		"ONEESAMA_SECRETS_FILE",
		"SLACK_AGENT_CONFIG_FILE",
		"SLACK_AGENT_SECRETS_FILE",
		"ONEESAMA_SLACK_LISTEN",
		"ONEESAMA_SLACK_ADDR",
		"MAB_SLACK_PORT",
		"SCAN_MAX_BATCH",
		"SCAN_DEBOUNCE",
	} {
		t.Setenv(key, "")
	}
}
