package slackagent

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

type slackStatusDashboardSnapshot struct {
	Runtime         StatusResponse
	ConfigFile      string
	SecretsFile     string
	MeetConfigured  bool
	MeetHealthy     bool
	MeetURL         string
	MeetError       string
	MeetHealthCheck RuntimeProbeResult
}

func (s *Service) collectStatusDashboard(ctx context.Context) slackStatusDashboardSnapshot {
	meetCheck := probeMeetingAgentHealth(ctx, s.meetingAgentURL)
	return slackStatusDashboardSnapshot{
		Runtime:         s.Status(),
		ConfigFile:      baseNameOrEmpty(s.configFilePath),
		SecretsFile:     baseNameOrEmpty(s.secretsFilePath),
		MeetConfigured:  !meetCheck.Skipped,
		MeetHealthy:     meetCheck.OK && !meetCheck.Skipped,
		MeetURL:         strings.TrimRight(strings.TrimSpace(s.meetingAgentURL), "/"),
		MeetError:       firstNonEmpty(meetCheck.Error, meetCheck.Body, meetCheck.Reason),
		MeetHealthCheck: meetCheck,
	}
}

func renderStatusDashboardText(snapshot slackStatusDashboardSnapshot) string {
	var lines []string
	if snapshot.ConfigFile != "" || snapshot.SecretsFile != "" {
		lines = append(lines, fmt.Sprintf("config `%s` + secrets `%s`", firstNonEmpty(snapshot.ConfigFile, "unknown"), firstNonEmpty(snapshot.SecretsFile, "unknown")))
	}
	switch {
	case !snapshot.MeetConfigured:
		lines = append(lines, "Meet Agent: not configured")
	case snapshot.MeetHealthy:
		lines = append(lines, fmt.Sprintf("Meet Agent: healthy (`%s`)", snapshot.MeetURL))
	default:
		lines = append(lines, fmt.Sprintf("Meet Agent: unhealthy (`%s`): %s", snapshot.MeetURL, firstNonEmpty(snapshot.MeetError, "health probe failed")))
	}
	lines = append(lines,
		fmt.Sprintf("Slack poster: %s", snapshot.Runtime.Slack.PosterMode),
		fmt.Sprintf("Agent runner: %s", snapshot.Runtime.AgentRunner.Provider),
	)
	return strings.Join(lines, "\n")
}

func baseNameOrEmpty(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return ""
	}
	return filepath.Base(trimmed)
}
