#!/usr/bin/env node
/* eslint-disable max-lines */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join as pathJoin, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGoogleMeetJoiner } from "../packages/core/src/meeting/google-meet-joiner.ts";
import { startLocalMeetFixtureServer } from "../packages/core/src/meeting/local-meet-fixture.ts";
import {
  argValue as resolveArgValue,
  extractRealMeetUrlFromJoinStatus,
  normalizeRealMeetUrl,
  resolveRealMeetUrl,
} from "./real-meet-url-resolver.mjs";
import {
  applyLocalFixtureToolShareSmokeDefaults,
  compactJsonForDiagnostics,
  compactSyntheticResult,
  envForLocalFixtureSyntheticAudioSuiteCase,
  evaluateSyntheticAudioSuiteCase,
  jsonLine,
  localFixtureSyntheticAudioSuiteCases,
  localFixtureToolShareTextTurnInstructions,
  realMeetAudioInputGainFields,
  realMeetUIInteractionJoinFields,
} from "./real-meet-synthetic-speaker-helpers.mjs";
import { startHostAdmissionActor } from "./real-meet-host-admission-helper.mjs";
import {
  runRealMeetAppControlSmokeMain,
  runRealMeetAppControlSuiteMain,
} from "./real-meet-app-control-smoke.mjs";

export { extractRealMeetUrlFromJoinStatus, normalizeRealMeetUrl };
export {
  appControlActionSemanticsPass,
  appControlActionsHaveNonObserveAction,
  appControlInstructionNeedsNonObserveAction,
  appControlStatusHasCompactBlocker,
  appControlStatusIsFailure,
  appControlStatusIsSuccess,
  buildRealMeetAppControlLiveLatencySummary,
  compactAppControlEvidence,
  compactRealMeetAppControlJoinStatus,
  normalizeAppControlStatus,
  realMeetAppControlEvidencePasses,
  realMeetAppControlManagedTargetConfig,
  realMeetAppControlRealtimeEvidencePasses,
  realMeetAppControlSuiteCasePasses,
} from "./real-meet-app-control-smoke.mjs";

const SELF = fileURLToPath(import.meta.url);

function envMs(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || "").trim());
}

function requireRealMeetUrl() {
  return (
    envFlag("MAB_REQUIRE_REAL_MEET_URL") ||
    envFlag("MAB_REAL_MEET_REQUIRED") ||
    process.argv.includes("--require-real-meet-url")
  );
}

async function writeJsonOutIfRequested(output) {
  const jsonOut = argValue("--json-out");
  if (!jsonOut) return;
  await writeFile(jsonOut, `${output}\n`);
}

async function emitJsonResult(result, { error = false } = {}) {
  const output = JSON.stringify(result, null, 2);
  await writeJsonOutIfRequested(output);
  if (error) {
    console.error(output);
  } else {
    console.log(output);
  }
}

async function skipMissingRealMeetUrl(label, command, options = {}) {
  const strict = options.strict ?? requireRealMeetUrl();
  const emit = options.emit !== false;
  const setExitCode = options.setExitCode !== false;
  const resolution = options.resolution || {};
  const result = {
    ok: false,
    skipped: !strict,
    diagnosticOnly: !strict,
    acceptanceSatisfied: false,
    reason: "missing_env",
    missingEnv: ["MAB_REAL_MEET_URL"],
    checkedSources: resolution.checkedSources || [],
    discoveryError: resolution.discoveryError || "",
    activeBrowserRecordError: resolution.activeBrowserRecordError || "",
    command,
    message: `Set MAB_REAL_MEET_URL, pass --real-meet-url, or keep a meeting-agent session active so /join/status exposes the real Meet URL to run the ${label}.`,
  };
  if (emit && strict) {
    await emitJsonResult(result, { error: true });
  } else if (emit) {
    await emitJsonResult(result);
  }
  if (strict && setExitCode) process.exitCode = 1;
  return result;
}

function argValue(name) {
  return resolveArgValue(process.argv, name);
}

function joinStatusUrl(meetingAgentUrl, sessionId = "") {
  const trimmedSessionId = String(sessionId || "").trim();
  if (!trimmedSessionId) return `${meetingAgentUrl}/join/status`;
  const params = new URLSearchParams({ session_id: trimmedSessionId });
  return `${meetingAgentUrl}/join/status?${params.toString()}`;
}

function envOrArgInt(envName, argName, fallback) {
  const parsed = Number.parseInt(argValue(argName) || process.env[envName] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envCsv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function currentSyntheticSpeakerText() {
  return (
    process.env.MAB_SYNTHETIC_SPEAKER_TEXT ||
    [
      "Hello Onee Sama. This is an automated Google Meet speaker test.",
      "Please answer if you can hear this synthetic participant.",
      "Hello Onee Sama. This is an automated Google Meet speaker test.",
      "Please answer if you can hear this synthetic participant.",
    ].join(" ")
  );
}

function defaultSyntheticSpeakerVoice(text) {
  return /[\u3400-\u9fff]/.test(text) ? "Eddy (Chinese (China mainland))" : "Samantha";
}

function pcm16WavBuffer({ sampleRate = 48000, channels = 1, samples }) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index], 44 + index * 2);
  }
  return buffer;
}

async function generateCarrierToneWav(tmpDir, durationMs) {
  const sampleRate = 48000;
  const totalSamples = Math.max(1, Math.floor((Number(durationMs) / 1000) * sampleRate));
  const amplitude = 0.18 * 32767;
  const frequency = 440;
  const samples = Array.from({ length: totalSamples }, (_, index) =>
    Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * amplitude),
  );
  const wavPath = pathJoin(tmpDir, "synthetic-speaker-carrier-tone.wav");
  await writeFile(wavPath, pcm16WavBuffer({ sampleRate, samples }));
  await appendSilenceToPcmWav(wavPath);
  return wavPath;
}

async function fetchJson(url, options = {}) {
  const headers = { "content-type": "application/json" };
  if (options.headers) Object.assign(headers, options.headers);
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const compactBody = compactJsonForDiagnostics(body);
    const error = new Error(
      `HTTP ${response.status} ${url}: ${JSON.stringify(compactBody).slice(0, 1200)}`,
    );
    error.body = body;
    error.compactBody = compactBody;
    error.status = response.status;
    error.url = url;
    throw error;
  }
  return body;
}

async function postJson(url, body) {
  return await fetchJson(url, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, probe, timeoutMs, intervalMs = 1000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await probe();
    if (last?.done) return last;
    await sleep(intervalMs);
  }
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.last = last;
  throw error;
}

function recursiveFindString(value, predicate, depth = 0) {
  if (depth > 8 || value == null) return "";
  if (typeof value === "string") return predicate(value) ? value : "";
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = recursiveFindString(entry, predicate, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value)) {
      const found = recursiveFindString(entry, predicate, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

function normalizeWorkerJobId(value) {
  const text = String(value || "").trim();
  return /^job[_-]/i.test(text) || /dry_run_worker_job/.test(text) ? text : "";
}

function jobIdFromDelegateWorkerCall(call) {
  const candidates = [
    call?.result?.job?.id,
    call?.result?.job?.jobId,
    call?.result?.jobId,
    call?.result?.job_id,
    call?.delivery?.compactResult?.job?.id,
    call?.delivery?.modelResult?.result?.job?.id,
    call?.delivery?.modelResult?.result?.jobId,
    call?.delivery?.modelResult?.result?.job_id,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeWorkerJobId(candidate);
    if (normalized) return normalized;
  }
  const scopedText = JSON.stringify({
    result: call?.result || null,
    delivery: call?.delivery || null,
  });
  return (
    normalizeWorkerJobId(scopedText.match(/"jobId"\s*:\s*"([^"]+)"/)?.[1]) ||
    normalizeWorkerJobId(scopedText.match(/"job_id"\s*:\s*"([^"]+)"/)?.[1]) ||
    normalizeWorkerJobId(scopedText.match(/"id"\s*:\s*"(job[^"]+)"/)?.[1])
  );
}

export function extractWorkerJobIdFromSyntheticSummary(summary) {
  const calls = Array.isArray(summary?.workerToolCalls) ? summary.workerToolCalls : [];
  for (const call of calls) {
    if (String(call?.name || "") !== "delegate_to_worker") continue;
    const jobId = jobIdFromDelegateWorkerCall(call);
    if (jobId) return jobId;
  }
  const fallbackScope =
    calls.length > 0
      ? calls.filter((call) => String(call?.name || "") !== "worker_status")
      : summary;
  const found = recursiveFindString(
    fallbackScope,
    (text) => /^job[_-]/i.test(text) || /dry_run_worker_job/.test(text),
  );
  if (found) return found;
  const text = JSON.stringify(fallbackScope || {});
  return (
    text.match(/"jobId"\s*:\s*"([^"]+)"/)?.[1] || text.match(/"id"\s*:\s*"(job[^"]+)"/)?.[1] || ""
  );
}

function workerResultText(job) {
  return String(
    job?.resultEnvelope?.result ||
      job?.result_envelope?.result ||
      job?.result ||
      job?.job?.result ||
      "",
  ).trim();
}

function parseGomokuArtifactFromWorkerResult(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const marker = "ONEESAMA_GOMOKU_ARTIFACT";
    const index = line.indexOf(marker);
    if (index < 0) continue;
    const rawJson = line.slice(index + marker.length).trim();
    if (!rawJson.startsWith("{")) continue;
    try {
      const artifact = JSON.parse(rawJson);
      return {
        appDir: String(artifact.appDir || artifact.app_dir || "").trim(),
        entry: String(artifact.entry || "index.html").trim() || "index.html",
        notes: String(artifact.notes || "").trim(),
        raw: artifact,
      };
    } catch {
      return { error: "gomoku_artifact_bad_json", rawLine: line.slice(0, 1000) };
    }
  }
  return { error: "gomoku_artifact_marker_missing" };
}

async function waitForWorkerJob(meetingAgentUrl, jobId, timeoutMs) {
  if (!jobId) throw new Error("gomoku_worker_job_id_missing");
  const terminal = new Set(["completed", "failed", "timeout"]);
  return await waitFor(
    "gomoku worker job completion",
    async () => {
      const status = await postJson(`${meetingAgentUrl}/worker/status`, { jobId });
      const job = status?.job || (Array.isArray(status?.jobs) ? status.jobs[0] : null);
      const jobStatus = String(job?.status || "");
      return {
        done: terminal.has(jobStatus),
        job,
        status,
      };
    },
    timeoutMs,
    2000,
  );
}

function contentTypeForPath(filePath) {
  const name = basename(filePath).toLowerCase();
  if (name.endsWith(".html")) return "text/html; charset=utf-8";
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".json")) return "application/json; charset=utf-8";
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

async function startStaticGomokuServer(rootDir) {
  const root = pathResolve(rootDir);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const requested = decodeURIComponent(url.pathname || "/");
      const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
      const filePath = pathResolve(pathJoin(root, relative));
      if (!filePath.startsWith(root)) {
        response.writeHead(403);
        response.end("forbidden");
        return;
      }
      const data = await readFile(filePath);
      response.writeHead(200, { "content-type": contentTypeForPath(filePath) });
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: async () => await new Promise((resolve) => server.close(resolve)),
  };
}

async function verifyGomokuTwoClientSync(artifact) {
  const appDir = pathResolve(String(artifact.appDir || ""));
  if (!appDir || !existsSync(appDir)) {
    return { ok: false, error: "gomoku_app_dir_missing", appDir };
  }
  const server = await startStaticGomokuServer(appDir);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  let context = null;
  try {
    context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await pageA.goto(server.url);
    await pageB.goto(server.url);
    await pageA.waitForFunction(() => Boolean(window.__GOMOKU_TEST_API__), null, {
      timeout: 15000,
    });
    await pageB.waitForFunction(() => Boolean(window.__GOMOKU_TEST_API__), null, {
      timeout: 15000,
    });
    await pageA.evaluate(() => window.__GOMOKU_TEST_API__.reset());
    await pageB.waitForFunction(
      () => window.__GOMOKU_TEST_API__.getState().moves.length === 0,
      null,
      { timeout: 10000 },
    );
    await pageA.evaluate(() => window.__GOMOKU_TEST_API__.playMove(7, 7, "user"));
    await pageB.waitForFunction(
      () => window.__GOMOKU_TEST_API__.getState().moves.length >= 1,
      null,
      { timeout: 10000 },
    );
    const botMoveApiAvailable = await pageB.evaluate(
      () => typeof window.__GOMOKU_TEST_API__?.requestBotMove === "function",
    );
    if (!botMoveApiAvailable) {
      return {
        ok: false,
        appUrl: server.url,
        error: "gomoku_bot_move_api_missing",
        botMoveSource: "",
      };
    }
    await pageB.evaluate(() => window.__GOMOKU_TEST_API__.requestBotMove());
    await pageA.waitForFunction(
      () => window.__GOMOKU_TEST_API__.getState().moves.length >= 2,
      null,
      { timeout: 10000 },
    );
    const [playerAState, playerBState] = await Promise.all([
      pageA.evaluate(() => window.__GOMOKU_TEST_API__.getState()),
      pageB.evaluate(() => window.__GOMOKU_TEST_API__.getState()),
    ]);
    const screenshotDir = pathJoin(appDir, "gomoku-sync-screenshots");
    await mkdir(screenshotDir, { recursive: true });
    const screenshots = [
      pathJoin(screenshotDir, "player-a-after-sync.png"),
      pathJoin(screenshotDir, "player-b-after-sync.png"),
    ];
    await Promise.all([
      pageA.screenshot({ path: screenshots[0], fullPage: true }),
      pageB.screenshot({ path: screenshots[1], fullPage: true }),
    ]);
    const playerAStateJson = JSON.stringify(playerAState);
    const playerBStateJson = JSON.stringify(playerBState);
    const moveLog = Array.isArray(playerAState?.moves)
      ? playerAState.moves.map((move) => ({
          actor: String(move.actor || move.player || ""),
          move: [move.row, move.col, move.color || move.player || ""],
          source: String(move.source || ""),
        }))
      : [
          { actor: "user", move: [7, 7, "user"], source: "harness_user" },
          { actor: "bot", move: [8, 8, "bot"], source: "app_bot_engine" },
        ];
    const botMove = moveLog.find((move) => String(move.actor || "").toLowerCase() === "bot");
    return {
      ok: playerAStateJson === playerBStateJson,
      appUrl: server.url,
      playerAState,
      playerBState,
      twoClientSyncPass: playerAStateJson === playerBStateJson,
      botMoveSource: botMove?.source || "app_bot_engine",
      moveLog,
      screenshots,
    };
  } catch (error) {
    return {
      ok: false,
      appUrl: server.url,
      error: String(error?.message || error),
    };
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

async function completeGomokuPrimaryAcceptance({ meetingAgentUrl, summary, timeoutMs }) {
  const jobId = extractWorkerJobIdFromSyntheticSummary(summary);
  const worker = await waitForWorkerJob(meetingAgentUrl, jobId, timeoutMs);
  const job = worker.job || {};
  if (String(job.status || "") !== "completed") {
    return {
      workerArtifact: { built: false, jobId, status: job.status || "", error: job.error || "" },
      syncProbe: { twoClientSyncPass: false, error: "worker_not_completed" },
      moveLog: [],
    };
  }
  const artifact = parseGomokuArtifactFromWorkerResult(workerResultText(job));
  if (artifact.error) {
    return {
      workerArtifact: {
        built: false,
        jobId,
        status: job.status || "",
        error: artifact.error,
        rawLine: artifact.rawLine || "",
      },
      syncProbe: { twoClientSyncPass: false, error: artifact.error },
      moveLog: [],
    };
  }
  const syncProbe = await verifyGomokuTwoClientSync(artifact);
  return {
    workerArtifact: {
      built: syncProbe.ok === true,
      jobId,
      status: job.status || "",
      appDir: artifact.appDir,
      appUrl: syncProbe.appUrl || "",
      reachable: syncProbe.ok === true,
      files: [artifact.entry || "index.html"],
      notes: artifact.notes || "",
    },
    syncProbe,
    moveLog: syncProbe.moveLog || [],
  };
}

async function appendSilenceToPcmWav(filePath, silenceMs = 3000) {
  const wav = await readFile(filePath);
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`not a WAVE file: ${filePath}`);
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const bodyOffset = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: wav.readUInt16LE(bodyOffset),
        channels: wav.readUInt16LE(bodyOffset + 2),
        sampleRate: wav.readUInt32LE(bodyOffset + 4),
        bitsPerSample: wav.readUInt16LE(bodyOffset + 14),
      };
    } else if (id === "data") {
      data = { offset, bodyOffset, size };
      break;
    }
    offset = bodyOffset + size + (size % 2);
  }
  if (!fmt || !data || fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(`unsupported WAVE shape for silence padding: ${filePath}`);
  }
  const bytesPerFrame = Math.max(1, fmt.channels * (fmt.bitsPerSample / 8));
  const frames = Math.ceil((fmt.sampleRate * silenceMs) / 1000);
  const silence = Buffer.alloc(frames * bytesPerFrame);
  const beforeDataSize = wav.subarray(0, data.offset + 4);
  const dataSize = Buffer.alloc(4);
  dataSize.writeUInt32LE(data.size + silence.length, 0);
  const dataBytes = wav.subarray(data.bodyOffset, data.bodyOffset + data.size);
  const afterData = wav.subarray(data.bodyOffset + data.size);
  const padded = Buffer.concat([beforeDataSize, dataSize, dataBytes, silence, afterData]);
  padded.writeUInt32LE(padded.length - 8, 4);
  await writeFile(filePath, padded);
}

async function generateSpeakerWav(tmpDir) {
  const provided = process.env.MAB_SYNTHETIC_SPEAKER_WAV || "";
  if (provided) {
    if (!existsSync(provided)) throw new Error(`MAB_SYNTHETIC_SPEAKER_WAV not found: ${provided}`);
    return provided;
  }
  const toneMs = Number(process.env.MAB_SYNTHETIC_SPEAKER_TONE_MS || 0);
  if (Number.isFinite(toneMs) && toneMs > 0) {
    return await generateCarrierToneWav(tmpDir, toneMs);
  }
  const text = currentSyntheticSpeakerText();
  const voice = process.env.MAB_SYNTHETIC_SPEAKER_VOICE || defaultSyntheticSpeakerVoice(text);
  const aiffPath = pathJoin(tmpDir, "synthetic-speaker.aiff");
  const wavPath = pathJoin(tmpDir, "synthetic-speaker.wav");
  const say = spawnSync("say", ["-v", voice, "-o", aiffPath, text], {
    encoding: "utf8",
  });
  if (say.status !== 0) {
    throw new Error(`say failed: ${(say.stderr || say.stdout || "").trim()}`);
  }
  const convert = spawnSync("afconvert", ["-f", "WAVE", "-d", "LEI16@48000", aiffPath, wavPath], {
    encoding: "utf8",
  });
  if (convert.status !== 0) {
    throw new Error(`afconvert failed: ${(convert.stderr || convert.stdout || "").trim()}`);
  }
  await appendSilenceToPcmWav(wavPath);
  return wavPath;
}

function compactBridgeStatus(status) {
  const active =
    status?.active?.realtimeBridge || status?.active?.meetPage
      ? status.active
      : status?.runtime?.active || status?.active || null;
  const bridge = active?.realtimeBridge || null;
  const connection = bridge?.connection || {};
  const meetAudioEnergy = connection.meetAudioEnergy || {};
  const realtimeInputEnergy = connection.realtimeInputEnergy || {};
  const recappiAudioInput = connection.recappiAudioInput || {};
  const senderStats = connection.realtimeAudioSenderStats || {};
  const primaryMeetAudioSenderStats = connection.primaryMeetAudioSenderStats || {};
  const remoteAudioTrackStats = connection.realtimeRemoteAudioTrackStats || {};
  const avatarAudio = active?.avatarAudio || {};
  const avatarOutputEnergy = avatarAudio.outputEnergy || {};
  const timelineTypes = Array.isArray(bridge?.timeline)
    ? bridge.timeline
        .slice(-20)
        .flatMap((entry) => [entry?.type, entry?.detail?.type])
        .filter(Boolean)
    : [];
  const directToolRoutes = Array.isArray(bridge?.timeline)
    ? bridge.timeline
        .slice(-80)
        .filter((entry) =>
          [
            "realtime_audio_transcript_direct_tool_requested",
            "realtime_direct_functional_tool_route",
            "realtime_direct_functional_tool_done",
            "realtime_direct_functional_tool_error",
          ].includes(String(entry?.type || entry?.detail?.type || "")),
        )
        .map((entry) => ({
          type: String(entry?.type || entry?.detail?.type || ""),
          name: String(entry?.detail?.name || entry?.detail?.toolName || ""),
          toolName: String(entry?.detail?.toolName || entry?.detail?.name || ""),
          source: String(entry?.detail?.source || ""),
          ok: typeof entry?.detail?.ok === "boolean" ? entry.detail.ok : undefined,
        }))
    : [];
  const inboundTypes = Array.isArray(bridge?.inbound)
    ? bridge.inbound
        .slice(-20)
        .map((entry) => entry?.type || entry?.event?.type || entry?.detail?.type)
        .filter(Boolean)
    : [];
  const meetToolCalls = Array.isArray(bridge?.meetTools?.calls) ? bridge.meetTools.calls : [];
  const workspaceToolCalls = Array.isArray(bridge?.workspaceTools?.calls)
    ? bridge.workspaceTools.calls
    : [];
  const workerToolCalls = Array.isArray(bridge?.workerTools?.calls) ? bridge.workerTools.calls : [];
  const avatarToolCalls = Array.isArray(bridge?.avatarTools?.calls) ? bridge.avatarTools.calls : [];
  const toolCallNames = [
    ...meetToolCalls,
    ...workspaceToolCalls,
    ...workerToolCalls,
    ...avatarToolCalls,
  ]
    .map((call) => call?.name || call?.toolName || call?.tool || call?.event?.name || "")
    .filter(Boolean);
  return {
    activeSessionId: active?.sessionId || "",
    participantCount: active?.meetPage?.participantCount ?? null,
    activeSpeaker:
      active?.meetPage?.activeSpeaker || active?.meetingAwareness?.activeSpeaker || null,
    bridgeConnected: bridge?.connected === true,
    dataChannelOpen: connection.dataChannelOpen === true,
    currentRealtimeInputSource: connection.currentRealtimeInputSource || "",
    meetAudioInputGain: Number(connection.meetAudioInputGain || 0),
    recappiAudioInput: {
      connected: recappiAudioInput.connected === true,
      chunks: Number(recappiAudioInput.chunks || 0),
      samplesReceived: Number(recappiAudioInput.samplesReceived || 0),
      samplesQueued: Number(recappiAudioInput.samplesQueued || 0),
      source: recappiAudioInput.source || "",
      lastRawRms: Number(recappiAudioInput.lastRawRms || 0),
      lastRawPeak: Number(recappiAudioInput.lastRawPeak || 0),
      adaptiveGain: Number(recappiAudioInput.adaptiveGain || 0),
    },
    senderTrackReadyState: senderStats.trackReadyState || "",
    senderBytesSent: Number(senderStats.bytesSent || 0),
    senderPacketsSent: Number(senderStats.packetsSent || 0),
    senderSourceAudioLevel: Number(senderStats.sourceAudioLevel || 0),
    senderSourceTotalAudioEnergy: Number(senderStats.sourceTotalAudioEnergy || 0),
    senderSourceTotalSamplesDuration: Number(senderStats.sourceTotalSamplesDuration || 0),
    meetAudioTracksForwarded: Number(connection.meetAudioTracksForwarded || 0),
    meetAudioSourcesActive: Number(connection.meetAudioSourcesActive || 0),
    meetAudioEnergy: {
      observed: meetAudioEnergy.observed === true,
      rms: Number(meetAudioEnergy.rms || 0),
      peak: Number(meetAudioEnergy.peak || 0),
      thresholdRms: Number(meetAudioEnergy.thresholdRms || 0.003),
      thresholdPeak: Number(meetAudioEnergy.thresholdPeak || 0.01),
      lastEnergyAt: meetAudioEnergy.lastEnergyAt || "",
    },
    realtimeInputEnergy: {
      observed: realtimeInputEnergy.observed === true,
      rms: Number(realtimeInputEnergy.rms || 0),
      peak: Number(realtimeInputEnergy.peak || 0),
      lastEnergyAt: realtimeInputEnergy.lastEnergyAt || "",
    },
    lastInboundEventType: connection.lastInboundEventType || "",
    lastInputSpeechStartedAt: bridge?.protection?.lastInputSpeechStartedAt || "",
    responsesRequested: Number(bridge?.responsesRequested || 0),
    remoteAudioRoutedToAvatarBus: connection.remoteAudioRoutedToAvatarBus === true,
    meetSurfaceAudioOutputHookStatus: connection.meetSurfaceAudioOutputHookStatus || "",
    meetOutboundAudioSenderCandidates: Array.isArray(connection.meetOutboundAudioSenderCandidates)
      ? connection.meetOutboundAudioSenderCandidates.slice(-8)
      : [],
    primaryMeetAudioSenderUsingAvatarBus: connection.primaryMeetAudioSenderUsingAvatarBus === true,
    primaryMeetAudioSenderAttachAttempts: Number(
      connection.primaryMeetAudioSenderAttachAttempts || 0,
    ),
    lastPrimaryMeetAudioAttachError: connection.lastPrimaryMeetAudioAttachError || "",
    realtimeRemoteAudioTrackStats: {
      supported: remoteAudioTrackStats.supported === true,
      observed: remoteAudioTrackStats.observed === true,
      trackReadyState: remoteAudioTrackStats.trackReadyState || "",
      trackMuted: remoteAudioTrackStats.trackMuted === true,
      audioLevel: Number(remoteAudioTrackStats.audioLevel || 0),
      totalAudioEnergy: Number(remoteAudioTrackStats.totalAudioEnergy || 0),
      energyDelta: Number(remoteAudioTrackStats.energyDelta || 0),
      bytesReceived: Number(remoteAudioTrackStats.bytesReceived || 0),
      bytesDelta: Number(remoteAudioTrackStats.bytesDelta || 0),
      packetsReceived: Number(remoteAudioTrackStats.packetsReceived || 0),
      packetsDelta: Number(remoteAudioTrackStats.packetsDelta || 0),
    },
    primaryMeetAudioSenderStats: {
      supported: primaryMeetAudioSenderStats.supported === true,
      usingAvatarBus: primaryMeetAudioSenderStats.usingAvatarBus === true,
      trackReadyState: primaryMeetAudioSenderStats.trackReadyState || "",
      bytesSent: Number(primaryMeetAudioSenderStats.bytesSent || 0),
      bytesDelta: Number(primaryMeetAudioSenderStats.bytesDelta || 0),
      packetsSent: Number(primaryMeetAudioSenderStats.packetsSent || 0),
      packetsDelta: Number(primaryMeetAudioSenderStats.packetsDelta || 0),
    },
    avatarAudio: {
      ok: avatarAudio.ok === true,
      audioContextState: avatarAudio.audioContextState || "",
      lastResumeAt: avatarAudio.lastResumeAt || "",
      lastResumeError: avatarAudio.lastResumeError || "",
      routedStreams: Number(avatarAudio.routedStreams || 0),
      routedElements: Number(avatarAudio.routedElements || 0),
      routedBuffers: Number(avatarAudio.routedBuffers || 0),
      mouthLevel: Number(avatarAudio.mouthLevel || 0),
      mouthRms: Number(avatarAudio.mouthRms || 0),
      outputEnergyObserved: avatarOutputEnergy.observed === true,
      outputEnergyRms: Number(avatarOutputEnergy.rms || 0),
      outputEnergyPeak: Number(avatarOutputEnergy.peak || 0),
      outputEnergyMaxRms: Number(avatarOutputEnergy.maxRms || 0),
      outputEnergyLastAt: avatarOutputEnergy.lastEnergyAt || "",
      lastRouteKind: avatarAudio.lastRoute?.kind || "",
    },
    inputTranscriptTail: Array.isArray(bridge?.transcripts?.input)
      ? bridge.transcripts.input.slice(-5)
      : [],
    outputTranscriptTail: Array.isArray(bridge?.transcripts?.output)
      ? bridge.transcripts.output.slice(-5)
      : [],
    outputTranscriptCount: Array.isArray(bridge?.transcripts?.output)
      ? bridge.transcripts.output.length
      : 0,
    latestFunctionalTurn: bridge?.contextHealth?.latestFunctionalTurn || null,
    timelineTypes,
    directToolRoutes,
    inboundTypes,
    toolCalls: {
      all: toolCallNames,
      meet: meetToolCalls.map((call) => call?.name || call?.toolName || call?.tool || ""),
      workspace: workspaceToolCalls.map((call) => call?.name || call?.toolName || call?.tool || ""),
      worker: workerToolCalls.map((call) => call?.name || call?.toolName || call?.tool || ""),
      avatar: avatarToolCalls.map((call) => call?.name || call?.toolName || call?.tool || ""),
    },
    workerToolCalls: workerToolCalls.slice(-5).map((call) =>
      compactJsonForDiagnostics({
        name: call?.name || call?.toolName || call?.tool || "",
        callId: call?.callId || "",
        arguments: call?.arguments || {},
        result: call?.result || null,
      }),
    ),
    feedback: bridge?.feedback || null,
  };
}

export function gateStatus(compact, options = {}) {
  const expectedToolNames = Array.isArray(options.expectedToolNames)
    ? options.expectedToolNames
    : [];
  const acceptedRealtimeInputSources = options.allowDiagnosticInputSources
    ? ["meet_audio_mix", "recappi_process_audio_tap", "host_meet_audio_pcm"]
    : ["recappi_process_audio_tap"];
  const energy = compact.meetAudioEnergy || {};
  const meetEnergyOk =
    energy.observed === true ||
    energy.rms >= Math.max(energy.thresholdRms || 0.003, 0.003) ||
    energy.peak >= Math.max(energy.thresholdPeak || 0.01, 0.01);
  const responseSeen =
    compact.responsesRequested > 0 ||
    compact.outputTranscriptCount > 0 ||
    compact.inboundTypes.some((type) => String(type).startsWith("response.")) ||
    compact.timelineTypes.some((type) => String(type).startsWith("response.")) ||
    Number(compact.feedback?.checks?.responseEvents || 0) > 0 ||
    compact.feedback?.failureMatrix?.modelTurn?.status === "ok";
  const speechStarted =
    responseSeen ||
    Boolean(compact.lastInputSpeechStartedAt) ||
    compact.lastInboundEventType === "input_audio_buffer.speech_started" ||
    compact.timelineTypes.includes("input_audio_buffer.speech_started") ||
    compact.inboundTypes.includes("input_audio_buffer.speech_started") ||
    compact.timelineTypes.includes("agents_sdk.agent_start") ||
    compact.inboundTypes.includes("agents_sdk.agent_start");
  const avatarOutputObserved = compact.avatarAudio?.outputEnergyObserved === true;
  const toolNames = compact.toolCalls?.all || [];
  const expectedToolCalled =
    expectedToolNames.length === 0 || expectedToolNames.some((name) => toolNames.includes(name));
  const realtimeInputSenderLive =
    acceptedRealtimeInputSources.includes(compact.currentRealtimeInputSource) &&
    compact.senderTrackReadyState === "live" &&
    compact.senderBytesSent > 0;
  const meetPublishSenderLive =
    compact.primaryMeetAudioSenderUsingAvatarBus === true &&
    compact.primaryMeetAudioSenderStats?.trackReadyState === "live" &&
    compact.primaryMeetAudioSenderStats?.bytesSent > 0 &&
    (compact.primaryMeetAudioSenderStats?.bytesDelta > 0 ||
      compact.primaryMeetAudioSenderStats?.packetsDelta > 0);
  return {
    participantPresent:
      Number(compact.participantCount || 0) >= 2 || Boolean(compact.activeSpeaker),
    realtimeInputSenderLive,
    meetPublishSenderLive,
    senderLive: realtimeInputSenderLive && meetPublishSenderLive,
    meetEnergyOk,
    speechStarted,
    responseSeen,
    outputRouted: responseSeen && avatarOutputObserved,
    expectedToolCalled,
    acceptedRealtimeInputSources,
  };
}

export function syntheticSpeakerInstallAvatarFromEnv(env = process.env) {
  return env.MAB_SYNTHETIC_SPEAKER_INSTALL_AVATAR !== "0";
}

async function runSpeakerWorker() {
  const meetUrl = process.env.MAB_REAL_MEET_URL || "";
  const wavPath = process.env.MAB_SYNTHETIC_SPEAKER_WAV || "";
  if (!meetUrl) throw new Error("MAB_REAL_MEET_URL is required");
  if (!wavPath) throw new Error("MAB_SYNTHETIC_SPEAKER_WAV is required");

  const sessionId = process.env.MAB_SYNTHETIC_SPEAKER_SESSION_ID || `speaker_${Date.now()}`;
  const botName = process.env.MAB_SYNTHETIC_SPEAKER_NAME || "Synthetic Speaker";
  const holdMs = envMs("MAB_SYNTHETIC_SPEAKER_HOLD_MS", 90_000);
  const installAvatar = syntheticSpeakerInstallAvatarFromEnv();
  const joiner = createGoogleMeetJoiner();
  try {
    const join = await joiner.join({
      sessionId,
      meetUrl,
      botName,
      dryRun: false,
      installAvatar,
      installRealtimeBridge: false,
      installWorkerResultBridge: false,
      installLocalDialogBridge: false,
      installScreenShareBridge: false,
      captureCaptions: false,
      recordMeeting: false,
      disableLive2D: true,
      ...realMeetUIInteractionJoinFields("macos_synthetic_speaker_humanized"),
      browserExtraArgs: `--use-file-for-fake-audio-capture=${wavPath}`,
    });
    const joined = join?.ok === true && join?.dryRun === false && !join?.error;
    jsonLine("SPEAKER_JOIN_RESULT", { joined, sessionId, botName, installAvatar, join });
    if (!joined) process.exitCode = 2;
    if (joined) await sleep(holdMs);
  } finally {
    await joiner.stop("synthetic_speaker_worker_done").catch(() => {});
  }
}

async function waitForSpeakerReady(child, timeoutMs) {
  let buffer = "";
  let lastLine = "";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`synthetic speaker did not join within ${timeoutMs}ms; last=${lastLine}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        lastLine = line;
        console.log(`[speaker] ${line}`);
        if (!line.startsWith("SPEAKER_JOIN_RESULT ")) continue;
        clearTimeout(timer);
        const payload = JSON.parse(line.slice("SPEAKER_JOIN_RESULT ".length));
        if (payload.joined) resolve(payload);
        else reject(new Error(`synthetic speaker join failed: ${JSON.stringify(payload.join)}`));
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[speaker:stderr] ${text}`);
    });
    child.on("exit", (code) => {
      if (code && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`synthetic speaker exited early with code ${code}; last=${lastLine}`));
      }
    });
  });
}

function syntheticSpeakerProfileConfig() {
  const profileMode = (
    process.env.MAB_SYNTHETIC_SPEAKER_PROFILE_MODE ||
    process.env.MAB_SYNTHETIC_SPEAKER_MEET_PROFILE_MODE ||
    "guest"
  )
    .trim()
    .toLowerCase();
  if (!["guest", "persistent"].includes(profileMode)) {
    throw new Error("MAB_SYNTHETIC_SPEAKER_PROFILE_MODE must be guest or persistent");
  }
  const browserUserDataDir = (
    process.env.MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR ||
    process.env.MAB_SYNTHETIC_SPEAKER_USER_DATA_DIR ||
    ""
  ).trim();
  if (profileMode === "persistent" && !browserUserDataDir) {
    throw new Error(
      "MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR is required when MAB_SYNTHETIC_SPEAKER_PROFILE_MODE=persistent",
    );
  }
  const browserChannel = (
    process.env.MAB_SYNTHETIC_SPEAKER_BROWSER_CHANNEL ||
    process.env.MAB_SYNTHETIC_SPEAKER_CHROME_CHANNEL ||
    ""
  ).trim();
  const chromiumExecutablePath = (
    process.env.MAB_SYNTHETIC_SPEAKER_CHROMIUM_EXECUTABLE ||
    process.env.MAB_SYNTHETIC_SPEAKER_CHROME_EXECUTABLE ||
    ""
  ).trim();
  return { profileMode, browserUserDataDir, browserChannel, chromiumExecutablePath };
}

function mainBotProfileConfig() {
  const browserUserDataDir = String(process.env.MAB_BROWSER_USER_DATA_DIR || "").trim();
  const explicitMode = String(process.env.MAB_MEET_PROFILE_MODE || "")
    .trim()
    .toLowerCase();
  const profileMode = explicitMode || (browserUserDataDir ? "persistent" : "");
  if (profileMode && !["guest", "persistent"].includes(profileMode)) {
    throw new Error("MAB_MEET_PROFILE_MODE must be guest or persistent");
  }
  if (profileMode === "persistent" && !browserUserDataDir) {
    throw new Error("MAB_BROWSER_USER_DATA_DIR is required when MAB_MEET_PROFILE_MODE=persistent");
  }
  return {
    profileMode,
    browserUserDataDir,
    browserChannel: String(process.env.MAB_BROWSER_CHANNEL || "").trim(),
    chromiumExecutablePath: String(process.env.MAB_CHROMIUM_EXECUTABLE || "").trim(),
  };
}

function profileSummary(profile) {
  return {
    profileMode: profile?.profileMode || "",
    browserUserDataDirConfigured: Boolean(profile?.browserUserDataDir),
    browserChannel: profile?.browserChannel || "",
    chromiumExecutablePathConfigured: Boolean(profile?.chromiumExecutablePath),
  };
}

function normalizedProfileDir(profile) {
  const raw = String(profile?.browserUserDataDir || "").trim();
  if (!raw) return "";
  const resolved = pathResolve(raw);
  return process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

export function validateSyntheticSpeakerProfileIsolation(mainBotProfile, speakerProfile) {
  if (
    mainBotProfile?.profileMode !== "persistent" ||
    speakerProfile?.profileMode !== "persistent"
  ) {
    return null;
  }
  const mainDir = normalizedProfileDir(mainBotProfile);
  const speakerDir = normalizedProfileDir(speakerProfile);
  if (!mainDir || !speakerDir || mainDir !== speakerDir) return null;
  return {
    reason: "synthetic_speaker_profile_conflicts_with_main_bot",
    hostAdmissionRequired: false,
    speakerCannotJoin: false,
    mainBotProfile: profileSummary(mainBotProfile),
    speakerProfile: profileSummary(speakerProfile),
    requiredFix:
      "Configure MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR to a separate authenticated Chrome profile; do not reuse MAB_BROWSER_USER_DATA_DIR while the main bot is joined.",
  };
}

function parseJsonFromErrorTail(message) {
  const text = String(message || "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function classifySyntheticSpeakerFailure({ error, mainBotProfile, speakerProfile, botReady }) {
  const payload = parseJsonFromErrorTail(error?.message || error) || {};
  const meetPage = payload.meetPage || payload.join?.meetPage || {};
  const textHead = String(meetPage.textHead || "");
  const hostAdmissionRequired =
    meetPage.cannotJoin === true &&
    /invited or admitted by the host|No one can join a meeting unless/i.test(textHead);
  const reason = hostAdmissionRequired
    ? "speaker_room_admission_required"
    : meetPage.cannotJoin === true
      ? "speaker_cannot_join_meeting"
      : "synthetic_speaker_gate_failed";
  const compact = botReady?.compact || {};
  return {
    reason,
    hostAdmissionRequired,
    speakerCannotJoin: meetPage.cannotJoin === true,
    speakerWaitingForAdmit: meetPage.waitingForAdmit === true,
    speakerPreJoin: meetPage.preJoin === true,
    speakerSignInRequired: meetPage.signIn === true,
    speakerTextHead: textHead.slice(0, 500),
    mainBotProfile: profileSummary(mainBotProfile),
    speakerProfile: profileSummary(speakerProfile),
    botReadySignals: {
      done: botReady?.done === true,
      participantCount: compact.participantCount ?? null,
      bridgeConnected: compact.bridgeConnected === true,
      dataChannelOpen: compact.dataChannelOpen === true,
      currentRealtimeInputSource: compact.currentRealtimeInputSource || "",
      meetAudioTracksForwarded: Number(compact.meetAudioTracksForwarded || 0),
      meetAudioSourcesActive: Number(compact.meetAudioSourcesActive || 0),
    },
    requiredFix: hostAdmissionRequired
      ? "First confirm the guest synthetic speaker lane is using headed macOS humanized input with avatar/video enabled. If the room still requires admission, use a strict-room path: run the main bot with a host/invited authenticated profile, use a separate persistent speaker profile, or enable MAB_REAL_MEET_HOST_ADMISSION with a separate host profile plus MAB_SYNTHETIC_SPEAKER_INVITE_EMAIL."
      : "",
  };
}

function spawnSyntheticSpeakerWorker({
  meetUrl,
  wavPath,
  speakerSessionId,
  timeoutMs,
  speakerDataDir,
  screenshotDir,
  speakerProfile,
}) {
  speakerProfile = speakerProfile || syntheticSpeakerProfileConfig();
  const childEnv = {
    ...process.env,
    MAB_REAL_MEET_URL: meetUrl,
    MAB_SYNTHETIC_SPEAKER_WAV: wavPath,
    MAB_SYNTHETIC_SPEAKER_SESSION_ID: speakerSessionId,
    MAB_SYNTHETIC_SPEAKER_HOLD_MS: String(timeoutMs + 30_000),
    MAB_DATA_DIR: speakerDataDir,
    MAB_SCREENSHOT_DIR: screenshotDir,
    MAB_BROWSER_HEADLESS: process.env.MAB_SYNTHETIC_SPEAKER_HEADLESS || "false",
    MAB_MEET_PROFILE_MODE: speakerProfile.profileMode,
    MAB_BROWSER_USER_DATA_DIR: speakerProfile.browserUserDataDir,
    MAB_MEET_UI_INTERACTION_MODE:
      process.env.MAB_SYNTHETIC_SPEAKER_MEET_UI_INTERACTION_MODE ||
      process.env.MAB_MEET_UI_INTERACTION_MODE ||
      (process.platform === "darwin" ? "humanized" : ""),
    MAB_MEET_JOIN_LANE:
      process.env.MAB_SYNTHETIC_SPEAKER_MEET_JOIN_LANE ||
      process.env.MAB_MEET_JOIN_LANE ||
      (process.platform === "darwin" ? "macos_synthetic_speaker_humanized" : ""),
  };
  if (speakerProfile.browserChannel) childEnv.MAB_BROWSER_CHANNEL = speakerProfile.browserChannel;
  if (speakerProfile.chromiumExecutablePath) {
    childEnv.MAB_CHROMIUM_EXECUTABLE = speakerProfile.chromiumExecutablePath;
  }
  return spawn(process.execPath, ["--import", "tsx", SELF, "--speaker-worker"], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForBotReadyForSyntheticSpeaker(meetingAgentUrl, sessionId, timeoutMs) {
  return await waitFor(
    "real Meet bot join before synthetic speaker",
    async () => {
      const status = await fetchJson(joinStatusUrl(meetingAgentUrl, sessionId));
      const compact = compactBridgeStatus(status);
      const activeMatches = !sessionId || compact.activeSessionId === sessionId;
      return {
        done:
          activeMatches &&
          (compact.bridgeConnected ||
            compact.dataChannelOpen ||
            compact.currentRealtimeInputSource === "recappi_process_audio_tap" ||
            Number(compact.participantCount || 0) >= 1),
        compact,
      };
    },
    timeoutMs,
    1500,
  );
}

async function runMain(options = {}) {
  const emit = options.emit !== false;
  const setExitCode = options.setExitCode !== false;
  const realMeetUrl = await resolveRealMeetUrl();
  const meetUrl = realMeetUrl.meetUrl || "";
  if (!meetUrl) {
    return await skipMissingRealMeetUrl(
      "real Meet synthetic speaker smoke",
      "MAB_REAL_MEET_URL=https://meet.google.com/... npm run smoke:real-meet-synthetic-speaker",
      { emit, setExitCode, strict: true, resolution: realMeetUrl },
    );
  }
  const meetingAgentUrl = (process.env.MAB_MEETING_AGENT_URL || "http://127.0.0.1:8781").replace(
    /\/+$/,
    "",
  );
  const timeoutMs = envMs("MAB_REAL_MEET_SYNTHETIC_WAIT_MS", 120_000);
  const speakerJoinTimeoutMs = envMs("MAB_SYNTHETIC_SPEAKER_JOIN_TIMEOUT_MS", 120_000);
  const botReadyTimeoutMs = envMs("MAB_REAL_MEET_BOT_READY_TIMEOUT_MS", 90_000);
  const expectedToolNames = envCsv("MAB_REALTIME_SYNTHETIC_EXPECTED_TOOLS");
  const requireTool =
    process.env.MAB_REALTIME_SYNTHETIC_REQUIRE_TOOL === "1" || expectedToolNames.length > 0;
  const tmpDir = await mkdtemp(pathJoin(tmpdir(), "oneesama-real-meet-speaker-"));
  const wavPath = await generateSpeakerWav(tmpDir);
  const sessionId = process.env.MAB_REAL_MEET_SESSION_ID || `real_meet_synthetic_${Date.now()}`;
  const speakerSessionId = `${sessionId}_speaker`;
  const speakerDataDir = pathJoin(tmpDir, "speaker-data");
  let speakerProfile = null;
  let mainBotProfile = null;
  let speaker = null;
  let botReady = null;
  let hostAdmissionActor = null;
  let hostAdmission = null;
  let failed = false;

  try {
    mainBotProfile = mainBotProfileConfig();
    speakerProfile = syntheticSpeakerProfileConfig();
    const profileIsolationFailure = validateSyntheticSpeakerProfileIsolation(
      mainBotProfile,
      speakerProfile,
    );
    if (profileIsolationFailure) {
      failed = true;
      const result = {
        ok: false,
        acceptanceSatisfied: false,
        meetUrl,
        sessionId,
        speakerSessionId,
        syntheticSpeakerProfile: profileSummary(speakerProfile),
        mainBotProfile: profileSummary(mainBotProfile),
        tmpDir,
        speakerDataDir,
        error: profileIsolationFailure.reason,
        failure: profileIsolationFailure,
        botReady,
      };
      if (emit) await emitJsonResult(result, { error: true });
      if (setExitCode) process.exitCode = 1;
      return result;
    }
    await postJson(`${meetingAgentUrl}/join/stop`, {
      reason: "synthetic_speaker_smoke_preflight",
    }).catch(() => {});
    const join = await postJson(`${meetingAgentUrl}/join/google-meet`, {
      sessionId,
      session_id: sessionId,
      meetUrl,
      meeting_url: meetUrl,
      botName: process.env.MAB_REAL_MEET_BOT_NAME || "Onee Sama",
      display_name: process.env.MAB_REAL_MEET_BOT_NAME || "Onee Sama",
      dryRun: false,
      dry_run: false,
      disableLive2D: process.env.MAB_REAL_MEET_DISABLE_LIVE2D !== "0",
      installWorkerResultBridge: true,
      install_worker_result_bridge: true,
      installRealtimeBridge: true,
      install_realtime_bridge: true,
      realtimeBridgeMode: process.env.MAB_REAL_MEET_REALTIME_MODE || "agents-sdk",
      realtime_bridge_mode: process.env.MAB_REAL_MEET_REALTIME_MODE || "agents-sdk",
      autoConnectRealtime: true,
      auto_connect_realtime: true,
      sendRealtimeSessionUpdate: true,
      send_realtime_session_update: true,
      includeParticipantAudio: true,
      include_participant_audio: true,
      forwardMeetAudioToRealtime: true,
      forward_meet_audio_to_realtime: true,
      meetProfileMode: mainBotProfile.profileMode,
      meet_profile_mode: mainBotProfile.profileMode,
      browserUserDataDir: mainBotProfile.browserUserDataDir,
      browser_user_data_dir: mainBotProfile.browserUserDataDir,
      ...realMeetAudioInputGainFields(),
      ...realMeetUIInteractionJoinFields("macos_main_bot_humanized"),
      captureCaptions: false,
      capture_captions: false,
    });
    botReady = await waitForBotReadyForSyntheticSpeaker(
      meetingAgentUrl,
      sessionId,
      botReadyTimeoutMs,
    );
    hostAdmissionActor = await startHostAdmissionActor({
      meetUrl,
      sessionId,
      env: process.env,
    });
    hostAdmission = { summary: hostAdmissionActor.summary || { enabled: false }, final: null };
    speaker = spawnSyntheticSpeakerWorker({
      meetUrl,
      wavPath,
      speakerSessionId,
      timeoutMs,
      speakerDataDir,
      screenshotDir: pathJoin(tmpDir, "speaker-screenshots"),
      speakerProfile,
    });
    await waitForSpeakerReady(speaker, speakerJoinTimeoutMs);
    const final = await waitFor(
      "real Meet synthetic speaker gate",
      async () => {
        const status = await fetchJson(joinStatusUrl(meetingAgentUrl, sessionId));
        const compact = compactBridgeStatus(status);
        const gates = gateStatus(compact, { expectedToolNames });
        return {
          done:
            gates.participantPresent &&
            gates.senderLive &&
            gates.meetEnergyOk &&
            gates.speechStarted &&
            gates.responseSeen &&
            (requireTool ? gates.expectedToolCalled : gates.outputRouted),
          gates,
          compact,
        };
      },
      timeoutMs,
      1500,
    );
    if (hostAdmissionActor?.enabled) {
      hostAdmission.final = await hostAdmissionActor.stop("synthetic_speaker_gate_passed");
      hostAdmissionActor = null;
    }
    const result = {
      ok: true,
      acceptanceSatisfied: true,
      meetUrl,
      meetUrlSource: realMeetUrl.source || "",
      sessionId,
      speakerSessionId,
      wavPath,
      syntheticSpeakerText: currentSyntheticSpeakerText(),
      syntheticSpeakerProfile: profileSummary(speakerProfile),
      mainBotProfile: profileSummary(mainBotProfile),
      expectedToolNames,
      requireTool,
      join,
      botReady,
      hostAdmission,
      final,
    };
    if (emit) await emitJsonResult(result);
    return result;
  } catch (error) {
    failed = true;
    if (hostAdmissionActor?.enabled) {
      hostAdmission = {
        ...(hostAdmission || { summary: hostAdmissionActor.summary || { enabled: true } }),
        final: await hostAdmissionActor
          .stop("synthetic_speaker_gate_failed")
          .catch((stopError) => ({
            enabled: true,
            ok: false,
            status: "stop_failed",
            error: String(stopError?.message || stopError),
          })),
      };
      hostAdmissionActor = null;
    }
    const result = {
      ok: false,
      acceptanceSatisfied: false,
      meetUrl,
      sessionId,
      speakerSessionId,
      syntheticSpeakerProfile: profileSummary(speakerProfile),
      mainBotProfile: profileSummary(mainBotProfile),
      tmpDir,
      speakerDataDir,
      error: String(error?.message || error),
      failure: classifySyntheticSpeakerFailure({
        error,
        mainBotProfile,
        speakerProfile,
        botReady,
      }),
      hostAdmission,
      last: error?.last || null,
      botReady,
    };
    if (emit) await emitJsonResult(result, { error: true });
    if (setExitCode) process.exitCode = 1;
    return result;
  } finally {
    await postJson(`${meetingAgentUrl}/join/stop`, {
      reason: "real_meet_synthetic_speaker_smoke_done",
    }).catch(() => {});
    speaker?.kill("SIGTERM");
    if (hostAdmissionActor?.enabled) {
      await hostAdmissionActor.stop("synthetic_speaker_smoke_cleanup").catch(() => {});
    }
    if (failed || envFlag("MAB_KEEP_TMP")) {
      console.error(`[real-meet-synthetic-speaker] preserved tmpDir=${tmpDir}`);
    } else {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function runLocalFixtureMain(options = {}) {
  const print = options.print !== false;
  const meetingAgentUrl = (process.env.MAB_MEETING_AGENT_URL || "http://127.0.0.1:8781").replace(
    /\/+$/,
    "",
  );
  const timeoutMs = envMs("MAB_REALTIME_SYNTHETIC_SPEECH_WAIT_MS", 90_000);
  const expectedToolNames = envCsv("MAB_REALTIME_SYNTHETIC_EXPECTED_TOOLS");
  const requireTool =
    process.env.MAB_REALTIME_SYNTHETIC_REQUIRE_TOOL === "1" || expectedToolNames.length > 0;
  const textTurnFallbackEnabled =
    requireTool && envFlag("MAB_REALTIME_SYNTHETIC_TEXT_TURN_FALLBACK");
  const tmpDir = await mkdtemp(pathJoin(tmpdir(), "oneesama-realtime-speech-"));
  const wavPath = await generateSpeakerWav(tmpDir);
  const fixture = await startLocalMeetFixtureServer({ participantAudioFile: wavPath });
  const speechStartDelayMs = envMs("MAB_REALTIME_SYNTHETIC_SPEECH_START_DELAY_MS", 35000);
  const fixtureParams = new URLSearchParams({
    participantSpeech: "1",
    participantSpeechStartDelayMs: String(speechStartDelayMs),
  });
  if (envFlag("MAB_REALTIME_SYNTHETIC_SPEECH_LOOP")) {
    fixtureParams.set("participantSpeechLoop", "1");
  }
  const fixtureUrl = `${fixture.url}?${fixtureParams.toString()}`;
  const sessionId =
    process.env.MAB_REALTIME_SYNTHETIC_SESSION_ID || `realtime_speech_${Date.now()}`;
  const realtimeSessionOverride = envFlag("MAB_REALTIME_SYNTHETIC_DISABLE_AUTO_RESPONSE")
    ? {
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              create_response: false,
              interrupt_response: false,
            },
          },
        },
      }
    : null;
  let textTurnFallback = null;
  let syntheticTranscriptInjected = null;
  try {
    await postJson(`${meetingAgentUrl}/join/stop`, {
      reason: "synthetic_speech_smoke_preflight",
    }).catch(() => {});
    const join = await postJson(`${meetingAgentUrl}/join/google-meet`, {
      sessionId,
      session_id: sessionId,
      meetUrl: fixtureUrl,
      meeting_url: fixtureUrl,
      botName: process.env.MAB_REAL_MEET_BOT_NAME || "Onee Sama Synthetic Speech",
      display_name: process.env.MAB_REAL_MEET_BOT_NAME || "Onee Sama Synthetic Speech",
      dryRun: false,
      dry_run: false,
      allowNonGoogleMeet: true,
      allow_non_google_meet: true,
      meetUIInteractionMode: "synthetic",
      meet_ui_interaction_mode: "synthetic",
      collectFixtureState: true,
      collect_fixture_state: true,
      disableLive2D: process.env.MAB_REAL_MEET_DISABLE_LIVE2D !== "0",
      installWorkerResultBridge: true,
      install_worker_result_bridge: true,
      installRealtimeBridge: true,
      install_realtime_bridge: true,
      realtimeBridgeMode: process.env.MAB_REAL_MEET_REALTIME_MODE || "agents-sdk",
      realtime_bridge_mode: process.env.MAB_REAL_MEET_REALTIME_MODE || "agents-sdk",
      autoConnectRealtime: true,
      auto_connect_realtime: true,
      sendRealtimeSessionUpdate: true,
      send_realtime_session_update: true,
      realtimeSession: realtimeSessionOverride || undefined,
      realtime_session: realtimeSessionOverride || undefined,
      includeParticipantAudio: true,
      include_participant_audio: true,
      forwardMeetAudioToRealtime: true,
      forward_meet_audio_to_realtime: true,
      meetAudioInputGain: 1,
      meet_audio_input_gain: 1,
      dryRunLocalTools: envFlag("MAB_REALTIME_SYNTHETIC_DRY_RUN_LOCAL_TOOLS"),
      dry_run_local_tools: envFlag("MAB_REALTIME_SYNTHETIC_DRY_RUN_LOCAL_TOOLS"),
      captureCaptions: false,
      capture_captions: false,
    });
    const final = await waitFor(
      "local fixture synthetic speech gate",
      async () => {
        const status = await fetchJson(joinStatusUrl(meetingAgentUrl, sessionId));
        const compact = compactBridgeStatus(status);
        const gates = gateStatus(compact, {
          expectedToolNames,
          allowDiagnosticInputSources: true,
        });
        const syntheticTranscript = String(
          process.env.MAB_REALTIME_SYNTHETIC_TRANSCRIPT_TEXT || "",
        ).trim();
        if (
          syntheticTranscript &&
          !syntheticTranscriptInjected &&
          (compact.bridgeConnected || compact.dataChannelOpen)
        ) {
          syntheticTranscriptInjected = await postJson(`${meetingAgentUrl}/realtime/event`, {
            event: {
              type: "conversation.item.input_audio_transcription.completed",
              item_id: `synthetic_transcript_${Date.now()}`,
              transcript: syntheticTranscript,
            },
          }).catch((error) => ({
            ok: false,
            error: String(error?.message || error),
            body: error?.body || null,
          }));
        }
        if (
          textTurnFallbackEnabled &&
          !textTurnFallback &&
          gates.meetEnergyOk &&
          gates.speechStarted &&
          gates.responseSeen &&
          !gates.expectedToolCalled
        ) {
          textTurnFallback = await postJson(`${meetingAgentUrl}/realtime/text-turn`, {
            session_id: sessionId,
            text: currentSyntheticSpeakerText(),
            instructions: localFixtureToolShareTextTurnInstructions(expectedToolNames),
          }).catch((error) => ({
            ok: false,
            error: String(error?.message || error),
            body: error?.body || null,
          }));
        }
        return {
          done:
            gates.meetEnergyOk &&
            gates.speechStarted &&
            gates.responseSeen &&
            (requireTool
              ? gates.expectedToolCalled || Boolean(textTurnFallback)
              : gates.outputRouted),
          gates,
          compact,
          textTurnFallback,
          syntheticTranscriptInjected,
        };
      },
      timeoutMs,
      1500,
    );
    const acceptanceSatisfied = requireTool
      ? !textTurnFallback && final.gates?.expectedToolCalled === true
      : true;
    const result = {
      ok: acceptanceSatisfied,
      acceptanceSatisfied,
      fixtureUrl,
      sessionId,
      wavPath,
      syntheticSpeakerText: currentSyntheticSpeakerText(),
      expectedToolNames,
      requireTool,
      textTurnFallback,
      syntheticTranscriptInjected,
      join,
      final,
    };
    if (typeof options.afterGate === "function") {
      const extra = await options.afterGate({
        meetingAgentUrl,
        sessionId,
        result,
        final,
      });
      if (extra && typeof extra === "object") {
        Object.assign(result, extra);
      }
    }
    if (print) console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const result = {
      ok: false,
      fixtureUrl,
      sessionId,
      error: String(error?.message || error),
      last: error?.last || null,
      textTurnFallback,
    };
    if (print) console.error(JSON.stringify(result, null, 2));
    if (print) process.exitCode = 1;
    return result;
  } finally {
    await postJson(`${meetingAgentUrl}/join/stop`, {
      reason: "realtime_synthetic_speech_smoke_done",
    }).catch(() => {});
    await fixture.close().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runLocalFixtureToolShareSmokeMain() {
  applyLocalFixtureToolShareSmokeDefaults();
  const cliTimeoutMs = argValue("--timeout-ms");
  if (cliTimeoutMs) {
    process.env.MAB_REALTIME_SYNTHETIC_SPEECH_WAIT_MS = cliTimeoutMs;
  }
  const iterations = envOrArgInt("MAB_REALTIME_SYNTHETIC_ITERATIONS", "--iterations", 3);
  const originalSessionId = process.env.MAB_REALTIME_SYNTHETIC_SESSION_ID || "";
  const results = [];
  try {
    for (let index = 0; index < iterations; index += 1) {
      if (originalSessionId) {
        process.env.MAB_REALTIME_SYNTHETIC_SESSION_ID = `${originalSessionId}_${index + 1}`;
      } else {
        delete process.env.MAB_REALTIME_SYNTHETIC_SESSION_ID;
      }
      const result = await runLocalFixtureMain({ print: false });
      results.push(
        compactSyntheticResult(result, {
          syntheticSpeakerText: currentSyntheticSpeakerText(),
          expectedToolNames: envCsv("MAB_REALTIME_SYNTHETIC_EXPECTED_TOOLS"),
        }),
      );
      if (!result?.ok) break;
    }
  } finally {
    if (originalSessionId) {
      process.env.MAB_REALTIME_SYNTHETIC_SESSION_ID = originalSessionId;
    } else {
      delete process.env.MAB_REALTIME_SYNTHETIC_SESSION_ID;
    }
  }
  const passed = results.filter((result) => result.acceptanceSatisfied).length;
  const summary = {
    ok: passed === iterations,
    iterations,
    passed,
    failed: iterations - passed,
    results,
  };
  const output = JSON.stringify(summary, null, 2);
  console.log(output);
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

function syntheticSuiteCaseFilter() {
  return String(argValue("--cases") || process.env.MAB_REALTIME_SYNTHETIC_CASES || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function syntheticSuiteCaseTimeoutMs(testCase, cliTimeoutMs) {
  if (cliTimeoutMs && !testCase.timeoutMs) return String(cliTimeoutMs);
  if (testCase.timeoutMs) return String(testCase.timeoutMs);
  return "";
}

function syntheticSuiteProgress(event, fields = {}) {
  const payload = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.error(`[synthetic-audio-suite] ${event}${payload ? ` ${payload}` : ""}`);
}

async function withEnvOverrides(overrides, fn) {
  const keys = Object.keys(overrides);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null || value === "") {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runLocalFixtureSyntheticAudioSuiteMain() {
  const selectedCaseIds = syntheticSuiteCaseFilter();
  const selectedCaseIdSet = new Set(selectedCaseIds);
  const allCases = localFixtureSyntheticAudioSuiteCases();
  const cases =
    selectedCaseIdSet.size > 0
      ? allCases.filter((testCase) => selectedCaseIdSet.has(testCase.id))
      : allCases;
  if (cases.length === 0) {
    throw new Error(`No synthetic audio suite cases matched: ${selectedCaseIds.join(",")}`);
  }
  const cliTimeoutMs = argValue("--timeout-ms");
  const originalSessionId = process.env.MAB_REALTIME_SYNTHETIC_SESSION_ID || "";
  const results = [];
  syntheticSuiteProgress("start", {
    cases: cases.map((testCase) => testCase.id).join(","),
    count: cases.length,
  });
  for (const testCase of cases) {
    const caseStarted = Date.now();
    const env = envForLocalFixtureSyntheticAudioSuiteCase(testCase);
    env.MAB_REALTIME_SYNTHETIC_SESSION_ID = originalSessionId
      ? `${originalSessionId}_${testCase.id}`
      : `synthetic_audio_${testCase.id}_${Date.now()}`;
    const caseTimeoutMs = syntheticSuiteCaseTimeoutMs(testCase, cliTimeoutMs);
    if (caseTimeoutMs) {
      env.MAB_REALTIME_SYNTHETIC_SPEECH_WAIT_MS = caseTimeoutMs;
    }
    syntheticSuiteProgress("case-start", {
      id: testCase.id,
      category: testCase.category,
      timeoutMs: caseTimeoutMs,
      workerTimeoutMs: testCase.workerTimeoutMs || "",
      primary: testCase.primaryAcceptance === true ? "true" : "false",
    });
    const result = await withEnvOverrides(
      env,
      async () =>
        await runLocalFixtureMain({
          print: false,
          afterGate: testCase.primaryAcceptance
            ? async ({ meetingAgentUrl, result: fixtureResult }) => {
                const summary = compactSyntheticResult(fixtureResult, {
                  syntheticSpeakerText: testCase.text,
                  expectedToolNames: testCase.expectedToolNames || [],
                });
                return await completeGomokuPrimaryAcceptance({
                  meetingAgentUrl,
                  summary,
                  timeoutMs: testCase.workerTimeoutMs || 600000,
                });
              }
            : undefined,
        }),
    );
    const compact = compactSyntheticResult(result, {
      syntheticSpeakerText: testCase.text,
      expectedToolNames: testCase.expectedToolNames || [],
    });
    const evaluation = evaluateSyntheticAudioSuiteCase(compact, testCase);
    results.push({
      id: testCase.id,
      category: testCase.category,
      description: testCase.description,
      ok: evaluation.ok,
      evaluation,
      result: compact,
    });
    syntheticSuiteProgress(evaluation.ok ? "case-pass" : "case-fail", {
      id: testCase.id,
      elapsedMs: Date.now() - caseStarted,
      tools: (compact.toolCalls?.all || []).join(","),
      missing: evaluation.missingRequiredToolNames.join(","),
      forbidden: evaluation.forbiddenToolNamesCalled.join(","),
    });
  }
  const failed = results.filter((result) => !result.ok);
  const categories = [...new Set(results.map((result) => result.category).filter(Boolean))];
  const summary = {
    ok: failed.length === 0,
    caseCount: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    categories,
    results,
  };
  await emitJsonResult(summary, { error: !summary.ok });
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

async function main() {
  if (process.argv.includes("--speaker-worker")) {
    await runSpeakerWorker();
  } else if (process.argv.includes("--local-fixture")) {
    await runLocalFixtureMain();
  } else if (process.argv.includes("--local-fixture-tool-share-smoke")) {
    await runLocalFixtureToolShareSmokeMain();
  } else if (process.argv.includes("--local-fixture-synthetic-audio-suite")) {
    await runLocalFixtureSyntheticAudioSuiteMain();
  } else if (process.argv.includes("--real-meet-app-control-suite")) {
    await runRealMeetAppControlSuiteMain();
  } else if (process.argv.includes("--real-meet-app-control-smoke")) {
    await runRealMeetAppControlSmokeMain();
  } else {
    await runMain();
  }
}

if (process.argv[1] && pathResolve(process.argv[1]) === SELF) {
  await main();
}
