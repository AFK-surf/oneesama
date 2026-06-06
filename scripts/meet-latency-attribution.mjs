#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LAN_REPORT = "/tmp/oneesama-realtime-lan-slo-suite-latest.json";
const DEFAULT_MEET_REPORT = "/tmp/oneesama-realtime-meet-compat-latest.json";
const DEFAULT_JSON_OUT = "/tmp/oneesama-realtime-meet-latency-attribution-latest.json";
const DEFAULT_MAX_MEET_APP_CONTROL_OVERHEAD_MS = 3000;

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArgs(argv) {
  const args = {
    lanReport: DEFAULT_LAN_REPORT,
    meetReport: DEFAULT_MEET_REPORT,
    jsonOut: DEFAULT_JSON_OUT,
    optional: false,
    maxMeetAppControlOverheadMs: DEFAULT_MAX_MEET_APP_CONTROL_OVERHEAD_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--lan-report") args.lanReport = argv[++index];
    else if (arg === "--meet-report") args.meetReport = argv[++index];
    else if (arg === "--json-out") args.jsonOut = argv[++index];
    else if (arg === "--optional") args.optional = true;
    else if (arg === "--max-meet-app-control-overhead-ms") {
      args.maxMeetAppControlOverheadMs = Number(argv[++index]);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/meet-latency-attribution.mjs [options]

Options:
  --lan-report <path>       LAN SLO suite/report path (default: ${DEFAULT_LAN_REPORT})
  --meet-report <path>      Meet compatibility report path (default: ${DEFAULT_MEET_REPORT})
  --json-out <path>         Output report path (default: ${DEFAULT_JSON_OUT})
  --optional                Exit 0 when Meet evidence is missing or not accepted
  --max-meet-app-control-overhead-ms <n>
                            App-control overhead budget over LAN warm baseline
`);
}

function entryFromAggregate(report, gate, id) {
  return (report?.gates?.[gate]?.entries || []).find((entry) => entry.id === id) || null;
}

function entryFromReport(report, id) {
  return (report?.slo?.entries || []).find((entry) => entry.id === id) || null;
}

function entryValue(entry, statistic = "p95") {
  return numberOrNull(entry?.[statistic] ?? entry?.actual ?? entry?.max ?? entry?.p50);
}

function baselineEntry(report, gate, id, statistic = "p95") {
  return entryValue(entryFromAggregate(report, gate, id) || entryFromReport(report, id), statistic);
}

function extractLanBaseline(report) {
  const voiceReport = (report?.reports || []).find((entry) => entry.gate === "lan_voice_loop");
  return {
    ok: report?.ok === true,
    schema: report?.schema || "",
    reportGeneratedAt: report?.generatedAt || "",
    voice: {
      firstFeedbackMs: numberOrNull(voiceReport?.perceivedUx?.firstFeedbackMs),
      assistantOutputP95Ms: baselineEntry(
        report,
        "lan_voice_loop",
        "turn_heard_to_assistant_output_ms",
      ),
    },
    kwwk: {
      visibleFeedbackP95Ms: baselineEntry(
        report,
        "lan_kwwk_action",
        "kwwk_visible_feedback_after_tool_ms",
      ),
      warmActionVerifiedP95Ms: baselineEntry(
        report,
        "lan_kwwk_action",
        "warm_simple_app_action_verified_ms",
      ),
      coldActionVerifiedP95Ms: baselineEntry(
        report,
        "lan_kwwk_action",
        "cold_simple_app_action_verified_ms",
      ),
    },
  };
}

function extractMeetAppControlLatency(report) {
  return (
    report?.gates?.appControl?.liveModelFirstLatency ||
    report?.results?.appControl?.liveModelFirstLatency ||
    report?.liveModelFirstLatency ||
    null
  );
}

function extractMeetEvidence(report) {
  const latency = extractMeetAppControlLatency(report);
  const appControlAccepted =
    report?.gates?.appControl?.acceptanceSatisfied === true || report?.acceptanceSatisfied === true;
  const syntheticAccepted =
    report?.gates?.syntheticSpeaker?.acceptanceSatisfied === true || report?.gate !== "meet_compat";
  return {
    ok: report?.ok === true,
    acceptanceSatisfied: report?.acceptanceSatisfied === true,
    gate: report?.gate || "",
    acceptanceLane: report?.acceptanceLane || "",
    diagnosticOnly: report?.diagnosticOnly === true,
    skipped: report?.skipped === true,
    reason: report?.reason || "",
    blocker: report?.blocker || "",
    blockerSource: report?.blockerSource || "",
    syntheticSpeakerAccepted: syntheticAccepted,
    appControlAccepted,
    appControlWarmP95Ms: numberOrNull(latency?.warmP95Ms),
    appControlWarmSloMs: numberOrNull(latency?.warmSloMs),
    appControlMeasuredSampleCount: numberOrNull(latency?.measuredSampleCount),
    appControlSampleCount: numberOrNull(latency?.sampleCount),
  };
}

function classifyMissingOrBlocked(meetEvidence, meetReportPresent) {
  if (!meetReportPresent) return "missing_meet_report";
  if (meetEvidence.skipped) return "meet_compat_not_run";
  if (meetEvidence.blockerSource) return meetEvidence.blockerSource;
  if (meetEvidence.reason) return meetEvidence.reason;
  if (!meetEvidence.syntheticSpeakerAccepted) return "synthetic_speaker";
  if (!meetEvidence.appControlAccepted) return "meet_app_control";
  return "meet_compat";
}

function appControlComparison(lanBaseline, meetEvidence, maxOverheadMs) {
  const lanMs = numberOrNull(lanBaseline?.kwwk?.warmActionVerifiedP95Ms);
  const meetMs = numberOrNull(meetEvidence?.appControlWarmP95Ms);
  const overheadMs = lanMs !== null && meetMs !== null ? Math.max(0, meetMs - lanMs) : null;
  const ok =
    overheadMs !== null && overheadMs <= maxOverheadMs && meetEvidence.appControlAccepted === true;
  return {
    ok,
    measured: overheadMs !== null,
    lanWarmActionVerifiedP95Ms: lanMs,
    meetAppControlWarmP95Ms: meetMs,
    overheadMs,
    maxOverheadMs,
    attribution:
      overheadMs === null
        ? "missing_comparable_timing"
        : overheadMs > maxOverheadMs
          ? "meet_adapter_or_room_overhead_above_budget"
          : "meet_adapter_overhead_within_budget",
  };
}

export function buildMeetLatencyAttributionReport({
  lanReport,
  meetReport,
  meetReportPresent = true,
  maxMeetAppControlOverheadMs = DEFAULT_MAX_MEET_APP_CONTROL_OVERHEAD_MS,
} = {}) {
  const lanBaseline = extractLanBaseline(lanReport || {});
  const meetEvidence = extractMeetEvidence(meetReport || {});
  const appControl = appControlComparison(lanBaseline, meetEvidence, maxMeetAppControlOverheadMs);
  const missingOrBlocked = classifyMissingOrBlocked(meetEvidence, meetReportPresent);
  const ok =
    lanBaseline.ok === true &&
    meetReportPresent === true &&
    meetEvidence.acceptanceSatisfied === true &&
    appControl.ok === true;
  return {
    schema: "oneesama.meet_latency_attribution.v1",
    gate: "meet_latency_attribution",
    acceptanceLane: "meet_compat_secondary",
    primaryAcceptanceLane: "lan_operator",
    generatedAt: new Date().toISOString(),
    ok,
    acceptanceSatisfied: ok,
    lanBaseline,
    meetEvidence: {
      ...meetEvidence,
      present: meetReportPresent,
    },
    comparisons: {
      appControl,
      voice: {
        measured: false,
        lanAssistantOutputP95Ms: lanBaseline.voice.assistantOutputP95Ms,
        attribution: "meet_voice_latency_requires_successful_meet_compat_voice_report",
      },
    },
    blocker: ok ? "" : missingOrBlocked,
    requiredFix: ok
      ? ""
      : "Run the LAN SLO suite and a successful Meet compatibility report, then rerun this attribution command.",
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readOptionalJson(path) {
  try {
    return { present: true, report: await readJson(path), error: "" };
  } catch (error) {
    return { present: false, report: null, error: String(error?.message || error) };
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function runMeetLatencyAttribution(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const lan = await readOptionalJson(args.lanReport);
  const meet = await readOptionalJson(args.meetReport);
  const report = buildMeetLatencyAttributionReport({
    lanReport: lan.report,
    meetReport: meet.report,
    meetReportPresent: meet.present,
    maxMeetAppControlOverheadMs: args.maxMeetAppControlOverheadMs,
  });
  report.inputs = {
    lanReport: args.lanReport,
    lanReportPresent: lan.present,
    lanReadError: lan.error,
    meetReport: args.meetReport,
    meetReportPresent: meet.present,
    meetReadError: meet.error,
    optional: args.optional,
  };
  await writeJson(args.jsonOut, report);
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        acceptanceSatisfied: report.acceptanceSatisfied,
        blocker: report.blocker,
        appControlOverheadMs: report.comparisons.appControl.overheadMs,
        jsonOut: args.jsonOut,
      },
      null,
      2,
    ),
  );
  if (!report.ok && !args.optional) process.exitCode = 1;
  return report;
}

const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && pathResolve(process.argv[1]) === SELF) {
  await runMeetLatencyAttribution();
}
