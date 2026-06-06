import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";

async function waitForRuntimeStatus(url, predicate, timeoutMs = 5_000) {
  const statusUrl = new URL("/runtime/status", url);
  const started = Date.now();
  let lastBody = null;
  while (Date.now() - started < timeoutMs) {
    const body = await (await fetch(statusUrl)).json();
    lastBody = body;
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runtime_status_timeout: ${JSON.stringify(lastBody)}`);
}

test("LAN operator surface renders KWWK verification evidence", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-kwwk-verification",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true);
    await page.evaluate(() => {
      window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState({
        jobId: "kwwk_verify_job",
        status: "verifying",
        timings: { verifyMs: 29 },
        phaseEvidence: {
          plan: { status: "planned", summary: "press_key", detail: { provider: "fixture" } },
          execute: {
            status: "executed",
            summary: "1/1 actions succeeded",
            detail: { executionSurface: "kwwk_core" },
          },
        },
        verification: {
          ok: false,
          status: "failed",
          blocker: "failed_verification",
          checks: [
            { name: "post_state_observed", passed: true },
            { name: "window_title_contains", passed: false },
          ],
        },
      });
    });

    const body = await waitForRuntimeStatus(url, (nextBody) =>
      nextBody.debug.timeline.rows.some((row) => row.event === "kwwk_verifying"),
    );
    assert.equal(body.debug.kwwk.verification.status, "failed");
    assert.equal(body.debug.kwwk.verification.failedCheckCount, 1);
    assert.equal(body.debug.kwwk.phaseEvidence.plan.detail.provider, "fixture");
    assert.equal(body.debug.kwwk.currentJobId, "kwwk_verify_job");
    assert.ok(
      body.debug.kwwk.verification.checks.some(
        (check) => check.name === "window_title_contains" && check.passed === false,
      ),
      JSON.stringify(body.debug.kwwk.verification),
    );
    assert.ok(
      body.debug.timeline.rows.some(
        (row) =>
          row.detail.verification?.failedCheckCount === 1 &&
          row.detail.phaseEvidence?.plan?.summary === "press_key",
      ),
      JSON.stringify(body.debug.timeline),
    );

    const kwwkSection = await page.locator("#debug-kwwk-table").count();
    assert.equal(kwwkSection, 1);
  } finally {
    await browser.close();
    await surface.close();
  }
});
