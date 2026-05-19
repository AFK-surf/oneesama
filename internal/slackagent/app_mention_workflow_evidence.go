package slackagent

import (
	"regexp"
	"sort"
	"strings"
)

var slackWorkflowMentionPattern = regexp.MustCompile(`<@[A-Z0-9]+>`)

func collectAppMentionWorkflowEvidence(mention *SlackAppMentionContext) (SlackAppMentionToolEvidence, bool) {
	if mention == nil {
		return SlackAppMentionToolEvidence{}, false
	}
	text := appMentionWorkflowText(mention)
	urls := appMentionWorkflowURLs(mention, text)
	signals := appMentionWorkflowSignals(text, urls)
	if len(signals) == 0 {
		return SlackAppMentionToolEvidence{}, false
	}
	summary := renderAppMentionWorkflowEvidenceSummary(text, urls, signals)
	if strings.TrimSpace(summary) == "" {
		return SlackAppMentionToolEvidence{}, false
	}
	return SlackAppMentionToolEvidence{
		Tool: "slack_workflow_context",
		Args: map[string]any{
			"workflow_request": "true",
			"signals":          strings.Join(signals, ","),
			"urls":             len(urls),
		},
		OK:      true,
		Summary: summary,
	}, true
}

func appMentionWorkflowText(mention *SlackAppMentionContext) string {
	if mention == nil {
		return ""
	}
	return strings.TrimSpace(strings.Join([]string{
		stripSlackBotMentions(mention.MentionText),
		stripSlackBotMentions(mention.RawMentionText),
		mention.Transcript,
		formatSlackExternalLinkContexts(mention.ExternalLinks),
	}, "\n"))
}

func appMentionWorkflowURLs(mention *SlackAppMentionContext, text string) []string {
	seen := map[string]struct{}{}
	var urls []string
	for _, link := range mention.ExternalLinks {
		rawURL := strings.TrimSpace(link.URL)
		if rawURL == "" {
			continue
		}
		if _, ok := seen[rawURL]; ok {
			continue
		}
		seen[rawURL] = struct{}{}
		urls = append(urls, rawURL)
	}
	for _, rawURL := range extractSlackExternalLinkURLs([]SlackInboundMessage{{Text: text}}) {
		if _, ok := seen[rawURL]; ok {
			continue
		}
		seen[rawURL] = struct{}{}
		urls = append(urls, rawURL)
	}
	return urls
}

func appMentionWorkflowSignals(text string, urls []string) []string {
	normalized := strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(text)), " "))
	if normalized == "" {
		return nil
	}
	var signals []string
	if backfillMessageLooksLikeOperationalGitHubWork(text, urls) {
		signals = append(signals, "operational_github_work")
	}
	if containsAnyWorkflowMarker(normalized, []string{"review", "approve", "merge", "deploy", "ci", "build", "test", "pull request", "cherry-pick", "cherry pick", "preprod", "来 review", "没问题就 approve", "合并", "发版", "上线", "测一下", "看一下 pr", "看看 pr"}) &&
		(containsAnyWorkflowMarker(normalized, []string{"github", "/pull/", "/issues/", " pr ", "pull request", "issue", "linear", "cue-"}) || len(urls) > 0) {
		signals = append(signals, "review_or_delivery_request")
	}
	if containsAnyWorkflowMarker(normalized, []string{"task #", "任务", "开个 task", "建个 task", "linear", "cue-"}) &&
		containsAnyWorkflowMarker(normalized, []string{"推进", "跟进", "review", "approve", "done", "close", "resolve", "处理", "确认"}) {
		signals = append(signals, "task_workflow_request")
	}
	return compactUniqueStrings(signals)
}

func containsAnyWorkflowMarker(text string, markers []string) bool {
	for _, marker := range markers {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

func renderAppMentionWorkflowEvidenceSummary(text string, urls []string, signals []string) string {
	var lines []string
	lines = append(lines, "This looks like an operational product/workflow request, not a general link/article share.")
	if len(signals) > 0 {
		lines = append(lines, "Signals: "+strings.Join(signals, ", "))
	}
	if len(urls) > 0 {
		var operational []string
		for _, rawURL := range urls {
			if looksLikeOperationalGitHubURL(rawURL) {
				operational = append(operational, rawURL)
			}
		}
		if len(operational) > 0 {
			sort.Strings(operational)
			lines = append(lines, "Operational GitHub links: "+strings.Join(operational, ", "))
		}
	}
	if mentions := appMentionWorkflowSlackMentions(text); len(mentions) > 0 {
		lines = append(lines, "Addressed Slack users: "+strings.Join(mentions, " "))
	}
	lines = append(lines, "Expected handling: identify the requested owner/action/status; for PR/issue/code workflow, inspect the source repo or PR state before commenting. Do not summarize the link as reading material or evaluate it like an article. If safe workflow evidence is unavailable, say what is missing instead of inventing review/merge status.")
	return strings.Join(lines, "\n")
}

func appMentionWorkflowSlackMentions(text string) []string {
	matches := slackWorkflowMentionPattern.FindAllString(text, -1)
	if len(matches) == 0 {
		return nil
	}
	return compactUniqueStrings(matches)
}
