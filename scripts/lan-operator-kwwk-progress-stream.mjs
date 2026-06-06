import { performance } from "node:perf_hooks";

const IN_FLIGHT_KWWK_PHASES = Object.freeze([
  ["observe", "observing", "observing target context"],
  ["plan", "planning", "planning host action"],
  ["execute", "executing", "executing native action"],
]);

export async function callHelperWithKwwkProgress(child, request, progress) {
  const started = performance.now();
  let responseAt = null;
  child.stdin.write(`${JSON.stringify(request)}\n`);
  const responsePromise = child.nextResponse().then((response) => {
    responseAt = performance.now();
    return response;
  });
  const inFlightProgress = await emitInFlightKwwkProgress(progress, () => responseAt, started);
  const response = await responsePromise;
  return {
    response,
    durationMs: Math.round(performance.now() - started),
    inFlightProgress: inFlightProgress.map((item) =>
      Object.assign({}, item, {
        responseMs: Math.round((responseAt || performance.now()) - started),
      }),
    ),
  };
}

async function emitInFlightKwwkProgress(input, responseAt, started) {
  const emitted = [];
  for (const [phase, status, summary] of IN_FLIGHT_KWWK_PHASES) {
    const elapsedMs = Math.round(performance.now() - started);
    const emittedBeforeResponse = responseAt() == null;
    const action =
      phase === "execute"
        ? { kind: input.operation.kind || "action", label: input.instruction, status: "running" }
        : undefined;
    await input.page.evaluate((state) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(state), {
      ...input.baseKwwkState,
      jobId: input.jobId,
      status,
      action,
      target: input.target,
      phaseEvidence: {
        [phase]: {
          status: "running",
          durationMs: elapsedMs,
          summary,
          detail: {
            source: "host_helper_in_flight_stream",
            phase,
            emittedBeforeResponse,
            helperRequestId: input.jobId,
            operationKind: input.operation.kind || "",
          },
        },
      },
    });
    emitted.push({ phase, status, elapsedMs, emittedBeforeResponse });
  }
  return emitted;
}

function withSample(sample, event) {
  return Object.assign({ sample }, event);
}

export function compactInFlightProgress(cold, warm) {
  const coldEvents = Array.isArray(cold?.inFlightProgress) ? cold.inFlightProgress : [];
  const warmEvents = Array.isArray(warm?.inFlightProgress) ? warm.inFlightProgress : [];
  const events = [
    ...coldEvents.map((event) => withSample("cold", event)),
    ...warmEvents.map((event) => withSample("warm", event)),
  ];
  const beforeResponse = events.filter((event) => event.emittedBeforeResponse === true);
  const phasesBeforeResponse = [
    ...new Set(beforeResponse.map((event) => event.phase).filter(Boolean)),
  ];
  return {
    schemaVersion: 1,
    source: "host_helper_in_flight_stream",
    eventCount: events.length,
    beforeResponseCount: beforeResponse.length,
    phasesBeforeResponse,
    phaseCountBeforeResponse: phasesBeforeResponse.length,
    cold: coldEvents,
    warm: warmEvents,
  };
}
