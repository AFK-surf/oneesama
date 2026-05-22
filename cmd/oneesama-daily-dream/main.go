// Command oneesama-daily-dream builds review-gated Daily Dream memory and
// skill/policy candidates from learning-signal NDJSON. It defaults to dry-run
// stdout output: operators can inspect candidate clusters before any promotion
// path is added or scheduled.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/AFK-surf/oneesama/internal/slackagent"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	fs := flag.NewFlagSet("oneesama-daily-dream", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var (
		signalFile string
		outputPath string
		date       string
		minSignals int
	)
	fs.StringVar(&signalFile, "signal-file", "-", "LearningSignal NDJSON input path. Use '-' for stdin.")
	fs.StringVar(&outputPath, "output", "-", "Markdown output path. Use '-' for stdout. Default is dry-run stdout.")
	fs.StringVar(&date, "date", "", "Candidate date in YYYY-MM-DD. Defaults to Asia/Shanghai today.")
	fs.IntVar(&minSignals, "min-signals", 2, "Signals needed before a candidate is marked repeated_pattern instead of single_signal_low_confidence.")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	input, closeInput, err := openInput(signalFile, stdin)
	if err != nil {
		fmt.Fprintf(stderr, "open input: %v\n", err)
		return 1
	}
	if closeInput != nil {
		defer closeInput()
	}
	signals, err := slackagent.ReadSlackDreamSignalsNDJSON(input)
	if err != nil {
		fmt.Fprintf(stderr, "read signals: %v\n", err)
		return 1
	}
	candidates := slackagent.BuildSlackDreamCandidates(signals, slackagent.SlackDreamCandidateOptions{
		Date:                          date,
		MinSignalsForNormalConfidence: minSignals,
	})
	skillPolicyCandidates := slackagent.BuildSlackSkillPolicyCandidates(signals, slackagent.SlackSkillPolicyCandidateOptions{
		Date:                          date,
		MinSignalsForNormalConfidence: minSignals,
	})
	markdown := slackagent.RenderSlackDailyDreamMarkdown(candidates, skillPolicyCandidates)
	if err := writeOutput(outputPath, stdout, markdown); err != nil {
		fmt.Fprintf(stderr, "write output: %v\n", err)
		return 1
	}
	fmt.Fprintf(stderr, "daily dream dry-run: signals=%d candidates=%d skill_policy_candidates=%d output=%s\n", len(signals), len(candidates), len(skillPolicyCandidates), firstNonEmpty(strings.TrimSpace(outputPath), "-"))
	return 0
}

func openInput(path string, stdin io.Reader) (io.Reader, func(), error) {
	path = strings.TrimSpace(path)
	if path == "" || path == "-" {
		return stdin, nil, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	return file, func() { _ = file.Close() }, nil
}

func writeOutput(path string, stdout io.Writer, content string) error {
	path = strings.TrimSpace(path)
	if path == "" || path == "-" {
		_, err := io.WriteString(stdout, content)
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
