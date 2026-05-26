package slackagent

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
	_ "modernc.org/sqlite"
)

const (
	slackDailyReportsCollection = "slack_daily_reports"
	slackDailyReportDefaultTime = "18:00"
	slackDailyReportDefaultTZ   = "Asia/Shanghai"
)

var slackEmojiNamePattern = regexp.MustCompile(`:([a-zA-Z0-9_+\-]+):`)
var slackDailyReportTodoPlaceholderPattern = regexp.MustCompile(`\bTODO\b`)

type SlackDailyReportStatus struct {
	Enabled          bool   `json:"enabled"`
	Running          bool   `json:"running"`
	ChannelID        string `json:"channel_id,omitempty"`
	TimeOfDay        string `json:"time_of_day"`
	Timezone         string `json:"timezone"`
	WindowSeconds    int64  `json:"window_seconds"`
	NextRunAt        string `json:"next_run_at,omitempty"`
	LastTickAt       string `json:"last_tick_at,omitempty"`
	LastPostedAt     string `json:"last_posted_at,omitempty"`
	LastChannelID    string `json:"last_channel_id,omitempty"`
	LastError        string `json:"last_error,omitempty"`
	TicksLastWindow  int    `json:"ticks_last_window"`
	LegacyDBPath     string `json:"legacy_db_path,omitempty"`
	LegacyArchiveDir string `json:"legacy_archive_dir,omitempty"`
}

type SlackDailyReportRunRequest struct {
	ChannelID  string `json:"channel_id,omitempty"`
	ReportDate string `json:"report_date,omitempty"`
	Window     string `json:"window,omitempty"`
	DryRun     bool   `json:"dry_run,omitempty"`
	Force      bool   `json:"force,omitempty"`
}

type SlackDailyReportRunResponse struct {
	OK      bool                    `json:"ok"`
	Report  SlackDailyReport        `json:"report"`
	Post    *PostMessageResult      `json:"post,omitempty"`
	Skipped bool                    `json:"skipped,omitempty"`
	Reason  string                  `json:"reason,omitempty"`
	Record  *SlackDailyReportRecord `json:"record,omitempty"`
}

type SlackDailyReport struct {
	GeneratedAt string                     `json:"generated_at"`
	ReportDate  string                     `json:"report_date"`
	WindowStart string                     `json:"window_start"`
	WindowEnd   string                     `json:"window_end"`
	WindowHours float64                    `json:"window_hours"`
	New         SlackDailyTriageMetrics    `json:"new_oneesama"`
	Legacy      SlackDailyTriageMetrics    `json:"legacy_slackd"`
	Comparison  SlackDailyTriageComparison `json:"comparison"`
	Diary       SlackDailyDiary            `json:"diary"`
	Flags       []SlackDailyReportFlag     `json:"flags,omitempty"`
	Text        string                     `json:"text"`
}

type SlackDailyDiary struct {
	Intro     string                     `json:"intro"`
	Themes    []SlackDailyDiaryTheme     `json:"themes,omitempty"`
	Watchlist []string                   `json:"watchlist,omitempty"`
	Sources   SlackDailyDiarySourceCount `json:"sources"`
}

type SlackDailyDiaryTheme struct {
	Title string                `json:"title"`
	Items []SlackDailyDiaryItem `json:"items,omitempty"`
}

type SlackDailyDiaryItem struct {
	Channel string `json:"channel,omitempty"`
	Time    string `json:"time,omitempty"`
	Text    string `json:"text"`
	Source  string `json:"source"`
}

type SlackDailyDiarySourceCount struct {
	NewRuns    int `json:"new_runs"`
	LegacyRuns int `json:"legacy_runs"`
}

type SlackDailyTriageMetrics struct {
	Source                        string         `json:"source"`
	Available                     bool           `json:"available"`
	Error                         string         `json:"error,omitempty"`
	Runs                          int            `json:"runs"`
	FailedRuns                    int            `json:"failed_runs"`
	RecoveredProviderFailures     int            `json:"recovered_provider_failures,omitempty"`
	MutatingRuns                  int            `json:"mutating_runs"`
	Mutations                     int            `json:"mutations"`
	ReplyRuns                     int            `json:"reply_runs"`
	ReactionRuns                  int            `json:"reaction_runs"`
	ReactionMutations             int            `json:"reaction_mutations"`
	CustomEmojiRuns               int            `json:"custom_emoji_runs"`
	CustomEmojiUses               int            `json:"custom_emoji_uses"`
	NoActionRuns                  int            `json:"no_action_runs"`
	ParseFallbacks                int            `json:"parse_fallbacks"`
	PlaceholderSummaries          int            `json:"placeholder_summaries"`
	InvalidPersonaJSON            int            `json:"invalid_persona_json"`
	HighContextNoAction           int            `json:"high_context_no_action"`
	LinkContextRuns               int            `json:"link_context_runs"`
	LinkContextNoAction           int            `json:"link_context_no_action"`
	LinkReplies                   int            `json:"link_replies"`
	LowConfidenceNoAction         int            `json:"low_confidence_no_action"`
	DynamicContextIssues          int            `json:"dynamic_context_issues"`
	MaxContextBudgetTokens        int            `json:"max_context_budget_tokens,omitempty"`
	MaxDynamicContextTokens       int            `json:"max_dynamic_context_tokens,omitempty"`
	MaxWorkerResultTokens         int            `json:"max_worker_result_tokens,omitempty"`
	MaxMemoryEvidenceTokens       int            `json:"max_memory_evidence_tokens,omitempty"`
	IntentActionMismatch          int            `json:"intent_action_mismatch"`
	DelegateNoVisibleAction       int            `json:"delegate_no_visible_action"`
	HandledByOtherNoAction        int            `json:"handled_by_other_no_action"`
	DirectedToActiveAgentNoAction int            `json:"directed_to_active_agent_no_action"`
	ToolCalls                     int            `json:"tool_calls"`
	MemoryLookups                 int            `json:"memory_lookups"`
	ExternalSearches              int            `json:"external_searches"`
	ThreadFetches                 int            `json:"thread_fetches"`
	PersonaRuns                   int            `json:"persona_runs,omitempty"`
	PersonaFailures               int            `json:"persona_failures,omitempty"`
	DelegateWorkerJobs            int            `json:"delegate_worker_jobs,omitempty"`
	TopEmoji                      map[string]int `json:"top_emoji,omitempty"`
	TopCustomEmoji                map[string]int `json:"top_custom_emoji,omitempty"`
	ReplySamples                  []string       `json:"reply_samples,omitempty"`
	ReactionSamples               []string       `json:"reaction_samples,omitempty"`
	SkippedSamples                []string       `json:"skipped_samples,omitempty"`
	FailedSamples                 []string       `json:"failed_samples,omitempty"`
}

type SlackDailyTriageComparison struct {
	RunDelta              int     `json:"run_delta"`
	ReplyRunDelta         int     `json:"reply_run_delta"`
	ReactionRunDelta      int     `json:"reaction_run_delta"`
	CustomEmojiUseDelta   int     `json:"custom_emoji_use_delta"`
	FailureDelta          int     `json:"failure_delta"`
	NewReplyRate          float64 `json:"new_reply_rate"`
	LegacyReplyRate       float64 `json:"legacy_reply_rate"`
	NewReactionRate       float64 `json:"new_reaction_rate"`
	LegacyReactionRate    float64 `json:"legacy_reaction_rate"`
	NewCustomEmojiRate    float64 `json:"new_custom_emoji_rate"`
	LegacyCustomEmojiRate float64 `json:"legacy_custom_emoji_rate"`
}

type SlackDailyReportFlag struct {
	Level   string `json:"level"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type SlackDailyReportRecord struct {
	ID          string            `json:"id"`
	ReportDate  string            `json:"report_date"`
	ChannelID   string            `json:"channel_id"`
	PostedAt    string            `json:"posted_at"`
	WindowStart string            `json:"window_start"`
	WindowEnd   string            `json:"window_end"`
	Post        PostMessageResult `json:"post"`
	Summary     string            `json:"summary"`
}

type slackDailyReportStore struct {
	reports *persistence.TypedCollection[SlackDailyReportRecord]
}

func newSlackDailyReportStore(cfg appconfig.PersistenceConfig, logger warnLogger) *slackDailyReportStore {
	reports, err := persistence.OpenTyped[SlackDailyReportRecord](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackDailyReportsCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		if logger != nil {
			logger.Warn("slack daily report store init failed", "error", err)
		}
		return nil
	}
	return &slackDailyReportStore{reports: reports}
}

func (s *slackDailyReportStore) Get(ctx context.Context, id string) (SlackDailyReportRecord, bool, error) {
	if s == nil || s.reports == nil || strings.TrimSpace(id) == "" {
		return SlackDailyReportRecord{}, false, nil
	}
	return s.reports.Get(ctx, id)
}

func (s *slackDailyReportStore) Set(ctx context.Context, record SlackDailyReportRecord) error {
	if s == nil || s.reports == nil {
		return nil
	}
	if strings.TrimSpace(record.ID) == "" {
		record.ID = dailyReportRecordID(record.ChannelID, record.ReportDate)
	}
	return s.reports.Set(ctx, record.ID, record)
}

func normalizeSlackDailyReportConfig(cfg appconfig.SlackDailyReportConfig) appconfig.SlackDailyReportConfig {
	cfg.ChannelID = strings.TrimSpace(cfg.ChannelID)
	cfg.TimeOfDay = strings.TrimSpace(cfg.TimeOfDay)
	if cfg.TimeOfDay == "" {
		cfg.TimeOfDay = slackDailyReportDefaultTime
	}
	cfg.Timezone = strings.TrimSpace(cfg.Timezone)
	if cfg.Timezone == "" {
		cfg.Timezone = slackDailyReportDefaultTZ
	}
	if cfg.Window <= 0 {
		cfg.Window = 24 * time.Hour
	}
	cfg.LegacySlackDBPath = strings.TrimSpace(cfg.LegacySlackDBPath)
	cfg.LegacyTriageArchiveDir = strings.TrimSpace(cfg.LegacyTriageArchiveDir)
	return cfg
}

func (s *Service) startDailyReportTicker() {
	if s == nil || !s.dailyReportConfig.Enabled || strings.TrimSpace(s.dailyReportConfig.ChannelID) == "" {
		return
	}
	s.dailyReportMu.Lock()
	defer s.dailyReportMu.Unlock()
	if s.dailyReportCancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.dailyReportCancel = cancel
	go s.runDailyReportTicker(ctx)
}

func (s *Service) stopDailyReportTicker() {
	if s == nil {
		return
	}
	s.dailyReportMu.Lock()
	cancel := s.dailyReportCancel
	s.dailyReportCancel = nil
	s.dailyReportMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *Service) runDailyReportTicker(ctx context.Context) {
	for {
		next, err := nextSlackDailyReportRun(timeNow().UTC(), s.dailyReportConfig)
		if err != nil {
			s.recordDailyReportTick(timeNow().UTC(), "", err)
			return
		}
		delay := time.Until(next)
		if delay < 0 {
			delay = 0
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		response, err := s.RunDailyReport(ctx, SlackDailyReportRunRequest{})
		channel := strings.TrimSpace(s.dailyReportConfig.ChannelID)
		if response.Post != nil {
			channel = response.Post.Channel
		}
		s.recordDailyReportTick(timeNow().UTC(), channel, err)
		if err != nil {
			s.logger.Warn("slack daily report failed", "error", err)
		} else if response.Post != nil && response.Post.OK {
			s.logger.Info("slack daily report posted", "channel", response.Post.Channel, "ts", response.Post.TS, "report_date", response.Report.ReportDate)
		}
	}
}

func (s *Service) RunDailyReport(ctx context.Context, request SlackDailyReportRunRequest) (SlackDailyReportRunResponse, error) {
	if s == nil {
		return SlackDailyReportRunResponse{}, fmt.Errorf("service is required")
	}
	cfg := s.dailyReportConfig
	channelID := strings.TrimSpace(firstNonEmpty(request.ChannelID, cfg.ChannelID))
	window := cfg.Window
	if strings.TrimSpace(request.Window) != "" {
		parsed, err := time.ParseDuration(strings.TrimSpace(request.Window))
		if err != nil || parsed <= 0 {
			return SlackDailyReportRunResponse{}, fmt.Errorf("invalid daily report window %q", request.Window)
		}
		window = parsed
	}
	windowStart, windowEnd, reportDate, err := slackDailyReportWindow(timeNow().UTC(), window, cfg.Timezone, request.ReportDate)
	if err != nil {
		return SlackDailyReportRunResponse{}, err
	}
	report, err := s.BuildDailyReport(ctx, windowStart, windowEnd, reportDate)
	if err != nil {
		return SlackDailyReportRunResponse{}, err
	}
	response := SlackDailyReportRunResponse{OK: true, Report: report}
	if request.DryRun {
		return response, nil
	}
	if channelID == "" {
		return response, fmt.Errorf("daily report channel is required")
	}
	recordID := dailyReportRecordID(channelID, reportDate)
	if !request.Force {
		if previous, ok, err := s.dailyReports.Get(ctx, recordID); err != nil {
			return response, err
		} else if ok {
			response.Skipped = true
			response.Reason = "already_posted"
			response.Record = &previous
			return response, nil
		}
	}
	postCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	post := s.deliverSlackPublicNotification(postCtx, slackPublicNotificationDelivery{
		Source:    slackPublicNotificationSourceDailyReport,
		Surface:   slackPublicNotificationSurfaceDailyReport,
		ChannelID: channelID,
		Text:      report.Text,
		DedupKey:  "daily-report:" + recordID,
	}).Post
	response.Post = &post
	if !post.OK {
		s.recordDailyReportPost(timeNow().UTC(), channelID, fmt.Errorf("post daily report: %s", firstNonEmpty(post.Error, post.Detail, "slack_post_failed")))
		return response, fmt.Errorf("post daily report: %s", firstNonEmpty(post.Error, post.Detail, "slack_post_failed"))
	}
	record := SlackDailyReportRecord{
		ID:          recordID,
		ReportDate:  reportDate,
		ChannelID:   channelID,
		PostedAt:    timeNow().UTC().Format(time.RFC3339Nano),
		WindowStart: report.WindowStart,
		WindowEnd:   report.WindowEnd,
		Post:        post,
		Summary:     firstLine(report.Text),
	}
	if err := s.dailyReports.Set(ctx, record); err != nil {
		return response, err
	}
	s.recordDailyReportPost(timeNow().UTC(), channelID, nil)
	response.Record = &record
	return response, nil
}

func (s *Service) BuildDailyReport(ctx context.Context, windowStart time.Time, windowEnd time.Time, reportDate string) (SlackDailyReport, error) {
	if windowEnd.IsZero() {
		windowEnd = timeNow().UTC()
	}
	if windowStart.IsZero() || !windowStart.Before(windowEnd) {
		windowStart = windowEnd.Add(-s.dailyReportConfig.Window)
	}
	runs, err := s.triage.ListRuns(ctx, 10000)
	if err != nil {
		return SlackDailyReport{}, err
	}
	windowRuns := filterTriageRunsSince(runs, windowStart, windowEnd)
	customEmoji := s.workspaceCustomEmojiSnapshot()
	newMetrics := buildSlackDailyTriageMetrics("new_oneesama", windowRuns, customEmoji)
	legacyRuns, legacyErr := loadLegacySlackdDailyTriageRuns(ctx, s.dailyReportConfig, windowStart, windowEnd)
	legacyMetrics := buildSlackDailyTriageMetrics("legacy_slackd", legacyRuns, customEmoji)
	legacyMetrics.Available = legacyErr == nil
	if legacyErr != nil {
		legacyMetrics.Error = legacyErr.Error()
	}
	comparison := compareSlackDailyTriageMetrics(newMetrics, legacyMetrics)
	report := SlackDailyReport{
		GeneratedAt: timeNow().UTC().Format(time.RFC3339Nano),
		ReportDate:  reportDate,
		WindowStart: windowStart.UTC().Format(time.RFC3339Nano),
		WindowEnd:   windowEnd.UTC().Format(time.RFC3339Nano),
		WindowHours: windowEnd.Sub(windowStart).Hours(),
		New:         newMetrics,
		Legacy:      legacyMetrics,
		Comparison:  comparison,
	}
	report.Diary = buildSlackDailyDiary(windowRuns, legacyRuns)
	report.Flags = buildSlackDailyReportFlags(report)
	report.Text = formatSlackDailyReportText(report)
	return report, nil
}
