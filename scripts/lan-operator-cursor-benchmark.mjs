#!/usr/bin/env node
// Rendered-pixel proof for the operator-stage KWWK cursor (Phase 3b cursor-parity).
//
// Loads the Local Operator surface, runs the pointer click/drag fixture, and
// proves the Cueboard-standard cursor actually renders to the composition canvas
// by diffing canvas pixels before/after the fixture (not by trusting telemetry).
// Also checks the cursor artifact (drag trail >= 2 points + click + drag events).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { chromium } from "playwright";

import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";

const DEFAULT_JSON_OUT = "/tmp/oneesama-realtime-local-operator-cursor-latest.json";
// The cursor (arrow + ring + drag trail + label) is small vs the full 1280x720
// canvas; require a clear, non-trivial rendered footprint.
const MIN_RENDERED_RATIO = 0.0008;
const MIN_TRAIL_POINTS = 2;

function parseArgs(argv) {
  const args = { jsonOut: DEFAULT_JSON_OUT, screenshot: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json-out") args.jsonOut = argv[++i];
    else if (arg === "--screenshot") args.screenshot = argv[++i];
    else if (arg === "--help") {
      process.stdout.write(
        "Usage: lan-operator-cursor-benchmark [--json-out <path>] [--screenshot <path>]\n",
      );
      process.exit(0);
    }
  }
  return args;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-cursor-benchmark",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];
  let measurement = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });

    measurement = await page.evaluate(async () => {
      const canvas = document.getElementById("composition");
      const ctx = canvas.getContext("2d");
      const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
      // Let the source composition settle, then snapshot the baseline.
      await raf();
      await raf();
      const before = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      // Drive the pointer fixture (approach → click → drag trail → done).
      window.MAB_LAN_OPERATOR_SURFACE.runKwwkCursorFixture({ animated: false });
      await raf();
      await raf();
      const after = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let changed = 0;
      for (let i = 0; i < before.length; i += 4) {
        const delta =
          Math.abs(after[i] - before[i]) +
          Math.abs(after[i + 1] - before[i + 1]) +
          Math.abs(after[i + 2] - before[i + 2]);
        if (delta > 36) changed += 1;
      }
      const total = before.length / 4;
      const artifact = window.MAB_LAN_OPERATOR_KWWK_CURSOR.artifact();
      const eventKinds = artifact.events.map((e) => e.kind);
      return {
        canvas: { width: canvas.width, height: canvas.height },
        changedPixels: changed,
        totalPixels: total,
        renderedRatio: changed / total,
        trailPoints: artifact.trail.length,
        eventKinds,
        hasClick: eventKinds.includes("cursor.click"),
        hasDrag: eventKinds.includes("cursor.drag"),
        styles: artifact.styles,
        latestVisible: artifact.latest.visible,
      };
    });

    if (args.screenshot) await page.screenshot({ path: args.screenshot });
  } finally {
    await browser.close();
    await surface.close();
  }

  const pixelOk = Boolean(measurement) && measurement.renderedRatio >= MIN_RENDERED_RATIO;
  const trailOk = Boolean(measurement) && measurement.trailPoints >= MIN_TRAIL_POINTS;
  const eventsOk = Boolean(measurement) && measurement.hasClick && measurement.hasDrag;
  const stylesOk =
    Boolean(measurement) &&
    measurement.styles?.dragTrail === true &&
    measurement.styles?.clickPulse === true &&
    measurement.styles?.targetRing === true;
  const consoleOk = consoleErrors.length === 0;
  const functionalOk = trailOk && eventsOk && stylesOk && consoleOk;
  const ok = pixelOk && functionalOk;

  const report = {
    ok,
    functionalOk,
    pixelOk,
    gate: "local_operator_cursor",
    thresholds: { minRenderedRatio: MIN_RENDERED_RATIO, minTrailPoints: MIN_TRAIL_POINTS },
    measurement,
    checks: { pixelOk, trailOk, eventsOk, stylesOk, consoleOk },
    consoleErrors,
    jsonOut: args.jsonOut,
  };
  await writeJson(args.jsonOut, report);
  process.stdout.write(`${JSON.stringify({ ...report, measurement: undefined }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
