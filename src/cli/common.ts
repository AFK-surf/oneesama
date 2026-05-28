import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join as pathJoin, relative } from "node:path";
import Database from "better-sqlite3";
import { getRuntimeConfig } from "../../packages/core/src/env.js";
import {
  createInMemorySessionStore,
  createSessionStore,
} from "../../packages/core/src/session-store.js";
import { createAgentRunner } from "../../packages/core/src/agent-runner/agent-runner.js";
import { codexAppServerRunnerInternals } from "../../packages/core/src/agent-runner/codex-app-server-runner.js";
import { buildAvatarInitScript } from "../../packages/core/src/avatar/init-script-builder.js";
import { buildLocalDialogInitScript } from "../../packages/core/src/dialog/local-dialog-init-builder.js";
import { createGoogleMeetJoiner } from "../../packages/core/src/meeting/google-meet-joiner.js";
import { installMeetCaptionCapture } from "../../packages/core/src/meeting/caption-capture.js";
import { createMeetingArtifactPipeline } from "../../packages/core/src/meeting/post-meeting-artifacts.js";
import {
  computeDigestWebhookSignature,
  verifyDigestWebhookSignature,
} from "../../packages/core/src/meeting/digest-webhook.js";
import { startLocalMeetFixtureServer } from "../../packages/core/src/meeting/local-meet-fixture.js";
import { buildRealtimeBrowserInitScript } from "../../packages/core/src/realtime/realtime-browser-init-builder.js";
import {
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
  realtimeToolSchemas,
} from "../../packages/core/src/realtime/realtime-contract.js";
import { createWorkerReportStore } from "../../packages/core/src/realtime/worker-report-store.js";
import {
  parseAvatarCommand,
  slackTextResponse,
} from "../../packages/core/src/control-plane/avatar-command.js";
import { createJsonServer } from "../../packages/core/src/http-json.js";
import {
  signSlackRequestBody,
  verifySlackRequest,
} from "../../packages/core/src/slack/slack-signature.js";
import { createCanvasPublisher } from "../../packages/core/src/slack/canvas-publisher.js";
import { createSlackPoster } from "../../packages/core/src/slack/slack-poster.js";
import {
  createInMemoryAssistantScheduleManager,
  executeAssistantScheduleTool,
} from "../../packages/core/src/slack/assistant-schedule-tool.js";
import {
  LEGACY_SLACK_TOOL_SPECS,
  createLegacySlackToolRegistry,
} from "../../packages/core/src/slack/legacy-slack-tool-registry.js";
import { createLegacySlackDomainStore } from "../../packages/core/src/slack/legacy-slack-domain-store.js";
import {
  htmlToMarkdown,
  markdownToBlocks,
  markdownToMrkdwn,
  markdownToSlackFallbackText,
  markdownishToMrkdwn,
} from "../../packages/core/src/slack/mrkdwn-renderer.js";
import {
  createLocalSlackMemoryProvider,
  seedLegacySlackMemory,
} from "../../packages/core/src/slack/local-memory.js";
import { buildSlackTriageActionBlocks } from "../../packages/core/src/slack/triage-flow.js";
import {
  formatTriageContexts,
  loadTriageContextProjection,
  persistTriageContextProjection,
} from "../../packages/core/src/slack/triage-context.js";
import {
  buildDailyNoteCompactionTask,
  buildDailyNoteCompactionPrompt,
  dailyNoteCompactHash,
  shouldCompactDailyNote,
} from "../../packages/core/src/slack/scanner-compaction.js";
import {
  assertNoPrivateSlackFields,
  createShadowTapPayload,
  postShadowTap,
  type ShadowTapInput,
} from "../../packages/core/src/shadow/shadow-transmitter.js";

export function printHelp() {
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
  meet-live-acceptance Validate a real Meet diagnostics JSON against Realtime HITL criteria
  realtime-smoke Verify realtime config + worker completion polling
  slack-smoke   Verify Slack control-plane commands against Meeting Agent

Dev services:
  npm run dev:slack
  npm run dev:meeting
`);
}

export function assertSmoke(condition: unknown, message: string, details: unknown = {}): void {
  if (condition) return;
  const error = new Error(message) as Error & { details?: unknown };
  error.details = details;
  throw error;
}

export function readStdinText(): Promise<string> {
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

export function shouldRunOptionalSmoke(runEnvName: string, requireEnvName: string): boolean {
  return process.env[runEnvName] === "1" || process.env[requireEnvName] === "1";
}

export interface RealtimeBridgeWorkerToolCall {
  name?: string;
  result?: { job?: { id?: string; status?: string } };
  [key: string]: unknown;
}

export interface RealtimeBridgeSnapshot {
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

export interface AvatarStateSnapshot {
  mood?: string;
  action?: string;
  statusKind?: string;
  statusText?: string;
  updates?: Array<{ kind?: string; action?: string; statusKind?: string; statusText?: string }>;
  live2dParameterFrames?: number;
  [key: string]: unknown;
}

export interface AvatarVisualSnapshot {
  ok?: boolean;
  hash?: string;
  face?: { nonBackgroundRatio?: number };
  mouth?: { nonBackgroundRatio?: number };
  status?: { nonBackgroundRatio?: number };
  [key: string]: unknown;
}

export interface AvatarVisualDiff {
  changedRatio?: number;
  [key: string]: unknown;
}

export interface AvatarVisualTestHarness {
  renderSnapshot(input: Record<string, unknown>): AvatarVisualSnapshot;
  compareSnapshots(
    from: Record<string, unknown>,
    to: Record<string, unknown>,
    region: Record<string, number>,
  ): AvatarVisualDiff;
  captureSourceSnapshot(input: Record<string, unknown>): AvatarVisualSnapshot;
  getLiveHash(): string;
}

export interface ShadowHookResponseBody {
  ok?: boolean;
  sideEffects?: string;
  event?: {
    summary?: { source?: string };
    parsed?: { action?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ShadowHookBody {
  disabled?: boolean;
  error?: string;
  ok?: boolean;
  payload?: Record<string, unknown>;
  status?: number;
  response?: ShadowHookResponseBody;
  raw?: string;
}

export interface ShadowHookResult {
  status: number | null;
  stdout: string;
  stderr: string;
  body: ShadowHookBody;
}

export interface ShadowReportEvent {
  newStack?: { sideEffects?: string; [key: string]: unknown };
  summary?: { source?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface EvidenceArtifact {
  path: string;
  bytes: number;
}

export interface CutoverEvidenceManifest {
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

export function collectRealtimeSentEvents(bridge: RealtimeBridgeSnapshot): Record<string, unknown>[] {
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

export function hasCommand(commandName: string): string {
  const result = spawnSync("bash", ["-lc", `command -v ${commandName}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function parseEnvFile(filePath: string = ""): Record<string, string> {
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

export function envValue(envFileValues, key) {
  return process.env[key] || envFileValues[key] || "";
}

export function redactSecret(value = "") {
  const raw = String(value || "");
  if (!raw) return "";
  if (raw.length <= 12) return `${raw.slice(0, 3)}...`;
  return `${raw.slice(0, 8)}...${raw.slice(-4)}`;
}


export {
  existsSync,
  readFileSync,
  spawn,
  spawnSync,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
  createServer,
  tmpdir,
  basename,
  dirname,
  pathJoin,
  relative,
  Database,
  getRuntimeConfig,
  createInMemorySessionStore,
  createSessionStore,
  createAgentRunner,
  codexAppServerRunnerInternals,
  buildAvatarInitScript,
  buildLocalDialogInitScript,
  createGoogleMeetJoiner,
  installMeetCaptionCapture,
  createMeetingArtifactPipeline,
  computeDigestWebhookSignature,
  verifyDigestWebhookSignature,
  startLocalMeetFixtureServer,
  buildRealtimeBrowserInitScript,
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
  realtimeToolSchemas,
  createWorkerReportStore,
  parseAvatarCommand,
  slackTextResponse,
  createJsonServer,
  signSlackRequestBody,
  verifySlackRequest,
  createCanvasPublisher,
  createSlackPoster,
  createInMemoryAssistantScheduleManager,
  executeAssistantScheduleTool,
  LEGACY_SLACK_TOOL_SPECS,
  createLegacySlackToolRegistry,
  createLegacySlackDomainStore,
  htmlToMarkdown,
  markdownToBlocks,
  markdownToMrkdwn,
  markdownToSlackFallbackText,
  markdownishToMrkdwn,
  createLocalSlackMemoryProvider,
  seedLegacySlackMemory,
  buildSlackTriageActionBlocks,
  formatTriageContexts,
  loadTriageContextProjection,
  persistTriageContextProjection,
  buildDailyNoteCompactionTask,
  buildDailyNoteCompactionPrompt,
  dailyNoteCompactHash,
  shouldCompactDailyNote,
  assertNoPrivateSlackFields,
  createShadowTapPayload,
  postShadowTap
};
export type { ShadowTapInput };
