#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import { chromium } from "playwright";

import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";
import { attachLanAcceptanceSlo } from "./lan-operator-acceptance-slo.mjs";

const DEFAULT_JSON_OUT = "/tmp/oneesama-realtime-local-voice-latest.json";

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 0,
    timeoutMs: 10_000,
    jsonOut: DEFAULT_JSON_OUT,
    headed: false,
    localVad: "disabled",
    inputMode: "fake_mic",
    minInputEnergy: null,
    micDeviceId: process.env.MAB_LAN_OPERATOR_MIC_DEVICE_ID || "",
    micLabel: process.env.MAB_LAN_OPERATOR_MIC_LABEL || "",
    surfaceUrl: "",
    surfaceUrlProvided: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--json-out") args.jsonOut = argv[++index];
    else if (arg === "--headed") args.headed = true;
    else if (arg === "--local-vad") args.localVad = String(argv[++index] || "disabled");
    else if (arg === "--real-mic") args.inputMode = "real_mic";
    else if (arg === "--input-mode") args.inputMode = String(argv[++index] || "fake_mic");
    else if (arg === "--min-input-energy") args.minInputEnergy = Number(argv[++index]);
    else if (arg === "--mic-device-id") args.micDeviceId = String(argv[++index] || "");
    else if (arg === "--mic-label") args.micLabel = String(argv[++index] || "");
    else if (arg === "--surface-url" || arg === "--operator-url") {
      args.surfaceUrlProvided = true;
      args.surfaceUrl = argv[++index] || "";
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!["enabled", "disabled"].includes(args.localVad)) {
    throw new Error("--local-vad must be disabled or enabled");
  }
  if (!["fake_mic", "real_mic"].includes(args.inputMode)) {
    throw new Error("--input-mode must be fake_mic or real_mic");
  }
  if (args.minInputEnergy == null) {
    args.minInputEnergy = args.inputMode === "real_mic" ? 0.02 : 0;
  }
  if (!Number.isFinite(args.minInputEnergy) || args.minInputEnergy < 0) {
    throw new Error("--min-input-energy must be a non-negative number");
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/lan-operator-voice-acceptance.mjs [options]

Options:
  --host <host>         Bind host (default: 127.0.0.1)
  --port <port>         Bind port, 0 means random (default: 0)
  --timeout-ms <n>      Acceptance timeout (default: 10000)
  --json-out <path>     Write structured report (default: ${DEFAULT_JSON_OUT})
  --surface-url <url>   Use an already-running Local Operator Surface instead of
                        starting a local server. Use this from the operator
                        computer for true LAN voice evidence.
  --local-vad <mode>    Local VAD telemetry mode: disabled or enabled (default: disabled)
  --real-mic            Use the browser's real microphone device instead of
                        Chromium fake media input.
  --input-mode <mode>   fake_mic or real_mic (default: fake_mic)
  --min-input-energy <n>
                        Minimum observed RMS energy required in real_mic mode
                        (default: 0.02)
  --mic-device-id <id>  Select an exact browser audioinput device id before
                        arming the microphone
  --mic-label <text>    Select the first browser audioinput whose label
                        contains this text. Also available as
                        MAB_LAN_OPERATOR_MIC_LABEL.
  --headed              Run Chromium headed
`);
}

function listenResultFromSurfaceUrl(surfaceUrl) {
  const url = new URL(surfaceUrl);
  return {
    url: url.toString(),
    host: url.hostname,
    external: true,
  };
}

function isLoopbackHost(hostname) {
  const normalized = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.")
  );
}

export function lanOperatorVoiceOperatorPageUrl(surfaceUrl) {
  const url = new URL(surfaceUrl);
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/operator";
  return url.toString();
}

export function lanOperatorVoiceBrowserLaunchArgs(surfaceUrl, options = {}) {
  const inputMode = String(options.inputMode || "fake_mic");
  const launchArgs =
    inputMode === "real_mic"
      ? []
      : ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
  try {
    const url = new URL(surfaceUrl);
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      launchArgs.push(`--unsafely-treat-insecure-origin-as-secure=${url.origin}`);
    }
  } catch {
    // The acceptance path reports invalid URLs. Keep browser defaults here.
  }
  return launchArgs;
}

export function lanOperatorVoiceSelectDevice(devices, options = {}) {
  const micDeviceId = String(options.micDeviceId || "").trim();
  const micLabel = String(options.micLabel || "")
    .trim()
    .toLowerCase();
  const candidates = Array.isArray(devices) ? devices : [];
  if (!micDeviceId && !micLabel) return { requested: false, selected: null };
  const selected =
    (micDeviceId
      ? candidates.find((device) => String(device?.deviceId || "") === micDeviceId)
      : null) ||
    (micLabel
      ? candidates.find((device) =>
          String(device?.label || "")
            .toLowerCase()
            .includes(micLabel),
        )
      : null) ||
    null;
  return {
    requested: true,
    selected,
    requestedDeviceId: micDeviceId,
    requestedLabel: micLabel,
    availableDevices: candidates.map((device) => ({
      deviceId: String(device?.deviceId || ""),
      label: String(device?.label || ""),
      groupId: String(device?.groupId || ""),
    })),
  };
}

export async function configureMicrophoneDevice(page, args) {
  const requestedDeviceId = String(args.micDeviceId || "").trim();
  const requestedLabel = String(args.micLabel || "").trim();
  if (!requestedDeviceId && !requestedLabel && args.inputMode !== "real_mic") {
    return { requested: false, ok: true };
  }
  return page.evaluate(
    async ({ micDeviceId, micLabel }) => {
      const surface = window.MAB_LAN_OPERATOR_SURFACE;
      const devices = await surface.refreshVoiceDevices();
      const targetDeviceId = String(micDeviceId || "").trim();
      const targetLabel = String(micLabel || "")
        .trim()
        .toLowerCase();
      const availableDevices = devices.map((device) => ({
        deviceId: String(device?.deviceId || ""),
        label: String(device?.label || ""),
        groupId: String(device?.groupId || ""),
      }));
      const selected =
        targetDeviceId || targetLabel
          ? (targetDeviceId
              ? availableDevices.find((device) => device.deviceId === targetDeviceId)
              : null) ||
            (targetLabel
              ? availableDevices.find((device) => device.label.toLowerCase().includes(targetLabel))
              : null) ||
            null
          : null;
      const selection = {
        requested: Boolean(targetDeviceId || targetLabel),
        selected,
        requestedDeviceId: targetDeviceId,
        requestedLabel: targetLabel,
        availableDevices,
      };
      if (selection.requested && !selection.selected) {
        return {
          ...selection,
          ok: false,
          blocker: "requested_microphone_device_not_found",
        };
      }
      if (!selection.requested) {
        return {
          ...selection,
          ok: true,
        };
      }
      surface.state.voiceDeviceId = selection.selected.deviceId;
      const select = document.getElementById("voice-device-select");
      if (select) select.value = selection.selected.deviceId;
      surface.markInterestingRun?.({
        label: "real_mic_device_selected",
        note: selection.selected.label || selection.selected.deviceId,
      });
      return {
        ...selection,
        ok: true,
        selectedDeviceId: selection.selected.deviceId,
        selectedLabel: selection.selected.label || "",
      };
    },
    { micDeviceId: requestedDeviceId, micLabel: requestedLabel },
  );
}

async function waitForRuntimeStatus(url, predicate, timeoutMs, onSample = null) {
  const statusUrl = new URL("/runtime/status", url);
  const started = Date.now();
  let lastBody = null;
  while (Date.now() - started < timeoutMs) {
    const body = await (await fetch(statusUrl)).json();
    lastBody = body;
    onSample?.(body);
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runtime_status_timeout: ${JSON.stringify(lastBody)}`);
}

async function fetchDebugReport(url) {
  const body = await (await fetch(new URL("/runtime/report", url))).json();
  return body.report || body;
}

function firstTimelineDuration(timeline, event) {
  const row = timeline.find((entry) => entry.event === event);
  return row?.durationMs ?? null;
}

function firstTurnMilestoneDuration(turns, milestone) {
  for (const turn of Array.isArray(turns) ? turns : []) {
    const rawDuration = turn?.milestoneDurationsMs?.[milestone];
    if (rawDuration != null && rawDuration !== "") {
      const duration = Number(rawDuration);
      if (Number.isFinite(duration)) return duration;
    }
    const at = Date.parse(String(turn?.milestoneAts?.[milestone] || ""));
    const startedAt = Date.parse(String(turn?.startedAt || ""));
    if (Number.isFinite(at) && Number.isFinite(startedAt)) return Math.max(0, at - startedAt);
  }
  return null;
}

function countFrom(status, path) {
  let current = status;
  for (const key of path) current = current?.[key];
  return Number(current || 0);
}

function lanPeerEvidenceFrom(debug, debugReport) {
  return (
    debugReport?.summaries?.surfaceContext?.lanPeerEvidence ||
    debug?.surfaceContext?.lanPeerEvidence ||
    null
  );
}

export function lanOperatorVoiceTimelineSinceBaseline(timeline, baselineStatus) {
  const baselineRows = Array.isArray(baselineStatus?.debug?.timeline?.rows)
    ? baselineStatus.debug.timeline.rows.length
    : 0;
  return Array.isArray(timeline) ? timeline.slice(baselineRows) : [];
}

export function lanOperatorVoiceNormalizeTimelineDurations(timeline) {
  const durations = timeline
    .map((row) => Number(row?.durationMs))
    .filter((duration) => Number.isFinite(duration));
  if (durations.length === 0) return timeline;
  const baselineDuration = Math.min(...durations);
  return timeline.map((row) => {
    const duration = Number(row?.durationMs);
    if (!Number.isFinite(duration)) return row;
    return {
      ...row,
      durationMs: Math.max(0, duration - baselineDuration),
      originalDurationMs: duration,
    };
  });
}

function buildAcceptanceReport(input) {
  const {
    args,
    listenResult,
    baselineStatus,
    runtimeStatus,
    debugReport,
    clientState,
    energyEvidence,
    micDeviceSelection,
    startedAt,
    readyMs,
    completedMs,
  } = input;
  const debug = runtimeStatus?.debug || {};
  const voice = debug.voice || {};
  const conversation = debug.conversation || {};
  const output = debug.output || {};
  const visual = debug.visual || {};
  const localVad = voice.localVad || {};
  const fullTimeline = debugReport?.timeline || debug.timeline?.rows || [];
  const timeline = lanOperatorVoiceNormalizeTimelineDurations(
    lanOperatorVoiceTimelineSinceBaseline(fullTimeline, baselineStatus),
  );
  const turns = debugReport?.debug?.timeline?.turns || debug.timeline?.turns || [];
  const failedRows = timeline.filter((row) => row.ok === false);
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
  const speechStartedDelta = Math.max(
    0,
    Number(conversation.eventCounts?.speech_started || 0) -
      countFrom(baselineStatus, ["debug", "conversation", "eventCounts", "speech_started"]),
  );
  const assistantTextCompletedDelta = Math.max(
    0,
    Number(output.assistantText?.completedCount || 0) -
      countFrom(baselineStatus, ["debug", "output", "assistantText", "completedCount"]),
  );
  const assistantAudioChunksReceivedDelta = Math.max(
    0,
    Number(output.assistantAudio?.chunksReceived || 0) -
      countFrom(baselineStatus, ["debug", "output", "assistantAudio", "chunksReceived"]),
  );
  const assistantAudioChunksPlayedDelta = Math.max(
    0,
    Number(output.assistantAudio?.chunksPlayed || 0) -
      countFrom(baselineStatus, ["debug", "output", "assistantAudio", "chunksPlayed"]),
  );
  const assistantAudioBytesReceivedDelta = Math.max(
    0,
    Number(output.assistantAudio?.bytesReceived || 0) -
      countFrom(baselineStatus, ["debug", "output", "assistantAudio", "bytesReceived"]),
  );
  const forwardFailuresDelta = Math.max(
    0,
    Number(voice.forwardFailures || 0) -
      countFrom(baselineStatus, ["debug", "voice", "forwardFailures"]),
  );
  const forwardBackpressureDropsDelta = Math.max(
    0,
    Number(voice.forwardBackpressureDrops || 0) -
      countFrom(baselineStatus, ["debug", "voice", "forwardBackpressureDrops"]),
  );
  const maxInputEnergy = Math.max(
    Number(energyEvidence?.maxInputEnergy || 0),
    Number(voice.lastEnergy || 0),
    Number(clientState?.voiceCapture?.lastEnergy || 0),
  );
  const realMicrophoneRequired = args.inputMode === "real_mic";
  const realMicrophoneEvidenceOk =
    !realMicrophoneRequired ||
    (voice.captureMode === "microphone_pcm16" &&
      voice.permissionState === "granted" &&
      clientState?.voiceCapture?.mode === "microphone_pcm16" &&
      maxInputEnergy >= Number(args.minInputEnergy || 0) &&
      Number(energyEvidence?.samplesAboveThreshold || 0) >= 1);
  const ok =
    runtimeStatus?.ok === true &&
    chunksReceivedDelta >= 6 &&
    forwardedChunksDelta >= 6 &&
    forwardFailuresDelta === 0 &&
    speechStartedDelta >= 1 &&
    assistantTextCompletedDelta >= 1 &&
    assistantAudioChunksPlayedDelta >= 1 &&
    failedRows.length === 0 &&
    realMicrophoneEvidenceOk;
  const surfaceUrl = new URL(listenResult?.url || "http://127.0.0.1/");
  const externalSurfaceMode = Boolean(args.surfaceUrl);
  const surfaceContext = debugReport?.summaries?.surfaceContext || debug.surfaceContext || {};
  const lanPeerEvidence = lanPeerEvidenceFrom(debug, debugReport);

  return {
    schema: "oneesama.local_voice_acceptance.v1",
    gate: "local_voice",
    ok,
    functionalOk: ok,
    generatedAt: new Date().toISOString(),
    host: {
      url: listenResult?.url || "",
      lanAddress: listenResult?.host || "",
      trustedLanOperatorMode: surfaceContext.trustedLanOperatorMode ?? true,
      lanModeExplicitlyEnabled: surfaceContext.lanModeExplicitlyEnabled ?? !externalSurfaceMode,
      reachability: surfaceContext.lanReachability || null,
    },
    lanEvidence: {
      externalSurfaceMode,
      surfaceReachability: surfaceContext.lanReachability || null,
      surfaceHost: surfaceUrl.hostname,
      nonLoopbackSurfaceHost: !isLoopbackHost(surfaceUrl.hostname),
      peerEvidence: lanPeerEvidence,
      operatorNonLoopbackPeerCount: Number(lanPeerEvidence?.operatorNonLoopbackPeerCount || 0),
      operatorPrivateLanPeerCount: Number(lanPeerEvidence?.operatorPrivateLanPeerCount || 0),
      operatorPageUrl: clientState?.pageUrl || "",
      operatorUserAgent: clientState?.userAgent || "",
      voicePublisherMode: externalSurfaceMode
        ? "preexisting_lan_operator_surface"
        : "self_contained_local_surface",
    },
    operatorSurface: {
      id: runtimeStatus?.snapshot?.sessionId || "",
      userAgent: clientState?.userAgent || "",
      voiceMode: "always_on",
      inputMode: args.inputMode,
      armed: clientState?.voiceCapture?.status === "recording",
      muted: clientState?.voiceMuted === true,
      readyMs,
      completedMs,
    },
    conversationEngine: {
      kind: "diagnostic",
      transport: "mock",
      sessionId: runtimeStatus?.snapshot?.sessionId || "",
      connected: conversation.status === "connected",
      speechStartMs:
        firstTimelineDuration(timeline, "speech_started") ??
        firstTurnMilestoneDuration(turns, "speechStarted"),
      canonicalEventCounts: conversation.eventCounts || {},
      latestCanonicalEvent: conversation.canonicalEvents?.at(-1)?.type || "",
      rawProviderEventsAvailable: false,
    },
    audio: {
      transport: "websocket_pcm",
      captureMode: "always_on",
      turnDetectionOwner: "conversation_engine",
      localVadEnabled: localVad.enabled === true,
      localVadRole: localVad.role || (localVad.enabled === true ? "telemetry" : "disabled"),
      localVadActive: localVad.active === true,
      localVadThreshold: localVad.threshold ?? null,
      sampleRate: voice.sampleRate || clientState?.voiceCapture?.sampleRate || null,
      channels: voice.channels || null,
      chunkDurationMs: voice.durationMs || null,
      hostReceiveLagMs: voice.lastReceiveLagMs ?? null,
      maxHostReceiveLagMs: voice.maxReceiveLagMs ?? null,
      hostReceiveLagClock: voice.receiveLagClock || "client_wall_to_host_wall",
      voiceStreamId: voice.activeStreamId || null,
      voiceStreamGeneration: voice.activeStreamGeneration || 0,
      voiceStreamOpenCount: voice.streamOpenCount || 0,
      staleChunksRejected: voice.staleChunksRejected || 0,
      lastChunkSentAt: voice.lastChunkSentAt || null,
      lastChunkReceivedAt: voice.lastChunkReceivedAt || voice.lastChunkAt || null,
      chunksSent: clientState?.voiceChunksSent || 0,
      chunksReceived: voice.chunksReceived || 0,
      forwardedChunks: voice.forwardedChunks || 0,
      chunksReceivedDelta,
      forwardedChunksDelta,
      speechStartedDelta,
      assistantTextCompletedDelta,
      forwardFailuresDelta,
      forwardBackpressureDropsDelta,
      chunksDropped: voice.forwardBackpressureDrops || 0,
      sequenceGaps: voice.dropsDetected || 0,
      inputEnergy: voice.lastEnergy || 0,
      inputMode: args.inputMode,
      realMicrophoneRequired,
      realMicrophoneEvidenceOk,
      inputEnergyThreshold: Number(args.minInputEnergy || 0),
      maxInputEnergy,
      inputEnergySamplesAboveThreshold: Number(energyEvidence?.samplesAboveThreshold || 0),
      selectedDeviceId: clientState?.voiceDeviceId || clientState?.voiceCapture?.deviceId || null,
      selectedDeviceLabel: clientState?.voiceCapture?.deviceLabel || "",
      availableDevices: Array.isArray(clientState?.voiceDevices) ? clientState.voiceDevices : [],
      requestedMicDeviceId: args.micDeviceId || "",
      requestedMicLabel: args.micLabel || "",
      micDeviceSelection: micDeviceSelection || null,
      outputEnergy: output.assistantAudio?.rms || null,
      outputSilent: output.assistantText?.completedCount < 1,
      voiceAckRttMs: clientState?.voice?.lastAckRttMs ?? voice.lastAckRttMs ?? null,
      maxVoiceAckRttMs: clientState?.voice?.maxAckRttMs ?? voice.maxAckRttMs ?? null,
      voiceAckCount: clientState?.voice?.ackCount ?? voice.ackCount ?? 0,
      voiceAckClock: clientState?.voice?.ackClock || voice.ackClock || "client_send_to_ack_wall",
    },
    output: {
      assistantText: output.assistantText || {},
      assistantAudio: {
        ...output.assistantAudio,
        chunksReceivedDelta: assistantAudioChunksReceivedDelta,
        chunksPlayedDelta: assistantAudioChunksPlayedDelta,
        bytesReceivedDelta: assistantAudioBytesReceivedDelta,
      },
    },
    visual: {
      direction: "host_to_operator",
      transport: "webrtc_video",
      hostVisualContextMode:
        Number(visual.trackCount || 0) > 0 ? "visible" : "disabled_for_voice_gate",
      hostVisualContextDisabled: Number(visual.trackCount || 0) === 0,
      connectionState: visual.connectionState || "",
      iceConnectionState: visual.iceConnectionState || "",
      trackCount: visual.trackCount || 0,
      sources: visual.sources || [],
      composition: visual.composition || null,
      operatorScreenBackflow: false,
    },
    timeline,
    turns,
    debugReport,
    timings: {
      totalWallMs: Math.round(performance.now() - startedAt),
      readyMs,
      completedMs,
    },
    failureRows: failedRows,
    args: {
      timeoutMs: args.timeoutMs,
      headed: args.headed,
      localVad: args.localVad,
      inputMode: args.inputMode,
      minInputEnergy: args.minInputEnergy,
      micDeviceId: args.micDeviceId,
      micLabel: args.micLabel,
      browserLaunchArgs: listenResult
        ? lanOperatorVoiceBrowserLaunchArgs(listenResult.url, { inputMode: args.inputMode })
        : [],
    },
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function missingSurfaceUrlReport(args) {
  return {
    schema: "oneesama.local_voice_acceptance.v1",
    gate: "local_voice",
    ok: false,
    functionalOk: false,
    generatedAt: new Date().toISOString(),
    blocker: "missing_local_operator_surface_url",
    reason: "missing_env",
    missingEnv: ["MAB_LAN_OPERATOR_SURFACE_URL"],
    requiredFix:
      "Set MAB_LAN_OPERATOR_SURFACE_URL to the host Mac Local Operator Surface URL before running the legacy external diagnostic voice gate.",
    command:
      "MAB_LAN_OPERATOR_SURFACE_URL=http://<host-ip>:18913/ vp run acceptance:realtime-lan-voice:external",
    lanEvidence: {
      externalSurfaceMode: true,
      surfaceHost: "",
      nonLoopbackSurfaceHost: false,
      voicePublisherMode: "preexisting_lan_operator_surface",
      operatorNonLoopbackPeerCount: 0,
      operatorPrivateLanPeerCount: 0,
    },
    args: {
      timeoutMs: args.timeoutMs,
      headed: args.headed,
      localVad: args.localVad,
      inputMode: args.inputMode,
      minInputEnergy: args.minInputEnergy,
      surfaceUrl: "",
      surfaceUrlProvided: true,
    },
  };
}

function voiceAcceptanceBlocker(args, runtimeStatus, energyEvidence, micDeviceSelection, error) {
  if (micDeviceSelection?.requested === true && micDeviceSelection?.ok === false) {
    return "requested_microphone_device_not_found";
  }
  const voice = runtimeStatus?.debug?.voice || {};
  if (voice.permissionState && voice.permissionState !== "granted") {
    return "operator_microphone_permission_not_granted";
  }
  if (voice.captureStatus && voice.captureStatus !== "recording") {
    return "operator_microphone_not_recording";
  }
  if (args.inputMode === "real_mic") {
    const threshold = Number(args.minInputEnergy || 0);
    const maxInputEnergy = Number(energyEvidence?.maxInputEnergy || voice.lastEnergy || 0);
    if (maxInputEnergy < threshold) return "real_microphone_input_energy_below_threshold";
  }
  const message = String(error?.message || error || "");
  if (message.startsWith("runtime_status_timeout")) return "conversation_turn_not_completed";
  return "voice_acceptance_failed";
}

async function readClientState(page) {
  if (!page) return null;
  return page.evaluate(() => ({
    userAgent: navigator.userAgent,
    pageUrl: location.href,
    voiceCapture: window.MAB_LAN_OPERATOR_SURFACE.state.voiceCapture,
    voiceLocalVad: window.MAB_LAN_OPERATOR_SURFACE.state.voiceLocalVad,
    voiceDeviceId: window.MAB_LAN_OPERATOR_SURFACE.state.voiceDeviceId,
    voiceDevices: window.MAB_LAN_OPERATOR_SURFACE.state.voiceDevices,
    voiceChunksSent: window.MAB_LAN_OPERATOR_SURFACE.state.voiceChunksSent,
    voiceMuted: window.MAB_LAN_OPERATOR_SURFACE.state.voiceMuted,
    voice: window.MAB_LAN_OPERATOR_SURFACE.state.voice,
  }));
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.surfaceUrlProvided && !String(args.surfaceUrl || "").trim()) {
    const report = attachLanAcceptanceSlo(missingSurfaceUrlReport(args));
    await writeJson(args.jsonOut, report);
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          functionalOk: report.functionalOk,
          sloOk: report.slo?.ok,
          sloFailures: report.slo?.failures?.map((failure) => failure.id) || [],
          blocker: report.blocker,
          jsonOut: args.jsonOut,
          gate: report.gate,
          inputMode: report.audio?.inputMode,
          maxInputEnergy: report.audio?.maxInputEnergy,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }
  const startedAt = performance.now();
  const externalSurfaceMode = Boolean(args.surfaceUrl);
  const surface = externalSurfaceMode
    ? null
    : createLanOperatorSurfaceServer({
        host: args.host,
        port: args.port,
        sessionId: `lan_voice_acceptance_${Date.now().toString(36)}`,
        botName: "LAN Oneesama",
      });
  let browser = null;
  let context = null;
  let page = null;
  let report = null;
  let listenResult = null;
  let baselineStatus = null;
  let runtimeStatus = null;
  let debugReport = null;
  let clientState = null;
  let micDeviceSelection = null;
  let readyMs = null;
  let completedMs = null;
  const energyEvidence = {
    maxInputEnergy: 0,
    samplesAboveThreshold: 0,
    threshold: args.minInputEnergy,
  };
  const observeEnergy = (body) => {
    const energy = Number(body?.debug?.voice?.lastEnergy);
    if (!Number.isFinite(energy)) return;
    energyEvidence.maxInputEnergy = Math.max(energyEvidence.maxInputEnergy, energy);
    if (energy >= Number(args.minInputEnergy || 0)) {
      energyEvidence.samplesAboveThreshold += 1;
    }
  };
  try {
    listenResult = externalSurfaceMode
      ? listenResultFromSurfaceUrl(args.surfaceUrl)
      : await surface.listen();
    browser = await chromium.launch({
      headless: !args.headed,
      args: lanOperatorVoiceBrowserLaunchArgs(listenResult.url, { inputMode: args.inputMode }),
    });
    context = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 1366, height: 860 },
    });
    page = await context.newPage();
    await page.goto(lanOperatorVoiceOperatorPageUrl(listenResult.url));
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: args.timeoutMs,
    });
    readyMs = Math.round(performance.now() - startedAt);
    await page.evaluate(
      (mode) => window.MAB_LAN_OPERATOR_SURFACE.configureLocalVad(mode === "enabled"),
      args.localVad,
    );
    micDeviceSelection = await configureMicrophoneDevice(page, args);
    if (micDeviceSelection?.requested === true && micDeviceSelection?.ok === false) {
      throw new Error(`microphone_device_selection_failed: ${JSON.stringify(micDeviceSelection)}`);
    }
    baselineStatus = await (await fetch(new URL("/runtime/status", listenResult.url))).json();
    await page.click("#voice-button");
    runtimeStatus = await waitForRuntimeStatus(
      listenResult.url,
      (body) => {
        const realMicOk =
          args.inputMode !== "real_mic" ||
          (body.debug.voice.captureMode === "microphone_pcm16" &&
            body.debug.voice.permissionState === "granted" &&
            energyEvidence.maxInputEnergy >= Number(args.minInputEnergy || 0) &&
            energyEvidence.samplesAboveThreshold >= 1);
        return (
          Math.max(
            0,
            Number(body.debug.voice.chunksReceived || 0) -
              countFrom(baselineStatus, ["debug", "voice", "chunksReceived"]),
          ) >= 6 &&
          Math.max(
            0,
            Number(body.debug.voice.forwardedChunks || 0) -
              countFrom(baselineStatus, ["debug", "voice", "forwardedChunks"]),
          ) >= 6 &&
          body.debug.voice.lastAckRttMs != null &&
          Math.max(
            0,
            Number(body.debug.output.assistantText.completedCount || 0) -
              countFrom(baselineStatus, ["debug", "output", "assistantText", "completedCount"]),
          ) >= 1 &&
          Math.max(
            0,
            Number(body.debug.output.assistantAudio.chunksPlayed || 0) -
              countFrom(baselineStatus, ["debug", "output", "assistantAudio", "chunksPlayed"]),
          ) >= 1 &&
          realMicOk
        );
      },
      args.timeoutMs,
      observeEnergy,
    );
    completedMs = Math.round(performance.now() - startedAt);
    clientState = await readClientState(page);
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.markInterestingRun({ label: "lan_voice_acceptance" }),
    );
    debugReport = await fetchDebugReport(listenResult.url);
    report = buildAcceptanceReport({
      args,
      listenResult,
      baselineStatus,
      runtimeStatus,
      debugReport,
      clientState,
      energyEvidence,
      micDeviceSelection,
      startedAt,
      readyMs,
      completedMs,
    });
  } catch (error) {
    runtimeStatus =
      runtimeStatus ||
      surface?.status("failed") ||
      (listenResult
        ? await fetch(new URL("/runtime/status", listenResult.url))
            .then((res) => res.json())
            .catch(() => null)
        : null);
    debugReport =
      debugReport ||
      (listenResult ? await fetchDebugReport(listenResult.url).catch(() => null) : null);
    clientState = clientState || (await readClientState(page).catch(() => null));
    const blocker = voiceAcceptanceBlocker(
      args,
      runtimeStatus,
      energyEvidence,
      micDeviceSelection,
      error,
    );
    if (listenResult && runtimeStatus) {
      report = buildAcceptanceReport({
        args,
        listenResult,
        baselineStatus,
        runtimeStatus,
        debugReport,
        clientState,
        energyEvidence,
        micDeviceSelection,
        startedAt,
        readyMs,
        completedMs: completedMs ?? Math.round(performance.now() - startedAt),
      });
      report.ok = false;
      report.functionalOk = false;
      report.error = String(error?.message || error);
      report.blocker = blocker;
      report.acceptanceBlocker = blocker;
    } else {
      report = {
        schema: "oneesama.local_voice_acceptance.v1",
        gate: "local_voice",
        ok: false,
        functionalOk: false,
        generatedAt: new Date().toISOString(),
        error: String(error?.message || error),
        blocker,
        acceptanceBlocker: blocker,
        host: { url: listenResult?.url || "" },
        audio: {
          inputMode: args.inputMode,
          realMicrophoneRequired: args.inputMode === "real_mic",
          realMicrophoneEvidenceOk: args.inputMode !== "real_mic",
          inputEnergyThreshold: args.minInputEnergy,
          maxInputEnergy: energyEvidence.maxInputEnergy,
          inputEnergySamplesAboveThreshold: energyEvidence.samplesAboveThreshold,
          requestedMicDeviceId: args.micDeviceId || "",
          requestedMicLabel: args.micLabel || "",
          micDeviceSelection: micDeviceSelection || null,
        },
        debugReport,
        runtimeStatus,
      };
    }
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close();
    await surface?.close();
  }

  report = attachLanAcceptanceSlo(report);
  await writeJson(args.jsonOut, report);
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        functionalOk: report.functionalOk,
        sloOk: report.slo?.ok,
        sloFailures: report.slo?.failures?.map((failure) => failure.id) || [],
        blocker: report.blocker || report.acceptanceBlocker,
        jsonOut: args.jsonOut,
        gate: report.gate,
        inputMode: report.audio?.inputMode,
        maxInputEnergy: report.audio?.maxInputEnergy,
      },
      null,
      2,
    ),
  );
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("lan-operator-voice-acceptance.mjs")) {
  await run();
}
