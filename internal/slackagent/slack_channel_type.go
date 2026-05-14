package slackagent

import "strings"

func normalizeObservedChannelType(value string) string {
	switch strings.TrimSpace(value) {
	case "", "channel", "public_channel":
		return "public_channel"
	case "group", "private_channel":
		return "private_channel"
	default:
		return strings.TrimSpace(value)
	}
}
