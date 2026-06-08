/* eslint-disable max-lines */
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import {
  buildLanOperatorRuntimeSessionConfig,
  createLanOperatorSurfaceServer,
} from "../packages/core/src/operator/lan-operator-surface.ts";
import { validateRuntimeSessionConfig } from "../packages/core/src/avatar-runtime/contracts.ts";

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

test("LAN operator surface config declares always-on voice and operator composition", () => {
  const config = buildLanOperatorRuntimeSessionConfig({
    sessionId: "lan-operator-contract-test",
    botName: "LAN Oneesama",
  });
  const validation = validateRuntimeSessionConfig(config);

  assert.equal(validation.ok, true);
  assert.equal(validation.config.surfaceKind, "lan_operator");
  assert.equal(validation.config.conversationTransport, "mock");
  assert.deepEqual(validation.config.inputPolicy.audioInputs, ["local_mic"]);
  assert.equal(validation.config.inputPolicy.continuousMic, true);
  assert.equal(validation.config.inputPolicy.pushToTalk, false);
  assert.deepEqual(validation.config.outputPolicy.videoOutputs, ["dom_canvas", "capture_track"]);
  assert.equal(validation.config.outputPolicy.allowLocalSpeaker, true);
  assert.ok(
    validation.config.capabilities.some(
      (capability) => capability.name === "operator_visual_composition",
    ),
  );
  assert.ok(validation.config.capabilities.some((capability) => capability.name === "debug_panel"));
});

test("LAN operator surface can select OpenAI Realtime live transport", () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-openai-config-test",
    conversationTransport: "openai_realtime",
  });
  const status = surface.status();

  assert.equal(surface.config.conversationTransport, "openai_realtime");
  assert.equal(status.debug.conversation.engineId, "openai_realtime");
});

test("LAN operator surface serves /operator as the Local Operator app entrypoint", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-url-entrypoint",
    botName: "Oneesama",
  });
  const { url } = await surface.listen();
  try {
    const response = await fetch(new URL("/operator", url));
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Oneesama Local Operator Surface/);
    assert.match(html, /MAB_LAN_OPERATOR_SURFACE/);
  } finally {
    await surface.close();
  }
});

test("LAN operator surface serves local avatar video assets for foreground preset switches", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-avatar-asset-route",
    botName: "Oneesama",
  });
  const { url } = await surface.listen();
  try {
    const response = await fetch(
      new URL("/assets/avatar/v1-green/oneesama-video-idle-loop-subtle.mp4", url),
    );
    const bytes = await response.arrayBuffer();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /video\/mp4/);
    assert.ok(bytes.byteLength > 1024);
  } finally {
    await surface.close();
  }
});

test("LAN operator surface exposes voice controls and optional local VAD telemetry", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-voice-controls",
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

    const initial = await page.evaluate(async () => {
      await window.MAB_LAN_OPERATOR_SURFACE.refreshVoiceDevices();
      const defaultVadEnabled = window.MAB_LAN_OPERATOR_SURFACE.state.voiceLocalVad.enabled;
      const disabledVad = window.MAB_LAN_OPERATOR_SURFACE.configureLocalVad(false);
      return {
        armed: window.MAB_LAN_OPERATOR_SURFACE.state.voiceArmed,
        muted: window.MAB_LAN_OPERATOR_SURFACE.state.voiceMuted,
        deviceSelect: Boolean(document.getElementById("voice-device-select")),
        armText: document.getElementById("voice-button")?.innerText,
        defaultVadEnabled,
        disabledVadEnabled: disabledVad.enabled,
      };
    });

    assert.deepEqual(
      {
        armed: initial.armed,
        muted: initial.muted,
        deviceSelect: initial.deviceSelect,
        armText: initial.armText,
        defaultVadEnabled: initial.defaultVadEnabled,
        disabledVadEnabled: initial.disabledVadEnabled,
      },
      {
        armed: false,
        muted: false,
        deviceSelect: true,
        armText: "Arm",
        defaultVadEnabled: false,
        disabledVadEnabled: false,
      },
    );
    const body = await waitForRuntimeStatus(
      url,
      (nextBody) => nextBody.debug.voice.localVad.enabled === false,
    );
    assert.equal(body.debug.voice.armed, false);
    assert.equal(body.debug.voice.localVad.role, "disabled");
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator surface sends typed debug text through the Conversation Engine Port", async () => {
  const receivedTextInputs = [];
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-text-input-smoke",
    botName: "LAN Oneesama",
    conversationEngine: {
      id: "typed_text_test_engine",
      receiveVoiceChunk: () => ({
        result: { ok: true, engineId: "typed_text_test_engine" },
        events: [],
      }),
      receiveTextInput: (input) => {
        receivedTextInputs.push(input);
        const ts = new Date().toISOString();
        return {
          result: {
            ok: true,
            engineId: "typed_text_test_engine",
            accepted: true,
            inputMode: "text",
          },
          events: [
            {
              id: "typed_text_engine_connected",
              ts,
              sessionId: input.sessionId,
              type: "engine_connected",
              engineId: "typed_text_test_engine",
              detail: { inputMode: "text", source: input.source },
            },
            {
              id: "typed_text_transcript_completed",
              ts,
              sessionId: input.sessionId,
              type: "transcript_completed",
              engineId: "typed_text_test_engine",
              turnId: "turn_typed_text",
              text: input.text,
              detail: { inputMode: "text", inputId: input.id, source: input.source },
            },
            {
              id: "typed_text_assistant_completed",
              ts,
              sessionId: input.sessionId,
              type: "assistant_text_completed",
              engineId: "typed_text_test_engine",
              turnId: "turn_typed_text",
              responseId: "response_typed_text",
              text: `typed response: ${input.text}`,
              detail: { inputMode: "text", inputId: input.id },
            },
          ],
        };
      },
    },
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });
    const sendResult = await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.sendTextInput("debug typed hello"),
    );
    assert.equal(sendResult.ok, true);

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) =>
        nextBody.debug.conversation.eventCounts.transcript_completed >= 1 &&
        nextBody.debug.conversation.eventCounts.assistant_text_completed >= 1,
    );
    const turn = body.debug.timeline.turns.find((entry) => entry.turnId === "turn_typed_text");
    const panel = await page.evaluate(() => ({
      input: Boolean(document.getElementById("operator-text-input")),
      sendButton: Boolean(document.getElementById("operator-text-send-button")),
      modeStatus: document.getElementById("operator-realtime-mode-status")?.textContent || "",
      connectHidden: document.getElementById("operator-realtime-connect-button")?.hidden ?? null,
    }));

    assert.equal(receivedTextInputs.length, 1);
    assert.equal(receivedTextInputs[0].text, "debug typed hello");
    assert.equal(receivedTextInputs[0].source, "operator_text_input");
    assert.equal(
      receivedTextInputs[0].surfaceContext.schema,
      "oneesama.lan_operator_surface_context.v1",
    );
    assert.equal(receivedTextInputs[0].surfaceContext.surfaceKind, "lan_operator");
    assert.equal(receivedTextInputs[0].surfaceContext.visual.focusedSourceId, "host-app");
    assert.equal(receivedTextInputs[0].surfaceContext.clientContext.focusedSourceId, "host-app");
    assert.equal(body.debug.conversation.engineId, "typed_text_test_engine");
    assert.equal(body.debug.surfaceContext.schema, "oneesama.lan_operator_surface_context.v1");
    assert.equal(body.debug.conversation.eventCounts.speech_started || 0, 0);
    assert.equal(turn.milestones.heard, false);
    assert.equal(turn.milestones.speechStarted, false);
    assert.equal(turn.milestones.transcript, true);
    assert.equal(turn.milestones.output, true);
    assert.equal(turn.status, "completed");
    assert.equal(panel.input, true);
    assert.equal(panel.sendButton, true);
    assert.match(panel.modeStatus, /mock typed_text_test_engine/);
    assert.equal(panel.connectHidden, true);
    assert.ok(
      body.recentEvents.some((event) => event.event === "operator_text_input_completed"),
      JSON.stringify(body.recentEvents),
    );

    const reportBody = await (await fetch(new URL("/runtime/report", url))).json();
    assert.equal(reportBody.report.summaries.conversationTurn.userTranscript, "debug typed hello");
    assert.equal(
      reportBody.report.summaries.conversationTurn.assistantTranscript,
      "typed response: debug typed hello",
    );
    assert.equal(reportBody.report.summaries.turns.latest.milestones.heard, false);
    assert.equal(reportBody.report.summaries.surfaceContext.visual.focusedSourceId, "host-app");
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator web app exposes live Realtime text connect without browser key handling", async () => {
  const controls = [];
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-live-text-web-control",
    botName: "LAN Oneesama",
    conversationTransport: "openai_realtime",
    conversationEngine: {
      id: "openai_realtime_ui_test",
      receiveVoiceChunk: () => ({
        result: { ok: true, engineId: "openai_realtime_ui_test" },
        events: [],
      }),
      receiveTextInput: () => ({
        result: { ok: true, engineId: "openai_realtime_ui_test", accepted: true },
        events: [],
      }),
      control: (command) => {
        controls.push(command);
        const ts = new Date().toISOString();
        return {
          result: { ok: true, engineId: "openai_realtime_ui_test", control: command.type },
          events: [
            {
              id: "openai_realtime_ui_test_connected",
              ts,
              sessionId: command.sessionId,
              type: "engine_connected",
              engineId: "openai_realtime_ui_test",
              detail: { inputMode: "text", source: "operator_text_input" },
            },
          ],
        };
      },
    },
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });
    const before = await page.evaluate(() => ({
      status: document.getElementById("operator-realtime-mode-status")?.textContent || "",
      title: document.getElementById("operator-realtime-mode-status")?.getAttribute("title") || "",
      hidden: document.getElementById("operator-realtime-connect-button")?.hidden ?? null,
      disabled: document.getElementById("operator-realtime-connect-button")?.disabled ?? null,
      button: document.getElementById("operator-realtime-connect-button")?.textContent || "",
    }));
    assert.match(before.status, /live openai_realtime_ui_test (ready|connected)/);
    assert.match(before.title, /OpenAI Realtime engine: openai_realtime_ui_test/);
    assert.equal(before.hidden, false);
    assert.equal(before.disabled, false);
    assert.match(before.button, /^(Connect|Reconnect)$/);

    await page.click("#operator-realtime-connect-button");
    const body = await waitForRuntimeStatus(
      url,
      (nextBody) => nextBody.debug.conversation.control.lastCommand === "connect",
    );
    const after = await page.waitForFunction(
      () => {
        const status = document.getElementById("operator-realtime-mode-status")?.textContent || "";
        const button =
          document.getElementById("operator-realtime-connect-button")?.textContent || "";
        return /live openai_realtime_ui_test connected/.test(status) && button === "Reconnect"
          ? { status, button }
          : false;
      },
      null,
      { timeout: 5_000 },
    );
    const afterValue = await after.jsonValue();

    const connectCommand = controls.find(
      (command) => command.reason === "operator_realtime_text_connect",
    );
    assert.ok(connectCommand, JSON.stringify(controls));
    assert.equal(connectCommand.type, "connect");
    assert.equal(connectCommand.detail.inputMode, "text");
    assert.equal(connectCommand.detail.source, "operator_text_input");
    assert.equal(body.debug.surfaceContext.operatorMode.conversationTransport, "openai_realtime");
    assert.equal(afterValue.button, "Reconnect");
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator surface reports transport reconnect state", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-reconnect-smoke",
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
    await page.waitForFunction(
      () => window.MAB_LAN_OPERATOR_SURFACE.state.transport.voice.state === "open",
      null,
      { timeout: 5_000 },
    );
    const firstStream = await page.evaluate(
      () => window.MAB_LAN_OPERATOR_SURFACE.state.voiceStreamId,
    );

    await page.evaluate(() => window.MAB_LAN_OPERATOR_SURFACE.forceCloseTransport("voice"));

    await page.waitForFunction(
      () =>
        window.MAB_LAN_OPERATOR_SURFACE.state.transport.voice.reconnectCount >= 1 &&
        window.MAB_LAN_OPERATOR_SURFACE.state.transport.voice.state === "open",
      null,
      { timeout: 10_000 },
    );
    await page.evaluate((streamId) => {
      window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({
        sequence: 1,
        voiceStreamId: streamId,
      });
      window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({ sequence: 2 });
    }, firstStream);
    const body = await waitForRuntimeStatus(
      url,
      (nextBody) =>
        nextBody.debug.transport.voice.reconnectCount >= 1 &&
        nextBody.debug.transport.voice.connectCount >= 2 &&
        nextBody.debug.voice.staleChunksRejected >= 1 &&
        nextBody.debug.voice.chunksReceived >= 1,
      10_000,
    );
    assert.equal(body.debug.transport.voice.state, "open");
    assert.equal(
      [body.debug.voice.chunksReceived, body.debug.voice.staleChunksRejected].join("/"),
      "1/1",
    );
    assert.notEqual(body.debug.voice.activeStreamId, firstStream);
    assert.ok(body.debug.transport.voice.lastConnectedAt);
    assert.ok(body.debug.transport.voice.lastDisconnectedAt);
    assert.ok(
      body.debug.timeline.rows.some(
        (row) => row.layer === "transport" && row.event.includes("voice"),
      ),
      JSON.stringify(body.debug.timeline),
    );
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator surface exposes debug state for composition, overlay, and voice chunks", async () => {
  const forwarded = [];
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-smoke",
    botName: "LAN Oneesama",
    handleVoiceChunk: async (chunk) => {
      forwarded.push(chunk);
      return { ok: true };
    },
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1366, height: 860 },
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });

    const initial = await page.evaluate(() => ({
      ready: window.MAB_LAN_OPERATOR_SURFACE.state.ready,
      voiceWsState: window.MAB_LAN_OPERATOR_SURFACE.state.voiceWsState,
      eventWsState: window.MAB_LAN_OPERATOR_SURFACE.state.eventsWsState,
      composition: window.MAB_LAN_OPERATOR_SURFACE.currentComposition(),
      sourceCount: window.MAB_LAN_OPERATOR_SURFACE.state.sources.length,
    }));

    assert.equal(initial.ready, true);
    assert.equal(initial.voiceWsState, "open");
    assert.equal(initial.eventWsState, "open");
    assert.equal(initial.composition.localComposedTrack, true);
    assert.ok(initial.composition.localComposedStreamId, JSON.stringify(initial.composition));
    assert.ok(initial.composition.trackId, JSON.stringify(initial.composition));
    assert.equal(initial.composition.trackKind, "video");
    assert.equal(initial.composition.trackReadyState, "live");
    assert.equal(initial.composition.width, 1280);
    assert.equal(initial.composition.height, 720);
    assert.equal(initial.composition.targetFps, 30);
    assert.equal(initial.sourceCount, 2);

    const result = await page.evaluate(() => {
      window.MAB_LAN_OPERATOR_SURFACE.moveSource("avatar", {
        x: 0.58,
        y: 0.42,
        width: 0.28,
        height: 0.38,
      });
      window.MAB_LAN_OPERATOR_SURFACE.emitKwwkOverlay({
        sourceId: "host-app",
        kind: "click",
        x: 0.45,
        y: 0.52,
        label: "KWWK click",
      });
      return window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({
        sequence: 1,
        sampleRate: 24000,
        channels: 1,
        durationMs: 20,
        energy: 0.42,
      });
    });
    assert.equal(result, true);

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) =>
        nextBody.debug.voice.chunksReceived >= 1 &&
        nextBody.debug.voice.forwardedChunks >= 1 &&
        nextBody.debug.voice.ackCount >= 1 &&
        nextBody.debug.conversation.eventCounts.speech_started >= 1 &&
        nextBody.debug.visual.composition.overlayCount >= 1 &&
        nextBody.debug.visual.composition.layoutRevision >= 1 &&
        nextBody.debug.visual.composition.trackReadyState === "live" &&
        nextBody.debug.visual.composition.renderedFrameCount > 0,
    );
    const clientCanonicalEvents = await page.waitForFunction(
      () =>
        (window.MAB_LAN_OPERATOR_SURFACE.state.canonicalEvents || []).some(
          (event) => event.type === "speech_started",
        ),
      null,
      { timeout: 5_000 },
    );

    assert.equal(body.ok, true);
    assert.equal(body.snapshot.surfaceKind, "lan_operator");
    assert.equal(body.debug.voice.chunksReceived, 1);
    assert.equal(body.debug.voice.forwardedChunks, 1);
    assert.equal(body.debug.voice.lastSequence, 1);
    assert.equal(body.debug.voice.sampleRate, 24000);
    assert.ok(
      body.debug.voice.lastChunkSentAt &&
        body.debug.voice.lastChunkReceivedAt &&
        body.debug.voice.lastReceiveLagMs != null &&
        body.debug.voice.maxReceiveLagMs != null &&
        body.debug.voice.lastReceiveLagMs >= 0,
      JSON.stringify(body.debug.voice),
    );
    assert.ok(
      body.debug.voice.ackCount >= 1 &&
        body.debug.voice.lastAckRttMs != null &&
        body.debug.voice.lastAckRttMs >= 0,
      JSON.stringify(body.debug.voice),
    );
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].source, "synthetic_pcm16");
    assert.equal(forwarded[0].bytes, 4);
    assert.ok(
      forwarded[0].sentAt && forwarded[0].receivedAt && forwarded[0].receiveLagMs != null,
      JSON.stringify(forwarded[0]),
    );
    assert.equal(forwarded[0].surfaceContext.schema, "oneesama.lan_operator_surface_context.v1");
    assert.equal(forwarded[0].surfaceContext.surfaceKind, "lan_operator");
    assert.equal(forwarded[0].surfaceContext.visual.focusedSourceId, "avatar");
    assert.equal(forwarded[0].surfaceContext.composition.layoutRevision, 1);
    assert.equal(forwarded[0].surfaceContext.composition.localComposedTrack, true);
    assert.equal(body.debug.conversation.status, "connected");
    assert.equal(body.debug.conversation.eventCounts.engine_connected, 1);
    assert.equal(body.debug.conversation.eventCounts.speech_started, 1);
    assert.equal(body.debug.conversation.eventCounts.transcript_delta, 1);
    const voiceTurn = body.debug.timeline.turns.find(
      (turn) => turn.turnId === body.debug.timeline.currentTurnId,
    );
    assert.ok(voiceTurn, JSON.stringify(body.debug.timeline));
    assert.equal(voiceTurn.milestones.heard, true);
    assert.equal(voiceTurn.milestones.speechStarted, true);
    assert.equal(voiceTurn.milestones.transcript, true);
    assert.equal(voiceTurn.status, "active");
    assert.equal(await clientCanonicalEvents.jsonValue(), true);
    assert.ok(
      body.debug.timeline.rows.some(
        (row) => row.event === "operator_voice_chunk_received" && row.detail.receiveLagMs != null,
      ),
      JSON.stringify(body.debug.timeline),
    );
    const speechStartedRow = body.debug.timeline.rows.find((row) => row.event === "speech_started");
    assert.equal(speechStartedRow.layer, "audio_input");
    assert.equal(speechStartedRow.ok, true);
    assert.notEqual(speechStartedRow.durationMs, null);
    assert.ok(
      body.debug.timeline.rows.some((row) => row.event === "transcript_delta"),
      JSON.stringify(body.debug.timeline),
    );
    assert.equal(body.debug.visual.composition.mode, "operator_side");
    assert.equal(body.debug.surfaceContext.visual.focusedSourceId, "avatar");
    assert.equal(body.debug.surfaceContext.composition.localComposedTrack, true);
    assert.equal(body.debug.visual.composition.localComposedTrack, true);
    assert.ok(body.debug.visual.composition.localComposedStreamId);
    assert.ok(body.debug.visual.composition.trackId);
    assert.equal(body.debug.visual.composition.trackKind, "video");
    assert.equal(body.debug.visual.composition.trackReadyState, "live");
    assert.equal(body.debug.visual.composition.width, 1280);
    assert.equal(body.debug.visual.composition.height, 720);
    assert.equal(body.debug.visual.composition.targetFps, 30);
    assert.ok(body.debug.visual.composition.renderedFrameCount > 0);
    assert.ok(body.debug.visual.composition.lastRenderedFrameAt);
    assert.notEqual(body.debug.visual.composition.lastRenderedFrameAgeMs, null);
    assert.ok(body.debug.visual.composition.lastRenderedFrameAgeMs < 2500);
    assert.equal(body.debug.visual.composition.focusedSourceId, "avatar");
    assert.equal(body.debug.visual.composition.sourceRects.avatar.x, 0.58);
    const denseDebugPanel = await page.evaluate(() => ({
      panel: Boolean(document.querySelector('[data-debug-panel="dense"]')),
      timeline: Boolean(document.getElementById("debug-timeline-table")),
      composition: Boolean(document.getElementById("debug-composition-table")),
      sources: Boolean(document.getElementById("debug-visual-source-table")),
      voice: Boolean(document.getElementById("debug-voice-table")),
    }));
    assert.equal(denseDebugPanel.panel, true);
    assert.equal(denseDebugPanel.timeline, true);
    assert.equal(denseDebugPanel.composition, true);
    assert.equal(denseDebugPanel.sources, true);
    assert.equal(denseDebugPanel.voice, true);
    assert.ok(
      body.recentEvents.some((event) => event.event === "operator_voice_chunk_received"),
      JSON.stringify(body.recentEvents),
    );

    const reportBody = await (await fetch(new URL("/runtime/report", url))).json();
    assert.equal(reportBody.ok, true);
    assert.equal(reportBody.report.reportKind, "lan_operator_debug_report");
    assert.equal(reportBody.report.schemaVersion, 1);
    assert.equal(reportBody.report.sessionId, "lan-operator-smoke");
    assert.equal(reportBody.report.debug.visual.composition.localComposedTrack, true);
    assert.ok(
      reportBody.report.debug.timeline.rows.some((row) => row.event === "speech_started"),
      JSON.stringify(reportBody.report.debug.timeline),
    );
    assert.ok(
      reportBody.report.timeline.some((row) => row.event === "speech_started"),
      JSON.stringify(reportBody.report.timeline),
    );
    assert.equal(reportBody.report.summaries.timelineRows, reportBody.report.timeline.length);
    assert.equal(reportBody.report.summaries.turns.count, 1);
    assert.equal(reportBody.report.summaries.turns.latest.milestones.heard, true);
    assert.equal(reportBody.report.summaries.canonicalConversationEvents.speech_started, 1);
    assert.equal(reportBody.report.summaries.surfaceContext.visual.focusedSourceId, "avatar");
    assert.equal(reportBody.report.summaries.surfaceContext.composition.localComposedTrack, true);
    assert.ok(reportBody.report.recentEvents.length >= body.recentEvents.length);

    const artifactResult = await page.evaluate(async () => {
      const copied = await window.MAB_LAN_OPERATOR_SURFACE.copyDiagnostics();
      const marked = window.MAB_LAN_OPERATOR_SURFACE.markInterestingRun({
        label: "smoke",
        note: "report artifact smoke",
      });
      const downloaded = await window.MAB_LAN_OPERATOR_SURFACE.downloadReport();
      return {
        copiedBytes: copied.bytes,
        copiedKind: copied.report.reportKind,
        copiedSession: copied.report.sessionId,
        copiedTextHasSession: window.__MAB_LAST_COPIED_DIAGNOSTICS.includes("lan-operator-smoke"),
        markedCount: marked.interestingMarks.length,
        downloadedFilename: downloaded.filename,
        downloadedKind: downloaded.report.reportKind,
      };
    });
    assert.ok(artifactResult.copiedBytes > 500, JSON.stringify(artifactResult));
    assert.equal(artifactResult.copiedKind, "lan_operator_debug_report");
    assert.equal(artifactResult.copiedSession, "lan-operator-smoke");
    assert.equal(artifactResult.copiedTextHasSession, true);
    assert.equal(artifactResult.markedCount, 1);
    assert.match(
      artifactResult.downloadedFilename,
      /oneesama-local-operator-lan-operator-smoke-\d+\.json/,
    );
    assert.equal(artifactResult.downloadedKind, "lan_operator_debug_report");

    const artifactBody = await waitForRuntimeStatus(
      url,
      (nextBody) =>
        nextBody.debug.artifacts.reportCopyCount >= 1 &&
        nextBody.debug.artifacts.reportDownloadCount >= 1 &&
        nextBody.debug.artifacts.interestingMarks.length >= 1,
    );
    assert.equal(artifactBody.debug.artifacts.interestingMarks.at(-1).label, "smoke");
    assert.equal(
      artifactBody.debug.artifacts.interestingMarks.at(-1).note,
      "report artifact smoke",
    );
    assert.ok(
      artifactBody.recentEvents.some((event) => event.event === "debug_report_artifact_recorded"),
      JSON.stringify(artifactBody.recentEvents),
    );
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator surface records KWWK progress and blockers", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-kwwk-smoke",
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
      window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState({
        jobId: "kwwk_smoke_job",
        status: "planning",
        target: { app: "Fixture", window: "Smoke" },
        timings: { observeMs: 18, planMs: 41 },
      });
      window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState({
        jobId: "kwwk_smoke_job",
        status: "executing",
        action: { kind: "click", label: "primary button", status: "running" },
        cursorEventCountDelta: 2,
      });
      window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState({
        jobId: "kwwk_smoke_job",
        status: "blocked",
        blocker: "verification_target_missing",
        timings: { executeMs: 117, verifyMs: 29, totalMs: 205 },
      });
    });

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) =>
        nextBody.debug.kwwk.status === "blocked" &&
        nextBody.debug.kwwk.actionCount >= 1 &&
        nextBody.debug.timeline.rows.some((row) => row.event === "kwwk_blocked"),
    );
    assert.equal(body.debug.kwwk.currentJobId, "kwwk_smoke_job");
    assert.equal(body.debug.kwwk.blocker, "verification_target_missing");
    assert.equal(body.debug.kwwk.latestActionKind, "click");
    assert.equal(body.debug.kwwk.cursorEventCount, 2);
    assert.equal(body.debug.kwwk.timings.totalMs, 205);
    const denseKwwkPanel = await page.evaluate(() => ({
      panel: Boolean(document.querySelector('[data-debug-panel="dense"]')),
      kwwk: Boolean(document.getElementById("debug-kwwk-table")),
      timeline: Boolean(document.getElementById("debug-timeline-table")),
    }));
    assert.equal(denseKwwkPanel.panel, true);
    assert.equal(denseKwwkPanel.kwwk, true);
    assert.equal(denseKwwkPanel.timeline, true);
    assert.ok(
      body.debug.timeline.rows.some(
        (row) =>
          row.layer === "kwwk" &&
          row.event === "kwwk_blocked" &&
          row.ok === false &&
          row.blocker === "verification_target_missing",
      ),
      JSON.stringify(body.debug.timeline),
    );
    assert.ok(
      body.recentEvents.some((event) => event.event === "kwwk_job_state_updated"),
      JSON.stringify(body.recentEvents),
    );

    const reportBody = await (await fetch(new URL("/runtime/report", url))).json();
    assert.ok(
      reportBody.report.summaries.blockers.some(
        (blocker) => blocker.layer === "kwwk" && blocker.blocker === "verification_target_missing",
      ),
      JSON.stringify(reportBody.report.summaries),
    );
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator surface records tool routing arguments and function output", async () => {
  const receivedToolResults = [];
  const toolArguments = {
    instruction: "switch to the first browser tab",
    target: { applicationName: "Chromium", windowTitle: "Fixture" },
  };
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-tool-routing-smoke",
    botName: "LAN Oneesama",
    conversationEngine: {
      id: "tool_routing_test_engine",
      receiveVoiceChunk: (chunk) => {
        const ts = new Date().toISOString();
        const providerDetail = (providerEventType, extra = {}) => ({
          provider: "test_provider",
          providerEventType,
          providerEventId: `provider_${providerEventType.replaceAll(".", "_")}`,
          ...extra,
        });
        return {
          result: { ok: true, engineId: "tool_routing_test_engine" },
          events: [
            {
              id: "tool_route_engine_connected",
              ts,
              sessionId: chunk.sessionId,
              type: "engine_connected",
              engineId: "tool_routing_test_engine",
              detail: providerDetail("session.created"),
            },
            {
              id: "tool_route_speech_started",
              ts,
              sessionId: chunk.sessionId,
              type: "speech_started",
              engineId: "tool_routing_test_engine",
              turnId: "turn_tool_route",
              detail: providerDetail("input_audio_buffer.speech_started"),
            },
            {
              id: "tool_route_transcript_completed",
              ts,
              sessionId: chunk.sessionId,
              type: "transcript_completed",
              engineId: "tool_routing_test_engine",
              turnId: "turn_tool_route",
              text: "switch to the first browser tab",
              detail: providerDetail("conversation.item.input_audio_transcription.completed"),
            },
            {
              id: "tool_route_started",
              ts,
              sessionId: chunk.sessionId,
              type: "tool_call_started",
              engineId: "tool_routing_test_engine",
              turnId: "turn_tool_route",
              itemId: "item_tool_route",
              detail: providerDetail("response.output_item.added", {
                expectedTool: "kwwk_computer_use",
                name: "kwwk_computer_use",
                callId: "call_tool_route",
              }),
            },
            {
              id: "tool_route_completed",
              ts,
              sessionId: chunk.sessionId,
              type: "tool_call_completed",
              engineId: "tool_routing_test_engine",
              turnId: "turn_tool_route",
              itemId: "item_tool_route",
              text: JSON.stringify(toolArguments),
              detail: providerDetail("response.function_call_arguments.done", {
                expectedTool: "kwwk_computer_use",
                name: "kwwk_computer_use",
                callId: "call_tool_route",
              }),
            },
            {
              id: "tool_route_result",
              ts,
              sessionId: chunk.sessionId,
              type: "tool_result_accepted",
              engineId: "tool_routing_test_engine",
              turnId: "turn_tool_route",
              responseId: "response_tool_route",
              itemId: "item_tool_route",
              text: JSON.stringify({ ok: true, jobId: "kwwk_tool_route_job", status: "queued" }),
              detail: providerDetail("conversation.item.created", {
                expectedTool: "kwwk_computer_use",
                name: "kwwk_computer_use",
                callId: "call_tool_route",
              }),
            },
            {
              id: "tool_route_assistant_completed",
              ts,
              sessionId: chunk.sessionId,
              type: "assistant_text_completed",
              engineId: "tool_routing_test_engine",
              turnId: "turn_tool_route",
              responseId: "response_tool_route",
              text: "switching tabs now",
              detail: providerDetail("response.output_text.done"),
            },
          ],
        };
      },
      receiveToolResult: (input) => {
        receivedToolResults.push(input);
        const ts = new Date().toISOString();
        return {
          result: {
            ok: true,
            engineId: "tool_routing_test_engine",
            accepted: true,
            inputMode: "tool_result",
          },
          events: [
            {
              id: "tool_route_real_result",
              ts,
              sessionId: input.sessionId,
              type: "tool_result_accepted",
              engineId: "tool_routing_test_engine",
              turnId: input.turnId || "turn_tool_route",
              responseId: input.responseId || "response_tool_route",
              itemId: input.itemId || "item_tool_route",
              text: JSON.stringify(input.output),
              detail: {
                inputMode: "tool_result",
                inputId: input.id,
                source: input.source,
                expectedTool: input.toolName,
                name: input.toolName,
                callId: input.callId,
                jobId: input.jobId,
                status: input.status,
                surfaceContext: input.surfaceContext,
              },
            },
          ],
        };
      },
    },
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({ sequence: 1 }),
    );

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) =>
        nextBody.debug.toolRouting.status === "result_accepted" &&
        nextBody.debug.toolRouting.functionOutputDelivered === true,
    );
    assert.equal(body.debug.toolRouting.expectedTool, "kwwk_computer_use");
    assert.equal(body.debug.toolRouting.actualTool, "kwwk_computer_use");
    assert.equal(body.debug.toolRouting.callId, "call_tool_route");
    assert.equal(body.debug.toolRouting.argumentSafety.ok, true);
    assert.equal(body.debug.toolRouting.argumentSafety.naturalLanguageInstruction, true);
    assert.equal(body.debug.toolRouting.argumentSafety.safeTargetHint, true);
    assert.equal(body.debug.toolRouting.argumentSafety.exposesRawOperations, false);
    assert.equal(body.debug.toolRouting.argumentSafety.exposesCoordinates, false);
    assert.deepEqual(body.debug.toolRouting.parsedArguments, toolArguments);
    assert.equal(body.debug.toolRouting.functionOutput.jobId, "kwwk_tool_route_job");
    assert.equal(body.debug.conversation.provider.adapterKind, "test_provider");
    assert.equal(body.debug.conversation.provider.rawEventDrilldownAvailable, true);
    assert.equal(
      body.debug.conversation.provider.providerEventCounts["response.function_call_arguments.done"],
      1,
    );
    const toolArgsProviderEvent = body.debug.conversation.provider.recentEvents.find(
      (event) => event.providerEventType === "response.function_call_arguments.done",
    );
    assert.deepEqual(
      [toolArgsProviderEvent?.provider, toolArgsProviderEvent?.canonicalType],
      ["test_provider", "tool_call_completed"],
    );
    assert.deepEqual(
      [
        toolArgsProviderEvent?.providerEventId,
        toolArgsProviderEvent?.callId,
        toolArgsProviderEvent?.toolName,
      ],
      ["provider_response_function_call_arguments_done", "call_tool_route", "kwwk_computer_use"],
    );
    assert.ok(
      toolArgsProviderEvent?.detailKeys.includes("providerEventId"),
      JSON.stringify(toolArgsProviderEvent),
    );
    await page.evaluate(() => {
      window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState({
        turnId: "turn_tool_route",
        responseId: "response_tool_route",
        jobId: "kwwk_tool_route_job",
        status: "completed",
        action: { kind: "press_key", label: "ctrl+1", status: "completed" },
        timings: { totalMs: 42 },
      });
      window.MAB_LAN_OPERATOR_SURFACE.submitToolResult({
        callId: "call_tool_route",
        itemId: "item_tool_route",
        toolName: "kwwk_computer_use",
        turnId: "turn_tool_route",
        responseId: "response_tool_route",
        jobId: "kwwk_tool_route_job",
        status: "completed",
        output: { ok: true, jobId: "kwwk_tool_route_job", status: "completed" },
        source: "kwwk",
      });
    });
    const correlatedBody = await waitForRuntimeStatus(
      url,
      (nextBody) => {
        const turn = nextBody.debug.timeline.turns.find(
          (entry) => entry.turnId === "turn_tool_route",
        );
        return (
          turn?.milestones?.heard === true &&
          turn?.milestones?.speechStarted === true &&
          turn?.milestones?.transcript === true &&
          turn?.milestones?.tool === true &&
          turn?.milestones?.kwwk === true &&
          turn?.milestones?.output === true &&
          turn?.status === "completed" &&
          nextBody.debug.conversation.eventCounts.tool_result_accepted >= 2
        );
      },
      5_000,
    );
    assert.equal(receivedToolResults.length, 1);
    assert.equal(receivedToolResults[0].callId, "call_tool_route");
    assert.equal(receivedToolResults[0].jobId, "kwwk_tool_route_job");
    assert.equal(receivedToolResults[0].source, "kwwk");
    assert.equal(
      receivedToolResults[0].surfaceContext.schema,
      "oneesama.lan_operator_surface_context.v1",
    );
    const correlatedTurn = correlatedBody.debug.timeline.turns.find(
      (turn) => turn.turnId === "turn_tool_route",
    );
    assert.equal(correlatedTurn.latestEvent, "tool_result_accepted");
    assert.ok(correlatedTurn.events.includes("kwwk_completed"), JSON.stringify(correlatedTurn));
    assert.deepEqual(correlatedTurn.responseIds, ["response_tool_route"]);
    const denseToolPanel = await page.evaluate(() => ({
      panel: Boolean(document.querySelector('[data-debug-panel="dense"]')),
      toolRouting: Boolean(document.getElementById("debug-tool-routing-table")),
      port: Boolean(document.getElementById("debug-port-table")),
      providerDrilldown: Boolean(document.getElementById("debug-provider-drilldown-table")),
      turnTimeline: Boolean(document.getElementById("debug-turn-timeline-table")),
    }));
    assert.equal(denseToolPanel.panel, true);
    assert.equal(denseToolPanel.toolRouting, true);
    assert.equal(denseToolPanel.port, true);
    assert.equal(denseToolPanel.providerDrilldown, true);
    assert.equal(denseToolPanel.turnTimeline, true);
    assert.ok(
      body.debug.timeline.rows.some((row) => row.event === "tool_call_completed"),
      JSON.stringify(body.debug.timeline),
    );
    assert.ok(
      !body.debug.timeline.rows.some((row) => row.event === "tool_arguments_rejected"),
      JSON.stringify(body.debug.timeline),
    );
    assert.ok(
      body.recentEvents.some((event) => event.event === "tool_routing_state_updated"),
      JSON.stringify(body.recentEvents),
    );
    assert.ok(
      correlatedBody.recentEvents.some(
        (event) => event.event === "conversation_tool_result_delivered",
      ),
      JSON.stringify(correlatedBody.recentEvents),
    );

    const reportBody = await (await fetch(new URL("/runtime/report", url))).json();
    assert.equal(reportBody.report.summaries.toolRouting.expectedTool, "kwwk_computer_use");
    assert.equal(reportBody.report.summaries.toolRouting.actualTool, "kwwk_computer_use");
    assert.equal(reportBody.report.summaries.toolRouting.functionOutputDelivered, true);
    assert.equal(reportBody.report.summaries.canonicalConversationEvents.tool_result_accepted, 2);
    assert.equal(reportBody.report.summaries.toolRouting.argumentSafety.ok, true);
    assert.equal(reportBody.report.summaries.turns.latest.turnId, "turn_tool_route");
    assert.equal(reportBody.report.summaries.turns.latest.milestones.kwwk, true);
    assert.equal(reportBody.report.summaries.conversationPort.providerAdapterKind, "test_provider");
    assert.equal(reportBody.report.summaries.conversationPort.rawEventDrilldownAvailable, true);
    assert.equal(
      reportBody.report.summaries.conversationPort.latestCanonicalEvent,
      "tool_result_accepted",
    );
    assert.equal(
      reportBody.report.summaries.conversationPort.providerEventCounts[
        "response.function_call_arguments.done"
      ],
      1,
    );
    assert.ok(
      reportBody.report.summaries.conversationPort.recentProviderEvents.some(
        (event) =>
          event.providerEventId === "provider_response_function_call_arguments_done" &&
          event.callId === "call_tool_route",
      ),
      JSON.stringify(reportBody.report.summaries.conversationPort.recentProviderEvents),
    );
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator surface rejects unsafe tool-routing arguments", async () => {
  const unsafeArguments = {
    instruction: "click the primary button",
    target: { applicationName: "Chromium" },
    operations: [{ kind: "click", x: 10, y: 20 }],
  };
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-unsafe-tool-routing-smoke",
    botName: "LAN Oneesama",
    conversationEngine: {
      id: "unsafe_tool_routing_test_engine",
      receiveVoiceChunk: (chunk) => {
        const ts = new Date().toISOString();
        return {
          result: { ok: true, engineId: "unsafe_tool_routing_test_engine" },
          events: [
            {
              id: "unsafe_tool_route_started",
              ts,
              sessionId: chunk.sessionId,
              type: "tool_call_started",
              engineId: "unsafe_tool_routing_test_engine",
              turnId: "turn_unsafe_tool_route",
              detail: {
                expectedTool: "kwwk_computer_use",
                name: "kwwk_computer_use",
                callId: "call_unsafe_tool_route",
              },
            },
            {
              id: "unsafe_tool_route_completed",
              ts,
              sessionId: chunk.sessionId,
              type: "tool_call_completed",
              engineId: "unsafe_tool_routing_test_engine",
              turnId: "turn_unsafe_tool_route",
              text: JSON.stringify(unsafeArguments),
              detail: {
                expectedTool: "kwwk_computer_use",
                name: "kwwk_computer_use",
                callId: "call_unsafe_tool_route",
              },
            },
          ],
        };
      },
    },
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({ sequence: 1 }),
    );

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) =>
        nextBody.debug.toolRouting.status === "completed" &&
        nextBody.debug.timeline.rows.some((row) => row.event === "tool_arguments_rejected"),
    );
    assert.equal(body.debug.toolRouting.argumentSafety.ok, false);
    assert.equal(body.debug.toolRouting.argumentSafety.exposesRawOperations, true);
    assert.equal(body.debug.toolRouting.argumentSafety.exposesCoordinates, true);
    assert.ok(
      body.debug.timeline.rows.some(
        (row) =>
          row.event === "tool_arguments_rejected" &&
          row.layer === "tool_routing" &&
          row.ok === false &&
          row.blocker === "unsafe_tool_arguments",
      ),
      JSON.stringify(body.debug.timeline),
    );
    assert.ok(
      body.recentEvents.some(
        (event) => event.event === "tool_routing_state_updated" && event.severity === "warn",
      ),
      JSON.stringify(body.recentEvents),
    );
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator surface microphone capture emits PCM16 chunks to the voice port", async () => {
  const forwarded = [];
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-mic-smoke",
    botName: "LAN Oneesama",
    handleVoiceChunk: async (chunk) => {
      forwarded.push(chunk);
      return { ok: true };
    },
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
    await page.click("#voice-button");

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) =>
        nextBody.debug.voice.chunksReceived >= 6 &&
        nextBody.debug.voice.forwardedChunks >= 6 &&
        nextBody.debug.conversation.eventCounts.assistant_text_completed >= 1 &&
        nextBody.debug.output.assistantText.completedCount >= 1 &&
        nextBody.debug.voice.bytesReceived > 0 &&
        nextBody.debug.voice.lastAckRttMs != null,
      10_000,
    );
    const clientVoice = await page.evaluate(
      () => window.MAB_LAN_OPERATOR_SURFACE.state.voiceCapture,
    );

    assert.equal(body.ok, true);
    assert.equal(body.debug.voice.armed, true);
    assert.equal(body.debug.voice.muted, false);
    assert.equal(body.debug.voice.captureMode, "microphone_pcm16");
    assert.equal(body.debug.voice.captureStatus, "recording");
    assert.equal(body.debug.voice.permissionState, "granted");
    assert.ok(body.debug.voice.availableDeviceCount >= 0);
    assert.equal(body.debug.voice.localVad.enabled, false);
    assert.equal(body.debug.voice.localVad.role, "disabled");
    assert.notEqual(body.debug.voice.localVad.lastEnergy, null);
    assert.equal(body.debug.voice.forwardFailures, 0);
    assert.equal(body.debug.voice.forwardBackpressureDrops, 0);
    assert.ok(body.debug.voice.sampleRate > 0, JSON.stringify(body.debug.voice));
    assert.ok(body.debug.voice.durationMs > 0, JSON.stringify(body.debug.voice));
    assert.ok(
      body.debug.voice.lastReceiveLagMs != null && body.debug.voice.lastReceiveLagMs >= 0,
      JSON.stringify(body.debug.voice),
    );
    assert.ok(
      body.debug.voice.lastAckRttMs != null && body.debug.voice.lastAckRttMs >= 0,
      JSON.stringify(body.debug.voice),
    );
    assert.ok(clientVoice.sampleRate > 0, JSON.stringify(clientVoice));
    assert.equal(clientVoice.mode, "microphone_pcm16");
    assert.equal(clientVoice.status, "recording");
    assert.equal(clientVoice.permissionState, "granted");
    assert.equal(
      await page.evaluate(() => document.getElementById("voice-button")?.innerText),
      "Disarm",
    );
    assert.ok(forwarded.length >= 2, JSON.stringify(forwarded));
    assert.equal(forwarded[0].source, "operator_mic_pcm16");
    assert.ok(forwarded[0].bytes > 0, JSON.stringify(forwarded[0]));
    assert.ok(
      body.debug.conversation.canonicalEvents.some(
        (event) => event.type === "assistant_text_completed",
      ),
      JSON.stringify(body.debug.conversation),
    );
    assert.equal(body.debug.output.assistantText.completedCount, 1);
    assert.ok(
      body.debug.output.assistantText.completedText.includes("diagnostic response ready"),
      JSON.stringify(body.debug.output),
    );
    assert.ok(
      body.debug.timeline.rows.some((row) => row.event === "assistant_text_completed"),
      JSON.stringify(body.debug.timeline),
    );
    const voicePanel = await page.evaluate(() => ({
      mic: document.getElementById("mic-state")?.innerText || "",
      vad: document.getElementById("local-vad-state")?.innerText || "",
      energyWidth: document.getElementById("voice-energy-bar")?.style.width || "",
    }));
    assert.match(voicePanel.mic, /armed/);
    assert.match(voicePanel.vad, /disabled/);
    assert.notEqual(voicePanel.energyWidth, "");
    assert.equal(body.debug.conversation.status, "connected");
    assert.match(body.debug.output.assistantText.completedText, /diagnostic response ready/);

    const reportBody = await (await fetch(new URL("/runtime/report", url))).json();
    const conversationTurn = reportBody.report.summaries.conversationTurn;
    assert.equal(conversationTurn.engineId, "diagnostic_conversation_engine");
    assert.equal(conversationTurn.transport, "mock");
    assert.equal(conversationTurn.sessionId, "lan-operator-mic-smoke");
    assert.ok(conversationTurn.currentTurnId, JSON.stringify(conversationTurn));
    assert.ok(conversationTurn.currentResponseId, JSON.stringify(conversationTurn));
    assert.match(conversationTurn.userTranscript, /operator audio|chunk_\d+/);
    assert.match(conversationTurn.assistantTranscript, /diagnostic response ready/);
    assert.equal(conversationTurn.speechStartCount, 1);
    assert.equal(conversationTurn.control.lastCommand, "set_voice_armed");

    await page.evaluate(() => window.MAB_LAN_OPERATOR_SURFACE.setVoiceMuted(true));
    const mutedBody = await waitForRuntimeStatus(
      url,
      (nextBody) => nextBody.debug.voice.muted === true,
      5_000,
    );
    assert.equal(mutedBody.debug.voice.muted, true);

    await page.evaluate(() => window.MAB_LAN_OPERATOR_SURFACE.stopMicrophone("test_done"));
    const stoppedBody = await waitForRuntimeStatus(
      url,
      (nextBody) => nextBody.debug.voice.armed === false,
      5_000,
    );
    assert.equal(stoppedBody.debug.voice.captureStatus, "stopped");
    await context.close();
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator voice forwarding drops loudly on backpressure", async () => {
  let releaseFirstForward;
  let forwardCalls = 0;
  const firstForward = new Promise((resolve) => {
    releaseFirstForward = resolve;
  });
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-backpressure-smoke",
    botName: "LAN Oneesama",
    maxVoiceForwardInFlight: 1,
    handleVoiceChunk: async () => {
      forwardCalls += 1;
      if (forwardCalls === 1) return await firstForward;
      return { ok: true };
    },
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
      window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({ sequence: 2 });
    });

    const dropped = await waitForRuntimeStatus(
      url,
      (body) => body.debug.voice.forwardBackpressureDrops >= 1,
    );
    assert.equal(dropped.debug.voice.forwardBackpressureDrops, 1);
    assert.equal(dropped.debug.voice.forwardInFlight, 1);
    assert.equal(forwardCalls, 1);

    releaseFirstForward({ ok: true });
    const forwarded = await waitForRuntimeStatus(
      url,
      (body) => body.debug.voice.forwardedChunks >= 1 && body.debug.voice.forwardInFlight === 0,
    );
    assert.equal(forwarded.debug.voice.forwardedChunks, 1);
    assert.equal(forwarded.debug.voice.chunksReceived, 2);
  } finally {
    releaseFirstForward?.({ ok: true });
    await browser.close();
    await surface.close();
  }
});

test("LAN operator conversation engine errors surface as canonical events", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-engine-error-smoke",
    botName: "LAN Oneesama",
    conversationEngine: {
      id: "failing_test_engine",
      receiveVoiceChunk: (chunk) => ({
        result: { ok: false, error: "engine_down" },
        events: [
          {
            id: "engine_error_test",
            ts: new Date().toISOString(),
            sessionId: chunk.sessionId,
            type: "engine_error",
            engineId: "failing_test_engine",
            error: "engine_down",
            detail: { sequence: chunk.sequence },
          },
        ],
      }),
    },
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({ sequence: 1 }),
    );

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) =>
        nextBody.debug.conversation.eventCounts.engine_error >= 1 &&
        nextBody.debug.voice.forwardFailures >= 1,
    );
    assert.equal(body.debug.conversation.status, "failed");
    assert.equal(body.debug.conversation.engineId, "failing_test_engine");
    assert.equal(body.debug.conversation.errors[0].error, "engine_down");
    assert.ok(
      body.debug.timeline.rows.some(
        (row) =>
          row.event === "operator_voice_chunk_forward_failed" &&
          row.layer === "audio_input" &&
          row.ok === false &&
          row.blocker === "engine_down",
      ),
      JSON.stringify(body.debug.timeline),
    );
    assert.ok(
      body.debug.timeline.rows.some(
        (row) =>
          row.event === "engine_error" &&
          row.layer === "conversation_engine" &&
          row.ok === false &&
          row.blocker === "engine_down",
      ),
      JSON.stringify(body.debug.timeline),
    );
    assert.ok(
      body.recentEvents.some((event) => event.event === "conversation_engine_error"),
      JSON.stringify(body.recentEvents),
    );
  } finally {
    await browser.close();
    await surface.close();
  }
});
