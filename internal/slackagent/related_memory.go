package slackagent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

const (
	relatedMemoryDefaultLimit = 8
	relatedMemorySnippetLimit = 900
)

type SlackRelatedMemorySearchOptions struct {
	Limit int       `json:"limit,omitempty"`
	Now   time.Time `json:"-"`
}

type SlackRelatedMemorySearchResult struct {
	Query            string                     `json:"query"`
	Status           string                     `json:"status"`
	NoRelevantMemory bool                       `json:"noRelevantMemory"`
	Results          []SlackRelatedMemoryRecord `json:"results,omitempty"`
}

type SlackRelatedMemoryRecord struct {
	Kind       string   `json:"kind"`
	Source     string   `json:"source"`
	SourcePath string   `json:"sourcePath,omitempty"`
	SourceRef  string   `json:"sourceRef,omitempty"`
	Title      string   `json:"title,omitempty"`
	StartLine  int      `json:"startLine,omitempty"`
	EndLine    int      `json:"endLine,omitempty"`
	CreatedAt  string   `json:"createdAt,omitempty"`
	UpdatedAt  string   `json:"updatedAt,omitempty"`
	Content    string   `json:"content"`
	Score      float64  `json:"score"`
	Reasons    []string `json:"reasons,omitempty"`
}

func (s *Service) SearchRelatedMemory(query string, options SlackRelatedMemorySearchOptions) SlackRelatedMemorySearchResult {
	query = strings.TrimSpace(query)
	limit := options.Limit
	if limit <= 0 {
		limit = relatedMemoryDefaultLimit
	}
	now := options.Now
	if now.IsZero() {
		now = timeNow()
	}
	result := SlackRelatedMemorySearchResult{Query: query, Status: "ok"}
	tokens := relatedMemoryTokens(query)
	if s == nil || len(tokens) == 0 {
		result.Status = "no_relevant_memory"
		result.NoRelevantMemory = true
		return result
	}
	var records []SlackRelatedMemoryRecord
	records = append(records, relatedMemoryWorkspaceRecords(s.workspaceDir, tokens, now)...)
	records = append(records, s.relatedMemoryFeedbackRecords(tokens, limit)...)
	records = append(records, relatedMemoryTriageProjectionRecords(s.workspaceDir, tokens)...)
	records = append(records, s.relatedMemoryProviderRecords(context.Background(), query, tokens, limit, now)...)
	records = dedupeRelatedMemoryRecords(records)
	sort.SliceStable(records, func(i, j int) bool {
		if records[i].Score == records[j].Score {
			return records[i].Source < records[j].Source
		}
		return records[i].Score > records[j].Score
	})
	if len(records) > limit {
		records = records[:limit]
	}
	sanitizeSlackRelatedMemoryRecords(records)
	result.Results = records
	if len(records) == 0 {
		result.Status = "no_relevant_memory"
		result.NoRelevantMemory = true
	}
	return result
}

func sanitizeSlackRelatedMemoryRecords(records []SlackRelatedMemoryRecord) {
	for index := range records {
		records[index].Content = sanitizeSlackVisibleText(records[index].Content)
	}
}

func (s *Service) relatedMemoryProviderRecords(ctx context.Context, query string, tokens []string, limit int, now time.Time) []SlackRelatedMemoryRecord {
	if s == nil || s.memoryProviders == nil {
		return nil
	}
	return s.memoryProviders.Search(ctx, SlackMemoryProviderSearchRequest{
		Query:  query,
		Tokens: append([]string(nil), tokens...),
		Limit:  limit,
		Now:    now,
	})
}

func (s *Service) searchSlackTriageRelatedMemory(query string, limit int) SlackRelatedMemorySearchResult {
	result := s.SearchRelatedMemory(query, SlackRelatedMemorySearchOptions{Limit: limit})
	result.Results = credibleBackfillRelatedMemory(result.Results, limit)
	if len(result.Results) == 0 {
		result.Status = "no_relevant_memory"
		result.NoRelevantMemory = true
	}
	return result
}

func relatedMemoryWorkspaceRecords(workspaceDir string, tokens []string, now time.Time) []SlackRelatedMemoryRecord {
	if strings.TrimSpace(workspaceDir) == "" {
		return nil
	}
	var records []SlackRelatedMemoryRecord
	for _, relPath := range listDirectWorkspaceMemoryFiles(workspaceDir) {
		fullPath := filepath.Join(workspaceDir, filepath.FromSlash(relPath))
		raw, err := os.ReadFile(fullPath)
		if err != nil {
			continue
		}
		info, _ := os.Stat(fullPath)
		createdAt, updatedAt := relatedMemoryFileTimestamps(relPath, info)
		kind := relatedMemoryKindForPath(relPath)
		for _, chunk := range relatedMemoryMarkdownChunks(string(raw)) {
			content := sanitizeSlackVisibleText(chunk.Content)
			if relatedMemorySuppressesImportedPolicyTrace(kind, content) {
				continue
			}
			base := relatedMemoryTextScore(content, tokens)
			if base <= 0 {
				continue
			}
			score, reasons := relatedMemoryScoreWithBoosts(base, kind, relPath, content, tokens, now)
			records = append(records, SlackRelatedMemoryRecord{
				Kind:       kind,
				Source:     filepath.ToSlash(relPath),
				SourcePath: filepath.ToSlash(relPath),
				Title:      relatedMemoryTitle(content),
				StartLine:  chunk.StartLine,
				EndLine:    chunk.EndLine,
				CreatedAt:  createdAt,
				UpdatedAt:  updatedAt,
				Content:    truncateSlackContextText(strings.TrimSpace(content), relatedMemorySnippetLimit),
				Score:      score,
				Reasons:    reasons,
			})
		}
	}
	return records
}

func (s *Service) relatedMemoryFeedbackRecords(tokens []string, limit int) []SlackRelatedMemoryRecord {
	if s == nil || s.feedback == nil {
		return nil
	}
	entries, err := s.feedback.ListEntries(context.Background(), maxInt(limit*2, relatedMemoryDefaultLimit))
	if err != nil {
		return nil
	}
	records := make([]SlackRelatedMemoryRecord, 0, len(entries))
	for _, entry := range entries {
		content := feedbackEntryMemoryText(entry)
		base := relatedMemoryTextScore(content, tokens)
		if base <= 0 {
			continue
		}
		score, reasons := relatedMemoryScoreWithBoosts(base+0.05, "feedback", feedbackEntrySource(entry), content, tokens, time.Time{})
		reasons = append(reasons, "feedback_match")
		records = append(records, SlackRelatedMemoryRecord{
			Kind:      "feedback",
			Source:    feedbackEntrySource(entry),
			SourceRef: feedbackEntrySource(entry),
			CreatedAt: entry.CreatedAt,
			UpdatedAt: entry.CreatedAt,
			Content:   truncateSlackContextText(content, relatedMemorySnippetLimit),
			Score:     score,
			Reasons:   reasons,
		})
	}
	return records
}

func relatedMemoryTriageProjectionRecords(workspaceDir string, tokens []string) []SlackRelatedMemoryRecord {
	var records []SlackRelatedMemoryRecord
	for _, context := range workspaceTriageContextsForMemory(workspaceDir) {
		if slackTriageContextSuppressesMemoryProjection(context) {
			continue
		}
		content := triageContextMemoryText(context)
		base := relatedMemoryTextScore(content, tokens)
		if base <= 0 {
			continue
		}
		source := triageMemorySource(context)
		score, reasons := relatedMemoryScoreWithBoosts(base+0.03, "triage_projection", source, content, tokens, time.Time{})
		reasons = append(reasons, "triage_projection_match")
		records = append(records, SlackRelatedMemoryRecord{
			Kind:       "triage_projection",
			Source:     source,
			SourcePath: source,
			SourceRef:  context.SessionID,
			Title:      firstNonEmpty(context.Summary, context.Status),
			CreatedAt:  context.Timestamp,
			UpdatedAt:  context.Timestamp,
			Content:    truncateSlackContextText(content, relatedMemorySnippetLimit),
			Score:      score,
			Reasons:    reasons,
		})
	}
	return records
}

func slackTriageContextSuppressesMemoryProjection(context SlackTriageContext) bool {
	if context.Mutations > 0 || len(context.Actions) > 0 {
		return false
	}
	summaryText := strings.ToLower(strings.TrimSpace(context.Summary))
	for _, marker := range []string{"already handled", "handled by", "已处理", "已经处理", "有人接", "已经有人"} {
		if strings.Contains(summaryText, marker) {
			return false
		}
	}
	metadataText := strings.ToLower(strings.TrimSpace(strings.Join([]string{
		stringFromAny(context.Metadata["skip_reason_bucket"]),
		stringFromAny(context.Metadata["suppressed_reason"]),
	}, "\n")))
	for _, marker := range []string{
		"no_actions",
		"stay_silent",
		"no_action_other",
	} {
		if strings.Contains(metadataText, marker) {
			return true
		}
	}
	for _, marker := range []string{
		"无动作",
		"无行动",
		"不需要动作",
		"无需动作",
		"无需介入",
		"不介入",
		"不回复",
	} {
		if strings.Contains(summaryText, marker) {
			return true
		}
	}
	return false
}

type relatedMemoryChunk struct {
	StartLine int
	EndLine   int
	Content   string
}

func relatedMemoryMarkdownChunks(content string) []relatedMemoryChunk {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	var chunks []relatedMemoryChunk
	start := 1
	var block []string
	flush := func(end int) {
		text := strings.TrimSpace(strings.Join(block, "\n"))
		if text != "" {
			chunks = append(chunks, relatedMemoryChunk{StartLine: start, EndLine: end, Content: text})
		}
		block = nil
	}
	for index, line := range lines {
		lineNo := index + 1
		if strings.HasPrefix(line, "#") && len(block) > 0 {
			flush(lineNo - 1)
			start = lineNo
		}
		block = append(block, line)
	}
	if len(block) > 0 {
		flush(len(lines))
	}
	if len(chunks) == 0 && strings.TrimSpace(content) != "" {
		return []relatedMemoryChunk{{StartLine: 1, EndLine: len(lines), Content: strings.TrimSpace(content)}}
	}
	return chunks
}

func relatedMemoryKindForPath(relPath string) string {
	relPath = filepath.ToSlash(strings.TrimSpace(relPath))
	if inner, ok := strings.CutPrefix(relPath, "memory/legacy/slack-agent-d/workspace/"); ok {
		switch {
		case inner == "MEMORY.md":
			return "legacy_memory_index"
		case strings.HasPrefix(inner, "memory/triage-archive/"):
			return "legacy_triage_archive"
		case strings.HasPrefix(inner, "memory/people/") && strings.HasSuffix(inner, ".md"):
			return "person_profile"
		case strings.HasPrefix(inner, "memory/team/decisions/"):
			return "team_decision"
		case strings.HasPrefix(inner, "memory/team/actions/"):
			return "team_action"
		case strings.HasPrefix(inner, "memory/team/questions/"):
			return "team_question"
		case strings.HasPrefix(inner, "memory/team/facts/"):
			return "team_fact"
		case strings.HasPrefix(inner, "memory/team/meetings/"):
			return "team_meeting"
		case strings.HasPrefix(inner, "memory/lessons/candidates/"):
			return "lesson_candidate"
		case strings.HasPrefix(inner, "memory/feedback/"):
			return "feedback"
		default:
			return "legacy_memory_file"
		}
	}
	if strings.HasPrefix(relPath, "memory/legacy/slack-agent-d/db/") {
		return "legacy_slack_db"
	}
	switch {
	case relPath == "MEMORY.md":
		return "memory_index"
	case regexp.MustCompile(`^memory/\d{4}-\d{2}-\d{2}\.md$`).MatchString(relPath):
		return "daily_note"
	case strings.HasPrefix(relPath, "memory/persona/writes/") && strings.HasSuffix(relPath, ".md"):
		return "persona_memory_write"
	case strings.HasPrefix(relPath, "memory/people/") && strings.HasSuffix(relPath, ".md"):
		return "person_profile"
	case strings.HasPrefix(relPath, "memory/team/decisions/"):
		return "team_decision"
	case strings.HasPrefix(relPath, "memory/team/actions/"):
		return "team_action"
	case strings.HasPrefix(relPath, "memory/team/questions/"):
		return "team_question"
	case strings.HasPrefix(relPath, "memory/team/facts/"):
		return "team_fact"
	case strings.HasPrefix(relPath, "memory/team/meetings/"):
		return "team_meeting"
	case strings.HasPrefix(relPath, "memory/lessons/candidates/"):
		return "lesson_candidate"
	case strings.HasPrefix(relPath, "memory/multimodal/"):
		return "multimodal_memory"
	case strings.HasPrefix(relPath, "memory/feedback/"):
		return "feedback"
	default:
		return "memory_file"
	}
}

func relatedMemoryScoreWithBoosts(base float64, kind, relPath, content string, tokens []string, now time.Time) (float64, []string) {
	score := base
	reasons := []string{fmt.Sprintf("lexical_match:%.2f", base)}
	if boost := relatedMemoryFamilyBoost(kind, tokens); boost > 0 {
		score += boost
		reasons = append(reasons, fmt.Sprintf("family_boost:%s", kind))
	}
	if boost := relatedMemoryProjectBoost(relPath+"\n"+content, tokens); boost > 0 {
		score += boost
		reasons = append(reasons, "project_or_repo_boost")
	}
	if boost := relatedMemoryRecencyBoost(relPath, now); boost > 0 {
		score += boost
		reasons = append(reasons, "recent_memory")
	}
	if boost := relatedMemoryLegacyToolTraceBoost(base, kind, content); boost > 0 {
		score += boost
		reasons = append(reasons, "legacy_tool_trace_boost")
	}
	return score, reasons
}

func relatedMemoryFamilyBoost(kind string, tokens []string) float64 {
	tokenSet := make(map[string]struct{}, len(tokens))
	for _, token := range tokens {
		tokenSet[token] = struct{}{}
	}
	hasAny := func(values ...string) bool {
		for _, value := range values {
			if _, ok := tokenSet[value]; ok {
				return true
			}
		}
		return false
	}
	switch kind {
	case "legacy_triage_archive":
		return 0.14
	case "persona_memory_write":
		return 0.20
	case "multimodal_memory":
		return 0.16
	case "person_profile":
		if hasAny("who", "owner", "review", "reviewer", "找谁", "负责人", "谁", "review") {
			return 0.25
		}
	case "team_action":
		if hasAny("todo", "action", "owner", "review", "任务", "负责人", "推进") {
			return 0.18
		}
	case "team_decision":
		if hasAny("decision", "decide", "方案", "决定", "结论", "拍板") {
			return 0.18
		}
	case "team_question":
		if hasAny("question", "why", "how", "问题", "为什么", "怎么") {
			return 0.16
		}
	case "team_fact", "team_meeting":
		if hasAny("quota", "reset", "配额", "额度", "付费", "免费", "用户", "事实", "站会", "meeting") {
			return 0.22
		}
	case "lesson_candidate":
		if hasAny("bug", "incident", "mistake", "regression", "教训", "复盘", "错误") {
			return 0.16
		}
	}
	return 0
}

func relatedMemoryProjectBoost(content string, tokens []string) float64 {
	lower := strings.ToLower(content)
	for _, token := range tokens {
		if strings.HasPrefix(token, "repo:") || strings.HasPrefix(token, "pr:") || strings.HasPrefix(token, "project:") {
			value := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(token, "repo:"), "pr:"), "project:"))
			if value != "" && strings.Contains(lower, value) {
				return 0.12
			}
		}
	}
	return 0
}

func relatedMemoryLegacyToolTraceBoost(base float64, kind, content string) float64 {
	if kind != "legacy_triage_archive" || base < 0.35 {
		return 0
	}
	lower := strings.ToLower(content)
	if !strings.Contains(lower, "tool calls:") {
		return 0
	}
	for _, marker := range []string{"memory_search", "memory_get", "person_memory"} {
		if strings.Contains(lower, marker) {
			return 0.22
		}
	}
	return 0
}

func relatedMemorySuppressesImportedPolicyTrace(kind, content string) bool {
	if kind != "legacy_triage_archive" {
		return false
	}
	lower := strings.ToLower(content)
	for _, marker := range []string{"tool calls:", "memory_search", "memory_get", "person_memory"} {
		if strings.Contains(lower, marker) {
			return false
		}
	}
	actionless := false
	for _, marker := range []string{
		"actions:\n> []",
		"\"actions\": []",
		"\"actions\":[]",
		"actions: []",
		"no action",
		"skip",
		"无 action",
		"无动作",
		"无需介入",
		"不介入",
	} {
		if strings.Contains(lower, marker) {
			actionless = true
			break
		}
	}
	if !actionless {
		return false
	}
	for _, marker := range []string{
		"office helper",
		"watercooler",
		"水群",
		"水聊",
		"not in my lane",
		"不属于 office helper",
		"无需 office helper",
		"纯技术",
		"纯粹 casual",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func relatedMemoryRecencyBoost(relPath string, now time.Time) float64 {
	matches := regexp.MustCompile(`(?:^|/)memory/(\d{4}-\d{2}-\d{2})\.md$`).FindStringSubmatch(filepath.ToSlash(relPath))
	if len(matches) != 2 || now.IsZero() {
		return 0
	}
	day, err := time.ParseInLocation("2006-01-02", matches[1], shanghaiLocation())
	if err != nil {
		return 0
	}
	age := now.In(shanghaiLocation()).Sub(day)
	switch {
	case age >= 0 && age <= 24*time.Hour:
		return 0.18
	case age > 24*time.Hour && age <= 72*time.Hour:
		return 0.10
	default:
		return 0
	}
}

func relatedMemoryTextScore(content string, tokens []string) float64 {
	if len(tokens) == 0 {
		return 0
	}
	lower := strings.ToLower(content)
	hits := 0
	seen := map[string]struct{}{}
	for _, token := range tokens {
		if _, ok := seen[token]; ok {
			continue
		}
		seen[token] = struct{}{}
		if strings.Contains(lower, token) {
			hits++
		}
	}
	if hits == 0 {
		return 0
	}
	return float64(hits) / float64(maxInt(len(seen), 1))
}

func relatedMemoryTokens(query string) []string {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return nil
	}
	var tokens []string
	var current []rune
	flush := func() {
		if len(current) == 0 {
			return
		}
		token := string(current)
		tokens = append(tokens, token)
		if containsHan(current) {
			tokens = append(tokens, cjkNgrams(current, 2)...)
			tokens = append(tokens, cjkNgrams(current, 3)...)
		}
		current = nil
	}
	for _, r := range query {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-' || r == '.' || r == '/' || r == '#' {
			current = append(current, r)
			continue
		}
		flush()
	}
	flush()
	return compactUniqueStrings(expandRelatedMemoryTokens(tokens))
}

func expandRelatedMemoryTokens(tokens []string) []string {
	var out []string
	for _, token := range tokens {
		urlish := relatedMemoryTokenLooksURLish(token)
		if !urlish && !relatedMemoryNoiseToken(token, false) {
			out = append(out, token)
		}
		for _, subtoken := range asciiWordSubtokens(token) {
			if relatedMemoryNoiseToken(subtoken, urlish) {
				continue
			}
			out = append(out, subtoken)
		}
		if strings.Contains(token, "github.com/") {
			parts := strings.Split(token, "/")
			for index, part := range parts {
				part = strings.TrimSpace(part)
				if part == "" || part == "https:" || part == "http:" || part == "github.com" || relatedMemoryNoiseToken(part, true) {
					continue
				}
				out = append(out, part)
				if index >= 2 && parts[index-1] == "github.com" {
					out = append(out, "project:"+part)
				}
				if index >= 3 && parts[index-2] == "github.com" {
					out = append(out, "repo:"+part)
				}
				if index >= 1 && parts[index-1] == "pull" {
					out = append(out, "pr:"+part)
				}
			}
		}
	}
	return out
}

func relatedMemoryTokenLooksURLish(token string) bool {
	token = strings.TrimSpace(strings.ToLower(token))
	return strings.Contains(token, "/") || strings.Contains(token, ".") || strings.HasPrefix(token, "http")
}

func relatedMemoryNoiseToken(token string, urlDerived bool) bool {
	token = strings.Trim(strings.ToLower(strings.TrimSpace(token)), "/.")
	if token == "" {
		return true
	}
	switch token {
	case "http", "https", "www":
		return true
	}
	if !urlDerived {
		return false
	}
	switch token {
	case "com", "net", "org", "io", "ai", "app", "dev", "co", "cn", "xyz":
		return true
	default:
		return false
	}
}

func asciiWordSubtokens(token string) []string {
	var out []string
	var current []rune
	flush := func() {
		if len(current) >= 2 {
			out = append(out, string(current))
		}
		current = nil
	}
	for _, r := range strings.ToLower(token) {
		if r <= unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)) {
			current = append(current, r)
			continue
		}
		flush()
	}
	flush()
	return out
}

func relatedMemoryFileTimestamps(relPath string, info os.FileInfo) (string, string) {
	var updatedAt string
	if info != nil && !info.ModTime().IsZero() {
		updatedAt = info.ModTime().UTC().Format(time.RFC3339)
	}
	if matches := regexp.MustCompile(`^memory/(\d{4}-\d{2}-\d{2})\.md$`).FindStringSubmatch(filepath.ToSlash(relPath)); len(matches) == 2 {
		if day, err := time.ParseInLocation("2006-01-02", matches[1], shanghaiLocation()); err == nil {
			createdAt := day.UTC().Format(time.RFC3339)
			if updatedAt == "" {
				updatedAt = createdAt
			}
			return createdAt, updatedAt
		}
	}
	return "", updatedAt
}

func containsHan(runes []rune) bool {
	for _, r := range runes {
		if unicode.In(r, unicode.Han) {
			return true
		}
	}
	return false
}

func cjkNgrams(runes []rune, n int) []string {
	if n <= 0 || len(runes) < n {
		return nil
	}
	var out []string
	for index := 0; index+n <= len(runes); index++ {
		chunk := runes[index : index+n]
		if containsHan(chunk) {
			out = append(out, string(chunk))
		}
	}
	return out
}

func relatedMemoryTitle(content string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") {
			return strings.TrimSpace(strings.TrimLeft(line, "#"))
		}
	}
	return ""
}

func dedupeRelatedMemoryRecords(records []SlackRelatedMemoryRecord) []SlackRelatedMemoryRecord {
	if len(records) == 0 {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]SlackRelatedMemoryRecord, 0, len(records))
	for _, record := range records {
		key := strings.Join([]string{record.Kind, record.Source, fmt.Sprint(record.StartLine), record.Content}, "\x00")
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, record)
	}
	return out
}
