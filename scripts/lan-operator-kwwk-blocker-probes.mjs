import { performance } from "node:perf_hooks";

import { spawnHelper } from "./lan-operator-kwwk-helper-process.mjs";

function compactVerification(result) {
  const verification = result?.metadata?.verification;
  if (!verification || typeof verification !== "object") return null;
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  return {
    schema: String(verification.schema || "") || null,
    blocker: String(verification.blocker || "") || null,
    failedCheckCount: checks.filter((check) => check?.passed === false).length,
  };
}

function blockedProbePlan(blocker) {
  return () => ({
    status: "blocked",
    summary: `Intentional ${blocker} probe.`,
    blocker,
    operations: [],
  });
}

function compactProbeEntry(probe, response, durationMs) {
  if (response?.error) {
    return {
      phase: probe.phase,
      source: "host_kwwk_helper_probe",
      jobId: probe.jobId,
      ok: Boolean(response.error.message),
      status: "failed",
      blocker: String(response.error.message || ""),
      summary: "helper returned JSON-RPC error",
      durationMs,
      evidence: {
        responseErrorCode: response.error.code ?? null,
        responseErrorMessage: String(response.error.message || ""),
      },
    };
  }
  const result = response?.result || {};
  const metadata = result?.metadata || {};
  const planner = metadata.planner || result.planner || {};
  const verification = compactVerification(result);
  const actionTelemetry = Array.isArray(metadata.actionTelemetry) ? metadata.actionTelemetry : [];
  const blocker = String(
    result.blocker ||
      result.error ||
      verification?.blocker ||
      metadata.observationSkipped?.blocker ||
      actionTelemetry[0]?.error ||
      "",
  );
  return {
    phase: probe.phase,
    source: "host_kwwk_helper_probe",
    jobId: probe.jobId,
    ok: result.ok === false && Boolean(blocker),
    status: String(result.status || (result.ok === false ? "blocked" : "unknown")),
    blocker,
    summary: String(result.summary || ""),
    durationMs,
    evidence: {
      helperMethod: probe.method || "kwwk.cu.execute",
      observationProvided: Boolean(probe.observation),
      observationMode: metadata.observationMode || null,
      plannerProvider: planner.provider || null,
      plannerValidationOk: planner.validation?.ok ?? null,
      executionError: actionTelemetry[0]?.error || null,
      verificationSchema: verification?.schema || null,
      verificationBlocker: verification?.blocker || null,
      failedCheckCount: verification?.failedCheckCount ?? null,
    },
  };
}

async function runKwwkBlockerProbe(binary, args, probe, modelPlan) {
  const operation = probe.operation || { kind: "state" };
  const planner = probe.modelPlan || modelPlan;
  const helper = spawnHelper(
    binary,
    Math.min(args.timeoutMs, probe.timeoutMs || 4_000),
    operation,
    planner,
  );
  const started = performance.now();
  try {
    const params =
      probe.method === "kwwk.cu.action"
        ? {
            operation,
            target: probe.target,
            verification: probe.verification || { useLightObservation: true },
          }
        : {
            instruction: probe.instruction,
            target: probe.target,
            includeScreenshot: probe.includeScreenshot === true,
            modelPlan: planner(operation),
            verification: probe.verification || { useLightObservation: true },
          };
    if (probe.observation) params.observation = probe.observation;
    helper.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: probe.jobId, method: probe.method || "kwwk.cu.execute", params })}\n`,
    );
    return compactProbeEntry(
      probe,
      await helper.nextResponse(),
      Math.round(performance.now() - started),
    );
  } catch (error) {
    return {
      phase: probe.phase,
      source: "host_kwwk_helper_probe",
      jobId: probe.jobId,
      ok: false,
      status: "failed",
      blocker: String(error?.message || error),
      summary: "helper probe threw before response",
      durationMs: Math.round(performance.now() - started),
      evidence: { thrown: true },
    };
  } finally {
    await helper.closeHelper().catch(() => {});
  }
}

export async function runKwwkPhaseBlockerMatrix(args, binary, modelPlan) {
  const probes = [
    {
      phase: "observe",
      jobId: "lan_kwwk_blocker_observe",
      method: "kwwk.cu.plan",
      instruction: "click an unobserved visual target",
      target: args.target,
      operation: { kind: "click" },
      observation: { kwwkAppState: { text: "" }, accessibility: [] },
    },
    {
      phase: "plan",
      jobId: "lan_kwwk_blocker_plan",
      instruction: "intentional planner blocker probe",
      target: args.target,
      operation: { kind: "state" },
      modelPlan: blockedProbePlan("model_plan_operations_required"),
    },
    {
      phase: "execute",
      jobId: "lan_kwwk_blocker_execute",
      instruction: "set value on a missing element",
      target: args.target,
      operation: { kind: "set_value", elementIndex: 99999, value: "probe" },
      timeoutMs: 4_000,
    },
    {
      phase: "verify",
      jobId: "lan_kwwk_blocker_verify",
      instruction: "press escape",
      target: args.target,
      operation: { kind: "press_key", key: "escape" },
      verification: { expectedWindowTitleContains: "__oneesama_missing_verification_title__" },
      timeoutMs: 12_000,
    },
  ];
  const entries = [];
  for (const probe of probes)
    entries.push(await runKwwkBlockerProbe(binary, args, probe, modelPlan));
  const requiredPhases = probes.map((probe) => probe.phase);
  const observedPhases = requiredPhases.filter((phase) =>
    entries.some((entry) => entry.phase === phase && entry.ok === true && entry.blocker),
  );
  return {
    schema: "oneesama.kwwk_phase_blocker_matrix.v1",
    source: "host_kwwk_helper_probe",
    requiredPhases,
    observedPhases,
    missingPhases: requiredPhases.filter((phase) => !observedPhases.includes(phase)),
    entries,
    ok: observedPhases.length === requiredPhases.length,
  };
}
