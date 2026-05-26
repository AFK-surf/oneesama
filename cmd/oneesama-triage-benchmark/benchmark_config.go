package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/slackagent"
)

func resolveChannels(ctx context.Context, channels string, token string, stderr io.Writer) ([]string, error) {
	requested := splitCSV(channels)
	if len(requested) == 0 {
		return nil, fmt.Errorf("--channel must not be empty")
	}
	hasAuto := false
	hasExplicit := false
	for _, value := range requested {
		if strings.EqualFold(value, "auto") {
			hasAuto = true
		} else {
			hasExplicit = true
		}
	}
	if hasAuto && hasExplicit {
		return nil, fmt.Errorf("--channel cannot mix 'auto' with explicit ids")
	}
	if !hasAuto {
		return requested, nil
	}
	channelsFound, err := slackagent.ListBackfillJoinedChannels(ctx, token)
	if err != nil {
		return nil, fmt.Errorf("--channel auto: %w", err)
	}
	if len(channelsFound) == 0 {
		return nil, fmt.Errorf("--channel auto discovered 0 joined channels")
	}
	out := make([]string, 0, len(channelsFound))
	for _, ch := range channelsFound {
		out = append(out, ch.ID)
	}
	fmt.Fprintf(stderr, "oneesama-triage-benchmark: --channel auto discovered %d channel(s)\n", len(out))
	return out, nil
}

func resolveBenchmarkWindow(since time.Duration, rawAfter string, rawBefore string, now time.Time) (time.Duration, time.Time, string, error) {
	rawAfter = strings.TrimSpace(rawAfter)
	rawBefore = strings.TrimSpace(rawBefore)
	if rawAfter == "" && rawBefore == "" {
		return since, now, since.String(), nil
	}
	before := now
	if rawBefore != "" {
		parsed, err := parseBenchmarkTime(rawBefore)
		if err != nil {
			return 0, time.Time{}, "", fmt.Errorf("--before: %w", err)
		}
		before = parsed
	}
	after := before.Add(-since)
	if rawAfter != "" {
		parsed, err := parseBenchmarkTime(rawAfter)
		if err != nil {
			return 0, time.Time{}, "", fmt.Errorf("--after: %w", err)
		}
		after = parsed
	}
	if !before.After(after) {
		return 0, time.Time{}, "", fmt.Errorf("--before must be after --after")
	}
	return before.Sub(after), before, after.Format(time.RFC3339) + ".." + before.Format(time.RFC3339), nil
}

func parseBenchmarkTime(raw string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, fmt.Errorf("time is empty")
	}
	layouts := []string{
		time.RFC3339,
		"2006-01-02 15:04",
		"2006-01-02 15:04:05",
		"2006-01-02T15:04",
		"2006-01-02T15:04:05",
	}
	for _, layout := range layouts {
		if layout == time.RFC3339 {
			if parsed, err := time.Parse(layout, raw); err == nil {
				return parsed, nil
			}
			continue
		}
		if parsed, err := time.ParseInLocation(layout, raw, time.FixedZone("Asia/Shanghai", 8*60*60)); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("unsupported time %q", raw)
}

func newBenchmarkSummary() benchmarkSummary {
	return benchmarkSummary{
		ByFinalDecision:      map[string]int{},
		ByPersonaDecision:    map[string]int{},
		ByVisibleReplyReason: map[string]int{},
		ByPipelineSmell:      map[string]int{},
		ByFixtureLabel:       map[string]int{},
		ByFixtureOutcome:     map[string]int{},
		ByGoldStatus:         map[string]int{},
		ByJudgeVerdict:       map[string]int{},
		ByJudgeFlag:          map[string]int{},
	}
}

func loadBenchmarkVariants(inputs []string, defaultID string) ([]benchmarkVariant, error) {
	paths, err := expandConfigPaths(inputs)
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return []benchmarkVariant{{VariantID: firstNonEmpty(defaultID, "current")}}, nil
	}
	var out []benchmarkVariant
	for _, path := range paths {
		variants, err := readBenchmarkVariantConfig(path)
		if err != nil {
			return nil, err
		}
		out = append(out, variants...)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("config-set produced 0 variants")
	}
	seen := map[string]int{}
	for i := range out {
		out[i].VariantID = strings.TrimSpace(out[i].VariantID)
		if out[i].VariantID == "" {
			out[i].VariantID = strings.TrimSuffix(filepath.Base(out[i].SourcePath), filepath.Ext(out[i].SourcePath))
		}
		if out[i].VariantID == "" {
			out[i].VariantID = fmt.Sprintf("variant_%d", i+1)
		}
		seen[out[i].VariantID]++
		if seen[out[i].VariantID] > 1 {
			out[i].VariantID = fmt.Sprintf("%s_%d", out[i].VariantID, seen[out[i].VariantID])
		}
	}
	return out, nil
}

func expandConfigPaths(inputs []string) ([]string, error) {
	var out []string
	for _, input := range inputs {
		input = strings.TrimSpace(input)
		if input == "" {
			continue
		}
		if info, err := os.Stat(input); err == nil && info.IsDir() {
			entries, err := os.ReadDir(input)
			if err != nil {
				return nil, fmt.Errorf("read config-set dir %s: %w", input, err)
			}
			for _, entry := range entries {
				if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".json") {
					continue
				}
				out = append(out, filepath.Join(input, entry.Name()))
			}
			continue
		}
		matches, err := filepath.Glob(input)
		if err != nil {
			return nil, fmt.Errorf("config-set glob %q: %w", input, err)
		}
		if len(matches) == 0 {
			out = append(out, input)
			continue
		}
		out = append(out, matches...)
	}
	sort.Strings(out)
	return uniqueStrings(out), nil
}

func readBenchmarkVariantConfig(path string) ([]benchmarkVariant, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config-set %s: %w", path, err)
	}
	var variants []benchmarkVariant
	if err := json.Unmarshal(data, &variants); err == nil && len(variants) > 0 {
		for i := range variants {
			variants[i].SourcePath = path
		}
		return variants, nil
	}
	var wrapper struct {
		Variants    []benchmarkVariant `json:"variants"`
		VariantID   string             `json:"variantId"`
		ID          string             `json:"id"`
		Description string             `json:"description"`
		Knobs       map[string]any     `json:"knobs"`
	}
	if err := json.Unmarshal(data, &wrapper); err != nil {
		return nil, fmt.Errorf("decode config-set %s: %w", path, err)
	}
	if len(wrapper.Variants) > 0 {
		for i := range wrapper.Variants {
			wrapper.Variants[i].SourcePath = path
		}
		return wrapper.Variants, nil
	}
	return []benchmarkVariant{{
		VariantID:   firstNonEmpty(wrapper.VariantID, wrapper.ID),
		Description: strings.TrimSpace(wrapper.Description),
		Knobs:       wrapper.Knobs,
		SourcePath:  path,
	}}, nil
}
