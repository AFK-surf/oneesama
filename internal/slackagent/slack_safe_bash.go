package slackagent

import (
	"fmt"
	"regexp"
	"strings"
)

type slackBashBlockRule struct {
	name string
	re   *regexp.Regexp
	help string
}

var slackBashBlockRules = []slackBashBlockRule{
	{
		name: "privilege escalation",
		re:   regexp.MustCompile(`(?i)(^|[\s;&|()])sudo(\s|$)`),
		help: "Stay in the current user context. If a privileged step is truly required, the user should run it manually.",
	},
	{
		name: "system power control",
		re:   regexp.MustCompile(`(?i)\b(shutdown|reboot|halt|poweroff)\b|launchctl\s+reboot`),
		help: "Do not power off or reboot the user's machine from Slack.",
	},
	{
		name: "disk erase / format",
		re:   regexp.MustCompile(`(?i)\b(diskutil\s+(eraseDisk|partitionDisk|apfs\s+deleteContainer)|mkfs(?:\.\w+)?|newfs|fdisk)\b|\bdd\b[^\n]*\bof=/dev/`),
		help: "Disk erase, repartition, and raw device writes are blocked from Slack.",
	},
	{
		name: "destructive git cleanup",
		re:   regexp.MustCompile(`(?i)\bgit\s+reset\s+--hard\b|\bgit\s+checkout\s+--\b|\bgit\s+clean\b[^\n]*-(?:[^\s\n]*f[^\s\n]*d|[^\s\n]*d[^\s\n]*f)[^\n]*`),
		help: "Use git status, git diff, targeted restores, or an isolated git worktree instead of destructive cleanup.",
	},
	{
		name: "broad rm -rf target",
		re: regexp.MustCompile(
			`(?i)(^|[;&|\n])\s*rm\s+-[^\n]*r[^\n]*f[^\n]*\s+(?:/($|\s)|/\*($|\s)|~($|\s)|~/($|\s)|~/\*($|\s)|\$HOME($|\s)|\$HOME/($|\s)|\$HOME/\*($|\s)|\.\.($|\s)|\.($|\s))`,
		),
		help: "Use targeted file/path deletion only. Never wipe root, home, or the current repo/worktree root from Slack.",
	},
	{
		name: "remote script piping",
		re: regexp.MustCompile(
			`(?i)\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|zsh)\b|\b(?:sh|bash|zsh)\s*<\s*\([^)]*\b(?:curl|wget)\b`,
		),
		help: "Download scripts explicitly, inspect them first, and only then run a reviewed local file if needed.",
	},
	{
		name: "local listener / file server",
		re: regexp.MustCompile(
			`(?i)\bpython(?:3)?\s+-m\s+(?:http\.server|simplehttpserver)\b|\bnc\b[^\n]*\s-l\b|\bsocat\b[^\n]*LISTEN\b|\buvicorn\b[^\n]*--host\s+(?:0\.0\.0\.0|::)\b`,
		),
		help: "Do not start local HTTP servers, TCP listeners, or similar host services from Slack.",
	},
}

func validateSlackBashCommand(command string) error {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil
	}
	for _, rule := range slackBashBlockRules {
		if rule.re.MatchString(command) {
			return fmt.Errorf("blocked dangerous bash command: %s. %s", rule.name, rule.help)
		}
	}
	return nil
}
