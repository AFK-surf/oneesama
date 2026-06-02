import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";
import { createAvatarPlaygroundServer } from "../packages/core/src/avatar-runtime/avatar-playground.ts";

test("avatar playground renders runtime HUD signals and state presets", async () => {
  const playground = createAvatarPlaygroundServer({ port: 0, botName: "Playground Smoke" });
  const started = await playground.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    const page = await context.newPage();
    await page.goto(`${started.url}?avatar=fallback-canvas`);
    await page.waitForFunction(() => window.MAB_AVATAR_PLAYGROUND?.state?.ready === true, null, {
      timeout: 10_000,
    });
    const renderer = await page.evaluate(() => window.MAB_AVATAR_RENDERER?.renderer);
    assert.equal(renderer, "fallback");
    const status = await (await fetch(`${started.url}runtime/status`)).json();
    assert.ok(status.avatars.some((avatar) => avatar.id === "oneesama-video"));
    const listening = await page.evaluate(() =>
      window.MAB_AVATAR_PLAYGROUND.applyPreset("listening"),
    );
    assert.deepEqual(
      listening.signals.map((signal) => signal.label),
      ["连接", "音频", "回合", "说", "工具", "错误"],
    );
    assert.equal(listening.signals.find((signal) => signal.label === "音频")?.value, "有输入");

    const sidecarMeetSurfaceSignals = await page.evaluate(() => {
      window.MAB_REALTIME_BRIDGE = {
        runtimePlacement: "sidecar",
        pageRole: "meet-surface",
        sdkOwner: "sidecar",
        agentRuntime: { sdkSuppressedOnMeetSurface: true },
      };
      return window.MAB_AVATAR_HUD_SIGNALS();
    });
    assert.equal(
      sidecarMeetSurfaceSignals.find((signal) => signal.label === "连接")?.level,
      "idle",
    );
    assert.equal(
      sidecarMeetSurfaceSignals.find((signal) => signal.label === "音频")?.level,
      "idle",
    );

    const lowValueCells = await page.evaluate(() => {
      window.MAB_AVATAR_CONTROLLER?.updateState?.({
        status_kind: "idle",
        status_text: "",
        status_hold_ms: 0,
      });
      window.MAB_REALTIME_BRIDGE = {
        connected: false,
        connection: {
          peerConnectionState: "connecting",
          dataChannelReadyState: "connecting",
          currentRealtimeInputSource: "",
          responseEvents: 0,
        },
        feedback: {
          failureMatrix: {
            transport: { status: "waiting", reason: "connecting" },
            audioInput: { status: "waiting", reason: "input_audio_not_configured" },
            audioOutput: { status: "waiting", reason: "waiting_for_model_response" },
          },
        },
      };
      return window.MAB_AVATAR_HUD_VISIBLE_CELLS();
    });
    const lowValueText = lowValueCells.map((cell) => `${cell.label} ${cell.value}`).join("\n");
    assert.doesNotMatch(lowValueText, /连接中|没音频|没开口|没出声/);
    assert.equal(
      lowValueCells.some((cell) => ["rt", "audio", "speak"].includes(cell.key)),
      false,
    );

    const speakingCells = await page.evaluate(() => {
      window.MAB_AVATAR_PLAYGROUND.applyPreset("speaking");
      return window.MAB_AVATAR_HUD_VISIBLE_CELLS();
    });
    assert.equal(
      speakingCells.some((cell) => cell.key === "speak"),
      false,
    );
    assert.equal(
      speakingCells.some((cell) => /说话|在说|speaking/i.test(cell.label)),
      false,
    );

    const cursorSnapshot = await page.evaluate(() =>
      window.MAB_KWWK_CURSOR_FEEDBACK({
        x: 0.14,
        y: 0.18,
        kind: "click",
        label: "点击",
        holdMs: 5000,
      }),
    );
    assert.equal(cursorSnapshot.visible, true);
    assert.equal(cursorSnapshot.kind, "click");
    const cursorRender = await page.evaluate(() =>
      window.MAB_AVATAR_VISUAL_TEST.renderSnapshot({
        label: "kwwk-cursor-feedback",
        statusKind: "idle",
        statusText: "",
      }),
    );
    assert.ok(
      cursorRender.cursor.nonBackgroundRatio > 0.02,
      `expected visible cursor feedback pixels, got ${cursorRender.cursor.nonBackgroundRatio}`,
    );
    const cursorArtifact = await page.evaluate(() => window.MAB_KWWK_CURSOR_ARTIFACT());
    assert.equal(cursorArtifact.schema, "oneesama.kwwk-cursor-artifact.v1");
    assert.ok(cursorArtifact.events.some((event) => event.kind === "cursor.click"));
    assert.ok(cursorArtifact.coordinateSpaces.avatar_shared_surface_normalized);

    const tool = await page.evaluate(() => window.MAB_AVATAR_PLAYGROUND.applyPreset("tool"));
    assert.equal(tool.signals.find((signal) => signal.label === "工具")?.level, "active");
    assert.equal(tool.signals.find((signal) => signal.label === "工具")?.value, "列窗口→共享→控制");

    const blocked = await page.evaluate(() => window.MAB_AVATAR_PLAYGROUND.applyPreset("blocked"));
    assert.equal(blocked.signals.find((signal) => signal.label === "错误")?.level, "blocked");

    const doneVisible = await page.evaluate(() => {
      window.MAB_AVATAR_CONTROLLER?.updateState?.({
        status_kind: "done",
        status_text: "完成",
      });
      return {
        cells: window.MAB_AVATAR_HUD_VISIBLE_CELLS?.() || [],
        diagnostics: typeof window.MAB_AVATAR_HUD_SIGNALS === "function",
      };
    });
    assert.equal(doneVisible.diagnostics, true);
    assert.equal(
      doneVisible.cells.some((cell) => cell.key === "done"),
      true,
    );
    await page.waitForTimeout(2200);
    const doneCleared = await page.evaluate(() => window.MAB_AVATAR_HUD_VISIBLE_CELLS?.() || []);
    assert.equal(
      doneCleared.some((cell) => cell.key === "done"),
      false,
    );

    const quietListeningCells = await page.evaluate(() => {
      window.MAB_AVATAR_PLAYGROUND.applyPreset("listening");
      return window.MAB_AVATAR_HUD_VISIBLE_CELLS?.() || [];
    });
    assert.equal(
      quietListeningCells.some((cell) => /听语音|说话|讲话|listening|speaking/i.test(cell.label)),
      false,
    );
    await page.evaluate(() => window.MAB_AVATAR_PLAYGROUND.applyPreset("tool"));
    await page.waitForFunction(
      () => {
        const snapshot = window.MAB_AVATAR_VISUAL_TEST?.captureSourceSnapshot({
          label: "playground-wait",
        });
        return Number(snapshot?.status?.nonBackgroundRatio || 0) > 0.12;
      },
      null,
      { timeout: 5_000 },
    );
    const snapshot = await page.evaluate(() =>
      window.MAB_AVATAR_VISUAL_TEST.captureSourceSnapshot({ label: "playground" }),
    );
    assert.ok(
      snapshot.status.nonBackgroundRatio > 0.12,
      `expected painted HUD pixels, got ${snapshot.status.nonBackgroundRatio}`,
    );
  } finally {
    await browser.close();
    await playground.close();
  }
});

test("video avatar suppresses fallback drawings when sources are unavailable", async () => {
  const playground = createAvatarPlaygroundServer({
    port: 0,
    botName: "Video Failure Smoke",
    avatar: {
      avatarRenderer: "video",
      background: "#0b1018",
      videoChromaKey: { enabled: false },
      videoSources: [
        {
          id: "broken-idle",
          label: "Broken idle",
          state: "idle",
          url: "/assets/avatar/missing-video-source.webm",
          background: "#0b1018",
        },
      ],
    },
  });
  const started = await playground.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    const page = await context.newPage();
    await page.goto(`${started.url}?avatar=oneesama-video`);
    await page.waitForFunction(
      () => {
        const renderer = window.MAB_AVATAR_RENDERER;
        return renderer?.renderer === "video" && Number(renderer.videoHoldFrames || 0) > 0;
      },
      null,
      { timeout: 10_000 },
    );
    const renderer = await page.evaluate(() => window.MAB_AVATAR_RENDERER);
    assert.equal(renderer.renderer, "video");
    assert.equal(renderer.videoLoaded, false);
    assert.equal(renderer.videoFallbackSuppressed, true);
    assert.equal(renderer.videoFallbackFrames, 0);
    assert.match(renderer.videoHoldReason || renderer.videoLoadErrors?.[0]?.error || "", /video/i);
    assert.equal(renderer.fallbackReason, "");
  } finally {
    await browser.close();
    await playground.close();
  }
});
