package slackagent

import (
	"slices"
	"strings"
)

type ManifestValidationResult struct {
	OK           bool            `json:"ok"`
	Error        string          `json:"error,omitempty"`
	Checks       []ManifestCheck `json:"checks"`
	Warnings     []ManifestCheck `json:"warnings"`
	Blocking     []string        `json:"blocking,omitempty"`
	InstallSteps []string        `json:"install_steps,omitempty"`
}

type ManifestCheck struct {
	Name        string   `json:"name"`
	OK          bool     `json:"ok"`
	Missing     []string `json:"missing,omitempty"`
	Required    []string `json:"required,omitempty"`
	Recommended []string `json:"recommended,omitempty"`
	Expected    any      `json:"expected,omitempty"`
	Actual      any      `json:"actual,omitempty"`
	Hint        string   `json:"hint,omitempty"`
}

func (s *Service) ValidateManifest(manifest SlackManifest, requireRecommended bool) ManifestValidationResult {
	expected := s.BuildManifest()
	missingBotScopes := missingStrings(manifest.OAuthConfig.Scopes.Bot, requiredBotScopes)
	missingBotEvents := missingStrings(manifest.Settings.EventSubscriptions.BotEvents, requiredBotEvents)
	missingRecommendedBotScopes := missingStrings(manifest.OAuthConfig.Scopes.Bot, recommendedBotScopes)
	missingRecommendedUserScopes := missingStrings(manifest.OAuthConfig.Scopes.User, recommendedUserScopes)

	checks := []ManifestCheck{
		{Name: "bot_scopes", OK: len(missingBotScopes) == 0, Missing: missingBotScopes, Required: slices.Clone(requiredBotScopes)},
		{Name: "bot_events", OK: len(missingBotEvents) == 0, Missing: missingBotEvents, Required: slices.Clone(requiredBotEvents)},
		{Name: "app_home_messages_tab", OK: manifest.Features.AppHome.MessagesTabEnabled, Expected: true, Actual: manifest.Features.AppHome.MessagesTabEnabled, Hint: "Slack App Home Messages tab must be enabled before users can DM the bot from its app surface."},
		{Name: "app_home_messages_writable", OK: !manifest.Features.AppHome.MessagesTabReadOnlyEnable, Expected: false, Actual: manifest.Features.AppHome.MessagesTabReadOnlyEnable, Hint: "Messages tab must not be read-only."},
		{Name: "assistant_view", OK: manifest.Features.AssistantView.AssistantDescription != "", Hint: "Assistant view should be configured for Slack Assistant threads and suggested prompts."},
		{Name: "bot_user", OK: manifest.Features.BotUser.DisplayName != "", Hint: "Manifest needs a bot user display name."},
		{Name: "socket_mode", OK: manifest.Settings.SocketModeEnabled, Expected: true, Actual: manifest.Settings.SocketModeEnabled},
		{Name: "interactivity", OK: manifest.Settings.Interactivity.IsEnabled, Expected: true, Actual: manifest.Settings.Interactivity.IsEnabled},
		{Name: "request_urls", OK: manifest.Settings.EventSubscriptions.RequestURL == expected.Settings.EventSubscriptions.RequestURL && manifest.Settings.Interactivity.RequestURL == expected.Settings.Interactivity.RequestURL, Expected: []string{expected.Settings.EventSubscriptions.RequestURL, expected.Settings.Interactivity.RequestURL}, Actual: []string{manifest.Settings.EventSubscriptions.RequestURL, manifest.Settings.Interactivity.RequestURL}},
	}
	warnings := []ManifestCheck{
		{Name: "recommended_bot_scopes", OK: len(missingRecommendedBotScopes) == 0, Missing: missingRecommendedBotScopes, Recommended: slices.Clone(recommendedBotScopes)},
		{Name: "recommended_user_scopes", OK: len(missingRecommendedUserScopes) == 0, Missing: missingRecommendedUserScopes, Recommended: slices.Clone(recommendedUserScopes)},
	}

	blocking := make([]string, 0)
	for _, check := range checks {
		if !check.OK {
			blocking = append(blocking, check.Name)
		}
	}
	if requireRecommended {
		for _, warning := range warnings {
			if !warning.OK {
				blocking = append(blocking, warning.Name)
			}
		}
	}
	return ManifestValidationResult{
		OK:           len(blocking) == 0,
		Checks:       checks,
		Warnings:     warnings,
		Blocking:     blocking,
		InstallSteps: buildInstallSteps(checks),
	}
}

func missingStrings(actual []string, required []string) []string {
	actualSet := make(map[string]struct{}, len(actual))
	for _, value := range uniqSortedStrings(actual) {
		actualSet[value] = struct{}{}
	}
	missing := make([]string, 0)
	for _, value := range uniqSortedStrings(required) {
		if _, ok := actualSet[value]; !ok {
			missing = append(missing, value)
		}
	}
	return missing
}

func buildInstallSteps(checks []ManifestCheck) []string {
	steps := []string{
		"Apply or update the Slack app manifest.",
		"Save OAuth scopes and bot event subscriptions.",
		"Reinstall the app to the workspace after any scope/event/App Home change.",
		"Restart the Slack Agent only after local validation is green.",
	}
	for _, check := range checks {
		if check.OK {
			continue
		}
		detail := check.Hint
		if detail == "" && len(check.Missing) > 0 {
			detail = "missing: " + strings.Join(check.Missing, ", ")
		}
		if detail == "" {
			detail = "see expected/actual values"
		}
		steps = append(steps, "Fix "+check.Name+": "+detail)
	}
	return steps
}
