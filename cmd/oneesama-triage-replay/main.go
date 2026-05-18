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
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/slackagent"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

// mergePersistedState loads the runtime's persisted `delayed_no_reply`
// followups and folds them into the fresh candidate list using the
// (channel, thread, classification) dedupe key. Returns the new
// candidate list and the count of persisted records that were merged
// (for the stderr breadcrumb + Markdown footer).
//
// Failure to open the store is treated as non-fatal by the caller —
// we still surface fresh candidates instead of zero-output.
func mergePersistedState(
	candidates []slackagent.SlackBackfillCandidate,
	dataDir string,
	sqlitePath string,
	provider string,
) ([]slackagent.SlackBackfillCandidate, int, error) {
	cfg := appconfig.PersistenceConfig{
		Provider:   strings.TrimSpace(provider),
		DataDir:    strings.TrimSpace(dataDir),
		SQLitePath: strings.TrimSpace(sqlitePath),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	followups, err := slackagent.LoadDelayedNoReplyFollowups(ctx, cfg)
	if err != nil {
		return candidates, 0, err
	}
	if len(followups) == 0 {
		return candidates, 0, nil
	}
	merged := slackagent.MergePersistedDelayedNoReply(candidates, followups)
	return merged, len(followups), nil
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
	var persistenceProvider string
	fs.StringVar(&persistenceProvider, "persistence-provider", "", "Optional: persistence provider (e.g. 'json-file' or 'sqlite'). Defaults to runtime config default.")
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

	// Slice 3 piece A: optional persisted-state merge. Opt-in via
	// --persistence-dir; the CLI stays usable without runtime state
	// access (e.g. when running against a stale Slack export).
	persistenceAttempted := false
	if strings.TrimSpace(persistenceDir) != "" || strings.TrimSpace(persistenceSQLite) != "" {
		persistenceAttempted = true
		merged, _, mergeErr := mergePersistedState(
			candidates, persistenceDir, persistenceSQLite, persistenceProvider,
		)
		if mergeErr != nil {
			fmt.Fprintf(stderr, "oneesama-triage-replay: persisted state merge: %v\n", mergeErr)
			// Non-fatal: keep going with fresh candidates only.
		} else {
			candidates = merged
		}
	}

	markdown := slackagent.RenderBackfillCandidatesMarkdown(candidates)
	if liveMode {
		markdown = appendLiveStatsSection(markdown, liveStats)
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
		if fromPersisted > 0 {
			markdown += fmt.Sprintf("\n_Persisted state merged: %d candidate(s) carry FromPersistedState=true in the rendered report._\n", fromPersisted)
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
	}
	return 0
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
		b.WriteString(fmt.Sprintf(
			"| `%s` | %d | %d | %d | %v | %d | %s |\n",
			s.ChannelID, s.MessagesScanned, s.RepliesFetched, s.CandidatesFound, s.Truncated, s.APIRetries429, warnings,
		))
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
