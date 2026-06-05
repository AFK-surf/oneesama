#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

const SPEECH_TO_STOP_SLO_MS = 200;
const API_TO_STOP_SLO_MS = 150;
const USER_TO_SILENCE_SLO_MS = 350;

function parseArgs(argv) {
  const args = {
    jsonOut: "",
    timeoutMs: 15_000,
    speechToStopSloMs: SPEECH_TO_STOP_SLO_MS,
    apiToStopSloMs: API_TO_STOP_SLO_MS,
    userToSilenceSloMs: USER_TO_SILENCE_SLO_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json-out") args.jsonOut = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--speech-to-stop-slo-ms") args.speechToStopSloMs = Number(argv[++i]);
    else if (arg === "--api-to-stop-slo-ms") args.apiToStopSloMs = Number(argv[++i]);
    else if (arg === "--user-to-silence-slo-ms") args.userToSilenceSloMs = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  args.timeoutMs = positiveNumber(args.timeoutMs, 15_000);
  args.speechToStopSloMs = positiveNumber(args.speechToStopSloMs, SPEECH_TO_STOP_SLO_MS);
  args.apiToStopSloMs = positiveNumber(args.apiToStopSloMs, API_TO_STOP_SLO_MS);
  args.userToSilenceSloMs = positiveNumber(args.userToSilenceSloMs, USER_TO_SILENCE_SLO_MS);
  return args;
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/realtime-native-interruption-benchmark.mjs [options]

Options:
  --json-out <path>                 Write structured report
  --timeout-ms <n>                  Overall benchmark timeout (default: 15000)
  --speech-to-stop-slo-ms <n>       speech_started -> avatar audio stop SLO (default: ${SPEECH_TO_STOP_SLO_MS})
  --api-to-stop-slo-ms <n>          API interruption -> avatar audio stop SLO (default: ${API_TO_STOP_SLO_MS})
  --user-to-silence-slo-ms <n>      user speech-start -> no bot audio SLO (default: ${USER_TO_SILENCE_SLO_MS})
`);
}

function deltaMs(start, end) {
  const startMs = Date.parse(String(start || ""));
  const endMs = Date.parse(String(end || ""));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs <= 0 || endMs <= 0) {
    return Number.NaN;
  }
  return Math.max(0, endMs - startMs);
}

function finiteMs(value) {
  return Number.isFinite(value) ? value : null;
}

function formatMs(value) {
  return value === null || value === undefined ? "n/a" : `${value}ms`;
}

async function withRealtimeBridge(config, callback) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
        simulateRemoteAudio: false,
        dryRunLocalTools: true,
        tools: [],
        ...config,
      }),
    });
    await page.goto("data:text/html,<html><body>native interruption benchmark</body></html>");
    await page.waitForFunction(
      () => window.MAB_REALTIME_BRIDGE?.connection?.dataChannelOpen === true,
    );
    return await callback(page);
  } finally {
    await browser.close();
  }
}

async function runInterruptionScenario({
  transport = "webrtc-mock",
  eventSequence,
  selfEchoAvatarOutput = false,
}) {
  return await withRealtimeBridge({ realtimeTransport: transport }, async (page) => {
    return await page.evaluate(
      async ({ sequence, selfEcho }) => {
        window.__MAB_NATIVE_INTERRUPTION_STOPS = [];
        if (selfEcho) {
          const now = new Date().toISOString();
          window.MAB_AVATAR_AUDIO = {
            syntheticSpeechActive: false,
            outputEnergy: {
              observed: true,
              rms: 0.05,
              peak: 0.12,
              lastEnergyAt: now,
              lastCheckedAt: now,
            },
          };
        }
        window.MAB_AVATAR_AUDIO_BUS = {
          interruptOutput(input) {
            const record = {
              ts: new Date().toISOString(),
              input,
              stoppedBufferedSources: 2,
            };
            window.__MAB_NATIVE_INTERRUPTION_STOPS.push(record);
            return {
              ok: true,
              reason: input?.reason || "",
              stoppedBufferedSources: record.stoppedBufferedSources,
              stoppedAt: record.ts,
            };
          },
        };
        const dispatch = (detail) =>
          window.dispatchEvent(
            new CustomEvent("meeting-avatar-realtime-server-event", {
              detail,
            }),
          );
        dispatch({
          type: "response.output_audio.delta",
          response_id: "resp_native_interruption_bench",
          item_id: "item_native_interruption_bench",
          content_index: 0,
          delta: "pcm",
        });
        for (const step of sequence) {
          if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
          dispatch(step.event);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          stops: window.__MAB_NATIVE_INTERRUPTION_STOPS,
          protection: window.MAB_REALTIME_BRIDGE.protection,
          outbound: window.MAB_REALTIME_BRIDGE.outbound,
          timeline: window.MAB_REALTIME_BRIDGE.timeline,
        };
      },
      { sequence: eventSequence, selfEcho: selfEchoAvatarOutput },
    );
  });
}

function summarizeScenario(id, scenario, args) {
  const ni = scenario.protection?.nativeInterruption || {};
  const speechToStopMs = deltaMs(ni.speech_started_at, ni.avatar_audio_stopped_at);
  const apiToStopMs = deltaMs(ni.api_interruption_at, ni.avatar_audio_stopped_at);
  const responseCancelToStopMs = deltaMs(ni.response_cancelled_at, ni.avatar_audio_stopped_at);
  const outboundTypes = (scenario.outbound || []).map((entry) => entry?.event?.type || "");
  const timelineTypes = (scenario.timeline || []).map((entry) => entry?.type || "");
  const truncateEvents = (scenario.outbound || [])
    .map((entry) => entry?.event || {})
    .filter((event) => event.type === "conversation.item.truncate");
  const stopCount = Number(ni.avatar_audio_stop_count || 0);
  const selfEchoSuppressedCount = Number(ni.self_echo_suppressed_count || 0);
  const noLocalCancel = !outboundTypes.includes("response.cancel");
  const noUnexpectedTruncate =
    id === "websocket-truncation" || !outboundTypes.includes("conversation.item.truncate");
  const selfEchoCase = id === "self-echo-suppressed";
  const speechStopOk = !Number.isFinite(speechToStopMs) || speechToStopMs <= args.speechToStopSloMs;
  const apiStopOk = !Number.isFinite(apiToStopMs) || apiToStopMs <= args.apiToStopSloMs;
  const userSilenceOk =
    !Number.isFinite(speechToStopMs) || speechToStopMs <= args.userToSilenceSloMs;
  const websocketTruncateOk =
    id !== "websocket-truncation" ||
    (truncateEvents.length === 1 &&
      truncateEvents[0].item_id === "item_native_interruption_bench" &&
      Number.isFinite(Number(truncateEvents[0].audio_end_ms)));
  const stopped = stopCount > 0 && Boolean(ni.avatar_audio_stopped_at);
  const ok = selfEchoCase
    ? selfEchoSuppressedCount > 0 &&
      stopCount === 0 &&
      !ni.speech_started_at &&
      noLocalCancel &&
      noUnexpectedTruncate
    : stopped &&
      speechStopOk &&
      apiStopOk &&
      userSilenceOk &&
      noLocalCancel &&
      noUnexpectedTruncate &&
      websocketTruncateOk;
  let blocker = "";
  if (!ok) {
    if (selfEchoCase && selfEchoSuppressedCount <= 0) {
      blocker = "self_echo_not_suppressed";
    } else if (selfEchoCase && stopCount > 0) {
      blocker = "self_echo_stopped_avatar_audio";
    } else if (!stopped) {
      blocker = "avatar_audio_not_stopped";
    } else if (!speechStopOk) {
      blocker = "speech_started_to_avatar_stop_slo_exceeded";
    } else if (!apiStopOk) {
      blocker = "api_interruption_to_avatar_stop_slo_exceeded";
    } else if (!noLocalCancel) {
      blocker = "local_response_cancel_sent";
    } else if (!websocketTruncateOk) {
      blocker = "websocket_truncate_missing_or_invalid";
    } else {
      blocker = "native_interruption_benchmark_failed";
    }
  }
  return {
    id,
    ok,
    status: ok ? "passed" : "failed",
    timings: {
      speechStartedToAvatarStopMs: finiteMs(speechToStopMs),
      apiInterruptionToAvatarStopMs: finiteMs(apiToStopMs),
      responseCancelledToAvatarStopMs: finiteMs(responseCancelToStopMs),
    },
    slo: {
      speechStartedToAvatarStopMs: args.speechToStopSloMs,
      apiInterruptionToAvatarStopMs: args.apiToStopSloMs,
      userSpeechStartedToSilenceMs: args.userToSilenceSloMs,
    },
    evidence: {
      speechStartedAt: ni.speech_started_at || "",
      apiInterruptionAt: ni.api_interruption_at || "",
      responseCancelledAt: ni.response_cancelled_at || "",
      avatarAudioStoppedAt: ni.avatar_audio_stopped_at || "",
      truncateSentAt: ni.truncate_sent_at || "",
      stopCount,
      truncateCount: Number(ni.truncate_count || 0),
      selfEchoSuppressedCount,
      lastSelfEchoSuppressedAt: ni.last_self_echo_suppressed_at || "",
      lastSelfEchoReason: ni.last_self_echo_reason || "",
      lastSelfEchoEvidence: ni.last_self_echo_evidence || null,
      lastOutputItemId: ni.last_output_item_id || "",
      lastStopResult: ni.last_stop_result || null,
      outboundTypes,
      timelineTypes,
      truncateEvents,
      noLocalCancel,
    },
    blocker,
  };
}

export function buildRealtimeNativeInterruptionReport(args, result) {
  const cases = result.cases.map((entry) => summarizeScenario(entry.id, entry.result, args));
  return {
    schema: "oneesama.realtime-native-interruption-report.v1",
    gate: "realtime_native_audio_interruption",
    ok: result.ok === true && cases.every((entry) => entry.ok),
    generatedAt: new Date().toISOString(),
    evidenceMode: "local_playwright_realtime_bridge_native_interruption",
    acceptanceGateScope: "realtime_native_audio_interruption",
    meetRoomRequired: false,
    realAppExecution: false,
    environment: {
      platform: process.platform,
      browser: "chromium",
    },
    slo: {
      speechStartedToAvatarStopP95Ms: args.speechToStopSloMs,
      apiInterruptionToAvatarStopP95Ms: args.apiToStopSloMs,
      userSpeechStartedToSilenceP95Ms: args.userToSilenceSloMs,
    },
    proofBoundary: {
      proves: [
        "Realtime API/SDK interruption events stop avatar output without speculative local response.cancel",
        "obvious avatar-output self-echo speech_started events are suppressed without stopping avatar audio",
        "WebSocket fallback sends conversation.item.truncate for the interrupted output item",
        "interruption timing fields are recorded for benchmark and real-room artifacts",
      ],
      doesNotProve: [
        "real microphone VAD timing in a Meet room",
        "audible acoustic silence measured from speakers",
      ],
    },
    cases,
    error: result.error || "",
  };
}

export async function runRealtimeNativeInterruptionBenchmark() {
  try {
    const speechStarted = await runInterruptionScenario({
      eventSequence: [{ event: { type: "input_audio_buffer.speech_started" } }],
    });
    const responseCancelled = await runInterruptionScenario({
      eventSequence: [
        {
          event: {
            type: "response.cancelled",
            response_id: "resp_native_interruption_bench",
          },
        },
      ],
    });
    const selfEchoSuppressed = await runInterruptionScenario({
      selfEchoAvatarOutput: true,
      eventSequence: [{ event: { type: "input_audio_buffer.speech_started" } }],
    });
    const websocketTruncation = await runInterruptionScenario({
      transport: "websocket",
      eventSequence: [
        { delayMs: 15, event: { type: "input_audio_buffer.speech_started" } },
        {
          delayMs: 5,
          event: {
            type: "response.cancelled",
            response_id: "resp_native_interruption_bench",
          },
        },
      ],
    });
    return {
      ok: true,
      cases: [
        { id: "speech-started-avatar-stop", result: speechStarted },
        { id: "response-cancelled-avatar-stop", result: responseCancelled },
        { id: "self-echo-suppressed", result: selfEchoSuppressed },
        { id: "websocket-truncation", result: websocketTruncation },
      ],
    };
  } catch (error) {
    return { ok: false, cases: [], error: String(error?.message || error) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runRealtimeNativeInterruptionBenchmark(args);
  const report = buildRealtimeNativeInterruptionReport(args, result);
  if (args.jsonOut) {
    await writeFile(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    `Realtime native interruption benchmark: ${report.ok ? "PASS" : "FAIL"} (${report.cases.length} cases)`,
  );
  for (const testCase of report.cases) {
    console.log(
      `- ${testCase.ok ? "PASS" : "FAIL"} ${testCase.id} speechStop=${formatMs(testCase.timings.speechStartedToAvatarStopMs)} apiStop=${formatMs(testCase.timings.apiInterruptionToAvatarStopMs)} blocker=${testCase.blocker || ""}`,
    );
  }
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
