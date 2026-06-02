#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  argValue as resolveArgValue,
  extractRealMeetUrlFromJoinStatus,
  normalizeRealMeetUrl,
  resolveRealMeetUrl,
} from "./real-meet-url-resolver.mjs";

export { extractRealMeetUrlFromJoinStatus, normalizeRealMeetUrl };

const SELF = fileURLToPath(import.meta.url);
const SYNTHETIC_SCRIPT = fileURLToPath(
  new URL("./real-meet-synthetic-speaker-smoke.mjs", import.meta.url),
);

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

function argValue(name) {
  return resolveArgValue(process.argv, name);
}

async function writeJsonOutIfRequested(output) {
  const jsonOut = argValue("--json-out");
  if (jsonOut) await writeFile(jsonOut, `${output}\n`);
}

async function emitJsonResult(result, { error = false } = {}) {
  const output = JSON.stringify(result, null, 2);
  await writeJsonOutIfRequested(output);
  if (error) console.error(output);
  else console.log(output);
}

async function skipMissingRealMeetUrl(resolution = {}) {
  const strict = requireRealMeetUrl();
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
    command:
      "MAB_REAL_MEET_URL=https://meet.google.com/... npm run acceptance:realtime-live-sidecar",
    message:
      "Set MAB_REAL_MEET_URL, pass --real-meet-url, or keep a meeting-agent session active so /join/status exposes the real Meet URL.",
  };
  await emitJsonResult(result, { error: strict });
  if (strict) process.exitCode = 1;
  return result;
}

function forwardChildOutput(label, stream) {
  stream.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk.toString()}`);
  });
}

async function runGate(label, args, sessionId, meetUrl) {
  let tmpDir = "";
  try {
    tmpDir = await mkdtemp(pathJoin(tmpdir(), `oneesama-${label}-`));
    const jsonOut = pathJoin(tmpDir, "result.json");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", SYNTHETIC_SCRIPT, ...args, "--json-out", jsonOut],
      {
        env: {
          ...process.env,
          MAB_REAL_MEET_URL: meetUrl,
          MAB_REAL_MEET_SESSION_ID: sessionId,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    forwardChildOutput(label, child.stdout);
    forwardChildOutput(`${label}:stderr`, child.stderr);
    const exit = await waitForChildExit(child);
    if (!existsSync(jsonOut)) {
      return {
        ok: false,
        acceptanceSatisfied: false,
        error: `${label} did not write ${jsonOut}`,
        childExit: exit,
      };
    }
    return parseGateJsonResult(label, await readFile(jsonOut, "utf8"), exit);
  } catch (error) {
    return gateRunErrorResult(label, error);
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function gateRunErrorResult(label, error) {
  return {
    ok: false,
    acceptanceSatisfied: false,
    reason: "gate_error",
    error: `${label} gate failed: ${String(error?.message || error)}`,
    childExit: null,
  };
}

export async function waitForChildExit(child) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.off("error", fail);
      child.off("exit", finish);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error) => settle(reject, error);
    const finish = (code, signal) => settle(resolve, { code, signal });
    child.once("error", fail);
    child.once("exit", finish);
  });
}

export function parseGateJsonResult(label, text, childExit) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected JSON object");
    }
    return {
      ...parsed,
      childExit,
    };
  } catch (error) {
    return {
      ok: false,
      acceptanceSatisfied: false,
      reason: "invalid_json",
      error: `${label} wrote invalid JSON evidence: ${String(error?.message || error)}`,
      raw: String(text || "").slice(0, 500),
      childExit,
    };
  }
}

function childExitSucceeded(result = {}) {
  const exit = result.childExit;
  return Boolean(exit && exit.code === 0 && !exit.signal);
}

export function compactSyntheticResult(result = {}) {
  const compact = result?.final?.compact || result?.last?.compact || {};
  const childOk = childExitSucceeded(result);
  const textTurnFallback =
    result?.textTurnFallback ||
    result?.final?.textTurnFallback ||
    result?.last?.textTurnFallback ||
    null;
  return {
    ok: result.ok === true && childOk,
    acceptanceSatisfied: childOk && result.acceptanceSatisfied === true && !textTurnFallback,
    sessionId: result.sessionId || "",
    gates: result?.final?.gates || result?.last?.gates || {},
    toolCalls: compact.toolCalls || null,
    textTurnFallback,
    error: result.error || "",
    childExit: result.childExit || null,
  };
}

export function compactAppControlResult(result = {}) {
  if (Array.isArray(result.suite)) {
    const cases = result.suite.map((entry) => {
      const final = entry?.final || {};
      const appControl = final.appControl || {};
      const joinStatus = final.joinStatus || {};
      return {
        id: entry.id || "",
        kind: entry.kind || "",
        ok: entry.ok === true,
        acceptanceSatisfied: entry.acceptanceSatisfied === true,
        status: appControl.status || "",
        actions: appControl.actions || [],
        cursor: appControl.cursor || null,
        audienceCursor: joinStatus.kwwkCursor || null,
        avatarHud: joinStatus.avatarHud || null,
        jobId: appControl.jobId || joinStatus?.toolTelemetry?.appControlJobId || "",
      };
    });
    const childOk = childExitSucceeded(result);
    return {
      ok: result.ok === true && childOk,
      acceptanceSatisfied:
        result.acceptanceSatisfied === true &&
        childOk &&
        cases.length > 0 &&
        cases.every((entry) => entry.acceptanceSatisfied),
      sessionId: result.sessionId || "",
      applicationName: result.applicationName || "",
      suite: cases,
      childExit: result.childExit || null,
    };
  }
  const final = result?.final || {};
  const appControl = final.appControl || {};
  const joinStatus = final.joinStatus || {};
  const childOk = childExitSucceeded(result);
  return {
    ok: result.ok === true && childOk,
    acceptanceSatisfied: result.acceptanceSatisfied === true && childOk,
    sessionId: result.sessionId || "",
    applicationName: result.applicationName || "",
    status: appControl.status || "",
    blocker: appControl.blocker || "",
    error: result.error || appControl.error || "",
    jobId: appControl.jobId || joinStatus?.toolTelemetry?.appControlJobId || "",
    realtimeEvidence: {
      sidecarActive: joinStatus.sidecarActive === true,
      sidecarPageCount: Number(joinStatus.sidecarPageCount || 0),
      sdkOwnerPageCount: Number(joinStatus.sdkOwnerPageCount || 0),
      connected: joinStatus.realtime?.connected === true,
      toolTelemetry: joinStatus.toolTelemetry || null,
      meetSurface: joinStatus.meetSurface || null,
    },
    childExit: result.childExit || null,
  };
}

export async function runRealMeetSidecarAcceptanceMain() {
  const realMeetUrl = await resolveRealMeetUrl();
  const meetUrl = realMeetUrl.meetUrl || "";
  if (!meetUrl) return await skipMissingRealMeetUrl(realMeetUrl);

  const startedAt = new Date().toISOString();
  const sessionBase = process.env.MAB_REAL_MEET_SESSION_ID || `real_meet_sidecar_${Date.now()}`;
  const syntheticSpeaker = await runGate(
    "synthetic-speaker",
    [],
    `${sessionBase}_synthetic`,
    meetUrl,
  );
  const appControl = await runGate(
    "app-control",
    ["--real-meet-app-control-suite"],
    `${sessionBase}_app_control`,
    meetUrl,
  );
  const gates = {
    syntheticSpeaker: compactSyntheticResult(syntheticSpeaker),
    appControl: compactAppControlResult(appControl),
  };
  const ok = gates.syntheticSpeaker.acceptanceSatisfied && gates.appControl.acceptanceSatisfied;
  const result = {
    ok,
    acceptanceSatisfied: ok,
    skipped: false,
    diagnosticOnly: false,
    meetUrl,
    meetUrlSource: realMeetUrl.source || "",
    startedAt,
    completedAt: new Date().toISOString(),
    sessionBase,
    gates,
    results: {
      syntheticSpeaker,
      appControl,
    },
  };
  await emitJsonResult(result, { error: !ok });
  if (!ok) process.exitCode = 1;
  return result;
}

if (process.argv[1] && pathResolve(process.argv[1]) === SELF) {
  await runRealMeetSidecarAcceptanceMain();
}
