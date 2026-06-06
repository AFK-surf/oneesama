import type { DebugState } from "./lan-operator-debug-state.ts";
import { appendTimelineRow } from "./lan-operator-timeline-debug.ts";

type KwwkStatus = DebugState["kwwk"]["status"];
type KwwkPhase = keyof DebugState["kwwk"]["phaseEvidence"];

const KWWK_STATUSES = new Set<KwwkStatus>([
  "idle",
  "queued",
  "observing",
  "planning",
  "executing",
  "verifying",
  "completed",
  "cancelled",
  "blocked",
  "failed",
]);
const KWWK_PHASES: KwwkPhase[] = ["observe", "plan", "execute", "verify"];

function statusFrom(value: unknown): KwwkStatus {
  const status = String(value || "idle") as KwwkStatus;
  return KWWK_STATUSES.has(status) ? status : "idle";
}

function numberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function booleanOrNull(value: unknown) {
  if (value === true || value === false) return value;
  return null;
}

function verificationFrom(input: Record<string, unknown>) {
  const metadata = objectValue(input.metadata);
  const verification = objectValue(input.verification || metadata.verification);
  if (!Object.keys(verification).length) return null;
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  const compactChecks = checks.map((check) => {
    const item = objectValue(check);
    return {
      name: String(item.name || ""),
      passed: booleanOrNull(item.passed),
    };
  });
  const failedCheckCount = compactChecks.filter((check) => check.passed === false).length;
  return {
    schema: String(verification.schema || "") || null,
    ok: booleanOrNull(verification.ok),
    status: String(verification.status || "") || null,
    reason: String(verification.reason || "") || null,
    blocker: String(verification.blocker || "") || null,
    checkCount: compactChecks.length,
    failedCheckCount,
    checks: compactChecks.slice(-12),
  };
}

function phaseEvidenceFrom(input: Record<string, unknown>, ts: string) {
  const phaseEvidence = objectValue(input.phaseEvidence);
  const output: Partial<DebugState["kwwk"]["phaseEvidence"]> = {};
  for (const phase of KWWK_PHASES) {
    const evidence = objectValue(phaseEvidence[phase]);
    if (!Object.keys(evidence).length) continue;
    output[phase] = {
      status: String(evidence.status || "") || null,
      durationMs: numberOrNull(evidence.durationMs),
      summary: String(evidence.summary || "") || null,
      detail: objectValue(evidence.detail),
      lastUpdatedAt: ts,
    };
  }
  return output;
}

export function mergeKwwkJobState(debug: DebugState, input: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const action = objectValue(input.action);
  const timings = objectValue(input.timings);
  const status = statusFrom(input.status || debug.kwwk.status);
  const blocker = String(input.blocker || "");
  const jobId = String(input.jobId || input.job_id || debug.kwwk.currentJobId || "");
  const latestActionKind = String(input.latestActionKind || action.kind || "");

  debug.kwwk.currentJobId = jobId || debug.kwwk.currentJobId;
  debug.kwwk.status = status;
  debug.kwwk.target = {
    ...debug.kwwk.target,
    ...objectValue(input.target),
  };
  debug.kwwk.blocker =
    blocker || (status === "blocked" || status === "failed" ? debug.kwwk.blocker : null);
  debug.kwwk.latestActionKind = latestActionKind || debug.kwwk.latestActionKind;
  debug.kwwk.cursorEventCount += Number(input.cursorEventCountDelta || 0);
  debug.kwwk.actionCount = Math.max(
    debug.kwwk.actionCount,
    Number(input.actionCount || debug.kwwk.actionCount || 0),
  );
  debug.kwwk.timings = {
    observeMs: numberOrNull(timings.observeMs ?? debug.kwwk.timings.observeMs),
    planMs: numberOrNull(timings.planMs ?? debug.kwwk.timings.planMs),
    executeMs: numberOrNull(timings.executeMs ?? debug.kwwk.timings.executeMs),
    verifyMs: numberOrNull(timings.verifyMs ?? debug.kwwk.timings.verifyMs),
    totalMs: numberOrNull(timings.totalMs ?? debug.kwwk.timings.totalMs),
  };
  const verification = verificationFrom(input);
  if (verification) {
    debug.kwwk.verification = {
      ...debug.kwwk.verification,
      ...verification,
      lastUpdatedAt: ts,
    };
  }
  const phaseEvidence = phaseEvidenceFrom(input, ts);
  debug.kwwk.phaseEvidence = {
    ...debug.kwwk.phaseEvidence,
    ...phaseEvidence,
  };
  debug.kwwk.lastUpdatedAt = ts;

  if (action.kind || input.actionKind) {
    if (input.actionCount == null) debug.kwwk.actionCount += 1;
    debug.kwwk.actions = [
      ...debug.kwwk.actions,
      {
        ts,
        kind: String(action.kind || input.actionKind || "action"),
        label: String(action.label || input.actionLabel || ""),
        status: String(action.status || status),
        durationMs: numberOrNull(action.durationMs),
      },
    ].slice(-80);
  }

  appendTimelineRow(debug, {
    at: ts,
    layer: "kwwk",
    event: `kwwk_${status}`,
    ok: status !== "blocked" && status !== "failed" && status !== "cancelled",
    turnId: String(input.turnId || "") || debug.timeline.currentTurnId,
    responseId: String(input.responseId || "") || null,
    blocker: debug.kwwk.blocker,
    detail: {
      jobId: debug.kwwk.currentJobId || "",
      target: debug.kwwk.target,
      latestActionKind: debug.kwwk.latestActionKind || "",
      actionCount: debug.kwwk.actionCount,
      timings: debug.kwwk.timings,
      verification: debug.kwwk.verification,
      phaseEvidence: debug.kwwk.phaseEvidence,
    },
  });

  return debug.kwwk;
}

export function kwwkRuntimeDetail(debug: DebugState) {
  return {
    currentJobId: debug.kwwk.currentJobId,
    status: debug.kwwk.status,
    blocker: debug.kwwk.blocker,
    latestActionKind: debug.kwwk.latestActionKind,
    actionCount: debug.kwwk.actionCount,
    cursorEventCount: debug.kwwk.cursorEventCount,
    timings: debug.kwwk.timings,
    verification: debug.kwwk.verification,
    phaseEvidence: debug.kwwk.phaseEvidence,
  };
}
