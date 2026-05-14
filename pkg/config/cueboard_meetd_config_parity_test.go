//go:build cueboardparity

package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCueboardParityMeetdModelDefaultsStayConfigOnly(t *testing.T) {
	clearMeetdConfigParityEnv(t)

	cfg := loadInTempDir(t)
	if cfg.Meetd.SummaryModel != "" || cfg.Meetd.CalibrateModel != "" || cfg.Meetd.GeminiASRModel != "" {
		t.Fatalf("Meetd models = %#v, want no hard-coded provider/model defaults", cfg.Meetd)
	}
}

func TestCueboardParityMeetdModelFallbackPrecedence(t *testing.T) {
	clearMeetdConfigParityEnv(t)
	t.Setenv("LLM_MODEL", "summary-fallback-model")

	cfg := loadInTempDir(t)
	if cfg.Meetd.SummaryModel != "summary-fallback-model" {
		t.Fatalf("SummaryModel = %q, want LLM_MODEL fallback", cfg.Meetd.SummaryModel)
	}
	if cfg.Meetd.CalibrateModel != "summary-fallback-model" {
		t.Fatalf("CalibrateModel = %q, want SummaryModel fallback", cfg.Meetd.CalibrateModel)
	}
}

func TestCueboardParityMeetdExplicitModelsOverrideFallback(t *testing.T) {
	clearMeetdConfigParityEnv(t)
	t.Setenv("LLM_MODEL", "summary-fallback-model")
	t.Setenv("MEET_SUMMARY_MODEL", "summary-explicit-model")
	t.Setenv("MEET_CALIBRATE_MODEL", "calibrate-explicit-model")

	cfg := loadInTempDir(t)
	if cfg.Meetd.SummaryModel != "summary-explicit-model" {
		t.Fatalf("SummaryModel = %q, want explicit meeting model", cfg.Meetd.SummaryModel)
	}
	if cfg.Meetd.CalibrateModel != "calibrate-explicit-model" {
		t.Fatalf("CalibrateModel = %q, want explicit calibrate model", cfg.Meetd.CalibrateModel)
	}
}

func TestCueboardParityMeetdWatchIntervalPrefersMeetWatchInterval(t *testing.T) {
	clearMeetdConfigParityEnv(t)
	t.Setenv("MEET_WATCH_INTERVAL", "2m")

	cfg := loadInTempDir(t)
	if cfg.Meetd.WatchInterval != 2*time.Minute {
		t.Fatalf("WatchInterval = %v, want 2m", cfg.Meetd.WatchInterval)
	}
}

func TestCueboardParityMeetdFileAndASREnvConfig(t *testing.T) {
	clearMeetdConfigParityEnv(t)
	dir := t.TempDir()
	configPath := filepath.Join(dir, "oneesama.json")
	if err := os.WriteFile(configPath, []byte(`{
  "meetd": {
    "watch_interval": "2m",
    "summary_model": "summary-file-model",
    "calibrate_model": "calibrate-file-model",
    "asr_provider": "gemini",
    "asr_language": "zh",
    "gemini_asr_model": "gemini-file-model"
  }
}`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	t.Setenv(oneesamaConfigEnvOverrideKey, configPath)
	t.Setenv("GEMINI_API_KEY", "gemini-secret")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Meetd.SummaryModel != "summary-file-model" || cfg.Meetd.CalibrateModel != "calibrate-file-model" {
		t.Fatalf("Meetd summary models = %#v, want config values", cfg.Meetd)
	}
	if cfg.Meetd.ASRProvider != "gemini" || cfg.Meetd.ASRLanguage != "zh" ||
		cfg.Meetd.GeminiASRModel != "gemini-file-model" || cfg.Meetd.GeminiAPIKey != "gemini-secret" {
		t.Fatalf("Meetd ASR = %#v, want config/env values", cfg.Meetd)
	}
}

func clearMeetdConfigParityEnv(t *testing.T) {
	t.Helper()
	clearAmbientEnvOverrides(t)
	for _, key := range []string{
		oneesamaConfigEnvOverrideKey,
		"ONEESAMA_MEETD_WATCH_INTERVAL",
		"MEET_WATCH_INTERVAL",
		"MAB_MEET_WATCH_INTERVAL",
		"ONEESAMA_MEETING_SUMMARY_MODEL",
		"ONEESAMA_MEET_SUMMARY_MODEL",
		"MEET_SUMMARY_MODEL",
		"LLM_MODEL",
		"ONEESAMA_MEETING_CALIBRATE_MODEL",
		"ONEESAMA_MEET_CALIBRATE_MODEL",
		"MEET_CALIBRATE_MODEL",
		"ONEESAMA_MEETING_ASR_PROVIDER",
		"MEET_ASR_PROVIDER",
		"ONEESAMA_MEETING_ASR_LANGUAGE",
		"MEET_ASR_LANGUAGE",
		"GEMINI_API_KEY",
		"ONEESAMA_GEMINI_ASR_MODEL",
		"GEMINI_ASR_MODEL",
	} {
		t.Setenv(key, "")
	}
}
