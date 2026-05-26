// Command oneesama-triage-benchmark replays recent Slack threads through
// Oneesama's live triage dry-run path. It is read-only: Slack fetching is
// via conversations.history/replies and the triage call uses dry_run=true,
// so posting, worker starts, reactions, and memory writes
// are blocked by the service.
package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/slackagent"
)

//go:embed review.html
var benchmarkReviewHTML string

var (
	slackUserIDPattern    = regexp.MustCompile(`(?:<@|@)([UW][A-Z0-9]+)`)
	slackChannelIDPattern = regexp.MustCompile(`(?:<#|#)([CG][A-Z0-9]+)`)
)

const benchmarkNameResolutionTimeout = 25 * time.Second

const benchmarkSlackNameCacheRelPath = "cache/slack_name_map.json"

type benchmarkReport struct {
	GeneratedAt      string                                    `json:"generatedAt"`
	VariantID        string                                    `json:"variantId"`
	SlackAgentURL    string                                    `json:"slackAgentUrl"`
	Mode             string                                    `json:"mode"`
	Since            string                                    `json:"since"`
	Channels         []string                                  `json:"channels"`
	Fixtures         []string                                  `json:"fixtures,omitempty"`
	MaxThreads       int                                       `json:"maxThreads,omitempty"`
	Truncated        bool                                      `json:"truncated"`
	Stats            []slackagent.SlackBackfillReplayLiveStats `json:"stats,omitempty"`
	ThreadsSeen      int                                       `json:"threadsSeen"`
	ThreadsReplayed  int                                       `json:"threadsReplayed"`
	Summary          benchmarkSummary                          `json:"summary"`
	Rows             []benchmarkRow                            `json:"rows"`
	Variants         []benchmarkVariant                        `json:"variants,omitempty"`
	VariantSummaries []benchmarkVariantSummary                 `json:"variantSummaries,omitempty"`
	Judge            benchmarkJudgeConfig                      `json:"judge,omitempty"`
	GoldInputs       []string                                  `json:"goldInputs,omitempty"`
	Runtime          map[string]any                            `json:"runtime,omitempty"`
}

type benchmarkSummary struct {
	ByFinalDecision      map[string]int `json:"byFinalDecision"`
	ByPersonaDecision    map[string]int `json:"byPersonaDecision"`
	ByVisibleReplyReason map[string]int `json:"byVisibleReplyReason"`
	ByPipelineSmell      map[string]int `json:"byPipelineSmell"`
	ByFixtureLabel       map[string]int `json:"byFixtureLabel,omitempty"`
	ByFixtureOutcome     map[string]int `json:"byFixtureOutcome,omitempty"`
	ByGoldStatus         map[string]int `json:"byGoldStatus,omitempty"`
	ByJudgeVerdict       map[string]int `json:"byJudgeVerdict,omitempty"`
	ByJudgeFlag          map[string]int `json:"byJudgeFlag,omitempty"`
	FixturePasses        int            `json:"fixturePasses,omitempty"`
	FixtureFailures      int            `json:"fixtureFailures,omitempty"`
	GoldRows             int            `json:"goldRows,omitempty"`
	GoldPasses           int            `json:"goldPasses,omitempty"`
	GoldFailures         int            `json:"goldFailures,omitempty"`
	GoldUnrated          int            `json:"goldUnrated,omitempty"`
	Errors               int            `json:"errors"`
	JudgeRows            int            `json:"judgeRows,omitempty"`
	JudgeErrors          int            `json:"judgeErrors,omitempty"`
	JudgeSkipped         int            `json:"judgeSkipped,omitempty"`
	JudgeAverageScore    float64        `json:"judgeAverageScore,omitempty"`
}

type benchmarkRow struct {
	VariantID            string                 `json:"variantId"`
	CaseID               string                 `json:"caseId,omitempty"`
	CaseDescription      string                 `json:"caseDescription,omitempty"`
	FixtureLabel         string                 `json:"fixtureLabel,omitempty"`
	FixturePassed        *bool                  `json:"fixturePassed,omitempty"`
	FixtureReason        string                 `json:"fixtureReason,omitempty"`
	FixtureFailureLayer  string                 `json:"fixtureFailureLayer,omitempty"`
	FixtureFailureDetail string                 `json:"fixtureFailureDetail,omitempty"`
	ChannelID            string                 `json:"channelId"`
	ThreadTS             string                 `json:"threadTs"`
	MessageCount         int                    `json:"messageCount"`
	PersonaDecision      string                 `json:"personaDecision,omitempty"`
	FinalDecision        string                 `json:"finalDecision,omitempty"`
	GateDecision         string                 `json:"gateDecision,omitempty"`
	VisibleReplyAllowed  bool                   `json:"visibleReplyAllowed"`
	VisibleReplyReasons  []string               `json:"visibleReplyReasons,omitempty"`
	WorkerRequests       int                    `json:"workerRequests"`
	PipelineSmellSignals []string               `json:"pipelineSmellSignals,omitempty"`
	GoldStatus           string                 `json:"goldStatus,omitempty"`
	GoldExpected         string                 `json:"goldExpected,omitempty"`
	GoldActual           string                 `json:"goldActual,omitempty"`
	GoldReason           string                 `json:"goldReason,omitempty"`
	GoldHumanVerdict     string                 `json:"goldHumanVerdict,omitempty"`
	GoldNotes            string                 `json:"goldNotes,omitempty"`
	Judge                *benchmarkJudgeVerdict `json:"judge,omitempty"`
	JudgeError           string                 `json:"judgeError,omitempty"`
	JudgeSkipped         bool                   `json:"judgeSkipped,omitempty"`
	Error                string                 `json:"error,omitempty"`
}

type benchmarkVariant struct {
	VariantID   string         `json:"variantId"`
	Description string         `json:"description,omitempty"`
	Knobs       map[string]any `json:"knobs,omitempty"`
	SourcePath  string         `json:"sourcePath,omitempty"`
}

type benchmarkVariantSummary struct {
	VariantID   string           `json:"variantId"`
	Description string           `json:"description,omitempty"`
	Knobs       map[string]any   `json:"knobs,omitempty"`
	Summary     benchmarkSummary `json:"summary"`
}

type benchmarkJudgeConfig struct {
	Enabled bool   `json:"enabled"`
	Model   string `json:"model,omitempty"`
	URL     string `json:"url,omitempty"`
	MaxRows int    `json:"maxRows,omitempty"`
}

type benchmarkJudgeVerdict struct {
	Score     float64  `json:"score"`
	Verdict   string   `json:"verdict"`
	Flags     []string `json:"flags,omitempty"`
	Reasoning string   `json:"reasoning,omitempty"`
}

type benchmarkJudgeOptions struct {
	benchmarkJudgeConfig
	APIKey string
}

type benchmarkJudgeBudget struct {
	MaxRows int
	Used    int
}

type benchmarkFixture struct {
	CaseID      string                                `json:"caseId"`
	Description string                                `json:"description,omitempty"`
	Label       string                                `json:"label"`
	Tags        []string                              `json:"tags,omitempty"`
	SourceRefs  []string                              `json:"sourceRefs,omitempty"`
	Thread      slackagent.SlackTriageReplayThread    `json:"thread"`
	Candidate   slackagent.SlackVisibleReplyCandidate `json:"candidate,omitempty"`
	Expected    benchmarkFixtureExpected              `json:"expected,omitempty"`
}

type benchmarkDetail struct {
	Schema        string               `json:"schema"`
	GeneratedAt   string               `json:"generatedAt"`
	VariantID     string               `json:"variantId"`
	SlackAgentURL string               `json:"slackAgentUrl"`
	Mode          string               `json:"mode"`
	NameMap       benchmarkNameMap     `json:"nameMap"`
	Runtime       map[string]any       `json:"runtime,omitempty"`
	Rows          []benchmarkDetailRow `json:"rows"`
}

type benchmarkNameMap struct {
	Users    map[string]string `json:"users,omitempty"`
	Channels map[string]string `json:"channels,omitempty"`
}

type benchmarkNameMapCache struct {
	Schema    string            `json:"schema"`
	UpdatedAt string            `json:"updatedAt"`
	NameMap   benchmarkNameMap  `json:"nameMap"`
	Users     map[string]string `json:"users,omitempty"`
	Channels  map[string]string `json:"channels,omitempty"`
	Metadata  map[string]any    `json:"metadata,omitempty"`
}

type benchmarkDetailRow struct {
	VariantID               string                              `json:"variantId"`
	CaseID                  string                              `json:"caseId,omitempty"`
	CaseDescription         string                              `json:"caseDescription,omitempty"`
	FixtureLabel            string                              `json:"fixtureLabel,omitempty"`
	ChannelID               string                              `json:"channelId"`
	ThreadTS                string                              `json:"threadTs"`
	Messages                []slackagent.SlackInboundMessage    `json:"messages"`
	DryRun                  *slackagent.SlackTriageDryRunResult `json:"dryRun,omitempty"`
	HistoricalWorkerResults []benchmarkHistoricalWorkerResult   `json:"historicalWorkerResults,omitempty"`
	Error                   string                              `json:"error,omitempty"`
}

type benchmarkHistoricalWorkerResult struct {
	JobID              string                                  `json:"jobId"`
	Provider           string                                  `json:"provider,omitempty"`
	Status             string                                  `json:"status"`
	FailureCode        string                                  `json:"failureCode,omitempty"`
	CreatedAt          string                                  `json:"createdAt,omitempty"`
	UpdatedAt          string                                  `json:"updatedAt,omitempty"`
	SessionKind        string                                  `json:"sessionKind,omitempty"`
	DelegationScope    string                                  `json:"delegationScope,omitempty"`
	TaskPreview        string                                  `json:"taskPreview,omitempty"`
	Result             string                                  `json:"result,omitempty"`
	Error              string                                  `json:"error,omitempty"`
	Envelope           agentrunner.WorkerResultEnvelope        `json:"envelope"`
	VisibleText        string                                  `json:"visibleText,omitempty"`
	VisibleGateAllowed bool                                    `json:"visibleGateAllowed"`
	VisibleGateReason  string                                  `json:"visibleGateReason,omitempty"`
	EvidenceAnchors    []slackagent.SlackVisibleEvidenceAnchor `json:"evidenceAnchors,omitempty"`
	WouldPost          bool                                    `json:"wouldPost"`
	WouldPostReason    string                                  `json:"wouldPostReason,omitempty"`
}

func recordBenchmarkRow(report *benchmarkReport, row benchmarkRow) {
	report.Rows = append(report.Rows, row)
	report.ThreadsReplayed++
	recordRow(&report.Summary, row)
}

type benchmarkFixtureExpected struct {
	FinalDecision           string   `json:"finalDecision,omitempty"`
	VisibleReplyAllowed     *bool    `json:"visibleReplyAllowed,omitempty"`
	VisibleReplyReason      string   `json:"visibleReplyReason,omitempty"`
	MinWorkerRequests       int      `json:"minWorkerRequests,omitempty"`
	AnyVisibleReplyReasons  []string `json:"anyVisibleReplyReasons,omitempty"`
	AnyPipelineSmellSignals []string `json:"anyPipelineSmellSignals,omitempty"`
}

type benchmarkGoldInput struct {
	Schema  string              `json:"schema,omitempty"`
	Cases   []benchmarkGoldCase `json:"cases,omitempty"`
	Items   []benchmarkGoldCase `json:"items,omitempty"`
	Reviews []benchmarkGoldCase `json:"reviews,omitempty"`
}

type benchmarkGoldCase struct {
	DedupKey            string                   `json:"dedupKey,omitempty"`
	CaseID              string                   `json:"caseId,omitempty"`
	ChannelID           string                   `json:"channelId,omitempty"`
	ThreadTS            string                   `json:"threadTs,omitempty"`
	VariantID           string                   `json:"variantId,omitempty"`
	HumanVerdict        string                   `json:"humanVerdict,omitempty"`
	Verdict             string                   `json:"verdict,omitempty"`
	Vote                string                   `json:"vote,omitempty"`
	Notes               string                   `json:"notes,omitempty"`
	HumanNotes          string                   `json:"humanNotes,omitempty"`
	ExpectedKind        string                   `json:"expectedKind,omitempty"`
	ExpectedDecision    string                   `json:"expectedDecision,omitempty"`
	Expected            benchmarkGoldExpectation `json:"expected,omitempty"`
	Actual              benchmarkGoldExpectation `json:"actual,omitempty"`
	Observed            benchmarkGoldExpectation `json:"observed,omitempty"`
	Row                 benchmarkGoldExpectation `json:"row,omitempty"`
	Machine             benchmarkGoldExpectation `json:"machine,omitempty"`
	FinalDecision       string                   `json:"finalDecision,omitempty"`
	VisibleReplyAllowed *bool                    `json:"visibleReplyAllowed,omitempty"`
	WorkerRequests      int                      `json:"workerRequests,omitempty"`
}

type benchmarkGoldExpectation struct {
	Kind                string `json:"kind,omitempty"`
	Freeform            string `json:"freeform,omitempty"`
	FinalDecision       string `json:"finalDecision,omitempty"`
	Decision            string `json:"decision,omitempty"`
	VisibleReplyAllowed *bool  `json:"visibleReplyAllowed,omitempty"`
	MinWorkerRequests   int    `json:"minWorkerRequests,omitempty"`
}

type benchmarkGoldStore struct {
	enabled  bool
	paths    []string
	byThread map[string]benchmarkGoldCase
	byCase   map[string]benchmarkGoldCase
}

type triageRunRequest struct {
	ChannelID              string                           `json:"channel_id"`
	Messages               []slackagent.SlackInboundMessage `json:"messages"`
	DryRun                 bool                             `json:"dry_run"`
	IgnoreExistingBotReply bool                             `json:"ignore_existing_bot_reply"`
	RerunForce             bool                             `json:"rerun_force"`
}

type triageRunResponse struct {
	OK     bool                               `json:"ok"`
	Error  string                             `json:"error,omitempty"`
	DryRun slackagent.SlackTriageDryRunResult `json:"dry_run"`
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout io.Writer, stderr io.Writer) int {
	fs := flag.NewFlagSet("oneesama-triage-benchmark", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var (
		slackURL          string
		liveMode          bool
		channels          string
		token             string
		botIDs            string
		since             time.Duration
		after             string
		before            string
		maxPerChan        int
		maxPerChanThreads int
		maxTotalThreads   int
		outputPath        string
		detailPath        string
		workerJobsInput   string
		format            string
		variantID         string
		timeout           time.Duration
		dryRunTimeout     time.Duration
		parallel          int
		fixtures          stringListFlag
		configSets        stringListFlag
		goldInputs        stringListFlag
		serveReview       bool
		reviewListen      string
		reviewOutput      string
		nameMapCachePath  string
		judgeURL          string
		judgeModel        string
		judgeAPIKey       string
		judgeMaxRows      int
	)
	fs.StringVar(&slackURL, "slack-url", firstNonEmpty(os.Getenv("ONEESAMA_SLACK_AGENT_URL"), os.Getenv("ONEESAMA_MONITOR_SLACK_URL"), "http://127.0.0.1:8780"), "Local oneesama slack-agent URL.")
	fs.BoolVar(&liveMode, "live", true, "Live Slack scan mode. This is currently the only supported input mode.")
	fs.Var(&fixtures, "fixture", "Fixture JSON path or glob. Repeatable; extra positional args are also treated as fixtures when set.")
	fs.Var(&configSets, "config-set", "Variant config JSON file, directory, or glob. Repeatable. This first pass records variant metadata and replays the same cases for every variant.")
	fs.Var(&goldInputs, "gold-input", "Human review JSON path or glob. Repeatable. Adds replayable gold labels keyed by channelId+threadTs+variantId or caseId+variantId.")
	fs.StringVar(&channels, "channel", "auto", "Comma-separated Slack channel ids or exactly 'auto'.")
	fs.StringVar(&token, "token", "", "Slack bot token. Defaults to ONEESAMA_SLACK_BOT_TOKEN.")
	fs.StringVar(&botIDs, "bot-user-ids", "", "Comma-separated bot user ids used only for legacy stats.")
	fs.DurationVar(&since, "since", 24*time.Hour, "Live Slack scan window.")
	fs.StringVar(&after, "after", "", "Optional absolute window start. Accepts RFC3339 or '2006-01-02 15:04' in Asia/Shanghai.")
	fs.StringVar(&before, "before", "", "Optional absolute window end. Accepts RFC3339 or '2006-01-02 15:04' in Asia/Shanghai.")
	fs.IntVar(&maxPerChan, "max-messages-per-channel", 200, "Max conversations.history rows per channel.")
	fs.IntVar(&maxPerChanThreads, "max-threads-per-channel", 3, "Max root threads to collect per channel.")
	fs.IntVar(&maxTotalThreads, "max-threads", 24, "Max total root threads to dry-run across all channels. Use 0 to disable the global cap.")
	fs.StringVar(&outputPath, "output", "", "Optional JSON report path. Use '-' or omit for stdout JSON.")
	fs.StringVar(&detailPath, "detail-output", "", "Optional JSON path for full per-row detail (messages + dry-run result). Required by the human review UI.")
	fs.StringVar(&workerJobsInput, "worker-jobs-input", defaultWorkerJobsInput(), "Optional agent_runner_jobs.json path. When present, detail rows include historical delegated worker results for matching Slack threads.")
	fs.StringVar(&format, "format", "json", "Output format: json or markdown.")
	fs.StringVar(&variantID, "variant-id", "current", "Variant/config id recorded in the report.")
	fs.DurationVar(&timeout, "timeout", 10*time.Minute, "Overall benchmark timeout.")
	fs.DurationVar(&dryRunTimeout, "dry-run-timeout", 90*time.Second, "HTTP timeout for each /slack/triage/run dry-run request.")
	fs.IntVar(&parallel, "parallel", 5, "Number of concurrent dry-run requests. Use cautiously against live services.")
	fs.BoolVar(&serveReview, "serve-review", false, "Start a temporary local review UI after the dry-run completes. Serves embedded review.html, detail.json, summary.json, and accepts human-review POSTs.")
	fs.StringVar(&reviewListen, "review-listen", "127.0.0.1:0", "Listen address for --serve-review.")
	fs.StringVar(&reviewOutput, "review-output", "", "Path to save human review JSON submitted by --serve-review. Defaults next to --detail-output or the current directory.")
	fs.StringVar(&nameMapCachePath, "name-map-cache", "", "Workspace-level Slack name map cache path. Defaults to ONEESAMA_TRIAGE_BENCHMARK_NAME_MAP_CACHE or {ONEESAMA_SLACK_WORKSPACE_DIR}/cache/slack_name_map.json.")
	fs.StringVar(&judgeURL, "judge-url", firstNonEmpty(os.Getenv("ONEESAMA_TRIAGE_BENCHMARK_JUDGE_URL"), os.Getenv("OPENAI_BASE_URL")), "Optional OpenAI-compatible chat completions URL or base URL for LLM judge.")
	fs.StringVar(&judgeModel, "judge-model", os.Getenv("ONEESAMA_TRIAGE_BENCHMARK_JUDGE_MODEL"), "Optional judge model. When set, each replay row receives an LLM judge signal.")
	fs.StringVar(&judgeAPIKey, "judge-api-key", firstNonEmpty(os.Getenv("ONEESAMA_TRIAGE_BENCHMARK_JUDGE_API_KEY"), os.Getenv("ONEESAMA_OPENAI_API_KEY"), os.Getenv("MAB_OPENAI_API_KEY"), os.Getenv("OPENAI_API_KEY")), "Optional judge API key. Defaults to ONEESAMA_TRIAGE_BENCHMARK_JUDGE_API_KEY / OpenAI envs.")
	fs.IntVar(&judgeMaxRows, "judge-max-rows", 0, "Maximum rows to judge. 0 means all replayed rows when judge is enabled.")
	fs.Usage = func() {
		fmt.Fprintf(stderr, "Usage: oneesama-triage-benchmark [--live --channel auto|C123,C456] [--fixture 'internal/slackagent/testdata/triage_benchmark/*.json'] [--output report.json]\n\n")
		fmt.Fprintf(stderr, "Replays Slack threads through /slack/triage/run with dry_run=true. No Slack posts or workers are started.\n\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	judgeOpts, err := newBenchmarkJudgeOptions(judgeURL, judgeModel, judgeAPIKey, judgeMaxRows)
	if err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: %v\n", err)
		return 2
	}
	judgeBudget := benchmarkJudgeBudget{MaxRows: judgeOpts.MaxRows}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	fixtureInputs := append([]string(nil), fixtures...)
	fixtureInputs = append(fixtureInputs, fs.Args()...)
	fixturePaths, err := expandFixturePaths(fixtureInputs)
	if err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: %v\n", err)
		return 1
	}
	mode := "live"
	if len(fixturePaths) > 0 {
		mode = "fixture"
	}
	if !liveMode && mode != "fixture" {
		_, _ = fmt.Fprintln(stderr, "oneesama-triage-benchmark: --fixture path is required when --live=false")
		return 2
	}
	scanSince, scanNow, sinceLabel, err := resolveBenchmarkWindow(since, after, before, time.Now())
	if err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: %v\n", err)
		return 2
	}
	variants, err := loadBenchmarkVariants(configSets, variantID)
	if err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: %v\n", err)
		return 1
	}
	reportVariantID := strings.TrimSpace(variantID)
	if len(variants) > 1 {
		reportVariantID = "multi"
	}
	goldStore, err := loadBenchmarkGoldInputs(goldInputs)
	if err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: %v\n", err)
		return 1
	}
	report := benchmarkReport{
		GeneratedAt:   time.Now().UTC().Format(time.RFC3339),
		VariantID:     reportVariantID,
		SlackAgentURL: strings.TrimRight(strings.TrimSpace(slackURL), "/"),
		Mode:          mode,
		Since:         sinceLabel,
		Fixtures:      fixturePaths,
		MaxThreads:    maxTotalThreads,
		Summary:       newBenchmarkSummary(),
		Variants:      variants,
		Judge:         judgeOpts.benchmarkJudgeConfig,
		GoldInputs:    goldStore.paths,
	}
	detail := benchmarkDetail{
		Schema:        "oneesama.triage.benchmark_detail.v1",
		GeneratedAt:   report.GeneratedAt,
		VariantID:     report.VariantID,
		SlackAgentURL: report.SlackAgentURL,
		Mode:          mode,
		NameMap: benchmarkNameMap{
			Users:    map[string]string{},
			Channels: map[string]string{},
		},
	}
	collectDetail := strings.TrimSpace(detailPath) != "" || serveReview
	client := &http.Client{Timeout: dryRunTimeout}
	runtime := fetchBenchmarkRuntimeMetadata(ctx, report.SlackAgentURL)
	report.Runtime = runtime
	detail.Runtime = runtime
	if mode == "fixture" {
		selectedFixturePaths := fixturePaths
		if maxTotalThreads > 0 && len(selectedFixturePaths) > maxTotalThreads {
			selectedFixturePaths = selectedFixturePaths[:maxTotalThreads]
			report.Truncated = true
		}
		report.ThreadsSeen = len(fixturePaths)
		for _, variant := range variants {
			for _, path := range selectedFixturePaths {
				fixture, readErr := readBenchmarkFixture(path)
				if readErr != nil {
					row := benchmarkRow{VariantID: variant.VariantID, CaseID: strings.TrimSpace(path), Error: readErr.Error()}
					applyBenchmarkGold(&row, goldStore)
					recordBenchmarkRow(&report, row)
					if collectDetail {
						detail.Rows = append(detail.Rows, benchmarkDetailRow{
							VariantID: variant.VariantID,
							CaseID:    strings.TrimSpace(path),
							Error:     readErr.Error(),
						})
					}
					continue
				}
				fmt.Fprintf(stderr, "oneesama-triage-benchmark: dry-run fixture %s variant=%s\n", fixture.CaseID, variant.VariantID)
				row, dryRun := dryRunThread(ctx, client, report.SlackAgentURL, variant.VariantID, fixture.Thread)
				if strings.TrimSpace(fixture.Candidate.Message) != "" {
					row = evaluateCandidateFixture(variant.VariantID, fixture)
					dryRun = nil
				}
				applyFixtureResult(&row, fixture)
				applyBenchmarkJudge(ctx, client, judgeOpts, &judgeBudget, &row, fixture.Thread, &fixture)
				applyBenchmarkGold(&row, goldStore)
				recordBenchmarkRow(&report, row)
				if collectDetail {
					detail.Rows = append(detail.Rows, benchmarkDetailRow{
						VariantID:       variant.VariantID,
						CaseID:          fixture.CaseID,
						CaseDescription: fixture.Description,
						FixtureLabel:    fixture.Label,
						ChannelID:       fixture.Thread.ChannelID,
						ThreadTS:        fixture.Thread.ThreadTS,
						Messages:        append([]slackagent.SlackInboundMessage(nil), fixture.Thread.Messages...),
						DryRun:          dryRun,
						Error:           row.Error,
					})
				}
			}
		}
	} else {
		token = firstNonEmpty(
			strings.TrimSpace(token),
			strings.TrimSpace(os.Getenv("ONEESAMA_SLACK_BOT_TOKEN")),
			strings.TrimSpace(os.Getenv("SLACK_BOT_TOKEN")),
			strings.TrimSpace(os.Getenv("MAB_SLACK_BOT_TOKEN")),
		)
		if token == "" {
			_, _ = fmt.Fprintln(stderr, "oneesama-triage-benchmark: --token or ONEESAMA_SLACK_BOT_TOKEN / SLACK_BOT_TOKEN / MAB_SLACK_BOT_TOKEN is required")
			return 1
		}
		channelIDs, err := resolveChannels(ctx, channels, token, stderr)
		if err != nil {
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: %v\n", err)
			return 1
		}
		report.Channels = channelIDs
		botUserIDs := splitCSV(botIDs)
		threadBuckets := make([][]slackagent.SlackTriageReplayThread, 0, len(channelIDs))
		for _, channelID := range channelIDs {
			channelThreadLimit := maxPerChanThreads
			threads, stats, scanErr := slackagent.SlackTriageReplayLiveThreads(ctx, slackagent.SlackBackfillReplayLiveOptions{
				BotToken:              token,
				BotUserIDs:            botUserIDs,
				ChannelID:             channelID,
				Since:                 scanSince,
				MaxMessagesPerChannel: maxPerChan,
				MaxThreads:            channelThreadLimit,
				Now:                   scanNow,
				Latest:                scanNow,
			})
			if scanErr != nil {
				stats.ChannelID = channelID
				stats.Warnings = append(stats.Warnings, fmt.Sprintf("thread scan failed: %v", scanErr))
			}
			report.Stats = append(report.Stats, stats)
			report.ThreadsSeen += len(threads)
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: channel %s scan found %d thread(s)\n", channelID, len(threads))
			threadBuckets = append(threadBuckets, threads)
		}
		replayThreads := selectBalancedReplayThreads(threadBuckets, maxTotalThreads)
		if maxTotalThreads > 0 && len(replayThreads) < report.ThreadsSeen {
			report.Truncated = true
		}
		for _, variant := range variants {
			dryRunResults := dryRunReplayThreads(ctx, client, report.SlackAgentURL, variant.VariantID, replayThreads, parallel, stderr)
			for _, dryRunResult := range dryRunResults {
				row := dryRunResult.row
				dryRun := dryRunResult.dryRun
				thread := dryRunResult.thread
				applyBenchmarkJudge(ctx, client, judgeOpts, &judgeBudget, &row, thread, nil)
				applyBenchmarkGold(&row, goldStore)
				recordBenchmarkRow(&report, row)
				if collectDetail {
					detail.Rows = append(detail.Rows, benchmarkDetailRow{
						VariantID: variant.VariantID,
						ChannelID: thread.ChannelID,
						ThreadTS:  thread.ThreadTS,
						Messages:  append([]slackagent.SlackInboundMessage(nil), thread.Messages...),
						DryRun:    dryRun,
						Error:     row.Error,
					})
				}
			}
		}
	}
	report.VariantSummaries = buildVariantSummaries(variants, report.Rows)
	if collectDetail {
		attachHistoricalWorkerResults(ctx, &detail, workerJobsInput, stderr)
		nameMapCachePath = resolveBenchmarkNameMapCachePath(nameMapCachePath)
		nameCtx, nameCancel := context.WithTimeout(ctx, benchmarkNameResolutionTimeout)
		detail.NameMap = resolveSlackNamesWithCache(nameCtx, token, detail.Rows, nameMapCachePath, stderr)
		if nameCtx.Err() != nil {
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: slack name resolution stopped after %s: %v\n", benchmarkNameResolutionTimeout, nameCtx.Err())
		}
		nameCancel()
	}

	var data []byte
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "", "json":
		data, err = json.MarshalIndent(report, "", "  ")
		if err != nil {
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: marshal report: %v\n", err)
			return 1
		}
	case "markdown", "md":
		data = []byte(renderMarkdownReport(report))
	default:
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: unsupported --format %q; expected json or markdown\n", format)
		return 2
	}
	if err := writeOutput(outputPath, stdout, data); err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: write output: %v\n", err)
		return 1
	}
	if strings.TrimSpace(detailPath) != "" {
		detailBytes, err := json.MarshalIndent(detail, "", "  ")
		if err != nil {
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: marshal detail: %v\n", err)
			return 1
		}
		if err := os.WriteFile(detailPath, append(detailBytes, '\n'), 0o644); err != nil {
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: write detail: %v\n", err)
			return 1
		}
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: wrote detail with %d row(s), %d user name(s), %d channel name(s) to %s\n",
			len(detail.Rows), len(detail.NameMap.Users), len(detail.NameMap.Channels), detailPath)
	}
	fmt.Fprintf(stderr, "oneesama-triage-benchmark: replayed %d thread(s); errors=%d; fixture_failures=%d; decisions=%v\n", report.ThreadsReplayed, report.Summary.Errors, report.Summary.FixtureFailures, report.Summary.ByFinalDecision)
	if serveReview {
		if err := serveBenchmarkReview(context.Background(), reviewListen, reviewOutput, report, detail, stderr); err != nil {
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: review server: %v\n", err)
			return 1
		}
	}
	return 0
}

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

func loadBenchmarkGoldInputs(inputs []string) (benchmarkGoldStore, error) {
	store := benchmarkGoldStore{
		enabled:  len(inputs) > 0,
		byThread: map[string]benchmarkGoldCase{},
		byCase:   map[string]benchmarkGoldCase{},
	}
	paths, err := expandGoldPaths(inputs)
	if err != nil {
		return store, err
	}
	store.paths = paths
	for _, path := range paths {
		cases, err := readBenchmarkGoldCases(path)
		if err != nil {
			return store, err
		}
		for _, gold := range cases {
			gold = normalizeBenchmarkGoldCase(gold)
			if gold.ChannelID != "" && gold.ThreadTS != "" {
				store.byThread[benchmarkGoldThreadKey(gold.ChannelID, gold.ThreadTS, gold.VariantID)] = gold
			}
			if gold.CaseID != "" {
				store.byCase[benchmarkGoldCaseKey(gold.CaseID, gold.VariantID)] = gold
			}
		}
	}
	return store, nil
}

func newBenchmarkGoldStoreFromCases(cases []benchmarkGoldCase) benchmarkGoldStore {
	store := benchmarkGoldStore{
		enabled:  len(cases) > 0,
		byThread: map[string]benchmarkGoldCase{},
		byCase:   map[string]benchmarkGoldCase{},
	}
	for _, gold := range cases {
		gold = normalizeBenchmarkGoldCase(gold)
		if gold.ChannelID != "" && gold.ThreadTS != "" {
			store.byThread[benchmarkGoldThreadKey(gold.ChannelID, gold.ThreadTS, gold.VariantID)] = gold
		}
		if gold.CaseID != "" {
			store.byCase[benchmarkGoldCaseKey(gold.CaseID, gold.VariantID)] = gold
		}
	}
	return store
}

func expandGoldPaths(inputs []string) ([]string, error) {
	var out []string
	for _, input := range inputs {
		input = strings.TrimSpace(input)
		if input == "" {
			continue
		}
		matches, err := filepath.Glob(input)
		if err != nil {
			return nil, fmt.Errorf("gold-input glob %q: %w", input, err)
		}
		if len(matches) == 0 {
			out = append(out, input)
			continue
		}
		sort.Strings(matches)
		out = append(out, matches...)
	}
	return uniqueStrings(out), nil
}

func readBenchmarkGoldCases(path string) ([]benchmarkGoldCase, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read gold-input %s: %w", path, err)
	}
	cases, err := decodeBenchmarkGoldCases(data)
	if err != nil {
		return nil, fmt.Errorf("decode gold-input %s: %w", path, err)
	}
	return cases, nil
}

func decodeBenchmarkGoldCases(data []byte) ([]benchmarkGoldCase, error) {
	var direct []benchmarkGoldCase
	if err := json.Unmarshal(data, &direct); err == nil && len(direct) > 0 {
		return direct, nil
	}
	var wrapper benchmarkGoldInput
	if err := json.Unmarshal(data, &wrapper); err != nil {
		return nil, err
	}
	out := append([]benchmarkGoldCase{}, wrapper.Cases...)
	out = append(out, wrapper.Items...)
	out = append(out, wrapper.Reviews...)
	return out, nil
}

func normalizeBenchmarkGoldCase(gold benchmarkGoldCase) benchmarkGoldCase {
	gold.CaseID = strings.TrimSpace(gold.CaseID)
	gold.ChannelID = strings.TrimSpace(gold.ChannelID)
	gold.ThreadTS = strings.TrimSpace(gold.ThreadTS)
	gold.VariantID = strings.TrimSpace(gold.VariantID)
	if gold.DedupKey != "" && (gold.ChannelID == "" || gold.ThreadTS == "" || gold.VariantID == "") {
		parts := strings.Split(gold.DedupKey, "+")
		if len(parts) >= 1 && gold.ChannelID == "" {
			gold.ChannelID = strings.TrimSpace(parts[0])
		}
		if len(parts) >= 2 && gold.ThreadTS == "" {
			gold.ThreadTS = strings.TrimSpace(parts[1])
		}
		if len(parts) >= 3 && gold.VariantID == "" {
			gold.VariantID = strings.TrimSpace(parts[2])
		}
	}
	gold.HumanVerdict = normalizeGoldToken(firstNonEmpty(gold.HumanVerdict, gold.Verdict, gold.Vote))
	gold.Notes = firstNonEmpty(gold.Notes, gold.HumanNotes)
	return gold
}

func applyBenchmarkGold(row *benchmarkRow, store benchmarkGoldStore) {
	if !store.enabled {
		return
	}
	gold, ok := lookupBenchmarkGold(row, store)
	if !ok {
		row.GoldStatus = "unrated"
		row.GoldActual = benchmarkGoldActualDecision(*row)
		row.GoldReason = "no_gold_label"
		return
	}
	expected, ok := benchmarkGoldExpectedBehavior(gold)
	row.GoldHumanVerdict = gold.HumanVerdict
	row.GoldNotes = gold.Notes
	row.GoldActual = benchmarkGoldActualDecision(*row)
	if !ok {
		row.GoldStatus = "unrated"
		row.GoldReason = "gold_label_missing_comparable_expected"
		return
	}
	row.GoldExpected = benchmarkGoldExpectedLabel(expected)
	status, reason := evaluateBenchmarkGold(*row, expected)
	row.GoldStatus = status
	row.GoldReason = reason
}

func lookupBenchmarkGold(row *benchmarkRow, store benchmarkGoldStore) (benchmarkGoldCase, bool) {
	variants := []string{strings.TrimSpace(row.VariantID), "current", ""}
	variants = uniqueStrings(variants)
	if row.ChannelID != "" && row.ThreadTS != "" {
		for _, variant := range variants {
			if gold, ok := store.byThread[benchmarkGoldThreadKey(row.ChannelID, row.ThreadTS, variant)]; ok {
				return gold, true
			}
		}
	}
	if row.CaseID != "" {
		for _, variant := range variants {
			if gold, ok := store.byCase[benchmarkGoldCaseKey(row.CaseID, variant)]; ok {
				return gold, true
			}
		}
	}
	return benchmarkGoldCase{}, false
}

func benchmarkGoldExpectedBehavior(gold benchmarkGoldCase) (benchmarkGoldExpectation, bool) {
	expected := gold.Expected
	expected.Kind = firstNonEmpty(expected.Kind, gold.ExpectedKind, gold.ExpectedDecision, expected.FinalDecision, expected.Decision)
	if benchmarkGoldExpectationHasSignal(expected) {
		return expected, true
	}
	if gold.ExpectedDecision != "" || gold.ExpectedKind != "" {
		return benchmarkGoldExpectation{Kind: firstNonEmpty(gold.ExpectedKind, gold.ExpectedDecision)}, true
	}
	if !goldHumanVerdictIsPositive(gold.HumanVerdict) {
		return benchmarkGoldExpectation{}, false
	}
	for _, candidate := range []benchmarkGoldExpectation{gold.Actual, gold.Observed, gold.Row, gold.Machine, {
		FinalDecision:       gold.FinalDecision,
		VisibleReplyAllowed: gold.VisibleReplyAllowed,
		MinWorkerRequests:   gold.WorkerRequests,
	}} {
		candidate.Kind = firstNonEmpty(candidate.Kind, candidate.FinalDecision, candidate.Decision)
		if benchmarkGoldExpectationHasSignal(candidate) {
			return candidate, true
		}
	}
	return benchmarkGoldExpectation{}, false
}

func benchmarkGoldExpectationHasSignal(expected benchmarkGoldExpectation) bool {
	return firstNonEmpty(expected.Kind, expected.FinalDecision, expected.Decision, expected.Freeform) != "" ||
		expected.VisibleReplyAllowed != nil ||
		expected.MinWorkerRequests > 0
}

func evaluateBenchmarkGold(row benchmarkRow, expected benchmarkGoldExpectation) (string, string) {
	if strings.TrimSpace(row.Error) != "" {
		return "fail", "dry_run_error:" + row.Error
	}
	kind := normalizeGoldExpectedKind(firstNonEmpty(expected.Kind, expected.FinalDecision, expected.Decision))
	if kind == "other" || kind == "freeform" {
		return "unrated", "freeform_expected_requires_human_review:" + strings.TrimSpace(expected.Freeform)
	}
	if expected.VisibleReplyAllowed != nil && *expected.VisibleReplyAllowed != row.VisibleReplyAllowed {
		return "fail", fmt.Sprintf("expected visible_reply_allowed=%v; got %v", *expected.VisibleReplyAllowed, row.VisibleReplyAllowed)
	}
	if expected.MinWorkerRequests > 0 && row.WorkerRequests < expected.MinWorkerRequests {
		return "fail", fmt.Sprintf("expected worker_requests >= %d; got %d", expected.MinWorkerRequests, row.WorkerRequests)
	}
	if kind == "" {
		if expected.VisibleReplyAllowed != nil || expected.MinWorkerRequests > 0 {
			return "pass", "ok"
		}
		return "unrated", "gold_label_missing_comparable_expected"
	}
	actual := benchmarkGoldActualDecision(row)
	if kind == actual {
		return "pass", "ok"
	}
	return "fail", fmt.Sprintf("expected %s; got %s", kind, actual)
}

func benchmarkGoldExpectedLabel(expected benchmarkGoldExpectation) string {
	kind := normalizeGoldExpectedKind(firstNonEmpty(expected.Kind, expected.FinalDecision, expected.Decision))
	if kind == "other" || kind == "freeform" {
		if freeform := strings.TrimSpace(expected.Freeform); freeform != "" {
			return "other:" + freeform
		}
		return "other"
	}
	parts := []string{}
	if kind != "" {
		parts = append(parts, kind)
	}
	if expected.VisibleReplyAllowed != nil {
		parts = append(parts, fmt.Sprintf("visible_reply_allowed=%v", *expected.VisibleReplyAllowed))
	}
	if expected.MinWorkerRequests > 0 {
		parts = append(parts, fmt.Sprintf("worker_requests>=%d", expected.MinWorkerRequests))
	}
	return strings.Join(parts, ",")
}

func benchmarkGoldActualDecision(row benchmarkRow) string {
	if strings.TrimSpace(row.Error) != "" {
		return "error"
	}
	switch {
	case row.VisibleReplyAllowed || row.FinalDecision == "would_request_reply_approval" || row.FinalDecision == "would_post_reply":
		return "visible_reply"
	case row.WorkerRequests > 0 || row.FinalDecision == "would_delegate_worker":
		return "would_delegate_worker"
	case row.FinalDecision == "would_react" || row.FinalDecision == "would_add_reaction":
		return "would_react"
	case row.FinalDecision == "would_stay_silent" || row.FinalDecision == "stay_silent":
		return "would_stay_silent"
	default:
		return firstNonEmpty(row.FinalDecision, "unknown")
	}
}

func normalizeGoldExpectedKind(value string) string {
	value = normalizeGoldToken(value)
	switch value {
	case "", "unknown":
		return ""
	case "stay_silent", "silent", "no_action", "would_stay_silent":
		return "would_stay_silent"
	case "delegate", "delegate_worker", "worker", "start_worker", "would_delegate_worker":
		return "would_delegate_worker"
	case "visible_reply", "reply", "thread_reply", "post_thread_reply", "would_reply", "would_post_reply", "would_request_reply_approval":
		return "visible_reply"
	case "react", "reaction", "emoji", "would_react", "would_add_reaction":
		return "would_react"
	case "other", "freeform":
		return "other"
	default:
		return value
	}
}

func goldHumanVerdictIsPositive(value string) bool {
	switch normalizeGoldToken(value) {
	case "correct", "ok", "good", "pass", "right", "yes", "对", "yes_correct":
		return true
	default:
		return false
	}
}

func normalizeGoldToken(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "-", "_")
	value = strings.ReplaceAll(value, " ", "_")
	return value
}

func benchmarkGoldThreadKey(channelID string, threadTS string, variantID string) string {
	return strings.TrimSpace(channelID) + "\x00" + strings.TrimSpace(threadTS) + "\x00" + strings.TrimSpace(variantID)
}

func benchmarkGoldCaseKey(caseID string, variantID string) string {
	return strings.TrimSpace(caseID) + "\x00" + strings.TrimSpace(variantID)
}

func newBenchmarkJudgeOptions(rawURL string, model string, apiKey string, maxRows int) (benchmarkJudgeOptions, error) {
	model = strings.TrimSpace(model)
	if maxRows < 0 {
		return benchmarkJudgeOptions{}, fmt.Errorf("--judge-max-rows must be >= 0")
	}
	if model == "" {
		return benchmarkJudgeOptions{benchmarkJudgeConfig: benchmarkJudgeConfig{Enabled: false, MaxRows: maxRows}}, nil
	}
	url := normalizeBenchmarkJudgeURL(rawURL)
	return benchmarkJudgeOptions{
		benchmarkJudgeConfig: benchmarkJudgeConfig{
			Enabled: true,
			Model:   model,
			URL:     url,
			MaxRows: maxRows,
		},
		APIKey: strings.TrimSpace(apiKey),
	}, nil
}

func normalizeBenchmarkJudgeURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		raw = "https://api.openai.com/v1"
	}
	raw = strings.TrimRight(raw, "/")
	if strings.HasSuffix(raw, "/chat/completions") {
		return raw
	}
	return raw + "/chat/completions"
}

func applyBenchmarkJudge(ctx context.Context, client *http.Client, opts benchmarkJudgeOptions, budget *benchmarkJudgeBudget, row *benchmarkRow, thread slackagent.SlackTriageReplayThread, fixture *benchmarkFixture) {
	if !opts.Enabled {
		return
	}
	if budget != nil && budget.MaxRows > 0 && budget.Used >= budget.MaxRows {
		row.JudgeSkipped = true
		return
	}
	if budget != nil {
		budget.Used++
	}
	verdict, err := requestBenchmarkJudge(ctx, client, opts, *row, thread, fixture)
	if err != nil {
		row.JudgeError = err.Error()
		return
	}
	row.Judge = &verdict
}

func requestBenchmarkJudge(ctx context.Context, client *http.Client, opts benchmarkJudgeOptions, row benchmarkRow, thread slackagent.SlackTriageReplayThread, fixture *benchmarkFixture) (benchmarkJudgeVerdict, error) {
	payload := map[string]any{
		"task": "Judge this Oneesama Slack triage dry-run row. Score the final human-visible behavior, not the internal implementation style.",
		"contract": map[string]any{
			"score":   "0.0 to 1.0 where 1.0 is clearly useful and safe",
			"verdict": "good, bad, or uncertain",
			"flags": []string{
				"over_respond",
				"under_respond",
				"missing_evidence",
				"internal_leak",
				"self_identity_overreach",
				"wrong_delegation",
				"review_burden",
			},
			"reasoning": "one short private audit note; do not include chain-of-thought",
		},
		"thread": map[string]any{
			"channel_id": thread.ChannelID,
			"thread_ts":  thread.ThreadTS,
			"messages":   judgeMessageSamples(thread.Messages),
		},
		"row": row,
	}
	if fixture != nil {
		payload["fixture"] = map[string]any{
			"case_id":     fixture.CaseID,
			"description": fixture.Description,
			"label":       fixture.Label,
			"tags":        fixture.Tags,
			"source_refs": fixture.SourceRefs,
			"expected":    fixture.Expected,
		}
	}
	userContent, err := json.Marshal(payload)
	if err != nil {
		return benchmarkJudgeVerdict{}, fmt.Errorf("marshal judge payload: %w", err)
	}
	requestBody := map[string]any{
		"model":       opts.Model,
		"temperature": 0,
		"response_format": map[string]string{
			"type": "json_object",
		},
		"messages": []map[string]string{
			{
				"role": "system",
				"content": strings.Join([]string{
					"You are an independent benchmark judge for Oneesama Slack triage.",
					"Use a different lens from production Pi: product fit, factual grounding, usefulness, over-response risk, internal leak risk, evidence quality, and reviewer burden.",
					"Return only compact JSON with keys: score, verdict, flags, reasoning.",
					"The judge is not an oracle; uncertain is acceptable when the thread lacks enough evidence.",
				}, "\n"),
			},
			{"role": "user", "content": string(userContent)},
		},
	}
	body, err := json.Marshal(requestBody)
	if err != nil {
		return benchmarkJudgeVerdict{}, fmt.Errorf("marshal judge request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, opts.URL, bytes.NewReader(body))
	if err != nil {
		return benchmarkJudgeVerdict{}, fmt.Errorf("create judge request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if opts.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+opts.APIKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		return benchmarkJudgeVerdict{}, fmt.Errorf("judge request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return benchmarkJudgeVerdict{}, fmt.Errorf("decode judge HTTP %d: %w", resp.StatusCode, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return benchmarkJudgeVerdict{}, fmt.Errorf("judge HTTP %d: %s", resp.StatusCode, firstNonEmpty(out.Error.Message, "unknown error"))
	}
	if len(out.Choices) == 0 || strings.TrimSpace(out.Choices[0].Message.Content) == "" {
		return benchmarkJudgeVerdict{}, fmt.Errorf("judge response missing content")
	}
	var verdict benchmarkJudgeVerdict
	if err := json.Unmarshal([]byte(out.Choices[0].Message.Content), &verdict); err != nil {
		return benchmarkJudgeVerdict{}, fmt.Errorf("decode judge verdict: %w", err)
	}
	return normalizeBenchmarkJudgeVerdict(verdict), nil
}

func normalizeBenchmarkJudgeVerdict(verdict benchmarkJudgeVerdict) benchmarkJudgeVerdict {
	if verdict.Score < 0 {
		verdict.Score = 0
	}
	if verdict.Score > 1 {
		verdict.Score = 1
	}
	verdict.Verdict = strings.ToLower(strings.TrimSpace(verdict.Verdict))
	switch verdict.Verdict {
	case "good", "bad", "uncertain":
	default:
		verdict.Verdict = "uncertain"
	}
	verdict.Reasoning = truncateForJudge(strings.TrimSpace(verdict.Reasoning), 360)
	for i := range verdict.Flags {
		verdict.Flags[i] = strings.ToLower(strings.TrimSpace(verdict.Flags[i]))
	}
	verdict.Flags = uniqueStrings(verdict.Flags)
	return verdict
}

func judgeMessageSamples(messages []slackagent.SlackInboundMessage) []map[string]string {
	limit := len(messages)
	if limit > 12 {
		limit = 12
	}
	out := make([]map[string]string, 0, limit)
	for i := 0; i < limit; i++ {
		message := messages[i]
		out = append(out, map[string]string{
			"user":      firstNonEmpty(message.UserID, message.UserIDSnake, message.User, message.BotID, message.BotIDSnake, "unknown"),
			"ts":        firstNonEmpty(message.TS, message.EventTS, message.EventTSSnake),
			"thread_ts": firstNonEmpty(message.ThreadTS, message.ThreadTSSnake),
			"text":      truncateForJudge(message.Text, 700),
		})
	}
	return out
}

func truncateForJudge(value string, max int) string {
	value = strings.TrimSpace(value)
	if max <= 0 {
		return value
	}
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max]) + "..."
}

func dryRunThread(ctx context.Context, client *http.Client, baseURL string, variantID string, thread slackagent.SlackTriageReplayThread) (benchmarkRow, *slackagent.SlackTriageDryRunResult) {
	row := benchmarkRow{
		VariantID:    variantID,
		ChannelID:    thread.ChannelID,
		ThreadTS:     thread.ThreadTS,
		MessageCount: len(thread.Messages),
	}
	payload := triageRunRequest{
		ChannelID:              thread.ChannelID,
		Messages:               thread.Messages,
		DryRun:                 true,
		IgnoreExistingBotReply: true,
		RerunForce:             true,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		row.Error = err.Error()
		return row, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/slack/triage/run", bytes.NewReader(body))
	if err != nil {
		row.Error = err.Error()
		return row, nil
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		row.Error = err.Error()
		return row, nil
	}
	defer func() { _ = resp.Body.Close() }()
	var out triageRunResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		row.Error = fmt.Sprintf("decode HTTP %d: %v", resp.StatusCode, err)
		return row, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !out.OK {
		row.Error = firstNonEmpty(out.Error, fmt.Sprintf("HTTP %d", resp.StatusCode))
		return row, nil
	}
	row.FinalDecision = out.DryRun.FinalDecision
	row.PersonaDecision = out.DryRun.Persona.Decision
	row.WorkerRequests = len(out.DryRun.WouldDelegateWorkers)
	row.PipelineSmellSignals = append([]string(nil), out.DryRun.PipelineSmellSignals...)
	row.GateDecision = benchmarkGateDecision(out.DryRun)
	for _, verdict := range out.DryRun.VisibleReplyVerdicts {
		if verdict.Allowed {
			row.VisibleReplyAllowed = true
		}
		row.VisibleReplyReasons = append(row.VisibleReplyReasons, verdict.Reason)
	}
	row.VisibleReplyReasons = uniqueStrings(row.VisibleReplyReasons)
	dryRun := out.DryRun
	return row, &dryRun
}

type benchmarkDryRunResult struct {
	thread slackagent.SlackTriageReplayThread
	row    benchmarkRow
	dryRun *slackagent.SlackTriageDryRunResult
}

func dryRunReplayThreads(ctx context.Context, client *http.Client, baseURL string, variantID string, threads []slackagent.SlackTriageReplayThread, parallel int, stderr io.Writer) []benchmarkDryRunResult {
	if parallel <= 1 || len(threads) <= 1 {
		out := make([]benchmarkDryRunResult, 0, len(threads))
		for index, thread := range threads {
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: dry-run thread %d/%d channel=%s thread=%s variant=%s\n", index+1, len(threads), thread.ChannelID, thread.ThreadTS, variantID)
			row, dryRun := dryRunThread(ctx, client, baseURL, variantID, thread)
			out = append(out, benchmarkDryRunResult{thread: thread, row: row, dryRun: dryRun})
		}
		return out
	}
	if parallel > len(threads) {
		parallel = len(threads)
	}
	out := make([]benchmarkDryRunResult, len(threads))
	jobs := make(chan int)
	var wg sync.WaitGroup
	for worker := 0; worker < parallel; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				thread := threads[index]
				fmt.Fprintf(stderr, "oneesama-triage-benchmark: dry-run thread %d/%d channel=%s thread=%s variant=%s\n", index+1, len(threads), thread.ChannelID, thread.ThreadTS, variantID)
				row, dryRun := dryRunThread(ctx, client, baseURL, variantID, thread)
				out[index] = benchmarkDryRunResult{thread: thread, row: row, dryRun: dryRun}
			}
		}()
	}
	for index := range threads {
		jobs <- index
	}
	close(jobs)
	wg.Wait()
	return out
}

func selectBalancedReplayThreads(buckets [][]slackagent.SlackTriageReplayThread, maxTotal int) []slackagent.SlackTriageReplayThread {
	total := 0
	for _, bucket := range buckets {
		total += len(bucket)
	}
	limit := total
	if maxTotal > 0 && maxTotal < limit {
		limit = maxTotal
	}
	out := make([]slackagent.SlackTriageReplayThread, 0, limit)
	for offset := 0; len(out) < limit; offset++ {
		added := false
		for _, bucket := range buckets {
			if offset >= len(bucket) {
				continue
			}
			out = append(out, bucket[offset])
			added = true
			if len(out) >= limit {
				break
			}
		}
		if !added {
			break
		}
	}
	return out
}

func benchmarkGateDecision(dryRun slackagent.SlackTriageDryRunResult) string {
	if len(dryRun.VisibleReplyVerdicts) == 0 {
		return "no_visible_reply_candidate"
	}
	allowed := false
	for _, verdict := range dryRun.VisibleReplyVerdicts {
		if verdict.Allowed {
			allowed = true
			break
		}
	}
	if !allowed {
		return "visible_reply_blocked"
	}
	for _, action := range dryRun.ActionsAfterGate {
		if strings.TrimSpace(action.Type) == "post_thread_reply" {
			return "visible_reply_requires_approval"
		}
	}
	return "visible_reply_allowed_no_delivery"
}

func expandFixturePaths(inputs []string) ([]string, error) {
	var out []string
	for _, input := range inputs {
		input = strings.TrimSpace(input)
		if input == "" {
			continue
		}
		matches, err := filepath.Glob(input)
		if err != nil {
			return nil, fmt.Errorf("fixture glob %q: %w", input, err)
		}
		if len(matches) == 0 {
			out = append(out, input)
			continue
		}
		sort.Strings(matches)
		out = append(out, matches...)
	}
	return uniqueStrings(out), nil
}

func readBenchmarkFixture(path string) (benchmarkFixture, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return benchmarkFixture{}, fmt.Errorf("read fixture %s: %w", path, err)
	}
	var fixture benchmarkFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		return benchmarkFixture{}, fmt.Errorf("decode fixture %s: %w", path, err)
	}
	fixture.CaseID = strings.TrimSpace(fixture.CaseID)
	if fixture.CaseID == "" {
		fixture.CaseID = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	}
	fixture.Label = normalizeFixtureLabel(fixture.Label)
	if fixture.Label == "" {
		return benchmarkFixture{}, fmt.Errorf("fixture %s: label is required", path)
	}
	if len(fixture.Thread.Messages) == 0 {
		return benchmarkFixture{}, fmt.Errorf("fixture %s: thread messages are required", path)
	}
	fixture.Thread.ChannelID = firstNonEmpty(fixture.Thread.ChannelID, fixture.Thread.Messages[0].ChannelID)
	fixture.Thread.ThreadTS = firstNonEmpty(fixture.Thread.ThreadTS, fixture.Thread.RootTS)
	if fixture.Thread.ThreadTS == "" && len(fixture.Thread.Messages) > 0 {
		fixture.Thread.ThreadTS = firstNonEmpty(fixture.Thread.Messages[0].ThreadTS, fixture.Thread.Messages[0].TS)
	}
	if fixture.Thread.RootTS == "" {
		fixture.Thread.RootTS = fixture.Thread.ThreadTS
	}
	if fixture.Thread.ChannelID == "" || fixture.Thread.ThreadTS == "" || len(fixture.Thread.Messages) == 0 {
		return benchmarkFixture{}, fmt.Errorf("fixture %s: thread channelId, threadTs, and messages are required", path)
	}
	for i := range fixture.Thread.Messages {
		if strings.TrimSpace(fixture.Thread.Messages[i].ChannelID) == "" {
			fixture.Thread.Messages[i].ChannelID = fixture.Thread.ChannelID
		}
		if strings.TrimSpace(fixture.Thread.Messages[i].ThreadTS) == "" {
			fixture.Thread.Messages[i].ThreadTS = fixture.Thread.ThreadTS
		}
	}
	return fixture, nil
}

func applyFixtureResult(row *benchmarkRow, fixture benchmarkFixture) {
	row.CaseID = fixture.CaseID
	row.CaseDescription = strings.TrimSpace(fixture.Description)
	row.FixtureLabel = fixture.Label
	passed, reason := evaluateFixtureRow(*row, fixture)
	row.FixturePassed = &passed
	row.FixtureReason = reason
	if !passed {
		row.FixtureFailureLayer, row.FixtureFailureDetail = diagnoseFixtureFailure(*row, fixture, reason)
	}
}

func evaluateCandidateFixture(variantID string, fixture benchmarkFixture) benchmarkRow {
	verdict := slackagent.EvaluateSlackVisibleReplyCandidate(fixture.Candidate)
	reasons := []string{}
	if strings.TrimSpace(verdict.Reason) != "" {
		reasons = []string{verdict.Reason}
	}
	gateDecision := "visible_reply_blocked"
	if verdict.Allowed {
		gateDecision = "visible_reply_allowed_no_delivery"
	}
	return benchmarkRow{
		VariantID:           variantID,
		ChannelID:           fixture.Thread.ChannelID,
		ThreadTS:            fixture.Thread.ThreadTS,
		MessageCount:        len(fixture.Thread.Messages),
		PersonaDecision:     "fixture_candidate",
		FinalDecision:       "candidate_visible_reply_gate",
		GateDecision:        gateDecision,
		VisibleReplyAllowed: verdict.Allowed,
		VisibleReplyReasons: reasons,
	}
}

func evaluateFixtureRow(row benchmarkRow, fixture benchmarkFixture) (bool, string) {
	if strings.TrimSpace(row.Error) != "" {
		return false, "dry_run_error"
	}
	if expected := strings.TrimSpace(fixture.Expected.FinalDecision); expected != "" && expected != row.FinalDecision {
		return false, "final_decision_mismatch"
	}
	if fixture.Expected.VisibleReplyAllowed != nil && *fixture.Expected.VisibleReplyAllowed != row.VisibleReplyAllowed {
		return false, "visible_reply_allowed_mismatch"
	}
	if expected := strings.TrimSpace(fixture.Expected.VisibleReplyReason); expected != "" && !containsAnyString(row.VisibleReplyReasons, []string{expected}) {
		return false, "visible_reply_reason_mismatch"
	}
	if fixture.Expected.MinWorkerRequests > 0 && row.WorkerRequests < fixture.Expected.MinWorkerRequests {
		return false, "worker_request_count_below_expected"
	}
	if len(fixture.Expected.AnyVisibleReplyReasons) > 0 && !containsAnyString(row.VisibleReplyReasons, fixture.Expected.AnyVisibleReplyReasons) {
		return false, "visible_reply_reason_missing"
	}
	if len(fixture.Expected.AnyPipelineSmellSignals) > 0 && !containsAnyString(row.PipelineSmellSignals, fixture.Expected.AnyPipelineSmellSignals) {
		return false, "pipeline_smell_missing"
	}
	switch fixture.Label {
	case "must_block":
		if row.VisibleReplyAllowed || row.FinalDecision == "would_request_reply_approval" || row.FinalDecision == "would_post_reply" {
			return false, "must_block_visible_reply"
		}
	case "must_allow":
		if !row.VisibleReplyAllowed {
			return false, "must_allow_blocked"
		}
	case "should_delegate":
		if row.WorkerRequests <= 0 && row.FinalDecision != "would_delegate_worker" {
			return false, "should_delegate_missing_worker"
		}
	case "freely_silent":
		if row.VisibleReplyAllowed || row.WorkerRequests > 0 {
			return false, "freely_silent_not_silent"
		}
	default:
		return false, "unknown_fixture_label"
	}
	return true, "ok"
}

func diagnoseFixtureFailure(row benchmarkRow, fixture benchmarkFixture, reason string) (string, string) {
	switch reason {
	case "dry_run_error":
		return "runtime", strings.TrimSpace(row.Error)
	case "visible_reply_allowed_mismatch", "must_allow_blocked":
		if row.WorkerRequests > 0 || row.FinalDecision == "would_delegate_worker" {
			return "delegation", "pipeline delegated instead of producing an allowed visible reply"
		}
		if !row.VisibleReplyAllowed && (row.FinalDecision == "would_stay_silent" || row.PersonaDecision == "stay_silent" || len(row.VisibleReplyReasons) == 0) {
			return "pi_decision", "pipeline stayed silent before producing a visible reply candidate"
		}
		if len(row.VisibleReplyReasons) > 0 {
			return "visible_reply_gate", "gate reasons: " + strings.Join(row.VisibleReplyReasons, ",")
		}
		return "pipeline_decision", "visible reply expectation did not match final decision"
	case "visible_reply_reason_mismatch", "visible_reply_reason_missing":
		return "visible_reply_gate", "expected gate reason " + firstNonEmpty(fixture.Expected.VisibleReplyReason, strings.Join(fixture.Expected.AnyVisibleReplyReasons, ",")) + "; got " + strings.Join(row.VisibleReplyReasons, ",")
	case "worker_request_count_below_expected", "should_delegate_missing_worker":
		return "delegation", fmt.Sprintf("expected worker_requests >= %d; got %d", fixture.Expected.MinWorkerRequests, row.WorkerRequests)
	case "final_decision_mismatch":
		return "pipeline_decision", fmt.Sprintf("expected final decision %s; got %s", fixture.Expected.FinalDecision, row.FinalDecision)
	case "must_block_visible_reply":
		return "visible_reply_gate", "must_block fixture produced a visible reply"
	case "freely_silent_not_silent":
		return "pipeline_decision", "freely_silent fixture produced visible reply or worker request"
	default:
		return "fixture", reason
	}
}

func normalizeFixtureLabel(label string) string {
	label = strings.ToLower(strings.TrimSpace(label))
	label = strings.ReplaceAll(label, "-", "_")
	label = strings.ReplaceAll(label, " ", "_")
	return label
}

func recordRow(summary *benchmarkSummary, row benchmarkRow) {
	if strings.TrimSpace(row.Error) != "" {
		summary.Errors++
	}
	recordGoldSummary(summary, row)
	recordJudgeSummary(summary, row)
	if row.FixtureLabel != "" {
		summary.ByFixtureLabel[row.FixtureLabel]++
		outcome := "unknown"
		if row.FixturePassed != nil {
			if *row.FixturePassed {
				outcome = "pass"
				summary.FixturePasses++
			} else {
				outcome = "fail"
				summary.FixtureFailures++
			}
		}
		summary.ByFixtureOutcome[row.FixtureLabel+"_"+outcome]++
	}
	if strings.TrimSpace(row.Error) != "" {
		return
	}
	summary.ByFinalDecision[firstNonEmpty(row.FinalDecision, "unknown")]++
	summary.ByPersonaDecision[firstNonEmpty(row.PersonaDecision, "unknown")]++
	for _, reason := range row.VisibleReplyReasons {
		summary.ByVisibleReplyReason[firstNonEmpty(reason, "unknown")]++
	}
	for _, smell := range row.PipelineSmellSignals {
		summary.ByPipelineSmell[firstNonEmpty(smell, "unknown")]++
	}
}

func recordGoldSummary(summary *benchmarkSummary, row benchmarkRow) {
	status := strings.TrimSpace(row.GoldStatus)
	if status == "" {
		return
	}
	summary.ByGoldStatus[status]++
	summary.GoldRows++
	switch status {
	case "pass":
		summary.GoldPasses++
	case "fail":
		summary.GoldFailures++
	case "unrated":
		summary.GoldUnrated++
	}
}

func recordJudgeSummary(summary *benchmarkSummary, row benchmarkRow) {
	if row.JudgeSkipped {
		summary.JudgeSkipped++
		return
	}
	if strings.TrimSpace(row.JudgeError) != "" {
		summary.JudgeErrors++
		return
	}
	if row.Judge == nil {
		return
	}
	summary.ByJudgeVerdict[firstNonEmpty(row.Judge.Verdict, "uncertain")]++
	for _, flag := range row.Judge.Flags {
		summary.ByJudgeFlag[firstNonEmpty(flag, "unknown")]++
	}
	summary.JudgeAverageScore = ((summary.JudgeAverageScore * float64(summary.JudgeRows)) + row.Judge.Score) / float64(summary.JudgeRows+1)
	summary.JudgeRows++
}

func buildVariantSummaries(variants []benchmarkVariant, rows []benchmarkRow) []benchmarkVariantSummary {
	summaries := make(map[string]benchmarkSummary, len(variants))
	meta := make(map[string]benchmarkVariant, len(variants))
	order := make([]string, 0, len(variants))
	for _, variant := range variants {
		id := firstNonEmpty(variant.VariantID, "current")
		if _, ok := summaries[id]; !ok {
			summaries[id] = newBenchmarkSummary()
			order = append(order, id)
		}
		meta[id] = variant
	}
	for _, row := range rows {
		id := firstNonEmpty(row.VariantID, "current")
		if _, ok := summaries[id]; !ok {
			summaries[id] = newBenchmarkSummary()
			order = append(order, id)
		}
		summary := summaries[id]
		recordRow(&summary, row)
		summaries[id] = summary
	}
	out := make([]benchmarkVariantSummary, 0, len(order))
	for _, id := range order {
		variant := meta[id]
		out = append(out, benchmarkVariantSummary{
			VariantID:   id,
			Description: variant.Description,
			Knobs:       variant.Knobs,
			Summary:     summaries[id],
		})
	}
	return out
}

func renderMarkdownReport(report benchmarkReport) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Oneesama Triage Benchmark\n\n")
	fmt.Fprintf(&b, "| Field | Value |\n|---|---|\n")
	fmt.Fprintf(&b, "| Generated | `%s` |\n", escapeMarkdownCell(report.GeneratedAt))
	fmt.Fprintf(&b, "| Variant | `%s` |\n", escapeMarkdownCell(report.VariantID))
	fmt.Fprintf(&b, "| Mode | `%s` |\n", escapeMarkdownCell(report.Mode))
	fmt.Fprintf(&b, "| Window | `%s` |\n", escapeMarkdownCell(report.Since))
	if len(report.Channels) > 0 {
		fmt.Fprintf(&b, "| Channels | `%s` |\n", escapeMarkdownCell(strings.Join(report.Channels, ",")))
	}
	if len(report.Fixtures) > 0 {
		fmt.Fprintf(&b, "| Fixtures | %d |\n", len(report.Fixtures))
	}
	if len(report.Variants) > 0 {
		fmt.Fprintf(&b, "| Variants | %d |\n", len(report.Variants))
	}
	if report.Judge.Enabled {
		fmt.Fprintf(&b, "| Judge | `%s` max_rows=%d |\n", escapeMarkdownCell(report.Judge.Model), report.Judge.MaxRows)
	}
	if report.MaxThreads > 0 {
		fmt.Fprintf(&b, "| Max threads | %d |\n", report.MaxThreads)
	}
	fmt.Fprintf(&b, "| Truncated | %v |\n", report.Truncated)
	fmt.Fprintf(&b, "| Threads seen | %d |\n", report.ThreadsSeen)
	fmt.Fprintf(&b, "| Threads replayed | %d |\n", report.ThreadsReplayed)
	fmt.Fprintf(&b, "| Errors | %d |\n\n", report.Summary.Errors)
	if len(report.Summary.ByFixtureOutcome) > 0 {
		fmt.Fprintf(&b, "| Fixture passes | %d |\n", report.Summary.FixturePasses)
		fmt.Fprintf(&b, "| Fixture failures | %d |\n\n", report.Summary.FixtureFailures)
	}
	if report.Summary.GoldRows > 0 {
		fmt.Fprintf(&b, "| Gold pass/fail/unrated | %d / %d / %d |\n\n", report.Summary.GoldPasses, report.Summary.GoldFailures, report.Summary.GoldUnrated)
	}

	appendCountTable(&b, "Fixture Labels", report.Summary.ByFixtureLabel)
	appendCountTable(&b, "Fixture Outcomes", report.Summary.ByFixtureOutcome)
	appendCountTable(&b, "Gold Outcomes", report.Summary.ByGoldStatus)
	appendCountTable(&b, "Final Decisions", report.Summary.ByFinalDecision)
	appendCountTable(&b, "Persona Decisions", report.Summary.ByPersonaDecision)
	appendCountTable(&b, "Visible Reply Gate Reasons", report.Summary.ByVisibleReplyReason)
	appendCountTable(&b, "Pipeline Smells", report.Summary.ByPipelineSmell)
	if report.Summary.JudgeRows > 0 || report.Summary.JudgeErrors > 0 || report.Summary.JudgeSkipped > 0 {
		fmt.Fprintf(&b, "## LLM Judge\n\n")
		fmt.Fprintf(&b, "| Judged | Errors | Skipped | Average score |\n")
		fmt.Fprintf(&b, "|---:|---:|---:|---:|\n")
		fmt.Fprintf(&b, "| %d | %d | %d | %.2f |\n\n", report.Summary.JudgeRows, report.Summary.JudgeErrors, report.Summary.JudgeSkipped, report.Summary.JudgeAverageScore)
		appendCountTable(&b, "Judge Verdicts", report.Summary.ByJudgeVerdict)
		appendCountTable(&b, "Judge Flags", report.Summary.ByJudgeFlag)
	}
	if len(report.VariantSummaries) > 1 {
		fmt.Fprintf(&b, "## Variant Summaries\n\n")
		fmt.Fprintf(&b, "| Variant | Fixture passes | Fixture failures | Errors | Judge score | Decisions |\n")
		fmt.Fprintf(&b, "|---|---:|---:|---:|---:|---|\n")
		for _, variant := range report.VariantSummaries {
			fmt.Fprintf(&b, "| `%s` | %d | %d | %d | %.2f | %s |\n",
				escapeMarkdownCell(variant.VariantID),
				variant.Summary.FixturePasses,
				variant.Summary.FixtureFailures,
				variant.Summary.Errors,
				variant.Summary.JudgeAverageScore,
				escapeMarkdownCell(formatCountMap(variant.Summary.ByFinalDecision)),
			)
		}
		fmt.Fprintf(&b, "\n")
	}

	if len(report.Stats) > 0 {
		fmt.Fprintf(&b, "## Slack Scan Coverage\n\n")
		fmt.Fprintf(&b, "| Channel | Scanned | Replies fetched | Threads | Truncated | Warnings |\n")
		fmt.Fprintf(&b, "|---|---:|---:|---:|---|---|\n")
		for _, stat := range report.Stats {
			warnings := "—"
			if len(stat.Warnings) > 0 {
				warnings = strings.Join(stat.Warnings, "; ")
			}
			fmt.Fprintf(&b, "| `%s` | %d | %d | %d | %v | %s |\n",
				escapeMarkdownCell(stat.ChannelID),
				stat.MessagesScanned,
				stat.RepliesFetched,
				stat.CandidatesFound,
				stat.Truncated,
				escapeMarkdownCell(warnings),
			)
		}
		fmt.Fprintf(&b, "\n")
	}

	fmt.Fprintf(&b, "## Replay Rows\n\n")
	fmt.Fprintf(&b, "| Variant | Case | Channel | Thread | Msgs | Label | Result | Failure layer | Persona | Final | Gate | Gate reasons | Workers | Judge | Smells | Error | Gold |\n")
	fmt.Fprintf(&b, "|---|---|---|---|---:|---|---|---|---|---|---|---|---:|---|---|---|---|\n")
	for _, row := range report.Rows {
		errText := "—"
		if strings.TrimSpace(row.Error) != "" {
			errText = row.Error
		}
		reasons := "—"
		if len(row.VisibleReplyReasons) > 0 {
			reasons = strings.Join(row.VisibleReplyReasons, ", ")
		}
		goldCell := "—"
		if row.GoldStatus != "" {
			goldCell = row.GoldStatus
			if row.GoldExpected != "" || row.GoldActual != "" {
				goldCell += ":" + firstNonEmpty(row.GoldExpected, "?") + "→" + firstNonEmpty(row.GoldActual, "?")
			}
			if row.GoldReason != "" && row.GoldStatus != "pass" {
				goldCell += " (" + row.GoldReason + ")"
			}
		}
		smells := "—"
		if len(row.PipelineSmellSignals) > 0 {
			smells = strings.Join(row.PipelineSmellSignals, ", ")
		}
		fmt.Fprintf(&b, "| `%s` | `%s` | `%s` | `%s` | %d | `%s` | `%s` | `%s` | `%s` | `%s` | `%s` | %s | %d | `%s` | %s | %s | `%s` |\n",
			escapeMarkdownCell(firstNonEmpty(row.VariantID, "current")),
			escapeMarkdownCell(firstNonEmpty(row.CaseID, "—")),
			escapeMarkdownCell(row.ChannelID),
			escapeMarkdownCell(row.ThreadTS),
			row.MessageCount,
			escapeMarkdownCell(firstNonEmpty(row.FixtureLabel, "—")),
			escapeMarkdownCell(formatFixtureResultCell(row)),
			escapeMarkdownCell(formatFixtureFailureLayerCell(row)),
			escapeMarkdownCell(firstNonEmpty(row.PersonaDecision, "unknown")),
			escapeMarkdownCell(firstNonEmpty(row.FinalDecision, "unknown")),
			escapeMarkdownCell(firstNonEmpty(row.GateDecision, "unknown")),
			escapeMarkdownCell(reasons),
			row.WorkerRequests,
			escapeMarkdownCell(formatJudgeCell(row)),
			escapeMarkdownCell(smells),
			escapeMarkdownCell(errText),
			escapeMarkdownCell(goldCell),
		)
	}
	return b.String()
}

func formatFixtureResultCell(row benchmarkRow) string {
	if row.FixturePassed == nil {
		return "—"
	}
	result := "fail"
	if *row.FixturePassed {
		result = "pass"
	}
	if row.FixtureReason != "" {
		result += ":" + row.FixtureReason
	}
	return result
}

func formatFixtureFailureLayerCell(row benchmarkRow) string {
	layer := firstNonEmpty(row.FixtureFailureLayer, "—")
	if row.FixtureFailureDetail != "" && layer != "—" {
		layer += ":" + row.FixtureFailureDetail
	}
	return layer
}

func formatJudgeCell(row benchmarkRow) string {
	if row.Judge != nil {
		cell := fmt.Sprintf("%s %.2f", row.Judge.Verdict, row.Judge.Score)
		if len(row.Judge.Flags) > 0 {
			cell += " " + strings.Join(row.Judge.Flags, ",")
		}
		return cell
	}
	if row.JudgeSkipped {
		return "skipped"
	}
	if row.JudgeError != "" {
		return "error:" + row.JudgeError
	}
	return "—"
}

func appendCountTable(b *strings.Builder, title string, counts map[string]int) {
	if len(counts) == 0 {
		return
	}
	fmt.Fprintf(b, "## %s\n\n", title)
	fmt.Fprintf(b, "| Value | Count |\n|---|---:|\n")
	for _, key := range sortedCountKeys(counts) {
		fmt.Fprintf(b, "| `%s` | %d |\n", escapeMarkdownCell(key), counts[key])
	}
	fmt.Fprintf(b, "\n")
}

func sortedCountKeys(counts map[string]int) []string {
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func formatCountMap(counts map[string]int) string {
	if len(counts) == 0 {
		return "—"
	}
	var parts []string
	for _, key := range sortedCountKeys(counts) {
		parts = append(parts, fmt.Sprintf("%s=%d", key, counts[key]))
	}
	return strings.Join(parts, ", ")
}

func writeOutput(path string, stdout io.Writer, data []byte) error {
	if strings.TrimSpace(path) == "" || strings.TrimSpace(path) == "-" {
		_, err := stdout.Write(append(data, '\n'))
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

func splitCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func containsAnyString(values []string, needles []string) bool {
	normalized := map[string]struct{}{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			normalized[value] = struct{}{}
		}
	}
	for _, needle := range needles {
		if _, ok := normalized[strings.TrimSpace(needle)]; ok {
			return true
		}
	}
	return false
}

type stringListFlag []string

func (v *stringListFlag) String() string {
	return strings.Join(*v, ",")
}

func (v *stringListFlag) Set(value string) error {
	value = strings.TrimSpace(value)
	if value != "" {
		*v = append(*v, value)
	}
	return nil
}

func escapeMarkdownCell(value string) string {
	value = strings.ReplaceAll(value, "|", "\\|")
	value = strings.ReplaceAll(value, "\n", " ")
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func serveBenchmarkReview(ctx context.Context, listen string, reviewOutput string, report benchmarkReport, detail benchmarkDetail, stderr io.Writer) error {
	listen = firstNonEmpty(listen, "127.0.0.1:0")
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, benchmarkReviewHTML)
	})
	mux.HandleFunc("/detail.json", func(w http.ResponseWriter, r *http.Request) {
		writeReviewServerJSON(w, detail)
	})
	mux.HandleFunc("/summary.json", func(w http.ResponseWriter, r *http.Request) {
		writeReviewServerJSON(w, report)
	})
	mux.HandleFunc("/human-review", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
		if err != nil {
			http.Error(w, "read review: "+err.Error(), http.StatusBadRequest)
			return
		}
		if !json.Valid(body) {
			http.Error(w, "review JSON is invalid", http.StatusBadRequest)
			return
		}
		path := firstNonEmpty(reviewOutput, defaultReviewOutputPath())
		if err := os.WriteFile(path, append(body, '\n'), 0o644); err != nil {
			http.Error(w, "write review: "+err.Error(), http.StatusInternalServerError)
			return
		}
		cases, err := decodeBenchmarkGoldCases(body)
		if err != nil {
			http.Error(w, "decode review as gold input: "+err.Error(), http.StatusBadRequest)
			return
		}
		gold := newBenchmarkGoldStoreFromCases(cases)
		summary := benchmarkGoldReplaySummary(report.Rows, gold)
		writeReviewServerJSON(w, map[string]any{
			"ok":      true,
			"path":    path,
			"gold":    summary,
			"message": "saved human review and replayed current rows against submitted gold labels",
		})
	})
	server := &http.Server{Handler: mux}
	addr := ln.Addr().String()
	if strings.HasPrefix(addr, "127.0.0.1:") || strings.HasPrefix(addr, "[::1]:") {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: review UI listening at http://%s/\n", addr)
	} else {
		fmt.Fprintf(stderr, "oneesama-triage-benchmark: review UI listening at %s\n", addr)
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	err = server.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func writeReviewServerJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(body)
}

func defaultReviewOutputPath() string {
	stamp := time.Now().Format("20060102-150405")
	return "oneesama-triage-human-review-" + stamp + ".json"
}

func defaultWorkerJobsInput() string {
	if path := strings.TrimSpace(os.Getenv("ONEESAMA_AGENT_RUNNER_JOBS_PATH")); path != "" {
		return path
	}
	for _, env := range []string{
		"ONEESAMA_STATE_DATA_DIR",
		"ONEESAMA_PERSISTENCE_DATA_DIR",
		"ONEESAMA_DATA_DIR",
		"MAB_DATA_DIR",
	} {
		if dir := strings.TrimSpace(os.Getenv(env)); dir != "" {
			return filepath.Join(dir, "agent_runner_jobs.json")
		}
	}
	return ""
}

func attachHistoricalWorkerResults(ctx context.Context, detail *benchmarkDetail, path string, stderr io.Writer) {
	if detail == nil || len(detail.Rows) == 0 {
		return
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return
	}
	jobs, err := readHistoricalWorkerJobs(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: read historical worker jobs: %v\n", err)
		}
		return
	}
	byThread := make(map[string][]benchmarkHistoricalWorkerResult)
	for _, job := range jobs {
		select {
		case <-ctx.Done():
			return
		default:
		}
		if !historicalJobIsPersonaDelegate(job) {
			continue
		}
		channelID, threadTS := historicalJobSlackTarget(job)
		if channelID == "" || threadTS == "" {
			continue
		}
		key := benchmarkThreadKey(channelID, threadTS)
		byThread[key] = append(byThread[key], buildHistoricalWorkerResult(job))
	}
	for key := range byThread {
		sort.SliceStable(byThread[key], func(i, j int) bool {
			return historicalWorkerResultSortTime(byThread[key][i]).After(historicalWorkerResultSortTime(byThread[key][j]))
		})
		if len(byThread[key]) > 8 {
			byThread[key] = byThread[key][:8]
		}
	}
	for i := range detail.Rows {
		key := benchmarkThreadKey(detail.Rows[i].ChannelID, detail.Rows[i].ThreadTS)
		if results := byThread[key]; len(results) > 0 {
			detail.Rows[i].HistoricalWorkerResults = append([]benchmarkHistoricalWorkerResult(nil), results...)
		}
	}
}

func readHistoricalWorkerJobs(path string) ([]agentrunner.Job, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil, nil
	}
	if trimmed[0] == '[' {
		var jobs []agentrunner.Job
		if err := json.Unmarshal(trimmed, &jobs); err != nil {
			return nil, err
		}
		return jobs, nil
	}
	var collection struct {
		Items []struct {
			ID    string          `json:"id"`
			Value agentrunner.Job `json:"value"`
		} `json:"items"`
		Jobs []agentrunner.Job `json:"jobs"`
	}
	if err := json.Unmarshal(trimmed, &collection); err != nil {
		return nil, err
	}
	jobs := make([]agentrunner.Job, 0, len(collection.Items)+len(collection.Jobs))
	for _, item := range collection.Items {
		job := item.Value
		if strings.TrimSpace(job.ID) == "" {
			job.ID = strings.TrimSpace(item.ID)
		}
		jobs = append(jobs, job)
	}
	jobs = append(jobs, collection.Jobs...)
	return jobs, nil
}

func historicalJobIsPersonaDelegate(job agentrunner.Job) bool {
	return strings.EqualFold(contextString(job.Context, "source"), "persona_delegate_worker")
}

func historicalJobSlackTarget(job agentrunner.Job) (string, string) {
	slack := contextMap(job.Context, "slack")
	channelID := firstNonEmpty(
		contextString(slack, "channel_id", "channelId", "channel"),
		contextString(job.Context, "channel_id", "channelId", "channel"),
	)
	threadTS := firstNonEmpty(
		contextString(slack, "thread_ts", "threadTs", "thread"),
		contextString(job.Context, "thread_ts", "threadTs", "thread"),
	)
	if channelID != "" && threadTS != "" {
		return channelID, threadTS
	}
	if parsedChannel, parsedThread := parseHistoricalTriageRequestID(firstNonEmpty(
		contextString(contextMap(job.Context, "persona"), "request_id", "requestId"),
		contextString(job.Context, "request_id", "requestId", "sessionId", "session_id"),
		contextString(contextMap(job.Context, "worker_context"), "request_id", "requestId", "sessionId", "session_id"),
	)); parsedChannel != "" && parsedThread != "" {
		if channelID == "" {
			channelID = parsedChannel
		}
		if threadTS == "" {
			threadTS = parsedThread
		}
	}
	return channelID, threadTS
}

func parseHistoricalTriageRequestID(value string) (string, string) {
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 3 || parts[0] != "triage" {
		return "", ""
	}
	channelID := strings.TrimSpace(parts[1])
	threadTS := strings.TrimSpace(parts[2])
	if channelID == "" || threadTS == "" {
		return "", ""
	}
	return channelID, threadTS
}

func buildHistoricalWorkerResult(job agentrunner.Job) benchmarkHistoricalWorkerResult {
	envelope := agentrunner.NewWorkerResultEnvelope(job)
	sessionKind := agentrunner.NormalizeSessionKind(firstNonEmpty(
		contextString(job.Context, "session_kind", "sessionKind"),
		contextString(contextMap(job.Context, "worker_context"), "session_kind", "sessionKind"),
	))
	scope := firstNonEmpty(
		contextString(job.Context, "delegation_scope", "delegationScope"),
		contextString(contextMap(job.Context, "worker_context"), "delegation_scope", "delegationScope"),
	)
	result := benchmarkHistoricalWorkerResult{
		JobID:           strings.TrimSpace(job.ID),
		Provider:        strings.TrimSpace(job.Provider),
		Status:          string(job.Status),
		FailureCode:     string(job.FailureCode),
		CreatedAt:       strings.TrimSpace(job.CreatedAt),
		UpdatedAt:       strings.TrimSpace(job.UpdatedAt),
		SessionKind:     sessionKind,
		DelegationScope: scope,
		TaskPreview:     truncateBenchmarkText(job.Task, 900),
		Result:          truncateBenchmarkText(job.Result, 8000),
		Error:           truncateBenchmarkText(job.Error, 1400),
		Envelope:        envelope,
	}
	if job.Status != agentrunner.StatusCompleted {
		result.VisibleGateReason = "worker_status_" + firstNonEmpty(string(job.Status), "unknown")
		result.WouldPostReason = result.VisibleGateReason
		return result
	}
	completedText := agentrunner.WorkerResultEnvelopeCompletedText(envelope)
	if sessionKind == agentrunner.SessionKindSecretaryLookup || strings.EqualFold(scope, "secretary_lookup") {
		visibleText, anchors := parseHistoricalSecretaryLookupResult(completedText)
		result.VisibleText = visibleText
		result.EvidenceAnchors = anchors
		verdict := slackagent.EvaluateSlackVisibleReplyCandidate(slackagent.SlackVisibleReplyCandidate{
			Message:         visibleText,
			EvidenceAnchors: anchors,
		})
		result.VisibleGateAllowed = verdict.Allowed
		result.VisibleGateReason = verdict.Reason
		result.EvidenceAnchors = verdict.EvidenceAnchors
		result.WouldPost = verdict.Allowed
		if verdict.Allowed {
			result.WouldPostReason = "secretary_lookup_visible_reply_allowed"
		} else {
			result.WouldPostReason = "secretary_lookup_visible_reply_blocked:" + firstNonEmpty(verdict.Reason, "unknown")
		}
		return result
	}
	result.VisibleText = completedText
	result.VisibleGateAllowed = true
	result.VisibleGateReason = "normal_worker_result_not_allowlist_gated"
	result.WouldPost = strings.TrimSpace(completedText) != ""
	if result.WouldPost {
		result.WouldPostReason = "normal_worker_result_posted_directly_after_formatting"
	} else {
		result.WouldPostReason = "empty_completed_worker_result"
	}
	return result
}

func parseHistoricalSecretaryLookupResult(text string) (string, []slackagent.SlackVisibleEvidenceAnchor) {
	var mapped map[string]any
	if err := json.Unmarshal([]byte(stripBenchmarkJSONFence(text)), &mapped); err != nil {
		return "", nil
	}
	visibleText := firstNonEmpty(
		anyString(mapped["visible_text"]),
		anyString(mapped["visibleText"]),
		anyString(mapped["message"]),
		anyString(mapped["text"]),
		anyString(mapped["summary"]),
	)
	anchors := evidenceAnchorsFromBenchmarkAny(firstNonEmptyAny(
		mapped["evidence_anchors"],
		mapped["evidenceAnchors"],
		mapped["evidence"],
	))
	return visibleText, anchors
}

func evidenceAnchorsFromBenchmarkAny(value any) []slackagent.SlackVisibleEvidenceAnchor {
	if value == nil {
		return nil
	}
	switch typed := value.(type) {
	case []slackagent.SlackVisibleEvidenceAnchor:
		return typed
	case slackagent.SlackVisibleEvidenceAnchor:
		return []slackagent.SlackVisibleEvidenceAnchor{typed}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var anchors []slackagent.SlackVisibleEvidenceAnchor
	if err := json.Unmarshal(data, &anchors); err == nil {
		return anchors
	}
	var anchor slackagent.SlackVisibleEvidenceAnchor
	if err := json.Unmarshal(data, &anchor); err == nil {
		return []slackagent.SlackVisibleEvidenceAnchor{anchor}
	}
	return nil
}

func stripBenchmarkJSONFence(text string) string {
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(trimmed, "```") {
		trimmed = strings.TrimPrefix(trimmed, "```json")
		trimmed = strings.TrimPrefix(trimmed, "```JSON")
		trimmed = strings.TrimPrefix(trimmed, "```")
		trimmed = strings.TrimSuffix(trimmed, "```")
	}
	return strings.TrimSpace(trimmed)
}

func benchmarkThreadKey(channelID string, threadTS string) string {
	return strings.TrimSpace(channelID) + "\x00" + strings.TrimSpace(threadTS)
}

func historicalWorkerResultSortTime(result benchmarkHistoricalWorkerResult) time.Time {
	for _, value := range []string{result.UpdatedAt, result.CreatedAt} {
		if t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value)); err == nil {
			return t
		}
	}
	return time.Time{}
}

func contextString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := anyString(values[key]); value != "" {
			return value
		}
	}
	return ""
}

func contextMap(values map[string]any, key string) map[string]any {
	if values == nil {
		return nil
	}
	switch typed := values[key].(type) {
	case map[string]any:
		return typed
	case map[string]string:
		out := make(map[string]any, len(typed))
		for k, v := range typed {
			out[k] = v
		}
		return out
	default:
		return nil
	}
}

func firstNonEmptyAny(values ...any) any {
	for _, value := range values {
		switch typed := value.(type) {
		case nil:
			continue
		case string:
			if strings.TrimSpace(typed) != "" {
				return value
			}
		case []any:
			if len(typed) > 0 {
				return value
			}
		case []map[string]any:
			if len(typed) > 0 {
				return value
			}
		default:
			return value
		}
	}
	return nil
}

func anyString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return ""
	}
}

func truncateBenchmarkText(value string, maxRunes int) string {
	trimmed := strings.TrimSpace(value)
	if maxRunes <= 0 || len([]rune(trimmed)) <= maxRunes {
		return trimmed
	}
	return strings.TrimSpace(string([]rune(trimmed)[:maxRunes])) + "\n\n[truncated]"
}

func fetchBenchmarkRuntimeMetadata(ctx context.Context, baseURL string) map[string]any {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 3 * time.Second}
	out := map[string]any{}
	if health := fetchBenchmarkJSONMap(ctx, client, baseURL+"/healthz"); len(health) > 0 {
		out["healthz"] = health
	}
	if status := fetchBenchmarkJSONMap(ctx, client, baseURL+"/slack/status"); len(status) > 0 {
		out["slack_status"] = status
		if personaStatus, ok := status["persona_runtime"].(map[string]any); ok {
			out["persona_runtime"] = personaStatus
		}
		if agentRunner, ok := status["agent_runner"].(map[string]any); ok {
			out["agent_runner"] = agentRunner
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func fetchBenchmarkJSONMap(ctx context.Context, client *http.Client, url string) map[string]any {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil
	}
	return out
}

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
