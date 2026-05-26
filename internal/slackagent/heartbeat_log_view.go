package slackagent

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func heartbeatLogPathCandidates() []string {
	var paths []string
	if explicit := strings.TrimSpace(os.Getenv("SLACK_AGENT_LOG_PATH")); explicit != "" {
		return []string{explicit}
	}
	if logDir := strings.TrimSpace(os.Getenv("LOG_DIR")); logDir != "" {
		paths = append(paths, filepath.Join(logDir, "slack-agentd.log"))
	}
	paths = append(paths,
		filepath.Join(os.TempDir(), "slack-agentd.log"),
		"/var/log/oneesama/slack-agentd.log",
		"/var/log/cue/slack-agentd.log",
	)
	return uniqueStrings(paths)
}

func loadHeartbeatLogTail(limit int) (string, []string, error) {
	if limit <= 0 {
		limit = 20
	}
	var firstErr error
	for _, path := range heartbeatLogPathCandidates() {
		lines, err := readHeartbeatLogFileTail(path, limit)
		if err == nil {
			return path, lines, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	candidates := heartbeatLogPathCandidates()
	if len(candidates) == 0 {
		return "", nil, fmt.Errorf("no heartbeat log path candidates")
	}
	return candidates[0], nil, firstErr
}

func readHeartbeatLogFileTail(path string, limit int) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()

	var lines []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !isHeartbeatLogSignal(line) {
			continue
		}
		lines = append(lines, line)
		if len(lines) > limit {
			lines = lines[1:]
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}

func isHeartbeatLogSignal(line string) bool {
	lower := strings.ToLower(line)
	return strings.Contains(lower, "framework heartbeat:") ||
		strings.Contains(lower, "slack: heartbeat")
}

func formatHeartbeatLogView(runtime *slackRuntimeStatusData, logPath string, logLines []string, logErr error, includeRawLogs bool) string {
	if runtime == nil {
		runtime = &slackRuntimeStatusData{}
	}
	lines := []string{
		fmt.Sprintf("Scope: %s", fallbackText(runtime.HeartbeatScopeLabel, "global")),
		fmt.Sprintf("Loop: %s", boolText(runtime.HeartbeatLoop, "running", "stopped")),
		fmt.Sprintf("Global pending follow-ups: %d", runtime.HeartbeatGlobalPendingCount),
		fmt.Sprintf("Visible pending follow-ups: %d", runtime.HeartbeatVisiblePendingCount),
	}
	switch {
	case runtime.HeartbeatLastResultHidden:
		lines = append(lines, "Last result: hidden outside this thread")
	case runtime.HeartbeatLastAt.IsZero():
		lines = append(lines, "Last result: none yet")
	default:
		lines = append(lines, "Last result: "+formatRuntimeTime(runtime.HeartbeatLastAt))
	}
	if !runtime.HeartbeatLastResultHidden {
		lines = append(lines,
			"Last status: "+heartbeatLastStatus(runtime),
			"Title: "+fallbackText(runtime.HeartbeatTitle, "none"),
			"Summary: "+fallbackText(runtime.HeartbeatSummary, "none"),
			"Notify delivery: "+heartbeatDeliveryLine(runtime),
		)
	}
	lines = append(lines, "Log path: "+fallbackText(logPath, runtime.HeartbeatLogPath, "unknown"))
	if recent := runtimeHeartbeatRecentSurfaceLines(runtime, 5); len(recent) > 0 {
		lines = append(lines, "Recent surfaces:")
		for _, line := range recent {
			lines = append(lines, "- "+line)
		}
	}
	if logErr != nil {
		lines = append(lines, "Log read error: "+logErr.Error())
	}
	if !includeRawLogs {
		lines = append(lines, "Recent heartbeat log lines: hidden outside the global runtime view")
		return strings.Join(lines, "\n")
	}
	if len(logLines) > 0 {
		lines = append(lines, "Recent heartbeat log lines:")
		for _, line := range logLines {
			if isHeartbeatLogSignal(line) {
				lines = append(lines, "- "+line)
			}
		}
	}
	return strings.Join(lines, "\n")
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	unique := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		unique = append(unique, value)
	}
	return unique
}
