import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { executeAssistantScheduleTool } from "./assistant-schedule-tool.js";
import { callSlackApi } from "./canvas-publisher.js";

const execFileAsync = promisify(execFile);

export const LEGACY_SLACK_TOOL_SPECS = [
  {
    name: "slack_api",
    source: "slack_api_tool.go",
    category: "proxy",
    registration: "RegisterSlackProxyTools",
    adapter: "native_slack_web_api",
    status: "active_with_bot_token",
  },
  {
    name: "read_doc",
    source: "slack_tools.go",
    category: "helper",
    registration: "RegisterSlackHelperTools",
    adapter: "local_workspace_doc_reader",
    status: "active",
  },
  {
    name: "person_memory",
    source: "people_memory_tool.go",
    category: "helper",
    registration: "RegisterSlackHelperTools",
    adapter: "local_slack_memory_seed",
    status: "active_with_memory_seed",
  },
  {
    name: "followup_memory",
    source: "heartbeat_followup.go",
    category: "helper",
    registration: "RegisterSlackHelperTools/RegisterHeartbeatTools",
    adapter: "local_slack_memory_seed",
    status: "active_with_memory_seed",
  },
  {
    name: "suggest_action",
    source: "suggest_tool.go",
    category: "helper",
    registration: "RegisterSlackHelperTools",
    adapter: "local_pending_action_stub",
    status: "active_stub",
  },
  {
    name: "usage_api",
    source: "usage_tool.go",
    category: "helper",
    registration: "RegisterSlackHelperTools",
    adapter: "external_legacy_usage_backend",
    status: "external_required",
  },
  {
    name: "audio_generation",
    source: "audio_generation_tool.go",
    category: "assistant_only",
    registration: "RegisterSlackHelperTools(RoleAssistant)",
    adapter: "external_audio_provider",
    status: "external_required",
  },
  {
    name: "image_generation",
    source: "image_generation_tool.go",
    category: "assistant_only",
    registration: "RegisterSlackHelperTools(RoleAssistant)",
    adapter: "external_image_provider",
    status: "external_required",
  },
  {
    name: "runtime_status",
    source: "runtime_status_tool.go",
    category: "assistant_only/heartbeat",
    registration: "RegisterSlackHelperTools(RoleAssistant)/RegisterHeartbeatTools",
    adapter: "local_runtime_status",
    status: "active",
  },
  {
    name: "heartbeat_log",
    source: "heartbeat_log_tool.go",
    category: "assistant_only",
    registration: "RegisterSlackHelperTools(RoleAssistant)",
    adapter: "local_status_log",
    status: "active_stub",
  },
  {
    name: "linear_api",
    source: "linear_tools.go",
    category: "credentialed_proxy",
    registration: "RegisterCredentialedProxyTools",
    adapter: "external_linear_provider_or_agent_runner",
    status: "external_required",
  },
  {
    name: "google_calendar_api",
    source: "gcal_tools.go",
    category: "credentialed_proxy",
    registration: "RegisterCredentialedProxyTools",
    adapter: "external_gcal_provider",
    status: "external_required",
  },
  {
    name: "notion_api",
    source: "notion_tool.go",
    category: "credentialed_proxy",
    registration: "RegisterCredentialedProxyTools",
    adapter: "external_notion_provider",
    status: "external_required",
  },
  {
    name: "figma_api",
    source: "figma_tools.go",
    category: "credentialed_proxy",
    registration: "RegisterCredentialedProxyTools",
    adapter: "external_figma_provider",
    status: "external_required",
  },
  {
    name: "notify_meeting_slack",
    source: "meeting_slack_notify_tool.go",
    category: "copilot",
    registration: "RegisterCopilotHelperTools",
    adapter: "meeting_agent_slack_notify",
    status: "active_with_meeting_agent",
  },
  {
    name: "send_meeting_chat",
    source: "copilot_tools.go",
    category: "copilot",
    registration: "RegisterCopilotHelperTools",
    adapter: "meeting_agent_chat",
    status: "external_required",
  },
  {
    name: "run_command",
    source: "run_command_tool.go",
    category: "legacy_hidden",
    registration: "RegisterLegacySlackUtilityTools (empty in Legacy defaults)",
    adapter: "disabled_fail_closed",
    status: "disabled_by_default",
  },
  {
    name: "manage_schedule",
    source: "assistant_schedule_tool.go",
    category: "assistant_schedule",
    registration: "assistant prompt/defaults",
    adapter: "assistant_thread_schedule_list",
    status: "active_with_schedule_manager",
  },
];

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeString(value) {
  return String(value || "").trim();
}

function assertInside(root, path) {
  const rootAbs = resolve(root);
  const pathAbs = resolve(path);
  const rel = relative(rootAbs, pathAbs);
  if (rel.startsWith("..") || rel === ".." || resolve(pathAbs) === rootAbs) {
    throw new Error(`path must be inside ${rootAbs}`);
  }
  return pathAbs;
}

function isAllowedDocPath(relPath) {
  const normalized = String(relPath || "").replaceAll("\\", "/");
  return (
    normalized === "README.md" || (normalized.startsWith("docs/") && normalized.endsWith(".md"))
  );
}

function readSourceEvidence(spec, sourceRoot = "") {
  if (!sourceRoot) return { exists: false, path: "" };
  const path = join(sourceRoot, spec.source);
  if (!existsSync(path)) return { exists: false, path };
  const content = readFileSync(path, "utf8");
  return {
    exists: true,
    path,
    hasName:
      content.includes(`Name() string { return "${spec.name}"`) ||
      content.includes(`"${spec.name}"`),
  };
}

function toolResult(ok, data = {}) {
  return {
    ok,
    schema: "meeting-avatar-bot.legacy-slack-tool-result.v1",
    ...data,
  };
}

function externalRequired(spec, detail = {}) {
  return toolResult(false, {
    error: "external_provider_required",
    tool: spec.name,
    adapter: spec.adapter,
    source: spec.source,
    detail,
  });
}

function commandAllowed(command, allowlist) {
  const name =
    String(command || "")
      .trim()
      .split(/\s+/)[0] || "";
  return allowlist.includes(name);
}

type FetchLike = typeof fetch;

export interface CreateLegacySlackToolRegistryOptions {
  botToken?: string;
  fetchImpl?: FetchLike;
  localMemory?: unknown;
  workspaceDir?: string;
  runtimeStatus?: () => Record<string, unknown>;
  scheduleManager?: unknown;
  scheduleStore?: unknown;
  slackContext?: Record<string, unknown>;
  sessionMetadata?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  sourceRoot?: string;
}

export interface LegacyToolArgs {
  method?: string;
  api_method?: string;
  apiMethod?: string;
  payload?: Record<string, unknown>;
  path?: string;
  query?: string;
  limit?: number | string;
  channel?: string;
  text?: string;
  blocks?: unknown;
  action?: { type?: string; text?: string };
  channelName?: string;
  command?: string;
  [key: string]: unknown;
}

export function createLegacySlackToolRegistry(options: CreateLegacySlackToolRegistryOptions = {}) {
  const specs = LEGACY_SLACK_TOOL_SPECS.map((spec) => Object.assign({}, spec));
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const botToken = options.botToken || "";
  const fetchImpl = options.fetchImpl || fetch;
  const localMemory = options.localMemory || null;
  const workspaceDir = resolve(options.workspaceDir || process.cwd());
  const runtimeStatus = options.runtimeStatus || (() => ({}));
  const scheduleManager = options.scheduleManager || options.scheduleStore || null;
  const slackContext = options.slackContext || {};
  const env = options.env || process.env;
  const sourceRoot = safeString(options.sourceRoot || env.MAB_LEGACY_SLACK_SOURCE_ROOT);

  async function execute(name: string, args: LegacyToolArgs = {}) {
    const spec = byName.get(name);
    if (!spec) {
      return toolResult(false, {
        error: "unknown_tool",
        tool: name,
        knownTools: specs.map((item) => item.name),
      });
    }

    if (name === "slack_api") {
      const method = safeString(args.method || args.api_method || args.apiMethod);
      const payload = args.payload && typeof args.payload === "object" ? args.payload : {};
      if (!method || !/^[a-zA-Z0-9_.]+$/.test(method)) {
        return toolResult(false, { error: "invalid_slack_api_method", tool: name });
      }
      const result = await callSlackApi({ botToken, method, payload, fetchImpl });
      return toolResult(result.ok, { tool: name, method, result });
    }

    if (name === "read_doc") {
      const relPath = safeString(args.path);
      if (!relPath) return toolResult(false, { error: "path_required", tool: name });
      if (!isAllowedDocPath(relPath)) {
        return toolResult(false, {
          error: "path_not_allowed",
          tool: name,
          note: "read_doc only exposes README.md and docs/*.md so ignored local secrets such as .env stay private.",
        });
      }
      try {
        const absPath = assertInside(workspaceDir, join(workspaceDir, relPath));
        if (!existsSync(absPath))
          return toolResult(false, { error: "file_not_found", tool: name, path: relPath });
        const content = readFileSync(absPath, "utf8");
        return toolResult(true, {
          tool: name,
          path: relPath,
          content: content.length > 8000 ? `${content.slice(0, 8000)}\n... (truncated)` : content,
        });
      } catch (error) {
        return toolResult(false, {
          error: "read_doc_failed",
          tool: name,
          detail: String(error?.message || error),
        });
      }
    }

    if (name === "person_memory" || name === "followup_memory") {
      if (!localMemory)
        return toolResult(false, { error: "local_memory_not_configured", tool: name });
      const query = safeString(args.query || args.person || args.topic);
      const limit = Number.parseInt(String(args.limit ?? "5"), 10);
      if (!query) return toolResult(false, { error: "query_required", tool: name });
      const memory = localMemory as { search?: (q: string, limit: number) => unknown };
      return toolResult(true, {
        tool: name,
        query,
        results: memory.search?.(query, Number.isFinite(limit) ? limit : 5),
      });
    }

    if (name === "runtime_status") {
      return toolResult(true, {
        tool: name,
        status: {
          generatedAt: nowIso(),
          ...runtimeStatus(),
        },
      });
    }

    if (name === "suggest_action") {
      return toolResult(true, {
        tool: name,
        status: "pending_user_confirmation",
        action: args.action || args,
        note: "Legacy suggest_action parity adapter records the requested confirmation envelope; UI execution is intentionally separate.",
      });
    }

    if (name === "heartbeat_log") {
      return toolResult(true, {
        tool: name,
        status: "recorded_locally",
        entry: {
          at: nowIso(),
          text: safeString(args.text || args.summary || "heartbeat"),
          metadata: args.metadata || {},
        },
      });
    }

    if (name === "manage_schedule") {
      const result = await executeAssistantScheduleTool(
        args as { action?: string; channel_id?: string; channelId?: string; thread_ts?: string; threadTs?: string; [key: string]: unknown },
        {
          scheduleManager: scheduleManager as Parameters<typeof executeAssistantScheduleTool>[1]["scheduleManager"],
          slackContext,
          sessionMetadata: options.sessionMetadata || {},
        },
      );
      return toolResult(result.ok, {
        ...result,
        source: spec.source,
      });
    }

    if (name === "notify_meeting_slack") {
      const channel = safeString(args.channel);
      const text = safeString(args.text || args.message);
      if (!channel || !text)
        return toolResult(false, { error: "channel_and_text_required", tool: name });
      const result = await callSlackApi({
        botToken,
        method: "chat.postMessage",
        payload: { channel, text, thread_ts: args.thread_ts || args.threadTs || undefined },
        fetchImpl,
      });
      return toolResult(result.ok, { tool: name, result });
    }

    if (name === "run_command") {
      if (env.MAB_ENABLE_RUN_COMMAND_TOOL !== "1") {
        return toolResult(false, {
          error: "run_command_disabled",
          tool: name,
          note: "Legacy no longer registers this legacy utility by default; set MAB_ENABLE_RUN_COMMAND_TOOL=1 plus MAB_RUN_COMMAND_ALLOWLIST to opt in.",
        });
      }
      const command = safeString(args.command);
      const allowlist = safeString(env.MAB_RUN_COMMAND_ALLOWLIST || "git,gh,curl,jq")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (!commandAllowed(command, allowlist)) {
        return toolResult(false, { error: "run_command_not_allowed", tool: name, allowlist });
      }
      const [bin, ...cmdArgs] = command.split(/\s+/);
      try {
        const result = await execFileAsync(bin, cmdArgs, {
          cwd: workspaceDir,
          timeout: Number.parseInt(env.MAB_RUN_COMMAND_TIMEOUT_MS || "10000", 10),
          maxBuffer: 256 * 1024,
        });
        return toolResult(true, {
          tool: name,
          stdout: result.stdout.slice(0, 12000),
          stderr: result.stderr.slice(0, 12000),
        });
      } catch (error) {
        return toolResult(false, {
          error: "run_command_failed",
          tool: name,
          stdout: String(error?.stdout || "").slice(0, 12000),
          stderr: String(error?.stderr || error?.message || error).slice(0, 12000),
        });
      }
    }

    return externalRequired(spec, {
      args: safeJsonParse(JSON.stringify(args), {}),
    });
  }

  function report() {
    const activeTools = [];
    const pendingTools = [];
    const sourceEvidence = {};
    for (const spec of specs) {
      const active = [
        "slack_api",
        "read_doc",
        "person_memory",
        "followup_memory",
        "runtime_status",
        "suggest_action",
        "heartbeat_log",
        "notify_meeting_slack",
        "manage_schedule",
      ].includes(spec.name);
      if (spec.name === "run_command" && env.MAB_ENABLE_RUN_COMMAND_TOOL === "1")
        activeTools.push(spec.name);
      else if (active) activeTools.push(spec.name);
      else pendingTools.push(spec.name);
      sourceEvidence[spec.name] = readSourceEvidence(spec, sourceRoot);
    }

    return {
      ok: true,
      schema: "meeting-avatar-bot.legacy-slack-tools-parity.v1",
      generatedAt: nowIso(),
      sourceRoot,
      totalTools: specs.length,
      activeTools,
      pendingTools,
      tools: specs,
      sourceEvidence,
      notes: [
        "Legacy old repo is read-only source evidence.",
        "Legacy run_command is fail-closed because Legacy defaults no longer register it.",
        "Credentialed external tools keep the Legacy names and adapter slots; provider credentials/backends are wired incrementally.",
      ],
    };
  }

  return {
    specs,
    list: () => specs,
    report,
    execute,
  };
}
