package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

func Load() (Config, error) {
	secretsPath, err := loadSecretsFile()
	if err != nil {
		return Config{}, err
	}
	data, resolvedPath, err := loadFile()
	if err != nil {
		return Config{}, err
	}

	var raw rawConfig
	if len(data) > 0 {
		if err := json.Unmarshal(data, &raw); err != nil {
			return Config{}, fmt.Errorf("parse config: %w", err)
		}
	}

	cfg := raw.toConfig(resolvedPath)
	cfg.SecretsFilePath = secretsPath
	applyEnvOverrides(&cfg)
	if err := applyDerivedRuntimeDefaults(&cfg); err != nil {
		return Config{}, err
	}
	if err := Validate(cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func loadFile() ([]byte, string, error) {
	resolvedPath := strings.TrimSpace(getenv(oneesamaConfigEnvOverrideKey, "SLACK_AGENT_CONFIG_FILE"))
	explicitPath := resolvedPath != ""
	if resolvedPath == "" {
		resolvedPath = DefaultPath
	}

	data, err := os.ReadFile(resolvedPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) && !explicitPath {
			return nil, "", nil
		}
		return nil, "", fmt.Errorf("read config: %w", err)
	}
	return data, resolvedPath, nil
}

func getenv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func getenvBool(keys ...string) (bool, bool) {
	for _, key := range keys {
		raw := strings.TrimSpace(os.Getenv(key))
		if raw == "" {
			continue
		}
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return false, false
		}
		return value, true
	}
	return false, false
}

func getenvInt(keys ...string) (int, bool) {
	for _, key := range keys {
		raw := strings.TrimSpace(os.Getenv(key))
		if raw == "" {
			continue
		}
		value, err := strconv.Atoi(raw)
		if err != nil {
			return 0, false
		}
		return value, true
	}
	return 0, false
}

func getenvDuration(keys ...string) (time.Duration, bool) {
	for _, key := range keys {
		raw := strings.TrimSpace(os.Getenv(key))
		if raw == "" {
			continue
		}
		value, err := time.ParseDuration(raw)
		if err != nil {
			return 0, false
		}
		return value, true
	}
	return 0, false
}

func legacyPortListen(envKey string) string {
	if value := strings.TrimSpace(os.Getenv(envKey)); value != "" {
		if strings.HasPrefix(value, ":") {
			return value
		}
		return ":" + value
	}
	return ""
}

func parseCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			values = append(values, trimmed)
		}
	}
	if len(values) == 0 {
		return []string{"*"}
	}
	return values
}
