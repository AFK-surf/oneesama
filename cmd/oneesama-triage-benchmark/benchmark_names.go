package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/slackagent"
)

func benchmarkGoldReplaySummary(rows []benchmarkRow, gold benchmarkGoldStore) benchmarkSummary {
	summary := newBenchmarkSummary()
	for _, row := range rows {
		applyBenchmarkGold(&row, gold)
		recordGoldSummary(&summary, row)
	}
	return summary
}

func resolveBenchmarkNameMapCachePath(raw string) string {
	if value := strings.TrimSpace(raw); value != "" {
		return value
	}
	if value := strings.TrimSpace(os.Getenv("ONEESAMA_TRIAGE_BENCHMARK_NAME_MAP_CACHE")); value != "" {
		return value
	}
	if workspace := strings.TrimSpace(firstNonEmpty(os.Getenv("ONEESAMA_SLACK_WORKSPACE_DIR"), os.Getenv("MAB_SLACK_WORKSPACE_DIR"))); workspace != "" {
		return filepath.Join(workspace, benchmarkSlackNameCacheRelPath)
	}
	return filepath.Join("runtime", "cache", "slack_name_map.json")
}

func resolveSlackNamesWithCache(ctx context.Context, token string, rows []benchmarkDetailRow, cachePath string, stderr io.Writer) benchmarkNameMap {
	out := benchmarkNameMap{
		Users:    map[string]string{},
		Channels: map[string]string{},
	}
	channelIDs, userIDs := collectSlackNameIDs(rows)
	if cached := loadBenchmarkNameMapCache(cachePath, stderr); cached != nil {
		mergeBenchmarkNameMap(out, *cached)
	}
	mergeBenchmarkSlackChannelCaches(out.Channels, cachePath, stderr)

	missingChannels := missingStringSet(channelIDs, out.Channels)
	missingUsers := missingStringSet(userIDs, out.Users)
	if strings.TrimSpace(token) != "" {
		client := &http.Client{Timeout: 8 * time.Second}
		if len(missingChannels) > 0 {
			channels, err := slackagent.ListBackfillJoinedChannels(ctx, token)
			if err != nil {
				fmt.Fprintf(stderr, "oneesama-triage-benchmark: resolve slack channels: %v\n", err)
			}
			for _, ch := range channels {
				if _, needed := missingChannels[strings.TrimSpace(ch.ID)]; needed && strings.TrimSpace(ch.Name) != "" {
					out.Channels[strings.TrimSpace(ch.ID)] = strings.TrimSpace(ch.Name)
				}
			}
			missingChannels = missingStringSet(channelIDs, out.Channels)
			for id := range missingChannels {
				if name := fetchSlackChannelName(ctx, client, token, id); name != "" {
					out.Channels[id] = name
				}
			}
		}
		if len(missingUsers) > 0 {
			if err := fetchSlackUserNames(ctx, client, token, missingUsers, out.Users); err != nil {
				fmt.Fprintf(stderr, "oneesama-triage-benchmark: resolve slack users.list: %v\n", err)
			}
			missingUsers = missingStringSet(userIDs, out.Users)
			for id := range missingUsers {
				if name := fetchSlackUserName(ctx, client, token, id); name != "" {
					out.Users[id] = name
				}
			}
		}
	}
	saveBenchmarkNameMapCache(cachePath, out, stderr)
	return out
}

func collectSlackNameIDs(rows []benchmarkDetailRow) (map[string]struct{}, map[string]struct{}) {
	channelIDs := map[string]struct{}{}
	userIDs := map[string]struct{}{}
	for _, row := range rows {
		if id := strings.TrimSpace(row.ChannelID); id != "" {
			channelIDs[id] = struct{}{}
		}
		for _, message := range row.Messages {
			for _, id := range []string{message.UserID, message.UserIDSnake, message.User} {
				if value := strings.TrimSpace(id); value != "" {
					userIDs[value] = struct{}{}
				}
			}
			for _, id := range []string{message.ChannelID, message.ChannelIDSnake} {
				if value := strings.TrimSpace(id); value != "" {
					channelIDs[value] = struct{}{}
				}
			}
			collectSlackIDsFromText(message.Text, userIDs, channelIDs)
		}
		if row.DryRun == nil {
			continue
		}
		for _, action := range row.DryRun.ActionsBeforeGate {
			if id := strings.TrimSpace(action.ChannelID); id != "" {
				channelIDs[id] = struct{}{}
			}
			collectSlackIDsFromText(action.Message, userIDs, channelIDs)
			collectSlackIDsFromText(action.Reason, userIDs, channelIDs)
		}
		for _, action := range row.DryRun.ActionsAfterGate {
			if id := strings.TrimSpace(action.ChannelID); id != "" {
				channelIDs[id] = struct{}{}
			}
			collectSlackIDsFromText(action.Message, userIDs, channelIDs)
			collectSlackIDsFromText(action.Reason, userIDs, channelIDs)
		}
		for _, verdict := range row.DryRun.VisibleReplyVerdicts {
			collectSlackIDsFromText(verdict.Message, userIDs, channelIDs)
			collectSlackIDsFromText(verdict.Reason, userIDs, channelIDs)
		}
		collectSlackIDsFromText(row.DryRun.Digest, userIDs, channelIDs)
		collectSlackIDsFromText(row.DryRun.Persona.Reason, userIDs, channelIDs)
		collectSlackIDsFromText(row.DryRun.Persona.VisibleText, userIDs, channelIDs)
		collectSlackIDsFromText(row.DryRun.FinalDecision, userIDs, channelIDs)
		for _, worker := range row.DryRun.WouldDelegateWorkers {
			collectSlackIDsFromText(worker.PromptPreview, userIDs, channelIDs)
			collectSlackIDsFromText(worker.DelegationScope, userIDs, channelIDs)
		}
		for _, result := range row.HistoricalWorkerResults {
			collectSlackIDsFromText(result.TaskPreview, userIDs, channelIDs)
			collectSlackIDsFromText(result.Result, userIDs, channelIDs)
			collectSlackIDsFromText(result.Error, userIDs, channelIDs)
			collectSlackIDsFromText(result.VisibleText, userIDs, channelIDs)
			collectSlackIDsFromText(result.Envelope.Summary, userIDs, channelIDs)
			collectSlackIDsFromText(result.Envelope.Result, userIDs, channelIDs)
			collectSlackIDsFromText(result.Envelope.Error, userIDs, channelIDs)
			for _, anchor := range result.EvidenceAnchors {
				collectSlackIDsFromText(anchor.SourceRef, userIDs, channelIDs)
				collectSlackIDsFromText(anchor.Quote, userIDs, channelIDs)
			}
		}
	}
	return channelIDs, userIDs
}

func loadBenchmarkNameMapCache(cachePath string, stderr io.Writer) *benchmarkNameMap {
	cachePath = strings.TrimSpace(cachePath)
	if cachePath == "" {
		return nil
	}
	raw, err := os.ReadFile(cachePath)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: read name map cache %s: %v\n", cachePath, err)
		}
		return nil
	}
	var cache benchmarkNameMapCache
	if err := json.Unmarshal(raw, &cache); err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: decode name map cache %s: %v\n", cachePath, err)
		return nil
	}
	out := benchmarkNameMap{Users: map[string]string{}, Channels: map[string]string{}}
	mergeBenchmarkNameMap(out, cache.NameMap)
	mergeStringMap(out.Users, cache.Users)
	mergeStringMap(out.Channels, cache.Channels)
	return &out
}

func saveBenchmarkNameMapCache(cachePath string, nameMap benchmarkNameMap, stderr io.Writer) {
	cachePath = strings.TrimSpace(cachePath)
	if cachePath == "" {
		return
	}
	payload := benchmarkNameMapCache{
		Schema:    "oneesama.slack_name_map_cache.v1",
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
		NameMap: benchmarkNameMap{
			Users:    copyStringMap(nameMap.Users),
			Channels: copyStringMap(nameMap.Channels),
		},
		Users:    copyStringMap(nameMap.Users),
		Channels: copyStringMap(nameMap.Channels),
		Metadata: map[string]any{
			"source": "oneesama-triage-benchmark",
		},
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: encode name map cache: %v\n", err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: create name map cache dir %s: %v\n", filepath.Dir(cachePath), err)
		return
	}
	if err := os.WriteFile(cachePath, data, 0o644); err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: write name map cache %s: %v\n", cachePath, err)
	}
}

func mergeBenchmarkNameMap(dst benchmarkNameMap, src benchmarkNameMap) {
	mergeStringMap(dst.Users, src.Users)
	mergeStringMap(dst.Channels, src.Channels)
}

func mergeStringMap(dst map[string]string, src map[string]string) {
	for key, value := range src {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key != "" && value != "" {
			dst[key] = value
		}
	}
}

func copyStringMap(src map[string]string) map[string]string {
	out := make(map[string]string, len(src))
	mergeStringMap(out, src)
	return out
}

func missingStringSet(ids map[string]struct{}, known map[string]string) map[string]struct{} {
	missing := map[string]struct{}{}
	for id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if strings.TrimSpace(known[id]) == "" {
			missing[id] = struct{}{}
		}
	}
	return missing
}

func mergeBenchmarkSlackChannelCaches(channels map[string]string, cachePath string, stderr io.Writer) {
	seen := map[string]struct{}{}
	for _, candidate := range benchmarkSlackChannelCacheCandidates(cachePath) {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		cleaned := filepath.Clean(candidate)
		if _, ok := seen[cleaned]; ok {
			continue
		}
		seen[cleaned] = struct{}{}
		mergeStringMap(channels, readBenchmarkSlackChannelCollection(cleaned, stderr))
	}
}

func benchmarkSlackChannelCacheCandidates(cachePath string) []string {
	var candidates []string
	if workspace := strings.TrimSpace(firstNonEmpty(os.Getenv("ONEESAMA_SLACK_WORKSPACE_DIR"), os.Getenv("MAB_SLACK_WORKSPACE_DIR"))); workspace != "" {
		candidates = append(candidates, filepath.Join(filepath.Dir(workspace), "live-state", "slack_channels.json"))
	}
	if cachePath = strings.TrimSpace(cachePath); cachePath != "" {
		cacheDir := filepath.Dir(cachePath)
		workspaceDir := filepath.Dir(cacheDir)
		runtimeDir := filepath.Dir(workspaceDir)
		candidates = append(candidates,
			filepath.Join(workspaceDir, "live-state", "slack_channels.json"),
			filepath.Join(runtimeDir, "live-state", "slack_channels.json"),
		)
	}
	candidates = append(candidates, filepath.Join("runtime", "live-state", "slack_channels.json"))
	return candidates
}

func readBenchmarkSlackChannelCollection(filePath string, stderr io.Writer) map[string]string {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: read slack channel cache %s: %v\n", filePath, err)
		}
		return nil
	}
	var doc struct {
		Items []struct {
			ID    string `json:"id"`
			Value struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"value"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: decode slack channel cache %s: %v\n", filePath, err)
		return nil
	}
	out := map[string]string{}
	for _, item := range doc.Items {
		id := strings.TrimSpace(firstNonEmpty(item.Value.ID, item.ID))
		name := strings.TrimSpace(item.Value.Name)
		if id != "" && name != "" {
			out[id] = name
		}
	}
	return out
}

func collectSlackIDsFromText(text string, userIDs map[string]struct{}, channelIDs map[string]struct{}) {
	if text == "" {
		return
	}
	for _, match := range slackUserIDPattern.FindAllStringSubmatch(text, -1) {
		if len(match) > 1 && strings.TrimSpace(match[1]) != "" {
			userIDs[match[1]] = struct{}{}
		}
	}
	for _, match := range slackChannelIDPattern.FindAllStringSubmatch(text, -1) {
		if len(match) > 1 && strings.TrimSpace(match[1]) != "" {
			channelIDs[match[1]] = struct{}{}
		}
	}
}

func fetchSlackChannelName(ctx context.Context, client *http.Client, token string, channelID string) string {
	if strings.TrimSpace(channelID) == "" {
		return ""
	}
	var resp struct {
		OK      bool   `json:"ok"`
		Error   string `json:"error,omitempty"`
		Channel struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"channel"`
	}
	if err := slackGetJSON(ctx, client, token, "conversations.info", url.Values{"channel": {channelID}}, &resp); err != nil || !resp.OK {
		return ""
	}
	return strings.TrimSpace(resp.Channel.Name)
}

func fetchSlackUserName(ctx context.Context, client *http.Client, token string, userID string) string {
	if strings.TrimSpace(userID) == "" {
		return ""
	}
	var resp struct {
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
		User  struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Profile struct {
				DisplayName string `json:"display_name"`
				RealName    string `json:"real_name"`
			} `json:"profile"`
		} `json:"user"`
	}
	if err := slackGetJSON(ctx, client, token, "users.info", url.Values{"user": {userID}}, &resp); err != nil || !resp.OK {
		return ""
	}
	if name := strings.TrimSpace(resp.User.Profile.DisplayName); name != "" {
		return name
	}
	if name := strings.TrimSpace(resp.User.Profile.RealName); name != "" {
		return name
	}
	return strings.TrimSpace(resp.User.Name)
}

func fetchSlackUserNames(ctx context.Context, client *http.Client, token string, wanted map[string]struct{}, out map[string]string) error {
	cursor := ""
	for {
		values := url.Values{"limit": {"200"}}
		if cursor != "" {
			values.Set("cursor", cursor)
		}
		var resp struct {
			OK      bool   `json:"ok"`
			Error   string `json:"error,omitempty"`
			Members []struct {
				ID      string `json:"id"`
				Name    string `json:"name"`
				Deleted bool   `json:"deleted"`
				Profile struct {
					DisplayName string `json:"display_name"`
					RealName    string `json:"real_name"`
				} `json:"profile"`
			} `json:"members"`
			ResponseMetadata struct {
				NextCursor string `json:"next_cursor"`
			} `json:"response_metadata"`
		}
		if err := slackGetJSON(ctx, client, token, "users.list", values, &resp); err != nil {
			return err
		}
		if !resp.OK {
			return fmt.Errorf("users.list returned ok=false (%s)", resp.Error)
		}
		for _, member := range resp.Members {
			if _, ok := wanted[member.ID]; !ok {
				continue
			}
			name := strings.TrimSpace(member.Profile.DisplayName)
			if name == "" {
				name = strings.TrimSpace(member.Profile.RealName)
			}
			if name == "" {
				name = strings.TrimSpace(member.Name)
			}
			if name != "" {
				out[member.ID] = name
			}
		}
		next := strings.TrimSpace(resp.ResponseMetadata.NextCursor)
		if next == "" {
			return nil
		}
		cursor = next
	}
}

func slackGetJSON(ctx context.Context, client *http.Client, token string, method string, values url.Values, out any) error {
	base := strings.TrimRight(strings.TrimSpace(slackagent.SlackBackfillLiveBaseURL), "/")
	if base == "" {
		base = "https://slack.com/api"
	}
	endpoint := base + "/" + method
	if encoded := values.Encode(); encoded != "" {
		endpoint += "?" + encoded
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("slack %s HTTP %d", method, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
