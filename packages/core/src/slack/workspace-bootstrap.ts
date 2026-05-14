import net from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

function text(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function assertInside(rootDir, filePath) {
  const root = resolve(rootDir);
  const target = resolve(filePath);
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`) && rel !== ".."))
    return target;
  throw new Error(`workspace template path escapes root: ${filePath}`);
}

export const SLACK_WORKSPACE_TEMPLATE_FILES = [
  {
    path: "AGENTS.md",
    content: `# Onee-sama Workspace

Read these files before handling Slack-originated work:

1. \`SOUL.md\` for identity and tone.
2. \`MEMORY.md\` and recent \`memory/*.md\` files when present.
3. \`CODEX_GUIDANCE.md\` for code/shell-heavy tasks.

Use the local repository runbooks and tests before guessing. Keep secrets out of
files and logs. Prefer concrete command output over vague summaries.
`,
  },
  {
    path: "SOUL.md",
    content: `# SOUL.md — Onee-sama

You are Onee-sama, a warm, direct AI teammate for the Slack workspace.

- Default to concise, useful replies.
- Match the language of the message you are handling.
- Fetch thread/file/canvas context before answering questions about linked Slack content.
- Delegate code-heavy or multi-step implementation work to the configured Codex runner.
- Never fabricate missing context; say what you could not find.
`,
  },
  {
    path: "CODEX_GUIDANCE.md",
    content: `# CODEX_GUIDANCE.md

Use this guidance when Slack tasks become code, shell, or repo inspection work.

- Prefer repo-provided scripts and runbooks.
- Search with \`rg\` / \`rg --files\`.
- Read relevant files before editing them.
- Keep edits scoped and avoid destructive git commands.
- Report exact paths, commands, and verification results.
`,
  },
  {
    path: "docs/slack-patterns.md",
    content: `# Slack Patterns

## Slack thread links

Parse \`/archives/<channel>/p<timestamp>\`, convert the timestamp to
\`1234567890.123456\`, then fetch the thread before answering.

## Files and canvases

Fetch images/canvases before summarizing their contents.

## Delegation

When a request needs code edits, command execution, URL fetches, or multi-step
investigation, route it to the configured Codex runner instead of claiming the
bot cannot do it.
`,
  },
  {
    path: "docs/slack-tools.md",
    content: `# Slack Tools

Core workspace tools expected by Onee-sama:

- read thread/channel history
- post a thread reply or structured Block Kit message
- react/pin/update/delete bot-authored messages when permitted
- fetch files/images/canvases
- delegate code or shell-heavy work to Codex

Credentialed third-party proxies are optional adapters, not required for the
open-source baseline.
`,
  },
  {
    path: "docs/fetch-tools.md",
    content: `# Fetch Tools

Before answering about a linked Slack thread, file, image, canvas, or external
URL, fetch the actual content. Do not infer from the link text alone.
`,
  },
  {
    path: "docs/post-blocks.md",
    content: `# Post Blocks

Use Block Kit for structured reports. Always include fallback text. Avoid
interactive elements unless the action flow has explicit confirmation handling.
`,
  },
  {
    path: "docs/run-command.md",
    content: `# Run Command

Prefer specific runtime tools and repo scripts. Use shell commands for local
verification, diagnostics, and code work. Avoid dangerous or destructive
commands unless the human explicitly requested them.
`,
  },
  {
    path: "memory/.gitkeep",
    content: "",
  },
];

export interface SlackWorkspaceTemplate {
  path: string;
  content: string;
}

export interface EnsureSlackWorkspaceFilesOptions {
  workspaceDir?: string;
  templates?: SlackWorkspaceTemplate[];
}

export function ensureSlackWorkspaceFiles({
  workspaceDir,
  templates = SLACK_WORKSPACE_TEMPLATE_FILES,
}: EnsureSlackWorkspaceFilesOptions = {}) {
  const root = text(workspaceDir);
  if (!root) return { ok: false, error: "workspace_dir_required" };
  mkdirSync(root, { recursive: true });

  const created = [];
  const existing = [];
  for (const template of templates) {
    const relPath = text(template.path);
    if (!relPath) continue;
    const dest = assertInside(root, join(root, relPath));
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest)) {
      existing.push(relPath);
      continue;
    }
    writeFileSync(dest, String(template.content ?? ""), "utf8");
    created.push(relPath);
  }

  return {
    ok: true,
    workspaceDir: resolve(root),
    templateCount: templates.length,
    created,
    existing,
  };
}

export interface SlackRuntimeProbeResult {
  name: string;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  status?: number;
  url?: string;
  body?: string;
  listen?: string;
  bound?: unknown;
  error?: string;
  [key: string]: unknown;
}

type FetchLike = typeof fetch;

export interface ProbeMeetdHealthOptions {
  meetingAgentUrl?: string;
  fetchImpl?: FetchLike;
}

export async function probeMeetdHealth({
  meetingAgentUrl,
  fetchImpl = fetch,
}: ProbeMeetdHealthOptions = {}): Promise<SlackRuntimeProbeResult> {
  const baseUrl = text(meetingAgentUrl).replace(/\/+$/, "");
  if (!baseUrl)
    return { name: "meetd_health", ok: true, skipped: true, reason: "meeting_agent_url_empty" };
  try {
    const response = await fetchImpl(`${baseUrl}/health`);
    const bodyText = await response.text();
    return {
      name: "meetd_health",
      ok: response.ok,
      status: response.status,
      url: `${baseUrl}/health`,
      body: bodyText.slice(0, 512),
    };
  } catch (error) {
    const err = error as { message?: string };
    return {
      name: "meetd_health",
      ok: false,
      url: `${baseUrl}/health`,
      error: String(err?.message || error),
    };
  }
}

export interface ProbeWebhookListenOptions {
  webhookListen?: string;
}

export async function probeWebhookListen({
  webhookListen,
}: ProbeWebhookListenOptions = {}): Promise<SlackRuntimeProbeResult> {
  const raw = text(webhookListen);
  if (!raw)
    return { name: "webhook_listen", ok: true, skipped: true, reason: "webhook_listen_empty" };
  const [hostPart, portPart] = raw.includes(":") ? raw.split(/:(?=[^:]+$)/) : ["127.0.0.1", raw];
  const host = hostPart || "127.0.0.1";
  const port = Number.parseInt(portPart || "0", 10);
  if (Number.isNaN(port))
    return { name: "webhook_listen", ok: false, listen: raw, error: "invalid_port" };

  return await new Promise<SlackRuntimeProbeResult>((resolvePromise) => {
    const server = net.createServer();
    server.once("error", (error) => {
      const err = error as { message?: string };
      resolvePromise({
        name: "webhook_listen",
        ok: false,
        listen: raw,
        error: String(err?.message || error),
      });
    });
    server.listen(port, host, () => {
      const address = server.address();
      server.close(() => {
        resolvePromise({ name: "webhook_listen", ok: true, listen: raw, bound: address });
      });
    });
  });
}

export interface ValidateSlackAgentRuntimeOptions {
  meetingAgentUrl?: string;
  webhookListen?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  requireSlackTokens?: boolean;
  fetchImpl?: FetchLike;
}

export async function validateSlackAgentRuntime({
  meetingAgentUrl = "",
  webhookListen = "",
  slackBotToken = "",
  slackAppToken = "",
  slackSigningSecret = "",
  requireSlackTokens = false,
  fetchImpl = fetch,
}: ValidateSlackAgentRuntimeOptions = {}) {
  const checks: SlackRuntimeProbeResult[] = [
    await probeMeetdHealth({ meetingAgentUrl, fetchImpl }),
    await probeWebhookListen({ webhookListen }),
  ];

  const slackTokenCheck: SlackRuntimeProbeResult = {
    name: "slack_tokens",
    ok: !requireSlackTokens || Boolean(slackBotToken && slackAppToken && slackSigningSecret),
    bot_token_configured: Boolean(slackBotToken),
    app_token_configured: Boolean(slackAppToken),
    signing_secret_configured: Boolean(slackSigningSecret),
    required: Boolean(requireSlackTokens),
  };
  checks.push(slackTokenCheck);

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

export function readWorkspaceFile(workspaceDir: string, relPath: string): string {
  const filePath = assertInside(workspaceDir, join(workspaceDir, relPath));
  return readFileSync(filePath, "utf8");
}
