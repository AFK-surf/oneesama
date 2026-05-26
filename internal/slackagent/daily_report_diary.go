package slackagent

import (
	"fmt"
	"html"
	"sort"
	"strings"
	"time"
)

type slackDailyDiaryCandidate struct {
	item  SlackDailyDiaryItem
	theme string
	score int
	at    time.Time
	key   string
}

func buildSlackDailyDiary(newRuns []SlackTriageContext, legacyRuns []SlackTriageContext) SlackDailyDiary {
	diary := SlackDailyDiary{
		Sources: SlackDailyDiarySourceCount{NewRuns: len(newRuns), LegacyRuns: len(legacyRuns)},
	}
	candidates := make([]slackDailyDiaryCandidate, 0, len(newRuns)+len(legacyRuns))
	for _, run := range newRuns {
		if candidate, ok := slackDailyDiaryCandidateForRun(run, "new_oneesama"); ok {
			candidates = append(candidates, candidate)
		}
	}
	for _, run := range legacyRuns {
		if candidate, ok := slackDailyDiaryCandidateForRun(run, "legacy_slackd"); ok {
			candidates = append(candidates, candidate)
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].score == candidates[j].score {
			return candidates[i].at.After(candidates[j].at)
		}
		return candidates[i].score > candidates[j].score
	})
	themeOrder := []string{
		"Oneesama / meeting avatar",
		"Cue / Bridge 工程",
		"Recappi / 音频体验",
		"Bazaar Buddy / simulator",
		"社交自动化 / Linger",
		"团队协作与 review",
	}
	themesByTitle := map[string]*SlackDailyDiaryTheme{}
	seen := map[string]struct{}{}
	for _, candidate := range candidates {
		if len(themesByTitle) >= 5 && themesByTitle[candidate.theme] == nil {
			continue
		}
		if _, ok := seen[candidate.key]; ok {
			continue
		}
		theme := themesByTitle[candidate.theme]
		if theme == nil {
			theme = &SlackDailyDiaryTheme{Title: candidate.theme}
			themesByTitle[candidate.theme] = theme
		}
		if len(theme.Items) >= 3 {
			continue
		}
		theme.Items = append(theme.Items, candidate.item)
		seen[candidate.key] = struct{}{}
	}
	for _, title := range themeOrder {
		if theme := themesByTitle[title]; theme != nil && len(theme.Items) > 0 {
			diary.Themes = append(diary.Themes, *theme)
		}
	}
	for title, theme := range themesByTitle {
		if len(theme.Items) == 0 || slackDailyDiaryThemeInOrder(title, themeOrder) {
			continue
		}
		diary.Themes = append(diary.Themes, *theme)
	}
	if len(diary.Themes) == 0 {
		diary.Intro = "今天我没有观察到足够明确的团队进展，先不硬凑；我会继续看 Slack、GitHub、Linear 里的可见记录。"
	} else {
		diary.Intro = slackDailyDiaryIntro(diary.Themes)
	}
	diary.Watchlist = slackDailyDiaryWatchlist(newRuns, legacyRuns)
	return diary
}

func slackDailyDiaryCandidateForRun(run SlackTriageContext, source string) (slackDailyDiaryCandidate, bool) {
	if slackTriageRunFailed(run) {
		return slackDailyDiaryCandidate{}, false
	}
	detail := slackDailyDiaryDetail(run)
	if detail == "" || slackDailyDiaryLowSignal(detail) {
		return slackDailyDiaryCandidate{}, false
	}
	at := parseTriageTimestamp(run.Timestamp)
	theme := slackDailyDiaryThemeTitle(run, detail)
	item := SlackDailyDiaryItem{
		Channel: slackDailyDiaryChannelLabel(run),
		Time:    slackDailyDiaryTimeLabel(at),
		Text:    detail,
		Source:  source,
	}
	return slackDailyDiaryCandidate{
		item:  item,
		theme: theme,
		score: slackDailyDiaryScore(run, detail),
		at:    at,
		key:   strings.ToLower(theme + "|" + item.Channel + "|" + truncateSlackContextTextRunes(detail, 80)),
	}, true
}

func slackDailyDiaryDetail(run SlackTriageContext) string {
	candidates := []string{run.Summary}
	for _, action := range run.Actions {
		candidates = append(candidates, action.Brief)
	}
	for _, call := range run.ToolCalls {
		candidates = append(candidates, call.Brief, call.Result)
	}
	candidates = append(candidates, slackDailyDiaryDigestSnippet(run.Digest))
	for _, candidate := range candidates {
		detail := slackDailyDiaryCleanDetail(candidate)
		if detail != "" && !slackDailyDiaryLowSignal(detail) {
			return truncateSlackContextTextRunes(detail, 220)
		}
	}
	return ""
}

func slackDailyDiaryCleanDetail(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	value = html.UnescapeString(value)
	replacements := []struct{ from, to string }{
		{"Assistant turn 1 Text:", ""},
		{"Assistant turn 1", ""},
		{"Text:", ""},
		{"**Classification: SKIP**", ""},
		{"Classification: SKIP", ""},
		{"The thread shows that ", ""},
		{"The thread shows ", ""},
		{"The message ", "消息 "},
		{"This is ", ""},
		{"No further action needed.", ""},
		{"No action.", ""},
		{"Stay silent.", ""},
		{"stay_silent", ""},
	}
	for _, replacement := range replacements {
		value = strings.ReplaceAll(value, replacement.from, replacement.to)
	}
	value = slackDailyReportVisibleDetail(value)
	value = strings.ReplaceAll(value, "\n", " ")
	value = strings.Join(strings.Fields(value), " ")
	value = strings.Trim(value, " -—:;,.，。")
	return value
}

func slackDailyDiaryLowSignal(value string) bool {
	text := strings.ToLower(strings.TrimSpace(value))
	if text == "" || text == "no action" || text == "n/a" {
		return true
	}
	if slackDailyDiaryLooksLikeRawPayload(text) {
		return true
	}
	if slackDailyDiaryLooksLikeOpaqueIdentifier(text) {
		return true
	}
	lowSignalMarkers := []string{
		"routine automated daily",
		"automated daily diary",
		"daily notes",
		"candidate task review",
		"pi-first foreground triage pending",
		"persona reaction",
		"persona reply",
		"persona delegated worker",
		"persona delegate_worker",
		"persona runtime foreground",
		"persona foreground orphaned",
		"delegate_worker",
		"reply posted to thread",
		"decode oneesama pi decision json",
		"call oneesama pi model",
		"context deadline exceeded",
		"not valid persona json",
		"invalid persona json",
		"daily report",
		"/deploy ",
		"agentrunner triage completed",
		"approval gate live",
		"approval card live",
		"simplified approval card",
		"pending_dm_card_posted",
		"is active",
		"repeat '/deploy' commands not directed",
		"not directed at oneesama",
		"out of scope per secretary policy",
		"staying silent",
		"directly answered by",
		"thread is handled",
		"handled and no further action",
		"mentioned_other_user_without_bot",
		"is already actively handling",
		"fully in-progress",
		"suppressed for ambient",
		"no direct evidence",
		"delegating to worker",
		"bounded secretary work",
		"auto-delegated to secretary lookup",
		"stay-silent external link",
		"workspace policy",
		"product-adjacent",
		"secretary lookup",
		"轻量emoji反应",
		"无实质内容",
		"用户分享了同一个链接",
		"from previous discussion",
		"从之前的讨论看",
		"要不要看看",
		"可能",
		"推断",
		"大概",
		"也许",
		"maybe",
		"might",
		"possibly",
		"no explicit question",
		"看下现在的 prompt",
		"引导 agent",
		"文件名或者文件路径",
		"no human ask",
		"nothing for me to add",
		"nothing factual or useful to add",
		"working through the issue themselves",
		"skip —",
		"internal technical debugging thread",
		"no explicit request",
		"no question or request",
		"no question or action",
		"no action needed",
		"no reply needed",
		"no need to reply",
		"nothing here calls for",
		"already handled",
		"handled by the speaker",
		"status update on",
		"routine ci/pr",
		"routine ci / pr",
		"casual banter",
		"watercooler",
		"without more context",
		"let me look",
		"tool calls:",
		"slack_api",
		"buffered ",
		"slack message(s)",
		"latest from",
		"pass 1: classification",
		"pass 1 分类",
		"| ref | summary",
		"**skip**",
		"skip。",
		" skip",
		"classification |",
		"shared link returns",
		"http 400",
		"no content",
		"best to stay silent",
		"file_id:",
		"type: text/html",
		"successfully wrote to memory",
		"source: memory/",
		"person:",
		"identity:",
		"thread_ts",
		"tool_capab",
		"reaction acknowledges",
		"reply in thread",
		"review & merge",
		"patch if have problem",
		"测测吧",
		"suggest_acti",
		"[reactions:",
		"\\x",
		"闭源版每次发布",
		"未明确请求",
		"没有明确",
		"没有问题",
		"没有提问",
		"无需回复",
		"无需文字回复",
		"无需额外",
		"不需要额外",
		"不需要介入",
		"不需要回复",
		"已自行跟进",
		"自行跟进",
		"已处理",
		"已经处理",
		"轻量确认",
	}
	for _, marker := range lowSignalMarkers {
		if strings.Contains(text, marker) {
			return true
		}
	}
	if strings.HasPrefix(text, "#c0") || strings.HasPrefix(text, "[177") || strings.HasPrefix(text, "http://") || strings.HasPrefix(text, "https://") || strings.HasPrefix(text, "<http") || strings.HasPrefix(text, "/deploy ") || strings.Contains(text, "c_replay_smoke") {
		return true
	}
	if len([]rune(strings.TrimSpace(value))) < 12 && !slackDailyDiaryContainsAny(text, "fix", "ship", "release", "pr #", "ci", "修复", "根因", "上线", "发布") {
		return true
	}
	return false
}

func slackDailyDiaryLooksLikeRawPayload(text string) bool {
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		return true
	}
	rawMarkers := []string{
		`"query"`,
		`"results"`,
		`"file_path"`,
		`"start_line"`,
		`"end_line"`,
		"reactions.add",
		"chat.postmessage",
		"conversations.replies",
		"tool_calls",
	}
	for _, marker := range rawMarkers {
		if strings.Contains(trimmed, marker) {
			return true
		}
	}
	return false
}

func slackDailyDiaryLooksLikeOpaqueIdentifier(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return false
	}
	digitOrDot := 0
	for _, r := range trimmed {
		if (r >= '0' && r <= '9') || r == '.' {
			digitOrDot++
			continue
		}
		return false
	}
	return digitOrDot >= 8
}

func slackDailyDiaryDigestSnippet(digest string) string {
	for _, line := range strings.Split(digest, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, ": \"") {
			continue
		}
		_, rest, ok := strings.Cut(line, ": \"")
		if !ok {
			continue
		}
		rest = strings.TrimSuffix(rest, "\"")
		rest = strings.TrimSpace(rest)
		if rest != "" {
			return rest
		}
	}
	return ""
}

func slackDailyDiaryThemeTitle(run SlackTriageContext, detail string) string {
	text := strings.ToLower(strings.Join([]string{detail, run.Summary, run.Digest, strings.Join(run.Channels, " ")}, " "))
	switch {
	case slackDailyDiaryContainsAny(text, "oneesama", "onee", "meeting-avatar", "meeting agent", "realtime", "real time", "google meet", "demo surface", "computer use", "kwwk", "join card", "caption", "avatar hud", "贪吃蛇", "入会", "字幕"):
		return "Oneesama / meeting avatar"
	case slackDailyDiaryContainsAny(text, "recappi", "transcription", "speaker", "audio", "coreaudio", "cloud transcription", "音频", "转写"):
		return "Recappi / 音频体验"
	case slackDailyDiaryContainsAny(text, "bazaar", "simulator", "corpus", "karnok", "potion", "lifesteal", "bazaar-buddy"):
		return "Bazaar Buddy / simulator"
	case slackDailyDiaryContainsAny(text, "bridge", "cue.surf", "cueboard", "willow", "staging", "ci", "pr #", "pull request", "review", "deploy", "traffic", "140 gb", "mp4"):
		return "Cue / Bridge 工程"
	case slackDailyDiaryContainsAny(text, "twitter", "ootd", "linger", "wechat", "like", "social"):
		return "社交自动化 / Linger"
	default:
		return "团队协作与 review"
	}
}

func slackDailyDiaryScore(run SlackTriageContext, detail string) int {
	score := 1
	if run.Mutations > 0 || len(run.Actions) > 0 {
		score += 6
	}
	text := strings.ToLower(detail + " " + run.Summary + " " + run.Digest)
	for _, marker := range []string{"ship", "fix", "root cause", "review", "merge", "ci", "release", "deploy", "bug", "poc", "smoke", "验证", "修", "根因", "上线", "验收"} {
		if strings.Contains(text, marker) {
			score += 2
		}
	}
	if intFromAny(run.Metadata["external_links_fetched"]) > 0 {
		score += 1
	}
	if strings.Contains(text, "already") || strings.Contains(text, "已由") || strings.Contains(text, "已经") {
		score -= 2
	}
	if score < 1 {
		score = 1
	}
	return score
}

func slackDailyDiaryChannelLabel(run SlackTriageContext) string {
	if label := slackDailyDiaryChannelFromDigest(run.Digest); label != "" {
		return label
	}
	if channel := slackDailyReportRunChannel(run); channel != "" {
		if strings.HasPrefix(channel, "C") || strings.HasPrefix(channel, "G") {
			return "<#" + channel + ">"
		}
		return channel
	}
	return ""
}

func slackDailyDiaryChannelFromDigest(digest string) string {
	for _, line := range strings.Split(digest, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "#") || !strings.Contains(line, " (") {
			continue
		}
		name := strings.TrimSpace(strings.TrimPrefix(strings.SplitN(line, " (", 2)[0], "#"))
		if name != "" {
			return "#" + name
		}
	}
	return ""
}

func slackDailyDiaryTimeLabel(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	loc, err := time.LoadLocation(slackDailyReportDefaultTZ)
	if err != nil {
		return value.UTC().Format("15:04Z")
	}
	return value.In(loc).Format("15:04")
}

func slackDailyDiaryContainsAny(text string, markers ...string) bool {
	for _, marker := range markers {
		if strings.Contains(text, strings.ToLower(marker)) {
			return true
		}
	}
	return false
}

func slackDailyDiaryThemeInOrder(title string, order []string) bool {
	for _, entry := range order {
		if entry == title {
			return true
		}
	}
	return false
}

func slackDailyDiaryIntro(themes []SlackDailyDiaryTheme) string {
	titles := make([]string, 0, minInt(len(themes), 3))
	for _, theme := range themes {
		if len(theme.Items) == 0 {
			continue
		}
		titles = append(titles, theme.Title)
		if len(titles) >= 3 {
			break
		}
	}
	if len(titles) == 0 {
		return "今天我没有观察到足够明确的团队进展，先不硬凑；我会继续看 Slack、GitHub、Linear 里的可见记录。"
	}
	return "今天我观察到的主线集中在 " + strings.Join(titles, "、") + "；下面按方向记，不按流水账堆计数。"
}

func slackDailyDiaryWatchlist(newRuns []SlackTriageContext, legacyRuns []SlackTriageContext) []string {
	var watchlist []string
	failedNew := 0
	for _, run := range newRuns {
		if _, recovered := triageQualityRunRecoveredProviderFailure(run, newRuns); slackTriageRunFailed(run) && !recovered {
			failedNew++
		}
	}
	if failedNew > 0 {
		watchlist = append(watchlist, fmt.Sprintf("Oneesama 自己今天有 %d 条 triage/runtime 异常，继续走审计面单独跟进，不把日志细节塞进日记。", failedNew))
	}
	if len(legacyRuns) == 0 {
		watchlist = append(watchlist, "旧 slackd 对照源今天不可用或没有样本；这篇日记只基于新 Oneesama 可见记录。")
	}
	return watchlist
}
