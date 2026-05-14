package config

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

func loadSecretsFile() (string, error) {
	path := strings.TrimSpace(getenv(oneesamaSecretsEnvOverrideKey, "SLACK_AGENT_SECRETS_FILE"))
	if path == "" {
		return "", nil
	}
	if err := loadEnvFileIntoEnv(path); err != nil {
		return "", err
	}
	return path, nil
}

func loadEnvFileIntoEnv(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open env file %s: %w", path, err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for lineNo := 1; scanner.Scan(); lineNo++ {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return fmt.Errorf("parse env file %s:%d: expected KEY=VALUE", path, lineNo)
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key == "" {
			return fmt.Errorf("parse env file %s:%d: empty key", path, lineNo)
		}
		if len(value) >= 2 {
			if strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) {
				value = strings.TrimSuffix(strings.TrimPrefix(value, `"`), `"`)
			} else if strings.HasPrefix(value, "'") && strings.HasSuffix(value, "'") {
				value = strings.TrimSuffix(strings.TrimPrefix(value, "'"), "'")
			}
		}
		if existing, exists := os.LookupEnv(key); exists && strings.TrimSpace(existing) != "" {
			continue
		}
		if err := os.Setenv(key, value); err != nil {
			return fmt.Errorf("set env %s from %s: %w", key, path, err)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("scan env file %s: %w", path, err)
	}
	return nil
}
