package slackagent

import "github.com/AFK-surf/oneesama/internal/agentrunner"

const (
	dailyNoteCompactSizeThreshold    = 4096
	dailyNoteCompactHeadingThreshold = 10
	dailyNoteCompactSessionKind      = "memory_compact"
)

type SlackScannerCompactRequest struct {
	WorkspaceDir    string `json:"workspace_dir"`
	WorkspaceDirAlt string `json:"workspaceDir"`
	Date            string `json:"date"`
	Run             any    `json:"run"`
}

type SlackScannerCompactResult struct {
	OK           bool             `json:"ok"`
	Eligible     bool             `json:"eligible"`
	Skipped      bool             `json:"skipped,omitempty"`
	Reason       string           `json:"reason,omitempty"`
	Error        string           `json:"error,omitempty"`
	Date         string           `json:"date,omitempty"`
	Path         string           `json:"path,omitempty"`
	SizeBytes    int              `json:"sizeBytes,omitempty"`
	HeadingCount int              `json:"headingCount,omitempty"`
	Hash         string           `json:"hash,omitempty"`
	SessionKind  string           `json:"sessionKind,omitempty"`
	Prompt       string           `json:"prompt,omitempty"`
	Job          *agentrunner.Job `json:"job,omitempty"`
}
