// Command oneesama-legacy-slack-memory-import imports old Slack Agent D
// workspace memory + sqlite triage runs into Oneesama's live workspace
// under `memory/legacy/slack-agent-d/` as line-citable Markdown.
//
// Why this exists:
//   - During the slack-agent-d → oneesama migration we needed to preserve
//     historical triage / channel-brain / feedback / lessons so the new
//     Memory provider could cite them via `legacy_triage_archive`,
//     `legacy_memory_file`, etc. (see relatedMemoryKindForPath).
//   - Default mode is dry-run; pass `--write` to actually create files.
//   - `--max-triage-runs` bounds how many sqlite triage_run rows get
//     rendered (default 200) to keep workspace size manageable.
//
// Reference: notes/cueboard-function-audit/ runs against the imported
// memory; the suppression filter for actionless legacy policy traces
// (relatedMemorySuppressesImportedPolicyTrace) is what keeps the imported
// content from polluting current Workspace policy.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/slackagent"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout io.Writer, stderr io.Writer) int {
	fs := flag.NewFlagSet("oneesama-legacy-slack-memory-import", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var sourceWorkspace string
	var sourceDB string
	var targetWorkspace string
	var write bool
	var maxTriageRuns int
	fs.StringVar(&sourceWorkspace, "source-workspace", "", "Old Slack Agent D workspace directory, e.g. ~/.bridge/slack-agent/workspace.")
	fs.StringVar(&sourceDB, "source-db", "", "Old Slack Agent D sqlite database path, e.g. ~/.bridge/slack-agent/slack.db.")
	fs.StringVar(&targetWorkspace, "target-workspace", "", "Oneesama live workspace directory to receive memory/legacy/slack-agent-d/*.md.")
	fs.BoolVar(&write, "write", false, "Actually write files. Omit for dry-run.")
	fs.IntVar(&maxTriageRuns, "max-triage-runs", 200, "Maximum legacy triage_run rows to render into Markdown.")
	fs.Usage = func() {
		fmt.Fprintf(stderr, "Usage: oneesama-legacy-slack-memory-import --source-workspace PATH --source-db PATH --target-workspace PATH [--write]\n\n")
		fmt.Fprintf(stderr, "Imports old Slack Agent D memory into Oneesama workspace memory as line-citable Markdown.\n")
		fmt.Fprintf(stderr, "Default mode is dry-run; pass --write to create/update memory/legacy/slack-agent-d files.\n\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	report, err := slackagent.ImportLegacySlackAgentDMemory(ctx, slackagent.LegacySlackMemoryImportOptions{
		SourceWorkspaceDir: sourceWorkspace,
		SourceDBPath:       sourceDB,
		TargetWorkspaceDir: targetWorkspace,
		Write:              write,
		MaxTriageRuns:      maxTriageRuns,
	})
	if err != nil {
		fmt.Fprintf(stderr, "oneesama-legacy-slack-memory-import: %v\n", err)
		return 1
	}
	printReport(stdout, report)
	if len(report.Warnings) > 0 {
		for _, warning := range report.Warnings {
			fmt.Fprintf(stderr, "warning: %s\n", warning)
		}
	}
	return 0
}

func printReport(w io.Writer, report slackagent.LegacySlackMemoryImportReport) {
	mode := "dry-run"
	if !report.DryRun {
		mode = "write"
	}
	fmt.Fprintf(w, "# Legacy Slack Agent D memory import report\n\n")
	fmt.Fprintf(w, "- Mode: %s\n", mode)
	fmt.Fprintf(w, "- Source workspace: %s\n", strings.TrimSpace(report.SourceWorkspaceDir))
	fmt.Fprintf(w, "- Source db: %s\n", strings.TrimSpace(report.SourceDBPath))
	fmt.Fprintf(w, "- Target workspace: %s\n", strings.TrimSpace(report.TargetWorkspaceDir))
	fmt.Fprintf(w, "- Workspace files scanned: %d\n", report.WorkspaceFilesScanned)
	fmt.Fprintf(w, "- Workspace files %s: %d\n", importVerb(report), report.WorkspaceFilesWritten)
	fmt.Fprintf(w, "- Triage archive files scanned: %d\n", report.TriageArchiveFilesScanned)
	fmt.Fprintf(w, "- Triage archive files %s: %d\n", importVerb(report), report.TriageArchiveFilesWritten)
	fmt.Fprintf(w, "- Database files %s: %d\n", importVerb(report), report.DatabaseFilesWritten)
	fmt.Fprintf(w, "- Channel brain rows: %d\n", report.ChannelBrainRows)
	fmt.Fprintf(w, "- Thread ledger rows: %d\n", report.ThreadLedgerRows)
	fmt.Fprintf(w, "- Feedback rows: %d\n", report.FeedbackRows)
	fmt.Fprintf(w, "- Triage run rows: %d\n", report.TriageRunRows)
	fmt.Fprintf(w, "- Warnings: %d\n", len(report.Warnings))
	if len(report.GeneratedFiles) == 0 {
		fmt.Fprintf(w, "\nNo files would be generated.\n")
		return
	}
	fmt.Fprintf(w, "\n## Generated files\n\n")
	for _, file := range report.GeneratedFiles {
		fmt.Fprintf(w, "- %s\n", file)
	}
}

func importVerb(report slackagent.LegacySlackMemoryImportReport) string {
	if report.DryRun {
		return "to generate"
	}
	return "written"
}
