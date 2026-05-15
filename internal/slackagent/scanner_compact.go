package slackagent

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

func (s *Service) CompactSlackDailyNotes(ctx context.Context, input SlackScannerCompactRequest) (SlackScannerCompactResult, error) {
	task := s.buildDailyNoteCompactionTask(input)
	if !task.OK || !task.Eligible {
		return task, nil
	}
	s.compactMu.Lock()
	if task.Hash != "" && task.Hash == s.lastScannerCompactionHash {
		s.compactMu.Unlock()
		task.Eligible = false
		task.Skipped = true
		task.Reason = "duplicate_hash"
		task.Prompt = ""
		return task, nil
	}
	if !boolFromAny(input.Run, false) {
		s.compactMu.Unlock()
		return task, nil
	}
	if s.runner == nil {
		s.compactMu.Unlock()
		return SlackScannerCompactResult{}, fmt.Errorf("agent runner is not ready: %s", runnerErrorText(s.runnerErr))
	}
	job, err := s.runner.StartTask(ctx, agentrunner.WithSessionCapabilities(agentrunner.StartInput{
		Task:             task.Prompt,
		Mode:             "analysis",
		AllowCodeChanges: false,
		Context: map[string]any{
			"kind":         task.SessionKind,
			"workspaceDir": firstNonEmpty(input.WorkspaceDir, input.WorkspaceDirAlt, s.workspaceDir),
			"date":         task.Date,
			"path":         task.Path,
			"hash":         task.Hash,
		},
	}, agentrunner.SessionKindCompact))
	if err != nil {
		s.compactMu.Unlock()
		return SlackScannerCompactResult{}, err
	}
	s.lastScannerCompactionHash = task.Hash
	s.compactMu.Unlock()
	task.Job = &job
	return task, nil
}

func (s *Service) maybeCompactDailyNotes(ctx context.Context) {
	result, err := s.CompactSlackDailyNotes(ctx, SlackScannerCompactRequest{Run: true})
	if err != nil {
		s.logger.Warn("slack scanner daily note compaction failed", "error", err)
		return
	}
	if result.Job != nil {
		s.logger.Info("slack scanner daily note compaction started", "date", result.Date, "job_id", result.Job.ID)
	}
}

func (s *Service) buildDailyNoteCompactionTask(input SlackScannerCompactRequest) SlackScannerCompactResult {
	root := strings.TrimSpace(firstNonEmpty(input.WorkspaceDir, input.WorkspaceDirAlt, s.workspaceDir))
	if root == "" {
		return SlackScannerCompactResult{OK: false, Eligible: false, Error: "workspace_dir_required"}
	}
	day := strings.TrimSpace(input.Date)
	if day == "" {
		day = timeNow().In(shanghaiLocation()).Format("2006-01-02")
	}
	path, err := dailyNotePath(root, day)
	if err != nil {
		return SlackScannerCompactResult{OK: false, Eligible: false, Error: err.Error(), Date: day}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return SlackScannerCompactResult{OK: true, Eligible: false, Reason: "daily_note_missing", Date: day, Path: path}
	}
	sizeBytes := len(raw)
	headingCount := countLinesWithPrefix(string(raw), "## ")
	eligible := sizeBytes >= dailyNoteCompactSizeThreshold && headingCount >= dailyNoteCompactHeadingThreshold
	result := SlackScannerCompactResult{
		OK:           true,
		Eligible:     eligible,
		Reason:       mapBool(eligible, "eligible", "below_threshold"),
		Date:         day,
		Path:         path,
		SizeBytes:    sizeBytes,
		HeadingCount: headingCount,
		Hash:         dailyNoteCompactHash(raw),
		SessionKind:  dailyNoteCompactSessionKind,
	}
	if eligible {
		result.Prompt = buildDailyNoteCompactionPrompt(day)
	}
	return result
}

func dailyNotePath(root string, day string) (string, error) {
	base, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	target := filepath.Join(base, "memory", day+".md")
	rel, err := filepath.Rel(base, target)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("daily note compaction path escapes root: %s", target)
	}
	return target, nil
}

func dailyNoteCompactHash(data []byte) string {
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%d:%x", len(data), sum[:8])
}

func countLinesWithPrefix(content string, prefix string) int {
	count := 0
	for _, line := range strings.Split(content, "\n") {
		if strings.HasPrefix(line, prefix) {
			count++
		}
	}
	return count
}

func shanghaiLocation() *time.Location {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.FixedZone("CST", 8*60*60)
	}
	return loc
}
