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
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/AFK-surf/oneesama/internal/slackagent"
)

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
	)
	fs.StringVar(&outputPath, "output", "", "Markdown report path. Use '-' or omit for stdout.")
	fs.StringVar(&botIDsFlag, "bot-user-ids", "", "Comma-separated Slack user ids for oneesama bots; messages from these users are excluded.")
	fs.BoolVar(&quiet, "quiet", false, "Suppress informational stderr summary (errors still print).")
	fs.Usage = func() {
		fmt.Fprintf(stderr, "Usage: oneesama-triage-replay [--output PATH] [--bot-user-ids U_BOT,U_OTHER] [--quiet]\n\n")
		fmt.Fprintf(stderr, "Reads NDJSON SlackInboundMessage objects from stdin and emits a\n")
		fmt.Fprintf(stderr, "Markdown report of candidate follow-up replies. Nothing is posted —\n")
		fmt.Fprintf(stderr, "this is a dry-run surface. Use it to review what oneesama would\n")
		fmt.Fprintf(stderr, "say before wiring a live --post path.\n\n")
		fmt.Fprintf(stderr, "Input format: one JSON object per line with at minimum `channelId`,\n")
		fmt.Fprintf(stderr, "`ts`, `user_id`, `text`. Replies belonging to a thread share the\n")
		fmt.Fprintf(stderr, "thread root via the `thread_ts` field.\n\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}

	botUserIDs := splitCSV(botIDsFlag)

	messages, err := readMessages(stdin)
	if err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-replay: read messages: %v\n", err)
		return 1
	}
	if len(messages) == 0 {
		fmt.Fprintf(stderr, "oneesama-triage-replay: input contained no SlackInboundMessage records\n")
		return 1
	}

	candidates := classifyAll(messages, botUserIDs)
	markdown := slackagent.RenderBackfillCandidatesMarkdown(candidates)

	dest, closeFn, err := openOutput(outputPath, stdout)
	if err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-replay: open output: %v\n", err)
		return 1
	}
	defer closeFn()
	if _, err := dest.Write([]byte(markdown)); err != nil {
		fmt.Fprintf(stderr, "oneesama-triage-replay: write output: %v\n", err)
		return 1
	}

	if !quiet {
		fmt.Fprintf(stderr,
			"oneesama-triage-replay: scanned %d message(s), produced %d candidate(s) → %s\n",
			len(messages), len(candidates), describeOutput(outputPath),
		)
	}
	return 0
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
		out = append(out, m)
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
