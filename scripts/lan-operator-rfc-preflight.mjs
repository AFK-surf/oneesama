#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { auditLanRfcAcceptanceArtifacts } from "./lan-operator-rfc-acceptance-audit.mjs";

const DEFAULT_JSON_OUT = "/tmp/oneesama-realtime-lan-rfc-preflight-latest.json";
const DEFAULT_TIMEOUT_MS = 3000;

function compactObject(input) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    output[key] = value;
  }
  return output;
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

function firstSetEnv(env, names) {
  return names.find((name) => typeof env[name] === "string" && env[name].trim()) || "";
}

function proxySummary(env) {
  const source = firstSetEnv(env, [
    "MAB_LAN_OPENAI_REALTIME_PROXY_URL",
    "MAB_OPENAI_REALTIME_PROXY_URL",
    "https_proxy",
    "HTTPS_PROXY",
    "http_proxy",
    "HTTP_PROXY",
    "all_proxy",
    "ALL_PROXY",
  ]);
  const value = source ? String(env[source] || "").trim() : "";
  if (!value) {
    return {
      configured: false,
      source: null,
      protocol: null,
      supportedByRealtimeTransport: false,
    };
  }
  try {
    const parsed = new URL(value);
    return {
      configured: true,
      source,
      protocol: parsed.protocol,
      supportedByRealtimeTransport: parsed.protocol === "http:",
      loopbackProxy: isLoopbackHost(parsed.hostname),
    };
  } catch {
    return {
      configured: true,
      source,
      protocol: "invalid",
      supportedByRealtimeTransport: false,
    };
  }
}

function command(label, value, where = "repo") {
  return compactObject({ label, command: value, where });
}

function recipe() {
  return [
    command("Start host LAN surface", "vp run dev:lan-operator -- --host 0.0.0.0", "host_mac"),
    command("Open app-view publisher", "open http://<host-lan-ip>:18913/host-visual", "host_mac"),
    command(
      "Open avatar publisher",
      "open 'http://<host-lan-ip>:18913/host-visual?avatar=1&sourceId=avatar&label=Avatar&kind=avatar'",
      "host_mac",
    ),
    command(
      "Run RFC preflight from operator computer",
      "MAB_LAN_OPERATOR_SURFACE_URL=http://<host-lan-ip>:18913/ vp run acceptance:realtime-lan-rfc:preflight",
      "operator_computer",
    ),
    command(
      "Run external voice gate",
      "MAB_LAN_OPERATOR_SURFACE_URL=http://<host-lan-ip>:18913/ vp run acceptance:realtime-lan-voice:external",
      "operator_computer",
    ),
    command(
      "Run external visual gate",
      "MAB_LAN_OPERATOR_SURFACE_URL=http://<host-lan-ip>:18913/ vp run acceptance:realtime-lan-host-visual-stream:external",
      "operator_computer",
    ),
    command(
      "Run display-capture visual gate on a supported host browser",
      "vp run acceptance:realtime-lan-host-visual-stream:display",
      "host_mac",
    ),
    command(
      "Run display-capture visual gate with manual browser picker",
      "vp run acceptance:realtime-lan-host-visual-stream:display:manual",
      "host_mac",
    ),
    command(
      "Run display-capture visual gate with native screencapture fallback",
      "vp run acceptance:realtime-lan-host-visual-stream:display:native",
      "host_mac",
    ),
    command("Run live OpenAI text gate", "vp run acceptance:realtime-lan-openai-live"),
    command("Run live OpenAI voice gate", "vp run acceptance:realtime-lan-openai-voice-live"),
    command("Run live OpenAI tool gate", "vp run acceptance:realtime-lan-openai-tool-live"),
    command(
      "Preflight Meet compatibility",
      "MAB_REAL_MEET_URL=https://meet.google.com/... vp run acceptance:realtime-meet-compat:preflight",
    ),
    command("Run final RFC audit", "vp run acceptance:realtime-lan-rfc:audit"),
  ];
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function surfaceContextFrom(statusBody, reportBody) {
  return (
    reportBody?.report?.summaries?.surfaceContext ||
    reportBody?.summaries?.surfaceContext ||
    statusBody?.debug?.surfaceContext ||
    {}
  );
}

function auditSummary(auditReport) {
  if (!auditReport) return null;
  return {
    ok: auditReport.ok === true,
    artifactCount: auditReport.artifactCount || 0,
    passed: auditReport.passed || 0,
    failed: auditReport.failed || 0,
    missing: auditReport.missing || 0,
    categories: auditReport.categories || {},
    requiredFailures: (auditReport.requiredFailures || []).map((entry) =>
      compactObject({
        id: entry.id,
        category: entry.category,
        status: entry.status,
        blocker: entry.blocker,
        error: entry.error,
        artifactPath: entry.path,
      }),
    ),
    nextActionCount: auditReport.nextActionCount || 0,
  };
}

function environmentReadiness(env) {
  const openAiKeySource = firstSetEnv(env, ["MAB_OPENAI_API_KEY", "OPENAI_API_KEY"]);
  const meetUrlSource = firstSetEnv(env, ["MAB_REAL_MEET_URL"]);
  const calendarAutoRoomSource = firstSetEnv(env, [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_REFRESH_TOKEN",
    "MAB_WORKSPACE_TOOLS_ENV_FILE",
  ]);
  return {
    openaiRealtime: {
      configured: Boolean(openAiKeySource),
      keySource: openAiKeySource || null,
      websocketProxy: proxySummary(env),
    },
    meetCompatibility: {
      meetUrlConfigured: Boolean(meetUrlSource),
      meetUrlSource: meetUrlSource || null,
      calendarAutoRoomMaybeConfigured: Boolean(calendarAutoRoomSource),
      calendarAutoRoomSource: calendarAutoRoomSource || null,
    },
  };
}

function pushBlocker(blockers, source, blocker, message, requiredFix) {
  blockers.push(compactObject({ source, blocker, message, requiredFix }));
}

export async function buildLanRfcPreflightReport({
  surfaceUrl = "",
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now(),
  auditReport = null,
} = {}) {
  const blockers = [];
  const warnings = [];
  const environment = environmentReadiness(env);
  const rawSurfaceUrl = String(surfaceUrl || env.MAB_LAN_OPERATOR_SURFACE_URL || "").trim();
  let parsedSurfaceUrl = null;
  let runtimeStatus = null;
  let debugReport = null;
  let surfaceContext = {};

  if (!rawSurfaceUrl) {
    pushBlocker(
      blockers,
      "lan_operator_surface",
      "missing_lan_operator_surface_url",
      "MAB_LAN_OPERATOR_SURFACE_URL is required for true second-computer LAN preflight.",
      "Start the host surface on 0.0.0.0 and pass http://<host-lan-ip>:18913/ from the operator computer.",
    );
  } else {
    try {
      parsedSurfaceUrl = new URL(rawSurfaceUrl);
      if (!["http:", "https:"].includes(parsedSurfaceUrl.protocol)) {
        pushBlocker(
          blockers,
          "lan_operator_surface",
          "lan_operator_surface_url_unsupported_protocol",
          "The LAN Operator Surface URL must be http or https.",
          "Use the advertised http://<host-lan-ip>:<port>/ operator surface URL.",
        );
      }
      if (isLoopbackHost(parsedSurfaceUrl.hostname)) {
        pushBlocker(
          blockers,
          "lan_operator_surface",
          "lan_operator_surface_url_loopback",
          "Loopback URLs only prove same-machine diagnostics, not another LAN computer.",
          "Use a non-loopback host LAN IP such as http://192.168.x.y:18913/.",
        );
      }
    } catch (error) {
      pushBlocker(
        blockers,
        "lan_operator_surface",
        "lan_operator_surface_url_invalid",
        String(error?.message || error),
        "Set MAB_LAN_OPERATOR_SURFACE_URL to a full URL such as http://192.168.x.y:18913/.",
      );
    }
  }

  if (parsedSurfaceUrl && fetchImpl) {
    try {
      runtimeStatus = await fetchJson(
        fetchImpl,
        new URL("/runtime/status", parsedSurfaceUrl),
        timeoutMs,
      );
      if (runtimeStatus?.ok !== true) {
        pushBlocker(
          blockers,
          "runtime_status",
          "lan_operator_runtime_status_not_ok",
          "The LAN Operator Surface /runtime/status endpoint responded but was not ok.",
          "Inspect the host LAN Operator Surface terminal and Debug Panel runtime status.",
        );
      }
    } catch (error) {
      pushBlocker(
        blockers,
        "runtime_status",
        "lan_operator_runtime_status_unreachable",
        String(error?.message || error),
        "Confirm the host surface is running, bound to 0.0.0.0, and reachable from the operator computer.",
      );
    }

    try {
      const body = await fetchJson(
        fetchImpl,
        new URL("/runtime/report", parsedSurfaceUrl),
        timeoutMs,
      );
      debugReport = body.report || body;
    } catch (error) {
      pushBlocker(
        blockers,
        "runtime_report",
        "lan_operator_runtime_report_unreachable",
        String(error?.message || error),
        "The Debug Report endpoint must be reachable before external gates can explain failures.",
      );
    }
    surfaceContext = surfaceContextFrom(runtimeStatus, debugReport);
  }

  if (!environment.openaiRealtime.configured) {
    pushBlocker(
      blockers,
      "openai_realtime",
      "openai_realtime_api_key_missing",
      "Strict live OpenAI Realtime gates need MAB_OPENAI_API_KEY or OPENAI_API_KEY.",
      "Export a valid key before running the live text/voice/tool gates.",
    );
  }

  if (
    !environment.meetCompatibility.meetUrlConfigured &&
    !environment.meetCompatibility.calendarAutoRoomMaybeConfigured
  ) {
    pushBlocker(
      blockers,
      "meet_compatibility",
      "meet_compatibility_input_missing",
      "Gate 6 needs MAB_REAL_MEET_URL or an auto-room/admission setup.",
      "Set MAB_REAL_MEET_URL for a controlled room, or configure the Calendar auto-room path.",
    );
  }

  const reachability = surfaceContext.lanReachability || null;
  const lanPeerEvidence = surfaceContext.lanPeerEvidence || null;
  if (reachability?.externallyReachableCandidate === false) {
    warnings.push({
      source: "lan_reachability",
      reason: "surface_not_advertised_as_external_candidate",
      message: "The host reported a local-only or loopback reachability posture.",
    });
  }

  const audit = auditReport || auditLanRfcAcceptanceArtifacts({ now });
  return {
    schema: "oneesama.lan_rfc_preflight.v1",
    generatedAt: new Date(now).toISOString(),
    ok: blockers.length === 0,
    preflightSatisfied: blockers.length === 0,
    acceptanceSatisfied: false,
    blockers,
    blockerCount: blockers.length,
    warnings,
    warningCount: warnings.length,
    surface: {
      configured: Boolean(rawSurfaceUrl),
      url: parsedSurfaceUrl?.toString() || rawSurfaceUrl || null,
      host: parsedSurfaceUrl?.hostname || null,
      nonLoopbackHost: parsedSurfaceUrl ? !isLoopbackHost(parsedSurfaceUrl.hostname) : false,
      runtimeStatusReachable: Boolean(runtimeStatus),
      runtimeStatusOk: runtimeStatus?.ok === true,
      debugReportReachable: Boolean(debugReport),
      trustedLanOperatorMode: surfaceContext.trustedLanOperatorMode ?? null,
      lanModeExplicitlyEnabled: surfaceContext.lanModeExplicitlyEnabled ?? null,
      reachability,
      lanPeerEvidence,
    },
    environment,
    currentEvidence: auditSummary(audit),
    commands: recipe(),
  };
}

function parseArgs(argv) {
  const args = {
    jsonOut: DEFAULT_JSON_OUT,
    surfaceUrl: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    optional: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json-out") args.jsonOut = argv[++index];
    else if (arg === "--surface-url" || arg === "--operator-url")
      args.surfaceUrl = argv[++index] || "";
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--optional") args.optional = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node --import tsx scripts/lan-operator-rfc-preflight.mjs [options]

Options:
  --surface-url <url>   LAN Operator Surface URL. Defaults to MAB_LAN_OPERATOR_SURFACE_URL.
  --timeout-ms <n>      Runtime endpoint timeout (default: ${DEFAULT_TIMEOUT_MS})
  --json-out <path>     Write structured report (default: ${DEFAULT_JSON_OUT})
  --optional            Exit 0 even when preflight blockers remain.
`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function runLanRfcPreflight(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = await buildLanRfcPreflightReport({
    surfaceUrl: args.surfaceUrl,
    timeoutMs: args.timeoutMs,
  });
  writeJson(args.jsonOut, report);
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        blockerCount: report.blockerCount,
        blockers: report.blockers,
        warningCount: report.warningCount,
        currentEvidence: report.currentEvidence,
        commands: report.commands,
        jsonOut: args.jsonOut,
      },
      null,
      2,
    ),
  );
  if (!report.ok && !args.optional) process.exitCode = 1;
  return report;
}

if (process.argv[1]?.endsWith("lan-operator-rfc-preflight.mjs")) {
  await runLanRfcPreflight();
}
