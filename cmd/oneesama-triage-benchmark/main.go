// Command oneesama-triage-benchmark replays recent Slack threads through
// Oneesama's live triage dry-run path. It is read-only: Slack fetching is
// via conversations.history/replies and the triage call uses dry_run=true,
// so posting, worker starts, reactions, and memory writes
// are blocked by the service.
package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
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
