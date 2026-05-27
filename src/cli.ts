#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join as pathJoin, relative } from "node:path";
import Database from "better-sqlite3";
import { getRuntimeConfig } from "../packages/core/src/env.js";
import {
  createInMemorySessionStore,
  createSessionStore,
} from "../packages/core/src/session-store.js";
import { createAgentRunner } from "../packages/core/src/agent-runner/agent-runner.js";
import { codexAppServerRunnerInternals } from "../packages/core/src/agent-runner/codex-app-server-runner.js";
import { buildAvatarInitScript } from "../packages/core/src/avatar/init-script-builder.js";
import { buildLocalDialogInitScript } from "../packages/core/src/dialog/local-dialog-init-builder.js";
import { createGoogleMeetJoiner } from "../packages/core/src/meeting/google-meet-joiner.js";
import { installMeetCaptionCapture } from "../packages/core/src/meeting/caption-capture.js";
import { createMeetingArtifactPipeline } from "../packages/core/src/meeting/post-meeting-artifacts.js";
import {
  computeDigestWebhookSignature,
  verifyDigestWebhookSignature,
} from "../packages/core/src/meeting/digest-webhook.js";
import { startLocalMeetFixtureServer } from "../packages/core/src/meeting/local-meet-fixture.js";
import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.js";
import {
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
  realtimeToolSchemas,
} from "../packages/core/src/realtime/realtime-contract.js";
import { createWorkerReportStore } from "../packages/core/src/realtime/worker-report-store.js";
import {
  parseAvatarCommand,
  slackTextResponse,
} from "../packages/core/src/control-plane/avatar-command.js";
import { createJsonServer } from "../packages/core/src/http-json.js";
import {
  signSlackRequestBody,
  verifySlackRequest,
} from "../packages/core/src/slack/slack-signature.js";
import { createCanvasPublisher } from "../packages/core/src/slack/canvas-publisher.js";
import { createSlackPoster } from "../packages/core/src/slack/slack-poster.js";
import {
  createInMemoryAssistantScheduleManager,
  executeAssistantScheduleTool,
} from "../packages/core/src/slack/assistant-schedule-tool.js";
import {
  LEGACY_SLACK_TOOL_SPECS,
  createLegacySlackToolRegistry,
} from "../packages/core/src/slack/legacy-slack-tool-registry.js";
import { createLegacySlackDomainStore } from "../packages/core/src/slack/legacy-slack-domain-store.js";
import {
  htmlToMarkdown,
  markdownToBlocks,
  markdownToMrkdwn,
  markdownToSlackFallbackText,
  markdownishToMrkdwn,
} from "../packages/core/src/slack/mrkdwn-renderer.js";
import {
  createLocalSlackMemoryProvider,
  seedLegacySlackMemory,
} from "../packages/core/src/slack/local-memory.js";
import { buildSlackTriageActionBlocks } from "../packages/core/src/slack/triage-flow.js";
import {
  formatTriageContexts,
  loadTriageContextProjection,
  persistTriageContextProjection,
} from "../packages/core/src/slack/triage-context.js";
import {
  buildDailyNoteCompactionTask,
  buildDailyNoteCompactionPrompt,
  dailyNoteCompactHash,
  shouldCompactDailyNote,
} from "../packages/core/src/slack/scanner-compaction.js";
import {
  assertNoPrivateSlackFields,
  createShadowTapPayload,
  postShadowTap,
  type ShadowTapInput,
} from "../packages/core/src/shadow/shadow-transmitter.js";

const command = process.argv[2] || "help";

function printHelp() {
  console.log(`meeting-avatar-bot

Commands:
  doctor        Check local environment for the Slack + Meeting bot
  smoke         Run an in-process session + worker delegation smoke
  agent-provider-smoke Verify dry-run, command, and HTTP agent runner providers
  agent-real-task-smoke Verify optional live AgentRunner transcript task output
  claude-provider-smoke Verify Claude Code agent runner provider contract
  codex-app-server-provider-smoke Verify Codex App Server runner session mapping in dry-run mode
  ollama-provider-smoke Verify Ollama agent runner provider contract
  slack-agent-d-provider-smoke Verify Slack Agent D adapter provider contract
  slack-live-capability-smoke Verify another Slack bot key can support shadow validation without touching old services
  slack-live-socket-smoke Verify live Slack Socket Mode event loop receives a test channel message
  slack-memory-seed Seed private local Slack Agent D memory into MAB_SLACK_MEMORY_DIR
  slack-memory-smoke Verify private local Slack memory seed/search/delegate context
  local-agent-dialog-smoke Verify local utterance -> AgentRunner -> TTS/audio/avatar bridge
  caption-local-dialog-smoke Verify Meet captions can drive local dialog turn/TTS without self-looping
  dialog-provider-smoke Verify STT event seam + Meeting Agent TTS provider route
  post-meeting-smoke Verify meeting artifact transcript/summary output
  meetd-api-compat-smoke Verify old Legacy MeetD REST API compatibility routes
  meetd-runtime-store-smoke Verify MeetD runtime/store watcher tick parity with a local service
  digest-webhook-smoke Verify MeetD digest webhook HMAC signing, retry, and redeliver
  meeting-copilot-smoke Verify in-meeting copilot digest runner and cooldown behavior
  canvas-publisher-smoke Verify post-meeting report publish payload + Slack-thread fallback
  slack-mrkdwn-renderer-smoke Verify Markdown/HTML -> Slack mrkdwn/block rendering
  slack-assistant-schedule-smoke Verify Assistant manage_schedule list/gating parity
  slack-assistant-schedule-service-smoke Verify manage_schedule through a local Slack Agent HTTP process
  slack-workspace-bootstrap-smoke Verify workspace bootstrap + validate-only preflight routes
  slack-install-smoke Verify Slack app manifest/OAuth install permission model locally
  slack-tool-registry-smoke Verify Slack tool registry/adapters compatibility
  slack-domain-store-smoke Verify Slack domain store schema/ledger/action/triage compatibility
  slack-triage-flow-smoke Verify Slack buffer triage -> pending action/card flow
  state-provider-smoke Verify memory/json-file/sqlite state provider contracts
  avatar-smoke  Verify avatar fake mic/cam injection in a local browser
  meet-smoke    Verify non-dry-run Playwright join against a local Meet fixture
  meet-contract-smoke Verify Google Meet joiner contract matrix against local fixture
  screen-share-smoke Verify synthetic screen-share stream bridge against local Meet fixture
  real-meet-smoke Verify optional real Google Meet join when MAB_REAL_MEET_URL is set
  real-local-dialog-smoke Verify optional real Meet + selected local AgentRunner dialog bridge
  persistence-smoke Verify service session/job state survives restart
  worker-bridge-smoke Verify completed worker jobs are delivered to the browser runtime
  realtime-browser-smoke Verify browser worker results create Realtime events
  realtime-webrtc-smoke Verify browser Realtime WebRTC connection seam in mock mode
  realtime-participant-audio-smoke Verify participant audio discovery for Realtime input
  realtime-audio-route-smoke Verify Realtime remote audio is routed into the avatar fake mic bus
  realtime-repeat-guard-smoke Verify duplicate worker-result and interrupt guards
  realtime-session-update-smoke Verify Realtime session.update registers instructions and tools
  realtime-worker-tool-smoke Verify Realtime worker tool calls reach Meeting Agent
  realtime-live-tool-smoke Verify real Realtime data channel can trigger worker tools when an OpenAI-compatible key is set
  realtime-live-routing-smoke Verify real Realtime routes visual requests to app/browser/generation tools
  avatar-state-smoke Verify Realtime avatar mood/action tools reach the avatar runtime
  avatar-visual-smoke Verify avatar mouth/action visual snapshots and state gates
  avatar-vrm-smoke Verify experimental Three.js/VRM avatar render pixels and state controls
  hiyori-live2d-smoke Verify true Hiyori Live2D render pixels when WebGL/CDN support is available
  runtime-acceptance-smoke Verify joined runtime combines avatar, participant audio, worker, and Realtime state
  slack-result-smoke Verify Slack polls completed Meeting Agent worker results once
  slack-posting-smoke Verify Slack posting adapter posts worker results once in mock mode
  slack-contract-smoke Verify Slack slash-command parser/signature/command contracts
  cutover-shadow-smoke Verify cutover feature flags, shadow/canary routing, and rollback safety
  cutover-rollback-smoke Verify failed new-stack joins automatically roll back to the old stack
  shadow-parity-smoke Verify fixture-level old-vs-new shadow parity for the control plane
  shadow-tap-smoke Verify shadow tap receiver records old-stack mirrored commands without side effects
  shadow-transmitter-smoke Verify old-stack mirror payloads can post to the shadow tap receiver
  shadow-transmitter-hook Mirror one old-stack Slack command to the shadow tap receiver from stdin
  cutover-evidence-bundle Generate a fixture-safe cutover evidence tarball
  cutover-evidence-smoke Verify the cutover evidence bundle generator
  realtime-sdp-smoke Verify optional real OpenAI-compatible Realtime SDP handshake when a key is set
  realtime-smoke Verify realtime config + worker completion polling
  slack-smoke   Verify Slack control-plane commands against Meeting Agent

Dev services:
  npm run dev:slack
  npm run dev:meeting
`);
}

function assertSmoke(condition: unknown, message: string, details: unknown = {}): void {
  if (condition) return;
  const error = new Error(message) as Error & { details?: unknown };
  error.details = details;
  throw error;
}

function readStdinText(): Promise<string> {
  return new Promise<string>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string | Buffer) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    if (process.stdin.isTTY) resolve("");
  });
}

function shouldRunOptionalSmoke(runEnvName: string, requireEnvName: string): boolean {
  return process.env[runEnvName] === "1" || process.env[requireEnvName] === "1";
}

interface RealtimeBridgeWorkerToolCall {
  name?: string;
  result?: { job?: { id?: string; status?: string } };
  [key: string]: unknown;
}

interface RealtimeBridgeSnapshot {
  outbound?: Array<{ event?: Record<string, unknown> & { type?: string; session?: unknown } }>;
  connection?: {
    sentDataChannelMessages?: Array<{ payload?: string }>;
    dataChannelOpen?: boolean;
    participantAudioTracksDiscovered?: number;
    [key: string]: unknown;
  };
  session?: {
    configured?: boolean;
    toolNames?: string[];
    instructions?: string;
    model?: string;
    output_modalities?: string[];
    audio?: unknown;
    reasoning?: { effort?: string };
    [key: string]: unknown;
  };
  timeline?: Array<{
    type?: string;
    detail?: { type?: string; name?: string; [key: string]: unknown };
    [key: string]: unknown;
  }>;
  workerTools?: {
    calls?: RealtimeBridgeWorkerToolCall[];
    errors?: unknown[];
  };
  avatarTools?: { calls?: Array<{ name?: string; [key: string]: unknown }>; errors?: unknown[] };
  meetTools?: { calls?: Array<Record<string, unknown>>; errors?: unknown[] };
  protection?: {
    duplicateWorkerResultsSkipped?: number;
    userSpeechCancels?: number;
    handledLocalToolCallIds?: string[];
    activeResponseId?: string;
  };
  inbound?: Array<{
    event?: { type?: string; name?: string; [key: string]: unknown };
    [key: string]: unknown;
  }>;
  meetChat?: { messages?: Array<{ text?: string; links?: string[] }> };
  [key: string]: unknown;
}

interface AvatarStateSnapshot {
  mood?: string;
  action?: string;
  statusKind?: string;
  statusText?: string;
  updates?: Array<{ kind?: string; action?: string; statusKind?: string; statusText?: string }>;
  live2dParameterFrames?: number;
  [key: string]: unknown;
}

interface AvatarVisualSnapshot {
  ok?: boolean;
  hash?: string;
  face?: { nonBackgroundRatio?: number };
  mouth?: { nonBackgroundRatio?: number };
  status?: { nonBackgroundRatio?: number };
  [key: string]: unknown;
}

interface AvatarVisualDiff {
  changedRatio?: number;
  [key: string]: unknown;
}

interface AvatarVisualTestHarness {
  renderSnapshot(input: Record<string, unknown>): AvatarVisualSnapshot;
  compareSnapshots(
    from: Record<string, unknown>,
    to: Record<string, unknown>,
    region: Record<string, number>,
  ): AvatarVisualDiff;
  captureSourceSnapshot(input: Record<string, unknown>): AvatarVisualSnapshot;
  getLiveHash(): string;
}

interface ShadowHookResponseBody {
  ok?: boolean;
  sideEffects?: string;
  event?: {
    summary?: { source?: string };
    parsed?: { action?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ShadowHookBody {
  disabled?: boolean;
  error?: string;
  ok?: boolean;
  payload?: Record<string, unknown>;
  status?: number;
  response?: ShadowHookResponseBody;
  raw?: string;
}

interface ShadowHookResult {
  status: number | null;
  stdout: string;
  stderr: string;
  body: ShadowHookBody;
}

interface ShadowReportEvent {
  newStack?: { sideEffects?: string; [key: string]: unknown };
  summary?: { source?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface EvidenceArtifact {
  path: string;
  bytes: number;
}

interface CutoverEvidenceManifest {
  ok: boolean;
  kind: string;
  generatedAt: string;
  smokeMode: boolean;
  repo: { head: string; branch: string; origin: string };
  env: {
    cutoverMode: string;
    stateProvider: string;
    stateSqlitePath: string;
    cutoverReportPath: string;
    shadowTapReportPath: string;
  };
  checks: Array<{ name: string; pass: boolean; details: Record<string, unknown> }>;
  commands: Array<Record<string, unknown>>;
  stateArtifacts: string[];
  agentRealTaskReports: string[];
  reportSummary: {
    slackSessions: number;
    cutoverEvents: number;
    shadowEvents: number;
    agentRealTaskReports: number;
  };
  artifacts: EvidenceArtifact[];
}

function collectRealtimeSentEvents(bridge: RealtimeBridgeSnapshot): Record<string, unknown>[] {
  const outboundEvents = (bridge?.outbound || []).map((entry) => entry.event || {});
  const dataChannelEvents = (bridge?.connection?.sentDataChannelMessages || []).map((entry) => {
    try {
      return JSON.parse(String(entry.payload || "")) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  });
  return [...outboundEvents, ...dataChannelEvents];
}

function hasCommand(commandName: string): string {
  const result = spawnSync("bash", ["-lc", `command -v ${commandName}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function parseEnvFile(filePath: string = ""): Record<string, string> {
  if (!filePath) return {};
  if (!existsSync(filePath)) return {};
  const result: Record<string, string> = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("export ")) {
      const exported = line.startsWith("export ") ? line.slice("export ".length).trim() : "";
      if (!exported || exported.startsWith("#")) continue;
      const eq = exported.indexOf("=");
      if (eq <= 0) continue;
      const key = exported.slice(0, eq).trim();
      const value = exported
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      result[key] = value;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    result[key] = value;
  }
  return result;
}

function envValue(envFileValues, key) {
  return process.env[key] || envFileValues[key] || "";
}

function redactSecret(value = "") {
  const raw = String(value || "");
  if (!raw) return "";
  if (raw.length <= 12) return `${raw.slice(0, 3)}...`;
  return `${raw.slice(0, 8)}...${raw.slice(-4)}`;
}

async function doctor() {
  const config = getRuntimeConfig();
  const checks = [
    ["node >= 22", Number(process.versions.node.split(".")[0]) >= 22, process.version],
    [
      "OpenAI-compatible realtime key",
      Boolean(config.openaiApiKey),
      config.openaiApiKey ? "set" : "missing",
    ],
    ["OpenAI base URL", Boolean(config.openaiBaseUrl), config.openaiBaseUrl],
    ["SLACK_BOT_TOKEN", Boolean(config.slackBotToken), config.slackBotToken ? "set" : "missing"],
    ["SLACK_APP_TOKEN", Boolean(config.slackAppToken), config.slackAppToken ? "set" : "missing"],
    ["agent runner", Boolean(config.agentRunner), config.agentRunner],
    [
      "codex binary",
      config.agentRunner !== "codex" || Boolean(hasCommand(config.codexBin)),
      hasCommand(config.codexBin) || "not required unless MAB_AGENT_RUNNER=codex",
    ],
    [
      "Ollama endpoint",
      config.agentRunner !== "ollama" || Boolean(config.ollamaBaseUrl),
      config.ollamaBaseUrl || "not required unless MAB_AGENT_RUNNER=ollama",
    ],
    [
      "Slack Agent D bridge",
      config.agentRunner !== "slack-agent-d" || Boolean(config.slackAgentDUrl),
      config.slackAgentDUrl || "not required unless MAB_AGENT_RUNNER=slack-agent-d",
    ],
    ["Avatar renderer", Boolean(config.avatarRenderer), config.avatarRenderer || "missing"],
    ["Hiyori/model URL", Boolean(config.avatarModelUrl), config.avatarModelUrl || "missing"],
    ["VRM/model URL", Boolean(config.avatarVRMModelUrl), config.avatarVRMModelUrl || "missing"],
    [
      "Playwright chromium cache",
      existsSync(`${process.env.HOME}/Library/Caches/ms-playwright`),
      "optional for local Meet joiner",
    ],
  ];

  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "ok " : "warn"} ${name}: ${detail}`);
  }
  console.log(
    "\nDoctor is warning-only for the scaffold. Missing tokens are expected in open-source local smoke.",
  );
}

async function smoke() {
  const sessions = createInMemorySessionStore();
  const runner = createAgentRunner({ provider: "dry-run" });
  const session = sessions.create({
    source: "smoke",
    meetUrl: "https://meet.google.com/example-demo",
    avatar: "hiyori",
    requestedBy: "local-dev",
  });
  const job = await runner.startTask({
    task: "Summarize the open-source Meeting Avatar Bot MVP.",
    mode: "plan",
    context: { sessionId: session.id },
  });
  sessions.update(session.id, { lastWorkerJobId: job.id, status: "ready_for_meeting_agent" });
  console.log(JSON.stringify({ ok: true, session: sessions.get(session.id), job }, null, 2));
}

async function agentProviderSmoke() {
  const dryRunRunner = createAgentRunner({ provider: "dry-run" });
  const dryRunJob = await dryRunRunner.startTask({
    task: "Check dry-run provider.",
    mode: "smoke",
    context: { provider: "dry-run" },
  });
  assertSmoke(
    dryRunJob.provider === "dry-run",
    "dry-run provider returned the wrong provider",
    dryRunJob,
  );
  assertSmoke(
    dryRunJob.status === "completed",
    "dry-run provider did not complete synchronously",
    dryRunJob,
  );

  const tempDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-agent-provider-"));
  const commandScript = pathJoin(tempDir, "agent-command-runner.mjs");
  await writeFile(
    commandScript,
    `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const job = JSON.parse(input);
  console.log(JSON.stringify({
    status: "completed",
    result: "command runner handled: " + job.task,
  }));
});
`,
    "utf8",
  );

  let httpServer = null;
  try {
    const commandRunner = createAgentRunner({
      provider: "command",
      env: {
        ...process.env,
        MAB_AGENT_RUNNER: "command",
        MAB_AGENT_COMMAND: `${process.execPath} ${commandScript}`,
      },
    });
    const commandJob = await commandRunner.startTask({
      task: "Check command provider.",
      mode: "smoke",
      context: { provider: "command" },
    });
    const completedCommandJob = await waitForRunnerJob(commandRunner, commandJob.id);
    assertSmoke(
      completedCommandJob.provider === "command",
      "command provider returned the wrong provider",
      completedCommandJob,
    );
    assertSmoke(
      completedCommandJob.status === "completed",
      "command provider did not complete",
      completedCommandJob,
    );
    assertSmoke(
      completedCommandJob.result.includes("Check command provider."),
      "command provider did not receive the task payload",
      completedCommandJob,
    );

    httpServer = createJsonServer({
      name: "agent-provider-smoke",
      port: 18911,
      routes: {
        "GET /healthz": () => ({ ok: true }),
        "POST /agent/run": async ({ body }) => ({
          body: {
            ok: true,
            status: "completed",
            result: `http runner handled: ${body.task}`,
          },
        }),
      },
    });
    await httpServer.listen();
    const httpRunner = createAgentRunner({
      provider: "http",
      env: {
        ...process.env,
        MAB_AGENT_RUNNER: "http",
        MAB_AGENT_HTTP_URL: "http://127.0.0.1:18911/agent/run",
      },
    });
    const httpJob = await httpRunner.startTask({
      task: "Check HTTP provider.",
      mode: "smoke",
      context: { provider: "http" },
    });
    const completedHttpJob = await waitForRunnerJob(httpRunner, httpJob.id);
    assertSmoke(
      completedHttpJob.provider === "http",
      "HTTP provider returned the wrong provider",
      completedHttpJob,
    );
    assertSmoke(
      completedHttpJob.status === "completed",
      "HTTP provider did not complete",
      completedHttpJob,
    );
    assertSmoke(
      completedHttpJob.result.includes("Check HTTP provider."),
      "HTTP provider did not receive the task payload",
      completedHttpJob,
    );

    console.log(
      JSON.stringify(
        { ok: true, dryRunJob, commandJob: completedCommandJob, httpJob: completedHttpJob },
        null,
        2,
      ),
    );
  } finally {
    if (httpServer) await new Promise((resolve) => httpServer.server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAgentRealTaskProvider(provider) {
  const normalized = String(provider || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
  if (normalized === "claude-code") return "claude";
  if (normalized === "slack-agentd" || normalized === "legacy-slack-agent-d")
    return "slack-agent-d";
  return normalized;
}

function requiredAgentRealTaskKeywords() {
  const configured = parseCsv(process.env.MAB_AGENT_REAL_TASK_KEYWORDS || "");
  return configured.length ? configured : ["Alice", "Bob", "Slack", "Meet", "latency", "alpha42"];
}

function agentRealTaskPrompt({ provider: _provider, keywords }) {
  return [
    "你是 meeting-avatar-bot 的可替换 AgentRunner provider。",
    "请阅读下面的短会议 transcript，输出一段中文摘要。",
    "为了让自动化验收能确认这是真 provider 输出，请在回答中逐字包含这些关键词：",
    keywords.join(", "),
    "",
    "Transcript:",
    "Alice: We need the meeting avatar bot to route complex Slack requests to a local agent provider instead of baking a model into the bot shell.",
    "Bob: Agreed. The bot should join Google Meet, keep Hiyori speaking, and report the worker result back to Slack.",
    "Alice: The cutover evidence bundle must include health checks, SQLite state snapshots, and reports.",
    "Bob: Track the latency risk as alpha42 so tomorrow's handoff can grep for it.",
    "",
    "回答要求：",
    "- 3 条 bullet 即可。",
    "- 说明 Slack 控制面、Meet/Hiyori 会议面、cutover evidence 三件事。",
    "- 不要写代码。",
  ].join("\n");
}

function defaultAgentRealTaskProviders() {
  const configured = parseCsv(process.env.MAB_AGENT_REAL_TASK_PROVIDERS || "");
  if (configured.length) return configured;
  const selected = normalizeAgentRealTaskProvider(process.env.MAB_AGENT_RUNNER || "");
  if (selected && selected !== "dry-run") return [selected];
  return ["codex"];
}

async function copyAgentRealTaskReports({ rootDir }) {
  const reportDir =
    process.env.MAB_AGENT_REAL_TASK_REPORT_DIR || pathJoin(process.cwd(), "reports");
  if (!existsSync(reportDir)) return [];
  const copied = [];
  for (const name of await readdir(reportDir)) {
    if (!/^agent-real-task-.+\.json$/.test(name)) continue;
    const sourcePath = pathJoin(reportDir, name);
    const targetPath = pathJoin(rootDir, "reports", name);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    copied.push(relative(rootDir, targetPath));
  }
  return copied.toSorted();
}

async function runAgentRealTaskForProvider(providerInput, { keywords, reportDir }) {
  const provider = normalizeAgentRealTaskProvider(providerInput);
  assertSmoke(
    provider && provider !== "dry-run",
    "agent real task smoke requires a live provider, not dry-run",
    { providerInput },
  );
  if (provider === "codex") {
    const codexBin = process.env.MAB_CODEX_BIN || "codex";
    assertSmoke(
      Boolean(hasCommand(codexBin)),
      "Codex real task smoke requires MAB_CODEX_BIN on PATH",
      { codexBin },
    );
  }
  if (provider === "claude") {
    const claudeBin = process.env.MAB_CLAUDE_BIN || "claude";
    assertSmoke(
      Boolean(hasCommand(claudeBin)),
      "Claude real task smoke requires MAB_CLAUDE_BIN on PATH",
      { claudeBin },
    );
  }

  const runner = createAgentRunner({
    provider,
    env: {
      ...process.env,
      MAB_AGENT_RUNNER: provider,
      MAB_DRY_RUN_AGENT: "",
      MAB_DRY_RUN_CODEX: "",
    },
  });
  const startedAt = new Date().toISOString();
  const job = await runner.startTask({
    task: agentRealTaskPrompt({ provider, keywords }),
    mode: "acceptance-smoke",
    allowCodeChanges: false,
    context: {
      fixture: "agent-real-task.v1",
      expectation: "Summarize transcript and preserve acceptance keywords.",
    },
  });
  const timeoutMs = Number.parseInt(process.env.MAB_AGENT_REAL_TASK_TIMEOUT_MS || "180000", 10);
  const completed = await waitForRunnerJob(runner, job.id, timeoutMs);
  const result = String(completed.result || "");
  const missingKeywords = keywords.filter(
    (keyword) => !result.toLowerCase().includes(keyword.toLowerCase()),
  );
  assertSmoke(
    completed.status === "completed",
    "agent real task provider did not complete",
    completed,
  );
  assertSmoke(
    missingKeywords.length === 0,
    "agent real task provider response missed expected keywords",
    {
      provider,
      missingKeywords,
      result,
    },
  );

  const report = {
    ok: true,
    kind: "meeting-avatar-bot.agent-real-task.v1",
    provider,
    startedAt,
    finishedAt: new Date().toISOString(),
    keywords,
    missingKeywords,
    job: completed,
  };
  const reportPath = pathJoin(reportDir, `agent-real-task-${provider}.json`);
  await writeJsonArtifact(reportPath, report);
  return { ...report, reportPath };
}

async function agentRealTaskSmoke() {
  const required = process.env.MAB_REQUIRE_AGENT_REAL_TASK === "1";
  const runLive = required || process.env.MAB_RUN_AGENT_REAL_TASK_SMOKE === "1";
  const reportDir =
    process.env.MAB_AGENT_REAL_TASK_REPORT_DIR || pathJoin(process.cwd(), "reports");
  if (!runLive) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          skipped: true,
          reason:
            "set MAB_RUN_AGENT_REAL_TASK_SMOKE=1 or MAB_REQUIRE_AGENT_REAL_TASK=1 to run live AgentRunner providers",
          examples: [
            "MAB_RUN_AGENT_REAL_TASK_SMOKE=1 MAB_AGENT_RUNNER=codex npm run smoke:agent-real-task",
            "MAB_RUN_AGENT_REAL_TASK_SMOKE=1 MAB_AGENT_REAL_TASK_PROVIDERS=codex,claude npm run smoke:agent-real-task",
          ],
        },
        null,
        2,
      ),
    );
    return;
  }

  const keywords = requiredAgentRealTaskKeywords();
  const providers = defaultAgentRealTaskProviders();
  await mkdir(reportDir, { recursive: true });
  const results = [];
  for (const provider of providers) {
    results.push(await runAgentRealTaskForProvider(provider, { keywords, reportDir }));
  }
  console.log(JSON.stringify({ ok: true, reportDir, providers, results }, null, 2));
}

async function claudeProviderSmoke() {
  const dryRunRunner = createAgentRunner({
    provider: "claude",
    dryRun: true,
    env: { ...process.env, MAB_AGENT_RUNNER: "claude", MAB_DRY_RUN_AGENT: "1" },
  });
  const dryRunJob = await dryRunRunner.startTask({
    task: "Check Claude Code provider dry-run contract.",
    mode: "smoke",
    context: { provider: "claude", runner: "claude-code" },
  });
  assertSmoke(
    dryRunJob.provider === "claude",
    "Claude provider returned the wrong provider",
    dryRunJob,
  );
  assertSmoke(
    dryRunJob.status === "completed",
    "Claude provider dry-run did not complete",
    dryRunJob,
  );

  const requireLive = (process.env.MAB_REQUIRE_CLAUDE_PROVIDER || "") === "1";
  const runLive = requireLive || (process.env.MAB_RUN_CLAUDE_PROVIDER_SMOKE || "") === "1";
  let live: { skipped: boolean; reason?: string; job?: unknown } = {
    skipped: true,
    reason:
      "set MAB_RUN_CLAUDE_PROVIDER_SMOKE=1 or MAB_REQUIRE_CLAUDE_PROVIDER=1 to run Claude Code live",
  };
  if (runLive) {
    const claudeBin = process.env.MAB_CLAUDE_BIN || "claude";
    if (!hasCommand(claudeBin)) {
      assertSmoke(!requireLive, "Claude provider live smoke requires MAB_CLAUDE_BIN on PATH", {
        claudeBin,
      });
      live = { skipped: true, reason: `Claude binary not found: ${claudeBin}` };
    } else {
      const runner = createAgentRunner({
        provider: "claude",
        env: {
          ...process.env,
          MAB_AGENT_RUNNER: "claude",
          MAB_CLAUDE_MAX_BUDGET_USD: process.env.MAB_CLAUDE_MAX_BUDGET_USD || "0.30",
        },
      });
      const job = await runner.startTask({
        task: "用一句中文说明 Claude Code provider 已接入 meeting-avatar-bot。",
        mode: "smoke",
        context: { provider: "claude", live: true },
      });
      const completed = await waitForRunnerJob(runner, job.id, 120_000);
      assertSmoke(
        completed.provider === "claude",
        "Claude provider live job returned wrong provider",
        completed,
      );
      assertSmoke(
        completed.status === "completed",
        "Claude provider live job did not complete",
        completed,
      );
      assertSmoke(
        Boolean(completed.result?.trim()),
        "Claude provider live job returned an empty result",
        completed,
      );
      live = { skipped: false, job: completed };
    }
  }

  console.log(JSON.stringify({ ok: true, dryRunJob, live }, null, 2));
}

async function codexAppServerProviderSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-codex-app-server-"));
  const env = {
    ...process.env,
    MAB_AGENT_RUNNER: "codex-app-server",
    MAB_DRY_RUN_CODEX: "1",
    MAB_DATA_DIR: dataDir,
    MAB_CODEX_APP_SERVER_SESSIONS_PATH: pathJoin(dataDir, "codex-app-server-sessions.json"),
    MAB_CODEX_APP_SERVER_WORKSPACE_ROOT: pathJoin(dataDir, "codex-workspaces"),
  };
  const context = {
    sessionId: "meet_app_server_smoke",
    slack: {
      workspaceId: "T_APP",
      channelId: "C_APP",
      threadTs: "1778517300.000100",
      userId: "U_PENG",
    },
  };
  const firstRunner = createAgentRunner({ provider: "codex-app-server", env });
  const first = await firstRunner.startTask({
    task: "Check Codex App Server runner session mapping.",
    mode: "smoke",
    allowCodeChanges: false,
    context,
  });
  const second = await firstRunner.startTask({
    task: "Reuse the same Slack thread session.",
    mode: "smoke",
    allowCodeChanges: false,
    context,
  });
  const other = await firstRunner.startTask({
    task: "Create a separate Slack thread session.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      ...context,
      slack: { ...context.slack, threadTs: "1778517301.000200" },
    },
  });
  const teammate = await firstRunner.startTask({
    task: "Reuse the same Slack thread when a different participant replies.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      ...context,
      requestedBy: "U_TEAMMATE",
      slack: { ...context.slack, userId: "U_TEAMMATE" },
    },
  });
  const rootUserA = await firstRunner.startTask({
    task: "Create a channel-root Slack session for one user.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      source: "slack-agent",
      requestedBy: "U_PENG",
      slack: {
        workspaceId: "T_APP",
        channelId: "C_APP",
        userId: "U_PENG",
      },
    },
  });
  const rootUserB = await firstRunner.startTask({
    task: "Create a separate channel-root Slack session for another user.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      source: "slack-agent",
      requestedBy: "U_TEAMMATE",
      slack: {
        workspaceId: "T_APP",
        channelId: "C_APP",
        userId: "U_TEAMMATE",
      },
    },
  });
  const rootSession = await firstRunner.startTask({
    task: "Create a channel-root Slack session scoped to an explicit meeting session.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      source: "slack-agent",
      sessionId: "meet_bound_delegate",
      slack: {
        workspaceId: "T_APP",
        channelId: "C_APP",
        userId: "U_PENG",
      },
    },
  });
  const rootSentinel = await firstRunner.startTask({
    task: "Treat channel-root sentinel as no Slack thread.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      source: "slack-agent",
      requestedBy: "U_PENG",
      slack: {
        workspaceId: "T_APP",
        channelId: "C_APP",
        threadTs: "channel-root",
        userId: "U_PENG",
      },
    },
  });
  const topLevelTriage = await firstRunner.startTask({
    task: "Scope top-level Slack triage context to its explicit triage session.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      source: "slack-triage",
      sessionId: "triage:C_APP:smoke",
      workspaceId: "T_APP",
      channelId: "C_APP",
      threadTs: "channel-root",
      messageCount: 1,
    },
  });
  const explicit = await firstRunner.startTask({
    task: "Honor an explicit App Server business session key.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      codexAppServerSessionKey: "manual:acceptance:session",
      slack: {
        workspaceId: "T_APP",
        channelId: "C_APP",
        threadTs: "1778517302.000300",
        userId: "U_PENG",
      },
    },
  });
  const secondRunner = createAgentRunner({ provider: "codex-app-server", env });
  const resumed = await secondRunner.startTask({
    task: "Resume the persisted Slack thread session after runner restart.",
    mode: "smoke",
    allowCodeChanges: false,
    context,
  });
  const meeting = await secondRunner.startTask({
    task: "Create a separate Meet session mapping.",
    mode: "smoke",
    allowCodeChanges: false,
    context: { sessionId: "meet_app_server_smoke" },
  });
  const codexModeRunner = createAgentRunner({
    provider: "codex",
    env: { ...env, MAB_AGENT_RUNNER: "codex", MAB_CODEX_RUNNER_MODE: "app-server" },
  });
  const codexMode = await codexModeRunner.startTask({
    task: "Select App Server through MAB_CODEX_RUNNER_MODE.",
    mode: "smoke",
    allowCodeChanges: false,
    context,
  });

  const firstSession = ((first.context as { codexAppServer?: Record<string, unknown> } | undefined)
    ?.codexAppServer || {}) as Record<string, unknown>;
  const secondSession = ((
    second.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const otherSession = ((other.context as { codexAppServer?: Record<string, unknown> } | undefined)
    ?.codexAppServer || {}) as Record<string, unknown>;
  const teammateSession = ((
    teammate.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const rootUserASession = ((
    rootUserA.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const rootUserBSession = ((
    rootUserB.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const rootExplicitSession = ((
    rootSession.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const rootSentinelSession = ((
    rootSentinel.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const topLevelTriageSession = ((
    topLevelTriage.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const explicitSession = ((
    explicit.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const resumedSession = ((
    resumed.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const meetingSession = ((
    meeting.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const codexModeSession = ((
    codexMode.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  assertSmoke(
    first.provider === "codex-app-server",
    "Codex App Server provider returned the wrong provider",
    first,
  );
  assertSmoke(first.status === "completed", "Codex App Server dry-run job did not complete", first);
  assertSmoke(
    Boolean(firstSession.sessionKey),
    "Codex App Server job did not expose session key",
    first,
  );
  assertSmoke(
    firstSession.sessionKey === "slack:T_APP:C_APP:1778517300.000100",
    "Slack thread key should be thread-scoped and not user-scoped",
    firstSession,
  );
  assertSmoke(
    firstSession.sessionKey === secondSession.sessionKey,
    "Same Slack thread did not reuse business session key",
    { first, second },
  );
  assertSmoke(
    firstSession.codexThreadId === secondSession.codexThreadId,
    "Same runner did not reuse Codex thread id",
    { first, second },
  );
  assertSmoke(
    firstSession.codexThreadId === teammateSession.codexThreadId,
    "Same Slack thread with a different user should reuse Codex thread id",
    { first, teammate },
  );
  assertSmoke(
    firstSession.codexThreadId === resumedSession.codexThreadId,
    "Persisted runner did not resume Codex thread id",
    { first, resumed },
  );
  assertSmoke(
    firstSession.codexThreadId !== otherSession.codexThreadId,
    "Different Slack thread reused the same Codex thread id",
    { first, other },
  );
  assertSmoke(
    rootUserASession.sessionKey === "slack:T_APP:C_APP:channel-root:U_PENG",
    "Slack channel-root session should stay user-scoped without an explicit thread/session",
    rootUserA,
  );
  assertSmoke(
    rootUserBSession.sessionKey === "slack:T_APP:C_APP:channel-root:U_TEAMMATE",
    "Slack channel-root session should preserve user isolation",
    rootUserB,
  );
  assertSmoke(
    rootUserASession.codexThreadId !== rootUserBSession.codexThreadId,
    "Different channel-root users reused the same Codex thread id",
    { rootUserA, rootUserB },
  );
  assertSmoke(
    rootExplicitSession.sessionKey === "slack:T_APP:C_APP:session:meet_bound_delegate",
    "Slack channel-root delegate with an explicit session should be session-scoped",
    rootSession,
  );
  assertSmoke(
    rootSentinelSession.sessionKey === rootUserASession.sessionKey,
    "Slack channel-root sentinel should not become a real thread session",
    { rootUserA, rootSentinel },
  );
  assertSmoke(
    rootSentinelSession.codexThreadId === rootUserASession.codexThreadId,
    "Slack channel-root sentinel should reuse the user-scoped channel-root session",
    { rootUserA, rootSentinel },
  );
  assertSmoke(
    topLevelTriageSession.sessionKey === "slack:T_APP:C_APP:session:triage:C_APP:smoke",
    "Top-level Slack triage context should use a Slack session key, not adhoc",
    topLevelTriage,
  );
  assertSmoke(
    explicitSession.sessionKey === "manual:acceptance:session",
    "Explicit App Server session key was not honored",
    explicit,
  );
  assertSmoke(
    meetingSession.sessionKey === "meeting:meet_app_server_smoke",
    "Meet session did not use the meeting business key",
    meeting,
  );
  assertSmoke(
    firstSession.sessionKey !== meetingSession.sessionKey,
    "Slack and Meet sessions should stay isolated",
    { first, meeting },
  );
  assertSmoke(
    codexMode.provider === "codex-app-server",
    "MAB_CODEX_RUNNER_MODE=app-server did not select App Server runner",
    codexMode,
  );
  assertSmoke(
    codexModeSession.codexThreadId === firstSession.codexThreadId,
    "Codex provider app-server mode did not reuse persisted Slack thread",
    { first, codexMode },
  );
  assertSmoke(
    firstSession.workspacePath === resumedSession.workspacePath,
    "Persisted runner did not reuse workspace path",
    { first, resumed },
  );
  const commandProgress = codexAppServerRunnerInternals.codexProgressFromEvent({
    method: "item/started",
    params: {
      item: {
        type: "commandExecution",
        command: "/bin/zsh -lc pwd",
      },
    },
  });
  assertSmoke(
    commandProgress?.status === "Running command: /bin/zsh -lc pwd" &&
      commandProgress?.toolName === "exec_command",
    "Codex App Server progress mapper did not label command execution events",
    commandProgress,
  );
  const toolProgress = codexAppServerRunnerInternals.codexProgressFromEvent({
    method: "item/mcpToolCall/progress",
    params: {
      toolName: "spawn_agent",
    },
  });
  assertSmoke(
    toolProgress?.status === "Delegating to worker..." && toolProgress?.toolName === "spawn_agent",
    "Codex App Server progress mapper did not label MCP tool events",
    toolProgress,
  );
  const replyProgress = codexAppServerRunnerInternals.codexProgressFromEvent({
    method: "item/agentMessage/delta",
    params: { delta: "tool-ok" },
  });
  assertSmoke(
    replyProgress?.status === "Composing reply..." && replyProgress?.toolName === "agent_message",
    "Codex App Server progress mapper did not label agent message deltas",
    replyProgress,
  );
  const completedCommandProgress = codexAppServerRunnerInternals.codexProgressFromEvent({
    method: "item/completed",
    params: {
      item: {
        type: "commandExecution",
        command: "/bin/zsh -lc pwd",
      },
    },
  });
  assertSmoke(
    completedCommandProgress === null,
    "Codex App Server progress mapper should not downgrade completed commands back to generic thinking",
    completedCommandProgress,
  );
  await (codexModeRunner as { close?: () => unknown | Promise<unknown> }).close?.();
  await (firstRunner as { close?: () => unknown | Promise<unknown> }).close?.();
  await (secondRunner as { close?: () => unknown | Promise<unknown> }).close?.();
  let live: { skipped: boolean; reason?: string; job?: unknown; toolJob?: unknown } = {
    skipped: true,
  };
  if (process.env.MAB_RUN_CODEX_APP_SERVER_LIVE_SMOKE === "1") {
    const liveDataDir = await mkdtemp(
      pathJoin(tmpdir(), "meeting-avatar-bot-codex-app-server-live-"),
    );
    const liveRunner = createAgentRunner({
      provider: "codex-app-server",
      env: {
        ...process.env,
        MAB_AGENT_RUNNER: "codex-app-server",
        MAB_DRY_RUN_CODEX: "0",
        MAB_CODEX_APP_SERVER_PORT: process.env.MAB_CODEX_APP_SERVER_PORT || "18768",
        MAB_DATA_DIR: liveDataDir,
        MAB_CODEX_APP_SERVER_SESSIONS_PATH: pathJoin(liveDataDir, "codex-app-server-sessions.json"),
        MAB_CODEX_APP_SERVER_WORKSPACE_ROOT: pathJoin(liveDataDir, "codex-workspaces"),
      },
    });
    try {
      const liveJob = await liveRunner.startTask({
        task: "Reply with exactly: app-server-ok",
        mode: "smoke",
        allowCodeChanges: false,
        context: {
          slack: {
            workspaceId: "T_APP_LIVE",
            channelId: "C_APP_LIVE",
            threadTs: "1778517302.000300",
            userId: "U_PENG",
          },
        },
      });
      const completed = await waitForRunnerJob(liveRunner, liveJob.id, 120_000);
      assertSmoke(
        completed.provider === "codex-app-server",
        "Live Codex App Server job returned wrong provider",
        completed,
      );
      assertSmoke(
        completed.status === "completed",
        "Live Codex App Server job did not complete",
        completed,
      );
      assertSmoke(
        String(completed.result || "")
          .toLowerCase()
          .includes("app-server-ok"),
        "Live Codex App Server job did not return the expected marker",
        completed,
      );
      assertSmoke(
        Boolean(completed.context?.codexAppServer?.codexThreadId),
        "Live Codex App Server job did not record a thread id",
        completed,
      );
      const toolJob = await liveRunner.startTask({
        task: "Run the shell command `pwd` once, then reply with exactly: tool-ok",
        mode: "smoke",
        allowCodeChanges: false,
        context: {
          slack: {
            workspaceId: "T_APP_LIVE",
            channelId: "C_APP_LIVE",
            threadTs: "1778517303.000400",
            userId: "U_PENG",
          },
        },
      });
      const toolCompleted = await waitForRunnerJob(liveRunner, toolJob.id, 120_000);
      assertSmoke(
        toolCompleted.status === "completed",
        "Live Codex App Server tool-progress job did not complete",
        toolCompleted,
      );
      assertSmoke(
        String(toolCompleted.result || "")
          .toLowerCase()
          .includes("tool-ok"),
        "Live Codex App Server tool-progress job did not return the expected marker",
        toolCompleted,
      );
      assertSmoke(
        toolCompleted.progressEvents?.some((event) => event.status?.startsWith("Running command:")),
        "Live Codex App Server tool-progress job did not record command execution progress",
        toolCompleted,
      );
      assertSmoke(
        toolCompleted.progressEvents?.some((event) => event.status === "Composing reply..."),
        "Live Codex App Server tool-progress job did not record reply composition progress",
        toolCompleted,
      );
      live = { skipped: false, job: completed, toolJob: toolCompleted };
    } finally {
      await (liveRunner as { close?: () => unknown | Promise<unknown> }).close?.();
      await rm(liveDataDir, { recursive: true, force: true });
    }
  }
  await rm(dataDir, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        ok: true,
        sessionCases: {
          sameSlackThread: firstSession.sessionKey,
          sameSlackThreadOtherUser: teammateSession.sessionKey,
          otherSlackThread: otherSession.sessionKey,
          channelRootUserA: rootUserASession.sessionKey,
          channelRootUserB: rootUserBSession.sessionKey,
          channelRootExplicitSession: rootExplicitSession.sessionKey,
          channelRootSentinel: rootSentinelSession.sessionKey,
          topLevelTriage: topLevelTriageSession.sessionKey,
          explicit: explicitSession.sessionKey,
          meeting: meetingSession.sessionKey,
        },
        first,
        second,
        other,
        resumed,
        meeting,
        codexMode,
        live,
      },
      null,
      2,
    ),
  );
}

async function ollamaProviderSmoke() {
  const dryRunRunner = createAgentRunner({
    provider: "ollama",
    dryRun: true,
    env: { ...process.env, MAB_AGENT_RUNNER: "ollama", MAB_DRY_RUN_AGENT: "1" },
  });
  const dryRunJob = await dryRunRunner.startTask({
    task: "Check Ollama provider dry-run contract.",
    mode: "smoke",
    context: { provider: "ollama", runner: "ollama" },
  });
  assertSmoke(
    dryRunJob.provider === "ollama",
    "Ollama provider returned the wrong provider",
    dryRunJob,
  );
  assertSmoke(
    dryRunJob.status === "completed",
    "Ollama provider dry-run did not complete",
    dryRunJob,
  );

  const requireLive = (process.env.MAB_REQUIRE_OLLAMA_PROVIDER || "") === "1";
  const runLive = requireLive || (process.env.MAB_RUN_OLLAMA_PROVIDER_SMOKE || "") === "1";
  let live: { skipped: boolean; reason?: string; job?: unknown } = {
    skipped: true,
    reason:
      "set MAB_RUN_OLLAMA_PROVIDER_SMOKE=1 or MAB_REQUIRE_OLLAMA_PROVIDER=1 to run Ollama live",
  };
  if (runLive) {
    const runner = createAgentRunner({
      provider: "ollama",
      env: { ...process.env, MAB_AGENT_RUNNER: "ollama" },
    });
    const job = await runner.startTask({
      task: "用一句中文说明 Ollama provider 已接入 meeting-avatar-bot。",
      mode: "smoke",
      context: { provider: "ollama", live: true },
    });
    const completed = await waitForRunnerJob(runner, job.id, 120_000);
    assertSmoke(
      completed.provider === "ollama",
      "Ollama provider live job returned wrong provider",
      completed,
    );
    assertSmoke(
      completed.status === "completed",
      "Ollama provider live job did not complete",
      completed,
    );
    assertSmoke(
      Boolean(completed.result?.trim()),
      "Ollama provider live job returned an empty result",
      completed,
    );
    live = { skipped: false, job: completed };
  }

  console.log(JSON.stringify({ ok: true, dryRunJob, live }, null, 2));
}

async function slackAgentDProviderSmoke() {
  const dryRunRunner = createAgentRunner({
    provider: "slack-agent-d",
    dryRun: true,
    env: { ...process.env, MAB_AGENT_RUNNER: "slack-agent-d", MAB_DRY_RUN_AGENT: "1" },
  });
  const dryRunJob = await dryRunRunner.startTask({
    task: "Check Slack Agent D adapter dry-run contract.",
    mode: "smoke",
    context: { provider: "slack-agent-d", runner: "legacy" },
  });
  assertSmoke(
    dryRunJob.provider === "slack-agent-d",
    "Slack Agent D adapter returned the wrong provider",
    dryRunJob,
  );
  assertSmoke(
    dryRunJob.status === "completed",
    "Slack Agent D adapter dry-run did not complete",
    dryRunJob,
  );

  let captured = null;
  const server = createJsonServer({
    name: "slack-agent-d-provider-smoke",
    port: 18914,
    routes: {
      "GET /healthz": () => ({ ok: true }),
      "POST /agent/run": async ({ req, body }) => {
        captured = {
          body,
          authorization: req.headers.authorization || "",
          bridgeToken: req.headers["x-meeting-avatar-bot-token"] || "",
        };
        return {
          body: {
            ok: true,
            status: "completed",
            jobId: "legacy_job_smoke",
            result: `Slack Agent D adapter received: ${body.task}`,
          },
        };
      },
    },
  });

  try {
    await server.listen();
    const runner = createAgentRunner({
      provider: "slack-agent-d",
      env: {
        ...process.env,
        MAB_AGENT_RUNNER: "slack-agent-d",
        MAB_SLACK_AGENT_D_URL: "http://127.0.0.1:18914/agent/run",
        MAB_SLACK_AGENT_D_TOKEN: "adapter-smoke-token",
      },
    });
    const job = await runner.startTask({
      task: "Check Slack Agent D adapter live bridge.",
      mode: "smoke",
      allowCodeChanges: false,
      context: {
        sessionId: "session_smoke",
        channelId: "C_SMOKE",
        token: "must-not-leak",
        response_url: "https://hooks.slack.com/must-not-leak",
        nested: {
          trigger_id: "must-not-leak",
          apiKey: "must-not-leak",
          safe: "kept",
        },
      },
    });
    const completed = await waitForRunnerJob(runner, job.id);
    assertSmoke(
      completed.provider === "slack-agent-d",
      "Slack Agent D adapter live job returned wrong provider",
      completed,
    );
    assertSmoke(
      completed.status === "completed",
      "Slack Agent D adapter live job did not complete",
      completed,
    );
    assertSmoke(
      completed.providerJobId === "legacy_job_smoke",
      "Slack Agent D adapter did not preserve upstream job id",
      completed,
    );
    assertSmoke(
      completed.result.includes("Check Slack Agent D adapter live bridge."),
      "Slack Agent D adapter did not receive the task",
      completed,
    );
    assertSmoke(
      captured?.authorization === "Bearer adapter-smoke-token",
      "Slack Agent D adapter did not send bearer token",
      captured,
    );
    assertSmoke(
      captured?.bridgeToken === "adapter-smoke-token",
      "Slack Agent D adapter did not send bridge token header",
      captured,
    );
    const capturedJson = JSON.stringify(captured?.body || {});
    for (const forbidden of ["token", "response_url", "trigger_id", "apiKey", "must-not-leak"]) {
      assertSmoke(
        !capturedJson.includes(forbidden),
        `Slack Agent D adapter leaked private field ${forbidden}`,
        captured,
      );
    }
    assertSmoke(
      captured?.body?.context?.nested?.safe === "kept",
      "Slack Agent D adapter removed safe nested context",
      captured,
    );
    console.log(JSON.stringify({ ok: true, dryRunJob, completed, captured }, null, 2));
  } finally {
    await new Promise((resolve) => server.server.close(resolve));
  }
}

async function slackLiveApi(token, method, payload = {}) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return {
    ok: response.ok && body.ok === true,
    status: response.status,
    method,
    body,
  };
}

async function slackLiveCapabilitySmoke() {
  const runLive = shouldRunOptionalSmoke(
    "MAB_RUN_SLACK_LIVE_CAPABILITY_SMOKE",
    "MAB_REQUIRE_SLACK_LIVE_CAPABILITY",
  );
  const envFile =
    process.env.MAB_SLACK_LIVE_ENV_FILE || process.env.MAB_SLACK_SHADOW_ENV_FILE || "";
  const envFileValues = parseEnvFile(envFile);
  const botToken = envValue(envFileValues, "SLACK_BOT_TOKEN");
  const appToken = envValue(envFileValues, "SLACK_APP_TOKEN");
  const signingSecret = envValue(envFileValues, "SLACK_SIGNING_SECRET");
  const testChannel =
    process.env.MAB_SLACK_LIVE_TEST_CHANNEL ||
    envFileValues.MAB_SLACK_LIVE_TEST_CHANNEL ||
    envFileValues.MAB_CANVAS_SLACK_CHANNEL ||
    "";

  if (!runLive) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          skipped: true,
          reason:
            "set MAB_RUN_SLACK_LIVE_CAPABILITY_SMOKE=1 or MAB_REQUIRE_SLACK_LIVE_CAPABILITY=1 to validate a real Slack bot key",
          envFile: envFile ? { path: envFile, exists: existsSync(envFile) } : null,
          configured: {
            botToken: Boolean(botToken),
            appToken: Boolean(appToken),
            signingSecret: Boolean(signingSecret),
            testChannel: Boolean(testChannel),
          },
          sideEffects: "none",
        },
        null,
        2,
      ),
    );
    return;
  }

  assertSmoke(Boolean(botToken), "SLACK_BOT_TOKEN is required for Slack live capability smoke", {
    envFile: envFile ? { path: envFile, exists: existsSync(envFile) } : null,
  });

  const botAuth = await slackLiveApi(botToken, "auth.test");
  assertSmoke(botAuth.ok, "Slack bot token auth.test failed", {
    status: botAuth.status,
    error: botAuth.body?.error,
  });

  let appConnection: {
    skipped: boolean;
    reason?: string;
    ok?: boolean;
    teamId?: string;
    urlIssued?: boolean;
    note?: string;
  } = {
    skipped: true,
    reason: "SLACK_APP_TOKEN missing; Socket Mode capability not checked",
  };
  if (appToken) {
    const opened = await slackLiveApi(appToken, "apps.connections.open");
    assertSmoke(
      opened.ok && Boolean(opened.body?.url),
      "Slack app token apps.connections.open failed",
      {
        status: opened.status,
        error: opened.body?.error,
      },
    );
    appConnection = {
      skipped: false,
      ok: true,
      teamId: opened.body?.team_id || "",
      urlIssued: Boolean(opened.body?.url),
      note: "Only requested a Socket Mode URL; this smoke does not open the WebSocket or ack real events.",
    };
  }

  let postMessage: {
    skipped: boolean;
    reason?: string;
    ok?: boolean;
    channel?: string;
    ts?: string;
  } = {
    skipped: true,
    reason: "set MAB_SLACK_LIVE_POST_TEST=1 and MAB_SLACK_LIVE_TEST_CHANNEL to post a test message",
  };
  if (process.env.MAB_SLACK_LIVE_POST_TEST === "1") {
    assertSmoke(
      Boolean(testChannel),
      "MAB_SLACK_LIVE_TEST_CHANNEL is required when MAB_SLACK_LIVE_POST_TEST=1",
    );
    const post = await slackLiveApi(botToken, "chat.postMessage", {
      channel: testChannel,
      text: "meeting-avatar-bot shadow validation smoke: Slack bot key can post here.",
      unfurl_links: false,
      unfurl_media: false,
    });
    assertSmoke(post.ok, "Slack live postMessage test failed", {
      status: post.status,
      error: post.body?.error,
      channel: testChannel,
    });
    postMessage = {
      skipped: false,
      ok: true,
      channel: post.body?.channel || testChannel,
      ts: post.body?.ts || "",
    };
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "shadow_live_capability",
        envFile: envFile ? { path: envFile, exists: existsSync(envFile) } : null,
        tokens: {
          botToken: botToken ? redactSecret(botToken) : "",
          appToken: appToken ? redactSecret(appToken) : "",
          signingSecret: Boolean(signingSecret),
        },
        botAuth: {
          ok: true,
          team: botAuth.body?.team || "",
          teamId: botAuth.body?.team_id || "",
          user: botAuth.body?.user || "",
          userId: botAuth.body?.user_id || "",
          botId: botAuth.body?.bot_id || "",
        },
        appConnection,
        postMessage,
        sideEffects: postMessage.skipped
          ? "no Slack messages posted; old Slack Agent D / Meet D untouched"
          : "posted one configured test message; old Slack Agent D / Meet D untouched",
      },
      null,
      2,
    ),
  );
}

async function slackLiveSocketSmoke() {
  const runLive = shouldRunOptionalSmoke(
    "MAB_RUN_SLACK_LIVE_SOCKET_SMOKE",
    "MAB_REQUIRE_SLACK_LIVE_SOCKET",
  );
  const envFile =
    process.env.MAB_SLACK_LIVE_ENV_FILE || process.env.MAB_SLACK_SHADOW_ENV_FILE || "";
  const envFileValues = parseEnvFile(envFile);
  const botToken = envValue(envFileValues, "SLACK_BOT_TOKEN");
  const appToken = envValue(envFileValues, "SLACK_APP_TOKEN");
  const testChannel =
    process.env.MAB_SLACK_LIVE_TEST_CHANNEL ||
    envFileValues.MAB_SLACK_LIVE_TEST_CHANNEL ||
    envFileValues.MAB_CANVAS_SLACK_CHANNEL ||
    "";

  if (!runLive) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          skipped: true,
          reason:
            "set MAB_RUN_SLACK_LIVE_SOCKET_SMOKE=1 or MAB_REQUIRE_SLACK_LIVE_SOCKET=1 to run a real Socket Mode loop smoke",
          envFile: envFile ? { path: envFile, exists: existsSync(envFile) } : null,
          configured: {
            botToken: Boolean(botToken),
            appToken: Boolean(appToken),
            testChannel: Boolean(testChannel),
          },
          sideEffects: "none",
        },
        null,
        2,
      ),
    );
    return;
  }

  assertSmoke(Boolean(botToken), "SLACK_BOT_TOKEN is required for Slack live socket smoke", {
    envFile: envFile ? { path: envFile, exists: existsSync(envFile) } : null,
  });
  assertSmoke(Boolean(appToken), "SLACK_APP_TOKEN is required for Slack live socket smoke", {
    envFile: envFile ? { path: envFile, exists: existsSync(envFile) } : null,
  });
  assertSmoke(
    Boolean(testChannel),
    "MAB_SLACK_LIVE_TEST_CHANNEL is required for Slack live socket smoke",
  );

  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-live-socket-"));
  const port = Number.parseInt(process.env.MAB_SLACK_LIVE_SOCKET_PORT || "18931", 10);
  const slack = startService("apps/slack-agent/src/index.js", {
    MAB_SLACK_PORT: String(port),
    MAB_DATA_DIR: dataDir,
    MAB_SLACK_SOCKET_MODE: "1",
    MAB_SLACK_EVENT_BUFFER: "1",
    MAB_SLACK_EVENT_DEBOUNCE_MS: "750",
    MAB_SLACK_EVENT_MAX_BATCH: "1",
    MAB_SLACK_EVENT_ALLOW_BOT_MESSAGES: "1",
    MAB_AGENT_RUNNER: "dry-run",
    MAB_DRY_RUN_AGENT: "1",
    MAB_SLACK_POSTER_MOCK: "1",
    SLACK_BOT_TOKEN: botToken,
    SLACK_APP_TOKEN: appToken,
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const initialHealth = await waitForServiceHealth(slack, `${baseUrl}/healthz`, 10_000);
    let initialStatus = await (await fetch(`${baseUrl}/slack/inbound/status`)).json();
    const connectDeadline = Date.now() + 15_000;
    while (!initialStatus.inbound?.socketMode?.connected && Date.now() < connectDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      initialStatus = await (await fetch(`${baseUrl}/slack/inbound/status`)).json();
    }
    assertSmoke(
      initialStatus.inbound?.socketMode?.connected === true,
      "Slack live socket did not connect",
      {
        status: initialStatus,
        logs: slack.logs(),
      },
    );

    const marker = `meeting-avatar-bot live socket smoke ${Date.now()}`;
    const post = await slackLiveApi(botToken, "chat.postMessage", {
      channel: testChannel,
      text: marker,
      unfurl_links: false,
      unfurl_media: false,
    });
    assertSmoke(post.ok, "Slack live socket smoke could not post trigger message", {
      status: post.status,
      error: post.body?.error,
      channel: testChannel,
    });

    let finalStatus = initialStatus;
    const initialFlushes = Number(initialStatus.inbound?.eventBuffer?.flushes || 0);
    const eventDeadline = Date.now() + 20_000;
    while (Date.now() < eventDeadline) {
      finalStatus = await (await fetch(`${baseUrl}/slack/inbound/status`)).json();
      const buffer = finalStatus.inbound?.eventBuffer || {};
      const channelStats = buffer.channels?.[testChannel] || null;
      const sawChannel = Boolean(channelStats);
      const flushed =
        buffer.lastFlushChannel === testChannel && Number(buffer.flushes || 0) > initialFlushes;
      if (sawChannel || flushed) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const buffer = finalStatus.inbound?.eventBuffer || {};
    const channelStats = buffer.channels?.[testChannel] || null;
    const sawEvent =
      Boolean(channelStats) ||
      (buffer.lastFlushChannel === testChannel && Number(buffer.flushes || 0) > initialFlushes);
    assertSmoke(sawEvent, "Slack live socket did not observe the test channel event", {
      initialStatus,
      finalStatus,
      post: { ok: post.ok, channel: post.body?.channel || testChannel, ts: post.body?.ts || "" },
      logs: slack.logs(),
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "shadow_live_socket",
          envFile: envFile ? { path: envFile, exists: existsSync(envFile) } : null,
          service: {
            port,
            health: {
              ok: initialHealth.ok,
              service: initialHealth.service,
              socketMode: initialHealth.state?.slackInbound?.socketMode,
            },
          },
          triggerPost: {
            ok: true,
            channel: post.body?.channel || testChannel,
            ts: post.body?.ts || "",
          },
          socketMode: finalStatus.inbound?.socketMode,
          eventBuffer: {
            bufferedMessages: buffer.bufferedMessages,
            flushes: buffer.flushes,
            lastBufferedAt: buffer.lastBufferedAt,
            lastFlushAt: buffer.lastFlushAt,
            lastFlushChannel: buffer.lastFlushChannel,
            channel: channelStats,
          },
          note: "Self-triggered with bot messages allowed only for this smoke; production default still ignores bot messages to avoid loops.",
          sideEffects:
            "posted one configured test message; connected an isolated Slack Agent Socket Mode loop; old Slack Agent D / Meet D untouched",
        },
        null,
        2,
      ),
    );
  } finally {
    slack.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function slackMemorySeed() {
  const config = getRuntimeConfig();
  const manifest = seedLegacySlackMemory({
    targetDir: config.slackMemoryDir,
    sourceWorkspaceDir: config.legacySlackWorkspaceDir,
    sourceDbPath: config.legacySlackAgentDb,
  });
  console.log(JSON.stringify({ ok: true, manifest }, null, 2));
}

async function slackMemorySmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-memory-"));
  const memoryDir = pathJoin(dataDir, "slack-memory");
  const sourceWorkspaceDir = pathJoin(dataDir, "old-workspace");
  const sourceDbPath = pathJoin(dataDir, "old-slack-agent.db");
  await mkdir(pathJoin(sourceWorkspaceDir, "memory", "team", "meetings"), { recursive: true });
  await writeFile(
    pathJoin(sourceWorkspaceDir, "MEMORY.md"),
    [
      "# Workspace Memory",
      "",
      "- Operator prefers Slack-first meeting control with persistent workspace context.",
      "- Use legacy workspace practice as a read-only reference.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    pathJoin(sourceWorkspaceDir, "memory", "team", "meetings", "meeting-42.md"),
    [
      "# Team Memory: Meeting Avatar",
      "",
      "## Decisions",
      "- Meeting avatar must publish transcript and summary to Slack Canvas.",
      "",
    ].join("\n"),
    "utf8",
  );
  const db = new Database(sourceDbPath);
  db.exec(`
    CREATE TABLE channel_brain (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      summary_version INTEGER NOT NULL DEFAULT 0,
      last_session_id TEXT NOT NULL DEFAULT '',
      last_thread_ts TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE thread_ledger (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      owner_user_id TEXT NOT NULL DEFAULT '',
      last_user_id TEXT NOT NULL DEFAULT '',
      last_action_type TEXT NOT NULL DEFAULT '',
      last_action_status TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  db.prepare("INSERT INTO channel_brain VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "T_SMOKE",
    "C_SMOKE",
    "Shared facts and conventions:\n- Meeting bot should remember Slack channel context before delegating work.",
    1,
    "meet_42",
    "1715155200.000000",
    "2026-05-08T07:30:00.000Z",
  );
  db.prepare("INSERT INTO thread_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "T_SMOKE",
    "C_SMOKE",
    "1715155200.000000",
    "active",
    "U_PENG",
    "U_PENG",
    "delegate",
    "completed",
    "Decision: publish meeting summary to Slack Canvas after ASR.",
    "2026-05-08T07:31:00.000Z",
  );
  db.close();

  const env = {
    MAB_SLACK_PORT: "18923",
    MAB_MEETING_PORT: "18924",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18924",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    MAB_SLACK_MEMORY_ENABLED: "1",
    MAB_SLACK_MEMORY_DIR: memoryDir,
    SLACK_SIGNING_SECRET: "slack-memory-signing-secret",
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const slack = startService("apps/slack-agent/src/index.js", env);

  try {
    const manifest = seedLegacySlackMemory({
      targetDir: memoryDir,
      sourceWorkspaceDir,
      sourceDbPath,
    });
    const privateFilePath = pathJoin(memoryDir, "workspace", "MEMORY.md");
    assertSmoke(
      existsSync(privateFilePath),
      "Slack memory seed did not copy private MEMORY.md",
      manifest,
    );
    assertSmoke(
      readFileSync(".gitignore", "utf8").includes("/local-data/") &&
        readFileSync(".gitignore", "utf8").includes("slack-memory/"),
      "gitignore does not protect local Slack memory directories",
    );
    const provider = createLocalSlackMemoryProvider({ enabled: true, rootDir: memoryDir });
    const search = provider.search("Slack Canvas meeting context", 6);
    assertSmoke(
      search.length >= 2,
      "local Slack memory provider did not find seeded file/db context",
      { search, manifest },
    );
    await waitForHealth("http://127.0.0.1:18924/healthz");
    await waitForHealth("http://127.0.0.1:18923/healthz");

    const memoryRoute = await (
      await fetch("http://127.0.0.1:18923/memory?q=Canvas&limit=5")
    ).json();
    assertSmoke(
      memoryRoute.summary?.seed?.channelBrain === 1,
      "Slack memory route did not expose private seed summary",
      memoryRoute,
    );
    assertSmoke(
      memoryRoute.results?.length >= 1,
      "Slack memory route did not search private seed",
      memoryRoute,
    );

    const join = await postSignedSlackCommand(
      "http://127.0.0.1:18923/slack/commands/avatar",
      "join https://meet.google.com/abc-defg-hij --start-joiner false",
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    const delegate = await postSignedSlackCommand(
      "http://127.0.0.1:18923/slack/commands/avatar",
      `delegate --session ${join.session?.id} "Use Slack Canvas context to summarize the meeting artifact pipeline"`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      delegate.job?.context?.localSlackMemory?.enabled === true,
      "delegate did not attach local Slack memory context",
      delegate.job?.context,
    );
    assertSmoke(
      delegate.job?.context?.localSlackMemory?.resultCount >= 1,
      "delegate local Slack memory context was empty",
      delegate.job?.context,
    );
    assertSmoke(
      !JSON.stringify(delegate.job?.context || {}).includes("response_url"),
      "delegate leaked private Slack response_url into agent context",
      delegate.job?.context,
    );

    console.log(
      JSON.stringify({ ok: true, manifest, search, memoryRoute, join, delegate }, null, 2),
    );
  } finally {
    for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function localAgentDialogSmoke() {
  const config = getRuntimeConfig();
  const provider = process.env.MAB_AGENT_RUNNER || "command";
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-local-dialog-"));
  const commandScript = pathJoin(dataDir, "dialog-agent-runner.mjs");
  await writeFile(
    commandScript,
    `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const job = JSON.parse(input);
  console.log(JSON.stringify({
    status: "completed",
    result: "本地 Agent provider 已处理：" + job.task,
  }));
});
`,
    "utf8",
  );
  const env = {
    MAB_MEETING_PORT: "18895",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18895",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    MAB_AGENT_RUNNER: provider,
    MAB_DRY_RUN_AGENT: config.dryRunAgent ? "1" : "",
    MAB_AGENT_COMMAND:
      provider === "command" ? `${process.execPath} ${commandScript}` : config.agentCommand,
    MAB_AGENT_HTTP_URL: config.agentHttpUrl,
    MAB_CODEX_BIN: config.codexBin,
    MAB_CODEX_MODEL: config.codexModel,
    MAB_STT_PROVIDER: "event",
    MAB_TTS_PROVIDER: "tone-wav",
  };
  const fixture = await startLocalMeetFixtureServer();
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18895/healthz");
    const utterance = "请用一句话说明本地 Agent provider 已接入会议。";
    const join = await postJson("http://127.0.0.1:18895/join/google-meet", {
      sessionId: "local_agent_dialog_smoke",
      meetUrl: `${fixture.url}?participantAudio=1`,
      botName: "Local Dialog Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installRealtimeBridge: false,
      installWorkerResultBridge: false,
      installLocalDialogBridge: true,
      localDialogTtsMode: "server",
      localDialogTtsUrl: "http://127.0.0.1:18895/tts/synthesize",
      localDialogSttProvider: "event",
      localDialogTtsProvider: "tone-wav",
      localDialogTtsGain: 0.42,
      localDialogAcceptanceUtterance: utterance,
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "local dialog smoke did not join fixture",
      join,
    );

    const status = await waitForJoinStatus(
      "http://127.0.0.1:18895/join/status",
      (body) => {
        const dialog = body.active?.localDialog;
        const avatar = body.active?.avatarReady?.avatarState;
        const audio = body.active?.avatarAudio;
        return (
          dialog?.turns?.some((turn) => {
            const responseText = String(turn.responseText || "");
            return (
              turn.status === "completed" &&
              turn.job?.provider === provider &&
              responseText.trim().length > 0 &&
              (provider !== "command" || responseText.includes("本地 Agent provider"))
            );
          }) &&
          dialog?.tts?.routedToAvatarBus === true &&
          (audio?.injectedTones > 0 || audio?.routedBuffers > 0) &&
          avatar?.updates?.some((update) => update.kind === "action" && update.action === "speak")
        );
      },
      12_000,
    );
    const workerJobs = await (await fetch("http://127.0.0.1:18895/worker/jobs")).json();
    const turn = status.active?.localDialog?.lastTurn;
    assertSmoke(
      turn?.job?.provider === provider,
      "local dialog did not use the selected provider",
      { expected: provider, turn },
    );
    assertSmoke(
      turn?.tts?.ok === true,
      "local dialog TTS did not route into the avatar fake mic bus",
      turn,
    );
    assertSmoke(
      status.active?.avatarAudio?.routedBuffers >= 1,
      "local dialog server TTS did not route a decoded audio buffer into the avatar fake mic",
      status.active?.avatarAudio,
    );
    assertSmoke(
      workerJobs.jobs?.some((job) => job.id === turn.job.id),
      "local dialog job was not recorded for reporting",
      workerJobs,
    );
    const stop = await postJson("http://127.0.0.1:18895/join/stop", {
      reason: "local_agent_dialog_smoke_done",
    });
    assertSmoke(stop.ok === true, "local dialog stop failed", stop);
    console.log(JSON.stringify({ ok: true, join, status, workerJobs, stop }, null, 2));
  } finally {
    await postJson("http://127.0.0.1:18895/join/stop", {
      reason: "local_agent_dialog_cleanup",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function captionLocalDialogSmoke() {
  const { chromium } = await import("playwright");
  const port = 18884;
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <body>
    <div role="region" aria-label="Captions" id="captions" style="padding:20px;border:1px solid #ddd"></div>
  </body>
</html>`);
      return;
    }
    if (req.method === "POST" && req.url === "/dialog/turn") {
      let body = "";
      req.setEncoding("utf8");
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || "{}");
      const utterance = String(parsed.utterance || "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          status: "completed",
          provider: "caption-smoke",
          responseText: `收到字幕:${utterance}`,
          job: {
            id: "job_caption_smoke",
            provider: "caption-smoke",
            status: "completed",
            result: `收到字幕:${utterance}`,
          },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript({
      content: `
window.MAB_AVATAR_AUDIO_BUS = {
  injectTone() { return { ok: true, durationMs: 800 }; },
  playAudioDataUrl() { return Promise.resolve({ ok: true, durationMs: 800 }); },
};
window.MAB_AVATAR_CONTROLLER = {
  updateState(update) { return { ok: true, update }; },
};
`,
    });
    await context.addInitScript({
      content: buildLocalDialogInitScript({
        enabled: true,
        sessionId: "caption_local_dialog_smoke",
        turnUrl: `http://127.0.0.1:${port}/dialog/turn`,
        ttsMode: "tone",
        sttProvider: "caption",
        ttsProvider: "browser-tone",
        botName: "Caption Smoke Bot",
      }),
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const capture = await installMeetCaptionCapture(page, {});
    await page.evaluate(
      ({ speaker, text }) => {
        const root = document.getElementById("captions");
        const entry = document.createElement("div");
        entry.style.padding = "8px";
        const speakerNode = document.createElement("div");
        speakerNode.className = "NWpY1d";
        speakerNode.textContent = speaker;
        const textNode = document.createElement("div");
        textNode.className = "ygicle";
        textNode.textContent = text;
        entry.appendChild(speakerNode);
        entry.appendChild(textNode);
        root.appendChild(entry);
      },
      { speaker: "Peng", text: "你好，这是测试字幕" },
    );
    await page.waitForFunction(
      () => {
        const dialog = window.MAB_LOCAL_DIALOG as
          | {
              utterancesReceived?: number;
              lastTurn?: { status?: string };
            }
          | null
          | undefined;
        return dialog?.utterancesReceived === 1 && dialog?.lastTurn?.status === "completed";
      },
      null,
      { timeout: 5_000 },
    );
    interface DialogTurnSnapshot {
      utterancesReceived?: number;
      lastTurn?: {
        status?: string;
        responseText?: string;
        tts?: { ok?: boolean; [key: string]: unknown };
        [key: string]: unknown;
      };
      [key: string]: unknown;
    }
    const first = (await page.evaluate(() => window.MAB_LOCAL_DIALOG)) as DialogTurnSnapshot | null;
    assertSmoke(
      String(first?.lastTurn?.responseText || "").includes("测试字幕"),
      "caption local dialog smoke did not preserve the caption text in the agent response",
      first,
    );
    assertSmoke(
      first?.lastTurn?.tts?.ok === true,
      "caption local dialog smoke did not route TTS",
      first?.lastTurn,
    );

    await page.evaluate(
      ({ speaker, text }) => {
        const root = document.getElementById("captions");
        const entry = document.createElement("div");
        entry.style.padding = "8px";
        const speakerNode = document.createElement("div");
        speakerNode.className = "NWpY1d";
        speakerNode.textContent = speaker;
        const textNode = document.createElement("div");
        textNode.className = "ygicle";
        textNode.textContent = text;
        entry.appendChild(speakerNode);
        entry.appendChild(textNode);
        root.appendChild(entry);
      },
      { speaker: "Caption Smoke Bot", text: "这条不该自激" },
    );
    await page.waitForTimeout(1_000);
    const second = await page.evaluate(() => ({
      dialog: window.MAB_LOCAL_DIALOG,
      capture: window.MAB_CAPTION_CAPTURE,
    }));
    assertSmoke(
      second.dialog?.utterancesReceived === 1,
      "caption local dialog smoke forwarded the bot's own caption and would self-loop",
      second,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          install: capture.install,
          firstTurn: first.lastTurn,
          finalUtterances: second.dialog?.utterancesReceived || 0,
          latestCaption: second.capture?.latest || null,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function realLocalDialogSmoke() {
  const config = getRuntimeConfig();
  const meetUrl = process.env.MAB_REAL_MEET_URL || "";
  if (!meetUrl) {
    const skipped = {
      ok: true,
      skipped: true,
      reason: "MAB_REAL_MEET_URL missing",
      note: "Set MAB_REAL_MEET_URL and MAB_REQUIRE_REAL_LOCAL_DIALOG=1 to make this optional smoke mandatory.",
    };
    if (process.env.MAB_REQUIRE_REAL_LOCAL_DIALOG === "1") {
      assertSmoke(
        false,
        "MAB_REAL_MEET_URL is required when MAB_REQUIRE_REAL_LOCAL_DIALOG=1",
        skipped,
      );
    }
    console.log(JSON.stringify(skipped, null, 2));
    return;
  }
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-real-local-dialog-"));
  const env = {
    MAB_MEETING_PORT: "18896",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18896",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    MAB_AGENT_RUNNER: config.agentRunner,
    MAB_DRY_RUN_AGENT: config.dryRunAgent ? "1" : "",
    MAB_AGENT_COMMAND: config.agentCommand,
    MAB_AGENT_HTTP_URL: config.agentHttpUrl,
    MAB_CODEX_BIN: config.codexBin,
    MAB_CODEX_MODEL: config.codexModel,
    MAB_STT_PROVIDER: config.sttProvider,
    MAB_TTS_PROVIDER: config.ttsProvider,
    MAB_TTS_COMMAND: config.ttsCommand,
    MAB_TTS_HTTP_URL: config.ttsHttpUrl,
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18896/healthz");
    const join = await postJson("http://127.0.0.1:18896/join/google-meet", {
      sessionId: "real_local_dialog_smoke",
      meetUrl,
      botName: "Local Dialog Bot",
      dryRun: false,
      collectFixtureState: false,
      disableLive2D: true,
      installRealtimeBridge: false,
      installWorkerResultBridge: false,
      installLocalDialogBridge: true,
      localDialogTtsMode: "server",
      localDialogTtsUrl: "http://127.0.0.1:18896/tts/synthesize",
      localDialogSttProvider: config.sttProvider,
      localDialogTtsProvider: config.ttsProvider,
      localDialogTtsGain: 0.35,
      localDialogAcceptanceUtterance: "请用一句话说明你已经通过本地 Agent provider 接入会议。",
    });
    assertSmoke(
      join.result?.clickedJoinSelector,
      "real local dialog smoke did not click a Meet join button",
      join,
    );
    const status = await waitForJoinStatus(
      "http://127.0.0.1:18896/join/status",
      (body) => {
        const dialog = body.active?.localDialog;
        const audio = body.active?.avatarAudio;
        return (
          dialog?.turns?.some((turn) => ["completed", "failed"].includes(turn.status)) &&
          audio?.injectedTones > 0
        );
      },
      40_000,
    );
    const turn = status.active?.localDialog?.lastTurn;
    const latestInventory = (join.result?.buttonInventories || []).at(-1) || {};
    const visibleButtonLabels = (latestInventory.buttons || [])
      .filter((button) => button.visible)
      .map((button) => button.aria || button.text || "")
      .filter(Boolean);
    const inCallControlsVisible = visibleButtonLabels.some(
      (label) =>
        /leave call|turn off microphone|turn off camera|microphone|camera/i.test(label) ||
        /退出|离开|離れる|マイク|カメラ|通話/.test(label),
    );
    assertSmoke(
      inCallControlsVisible,
      "real local dialog smoke did not observe in-call Meet controls; the room may be expired, blocked, or waiting for admit",
      { visibleButtonLabels, join, status },
    );
    assertSmoke(turn?.status === "completed", "real local dialog provider turn did not complete", {
      turn,
      status,
    });
    assertSmoke(
      turn?.tts?.ok === true,
      "real local dialog TTS did not route to avatar fake mic",
      turn,
    );
    const stop = await postJson("http://127.0.0.1:18896/join/stop", {
      reason: "real_local_dialog_smoke_done",
    });
    assertSmoke(stop.ok === true, "real local dialog stop failed", stop);
    console.log(
      JSON.stringify(
        { ok: true, join, status, visibleButtonLabels, inCallControlsVisible, stop },
        null,
        2,
      ),
    );
  } finally {
    await postJson("http://127.0.0.1:18896/join/stop", {
      reason: "real_local_dialog_cleanup",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function dialogProviderSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-dialog-provider-"));
  const env: Record<string, string> = {
    MAB_MEETING_PORT: "18897",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18897",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    MAB_AGENT_RUNNER: "command",
    MAB_TTS_PROVIDER: "tone-wav",
  };
  const commandScript = pathJoin(dataDir, "dialog-provider-agent.mjs");
  await writeFile(
    commandScript,
    `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const job = JSON.parse(input);
  console.log(JSON.stringify({
    status: "completed",
    result: "Dialog provider seam handled: " + job.task,
  }));
});
`,
    "utf8",
  );
  env.MAB_AGENT_COMMAND = `${process.execPath} ${commandScript}`;
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18897/healthz");
    const providers = await (await fetch("http://127.0.0.1:18897/dialog/providers")).json();
    assertSmoke(
      providers.tts?.provider === "tone-wav",
      "dialog provider route did not report the configured TTS provider",
      providers,
    );
    const tts = await postJson("http://127.0.0.1:18897/tts/synthesize", {
      text: "本地 TTS provider seam 已经准备好。",
      durationMs: 700,
    });
    assertSmoke(
      tts.ok === true && tts.audioDataUrl?.startsWith("data:audio/wav;base64,"),
      "TTS provider did not return a WAV data URL",
      tts,
    );
    const turn = await postJson("http://127.0.0.1:18897/dialog/turn", {
      sessionId: "dialog_provider_smoke",
      utterance: "请确认本地 dialog provider seam 工作正常。",
      timeoutMs: 8_000,
    });
    assertSmoke(turn.ok === true, "dialog turn route did not complete", turn);
    assertSmoke(
      turn.provider === "command",
      "dialog turn route did not use the configured AgentRunner",
      turn,
    );
    assertSmoke(
      turn.responseText.includes("Dialog provider seam handled"),
      "dialog turn did not return provider text",
      turn,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          providers,
          tts: { ...tts, audioDataUrl: `${tts.audioDataUrl.slice(0, 64)}...` },
          turn,
        },
        null,
        2,
      ),
    );
  } finally {
    meeting.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

function tinyWavBase64() {
  const sampleRate = 16_000;
  const sampleCount = 1600;
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + sampleCount * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.sin(2 * Math.PI * 440 * (index / sampleRate)) * 0.08;
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  }
  return buffer.toString("base64");
}

async function postMeetingSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-post-meeting-"));
  try {
    const pipeline = createMeetingArtifactPipeline({
      rootDir: pathJoin(dataDir, "artifacts"),
      asrProvider: "caption",
    });
    const result = await pipeline.postProcessMeeting({
      sessionId: "meet_post_smoke",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      title: "Post-meeting smoke",
      audioBase64: tinyWavBase64(),
      audioMimeType: "audio/wav",
      captions: [
        {
          speaker: "Operator",
          text: "We decided to use the legacy meeting recording shape.",
          timestamp: "2026-05-08T05:00:00.000Z",
        },
        {
          speaker: "Bot",
          text: "Action item: publish transcript and summary to Slack Canvas after the meeting.",
          timestamp: "2026-05-08T05:00:10.000Z",
        },
      ],
      chatMessages: [
        {
          direction: "incoming",
          sender: "Operator",
          text: "Please keep this Meet chat link: https://example.com/demo",
          timestamp: "2026-05-08T05:00:05.000Z",
          messageId: "chat-in-1",
          source: "observer",
        },
        {
          direction: "outgoing",
          sender: "Onee Sama",
          text: "I saw the demo link and will include it in the recap.",
          timestamp: "2026-05-08T05:00:06.000Z",
          messageId: "chat-out-1",
          deliveryState: "sent",
          source: "send_meet_chat",
        },
      ],
    });
    assertSmoke(result.ok === true, "post-meeting artifact pipeline failed", result);
    assertSmoke(
      result.artifact?.files?.audio && existsSync(result.artifact.files.audio),
      "post-meeting smoke did not write audio artifact",
      result.artifact,
    );
    assertSmoke(
      existsSync(result.artifact.files.transcript),
      "post-meeting smoke did not write transcript.json",
      result.artifact,
    );
    assertSmoke(
      existsSync(result.artifact.files.summary),
      "post-meeting smoke did not write summary.md",
      result.artifact,
    );
    assertSmoke(
      existsSync(result.artifact.files.chat),
      "post-meeting smoke did not write chat.json",
      result.artifact,
    );
    assertSmoke(
      result.transcript.segments.length === 2,
      "post-meeting smoke did not preserve caption segments",
      result.transcript,
    );
    assertSmoke(
      result.summary.decisions.length >= 1,
      "post-meeting smoke did not extract decisions",
      result.summary,
    );
    assertSmoke(
      result.chat.messageCount === 2,
      "post-meeting smoke did not preserve Meet chat messages",
      result.chat,
    );
    assertSmoke(
      result.chat.links.includes("https://example.com/demo"),
      "post-meeting smoke did not extract Meet chat links",
      result.chat,
    );
    const replayedChat = pipeline.getArtifactChat(result.artifact.id);
    assertSmoke(
      replayedChat?.messages?.length === 2,
      "post-meeting smoke could not replay chat.json",
      replayedChat,
    );
    assertSmoke(
      replayedChat.links.includes("https://example.com/demo"),
      "post-meeting replay lost Meet chat links",
      replayedChat,
    );

    const asrScript = pathJoin(dataDir, "chunk-asr-provider.mjs");
    await writeFile(
      asrScript,
      `
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
process.stdin.on("end", () => {
  const payload = JSON.parse(stdin || "{}");
  const index = payload.context?.chunkIndex ?? -1;
  const count = payload.context?.chunkCount ?? 0;
  console.log(JSON.stringify({
    ok: true,
    provider: "command",
    text: "chunk " + index + " of " + count + ": decision ship Slack Canvas after the meeting."
  }));
});
`,
      "utf8",
    );
    const recordingDir = pathJoin(dataDir, "recording-source");
    await mkdir(recordingDir, { recursive: true });
    const sourceAudio = pathJoin(recordingDir, "audio.wav");
    await writeFile(sourceAudio, Buffer.from(tinyWavBase64(), "base64"));
    const chunkA = pathJoin(recordingDir, "audio_chunk_000.mp3");
    const chunkB = pathJoin(recordingDir, "audio_chunk_001.mp3");
    await writeFile(chunkA, "fake mp3 chunk 0");
    await writeFile(chunkB, "fake mp3 chunk 1");
    const chunkPipeline = createMeetingArtifactPipeline({
      rootDir: pathJoin(dataDir, "chunk-artifacts"),
      asrProvider: "command",
      env: {
        ...process.env,
        MAB_ASR_COMMAND: `${JSON.stringify(process.execPath)} ${JSON.stringify(asrScript)}`,
      },
    });
    const chunked = await chunkPipeline.postProcessMeeting({
      sessionId: "meet_post_chunk_smoke",
      meetUrl: "https://meet.google.com/chunk-smoke",
      title: "Chunked ASR smoke",
      audioPath: sourceAudio,
      audioMimeType: "audio/wav",
    });
    assertSmoke(chunked.ok === true, "chunked ASR smoke failed", chunked);
    assertSmoke(
      chunked.asr.chunked === true,
      "chunked ASR smoke did not use chunked provider path",
      chunked.asr,
    );
    assertSmoke(
      chunked.asr.chunks.length === 2,
      "chunked ASR smoke did not process both chunks",
      chunked.asr,
    );
    assertSmoke(
      chunked.transcript.segments.length === 2,
      "chunked ASR smoke did not merge chunk transcript segments",
      chunked.transcript,
    );
    assertSmoke(
      chunked.transcript.text.includes("chunk 0") && chunked.transcript.text.includes("chunk 1"),
      "chunked ASR smoke lost chunk text",
      chunked.transcript,
    );
    assertSmoke(
      chunked.artifact.files.audioChunks.length === 2,
      "chunked ASR smoke did not record audio chunk files",
      chunked.artifact.files,
    );
    for (const chunkPath of chunked.artifact.files.audioChunks) {
      assertSmoke(
        existsSync(chunkPath),
        "chunked ASR smoke did not write chunk artifact",
        chunked.artifact.files,
      );
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          artifact: result.artifact,
          transcript: {
            provider: result.transcript.provider,
            segmentCount: result.transcript.segments.length,
          },
          chat: {
            messageCount: result.chat.messageCount,
            links: result.chat.links,
          },
          chunkedAsr: {
            provider: chunked.transcript.provider,
            chunkCount: chunked.asr.chunks.length,
            segmentCount: chunked.transcript.segments.length,
          },
          summary: result.summary,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function meetdApiCompatSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-meetd-api-"));
  const port = "18924";
  const baseUrl = `http://127.0.0.1:${port}`;
  const service = startService("apps/meeting-agent/src/index.js", {
    MAB_MEETING_PORT: port,
    MAB_MEETING_AGENT_URL: baseUrl,
    MAB_DATA_DIR: dataDir,
    MAB_DRY_RUN_AGENT: "1",
  });

  try {
    const health = await waitForServiceHealth(service, `${baseUrl}/health`);
    assertSmoke(health.status === "ok", "MeetD compat /health did not match old API", health);

    const create = await postJson(`${baseUrl}/meetings`, {
      event_id: "meetd-compat-event",
      meet_url: "https://meet.google.com/abc-defg-hij",
      title: "MeetD Compat Fixture",
      start_at: "2026-05-12T01:00:00.000Z",
      end_at: "2026-05-12T02:00:00.000Z",
      transcript_text: "Operator: 请验证 MeetD 兼容 API。\nOnee-sama: 收到。",
      captions: [
        {
          speaker: "Operator",
          text: "请验证 MeetD 兼容 API。",
          timestamp: "2026-05-12T01:00:10.000Z",
          source: "live_caption",
        },
        {
          speaker: "Onee-sama",
          text: "收到。",
          timestamp: "2026-05-12T01:00:20.000Z",
          source: "asr",
        },
      ],
    });
    assertSmoke(
      Number(create.meeting_id) > 0,
      "MeetD compat create did not return numeric meeting_id",
      create,
    );

    const duplicate = await postJson(`${baseUrl}/meetings`, {
      event_id: "meetd-compat-event",
      meet_url: "https://meet.google.com/abc-defg-hij",
      title: "MeetD Compat Fixture",
      start_at: "2026-05-12T01:00:00.000Z",
      end_at: "2026-05-12T02:00:00.000Z",
    });
    assertSmoke(
      duplicate.meeting_id === create.meeting_id,
      "MeetD compat create was not idempotent by event_id",
      { create, duplicate },
    );

    const detail = await (await fetch(`${baseUrl}/meetings/${create.meeting_id}`)).json();
    assertSmoke(
      detail.title === "MeetD Compat Fixture",
      "MeetD compat get meeting lost title",
      detail,
    );
    assertSmoke(detail.status === "pending", "MeetD compat new meeting was not pending", detail);

    const list = await (await fetch(`${baseUrl}/meetings?status=pending`)).json();
    assertSmoke(
      list.meetings?.some((meeting) => meeting.id === create.meeting_id),
      "MeetD compat list did not include pending meeting",
      list,
    );

    const liveCaptions = await (
      await fetch(`${baseUrl}/meetings/${create.meeting_id}/captions?limit=1`)
    ).json();
    assertSmoke(
      liveCaptions.source === "live_caption",
      "MeetD compat captions default source changed",
      liveCaptions,
    );
    assertSmoke(
      liveCaptions.returned_captions === 1,
      "MeetD compat captions limit was not honored",
      liveCaptions,
    );
    assertSmoke(
      liveCaptions.speakers.includes("Operator"),
      "MeetD compat captions did not preserve speakers",
      liveCaptions,
    );

    const allCaptions = await (
      await fetch(`${baseUrl}/meetings/${create.meeting_id}/captions?source=all`)
    ).json();
    assertSmoke(
      allCaptions.total_captions === 2,
      "MeetD compat all captions did not include live + asr",
      allCaptions,
    );

    const transcriptResponse = await fetch(
      `${baseUrl}/meetings/${create.meeting_id}/artifacts/transcript`,
    );
    const transcript = await transcriptResponse.text();
    assertSmoke(
      transcriptResponse.status === 200,
      "MeetD compat transcript artifact route failed",
      { status: transcriptResponse.status, transcript },
    );
    assertSmoke(transcript.includes("Onee-sama"), "MeetD compat transcript artifact lost content", {
      transcript,
    });

    const chat = await postJsonWithStatus(`${baseUrl}/meetings/${create.meeting_id}/chat`, {
      text: "fixture chat",
    });
    assertSmoke(
      chat.httpStatus === 404 && chat.error === "no active joiner for this meeting",
      "MeetD compat chat should fail closed without active joiner",
      chat,
    );

    const cancel = await postJson(`${baseUrl}/meetings/${create.meeting_id}/cancel`, {});
    assertSmoke(cancel.status === "cancelled", "MeetD compat cancel failed", cancel);
    const cancelled = await (await fetch(`${baseUrl}/meetings/${create.meeting_id}`)).json();
    assertSmoke(
      cancelled.status === "cancelled",
      "MeetD compat cancel did not persist status",
      cancelled,
    );

    const done = await postJson(`${baseUrl}/meetings`, {
      event_id: "meetd-compat-done-event",
      meet_url: "https://meet.google.com/red-eliv-erx",
      title: "MeetD Done Fixture",
      start_at: "2026-05-12T03:00:00.000Z",
      end_at: "2026-05-12T04:00:00.000Z",
      status: "done",
      result: { summary: { highlights: ["done"] } },
    });
    const redeliver = await postJson(`${baseUrl}/meetings/${done.meeting_id}/redeliver`, {});
    assertSmoke(redeliver.status === "redelivered", "MeetD compat redeliver failed", redeliver);
    const resummarize = await postJson(`${baseUrl}/meetings/${done.meeting_id}/resummarize`, {});
    assertSmoke(
      resummarize.status === "resummarizing",
      "MeetD compat resummarize failed",
      resummarize,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          health,
          meetingId: create.meeting_id,
          duplicate,
          detail,
          listCount: list.meetings?.length || 0,
          liveCaptions,
          allCaptions,
          chat,
          cancel,
          redeliver,
          resummarize,
        },
        null,
        2,
      ),
    );
  } finally {
    service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function meetdRuntimeStoreSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-meetd-runtime-"));
  const port = "18947";
  const baseUrl = `http://127.0.0.1:${port}`;
  const service = startService("apps/meeting-agent/src/index.js", {
    MAB_MEETING_PORT: port,
    MAB_MEETING_AGENT_URL: baseUrl,
    MAB_DATA_DIR: dataDir,
    MAB_STATE_PROVIDER: "json-file",
    MAB_DRY_RUN_AGENT: "1",
  });

  const now = new Date("2026-05-12T10:00:00.000Z");
  const iso = (offsetMs) => new Date(now.getTime() + offsetMs).toISOString();

  try {
    const health = await waitForServiceHealth(service, `${baseUrl}/healthz`);
    assertSmoke(
      health.state?.meetdRuntime?.pending === 0,
      "MeetD runtime health did not expose empty pending count",
      health,
    );

    const ready = await postJson(`${baseUrl}/meetings`, {
      event_id: "runtime-ready-event",
      meet_url: "https://meet.google.com/runtime-ready",
      title: "Runtime Ready",
      start_at: iso(5_000),
      end_at: iso(60 * 60 * 1000),
      slack_channel_id: "C_RUNTIME",
      slack_thread_ts: "1770000000.000001",
    });
    assertSmoke(
      Number(ready.meeting_id) > 0 && ready.created === true,
      "MeetD runtime ready meeting was not created",
      ready,
    );

    const duplicateEvent = await postJson(`${baseUrl}/meetings`, {
      event_id: "runtime-ready-event",
      meet_url: "https://meet.google.com/runtime-ready",
      title: "Runtime Ready Duplicate",
      start_at: iso(5_000),
      end_at: iso(60 * 60 * 1000),
    });
    assertSmoke(
      duplicateEvent.meeting_id === ready.meeting_id && duplicateEvent.idempotent === "event_id",
      "MeetD runtime store did not de-dupe by event_id",
      { ready, duplicateEvent },
    );

    const duplicateUrl = await postJson(`${baseUrl}/meetings`, {
      event_id: "runtime-ready-other-event",
      meet_url: "https://meet.google.com/runtime-ready",
      title: "Runtime Ready URL Duplicate",
      start_at: iso(2 * 60 * 1000),
      end_at: iso(62 * 60 * 1000),
    });
    assertSmoke(
      duplicateUrl.meeting_id === ready.meeting_id &&
        duplicateUrl.idempotent === "meet_url_start_window",
      "MeetD runtime store did not de-dupe active URL/start window",
      { ready, duplicateUrl },
    );

    const future = await postJson(`${baseUrl}/meetings`, {
      event_id: "runtime-future-event",
      meet_url: "https://meet.google.com/runtime-future",
      title: "Runtime Future",
      start_at: iso(10 * 60 * 1000),
      end_at: iso(70 * 60 * 1000),
    });
    const missed = await postJson(`${baseUrl}/meetings`, {
      event_id: "runtime-missed-event",
      meet_url: "https://meet.google.com/runtime-missed",
      title: "Runtime Missed",
      start_at: iso(-10 * 60 * 1000),
      end_at: iso(50 * 60 * 1000),
    });
    const active = await postJson(`${baseUrl}/meetings`, {
      event_id: "runtime-active-event",
      meet_url: "https://meet.google.com/runtime-active",
      title: "Runtime Active",
      start_at: iso(-30_000),
      end_at: iso(50 * 60 * 1000),
      status: "active",
    });
    const processing = await postJson(`${baseUrl}/meetings`, {
      event_id: "runtime-processing-event",
      meet_url: "https://meet.google.com/runtime-processing",
      title: "Runtime Processing",
      start_at: iso(-30_000),
      end_at: iso(50 * 60 * 1000),
      status: "processing",
    });

    const statusBefore = await (await fetch(`${baseUrl}/meetings/runtime/status`)).json();
    assertSmoke(
      statusBefore.counts.pending === 3,
      "MeetD runtime status should see ready/future/missed pending",
      statusBefore,
    );
    assertSmoke(
      statusBefore.counts.active === 1,
      "MeetD runtime status should see one active meeting",
      statusBefore,
    );
    assertSmoke(
      statusBefore.counts.processing === 1,
      "MeetD runtime status should see one processing meeting",
      statusBefore,
    );

    const tick = await postJson(`${baseUrl}/meetings/runtime/tick`, {
      now: now.toISOString(),
      stale_ms: -1,
      dry_run_joiner: true,
    });
    assertSmoke(tick.ok === true, "MeetD runtime tick failed", tick);
    assertSmoke(
      tick.ready.some(
        (item) =>
          item.meeting_id === ready.meeting_id &&
          item.action === "join_planned" &&
          item.status === "joining",
      ),
      "MeetD runtime did not claim ready meeting for join",
      tick.ready,
    );
    assertSmoke(
      tick.ready.some(
        (item) =>
          item.meeting_id === future.meeting_id &&
          item.action === "not_ready" &&
          item.status === "pending",
      ),
      "MeetD runtime did not leave future meeting pending",
      tick.ready,
    );
    assertSmoke(
      tick.ready.some(
        (item) =>
          item.meeting_id === missed.meeting_id &&
          item.action === "cancelled" &&
          item.status === "cancelled",
      ),
      "MeetD runtime did not cancel missed start-window meeting",
      tick.ready,
    );
    assertSmoke(
      tick.cleaned.some(
        (meeting) =>
          meeting.id === active.meeting_id &&
          meeting.status === "failed" &&
          meeting.error === "daemon restart",
      ),
      "MeetD runtime stale cleanup did not fail old active meeting",
      tick.cleaned,
    );
    assertSmoke(
      tick.recovered.some(
        (meeting) =>
          meeting.id === processing.meeting_id &&
          meeting.status === "processing" &&
          meeting.recovery_requested === true,
      ),
      "MeetD runtime did not mark processing meeting for recovery",
      tick.recovered,
    );

    const readyDetail = await (await fetch(`${baseUrl}/meetings/${ready.meeting_id}`)).json();
    const futureDetail = await (await fetch(`${baseUrl}/meetings/${future.meeting_id}`)).json();
    const missedDetail = await (await fetch(`${baseUrl}/meetings/${missed.meeting_id}`)).json();
    const activeDetail = await (await fetch(`${baseUrl}/meetings/${active.meeting_id}`)).json();
    const processingDetail = await (
      await fetch(`${baseUrl}/meetings/${processing.meeting_id}`)
    ).json();
    assertSmoke(
      readyDetail.status === "joining",
      "MeetD runtime ready detail did not persist joining",
      readyDetail,
    );
    assertSmoke(
      futureDetail.status === "pending",
      "MeetD runtime future detail did not persist pending",
      futureDetail,
    );
    assertSmoke(
      missedDetail.status === "cancelled",
      "MeetD runtime missed detail did not persist cancelled",
      missedDetail,
    );
    assertSmoke(
      activeDetail.status === "failed" && activeDetail.error === "daemon restart",
      "MeetD runtime stale detail did not persist failed",
      activeDetail,
    );
    assertSmoke(
      processingDetail.recovery_requested === true,
      "MeetD runtime processing recovery flag did not persist",
      processingDetail,
    );

    const statusAfter = await (await fetch(`${baseUrl}/meetings/runtime/status`)).json();
    assertSmoke(
      statusAfter.counts.joining === 1,
      "MeetD runtime status after tick should count joining",
      statusAfter,
    );
    assertSmoke(
      statusAfter.counts.pending === 1,
      "MeetD runtime status after tick should keep one future pending",
      statusAfter,
    );
    assertSmoke(
      statusAfter.counts.cancelled === 1,
      "MeetD runtime status after tick should count cancelled",
      statusAfter,
    );
    assertSmoke(
      statusAfter.counts.failed === 1,
      "MeetD runtime status after tick should count failed",
      statusAfter,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          health: health.state.meetdRuntime,
          ready,
          duplicateEvent,
          duplicateUrl,
          tick,
          statusAfter: statusAfter.counts,
        },
        null,
        2,
      ),
    );
  } finally {
    service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function digestWebhookSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-digest-webhook-"));
  const receiverPort = 18925;
  const meetingPort = 18926;
  const slackPort = 18927;
  const secret = "digest-webhook-smoke-secret";
  const received = [];
  let slack = null;
  const receiver = createJsonServer({
    name: "digest-webhook-smoke-receiver",
    port: receiverPort,
    routes: {
      "POST /digest": ({ req, rawBody, body }) => {
        const headerValue = req.headers["x-webhook-signature"];
        const signature = Array.isArray(headerValue) ? headerValue[0] || "" : headerValue || "";
        const signatureValid = verifyDigestWebhookSignature(rawBody, signature, secret);
        received.push({
          signatureValid,
          event: body.event,
          meetingId: body.meeting_id,
          title: body.title,
          transcript: body.transcript || "",
          chatTranscript: body.chat_transcript || "",
        });
        if (received.length === 1)
          return { status: 503, body: { ok: false, error: "intentional_retry_probe" } };
        return { ok: true, count: received.length };
      },
      "GET /received": () => ({ ok: true, received }),
    },
  });
  await receiver.listen();
  const meeting = startService("apps/meeting-agent/src/index.js", {
    MAB_MEETING_PORT: String(meetingPort),
    MAB_MEETING_AGENT_URL: `http://127.0.0.1:${meetingPort}`,
    MAB_DATA_DIR: dataDir,
    MAB_DIGEST_WEBHOOK_URL: `http://127.0.0.1:${receiverPort}/digest`,
    MAB_DIGEST_WEBHOOK_SECRET: secret,
    MAB_DIGEST_WEBHOOK_MAX_ATTEMPTS: "3",
    MAB_DIGEST_WEBHOOK_RETRY_DELAY_MS: "5",
    MAB_DRY_RUN_AGENT: "1",
  });

  try {
    await waitForServiceHealth(meeting, `http://127.0.0.1:${meetingPort}/healthz`);
    const done = await postJson(`http://127.0.0.1:${meetingPort}/meetings`, {
      event_id: "digest-webhook-result",
      meet_url: "https://meet.google.com/dig-esth-mac",
      title: "Digest Webhook Smoke",
      start_at: "2026-05-12T05:00:00.000Z",
      end_at: "2026-05-12T06:00:00.000Z",
      status: "done",
      result: { summary: { highlights: ["webhook redeliver"] } },
    });
    const redeliver = await postJson(
      `http://127.0.0.1:${meetingPort}/meetings/${done.meeting_id}/redeliver`,
      {},
    );
    assertSmoke(
      redeliver.status === "redelivered",
      "digest webhook redeliver did not report redelivered",
      redeliver,
    );
    assertSmoke(
      redeliver.webhook?.attempts === 2,
      "digest webhook redeliver did not retry after transient failure",
      redeliver,
    );
    assertSmoke(
      received.length === 2 && received.every((item) => item.signatureValid),
      "digest webhook receiver did not verify HMAC signatures",
      received,
    );
    assertSmoke(
      received.at(-1)?.event === "meeting.result",
      "digest webhook redeliver sent wrong event",
      received,
    );

    const digest = await postJson(
      `http://127.0.0.1:${meetingPort}/meetings/${done.meeting_id}/digest`,
      {
        transcript: "Operator: 继续迁移 MeetD digest webhook。",
        chat_transcript: "Operator: 看日志，别乱来。",
        time_from: "2026-05-12T05:10:00.000Z",
        time_to: "2026-05-12T05:15:00.000Z",
      },
    );
    assertSmoke(
      digest.status === "digest_delivered",
      "digest webhook live digest delivery failed",
      digest,
    );
    assertSmoke(
      received.at(-1)?.event === "meeting.digest",
      "digest webhook digest route sent wrong event",
      received,
    );
    assertSmoke(
      received.at(-1)?.transcript.includes("MeetD digest webhook"),
      "digest webhook payload lost transcript",
      received.at(-1),
    );

    const listed = await (await fetch(`http://127.0.0.1:${receiverPort}/received`)).json();
    assertSmoke(
      listed.received.length === 3,
      "digest webhook receiver did not record all attempts",
      listed,
    );

    slack = startService("apps/slack-agent/src/index.js", {
      MAB_SLACK_PORT: String(slackPort),
      MAB_DATA_DIR: dataDir,
      MAB_DIGEST_WEBHOOK_SECRET: secret,
      MAB_SLACK_POSTER_MOCK: "1",
      MAB_SLACK_API_MOCK: "1",
      MAB_DRY_RUN_AGENT: "1",
    });
    await waitForServiceHealth(slack, `http://127.0.0.1:${slackPort}/healthz`);
    const sendSlackWebhook = async (payload) => {
      const raw = JSON.stringify(payload);
      const response = await fetch(`http://127.0.0.1:${slackPort}/webhooks/meeting-digest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": computeDigestWebhookSignature(raw, secret),
        },
        body: raw,
      });
      return { httpStatus: response.status, ...(await response.json()) };
    };
    const slackPayload = JSON.stringify({
      event: "meeting.digest",
      meeting_id: done.meeting_id,
      title: "Digest Webhook Smoke",
      transcript: "Slack Agent receiver should verify this signature.",
    });
    const invalidSlackReceiver = await fetch(
      `http://127.0.0.1:${slackPort}/webhooks/meeting-digest`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-signature": "00" },
        body: slackPayload,
      },
    );
    assertSmoke(
      invalidSlackReceiver.status === 401,
      "Slack Agent digest receiver accepted bad HMAC",
      { status: invalidSlackReceiver.status },
    );
    const validSlackReceiver = await fetch(
      `http://127.0.0.1:${slackPort}/webhooks/meeting-digest`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": computeDigestWebhookSignature(slackPayload, secret),
        },
        body: slackPayload,
      },
    );
    const validSlackBody = await validSlackReceiver.json();
    assertSmoke(
      validSlackReceiver.status === 202 &&
        validSlackBody.ok === true &&
        validSlackBody.delivery?.copilotQueued === false &&
        validSlackBody.delivery?.skippedReason === "meeting_copilot_disabled_realtime_foreground",
      "Slack Agent digest receiver rejected valid HMAC or failed to disable legacy copilot digest",
      validSlackBody,
    );

    const slackRef = { channel_id: "C_MEET_WEBHOOK", thread_ts: "1715600000.000100" };
    const joinedDelivery = await sendSlackWebhook({
      event: "meeting.joined",
      meeting_id: done.meeting_id,
      title: "Digest Webhook Smoke",
      slack_ref: slackRef,
    });
    assertSmoke(
      joinedDelivery.httpStatus === 200 && joinedDelivery.ok === true,
      "Slack Agent joined webhook failed",
      joinedDelivery,
    );
    assertSmoke(
      joinedDelivery.delivery?.post?.mock === true,
      "Slack Agent joined webhook did not post joined notice",
      joinedDelivery,
    );

    const joinedStatus = await (
      await fetch(`http://127.0.0.1:${slackPort}/slack/assistant/status`)
    ).json();
    assertSmoke(
      joinedStatus.threads.some((thread) => thread.lastStatus === "Recording meeting..."),
      "Slack Agent joined webhook did not set Recording meeting assistant status",
      joinedStatus,
    );

    const processingDelivery = await sendSlackWebhook({
      event: "meeting.processing",
      meeting_id: done.meeting_id,
      title: "Digest Webhook Smoke",
    });
    assertSmoke(
      processingDelivery.httpStatus === 200 && processingDelivery.ok === true,
      "Slack Agent processing webhook failed",
      processingDelivery,
    );
    assertSmoke(
      processingDelivery.delivery?.slackRef?.source === "meeting_thread",
      "Slack Agent processing webhook did not resolve stored meeting thread",
      processingDelivery,
    );
    const processingStatus = await (
      await fetch(`http://127.0.0.1:${slackPort}/slack/assistant/status`)
    ).json();
    assertSmoke(
      processingStatus.threads.some(
        (thread) => thread.lastStatus === "Generating meeting summary...",
      ),
      "Slack Agent processing webhook did not set Generating meeting summary assistant status",
      processingStatus,
    );

    const resultPayload = {
      event: "meeting.result",
      meeting_id: done.meeting_id,
      title: "Digest Webhook Smoke",
      status: "done",
      summary: {
        title: "Digest Webhook Smoke",
        attendees: ["Operator", "Onee-sama"],
        duration_minutes: 12,
        key_points: ["Slack-side webhook delivery works."],
        decisions: ["Keep HMAC verification before delivery."],
        action_items: [{ description: "Review task #121", owner: "Operator" }],
      },
      artifacts: {
        transcript_path: "/tmp/digest-webhook-transcript.txt",
        audio_path: "/tmp/digest-webhook-audio.wav",
      },
    };
    const resultDelivery = await sendSlackWebhook(resultPayload);
    assertSmoke(
      resultDelivery.httpStatus === 202 && resultDelivery.ok === true,
      "Slack Agent result webhook failed",
      resultDelivery,
    );
    assertSmoke(
      resultDelivery.delivery?.slackRef?.source === "meeting_thread",
      "Slack Agent result webhook did not resolve stored meeting thread",
      resultDelivery,
    );
    assertSmoke(
      resultDelivery.delivery?.published?.slack?.mock === true,
      "Slack Agent result webhook did not publish Slack summary",
      resultDelivery,
    );
    assertSmoke(
      resultDelivery.delivery?.delivery?.status === "processed",
      "Slack Agent result webhook did not confirm durable delivery",
      resultDelivery,
    );

    const duplicateDelivery = await sendSlackWebhook(resultPayload);
    assertSmoke(
      duplicateDelivery.httpStatus === 202 && duplicateDelivery.delivery?.duplicate === true,
      "Slack Agent duplicate result webhook did not dedupe",
      duplicateDelivery,
    );

    const failedDelivery = await sendSlackWebhook({
      event: "meeting.result",
      meeting_id: Number(done.meeting_id) + 1,
      title: "Failed Digest Webhook Smoke",
      status: "failed",
      error: "join failed",
      slack_ref: slackRef,
    });
    assertSmoke(
      failedDelivery.httpStatus === 202 && failedDelivery.ok === true,
      "Slack Agent failed result webhook did not accept failure payload",
      failedDelivery,
    );
    assertSmoke(
      failedDelivery.delivery?.post?.sourceText?.includes("join failed"),
      "Slack Agent failed result webhook did not post failure text",
      failedDelivery,
    );

    const slackReceived = await (
      await fetch(`http://127.0.0.1:${slackPort}/webhooks/meeting-digest`)
    ).json();
    assertSmoke(
      slackReceived.webhooks.length === 6,
      "Slack Agent digest receiver did not record verified webhook state transitions",
      slackReceived,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          redeliver,
          digest,
          received: listed.received,
          slackReceiver: slackReceived,
          joinedDelivery,
          processingDelivery,
          resultDelivery,
          duplicateDelivery,
          failedDelivery,
        },
        null,
        2,
      ),
    );
  } finally {
    if (slack) slack.child.kill("SIGTERM");
    meeting.child.kill("SIGTERM");
    await new Promise((resolve) => receiver.server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function meetingCopilotSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-meeting-copilot-"));
  const slackPort = 18928;
  const secret = "meeting-copilot-smoke-secret";
  const slack = startService("apps/slack-agent/src/index.js", {
    MAB_SLACK_PORT: String(slackPort),
    MAB_DATA_DIR: dataDir,
    MAB_DIGEST_WEBHOOK_SECRET: secret,
    MAB_SLACK_POSTER_MOCK: "1",
    MAB_SLACK_API_MOCK: "1",
    MAB_AGENT_RUNNER: "codex-app-server",
    MAB_DRY_RUN_CODEX: "1",
  });
  const sendSlackWebhook = async (payload) => {
    const raw = JSON.stringify(payload);
    const response = await fetch(`http://127.0.0.1:${slackPort}/webhooks/meeting-digest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": computeDigestWebhookSignature(raw, secret),
      },
      body: raw,
    });
    return { httpStatus: response.status, ...(await response.json()) };
  };

  try {
    await waitForServiceHealth(slack, `http://127.0.0.1:${slackPort}/healthz`);
    const meetingId = 4242;
    const firstDigest = await sendSlackWebhook({
      event: "meeting.digest",
      meeting_id: meetingId,
      title: "Meeting Copilot Smoke",
      transcript: ["Operator: Onee-sama，帮我记一下这个决定。", "Onee-sama: 收到。"].join("\n"),
      chat_transcript: "Operator: 这个链接也记一下 https://example.com/demo",
      time_from: "2026-05-12T02:00:00.000Z",
      time_to: "2026-05-12T02:05:00.000Z",
      copilot_effects: [{ type: "meeting_chat", text: "收到，我会记录这个决定。" }],
    });
    assertSmoke(
      firstDigest.httpStatus === 202 &&
        firstDigest.delivery?.copilotQueued === false &&
        firstDigest.delivery?.skippedReason === "meeting_copilot_disabled_realtime_foreground",
      "meeting copilot digest was not disabled for realtime foreground ownership",
      firstDigest,
    );

    const duplicateDigest = await sendSlackWebhook({
      event: "meeting.digest",
      meeting_id: meetingId,
      title: "Meeting Copilot Smoke",
      transcript: ["Operator: Onee-sama，帮我记一下这个决定。", "Onee-sama: 收到。"].join("\n"),
      chat_transcript: "Operator: 这个链接也记一下 https://example.com/demo",
      time_from: "2026-05-12T02:00:00.000Z",
      time_to: "2026-05-12T02:05:00.000Z",
    });
    assertSmoke(
      duplicateDigest.httpStatus === 202 &&
        duplicateDigest.delivery?.copilotQueued === false &&
        duplicateDigest.delivery?.skippedReason === "meeting_copilot_disabled_realtime_foreground",
      "meeting copilot duplicate digest was not disabled",
      duplicateDigest,
    );

    const cooldownDigest = await sendSlackWebhook({
      event: "meeting.digest",
      meeting_id: meetingId,
      title: "Meeting Copilot Smoke",
      transcript: [
        "Operator: Onee-sama，帮我记一下这个决定。",
        "Onee-sama: 收到。",
        "Operator: 嗯，继续。",
      ].join("\n"),
      chat_transcript: "Operator: 这个链接也记一下 https://example.com/demo",
      time_from: "2026-05-12T02:05:00.000Z",
      time_to: "2026-05-12T02:06:00.000Z",
    });
    assertSmoke(
      cooldownDigest.delivery?.copilotQueued === false &&
        cooldownDigest.delivery?.skippedReason === "meeting_copilot_disabled_realtime_foreground",
      "meeting copilot chatter digest was not disabled",
      cooldownDigest,
    );

    const followUpDigest = await sendSlackWebhook({
      event: "meeting.digest",
      meeting_id: meetingId,
      title: "Meeting Copilot Smoke",
      transcript: [
        "Operator: Onee-sama，帮我记一下这个决定。",
        "Onee-sama: 收到。",
        "Operator: 嗯，继续。",
        "Operator: bot 能不能同步一下结论？",
      ].join("\n"),
      chat_transcript: "Operator: 这个链接也记一下 https://example.com/demo",
      time_from: "2026-05-12T02:06:00.000Z",
      time_to: "2026-05-12T02:08:00.000Z",
    });
    assertSmoke(
      followUpDigest.delivery?.copilotQueued === false &&
        followUpDigest.delivery?.skippedReason === "meeting_copilot_disabled_realtime_foreground",
      "meeting copilot explicit follow-up digest was not disabled",
      followUpDigest,
    );

    const resultDelivery = await sendSlackWebhook({
      event: "meeting.result",
      meeting_id: meetingId,
      title: "Meeting Copilot Smoke",
      status: "failed",
      error: "smoke ended",
      slack_ref: { channel_id: "C_MEET_COPILOT", thread_ts: "1715600000.000200" },
    });
    assertSmoke(
      resultDelivery.httpStatus === 202 && resultDelivery.delivery?.copilotStop?.stopped === true,
      "meeting result did not stop copilot runner",
      resultDelivery,
    );

    const status = await (
      await fetch(`http://127.0.0.1:${slackPort}/webhooks/meeting-copilot/status`)
    ).json();
    const state = status.states.find((entry) => String(entry.meetingId) === String(meetingId));
    assertSmoke(
      state?.stopped === true,
      "meeting copilot status did not retain stopped state",
      status,
    );
    assertSmoke(!state?.priorActions?.length, "disabled meeting copilot should not retain actions", status);
    assertSmoke(!state?.runs?.length, "disabled meeting copilot should not record queued runs", status);

    console.log(
      JSON.stringify(
        {
          ok: true,
          firstDigest,
          duplicateDigest,
          cooldownDigest,
          followUpDigest,
          resultDelivery,
          status,
        },
        null,
        2,
      ),
    );
  } finally {
    slack.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function canvasPublisherSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-canvas-publisher-"));
  try {
    const pipeline = createMeetingArtifactPipeline({
      rootDir: pathJoin(dataDir, "artifacts"),
      asrProvider: "caption",
    });
    const processed = await pipeline.postProcessMeeting({
      sessionId: "meet_canvas_smoke",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      title: "Canvas publisher smoke",
      captions: [
        {
          speaker: "Operator",
          text: "Decision: keep legacy project read-only.",
          timestamp: "2026-05-08T05:01:00.000Z",
        },
        {
          speaker: "Bot",
          text: "Action item: send the post-meeting report to Slack Canvas.",
          timestamp: "2026-05-08T05:01:10.000Z",
        },
      ],
    });
    const publisher = createCanvasPublisher({
      provider: "file",
      outDir: pathJoin(dataDir, "canvas"),
      env: { ...process.env, MAB_SLACK_POSTER_MOCK: "1" },
    });
    const published = await publisher.publish({
      artifact: processed.artifact,
      channel: "C_SMOKE",
      threadTs: "1710000000.000000",
    });
    assertSmoke(published.ok === true, "canvas publisher smoke failed", published);
    assertSmoke(
      existsSync(published.markdownPath),
      "canvas publisher did not write markdown payload",
      published,
    );
    assertSmoke(
      existsSync(published.manifestPath),
      "canvas publisher did not write manifest",
      published,
    );
    assertSmoke(
      (published.slack as { mock?: boolean } | null)?.mock === true,
      "canvas publisher did not use Slack-thread fallback in mock mode",
      published,
    );
    assertSmoke(
      publisher.listPublished().length === 1,
      "canvas publisher did not list published manifest",
      publisher.listPublished(),
    );

    const slackPort = 18946;
    const slackUrl = `http://127.0.0.1:${slackPort}`;
    const serviceCanvasDir = pathJoin(dataDir, "service-canvas");
    const slack = startService("apps/slack-agent/src/index.js", {
      MAB_SLACK_PORT: String(slackPort),
      MAB_DATA_DIR: pathJoin(dataDir, "service-data"),
      MAB_CANVAS_DIR: serviceCanvasDir,
      MAB_CANVAS_PUBLISHER: "file",
      MAB_SLACK_POSTER_MOCK: "1",
      MAB_DRY_RUN_AGENT: "1",
      SLACK_SIGNING_SECRET: "canvas-publisher-smoke-signing-secret",
    });
    let servicePublished = null;
    let serviceCanvas = null;
    try {
      await waitForServiceHealth(slack, `${slackUrl}/healthz`);
      servicePublished = await postJsonWithStatus(`${slackUrl}/post-meeting/publish`, {
        artifact: processed.artifact,
        channel: "C_SMOKE",
        threadTs: "1710000000.000000",
        destination: "post-meeting",
        dedupKey: `post-meeting:${processed.artifact.id}:smoke`,
      });
      assertSmoke(
        servicePublished.httpStatus === 200 && servicePublished.ok === true,
        "Slack Agent post-meeting publish route failed",
        servicePublished,
      );
      assertSmoke(
        servicePublished.published?.slack?.mock === true,
        "Slack Agent post-meeting route did not use mock Slack delivery",
        servicePublished,
      );
      assertSmoke(
        existsSync(servicePublished.published.markdownPath),
        "Slack Agent post-meeting route did not write markdown",
        servicePublished,
      );

      serviceCanvas = await postJsonWithStatus(`${slackUrl}/canvas/publish`, {
        artifact: processed.artifact,
        destination: "canvas",
      });
      assertSmoke(
        serviceCanvas.httpStatus === 200 && serviceCanvas.ok === true,
        "Slack Agent canvas publish route failed",
        serviceCanvas,
      );
      assertSmoke(
        serviceCanvas.published?.surface === "file",
        "Slack Agent canvas route did not use file Canvas publisher",
        serviceCanvas,
      );
      assertSmoke(
        existsSync(serviceCanvas.published.markdownPath),
        "Slack Agent canvas route did not write markdown",
        serviceCanvas,
      );

      const listed = await (await fetch(`${slackUrl}/canvas/published`)).json();
      assertSmoke(
        listed.published.length === 2,
        "Slack Agent did not list both published summary deliveries",
        listed,
      );
    } finally {
      slack.child.kill("SIGTERM");
    }

    console.log(
      JSON.stringify(
        { ok: true, artifact: processed.artifact, published, servicePublished, serviceCanvas },
        null,
        2,
      ),
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function slackMrkdwnRendererSmoke() {
  const table = "| Name | Status |\n| --- | --- |\n| Alice | Done |\n| Bob | Pending |";
  const tableWant = "• *Name*: Alice  ·  *Status*: Done\n• *Name*: Bob  ·  *Status*: Pending";
  assertSmoke(
    markdownToMrkdwn("this is **bold** and *italic*") === "this is *bold* and _italic_",
    "Markdown emphasis did not convert to Slack mrkdwn",
  );
  assertSmoke(
    markdownToMrkdwn("check [Spec](https://example.com)") === "check <https://example.com|Spec>",
    "Markdown link did not convert to Slack link",
  );
  assertSmoke(
    markdownToMrkdwn("## Summary\n- **Action**") === "*Summary*\n• *Action*",
    "Headers/lists did not convert to Slack mrkdwn",
  );
  assertSmoke(
    markdownToMrkdwn(table) === tableWant,
    "Markdown table did not collapse to Slack bullets",
    { got: markdownToMrkdwn(table) },
  );
  assertSmoke(
    markdownToMrkdwn("use `**literal**` and **real**") === "use `**literal**` and *real*",
    "Inline code was not preserved during mrkdwn conversion",
  );
  assertSmoke(
    markdownishToMrkdwn(":calendar: *Already Slack bold*\n[Open](https://example.com)") ===
      ":calendar: *Already Slack bold*\n<https://example.com|Open>",
    "Markdownish conversion did not preserve existing Slack mrkdwn",
  );
  assertSmoke(
    markdownToSlackFallbackText("See **status** in [Linear](https://linear.app).") ===
      "See *status* in <https://linear.app|Linear>.",
    "Slack fallback text did not convert markdown",
  );
  const blocks = markdownToBlocks(
    "# Project Status\n\nCore features are done.\n\n---\n\n## Next\n- **Fix** auth",
  ) as Array<{ type?: string; text?: { text?: string } }>;
  assertSmoke(blocks[0]?.type === "header", "Markdown heading did not become header block", blocks);
  assertSmoke(
    blocks.some((block) => block.type === "divider"),
    "Markdown horizontal rule did not become divider block",
    blocks,
  );
  assertSmoke(
    blocks.some((block) => block.type === "section" && block.text?.text?.includes("• *Fix* auth")),
    "Markdown body did not become mrkdwn section",
    blocks,
  );
  const chunks = markdownToBlocks(`## Long\n${"a".repeat(3100)}`) as Array<{
    type?: string;
    text?: { text?: string };
  }>;
  assertSmoke(
    chunks.filter((block) => block.type === "section").length >= 2,
    "Long mrkdwn body was not chunked",
    chunks,
  );
  assertSmoke(
    htmlToMarkdown(`<p>Hello <a href="https://example.com">world</a></p>`) ===
      "Hello [world](https://example.com)",
    "HTML link did not convert to Markdown",
  );

  const poster = createSlackPoster({ mock: true });
  const post = await poster.postMessage({
    channel: "C_SMOKE",
    text: "# Worker Result\n\n- **Status**: Done\n- [Open](https://example.com)",
    dedupKey: "mrkdwn-renderer-smoke",
  });
  assertSmoke(post.ok === true && post.mock === true, "Mock Slack poster failed", post);
  assertSmoke(
    post.message?.text?.includes("*Status*"),
    "Poster fallback text did not render mrkdwn",
    post,
  );
  assertSmoke(
    (post.message?.blocks?.[0] as { type?: string } | undefined)?.type === "header",
    "Poster did not auto-build blocks from markdown",
    post,
  );

  console.log(JSON.stringify({ ok: true, table: tableWant, blocks, chunks, post }, null, 2));
}

async function slackAssistantScheduleSmoke() {
  const definitions = [
    {
      id: "keep-metadata",
      name: "Current thread via metadata",
      prompt: "Summarize this thread.",
      metadata: {
        slack_channel_id: "C123",
        slack_thread_ts: "1700000000.123456",
      },
      cron_expr: "0 9 * * 1",
      timezone: "Asia/Shanghai",
      is_paused: false,
      created_at: "2026-05-12T00:00:00.000Z",
      updated_at: "2026-05-12T00:00:00.000Z",
    },
    {
      id: "keep-legacy",
      name: "Current thread via legacy prompt",
      prompt:
        "Summarize this thread.\n\n[Context] This schedule was created in channel=C123 thread_ts=1700000000.123456. When posting results, use slack_api to deliver to the appropriate channel/thread. Your text output alone is NOT delivered to Slack.",
      cron_expr: "0 10 * * *",
      timezone: "Asia/Shanghai",
      is_paused: false,
    },
    {
      id: "drop-other-thread",
      name: "Other thread",
      prompt: "Summarize another thread.",
      metadata: {
        slack_channel_id: "C123",
        slack_thread_ts: "1700000001.123456",
      },
      cron_expr: "0 11 * * *",
      timezone: "Asia/Shanghai",
      is_paused: false,
    },
    {
      id: "drop-no-context",
      name: "No Slack context",
      prompt: "Summarize something else.",
      cron_expr: "0 12 * * *",
      timezone: "Asia/Shanghai",
      is_paused: false,
    },
  ];
  const scheduleManager = createInMemoryAssistantScheduleManager(definitions);
  const args = { action: "list", channel_id: "C123", thread_ts: "1700000000.123456" };
  type ScheduleListResult = {
    ok: boolean;
    success?: boolean;
    error?: string;
    text?: string;
    metadata?: { schedule_ids?: string[]; [key: string]: unknown };
    schedules?: unknown[];
    [key: string]: unknown;
  };
  const direct = (await executeAssistantScheduleTool(args, {
    scheduleManager,
  })) as ScheduleListResult;
  assertSmoke(
    direct.ok === true && direct.success === true,
    "Assistant schedule list failed",
    direct,
  );
  assertSmoke(
    JSON.stringify(direct.metadata?.schedule_ids) ===
      JSON.stringify(["keep-metadata", "keep-legacy"]),
    "Assistant schedule list was not scoped to the current Slack thread",
    direct,
  );
  assertSmoke(
    (direct.schedules?.length || 0) === 2 && !direct.text?.includes("drop-other-thread"),
    "Assistant schedule output included other threads",
    direct,
  );

  for (const action of ["create", "get", "update", "pause", "resume", "delete"]) {
    const blocked = (await executeAssistantScheduleTool(
      { action },
      { scheduleManager },
    )) as ScheduleListResult;
    assertSmoke(
      blocked.ok === false && blocked.error === "assistant_mutation_blocked",
      `Assistant schedule ${action} should be blocked`,
      blocked,
    );
    assertSmoke(
      Boolean(
        blocked.text?.includes("not available in assistant sessions") &&
        blocked.text?.includes('"list"'),
      ),
      `Assistant schedule ${action} gate text missing allowed action`,
      blocked,
    );
  }

  const registry = createLegacySlackToolRegistry({
    scheduleManager,
    sessionMetadata: {
      channel_id: "C123",
      thread_ts: "1700000000.123456",
    },
  });
  const executeRegistry = registry.execute as (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>;
  const registryList = (await executeRegistry("manage_schedule", {
    action: "list",
  })) as ScheduleListResult;
  assertSmoke(
    registryList.ok === true && (registryList.metadata?.schedule_ids?.length || 0) === 2,
    "Legacy tool registry did not execute manage_schedule",
    registryList,
  );
  const registryBlocked = (await executeRegistry("manage_schedule", {
    action: "delete",
  })) as ScheduleListResult;
  assertSmoke(
    registryBlocked.ok === false && registryBlocked.error === "assistant_mutation_blocked",
    "Legacy tool registry did not block manage_schedule mutation",
    registryBlocked,
  );
  const report = registry.report() as {
    activeTools: string[];
    sourceEvidence: Record<string, { exists?: boolean; [key: string]: unknown }>;
  };
  assertSmoke(
    report.activeTools.includes("manage_schedule"),
    "Legacy registry did not mark manage_schedule active",
    report,
  );
  assertSmoke(
    report.sourceEvidence.manage_schedule?.exists === true,
    "Legacy source evidence missing for manage_schedule",
    report.sourceEvidence.manage_schedule,
  );

  console.log(
    JSON.stringify(
      { ok: true, direct, registryList, registryBlocked, activeTools: report.activeTools },
      null,
      2,
    ),
  );
}

async function slackAssistantScheduleServiceSmoke() {
  const dataDir = await mkdtemp(
    pathJoin(tmpdir(), "meeting-avatar-bot-assistant-schedule-service-"),
  );
  const port = "18946";
  const baseUrl = `http://127.0.0.1:${port}`;
  const definitionsPath = pathJoin(dataDir, "assistant-schedules.json");
  await writeFile(
    definitionsPath,
    JSON.stringify(
      {
        definitions: [
          {
            id: "service-keep-metadata",
            name: "Service current thread via metadata",
            metadata: { slack_channel_id: "C_SERVICE", slack_thread_ts: "1710000000.000000" },
            prompt: "Summarize service thread.",
            cron_expr: "0 9 * * 1",
            timezone: "Asia/Shanghai",
          },
          {
            id: "service-keep-legacy",
            name: "Service current thread via prompt",
            prompt:
              "Summarize service thread.\n\n[Context] This schedule was created in channel=C_SERVICE thread_ts=1710000000.000000. When posting results, use slack_api to deliver to the appropriate channel/thread. Your text output alone is NOT delivered to Slack.",
            cron_expr: "0 10 * * 1",
            timezone: "Asia/Shanghai",
          },
          {
            id: "service-drop-other-thread",
            name: "Service other thread",
            metadata: { slack_channel_id: "C_SERVICE", slack_thread_ts: "1710000001.000000" },
            prompt: "Summarize another thread.",
            cron_expr: "0 11 * * 1",
            timezone: "Asia/Shanghai",
          },
        ],
      },
      null,
      2,
    ),
  );

  const service = startService("apps/slack-agent/src/index.js", {
    MAB_SLACK_PORT: port,
    MAB_DATA_DIR: dataDir,
    MAB_STATE_PROVIDER: "json-file",
    MAB_SLACK_SOCKET_MODE: "0",
    MAB_SLACK_API_MOCK: "1",
    MAB_SLACK_POSTER_MOCK: "1",
    MAB_DRY_RUN_AGENT: "1",
    MAB_ASSISTANT_SCHEDULE_DEFINITIONS_PATH: definitionsPath,
  });

  try {
    const health = await waitForServiceHealth(service, `${baseUrl}/healthz`, 10_000);
    assertSmoke(
      health.ok === true && health.service === "slack-agent",
      "Slack Agent service did not boot",
      health,
    );
    const parity = await (await fetch(`${baseUrl}/slack/tools/parity`)).json();
    assertSmoke(
      parity.activeTools?.includes("manage_schedule"),
      "Slack Agent service did not expose manage_schedule as active",
      parity,
    );

    const list = await postJsonWithStatus(`${baseUrl}/slack/tools/call`, {
      tool: "manage_schedule",
      args: { action: "list", channel_id: "C_SERVICE", thread_ts: "1710000000.000000" },
    });
    assertSmoke(
      list.httpStatus === 200 && list.ok === true,
      "Slack Agent service manage_schedule list failed",
      list,
    );
    assertSmoke(
      JSON.stringify(list.metadata?.schedule_ids) ===
        JSON.stringify(["service-keep-metadata", "service-keep-legacy"]),
      "Slack Agent service manage_schedule list was not scoped to the current thread",
      list,
    );

    const blocked = await postJsonWithStatus(`${baseUrl}/slack/tools/call`, {
      tool: "manage_schedule",
      args: { action: "delete", channel_id: "C_SERVICE", thread_ts: "1710000000.000000" },
    });
    assertSmoke(
      blocked.httpStatus === 400 &&
        blocked.ok === false &&
        blocked.error === "assistant_mutation_blocked",
      "Slack Agent service manage_schedule did not block mutation",
      blocked,
    );

    console.log(JSON.stringify({ ok: true, service: { health, parity }, list, blocked }, null, 2));
  } finally {
    service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function slackWorkspaceBootstrapSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-workspace-bootstrap-"));
  const meetingPort = "18948";
  const slackPort = "18949";
  const meetingUrl = `http://127.0.0.1:${meetingPort}`;
  const slackUrl = `http://127.0.0.1:${slackPort}`;
  const workspaceDir = pathJoin(dataDir, "workspace");
  const validateOnlyWorkspaceDir = pathJoin(dataDir, "validate-only-workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(pathJoin(workspaceDir, "SOUL.md"), "custom soul stays\n");

  const meeting = startService("apps/meeting-agent/src/index.js", {
    MAB_MEETING_PORT: meetingPort,
    MAB_MEETING_AGENT_URL: meetingUrl,
    MAB_DATA_DIR: pathJoin(dataDir, "meeting-data"),
    MAB_DRY_RUN_AGENT: "1",
  });
  const slack = startService("apps/slack-agent/src/index.js", {
    MAB_SLACK_PORT: slackPort,
    MAB_MEETING_AGENT_URL: meetingUrl,
    MAB_DATA_DIR: pathJoin(dataDir, "slack-data"),
    MAB_SLACK_WORKSPACE_DIR: workspaceDir,
    MAB_STATE_PROVIDER: "json-file",
    MAB_SLACK_SOCKET_MODE: "0",
    MAB_SLACK_API_MOCK: "1",
    MAB_SLACK_POSTER_MOCK: "1",
    MAB_DRY_RUN_AGENT: "1",
  });

  try {
    await waitForServiceHealth(meeting, `${meetingUrl}/health`);
    const validateOnly = spawnSync(process.execPath, ["apps/slack-agent/src/index.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAB_SLACK_VALIDATE_ONLY: "1",
        MAB_VALIDATE_MEETING_AGENT_URL: meetingUrl,
        MAB_MEET_WEBHOOK_LISTEN: "127.0.0.1:0",
        MAB_SLACK_WORKSPACE_DIR: validateOnlyWorkspaceDir,
        MAB_DATA_DIR: pathJoin(dataDir, "validate-only-data"),
        MAB_STATE_PROVIDER: "json-file",
        MAB_SLACK_SOCKET_MODE: "0",
        MAB_SLACK_API_MOCK: "1",
        MAB_SLACK_POSTER_MOCK: "1",
        MAB_DRY_RUN_AGENT: "1",
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    assertSmoke(validateOnly.status === 0, "Slack validate-only process failed", {
      status: validateOnly.status,
      stdout: validateOnly.stdout,
      stderr: validateOnly.stderr,
    });
    const validateOnlyResult = JSON.parse(validateOnly.stdout);
    assertSmoke(
      validateOnlyResult.ok === true,
      "Slack validate-only process returned not ok",
      validateOnlyResult,
    );
    assertSmoke(
      validateOnlyResult.workspace?.created?.includes("AGENTS.md"),
      "Slack validate-only did not bootstrap workspace",
      validateOnlyResult,
    );
    assertSmoke(
      validateOnlyResult.validation?.checks?.some(
        (check) => check.name === "meetd_health" && check.ok === true,
      ),
      "Slack validate-only did not check Meeting Agent health",
      validateOnlyResult,
    );

    const health = await waitForServiceHealth(slack, `${slackUrl}/healthz`);
    assertSmoke(
      health.state?.slackWorkspaceDir === workspaceDir,
      "Slack Agent did not expose workspace dir",
      health,
    );
    assertSmoke(
      health.state?.slackWorkspaceBootstrap?.ok === true,
      "Slack Agent startup workspace bootstrap failed",
      health,
    );
    assertSmoke(
      health.state?.slackWorkspaceBootstrap?.created?.includes("AGENTS.md"),
      "Slack Agent startup did not create AGENTS.md",
      health,
    );
    assertSmoke(
      health.state?.slackWorkspaceBootstrap?.existing?.includes("SOUL.md"),
      "Slack Agent startup overwrote or missed existing SOUL.md",
      health,
    );
    assertSmoke(
      readFileSync(pathJoin(workspaceDir, "SOUL.md"), "utf8") === "custom soul stays\n",
      "workspace bootstrap overwrote existing SOUL.md",
    );

    const firstBootstrap = await postJsonWithStatus(`${slackUrl}/slack/workspace/bootstrap`, {});
    assertSmoke(
      firstBootstrap.httpStatus === 200 && firstBootstrap.ok === true,
      "workspace bootstrap route failed",
      firstBootstrap,
    );
    assertSmoke(
      firstBootstrap.created.length === 0,
      "workspace bootstrap route was not idempotent after startup bootstrap",
      firstBootstrap,
    );
    assertSmoke(
      firstBootstrap.existing.includes("AGENTS.md"),
      "workspace bootstrap route did not report existing AGENTS.md",
      firstBootstrap,
    );
    assertSmoke(
      firstBootstrap.existing.includes("CODEX_GUIDANCE.md"),
      "workspace bootstrap route did not report existing CODEX_GUIDANCE.md",
      firstBootstrap,
    );
    assertSmoke(
      firstBootstrap.existing.includes("docs/slack-patterns.md"),
      "workspace bootstrap route did not report existing Slack pattern docs",
      firstBootstrap,
    );
    assertSmoke(
      firstBootstrap.existing.includes("SOUL.md"),
      "workspace bootstrap overwrote or missed existing SOUL.md",
      firstBootstrap,
    );

    const secondBootstrap = await postJsonWithStatus(`${slackUrl}/slack/workspace/bootstrap`, {});
    assertSmoke(
      secondBootstrap.httpStatus === 200 && secondBootstrap.created.length === 0,
      "workspace bootstrap was not idempotent",
      secondBootstrap,
    );

    const valid = await postJsonWithStatus(`${slackUrl}/slack/validate`, {
      meeting_agent_url: meetingUrl,
      webhook_listen: "127.0.0.1:0",
      require_slack_tokens: false,
    });
    assertSmoke(
      valid.httpStatus === 200 && valid.ok === true,
      "Slack validate-only route failed valid local preflight",
      valid,
    );
    assertSmoke(
      valid.checks.some((check) => check.name === "meetd_health" && check.ok === true),
      "Slack validate-only did not check Meeting Agent health",
      valid,
    );
    assertSmoke(
      valid.checks.some((check) => check.name === "webhook_listen" && check.ok === true),
      "Slack validate-only did not check webhook listen",
      valid,
    );

    const bad = await postJsonWithStatus(`${slackUrl}/slack/validate`, {
      meeting_agent_url: "http://127.0.0.1:9",
      webhook_listen: "127.0.0.1:0",
      require_slack_tokens: false,
    });
    assertSmoke(
      bad.httpStatus === 400 && bad.ok === false,
      "Slack validate-only should fail bad Meeting Agent health",
      bad,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          health: health.state,
          validateOnly: validateOnlyResult,
          firstBootstrap,
          secondBootstrap,
          valid,
          bad: {
            httpStatus: bad.httpStatus,
            checks: bad.checks?.map((check) => ({
              name: check.name,
              ok: check.ok,
              status: check.status || 0,
            })),
          },
        },
        null,
        2,
      ),
    );
  } finally {
    slack.child.kill("SIGTERM");
    meeting.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function slackInstallSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-install-"));
  const slackPort = "18950";
  const meetingPort = "18951";
  const slackUrl = `http://127.0.0.1:${slackPort}`;
  const meetingUrl = `http://127.0.0.1:${meetingPort}`;
  const manifestPath = pathJoin(dataDir, "slack-manifest-bad.json");
  const pastedManifest = {
    display_information: {
      name: "Onee-sama",
      background_color: "#302f2f",
    },
    features: {
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: false,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: "Onee-sama",
        always_online: true,
      },
      assistant_view: {
        assistant_description: "Onee-sama is an AI assistant.",
        suggested_prompts: [],
      },
    },
    oauth_config: {
      redirect_urls: ["https://localhost:8080/slack/oauth"],
      scopes: {
        user: ["channels:history", "channels:read", "groups:history", "im:history"],
        bot: [
          "im:read",
          "app_mentions:read",
          "assistant:write",
          "channels:history",
          "channels:join",
          "channels:read",
          "chat:write",
          "chat:write.public",
          "commands",
          "files:read",
          "files:write",
          "groups:history",
          "groups:read",
          "im:history",
          "im:write",
          "pins:read",
          "pins:write",
          "reactions:read",
          "reactions:write",
          "users:read",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [
          "app_mention",
          "assistant_thread_context_changed",
          "assistant_thread_started",
          "message.channels",
          "message.im",
        ],
      },
      interactivity: { is_enabled: true },
      socket_mode_enabled: true,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(pastedManifest, null, 2)}\n`);

  const meeting = startService("apps/meeting-agent/src/index.js", {
    MAB_MEETING_PORT: meetingPort,
    MAB_MEETING_AGENT_URL: meetingUrl,
    MAB_DATA_DIR: pathJoin(dataDir, "meeting-data"),
    MAB_DRY_RUN_AGENT: "1",
  });
  const slack = startService("apps/slack-agent/src/index.js", {
    MAB_SLACK_PORT: slackPort,
    MAB_MEETING_AGENT_URL: meetingUrl,
    MAB_PUBLIC_BASE_URL: "https://localhost:8080",
    MAB_DATA_DIR: pathJoin(dataDir, "slack-data"),
    MAB_SLACK_WORKSPACE_DIR: pathJoin(dataDir, "workspace"),
    MAB_SLACK_APP_MANIFEST_PATH: manifestPath,
    SLACK_CLIENT_ID: "123.456",
    SLACK_CLIENT_SECRET: "fixture-secret",
    MAB_STATE_PROVIDER: "json-file",
    MAB_SLACK_SOCKET_MODE: "0",
    MAB_SLACK_API_MOCK: "1",
    MAB_SLACK_POSTER_MOCK: "1",
    MAB_DRY_RUN_AGENT: "1",
  });

  try {
    await waitForServiceHealth(meeting, `${meetingUrl}/health`);
    const health = await waitForServiceHealth(slack, `${slackUrl}/healthz`);
    assertSmoke(
      health.ok === true && health.service === "slack-agent",
      "Slack Agent service did not boot",
      health,
    );

    const install = await (await fetch(`${slackUrl}/slack/install`)).json();
    assertSmoke(install.ok === true, "Slack install model failed", install);
    assertSmoke(
      install.manifest?.features?.app_home?.messages_tab_enabled === true,
      "generated manifest does not enable App Home messages tab",
      install,
    );
    assertSmoke(
      install.manifest?.features?.slash_commands?.some((entry) => entry.command === "/avatar"),
      "generated manifest did not include /avatar slash command",
      install,
    );
    assertSmoke(
      install.oauth?.installUrl?.includes("https://slack.com/oauth/v2/authorize"),
      "install URL was not generated",
      install,
    );

    const badValidation = await postJsonWithStatus(`${slackUrl}/slack/app/manifest/validate`, {
      manifest: pastedManifest,
    });
    assertSmoke(
      badValidation.httpStatus === 400 && badValidation.ok === false,
      "bad manifest should fail validation",
      badValidation,
    );
    const badBlocking = badValidation.validation?.blocking || [];
    assertSmoke(
      badBlocking.includes("app_home_messages_tab"),
      "bad manifest did not flag disabled messages tab",
      badValidation,
    );
    assertSmoke(
      badBlocking.includes("bot_events"),
      "bad manifest did not flag missing message.groups event",
      badValidation,
    );
    assertSmoke(
      badBlocking.includes("slash_command"),
      "bad manifest did not flag missing /avatar command definition",
      badValidation,
    );

    const goodValidation = await postJsonWithStatus(`${slackUrl}/slack/app/manifest/validate`, {
      manifest: install.manifest,
    });
    assertSmoke(
      goodValidation.httpStatus === 200 && goodValidation.ok === true,
      "generated manifest should pass validation",
      goodValidation,
    );

    const routeValidation = await postJsonWithStatus(`${slackUrl}/slack/validate`, {
      require_slack_tokens: false,
      manifest: install.manifest,
    });
    assertSmoke(
      routeValidation.httpStatus === 200 && routeValidation.manifestValidation?.ok === true,
      "slack validate route did not include manifest validation",
      routeValidation,
    );

    const validateOnly = spawnSync(process.execPath, ["apps/slack-agent/src/index.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAB_SLACK_VALIDATE_ONLY: "1",
        MAB_SLACK_APP_MANIFEST_PATH: manifestPath,
        MAB_DATA_DIR: pathJoin(dataDir, "validate-only-data"),
        MAB_SLACK_WORKSPACE_DIR: pathJoin(dataDir, "validate-workspace"),
        MAB_STATE_PROVIDER: "json-file",
        MAB_SLACK_SOCKET_MODE: "0",
        MAB_SLACK_API_MOCK: "1",
        MAB_SLACK_POSTER_MOCK: "1",
        MAB_DRY_RUN_AGENT: "1",
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    assertSmoke(
      validateOnly.status === 1,
      "validate-only should fail the pasted incomplete manifest",
      {
        status: validateOnly.status,
        stdout: validateOnly.stdout,
        stderr: validateOnly.stderr,
      },
    );
    const validateOnlyResult = JSON.parse(validateOnly.stdout);
    assertSmoke(
      validateOnlyResult.manifestValidation?.blocking?.includes("app_home_messages_tab"),
      "validate-only did not surface manifest gaps",
      validateOnlyResult,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          install: {
            manifestMessagesTab: install.manifest.features.app_home.messages_tab_enabled,
            slashCommands: install.manifest.features.slash_commands.map((entry) => entry.command),
            installUrl: install.oauth.installUrl,
          },
          badValidation: {
            httpStatus: badValidation.httpStatus,
            blocking: badValidation.validation.blocking,
          },
          goodValidation: {
            httpStatus: goodValidation.httpStatus,
            blocking: goodValidation.validation.blocking,
          },
          routeValidation: {
            httpStatus: routeValidation.httpStatus,
            manifestOk: routeValidation.manifestValidation.ok,
          },
          validateOnly: {
            status: validateOnly.status,
            blocking: validateOnlyResult.manifestValidation.blocking,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    slack.child.kill("SIGTERM");
    meeting.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function slackToolRegistrySmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-tool-registry-"));
  try {
    const memoryRoot = pathJoin(dataDir, "slack-memory");
    const sourceRoot = pathJoin(dataDir, "legacy-source");
    await mkdir(pathJoin(memoryRoot, "workspace"), { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(
      pathJoin(memoryRoot, "workspace", "MEMORY.md"),
      "Operator uses Linear, Slack Canvas, and legacy workspace memory.\n",
    );
    for (const spec of LEGACY_SLACK_TOOL_SPECS) {
      await writeFile(
        pathJoin(sourceRoot, spec.source),
        `package slack\n\nfunc Name() string { return "${spec.name}" }\n`,
      );
    }
    const localMemory = createLocalSlackMemoryProvider({
      enabled: true,
      rootDir: memoryRoot,
    });
    const calls = [];
    const registry = createLegacySlackToolRegistry({
      botToken: "slack-test-token",
      localMemory,
      sourceRoot,
      workspaceDir: process.cwd(),
      runtimeStatus: () => ({ socketMode: { connected: true }, service: "smoke" }),
      fetchImpl: (async (url: string | URL, options: RequestInit = {}) => {
        calls.push({
          url: String(url),
          payload: JSON.parse(String(options.body || "{}")),
        });
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, method: String(url).split("/").pop(), ts: "1710000000.000000" };
          },
        } as unknown as Response;
      }) as typeof fetch,
    });
    const report = registry.report();
    const expected = [
      "audio_generation",
      "figma_api",
      "followup_memory",
      "google_calendar_api",
      "heartbeat_log",
      "image_generation",
      "linear_api",
      "notion_api",
      "person_memory",
      "read_doc",
      "runtime_status",
      "slack_api",
      "suggest_action",
      "usage_api",
      "manage_schedule",
    ];
    const names = report.tools.map((tool) => tool.name).toSorted();
    for (const name of expected) {
      assertSmoke(names.includes(name), `Legacy tool registry missing ${name}`, names);
      assertSmoke(
        report.sourceEvidence[name]?.exists === true,
        `Legacy source evidence missing for ${name}`,
        report.sourceEvidence[name],
      );
    }
    type ExecuteResult = {
      ok: boolean;
      status?: string;
      error?: string;
      results?: unknown[];
      schedules?: unknown[];
      [key: string]: unknown;
    };
    const executeRegistry = registry.execute as (
      name: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
    const slackApi = (await executeRegistry("slack_api", {
      method: "auth.test",
      payload: {},
    })) as ExecuteResult;
    const slackSurfaceMethods = [
      { method: "conversations.history", payload: { channel: "C_SMOKE", limit: 1 } },
      {
        method: "conversations.replies",
        payload: { channel: "C_SMOKE", ts: "1710000000.000000", limit: 5 },
      },
      { method: "files.info", payload: { file: "F_SMOKE" } },
      {
        method: "reactions.add",
        payload: { channel: "C_SMOKE", timestamp: "1710000000.000000", name: "eyes" },
      },
      { method: "pins.add", payload: { channel: "C_SMOKE", timestamp: "1710000000.000000" } },
      {
        method: "chat.update",
        payload: { channel: "C_SMOKE", ts: "1710000000.000000", text: "updated smoke" },
      },
      { method: "chat.delete", payload: { channel: "C_SMOKE", ts: "1710000000.000000" } },
    ];
    const slackSurfaceCalls: ExecuteResult[] = [];
    for (const call of slackSurfaceMethods) {
      slackSurfaceCalls.push((await executeRegistry("slack_api", call)) as ExecuteResult);
    }
    const memory = (await executeRegistry("person_memory", {
      query: "Linear Canvas",
      limit: 3,
    })) as ExecuteResult;
    const runtime = (await executeRegistry("runtime_status", {})) as ExecuteResult & {
      status?: { service?: string };
    };
    const suggest = (await executeRegistry("suggest_action", {
      action: { type: "confirm", text: "Ship it" },
    })) as ExecuteResult;
    const scheduleList = (await executeRegistry("manage_schedule", {
      action: "list",
      channel_id: "C_SMOKE",
      thread_ts: "1710000000.000000",
    })) as ExecuteResult;
    const scheduleBlocked = (await executeRegistry("manage_schedule", {
      action: "create",
    })) as ExecuteResult;
    const runCommand = (await executeRegistry("run_command", {
      command: "git status --short",
    })) as ExecuteResult;
    const linear = (await executeRegistry("linear_api", { action: "list" })) as ExecuteResult;
    assertSmoke(
      slackApi.ok === true && calls.length >= 1,
      "slack_api adapter did not call Slack API mock",
      slackApi,
    );
    assertSmoke(
      slackSurfaceCalls.every((call) => call.ok === true),
      "Slack surface API smoke failed",
      slackSurfaceCalls,
    );
    const calledMethods = calls.map((call) => call.url.split("/").pop());
    for (const { method } of slackSurfaceMethods) {
      assertSmoke(
        calledMethods.includes(method),
        `Slack surface method ${method} was not forwarded`,
        calledMethods,
      );
    }
    assertSmoke(
      memory.ok === true && (memory.results?.length || 0) >= 1,
      "person_memory adapter did not search local memory",
      memory,
    );
    assertSmoke(
      runtime.ok === true && runtime.status?.service === "smoke",
      "runtime_status adapter failed",
      runtime,
    );
    assertSmoke(
      suggest.ok === true && suggest.status === "pending_user_confirmation",
      "suggest_action adapter failed",
      suggest,
    );
    assertSmoke(
      scheduleList.ok === true && Array.isArray(scheduleList.schedules),
      "manage_schedule list adapter failed",
      scheduleList,
    );
    assertSmoke(
      scheduleBlocked.ok === false && scheduleBlocked.error === "assistant_mutation_blocked",
      "manage_schedule should gate mutations",
      scheduleBlocked,
    );
    assertSmoke(
      runCommand.ok === false && runCommand.error === "run_command_disabled",
      "run_command should fail closed by default",
      runCommand,
    );
    assertSmoke(
      linear.ok === false && linear.error === "external_provider_required",
      "credentialed external tool should fail closed",
      linear,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          totalTools: report.totalTools,
          activeTools: report.activeTools,
          pendingTools: report.pendingTools,
          smoke: {
            slackApi,
            slackSurfaceCalls,
            memory,
            runtime,
            suggest,
            scheduleList,
            scheduleBlocked,
            runCommand,
            linear,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function slackDomainStoreSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-domain-"));
  const dbPath = pathJoin(dataDir, "slack-agent-domain.sqlite3");
  const store = createLegacySlackDomainStore({ dbPath });
  try {
    const body = {
      team_id: "T_SMOKE",
      team_domain: "smoke-team",
      channel_id: "C_SMOKE",
      channel_name: "xp-test",
      user_id: "U_PENG",
      user_name: "peng",
      command: "/avatar",
      text: "delegate summarize the latest meeting",
      thread_ts: "1778226000.000100",
    };
    const domain = store.recordSlackCommand({
      body,
      parsed: {
        action: "delegate",
        task: "summarize the latest meeting",
        requestedMode: "analysis",
      },
      session: { id: "sess_smoke" },
      responseSummary: "Delegated to codex: job_smoke.",
    });
    store.syncChannelMembers("C_SMOKE", ["U_PENG", "U_TEAM"]);
    store.setEventCursor("socket:C_SMOKE", "1778226001.000000");
    const pending = store.insertPendingAction({
      channelId: "C_SMOKE",
      threadTs: "1778226000.000100",
      actionType: "create_linear_issue",
      params: { title: "Follow up on meeting summary" },
    });
    const confirmed = store.setPendingActionStatus(
      pending.id as string | number,
      "confirmed",
      "U_PENG",
      JSON.stringify({ ok: true }),
    );
    const outbound = store.reserveOutboundAction({
      actionType: "canvas_publish",
      target: "C_SMOKE",
      reference: "artifact_smoke",
      sessionId: "sess_smoke",
      summary: "Publish meeting summary to Canvas",
    });
    if (outbound.id) store.setOutboundActionStatus(outbound.id, "sent");
    const heartbeat = store.createHeartbeatFollowup({
      kind: "followup",
      title: "Check meeting summary delivery",
      summary: "Make sure Canvas summary landed in Slack.",
      sourceKind: "thread",
      channelId: "C_SMOKE",
      threadTs: "1778226000.000100",
      sourceRef: "C_SMOKE:1778226000.000100",
      nextCheckAt: "2026-05-08T10:00:00.000Z",
    });
    const surface = store.recordHeartbeatSurface({
      followupId: heartbeat.id,
      sessionId: "sess_smoke",
      title: heartbeat.title,
      summary: heartbeat.summary,
      requestedSurface: "slack_thread",
      deliveredSurface: "slack_thread",
      channelId: "C_SMOKE",
      threadTs: "1778226000.000100",
    });
    const triage = store.recordTriageRun({
      run: {
        sessionId: "triage_sess_smoke",
        status: "success",
        summary: "One pending meeting follow-up confirmed.",
        digest: "Buffered Slack activity for xp-test.",
        steps: 2,
        mutations: 1,
        channels: ["C_SMOKE"],
      },
      actions: [
        {
          tool: "suggest_action",
          channel: "C_SMOKE",
          brief: "Ask Operator to confirm Canvas publish.",
        },
      ],
      toolCalls: [
        {
          tool: "suggest_action",
          action: "confirm",
          args: { actionType: "canvas_publish" },
          success: true,
          brief: "Confirmation card created.",
          result: { pendingActionId: pending.id },
        },
      ],
    });
    const triageContexts = store.listTriageContexts(5);
    const triageContext = triageContexts.find((entry) => entry.session_id === "triage_sess_smoke");
    const projectionOne = persistTriageContextProjection({
      workspaceDir: pathJoin(dataDir, "projection-workspace"),
      maxSize: 2,
      context: triageContext,
    });
    const projectionTwo = persistTriageContextProjection({
      workspaceDir: pathJoin(dataDir, "projection-workspace"),
      maxSize: 2,
      context: {
        session_id: "triage_sess_followup",
        status: "success",
        timestamp: "2026-05-08T10:00:00.000Z",
        channels: ["C_SMOKE"],
        actions: [
          { tool: "suggest_action", channel: "C_SMOKE", brief: "Follow up on the recap owner." },
        ],
      },
    });
    const projectionThree = persistTriageContextProjection({
      workspaceDir: pathJoin(dataDir, "projection-workspace"),
      maxSize: 2,
      context: {
        session_id: "triage_sess_actionless",
        status: "failed",
        timestamp: "2026-05-08T11:00:00.000Z",
        channels: ["C_SMOKE"],
        error: "agent runner timed out",
      },
    });
    const projectedTriage = loadTriageContextProjection(pathJoin(dataDir, "projection-workspace"));
    const previousTriageText = formatTriageContexts(projectedTriage);
    const compactWorkspace = pathJoin(dataDir, "compact-workspace");
    const compactDate = "2026-01-01";
    const compactNote = Array.from({ length: 12 }, (_, index) => {
      return `## Topic ${index + 1}\n${"x".repeat(420)}\n`;
    }).join("\n");
    await mkdir(pathJoin(compactWorkspace, "memory"), { recursive: true });
    await writeFile(pathJoin(compactWorkspace, "memory", `${compactDate}.md`), compactNote, "utf8");
    const compactTask = buildDailyNoteCompactionTask({
      workspaceDir: compactWorkspace,
      date: compactDate,
    });
    const compactPrompt = buildDailyNoteCompactionPrompt(compactDate);
    const feedback = store.recordFeedbackEntry({
      entryDate: "2026-05-08",
      entryTime: "18:30",
      action: "confirmed",
      channel: "C_SMOKE",
      actionType: "canvas_publish",
      summary: "Operator confirmed the Canvas publish action.",
      userId: "U_PENG",
    });
    const improvement = store.recordImprovementSignal({
      topic: "progress_noise",
      signalType: "complaint",
      summary: "Progress updates should be concise and tied to evidence.",
      desiredBehavior: "Report current state, blocker, and verification signal without filler.",
      severity: "medium",
      confidence: 0.9,
      channelId: "C_SMOKE",
      threadTs: "1778226000.000100",
      msgTs: "1778226002.000000",
      sessionId: "sess_smoke",
      clusterKey: "bot_experience",
      metadata: { source: "slack-domain-store-smoke" },
    });
    const context = store.context({
      workspaceId: "T_SMOKE",
      channelId: "C_SMOKE",
      threadTs: "1778226000.000100",
      limit: 5,
    });
    const stats = store.stats();
    assertSmoke(
      domain.threadLedger?.last_action_type === "delegate",
      "domain store did not record Slack command action",
      domain,
    );
    assertSmoke(
      context.channelBrain?.last_session_id === "sess_smoke",
      "domain store did not touch channel brain",
      context,
    );
    assertSmoke(
      context.threadLedger?.summary.includes("Delegated"),
      "domain store did not record outbound summary",
      context.threadLedger,
    );
    assertSmoke(
      store.listChannelMemberIds("C_SMOKE").length === 2,
      "domain store did not sync channel members",
    );
    assertSmoke(
      store.getEventCursor("socket:C_SMOKE")?.value === "1778226001.000000",
      "domain store did not persist event cursor",
    );
    assertSmoke(
      confirmed.status === "confirmed",
      "domain store did not confirm pending action",
      confirmed,
    );
    assertSmoke(
      outbound.reserved === true,
      "domain store did not reserve outbound action",
      outbound,
    );
    assertSmoke(
      surface.status === "sent",
      "domain store did not record heartbeat surface",
      surface,
    );
    assertSmoke(triage.status === "success", "domain store did not record triage run", triage);
    assertSmoke(
      triageContext?.actions?.[0]?.tool === "suggest_action",
      "domain store did not project triage actions",
      triageContexts,
    );
    assertSmoke(
      triageContext?.tool_calls?.[0]?.success === true,
      "domain store did not project triage tool calls",
      triageContexts,
    );
    assertSmoke(
      projectionOne.ok === true && projectionTwo.ok === true && projectionThree.ok === true,
      "triage projection persistence failed",
      { projectionOne, projectionTwo, projectionThree },
    );
    assertSmoke(
      projectedTriage.length === 2,
      "triage projection did not keep the bounded active window",
      projectedTriage,
    );
    assertSmoke(
      projectionThree.archived?.[0]?.path && existsSync(projectionThree.archived[0].path),
      "triage projection did not archive evicted entries",
      projectionThree,
    );
    assertSmoke(
      previousTriageText.includes("Previous Triage") &&
        previousTriageText.includes("suggest_action"),
      "triage projection did not format prompt context",
      previousTriageText,
    );
    assertSmoke(
      shouldCompactDailyNote(compactNote) === true,
      "daily note compaction threshold did not match Legacy behavior",
    );
    assertSmoke(
      dailyNoteCompactHash(compactNote) === compactTask.hash,
      "daily note compaction hash was not stable",
      compactTask,
    );
    assertSmoke(
      compactTask.eligible === true && compactTask.prompt.includes(`memory/${compactDate}.md`),
      "daily note compaction task did not build prompt",
      compactTask,
    );
    assertSmoke(
      compactPrompt
        .split("\n")
        .filter((line) => line.includes("MEMORY.md"))
        .every((line) => line.includes("Do NOT read or write MEMORY.md")),
      "daily note compaction prompt references MEMORY.md outside prohibition",
      compactPrompt,
    );
    assertSmoke(
      feedback.action === "confirmed",
      "domain store did not record feedback entry",
      feedback,
    );
    assertSmoke(
      improvement.status === "open",
      "domain store did not record improvement signal",
      improvement,
    );
    assertSmoke(
      store.listFeedbackEntries({ dates: ["2026-05-08"] }).length === 1,
      "domain store did not list feedback by date",
    );
    assertSmoke(
      store.listImprovementSignals({ clusterKey: "bot_experience" }).length === 1,
      "domain store did not list improvement signals",
    );
    for (const table of [
      "thread_case",
      "channel_brain",
      "thread_ledger",
      "pending_action",
      "heartbeat_followup",
      "triage_run",
      "feedback_entry",
      "improvement_signal",
    ]) {
      assertSmoke(stats.tables[table] >= 1, `domain store missing table rows for ${table}`, stats);
    }

    const slackPort = 18947;
    const slackUrl = `http://127.0.0.1:${slackPort}`;
    const refreshDbPath = pathJoin(dataDir, "slack-agent-domain-refresh.sqlite3");
    const slack = startService("apps/slack-agent/src/index.js", {
      MAB_SLACK_PORT: String(slackPort),
      MAB_DATA_DIR: pathJoin(dataDir, "service-data"),
      MAB_SLACK_DOMAIN_DB_PATH: refreshDbPath,
      MAB_DRY_RUN_AGENT: "1",
      MAB_SLACK_POSTER_MOCK: "1",
      SLACK_SIGNING_SECRET: "domain-refresh-smoke-signing-secret",
    });
    let refresh = null;
    let refreshedContext = null;
    try {
      await waitForServiceHealth(slack, `${slackUrl}/healthz`);
      refresh = await postJsonWithStatus(`${slackUrl}/slack/domain/refresh`, {
        workspace: "T_SMOKE",
        channels: [
          {
            id: "C_AUTO",
            name: "auto-cache",
            is_channel: true,
            members: ["U_PENG", "U_TEAM"],
          },
          {
            id: "G_PRIVATE",
            name: "private-cache",
            is_private: true,
            members: ["U_PENG"],
          },
        ],
      });
      assertSmoke(
        refresh.httpStatus === 200 && refresh.ok === true,
        "domain refresh route failed",
        refresh,
      );
      assertSmoke(
        refresh.channelCount === 2 && refresh.memberCount === 3,
        "domain refresh route did not sync fixture channels/members",
        refresh,
      );

      refreshedContext = await (
        await fetch(`${slackUrl}/slack/domain/context?workspace=T_SMOKE&channel=C_AUTO`)
      ).json();
      assertSmoke(
        refreshedContext.context?.channel?.name === "auto-cache",
        "domain refresh route did not store channel cache",
        refreshedContext,
      );
      assertSmoke(
        refreshedContext.context?.channelMembers?.length === 2,
        "domain refresh route did not store channel members",
        refreshedContext,
      );
    } finally {
      slack.child.kill("SIGTERM");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          dbPath,
          stats,
          context,
          pending: confirmed,
          outbound,
          heartbeat,
          surface,
          triage,
          triageContexts,
          projectedTriage,
          previousTriageText,
          compactTask,
          feedback,
          improvement,
          refresh,
          refreshedContext,
        },
        null,
        2,
      ),
    );
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function slackTriageFlowSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-triage-"));
  const env = {
    MAB_SLACK_PORT: "18944",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18945",
    MAB_AGENT_RUNNER: "command",
    MAB_AGENT_COMMAND: `node -e 'let input=""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { const job = JSON.parse(input || "{}"); const task = String(job.task || ""); const needsAction = task.includes("meet.google.com") || task.includes("pending action"); const payload = needsAction ? { summary: "join meeting suggested", actions: [{ type: "join_meeting", title: "Join demo room", message: "Join the demo room and summarize it.", confidence: 0.88, requiresConfirmation: true }] } : { summary: "No action.", actions: [] }; console.log(JSON.stringify({ status: "completed", result: JSON.stringify(payload) })); });'`,
    MAB_DATA_DIR: dataDir,
    MAB_SLACK_POSTER_MOCK: "1",
    MAB_SLACK_EVENT_TRIAGE: "1",
    MAB_SLACK_TRIAGE_POST_ACTIONS: "1",
    MAB_SLACK_TRIAGE_HEURISTIC_FALLBACK: "1",
    SLACK_SIGNING_SECRET: "slack-triage-flow-signing-secret",
  };
  const slack = startService("apps/slack-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18944/healthz");
    const messages = [
      {
        teamId: "T_TRIAGE",
        channelId: "C_TRIAGE",
        userId: "U_PENG",
        text: "todo: follow up with the team about the Canvas summary and meeting recording",
        ts: "1778232000.000100",
        threadTs: "1778232000.000100",
      },
      {
        teamId: "T_TRIAGE",
        channelId: "C_TRIAGE",
        userId: "U_TEAM",
        text: "blocked until the bot posts the recap",
        ts: "1778232002.000200",
        threadTs: "1778232000.000100",
      },
    ];
    const events = [];
    for (const [index, message] of messages.entries()) {
      const event = await postSignedSlackJson(
        "http://127.0.0.1:18944/slack/events",
        {
          token: "deprecated-verification-token",
          team_id: message.teamId,
          api_app_id: "A_TRIAGE",
          event_id: `EvTRIAGE${index}`,
          type: "event_callback",
          event: {
            type: "message",
            channel: message.channelId,
            channel_type: "channel",
            user: message.userId,
            text: message.text,
            ts: message.ts,
            thread_ts: message.threadTs,
          },
        },
        { signingSecret: env.SLACK_SIGNING_SECRET },
      );
      assertSmoke(
        event.ok === true && event.mode === "event_buffer",
        "Slack event was not buffered for triage",
        event,
      );
      events.push(event);
    }
    const flush = await postJsonWithStatus("http://127.0.0.1:18944/slack/inbound/flush", {
      channel: "C_TRIAGE",
    });
    assertSmoke(
      flush.ok === true && flush.flushed?.[0]?.count === 2,
      "Slack triage buffer flush failed",
      flush,
    );

    const sweepFirst = await postJsonWithStatus("http://127.0.0.1:18944/slack/scanner/sweep", {
      workspace: "T_TRIAGE",
      channels: [
        {
          id: "C_SWEEP",
          name: "scanner-sweep",
          type: "public_channel",
          messages: [
            { user: "U_PENG", text: "first scanner sweep message", ts: "1778233000.000100" },
            {
              user: "U_TEAM",
              text: "second scanner sweep message",
              ts: "1778233002.000200",
              thread_ts: "1778233000.000100",
            },
          ],
        },
      ],
    });
    assertSmoke(
      sweepFirst.httpStatus === 200 && sweepFirst.ok === true,
      "Slack scanner first sweep failed",
      sweepFirst,
    );
    assertSmoke(
      sweepFirst.sweeps?.[0]?.buffered === 2,
      "Slack scanner first sweep did not buffer both messages",
      sweepFirst,
    );
    assertSmoke(
      sweepFirst.sweeps?.[0]?.flushed?.count === 2,
      "Slack scanner first sweep did not flush buffered messages",
      sweepFirst,
    );

    const sweepSecond = await postJsonWithStatus("http://127.0.0.1:18944/slack/scanner/sweep", {
      workspace: "T_TRIAGE",
      channels: [
        {
          id: "C_SWEEP",
          name: "scanner-sweep",
          type: "public_channel",
          messages: [
            { user: "U_PENG", text: "first scanner sweep message", ts: "1778233000.000100" },
            {
              user: "U_TEAM",
              text: "second scanner sweep message",
              ts: "1778233002.000200",
              thread_ts: "1778233000.000100",
            },
            { user: "U_PENG", text: "new scanner sweep message", ts: "1778233004.000300" },
          ],
        },
      ],
    });
    assertSmoke(
      sweepSecond.httpStatus === 200 && sweepSecond.ok === true,
      "Slack scanner second sweep failed",
      sweepSecond,
    );
    assertSmoke(
      sweepSecond.sweeps?.[0]?.previousCursor === sweepFirst.sweeps?.[0]?.nextCursor,
      "Slack scanner second sweep did not reuse cursor",
      { sweepFirst, sweepSecond },
    );
    assertSmoke(
      sweepSecond.sweeps?.[0]?.buffered === 1,
      "Slack scanner second sweep did not skip previously seen messages",
      sweepSecond,
    );

    const sweepContext = await (
      await fetch("http://127.0.0.1:18944/slack/domain/context?workspace=T_TRIAGE&channel=C_SWEEP")
    ).json();
    assertSmoke(
      sweepContext.context?.channel?.id === "C_SWEEP",
      "Slack scanner sweep did not upsert channel context",
      sweepContext,
    );
    assertSmoke(
      sweepContext.context?.recentThreads?.some(
        (entry) => entry.channel_id === "C_SWEEP" && entry.thread_ts === "1778233004.000300",
      ),
      "Slack scanner sweep did not replay the newly discovered message",
      sweepContext,
    );

    const followupCreate = await postJsonWithStatus(
      "http://127.0.0.1:18944/slack/followups/create",
      {
        channel: "C_FOLLOW",
        threadTs: "1778235000.000100",
        sessionId: "sess_followup_smoke",
        title: "Check boss demo follow-up",
        summary: "Make sure the Slack follow-up surface can be tracked without a heartbeat loop.",
        recommendationType: "review_thread",
        recommendationStatus: "active",
        outboundActionType: "post_followup",
        outboundStatus: "sent",
        followupStatus: "open",
        metadata: { source: "smoke" },
      },
    );
    assertSmoke(
      followupCreate.httpStatus === 200 && followupCreate.ok === true,
      "Slack followup create route failed",
      followupCreate,
    );
    assertSmoke(
      followupCreate.followup?.status === "open",
      "Slack followup route did not persist heartbeat followup",
      followupCreate,
    );
    assertSmoke(
      followupCreate.surface?.status === "sent",
      "Slack followup route did not persist surfaced heartbeat",
      followupCreate,
    );
    assertSmoke(
      followupCreate.recommendation?.status === "active",
      "Slack followup route did not persist thread recommendation",
      followupCreate,
    );
    assertSmoke(
      followupCreate.outbound?.status === "sent",
      "Slack followup route did not persist outbound action",
      followupCreate,
    );

    const followupStatus = await (
      await fetch("http://127.0.0.1:18944/slack/followups/status?limit=20")
    ).json();
    assertSmoke(
      followupStatus.heartbeatFollowups?.some(
        (entry) => entry.title === "Check boss demo follow-up",
      ),
      "Slack followup status did not list heartbeat followup",
      followupStatus,
    );
    assertSmoke(
      followupStatus.heartbeatSurfaces?.some((entry) => entry.session_id === "sess_followup_smoke"),
      "Slack followup status did not list heartbeat surface",
      followupStatus,
    );
    assertSmoke(
      followupStatus.threadRecommendations?.some(
        (entry) => entry.recommendation_type === "review_thread",
      ),
      "Slack followup status did not list thread recommendation",
      followupStatus,
    );
    assertSmoke(
      followupStatus.outboundActions?.some(
        (entry) => entry.action_type === "post_followup" && entry.status === "sent",
      ),
      "Slack followup status did not list outbound action",
      followupStatus,
    );

    const compactDate = "2026-01-01";
    const compactNote = Array.from({ length: 12 }, (_, index) => {
      return `## Scanner Topic ${index + 1}\n${"daily-note".repeat(45)}\n`;
    }).join("\n");
    await mkdir(pathJoin(dataDir, "slack-workspace", "memory"), { recursive: true });
    await writeFile(
      pathJoin(dataDir, "slack-workspace", "memory", `${compactDate}.md`),
      compactNote,
      "utf8",
    );
    const compactRoute = await postJsonWithStatus("http://127.0.0.1:18944/slack/scanner/compact", {
      date: compactDate,
    });
    assertSmoke(
      compactRoute.httpStatus === 200 && compactRoute.ok === true,
      "Slack scanner compaction route failed",
      compactRoute,
    );
    assertSmoke(
      compactRoute.eligible === true && compactRoute.sessionKind === "memory_compact",
      "Slack scanner compaction route did not detect eligible daily note",
      compactRoute,
    );
    assertSmoke(
      compactRoute.prompt?.includes(`memory/${compactDate}.md`),
      "Slack scanner compaction route did not build the expected prompt",
      compactRoute,
    );

    const mutationTriage = await postJsonWithStatus("http://127.0.0.1:18944/slack/triage/run", {
      team_id: "T_TRIAGE",
      channel_id: "C_ACTIONS",
      user_id: "U_PENG",
      text: "https://meet.google.com/abc-defg-hij 帮我让 bot 进会",
      ts: "1778234000.000100",
      thread_ts: "1778234000.000100",
    });
    assertSmoke(
      mutationTriage.httpStatus === 200 && mutationTriage.ok === true,
      "Slack triage explicit mutation route failed",
      mutationTriage,
    );

    let status = await (await fetch("http://127.0.0.1:18944/slack/triage/status?limit=10")).json();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pending = status.triage?.pendingActions || [];
      if (
        pending.some(
          (entry) =>
            entry.action_type === "join_meeting" && entry.thread_ts === "1778234000.000100",
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await (await fetch("http://127.0.0.1:18944/slack/triage/status?limit=10")).json();
    }
    const runs = status.triage?.runs || [];
    const pendingActions = status.triage?.pendingActions || [];
    const projectedTriage = loadTriageContextProjection(pathJoin(dataDir, "slack-workspace"));
    assertSmoke(
      runs.some((entry) => entry.status === "success"),
      "Slack triage flow did not record a successful triage run",
      status,
    );
    assertSmoke(
      pendingActions.some((entry) => entry.action_type === "join_meeting"),
      "Slack triage flow did not create a pending action for explicit mutation",
      status,
    );
    assertSmoke(
      pendingActions.some((entry) => entry.card_ts && entry.card_ts.startsWith("mock.")),
      "Slack triage flow did not post a mock action card",
      status,
    );
    assertSmoke(
      projectedTriage.some(
        (entry) =>
          entry.actions.length >= 1 &&
          entry.tool_calls.some((call) => call.tool === "agent_runner"),
      ),
      "Slack triage flow did not persist projected triage context",
      projectedTriage,
    );

    const blockFixture = buildSlackTriageActionBlocks({
      action: {
        type: "join_meeting",
        title: "Join demo room",
        message: "Join the demo room and summarize it.",
        reason: "Meet link appeared in the thread.",
        confidence: 0.88,
        channelId: "C_ACTIONS",
        threadTs: "1778234000.000100",
      },
      pendingAction: {
        id: 4242,
        channel_id: "C_ACTIONS",
        thread_ts: "1778234000.000100",
        action_type: "join_meeting",
      },
    });
    type ActionBlock = {
      type?: string;
      elements?: Array<{ action_id?: string; type?: string; [key: string]: unknown }>;
      [key: string]: unknown;
    };
    const actionBlock: ActionBlock =
      (blockFixture as ActionBlock[]).find((block) => block.type === "actions") || {};
    const actionIds = new Set((actionBlock.elements || []).map((element) => element.action_id));
    for (const expectedActionId of [
      "mab_pending_action_confirm",
      "mab_pending_action_dismiss",
      "mab_pending_action_snooze",
      "mab_pending_action_open_thread",
      "mab_pending_action_assign",
    ]) {
      assertSmoke(
        actionIds.has(expectedActionId),
        `Slack pending action Block Kit missing ${expectedActionId}`,
        blockFixture,
      );
    }
    const assignElement = (actionBlock.elements || []).find(
      (element) => element.action_id === "mab_pending_action_assign",
    );
    assertSmoke(
      assignElement?.type === "users_select",
      "Slack pending action assign control should be a users_select",
      blockFixture,
    );
    assertSmoke(
      !Object.prototype.hasOwnProperty.call(assignElement || {}, "value"),
      "Slack pending action assign control should not set unsupported value field",
      blockFixture,
    );

    const interactionSpecs = [
      { label: "confirm", status: "confirmed", actionId: "mab_pending_action_confirm" },
      { label: "dismiss", status: "dismissed", actionId: "mab_pending_action_dismiss" },
      {
        label: "snooze",
        status: "snoozed",
        actionId: "mab_pending_action_snooze",
        extra: { snoozeMinutes: 60 },
      },
      {
        label: "open",
        status: "opened",
        actionId: "mab_pending_action_open_thread",
        extra: { channelId: "C_ACTIONS", threadTs: "1778234000.000100" },
      },
      {
        label: "assign",
        status: "assigned",
        actionId: "mab_pending_action_assign",
        selectedUser: "U_ASSIGNEE",
        omitValue: true,
      },
    ];
    const interactions = [];
    for (const [index, spec] of interactionSpecs.entries()) {
      const threadTs = `17782340${index}.000100`;
      const triageRun = await postJsonWithStatus("http://127.0.0.1:18944/slack/triage/run", {
        team: "T_TRIAGE",
        channel: "C_ACTIONS",
        messages: [
          {
            teamId: "T_TRIAGE",
            channelId: "C_ACTIONS",
            userId: "U_PENG",
            text: `todo: ${spec.label} this pending action https://meet.google.com/abc-defg-hij`,
            ts: threadTs,
            threadTs,
          },
        ],
      });
      let pendingAction = triageRun.status?.pendingActions?.[0]?.pendingAction || null;
      for (let attempt = 0; !pendingAction && attempt < 5; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const triageStatus = await (
          await fetch("http://127.0.0.1:18944/slack/triage/status?limit=20")
        ).json();
        pendingAction =
          (triageStatus.triage?.pendingActions || []).find(
            (entry) => entry.thread_ts === threadTs,
          ) || null;
      }
      assertSmoke(
        pendingAction?.id,
        `Slack triage run did not create a pending action for ${spec.label}`,
        triageRun,
      );
      const interaction = await postSignedSlackInteraction(
        "http://127.0.0.1:18944/slack/interactions",
        {
          type: "block_actions",
          team: { id: "T_TRIAGE" },
          user: { id: "U_REVIEWER", username: "reviewer" },
          channel: { id: "C_ACTIONS", name: "actions" },
          message: {
            ts: pendingAction.card_ts || `mock.${index}`,
            thread_ts: pendingAction.thread_ts,
          },
          actions: [
            {
              action_id: spec.actionId,
              block_id: `mab_pending_action:${pendingAction.id}`,
              ...(!spec.omitValue
                ? {
                    value: JSON.stringify({
                      kind: "mab_pending_action",
                      id: pendingAction.id,
                      status: spec.status,
                      ...spec.extra,
                    }),
                  }
                : {}),
              ...(spec.selectedUser ? { selected_user: spec.selectedUser } : {}),
            },
          ],
        },
        { signingSecret: env.SLACK_SIGNING_SECRET },
      );
      assertSmoke(
        interaction.httpStatus === 200 && interaction.ok === true,
        `Slack pending action ${spec.label} interaction failed`,
        interaction,
      );
      assertSmoke(
        interaction.pendingAction?.status === spec.status,
        `Slack pending action ${spec.label} did not persist status`,
        interaction,
      );
      if (spec.selectedUser) {
        assertSmoke(
          String(interaction.pendingAction?.result || "").includes(spec.selectedUser),
          "Slack pending action assign did not persist assignee",
          interaction,
        );
      }
      interactions.push({ label: spec.label, response: interaction });
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          events,
          flush,
          sweepFirst,
          sweepSecond,
          sweepContext,
          followupCreate,
          followupStatus,
          compactRoute,
          status,
          projectedTriage,
          blockFixture,
          interactions,
        },
        null,
        2,
      ),
    );
  } finally {
    slack.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function waitForRunnerJob(runner, jobId, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = runner.getJob(jobId);
    if (last && ["completed", "failed", "timeout"].includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for runner job ${jobId}: ${JSON.stringify(last)}`);
}

async function waitForWorkerReportJob({ url, jobId, timeoutMs = 120_000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const body = await (await fetch(url)).json();
    last = body.jobs?.find((job) => job.id === jobId) || null;
    if (last && ["completed", "failed", "timeout"].includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for worker job ${jobId}: ${JSON.stringify(last)}`);
}

async function avatarSmoke() {
  const { chromium } = await import("playwright");
  const config = getRuntimeConfig();
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript({
      content: `
        (() => {
          if (typeof globalThis.__name !== "function") {
            Object.defineProperty(globalThis, "__name", {
              value: (fn) => fn,
              configurable: true,
            });
          }
        })();
      `,
    });
    await context.addInitScript({
      content: buildAvatarInitScript({
        botName: "Avatar Smoke Bot",
        disableLive2D: true,
      }),
    });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.waitForFunction(() => window.MAB_AVATAR_READY?.ok === true, null, {
      timeout: 10_000,
    });
    const result = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      return {
        ready: window.MAB_AVATAR_READY,
        videoTracks: stream.getVideoTracks().map((track) => ({
          id: track.id,
          readyState: track.readyState,
          settings: track.getSettings(),
        })),
        audioTracks: stream.getAudioTracks().map((track) => ({
          id: track.id,
          readyState: track.readyState,
          settings: track.getSettings(),
        })),
        devices: await navigator.mediaDevices.enumerateDevices(),
      };
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await browser.close();
  }
}

async function realtimeSmoke() {
  const config = getRuntimeConfig();
  const session = buildRealtimeSessionConfig({ botName: "Smoke Bot" }, config) as unknown as {
    model?: string;
    output_modalities?: string[];
    reasoning?: { effort?: string };
    audio?: { input?: { turn_detection?: { type?: string } } };
    [key: string]: unknown;
  };
  const reports = createWorkerReportStore();
  const job = reports.create({
    id: "job_smoke",
    status: "completed",
    task: "smoke worker completion",
    result: "Worker result is ready.",
  });
  const polled = reports.pollReadyForRealtime({ limit: 1, markDelivered: true });
  assertSmoke(
    session.model === "gpt-realtime-2",
    "Realtime default model is not gpt-realtime-2",
    session,
  );
  assertSmoke(
    Boolean(session.output_modalities?.includes("audio")),
    "Realtime 2 session did not request audio output",
    session,
  );
  assertSmoke(
    session.reasoning?.effort === "high",
    "Realtime 2 default reasoning effort should be high",
    session,
  );
  assertSmoke(
    session.audio?.input?.turn_detection?.type === "semantic_vad",
    "Realtime 2 session should default to semantic_vad",
    session,
  );
  assertSmoke(
    !("modalities" in session),
    "Realtime 2 session should not use legacy modalities",
    session,
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        instructions: buildRealtimeInstructions({ botName: "Smoke Bot" }),
        toolNames: realtimeToolSchemas.map((tool) => tool.name),
        session,
        job,
        polled,
        afterPoll: reports.get(job.id),
      },
      null,
      2,
    ),
  );
}

async function meetSmoke() {
  const fixture = await startLocalMeetFixtureServer();
  const joiner = createGoogleMeetJoiner({ allowNonGoogleMeet: true });
  try {
    const first = await joiner.join({
      sessionId: "meet_smoke_first",
      meetUrl: fixture.url,
      botName: "Meet Smoke Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      disableLive2D: true,
      collectFixtureState: true,
    });
    assertSmoke(first.clickedJoinSelector, "fixture join button was not clicked", first);
    assertSmoke(
      first.fixtureState?.joined === true,
      "fixture did not observe joined state",
      first.fixtureState,
    );
    assertSmoke(
      first.fixtureState?.name === "Meet Smoke Bot",
      "fixture did not receive bot display name",
      first.fixtureState,
    );
    assertSmoke(
      first.fixtureState?.media?.videoTracks?.length === 1,
      "fixture did not receive fake video track",
      first.fixtureState?.media,
    );
    assertSmoke(
      first.fixtureState?.media?.audioTracks?.length === 1,
      "fixture did not receive fake audio track",
      first.fixtureState?.media,
    );

    const second = await joiner.join({
      sessionId: "meet_smoke_second",
      meetUrl: fixture.url,
      botName: "Meet Smoke Bot 2",
      dryRun: false,
      allowNonGoogleMeet: true,
      disableLive2D: true,
      collectFixtureState: true,
    });
    assertSmoke(
      second.replacementStop?.stopped === true,
      "second join did not stop the first active browser",
      second.replacementStop,
    );
    assertSmoke(
      second.fixtureState?.joined === true,
      "second fixture join failed",
      second.fixtureState,
    );
    const status = await joiner.status();
    assertSmoke(
      status.active?.sessionId === "meet_smoke_second",
      "joiner status did not track the second session",
      status,
    );
    const stop = await joiner.stop("meet_smoke_done");
    assertSmoke(stop.stopped === true, "joiner stop did not close active browser", stop);
    console.log(
      JSON.stringify({ ok: true, fixtureUrl: fixture.url, first, second, status, stop }, null, 2),
    );
  } finally {
    await joiner.stop("meet_smoke_cleanup").catch(() => {});
    await fixture.close();
  }
}

async function meetContractSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-meet-contract-"));
  const screenshotDir = pathJoin(dataDir, "screenshots");
  const env = {
    MAB_MEETING_PORT: "18922",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18922",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
    MAB_SCREENSHOT_DIR: screenshotDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const fixtureUrl = `${fixture.url}?participantAudio=1`;
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const directJoiner = createGoogleMeetJoiner();

  try {
    const dryRun = await directJoiner.join({
      sessionId: "meet_contract_dry_run",
      meetUrl: "https://meet.google.com/abc-defg-hij?authuser=2",
      botName: "Meet Contract Bot",
      dryRun: true,
    });
    assertSmoke(dryRun.dryRun === true, "Meet dry-run contract did not return dryRun=true", dryRun);
    assertSmoke(
      dryRun.plan?.provider === "google-meet",
      "Meet dry-run plan did not report google-meet provider",
      dryRun,
    );
    assertSmoke(
      dryRun.plan?.botName === "Meet Contract Bot",
      "Meet dry-run plan did not preserve bot name",
      dryRun,
    );
    assertSmoke(
      dryRun.plan?.meetUrl?.includes("abc-defg-hij"),
      "Meet dry-run plan did not preserve Meet URL",
      dryRun,
    );
    assertSmoke(
      dryRun.plan?.steps?.some((step) => step.includes("click Join")),
      "Meet dry-run plan did not include join click step",
      dryRun.plan,
    );

    let invalidUrlError = "";
    try {
      await directJoiner.join({
        sessionId: "meet_contract_invalid",
        meetUrl: "https://example.com/not-a-meet",
        dryRun: true,
      });
    } catch (error) {
      invalidUrlError = String(error?.message || error);
    }
    assertSmoke(
      invalidUrlError.includes("Google Meet URL"),
      "Meet joiner accepted a non-Google Meet URL without allowNonGoogleMeet",
      { invalidUrlError },
    );

    const fixtureDryRun = await directJoiner.join({
      sessionId: "meet_contract_fixture_dry_run",
      meetUrl: fixture.url,
      botName: "Fixture Contract Bot",
      dryRun: true,
      allowNonGoogleMeet: true,
      installRealtimeBridge: false,
      installWorkerResultBridge: false,
    });
    assertSmoke(
      fixtureDryRun.plan?.allowNonGoogleMeet === true &&
        fixtureDryRun.plan?.meetUrl === fixture.url,
      "Meet joiner did not honor allowNonGoogleMeet for fixture dry-run",
      fixtureDryRun,
    );

    await waitForHealth("http://127.0.0.1:18922/healthz");

    const serviceDryRun = await postJson("http://127.0.0.1:18922/join/google-meet", {
      sessionId: "meet_contract_service_dry_run",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      botName: "Service Dry Run Bot",
      dryRun: true,
    });
    assertSmoke(
      serviceDryRun.ok === true && serviceDryRun.result?.dryRun === true,
      "Meeting Agent dry-run route failed",
      serviceDryRun,
    );
    assertSmoke(
      serviceDryRun.result?.plan?.installAvatar === true,
      "Meeting Agent dry-run did not install avatar by default",
      serviceDryRun,
    );

    const serviceInvalid = await postJsonWithStatus("http://127.0.0.1:18922/join/google-meet", {
      sessionId: "meet_contract_service_invalid",
      meetUrl: "https://example.com/not-a-meet",
      botName: "Invalid Service Bot",
      dryRun: true,
    });
    assertSmoke(
      serviceInvalid.httpStatus === 500 && serviceInvalid.detail?.includes("Google Meet URL"),
      "Meeting Agent route accepted invalid Meet URL",
      serviceInvalid,
    );

    const firstJoin = await postJson("http://127.0.0.1:18922/join/google-meet", {
      sessionId: "meet_contract_first",
      meetUrl: fixtureUrl,
      botName: "Meet Contract First",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installWorkerResultBridge: false,
      installRealtimeBridge: true,
      realtimeBridgeMode: "webrtc-mock",
      autoConnectRealtime: true,
    });
    const first = firstJoin.result;
    assertSmoke(
      first?.clickedJoinSelector,
      "Meet contract first join did not click Join",
      firstJoin,
    );
    assertSmoke(
      first?.fixtureState?.joined === true,
      "Meet contract fixture did not enter joined state",
      first?.fixtureState,
    );
    assertSmoke(
      first?.fixtureState?.name === "Meet Contract First",
      "Meet contract fixture did not preserve bot name",
      first?.fixtureState,
    );
    assertSmoke(
      first?.fixtureState?.media?.videoTracks?.length === 1,
      "Meet contract fixture did not receive fake video",
      first?.fixtureState?.media,
    );
    assertSmoke(
      first?.fixtureState?.media?.audioTracks?.length === 1,
      "Meet contract fixture did not receive fake audio",
      first?.fixtureState?.media,
    );
    assertSmoke(
      first?.fixtureState?.participantAudio?.trackIds?.length === 1,
      "Meet contract fixture did not expose participant audio",
      first?.fixtureState,
    );
    assertSmoke(
      first?.avatarReady?.ok === true,
      "Meet contract avatar runtime was not ready",
      first?.avatarReady,
    );
    assertSmoke(
      first?.avatarAudio?.ok === true,
      "Meet contract avatar fake mic bus was not ready",
      first?.avatarAudio,
    );
    assertSmoke(
      first?.screenshots?.length >= 2,
      "Meet contract did not capture diagnostics screenshots",
      first?.screenshots,
    );
    assertSmoke(
      existsSync(first?.diagnosticsPath || ""),
      "Meet contract diagnostics JSON was not written",
      { diagnosticsPath: first?.diagnosticsPath },
    );
    assertSmoke(
      first?.buttonInventories?.some((inventory) =>
        inventory.buttons?.some((button) => /join now/i.test(button.aria || button.text || "")),
      ),
      "Meet contract diagnostics did not record the fixture join button",
      first?.buttonInventories,
    );

    const participantStatus = await waitForJoinStatus(
      "http://127.0.0.1:18922/join/status",
      (body) =>
        body.active?.realtimeBridge?.connection?.participantAudioTracksDiscovered >= 1 ||
        (body.active?.realtimeBridge?.errors || []).length > 0,
      8_000,
    );
    const bridge = participantStatus.active?.realtimeBridge;
    assertSmoke(!bridge?.errors?.length, "Meet contract Realtime bridge reported errors", bridge);
    assertSmoke(
      bridge?.connection?.participantAudioTracksDiscovered >= 1,
      "Meet contract did not discover participant audio through the bridge",
      bridge?.connection,
    );
    assertSmoke(
      bridge?.connection?.participantAudioSources?.some(
        (source) => source.label === "fixture-participant-audio",
      ),
      "Meet contract did not preserve participant audio source label",
      bridge?.connection,
    );

    const secondJoin = await postJson("http://127.0.0.1:18922/join/google-meet", {
      sessionId: "meet_contract_second",
      meetUrl: fixture.url,
      botName: "Meet Contract Second",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installRealtimeBridge: false,
      installWorkerResultBridge: false,
    });
    const second = secondJoin.result;
    assertSmoke(
      second?.replacementStop?.stopped === true,
      "Meet contract second join did not stop the first browser",
      second?.replacementStop,
    );
    assertSmoke(
      second?.replacementStop?.sessionId === "meet_contract_first",
      "Meet contract replacement stopped the wrong session",
      second?.replacementStop,
    );
    assertSmoke(
      second?.fixtureState?.joined === true,
      "Meet contract second fixture join failed",
      second?.fixtureState,
    );

    const status = await (await fetch("http://127.0.0.1:18922/join/status")).json();
    assertSmoke(
      status.active?.sessionId === "meet_contract_second",
      "Meet contract status did not track second active session",
      status,
    );
    assertSmoke(
      status.active?.fixtureState?.joined === true,
      "Meet contract status did not refresh fixture state",
      status.active,
    );

    const stop = await postJson("http://127.0.0.1:18922/join/stop", {
      reason: "meet_contract_done",
    });
    assertSmoke(
      stop.result?.stopped === true,
      "Meet contract stop route did not close active browser",
      stop,
    );
    assertSmoke(
      stop.result?.sessionId === "meet_contract_second",
      "Meet contract stop closed the wrong session",
      stop,
    );
    const afterStop = await (await fetch("http://127.0.0.1:18922/join/status")).json();
    assertSmoke(
      afterStop.active === null,
      "Meet contract status remained active after stop",
      afterStop,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          contracts: {
            dryRun,
            invalidUrlRejected: true,
            fixtureDryRun,
            serviceDryRun,
            serviceInvalid,
            firstJoin,
            participantStatus,
            secondJoin,
            status,
            stop,
            afterStop,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await postJson("http://127.0.0.1:18922/join/stop", { reason: "meet_contract_cleanup" }).catch(
      () => {},
    );
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function screenShareSmoke() {
  const fixture = await startLocalMeetFixtureServer();
  const joiner = createGoogleMeetJoiner({ allowNonGoogleMeet: true });
  try {
    const join = await joiner.join({
      sessionId: "screen_share_smoke",
      meetUrl: fixture.url,
      botName: "Screen Share Smoke Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installRealtimeBridge: false,
      installWorkerResultBridge: false,
      installScreenShareBridge: true,
      autoStartScreenShare: false,
      screenShareTitle: "Meeting Avatar Bot",
      screenShareSubtitle: "Screen share smoke",
    });
    assertSmoke(
      join.ok === true && join.clickedJoinSelector,
      "screen-share smoke did not join fixture",
      join,
    );
    const present = await joiner.presentScreenShare({
      title: "Meeting Avatar Bot",
      subtitle: "Screen share smoke",
      waitMs: 700,
    });
    assertSmoke(
      present.ok === true && present.clickedSelector,
      "screen-share present path did not click share control",
      present,
    );
    assertSmoke(
      present.screenShare?.active === true,
      "screen-share bridge did not become active",
      present.screenShare,
    );
    assertSmoke(
      present.fixtureState?.screenShare?.videoTracks?.length === 1,
      "fixture did not receive screen-share stream",
      present.fixtureState?.screenShare,
    );
    assertSmoke(
      present.fixtureState?.screenShare?.videoTracks?.[0]?.settings?.width >= 640,
      "screen-share stream did not expose useful video settings",
      present.fixtureState?.screenShare,
    );
    const status = await joiner.status();
    assertSmoke(
      status.active?.screenShare?.active === true,
      "joiner status did not expose active screen-share state",
      status,
    );
    const stoppedShare = await joiner.stopScreenShare();
    assertSmoke(
      stoppedShare.ok === true && stoppedShare.screenShare?.active === false,
      "screen-share stop did not deactivate stream",
      stoppedShare,
    );
    const stop = await joiner.stop("screen_share_smoke_done");
    assertSmoke(stop.stopped === true, "screen-share smoke did not close active browser", stop);
    console.log(
      JSON.stringify(
        { ok: true, fixtureUrl: fixture.url, join, present, status, stoppedShare, stop },
        null,
        2,
      ),
    );
  } finally {
    await joiner.stop("screen_share_smoke_cleanup").catch(() => {});
    await fixture.close();
  }
}

async function realMeetSmoke() {
  const meetUrl = process.env.MAB_REAL_MEET_URL || "";
  const required = process.env.MAB_REQUIRE_REAL_MEET === "1";
  if (!meetUrl) {
    const skipped = {
      ok: true,
      skipped: true,
      reason: "MAB_REAL_MEET_URL missing",
      note: "Set MAB_REAL_MEET_URL and MAB_REQUIRE_REAL_MEET=1 to make this optional smoke mandatory.",
    };
    if (required) {
      assertSmoke(false, "MAB_REAL_MEET_URL is required when MAB_REQUIRE_REAL_MEET=1", skipped);
    }
    console.log(JSON.stringify(skipped, null, 2));
    return;
  }

  const sessionId = process.env.MAB_REAL_MEET_SESSION_ID || `real_meet_${Date.now()}`;
  const botName = process.env.MAB_REAL_MEET_BOT_NAME || "Meeting Avatar Real Smoke";
  const waitMs = Number.parseInt(process.env.MAB_REAL_MEET_WAIT_MS || "8000", 10);
  const joiner = createGoogleMeetJoiner();
  try {
    const join = await joiner.join({
      sessionId,
      meetUrl,
      botName,
      dryRun: false,
      disableLive2D: process.env.MAB_REAL_MEET_DISABLE_LIVE2D === "1",
      installWorkerResultBridge: true,
      installRealtimeBridge: true,
      realtimeBridgeMode: "mock",
      autoConnectRealtime: false,
      sendRealtimeSessionUpdate: false,
    });
    assertSmoke(
      join.ok === true && join.dryRun === false,
      "real Meet smoke did not perform a non-dry-run join",
      join,
    );
    assertSmoke(join.clickedJoinSelector, "real Meet smoke did not click a join button", join);
    assertSmoke(
      join.avatarReady?.ok === true,
      "real Meet smoke avatar/fake media was not ready",
      join.avatarReady,
    );
    assertSmoke(
      join.avatarAudio?.ok === true,
      "real Meet smoke avatar audio bus was not ready",
      join.avatarAudio,
    );

    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const status = (await joiner.status()) as {
      active?: {
        avatarReady?: unknown;
        avatarAudio?: unknown;
        realtimeBridge?: {
          connection?: { participantAudioTracksDiscovered?: number };
          [key: string]: unknown;
        };
        [key: string]: unknown;
      };
    };
    const active = status.active || {};
    type ButtonInventoryEntry = {
      buttons?: Array<{ visible?: boolean; aria?: string; text?: string }>;
    };
    const inventories = ((join as { buttonInventories?: ButtonInventoryEntry[] })
      .buttonInventories || []) as ButtonInventoryEntry[];
    const latestInventory: ButtonInventoryEntry = inventories.at(-1) || {};
    const latestButtons = latestInventory.buttons || [];
    const visibleButtonLabels = latestButtons
      .filter((button) => button.visible)
      .map((button) => button.aria || button.text || "")
      .filter(Boolean);
    const inCallControlsVisible = visibleButtonLabels.some((label) =>
      /leave call|turn off microphone|turn off camera/i.test(label),
    );
    const participantAudioTracks =
      active.realtimeBridge?.connection?.participantAudioTracksDiscovered || 0;
    assertSmoke(
      inCallControlsVisible || participantAudioTracks > 0,
      "real Meet smoke did not observe in-call controls or participant audio tracks",
      { visibleButtonLabels, participantAudioTracks, join, status },
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          meetUrl,
          sessionId,
          botName,
          clickedJoinSelector: join.clickedJoinSelector,
          diagnosticsPath: join.diagnosticsPath,
          screenshots: join.screenshots,
          visibleButtonLabels,
          inCallControlsVisible,
          participantAudioTracks,
          avatarReady: active.avatarReady || join.avatarReady,
          avatarAudio: active.avatarAudio || join.avatarAudio,
          realtimeBridge: active.realtimeBridge || null,
        },
        null,
        2,
      ),
    );
  } finally {
    await joiner.stop("real_meet_smoke_done").catch(() => {});
  }
}

async function persistenceSmokeForProvider({ provider, slackPort, meetingPort }) {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), `meeting-avatar-bot-persist-${provider}-`));
  const sqlitePath = pathJoin(dataDir, "state.sqlite3");
  const env = {
    MAB_SLACK_PORT: String(slackPort),
    MAB_MEETING_PORT: String(meetingPort),
    MAB_MEETING_AGENT_URL: `http://127.0.0.1:${meetingPort}`,
    MAB_STATE_PROVIDER: provider,
    MAB_STATE_SQLITE_PATH: sqlitePath,
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    SLACK_SIGNING_SECRET: `persist-signing-secret-${provider}`,
  };
  const slackUrl = `http://127.0.0.1:${slackPort}`;
  const meetingUrl = `http://127.0.0.1:${meetingPort}`;

  let meeting = null;
  let slack = null;
  try {
    meeting = startService("apps/meeting-agent/src/index.js", env);
    slack = startService("apps/slack-agent/src/index.js", env);
    await waitForServiceHealth(meeting, `${meetingUrl}/healthz`);
    await waitForServiceHealth(slack, `${slackUrl}/healthz`);
    const firstSlackHealth = await (await fetch(`${slackUrl}/healthz`)).json();
    const firstMeetingHealth = await (await fetch(`${meetingUrl}/healthz`)).json();
    assertSmoke(
      firstSlackHealth.state?.provider === provider,
      `Slack Agent did not use ${provider} state provider`,
      firstSlackHealth,
    );
    assertSmoke(
      firstMeetingHealth.state?.provider === provider,
      `Meeting Agent did not use ${provider} state provider`,
      firstMeetingHealth,
    );
    assertSmoke(
      firstMeetingHealth.state?.workerReportProvider === provider,
      `Meeting worker reports did not use ${provider} state provider`,
      firstMeetingHealth,
    );
    if (provider === "sqlite") {
      assertSmoke(
        firstSlackHealth.state?.sessionPath === sqlitePath,
        "Slack Agent sqlite path mismatch",
        firstSlackHealth,
      );
      assertSmoke(
        firstMeetingHealth.state?.workerReportPath === sqlitePath,
        "Meeting worker sqlite path mismatch",
        firstMeetingHealth,
      );
    }

    const join = await postSignedSlackCommand(
      `${slackUrl}/slack/commands/avatar`,
      `join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name Persist${provider}`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    const sessionId = join.session?.id;
    assertSmoke(
      sessionId,
      `persistence smoke did not create a Slack session for ${provider}`,
      join,
    );

    const delegate = await postSignedSlackCommand(
      `${slackUrl}/slack/commands/avatar`,
      `delegate --session ${sessionId} remember this completed ${provider} worker job`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      delegate.job?.status === "completed",
      `persistence smoke worker did not complete for ${provider}`,
      delegate,
    );

    for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));

    meeting = startService("apps/meeting-agent/src/index.js", env);
    slack = startService("apps/slack-agent/src/index.js", env);
    await waitForServiceHealth(meeting, `${meetingUrl}/healthz`);
    await waitForServiceHealth(slack, `${slackUrl}/healthz`);
    const secondSlackHealth = await (await fetch(`${slackUrl}/healthz`)).json();
    const secondMeetingHealth = await (await fetch(`${meetingUrl}/healthz`)).json();
    assertSmoke(
      secondSlackHealth.state?.provider === provider,
      `Slack Agent state provider changed after restart for ${provider}`,
      secondSlackHealth,
    );
    assertSmoke(
      secondMeetingHealth.state?.workerReportProvider === provider,
      `Meeting worker report provider changed after restart for ${provider}`,
      secondMeetingHealth,
    );

    const sessionsAfterRestart = await (await fetch(`${slackUrl}/sessions`)).json();
    assertSmoke(
      sessionsAfterRestart.sessions.some((session) => session.id === sessionId),
      `Slack session was not restored after service restart for ${provider}`,
      sessionsAfterRestart,
    );

    const jobsAfterRestart = await (await fetch(`${meetingUrl}/worker/jobs`)).json();
    assertSmoke(
      jobsAfterRestart.jobs.some((job) => job.id === delegate.job.id),
      `Meeting worker job was not restored after service restart for ${provider}`,
      jobsAfterRestart,
    );

    return {
      provider,
      dataDir,
      sqlitePath: provider === "sqlite" ? sqlitePath : "",
      health: { firstSlackHealth, firstMeetingHealth, secondSlackHealth, secondMeetingHealth },
      join,
      delegate,
      sessionsAfterRestart,
      jobsAfterRestart,
    };
  } finally {
    for (const service of [slack, meeting]) {
      if (service) service.child.kill("SIGTERM");
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function persistenceSmoke() {
  const jsonFile = await persistenceSmokeForProvider({
    provider: "json-file",
    slackPort: 18884,
    meetingPort: 18885,
  });
  const sqlite = await persistenceSmokeForProvider({
    provider: "sqlite",
    slackPort: 18894,
    meetingPort: 18895,
  });
  console.log(
    JSON.stringify(
      { ok: true, providers: ["json-file", "sqlite"], results: [jsonFile, sqlite] },
      null,
      2,
    ),
  );
}

async function stateProviderSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-state-provider-"));
  const sessionPath = pathJoin(dataDir, "sessions.json");
  const jobsPath = pathJoin(dataDir, "worker-reports.json");
  const sqlitePath = pathJoin(dataDir, "state.sqlite3");
  const closeables = [];
  try {
    const sessions = createSessionStore({ provider: "json-file", filePath: sessionPath });
    const session = sessions.create({
      source: "state-provider-smoke",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      requestedBy: "smoke",
    });
    sessions.update(session.id, { status: "joined" });

    const restoredSessions = createSessionStore({ provider: "json-file", filePath: sessionPath });
    const restoredSession = restoredSessions.get(session.id);
    assertSmoke(
      restoredSessions.provider === "json-file",
      "session store did not report json-file provider",
      restoredSessions,
    );
    assertSmoke(
      restoredSession?.status === "joined",
      "json-file session provider did not restore updated session",
      restoredSession,
    );

    const reports = createWorkerReportStore({ provider: "json-file", filePath: jobsPath });
    const job = reports.create({
      id: "job_state_provider_smoke",
      status: "completed",
      task: "persist this worker result",
      result: "worker result survived restart",
    });
    const ready = reports.pollReadyForSlack({ limit: 1, markDelivered: true });
    assertSmoke(ready[0]?.id === job.id, "json-file worker provider did not poll ready job", ready);

    const restoredReports = createWorkerReportStore({ provider: "json-file", filePath: jobsPath });
    const restoredJob = restoredReports.get(job.id);
    assertSmoke(
      restoredReports.provider === "json-file",
      "worker report store did not report json-file provider",
      restoredReports,
    );
    assertSmoke(
      restoredJob?.deliveredToSlack === true,
      "json-file worker provider did not persist delivery marker",
      restoredJob,
    );

    const memorySessions = createSessionStore({
      provider: "memory",
      filePath: pathJoin(dataDir, "ignored.json"),
    });
    const memorySession = memorySessions.create({ source: "memory-provider-smoke" });
    const freshMemorySessions = createSessionStore({
      provider: "memory",
      filePath: pathJoin(dataDir, "ignored.json"),
    });
    assertSmoke(
      memorySessions.provider === "memory" && memorySessions.path === "",
      "memory state provider did not stay in-memory",
      memorySessions,
    );
    assertSmoke(
      !freshMemorySessions.get(memorySession.id),
      "memory state provider unexpectedly restored state",
      {
        original: memorySession,
        restored: freshMemorySessions.get(memorySession.id),
      },
    );

    const legacyDb = new Database(sqlitePath);
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS thread_case (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        channel_id TEXT,
        thread_ts TEXT,
        status TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS meeting (
        id TEXT PRIMARY KEY,
        meet_url TEXT,
        status TEXT,
        updated_at TEXT
      );
      INSERT OR REPLACE INTO thread_case (id, workspace_id, channel_id, thread_ts, status, updated_at)
      VALUES ('legacy_thread_case', 'T_SMOKE', 'C_SMOKE', '123.456', 'open', '2026-05-08T00:00:00.000Z');
      INSERT OR REPLACE INTO meeting (id, meet_url, status, updated_at)
      VALUES ('legacy_meeting', 'https://meet.google.com/abc-defg-hij', 'scheduled', '2026-05-08T00:00:00.000Z');
    `);
    legacyDb.close();

    const sqliteSessions = createSessionStore({
      provider: "sqlite",
      sqlitePath,
      collection: "slack_sessions",
    });
    closeables.push(sqliteSessions);
    const sqliteSession = sqliteSessions.create({
      source: "sqlite-state-provider-smoke",
      meetUrl: "https://meet.google.com/sql-ite-smk",
      requestedBy: "smoke",
    });
    sqliteSessions.update(sqliteSession.id, { status: "sqlite_joined" });
    const restoredSqliteSessions = createSessionStore({
      provider: "sqlite",
      sqlitePath,
      collection: "slack_sessions",
    });
    closeables.push(restoredSqliteSessions);
    const restoredSqliteSession = restoredSqliteSessions.get(sqliteSession.id);
    assertSmoke(
      restoredSqliteSessions.provider === "sqlite",
      "session store did not report sqlite provider",
      restoredSqliteSessions,
    );
    assertSmoke(
      restoredSqliteSession?.status === "sqlite_joined",
      "sqlite session provider did not restore updated session",
      restoredSqliteSession,
    );

    const sqliteReports = createWorkerReportStore({
      provider: "sqlite",
      sqlitePath,
      collection: "worker_reports",
    });
    closeables.push(sqliteReports);
    const sqliteJob = sqliteReports.create({
      id: "job_sqlite_state_provider_smoke",
      status: "completed",
      task: "persist this sqlite worker result",
      result: "sqlite worker result survived restart",
    });
    const sqliteReady = sqliteReports.pollReadyForSlack({ limit: 1, markDelivered: true });
    assertSmoke(
      sqliteReady[0]?.id === sqliteJob.id,
      "sqlite worker provider did not poll ready job",
      sqliteReady,
    );
    const restoredSqliteReports = createWorkerReportStore({
      provider: "sqlite",
      sqlitePath,
      collection: "worker_reports",
    });
    closeables.push(restoredSqliteReports);
    const restoredSqliteJob = restoredSqliteReports.get(sqliteJob.id);
    assertSmoke(
      restoredSqliteJob?.deliveredToSlack === true,
      "sqlite worker provider did not persist delivery marker",
      restoredSqliteJob,
    );

    const concurrentA = createSessionStore({
      provider: "sqlite",
      sqlitePath,
      collection: "concurrent_sessions",
    });
    const concurrentB = createSessionStore({
      provider: "sqlite",
      sqlitePath,
      collection: "concurrent_sessions",
    });
    closeables.push(concurrentA, concurrentB);
    const concurrentSessionA = concurrentA.create({
      source: "sqlite-concurrent-a",
      requestedBy: "a",
    });
    const concurrentSessionB = concurrentB.create({
      source: "sqlite-concurrent-b",
      requestedBy: "b",
    });
    concurrentA.update(concurrentSessionA.id, { status: "writer_a_updated" });
    concurrentB.update(concurrentSessionB.id, { status: "writer_b_updated" });
    const concurrentReader = createSessionStore({
      provider: "sqlite",
      sqlitePath,
      collection: "concurrent_sessions",
    });
    closeables.push(concurrentReader);
    assertSmoke(
      concurrentReader.get(concurrentSessionA.id)?.status === "writer_a_updated" &&
        concurrentReader.get(concurrentSessionB.id)?.status === "writer_b_updated",
      "sqlite state provider did not survive interleaved writers",
      {
        a: concurrentReader.get(concurrentSessionA.id),
        b: concurrentReader.get(concurrentSessionB.id),
      },
    );

    const inspectDb = new Database(sqlitePath, { readonly: true });
    const tableNames = inspectDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    const migrations = inspectDb
      .prepare("SELECT version, name FROM mab_schema_migrations ORDER BY version")
      .all();
    inspectDb.close();
    for (const expectedTable of [
      "mab_schema_migrations",
      "mab_state_collection",
      "thread_case",
      "meeting",
    ]) {
      assertSmoke(
        tableNames.includes(expectedTable),
        `sqlite compatibility table missing: ${expectedTable}`,
        tableNames,
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          providers: ["memory", "json-file", "sqlite"],
          sessionPath,
          jobsPath,
          sqlitePath,
          restoredSession,
          restoredJob,
          memory: { provider: memorySessions.provider, path: memorySessions.path },
          sqlite: {
            restoredSession: restoredSqliteSession,
            restoredJob: restoredSqliteJob,
            concurrent: concurrentReader.list(),
            migrations,
            tableNames,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    for (const closeable of closeables) closeable.close?.();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function workerBridgeSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-worker-bridge-"));
  const env = {
    MAB_MEETING_PORT: "18886",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18886",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18886/healthz");
    const workerResultMinCreatedAt = new Date(Date.now() - 1000).toISOString();
    const longWorkerResult = [
      "Worker bridge smoke long detail sentinel.",
      "This is intentionally long so the bridge writes the full result to Meet chat instead of asking Realtime to read it aloud.",
      "DETAIL_SENTINEL_".repeat(70),
    ].join("\n");
    const reported = await postJson("http://127.0.0.1:18886/worker/report", {
      id: "job_worker_bridge_smoke",
      status: "completed",
      task: "prepare a spoken status update",
      result: longWorkerResult,
      context: {
        source: "meeting-worker-bridge-smoke",
        session_kind: "meeting_copilot",
        meeting_session_id: "worker_bridge_smoke",
      },
    });
    assertSmoke(reported.ok === true, "worker report route failed", reported);

    const join = await postJson("http://127.0.0.1:18886/join/google-meet", {
      sessionId: "worker_bridge_smoke",
      meetUrl: fixture.url,
      botName: "Worker Bridge Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      workerPollUrl: "http://127.0.0.1:18886/worker/poll-realtime",
      workerResultMinCreatedAt,
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "worker bridge smoke did not join fixture",
      join,
    );

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const status = await (await fetch("http://127.0.0.1:18886/join/status")).json();
    const workerJobs = await (await fetch("http://127.0.0.1:18886/worker/jobs")).json();
    const deliveredJob = workerJobs.jobs.find((job) => job.id === "job_worker_bridge_smoke");
    assertSmoke(
      deliveredJob?.deliveredToRealtime === true,
      "worker job was not marked delivered to realtime",
      {
        workerJobs,
        workerResultBridge: status.active?.workerResultBridge,
        meetPage: status.active?.meetPage,
      },
    );
    const realtimeTexts = (status.active?.fixtureState?.realtimeEvents || [])
      .flatMap((event) => event.item?.content || [])
      .map((content) => String(content.text || ""));
    assertSmoke(
      (status.active?.fixtureState?.chatMessages || []).some((entry) =>
        String(entry.text || "").includes("Worker bridge smoke long detail sentinel"),
      ),
      "long worker result was not written to Meet chat",
      status.active?.fixtureState,
    );
    assertSmoke(
      realtimeTexts.some((text) => text.includes("完整结果我已经发到 Meet chat")),
      "long worker result did not use short voice handoff text",
      realtimeTexts,
    );
    assertSmoke(
      !realtimeTexts.some((text) => text.includes("DETAIL_SENTINEL_DETAIL_SENTINEL")),
      "long worker result leaked into realtime voice context",
      realtimeTexts,
    );
    assertSmoke(
      status.active?.workerResultBridge?.delivered?.some(
        (job) => job.jobId === "job_worker_bridge_smoke",
      ),
      "worker bridge did not deliver the meeting-scoped worker job to the browser",
      status.active?.workerResultBridge,
    );

    console.log(JSON.stringify({ ok: true, reported, join, status, workerJobs }, null, 2));
  } finally {
    await postJson("http://127.0.0.1:18886/join/stop", {
      reason: "worker_bridge_smoke_done",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function realtimeBrowserSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-realtime-browser-"));
  const env = {
    MAB_MEETING_PORT: "18887",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18887",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18887/healthz");
    const workerResultMinCreatedAt = new Date(Date.now() - 1000).toISOString();
    const reported = await postJson("http://127.0.0.1:18887/worker/report", {
      id: "job_realtime_browser_smoke",
      status: "completed",
      task: "summarize completed browser bridge work",
      result: "Realtime browser bridge smoke result.",
      context: {
        source: "meeting-realtime-browser-smoke",
        session_kind: "meeting_copilot",
        meeting_session_id: "realtime_browser_smoke",
      },
    });
    assertSmoke(reported.ok === true, "realtime browser worker report failed", reported);

    const join = await postJson("http://127.0.0.1:18887/join/google-meet", {
      sessionId: "realtime_browser_smoke",
      meetUrl: fixture.url,
      botName: "Realtime Browser Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      workerPollUrl: "http://127.0.0.1:18887/worker/poll-realtime",
      workerResultMinCreatedAt,
      installRealtimeBridge: true,
      realtimeBridgeMode: "mock",
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "realtime browser smoke did not join fixture",
      join,
    );

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const status = await (await fetch("http://127.0.0.1:18887/join/status")).json();
    const workerJobs = await (await fetch("http://127.0.0.1:18887/worker/jobs")).json();
    const realtimeEvents = status.active?.fixtureState?.realtimeEvents || [];
    const eventTypes = new Set(realtimeEvents.map((event) => event.type));
    const deliveredJob = workerJobs.jobs.find((job) => job.id === "job_realtime_browser_smoke");
    assertSmoke(
      deliveredJob?.deliveredToRealtime === true,
      "worker job was not marked delivered to realtime",
      {
        workerJobs,
        workerResultBridge: status.active?.workerResultBridge,
        realtimeBridge: status.active?.realtimeBridge,
      },
    );
    assertSmoke(
      eventTypes.has("conversation.item.create"),
      "worker result did not create a realtime conversation item",
      status,
    );
    assertSmoke(
      eventTypes.has("response.create"),
      "worker result did not request a realtime response",
      status,
    );
    assertSmoke(
      status.active?.realtimeBridge?.responsesRequested >= 1,
      "browser realtime bridge did not record a response request",
      status.active?.realtimeBridge,
    );

    console.log(JSON.stringify({ ok: true, reported, join, status, workerJobs }, null, 2));
  } finally {
    await postJson("http://127.0.0.1:18887/join/stop", {
      reason: "realtime_browser_smoke_done",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function realtimeWebrtcSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-realtime-webrtc-"));
  const env = {
    MAB_MEETING_PORT: "18888",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18888",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18888/healthz");
    const workerResultMinCreatedAt = new Date(Date.now() - 1000).toISOString();
    const reported = await postJson("http://127.0.0.1:18888/worker/report", {
      id: "job_realtime_webrtc_smoke",
      status: "completed",
      task: "verify data-channel worker result reporting",
      result: "Realtime WebRTC smoke result.",
      context: {
        source: "meeting-realtime-webrtc-smoke",
        session_kind: "meeting_copilot",
        meeting_session_id: "realtime_webrtc_smoke",
      },
    });
    assertSmoke(reported.ok === true, "realtime webrtc worker report failed", reported);

    const join = await postJson("http://127.0.0.1:18888/join/google-meet", {
      sessionId: "realtime_webrtc_smoke",
      meetUrl: fixture.url,
      botName: "Realtime WebRTC Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      workerPollUrl: "http://127.0.0.1:18888/worker/poll-realtime",
      workerResultMinCreatedAt,
      installRealtimeBridge: true,
      realtimeBridgeMode: "webrtc-mock",
      autoConnectRealtime: true,
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "realtime webrtc smoke did not join fixture",
      join,
    );

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const status = await (await fetch("http://127.0.0.1:18888/join/status")).json();
    const workerJobs = await (await fetch("http://127.0.0.1:18888/worker/jobs")).json();
    const bridge = status.active?.realtimeBridge;
    const eventTypes = new Set((bridge?.outbound || []).map((entry) => entry.event?.type));
    const sentPayloadTypes = new Set((bridge?.connection?.sentDataChannelMessages || []).map((entry) => {
      try {
        return JSON.parse(entry.payload).type;
      } catch {
        return "";
      }
    }));
    const deliveredJob = workerJobs.jobs.find((job) => job.id === "job_realtime_webrtc_smoke");
    assertSmoke(
      deliveredJob?.deliveredToRealtime === true,
      "worker job was not marked delivered to realtime",
      { workerJobs, workerResultBridge: status.active?.workerResultBridge, realtimeBridge: bridge },
    );
    assertSmoke(
      bridge?.connected === true,
      "browser realtime bridge did not connect in WebRTC mock mode",
      bridge,
    );
    assertSmoke(
      bridge?.connection?.dataChannelOpen === true,
      "browser realtime data channel did not open",
      bridge?.connection,
    );
    assertSmoke(
      eventTypes.has("conversation.item.create"),
      "worker result did not create a realtime conversation item",
      bridge,
    );
    assertSmoke(
      eventTypes.has("response.create"),
      "worker result did not request a realtime response",
      bridge,
    );
    assertSmoke(
      sentPayloadTypes.has("conversation.item.create"),
      "conversation item was not sent over data-channel seam",
      bridge?.connection,
    );
    assertSmoke(
      sentPayloadTypes.has("response.create"),
      "response request was not sent over data-channel seam",
      bridge?.connection,
    );

    console.log(JSON.stringify({ ok: true, reported, join, status, workerJobs }, null, 2));
  } finally {
    await postJson("http://127.0.0.1:18888/join/stop", {
      reason: "realtime_webrtc_smoke_done",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function realtimeAudioRouteSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-realtime-audio-route-"));
  const env = {
    MAB_MEETING_PORT: "18890",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18890",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18890/healthz");
    const join = await postJson("http://127.0.0.1:18890/join/google-meet", {
      sessionId: "realtime_audio_route_smoke",
      meetUrl: fixture.url,
      botName: "Realtime Audio Route Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installWorkerResultBridge: false,
      installRealtimeBridge: true,
      realtimeBridgeMode: "webrtc-mock",
      autoConnectRealtime: true,
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "realtime audio route smoke did not join fixture",
      join,
    );
    assertSmoke(
      join.result?.fixtureState?.media?.audioTracks?.length === 1,
      "fixture did not receive the avatar fake mic track",
      join.result?.fixtureState?.media,
    );

    const status = await waitForJoinStatus(
      "http://127.0.0.1:18890/join/status",
      (body) =>
        body.active?.realtimeBridge?.connection?.mockRemoteAudioInjected === true ||
        (body.active?.realtimeBridge?.errors || []).length > 0,
      8_000,
    );
    const bridge = status.active?.realtimeBridge;
    const avatarAudio = status.active?.avatarAudio;
    assertSmoke(
      bridge?.errors?.length === 0,
      "Realtime audio route bridge reported errors",
      bridge,
    );
    assertSmoke(
      bridge?.connection?.remoteAudioRoutedToAvatarBus === true,
      "Realtime remote audio was not routed to the avatar audio bus",
      bridge?.connection,
    );
    assertSmoke(
      avatarAudio?.injectedTones >= 1 || avatarAudio?.routedStreams >= 1,
      "avatar audio bus did not record a routed remote audio source",
      avatarAudio,
    );

    console.log(JSON.stringify({ ok: true, join, status }, null, 2));
  } finally {
    await postJson("http://127.0.0.1:18890/join/stop", {
      reason: "realtime_audio_route_smoke_done",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function realtimeParticipantAudioSmoke() {
  const dataDir = await mkdtemp(
    pathJoin(tmpdir(), "meeting-avatar-bot-realtime-participant-audio-"),
  );
  const env = {
    MAB_MEETING_PORT: "18891",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18891",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const fixtureUrl = `${fixture.url}?participantAudio=1`;
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18891/healthz");
    const join = await postJson("http://127.0.0.1:18891/join/google-meet", {
      sessionId: "realtime_participant_audio_smoke",
      meetUrl: fixtureUrl,
      botName: "Realtime Participant Audio Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installWorkerResultBridge: false,
      installRealtimeBridge: true,
      realtimeBridgeMode: "webrtc-mock",
      autoConnectRealtime: true,
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "participant audio smoke did not join fixture",
      join,
    );
    assertSmoke(
      join.result?.fixtureState?.participantAudio?.trackIds?.length === 1,
      "fixture did not create participant audio",
      join.result?.fixtureState,
    );

    const status = await waitForJoinStatus(
      "http://127.0.0.1:18891/join/status",
      (body) =>
        (body.active?.realtimeBridge?.connection?.participantAudioTracksDiscovered >= 1 &&
          body.active?.realtimeBridge?.connection?.dataChannelOpen === true) ||
        (body.active?.realtimeBridge?.errors || []).length > 0,
      8_000,
    );
    const bridge = status.active?.realtimeBridge;
    assertSmoke(bridge?.errors?.length === 0, "participant audio bridge reported errors", bridge);
    assertSmoke(
      bridge?.connection?.participantAudioTracksDiscovered >= 1,
      "Realtime bridge did not discover participant audio tracks",
      bridge?.connection,
    );
    assertSmoke(
      bridge?.connection?.participantAudioSources?.some(
        (source) => source.label === "fixture-participant-audio",
      ),
      "Realtime bridge did not record the fixture participant source",
      bridge?.connection,
    );
    assertSmoke(
      bridge?.connection?.meetAudioTracksForwarded >= 1,
      "Realtime bridge did not forward participant audio into the Realtime input mix",
      bridge?.connection,
    );
    const audioBlockers = new Set(bridge?.feedback?.blockers || []);
    assertSmoke(
      !audioBlockers.has("waiting_for_meet_audio"),
      "Realtime harness did not prove it is using Meet participant audio",
      bridge?.feedback,
    );
    assertSmoke(
      bridge?.timeline?.some((entry) => entry.type === "meet_audio_track_forwarded"),
      "Realtime bridge did not record participant audio forwarding in the timeline",
      bridge?.timeline,
    );
    assertSmoke(
      bridge?.connected === true,
      "Realtime bridge did not connect in participant audio smoke",
      bridge,
    );
    assertSmoke(
      bridge?.connection?.dataChannelOpen === true,
      "Realtime data channel did not open in participant audio smoke",
      bridge,
    );

    console.log(JSON.stringify({ ok: true, join, status }, null, 2));
  } finally {
    await postJson("http://127.0.0.1:18891/join/stop", {
      reason: "realtime_participant_audio_smoke_done",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function realtimeRepeatGuardSmoke() {
  const { chromium } = await import("playwright");
  const config = getRuntimeConfig();
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript({
      content: buildAvatarInitScript({
        botName: "Realtime Repeat Guard Bot",
        disableLive2D: true,
      }),
    });
    await context.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
      }),
    });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.waitForFunction(
      () => {
        const ready = window.MAB_AVATAR_READY as { ok?: boolean } | null | undefined;
        const bridge = window.MAB_REALTIME_BRIDGE as
          | { connection?: { dataChannelOpen?: boolean } }
          | null
          | undefined;
        return ready?.ok === true && bridge?.connection?.dataChannelOpen === true;
      },
      null,
      { timeout: 10_000 },
    );

    type RepeatGuardResult = {
      firstDelivery?: unknown;
      duplicateDelivery?: { duplicate?: boolean };
      bridge?: RealtimeBridgeSnapshot;
    };
    const result = (await page.evaluate(() => {
      const job = {
        id: "job_repeat_guard_smoke",
        status: "completed",
        task: "verify duplicate worker guard",
        result: "Only one spoken report should be requested.",
      };
      const client = window.MAB_REALTIME_CLIENT as
        | { injectWorkerResult?: (job: unknown) => unknown }
        | null
        | undefined;
      const firstDelivery = client?.injectWorkerResult?.(job);
      const duplicateDelivery = client?.injectWorkerResult?.(job);
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "response.created",
            response: { id: "resp_repeat_guard_smoke" },
          },
        }),
      );
      window.dispatchEvent(new CustomEvent("meeting-avatar-user-speech-started"));
      return {
        firstDelivery,
        duplicateDelivery,
        bridge: window.MAB_REALTIME_BRIDGE,
      };
    })) as RepeatGuardResult;
    const eventTypes = (result.bridge?.outbound || []).map((entry) => entry.event?.type);
    const sentPayloadTypes = (result.bridge?.connection?.sentDataChannelMessages || []).map(
      (entry) => {
        try {
          return JSON.parse(String(entry.payload || "")).type as string | undefined;
        } catch {
          return "";
        }
      },
    );
    assertSmoke(
      result.duplicateDelivery?.duplicate === true,
      "duplicate worker result was not skipped",
      result,
    );
    assertSmoke(
      result.bridge?.protection?.duplicateWorkerResultsSkipped === 1,
      "duplicate worker skip counter did not increment",
      result.bridge?.protection,
    );
    assertSmoke(
      eventTypes.filter((type) => type === "response.create").length === 1,
      "repeat guard requested more than one response for a duplicate worker result",
      result.bridge?.outbound,
    );
    assertSmoke(
      eventTypes.includes("response.cancel"),
      "user speech did not cancel active response",
      result.bridge?.outbound,
    );
    assertSmoke(
      sentPayloadTypes.includes("response.cancel"),
      "response.cancel was not sent over data channel",
      result.bridge?.connection,
    );
    assertSmoke(
      result.bridge?.protection?.userSpeechCancels === 1,
      "user speech cancel counter did not increment",
      result.bridge?.protection,
    );

    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await browser.close();
  }
}

async function realtimeSessionUpdateSmoke() {
  const { chromium } = await import("playwright");
  const config = getRuntimeConfig();
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });
  try {
    const instructions = buildRealtimeInstructions({ botName: "Session Update Smoke Bot" });
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
        instructions,
        tools: realtimeToolSchemas,
      }),
    });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.waitForFunction(
      () => {
        const bridge = window.MAB_REALTIME_BRIDGE as
          | { connection?: { dataChannelOpen?: boolean } }
          | null
          | undefined;
        return bridge?.connection?.dataChannelOpen === true;
      },
      null,
      { timeout: 10_000 },
    );

    type SessionUpdateSession = {
      model?: string;
      output_modalities?: string[];
      audio?: { input?: { turn_detection?: { type?: string } } };
      reasoning?: { effort?: string };
      instructions?: string;
      tools?: Array<{ name?: string }>;
      [key: string]: unknown;
    };
    type SessionUpdateBridge = RealtimeBridgeSnapshot & {
      session?: { configured?: boolean; toolNames?: string[] };
      timeline?: Array<{ type?: string; detail?: { type?: string } }>;
      outbound?: Array<{
        event?: SessionUpdateSession & { type?: string; session?: SessionUpdateSession };
      }>;
      connection?: { sentDataChannelMessages?: Array<{ payload?: string }> };
    };
    const result = (await page.evaluate(() => ({
      bridge: window.MAB_REALTIME_BRIDGE,
      clientTools: Object.keys(window.MAB_REALTIME_CLIENT || {}),
    }))) as { bridge?: SessionUpdateBridge; clientTools?: string[] };
    const sentEvents = collectRealtimeSentEvents(result.bridge || {}) as Array<
      Record<string, unknown> & { type?: string; session?: SessionUpdateSession }
    >;
    const sessionUpdate = sentEvents.find((event) => event.type === "session.update");
    const toolNames = (sessionUpdate?.session?.tools || [])
      .map((tool) => tool.name)
      .filter(Boolean);
    assertSmoke(
      result.bridge?.session?.configured === true,
      "Realtime session was not marked configured",
      result.bridge?.session,
    );
    assertSmoke(
      Boolean(sessionUpdate),
      "Realtime bridge did not send session.update over the data channel",
      sentEvents,
    );
    assertSmoke(
      sessionUpdate?.session?.model === "gpt-realtime-2",
      "session.update did not default to gpt-realtime-2",
      sessionUpdate,
    );
    assertSmoke(
      Boolean(sessionUpdate?.session?.output_modalities?.includes("audio")),
      "session.update did not use Realtime 2 output_modalities",
      sessionUpdate,
    );
    assertSmoke(
      sessionUpdate?.session?.audio?.input?.turn_detection?.type === "semantic_vad",
      "session.update did not use Realtime 2 semantic_vad",
      sessionUpdate,
    );
    assertSmoke(
      sessionUpdate?.session?.reasoning?.effort === "high",
      "session.update did not set high Realtime 2 reasoning effort",
      sessionUpdate,
    );
    assertSmoke(
      !("modalities" in (sessionUpdate?.session || {})),
      "session.update used legacy modalities",
      sessionUpdate,
    );
    assertSmoke(
      Boolean(sessionUpdate?.session?.instructions?.includes("Session Update Smoke Bot")),
      "session.update did not include runtime instructions",
      sessionUpdate,
    );
    assertSmoke(
      toolNames.includes("delegate_to_worker"),
      "session.update did not include delegate_to_worker",
      toolNames,
    );
    assertSmoke(
      toolNames.includes("update_avatar_state"),
      "session.update did not include update_avatar_state",
      toolNames,
    );
    assertSmoke(
      Boolean(result.bridge?.session?.toolNames?.includes("update_avatar_state")),
      "Realtime bridge did not record configured avatar tool names",
      result.bridge?.session,
    );
    assertSmoke(
      Boolean(
        result.bridge?.timeline?.some(
          (entry) => entry.type === "realtime_outbound" && entry.detail?.type === "session.update",
        ),
      ),
      "Realtime bridge did not record session.update in the timeline",
      result.bridge?.timeline,
    );

    console.log(JSON.stringify({ ok: true, ...result, sessionUpdate }, null, 2));
  } finally {
    await browser.close();
  }
}

async function realtimeWorkerToolSmoke() {
  const { chromium } = await import("playwright");
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-realtime-worker-tool-"));
  const env = {
    MAB_MEETING_PORT: "18892",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18892",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const config = getRuntimeConfig();
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });
  try {
    await waitForHealth("http://127.0.0.1:18892/healthz");
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
        simulateRemoteAudio: false,
        workerDelegateUrl: "http://127.0.0.1:18892/worker/delegate",
        workerStatusUrl: "http://127.0.0.1:18892/worker/status",
      }),
    });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:18892/healthz");
    await page.waitForFunction(
      () =>
        (
          window.MAB_REALTIME_BRIDGE as
            | { connection?: { dataChannelOpen?: boolean } }
            | null
            | undefined
        )?.connection?.dataChannelOpen === true,
      null,
      { timeout: 10_000 },
    );

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "response.function_call_arguments.done",
            name: "delegate_to_worker",
            call_id: "call_delegate_worker_smoke",
            arguments: JSON.stringify({
              task: "Summarize the Realtime worker tool bridge.",
              context: "Local smoke test from Realtime function call.",
              mode: "analysis",
              allowCodeChanges: false,
            }),
          },
        }),
      );
    });
    await page.waitForFunction(
      () => {
        const tools = (
          window.MAB_REALTIME_BRIDGE as
            | {
                workerTools?: {
                  calls?: Array<{ name?: string; result?: { job?: { id?: string } } }>;
                  errors?: unknown[];
                };
              }
            | null
            | undefined
        )?.workerTools;
        return (
          tools?.calls?.some((call) => call.name === "delegate_to_worker") ||
          tools?.errors?.length > 0
        );
      },
      null,
      { timeout: 10_000 },
    );

    const delegateState = (await page.evaluate(() => {
      const bridge = window.MAB_REALTIME_BRIDGE as {
        workerTools?: {
          calls?: Array<{ name?: string; result?: { job?: { id?: string } } }>;
          errors?: unknown[];
        };
      } | null;
      const call = bridge?.workerTools?.calls?.find((entry) => entry.name === "delegate_to_worker");
      return {
        call,
        bridge: window.MAB_REALTIME_BRIDGE,
      };
    })) as {
      call?: RealtimeBridgeWorkerToolCall;
      bridge?: RealtimeBridgeSnapshot;
    };
    assertSmoke(
      !delegateState.bridge?.workerTools?.errors?.length,
      "delegate_to_worker recorded worker tool errors",
      delegateState.bridge?.workerTools,
    );
    const jobId = delegateState.call?.result?.job?.id;
    assertSmoke(Boolean(jobId), "delegate_to_worker did not return a worker job id", delegateState);

    await page.evaluate((id) => {
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "response.function_call_arguments.done",
            name: "worker_status",
            call_id: "call_worker_status_smoke",
            arguments: JSON.stringify({ jobId: id }),
          },
        }),
      );
    }, jobId);
    await page.waitForFunction(
      () =>
        (
          window.MAB_REALTIME_BRIDGE as
            | {
                workerTools?: {
                  calls?: Array<{ name?: string; result?: { job?: { id?: string } } }>;
                  errors?: unknown[];
                };
              }
            | null
            | undefined
        )?.workerTools?.calls?.some((call) => call.name === "worker_status"),
      null,
      { timeout: 10_000 },
    );

    const result = (await page.evaluate(() => ({
      bridge: window.MAB_REALTIME_BRIDGE,
      clientTools: Object.keys(window.MAB_REALTIME_CLIENT || {}),
    }))) as { bridge?: RealtimeBridgeSnapshot; clientTools?: string[] };
    const sentEvents = collectRealtimeSentEvents(result.bridge || {}) as Array<
      Record<string, unknown> & {
        type?: string;
        item?: { type?: string; call_id?: string };
      }
    >;
    const functionOutputs = sentEvents.filter(
      (event) => event.item?.type === "function_call_output",
    );
    const outputCallIds = new Set(functionOutputs.map((event) => event.item?.call_id));
    const workerJobs = (await (await fetch("http://127.0.0.1:18892/worker/jobs")).json()) as {
      jobs?: Array<{ id?: string; status?: string }>;
    };
    const reportedJob = workerJobs.jobs?.find((job) => job.id === jobId);

    assertSmoke(
      outputCallIds.has("call_delegate_worker_smoke"),
      "delegate_to_worker did not emit a function_call_output",
      sentEvents,
    );
    assertSmoke(
      outputCallIds.has("call_worker_status_smoke"),
      "worker_status did not emit a function_call_output",
      sentEvents,
    );
    assertSmoke(
      Boolean(
        result.bridge?.inbound?.some(
          (entry) =>
            entry.event?.type === "response.function_call_arguments.done" &&
            entry.event?.name === "delegate_to_worker",
        ),
      ),
      "Realtime bridge did not record inbound delegate_to_worker event",
      result.bridge?.inbound,
    );
    assertSmoke(
      Boolean(
        result.bridge?.timeline?.some(
          (entry) => entry.type === "realtime_inbound" && entry.detail?.name === "worker_status",
        ),
      ),
      "Realtime bridge did not record inbound worker_status event in timeline",
      result.bridge?.timeline,
    );
    assertSmoke(
      Boolean(
        result.bridge?.workerTools?.calls?.some(
          (call) => call.name === "worker_status" && call.result?.job?.id === jobId,
        ),
      ),
      "worker_status did not return the delegated job",
      result.bridge?.workerTools,
    );
    assertSmoke(
      reportedJob?.status === "completed",
      "delegated worker job was not reported to Meeting Agent",
      workerJobs,
    );
    assertSmoke(
      sentEvents.some((event) => event.type === "response.create"),
      "worker tool call did not request a follow-up response",
      sentEvents,
    );

    console.log(JSON.stringify({ ok: true, jobId, ...result, workerJobs }, null, 2));
  } finally {
    await browser.close();
    meeting.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function realtimeLiveToolSmoke() {
  const config = getRuntimeConfig();
  const shouldRunLive = shouldRunOptionalSmoke(
    "MAB_RUN_REALTIME_LIVE_TOOL",
    "MAB_REQUIRE_REALTIME_LIVE_TOOL",
  );
  if (!config.openaiApiKey || !shouldRunLive) {
    const skipped = {
      ok: true,
      skipped: true,
      reason: config.openaiApiKey
        ? "MAB_RUN_REALTIME_LIVE_TOOL not enabled"
        : "MAB_OPENAI_API_KEY/OPENAI_API_KEY missing",
      note: "Set MAB_RUN_REALTIME_LIVE_TOOL=1 to run this optional smoke. Set MAB_REQUIRE_REALTIME_LIVE_TOOL=1 to make it mandatory.",
    };
    if (process.env.MAB_REQUIRE_REALTIME_LIVE_TOOL === "1") {
      assertSmoke(
        false,
        "MAB_OPENAI_API_KEY or OPENAI_API_KEY is required when MAB_REQUIRE_REALTIME_LIVE_TOOL=1",
        skipped,
      );
    }
    console.log(JSON.stringify(skipped, null, 2));
    return;
  }

  const { chromium } = await import("playwright");
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-realtime-live-tool-"));
  const liveToolAgentRunner =
    process.env.MAB_REALTIME_LIVE_TOOL_AGENT_RUNNER || process.env.MAB_AGENT_RUNNER || "dry-run";
  const liveToolDryRunAgent =
    process.env.MAB_REALTIME_LIVE_TOOL_DRY_RUN_AGENT ||
    (String(liveToolAgentRunner).trim().toLowerCase() === "dry-run" ? "1" : "0");
  const env = {
    MAB_MEETING_PORT: "18893",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18893",
    MAB_BROWSER_HEADLESS: "true",
    MAB_AGENT_RUNNER: liveToolAgentRunner,
    MAB_DRY_RUN_AGENT: liveToolDryRunAgent,
    MAB_DATA_DIR: dataDir,
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const delegateTool = realtimeToolSchemas.find((tool) => tool.name === "delegate_to_worker");
  assertSmoke(delegateTool, "delegate_to_worker tool schema missing", realtimeToolSchemas);
  try {
    await waitForHealth("http://127.0.0.1:18893/healthz");
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    // Keep page.evaluate callbacks usable when this smoke is run through tsx/esbuild.
    await context.addInitScript({
      content: `
        (() => {
          if (typeof globalThis.__name !== "function") {
            Object.defineProperty(globalThis, "__name", {
              value: (fn) => fn,
              configurable: true,
            });
          }
        })();
      `,
    });
    await context.addInitScript({
      content: buildAvatarInitScript({
        botName: "Realtime Live Tool Bot",
        disableLive2D: true,
      }),
    });
    await context.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc",
        autoConnect: true,
        simulateRemoteAudio: false,
        tokenUrl: "http://127.0.0.1:18893/realtime/client-secret",
        sdpUrl: config.openaiRealtimeSdpUrl,
        workerDelegateUrl: "http://127.0.0.1:18893/worker/delegate",
        workerStatusUrl: "http://127.0.0.1:18893/worker/status",
        instructions: [
          "You are a Realtime live smoke test agent.",
          "When the user asks you to delegate a task, call delegate_to_worker exactly once.",
          "Do not answer from memory for delegated tasks.",
        ].join(" "),
        tools: [delegateTool],
        session: { tool_choice: "auto" },
        sendSessionUpdateOnConnect: true,
      }),
    });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:18893/healthz");
    await page.waitForFunction(
      () =>
        window.MAB_AVATAR_READY?.ok === true &&
        (
          window.MAB_REALTIME_BRIDGE as
            | { connection?: { dataChannelOpen?: boolean } }
            | null
            | undefined
        )?.connection?.dataChannelOpen === true,
      null,
      { timeout: 35_000 },
    );

    await page.evaluate((tool) => {
      window.MAB_REALTIME_CLIENT.sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "请把这个测试任务委托给后台 worker：用一句话说明 Realtime live tool smoke 已经触发。",
            },
          ],
        },
      });
      window.MAB_REALTIME_CLIENT.sendRealtimeEvent({
        type: "response.create",
        response: {
          instructions:
            "You must call delegate_to_worker once with a short Chinese task. Do not produce a final answer before the function call.",
          tools: [tool],
          tool_choice: "required",
        },
      });
    }, delegateTool);

    await page.waitForFunction(
      () => {
        const bridge = window.MAB_REALTIME_BRIDGE as
          | {
              workerTools?: { calls?: Array<{ name?: string }>; errors?: unknown[] };
              errors?: unknown[];
            }
          | null
          | undefined;
        return Boolean(
          bridge?.workerTools?.calls?.some((call) => call.name === "delegate_to_worker") ||
          (bridge?.workerTools?.errors?.length || 0) > 0 ||
          (bridge?.errors?.length || 0) > 0,
        );
      },
      null,
      { timeout: 45_000 },
    );

    const result = (await page.evaluate(() => ({
      bridge: window.MAB_REALTIME_BRIDGE,
      avatar: window.MAB_AVATAR_READY,
      clientTools: Object.keys(window.MAB_REALTIME_CLIENT || {}),
    }))) as {
      bridge?: RealtimeBridgeSnapshot & { errors?: unknown[] };
      avatar?: unknown;
      clientTools?: string[];
    };
    const sentEvents = collectRealtimeSentEvents(result.bridge || {}) as Array<
      Record<string, unknown> & { item?: { type?: string; call_id?: string } }
    >;
    const delegateCall = result.bridge?.workerTools?.calls?.find(
      (call) => call.name === "delegate_to_worker",
    ) as (RealtimeBridgeWorkerToolCall & { callId?: string }) | undefined;
    const delegateCalls =
      result.bridge?.workerTools?.calls?.filter((call) => call.name === "delegate_to_worker") || [];

    assertSmoke(
      !result.bridge?.errors?.length,
      "Realtime live bridge reported errors",
      result.bridge?.errors,
    );
    assertSmoke(
      !result.bridge?.workerTools?.errors?.length,
      "Realtime live worker tool reported errors",
      result.bridge?.workerTools,
    );
    assertSmoke(
      result.bridge?.connection?.dataChannelOpen === true,
      "Realtime live data channel did not open",
      result.bridge?.connection,
    );
    assertSmoke(
      Boolean(delegateCall?.result?.job?.id),
      "Realtime live model did not trigger delegate_to_worker",
      result.bridge?.workerTools,
    );
    assertSmoke(
      delegateCalls.length === 1,
      "Realtime live delegate_to_worker call was handled more than once for the same model call",
      result.bridge?.workerTools,
    );
    assertSmoke(
      sentEvents.some(
        (event) =>
          event.item?.type === "function_call_output" &&
          event.item?.call_id === delegateCall?.callId,
      ),
      "Realtime live delegate call did not emit function_call_output",
      sentEvents,
    );
    const completedWorkerJob = await waitForWorkerReportJob({
      url: "http://127.0.0.1:18893/worker/jobs",
      jobId: delegateCall.result.job.id,
      timeoutMs: Number(process.env.MAB_REALTIME_LIVE_TOOL_WORKER_TIMEOUT_MS || 120_000),
    });
    assertSmoke(
      completedWorkerJob.status === "completed",
      "Realtime live delegated worker job did not complete successfully",
      completedWorkerJob,
    );
    assertSmoke(
      completedWorkerJob.provider === liveToolAgentRunner || liveToolAgentRunner === "dry-run",
      "Realtime live delegated worker job used the wrong AgentRunner provider",
      { expected: liveToolAgentRunner, completedWorkerJob },
    );
    const finalWorkerJobs = await (await fetch("http://127.0.0.1:18893/worker/jobs")).json();
    assertSmoke(
      finalWorkerJobs.jobs.some(
        (job) => job.id === delegateCall.result.job.id && job.status === "completed",
      ),
      "Realtime live delegated worker job was not completed in Meeting Agent",
      finalWorkerJobs,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          agentRunner: liveToolAgentRunner,
          delegateCall,
          completedWorkerJob,
          ...result,
          workerJobs: finalWorkerJobs,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    meeting.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function realtimeLiveRoutingSmoke() {
  const config = getRuntimeConfig();
  const shouldRunLive = shouldRunOptionalSmoke(
    "MAB_RUN_REALTIME_LIVE_ROUTING",
    "MAB_REQUIRE_REALTIME_LIVE_ROUTING",
  );
  if (!config.openaiApiKey || !shouldRunLive) {
    const skipped = {
      ok: true,
      skipped: true,
      reason: config.openaiApiKey
        ? "MAB_RUN_REALTIME_LIVE_ROUTING not enabled"
        : "MAB_OPENAI_API_KEY/OPENAI_API_KEY missing",
      note: "Set MAB_RUN_REALTIME_LIVE_ROUTING=1 to run this optional smoke. Set MAB_REQUIRE_REALTIME_LIVE_ROUTING=1 to make it mandatory.",
    };
    if (process.env.MAB_REQUIRE_REALTIME_LIVE_ROUTING === "1") {
      assertSmoke(
        false,
        "MAB_OPENAI_API_KEY or OPENAI_API_KEY is required when MAB_REQUIRE_REALTIME_LIVE_ROUTING=1",
        skipped,
      );
    }
    console.log(JSON.stringify(skipped, null, 2));
    return;
  }

  const { chromium } = await import("playwright");
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-realtime-live-routing-"));
  const env = {
    MAB_MEETING_PORT: "18894",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18894",
    MAB_BROWSER_HEADLESS: "true",
    MAB_AGENT_RUNNER: "dry-run",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const visualToolNames = [
    "share_existing_app_window",
    "open_shared_browser_surface",
    "create_shared_workspace",
    "stop_video_stage",
    "stop_shared_browser_surface",
    "list_shareable_windows",
    "control_shared_app_window",
  ];
  const visualTools = visualToolNames.map((name) => {
    const tool = realtimeToolSchemas.find((entry) => entry.name === name);
    assertSmoke(tool, `Realtime visual routing tool schema missing: ${name}`, visualToolNames);
    return tool;
  });
  const cases = [
    {
      id: "existing_app_pencil",
      text: "用 Pencil 演示当前画面",
      expectedTools: ["share_existing_app_window"],
    },
    {
      id: "control_shared_pencil",
      text: "Pencil 已经在屏幕共享里了，请在 Pencil 里画一个贪食蛇 mockup",
      expectedTools: ["control_shared_app_window"],
      requireOperations: true,
    },
    {
      id: "ambiguous_app_editor",
      text: "用编辑器演示当前画面",
      expectedTools: ["list_shareable_windows"],
    },
    {
      id: "browser_url",
      text: "打开 https://example.com 给我看",
      expectedTools: ["open_shared_browser_surface"],
    },
    {
      id: "generate_snake",
      text: "做一个贪吃蛇，然后给我看",
      expectedTools: ["create_shared_workspace"],
    },
    {
      id: "create_dashboard",
      text: "做一个 Q3 metrics dashboard",
      expectedTools: ["create_shared_workspace"],
    },
    {
      id: "stop_share",
      text: "停止分享",
      expectedTools: ["stop_video_stage", "stop_shared_browser_surface"],
    },
    {
      id: "stop_when_idle_negative",
      text: "现在没有共享时停止分享",
      expectedTools: ["stop_video_stage", "stop_shared_browser_surface"],
      forbiddenTools: [
        "share_existing_app_window",
        "open_shared_browser_surface",
        "create_shared_workspace",
      ],
    },
  ];
  const results: unknown[] = [];

  try {
    await waitForServiceHealth(meeting, "http://127.0.0.1:18894/healthz", 20_000);
    for (const testCase of cases) {
      const context = await browser.newContext({ permissions: ["microphone", "camera"] });
      await context.addInitScript({
        content: `
          (() => {
            if (typeof globalThis.__name !== "function") {
              Object.defineProperty(globalThis, "__name", {
                value: (fn) => fn,
                configurable: true,
              });
            }
          })();
        `,
      });
      await context.addInitScript({
        content: buildAvatarInitScript({
          botName: "Realtime Visual Routing Bot",
          disableLive2D: true,
        }),
      });
      await context.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "webrtc",
          agentRuntime: config.openaiRealtimeAgentRuntime,
          autoConnect: true,
          simulateRemoteAudio: false,
          tokenUrl: "http://127.0.0.1:18894/realtime/client-secret",
          sdpUrl: config.openaiRealtimeSdpUrl,
          instructions: buildRealtimeInstructions({
            botName: "Realtime Visual Routing Bot",
          }),
          tools: visualTools,
          session: { tool_choice: "auto" },
          sendSessionUpdateOnConnect: true,
          dryRunLocalTools: true,
        }),
      });
      const page = await context.newPage();
      try {
        await page.goto("http://127.0.0.1:18894/healthz");
        await page.waitForFunction(
          () =>
            window.MAB_AVATAR_READY?.ok === true &&
            (
              window.MAB_REALTIME_BRIDGE as
                | { connection?: { dataChannelOpen?: boolean } }
                | null
                | undefined
            )?.connection?.dataChannelOpen === true,
          null,
          { timeout: 35_000 },
        );

        await page.evaluate(
          ({ text, tools }) => {
            window.MAB_REALTIME_CLIENT.sendRealtimeEvent({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text }],
              },
            });
            window.MAB_REALTIME_CLIENT.sendRealtimeEvent({
              type: "response.create",
              response: {
                tools,
                tool_choice: "auto",
              },
            });
          },
          { text: testCase.text, tools: visualTools },
        );

        await page.waitForFunction(
          () => {
            const bridge = window.MAB_REALTIME_BRIDGE as
              | {
                  meetTools?: { calls?: unknown[]; errors?: unknown[] };
                  workspaceTools?: { calls?: unknown[]; errors?: unknown[] };
                  errors?: unknown[];
                }
              | null
              | undefined;
            return Boolean(
              (bridge?.meetTools?.calls?.length || 0) +
                (bridge?.workspaceTools?.calls?.length || 0) >
                0 ||
                (bridge?.meetTools?.errors?.length || 0) > 0 ||
                (bridge?.workspaceTools?.errors?.length || 0) > 0 ||
                (bridge?.errors?.length || 0) > 0,
            );
          },
          null,
          { timeout: 45_000 },
        );
        if ("requireOperations" in testCase && testCase.requireOperations) {
          await page.waitForFunction(
            () => {
              const calls =
                (
                  window.MAB_REALTIME_BRIDGE as
                    | {
                        workspaceTools?: {
                          calls?: Array<{ name?: string; arguments?: { operations?: unknown } }>;
                        };
                      }
                    | null
                    | undefined
                )?.workspaceTools?.calls || [];
              return calls.some((call) => {
                if (call.name !== "control_shared_app_window") return false;
                const operations = Array.isArray(call.arguments?.operations)
                  ? (call.arguments.operations as Array<{ kind?: unknown }>)
                  : [];
                return operations.some((operation) => String(operation?.kind || "") !== "state");
              });
            },
            null,
            { timeout: 45_000 },
          );
        }

        const result = (await page.evaluate(() => ({
          bridge: window.MAB_REALTIME_BRIDGE,
          avatar: window.MAB_AVATAR_READY,
        }))) as {
          bridge?: RealtimeBridgeSnapshot & {
            meetTools?: { calls?: Array<{ name?: string; [key: string]: unknown }>; errors?: unknown[] };
            workspaceTools?: {
              calls?: Array<{ name?: string; [key: string]: unknown }>;
              errors?: unknown[];
            };
            errors?: unknown[];
          };
          avatar?: unknown;
        };
        const calls = [
          ...(result.bridge?.meetTools?.calls || []),
          ...(result.bridge?.workspaceTools?.calls || []),
        ];
        const actualTools = calls.map((call) => call.name).filter(Boolean);
        assertSmoke(
          actualTools.length > 0,
          `Realtime routing case ${testCase.id} did not call a visual tool`,
          result.bridge,
        );
        const forbiddenTools = "forbiddenTools" in testCase ? testCase.forbiddenTools : [];
        assertSmoke(
          !actualTools.some((tool) => forbiddenTools.includes(String(tool || ""))),
          `Realtime routing case ${testCase.id} called forbidden surface creation tool`,
          { text: testCase.text, actualTools, forbiddenTools, calls, bridge: result.bridge },
        );
        assertSmoke(
          testCase.expectedTools.includes(String(actualTools[0] || "")),
          `Realtime routing case ${testCase.id} called ${actualTools[0]}, expected ${testCase.expectedTools.join(" or ")}`,
          { text: testCase.text, actualTools, calls, bridge: result.bridge },
        );
        const appControlCalls =
          "requireOperations" in testCase && testCase.requireOperations
            ? calls.filter((call) => call.name === "control_shared_app_window")
            : [];
        const directOperationCall = appControlCalls.find((call) => {
          const args = call.arguments as { operations?: unknown } | undefined;
          const operations = Array.isArray(args?.operations)
            ? (args.operations as Array<{ kind?: unknown }>)
            : [];
          return operations.some((operation) => String(operation?.kind || "") !== "state");
        });
        if ("requireOperations" in testCase && testCase.requireOperations) {
          const operations = appControlCalls.flatMap((call) => {
            const args = call.arguments as { operations?: unknown } | undefined;
            return Array.isArray(args?.operations) ? (args.operations as Array<{ kind?: unknown }>) : [];
          });
          assertSmoke(
            operations.some((operation) => String(operation?.kind || "") !== "state"),
            `Realtime routing case ${testCase.id} did not continue with direct app-control operations after state`,
            { text: testCase.text, actualTools, appControlCalls, bridge: result.bridge },
          );
        }
        results.push({
          id: testCase.id,
          text: testCase.text,
          expectedTools: testCase.expectedTools,
          actualTools,
          firstCall: calls[0],
          ...(directOperationCall ? { directOperationCall } : {}),
        });
      } catch (error) {
        const snapshot = await page
          .evaluate(() => ({
            bridge: window.MAB_REALTIME_BRIDGE,
            avatar: window.MAB_AVATAR_READY,
          }))
          .catch(() => ({}));
        assertSmoke(false, `Realtime routing case ${testCase.id} failed`, {
          error: String((error && error.message) || error),
          text: testCase.text,
          snapshot,
        });
      } finally {
        await context.close();
      }
    }

    console.log(JSON.stringify({ ok: true, cases: results }, null, 2));
  } finally {
    await browser.close();
    meeting.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function avatarStateSmoke() {
  const { chromium } = await import("playwright");
  const config = getRuntimeConfig();
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript({
      content: buildAvatarInitScript({
        botName: "Avatar State Smoke Bot",
        disableLive2D: true,
      }),
    });
    await context.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
      }),
    });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.waitForFunction(
      () =>
        window.MAB_AVATAR_READY?.ok === true &&
        (
          window.MAB_REALTIME_BRIDGE as
            | { connection?: { dataChannelOpen?: boolean } }
            | null
            | undefined
        )?.connection?.dataChannelOpen === true,
      null,
      { timeout: 10_000 },
    );

    const result = (await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "response.function_call_arguments.done",
            name: "update_avatar_state",
            call_id: "call_avatar_state_smoke",
            arguments: JSON.stringify({
              mood: "happy",
              action: "nod",
              intensity: 1.05,
            }),
          },
        }),
      );
      return {
        avatar: window.MAB_AVATAR_STATE,
        ready: window.MAB_AVATAR_READY,
        bridge: window.MAB_REALTIME_BRIDGE,
        toolNames: window.MAB_REALTIME_CLIENT?.state ? Object.keys(window.MAB_REALTIME_CLIENT) : [],
      };
    })) as {
      avatar?: AvatarStateSnapshot;
      ready?: unknown;
      bridge?: RealtimeBridgeSnapshot;
      toolNames?: string[];
    };

    const sentPayloads = result.bridge?.connection?.sentDataChannelMessages || [];
    const sentEvents = sentPayloads.map((entry) => {
      try {
        return JSON.parse(entry.payload);
      } catch {
        return {};
      }
    });
    const functionOutput = sentEvents.find((event) => event.item?.type === "function_call_output");
    assertSmoke(
      result.avatar?.mood === "happy",
      "avatar mood did not update from Realtime tool call",
      result.avatar,
    );
    assertSmoke(
      result.avatar?.action === "nod",
      "avatar action did not update from Realtime tool call",
      result.avatar,
    );
    assertSmoke(
      result.bridge?.avatarTools?.calls?.some((call) => call.name === "update_avatar_state"),
      "Realtime bridge did not record the avatar tool call",
      result.bridge?.avatarTools,
    );
    assertSmoke(
      functionOutput?.item?.call_id === "call_avatar_state_smoke",
      "avatar tool call did not emit a function_call_output",
      sentEvents,
    );
    assertSmoke(
      sentEvents.some((event) => event.type === "response.create"),
      "avatar tool call did not request a follow-up response",
      sentEvents,
    );

    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await browser.close();
  }
}

async function avatarVisualSmoke() {
  const { chromium } = await import("playwright");
  const config = getRuntimeConfig();
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript({
      content: buildAvatarInitScript({
        botName: "Avatar Visual Smoke Bot",
        disableLive2D: true,
        enableVisualTestHooks: true,
      }),
    });
    await context.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
      }),
    });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.waitForFunction(
      () =>
        window.MAB_AVATAR_READY?.ok === true &&
        window.MAB_AVATAR_VISUAL_TEST &&
        (
          window.MAB_REALTIME_BRIDGE as
            | { connection?: { dataChannelOpen?: boolean } }
            | null
            | undefined
        )?.connection?.dataChannelOpen === true,
      null,
      { timeout: 10_000 },
    );

    const result = (await page.evaluate(async () => {
      const visualTest = window.MAB_AVATAR_VISUAL_TEST as unknown as AvatarVisualTestHarness;
      const neutralInput = { label: "neutral-idle", mood: "neutral", action: "idle", timeMs: 1200 };
      const speakingInput = {
        label: "speaking-emphasize",
        mood: "surprised",
        action: "emphasize",
        intensity: 1.15,
        timeMs: 1200,
      };
      const actionInput = {
        label: "neutral-shake",
        mood: "neutral",
        action: "shake",
        intensity: 1.6,
        timeMs: 1200,
      };
      const hudInputs = [
        { label: "hud-thinking", statusKind: "thinking", statusText: "Thinking" },
        { label: "hud-writing", statusKind: "writing_code", statusText: "Writing code" },
        { label: "hud-preview", statusKind: "opening_preview", statusText: "Opening preview" },
        { label: "hud-blocked", statusKind: "blocked", statusText: "Blocked" },
        { label: "hud-done", statusKind: "done", statusText: "Done" },
      ];
      const neutral = visualTest.renderSnapshot(neutralInput);
      const speaking = visualTest.renderSnapshot(speakingInput);
      const action = visualTest.renderSnapshot(actionInput);
      const hudSnapshots = hudInputs.map((input) =>
        visualTest.renderSnapshot({
          ...neutralInput,
          ...input,
          timeMs: 1200,
        }),
      );
      const mouthDiff = visualTest.compareSnapshots(neutralInput, speakingInput, {
        x: 760,
        y: 430,
        width: 400,
        height: 250,
      });
      const actionDiff = visualTest.compareSnapshots(neutralInput, actionInput, {
        x: 600,
        y: 130,
        width: 720,
        height: 680,
      });

      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "response.function_call_arguments.done",
            name: "update_avatar_state",
            call_id: "call_avatar_visual_smoke",
            arguments: JSON.stringify({
              mood: "happy",
              action: "emphasize",
              intensity: 1.1,
              status_kind: "writing_code",
              status_text: "Writing code",
            }),
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-worker-result", {
          detail: {
            id: "job_avatar_visual_smoke",
            task: "mock HUD completion",
            status: "completed",
            result: "done",
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        snapshots: { neutral, speaking, action },
        hudSnapshots,
        diffs: { mouthDiff, actionDiff },
        liveHash: visualTest.getLiveHash(),
        avatar: window.MAB_AVATAR_STATE,
        ready: window.MAB_AVATAR_READY,
        bridge: window.MAB_REALTIME_BRIDGE,
      };
    })) as {
      snapshots?: {
        neutral?: AvatarVisualSnapshot;
        speaking?: AvatarVisualSnapshot;
        action?: AvatarVisualSnapshot;
      };
      hudSnapshots?: AvatarVisualSnapshot[];
      diffs?: { mouthDiff?: AvatarVisualDiff; actionDiff?: AvatarVisualDiff };
      liveHash?: string;
      avatar?: AvatarStateSnapshot;
      ready?: unknown;
      bridge?: RealtimeBridgeSnapshot;
    };

    const hashes = Object.values(result.snapshots || {}).map((snapshot) => snapshot.hash);
    const uniqueHashes = new Set(hashes);
    const sentEvents = (result.bridge?.connection?.sentDataChannelMessages || []).map((entry) => {
      try {
        return JSON.parse(entry.payload);
      } catch {
        return {};
      }
    });
    assertSmoke(
      hashes.length === 3 && uniqueHashes.size === 3,
      "avatar visual snapshots did not produce distinct hashes",
      result.snapshots,
    );
    assertSmoke(
      result.snapshots?.neutral?.face?.nonBackgroundRatio > 0.05,
      "neutral avatar snapshot looks blank",
      result.snapshots?.neutral,
    );
    assertSmoke(
      result.snapshots?.speaking?.mouth?.nonBackgroundRatio >
        result.snapshots?.neutral?.mouth?.nonBackgroundRatio,
      "speaking mouth did not add visible mouth pixels",
      result.snapshots,
    );
    assertSmoke(
      result.diffs?.mouthDiff?.changedRatio > 0.015,
      "mouth visual diff was too small",
      result.diffs?.mouthDiff,
    );
    assertSmoke(
      result.diffs?.actionDiff?.changedRatio > 0.02,
      "action visual diff was too small",
      result.diffs?.actionDiff,
    );
    assertSmoke(
      (result.hudSnapshots || []).length === 5 &&
        (result.hudSnapshots || []).every(
          (snapshot) => snapshot.status?.nonBackgroundRatio > 0.12,
        ),
      "avatar HUD visual smoke did not render all fixed status states",
      result.hudSnapshots,
    );
    assertSmoke(
      result.avatar?.mood === "happy",
      "avatar visual smoke did not update mood through Realtime tool",
      result.avatar,
    );
    assertSmoke(
      result.avatar?.updates?.some(
        (update) => update.kind === "status" && update.statusKind === "writing_code",
      ),
      "avatar visual smoke did not update HUD status through Realtime tool",
      result.avatar,
    );
    assertSmoke(
      result.avatar?.statusKind === "done" && result.avatar?.statusText === "Done",
      "avatar visual smoke did not update HUD status through mock worker completion",
      result.avatar,
    );
    assertSmoke(
      result.avatar?.updates?.some(
        (update) => update.kind === "action" && update.action === "emphasize",
      ),
      "avatar visual smoke did not observe emphasize action state",
      result.avatar,
    );
    assertSmoke(
      sentEvents.some(
        (event) =>
          event.item?.type === "function_call_output" &&
          event.item?.call_id === "call_avatar_visual_smoke",
      ),
      "avatar visual smoke did not emit function_call_output",
      sentEvents,
    );

    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await browser.close();
  }
}

async function avatarVRMSmoke() {
  const { chromium } = await import("playwright");
  const config = getRuntimeConfig();
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "--use-gl=angle",
      "--enable-webgl",
    ],
  });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript({
      content: buildAvatarInitScript({
        botName: "VRM Avatar Smoke Bot",
        avatarRenderer: "vrm",
        enableVisualTestHooks: true,
      }),
    });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.waitForFunction(
      () =>
        window.MAB_AVATAR_READY?.ok === true &&
        window.MAB_AVATAR_RENDERER &&
        window.MAB_AVATAR_VISUAL_TEST,
      null,
      { timeout: 60_000 },
    );
    await page.waitForFunction(
      () =>
        Number((window.MAB_AVATAR_RENDERER as Record<string, unknown> | null)?.vrmFrames || 0) > 10,
      null,
      { timeout: 20_000 },
    );

    const result = (await page.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const visualTest = window.MAB_AVATAR_VISUAL_TEST;
      const controller = window.MAB_AVATAR_CONTROLLER;
      const neutral = visualTest.captureSourceSnapshot({ label: "vrm-neutral" });
      controller?.updateState({
        mood: "happy",
        action: "speak",
        intensity: 1.1,
        actionHoldMs: 2600,
      });
      window.MAB_AVATAR_AUDIO_BUS?.setSyntheticSpeech?.(true, { holdMs: 2200 });
      await wait(650);
      const expressive = visualTest.captureSourceSnapshot({ label: "vrm-happy-speak" });
      return {
        ready: window.MAB_AVATAR_READY,
        renderer: window.MAB_AVATAR_RENDERER,
        avatar: window.MAB_AVATAR_STATE,
        snapshots: { neutral, expressive },
      };
    })()`)) as {
      ready?: unknown;
      renderer?: {
        renderer?: string;
        vrmLoaded?: boolean;
        vrmFrames?: number;
        vrmSpeechFrames?: number;
        vrmMouthLevel?: number;
        vrmViseme?: string;
      };
      avatar?: AvatarStateSnapshot | null;
      snapshots?: { neutral?: AvatarVisualSnapshot; expressive?: AvatarVisualSnapshot };
    };

    assertSmoke(result.renderer?.renderer === "vrm", "VRM renderer did not activate", result);
    assertSmoke(result.renderer?.vrmLoaded === true, "VRM model did not load", result.renderer);
    assertSmoke((result.renderer?.vrmFrames || 0) > 10, "VRM render loop did not advance", result);
    assertSmoke(
      result.snapshots?.neutral?.ok === true && result.snapshots?.expressive?.ok === true,
      "VRM source snapshots failed",
      result.snapshots,
    );
    assertSmoke(
      result.snapshots?.neutral?.face?.nonBackgroundRatio > 0.015,
      "VRM neutral snapshot looks blank",
      result.snapshots?.neutral,
    );
    assertSmoke(
      result.snapshots?.neutral?.hash !== result.snapshots?.expressive?.hash,
      "VRM state change did not alter pixels",
      result.snapshots,
    );
    assertSmoke(
      result.avatar?.mood === "happy" &&
        result.avatar?.updates?.some(
          (update) => update.kind === "action" && update.action === "speak",
        ),
      "VRM smoke did not route avatar controller state",
      result.avatar,
    );
    assertSmoke(
      (result.renderer?.vrmSpeechFrames || 0) > 0 &&
        (result.renderer?.vrmMouthLevel || 0) > 0.05 &&
        result.renderer?.vrmViseme !== "closed",
      "VRM smoke did not drive lip sync from avatar audio",
      result.renderer,
    );
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await browser.close();
  }
}

async function hiyoriLive2dSmoke() {
  const { chromium } = await import("playwright");
  const config = getRuntimeConfig();
  const requireLive2D = process.env.MAB_REQUIRE_HIYORI_LIVE2D === "1";
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "--use-gl=angle",
      "--enable-webgl",
    ],
  });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript({
      content: buildAvatarInitScript({
        botName: "Hiyori Live2D Smoke Bot",
        disableLive2D: false,
        enableVisualTestHooks: true,
      }),
    });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.waitForFunction(
      () =>
        window.MAB_AVATAR_READY?.ok === true &&
        window.MAB_AVATAR_RENDERER &&
        window.MAB_AVATAR_VISUAL_TEST,
      null,
      { timeout: 60_000 },
    );

    const readiness = (await page.evaluate(() => ({
      ready: window.MAB_AVATAR_READY,
      renderer: window.MAB_AVATAR_RENDERER,
      state: window.MAB_AVATAR_STATE,
    }))) as {
      ready?: unknown;
      renderer?: { live2dLoaded?: boolean; [key: string]: unknown } | null;
      state?: AvatarStateSnapshot | null;
    };
    if (!readiness.renderer?.live2dLoaded) {
      assertSmoke(!requireLive2D, "Hiyori Live2D did not load", readiness);
      console.log(
        JSON.stringify(
          {
            ok: true,
            skipped: true,
            reason: "hiyori_live2d_not_loaded",
            note: "Set MAB_REQUIRE_HIYORI_LIVE2D=1 on a WebGL-capable runner to make this smoke mandatory.",
            ...readiness,
          },
          null,
          2,
        ),
      );
      return;
    }

    await page.waitForFunction(
      () =>
        ((window.MAB_AVATAR_STATE as AvatarStateSnapshot | null | undefined)
          ?.live2dParameterFrames || 0) > 20,
      null,
      {
        timeout: 15_000,
      },
    );
    const result = (await page.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const visualTest = window.MAB_AVATAR_VISUAL_TEST;
      const controller = window.MAB_AVATAR_CONTROLLER;
      const neutral = visualTest.captureSourceSnapshot({
        label: "live2d-neutral",
      });
      controller?.updateState({
        mood: "happy",
        action: "emphasize",
        intensity: 1.15,
      });
      await wait(1200);
      const expressive = visualTest.captureSourceSnapshot({
        label: "live2d-happy-emphasize",
      });
      return {
        ready: window.MAB_AVATAR_READY,
        renderer: window.MAB_AVATAR_RENDERER,
        avatar: window.MAB_AVATAR_STATE,
        snapshots: { neutral, expressive },
      };
    })()`)) as {
      ready?: unknown;
      renderer?: { live2dLoaded?: boolean; [key: string]: unknown } | null;
      avatar?: AvatarStateSnapshot | null;
      snapshots?: { neutral?: AvatarVisualSnapshot; expressive?: AvatarVisualSnapshot };
    };

    assertSmoke(
      result.renderer?.live2dLoaded === true,
      "Hiyori renderer did not stay in Live2D mode",
      result.renderer,
    );
    assertSmoke(
      result.avatar?.live2dParameterFrames > 20,
      "Hiyori Live2D parameters were not driven",
      result.avatar,
    );
    assertSmoke(
      result.snapshots?.neutral?.ok === true,
      "Hiyori neutral live snapshot failed",
      result.snapshots?.neutral,
    );
    assertSmoke(
      result.snapshots?.expressive?.ok === true,
      "Hiyori expressive live snapshot failed",
      result.snapshots?.expressive,
    );
    assertSmoke(
      result.snapshots?.neutral?.face?.nonBackgroundRatio > 0.02,
      "Hiyori neutral live snapshot looks blank",
      result.snapshots?.neutral,
    );
    assertSmoke(
      result.snapshots?.neutral?.hash !== result.snapshots?.expressive?.hash,
      "Hiyori Live2D state change did not alter pixels",
      result.snapshots,
    );
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await browser.close();
  }
}

async function runtimeAcceptanceSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-runtime-acceptance-"));
  const env = {
    MAB_MEETING_PORT: "18894",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18894",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18894/healthz");
    const join = await postJson("http://127.0.0.1:18894/join/google-meet", {
      sessionId: "runtime_acceptance_smoke",
      meetUrl: `${fixture.url}?participantAudio=1&runtimeAcceptance=1`,
      botName: "Runtime Acceptance Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installWorkerResultBridge: true,
      installRealtimeBridge: true,
      realtimeBridgeMode: "webrtc-mock",
      autoConnectRealtime: true,
      sendRealtimeSessionUpdate: true,
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "runtime acceptance did not join fixture",
      join,
    );
    assertSmoke(
      join.result?.fixtureState?.participantAudio?.trackIds?.length === 1,
      "runtime acceptance fixture did not expose participant audio",
      join.result?.fixtureState,
    );

    const report = await postJson("http://127.0.0.1:18894/worker/report", {
      id: "job_runtime_acceptance",
      status: "completed",
      task: "verify integrated runtime acceptance",
      result: "Runtime acceptance worker result.",
      context: {
        source: "meeting-runtime-acceptance-smoke",
        session_kind: "meeting_copilot",
        meeting_session_id: "runtime_acceptance_smoke",
      },
    });
    assertSmoke(report.ok === true, "runtime acceptance worker report failed", report);

    const statusAfterWorker = await waitForJoinStatus(
      "http://127.0.0.1:18894/join/status",
      (body) =>
        body.active?.realtimeBridge?.workerResults?.some(
          (job) => job.jobId === "job_runtime_acceptance",
        ),
      20_000,
    );

    const meetChat = await postJson("http://127.0.0.1:18894/meet/chat", {
      text: "Direct Meet chat from runtime acceptance smoke.",
    });
    assertSmoke(meetChat.ok === true, "runtime acceptance direct Meet chat failed", meetChat);
    assertSmoke(
      meetChat.fixtureState?.chatMessages?.some(
        (entry) => entry.text === "Direct Meet chat from runtime acceptance smoke.",
      ),
      "runtime acceptance direct Meet chat message was not recorded by the fixture",
      meetChat.fixtureState,
    );

    const finalStatus = await waitForJoinStatus(
      "http://127.0.0.1:18894/join/status",
      (body) => {
        const bridge = body.active?.realtimeBridge;
        const avatar = body.active?.avatarReady?.avatarState;
        return (
          avatar?.mood === "happy" &&
          avatar?.updates?.some(
            (update) => update.kind === "action" && update.action === "emphasize",
          ) &&
          bridge?.workerTools?.calls?.some((call) => call.name === "delegate_to_worker") &&
          bridge?.meetTools?.calls?.some((call) => call.name === "send_meet_chat") &&
          body.active?.fixtureState?.chatMessages?.some(
            (entry) => entry.text === "Direct Meet chat from runtime acceptance smoke.",
          ) &&
          body.active?.fixtureState?.chatMessages?.some(
            (entry) => entry.text === "Realtime hello from runtime acceptance smoke.",
          ) &&
          bridge?.connection?.participantAudioTracksDiscovered > 0
        );
      },
      20_000,
    );

    const active = finalStatus.active;
    const bridge = active?.realtimeBridge;
    const sentEvents = (bridge?.connection?.sentDataChannelMessages || []).map((entry) => {
      try {
        return JSON.parse(entry.payload);
      } catch {
        return {};
      }
    });
    assertSmoke(
      !bridge?.errors?.length,
      "runtime acceptance bridge reported errors",
      bridge?.errors,
    );
    assertSmoke(
      !bridge?.avatarTools?.errors?.length,
      "runtime acceptance avatar tools reported errors",
      bridge?.avatarTools,
    );
    assertSmoke(
      !bridge?.workerTools?.errors?.length,
      "runtime acceptance worker tools reported errors",
      bridge?.workerTools,
    );
    assertSmoke(
      !bridge?.meetTools?.errors?.length,
      "runtime acceptance Meet tools reported errors",
      bridge?.meetTools,
    );
    assertSmoke(
      active?.avatarReady?.avatarState?.mood === "happy",
      "runtime acceptance avatar mood did not update",
      active?.avatarReady?.avatarState,
    );
    assertSmoke(
      active?.avatarReady?.avatarState?.updates?.some(
        (update) => update.kind === "action" && update.action === "emphasize",
      ),
      "runtime acceptance avatar action was not observed",
      active?.avatarReady?.avatarState,
    );
    assertSmoke(
      bridge?.session?.configured === true,
      "runtime acceptance did not send session.update",
      bridge?.session,
    );
    assertSmoke(
      bridge?.connection?.dataChannelOpen === true,
      "runtime acceptance data channel did not open",
      bridge?.connection,
    );
    assertSmoke(
      bridge?.connection?.participantAudioTracksDiscovered > 0,
      "runtime acceptance did not discover participant audio",
      bridge?.connection,
    );
    assertSmoke(
      bridge?.connection?.remoteAudioRoutedToAvatarBus === true,
      "runtime acceptance did not route remote audio to avatar mic bus",
      bridge?.connection,
    );
    assertSmoke(
      sentEvents.some(
        (event) =>
          event.item?.type === "function_call_output" &&
          event.item?.call_id === "call_runtime_acceptance_avatar",
      ),
      "runtime acceptance avatar tool did not emit function_call_output",
      sentEvents,
    );
    assertSmoke(
      sentEvents.some(
        (event) =>
          event.item?.type === "function_call_output" &&
          event.item?.call_id === "call_runtime_acceptance_delegate",
      ),
      "runtime acceptance worker tool did not emit function_call_output",
      sentEvents,
    );
    assertSmoke(
      sentEvents.some(
        (event) =>
          event.item?.type === "function_call_output" &&
          event.item?.call_id === "call_runtime_acceptance_meet_chat",
      ),
      "runtime acceptance Meet chat tool did not emit function_call_output",
      sentEvents,
    );
    assertSmoke(
      active?.fixtureState?.chatMessages?.some(
        (entry) => entry.text === "Realtime hello from runtime acceptance smoke.",
      ),
      "runtime acceptance Meet chat message was not recorded by the fixture",
      active?.fixtureState,
    );

    const workerJobs = await (await fetch("http://127.0.0.1:18894/worker/jobs")).json();
    const stop = await postJson("http://127.0.0.1:18894/join/stop", {
      reason: "runtime_acceptance_smoke_done",
    });
    assertSmoke(stop.ok === true, "runtime acceptance stop failed", stop);
    console.log(
      JSON.stringify({ ok: true, join, statusAfterWorker, finalStatus, workerJobs, stop }, null, 2),
    );
  } finally {
    await postJson("http://127.0.0.1:18894/join/stop", {
      reason: "runtime_acceptance_cleanup",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function realtimeSdpSmoke() {
  const config = getRuntimeConfig();
  const shouldRunLive = shouldRunOptionalSmoke("MAB_RUN_REALTIME_SDP", "MAB_REQUIRE_REALTIME_SDP");
  if (!config.openaiApiKey || !shouldRunLive) {
    const skipped = {
      ok: true,
      skipped: true,
      reason: config.openaiApiKey
        ? "MAB_RUN_REALTIME_SDP not enabled"
        : "MAB_OPENAI_API_KEY/OPENAI_API_KEY missing",
      note: "Set MAB_RUN_REALTIME_SDP=1 to run this optional smoke. Set MAB_REQUIRE_REALTIME_SDP=1 to make it mandatory.",
    };
    if (process.env.MAB_REQUIRE_REALTIME_SDP === "1") {
      assertSmoke(
        false,
        "MAB_OPENAI_API_KEY or OPENAI_API_KEY is required when MAB_REQUIRE_REALTIME_SDP=1",
        skipped,
      );
    }
    console.log(JSON.stringify(skipped, null, 2));
    return;
  }

  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-realtime-sdp-"));
  const env = {
    MAB_MEETING_PORT: "18889",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18889",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18889/healthz");
    const join = await postJson("http://127.0.0.1:18889/join/google-meet", {
      sessionId: "realtime_sdp_smoke",
      meetUrl: fixture.url,
      botName: "Realtime SDP Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installWorkerResultBridge: false,
      installRealtimeBridge: true,
      realtimeBridgeMode: "webrtc",
      autoConnectRealtime: true,
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "realtime sdp smoke did not join fixture",
      join,
    );

    const status = await waitForJoinStatus(
      "http://127.0.0.1:18889/join/status",
      (body) =>
        body.active?.realtimeBridge?.connected === true ||
        (body.active?.realtimeBridge?.errors || []).length > 0,
      20_000,
    );
    const bridge = status.active?.realtimeBridge;
    assertSmoke(bridge?.errors?.length === 0, "Realtime SDP bridge reported errors", bridge);
    assertSmoke(
      bridge?.connection?.dataChannelOpen === true,
      "Realtime data channel did not open",
      bridge,
    );
    assertSmoke(
      bridge?.connection?.realtimeInputPlaceholderAdded === true ||
        bridge?.connection?.localAudioTrackAdded === true,
      "Realtime SDP bridge did not add an input sender placeholder or local fallback audio track",
      bridge?.connection,
    );

    console.log(JSON.stringify({ ok: true, join, status }, null, 2));
  } finally {
    await postJson("http://127.0.0.1:18889/join/stop", { reason: "realtime_sdp_smoke_done" }).catch(
      () => {},
    );
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function slackResultSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-result-"));
  const env = {
    MAB_SLACK_PORT: "18895",
    MAB_MEETING_PORT: "18896",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18896",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    SLACK_SIGNING_SECRET: "slack-result-signing-secret",
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const slack = startService("apps/slack-agent/src/index.js", env);

  try {
    await waitForHealth("http://127.0.0.1:18896/healthz");
    await waitForHealth("http://127.0.0.1:18895/healthz");
    const reported = await postJson("http://127.0.0.1:18896/worker/report", {
      id: "job_slack_result_smoke",
      status: "completed",
      task: "summarize the worker result loop",
      result: "Slack result smoke delivered this worker result exactly once.",
    });
    assertSmoke(reported.ok === true, "Slack result smoke could not report a worker job", reported);

    const firstPoll = await postJson("http://127.0.0.1:18895/jobs/poll-meeting", {
      limit: 5,
      markDelivered: true,
    });
    assertSmoke(firstPoll.ok === true, "Slack result smoke poll route failed", firstPoll);
    assertSmoke(
      firstPoll.jobs?.length === 1,
      "Slack result smoke did not return exactly one job",
      firstPoll,
    );
    assertSmoke(
      firstPoll.messages?.[0]?.includes(
        "Slack result smoke delivered this worker result exactly once.",
      ),
      "Slack result smoke did not format the worker result for Slack",
      firstPoll,
    );

    const workerJobs = await (await fetch("http://127.0.0.1:18896/worker/jobs")).json();
    const deliveredJob = workerJobs.jobs.find((job) => job.id === "job_slack_result_smoke");
    assertSmoke(
      deliveredJob?.deliveredToSlack === true,
      "worker job was not marked delivered to Slack",
      workerJobs,
    );

    const secondPoll = await postJson("http://127.0.0.1:18895/jobs/poll-meeting", {
      limit: 5,
      markDelivered: true,
    });
    assertSmoke(secondPoll.ok === true, "Slack result smoke second poll failed", secondPoll);
    assertSmoke(
      secondPoll.jobs?.length === 0,
      "Slack result smoke delivered a duplicate job",
      secondPoll,
    );

    console.log(JSON.stringify({ ok: true, reported, firstPoll, workerJobs, secondPoll }, null, 2));
  } finally {
    for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function slackPostingSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-posting-"));
  const env = {
    MAB_SLACK_PORT: "18897",
    MAB_MEETING_PORT: "18898",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18898",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    MAB_SLACK_POSTER_MOCK: "1",
    SLACK_SIGNING_SECRET: "slack-posting-signing-secret",
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const slack = startService("apps/slack-agent/src/index.js", env);

  try {
    await waitForHealth("http://127.0.0.1:18898/healthz");
    await waitForHealth("http://127.0.0.1:18897/healthz");
    const reported = await postJson("http://127.0.0.1:18898/worker/report", {
      id: "job_slack_posting_smoke",
      status: "completed",
      task: "post this worker result to a Slack thread",
      result: "Slack posting smoke delivered this worker result to a mock thread exactly once.",
    });
    assertSmoke(
      reported.ok === true,
      "Slack posting smoke could not report a worker job",
      reported,
    );

    const firstPoll = await postJson("http://127.0.0.1:18897/jobs/poll-meeting", {
      limit: 5,
      channel: "C_SMOKE",
      threadTs: "1710000000.000000",
      markDelivered: true,
      postToSlack: true,
    });
    assertSmoke(firstPoll.ok === true, "Slack posting smoke poll route failed", firstPoll);
    assertSmoke(
      firstPoll.jobs?.length === 1,
      "Slack posting smoke did not return exactly one job",
      firstPoll,
    );
    assertSmoke(
      firstPoll.posts?.length === 1,
      "Slack posting smoke did not create exactly one Slack post",
      firstPoll,
    );
    assertSmoke(
      firstPoll.posts?.[0]?.post?.mock === true,
      "Slack posting smoke did not use the mock poster",
      firstPoll.posts?.[0],
    );
    assertSmoke(
      firstPoll.posts?.[0]?.post?.channel === "C_SMOKE",
      "Slack posting smoke did not preserve channel",
      firstPoll.posts?.[0],
    );
    assertSmoke(
      firstPoll.posts?.[0]?.post?.threadTs === "1710000000.000000",
      "Slack posting smoke did not preserve thread ts",
      firstPoll.posts?.[0],
    );
    assertSmoke(
      firstPoll.posts?.[0]?.post?.dedupKey?.includes("job_slack_posting_smoke"),
      "Slack posting smoke did not assign a worker dedup key",
      firstPoll.posts?.[0],
    );

    const workerJobs = await (await fetch("http://127.0.0.1:18898/worker/jobs")).json();
    const deliveredJob = workerJobs.jobs.find((job) => job.id === "job_slack_posting_smoke");
    assertSmoke(
      deliveredJob?.deliveredToSlack === true,
      "worker job was not marked delivered to Slack",
      workerJobs,
    );
    assertSmoke(
      deliveredJob?.slackDelivery?.channel === "C_SMOKE",
      "worker job did not record Slack delivery channel",
      deliveredJob,
    );
    assertSmoke(
      deliveredJob?.slackDelivery?.threadTs === "1710000000.000000",
      "worker job did not record Slack delivery thread",
      deliveredJob,
    );
    assertSmoke(
      deliveredJob?.slackDelivery?.mock === true,
      "worker job did not record mock delivery mode",
      deliveredJob,
    );

    const secondPoll = await postJson("http://127.0.0.1:18897/jobs/poll-meeting", {
      limit: 5,
      channel: "C_SMOKE",
      threadTs: "1710000000.000000",
      markDelivered: true,
      postToSlack: true,
    });
    assertSmoke(secondPoll.ok === true, "Slack posting smoke second poll failed", secondPoll);
    assertSmoke(
      secondPoll.jobs?.length === 0,
      "Slack posting smoke delivered a duplicate job",
      secondPoll,
    );
    assertSmoke(
      secondPoll.posts?.length === 0,
      "Slack posting smoke posted a duplicate Slack message",
      secondPoll,
    );

    console.log(JSON.stringify({ ok: true, reported, firstPoll, workerJobs, secondPoll }, null, 2));
  } finally {
    for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function cutoverShadowSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-cutover-"));
  const reportPath = pathJoin(dataDir, "cutover-report.jsonl");

  async function runScenario({
    name,
    slackPort,
    meetingPort,
    mode,
    canaryPercent = "0",
    shouldStartMeeting,
    expectedStatus,
  }) {
    const env = {
      MAB_SLACK_PORT: String(slackPort),
      MAB_MEETING_PORT: String(meetingPort),
      MAB_MEETING_AGENT_URL: `http://127.0.0.1:${meetingPort}`,
      MAB_DRY_RUN_AGENT: "1",
      MAB_BROWSER_HEADLESS: "true",
      MAB_DATA_DIR: pathJoin(dataDir, name),
      MAB_CUTOVER_MODE: mode,
      MAB_CUTOVER_CANARY_PERCENT: String(canaryPercent),
      MAB_CUTOVER_REPORT_PATH: reportPath,
      SLACK_SIGNING_SECRET: `cutover-${name}-signing-secret`,
    };
    const meeting = startService("apps/meeting-agent/src/index.js", env);
    const slack = startService("apps/slack-agent/src/index.js", env);

    try {
      await waitForHealth(`http://127.0.0.1:${meetingPort}/healthz`);
      await waitForHealth(`http://127.0.0.1:${slackPort}/healthz`);
      const join = await postSignedSlackCommand(
        `http://127.0.0.1:${slackPort}/slack/commands/avatar`,
        "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name CutoverBot",
        { signingSecret: env.SLACK_SIGNING_SECRET, userId: `U_${name.toUpperCase()}` },
      );
      assertSmoke(join.ok === true, `${name} cutover join command failed`, join);
      assertSmoke(
        join.cutoverDecision?.mode === mode,
        `${name} did not use expected cutover mode`,
        join.cutoverDecision,
      );
      assertSmoke(
        join.session?.status === expectedStatus,
        `${name} session status mismatch`,
        join.session,
      );

      const meetingSessions = await (
        await fetch(`http://127.0.0.1:${meetingPort}/sessions`)
      ).json();
      assertSmoke(
        shouldStartMeeting
          ? meetingSessions.sessions.length === 1
          : meetingSessions.sessions.length === 0,
        `${name} meeting side effect mismatch`,
        meetingSessions,
      );

      const report = await (await fetch(`http://127.0.0.1:${slackPort}/cutover/report`)).json();
      assertSmoke(
        report.events.length >= 1,
        `${name} cutover report did not record an event`,
        report,
      );
      return { join, meetingSessions, report };
    } finally {
      for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    }
  }

  try {
    const shadow = await runScenario({
      name: "shadow",
      slackPort: 18901,
      meetingPort: 18902,
      mode: "shadow",
      shouldStartMeeting: false,
      expectedStatus: "shadow_old_stack_primary",
    });
    const rollback = await runScenario({
      name: "rollback",
      slackPort: 18903,
      meetingPort: 18904,
      mode: "rollback",
      shouldStartMeeting: false,
      expectedStatus: "rollback_old_stack_primary",
    });
    const canary = await runScenario({
      name: "canary",
      slackPort: 18905,
      meetingPort: 18906,
      mode: "canary",
      canaryPercent: "100",
      shouldStartMeeting: true,
      expectedStatus: "meeting_agent_started",
    });
    console.log(JSON.stringify({ ok: true, reportPath, shadow, rollback, canary }, null, 2));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function cutoverRollbackSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-rollback-"));
  const reportPath = pathJoin(dataDir, "cutover-report.jsonl");
  const slackPort = 18939;
  const missingMeetingPort = 18938;
  const signingSecret = "cutover-rollback-signing-secret";
  const env = {
    MAB_SLACK_PORT: String(slackPort),
    MAB_MEETING_PORT: String(missingMeetingPort),
    MAB_MEETING_AGENT_URL: `http://127.0.0.1:${missingMeetingPort}`,
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    MAB_CUTOVER_MODE: "new",
    MAB_CUTOVER_AUTO_ROLLBACK_ON_FAILURE: "1",
    MAB_CUTOVER_REPORT_PATH: reportPath,
    SLACK_SIGNING_SECRET: signingSecret,
  };
  const slack = startService("apps/slack-agent/src/index.js", env);

  try {
    await waitForServiceHealth(slack, `http://127.0.0.1:${slackPort}/healthz`);
    const join = await postSignedSlackCommand(
      `http://127.0.0.1:${slackPort}/slack/commands/avatar`,
      "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name RollbackBot --dry-run false",
      { signingSecret, userId: "U_ROLLBACK" },
    );
    assertSmoke(
      join.httpStatus === 200 && join.ok === true,
      "rollback smoke join command failed",
      join,
    );
    assertSmoke(
      join.session?.status === "auto_rollback_old_stack_primary",
      "rollback smoke did not mark the session as old-stack-primary",
      join.session,
    );
    assertSmoke(
      join.session?.meetingAgentStatus === 0,
      "rollback smoke did not capture missing Meeting Agent failure",
      join.session,
    );
    assertSmoke(
      join.cutoverDecision?.mode === "new",
      "rollback smoke did not start from new-stack mode",
      join.cutoverDecision,
    );
    assertSmoke(
      join.rollbackDecision?.mode === "rollback",
      "rollback smoke did not emit rollback decision",
      join.rollbackDecision,
    );
    assertSmoke(
      join.rollbackDecision?.reason === "auto_rollback_new_stack_failed",
      "rollback smoke recorded the wrong rollback reason",
      join.rollbackDecision,
    );

    const sessions = await (await fetch(`http://127.0.0.1:${slackPort}/sessions`)).json();
    const storedSession = sessions.sessions.find((session) => session.id === join.session.id);
    assertSmoke(
      storedSession?.status === "auto_rollback_old_stack_primary",
      "rollback smoke session store did not persist rollback status",
      sessions,
    );

    const report = await (await fetch(`http://127.0.0.1:${slackPort}/cutover/report`)).json();
    const autoRollbackEvent = report.events.find(
      (event) => event.type === "join_auto_rollback_decision",
    );
    assertSmoke(
      report.autoRollbackOnFailure === true,
      "rollback smoke report did not expose auto-rollback setting",
      report,
    );
    assertSmoke(
      Boolean(autoRollbackEvent),
      "rollback smoke did not write auto rollback event",
      report,
    );
    assertSmoke(
      autoRollbackEvent?.decision?.mode === "rollback",
      "rollback smoke event did not record rollback decision",
      autoRollbackEvent,
    );
    assertSmoke(
      autoRollbackEvent?.originalDecision?.mode === "new",
      "rollback smoke event did not preserve original new-stack decision",
      autoRollbackEvent,
    );
    assertSmoke(
      autoRollbackEvent?.newStack?.ok === false && autoRollbackEvent?.oldStack?.primary === true,
      "rollback smoke event did not capture failover shape",
      autoRollbackEvent,
    );

    console.log(JSON.stringify({ ok: true, reportPath, join, sessions, report }, null, 2));
  } finally {
    slack.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function shadowParitySmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-shadow-parity-"));
  const signingSecret = "shadow-parity-signing-secret";
  const oldStack = await startOldStackFixture({ port: 18907 });
  const env = {
    MAB_SLACK_PORT: "18908",
    MAB_MEETING_PORT: "18909",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18909",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: pathJoin(dataDir, "new-stack"),
    SLACK_SIGNING_SECRET: signingSecret,
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const slack = startService("apps/slack-agent/src/index.js", env);
  const commands = [];

  function addCheck(checks, name, pass, details = {}) {
    checks.push({ name, pass: Boolean(pass), ...details });
  }

  function recordCommand(action, oldResult, newResult, checks) {
    const ok = checks.every((check) => check.pass);
    const entry = { action, ok, old: oldResult, new: newResult, checks };
    commands.push(entry);
    assertSmoke(ok, `shadow parity ${action} mismatch`, entry);
    return entry;
  }

  try {
    await waitForHealth("http://127.0.0.1:18907/healthz");
    await waitForHealth("http://127.0.0.1:18909/healthz");
    await waitForHealth("http://127.0.0.1:18908/healthz");

    const joinCommand =
      "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name ParityBot";
    const oldJoin = await postSignedSlackCommand(
      "http://127.0.0.1:18907/slack/commands/avatar",
      joinCommand,
      { signingSecret },
    );
    const newJoin = await postSignedSlackCommand(
      "http://127.0.0.1:18908/slack/commands/avatar",
      joinCommand,
      { signingSecret },
    );
    const joinChecks = [];
    addCheck(joinChecks, "both_accept_join", oldJoin.ok === true && newJoin.ok === true, {
      oldOk: oldJoin.ok,
      newOk: newJoin.ok,
    });
    addCheck(
      joinChecks,
      "meet_url_matches",
      oldJoin.session?.meetUrl === newJoin.session?.meetUrl,
      { oldMeetUrl: oldJoin.session?.meetUrl, newMeetUrl: newJoin.session?.meetUrl },
    );
    addCheck(joinChecks, "avatar_matches", oldJoin.session?.avatar === newJoin.session?.avatar, {
      oldAvatar: oldJoin.session?.avatar,
      newAvatar: newJoin.session?.avatar,
    });
    addCheck(
      joinChecks,
      "new_stack_started_meeting_agent",
      newJoin.session?.status === "meeting_agent_started",
      { newStatus: newJoin.session?.status },
    );
    addCheck(
      joinChecks,
      "old_fixture_started_primary",
      oldJoin.session?.status === "meeting_agent_started",
      { oldStatus: oldJoin.session?.status },
    );
    recordCommand("join", summarizeParityJoin(oldJoin), summarizeParityJoin(newJoin), joinChecks);

    const oldSessionId = oldJoin.session?.id;
    const newSessionId = newJoin.session?.id;
    const delegateTask = "Summarize the meeting avatar bot shadow parity runner.";
    const oldDelegate = await postSignedSlackCommand(
      "http://127.0.0.1:18907/slack/commands/avatar",
      `delegate --session ${oldSessionId} ${delegateTask}`,
      { signingSecret },
    );
    const newDelegate = await postSignedSlackCommand(
      "http://127.0.0.1:18908/slack/commands/avatar",
      `delegate --session ${newSessionId} ${delegateTask}`,
      { signingSecret },
    );
    const delegateChecks = [];
    addCheck(delegateChecks, "both_delegate", oldDelegate.ok === true && newDelegate.ok === true, {
      oldOk: oldDelegate.ok,
      newOk: newDelegate.ok,
    });
    addCheck(
      delegateChecks,
      "both_completed",
      oldDelegate.job?.status === "completed" && newDelegate.job?.status === "completed",
      { oldStatus: oldDelegate.job?.status, newStatus: newDelegate.job?.status },
    );
    addCheck(delegateChecks, "task_matches", oldDelegate.job?.task === newDelegate.job?.task, {
      oldTask: oldDelegate.job?.task,
      newTask: newDelegate.job?.task,
    });
    addCheck(
      delegateChecks,
      "result_matches",
      oldDelegate.job?.result === newDelegate.job?.result,
      { oldResult: oldDelegate.job?.result, newResult: newDelegate.job?.result },
    );
    recordCommand(
      "delegate",
      summarizeParityJob(oldDelegate.job),
      summarizeParityJob(newDelegate.job),
      delegateChecks,
    );

    const oldJobs = await postSignedSlackCommand(
      "http://127.0.0.1:18907/slack/commands/avatar",
      `jobs --session ${oldSessionId}`,
      { signingSecret },
    );
    const newJobs = await postSignedSlackCommand(
      "http://127.0.0.1:18908/slack/commands/avatar",
      `jobs --session ${newSessionId}`,
      { signingSecret },
    );
    const jobChecks = [];
    addCheck(jobChecks, "both_list_jobs", oldJobs.ok === true && newJobs.ok === true, {
      oldOk: oldJobs.ok,
      newOk: newJobs.ok,
    });
    addCheck(
      jobChecks,
      "both_include_worker_result",
      oldJobs.text?.includes(delegateTask) && newJobs.text?.includes(delegateTask),
      { oldText: oldJobs.text, newText: newJobs.text },
    );
    addCheck(
      jobChecks,
      "new_meeting_result_ready_for_slack",
      newJobs.readyForSlack?.jobs?.length === 1,
      { readyForSlackCount: newJobs.readyForSlack?.jobs?.length || 0 },
    );
    recordCommand(
      "jobs",
      { text: oldJobs.text, jobs: oldJobs.jobs?.length || 0 },
      { text: newJobs.text, jobs: newJobs.jobs?.length || 0 },
      jobChecks,
    );

    const oldStop = await postSignedSlackCommand(
      "http://127.0.0.1:18907/slack/commands/avatar",
      `stop ${oldSessionId} --reason parity_done`,
      { signingSecret },
    );
    const newStop = await postSignedSlackCommand(
      "http://127.0.0.1:18908/slack/commands/avatar",
      `stop ${newSessionId} --reason parity_done`,
      { signingSecret },
    );
    const stopChecks = [];
    addCheck(stopChecks, "both_stop", oldStop.ok === true && newStop.ok === true, {
      oldOk: oldStop.ok,
      newOk: newStop.ok,
    });
    addCheck(
      stopChecks,
      "both_mark_stopped",
      oldStop.session?.status === "stopped" && newStop.session?.status === "stopped",
      { oldStatus: oldStop.session?.status, newStatus: newStop.session?.status },
    );
    recordCommand("stop", summarizeParityJoin(oldStop), summarizeParityJoin(newStop), stopChecks);

    const meetingSessions = await (await fetch("http://127.0.0.1:18909/sessions")).json();
    const oldSessions = await (await fetch("http://127.0.0.1:18907/sessions")).json();
    const report = {
      ok: true,
      mode: "fixture_shadow_parity",
      summary: {
        commandCount: commands.length,
        passed: commands.filter((entry) => entry.ok).length,
        failed: commands.filter((entry) => !entry.ok).length,
      },
      oldStack: {
        kind: "fixture",
        sessions: oldSessions.sessions?.length || 0,
      },
      newStack: {
        kind: "local",
        meetingSessions: meetingSessions.sessions?.length || 0,
      },
      commands,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    await oldStack.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function shadowTapSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-shadow-tap-"));
  const reportPath = pathJoin(dataDir, "shadow-tap-report.jsonl");
  const secret = "shadow-tap-smoke-secret";
  const env = {
    MAB_SLACK_PORT: "18910",
    MAB_MEETING_PORT: "18911",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18911",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: pathJoin(dataDir, "new-stack"),
    MAB_CUTOVER_MODE: "shadow",
    MAB_SHADOW_TAP_SECRET: secret,
    MAB_SHADOW_TAP_REPORT_PATH: reportPath,
    SLACK_SIGNING_SECRET: "shadow-tap-slack-signing-secret",
  };
  const slack = startService("apps/slack-agent/src/index.js", env);

  async function postShadow(body, providedSecret = secret) {
    const response = await fetch("http://127.0.0.1:18910/shadow/slack-command", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mab-shadow-tap-secret": providedSecret,
      },
      body: JSON.stringify(body),
    });
    return { httpStatus: response.status, body: await response.json() };
  }

  try {
    await waitForHealth("http://127.0.0.1:18910/healthz");

    const invalidSecret = await postShadow({ text: "status" }, "wrong-secret");
    assertSmoke(
      invalidSecret.httpStatus === 401 && invalidSecret.body?.ok === false,
      "shadow tap accepted an invalid secret",
      invalidSecret,
    );

    const mirrored = [
      {
        name: "join",
        text: "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name ShadowTapBot",
        oldStack: {
          source: "legacy-slack-agentd",
          sessionId: "meet_old_0001",
          status: "meeting_agent_started",
        },
      },
      {
        name: "delegate",
        text: "delegate --session meet_old_0001 Summarize the shadow tap smoke.",
        oldStack: {
          source: "legacy-slack-agentd",
          sessionId: "meet_old_0001",
          jobId: "job_old_0001",
          status: "completed",
        },
      },
      {
        name: "jobs",
        text: "jobs --session meet_old_0001",
        oldStack: { source: "legacy-slack-agentd", sessionId: "meet_old_0001", jobs: 1 },
      },
      {
        name: "stop",
        text: "stop meet_old_0001 --reason shadow_tap_done",
        oldStack: { source: "legacy-slack-agentd", sessionId: "meet_old_0001", status: "stopped" },
      },
    ];

    const results = [];
    for (const commandBody of mirrored) {
      const result = await postShadow({
        source: "legacy-slack-agentd",
        eventId: `evt_shadow_${commandBody.name}`,
        team_id: "T_SHADOW",
        channel_id: "C_SHADOW",
        user_id: "U_SHADOW",
        text: commandBody.text,
        oldStack: commandBody.oldStack,
      });
      assertSmoke(
        result.httpStatus === 200 && result.body?.ok === true,
        `shadow tap ${commandBody.name} failed`,
        result,
      );
      assertSmoke(
        result.body?.sideEffects === "suppressed",
        `shadow tap ${commandBody.name} had side effects`,
        result,
      );
      assertSmoke(
        result.body?.event?.parsed?.action === commandBody.name,
        `shadow tap ${commandBody.name} parsed the wrong action`,
        result,
      );
      results.push({ name: commandBody.name, result: result.body });
    }

    const sessions = await (await fetch("http://127.0.0.1:18910/sessions")).json();
    assertSmoke(sessions.sessions.length === 0, "shadow tap created Slack sessions", sessions);

    const report = await (await fetch("http://127.0.0.1:18910/shadow/report")).json();
    assertSmoke(
      report.events.length === mirrored.length,
      "shadow tap report did not record all mirrored commands",
      report,
    );
    assertSmoke(
      report.events.every(
        (event) => event.sideEffects !== "started" && event.newStack?.sideEffects === "suppressed",
      ),
      "shadow tap report includes an unsafe side effect",
      report,
    );

    console.log(
      JSON.stringify({ ok: true, reportPath, invalidSecret, results, sessions, report }, null, 2),
    );
  } finally {
    slack.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function shadowTransmitterSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-shadow-transmitter-"));
  const reportPath = pathJoin(dataDir, "shadow-transmitter-report.jsonl");
  const secret = "shadow-transmitter-smoke-secret";
  const endpoint = "http://127.0.0.1:18912/shadow/slack-command";
  const env = {
    MAB_SLACK_PORT: "18912",
    MAB_MEETING_PORT: "18913",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18913",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: pathJoin(dataDir, "new-stack"),
    MAB_CUTOVER_MODE: "shadow",
    MAB_SHADOW_TAP_SECRET: secret,
    MAB_SHADOW_TAP_REPORT_PATH: reportPath,
    SLACK_SIGNING_SECRET: "shadow-transmitter-slack-signing-secret",
  };
  const slack = startService("apps/slack-agent/src/index.js", env);

  try {
    await waitForHealth("http://127.0.0.1:18912/healthz");

    function runTransmitterHook(
      input: Record<string, unknown>,
      extraEnv: NodeJS.ProcessEnv = {},
    ): ShadowHookResult {
      const result = spawnSync(process.execPath, ["src/cli.js", "shadow-transmitter-hook"], {
        cwd: process.cwd(),
        encoding: "utf8",
        input: JSON.stringify(input),
        env: {
          ...process.env,
          MAB_SHADOW_TAP_ENABLED: "1",
          MAB_SHADOW_TAP_URL: endpoint,
          MAB_SHADOW_TAP_SECRET: secret,
          MAB_SHADOW_TAP_SOURCE: "legacy-slack-agentd",
          ...extraEnv,
        },
      });
      let body: ShadowHookBody = {};
      try {
        body = JSON.parse(result.stdout || "{}");
      } catch {
        body = { ok: false, error: "invalid_hook_output", raw: result.stdout };
      }
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, body };
    }

    const disabledHook = runTransmitterHook({ text: "status" }, { MAB_SHADOW_TAP_ENABLED: "0" });
    assertSmoke(
      disabledHook.status === 0 && disabledHook.body?.disabled === true,
      "shadow transmitter hook did not stay disabled by default",
      disabledHook,
    );

    const missingConfigHook = runTransmitterHook({ text: "status" }, { MAB_SHADOW_TAP_SECRET: "" });
    assertSmoke(
      missingConfigHook.status !== 0 &&
        missingConfigHook.body?.error === "shadow_tap_not_configured",
      "shadow transmitter hook accepted missing config",
      missingConfigHook,
    );

    const missingSecret = await postShadowTap({
      endpoint,
      secret: "",
      payload: createShadowTapPayload({ text: "status" }),
    });
    assertSmoke(
      missingSecret.ok === false && missingSecret.status === 0,
      "shadow transmitter accepted a missing secret",
      missingSecret,
    );

    const commands = [
      {
        name: "join",
        text: "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name ShadowTransmitterBot",
        sessionId: "meet_old_transmitter_0001",
        status: "meeting_agent_started",
      },
      {
        name: "delegate",
        text: "delegate --session meet_old_transmitter_0001 Draft a transmitter shadow report.",
        sessionId: "meet_old_transmitter_0001",
        jobId: "job_old_transmitter_0001",
        status: "completed",
      },
      {
        name: "jobs",
        text: "jobs --session meet_old_transmitter_0001",
        sessionId: "meet_old_transmitter_0001",
        status: "jobs_listed",
      },
      {
        name: "stop",
        text: "stop meet_old_transmitter_0001 --reason shadow_transmitter_done",
        sessionId: "meet_old_transmitter_0001",
        status: "stopped",
      },
    ];

    const results = [];
    for (const commandBody of commands) {
      const hook = runTransmitterHook({
        source: "legacy-slack-agentd",
        eventId: `evt_transmitter_${commandBody.name}`,
        team_id: "T_TRANSMITTER",
        team_domain: "transmitter-smoke",
        channel_id: "C_TRANSMITTER",
        channel_name: "meeting-avatar-shadow",
        user_id: "U_TRANSMITTER",
        user_name: "old-stack-user",
        text: commandBody.text,
        token: "must-not-leak",
        response_url: "https://hooks.slack.com/commands/must-not-leak",
        trigger_id: "must-not-leak",
        oldStack: {
          source: "legacy-slack-agentd",
          sessionId: commandBody.sessionId,
          jobId: commandBody.jobId,
          status: commandBody.status,
          commandTs: `1700000000.${commandBody.name.length}`,
          token: "must-not-leak",
        },
      });
      assertSmoke(
        hook.status === 0 && hook.body?.ok === true,
        `shadow transmitter hook ${commandBody.name} failed`,
        hook,
      );
      assertNoPrivateSlackFields(hook.body.payload);
      const post = { status: hook.body.status, body: hook.body.response };
      assertSmoke(
        post.status === 200 && post.body?.ok === true,
        `shadow transmitter ${commandBody.name} post failed`,
        post,
      );
      assertSmoke(
        post.body?.sideEffects === "suppressed",
        `shadow transmitter ${commandBody.name} caused side effects`,
        post,
      );
      assertSmoke(
        post.body?.event?.summary?.source === "legacy-slack-agentd",
        `shadow transmitter ${commandBody.name} lost source`,
        post.body?.event?.summary,
      );
      assertSmoke(
        post.body?.event?.parsed?.action === commandBody.name,
        `shadow transmitter ${commandBody.name} parsed wrong action`,
        post.body?.event?.parsed,
      );
      results.push({ name: commandBody.name, payload: hook.body.payload, post: post.body });
    }

    const sessions = (await (await fetch("http://127.0.0.1:18912/sessions")).json()) as {
      sessions: unknown[];
    };
    assertSmoke(
      sessions.sessions.length === 0,
      "shadow transmitter created Slack sessions",
      sessions,
    );

    const report = (await (await fetch("http://127.0.0.1:18912/shadow/report")).json()) as {
      events: ShadowReportEvent[];
    };
    assertSmoke(
      report.events.length === commands.length,
      "shadow transmitter report did not record all mirrored commands",
      report,
    );
    assertSmoke(
      report.events.every(
        (event) =>
          event.newStack?.sideEffects === "suppressed" &&
          event.summary?.source === "legacy-slack-agentd",
      ),
      "shadow transmitter report includes unsafe side effects or wrong source",
      report,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          reportPath,
          disabledHook: disabledHook.body,
          missingConfigHook: missingConfigHook.body,
          missingSecret,
          results,
          sessions,
          report,
        },
        null,
        2,
      ),
    );
  } finally {
    slack.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function shadowTransmitterHook() {
  let input: ShadowTapInput = {};
  try {
    const raw = await readStdinText();
    input = raw.trim() ? (JSON.parse(raw) as ShadowTapInput) : {};
  } catch (error) {
    process.exitCode = 1;
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: "invalid_shadow_transmitter_input",
          detail: String(error?.message || error),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (process.env.MAB_SHADOW_TAP_ENABLED !== "1") {
    console.log(
      JSON.stringify(
        {
          ok: true,
          disabled: true,
          reason: "MAB_SHADOW_TAP_ENABLED is not 1",
        },
        null,
        2,
      ),
    );
    return;
  }

  const endpoint = process.env.MAB_SHADOW_TAP_URL || process.env.MAB_SHADOW_TAP_ENDPOINT || "";
  const secret = process.env.MAB_SHADOW_TAP_SECRET || "";
  if (!endpoint || !secret) {
    process.exitCode = 1;
    console.log(
      JSON.stringify(
        {
          ok: false,
          disabled: false,
          error: "shadow_tap_not_configured",
          detail:
            "MAB_SHADOW_TAP_URL and MAB_SHADOW_TAP_SECRET are required when MAB_SHADOW_TAP_ENABLED=1",
        },
        null,
        2,
      ),
    );
    return;
  }

  const payload = createShadowTapPayload({
    ...input,
    source: process.env.MAB_SHADOW_TAP_SOURCE || input.source || "legacy-slack-agentd",
  });
  assertNoPrivateSlackFields(payload);

  const timeoutMs = Number.parseInt(process.env.MAB_SHADOW_TAP_TIMEOUT_MS || "1500", 10);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1500,
  );
  const result = await postShadowTap({
    endpoint,
    secret,
    payload,
    fetchImpl: (url, options) => fetch(url, { ...options, signal: controller.signal }),
  });
  clearTimeout(timer);

  const output = {
    ok: result.ok,
    disabled: false,
    status: result.status,
    payload,
    response: result.body,
  };
  if (!result.ok) process.exitCode = 1;
  console.log(JSON.stringify(output, null, 2));
}

async function writeTextArtifact(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function writeJsonArtifact(filePath, value) {
  await writeTextArtifact(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function runEvidenceCommand({ name, args, rootDir, required = false }) {
  const safeName = name.replace(/[^a-z0-9_.-]+/gi, "-").toLowerCase();
  const startedAt = new Date().toISOString();
  const result = spawnSync(args[0], args.slice(1), {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const evidenceCommand = {
    name,
    args,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: result.status,
    signal: result.signal,
    ok: result.status === 0,
    stdoutPath: `commands/${safeName}.stdout.txt`,
    stderrPath: `commands/${safeName}.stderr.txt`,
  };
  await writeTextArtifact(pathJoin(rootDir, evidenceCommand.stdoutPath), result.stdout || "");
  await writeTextArtifact(pathJoin(rootDir, evidenceCommand.stderrPath), result.stderr || "");
  if (required) assertSmoke(evidenceCommand.ok, `evidence command failed: ${name}`, evidenceCommand);
  return evidenceCommand;
}

async function fetchJsonArtifact(url, filePath) {
  const response = await fetch(url);
  const body = await response.json();
  await writeJsonArtifact(filePath, { httpStatus: response.status, body });
  return { httpStatus: response.status, body };
}

async function collectArtifacts(rootDir) {
  const artifacts = [];
  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = pathJoin(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const fileStat = await stat(fullPath);
        artifacts.push({
          path: relative(rootDir, fullPath),
          bytes: fileStat.size,
        });
      }
    }
  }
  await walk(rootDir);
  return artifacts.toSorted((a, b) => a.path.localeCompare(b.path));
}

async function copyStateArtifacts({ statePath, rootDir }) {
  const copied = [];
  for (const sourcePath of [statePath, `${statePath}-wal`, `${statePath}-shm`]) {
    if (!existsSync(sourcePath)) continue;
    const targetPath = pathJoin(rootDir, "state", basename(sourcePath));
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    copied.push(relative(rootDir, targetPath));
  }
  return copied;
}

async function createCutoverEvidenceBundle({ smokeMode = false } = {}) {
  const evidenceDir = process.env.MAB_CUTOVER_EVIDENCE_DIR
    ? pathJoin(process.env.MAB_CUTOVER_EVIDENCE_DIR)
    : await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-cutover-evidence-"));
  await mkdir(evidenceDir, { recursive: true });

  const bundlePath = process.env.MAB_CUTOVER_EVIDENCE_BUNDLE || `${evidenceDir}.tar.gz`;
  const runtimeDir = pathJoin(evidenceDir, "runtime");
  const statePath = pathJoin(runtimeDir, "state.sqlite3");
  const cutoverReportPath = pathJoin(evidenceDir, "reports", "cutover-report.jsonl");
  const shadowReportPath = pathJoin(evidenceDir, "reports", "shadow-tap-report.jsonl");
  const slackPort = Number(process.env.MAB_CUTOVER_EVIDENCE_SLACK_PORT || 18930);
  const meetingPort = Number(process.env.MAB_CUTOVER_EVIDENCE_MEETING_PORT || 18931);
  const signingSecret = "cutover-evidence-signing-secret";
  const shadowSecret = "cutover-evidence-shadow-secret";
  const commands = [];
  const checks = [];
  let slack = null;
  let meeting = null;

  const env = {
    MAB_SLACK_PORT: String(slackPort),
    MAB_MEETING_PORT: String(meetingPort),
    MAB_MEETING_AGENT_URL: `http://127.0.0.1:${meetingPort}`,
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: runtimeDir,
    MAB_STATE_PROVIDER: "sqlite",
    MAB_STATE_SQLITE_PATH: statePath,
    MAB_CUTOVER_MODE: "shadow",
    MAB_CUTOVER_REPORT_PATH: cutoverReportPath,
    MAB_SHADOW_TAP_SECRET: shadowSecret,
    MAB_SHADOW_TAP_REPORT_PATH: shadowReportPath,
    SLACK_SIGNING_SECRET: signingSecret,
  };

  async function recordCheck(name, pass, details = {}) {
    const check = { name, pass: Boolean(pass), details };
    checks.push(check);
    await writeJsonArtifact(pathJoin(evidenceDir, "checks", `${name}.json`), check);
    assertSmoke(check.pass, `cutover evidence check failed: ${name}`, check);
    return check;
  }

  try {
    await mkdir(pathJoin(evidenceDir, "reports"), { recursive: true });
    await mkdir(pathJoin(evidenceDir, "health"), { recursive: true });

    commands.push(
      await runEvidenceCommand({
        name: "git-status",
        args: ["git", "status", "--short", "--branch"],
        rootDir: evidenceDir,
      }),
    );
    commands.push(
      await runEvidenceCommand({
        name: "git-log",
        args: ["git", "log", "--oneline", "--decorate", "-n", "30"],
        rootDir: evidenceDir,
      }),
    );
    commands.push(
      await runEvidenceCommand({
        name: "git-remote",
        args: ["git", "remote", "-v"],
        rootDir: evidenceDir,
      }),
    );
    commands.push(
      await runEvidenceCommand({
        name: "github-recent-prs",
        args: [
          "gh",
          "pr",
          "list",
          "--state",
          "merged",
          "--limit",
          "25",
          "--json",
          "number,title,url,mergedAt,mergeCommit",
        ],
        rootDir: evidenceDir,
      }),
    );

    meeting = startService("apps/meeting-agent/src/index.js", env);
    slack = startService("apps/slack-agent/src/index.js", env);

    const meetingHealth = await waitForServiceHealth(
      meeting,
      `http://127.0.0.1:${meetingPort}/healthz`,
    );
    const slackHealth = await waitForServiceHealth(slack, `http://127.0.0.1:${slackPort}/healthz`);
    await writeJsonArtifact(pathJoin(evidenceDir, "health", "meeting-health.json"), meetingHealth);
    await writeJsonArtifact(pathJoin(evidenceDir, "health", "slack-health.json"), slackHealth);

    const join = await postSignedSlackCommand(
      `http://127.0.0.1:${slackPort}/slack/commands/avatar`,
      "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name EvidenceBot",
      { signingSecret, userId: "U_EVIDENCE" },
    );
    await writeJsonArtifact(pathJoin(evidenceDir, "reports", "shadow-join-response.json"), join);
    await recordCheck(
      "shadow-join-old-primary",
      join.ok === true && join.session?.status === "shadow_old_stack_primary",
      {
        status: join.session?.status,
        cutoverDecision: join.cutoverDecision,
      },
    );

    const meetingSessionsAfterJoin = await fetchJsonArtifact(
      `http://127.0.0.1:${meetingPort}/sessions`,
      pathJoin(evidenceDir, "reports", "meeting-sessions-after-shadow-join.json"),
    );
    await recordCheck(
      "shadow-join-no-meeting-side-effect",
      meetingSessionsAfterJoin.body?.sessions?.length === 0,
      meetingSessionsAfterJoin.body,
    );

    const mirroredCommands = [
      {
        name: "join",
        text: "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name EvidenceBot",
        oldStack: {
          source: "legacy-slack-agentd",
          sessionId: "meet_old_evidence_0001",
          status: "meeting_agent_started",
        },
      },
      {
        name: "delegate",
        text: "delegate --session meet_old_evidence_0001 Summarize the cutover evidence bundle.",
        oldStack: {
          source: "legacy-slack-agentd",
          sessionId: "meet_old_evidence_0001",
          jobId: "job_old_evidence_0001",
          status: "completed",
        },
      },
      {
        name: "jobs",
        text: "jobs --session meet_old_evidence_0001",
        oldStack: { source: "legacy-slack-agentd", sessionId: "meet_old_evidence_0001", jobs: 1 },
      },
      {
        name: "stop",
        text: "stop meet_old_evidence_0001 --reason evidence_done",
        oldStack: {
          source: "legacy-slack-agentd",
          sessionId: "meet_old_evidence_0001",
          status: "stopped",
        },
      },
    ];

    const shadowPosts = [];
    for (const commandBody of mirroredCommands) {
      const response = await fetch(`http://127.0.0.1:${slackPort}/shadow/slack-command`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mab-shadow-tap-secret": shadowSecret,
        },
        body: JSON.stringify({
          source: "legacy-slack-agentd",
          eventId: `evt_evidence_${commandBody.name}`,
          team_id: "T_EVIDENCE",
          channel_id: "C_EVIDENCE",
          user_id: "U_EVIDENCE",
          text: commandBody.text,
          oldStack: commandBody.oldStack,
        }),
      });
      const body = await response.json();
      const result = { name: commandBody.name, httpStatus: response.status, body };
      shadowPosts.push(result);
      await writeJsonArtifact(
        pathJoin(evidenceDir, "reports", `shadow-tap-${commandBody.name}.json`),
        result,
      );
      await recordCheck(
        `shadow-tap-${commandBody.name}-suppressed`,
        response.status === 200 && body?.sideEffects === "suppressed",
        result,
      );
    }

    const slackSessions = await fetchJsonArtifact(
      `http://127.0.0.1:${slackPort}/sessions`,
      pathJoin(evidenceDir, "reports", "slack-sessions.json"),
    );
    const cutoverReport = await fetchJsonArtifact(
      `http://127.0.0.1:${slackPort}/cutover/report`,
      pathJoin(evidenceDir, "reports", "cutover-report.snapshot.json"),
    );
    const shadowReport = await fetchJsonArtifact(
      `http://127.0.0.1:${slackPort}/shadow/report`,
      pathJoin(evidenceDir, "reports", "shadow-report.snapshot.json"),
    );

    await recordCheck(
      "cutover-report-recorded",
      cutoverReport.body?.events?.length >= 1,
      cutoverReport.body,
    );
    await recordCheck(
      "shadow-report-recorded",
      shadowReport.body?.events?.length === mirroredCommands.length,
      shadowReport.body,
    );
    await recordCheck(
      "state-provider-sqlite",
      slackHealth.state?.provider === "sqlite" && meetingHealth.state?.provider === "sqlite",
      {
        slackState: slackHealth.state,
        meetingState: meetingHealth.state,
      },
    );

    for (const service of [slack, meeting]) {
      if (service) service.child.kill("SIGTERM");
    }
    slack = null;
    meeting = null;
    await new Promise((resolve) => setTimeout(resolve, 250));

    const stateArtifacts = await copyStateArtifacts({ statePath, rootDir: evidenceDir });
    const agentRealTaskReports = await copyAgentRealTaskReports({ rootDir: evidenceDir });
    await writeJsonArtifact(pathJoin(evidenceDir, "reports", "shadow-posts.json"), shadowPosts);

    const manifest: CutoverEvidenceManifest = {
      ok: true,
      kind: "meeting-avatar-bot.cutover-evidence.v1",
      generatedAt: new Date().toISOString(),
      smokeMode,
      repo: {
        head: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
        branch: spawnSync("git", ["branch", "--show-current"], { encoding: "utf8" }).stdout.trim(),
        origin: spawnSync("git", ["config", "--get", "remote.origin.url"], {
          encoding: "utf8",
        }).stdout.trim(),
      },
      env: {
        cutoverMode: env.MAB_CUTOVER_MODE,
        stateProvider: env.MAB_STATE_PROVIDER,
        stateSqlitePath: "runtime/state.sqlite3",
        cutoverReportPath: "reports/cutover-report.jsonl",
        shadowTapReportPath: "reports/shadow-tap-report.jsonl",
      },
      checks,
      commands,
      stateArtifacts,
      agentRealTaskReports,
      reportSummary: {
        slackSessions: slackSessions.body?.sessions?.length || 0,
        cutoverEvents: cutoverReport.body?.events?.length || 0,
        shadowEvents: shadowReport.body?.events?.length || 0,
        agentRealTaskReports: agentRealTaskReports.length,
      },
      artifacts: [],
    };
    await writeJsonArtifact(pathJoin(evidenceDir, "manifest.json"), manifest);

    const artifacts = await collectArtifacts(evidenceDir);
    manifest.artifacts = artifacts;
    await writeJsonArtifact(pathJoin(evidenceDir, "manifest.json"), manifest);

    await mkdir(dirname(bundlePath), { recursive: true });
    const tar = spawnSync(
      "tar",
      ["-czf", bundlePath, "-C", dirname(evidenceDir), basename(evidenceDir)],
      {
        encoding: "utf8",
      },
    );
    assertSmoke(tar.status === 0, "failed to create cutover evidence tarball", {
      status: tar.status,
      stderr: tar.stderr,
    });

    const bundle = {
      ok: true,
      evidenceDir,
      bundlePath,
      manifestPath: pathJoin(evidenceDir, "manifest.json"),
      manifest,
    };
    console.log(JSON.stringify(bundle, null, 2));
    return bundle;
  } finally {
    for (const service of [slack, meeting]) {
      if (service) service.child.kill("SIGTERM");
    }
  }
}

async function cutoverEvidenceBundle() {
  await createCutoverEvidenceBundle();
}

async function cutoverEvidenceSmoke() {
  const bundle = await createCutoverEvidenceBundle({ smokeMode: true });
  assertSmoke(existsSync(bundle.bundlePath), "cutover evidence tarball was not created", bundle);
  assertSmoke(existsSync(bundle.manifestPath), "cutover evidence manifest was not created", bundle);
  assertSmoke(
    bundle.manifest?.checks?.every((check) => check.pass),
    "cutover evidence manifest includes failed checks",
    bundle.manifest,
  );
  assertSmoke(
    bundle.manifest?.artifacts?.some((artifact) => artifact.path === "manifest.json"),
    "cutover evidence manifest is not listed as an artifact",
    bundle.manifest,
  );
}

function summarizeParityJoin(result) {
  return {
    ok: result?.ok,
    status: result?.session?.status,
    meetUrl: result?.session?.meetUrl,
    avatar: result?.session?.avatar,
    text: result?.text,
  };
}

function summarizeParityJob(job) {
  return {
    idPrefix: job?.id?.split("_").slice(0, 2).join("_") || "",
    status: job?.status,
    task: job?.task,
    result: job?.result,
  };
}

async function startOldStackFixture({ port }) {
  const sessions = [];
  const jobs = [];

  function latestSession() {
    return sessions.at(-1) || null;
  }

  function getSession(parsed) {
    if (!parsed.sessionId) return latestSession();
    return sessions.find((session) => session.id === parsed.sessionId) || null;
  }

  async function handleAvatarCommand({ body }) {
    const parsed = parseAvatarCommand(body.text || body.raw || "");
    if (parsed.action === "join") {
      if (!parsed.validMeetUrl) {
        return {
          status: 400,
          body: slackTextResponse("Old stack fixture expected a Google Meet URL.", { ok: false }),
        };
      }
      const session = {
        id: `meet_old_${String(sessions.length + 1).padStart(4, "0")}`,
        status: "meeting_agent_started",
        source: "old-stack-fixture",
        meetUrl: parsed.meetUrl,
        avatar: parsed.avatar,
        requestedBy: body.user_id || body.user || "unknown",
      };
      sessions.push(session);
      return slackTextResponse(
        `Old stack fixture session ${session.id} created for ${session.meetUrl}.`,
        { extra: { session, oldStack: { fixture: true } } },
      );
    }

    if (parsed.action === "status") {
      const session = getSession(parsed);
      return slackTextResponse(
        `Status: ${session ? `${session.id} ${session.status} ${session.meetUrl}` : "no active session"}`,
        { extra: { session, sessions, oldStack: { fixture: true } } },
      );
    }

    if (parsed.action === "delegate") {
      const session = getSession(parsed);
      const job = {
        id: `job_old_${String(jobs.length + 1).padStart(4, "0")}`,
        provider: "fixture-agent",
        status: "completed",
        mode: parsed.requestedMode,
        task: parsed.task,
        result: "Dry-run agent runner accepted the task.",
      };
      jobs.push(job);
      if (session) session.status = "worker_delegated";
      return slackTextResponse(`Delegated to ${job.provider}: ${job.id} (${job.status}).`, {
        extra: { session, job, oldStack: { fixture: true } },
      });
    }

    if (parsed.action === "jobs") {
      const messages = jobs.map(
        (job) => `Worker ${job.id} ${job.status}: ${job.task}\n${job.result}`,
      );
      return slackTextResponse(
        [`Worker jobs: local=${jobs.length}, meeting=${jobs.length}`, messages.join("\n\n")]
          .filter(Boolean)
          .join("\n\n"),
        { extra: { jobs, messages, oldStack: { fixture: true } } },
      );
    }

    if (parsed.action === "stop") {
      const session = getSession(parsed);
      if (session) session.status = "stopped";
      return slackTextResponse(`Stop requested for ${session?.id || "current meeting joiner"}.`, {
        extra: { session, oldStack: { fixture: true } },
      });
    }

    return {
      status: 400,
      body: slackTextResponse(`Unknown old-stack fixture command: ${parsed.action}`, { ok: false }),
    };
  }

  const service = createJsonServer({
    name: "old-stack-fixture",
    port,
    routes: {
      "GET /healthz": () => ({ ok: true, service: "old-stack-fixture" }),
      "GET /sessions": () => ({ ok: true, sessions }),
      "GET /jobs": () => ({ ok: true, jobs }),
      "POST /slack/commands/avatar": handleAvatarCommand,
    },
  });

  await service.listen();
  return {
    close: () => new Promise((resolve) => service.server.close(resolve)),
  };
}

function startService(script, env) {
  let entry = script;
  if (!existsSync(entry) && entry.endsWith(".js") && existsSync(entry.replace(/\.js$/, ".ts"))) {
    entry = entry.replace(/\.js$/, ".ts");
  }
  const args = entry.endsWith(".ts") ? ["--import", "tsx", entry] : [entry];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return { child, logs: () => ({ stdout, stderr }) };
}

async function waitForHealth(url, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // Service is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForServiceHealth(service, url, timeoutMs = 8_000) {
  try {
    return await waitForHealth(url, timeoutMs);
  } catch (error) {
    const logs = service?.logs?.() || {};
    error.message = `${error.message}\nstdout:\n${logs.stdout || ""}\nstderr:\n${logs.stderr || ""}`;
    throw error;
  }
}

async function waitForJoinStatus(url, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await (await fetch(url)).json();
      if (predicate(last)) return last;
    } catch {
      // Status route may not be ready for the first poll.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for join status: ${JSON.stringify(last)}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function postJsonWithStatus(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { httpStatus: response.status, ...(await response.json()) };
}

interface SlackCommandFormOptions {
  userId?: string;
  userName?: string;
  formOverrides?: Record<string, string>;
}

interface SignedSlackRequestOptions extends SlackCommandFormOptions {
  timestamp?: string | number;
  rawBody?: string;
  signature?: string;
  signingSecret?: string;
  omitTimestamp?: boolean;
  omitSignature?: boolean;
}

function buildSlackCommandForm(commandText: string, options: SlackCommandFormOptions = {}) {
  const form = new URLSearchParams({
    token: "deprecated-verification-token",
    team_id: "T_SMOKE",
    team_domain: "smoke",
    channel_id: "C_SMOKE",
    channel_name: "meeting-avatar-smoke",
    user_id: options.userId || "U_SMOKE",
    user_name: options.userName || "smoke-user",
    command: "/avatar",
    text: commandText,
    response_url: "https://hooks.slack.com/commands/smoke",
    trigger_id: "smoke-trigger",
    ...options.formOverrides,
  });
  return form.toString();
}

async function postSignedSlackCommand(
  url: string,
  commandText: string,
  options: SignedSlackRequestOptions = {},
) {
  const timestamp = String(options.timestamp || Math.floor(Date.now() / 1000));
  const rawBody = options.rawBody || buildSlackCommandForm(commandText, options);
  const signature =
    options.signature ??
    signSlackRequestBody({
      signingSecret: options.signingSecret || "",
      timestamp,
      rawBody,
    });
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (!options.omitTimestamp) headers["x-slack-request-timestamp"] = timestamp;
  if (!options.omitSignature) headers["x-slack-signature"] = signature;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: rawBody,
  });
  const body = await response.json();
  return { ...body, httpStatus: response.status, rawBody, timestamp, signature };
}

function buildSlackInteractionForm(payload: Record<string, unknown>) {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

async function postSignedSlackInteraction(
  url: string,
  payload: Record<string, unknown>,
  options: SignedSlackRequestOptions = {},
) {
  return postSignedSlackCommand(url, "", {
    ...options,
    rawBody: buildSlackInteractionForm(payload),
  });
}

async function postSignedSlackJson(
  url: string,
  body: Record<string, unknown>,
  options: SignedSlackRequestOptions = {},
) {
  const timestamp = String(options.timestamp || Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(body);
  const signature =
    options.signature ??
    signSlackRequestBody({
      signingSecret: options.signingSecret || "",
      timestamp,
      rawBody,
    });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: rawBody,
  });
  return { ...(await response.json()), httpStatus: response.status, rawBody, timestamp, signature };
}

async function slackContractSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-contract-"));
  const env = {
    MAB_SLACK_PORT: "18920",
    MAB_MEETING_PORT: "18921",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18921",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    MAB_CUTOVER_MODE: "new",
    MAB_SLACK_API_MOCK: "1",
    MAB_SLACK_EVENT_ALLOW_BOT_MESSAGES: "1",
    MAB_SLACK_POSTER_MOCK: "1",
    MAB_SLACK_BOT_USER_ID: "U_BOT",
    SLACK_BOT_TOKEN: "placeholder-bot-token",
    SLACK_SIGNING_SECRET: "slack-contract-signing-secret",
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const slack = startService("apps/slack-agent/src/index.js", env);

  try {
    const parserJoin = parseAvatarCommand(
      'join https://meet.google.com/abc-defg-hij?authuser=2 --avatar hiyori --bot-name "Contract Bot" --dry-run false --start-joiner false',
    );
    assertSmoke(parserJoin.action === "join", "Slack parser did not parse join action", parserJoin);
    assertSmoke(
      parserJoin.validMeetUrl === true,
      "Slack parser rejected valid Meet URL with query",
      parserJoin,
    );
    assertSmoke(
      parserJoin.botName === "Contract Bot",
      "Slack parser did not preserve quoted bot name",
      parserJoin,
    );
    assertSmoke(
      parserJoin.dryRunJoiner === false,
      "Slack parser did not parse --dry-run false",
      parserJoin,
    );
    assertSmoke(
      parserJoin.startJoiner === false,
      "Slack parser did not parse --start-joiner false",
      parserJoin,
    );

    const parserDelegate = parseAvatarCommand(
      'delegate --session meet_contract_123 --mode code --write true "Fix the flaky Slack contract"',
    );
    assertSmoke(
      parserDelegate.action === "delegate",
      "Slack parser did not parse delegate action",
      parserDelegate,
    );
    assertSmoke(
      parserDelegate.sessionId === "meet_contract_123",
      "Slack parser did not parse --session",
      parserDelegate,
    );
    assertSmoke(
      parserDelegate.requestedMode === "code",
      "Slack parser did not parse --mode",
      parserDelegate,
    );
    assertSmoke(
      parserDelegate.allowCodeChanges === true,
      "Slack parser did not parse --write true",
      parserDelegate,
    );
    assertSmoke(
      parserDelegate.task === "Fix the flaky Slack contract",
      "Slack parser did not preserve quoted task",
      parserDelegate,
    );

    const parserStop = parseAvatarCommand('stop meet_contract_123 --reason "contract done"');
    assertSmoke(parserStop.action === "stop", "Slack parser did not parse stop action", parserStop);
    assertSmoke(
      parserStop.sessionId === "meet_contract_123",
      "Slack parser did not parse positional stop session",
      parserStop,
    );
    assertSmoke(
      parserStop.flags.reason === "contract done",
      "Slack parser did not preserve quoted stop reason",
      parserStop,
    );

    const nowSeconds = Math.floor(Date.now() / 1000);
    const rawBody = buildSlackCommandForm("status", { userId: "U_CONTRACT" });
    const validSignature = signSlackRequestBody({
      signingSecret: env.SLACK_SIGNING_SECRET,
      timestamp: String(nowSeconds),
      rawBody,
    });
    assertSmoke(
      verifySlackRequest({
        signingSecret: env.SLACK_SIGNING_SECRET,
        timestamp: String(nowSeconds),
        signature: validSignature,
        rawBody,
        nowSeconds,
      }).ok === true,
      "Slack signature verifier rejected valid fixture signature",
    );
    assertSmoke(
      verifySlackRequest({
        signingSecret: env.SLACK_SIGNING_SECRET,
        timestamp: String(nowSeconds - 999),
        signature: signSlackRequestBody({
          signingSecret: env.SLACK_SIGNING_SECRET,
          timestamp: String(nowSeconds - 999),
          rawBody,
        }),
        rawBody,
        nowSeconds,
      }).error === "stale_timestamp",
      "Slack signature verifier did not reject stale timestamp",
    );
    assertSmoke(
      verifySlackRequest({
        signingSecret: env.SLACK_SIGNING_SECRET,
        timestamp: String(nowSeconds),
        signature: "v0=bad",
        rawBody,
        nowSeconds,
      }).error === "signature_mismatch",
      "Slack signature verifier did not reject mismatched signature",
    );

    await waitForHealth("http://127.0.0.1:18921/healthz");
    await waitForHealth("http://127.0.0.1:18920/healthz");

    const botDmEvent = await postSignedSlackJson(
      "http://127.0.0.1:18920/slack/events",
      {
        team_id: "T_CONTRACT",
        api_app_id: "A_CONTRACT",
        event_id: "EvBOTDMCONTRACT",
        type: "event_callback",
        event: {
          type: "message",
          channel: "D_CONTRACT",
          channel_type: "im",
          user: "U_BOT",
          bot_id: "B_CONTRACT",
          subtype: "bot_message",
          text: "Delegated to codex: job_contract (running).",
          ts: "1778517200.000100",
        },
      },
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      botDmEvent.ok === true &&
        botDmEvent.ignored === true &&
        botDmEvent.reason === "bot_or_subtype",
      "Slack Events API allowed a bot DM message to re-enter the command path",
      botDmEvent,
    );
    const jobsAfterBotDm = await (await fetch("http://127.0.0.1:18920/jobs")).json();
    assertSmoke(
      jobsAfterBotDm.jobs?.length === 0,
      "Bot DM message created a worker job and would self-trigger",
      jobsAfterBotDm,
    );

    const assistantThreadStarted = await postSignedSlackJson(
      "http://127.0.0.1:18920/slack/events",
      {
        team_id: "T_CONTRACT",
        api_app_id: "A_CONTRACT",
        event_id: "EvASSISTANTTHREADCONTRACT",
        type: "event_callback",
        event: {
          type: "assistant_thread_started",
          assistant_thread: {
            channel_id: "D_CONTRACT",
            thread_ts: "1778517200.000200",
            user_id: "U_CONTRACT",
          },
        },
      },
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      assistantThreadStarted.ok === true && assistantThreadStarted.handled === true,
      "Slack assistant thread started event was not handled",
      assistantThreadStarted,
    );

    const assistantDmEvent = await postSignedSlackJson(
      "http://127.0.0.1:18920/slack/events",
      {
        team_id: "T_CONTRACT",
        api_app_id: "A_CONTRACT",
        event_id: "EvASSISTANTDMCONTRACT",
        type: "event_callback",
        event: {
          type: "message",
          channel: "D_CONTRACT",
          channel_type: "im",
          user: "U_CONTRACT",
          text: "jobs",
          ts: "1778517200.000300",
          thread_ts: "1778517200.000200",
        },
      },
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      assistantDmEvent.ok === true &&
        assistantDmEvent.handled === true &&
        assistantDmEvent.mode === "dm_command",
      "Slack assistant DM event did not enter the command path",
      assistantDmEvent,
    );
    const assistantStatus = await (
      await fetch("http://127.0.0.1:18920/slack/assistant/status")
    ).json();
    const assistantMethods = assistantStatus.calls?.map((call) => call.method) || [];
    assertSmoke(
      assistantMethods.includes("assistant.threads.setSuggestedPrompts"),
      "Slack assistant suggested prompts were not sent",
      assistantStatus,
    );
    assertSmoke(
      assistantStatus.calls?.some(
        (call) =>
          call.method === "assistant.threads.setStatus" && call.payload?.status === "Thinking...",
      ),
      "Slack assistant thinking status was not sent",
      assistantStatus,
    );
    assertSmoke(
      assistantStatus.calls?.some(
        (call) =>
          call.method === "assistant.threads.setStatus" &&
          call.payload?.status === "" &&
          !("loading_messages" in call.payload),
      ),
      "Slack assistant clear status should not send empty loading_messages",
      assistantStatus,
    );

    const fallbackMention = await postSignedSlackJson(
      "http://127.0.0.1:18920/slack/events",
      {
        team_id: "T_CONTRACT",
        api_app_id: "A_CONTRACT",
        event_id: "EvMESSAGEFALLBACKMENTIONCONTRACT",
        type: "event_callback",
        event: {
          type: "message",
          channel: "C_CONTRACT",
          channel_type: "channel",
          user: "U_CONTRACT",
          text: "<@U_BOT> hello from fallback",
          ts: "1778517200.000350",
        },
      },
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      fallbackMention.ok === true &&
        fallbackMention.handled === true &&
        fallbackMention.mode === "message_mention",
      "Slack message fallback mention did not enter the command path",
      fallbackMention,
    );
    const fallbackStatus = await (
      await fetch("http://127.0.0.1:18920/slack/assistant/status")
    ).json();
    assertSmoke(
      fallbackStatus.calls?.some(
        (call) =>
          call.method === "assistant.threads.setStatus" &&
          call.payload?.channel_id === "C_CONTRACT" &&
          call.payload?.thread_ts === "1778517200.000350" &&
          call.payload?.status === "Thinking...",
      ),
      "Slack message fallback mention did not set Thinking status",
      fallbackStatus,
    );
    assertSmoke(
      fallbackStatus.calls?.some(
        (call) =>
          call.method === "assistant.threads.setStatus" &&
          call.payload?.channel_id === "C_CONTRACT" &&
          call.payload?.thread_ts === "1778517200.000350" &&
          call.payload?.status === "",
      ),
      "Slack message fallback mention did not clear Thinking status after worker completion",
      fallbackStatus,
    );

    const richMention = await postSignedSlackJson(
      "http://127.0.0.1:18920/slack/events",
      {
        team_id: "T_CONTRACT",
        api_app_id: "A_CONTRACT",
        event_id: "EvAPPMENTIONRICHCONTRACT",
        type: "event_callback",
        thread_messages: [
          {
            type: "message",
            channel: "C_CONTRACT",
            user: "U_PARENT",
            ts: "1778517200.000400",
            text: "Boss demo room: https://meet.google.com/abc-defg-hij",
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "Decision: *record the demo* and include Canvas context.",
                },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Open brief" },
                    url: "https://example.com/brief",
                  },
                ],
              },
            ],
            attachments: [
              {
                title: "Demo Canvas",
                title_link: "https://slack.com/canvas/ABC",
                text: "Canvas-backed launch notes",
                files: [
                  {
                    id: "F_CANVAS",
                    name: "Launch Canvas",
                    title: "Launch Canvas",
                    filetype: "quip",
                    mimetype: "application/vnd.slack-docs",
                    size: 2048,
                  },
                ],
              },
            ],
            files: [
              {
                id: "F_IMG",
                name: "avatar.png",
                title: "Avatar frame",
                filetype: "png",
                mimetype: "image/png",
                size: 12345,
                permalink: "https://files.example/avatar.png",
              },
            ],
            reactions: [{ name: "eyes", count: 2 }],
          },
          {
            type: "app_mention",
            channel: "C_CONTRACT",
            user: "U_CONTRACT",
            ts: "1778517200.000500",
            thread_ts: "1778517200.000400",
            text: "<@U_BOT>",
          },
        ],
        event: {
          type: "app_mention",
          channel: "C_CONTRACT",
          user: "U_CONTRACT",
          text: "<@U_BOT>",
          ts: "1778517200.000500",
          thread_ts: "1778517200.000400",
        },
      },
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      richMention.ok === true && richMention.handled === true && richMention.mode === "app_mention",
      "Slack rich app_mention fixture did not enter command path",
      richMention,
    );
    const richMentionDuplicate = await postSignedSlackJson(
      "http://127.0.0.1:18920/slack/events",
      {
        team_id: "T_CONTRACT",
        api_app_id: "A_CONTRACT",
        event_id: "EvAPPMENTIONRICHCONTRACTDUP",
        type: "event_callback",
        event: {
          type: "message",
          channel: "C_CONTRACT",
          channel_type: "channel",
          user: "U_CONTRACT",
          text: "<@U_BOT>",
          ts: "1778517200.000500",
          thread_ts: "1778517200.000400",
        },
      },
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      richMentionDuplicate.ok === true &&
        richMentionDuplicate.ignored === true &&
        richMentionDuplicate.reason === "duplicate_mention_event",
      "Slack duplicate app_mention/message fallback created a second command path",
      richMentionDuplicate,
    );
    const richContext =
      richMention.response?.richThreadContext ||
      richMention.response?.job?.context?.slackAppMention ||
      {};
    assertSmoke(
      richContext.injectedJoinRequest === true,
      "empty rich mention with Meet URL did not inject join request",
      richContext,
    );
    assertSmoke(
      richContext.transcript?.includes("Boss demo room"),
      "rich mention transcript missed parent text",
      richContext,
    );
    assertSmoke(
      richContext.transcript?.includes("[canvas:"),
      "rich mention transcript missed Canvas file",
      richContext,
    );
    assertSmoke(
      richContext.transcript?.includes("[file: avatar.png"),
      "rich mention transcript missed image file metadata",
      richContext,
    );
    assertSmoke(
      richContext.transcript?.includes("[reactions:"),
      "rich mention transcript missed reactions",
      richContext,
    );
    assertSmoke(
      richContext.imageParts?.length === 1,
      "rich mention did not expose image metadata",
      richContext,
    );
    assertSmoke(
      richMention.response?.job?.task?.includes("请帮我加入这个会议") &&
        richMention.response?.job?.context?.slackAppMention?.prompt?.includes("Thread context:"),
      "rich mention delegate job did not carry the expected thread prompt",
      richMention.response?.job,
    );
    const richMentionJobs = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      "jobs",
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      richMentionJobs.readyForSlack?.jobs?.some((job) => job.id === richMention.response?.job?.id),
      "rich app_mention worker result was not available for Slack post-back",
      richMentionJobs,
    );
    const slackPostingStatus = await (
      await fetch("http://127.0.0.1:18920/slack/assistant/status")
    ).json();
    assertSmoke(
      slackPostingStatus.calls?.some(
        (call) =>
          call.method === "chat.postMessage" &&
          /Dry-run (agent runner|Codex App Server runner) accepted the task\./.test(
            call.payload?.text || "",
          ),
      ),
      "rich app_mention final worker result was not posted back to Slack",
      slackPostingStatus,
    );

    const help = await postSignedSlackCommand("http://127.0.0.1:18920/commands/avatar", "help", {
      signingSecret: env.SLACK_SIGNING_SECRET,
    });
    assertSmoke(
      help.httpStatus === 200 && help.text?.includes("/avatar join"),
      "Slack help contract failed",
      help,
    );

    const badSignature = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      "status",
      { signingSecret: "wrong-contract-secret" },
    );
    assertSmoke(
      badSignature.httpStatus === 401 && badSignature.ok === false,
      "Slack service accepted wrong signature",
      badSignature,
    );

    const staleSignature = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      "status",
      { signingSecret: env.SLACK_SIGNING_SECRET, timestamp: String(nowSeconds - 999) },
    );
    assertSmoke(
      staleSignature.httpStatus === 401 && staleSignature.text?.includes("stale_timestamp"),
      "Slack service accepted stale timestamp",
      staleSignature,
    );

    const invalidJoin = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      "join https://example.com/not-meet",
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      invalidJoin.httpStatus === 400 && invalidJoin.ok === false,
      "Slack service accepted invalid Meet URL",
      invalidJoin,
    );

    const unknown = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      "dance",
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      unknown.httpStatus === 400 && unknown.text?.includes("Unknown command: dance"),
      "Slack service accepted unknown command",
      unknown,
    );

    const join = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      'join https://meet.google.com/abc-defg-hij?authuser=2 --avatar hiyori --bot-name "Contract Bot"',
      {
        signingSecret: env.SLACK_SIGNING_SECRET,
        userId: "U_CONTRACT",
        formOverrides: {
          team_id: "T_CONTRACT",
          channel_id: "C_CONTRACT",
          response_url: "https://hooks.slack.com/commands/contract",
          trigger_id: "contract-trigger",
        },
      },
    );
    const sessionId = join.session?.id;
    assertSmoke(
      join.httpStatus === 200 && join.ok === true && sessionId,
      "Slack join contract did not create a session",
      join,
    );
    assertSmoke(
      join.session?.requestedBy === "U_CONTRACT",
      "Slack join did not preserve Slack user id",
      join.session,
    );
    assertSmoke(
      join.session?.status === "meeting_agent_started",
      "Slack join did not start Meeting Agent in dry-run mode",
      join.session,
    );
    assertSmoke(
      join.meetingAgent?.session?.meetUrl?.includes("abc-defg-hij"),
      "Slack join did not hand the Meet URL to Meeting Agent",
      join.meetingAgent,
    );
    assertSmoke(
      join.slackVerification?.ok === true && join.slackVerification?.skipped === false,
      "Slack join did not include successful verification metadata",
      join.slackVerification,
    );

    const meetingSessions = await (await fetch("http://127.0.0.1:18921/sessions")).json();
    assertSmoke(
      meetingSessions.sessions?.length === 1,
      "Meeting Agent did not receive exactly one session",
      meetingSessions,
    );

    const status = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      `status ${sessionId}`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      status.httpStatus === 200 && status.session?.id === sessionId,
      "Slack status contract did not resolve session id",
      status,
    );
    assertSmoke(
      Array.isArray(status.jobs),
      "Slack status contract did not include local runner jobs",
      status,
    );

    const missingDelegateTask = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      `delegate --session ${sessionId}`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      missingDelegateTask.httpStatus === 400 && missingDelegateTask.text?.includes("missing task"),
      "Slack delegate accepted a missing task",
      missingDelegateTask,
    );

    const delegate = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      `delegate --session ${sessionId} --mode code --write true "Summarize Slack contract matrix"`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      delegate.httpStatus === 200 && delegate.job?.status === "completed",
      "Slack delegate contract did not complete dry-run job",
      delegate,
    );
    assertSmoke(
      delegate.job?.mode === "code",
      "Slack delegate did not preserve requested mode",
      delegate.job,
    );
    assertSmoke(
      delegate.job?.allowCodeChanges === true,
      "Slack delegate did not preserve write permission flag",
      delegate.job,
    );
    assertSmoke(
      delegate.job?.context?.sessionId === sessionId,
      "Slack delegate did not attach session context",
      delegate.job,
    );
    assertSmoke(
      delegate.job?.context?.slack?.workspaceId === "T_SMOKE",
      "Slack delegate did not attach workspace id",
      delegate.job?.context,
    );
    assertSmoke(
      delegate.job?.context?.slack?.channelId === "C_SMOKE",
      "Slack delegate did not attach channel id",
      delegate.job?.context,
    );
    assertSmoke(
      delegate.job?.context?.workspaceContext?.recentCommands?.length >= 1,
      "Slack delegate did not attach recent workspace context",
      delegate.job?.context,
    );
    assertSmoke(
      !JSON.stringify(delegate.job?.context || {}).includes("response_url"),
      "Slack delegate leaked private Slack response_url into agent context",
      delegate.job?.context,
    );
    assertSmoke(
      delegate.meetingReport?.job?.id === delegate.job?.id,
      "Slack delegate did not report completed job to Meeting Agent",
      delegate.meetingReport,
    );

    const firstJobs = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      `jobs --session ${sessionId}`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      firstJobs.httpStatus === 200 && firstJobs.readyForSlack?.jobs?.length === 1,
      "Slack jobs did not return one ready Meeting Agent job",
      firstJobs,
    );
    assertSmoke(
      firstJobs.text?.includes("Summarize Slack contract matrix"),
      "Slack jobs did not format the worker task",
      firstJobs,
    );

    const secondJobs = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      `jobs --session ${sessionId}`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      secondJobs.httpStatus === 200 && secondJobs.readyForSlack?.jobs?.length === 0,
      "Slack jobs delivered a duplicate worker result",
      secondJobs,
    );

    const stop = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      `stop ${sessionId} --reason contract_done`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      stop.httpStatus === 200 && stop.session?.status === "stopped",
      "Slack stop contract did not mark session stopped",
      stop,
    );
    assertSmoke(
      stop.session?.stoppedReason === "contract_done",
      "Slack stop did not preserve reason",
      stop.session,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          parser: { join: parserJoin, delegate: parserDelegate, stop: parserStop },
          signature: { valid: true, staleRejected: true, mismatchRejected: true },
          service: {
            help,
            badSignature,
            staleSignature,
            botDmEvent,
            jobsAfterBotDm,
            assistantThreadStarted,
            assistantDmEvent,
            assistantStatus,
            richMention,
            richMentionJobs,
            invalidJoin,
            unknown,
            join,
            meetingSessions,
            status,
            missingDelegateTask,
            delegate,
            firstJobs,
            secondJobs,
            stop,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function slackSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-"));
  const env = {
    MAB_SLACK_PORT: "18882",
    MAB_MEETING_PORT: "18883",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18883",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    SLACK_SIGNING_SECRET: "smoke-signing-secret",
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const slack = startService("apps/slack-agent/src/index.js", env);

  try {
    await waitForHealth("http://127.0.0.1:18883/healthz");
    await waitForHealth("http://127.0.0.1:18882/healthz");
    const badSignature = await postSignedSlackCommand(
      "http://127.0.0.1:18882/slack/commands/avatar",
      "status",
      { signingSecret: "wrong-secret" },
    );
    assertSmoke(
      badSignature.httpStatus === 401 && badSignature.ok === false,
      "Slack signature verifier accepted a bad signature",
      badSignature,
    );
    const join = await postSignedSlackCommand(
      "http://127.0.0.1:18882/slack/commands/avatar",
      "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name SmokeBot",
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    const sessionId = join.session?.id;
    const status = await postSignedSlackCommand(
      "http://127.0.0.1:18882/slack/commands/avatar",
      `status ${sessionId}`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    const delegate = await postSignedSlackCommand(
      "http://127.0.0.1:18882/slack/commands/avatar",
      `delegate --session ${sessionId} Summarize the meeting avatar bot control plane.`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    const jobs = await postSignedSlackCommand(
      "http://127.0.0.1:18882/slack/commands/avatar",
      "jobs",
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    const stop = await postSignedSlackCommand(
      "http://127.0.0.1:18882/slack/commands/avatar",
      `stop ${sessionId} --reason smoke_done`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    console.log(
      JSON.stringify({ ok: true, badSignature, join, status, delegate, jobs, stop }, null, 2),
    );
  } finally {
    for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

if (command === "doctor") {
  await doctor();
} else if (command === "smoke") {
  await smoke();
} else if (command === "agent-provider-smoke") {
  await agentProviderSmoke();
} else if (command === "agent-real-task-smoke") {
  await agentRealTaskSmoke();
} else if (command === "claude-provider-smoke") {
  await claudeProviderSmoke();
} else if (command === "codex-app-server-provider-smoke") {
  await codexAppServerProviderSmoke();
} else if (command === "ollama-provider-smoke") {
  await ollamaProviderSmoke();
} else if (command === "slack-agent-d-provider-smoke") {
  await slackAgentDProviderSmoke();
} else if (command === "slack-live-capability-smoke") {
  await slackLiveCapabilitySmoke();
} else if (command === "slack-live-socket-smoke") {
  await slackLiveSocketSmoke();
} else if (command === "slack-memory-seed") {
  await slackMemorySeed();
} else if (command === "slack-memory-smoke") {
  await slackMemorySmoke();
} else if (command === "local-agent-dialog-smoke") {
  await localAgentDialogSmoke();
} else if (command === "caption-local-dialog-smoke") {
  await captionLocalDialogSmoke();
} else if (command === "dialog-provider-smoke") {
  await dialogProviderSmoke();
} else if (command === "post-meeting-smoke") {
  await postMeetingSmoke();
} else if (command === "meetd-api-compat-smoke") {
  await meetdApiCompatSmoke();
} else if (command === "meetd-runtime-store-smoke") {
  await meetdRuntimeStoreSmoke();
} else if (command === "digest-webhook-smoke") {
  await digestWebhookSmoke();
} else if (command === "meeting-copilot-smoke") {
  await meetingCopilotSmoke();
} else if (command === "canvas-publisher-smoke") {
  await canvasPublisherSmoke();
} else if (command === "slack-mrkdwn-renderer-smoke") {
  await slackMrkdwnRendererSmoke();
} else if (command === "slack-assistant-schedule-smoke") {
  await slackAssistantScheduleSmoke();
} else if (command === "slack-assistant-schedule-service-smoke") {
  await slackAssistantScheduleServiceSmoke();
} else if (command === "slack-workspace-bootstrap-smoke") {
  await slackWorkspaceBootstrapSmoke();
} else if (command === "slack-install-smoke") {
  await slackInstallSmoke();
} else if (command === "slack-tool-registry-smoke") {
  await slackToolRegistrySmoke();
} else if (command === "slack-domain-store-smoke") {
  await slackDomainStoreSmoke();
} else if (command === "slack-triage-flow-smoke") {
  await slackTriageFlowSmoke();
} else if (command === "state-provider-smoke") {
  await stateProviderSmoke();
} else if (command === "avatar-smoke") {
  await avatarSmoke();
} else if (command === "realtime-smoke") {
  await realtimeSmoke();
} else if (command === "meet-smoke") {
  await meetSmoke();
} else if (command === "meet-contract-smoke") {
  await meetContractSmoke();
} else if (command === "screen-share-smoke") {
  await screenShareSmoke();
} else if (command === "real-meet-smoke") {
  await realMeetSmoke();
} else if (command === "real-local-dialog-smoke") {
  await realLocalDialogSmoke();
} else if (command === "persistence-smoke") {
  await persistenceSmoke();
} else if (command === "worker-bridge-smoke") {
  await workerBridgeSmoke();
} else if (command === "realtime-browser-smoke") {
  await realtimeBrowserSmoke();
} else if (command === "realtime-webrtc-smoke") {
  await realtimeWebrtcSmoke();
} else if (command === "realtime-participant-audio-smoke") {
  await realtimeParticipantAudioSmoke();
} else if (command === "realtime-audio-route-smoke") {
  await realtimeAudioRouteSmoke();
} else if (command === "realtime-repeat-guard-smoke") {
  await realtimeRepeatGuardSmoke();
} else if (command === "realtime-session-update-smoke") {
  await realtimeSessionUpdateSmoke();
} else if (command === "realtime-worker-tool-smoke") {
  await realtimeWorkerToolSmoke();
} else if (command === "realtime-live-tool-smoke") {
  await realtimeLiveToolSmoke();
} else if (command === "realtime-live-routing-smoke") {
  await realtimeLiveRoutingSmoke();
} else if (command === "avatar-state-smoke") {
  await avatarStateSmoke();
} else if (command === "avatar-visual-smoke") {
  await avatarVisualSmoke();
} else if (command === "avatar-vrm-smoke") {
  await avatarVRMSmoke();
} else if (command === "hiyori-live2d-smoke") {
  await hiyoriLive2dSmoke();
} else if (command === "runtime-acceptance-smoke") {
  await runtimeAcceptanceSmoke();
} else if (command === "slack-result-smoke") {
  await slackResultSmoke();
} else if (command === "slack-posting-smoke") {
  await slackPostingSmoke();
} else if (command === "slack-contract-smoke") {
  await slackContractSmoke();
} else if (command === "cutover-shadow-smoke") {
  await cutoverShadowSmoke();
} else if (command === "cutover-rollback-smoke") {
  await cutoverRollbackSmoke();
} else if (command === "shadow-parity-smoke") {
  await shadowParitySmoke();
} else if (command === "shadow-tap-smoke") {
  await shadowTapSmoke();
} else if (command === "shadow-transmitter-smoke") {
  await shadowTransmitterSmoke();
} else if (command === "shadow-transmitter-hook") {
  await shadowTransmitterHook();
} else if (command === "cutover-evidence-bundle") {
  await cutoverEvidenceBundle();
} else if (command === "cutover-evidence-smoke") {
  await cutoverEvidenceSmoke();
} else if (command === "realtime-sdp-smoke") {
  await realtimeSdpSmoke();
} else if (command === "slack-smoke") {
  await slackSmoke();
} else {
  printHelp();
}
