import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import { createWorkBrowserSurface } from "../packages/core/src/work/work-browser-surface.ts";
import { createWorkExecutor } from "../packages/core/src/work/work-executor.ts";
import { startWorkFixtureServer } from "../packages/core/src/work/work-fixture-server.ts";
import { validateWorkJob } from "../packages/core/src/work/work-job.ts";
import {
  createRecordingWorkPlanner,
  createReplayWorkPlanner,
} from "../packages/core/src/work/work-planner.ts";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/work", import.meta.url));

function op(type, extra = {}) {
  return { schema: "oneesama.work_operation.v1", type, ...extra };
}

// A deterministic planner that — like the real one — resolves refs from the
// current observation instead of hardcoding them.
function familyAPlanner(baseUrl) {
  const byRole = (observation, role, needle) =>
    observation.refs.find((ref) => ref.role === role && ref.name.includes(needle));
  return {
    id: "family_a_fixture_planner",
    async decide({ observation, steps }) {
      switch (steps.length) {
        case 0:
          return op("navigate", { value: `${baseUrl}/search.html` });
        case 1: {
          const input = byRole(observation, "textbox", "Search query");
          return op("type-text", { target: { ref: input?.ref || "" }, value: "release notes" });
        }
        case 2: {
          const button = byRole(observation, "button", "Search");
          return op("click", { target: { ref: button?.ref || "" }, rationale: "run search" });
        }
        case 3: {
          const link = byRole(observation, "link", "Release Notes");
          return op("click", { target: { ref: link?.ref || "" }, rationale: "open result" });
        }
        case 4: {
          const passage = byRole(observation, "text", "2.0 adds");
          return op("extract", {
            target: { ref: passage?.ref || "" },
            rationale: "highlight what changed",
          });
        }
        default:
          return op("done", { summary: "Fixture Product 2.0 adds offline replay." });
      }
    },
  };
}

function familyAJob(surfaceId) {
  const validation = validateWorkJob({
    id: "job_family_a_fixture",
    surfaceId,
    intent: "Find what changed in version 2.0 of Fixture Product and highlight it.",
    postConditions: [
      { kind: "url_includes", value: "release-notes" },
      { kind: "text_present", value: "offline replay" },
      { kind: "element_present", value: "What changed in 2.0" },
    ],
    riskLevel: "read_only",
    source: "fixture",
  });
  assert.equal(validation.ok, true, validation.errors.join(","));
  return validation.job;
}

test("work executor runs a family-A job against the fixture site", { timeout: 60000 }, async () => {
  const fixture = await startWorkFixtureServer(FIXTURE_DIR);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const cursorEvents = [];
  const surface = createWorkBrowserSurface({
    page,
    allowedHosts: ["127.0.0.1", "localhost"],
    onCursor: (event) => cursorEvents.push(event),
  });
  try {
    const records = [];
    const planner = createRecordingWorkPlanner(familyAPlanner(fixture.url), (record) =>
      records.push(record),
    );
    const executor = createWorkExecutor({ surface, planner, maxSteps: 8 });
    const job = familyAJob(surface.id);
    const result = await executor.run(job);

    assert.equal(result.status, "done", JSON.stringify(result, null, 2).slice(0, 1200));
    assert.equal(result.postConditions.length, 3);
    assert.ok(result.postConditions.every((entry) => entry.ok));
    assert.match(result.extracted, /offline replay/);
    assert.ok(result.steps.length >= 5);
    assert.ok(cursorEvents.some((event) => event.kind === "click"));
    assert.ok(cursorEvents.some((event) => event.kind === "target"));
    assert.ok(records.length >= 5, "planner decisions were recorded");

    // Replay gate: the recorded decisions re-run deterministically.
    await page.goto("about:blank");
    const replayExecutor = createWorkExecutor({
      surface,
      planner: createReplayWorkPlanner(records),
      maxSteps: 8,
    });
    const replayResult = await replayExecutor.run(job);
    assert.equal(replayResult.status, "done");
    assert.match(replayResult.extracted, /offline replay/);
  } finally {
    await surface.close();
    await browser.close();
    await fixture.close();
  }
});

test("work executor blocks navigation outside the allowed hosts", { timeout: 60000 }, async () => {
  const fixture = await startWorkFixtureServer(FIXTURE_DIR);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const surface = createWorkBrowserSurface({ page, allowedHosts: ["127.0.0.1"] });
  try {
    const planner = {
      id: "escape_planner",
      async decide({ steps }) {
        if (steps.length === 0) return op("navigate", { value: "http://example.com/" });
        return op("done", { summary: "should not get here" });
      },
    };
    const executor = createWorkExecutor({ surface, planner, maxSteps: 3 });
    const job = familyAJob(surface.id);
    const result = await executor.run(job);
    assert.equal(result.status, "blocked");
    assert.equal(result.blocker, "navigation_outside_allowed_hosts");
  } finally {
    await surface.close();
    await browser.close();
    await fixture.close();
  }
});
