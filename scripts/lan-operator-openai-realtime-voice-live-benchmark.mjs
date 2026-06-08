#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { chromium } from "playwright";

import {
  createOpenAIRealtimeConversationEngine,
  createOpenAIRealtimeWebSocketTransport,
} from "../packages/core/src/operator/lan-operator-openai-realtime-adapter.ts";
import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";
import { buildRealtimeSessionConfig } from "../packages/core/src/realtime/realtime-contract.ts";
import { attachLanAcceptanceSlo } from "./lan-operator-acceptance-slo.mjs";
import {
  attachOpenAIRealtimeFailureDiagnostics,
  sanitizeOpenAIProviderText,
} from "./lan-operator-openai-live-diagnostics.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_JSON_OUT = "/tmp/oneesama-realtime-local-openai-voice-live-latest.json";
const DEFAULT_MODEL = "gpt-realtime-2";
const DEFAULT_TRANSCRIPT_MODEL = "whisper-1";
const DEFAULT_PHRASE =
  "LAN operator realtime voice acceptance. Please reply with exactly these three words: voice live ok.";
const TARGET_SAMPLE_RATE = 24000;

function defaultApiKey() {
  if (process.env.ONEESAMA_OPENAI_API_KEY) {
    return { value: process.env.ONEESAMA_OPENAI_API_KEY, source: "ONEESAMA_OPENAI_API_KEY" };
  }
  if (process.env.MAB_OPENAI_API_KEY) {
    return { value: process.env.MAB_OPENAI_API_KEY, source: "MAB_OPENAI_API_KEY" };
  }
  if (process.env.OPENAI_API_KEY) {
    return { value: process.env.OPENAI_API_KEY, source: "OPENAI_API_KEY" };
  }
  return { value: "", source: "" };
}

function defaultModel() {
  return (
    process.env.MAB_LAN_OPENAI_REALTIME_MODEL ||
    process.env.MAB_OPENAI_REALTIME_MODEL ||
    process.env.OPENAI_REALTIME_MODEL ||
    DEFAULT_MODEL
  );
}

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 0,
    timeoutMs: 45_000,
    connectTimeoutMs: 10_000,
    drainMs: 250,
    jsonOut: DEFAULT_JSON_OUT,
    headed: false,
    optional: false,
    model: defaultModel(),
    transcriptModel: process.env.MAB_OPENAI_REALTIME_TRANSCRIPT_MODEL || DEFAULT_TRANSCRIPT_MODEL,
    url: process.env.MAB_LAN_OPENAI_REALTIME_URL || process.env.MAB_OPENAI_REALTIME_URL || "",
    audioFile: process.env.MAB_LAN_OPENAI_REALTIME_VOICE_WAV || "",
    phrase: DEFAULT_PHRASE,
    chunkMs: 20,
    chunkDelayMs: 20,
    trailingSilenceMs: 1200,
    minVoiceChunks: 12,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--connect-timeout-ms") args.connectTimeoutMs = Number(argv[++index]);
    else if (arg === "--drain-ms") args.drainMs = Number(argv[++index]);
    else if (arg === "--json-out") args.jsonOut = argv[++index];
    else if (arg === "--model") args.model = argv[++index];
    else if (arg === "--transcript-model") args.transcriptModel = argv[++index];
    else if (arg === "--url") args.url = argv[++index];
    else if (arg === "--audio-file") args.audioFile = argv[++index];
    else if (arg === "--phrase") args.phrase = argv[++index];
    else if (arg === "--chunk-ms") args.chunkMs = Number(argv[++index]);
    else if (arg === "--chunk-delay-ms") args.chunkDelayMs = Number(argv[++index]);
    else if (arg === "--trailing-silence-ms") args.trailingSilenceMs = Number(argv[++index]);
    else if (arg === "--min-voice-chunks") args.minVoiceChunks = Number(argv[++index]);
    else if (arg === "--headed") args.headed = true;
    else if (arg === "--optional") args.optional = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.chunkMs) || args.chunkMs <= 0) {
    throw new Error("--chunk-ms must be positive");
  }
  if (!Number.isFinite(args.chunkDelayMs) || args.chunkDelayMs < 0) {
    throw new Error("--chunk-delay-ms must be >= 0");
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/lan-operator-openai-realtime-voice-live-benchmark.mjs [options]

Options:
  --host <host>                Bind host (default: 127.0.0.1)
  --port <port>                Bind port, 0 means random (default: 0)
  --timeout-ms <n>             Live voice gate timeout (default: 45000)
  --connect-timeout-ms <n>     OpenAI Realtime WebSocket connect timeout (default: 10000)
  --drain-ms <n>               Provider event drain window after each audio chunk (default: 250)
  --model <model>              Realtime model (default: ${DEFAULT_MODEL} or env)
  --transcript-model <model>   Input audio transcription model (default: ${DEFAULT_TRANSCRIPT_MODEL})
  --url <wss-url>              Override Realtime WebSocket URL
  --audio-file <wav>           Replay a PCM16 WAV fixture instead of generated macOS speech
  --phrase <text>              Phrase for generated macOS speech
  --chunk-ms <n>               PCM chunk duration (default: 20)
  --chunk-delay-ms <n>         Delay between chunk sends (default: 20)
  --trailing-silence-ms <n>    Silence appended after speech for provider VAD (default: 1200)
  --json-out <path>            Write structured report (default: ${DEFAULT_JSON_OUT})
  --headed                     Run Chromium headed
  --optional                   Exit 0 only when skipped because no OpenAI key is present
`);
}

function sanitizeProviderText(value) {
  return sanitizeOpenAIProviderText(value);
}

function providerCountsFrom(debug, debugReport) {
  return (
    debugReport?.summaries?.conversationPort?.providerEventCounts ||
    debug?.conversation?.provider?.providerEventCounts ||
    {}
  );
}

function canonicalCountsFrom(debug, debugReport) {
  return (
    debugReport?.summaries?.conversationPort?.canonicalEventCounts ||
    debug?.conversation?.eventCounts ||
    {}
  );
}

function providerEventTotal(providerEventCounts) {
  return Object.values(providerEventCounts || {}).reduce(
    (total, value) => total + Number(value || 0),
    0,
  );
}

function providerAudioInputEventCount(providerEventCounts) {
  return [
    "input_audio_buffer.speech_started",
    "input_audio_buffer.speech_stopped",
    "input_audio_buffer.committed",
    "conversation.item.input_audio_transcription.delta",
    "conversation.item.input_audio_transcription.completed",
  ].reduce((total, key) => total + Number(providerEventCounts?.[key] || 0), 0);
}

function providerTextEventCount(providerEventCounts) {
  return [
    "response.output_text.delta",
    "response.output_text.done",
    "response.text.delta",
    "response.text.done",
    "response.output_audio_transcript.delta",
    "response.output_audio_transcript.done",
  ].reduce((total, key) => total + Number(providerEventCounts?.[key] || 0), 0);
}

function timeoutSummary(body) {
  const conversation = body?.debug?.conversation || {};
  const providerEventCounts = conversation.provider?.providerEventCounts || {};
  return {
    ok: body?.ok === true,
    health: body?.snapshot?.health || "",
    conversationStatus: conversation.status || "",
    engineId: conversation.engineId || "",
    providerAdapterKind: conversation.provider?.adapterKind || "",
    providerEventCounts,
    providerAudioInputEventCount: providerAudioInputEventCount(providerEventCounts),
    canonicalEventCounts: conversation.eventCounts || {},
    voice: {
      chunksReceived: body?.debug?.voice?.chunksReceived || 0,
      forwardedChunks: body?.debug?.voice?.forwardedChunks || 0,
      forwardFailures: body?.debug?.voice?.forwardFailures || 0,
    },
    errors: (conversation.errors || []).slice(-4).map((entry) => ({
      ts: entry?.ts || "",
      error: sanitizeProviderText(entry?.error || ""),
    })),
  };
}

async function waitForRuntimeStatus(url, predicate, timeoutMs, failPredicate = null) {
  const statusUrl = new URL("/runtime/status", url);
  const started = Date.now();
  let lastBody = null;
  while (Date.now() - started < timeoutMs) {
    const body = await (await fetch(statusUrl)).json();
    lastBody = body;
    if (predicate(body)) return body;
    if (failPredicate?.(body)) {
      throw new Error(`runtime_status_failed:${JSON.stringify(timeoutSummary(body))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`runtime_status_timeout:${JSON.stringify(timeoutSummary(lastBody))}`);
}

async function fetchDebugReport(url) {
  const body = await (await fetch(new URL("/runtime/report", url))).json();
  return body.report || body;
}

function readAscii(buffer, offset, length) {
  return buffer.toString("ascii", offset, offset + length);
}

function parsePcm16Wav(buffer) {
  if (readAscii(buffer, 0, 4) !== "RIFF" || readAscii(buffer, 8, 4) !== "WAVE") {
    throw new Error("voice_fixture_not_wav");
  }
  let fmt = null;
  let data = null;
  for (let offset = 12; offset + 8 <= buffer.length; ) {
    const id = readAscii(buffer, offset, 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) break;
    if (id === "fmt ") {
      fmt = {
        format: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    }
    if (id === "data") data = buffer.subarray(start, end);
    offset = end + (size % 2);
  }
  if (!fmt || !data) throw new Error("voice_fixture_missing_fmt_or_data");
  if (fmt.format !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(
      `voice_fixture_must_be_pcm16_wav:format=${fmt.format}:bits=${fmt.bitsPerSample}`,
    );
  }
  return { ...fmt, pcm: data };
}

function downmixPcm16ToMono(pcm, channels) {
  if (channels === 1) return pcm;
  const frameCount = Math.floor(pcm.length / (channels * 2));
  const output = Buffer.alloc(frameCount * 2);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += pcm.readInt16LE((frame * channels + channel) * 2);
    }
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / channels))), frame * 2);
  }
  return output;
}

function resamplePcm16Mono(pcm, inputRate, targetRate) {
  if (inputRate === targetRate) return pcm;
  const inputFrames = Math.floor(pcm.length / 2);
  const outputFrames = Math.max(1, Math.round((inputFrames * targetRate) / inputRate));
  const output = Buffer.alloc(outputFrames * 2);
  for (let index = 0; index < outputFrames; index += 1) {
    const sourceIndex = (index * inputRate) / targetRate;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(inputFrames - 1, leftIndex + 1);
    const fraction = sourceIndex - leftIndex;
    const left = pcm.readInt16LE(Math.min(inputFrames - 1, leftIndex) * 2);
    const right = pcm.readInt16LE(rightIndex * 2);
    output.writeInt16LE(Math.round(left + (right - left) * fraction), index * 2);
  }
  return output;
}

function chunkEnergy(chunk) {
  const frameCount = Math.floor(chunk.length / 2);
  if (frameCount <= 0) return 0;
  let sum = 0;
  for (let index = 0; index < frameCount; index += 1) {
    const sample = chunk.readInt16LE(index * 2) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / frameCount);
}

function buildPcmChunks(pcm, input) {
  const framesPerChunk = Math.max(1, Math.round((TARGET_SAMPLE_RATE * input.chunkMs) / 1000));
  const bytesPerChunk = framesPerChunk * 2;
  const chunks = [];
  let sequence = 1;
  for (let offset = 0; offset < pcm.length; offset += bytesPerChunk) {
    const chunk = pcm.subarray(offset, Math.min(pcm.length, offset + bytesPerChunk));
    if (chunk.length === 0) continue;
    chunks.push({
      sequence,
      sampleRate: TARGET_SAMPLE_RATE,
      channels: 1,
      durationMs: (Math.floor(chunk.length / 2) / TARGET_SAMPLE_RATE) * 1000,
      energy: chunkEnergy(chunk),
      dataBase64: chunk.toString("base64"),
    });
    sequence += 1;
  }
  const silenceChunks = Math.max(
    0,
    Math.ceil(Number(input.trailingSilenceMs || 0) / input.chunkMs),
  );
  const silence = Buffer.alloc(bytesPerChunk);
  for (let index = 0; index < silenceChunks; index += 1) {
    chunks.push({
      sequence,
      sampleRate: TARGET_SAMPLE_RATE,
      channels: 1,
      durationMs: input.chunkMs,
      energy: 0,
      dataBase64: silence.toString("base64"),
    });
    sequence += 1;
  }
  return chunks;
}

async function generateSpeechWav(args) {
  const dir = await mkdtemp(join(tmpdir(), "oneesama-openai-voice-live-"));
  const path = join(dir, "voice-live.wav");
  try {
    await execFileAsync("/usr/bin/say", ["-o", path, "--data-format=LEI16@24000", args.phrase]);
    return { path, cleanupDir: dir, mode: "macos_say" };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`voice_fixture_generation_failed:${String(error?.message || error)}`, {
      cause: error,
    });
  }
}

async function loadVoiceFixture(args) {
  let generated = null;
  let wavPath = args.audioFile;
  if (!wavPath) {
    generated = await generateSpeechWav(args);
    wavPath = generated.path;
  }
  try {
    const wav = parsePcm16Wav(await readFile(wavPath));
    const mono = downmixPcm16ToMono(wav.pcm, wav.channels);
    const pcm = resamplePcm16Mono(mono, wav.sampleRate, TARGET_SAMPLE_RATE);
    const chunks = buildPcmChunks(pcm, args);
    const speechChunks = chunks.filter((chunk) => chunk.energy > 0.001).length;
    return {
      chunks,
      fixture: {
        mode: generated?.mode || "wav_file",
        path: args.audioFile ? wavPath : "",
        generatedPath: generated?.path || "",
        inputSampleRate: wav.sampleRate,
        sampleRate: TARGET_SAMPLE_RATE,
        inputChannels: wav.channels,
        channels: 1,
        chunkMs: args.chunkMs,
        chunkCount: chunks.length,
        speechChunkCount: speechChunks,
        durationMs: Math.round((pcm.length / 2 / TARGET_SAMPLE_RATE) * 1000),
        trailingSilenceMs: args.trailingSilenceMs,
      },
      cleanupDir: generated?.cleanupDir || "",
    };
  } catch (error) {
    if (generated?.cleanupDir)
      await rm(generated.cleanupDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function sendVoiceChunks(page, chunks, chunkDelayMs) {
  return await page.evaluate(
    async ({ voiceChunks, delayMs }) => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let sent = 0;
      for (const chunk of voiceChunks) {
        const ok = window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({
          ...chunk,
          source: "operator_voice_live_fixture_pcm16",
        });
        if (!ok) throw new Error(`operator_voice_live_fixture_send_failed:${chunk.sequence}`);
        sent += 1;
        if (delayMs > 0) await delay(delayMs);
      }
      return {
        sent,
        voiceChunksSent: window.MAB_LAN_OPERATOR_SURFACE.state.voiceChunksSent,
        voice: window.MAB_LAN_OPERATOR_SURFACE.state.voice,
      };
    },
    { voiceChunks: chunks, delayMs: chunkDelayMs },
  );
}

function countFrom(status, path) {
  let current = status;
  for (const key of path) current = current?.[key];
  return Number(current || 0);
}

function buildAcceptanceReport(input) {
  const {
    args,
    listenResult,
    runtimeStatus,
    baselineStatus,
    debugReport,
    clientState,
    fixture,
    startedAt,
    readyMs,
    connectedMs,
    completedMs,
    apiKeySource,
  } = input;
  const debug = runtimeStatus?.debug || {};
  const voice = debug.voice || {};
  const conversation = debug.conversation || {};
  const output = debug.output || {};
  const providerEventCounts = providerCountsFrom(debug, debugReport);
  const canonicalEventCounts = canonicalCountsFrom(debug, debugReport);
  const rawProviderEventsAvailable =
    debugReport?.summaries?.conversationPort?.rawEventDrilldownAvailable === true ||
    conversation.provider?.rawEventDrilldownAvailable === true;
  const providerAdapterKind =
    debugReport?.summaries?.conversationPort?.providerAdapterKind ||
    conversation.provider?.adapterKind ||
    "";
  const failedRows = (debugReport?.timeline || debug.timeline?.rows || []).filter(
    (row) => row.ok === false,
  );
  const chunksReceivedDelta = Math.max(
    0,
    Number(voice.chunksReceived || 0) -
      countFrom(baselineStatus, ["debug", "voice", "chunksReceived"]),
  );
  const forwardedChunksDelta = Math.max(
    0,
    Number(voice.forwardedChunks || 0) -
      countFrom(baselineStatus, ["debug", "voice", "forwardedChunks"]),
  );
  const assistantTranscript =
    debugReport?.summaries?.conversationTurn?.assistantTranscript ||
    output.assistantText?.completedText ||
    output.assistantText?.currentText ||
    "";
  const ok =
    runtimeStatus?.ok === true &&
    providerAdapterKind === "openai_realtime" &&
    conversation.engineId === "openai_realtime" &&
    conversation.status === "connected" &&
    chunksReceivedDelta >= args.minVoiceChunks &&
    forwardedChunksDelta >= args.minVoiceChunks &&
    voice.forwardFailures === 0 &&
    Number(providerEventCounts["session.created"] || 0) >= 1 &&
    Number(providerEventCounts["input_audio_buffer.speech_started"] || 0) >= 1 &&
    providerAudioInputEventCount(providerEventCounts) >= 2 &&
    rawProviderEventsAvailable &&
    Number(canonicalEventCounts.engine_connected || 0) >= 1 &&
    Number(canonicalEventCounts.speech_started || 0) >= 1 &&
    Number(canonicalEventCounts.transcript_completed || 0) >= 1 &&
    Number(canonicalEventCounts.assistant_text_completed || 0) >= 1 &&
    failedRows.length === 0;

  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "local_openai_realtime_voice_live",
    ok,
    functionalOk: ok,
    diagnosticOnly: false,
    skipped: false,
    acceptanceSatisfied: ok,
    generatedAt: new Date().toISOString(),
    host: {
      url: listenResult?.url || "",
      lanAddress: listenResult?.host || "",
      trustedLanOperatorMode: true,
      lanModeExplicitlyEnabled: true,
    },
    operatorSurface: {
      id: runtimeStatus?.snapshot?.sessionId || "",
      userAgent: clientState?.userAgent || "",
      readyMs,
      connectedMs,
      completedMs,
      voiceChunksSent: clientState?.sendResult?.sent || 0,
    },
    conversationEngine: {
      kind: "openai_realtime",
      transport: "openai_realtime",
      engineId: conversation.engineId || "",
      sessionId: runtimeStatus?.snapshot?.sessionId || "",
      status: conversation.status || "",
      connected: conversation.status === "connected",
      providerAdapterKind,
      providerEventCounts,
      providerEventTotal: providerEventTotal(providerEventCounts),
      providerAudioInputEventCount: providerAudioInputEventCount(providerEventCounts),
      providerTextEventCount: providerTextEventCount(providerEventCounts),
      rawProviderEventsAvailable,
      latestProviderEventType:
        debugReport?.summaries?.conversationPort?.latestProviderEventType ||
        conversation.provider?.latestProviderEventType ||
        "",
      recentProviderEvents:
        debugReport?.summaries?.conversationPort?.recentProviderEvents ||
        conversation.provider?.recentEvents ||
        [],
      canonicalEventCounts,
      latestCanonicalEvent:
        debugReport?.summaries?.conversationPort?.latestCanonicalEvent ||
        conversation.canonicalEvents?.at(-1)?.type ||
        "",
      assistantTranscript,
    },
    provider: {
      name: "openai",
      realtimeModel: args.model,
      apiKeySource,
      urlOverridden: Boolean(args.url),
      inputAudioFormat: "pcm16",
      inputAudioTranscriptionModel: args.transcriptModel,
      turnDetection: "server_vad",
      responseCreate: { output_modalities: ["text"] },
      rawPayloadStored: false,
      rawEventSummariesStored: rawProviderEventsAvailable,
    },
    audio: {
      transport: "websocket_pcm",
      captureMode: "fixture_replay_pcm16",
      source: "operator_voice_live_fixture_pcm16",
      turnDetectionOwner: "conversation_engine",
      providerVad: "server_vad",
      sampleRate: voice.sampleRate || fixture.sampleRate,
      channels: voice.channels || fixture.channels,
      chunkDurationMs: voice.durationMs || args.chunkMs,
      chunksSent: clientState?.sendResult?.sent || 0,
      chunksReceived: voice.chunksReceived || 0,
      forwardedChunks: voice.forwardedChunks || 0,
      chunksReceivedDelta,
      forwardedChunksDelta,
      forwardFailures: voice.forwardFailures || 0,
      chunksDropped: voice.forwardBackpressureDrops || 0,
      sequenceGaps: voice.dropsDetected || 0,
      hostReceiveLagMs: voice.lastReceiveLagMs ?? null,
      maxHostReceiveLagMs: voice.maxReceiveLagMs ?? null,
      voiceAckRttMs: clientState?.voice?.lastAckRttMs ?? voice.lastAckRttMs ?? null,
      maxVoiceAckRttMs: clientState?.voice?.maxAckRttMs ?? voice.maxAckRttMs ?? null,
      voiceAckCount: clientState?.voice?.ackCount ?? voice.ackCount ?? 0,
      voiceStreamId: voice.activeStreamId || null,
      voiceStreamGeneration: voice.activeStreamGeneration || 0,
      voiceStreamOpenCount: voice.streamOpenCount || 0,
      staleChunksRejected: voice.staleChunksRejected || 0,
      inputEnergy: voice.lastEnergy || 0,
      speechFixture: fixture,
    },
    timeline: debugReport?.timeline || debug.timeline?.rows || [],
    turns: debugReport?.debug?.timeline?.turns || debug.timeline?.turns || [],
    debugReport,
    timings: {
      totalWallMs: Math.round(performance.now() - startedAt),
      readyMs,
      connectedMs,
      completedMs,
      providerDrainMs: args.drainMs,
    },
    failureRows: failedRows,
    args: {
      timeoutMs: args.timeoutMs,
      connectTimeoutMs: args.connectTimeoutMs,
      drainMs: args.drainMs,
      headed: args.headed,
      optional: args.optional,
      model: args.model,
      transcriptModel: args.transcriptModel,
      urlOverridden: Boolean(args.url),
      audioFileProvided: Boolean(args.audioFile),
      chunkMs: args.chunkMs,
      chunkDelayMs: args.chunkDelayMs,
      trailingSilenceMs: args.trailingSilenceMs,
      minVoiceChunks: args.minVoiceChunks,
    },
  };
}

function skippedReport(args, apiKeySource, reason) {
  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "local_openai_realtime_voice_live",
    ok: false,
    functionalOk: false,
    diagnosticOnly: false,
    skipped: true,
    acceptanceSatisfied: false,
    generatedAt: new Date().toISOString(),
    blocker: reason,
    host: { url: "" },
    operatorSurface: { readyMs: null, connectedMs: null, completedMs: null },
    conversationEngine: {
      kind: "openai_realtime",
      transport: "openai_realtime",
      engineId: "openai_realtime",
      status: "skipped",
      providerAdapterKind: "",
      providerEventCounts: {},
      providerEventTotal: 0,
      providerAudioInputEventCount: 0,
      providerTextEventCount: 0,
      rawProviderEventsAvailable: false,
      canonicalEventCounts: {},
      latestCanonicalEvent: "",
    },
    provider: {
      name: "openai",
      realtimeModel: args.model,
      apiKeySource,
      urlOverridden: Boolean(args.url),
      inputAudioFormat: "pcm16",
      inputAudioTranscriptionModel: args.transcriptModel,
      turnDetection: "server_vad",
      responseCreate: { output_modalities: ["text"] },
      rawPayloadStored: false,
      rawEventSummariesStored: false,
    },
    audio: {
      transport: "websocket_pcm",
      captureMode: "fixture_replay_pcm16",
      turnDetectionOwner: "conversation_engine",
      providerVad: "server_vad",
      chunksSent: 0,
      chunksReceivedDelta: 0,
      forwardedChunksDelta: 0,
    },
    timeline: [],
    turns: [],
    timings: { totalWallMs: 0, readyMs: null, connectedMs: null, completedMs: null },
    args: {
      timeoutMs: args.timeoutMs,
      connectTimeoutMs: args.connectTimeoutMs,
      drainMs: args.drainMs,
      headed: args.headed,
      optional: args.optional,
      model: args.model,
      transcriptModel: args.transcriptModel,
      urlOverridden: Boolean(args.url),
    },
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function runLive(args, apiKey, apiKeySource) {
  const startedAt = performance.now();
  const loadedFixture = await loadVoiceFixture(args);
  const session = buildRealtimeSessionConfig({
    model: args.model,
    outputModalities: ["text"],
    inputAudioTranscription: { model: args.transcriptModel },
    reasoningEffort: "none",
    turnDetection: {
      type: "server_vad",
      threshold: 0.45,
      prefix_padding_ms: 300,
      silence_duration_ms: 600,
      create_response: true,
      interrupt_response: true,
    },
    instructions:
      "You are running Oneesama's LAN Operator Surface live voice acceptance probe. Keep responses short.",
  });
  const conversationEngine = createOpenAIRealtimeConversationEngine({
    transport: createOpenAIRealtimeWebSocketTransport({
      apiKey,
      model: args.model,
      url: args.url || undefined,
      connectTimeoutMs: args.connectTimeoutMs,
      drainMs: args.drainMs,
      session,
      response: {
        output_modalities: ["text"],
      },
    }),
  });
  const surface = createLanOperatorSurfaceServer({
    host: args.host,
    port: args.port,
    sessionId: `lan_openai_voice_live_${Date.now().toString(36)}`,
    botName: "LAN Oneesama",
    conversationTransport: "openai_realtime",
    conversationEngine,
  });
  let browser = null;
  let listenResult = null;
  try {
    listenResult = await surface.listen();
    browser = await chromium.launch({
      headless: !args.headed,
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    });
    const context = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 1366, height: 860 },
    });
    const page = await context.newPage();
    await page.goto(listenResult.url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: args.timeoutMs,
    });
    await waitForRuntimeStatus(
      listenResult.url,
      (body) =>
        body.debug?.transport?.events?.state === "open" &&
        body.debug?.transport?.voice?.state === "open",
      args.timeoutMs,
    );
    const readyMs = Math.round(performance.now() - startedAt);
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.sendEngineControl("connect", {
        reason: "lan_openai_realtime_voice_live_gate",
      }),
    );
    await waitForRuntimeStatus(
      listenResult.url,
      (body) =>
        body.debug?.conversation?.engineId === "openai_realtime" &&
        body.debug?.conversation?.status === "connected" &&
        Number(body.debug?.conversation?.provider?.providerEventCounts?.["session.created"] || 0) >=
          1,
      args.timeoutMs,
      (body) => body.debug?.conversation?.status === "failed",
    );
    const connectedMs = Math.round(performance.now() - startedAt);
    const baselineStatus = await (await fetch(new URL("/runtime/status", listenResult.url))).json();
    const sendResult = await sendVoiceChunks(page, loadedFixture.chunks, args.chunkDelayMs);
    const runtimeStatus = await waitForRuntimeStatus(
      listenResult.url,
      (body) => {
        const providerCounts = body.debug?.conversation?.provider?.providerEventCounts || {};
        const canonicalCounts = body.debug?.conversation?.eventCounts || {};
        const receivedDelta = Math.max(
          0,
          Number(body.debug?.voice?.chunksReceived || 0) -
            countFrom(baselineStatus, ["debug", "voice", "chunksReceived"]),
        );
        const forwardedDelta = Math.max(
          0,
          Number(body.debug?.voice?.forwardedChunks || 0) -
            countFrom(baselineStatus, ["debug", "voice", "forwardedChunks"]),
        );
        return (
          body.debug?.conversation?.engineId === "openai_realtime" &&
          body.debug?.conversation?.status === "connected" &&
          receivedDelta >= args.minVoiceChunks &&
          forwardedDelta >= args.minVoiceChunks &&
          Number(providerCounts["input_audio_buffer.speech_started"] || 0) >= 1 &&
          providerAudioInputEventCount(providerCounts) >= 2 &&
          Number(canonicalCounts.speech_started || 0) >= 1 &&
          Number(canonicalCounts.transcript_completed || 0) >= 1 &&
          Number(canonicalCounts.assistant_text_completed || 0) >= 1
        );
      },
      args.timeoutMs,
      (body) => body.debug?.conversation?.status === "failed",
    );
    const completedMs = Math.round(performance.now() - startedAt);
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.markInterestingRun({
        label: "lan_openai_realtime_voice_live",
        note: "live provider voice evidence gate",
      }),
    );
    const clientState = await page.evaluate(
      (inputSendResult) => ({
        userAgent: navigator.userAgent,
        pageUrl: location.href,
        sendResult: inputSendResult,
        voice: window.MAB_LAN_OPERATOR_SURFACE.state.voice,
      }),
      sendResult,
    );
    const debugReport = await fetchDebugReport(listenResult.url);
    await context.close();
    return buildAcceptanceReport({
      args,
      listenResult,
      runtimeStatus,
      baselineStatus,
      debugReport,
      clientState,
      fixture: loadedFixture.fixture,
      startedAt,
      readyMs,
      connectedMs,
      completedMs,
      apiKeySource,
    });
  } catch (error) {
    const runtimeStatus = surface.status("failed");
    const debugReport = listenResult
      ? await fetchDebugReport(listenResult.url).catch(() => null)
      : null;
    return {
      schema: "oneesama.lan_voice_acceptance.v1",
      gate: "local_openai_realtime_voice_live",
      ok: false,
      functionalOk: false,
      diagnosticOnly: false,
      skipped: false,
      acceptanceSatisfied: false,
      generatedAt: new Date().toISOString(),
      error: sanitizeProviderText(error?.message || error),
      host: { url: listenResult?.url || "" },
      conversationEngine: {
        kind: "openai_realtime",
        transport: "openai_realtime",
        engineId: runtimeStatus?.debug?.conversation?.engineId || "openai_realtime",
        status: runtimeStatus?.debug?.conversation?.status || "failed",
        providerAdapterKind: runtimeStatus?.debug?.conversation?.provider?.adapterKind || "",
        providerEventCounts:
          runtimeStatus?.debug?.conversation?.provider?.providerEventCounts || {},
        providerEventTotal: providerEventTotal(
          runtimeStatus?.debug?.conversation?.provider?.providerEventCounts || {},
        ),
        providerAudioInputEventCount: providerAudioInputEventCount(
          runtimeStatus?.debug?.conversation?.provider?.providerEventCounts || {},
        ),
        providerTextEventCount: providerTextEventCount(
          runtimeStatus?.debug?.conversation?.provider?.providerEventCounts || {},
        ),
        rawProviderEventsAvailable:
          runtimeStatus?.debug?.conversation?.provider?.rawEventDrilldownAvailable === true,
        canonicalEventCounts: runtimeStatus?.debug?.conversation?.eventCounts || {},
        latestCanonicalEvent:
          runtimeStatus?.debug?.conversation?.canonicalEvents?.at(-1)?.type || "",
      },
      provider: {
        name: "openai",
        realtimeModel: args.model,
        apiKeySource,
        urlOverridden: Boolean(args.url),
        inputAudioFormat: "pcm16",
        inputAudioTranscriptionModel: args.transcriptModel,
        turnDetection: "server_vad",
        responseCreate: { output_modalities: ["text"] },
        rawPayloadStored: false,
      },
      audio: {
        transport: "websocket_pcm",
        captureMode: "fixture_replay_pcm16",
        turnDetectionOwner: "conversation_engine",
        providerVad: "server_vad",
        speechFixture: loadedFixture.fixture,
      },
      timeline: debugReport?.timeline || runtimeStatus?.debug?.timeline?.rows || [],
      turns: debugReport?.debug?.timeline?.turns || runtimeStatus?.debug?.timeline?.turns || [],
      debugReport,
      runtimeStatus,
      timings: {
        totalWallMs: Math.round(performance.now() - startedAt),
        providerDrainMs: args.drainMs,
      },
      args: {
        timeoutMs: args.timeoutMs,
        connectTimeoutMs: args.connectTimeoutMs,
        drainMs: args.drainMs,
        headed: args.headed,
        optional: args.optional,
        model: args.model,
        transcriptModel: args.transcriptModel,
        urlOverridden: Boolean(args.url),
      },
    };
  } finally {
    await browser?.close();
    await surface.close();
    if (loadedFixture.cleanupDir) {
      await rm(loadedFixture.cleanupDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { value: apiKey, source: apiKeySource } = defaultApiKey();
  let report = null;
  if (!apiKey) {
    report = skippedReport(args, apiKeySource, "openai_realtime_api_key_missing");
  } else {
    report = await runLive(args, apiKey, apiKeySource);
  }
  report = attachOpenAIRealtimeFailureDiagnostics(attachLanAcceptanceSlo(report));
  await writeJson(args.jsonOut, report);
  const shouldExitZero = report.ok === true || (report.skipped === true && args.optional);
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        functionalOk: report.functionalOk,
        sloOk: report.slo?.ok,
        skipped: report.skipped === true,
        acceptanceSatisfied: report.acceptanceSatisfied === true,
        sloFailures: report.slo?.failures?.map((failure) => failure.id) || [],
        acceptanceBlocker: report.acceptanceBlocker || "",
        providerFailure: report.provider?.failure || null,
        providerEventCounts: report.conversationEngine?.providerEventCounts || {},
        providerAudioInputEventCount: report.conversationEngine?.providerAudioInputEventCount || 0,
        audio: {
          chunksSent: report.audio?.chunksSent || 0,
          chunksReceivedDelta: report.audio?.chunksReceivedDelta || 0,
          forwardedChunksDelta: report.audio?.forwardedChunksDelta || 0,
        },
        jsonOut: args.jsonOut,
        gate: report.gate,
      },
      null,
      2,
    ),
  );
  process.exit(shouldExitZero ? 0 : 1);
}

main().catch(async (error) => {
  const args = parseArgs(process.argv.slice(2));
  const report = attachOpenAIRealtimeFailureDiagnostics(
    attachLanAcceptanceSlo({
      schema: "oneesama.lan_voice_acceptance.v1",
      gate: "local_openai_realtime_voice_live",
      ok: false,
      functionalOk: false,
      diagnosticOnly: false,
      skipped: false,
      acceptanceSatisfied: false,
      generatedAt: new Date().toISOString(),
      error: sanitizeProviderText(error?.message || error),
    }),
  );
  await writeJson(args.jsonOut, report);
  console.error(JSON.stringify({ ok: false, error: report.error, jsonOut: args.jsonOut }, null, 2));
  process.exit(1);
});
