package slackagent

import "context"

type WorkspaceBootstrapInput struct {
	WorkspaceDir string
}

type RuntimeValidationInput struct {
	MeetingAgentURL    string
	WebhookListen      string
	RequireSlackTokens bool
}

type RuntimeValidationResult struct {
	OK     bool                 `json:"ok"`
	Checks []RuntimeProbeResult `json:"checks"`
}

func (s *Service) BootstrapWorkspace(input WorkspaceBootstrapInput) WorkspaceBootstrapResult {
	return EnsureWorkspaceFiles(EnsureWorkspaceFilesOptions{
		WorkspaceDir: firstNonEmpty(input.WorkspaceDir, s.workspaceDir),
	})
}

func (s *Service) ValidateRuntime(ctx context.Context, input RuntimeValidationInput) RuntimeValidationResult {
	checks := []RuntimeProbeResult{
		probeMeetingAgentHealth(ctx, firstNonEmpty(input.MeetingAgentURL, s.meetingAgentURL)),
		probeWebhookListen(firstNonEmpty(input.WebhookListen, "")),
	}

	checks = append(checks, RuntimeProbeResult{
		Name:                    "slack_tokens",
		OK:                      !input.RequireSlackTokens || (s.botToken != "" && s.appToken != "" && s.signingSecret != ""),
		BotTokenConfigured:      s.botToken != "",
		AppTokenConfigured:      s.appToken != "",
		SigningSecretConfigured: s.signingSecret != "",
		Required:                input.RequireSlackTokens,
	})

	result := RuntimeValidationResult{
		OK:     true,
		Checks: checks,
	}
	for _, check := range checks {
		if !check.OK {
			result.OK = false
			break
		}
	}
	return result
}
