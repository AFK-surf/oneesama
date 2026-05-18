package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"
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
		if err := decodeRawConfigStrict(data, &raw); err != nil {
			return Config{}, decorateParseError(resolvedPath, data, err)
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

// decodeRawConfigStrict decodes config JSON with `DisallowUnknownFields` so
// typos (`slcak_agent:` instead of `slack_agent:`) fail loudly instead of
// being silently ignored. Cueboard's old loader used strict unknown-field
// rejection on YAML; we match that contract on JSON.
func decodeRawConfigStrict(data []byte, raw *rawConfig) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(raw); err != nil {
		return err
	}
	// After a successful single-value decode, the next read should
	// return io.EOF. Any other outcome — a real token from a second
	// top-level JSON object, a parse error from stray YAML below, etc.
	// — is trailing content that we want to surface, not silently
	// accept.
	tok, err := dec.Token()
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("unexpected trailing content: %w", err)
	}
	return fmt.Errorf("unexpected trailing content after first JSON object: %v", tok)
}

// decorateParseError adds a YAML-detection hint to JSON parse errors so users
// upgrading from cueboard's YAML loader see an actionable migration message
// instead of a bare `invalid character '-'` style failure.
func decorateParseError(resolvedPath string, data []byte, err error) error {
	base := fmt.Errorf("parse config: %w", err)
	if !looksLikeYAML(data) {
		return base
	}
	suffix := "looks like YAML"
	if strings.TrimSpace(resolvedPath) != "" {
		suffix += fmt.Sprintf(" at %s", resolvedPath)
	}
	suffix += "; run `oneesama-config-migrate --input <yaml> --output <json>` to convert (see docs/config-migrate.md)"
	return fmt.Errorf("%w (%s)", base, suffix)
}

// looksLikeYAML is a heuristic: cueboard YAML configs typically start with
// `---`, contain top-level `slack_agent:` style mappings without surrounding
// braces, or contain comment lines beginning with `#`. JSON never has any of
// those at the top level.
func looksLikeYAML(data []byte) bool {
	trimmed := bytes.TrimLeftFunc(data, unicode.IsSpace)
	if len(trimmed) == 0 {
		return false
	}
	if bytes.HasPrefix(trimmed, []byte("---")) {
		return true
	}
	// JSON must start with `{`, `[`, or a quoted/numeric/keyword literal.
	first := rune(trimmed[0])
	if first == '{' || first == '[' || first == '"' || first == '-' || first == 't' || first == 'f' || first == 'n' || (first >= '0' && first <= '9') {
		return false
	}
	if first == '#' {
		return true
	}
	// Lines like `slack_agent:` with no leading brace are YAML.
	if idx := bytes.IndexByte(trimmed, ':'); idx > 0 && idx < 64 {
		head := trimmed[:idx]
		if isYAMLKey(head) {
			return true
		}
	}
	return false
}

func isYAMLKey(head []byte) bool {
	for _, b := range head {
		switch {
		case b >= 'a' && b <= 'z':
		case b >= 'A' && b <= 'Z':
		case b >= '0' && b <= '9':
		case b == '_' || b == '-':
		default:
			return false
		}
	}
	return len(head) > 0
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
