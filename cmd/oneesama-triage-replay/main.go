// Command oneesama-triage-replay scans a window of recent Slack
// messages and proposes lightweight follow-up replies for the ones
// oneesama should have caught — long-unanswered questions, stuck-help
// pings, article/link shares with no human follow-up, etc.
//
// This is task #185 from the consolidated cueboard backlog. The
// product goal (Peng, 5/18): "扫一下过去的所有消息，然后想一想哪些其实
// 是值得回的". Old cueboard's "Onisama" persona did this; the Go
// rewrite dropped it. This CLI brings it back, but only as a dry-run
// surface — the operator reviews the Markdown report before any
// reply is posted. `--post` is intentionally NOT in slice 1.
//
// Slice 1 input shape: NDJSON on stdin, one SlackInboundMessage JSON
// object per line. This makes the algorithm trivially testable and
// lets the operator pipe in any source of messages (a Slack export,
// a fixture, a live API dump) without coupling the CLI to a
// particular fetch path.
//
// Slice 2 (future): wire in a `--live --channel C123 --since 24h`
// path that calls Slack conversations.history directly.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persona"
	"github.com/AFK-surf/oneesama/internal/slackagent"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

// mergePersistedState loads the runtime's persisted `delayed_no_reply`
// followups, applies a TTL filter (`maxAge`) to drop stale records,
// folds the surviving leads into the fresh candidate list using the
// (channel, thread, classification) dedupe key, and re-verifies
// persisted-only leads against Slack when `token` is non-empty.
//
// When `resolveStaleAndSuperseded` is true, the function ALSO writes
// the runtime store: expired (TTL filter) and superseded (refetch
// found a human reply) followups are marked `done` with the
// appropriate `metadata.resolution`. This keeps the next replay
// run's report clean instead of resurfacing the same stale leads.
//
// Returns:
//   - merged candidates
//   - count of loaded followups (raw, before TTL)
//   - count of refetch-superseded
//   - count of TTL-expired
//   - count of records actually mutated by resolve (only non-zero
//     when resolveStaleAndSuperseded is true)
//   - error if the load or resolve writes failed; merge errors are
//     non-fatal and folded into supersededCount via stats.
//
// Failure to open the store is treated as non-fatal by the caller —
// we still surface fresh candidates instead of zero-output.
func mergePersistedState(
	candidates []slackagent.SlackBackfillCandidate,
	dataDir string,
	sqlitePath string,
	provider string,
	token string,
	botUserIDs []string,
	maxAge time.Duration,
	resolveStaleAndSuperseded bool,
) ([]slackagent.SlackBackfillCandidate, int, int, int, int, error) {
	cfg := appconfig.PersistenceConfig{
		Provider:   strings.TrimSpace(provider),
		DataDir:    strings.TrimSpace(dataDir),
		SQLitePath: strings.TrimSpace(sqlitePath),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	followups, err := slackagent.LoadDelayedNoReplyFollowups(ctx, cfg)
	if err != nil {
		return candidates, 0, 0, 0, 0, err
	}
	if len(followups) == 0 {
		return candidates, 0, 0, 0, 0, nil
	}

	// TTL filter first — saves refetch API quota on records we know
	// we won't use.
	kept, expired := slackagent.FilterBackfillFollowupsByAge(followups, maxAge, time.Time{})

	refetcher := slackagent.NewBackfillSlackRefetcher(token, botUserIDs)
	merged, superseded := slackagent.MergeAndRefetchPersistedDelayedNoReply(ctx, candidates, kept, refetcher)

	resolved := 0
	if resolveStaleAndSuperseded {
		ids := make([]int64, 0, len(superseded)+len(expired))
		for _, f := range superseded {
			ids = append(ids, f.ID)
		}
		expiredIDs := make([]int64, 0, len(expired))
		for _, f := range expired {
			expiredIDs = append(expiredIDs, f.ID)
		}
		if n, rerr := slackagent.BackfillResolveDelayedNoReplyFollowups(ctx, cfg, ids, "superseded_by_human"); rerr == nil {
			resolved += n
		}
		if n, rerr := slackagent.BackfillResolveDelayedNoReplyFollowups(ctx, cfg, expiredIDs, "expired"); rerr == nil {
			resolved += n
		}
	}

	return merged, len(followups), len(superseded), len(expired), resolved, nil
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	fs := flag.NewFlagSet("oneesama-triage-replay", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var (
		outputPath string
		botIDsFlag string
		quiet      bool
		liveMode   bool
		channels   string
		sinceFlag  time.Duration
		token      string
		maxPerChan int
	)
	fs.StringVar(&outputPath, "output", "", "Markdown report path. Use '-' or omit for stdout.")
	fs.StringVar(&botIDsFlag, "bot-user-ids", "", "Comma-separated Slack user ids for oneesama bots; messages from these users are excluded.")
	fs.BoolVar(&quiet, "quiet", false, "Suppress informational stderr summary (errors still print).")
	fs.BoolVar(&liveMode, "live", false, "Live mode: call Slack conversations.history directly instead of reading NDJSON from stdin.")
	fs.StringVar(&channels, "channel", "", "Comma-separated channel ids to scan (required in --live mode). Example: C0AQ0C0KVMH,C0123ABC.")
	fs.DurationVar(&sinceFlag, "since", 24*time.Hour, "Live mode: only consider messages newer than this duration.")
	fs.StringVar(&token, "token", "", "Live mode: Slack bot token (xoxb-...). Falls back to ONEESAMA_SLACK_BOT_TOKEN env var.")
	fs.IntVar(&maxPerChan, "max-messages-per-channel", 200, "Live mode: stop scanning a channel after this many messages (truncation flag set when hit).")
	var persistenceDir string
	fs.StringVar(&persistenceDir, "persistence-dir", "", "Optional: directory of the live runtime's persistence state (slice 3 piece A). When set, merges delayed_no_reply followups into the report so persisted 'wait for human' state isn't lost from candidates.")
	var persistenceSQLite string
	fs.StringVar(&persistenceSQLite, "persistence-sqlite", "", "Optional: explicit SQLite file path for runtime persistence (overrides --persistence-dir/state.sqlite3 default).")
	var persistenceMaxAge time.Duration
	fs.DurationVar(&persistenceMaxAge, "persistence-max-age", slackagent.DefaultBackfillPersistedMaxAge, "Stale persisted delayed_no_reply followups older than this duration are dropped from the report (and resolved as `expired` when --persistence-resolve is set). Set to 0 to disable.")
	var resolveStaleFollowups bool
	fs.BoolVar(&resolveStaleFollowups, "persistence-resolve", false, "When set, the CLI writes `done` + resolution metadata back to the runtime store for followups dropped by TTL (expired) or refetch (superseded_by_human). Off by default — dry-run preserves replay determinism.")
	var persistenceProvider string
	fs.StringVar(&persistenceProvider, "persistence-provider", "", "Optional: persistence provider (e.g. 'json-file' or 'sqlite'). Defaults to runtime config default.")
	var workspaceDir string
	fs.StringVar(&workspaceDir, "workspace-dir", "", "Optional: Slack workspace memory directory. Defaults to ONEESAMA_SLACK_WORKSPACE_DIR / MAB_SLACK_WORKSPACE_DIR when set; enables related-memory evidence in the report.")
	var personaRuntimeProvider string
	fs.StringVar(&personaRuntimeProvider, "persona-runtime", "", "Optional: shadow-replay candidates through a persona runtime provider (fake, http, or pi). Defaults to ONEESAMA_PERSONA_RUNTIME / MAB_PERSONA_RUNTIME when set.")
	var personaRuntimeMode string
	fs.StringVar(&personaRuntimeMode, "persona-runtime-mode", "shadow", "Persona runtime mode for shadow replay. Must stay shadow until live cutover.")
	var personaRuntimeBaseURL string
	fs.StringVar(&personaRuntimeBaseURL, "persona-runtime-base-url", "", "Optional: local Pi/http sidecar base URL for persona shadow replay. Defaults to ONEESAMA_PERSONA_RUNTIME_BASE_URL / MAB_PERSONA_RUNTIME_BASE_URL.")
	var personaRuntimeTimeout time.Duration
	fs.DurationVar(&personaRuntimeTimeout, "persona-runtime-timeout", 90*time.Second, "Persona runtime request timeout for shadow replay.")
	var benchmarkVerdictsPath string
	fs.StringVar(&benchmarkVerdictsPath, "benchmark-verdicts", "", "Optional: NDJSON benchmark/judge verdicts to convert into LearningSignal rows. Only failing verdicts are captured.")
	var learningSignalOutputPath string
	fs.StringVar(&learningSignalOutputPath, "learning-signal-output", "", "Optional: write captured LearningSignal rows as NDJSON to this path.")
	var learningSignalStore bool
	fs.BoolVar(&learningSignalStore, "learning-signal-store", false, "Optional: persist captured LearningSignal rows into the configured persistence store. Requires --persistence-dir, --persistence-sqlite, or --persistence-provider memory.")
	fs.Usage = func() {
		fmt.Fprintf(stderr, "Usage: oneesama-triage-replay [--output PATH] [--bot-user-ids U_BOT,U_OTHER] [--quiet]\n")
		fmt.Fprintf(stderr, "       oneesama-triage-replay --live --channel C123,C456 [--since 24h] [--token xoxb-...] [--max-messages-per-channel 200]\n\n")
		fmt.Fprintf(stderr, "Two input modes:\n\n")
		fmt.Fprintf(stderr, "  Default (NDJSON):  Reads one SlackInboundMessage per stdin line.\n")
		fmt.Fprintf(stderr, "                     Useful for fixtures, exports, replay testing.\n")
		fmt.Fprintf(stderr, "  --live:            Calls Slack conversations.history + .replies\n")
		fmt.Fprintf(stderr, "                     directly for each --channel. Pagination, 429\n")
		fmt.Fprintf(stderr, "                     retry, and truncation flags are handled.\n\n")
		fmt.Fprintf(stderr, "Both modes are dry-run: nothing is posted to Slack. The output is\n")
		fmt.Fprintf(stderr, "a Markdown report of candidate follow-up replies for human review.\n\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}

	botUserIDs := splitCSV(botIDsFlag)

	var (
		candidates []slackagent.SlackBackfillCandidate
		liveStats  []slackagent.SlackBackfillReplayLiveStats
		scanned    int
		err        error
	)
	if liveMode {
		candidates, liveStats, scanned, err = runLive(stderr, channels, sinceFlag, token, maxPerChan, botUserIDs)
	} else {
		candidates, scanned, err = runStdin(stdin, botUserIDs)
	}
	if err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-replay: %v\n", err)
		return 1
	}

	// Slice 3 piece A + refetch upgrade: optional persisted-state
	// merge. Opt-in via --persistence-dir; the CLI stays usable
	// without runtime state access (e.g. when running against a
	// stale Slack export). When a live bot token is available
	// (either --token flag or ONEESAMA_SLACK_BOT_TOKEN env), the
	// merger re-checks each persisted-only thread via
	// conversations.replies BEFORE surfacing — followups whose thread
	// has since gotten a human reply are dropped from the report so
	// stale persisted leads do not appear as postable candidates.
	persistenceAttempted := false
	supersededCount := 0
	expiredCount := 0
	resolvedCount := 0
	if strings.TrimSpace(persistenceDir) != "" || strings.TrimSpace(persistenceSQLite) != "" {
		persistenceAttempted = true
		refetchToken := strings.TrimSpace(token)
		if refetchToken == "" {
			refetchToken = strings.TrimSpace(os.Getenv("ONEESAMA_SLACK_BOT_TOKEN"))
		}
		merged, _, superseded, expired, resolved, mergeErr := mergePersistedState(
			candidates, persistenceDir, persistenceSQLite, persistenceProvider,
			refetchToken, botUserIDs,
			persistenceMaxAge, resolveStaleFollowups,
		)
		if mergeErr != nil {
			fmt.Fprintf(stderr, "oneesama-triage-replay: persisted state merge: %v\n", mergeErr)
			// Non-fatal: keep going with fresh candidates only.
		} else {
			candidates = merged
			supersededCount = superseded
			expiredCount = expired
			resolvedCount = resolved
		}
	}
	workspaceDir = firstNonEmpty(strings.TrimSpace(workspaceDir), strings.TrimSpace(os.Getenv("ONEESAMA_SLACK_WORKSPACE_DIR")), strings.TrimSpace(os.Getenv("MAB_SLACK_WORKSPACE_DIR")))
	if workspaceDir != "" {
		candidates = enrichBackfillRelatedMemory(context.Background(), candidates, workspaceDir, persistenceDir, persistenceSQLite, persistenceProvider)
	}
	personaShadowResults, personaShadowErr := runPersonaShadowReplay(
		candidates,
		personaRuntimeProvider,
		personaRuntimeMode,
		personaRuntimeBaseURL,
		personaRuntimeTimeout,
	)
	if personaShadowErr != nil {
		fmt.Fprintf(stderr, "oneesama-triage-replay: persona shadow replay: %v\n", personaShadowErr)
		return 1
	}

	learningSignals := slackagent.SlackLearningSignalsFromPersonaShadowResults(personaShadowResults)
	if strings.TrimSpace(benchmarkVerdictsPath) != "" {
		benchmarkSignals, readErr := readBenchmarkLearningSignals(benchmarkVerdictsPath)
		if readErr != nil {
			fmt.Fprintf(stderr, "oneesama-triage-replay: benchmark verdicts: %v\n", readErr)
			return 1
		}
		learningSignals = append(learningSignals, benchmarkSignals...)
	}
	if strings.TrimSpace(learningSignalOutputPath) != "" {
		if err := writeLearningSignalsNDJSON(learningSignalOutputPath, learningSignals); err != nil {
			fmt.Fprintf(stderr, "oneesama-triage-replay: write learning signals: %v\n", err)
			return 1
		}
	}
	if learningSignalStore {
		if strings.TrimSpace(persistenceDir) == "" && strings.TrimSpace(persistenceSQLite) == "" && strings.TrimSpace(persistenceProvider) != "memory" {
			fmt.Fprintf(stderr, "oneesama-triage-replay: --learning-signal-store requires --persistence-dir, --persistence-sqlite, or --persistence-provider memory\n")
			return 1
		}
		cfg := appconfig.PersistenceConfig{
			Provider:   strings.TrimSpace(persistenceProvider),
			DataDir:    strings.TrimSpace(persistenceDir),
			SQLitePath: strings.TrimSpace(persistenceSQLite),
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		written, persistErr := slackagent.PersistSlackLearningSignals(ctx, cfg, learningSignals)
		cancel()
		if persistErr != nil {
			fmt.Fprintf(stderr, "oneesama-triage-replay: persist learning signals: %v\n", persistErr)
			return 1
		}
		if !quiet {
			fmt.Fprintf(stderr, "oneesama-triage-replay: persisted %d learning signal(s)\n", written)
		}
	}

	markdown := slackagent.RenderBackfillCandidatesMarkdown(candidates)
	if liveMode {
		markdown = appendLiveStatsSection(markdown, liveStats)
	}
	if len(personaShadowResults) > 0 {
		markdown = appendPersonaShadowSection(markdown, personaShadowResults)
	}
	if len(learningSignals) > 0 {
		markdown = appendLearningSignalsSection(markdown, learningSignals)
	}
	// Footer should count actual rendered persisted candidates (the
	// reality the operator sees in the report), not the raw load
	// count. Driver flagged this on 13cba6e: if a malformed followup
	// gets dropped during merge, raw count would be optimistic.
	if persistenceAttempted {
		var fromPersisted int
		for _, c := range candidates {
			if c.FromPersistedState {
				fromPersisted++
			}
		}
		if fromPersisted > 0 || supersededCount > 0 || expiredCount > 0 {
			extras := ""
			if resolvedCount > 0 {
				extras = fmt.Sprintf("; %d resolved via --persistence-resolve writeback", resolvedCount)
			}
			markdown += fmt.Sprintf(
				"\n_Persisted state merged: %d candidate(s) carry FromPersistedState=true; %d superseded by human reply (dropped); %d expired by TTL (dropped)%s._\n",
				fromPersisted, supersededCount, expiredCount, extras,
			)
		}
	}

	dest, closeFn, openErr := openOutput(outputPath, stdout)
	if openErr != nil {
		fmt.Fprintf(stderr, "oneesama-triage-replay: open output: %v\n", openErr)
		return 1
	}
	defer closeFn()
	if _, writeErr := dest.Write([]byte(markdown)); writeErr != nil {
		fmt.Fprintf(stderr, "oneesama-triage-replay: write output: %v\n", writeErr)
		return 1
	}

	if !quiet {
		fmt.Fprintf(stderr,
			"oneesama-triage-replay: scanned %d message(s), produced %d candidate(s) → %s\n",
			scanned, len(candidates), describeOutput(outputPath),
		)
		if strings.TrimSpace(learningSignalOutputPath) != "" {
			fmt.Fprintf(stderr,
				"oneesama-triage-replay: captured %d learning signal(s) → %s\n",
				len(learningSignals), learningSignalOutputPath,
			)
		}
	}
	return 0
}

func readBenchmarkLearningSignals(path string) ([]slackagent.SlackLearningSignal, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	verdicts, err := slackagent.ReadSlackTriageReplayBenchmarkVerdictsNDJSON(f)
	if err != nil {
		return nil, err
	}
	return slackagent.SlackLearningSignalsFromTriageReplayBenchmarkVerdicts(verdicts), nil
}

func writeLearningSignalsNDJSON(path string, signals []slackagent.SlackLearningSignal) error {
	if strings.TrimSpace(path) == "-" {
		return fmt.Errorf("--learning-signal-output does not support '-' because stdout is the Markdown report")
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	enc := json.NewEncoder(f)
	for _, signal := range signals {
		if err := enc.Encode(signal); err != nil {
			return err
		}
	}
	return nil
}

func runPersonaShadowReplay(candidates []slackagent.SlackBackfillCandidate, provider string, mode string, baseURL string, timeout time.Duration) ([]slackagent.SlackPersonaShadowResult, error) {
	provider = strings.TrimSpace(firstNonEmpty(provider, os.Getenv("ONEESAMA_PERSONA_RUNTIME"), os.Getenv("MAB_PERSONA_RUNTIME")))
	if provider == "" || persona.NormalizeProvider(provider) == persona.ProviderLegacy {
		return nil, nil
	}
	baseURL = strings.TrimSpace(firstNonEmpty(baseURL, os.Getenv("ONEESAMA_PERSONA_RUNTIME_BASE_URL"), os.Getenv("MAB_PERSONA_RUNTIME_BASE_URL")))
	mode = persona.NormalizeMode(mode)
	if mode != persona.ModeShadow {
		return nil, fmt.Errorf("persona shadow replay requires --persona-runtime-mode=shadow; got %q", mode)
	}
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	runtime, err := persona.NewRuntime(persona.Config{
		Provider:   provider,
		Mode:       mode,
		BaseURL:    baseURL,
		Timeout:    timeout,
		ShadowOnly: true,
	})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), maxDuration(timeout*time.Duration(maxInt(1, len(candidates))), timeout))
	defer cancel()
	return slackagent.ShadowPersonaBackfillCandidates(ctx, runtime, candidates), nil
}

func enrichBackfillRelatedMemory(ctx context.Context, candidates []slackagent.SlackBackfillCandidate, workspaceDir string, persistenceDir string, persistenceSQLite string, persistenceProvider string) []slackagent.SlackBackfillCandidate {
	if ctx == nil {
		ctx = context.Background()
	}
	workspaceDir = strings.TrimSpace(workspaceDir)
	if workspaceDir == "" || len(candidates) == 0 {
		return candidates
	}
	cfg := appconfig.PersistenceConfig{
		Provider:   strings.TrimSpace(persistenceProvider),
		DataDir:    strings.TrimSpace(persistenceDir),
		SQLitePath: strings.TrimSpace(persistenceSQLite),
	}
	service := slackagent.NewService(slackagent.Config{
		Persistence: cfg,
		Slack: appconfig.SlackConfig{
			WorkspaceDir: filepath.Clean(workspaceDir),
		},
	})
	return slackagent.EnrichBackfillCandidatesWithRelatedMemory(candidates, func(query string) slackagent.SlackRelatedMemorySearchResult {
		return service.SearchRelatedMemoryContext(ctx, query, slackagent.SlackRelatedMemorySearchOptions{Limit: 5})
	}, 3)
}

// runLive iterates --channel values and fans out to BackfillReplayLive.
// One channel failing (bad token, channel not found) does not abort the
// whole run; we collect per-channel error into the warnings of that
// channel's stats so the Markdown report carries the diagnostic.
//
// `--channel auto` is a special value that triggers
// `slackagent.ListBackfillJoinedChannels` to fill the list from
// `users.conversations` (only joined, non-archived public/private
// channels). Audit-safety: `auto` and explicit channel ids are NOT
// allowed to mix in the same `--channel` value — driver flagged the
// risk that an operator would assume union semantics.
func runLive(stderr io.Writer, channels string, since time.Duration, tokenFlag string, maxPerChan int, botUserIDs []string) ([]slackagent.SlackBackfillCandidate, []slackagent.SlackBackfillReplayLiveStats, int, error) {
	requested := splitCSV(channels)
	if len(requested) == 0 {
		return nil, nil, 0, fmt.Errorf("--live requires --channel <ids|auto> with at least one value")
	}
	hasAuto := false
	hasExplicit := false
	for _, value := range requested {
		if strings.EqualFold(strings.TrimSpace(value), "auto") {
			hasAuto = true
		} else {
			hasExplicit = true
		}
	}
	if hasAuto && hasExplicit {
		return nil, nil, 0, fmt.Errorf("--channel cannot mix 'auto' with explicit channel ids; use one mode at a time")
	}

	token := strings.TrimSpace(tokenFlag)
	if token == "" {
		token = strings.TrimSpace(os.Getenv("ONEESAMA_SLACK_BOT_TOKEN"))
	}
	if token == "" {
		return nil, nil, 0, fmt.Errorf("--live requires --token or ONEESAMA_SLACK_BOT_TOKEN env var")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	chList := requested
	if hasAuto {
		discovered, err := slackagent.ListBackfillJoinedChannels(ctx, token)
		if err != nil {
			return nil, nil, 0, fmt.Errorf("--channel auto: %w", err)
		}
		if len(discovered) == 0 {
			// Driver-required audit safety: empty auto-discovery
			// is a hard failure, not a silent empty report. If the
			// bot isn't in any channel something is wrong on the
			// Slack side and the operator needs to know.
			return nil, nil, 0, fmt.Errorf("--channel auto discovered 0 joined channels; check bot is invited to at least one channel")
		}
		chList = make([]string, 0, len(discovered))
		for _, ch := range discovered {
			chList = append(chList, ch.ID)
		}
		fmt.Fprintf(stderr, "oneesama-triage-replay: --channel auto discovered %d channel(s)\n", len(chList))
	}

	var (
		allCandidates []slackagent.SlackBackfillCandidate
		allStats      []slackagent.SlackBackfillReplayLiveStats
		totalScanned  int
	)
	for _, ch := range chList {
		cs, st, err := slackagent.BackfillReplayLive(ctx, slackagent.SlackBackfillReplayLiveOptions{
			BotToken:              token,
			BotUserIDs:            botUserIDs,
			ChannelID:             ch,
			Since:                 since,
			MaxMessagesPerChannel: maxPerChan,
		})
		if err != nil {
			// Promote the channel-fatal error into the stats
			// warnings so the operator sees it in the report; do
			// NOT abort the whole run on a single bad channel.
			st.ChannelID = ch
			st.Warnings = append(st.Warnings, fmt.Sprintf("scan failed: %v", err))
			fmt.Fprintf(stderr, "oneesama-triage-replay: channel %s scan failed: %v\n", ch, err)
		}
		allCandidates = append(allCandidates, cs...)
		allStats = append(allStats, st)
		totalScanned += st.MessagesScanned
	}
	return allCandidates, allStats, totalScanned, nil
}

// runStdin is the slice-1 path: read NDJSON, classify, render. Kept as
// a fallback so fixtures and replay testing keep working in --live's
// shadow.
func runStdin(stdin io.Reader, botUserIDs []string) ([]slackagent.SlackBackfillCandidate, int, error) {
	messages, err := readMessages(stdin)
	if err != nil {
		return nil, 0, fmt.Errorf("read messages: %w", err)
	}
	if len(messages) == 0 {
		return nil, 0, fmt.Errorf("input contained no SlackInboundMessage records")
	}
	return classifyAll(messages, botUserIDs), len(messages), nil
}

// appendLiveStatsSection adds a per-channel coverage section to the
// rendered Markdown so the operator can see which channels were
// truncated, how many messages were scanned, and which channels
// failed. Without this the Markdown could silently misrepresent
// coverage (audit point #5).
func appendLiveStatsSection(markdown string, stats []slackagent.SlackBackfillReplayLiveStats) string {
	if len(stats) == 0 {
		return markdown
	}
	var b strings.Builder
	b.WriteString(markdown)
	if !strings.HasSuffix(markdown, "\n\n") {
		b.WriteString("\n")
	}
	b.WriteString("## Live scan coverage\n\n")
	b.WriteString("| Channel | Scanned | Replies fetched | Candidates | Truncated | 429 retries | Warnings |\n")
	b.WriteString("|---|---:|---:|---:|---|---:|---|\n")
	for _, s := range stats {
		warnings := "—"
		if len(s.Warnings) > 0 {
			warnings = strings.Join(s.Warnings, "; ")
		}
		_, _ = fmt.Fprintf(&b,
			"| `%s` | %d | %d | %d | %v | %d | %s |\n",
			s.ChannelID, s.MessagesScanned, s.RepliesFetched, s.CandidatesFound, s.Truncated, s.APIRetries429, warnings,
		)
	}
	return b.String()
}

func appendPersonaShadowSection(markdown string, results []slackagent.SlackPersonaShadowResult) string {
	if len(results) == 0 {
		return markdown
	}
	var b strings.Builder
	b.WriteString(markdown)
	if !strings.HasSuffix(markdown, "\n\n") {
		b.WriteString("\n")
	}
	b.WriteString("## Persona runtime shadow replay\n\n")
	b.WriteString("Shadow replay sends the same candidate evidence to the configured persona runtime. It does not post Slack replies.\n\n")
	b.WriteString("| Source | Channel | Thread | Classification | Runtime | Decision | Latency | Result |\n")
	b.WriteString("|---|---|---|---|---|---|---:|---|\n")
	for _, result := range results {
		outcome := "ok"
		if !result.Success {
			outcome = "error: " + result.Error
		} else if result.Reason != "" {
			outcome = result.Reason
		}
		_, _ = fmt.Fprintf(&b,
			"| `%s` | `%s` | `%s` | `%s` | `%s` | `%s` | %dms | %s |\n",
			result.Source,
			result.ChannelID,
			result.ThreadTS,
			result.Classification,
			result.Runtime,
			result.Decision,
			result.LatencyMS,
			strings.ReplaceAll(outcome, "|", "\\|"),
		)
	}
	return b.String()
}

func appendLearningSignalsSection(markdown string, signals []slackagent.SlackLearningSignal) string {
	if len(signals) == 0 {
		return markdown
	}
	var b strings.Builder
	b.WriteString(markdown)
	if !strings.HasSuffix(markdown, "\n\n") {
		b.WriteString("\n")
	}
	b.WriteString("## Learning signals captured\n\n")
	b.WriteString("Replay/judge failures are recorded as reviewable learning inputs; nothing is promoted automatically.\n\n")
	b.WriteString("| Source | Subject | Verdict | Reason | Refs |\n")
	b.WriteString("|---|---|---|---|---|\n")
	for _, signal := range signals {
		refs := "—"
		if len(signal.Refs) > 0 {
			refs = strings.Join(signal.Refs, ", ")
		}
		_, _ = fmt.Fprintf(&b,
			"| `%s` | `%s` | `%s` | `%s` | %s |\n",
			escapeMarkdownCell(signal.Source),
			escapeMarkdownCell(signal.Subject),
			escapeMarkdownCell(signal.Verdict),
			escapeMarkdownCell(signal.ReasonCode),
			escapeMarkdownCell(refs),
		)
	}
	return b.String()
}

// classifyAll groups messages by (channel, thread root), feeds each
// group to slackagent.ClassifyBackfillMessage, and returns the
// candidates in input order. Grouping is needed because the
// classifier wants to see the originator + its replies to decide
// whether a human already caught the message.
func classifyAll(messages []slackagent.SlackInboundMessage, botUserIDs []string) []slackagent.SlackBackfillCandidate {
	roots, repliesByRoot := groupByThreadRoot(messages)
	out := make([]slackagent.SlackBackfillCandidate, 0, len(roots))
	for _, root := range roots {
		replies := repliesByRoot[rootKey(root)]
		candidate, ok := slackagent.ClassifyBackfillMessage(root, replies, botUserIDs)
		if !ok {
			continue
		}
		out = append(out, candidate)
	}
	return out
}

func groupByThreadRoot(messages []slackagent.SlackInboundMessage) ([]slackagent.SlackInboundMessage, map[string][]slackagent.SlackInboundMessage) {
	roots := make([]slackagent.SlackInboundMessage, 0)
	repliesByRoot := make(map[string][]slackagent.SlackInboundMessage)
	for _, m := range messages {
		thread := strings.TrimSpace(firstNonEmpty(m.ThreadTS, m.ThreadTSSnake))
		if thread == "" || thread == strings.TrimSpace(m.TS) {
			roots = append(roots, m)
			continue
		}
		key := m.ChannelID + ":" + thread
		repliesByRoot[key] = append(repliesByRoot[key], m)
	}
	return roots, repliesByRoot
}

func rootKey(root slackagent.SlackInboundMessage) string {
	return root.ChannelID + ":" + strings.TrimSpace(firstNonEmpty(root.ThreadTS, root.ThreadTSSnake, root.TS))
}

func readMessages(stdin io.Reader) ([]slackagent.SlackInboundMessage, error) {
	scanner := bufio.NewScanner(stdin)
	// Slack messages can be longer than the default 64KB buffer when
	// transcripts include long quoted blocks; bump to 1MB so we
	// don't silently truncate.
	scanner.Buffer(make([]byte, 0, 1024*1024), 1024*1024)
	var out []slackagent.SlackInboundMessage
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var m slackagent.SlackInboundMessage
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNo, err)
		}
		// Slack exports / fixtures freely mix `channel_id` and
		// `channelId`; normalize once at read time so downstream
		// grouping and classification see a single canonical shape.
		out = append(out, slackagent.NormalizeSlackInboundMessage(m))
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func openOutput(path string, stdout io.Writer) (io.Writer, func(), error) {
	if path == "" || path == "-" {
		return stdout, func() {}, nil
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, nil, err
	}
	return f, func() { _ = f.Close() }, nil
}

func describeOutput(path string) string {
	if strings.TrimSpace(path) == "" || path == "-" {
		return "stdout"
	}
	return path
}

func escapeMarkdownCell(value string) string {
	value = strings.ReplaceAll(value, "|", "\\|")
	value = strings.ReplaceAll(value, "\n", " ")
	return value
}

func splitCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func maxInt(a int, b int) int {
	if a > b {
		return a
	}
	return b
}

func maxDuration(a time.Duration, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}
