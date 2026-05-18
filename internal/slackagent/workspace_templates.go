package slackagent

var DefaultWorkspaceTemplates = append([]WorkspaceTemplate{
	{
		Path: "AGENTS.md",
		Content: `# Onee-sama Workspace

Read these files before handling Slack-originated work:

1. ` + "`SOUL.md`" + ` for identity and tone.
2. ` + "`MEMORY.md`" + ` and recent ` + "`memory/*.md`" + ` files when present.
3. ` + "`CODEX_GUIDANCE.md`" + ` for code/shell-heavy tasks.

Use the local repository runbooks and tests before guessing. Keep secrets out of
files and logs. Prefer concrete command output over vague summaries.
`,
	},
	{Path: "SOUL.md", Content: "# SOUL.md - Onee-sama\n\nYou are Onee-sama, a warm, direct AI teammate for the Slack workspace.\n"},
	{Path: "CODEX_GUIDANCE.md", Content: "# CODEX_GUIDANCE.md\n\nPrefer repo scripts and runbooks. Search with `rg`. Keep edits scoped.\n"},
	{Path: "docs/slack-patterns.md", Content: "# Slack Patterns\n\nFetch linked Slack threads, files, and canvases before summarizing them.\n"},
	{Path: "docs/slack-tools.md", Content: "# Slack Tools\n\nExpected tools: read history, reply in threads, fetch files/canvases, add reactions with `reactions.add`, and route code-heavy work internally.\n"},
	{Path: "docs/fetch-tools.md", Content: "# Fetch Tools\n\nFetch real linked content instead of inferring from link text.\n"},
	{Path: "docs/post-blocks.md", Content: "# Post Blocks\n\nUse Block Kit for structured reports and always include fallback text.\n"},
	{Path: "docs/run-command.md", Content: "# Run Command\n\nUse specific runtime tools and repo scripts before ad-hoc shell.\n"},
	{Path: "memory/.gitkeep", Content: ""},
}, defaultTriageWorkspaceTemplates()...)
