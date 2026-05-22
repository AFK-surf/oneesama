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
	GeneratedAt     string                                    `json:"generatedAt"`
	VariantID       string                                    `json:"variantId"`
	SlackAgentURL   string                                    `json:"slackAgentUrl"`
	Mode            string                                    `json:"mode"`
	Since           string                                    `json:"since"`
	Channels        []string                                  `json:"channels"`
	Fixtures        []string                                  `json:"fixtures,omitempty"`
	MaxThreads      int                                       `json:"maxThreads,omitempty"`
	Truncated       bool                                      `json:"truncated"`
	Stats           []slackagent.SlackBackfillReplayLiveStats `json:"stats,omitempty"`
	ThreadsSeen     int                                       `json:"threadsSeen"`
	ThreadsReplayed int                                       `json:"threadsReplayed"`
	Summary         benchmarkSummary                          `json:"summary"`
	Rows            []benchmarkRow                            `json:"rows"`
}

type benchmarkSummary struct {
	ByFinalDecision      map[string]int `json:"byFinalDecision"`
	ByPersonaDecision    map[string]int `json:"byPersonaDecision"`
	ByVisibleReplyReason map[string]int `json:"byVisibleReplyReason"`
	ByPipelineSmell      map[string]int `json:"byPipelineSmell"`
	ByFixtureLabel       map[string]int `json:"byFixtureLabel,omitempty"`
	ByFixtureOutcome     map[string]int `json:"byFixtureOutcome,omitempty"`
	FixturePasses        int            `json:"fixturePasses,omitempty"`
	FixtureFailures      int            `json:"fixtureFailures,omitempty"`
	Errors               int            `json:"errors"`
}

type benchmarkRow struct {
	VariantID            string   `json:"variantId"`
	CaseID               string   `json:"caseId,omitempty"`
	CaseDescription      string   `json:"caseDescription,omitempty"`
	FixtureLabel         string   `json:"fixtureLabel,omitempty"`
	FixturePassed        *bool    `json:"fixturePassed,omitempty"`
	FixtureReason        string   `json:"fixtureReason,omitempty"`
	ChannelID            string   `json:"channelId"`
	ThreadTS             string   `json:"threadTs"`
	MessageCount         int      `json:"messageCount"`
	PersonaDecision      string   `json:"personaDecision,omitempty"`
	FinalDecision        string   `json:"finalDecision,omitempty"`
	VisibleReplyAllowed  bool     `json:"visibleReplyAllowed"`
	VisibleReplyReasons  []string `json:"visibleReplyReasons,omitempty"`
	WorkerRequests       int      `json:"workerRequests"`
	PipelineSmellSignals []string `json:"pipelineSmellSignals,omitempty"`
	Error                string   `json:"error,omitempty"`
}

type benchmarkFixture struct {
	CaseID      string                             `json:"caseId"`
	Description string                             `json:"description,omitempty"`
	Label       string                             `json:"label"`
	Tags        []string                           `json:"tags,omitempty"`
	SourceRefs  []string                           `json:"sourceRefs,omitempty"`
	Thread      slackagent.SlackTriageReplayThread `json:"thread"`
	Expected    benchmarkFixtureExpected           `json:"expected,omitempty"`
}

type benchmarkFixtureExpected struct {
	FinalDecision           string   `json:"finalDecision,omitempty"`
	VisibleReplyAllowed     *bool    `json:"visibleReplyAllowed,omitempty"`
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
	)
	fs.StringVar(&slackURL, "slack-url", firstNonEmpty(os.Getenv("ONEESAMA_SLACK_AGENT_URL"), os.Getenv("ONEESAMA_MONITOR_SLACK_URL"), "http://127.0.0.1:8780"), "Local oneesama slack-agent URL.")
	fs.BoolVar(&liveMode, "live", true, "Live Slack scan mode. This is currently the only supported input mode.")
	fs.Var(&fixtures, "fixture", "Fixture JSON path or glob. Repeatable; extra positional args are also treated as fixtures when set.")
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
	report := benchmarkReport{
		GeneratedAt:   time.Now().UTC().Format(time.RFC3339),
		VariantID:     strings.TrimSpace(variantID),
		SlackAgentURL: strings.TrimRight(strings.TrimSpace(slackURL), "/"),
		Mode:          mode,
		Since:         since.String(),
		Fixtures:      fixturePaths,
		MaxThreads:    maxTotalThreads,
		Summary: benchmarkSummary{
			ByFinalDecision:      map[string]int{},
			ByPersonaDecision:    map[string]int{},
			ByVisibleReplyReason: map[string]int{},
			ByPipelineSmell:      map[string]int{},
			ByFixtureLabel:       map[string]int{},
			ByFixtureOutcome:     map[string]int{},
		},
	}
	client := &http.Client{Timeout: 90 * time.Second}
	if mode == "fixture" {
		report.ThreadsSeen = len(fixturePaths)
		for _, path := range fixturePaths {
			if maxTotalThreads > 0 && report.ThreadsReplayed >= maxTotalThreads {
				report.Truncated = true
				break
			}
			fixture, readErr := readBenchmarkFixture(path)
			if readErr != nil {
				row := benchmarkRow{VariantID: report.VariantID, CaseID: strings.TrimSpace(path), Error: readErr.Error()}
				report.Rows = append(report.Rows, row)
				report.ThreadsReplayed++
				recordRow(&report.Summary, row)
				continue
			}
			row := dryRunThread(ctx, client, report.SlackAgentURL, report.VariantID, fixture.Thread)
			applyFixtureResult(&row, fixture)
			report.Rows = append(report.Rows, row)
			report.ThreadsReplayed++
			recordRow(&report.Summary, row)
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
		for _, channelID := range channelIDs {
			if maxTotalThreads > 0 && report.ThreadsReplayed >= maxTotalThreads {
				report.Truncated = true
				break
			}
			channelThreadLimit := maxPerChanThreads
			if maxTotalThreads > 0 {
				remaining := maxTotalThreads - report.ThreadsReplayed
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
				if maxTotalThreads > 0 && report.ThreadsReplayed >= maxTotalThreads {
					report.Truncated = true
					break
				}
				row := dryRunThread(ctx, client, report.SlackAgentURL, report.VariantID, thread)
				report.Rows = append(report.Rows, row)
				report.ThreadsReplayed++
				recordRow(&report.Summary, row)
			}
			if report.Truncated {
				break
			}
		}
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
	for _, verdict := range out.DryRun.VisibleReplyVerdicts {
		if verdict.Allowed {
			row.VisibleReplyAllowed = true
		}
		row.VisibleReplyReasons = append(row.VisibleReplyReasons, verdict.Reason)
	}
	row.VisibleReplyReasons = uniqueStrings(row.VisibleReplyReasons)
	return row
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

func normalizeFixtureLabel(label string) string {
	label = strings.ToLower(strings.TrimSpace(label))
	label = strings.ReplaceAll(label, "-", "_")
	label = strings.ReplaceAll(label, " ", "_")
	switch label {
	case "must_block", "must_allow", "should_delegate", "freely_silent":
		return label
	default:
		return label
	}
}

func recordRow(summary *benchmarkSummary, row benchmarkRow) {
	if strings.TrimSpace(row.Error) != "" {
		summary.Errors++
	}
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
	fmt.Fprintf(&b, "| Case | Channel | Thread | Msgs | Label | Result | Persona | Final | Gate reasons | Workers | Smells | Error |\n")
	fmt.Fprintf(&b, "|---|---|---|---:|---|---|---|---|---|---:|---|---|\n")
	for _, row := range report.Rows {
		reasons := "—"
		if len(row.VisibleReplyReasons) > 0 {
			reasons = strings.Join(row.VisibleReplyReasons, ", ")
		}
		smells := "—"
		if len(row.PipelineSmellSignals) > 0 {
			smells = strings.Join(row.PipelineSmellSignals, ", ")
		}
		errText := "—"
		if strings.TrimSpace(row.Error) != "" {
			errText = row.Error
		}
		fixtureResult := "—"
		if row.FixturePassed != nil {
			if *row.FixturePassed {
				fixtureResult = "pass"
			} else {
				fixtureResult = "fail"
			}
			if row.FixtureReason != "" {
				fixtureResult += ":" + row.FixtureReason
			}
		}
		fmt.Fprintf(&b, "| `%s` | `%s` | `%s` | %d | `%s` | `%s` | `%s` | `%s` | %s | %d | %s | %s |\n",
			escapeMarkdownCell(firstNonEmpty(row.CaseID, "—")),
			escapeMarkdownCell(row.ChannelID),
			escapeMarkdownCell(row.ThreadTS),
			row.MessageCount,
			escapeMarkdownCell(firstNonEmpty(row.FixtureLabel, "—")),
			escapeMarkdownCell(fixtureResult),
			escapeMarkdownCell(firstNonEmpty(row.PersonaDecision, "unknown")),
			escapeMarkdownCell(firstNonEmpty(row.FinalDecision, "unknown")),
			escapeMarkdownCell(reasons),
			row.WorkerRequests,
			escapeMarkdownCell(smells),
			escapeMarkdownCell(errText),
		)
	}
	return b.String()
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
