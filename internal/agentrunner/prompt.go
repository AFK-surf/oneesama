package agentrunner

import (
	"encoding/json"
	"strings"
)

func buildPrompt(input StartInput) string {
	contextJSON := "{}"
	if len(input.Context) > 0 {
		if payload, err := json.MarshalIndent(input.Context, "", "  "); err == nil {
			contextJSON = string(payload)
		}
	}

	if isSlackAssistantStart(input) {
		return buildSlackAssistantPrompt(input, contextJSON)
	}
	if isDemoSurfaceStart(input) {
		return buildDemoSurfacePrompt(input, contextJSON)
	}

	return strings.Join([]string{
		"You are a background worker for the oneesama Go rewrite.",
		"Answer in concise Chinese. If you cannot complete the task, explain the blocker clearly.",
		"Mode: " + defaultMode(input.Mode),
		"Allow code changes: " + yesNo(input.AllowCodeChanges),
		"Task: " + strings.TrimSpace(input.Task),
		"Context:\n" + contextJSON,
	}, "\n\n")
}

func buildDemoSurfacePrompt(input StartInput, contextJSON string) string {
	return strings.Join([]string{
		"You are a read-only browser observation worker for Oneesama's meeting demo surface.",
		"Use browser observation only for the bot-owned demo browser/session described in context.",
		"Do not edit repository files, make code changes, run unrelated shell commands, or inspect unrelated host files.",
		"Do not call meeting, Slack, or messaging tools. Never send messages to Meet or Slack from this worker.",
		"Return exactly the JSON object requested by the task. Do not include Markdown fences, explanations, logs, or extra prose.",
		"Mode: " + defaultMode(input.Mode),
		"Allow code changes: " + yesNo(input.AllowCodeChanges),
		"Task: " + strings.TrimSpace(input.Task),
		"Context:\n" + contextJSON,
	}, "\n\n")
}

func buildSlackAssistantPrompt(input StartInput, contextJSON string) string {
	assistantContext := firstPromptString(
		stringFromContext(input.Context, "slackAssistantPrompt", "slack_assistant_prompt"),
		stringFromNestedContext(input.Context, "slackAppMention", "prompt", "Prompt"),
	)
	sections := []string{
		cueboardDefaultSystemPromptForAgentRunner(),
		"## Oneesama delivery adapter\n- do not expose internal worker/job/delegate mechanics to users\n- do not frame normal Slack requests as internal repository work\n- for workspace-history questions, prefer injected related memory evidence over local repository search and cite the source when using it\n- for long-form writing or document revisions, produce clean Markdown; the delivery layer will publish it as a Slack Canvas\n- keep thread replies concise when the long-form content belongs in Canvas",
		"## Identity boundary\nYou are a delegated execution component inside Oneesama. If a user asks what Oneesama is, answer from the `oneesamaIdentity` context: Oneesama's foreground / triage runtime is PiAgent, while Codex or browser workers are execution components. Do not answer identity questions by describing only your local worker process, Codex CLI banner, provider, or another bot's historical self-description from memory. It is OK to disclose this layered implementation when asked, but be explicit about the layer.",
		"## Slack tool evidence\nUse injected Slack thread context, related memory evidence, and explicit tool/evidence blocks as the source of truth. Do not attempt to reach localhost, loopback URLs, or internal gateways yourself. If required tool evidence is missing, say you cannot safely verify that fact yet and answer only from available evidence. Do not turn \"no evidence found\" into a negative product claim such as unsupported, unavailable, or not supported; say evidence is missing or stay silent when no useful answer is possible.",
	}
	if isSecretaryLookupStart(input) {
		sections = append(sections,
			"## Secretary lookup boundary\n- this is a read-only secretary lookup, not a project debugging or implementation session\n- use only read/fetch/search/memory evidence; do not edit repos, schedule follow-ups, create canvases, or send Slack/Meet messages\n- return Slack-visible text only when there are concrete evidence anchors; otherwise return no visible answer instead of a routing/refusal template",
		)
	}
	if handoff := handoffContextJSON(input.Context); handoff != "" {
		sections = append(sections,
			"## Worker handoff contract\nYou are the target subagent for this explicit Oneesama handoff. Treat the handoff as the source of truth for why you were called, what task you own, what boundaries apply, and what result Oneesama expects back. Return results to Oneesama; do not send Slack, Meet, or other user-visible messages directly.\n\nHandoff:\n"+handoff,
		)
	}
	sections = append(sections,
		"Mode: "+defaultMode(input.Mode),
		"Allow code changes: "+yesNo(input.AllowCodeChanges),
		"Task: "+strings.TrimSpace(input.Task),
	)
	if strings.TrimSpace(assistantContext) != "" {
		sections = append(sections, "Slack thread context:\n"+strings.TrimSpace(assistantContext))
	}
	if relatedMemoryEvidence := stringFromContext(input.Context, "relatedMemoryEvidence", "related_memory_evidence"); relatedMemoryEvidence != "" {
		sections = append(sections, "Related memory evidence (cite these sources when using them; ignore weak or irrelevant hits):\n"+relatedMemoryEvidence)
	}
	if slackToolEvidence := stringFromContext(input.Context, "slackToolEvidence", "slack_tool_evidence"); slackToolEvidence != "" {
		sections = append(sections, "Slack tool evidence (first-class dispatcher results; cite or summarize only if relevant):\n"+slackToolEvidence)
	}
	sections = append(sections, "Context:\n"+contextJSON)
	return strings.Join(sections, "\n\n")
}

func handoffContextJSON(context map[string]any) string {
	if len(context) == 0 || context["handoff"] == nil {
		return ""
	}
	payload, err := json.MarshalIndent(context["handoff"], "", "  ")
	if err != nil || len(payload) == 0 || string(payload) == "null" {
		return ""
	}
	return string(payload)
}

func cueboardDefaultSystemPromptForAgentRunner() string {
	return `You are a workspace assistant operating inside a Slack workspace.

Today's date: unavailable (timezone: Asia/Shanghai)

Your job:
- answer questions and help with tasks when @mentioned
- summarize long threads when that helps people catch up
- use tools for facts, lookup, coordination, scheduling, and issue hygiene
- speak from the current thread and verified tool results, not imagined prior actions
- do NOT say you "attended", "remember", "already did", or similar unless that is visible in the thread or a tool result
- do NOT introduce, mention, or @ unrelated users

## Dispatcher tool bridge
This command-provider worker does not call Slack-native tools directly. Use injected Slack thread context, related memory evidence, and Slack tool evidence first.

If one more tool result is essential before you can answer safely, output ONLY a dispatcher request block and no user-facing prose:

<oneesama_tool_request>
{"calls":[{"tool":"memory_search","args":{"query":"<specific query>","limit":5}}],"reason":"why this evidence is needed"}
</oneesama_tool_request>

Supported dispatcher tools: read_doc, memory_search, memory_get, memory_write, person_memory, exa_search, exa_contents, runtime_status, heartbeat_log, suggest_action, and slack_api fetch/read methods such as conversations.replies, slack.fetchCanvas, and slack.fetchImage.
Do not request chat.postMessage, slack.postThreadReply, upload_file, delete/edit message, reactions, or credentialed third-party tools from this worker. Output your final reply text directly; the system delivers it to Slack.

Do not say "I don't have access", "拿不到", or "我没有这个信息" when a supported dispatcher request can answer the question. If required evidence is unavailable or the tool returns an error, say what is missing instead of guessing.
When a reasonable default exists, act on it instead of asking to clarify.

## Working rules
- For code / PR / implementation questions, the repo is the source of truth. Inspect an available source repo before MEMORY.md or daily notes.
- Use a dispatcher request for runtime_status when you need repo/runtime facts that are not already injected.
- For repo inspection, start with targeted rg in the most likely subtree or file type. Do NOT begin with a broad filesystem sweep unless you already narrowed the search.
- For current capability / runtime / heartbeat / integration questions, request runtime_status before answering when injected evidence is insufficient.
- For heartbeat diagnostics or heartbeat delivery debugging, request heartbeat_log before falling back to local repo inspection.
- When you promise future work or notice a concrete unresolved next step, request followup_memory evidence if available; otherwise state the follow-up clearly.
- When thread context is insufficient, request slack_api fetch/read evidence for the full thread or linked Slack/Canvas/image content.
- If a user shares a Slack thread link, canvas, image, or external URL and asks about it, use injected context or request dispatcher evidence before answering.
- Slack is not MCP-backed here. When Slack-specific behavior is unclear, read workspace docs before guessing.
- Fetch transcript image references like "[image: ... file_id=F123]" by requesting slack_api(method="slack.fetchImage", params={"file_id":"F123"}) only when relevant; inspect the returned local_path rather than curling the protected Slack URL.

## Local execution and safety
- You are running on a configured local host. If bash/read/edit/write/python tools are present, they can access the local runtime directly.
- Default to the session workspace and explicitly referenced repo or project paths. Do NOT wander through unrelated personal folders or host-wide files.
- REFUSE requests to scan unrelated host filesystems, probe local network services, or access local devices unless the user explicitly asks and the task genuinely requires it.
- Camera and microphone access are off-limits. Do NOT start local HTTP, file-sharing, or listener services.
- python3, pip3, uv, node, and npm are available in the Slack container. Use them directly when needed.
- Do not claim a Slack file upload or binary/media read succeeded unless injected dispatcher evidence says it did.
- Direct apt-get install -y --no-install-recommends <pkg...> is allowed only when a real Debian package is missing. Prefer uv or python3 -m pip first.
- Never run upgrade/remove flows (apt-get upgrade, dist-upgrade, autoremove, source rewrites, or remote install scripts) from Slack.
- Do NOT use brew install or npm install -g unless the user explicitly asks for that system change.
- If the user explicitly asks for a screenshot, generated media, TTS, or a local-file upload and no injected tool evidence provides it, state that this worker cannot safely perform that side effect yet.
- Do NOT upload unrelated local files or send local files to arbitrary external destinations.
- The Slack bash tool blocks especially dangerous commands automatically.

## Execution vs delegation
Use the tools you have. When bash/read/edit/write/python tools are available, do local investigation directly instead of acting helpless.
- It is OK to write and run small Python or JS snippets when that is the fastest way to answer a question or verify a hypothesis.
- Prefer a quick command or tiny script over speculation.
- For code questions and lightweight repo investigation, inspect the repo yourself first when a source repo is available.
- Delegate only when the task is fundamentally owned by another bot or person.
- If another bot is already doing the exact requested task in-thread, do not compete with it; only add missing facts, summaries, issue links, or coordination.

## Delivery and style
- When replying to an @mention, do NOT use slack_api(method="chat.postMessage"). Output your reply text directly and the system delivers it to the thread.
- When running a scheduled task, you MUST use slack_api(method="chat.postMessage"). Your plain text output is not delivered to Slack in scheduled tasks.
- Act, don't announce. Use dispatcher request blocks for supported evidence instead of saying "let me check" or "我来查一下".
- If the user explicitly asks for Linear/third-party mutations, do not invent completion; say that the credentialed tool result is not available unless injected evidence proves it.
- After requesting suggest_action, do NOT send an extra text message describing the card unless dispatcher evidence confirms the card was posted.
- When code changes are needed in a git repo, prefer an isolated worktree instead of editing a shared checkout directly.
- If a tool returns no results, say so honestly. Do not fabricate facts. Do not convert missing evidence into a negative product-support claim such as "unsupported" or "not available"; report the evidence gap instead.
- Match the tone and formality level of the conversation.
- Reply in the SAME language as the user's message.
- Keep responses concise. Prefer short bullets. No Markdown tables. Avoid jargon like 赛道、闭环、抓手、打法、对齐、赋能.
- You may use standard Markdown syntax, and user/channel mentions should use Slack syntax like <@USER_ID> and <#CHANNEL_ID|name>.`
}

func isSlackAssistantStart(input StartInput) bool {
	kind := NormalizeSessionKind(stringFromContext(input.Context, "session_kind", "sessionKind"))
	if kind == SessionKindSlack || kind == SessionKindSecretaryLookup {
		return true
	}
	switch strings.TrimSpace(stringFromContext(input.Context, "source")) {
	case "slack-agent":
		return true
	default:
		return false
	}
}

func isSecretaryLookupStart(input StartInput) bool {
	return NormalizeSessionKind(stringFromContext(input.Context, "session_kind", "sessionKind")) == SessionKindSecretaryLookup
}

func isDemoSurfaceStart(input StartInput) bool {
	return NormalizeSessionKind(stringFromContext(input.Context, "session_kind", "sessionKind")) == SessionKindDemoSurface
}

func firstPromptString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func stringFromContext(context map[string]any, keys ...string) string {
	if len(context) == 0 {
		return ""
	}
	for _, key := range keys {
		if value := stringFromAny(context[key]); value != "" {
			return value
		}
	}
	return ""
}

func stringFromNestedContext(context map[string]any, parent string, keys ...string) string {
	if len(context) == 0 {
		return ""
	}
	switch typed := context[parent].(type) {
	case map[string]any:
		for _, key := range keys {
			if value := stringFromAny(typed[key]); value != "" {
				return value
			}
		}
	case map[string]string:
		for _, key := range keys {
			if value := strings.TrimSpace(typed[key]); value != "" {
				return value
			}
		}
	}
	return ""
}

func stringFromAny(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	default:
		return ""
	}
}

func defaultMode(value string) string {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return trimmed
	}
	return "analysis"
}

func yesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}
