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

test("LAN operator surface exposes explicit Conversation Engine connect and disconnect controls", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-engine-lifecycle-smoke",
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
    await page.evaluate(() => {
      window.MAB_LAN_OPERATOR_SURFACE.sendEngineControl("connect");
      window.MAB_LAN_OPERATOR_SURFACE.sendEngineControl("disconnect");
      window.MAB_LAN_OPERATOR_SURFACE.sendEngineControl("connect");
    });

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) =>
        nextBody.debug.conversation.control.commandCounts.connect >= 2 &&
        nextBody.debug.conversation.control.commandCounts.disconnect >= 1 &&
        nextBody.debug.conversation.eventCounts.engine_disconnected >= 1 &&
        nextBody.debug.conversation.control.inFlight === 0,
    );

    assert.equal(body.debug.conversation.status, "connected");
    assert.equal(body.debug.conversation.control.lastCommand, "connect");
    assert.equal(body.debug.conversation.control.lastResult, "ok");
    assert.ok(
      body.debug.timeline.rows.some((row) => row.event === "engine_disconnected"),
      JSON.stringify(body.debug.timeline),
    );
    assert.ok(
      body.recentEvents.some((event) => event.event === "engine_control_completed"),
      JSON.stringify(body.recentEvents),
    );
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator voice arm and mute changes are Conversation Engine controls", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-voice-mode-control-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  try {
    const context = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 1366, height: 860 },
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });
    await page.evaluate(async () => {
      const result = await window.MAB_LAN_OPERATOR_SURFACE.startMicrophone();
      return { ok: result?.ok === true };
    });

    const armed = await waitForRuntimeStatus(
      url,
      (body) =>
        body.debug.voice.armed === true &&
        body.debug.conversation.control.commandCounts.set_voice_armed >= 1 &&
        body.debug.conversation.control.inFlight === 0,
      10_000,
    );
    assert.equal(armed.debug.conversation.status, "connected");
    assert.equal(armed.debug.conversation.control.lastCommand, "set_voice_armed");
    assert.equal(armed.debug.conversation.control.lastDetail.armed, true);

    await page.evaluate(() => window.MAB_LAN_OPERATOR_SURFACE.setVoiceMuted(true));
    const muted = await waitForRuntimeStatus(
      url,
      (body) =>
        body.debug.voice.muted === true &&
        body.debug.conversation.control.commandCounts.set_voice_muted >= 1 &&
        body.debug.conversation.control.inFlight === 0,
    );
    assert.equal(muted.debug.conversation.control.lastCommand, "set_voice_muted");
    assert.equal(muted.debug.conversation.control.lastDetail.muted, true);

    await page.evaluate(() => window.MAB_LAN_OPERATOR_SURFACE.setVoiceMuted(false));
    const unmuted = await waitForRuntimeStatus(
      url,
      (body) =>
        body.debug.voice.muted === false &&
        body.debug.conversation.control.lastDetail?.muted === false,
    );
    assert.equal(unmuted.debug.conversation.control.commandCounts.set_voice_muted, 2);

    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.stopMicrophone("voice_mode_control_done"),
    );
    const disarmed = await waitForRuntimeStatus(
      url,
      (body) =>
        body.debug.voice.armed === false &&
        body.debug.conversation.control.commandCounts.set_voice_armed >= 2 &&
        body.debug.conversation.control.lastDetail?.armed === false,
    );
    assert.equal(disarmed.debug.conversation.control.lastCommand, "set_voice_armed");
    assert.match(
      await page.evaluate(
        () => document.getElementById("debug-conversation-table")?.innerText || "",
      ),
      /Control detail/,
    );
    await context.close();
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator tool cancel delivers a cancelled tool result through the Conversation Engine Port", async () => {
  const receivedToolResults = [];
  const conversationEngine = {
    id: "tool_cancel_test_engine",
    receiveVoiceChunk: (chunk) => {
      const ts = new Date().toISOString();
      return {
        result: { ok: true, engineId: "tool_cancel_test_engine" },
        events: [
          {
            id: "tool_cancel_started",
            ts,
            sessionId: chunk.sessionId,
            type: "tool_call_started",
            engineId: "tool_cancel_test_engine",
            turnId: "turn_tool_cancel",
            itemId: "item_tool_cancel",
            detail: {
              expectedTool: "kwwk_computer_use",
              name: "kwwk_computer_use",
              callId: "call_tool_cancel",
            },
          },
          {
            id: "tool_cancel_completed",
            ts,
            sessionId: chunk.sessionId,
            type: "tool_call_completed",
            engineId: "tool_cancel_test_engine",
            turnId: "turn_tool_cancel",
            itemId: "item_tool_cancel",
            text: JSON.stringify({ instruction: "stop the current action", appHint: "Chrome" }),
            detail: {
              expectedTool: "kwwk_computer_use",
              name: "kwwk_computer_use",
              callId: "call_tool_cancel",
            },
          },
        ],
      };
    },
    receiveToolResult: (input) => {
      receivedToolResults.push(input);
      return {
        result: { ok: true, engineId: "tool_cancel_test_engine", accepted: true },
        events: [
          {
            id: "tool_cancel_result",
            ts: new Date().toISOString(),
            sessionId: input.sessionId,
            type: "tool_result_accepted",
            engineId: "tool_cancel_test_engine",
            turnId: input.turnId,
            itemId: input.itemId,
            text: JSON.stringify(input.output),
            detail: { callId: input.callId, name: input.toolName, status: input.status },
          },
        ],
      };
    },
  };
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-tool-cancel-smoke",
    botName: "LAN Oneesama",
    conversationEngine,
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });
    await page.evaluate(() => {
      window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({ sequence: 1 });
      window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState({
        turnId: "turn_tool_cancel",
        jobId: "kwwk_tool_cancel_job",
        status: "executing",
        action: { kind: "click", label: "slow click", status: "running" },
      });
    });
    await waitForRuntimeStatus(url, (body) => body.debug.toolRouting.callId === "call_tool_cancel");
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.cancelTool({ reason: "operator_cancelled" }),
    );

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) =>
        nextBody.debug.toolRouting.cancel.lastResult === "delivered" &&
        nextBody.debug.toolRouting.functionOutputDelivered === true &&
        nextBody.debug.kwwk.status === "cancelled",
    );

    assert.equal(receivedToolResults.length, 1);
    assert.equal(receivedToolResults[0].callId, "call_tool_cancel");
    assert.equal(receivedToolResults[0].status, "cancelled");
    assert.equal(receivedToolResults[0].output.cancelled, true);
    assert.equal(body.debug.toolRouting.cancel.requestedCount, 1);
    assert.equal(body.debug.toolRouting.cancel.lastCallId, "call_tool_cancel");
    assert.equal(body.debug.toolRouting.cancel.lastJobId, "kwwk_tool_cancel_job");
    assert.equal(body.debug.toolRouting.cancel.lastReason, "operator_cancelled");
    assert.equal(body.debug.kwwk.blocker, "operator_cancelled");
    assert.ok(
      body.debug.timeline.rows.some((row) => row.event === "tool_cancel_requested"),
      JSON.stringify(body.debug.timeline),
    );
    assert.ok(
      body.recentEvents.some((event) => event.event === "tool_cancel_delivered"),
      JSON.stringify(body.recentEvents),
    );
    await page.waitForFunction(() =>
      document
        .getElementById("debug-tool-routing-table")
        ?.innerText.includes("delivered / operator_cancelled"),
    );
    assert.match(
      await page.evaluate(
        () => document.getElementById("debug-tool-routing-table")?.innerText || "",
      ),
      /Cancel\s+delivered \/ operator_cancelled/,
    );
  } finally {
    await browser.close();
    await surface.close();
  }
});
