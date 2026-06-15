import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  DIAGNOSTICS_TABS,
  diagnosticsPanelView,
  timelineRowsView,
} from "../packages/core/src/operator/web/diagnosticsPanelView.ts";

function timelineRow(index, overrides = {}) {
  return {
    id: `row_${index}`,
    at: `2026-06-11T00:00:${String(index).padStart(2, "0")}.000Z`,
    layer: "kwwk",
    event: `event_${index}`,
    ok: true,
    durationMs: index,
    turnId: null,
    responseId: null,
    blocker: null,
    detail: {},
    ...overrides,
  };
}

test("operator diagnostics panel view derives telemetry rows and recent alerts", () => {
  const view = diagnosticsPanelView(
    {
      debug: {
        transport: {
          events: { state: "open" },
          voice: { state: "connecting" },
          visual: { state: "closed" },
        },
        voice: { captureStatus: "capturing", chunksReceived: 12, forwardedChunks: 10 },
        output: { assistantAudio: { status: "playing", chunksPlayed: 4 } },
        toolRouting: {
          status: "failed",
          expectedTool: "browser",
          actualTool: "computer",
          errors: [
            { ts: "t1", error: "first" },
            { ts: "t2", error: "second" },
            { ts: "t3", error: "third" },
            { ts: "t4", error: "fourth" },
          ],
        },
        kwwk: { status: "executing", actionCount: 5 },
      },
      providerConfig: null,
      recentEvents: [{ event: "runtime_updated" }],
      snapshot: { health: "ready" },
    },
    "",
  );

  assert.deepEqual(DIAGNOSTICS_TABS, ["telemetry", "sources", "timeline", "raw"]);
  assert.equal(view.latestEventLabel, "runtime_updated");
  assert.deepEqual(
    view.telemetryRows.map((row) => [row.label, row.value]),
    [
      ["events ws", "open"],
      ["voice ws", "connecting"],
      ["visual ws", "closed"],
      ["mic", "capturing"],
      ["voice chunks", "12"],
      ["voice forwarded", "10"],
      ["assistant audio", "playing"],
      ["audio chunks", "4"],
      ["tool status", "failed"],
      ["tool", "computer"],
      ["kwwk", "executing"],
      ["kwwk actions", "5"],
    ],
  );
  assert.deepEqual(
    view.alerts.map((alert) => alert.text),
    ["second", "third", "fourth"],
  );
});

test("operator diagnostics panel view derives source rows and raw report json", () => {
  const view = diagnosticsPanelView(
    {
      debug: {
        visual: {
          sources: [
            {
              id: "screen",
              label: "Main display",
              kind: "display",
              state: "active",
              width: 1920,
              height: 1080,
              captureStatus: "capturing",
            },
            {
              id: "avatar",
              label: "",
              kind: "avatar",
              state: "ready",
              width: null,
              height: null,
              trackReadyState: "live",
            },
          ],
        },
      },
      providerConfig: { selectedTransport: "openai_realtime", providers: [] },
      recentEvents: [],
      snapshot: { health: "ready" },
    },
    "",
  );

  assert.equal(view.sourcesEmpty, false);
  assert.deepEqual(view.sources, [
    {
      id: "screen",
      label: "Main display",
      kind: "display",
      state: "active",
      sizeLabel: "1920x1080",
      statusLabel: "capturing",
    },
    {
      id: "avatar",
      label: "avatar",
      kind: "avatar",
      state: "ready",
      sizeLabel: "0x0",
      statusLabel: "live",
    },
  ]);
  assert.match(view.rawJson, /"health": "ready"/);
  assert.match(view.rawJson, /"selectedTransport": "openai_realtime"/);
});

test("operator diagnostics timeline rows filter and keep only the last forty rows", () => {
  const rows = Array.from({ length: 45 }, (_, index) =>
    timelineRow(index, {
      layer: index % 2 ? "operator" : "kwwk",
      event: index === 44 ? "target_event" : `event_${index}`,
      ok: index !== 44,
      durationMs: index === 44 ? 123 : null,
      detail: { note: index === 10 ? "match-from-detail" : "other" },
    }),
  );

  const unfiltered = timelineRowsView(rows, "");
  assert.equal(unfiltered.length, 40);
  assert.equal(unfiltered[0].key, "row_5");
  assert.equal(unfiltered.at(-1)?.key, "row_44");
  assert.deepEqual(unfiltered.at(-1), {
    key: "row_44",
    className: "bad",
    layer: "kwwk",
    event: "target_event",
    durationLabel: "123ms",
  });

  assert.deepEqual(
    timelineRowsView(rows, "target").map((row) => row.event),
    ["target_event"],
  );
  assert.deepEqual(
    timelineRowsView(rows, "match-from-detail").map((row) => row.key),
    ["row_10"],
  );
});

test("operator diagnostics panel view falls back to empty labels", () => {
  const view = diagnosticsPanelView(
    { debug: {}, providerConfig: null, recentEvents: [], snapshot: null },
    "",
  );

  assert.equal(view.latestEventLabel, "no recent event");
  assert.equal(view.sourcesEmpty, true);
  assert.deepEqual(view.sources, []);
  assert.deepEqual(view.timelineRows, []);
  assert.equal(view.telemetryRows.find((row) => row.label === "events ws")?.value, "-");
  assert.equal(view.telemetryRows.find((row) => row.label === "kwwk actions")?.value, "0");
});

test("operator diagnostics panel view can skip raw json construction", () => {
  const view = diagnosticsPanelView(
    {
      debug: { transport: { events: { state: "open" } } },
      providerConfig: { selectedTransport: "openai_realtime", providers: [] },
      recentEvents: [{ event: "runtime_updated" }],
      snapshot: { health: "ready" },
    },
    "",
    { includeRawJson: false },
  );

  assert.equal(view.rawJson, "");
  assert.equal(view.latestEventLabel, "runtime_updated");
});
