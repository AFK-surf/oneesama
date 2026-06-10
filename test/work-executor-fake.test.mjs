import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createWorkExecutor } from "../packages/core/src/work/work-executor.ts";
import { createWorkFakeSurface } from "../packages/core/src/work/work-fake-surface.ts";
import { validateWorkJob } from "../packages/core/src/work/work-job.ts";
import {
  createRecordingWorkPlanner,
  createReplayWorkPlanner,
} from "../packages/core/src/work/work-planner.ts";

// Deterministic, browser-free family-A page set (the fake-surface analogue of
// the old CDP fixture site). Keeps the executor/planner harness green and
// cross-platform without a real backend (RFC G3).
function familyAPages() {
  return {
    pages: {
      "http://fixture/search": {
        url: "http://fixture/search",
        title: "Fixture Search",
        text: "Fixture Search",
        refs: [
          { ref: "e1", role: "textbox", name: "Search query" },
          { ref: "e2", role: "button", name: "Search" },
          { ref: "e3", role: "link", name: "Fixture Product Release Notes" },
        ],
      },
      "http://fixture/release-notes": {
        url: "http://fixture/release-notes",
        title: "Fixture Product Release Notes",
        text: "What changed in 2.0 Fixture Product 2.0 adds offline replay, a stepwise planner, and verified post-conditions.",
        refs: [
          { ref: "e1", role: "heading", name: "What changed in 2.0" },
          { ref: "e2", role: "text", name: "Fixture Product 2.0 adds offline replay" },
        ],
        extracts: {
          e2: "Fixture Product 2.0 adds offline replay, a stepwise planner, and verified post-conditions.",
        },
      },
    },
    startUrl: "http://fixture/search",
    links: { e3: "http://fixture/release-notes" },
    allowedHosts: ["fixture"],
  };
}

function op(type, extra = {}) {
  return { schema: "oneesama.work_operation.v1", type, ...extra };
}

// A scripted planner that resolves refs from the live observation (like the
// real planner), following the family-A flow.
function familyAPlanner() {
  const find = (obs, role, needle) =>
    obs.refs.find((r) => r.role === role && r.name.includes(needle));
  return {
    id: "fake_family_a_planner",
    async decide({ observation, steps }) {
      switch (steps.length) {
        case 0:
          return op("type-text", {
            target: { ref: find(observation, "textbox", "Search query")?.ref || "" },
            value: "release notes",
          });
        case 1:
          return op("click", { target: { ref: find(observation, "button", "Search")?.ref || "" } });
        case 2:
          return op("click", {
            target: { ref: find(observation, "link", "Release Notes")?.ref || "" },
            rationale: "open result",
          });
        case 3:
          return op("extract", {
            target: { ref: find(observation, "text", "offline replay")?.ref || "" },
          });
        default:
          return op("done", { summary: "Fixture Product 2.0 adds offline replay." });
      }
    },
  };
}

function familyAJob() {
  const v = validateWorkJob({
    id: "job_fake_family_a",
    surfaceId: "fake-surface",
    intent: "Find what changed in 2.0 and highlight it.",
    postConditions: [
      { kind: "url_includes", value: "release-notes" },
      { kind: "text_present", value: "offline replay" },
      { kind: "element_present", value: "What changed in 2.0" },
    ],
    riskLevel: "read_only",
    source: "fixture",
  });
  assert.equal(v.ok, true, v.errors.join(","));
  return v.job;
}

test("executor runs family A to verified done on the in-memory fake surface", async () => {
  const surface = createWorkFakeSurface(familyAPages());
  const records = [];
  const executor = createWorkExecutor({
    surface,
    planner: createRecordingWorkPlanner(familyAPlanner(), (r) => records.push(r)),
    maxSteps: 8,
  });
  const result = await executor.run(familyAJob());
  assert.equal(result.status, "done", JSON.stringify(result).slice(0, 800));
  assert.ok(
    result.postConditions.every((c) => c.ok),
    "all post-conditions pass",
  );
  assert.match(result.extracted, /offline replay/);
  assert.ok(records.length >= 4, "planner decisions recorded");
});

test("recorded family-A plan replays deterministically on the fake surface", async () => {
  // First pass: record.
  const recSurface = createWorkFakeSurface(familyAPages());
  const records = [];
  await createWorkExecutor({
    surface: recSurface,
    planner: createRecordingWorkPlanner(familyAPlanner(), (r) => records.push(r)),
    maxSteps: 8,
  }).run(familyAJob());

  // Replay pass: no planner logic, just the recorded operations — must still verify.
  const replaySurface = createWorkFakeSurface(familyAPages());
  const replay = await createWorkExecutor({
    surface: replaySurface,
    planner: createReplayWorkPlanner(records),
    maxSteps: 8,
  }).run(familyAJob());
  assert.equal(replay.status, "done");
  assert.ok(replay.postConditions.every((c) => c.ok));
});

test("fake surface enforces allowed-hosts isolation", async () => {
  const surface = createWorkFakeSurface(familyAPages());
  const escape = {
    id: "escape",
    async decide({ steps }) {
      if (steps.length === 0) return op("navigate", { value: "http://evil.example/x" });
      return op("done", { summary: "should not reach" });
    },
  };
  const result = await createWorkExecutor({ surface, planner: escape, maxSteps: 3 }).run(
    familyAJob(),
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.blocker, "navigation_outside_allowed_hosts");
});
