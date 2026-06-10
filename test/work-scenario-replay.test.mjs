import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import { createWorkBrowserSurface } from "../packages/core/src/work/work-browser-surface.ts";
import { createWorkExecutor } from "../packages/core/src/work/work-executor.ts";
import { startWorkFixtureServer } from "../packages/core/src/work/work-fixture-server.ts";
import { createReplayWorkPlanner } from "../packages/core/src/work/work-planner.ts";
import {
  parseWorkPlannerRecords,
  validateWorkScenario,
} from "../packages/core/src/work/work-scenario.ts";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/work", import.meta.url));
const SCENARIOS_DIR = join(FIXTURES_DIR, "scenarios");
const RECORDINGS_DIR = join(FIXTURES_DIR, "recordings");

// D9 gate 1: every committed scenario must replay its recorded plan to a
// verified "done" — any failure here is a plumbing bug, never the model.
test("all committed work scenarios replay deterministically", { timeout: 120000 }, async () => {
  const files = readdirSync(SCENARIOS_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort();
  assert.ok(files.length >= 5, `expected >=5 scenarios, found ${files.length}`);

  const fixture = await startWorkFixtureServer(FIXTURES_DIR);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const file of files) {
      const validation = validateWorkScenario(
        JSON.parse(readFileSync(join(SCENARIOS_DIR, file), "utf8")),
      );
      assert.equal(validation.ok, true, `${file}: ${validation.errors.join(",")}`);
      const scenario = validation.scenario;
      const records = parseWorkPlannerRecords(
        readFileSync(join(RECORDINGS_DIR, `${scenario.id}.json`), "utf8"),
        fixture.url,
      );
      const page = await browser.newPage();
      const surface = createWorkBrowserSurface({
        page,
        surfaceId: scenario.job.surfaceId,
        allowedHosts: ["127.0.0.1", "localhost"],
      });
      try {
        const executor = createWorkExecutor({
          surface,
          planner: createReplayWorkPlanner(records),
          maxSteps: 10,
        });
        const result = await executor.run(scenario.job);
        assert.equal(
          result.status,
          "done",
          `${scenario.id}: ${result.status} blocker=${result.blocker}`,
        );
        assert.ok(
          result.postConditions.every((entry) => entry.ok),
          `${scenario.id} post-conditions`,
        );
      } finally {
        await surface.close().catch(() => {});
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
});
