import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function spawnHelper(binary, timeoutMs, operation, modelPlan) {
  const child = spawn(binary, ["--stdio"], {
    env: {
      ...process.env,
      ONEESAMA_KWWK_CU_PLANNER_PROVIDER: "local",
      ONEESAMA_KWWK_CU_PLANNER_MODEL: "lan-kwwk-action-fixture",
      ONEESAMA_KWWK_CU_PLANNER_LOCAL_PLAN_JSON: JSON.stringify(modelPlan(operation)),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const pending = [];
  let exited = false;
  let exitResult = null;
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
  }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/u);
    stdout = lines.pop() || "";
    for (const line of lines.filter(Boolean)) pending.shift()?.resolve(JSON.parse(line));
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("error", (error) => {
    for (const entry of pending.splice(0)) entry.reject(error);
  });
  child.once("exit", (code, signal) => {
    exited = true;
    exitResult = { code, signal: signal || "" };
    clearTimeout(timer);
    const error = new Error(
      `app_control_helper_exited_before_response:${code ?? signal ?? "unknown"}:${stderr}`,
    );
    for (const entry of pending.splice(0)) entry.reject(error);
  });
  child.nextResponse = () =>
    new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  child.closeHelper = async () => {
    clearTimeout(timer);
    if (exited) return;
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
  };
  child.hardCancelHelper = async (signal = "SIGTERM", graceMs = 1200) => {
    clearTimeout(timer);
    if (exited) {
      return {
        requested: false,
        alreadyExited: true,
        exitCode: exitResult?.code ?? null,
        exitSignal: exitResult?.signal || "",
        stderr,
      };
    }
    child.kill(signal);
    const settled = await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)).then(() => "exited"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), graceMs)),
    ]);
    if (settled !== "exited" && !exited) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    return {
      requested: true,
      alreadyExited: false,
      exitCode: exitResult?.code ?? null,
      exitSignal: exitResult?.signal || "",
      escalated: settled !== "exited",
      stderr,
    };
  };
  child.stderrText = () => stderr;
  return child;
}

export async function runHardCancelProbe(input) {
  const { args, page, binary, baseKwwkState, target, operation, modelPlan } = input;
  const jobId = "lan_kwwk_action_hard_cancel_probe";
  const callId = "call_lan_kwwk_hard_cancel";
  const reason = "operator_cancelled_hard_stop";
  const helper = spawnHelper(binary, Math.min(args.timeoutMs, 10_000), operation, modelPlan);
  const started = performance.now();
  let responseBeforeCancel = false;
  let responseAfterCancel = false;
  const request = {
    jsonrpc: "2.0",
    id: jobId,
    method: "kwwk.cu.execute",
    params: {
      instruction: `${args.instruction} (hard cancel probe)`,
      target,
      includeScreenshot: true,
      modelPlan: modelPlan(operation),
      verification: { useLightObservation: true },
    },
  };
  try {
    await page.evaluate((state) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(state), {
      ...baseKwwkState,
      jobId,
      status: "executing",
      target,
      action: { kind: operation.kind || "action", label: "hard cancel probe", status: "running" },
      phaseEvidence: {
        execute: {
          status: "running",
          durationMs: 0,
          summary: "helper request running before hard cancel",
          detail: { source: "hard_cancel_probe", helperRequestId: jobId },
        },
      },
    });
    helper.stdin.write(`${JSON.stringify(request)}\n`);
    const responsePromise = helper
      .nextResponse()
      .then(() => {
        responseAfterCancel = true;
        return true;
      })
      .catch(() => null);
    await sleep(75);
    responseBeforeCancel = responseAfterCancel;
    await page.evaluate((state) => window.MAB_LAN_OPERATOR_SURFACE.cancelTool(state), {
      callId,
      jobId,
      reason,
      turnId: baseKwwkState.turnId,
      responseId: baseKwwkState.responseId,
    });
    const cancelResult = await helper.hardCancelHelper("SIGTERM");
    await responsePromise;
    const durationMs = Math.round(performance.now() - started);
    const ok =
      cancelResult.requested === true &&
      cancelResult.alreadyExited === false &&
      cancelResult.exitSignal === "SIGTERM" &&
      responseBeforeCancel === false;
    await page.evaluate((state) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(state), {
      ...baseKwwkState,
      jobId,
      status: "cancelled",
      blocker: reason,
      target,
      action: { kind: "cancel", label: reason, status: "cancelled" },
      phaseEvidence: {
        execute: {
          status: "cancelled",
          durationMs,
          summary: "helper process terminated by operator hard cancel",
          detail: {
            source: "hard_cancel_probe",
            signal: cancelResult.exitSignal,
            responseBeforeCancel,
            responseAfterCancel,
          },
        },
      },
    });
    return {
      ok,
      jobId,
      callId,
      reason,
      signalRequested: "SIGTERM",
      exitSignal: cancelResult.exitSignal,
      exitCode: cancelResult.exitCode,
      processTerminated: cancelResult.exitSignal === "SIGTERM" || cancelResult.exitCode != null,
      responseBeforeCancel,
      responseAfterCancel,
      durationMs,
      escalated: cancelResult.escalated === true,
      stderrTail: String(cancelResult.stderr || "").slice(-500),
    };
  } finally {
    await helper.closeHelper().catch(() => {});
  }
}
