import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  createWorkAxSurface,
  kwwkStateText,
  parseAxStateText,
} from "../packages/core/src/work/work-ax-surface.ts";

// An authentic slice of kwwk-cu's <app_state> output for the fixture page in
// Chrome (captured live, trimmed): toolbar chrome + the web content, each
// element line led by its kwwk-cu element index.
const STATE_TEXT = [
  "Computer Use state",
  '<app_state surface="window">',
  'Window: "Fixture Product Release Notes - Google Chrome - toeverything.info", App: Google Chrome.',
  "0 standard window Fixture Product Release Notes (settable, string)",
  "\t1 group (settable, string) URL: http://127.0.0.1:18931/release-notes.html",
  "\t\t\t\t\t\t\t9 button Reload (settable, string)",
  "\t\t\t\t\t\t\t\t12 text field Address and search bar (settable, string) Value: 127.0.0.1:18931/release-notes.html",
  "\t\t\t30 heading What changed in 2.0 (settable, string)",
  "\t\t\t31 text Fixture Product 2.0 adds offline replay, a stepwise planner, and verified post-conditions. (settable, string)",
  "\t\t\t40 link Back to search (settable, string)",
  "</app_state>",
].join("\n");

function actionResult(text) {
  return {
    ok: true,
    status: "completed",
    actions: ["state"],
    metadata: { actionTelemetry: [{ target: { coreOutputText: [text] } }] },
  };
}

// Fake transport: records requests, returns canned state for state ops and ok
// for actions. Lets us test the adapter mapping without the real helper.
function fakeTransport(stateText) {
  const requests = [];
  return {
    requests,
    async request(method, params) {
      requests.push({ method, params });
      const kind = params?.operation?.kind;
      if (kind === "state") return actionResult(stateText);
      return { ok: true, status: "completed", actions: [kind], metadata: {} };
    },
    async close() {},
  };
}

test("parseAxStateText extracts indexed refs, title, and url", () => {
  const parsed = parseAxStateText(STATE_TEXT);
  assert.equal(parsed.title, "Fixture Product Release Notes - Google Chrome - toeverything.info");
  assert.equal(parsed.url, "http://127.0.0.1:18931/release-notes.html");
  const byRef = Object.fromEntries(parsed.refs.map((r) => [r.ref, r]));
  assert.ok(byRef["30"], "heading element parsed");
  assert.equal(byRef["30"].role, "heading");
  assert.match(byRef["30"].name, /What changed in 2\.0/);
  assert.ok(byRef["40"], "link element parsed");
  assert.match(byRef["40"].name, /Back to search/);
  assert.equal(byRef["9"].role, "button");
});

test("kwwkStateText pulls coreOutputText out of an action result", () => {
  assert.equal(kwwkStateText(actionResult("hello state")), "hello state");
  assert.equal(kwwkStateText({ ok: true }), "");
});

test("AX surface observe() maps full state into an observation", async () => {
  const transport = fakeTransport(STATE_TEXT);
  const surface = createWorkAxSurface({ app: "Google Chrome", transport });
  const obs = await surface.observe();
  assert.equal(surface.kind, "native_ax");
  assert.match(obs.outline, /offline replay/);
  assert.equal(obs.url, "http://127.0.0.1:18931/release-notes.html");
  assert.ok(obs.refs.find((r) => r.ref === "40" && /Back to search/.test(r.name)));
  // observe() issues a state op against the configured app.
  assert.deepEqual(transport.requests.at(-1), {
    method: "kwwk.cu.action",
    params: { operation: { kind: "state" }, target: { app: "Google Chrome" } },
  });
});

test("AX surface perform() maps work verbs to kwwk ops by element index", async () => {
  const transport = fakeTransport(STATE_TEXT);
  const surface = createWorkAxSurface({ app: "Google Chrome", transport });

  const click = await surface.perform({
    schema: "oneesama.work_operation.v1",
    type: "click",
    target: { ref: "40" },
  });
  assert.equal(click.ok, true);
  assert.deepEqual(transport.requests.at(-1).params.operation, { kind: "click", elementIndex: 40 });

  await surface.perform({
    schema: "oneesama.work_operation.v1",
    type: "type-text",
    target: { ref: "12" },
    value: "release notes",
  });
  const typeOp = transport.requests.at(-1).params.operation;
  assert.equal(typeOp.kind, "type_text");
  assert.equal(typeOp.elementIndex, 12);
  assert.equal(typeOp.text, "release notes");
});

test("AX surface extract reads ref text from the live state (no kwwk action)", async () => {
  const transport = fakeTransport(STATE_TEXT);
  const surface = createWorkAxSurface({ app: "Google Chrome", transport });
  const res = await surface.perform({
    schema: "oneesama.work_operation.v1",
    type: "extract",
    target: { ref: "31" },
  });
  assert.equal(res.ok, true);
  assert.match(res.extracted, /offline replay/);
  // extract resolves from a state read, not a mutating action.
  assert.equal(transport.requests.at(-1).params.operation.kind, "state");
});

test("AX surface checkPostCondition matches against state text and url", async () => {
  const transport = fakeTransport(STATE_TEXT);
  const surface = createWorkAxSurface({ app: "Google Chrome", transport });
  assert.equal(
    (await surface.checkPostCondition({ kind: "text_present", value: "offline replay" })).ok,
    true,
  );
  assert.equal(
    (await surface.checkPostCondition({ kind: "url_includes", value: "release-notes" })).ok,
    true,
  );
  assert.equal(
    (await surface.checkPostCondition({ kind: "text_absent", value: "nonexistent term" })).ok,
    true,
  );
});

test("AX surface refuses navigate (out-of-band on the native backend)", async () => {
  const transport = fakeTransport(STATE_TEXT);
  const surface = createWorkAxSurface({ app: "Google Chrome", transport });
  const res = await surface.perform({
    schema: "oneesama.work_operation.v1",
    type: "navigate",
    value: "http://example.com",
  });
  assert.equal(res.ok, false);
  assert.equal(res.blocked, "navigate_unsupported_on_ax_backend");
});
