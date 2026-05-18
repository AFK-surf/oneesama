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
	fs := flag.NewFlagSet("oneesama-slock-workspace-import", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var sourceAgentsRoot string
	var targetWorkspace string
	var write bool
	var maxFileBytes int64
	fs.StringVar(&sourceAgentsRoot, "source-agents-root", "", "Slock agents root directory, e.g. ~/.slock/agents.")
	fs.StringVar(&targetWorkspace, "target-workspace", "", "Oneesama live workspace directory to receive memory/legacy/slock-d/*.md.")
	fs.BoolVar(&write, "write", false, "Actually write files. Omit for dry-run.")
	fs.Int64Var(&maxFileBytes, "max-file-bytes", 1024*1024, "Maximum bytes to import from each source Markdown file before truncation.")
	fs.Usage = func() {
		fmt.Fprintf(stderr, "Usage: oneesama-slock-workspace-import --source-agents-root PATH --target-workspace PATH [--write]\n\n")
		fmt.Fprintf(stderr, "Imports Slock D agent workspace knowledge into Oneesama workspace memory as line-citable Markdown.\n")
		fmt.Fprintf(stderr, "Default mode is dry-run; pass --write to create/update memory/legacy/slock-d files.\n\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	report, err := slackagent.ImportSlockWorkspaceMemory(ctx, slackagent.SlockWorkspaceImportOptions{
		SourceAgentsRoot:   sourceAgentsRoot,
		TargetWorkspaceDir: targetWorkspace,
		Write:              write,
		MaxFileBytes:       maxFileBytes,
	})
	if err != nil {
		fmt.Fprintf(stderr, "oneesama-slock-workspace-import: %v\n", err)
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

func printReport(w io.Writer, report slackagent.SlockWorkspaceImportReport) {
	mode := "dry-run"
	if !report.DryRun {
		mode = "write"
	}
	fmt.Fprintf(w, "# Slock D workspace import report\n\n")
	fmt.Fprintf(w, "- Mode: %s\n", mode)
	fmt.Fprintf(w, "- Source agents root: %s\n", strings.TrimSpace(report.SourceAgentsRoot))
	fmt.Fprintf(w, "- Target workspace: %s\n", strings.TrimSpace(report.TargetWorkspaceDir))
	fmt.Fprintf(w, "- Agents scanned: %d\n", report.AgentsScanned)
	fmt.Fprintf(w, "- Agents imported: %d\n", report.AgentsImported)
	fmt.Fprintf(w, "- Workspace files scanned: %d\n", report.FilesScanned)
	fmt.Fprintf(w, "- Workspace files %s: %d\n", importVerb(report), report.FilesWritten)
	fmt.Fprintf(w, "- Bytes %s: %d\n", bytesVerb(report), report.BytesWritten)
	fmt.Fprintf(w, "- Redacted lines: %d\n", report.RedactedLines)
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

func importVerb(report slackagent.SlockWorkspaceImportReport) string {
	if report.DryRun {
		return "to generate"
	}
	return "written"
}

func bytesVerb(report slackagent.SlockWorkspaceImportReport) string {
	if report.DryRun {
		return "to generate"
	}
	return "written"
}
