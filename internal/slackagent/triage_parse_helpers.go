package slackagent

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

func firstSlackTriageJSONObject(raw string) (map[string]any, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, false
	}
	candidates := []string{raw}
	if match := regexp.MustCompile("(?is)```(?:json)?\\s*([\\s\\S]*?)```").FindStringSubmatch(raw); len(match) > 1 {
		candidates = append(candidates, strings.TrimSpace(match[1]))
	}
	start, end := strings.Index(raw, "{"), strings.LastIndex(raw, "}")
	if start >= 0 && end > start {
		candidates = append(candidates, raw[start:end+1])
	}
	for _, candidate := range candidates {
		var decoded map[string]any
		if err := json.Unmarshal([]byte(candidate), &decoded); err == nil {
			return decoded, true
		}
	}
	return nil, false
}

func clampFloat(value float64, min float64, max float64, fallback float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func numberFromAny(value any, fallback float64) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case json.Number:
		if parsed, err := typed.Float64(); err == nil {
			return parsed
		}
	case string:
		if parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64); err == nil {
			return parsed
		}
	}
	return fallback
}

func boolFromAny(value any, fallback bool) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "1", "true", "yes", "y", "on":
			return true
		case "0", "false", "no", "n", "off":
			return false
		}
	}
	return fallback
}
