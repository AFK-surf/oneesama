package slackagent

import "strings"

func normalizedFetchThreadParams(params map[string]any) (string, string) {
	channel := strings.TrimSpace(stringFromContext(params, "channel"))
	threadTS := strings.TrimSpace(stringFromContext(params, "thread_ts"))
	if threadTS == "" {
		threadTS = strings.TrimSpace(stringFromContext(params, "ts"))
	}
	return channel, threadTS
}
