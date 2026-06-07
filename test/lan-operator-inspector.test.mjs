import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";

// A small synthetic conversation: user transcript -> assistant -> KWWK app-control tool.
const CONVO = [
  {
    type: "transcript_completed",
    turnId: "t1",
    text: "open textedit and type hello",
    ts: "2026-06-07T10:00:00.000Z",
  },
  {
    type: "assistant_text_completed",
    responseId: "r1",
    turnId: "t1",
    text: "On it — opening TextEdit now.",
    ts: "2026-06-07T10:00:01.000Z",
  },
  {
    type: "tool_call_started",
    detail: { toolName: "kwwk_click", callId: "c1" },
    ts: "2026-06-07T10:00:02.000Z",
  },
  {
    type: "tool_call_completed",
    detail: { toolName: "kwwk_click", callId: "c1" },
    ts: "2026-06-07T10:00:03.000Z",
  },
];

async function injectConversation(page, events) {
  await page.evaluate((evts) => {
    const surf = window.MAB_LAN_OPERATOR_SURFACE;
    surf.state.conversation.canonicalEvents = evts;
    surf.state.conversation.status = "connected";
    surf.state.conversation.engineId = "mock";
    window.MAB_LAN_OPERATOR_DEBUG_PANEL.renderConversationStream({
      stream: document.getElementById("operator-conversation-stream"),
      state: surf.state,
      boot: {},
    });
  }, events);
}

async function inspectorState(page) {
  return await page.evaluate(() => {
    const box = document.getElementById("operator-event-inspector");
    const ev = document.getElementById("inspector-evidence");
    const evidence = {};
    (ev ? ev.querySelectorAll(".insp-kv") : []).forEach((el) => {
      const k = el.querySelector("b")?.textContent || "";
      const v = el.querySelector("span")?.textContent || "";
      if (k) evidence[k] = v;
    });
    const next = document.getElementById("inspector-next");
    return {
      open: Boolean(box) && box.hidden === false,
      chip: document.getElementById("inspector-chip")?.textContent || "",
      owner: document.getElementById("inspector-owner")?.textContent || "",
      status: document.getElementById("inspector-status")?.textContent || "",
      evidence,
      raw: document.getElementById("inspector-raw")?.textContent || "",
      nextHidden: next?.hidden !== false,
      nextText: next?.textContent || "",
      nextBad: Boolean(next && next.className.includes("bad")),
      rowCount: document.querySelectorAll("#operator-conversation-stream .tl-row").length,
      selectedCount: document.querySelectorAll("#operator-conversation-stream .tl-row.selected")
        .length,
    };
  });
}

test("LAN operator selected-event inspector: click ledger row / pipeline stage shows evidence; full ledger stays intact", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-inspector-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });

    await injectConversation(page, CONVO);

    // Full ledger is intact (3 grouped rows: user / assistant / tool) and inspector starts closed.
    let s = await inspectorState(page);
    assert.equal(s.rowCount, 3, JSON.stringify(s));
    assert.equal(s.open, false, JSON.stringify(s));
    assert.equal(s.selectedCount, 0, JSON.stringify(s));

    // Click the first ledger row (the user transcript) → inspector opens with contextual evidence.
    await page.locator("#operator-conversation-stream .tl-row").first().click();
    s = await inspectorState(page);
    assert.equal(s.open, true, JSON.stringify(s));
    assert.equal(s.chip, "transcript", JSON.stringify(s));
    assert.equal(s.owner, "you", JSON.stringify(s));
    assert.equal(s.evidence.stage, "transcript", JSON.stringify(s));
    assert.match(s.raw, /transcript_completed/, JSON.stringify(s));
    // Selecting an event must NOT collapse the full event list.
    assert.equal(s.rowCount, 3, JSON.stringify(s));
    assert.equal(s.selectedCount, 1, JSON.stringify(s));

    // Click the "app" pipeline stage → jumps to + selects the KWWK app-control tool evidence.
    await page.click('.verdict-pipeline .stage[data-stage="app"]');
    s = await inspectorState(page);
    assert.equal(s.open, true, JSON.stringify(s));
    assert.equal(s.chip, "app-control", JSON.stringify(s));
    assert.equal(s.owner, "kwwk_click", JSON.stringify(s));
    assert.equal(s.evidence.stage, "app", JSON.stringify(s));
    assert.equal(s.evidence["call/item"], "c1", JSON.stringify(s));
    assert.equal(s.selectedCount, 1, JSON.stringify(s));
    assert.equal(s.rowCount, 3, JSON.stringify(s));

    // Re-clicking the selected row toggles the selection off → inspector closes.
    await page.locator("#operator-conversation-stream .tl-row.selected").click();
    s = await inspectorState(page);
    assert.equal(s.open, false, JSON.stringify(s));
    assert.equal(s.selectedCount, 0, JSON.stringify(s));
    assert.equal(s.rowCount, 3, JSON.stringify(s));
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator inspector surfaces a fault hint for an errored event", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-inspector-error-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });

    await injectConversation(page, [
      {
        type: "transcript_completed",
        turnId: "t9",
        text: "click the save button",
        ts: "2026-06-07T11:00:00.000Z",
      },
      {
        type: "tool_call_started",
        detail: { toolName: "kwwk_click", callId: "c9" },
        ts: "2026-06-07T11:00:01.000Z",
        error: "kwwk mutation failed: target not found",
      },
    ]);

    // Select the errored tool row (last row) → inspector shows a blocked fault hint.
    await page.locator("#operator-conversation-stream .tl-row").last().click();
    const s = await inspectorState(page);
    assert.equal(s.open, true, JSON.stringify(s));
    assert.equal(s.nextHidden, false, JSON.stringify(s));
    assert.equal(s.nextBad, true, JSON.stringify(s));
    assert.match(s.nextText, /mutation failed|blocked/, JSON.stringify(s));
  } finally {
    await browser.close();
    await surface.close();
  }
});
