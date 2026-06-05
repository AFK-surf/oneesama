#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

import { scoreCase, withRealtimeBenchmarkLock } from "./realtime-tool-recall-benchmark.mjs";
import {
  audioReplayRuntimeEvidenceProfile,
  browserTransportRuntimeOptions,
  printAudioReplayReport,
  validateAudioReplayRuntime,
} from "./realtime-audio-tool-replay-report.mjs";
export {
  audioReplayRuntimeEvidenceProfile,
  browserTransportRuntimeOptions,
  validateAudioReplayRuntime,
};
import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

const DEFAULT_AGENT_URL = "http://127.0.0.1:8781";
const DEFAULT_FIXTURE = "scripts/fixtures/realtime-tool-recall-cases.json";
const DEFAULT_AUDIO =
  process.env.MAB_REALTIME_AUDIO_REPLAY_SAMPLE ||
  "runtime/meeting-artifacts/runner-dual_audio_truebot_1200/recappi-audio.wav";
const DEFAULT_EXPECTED_TOOLS = "list_shareable_windows,share_existing_app_window";
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_CHUNK_MS = 100;
const PCM_RATE = 24_000;
const PCM_BYTES_PER_SAMPLE = 2;

export function parseAudioReplayArgs(argv) {
  const args = {
    audio: DEFAULT_AUDIO,
    fixture: DEFAULT_FIXTURE,
    meetingAgentUrl: process.env.MAB_MEETING_AGENT_URL || DEFAULT_AGENT_URL,
    browserPageUrl: process.env.MAB_REALTIME_BENCHMARK_BROWSER_PAGE_URL || "",
    runtime: "sidecar-audio",
    variants: "full,share-control-only",
    expectedTools: DEFAULT_EXPECTED_TOOLS,
    startSec: 0,
    durationSec: 25,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    chunkMs: DEFAULT_CHUNK_MS,
    transcriptionModel: "gpt-4o-mini-transcribe",
    jsonOut: "",
    reportOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--audio") args.audio = argv[++i];
    else if (arg === "--fixture") args.fixture = argv[++i];
    else if (arg === "--meeting-agent-url") args.meetingAgentUrl = argv[++i];
    else if (arg === "--browser-page-url") args.browserPageUrl = argv[++i];
    else if (arg === "--runtime") args.runtime = argv[++i];
    else if (arg === "--variants") args.variants = argv[++i];
    else if (arg === "--expected-tools") args.expectedTools = argv[++i];
    else if (arg === "--start-sec") args.startSec = Number(argv[++i]);
    else if (arg === "--duration-sec") args.durationSec = Number(argv[++i]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--chunk-ms") args.chunkMs = Number(argv[++i]);
    else if (arg === "--transcription-model") args.transcriptionModel = argv[++i];
    else if (arg === "--json-out") args.jsonOut = argv[++i];
    else if (arg === "--report-only") args.reportOnly = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.audio) throw new Error("--audio is required");
  args.meetingAgentUrl = args.meetingAgentUrl.replace(/\/+$/, "");
  args.browserPageUrl = String(args.browserPageUrl || "").trim();
  args.runtime = String(args.runtime || "sidecar-audio").toLowerCase();
  if (args.runtime === "browser-bridge") args.runtime = "browser-transport";
  if (
    !["sidecar-audio", "browser-transport", "agents-sdk", "raw-websocket"].includes(args.runtime)
  ) {
    throw new Error(
      "--runtime must be sidecar-audio, browser-transport, agents-sdk, or raw-websocket",
    );
  }
  args.startSec = Number.isFinite(args.startSec) && args.startSec >= 0 ? args.startSec : 0;
  args.durationSec =
    Number.isFinite(args.durationSec) && args.durationSec > 0 ? args.durationSec : 25;
  args.timeoutMs =
    Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
  args.chunkMs =
    Number.isFinite(args.chunkMs) && args.chunkMs > 0 ? args.chunkMs : DEFAULT_CHUNK_MS;
  validateAudioReplayRuntime(args);
  return args;
}

function envMs(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/realtime-audio-tool-replay-benchmark.mjs [--audio <wav>] [options]

Options:
  --audio <path>                WAV/MP3/etc. to replay through Realtime audio input (default: ${DEFAULT_AUDIO}; override with MAB_REALTIME_AUDIO_REPLAY_SAMPLE)
  --fixture <path>              Tool recall fixture for variant tool filters (default: ${DEFAULT_FIXTURE})
  --meeting-agent-url <url>     Meeting agent URL (default: ${DEFAULT_AGENT_URL})
  --browser-page-url <url>      Surface page used by sidecar-audio/browser-transport (default: <meeting-agent-url>/healthz; real Meet URLs require sidecar-audio)
  --runtime <name>              sidecar-audio, browser-transport, agents-sdk, or raw-websocket (default: sidecar-audio; non-sidecar modes are diagnostic-only)
  --variants <csv>              Variant names to run (default: full,share-control-only)
  --expected-tools <csv>        Any one of these tools must be called (default: ${DEFAULT_EXPECTED_TOOLS})
  --start-sec <n>               Start offset in the audio sample (default: 0)
  --duration-sec <n>            Audio segment length to replay (default: 25)
  --timeout-ms <n>              Per Realtime response timeout (default: ${DEFAULT_TIMEOUT_MS})
  --chunk-ms <n>                PCM append chunk size (default: ${DEFAULT_CHUNK_MS})
  --transcription-model <name>  Input audio transcription model (default: gpt-4o-mini-transcribe)
  --json-out <path>             Write structured report
  --report-only                 Always exit 0 after writing the report
`);
}

function runtimeIsAcceptanceGate(runtime) {
  return runtime === "sidecar-audio";
}

function compactText(value, limit = 800) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasShareIntent(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  return /(共享|分享|share|present|屏幕|窗口|浏览器|browser|chrome|Chrome|Pencil|VSCode|Notion)/i.test(
    normalized,
  );
}

function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part?.text || part?.transcript || "")
    .filter(Boolean)
    .join("");
}

function textFromEvent(event) {
  const responseOutputContent = Array.isArray(event.response?.output)
    ? event.response.output.flatMap((item) => item?.content || [])
    : [];
  return (
    event.delta ||
    event.text ||
    event.transcript ||
    event.part?.text ||
    event.part?.transcript ||
    event.item?.text ||
    textFromContent(event.item?.content) ||
    textFromContent(responseOutputContent) ||
    ""
  );
}

function toolNameFromEvent(event) {
  if (event.type === "response.function_call_arguments.done") return event.name || "";
  if (event.item?.type === "function_call") return event.item.name || "";
  if (event.output_item?.type === "function_call") return event.output_item.name || "";
  return "";
}

function secretFromMint(body) {
  return (
    body?.value ||
    body?.client_secret?.value ||
    body?.secret?.value ||
    body?.session?.client_secret?.value ||
    ""
  );
}

function wsUrlFromMint(body, model) {
  if (process.env.MAB_REALTIME_BENCHMARK_WS_URL) {
    const base = process.env.MAB_REALTIME_BENCHMARK_WS_URL.replace(/\/+$/, "");
    return `${base}?model=${encodeURIComponent(model)}`;
  }
  const upstream = String(body?.upstream?.baseUrl || "https://api.openai.com/v1").replace(
    /\/+$/,
    "",
  );
  return `${upstream.replace(/^http/i, "ws")}/realtime?model=${encodeURIComponent(model)}`;
}

async function loadFixture(path) {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(resolvePath(path), "utf8"));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}: ${text.slice(0, 400)}`);
  }
  return body;
}

function pickTools(allTools, fixture, variantName) {
  const variant = (fixture.variants || []).find((entry) => entry.name === variantName);
  if (!variant || variant.toolNames === "*") return allTools;
  const allowed = new Set(variant.toolNames || []);
  return allTools.filter((tool) => allowed.has(tool.name));
}

async function convertAudioToPcm({ audioPath, startSec, durationSec }) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(startSec),
    "-t",
    String(durationSec),
    "-i",
    audioPath,
    "-ac",
    "1",
    "-ar",
    String(PCM_RATE),
    "-f",
    "s16le",
    "pipe:1",
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `ffmpeg exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 400)}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

async function mintSecret({ meetingAgentUrl, tools, config, variantName, audioPath }) {
  const hash = createHash("sha256")
    .update(`${variantName}:${audioPath}:${Date.now()}`)
    .digest("hex")
    .slice(0, 16);
  const body = await fetchJson(`${meetingAgentUrl}/realtime/client-secret`, {
    method: "POST",
    body: JSON.stringify({
      instructions: config.instructions,
      tools,
      outputModalities: ["text"],
      toolChoice: "auto",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: PCM_RATE },
          turn_detection: null,
        },
      },
      safetyIdentifier: `realtime-audio-tool-replay-${hash}`,
    }),
  });
  const secret = secretFromMint(body);
  if (!secret) {
    throw new Error(`client secret missing (${body?.error || "unknown error"})`);
  }
  const model = body?.session?.model || config?.session?.model || config?.model || "gpt-realtime-2";
  return { secret, model, url: wsUrlFromMint(body, model) };
}

function buildSessionUpdate({ config, tools, transcriptionModel }) {
  const base = config.session && typeof config.session === "object" ? config.session : {};
  const audio = base.audio && typeof base.audio === "object" ? base.audio : {};
  const input = audio.input && typeof audio.input === "object" ? audio.input : {};
  const output = audio.output && typeof audio.output === "object" ? audio.output : {};
  const session = {
    ...base,
    type: "realtime",
    model: config.model || base.model || "gpt-realtime-2",
    instructions: config.instructions,
    tools,
    tool_choice: "auto",
    output_modalities: ["text"],
    audio: {
      ...audio,
      input: {
        ...input,
        format: { type: "audio/pcm", rate: PCM_RATE },
        turn_detection: null,
        transcription: transcriptionModel ? { model: transcriptionModel } : undefined,
      },
      output: {
        ...output,
        format: { type: "audio/pcm", rate: PCM_RATE },
        voice: output.voice || config.voice || "marin",
      },
    },
  };
  if (!session.reasoning && config.reasoningEffort) {
    session.reasoning = { effort: config.reasoningEffort };
  }
  return { type: "session.update", session };
}

function normalizeArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pcm16ToFloatSamples(pcm) {
  const samples = Array.from({ length: Math.floor(pcm.length / 2) });
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.max(-1, Math.min(1, pcm.readInt16LE(index * 2) / 32768));
  }
  return samples;
}

function mockToolResult(name, input = {}) {
  if (name === "list_shareable_windows") {
    return {
      ok: true,
      status: "completed",
      windows: [
        {
          applicationName: "Google Chrome",
          windowTitle: "Google Meet",
          processId: 12345,
          windowId: 67890,
        },
      ],
    };
  }
  if (name === "share_existing_app_window") {
    return {
      ok: true,
      status: "completed",
      active: true,
      applicationName: input.applicationName || "Chrome",
      windowTitle: input.windowTitle || "Google Chrome",
    };
  }
  if (name === "kwwk_computer_use") {
    return { ok: true, status: "queued", jobId: "benchmark_app_control_job" };
  }
  return { ok: true, status: "completed", benchmark: true, tool: name };
}

function buildAgentsSdkSessionConfig({ config, transcriptionModel }) {
  const base = config.session && typeof config.session === "object" ? config.session : {};
  const audio = base.audio && typeof base.audio === "object" ? base.audio : {};
  const output = audio.output && typeof audio.output === "object" ? audio.output : {};
  return {
    ...base,
    model: config.model || base.model || "gpt-realtime-2",
    outputModalities: ["text"],
    audio: {
      ...audio,
      input: {
        format: { type: "audio/pcm", rate: PCM_RATE },
        transcription: transcriptionModel ? { model: transcriptionModel } : undefined,
        turnDetection: null,
      },
      output: {
        ...output,
        format: { type: "audio/pcm", rate: PCM_RATE },
        voice: output.voice || config.voice || "marin",
      },
    },
    toolChoice: "auto",
    reasoning:
      base.reasoning || (config.reasoningEffort ? { effort: config.reasoningEffort } : undefined),
  };
}

function recordRealtimeTextEvent(target, event, sequence) {
  const text = textFromEvent(event);
  if (!text) return;
  target.push({
    type: event.type || "",
    mode: String(event.type || "").endsWith(".delta") ? "delta" : "full",
    text: compactText(text),
    sequence,
  });
}

function resultTextFromEvents(textEvents) {
  const deltaText = textEvents
    .filter((event) => event.mode === "delta")
    .map((event) => event.text)
    .join("");
  const fallbackText = textEvents.map((event) => event.text).join("");
  return compactText(deltaText || fallbackText);
}

function resultTranscriptFromEvents(transcriptionEvents) {
  const transcriptDelta = transcriptionEvents
    .filter((event) => event.mode === "delta")
    .map((event) => event.text)
    .join("");
  const transcriptFallback = transcriptionEvents.map((event) => event.text).join(" ");
  return compactText(transcriptDelta || transcriptFallback, 1600);
}

function isInputAudioTranscriptionEventType(type) {
  return (
    type === "conversation.item.input_audio_transcription.delta" ||
    type === "conversation.item.input_audio_transcription.completed"
  );
}

export function transcriptFromBrowserBridgeState(state) {
  const inputAudioTranscript = (state.inbound || [])
    .filter((entry) => isInputAudioTranscriptionEventType(entry?.event?.type || ""))
    .map((entry) => entry?.event?.transcript || entry?.event?.delta || "");
  return compactText(
    [
      ...inputAudioTranscript,
      ...(state.historyTail || [])
        .filter((entry) => entry.role === "user")
        .map((entry) => entry.text || ""),
      state.latestFunctionalTurn?.userText || "",
    ].join(" "),
    1600,
  );
}

function reportableBrowserBridgeErrors(errors) {
  return (errors || []).filter((error) => {
    const message = String(error?.message || error);
    return !/avatar audio bus is not available for remote audio routing/i.test(message);
  });
}

function browserBridgeRuntimeBlocked(result) {
  const runtime = result.browserBridgeRuntime;
  if (!runtime) return false;
  if (runtime.openaiSessionId) return false;
  if ((result.eventTypes || {})["session.created"]) return false;
  return runtime.sdkConnected === true && runtime.inboundCount <= 1;
}

function scoreCaseHasRuntimeOrDeliveryFailure(score) {
  return (
    score.ok === false &&
    ![
      "expected_tool_missing",
      "assistant_text_without_expected_tool",
      "expected_tool_called",
      "no_disallowed_tool_called",
      "disallowed_tool_called",
    ].includes(score.reason)
  );
}

async function runAgentsSdkAudioTurn({
  url,
  secret,
  pcm,
  timeoutMs,
  chunkMs,
  config,
  tools,
  transcriptionModel,
  expectedToolNames,
}) {
  const namespace = await import("@openai/agents-realtime");
  const calls = [];
  const callEvents = [];
  const textEvents = [];
  const transcriptionEvents = [];
  const errors = [];
  const eventTypes = {};
  const bytesPerChunk = Math.max(
    PCM_BYTES_PER_SAMPLE,
    Math.floor((PCM_RATE * PCM_BYTES_PER_SAMPLE * chunkMs) / 1000),
  );
  let sequence = 0;
  let settled = false;
  let session;

  const sdkTools = tools.map((toolConfig) =>
    namespace.tool({
      name: toolConfig.name,
      description: toolConfig.description || `Benchmark ${toolConfig.name} tool`,
      parameters: toolConfig.parameters || { type: "object", properties: {}, required: [] },
      strict: toolConfig.strict === true,
      execute: async (input, _context, details) => {
        const callId =
          details?.toolCall?.callId ||
          details?.toolCall?.call_id ||
          details?.callId ||
          details?.call_id ||
          "";
        sequence += 1;
        calls.push(toolConfig.name);
        callEvents.push({
          name: toolConfig.name,
          type: "agents_sdk.tool_execute",
          callId,
          sequence,
        });
        return JSON.stringify(mockToolResult(toolConfig.name, input || {}));
      },
    }),
  );

  return await new Promise((resolve, reject) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        session?.close?.();
      } catch {
        // Best-effort close.
      }
      resolve({
        calls: unique(calls),
        callEvents,
        assistantText: resultTextFromEvents(textEvents),
        textEvents,
        transcript: resultTranscriptFromEvents(transcriptionEvents),
        transcriptionEvents,
        eventTypes,
        errors,
      });
    };
    const timer = setTimeout(finish, timeoutMs);
    (async () => {
      try {
        const transport = new namespace.OpenAIRealtimeWebSocket({ url });
        const agent = new namespace.RealtimeAgent({
          name: config.botName || "Meeting Avatar Bot",
          instructions: config.instructions || "",
          tools: sdkTools,
          voice: config.voice || config.session?.audio?.output?.voice || "marin",
        });
        session = new namespace.RealtimeSession(agent, {
          model: config.model || config.session?.model || "gpt-realtime-2",
          transport,
          config: buildAgentsSdkSessionConfig({ config, transcriptionModel }),
          historyStoreAudio: false,
          context: { session_id: "benchmark-audio-replay" },
          groupId: "benchmark-audio-replay",
          traceMetadata: { benchmark: "realtime-audio-tool-replay" },
        });
        session.on("transport_event", (event) => {
          sequence += 1;
          eventTypes[event.type || "transport_event"] =
            (eventTypes[event.type || "transport_event"] || 0) + 1;
          const name = toolNameFromEvent(event);
          if (name) {
            calls.push(name);
            callEvents.push({ name, type: event.type, sequence });
          }
          if (
            event.type === "conversation.item.input_audio_transcription.delta" ||
            event.type === "conversation.item.input_audio_transcription.completed"
          ) {
            recordRealtimeTextEvent(transcriptionEvents, event, sequence);
          }
          if (
            event.type === "response.text.delta" ||
            event.type === "response.text.done" ||
            event.type === "response.output_text.delta" ||
            event.type === "response.output_text.done" ||
            event.type === "response.audio_transcript.delta" ||
            event.type === "response.audio_transcript.done" ||
            event.type === "response.output_audio_transcript.delta" ||
            event.type === "response.output_audio_transcript.done" ||
            event.type === "response.content_part.added" ||
            event.type === "response.output_item.done" ||
            event.type === "response.done"
          ) {
            recordRealtimeTextEvent(textEvents, event, sequence);
          }
          if (event.type === "error") errors.push(event.error || event);
        });
        session.on("agent_tool_start", (_context, _agent, tool, detail = {}) => {
          sequence += 1;
          const name = tool?.name || "";
          if (name) {
            calls.push(name);
            callEvents.push({
              name,
              type: "agents_sdk.agent_tool_start",
              callId: detail?.toolCall?.callId || detail?.toolCall?.call_id || "",
              sequence,
            });
          }
        });
        session.on("agent_tool_end", (_context, _agent, tool, _result, detail = {}) => {
          sequence += 1;
          const name = tool?.name || "";
          if (name) {
            calls.push(name);
            callEvents.push({
              name,
              type: "agents_sdk.agent_tool_end",
              callId: detail?.toolCall?.callId || detail?.toolCall?.call_id || "",
              sequence,
            });
          }
          if (expectedToolNames.some((expected) => name === expected)) {
            setTimeout(finish, 500);
          }
        });
        session.on("agent_end", (_context, _agent, text) => {
          if (text) {
            sequence += 1;
            textEvents.push({
              type: "agents_sdk.agent_end",
              mode: "full",
              text: compactText(text),
              sequence,
            });
          }
        });
        session.on("error", (error) => errors.push(error?.error || error));
        await session.connect({ apiKey: secret, model: config.model || "gpt-realtime-2", url });
        for (let offset = 0; offset < pcm.length; offset += bytesPerChunk) {
          session.sendAudio(normalizeArrayBuffer(pcm.subarray(offset, offset + bytesPerChunk)), {
            commit: false,
          });
        }
        session.transport?.sendEvent?.({ type: "input_audio_buffer.commit" });
        session.transport?.requestResponse?.();
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          session?.close?.();
        } catch {
          // Best-effort close.
        }
        reject(error);
      }
    })();
  });
}

async function runBrowserTransportAudioTurn({
  meetingAgentUrl,
  browserPageUrl,
  runtime,
  pcm,
  timeoutMs,
  chunkMs,
  config,
  tools,
  expectedToolNames,
}) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: process.env.MAB_REALTIME_BENCHMARK_HEADED !== "1",
    args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
  });
  const runtimeOptions = browserTransportRuntimeOptions(runtime);
  const useSidecar = runtimeOptions.useSidecar;
  const context = await browser.newContext();
  const meetPage = useSidecar ? await context.newPage() : null;
  const page = useSidecar ? await context.newPage() : await context.newPage();
  const textEvents = [];
  const samples = pcm16ToFloatSamples(pcm);
  const sampleChunkSize = Math.max(1, Math.floor((PCM_RATE * chunkMs) / 1000));
  try {
    if (meetPage) {
      await meetPage.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk",
          agentRuntime: "agents-sdk",
          sessionId: "benchmark-audio-replay",
          realtimeRuntimePlacement: "sidecar",
          realtimePageRole: "meet-surface",
        }),
      });
    }
    await page.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "agents-sdk",
        agentRuntime: "agents-sdk",
        realtimeRuntimePlacement: runtimeOptions.realtimeRuntimePlacement,
        realtimePageRole: runtimeOptions.realtimePageRole,
        allowInlineAgentsSDKDiagnostic: runtimeOptions.allowInlineAgentsSDKDiagnostic,
        sessionId: "benchmark-audio-replay",
        botName: config.botName || "Meeting Avatar Bot",
        autoConnect: true,
        autoReconnect: false,
        tokenUrl: `${meetingAgentUrl}/realtime/client-secret`,
        toolCallbackToken: "benchmark-dry-run",
        instructions: config.instructions || "",
        tools,
        toolChoice: "auto",
        session: config.session || {},
        includeParticipantAudio: false,
        forwardMeetAudioToRealtime: true,
        meetAudioInputSource: "recappi_process_audio",
        dryRunLocalTools: true,
        observeMeetChat: false,
      }),
    });
    const pageUrl = browserPageUrl || `${meetingAgentUrl}/healthz`;
    if (meetPage) await meetPage.goto(pageUrl);
    await page.goto(useSidecar ? `${meetingAgentUrl}/healthz#realtime-sidecar` : pageUrl);
    await page.waitForFunction(
      () => window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkConnected === true,
      { timeout: timeoutMs },
    );
    for (let offset = 0; offset < samples.length; offset += sampleChunkSize) {
      const chunk = samples.slice(offset, offset + sampleChunkSize);
      const result = await page.evaluate(
        ({ chunkSamples, sampleRate }) =>
          window.MAB_REALTIME_CLIENT?.pushRecappiAudioSamples?.({
            sessionId: "benchmark-audio-replay",
            source: "recappi_process_audio",
            sampleRate,
            channels: 1,
            samples: chunkSamples,
          }),
        { chunkSamples: chunk, sampleRate: PCM_RATE },
      );
      if (!result?.ok) {
        throw new Error(`pushRecappiAudioSamples failed: ${JSON.stringify(result)}`);
      }
      await sleep(Math.max(5, chunkMs));
    }
    try {
      await page.waitForFunction(
        (expected) => {
          const bridge = window.MAB_REALTIME_BRIDGE || {};
          const calls = [
            ...(bridge.meetTools?.calls || []),
            ...(bridge.workspaceTools?.calls || []),
            ...(bridge.workerTools?.calls || []),
          ];
          return calls.some((call) => expected.includes(call.name || call.toolName));
        },
        expectedToolNames,
        { timeout: Math.max(1000, timeoutMs - (samples.length / PCM_RATE) * 1000) },
      );
    } catch {
      await sleep(3000);
    }
    const state = await page.evaluate(() => {
      const bridge = window.MAB_REALTIME_BRIDGE || {};
      const inbound = bridge.inbound || [];
      const historyTail = bridge.contextHealth?.lastHistoryTail || [];
      return {
        agentRuntime: bridge.agentRuntime || null,
        meetToolCalls: bridge.meetTools?.calls || [],
        workspaceToolCalls: bridge.workspaceTools?.calls || [],
        workerToolCalls: bridge.workerTools?.calls || [],
        latestFunctionalTurn: bridge.contextHealth?.latestFunctionalTurn || null,
        historyTail,
        inbound,
        feedback: bridge.feedback || null,
        connection: bridge.connection || null,
        errors: bridge.errors || [],
        timelineTypes: (bridge.timeline || []).map((entry) => entry.type),
      };
    });
    const meetSurfaceState = meetPage
      ? await meetPage.evaluate(() => ({
          runtimePlacement: window.MAB_REALTIME_BRIDGE?.runtimePlacement || "",
          sdkSuppressedOnMeetSurface:
            window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkSuppressedOnMeetSurface === true,
          hasSDKGlobal: Boolean(window.OpenAIAgentsRealtime),
        }))
      : null;
    const calls = unique(
      [...state.meetToolCalls, ...state.workspaceToolCalls, ...state.workerToolCalls].map(
        (call) => call.name || call.toolName || call.tool_name || "",
      ),
    );
    const callEvents = [
      ...state.meetToolCalls.map((call, index) => ({
        name: call.name || call.toolName || "",
        type: "browser_bridge.meet_tool_call",
        sequence: index + 1,
      })),
      ...state.workspaceToolCalls.map((call, index) => ({
        name: call.name || call.toolName || "",
        type: "browser_bridge.workspace_tool_call",
        sequence: state.meetToolCalls.length + index + 1,
      })),
    ];
    const transcript = compactText(transcriptFromBrowserBridgeState(state));
    const assistantText = compactText(
      state.latestFunctionalTurn?.assistantText ||
        state.historyTail
          .filter((entry) => entry.role === "assistant")
          .map((entry) => entry.text || "")
          .join(" "),
    );
    const eventTypes = {};
    for (const entry of state.inbound) {
      const type = entry?.type || entry?.event?.type || "unknown";
      eventTypes[type] = (eventTypes[type] || 0) + 1;
    }
    for (const type of state.timelineTypes) {
      eventTypes[`timeline:${type}`] = (eventTypes[`timeline:${type}`] || 0) + 1;
    }
    if (assistantText) {
      textEvents.push({
        type: "browser_bridge.assistant_text",
        mode: "full",
        text: assistantText,
        sequence: 1,
      });
    }
    return {
      calls,
      callEvents,
      assistantText,
      textEvents,
      transcript,
      transcriptionEvents: [],
      eventTypes,
      errors: reportableBrowserBridgeErrors(state.errors),
      browserBridgeRuntime: {
        pageUrl: browserPageUrl || `${meetingAgentUrl}/healthz`,
        runtimePlacement: runtimeOptions.realtimeRuntimePlacement,
        diagnosticOnly: runtimeOptions.diagnosticOnly,
        allowInlineAgentsSDKDiagnostic: runtimeOptions.allowInlineAgentsSDKDiagnostic,
        sidecarPageUrl: useSidecar ? `${meetingAgentUrl}/healthz#realtime-sidecar` : "",
        meetSurface: meetSurfaceState,
        sdkConnected: state.agentRuntime?.sdkConnected === true,
        openaiSessionId: state.connection?.openaiSessionId || "",
        inboundCount: state.inbound?.length || 0,
        lastInboundEventType: state.connection?.lastInboundEventType || "",
      },
      bridge: state,
    };
  } finally {
    await page.evaluate(() => window.MAB_REALTIME_CLIENT?.disconnect?.()).catch(() => undefined);
    await sleep(envMs("MAB_REALTIME_BENCHMARK_DISCONNECT_SETTLE_MS", 250));
    await browser.close();
    await sleep(envMs("MAB_REALTIME_BENCHMARK_CASE_COOLDOWN_MS", 750));
  }
}

function runRawWebSocketAudioTurn({
  url,
  secret,
  pcm,
  timeoutMs,
  chunkMs,
  config,
  tools,
  transcriptionModel,
}) {
  return new Promise((resolve, reject) => {
    const calls = [];
    const callEvents = [];
    const textEvents = [];
    const transcriptionEvents = [];
    const errors = [];
    const eventTypes = {};
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    let settled = false;
    let sequence = 0;
    const bytesPerChunk = Math.max(
      PCM_BYTES_PER_SAMPLE,
      Math.floor((PCM_RATE * PCM_BYTES_PER_SAMPLE * chunkMs) / 1000),
    );

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Best-effort close.
      }
      resolve({
        calls: unique(calls),
        callEvents,
        assistantText: resultTextFromEvents(textEvents),
        textEvents,
        transcript: resultTranscriptFromEvents(transcriptionEvents),
        transcriptionEvents,
        eventTypes,
        errors,
      });
    };

    const timer = setTimeout(finish, timeoutMs);
    ws.on("open", () => {
      ws.send(JSON.stringify(buildSessionUpdate({ config, tools, transcriptionModel })));
      for (let offset = 0; offset < pcm.length; offset += bytesPerChunk) {
        ws.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcm.subarray(offset, offset + bytesPerChunk).toString("base64"),
          }),
        );
      }
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      ws.send(JSON.stringify({ type: "response.create" }));
    });
    ws.on("message", (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      sequence += 1;
      eventTypes[event.type || "unknown"] = (eventTypes[event.type || "unknown"] || 0) + 1;
      const name = toolNameFromEvent(event);
      if (name) {
        calls.push(name);
        callEvents.push({ name, type: event.type, sequence });
      }
      if (
        event.type === "conversation.item.input_audio_transcription.delta" ||
        event.type === "conversation.item.input_audio_transcription.completed"
      ) {
        recordRealtimeTextEvent(transcriptionEvents, event, sequence);
      }
      if (
        event.type === "response.text.delta" ||
        event.type === "response.text.done" ||
        event.type === "response.output_text.delta" ||
        event.type === "response.output_text.done" ||
        event.type === "response.audio_transcript.delta" ||
        event.type === "response.audio_transcript.done" ||
        event.type === "response.output_audio_transcript.delta" ||
        event.type === "response.output_audio_transcript.done" ||
        event.type === "response.content_part.added" ||
        event.type === "response.output_item.done" ||
        event.type === "response.done"
      ) {
        const text = textFromEvent(event);
        if (text) {
          recordRealtimeTextEvent(textEvents, event, sequence);
        }
      }
      if (event.type === "error") errors.push(event.error || event);
      if (event.type === "response.done") finish();
    });
    ws.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function scoreAudioReplay(testCase, result) {
  const browserRuntime = result.browserBridgeRuntime || null;
  const runtimeResult =
    result.bridgeRuntime || !browserRuntime ? result : { ...result, bridgeRuntime: browserRuntime };
  const base = scoreCase(testCase, runtimeResult);
  const transcript = result.transcript || "";
  const sawShareIntent = hasShareIntent(transcript);
  if (
    browserRuntime?.runtimePlacement === "sidecar" &&
    browserRuntime?.diagnosticOnly !== true &&
    browserRuntime?.sdkConnected !== true
  ) {
    return {
      ...base,
      ok: false,
      reason: "sidecar_sdk_not_connected",
      fakeExecution: false,
      transcriptShareIntent: sawShareIntent,
    };
  }
  if (browserBridgeRuntimeBlocked(result)) {
    return {
      ...base,
      ok: false,
      reason: "browser_transport_sdk_events_missing",
      fakeExecution: false,
      transcriptShareIntent: sawShareIntent,
    };
  }
  if (scoreCaseHasRuntimeOrDeliveryFailure(base)) {
    return { ...base, transcriptShareIntent: sawShareIntent };
  }
  if (!transcript) {
    return {
      ...base,
      ok: false,
      reason: "audio_replay_no_transcript",
      fakeExecution: false,
      transcriptShareIntent: false,
    };
  }
  if (base.ok) {
    return { ...base, reason: "expected_tool_called", transcriptShareIntent: sawShareIntent };
  }
  if (sawShareIntent) {
    const fakeExecution = Boolean(result.assistantText);
    return {
      ...base,
      ok: false,
      reason: fakeExecution
        ? "audio_replay_share_intent_with_assistant_text_without_tool"
        : "audio_replay_share_intent_without_tool",
      fakeExecution,
      transcriptShareIntent: true,
    };
  }
  return { ...base, transcriptShareIntent: false };
}

async function main() {
  const args = parseAudioReplayArgs(process.argv.slice(2));
  const [fixture, config, pcm] = await Promise.all([
    loadFixture(args.fixture),
    fetchJson(`${args.meetingAgentUrl}/realtime/config`),
    convertAudioToPcm({
      audioPath: resolvePath(args.audio),
      startSec: args.startSec,
      durationSec: args.durationSec,
    }),
  ]);
  const allTools = Array.isArray(config.tools) ? config.tools : [];
  if (allTools.length === 0) throw new Error("/realtime/config returned no tools");
  if (pcm.length === 0) throw new Error("audio segment produced no PCM samples");
  const expectedToolNames = splitCsv(args.expectedTools);
  const report = {
    schema: "oneesama.realtime-audio-tool-replay-report.v1",
    ok: true,
    createdAt: new Date().toISOString(),
    meetingAgentUrl: args.meetingAgentUrl,
    model: config.model || config.session?.model || "",
    audio: resolvePath(args.audio),
    startSec: args.startSec,
    durationSec: args.durationSec,
    pcmBytes: pcm.length,
    expectedToolNames,
    runtime: args.runtime,
    acceptanceGate: runtimeIsAcceptanceGate(args.runtime),
    notAcceptanceGate: !runtimeIsAcceptanceGate(args.runtime),
    ...audioReplayRuntimeEvidenceProfile(args.runtime),
    browserPageUrl: ["sidecar-audio", "browser-transport"].includes(args.runtime)
      ? args.browserPageUrl || `${args.meetingAgentUrl}/healthz`
      : "",
    variants: [],
  };
  for (const variantName of splitCsv(args.variants)) {
    const tools = pickTools(allTools, fixture, variantName);
    const rowBase = {
      id: `audio:${variantName}`,
      expectedToolNames,
    };
    try {
      const minted =
        args.runtime === "browser-transport" || args.runtime === "sidecar-audio"
          ? { url: "", secret: "" }
          : await mintSecret({
              meetingAgentUrl: args.meetingAgentUrl,
              tools,
              config,
              variantName,
              audioPath: resolvePath(args.audio),
            });
      const turnInput = {
        url: minted.url,
        secret: minted.secret,
        pcm,
        timeoutMs: args.timeoutMs,
        chunkMs: args.chunkMs,
        config,
        tools,
        transcriptionModel: args.transcriptionModel,
        expectedToolNames,
        meetingAgentUrl: args.meetingAgentUrl,
        browserPageUrl: args.browserPageUrl,
        runtime: args.runtime,
      };
      const result =
        args.runtime === "browser-transport" || args.runtime === "sidecar-audio"
          ? await runBrowserTransportAudioTurn(turnInput)
          : args.runtime === "agents-sdk"
            ? await runAgentsSdkAudioTurn(turnInput)
            : await runRawWebSocketAudioTurn(turnInput);
      const score = scoreAudioReplay(rowBase, result);
      const row = {
        ...rowBase,
        ok: score.ok,
        reason: score.reason,
        fakeExecution: score.fakeExecution,
        transcriptShareIntent: score.transcriptShareIntent,
        calls: result.calls,
        callEvents: result.callEvents,
        transcript: result.transcript,
        assistantText: result.assistantText,
        eventTypes: result.eventTypes,
        browserBridgeRuntime: result.browserBridgeRuntime || null,
        errors: result.errors.map((error) => ({
          type: error?.type || "",
          code: error?.code || "",
          message: String(error?.message || error).slice(0, 240),
        })),
      };
      report.variants.push({
        name: variantName,
        toolCount: tools.length,
        toolNames: tools.map((tool) => tool.name),
        row,
      });
      report.ok = report.ok && row.ok;
    } catch (error) {
      const row = {
        ...rowBase,
        ok: false,
        reason: "benchmark_error",
        fakeExecution: false,
        transcriptShareIntent: false,
        calls: [],
        callEvents: [],
        transcript: "",
        assistantText: "",
        eventTypes: {},
        errors: [{ message: String(error?.message || error).slice(0, 240) }],
      };
      report.variants.push({
        name: variantName,
        toolCount: tools.length,
        toolNames: tools.map((tool) => tool.name),
        row,
      });
      report.ok = false;
    }
  }
  printAudioReplayReport(report);
  if (args.jsonOut) {
    await writeFile(resolvePath(args.jsonOut), `${JSON.stringify(report, null, 2)}\n`);
  }
  if (!report.ok && !args.reportOnly) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await withRealtimeBenchmarkLock("realtime-audio-tool-replay", main).catch((error) => {
    console.error(`realtime-audio-tool-replay-benchmark failed: ${error?.message || error}`);
    process.exit(1);
  });
}
