// Command oneesama-triage-benchmark replays recent Slack threads through
// Oneesama's live triage dry-run path. It is read-only: Slack fetching is
// via conversations.history/replies and the triage call uses dry_run=true,
// so posting, worker starts, reactions, memory writes, and approval cards
// are blocked by the service.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/slackagent"
)

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
}

type benchmarkSummary struct {
	ByFinalDecision      map[string]int `json:"byFinalDecision"`
	ByPersonaDecision    map[string]int `json:"byPersonaDecision"`
	ByVisibleReplyReason map[string]int `json:"byVisibleReplyReason"`
	ByPipelineSmell      map[string]int `json:"byPipelineSmell"`
	ByFixtureLabel       map[string]int `json:"byFixtureLabel,omitempty"`
	ByFixtureOutcome     map[string]int `json:"byFixtureOutcome,omitempty"`
	ByJudgeVerdict       map[string]int `json:"byJudgeVerdict,omitempty"`
	ByJudgeFlag          map[string]int `json:"byJudgeFlag,omitempty"`
	FixturePasses        int            `json:"fixturePasses,omitempty"`
	FixtureFailures      int            `json:"fixtureFailures,omitempty"`
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
		maxPerChan        int
		maxPerChanThreads int
		maxTotalThreads   int
		outputPath        string
		format            string
		variantID         string
		timeout           time.Duration
		fixtures          stringListFlag
		configSets        stringListFlag
		judgeURL          string
		judgeModel        string
		judgeAPIKey       string
		judgeMaxRows      int
	)
	fs.StringVar(&slackURL, "slack-url", firstNonEmpty(os.Getenv("ONEESAMA_SLACK_AGENT_URL"), os.Getenv("ONEESAMA_MONITOR_SLACK_URL"), "http://127.0.0.1:8780"), "Local oneesama slack-agent URL.")
	fs.BoolVar(&liveMode, "live", true, "Live Slack scan mode. This is currently the only supported input mode.")
	fs.Var(&fixtures, "fixture", "Fixture JSON path or glob. Repeatable; extra positional args are also treated as fixtures when set.")
	fs.Var(&configSets, "config-set", "Variant config JSON file, directory, or glob. Repeatable. This first pass records variant metadata and replays the same cases for every variant.")
	fs.StringVar(&channels, "channel", "auto", "Comma-separated Slack channel ids or exactly 'auto'.")
	fs.StringVar(&token, "token", "", "Slack bot token. Defaults to ONEESAMA_SLACK_BOT_TOKEN.")
	fs.StringVar(&botIDs, "bot-user-ids", "", "Comma-separated bot user ids used only for legacy stats.")
	fs.DurationVar(&since, "since", 24*time.Hour, "Live Slack scan window.")
	fs.IntVar(&maxPerChan, "max-messages-per-channel", 200, "Max conversations.history rows per channel.")
	fs.IntVar(&maxPerChanThreads, "max-threads-per-channel", 3, "Max root threads to collect per channel.")
	fs.IntVar(&maxTotalThreads, "max-threads", 24, "Max total root threads to dry-run across all channels. Use 0 to disable the global cap.")
	fs.StringVar(&outputPath, "output", "", "Optional JSON report path. Use '-' or omit for stdout JSON.")
	fs.StringVar(&format, "format", "json", "Output format: json or markdown.")
	fs.StringVar(&variantID, "variant-id", "current", "Variant/config id recorded in the report.")
	fs.DurationVar(&timeout, "timeout", 10*time.Minute, "Overall benchmark timeout.")
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
		fmt.Fprintln(stderr, "oneesama-triage-benchmark: --fixture path is required when --live=false")
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
	report := benchmarkReport{
		GeneratedAt:   time.Now().UTC().Format(time.RFC3339),
		VariantID:     reportVariantID,
		SlackAgentURL: strings.TrimRight(strings.TrimSpace(slackURL), "/"),
		Mode:          mode,
		Since:         since.String(),
		Fixtures:      fixturePaths,
		MaxThreads:    maxTotalThreads,
		Summary:       newBenchmarkSummary(),
		Variants:      variants,
		Judge:         judgeOpts.benchmarkJudgeConfig,
	}
	client := &http.Client{Timeout: 90 * time.Second}
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
					recordBenchmarkRow(&report, row)
					continue
				}
				row := dryRunThread(ctx, client, report.SlackAgentURL, variant.VariantID, fixture.Thread)
				if strings.TrimSpace(fixture.Candidate.Message) != "" {
					row = evaluateCandidateFixture(variant.VariantID, fixture)
				}
				applyFixtureResult(&row, fixture)
				applyBenchmarkJudge(ctx, client, judgeOpts, &judgeBudget, &row, fixture.Thread, &fixture)
				recordBenchmarkRow(&report, row)
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
			fmt.Fprintln(stderr, "oneesama-triage-benchmark: --token or ONEESAMA_SLACK_BOT_TOKEN / SLACK_BOT_TOKEN / MAB_SLACK_BOT_TOKEN is required")
			return 1
		}
		channelIDs, err := resolveChannels(ctx, channels, token, stderr)
		if err != nil {
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: %v\n", err)
			return 1
		}
		report.Channels = channelIDs
		botUserIDs := splitCSV(botIDs)
		var replayThreads []slackagent.SlackTriageReplayThread
		for _, channelID := range channelIDs {
			if maxTotalThreads > 0 && len(replayThreads) >= maxTotalThreads {
				report.Truncated = true
				break
			}
			channelThreadLimit := maxPerChanThreads
			if maxTotalThreads > 0 {
				remaining := maxTotalThreads - len(replayThreads)
				if remaining < channelThreadLimit || channelThreadLimit <= 0 {
					channelThreadLimit = remaining
				}
			}
			threads, stats, scanErr := slackagent.SlackTriageReplayLiveThreads(ctx, slackagent.SlackBackfillReplayLiveOptions{
				BotToken:              token,
				BotUserIDs:            botUserIDs,
				ChannelID:             channelID,
				Since:                 since,
				MaxMessagesPerChannel: maxPerChan,
				MaxThreads:            channelThreadLimit,
			})
			if scanErr != nil {
				stats.ChannelID = channelID
				stats.Warnings = append(stats.Warnings, fmt.Sprintf("thread scan failed: %v", scanErr))
			}
			report.Stats = append(report.Stats, stats)
			report.ThreadsSeen += len(threads)
			fmt.Fprintf(stderr, "oneesama-triage-benchmark: channel %s scan found %d thread(s)\n", channelID, len(threads))
			for _, thread := range threads {
				if maxTotalThreads > 0 && len(replayThreads) >= maxTotalThreads {
					report.Truncated = true
					break
				}
				replayThreads = append(replayThreads, thread)
			}
			if report.Truncated {
				break
			}
		}
		for _, variant := range variants {
			for _, thread := range replayThreads {
				row := dryRunThread(ctx, client, report.SlackAgentURL, variant.VariantID, thread)
				applyBenchmarkJudge(ctx, client, judgeOpts, &judgeBudget, &row, thread, nil)
				recordBenchmarkRow(&report, row)
			}
		}
	}
	report.VariantSummaries = buildVariantSummaries(variants, report.Rows)

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
	fmt.Fprintf(stderr, "oneesama-triage-benchmark: replayed %d thread(s); errors=%d; fixture_failures=%d; decisions=%v\n", report.ThreadsReplayed, report.Summary.Errors, report.Summary.FixtureFailures, report.Summary.ByFinalDecision)
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

func newBenchmarkSummary() benchmarkSummary {
	return benchmarkSummary{
		ByFinalDecision:      map[string]int{},
		ByPersonaDecision:    map[string]int{},
		ByVisibleReplyReason: map[string]int{},
		ByPipelineSmell:      map[string]int{},
		ByFixtureLabel:       map[string]int{},
		ByFixtureOutcome:     map[string]int{},
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
	defer resp.Body.Close()
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

func dryRunThread(ctx context.Context, client *http.Client, baseURL string, variantID string, thread slackagent.SlackTriageReplayThread) benchmarkRow {
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
		return row
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/slack/triage/run", bytes.NewReader(body))
	if err != nil {
		row.Error = err.Error()
		return row
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		row.Error = err.Error()
		return row
	}
	defer resp.Body.Close()
	var out triageRunResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		row.Error = fmt.Sprintf("decode HTTP %d: %v", resp.StatusCode, err)
		return row
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !out.OK {
		row.Error = firstNonEmpty(out.Error, fmt.Sprintf("HTTP %d", resp.StatusCode))
		return row
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
	return row
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

	appendCountTable(&b, "Fixture Labels", report.Summary.ByFixtureLabel)
	appendCountTable(&b, "Fixture Outcomes", report.Summary.ByFixtureOutcome)
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
	fmt.Fprintf(&b, "| Variant | Case | Channel | Thread | Msgs | Label | Result | Failure layer | Persona | Final | Gate | Gate reasons | Workers | Judge | Error |\n")
	fmt.Fprintf(&b, "|---|---|---|---|---:|---|---|---|---|---|---|---|---:|---|---|\n")
	for _, row := range report.Rows {
		errText := "—"
		if strings.TrimSpace(row.Error) != "" {
			errText = row.Error
		}
		reasons := "—"
		if len(row.VisibleReplyReasons) > 0 {
			reasons = strings.Join(row.VisibleReplyReasons, ", ")
		}
		fmt.Fprintf(&b, "| `%s` | `%s` | `%s` | `%s` | %d | `%s` | `%s` | `%s` | `%s` | `%s` | `%s` | %s | %d | `%s` | %s |\n",
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
			escapeMarkdownCell(errText),
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
