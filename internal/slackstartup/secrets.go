package slackstartup

import "os"

// SlackAgentProcessSecretNames mirrors cueboard cmd/slack-agentd/main.go.
var SlackAgentProcessSecretNames = []string{
	"SLACK_BOT_TOKEN",
	"SLACK_APP_TOKEN",
	"API_KEY",
	"LINEAR_API_KEY",
	"GOOGLE_ACCESS_TOKEN",
	"GOOGLE_REFRESH_TOKEN",
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
	"FIGMA_API_KEY",
	"NOTION_TOKEN",
	"MEET_WEBHOOK_SECRET",
}

func ScrubProcessSecrets() {
	for _, name := range SlackAgentProcessSecretNames {
		_ = os.Unsetenv(name)
	}
}
