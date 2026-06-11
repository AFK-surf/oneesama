import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createLanOperatorWorkRuntime } from "../packages/core/src/operator/lan-operator-work-runtime.ts";

const STATE_TEXT = [
  'Window: "Fixture Product Release Notes", App: Google Chrome.',
  "0 standard window Fixture Product Release Notes (settable, string) URL: http://127.0.0.1/release-notes.html",
  "\t40 link Back to search (settable, string)",
  "\t31 text Fixture Product 2.0 adds offline replay and verified post-conditions. (settable, string)",
].join("\n");

function fakeAxTransport() {
  const requests = [];
  return {
    requests,
    async request(method, params) {
      requests.push({ method, params });
      if (params?.operation?.kind === "state") {
        return {
          ok: true,
          status: "completed",
          metadata: { actionTelemetry: [{ target: { coreOutputText: [STATE_TEXT] } }] },
        };
      }
      return { ok: true, status: "completed" };
    },
    async close() {},
  };
}

// Scripted planner: exercise a perform (click) then finish — the executor
// verifies post-conditions against the AX surface afterward.
function scriptedPlanner() {
  return {
    id: "scripted",
    async decide({ steps }) {
      if (steps.length === 0) {
        return { schema: "oneesama.work_operation.v1", type: "click", target: { ref: "40" } };
      }
      return {
        schema: "oneesama.work_operation.v1",
        type: "done",
        summary: "found offline replay",
      };
    },
  };
}

test("work runtime AX backend runs a job to verified done (injected transport + planner)", async () => {
  const events = [];
  const transport = fakeAxTransport();
  const runtime = createLanOperatorWorkRuntime({
    axApp: "Google Chrome",
    onEvent: (e) => events.push(e),
    createAxTransport: async () => transport,
    createPlanner: () => scriptedPlanner(),
  });

  // "look up offline replay" compiles to a read_only job (text_present "offline").
  const outcome = await runtime.run("look up offline replay");
  await runtime.close();

  assert.equal(outcome.status, "done", JSON.stringify(events).slice(0, 800));
  const intent = events.find((e) => e.type === "intent");
  assert.equal(intent.detail.backend, "ax");
  const result = events.find((e) => e.type === "result");
  assert.equal(result.detail.status, "done");
  assert.equal(result.detail.backend, "ax");
  assert.ok(
    result.detail.postConditions.every((c) => c.ok),
    "post-conditions verified via AX state",
  );
  // The runtime drove the AX backend: a state observe + a click action.
  assert.ok(transport.requests.some((r) => r.params?.operation?.kind === "state"));
  assert.ok(
    transport.requests.some(
      (r) => r.params?.operation?.kind === "click" && r.params.operation.elementIndex === 40,
    ),
  );
});

test("work runtime rejects a non-command without touching the backend", async () => {
  const events = [];
  let transportBuilt = false;
  const runtime = createLanOperatorWorkRuntime({
    onEvent: (e) => events.push(e),
    createAxTransport: async () => {
      transportBuilt = true;
      return fakeAxTransport();
    },
    createPlanner: () => scriptedPlanner(),
  });
  const outcome = await runtime.run("我觉得这个设计不错");
  await runtime.close();
  assert.equal(outcome.status, "not_a_command");
  assert.equal(transportBuilt, false, "no backend spawned for a non-command");
  assert.ok(events.some((e) => e.type === "not_a_command"));
});
