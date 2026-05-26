package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func formatSlackDailyReportText(report SlackDailyReport) string {
	var b strings.Builder
	fmt.Fprintf(&b, ":clock6: *今日日记 · %s*\n\n", report.ReportDate)
	if strings.TrimSpace(report.Diary.Intro) != "" {
		fmt.Fprintf(&b, "%s\n", report.Diary.Intro)
	}
	if len(report.Diary.Themes) == 0 {
		b.WriteString("\n*我观察到的主线*\n- 今天没有足够明确的团队工作样本，先不编故事。\n")
	} else {
		b.WriteString("\n*我观察到的主线*\n")
		for _, theme := range report.Diary.Themes {
			if len(theme.Items) == 0 {
				continue
			}
			fmt.Fprintf(&b, "\n*%s*\n", theme.Title)
			for _, item := range theme.Items {
				var prefix []string
				if strings.TrimSpace(item.Channel) != "" {
					prefix = append(prefix, item.Channel)
				}
				if strings.TrimSpace(item.Time) != "" {
					prefix = append(prefix, item.Time)
				}
				if len(prefix) > 0 {
					fmt.Fprintf(&b, "- %s：%s\n", strings.Join(prefix, " · "), item.Text)
				} else {
					fmt.Fprintf(&b, "- %s\n", item.Text)
				}
			}
		}
	}
	if len(report.Diary.Watchlist) > 0 {
		b.WriteString("\n*我会继续留意*\n")
		for _, item := range report.Diary.Watchlist {
			fmt.Fprintf(&b, "- %s\n", item)
		}
	}
	fmt.Fprintf(&b, "\n_基于过去 %.0fh 的可见 Slack / 工具记录整理；没录到的会议不写成一手结论。内部审计计数保留在 daily-report JSON，不在频道里展开。_", report.WindowHours)
	return strings.TrimSpace(b.String())
}

func formatDailyAuditBullets(samples []string) string {
	if len(samples) == 0 {
		return "- none"
	}
	var b strings.Builder
	for _, sample := range samples {
		fmt.Fprintf(&b, "- %s\n", sample)
	}
	return strings.TrimRight(b.String(), "\n")
}

func slackDailyReportEmojiSummary(counts map[string]int, reactionRuns int) string {
	if len(counts) > 0 {
		return formatEmojiCounts(counts)
	}
	if reactionRuns > 0 {
		return "none (standard emoji only)"
	}
	return "none"
}

func (s *Service) dailyReportStatus() SlackDailyReportStatus {
	if s == nil {
		return SlackDailyReportStatus{}
	}
	cfg := s.dailyReportConfig
	status := SlackDailyReportStatus{
		Enabled:          cfg.Enabled,
		ChannelID:        cfg.ChannelID,
		TimeOfDay:        cfg.TimeOfDay,
		Timezone:         cfg.Timezone,
		WindowSeconds:    int64(cfg.Window.Seconds()),
		LegacyDBPath:     cfg.LegacySlackDBPath,
		LegacyArchiveDir: cfg.LegacyTriageArchiveDir,
	}
	if next, err := nextSlackDailyReportRun(timeNow().UTC(), cfg); err == nil {
		status.NextRunAt = next.UTC().Format(time.RFC3339Nano)
	}
	s.dailyReportMu.Lock()
	defer s.dailyReportMu.Unlock()
	status.Running = s.dailyReportCancel != nil
	if !s.dailyReportLastTickAt.IsZero() {
		status.LastTickAt = s.dailyReportLastTickAt.UTC().Format(time.RFC3339Nano)
	}
	if !s.dailyReportLastPostedAt.IsZero() {
		status.LastPostedAt = s.dailyReportLastPostedAt.UTC().Format(time.RFC3339Nano)
	}
	status.LastChannelID = s.dailyReportLastChannel
	status.LastError = s.dailyReportLastError
	status.TicksLastWindow = len(s.dailyReportTicks)
	if status.LastPostedAt == "" && strings.TrimSpace(cfg.ChannelID) != "" && s.dailyReports != nil {
		if _, _, reportDate, err := slackDailyReportWindow(timeNow().UTC(), cfg.Window, cfg.Timezone, ""); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if record, ok, err := s.dailyReports.Get(ctx, dailyReportRecordID(cfg.ChannelID, reportDate)); err == nil && ok {
				status.LastPostedAt = strings.TrimSpace(record.PostedAt)
				status.LastChannelID = strings.TrimSpace(record.ChannelID)
			}
		}
	}
	return status
}

func (s *Service) recordDailyReportTick(now time.Time, channel string, err error) {
	if s == nil {
		return
	}
	if now.IsZero() {
		now = timeNow().UTC()
	}
	cutoff := now.Add(-24 * time.Hour)
	s.dailyReportMu.Lock()
	defer s.dailyReportMu.Unlock()
	s.dailyReportLastTickAt = now.UTC()
	s.dailyReportLastChannel = strings.TrimSpace(channel)
	if err != nil {
		s.dailyReportLastError = err.Error()
	} else {
		s.dailyReportLastError = ""
		s.dailyReportLastPostedAt = now.UTC()
	}
	s.dailyReportTicks = append(s.dailyReportTicks, now.UTC())
	kept := s.dailyReportTicks[:0]
	for _, tick := range s.dailyReportTicks {
		if tick.After(cutoff) || tick.Equal(cutoff) {
			kept = append(kept, tick)
		}
	}
	s.dailyReportTicks = kept
}

func (s *Service) recordDailyReportPost(now time.Time, channel string, err error) {
	if s == nil {
		return
	}
	if now.IsZero() {
		now = timeNow().UTC()
	}
	s.dailyReportMu.Lock()
	defer s.dailyReportMu.Unlock()
	s.dailyReportLastChannel = strings.TrimSpace(channel)
	if err != nil {
		s.dailyReportLastError = err.Error()
		return
	}
	s.dailyReportLastError = ""
	s.dailyReportLastPostedAt = now.UTC()
}

func nextSlackDailyReportRun(now time.Time, cfg appconfig.SlackDailyReportConfig) (time.Time, error) {
	cfg = normalizeSlackDailyReportConfig(cfg)
	loc, err := time.LoadLocation(cfg.Timezone)
	if err != nil {
		return time.Time{}, err
	}
	hour, minute, err := parseSlackDailyReportTimeOfDay(cfg.TimeOfDay)
	if err != nil {
		return time.Time{}, err
	}
	localNow := now.In(loc)
	next := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), hour, minute, 0, 0, loc)
	if !next.After(localNow) {
		next = next.AddDate(0, 0, 1)
	}
	return next.UTC(), nil
}

func parseSlackDailyReportTimeOfDay(value string) (int, int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		value = slackDailyReportDefaultTime
	}
	parsed, err := time.Parse("15:04", value)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid daily report time_of_day %q", value)
	}
	return parsed.Hour(), parsed.Minute(), nil
}

func slackDailyReportWindow(now time.Time, window time.Duration, timezone string, reportDate string) (time.Time, time.Time, string, error) {
	loc, err := time.LoadLocation(stringOrDefaultLocal(timezone, slackDailyReportDefaultTZ))
	if err != nil {
		return time.Time{}, time.Time{}, "", err
	}
	if now.IsZero() {
		now = timeNow().UTC()
	}
	if window <= 0 {
		window = 24 * time.Hour
	}
	if strings.TrimSpace(reportDate) != "" {
		day, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(reportDate), loc)
		if err != nil {
			return time.Time{}, time.Time{}, "", err
		}
		start := day
		end := day.AddDate(0, 0, 1)
		if end.After(now.In(loc)) {
			end = now.In(loc)
		}
		return start.UTC(), end.UTC(), day.Format("2006-01-02"), nil
	}
	end := now.UTC()
	start := end.Add(-window)
	return start, end, end.In(loc).Format("2006-01-02"), nil
}

func dailyReportRecordID(channelID string, reportDate string) string {
	return strings.Join([]string{strings.TrimSpace(channelID), strings.TrimSpace(reportDate)}, ":")
}

func normalizeLegacyTriageTimestamp(value string) string {
	t := parseLegacyTriageTimestamp(value)
	if t.IsZero() {
		return strings.TrimSpace(value)
	}
	return t.UTC().Format(time.RFC3339Nano)
}

func parseLegacyTriageTimestamp(value string) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}
	}
	if t := parseTriageTimestamp(value); !t.IsZero() {
		return t
	}
	layouts := []string{
		"2006-01-02 15:04:05.999999999Z07:00",
		"2006-01-02 15:04:05.999999Z07:00",
		"2006-01-02 15:04:05Z07:00",
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05.999999-07:00",
		"2006-01-02 15:04:05-07:00",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05.999999",
		"2006-01-02 15:04:05",
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, value); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}

func slackDailyReportActionIsReply(action string) bool {
	action = strings.ToLower(strings.TrimSpace(action))
	return action == "post_thread_reply" || action == "chat.postmessage" || action == "post_message" || action == "send_message"
}

func slackDailyReportActionIsReaction(action string) bool {
	action = strings.ToLower(strings.TrimSpace(action))
	return action == "add_reaction" || action == "reactions.add" || action == "slack.addreaction"
}

func slackDailyReportToolCallIsMemoryLookup(call SlackTriageToolCall) bool {
	tool := strings.ToLower(strings.TrimSpace(call.Tool))
	return tool == "memory_search" || tool == "memory_get" || tool == "person_memory"
}

func slackDailyReportToolCallIsExternalSearch(call SlackTriageToolCall) bool {
	tool := strings.ToLower(strings.TrimSpace(call.Tool))
	return tool == "exa_search" || tool == "exa_contents"
}

func slackDailyReportToolCallIsThreadFetch(call SlackTriageToolCall) bool {
	action := strings.ToLower(strings.TrimSpace(call.Action))
	return action == "fetch_thread" || action == "fetch_channel_history" || action == "conversations.replies" || action == "conversations.history"
}

func slackDailyReportExtractEmoji(text string) []string {
	matches := slackEmojiNamePattern.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return nil
	}
	out := make([]string, 0, len(matches))
	for _, match := range matches {
		if len(match) > 1 && strings.TrimSpace(match[1]) != "" {
			out = append(out, strings.Trim(strings.TrimSpace(match[1]), ":"))
		}
	}
	return out
}

func slackDailyReportRunSample(run SlackTriageContext, detail string) string {
	var parts []string
	if channel := slackDailyReportRunChannel(run); channel != "" {
		parts = append(parts, channel)
	}
	if ts := parseTriageTimestamp(run.Timestamp); !ts.IsZero() {
		parts = append(parts, ts.UTC().Format("01-02 15:04Z"))
	}
	detail = truncateSlackContextTextRunes(slackDailyReportVisibleDetail(firstLine(firstNonEmpty(detail, compactTriageSummary(run)))), 180)
	if detail != "" {
		parts = append(parts, detail)
	}
	if len(parts) == 0 {
		return "n/a"
	}
	return strings.Join(parts, " · ")
}

func slackDailyReportVisibleDetail(detail string) string {
	detail = strings.TrimSpace(detail)
	if detail == "" {
		return ""
	}
	replacer := strings.NewReplacer(
		"http://127.0.0.1:8799/persona/decide", "persona runtime request",
		"http://localhost:8799/persona/decide", "persona runtime request",
		"https://127.0.0.1:8799/persona/decide", "persona runtime request",
		"https://localhost:8799/persona/decide", "persona runtime request",
		"127.0.0.1:8799", "persona runtime",
		"localhost:8799", "persona runtime",
		"127.0.0.1", "local runtime",
		"localhost", "local runtime",
	)
	return replacer.Replace(detail)
}

func slackDailyReportRunChannel(run SlackTriageContext) string {
	for _, action := range run.Actions {
		if strings.TrimSpace(action.Channel) != "" {
			return strings.TrimSpace(action.Channel)
		}
	}
	for _, channel := range run.Channels {
		if strings.TrimSpace(channel) != "" {
			return strings.TrimSpace(channel)
		}
	}
	return ""
}

func appendLimitedString(values []string, value string, limit int) []string {
	value = strings.TrimSpace(value)
	if value == "" || limit <= 0 || len(values) >= limit {
		return values
	}
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func truncateSlackContextTextRunes(value string, maxLength int) string {
	value = strings.TrimSpace(value)
	if maxLength <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= maxLength {
		return value
	}
	return string(runes[:maxLength]) + "..."
}

func slackDailyReportPlaceholderSummary(run SlackTriageContext) bool {
	raw := run.Summary + " " + run.Error
	text := strings.ToLower(raw)
	return strings.Contains(text, "short reason for the shadow decision") ||
		strings.Contains(text, "placeholder") ||
		slackDailyReportTodoPlaceholderPattern.MatchString(raw)
}

func slackDailyReportInvalidPersonaJSON(run SlackTriageContext) bool {
	text := strings.ToLower(run.Summary + " " + run.Error)
	return strings.Contains(text, "not valid persona json") || strings.Contains(text, "invalid persona json")
}

func slackDailyReportLowConfidenceNoAction(run SlackTriageContext) bool {
	if run.Mutations > 0 || len(run.Actions) > 0 {
		return false
	}
	raw, ok := mapFromAny(run.Metadata["persona_foreground"])
	if !ok {
		return false
	}
	return float64FromAny(raw["confidence"]) > 0 && float64FromAny(raw["confidence"]) < triageQualityLowConfidenceCeiling
}

func float64FromAny(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case int32:
		return float64(v)
	case json.Number:
		parsed, _ := v.Float64()
		return parsed
	case string:
		parsed, _ := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return parsed
	default:
		return 0
	}
}

func topNStringInt(values map[string]int, limit int) map[string]int {
	if len(values) == 0 || limit <= 0 {
		return nil
	}
	type pair struct {
		Key   string
		Value int
	}
	pairs := make([]pair, 0, len(values))
	for key, value := range values {
		if strings.TrimSpace(key) != "" && value > 0 {
			pairs = append(pairs, pair{Key: key, Value: value})
		}
	}
	sort.SliceStable(pairs, func(i, j int) bool {
		if pairs[i].Value == pairs[j].Value {
			return pairs[i].Key < pairs[j].Key
		}
		return pairs[i].Value > pairs[j].Value
	})
	if len(pairs) > limit {
		pairs = pairs[:limit]
	}
	out := make(map[string]int, len(pairs))
	for _, pair := range pairs {
		out[pair.Key] = pair.Value
	}
	return out
}

func formatEmojiCounts(values map[string]int) string {
	if len(values) == 0 {
		return ""
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf(":%s:×%d", key, values[key]))
	}
	return strings.Join(parts, ", ")
}

func ratioPercent(part int, total int) float64 {
	if total <= 0 {
		return 0
	}
	return float64(part) / float64(total) * 100
}

func stringOrDefaultLocal(value string, fallback string) string {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return trimmed
	}
	return fallback
}
