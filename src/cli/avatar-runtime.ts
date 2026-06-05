/* eslint-disable no-unused-vars */
import {
  existsSync,
  readFileSync,
  spawn,
  spawnSync,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
  createServer,
  tmpdir,
  basename,
  dirname,
  pathJoin,
  relative,
  Database,
  getRuntimeConfig,
  createInMemorySessionStore,
  createSessionStore,
  createAgentRunner,
  codexAppServerRunnerInternals,
  buildAvatarInitScript,
  buildLocalDialogInitScript,
  createGoogleMeetJoiner,
  installMeetCaptionCapture,
  createMeetingArtifactPipeline,
  computeDigestWebhookSignature,
  verifyDigestWebhookSignature,
  startLocalMeetFixtureServer,
  buildRealtimeBrowserInitScript,
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
  realtimeToolSchemas,
  createWorkerReportStore,
  parseAvatarCommand,
  slackTextResponse,
  createJsonServer,
  signSlackRequestBody,
  verifySlackRequest,
  createCanvasPublisher,
  createSlackPoster,
  createInMemoryAssistantScheduleManager,
  executeAssistantScheduleTool,
  LEGACY_SLACK_TOOL_SPECS,
  createLegacySlackToolRegistry,
  createLegacySlackDomainStore,
  htmlToMarkdown,
  markdownToBlocks,
  markdownToMrkdwn,
  markdownToSlackFallbackText,
  markdownishToMrkdwn,
  createLocalSlackMemoryProvider,
  seedLegacySlackMemory,
  buildSlackTriageActionBlocks,
  formatTriageContexts,
  loadTriageContextProjection,
  persistTriageContextProjection,
  buildDailyNoteCompactionTask,
  buildDailyNoteCompactionPrompt,
  dailyNoteCompactHash,
  shouldCompactDailyNote,
  assertNoPrivateSlackFields,
  createShadowTapPayload,
  postShadowTap,
  printHelp,
  assertSmoke,
  readStdinText,
  shouldRunOptionalSmoke,
  collectRealtimeSentEvents,
  hasCommand,
  parseEnvFile,
  envValue,
  redactSecret,
} from "./common.js";
import type {
  RealtimeBridgeWorkerToolCall,
  RealtimeBridgeSnapshot,
  AvatarStateSnapshot,
  AvatarVisualSnapshot,
  AvatarVisualDiff,
  AvatarVisualTestHarness,
  ShadowHookResponseBody,
  ShadowHookBody,
  ShadowHookResult,
  ShadowReportEvent,
  EvidenceArtifact,
  CutoverEvidenceManifest,
} from "./common.js";
import {
  shadowTransmitterHook,
  waitForRunnerJob,
  waitForWorkerReportJob,
  writeTextArtifact,
  writeJsonArtifact,
  runEvidenceCommand,
  fetchJsonArtifact,
  collectArtifacts,
  copyStateArtifacts,
  createCutoverEvidenceBundle,
  cutoverEvidenceBundle,
  cutoverEvidenceSmoke,
  summarizeParityJoin,
  summarizeParityJob,
  startOldStackFixture,
  startService,
  waitForHealth,
  waitForServiceHealth,
  waitForJoinStatus,
  postJson,
  postJsonWithStatus,
  buildSlackCommandForm,
  postSignedSlackCommand,
  buildSlackInteractionForm,
  postSignedSlackInteraction,
  postSignedSlackJson,
} from "./support.js";

export async function avatarStateSmoke() {
  const { chromium } = await import("playwright");
  const config = getRuntimeConfig();
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript({
      content: buildAvatarInitScript({
        botName: "Avatar State Smoke Bot",
        disableLive2D: true,
      }),
    });
    await context.addInitScript({
      content: buildRealtimeBrowserInitScript({ mode: "webrtc-mock", autoConnect: true }),
    });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.waitForFunction(
      async () =>
        window.MAB_AVATAR_READY?.ok === true &&
        (await window.MAB_REALTIME_CLIENT?.connect?.()) &&
        (window.MAB_REALTIME_BRIDGE as RealtimeBridgeSnapshot | null | undefined)?.connection
          ?.dataChannelOpen === true,
      null,
      { timeout: 10_000 },
    );

    const result = (await page.evaluate(async () => {
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "response.function_call_arguments.done",
            name: "update_avatar_state",
            call_id: "call_avatar_state_smoke",
            arguments: JSON.stringify({
              mood: "happy",
              action: "nod",
              intensity: 1.05,
            }),
          },
        }),
      );
      for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
        const bridge = window.MAB_REALTIME_BRIDGE as RealtimeBridgeSnapshot | null | undefined;
        if (
          window.MAB_AVATAR_STATE?.mood === "happy" &&
          window.MAB_AVATAR_STATE?.action === "nod" &&
          bridge?.avatarTools?.calls?.some((call) => call.name === "update_avatar_state") === true
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        avatar: window.MAB_AVATAR_STATE,
        ready: window.MAB_AVATAR_READY,
        bridge: window.MAB_REALTIME_BRIDGE,
        toolNames: window.MAB_REALTIME_CLIENT?.state ? Object.keys(window.MAB_REALTIME_CLIENT) : [],
      };
    })) as {
      avatar?: AvatarStateSnapshot;
      ready?: unknown;
      bridge?: RealtimeBridgeSnapshot;
      toolNames?: string[];
    };

    const sentPayloads = result.bridge?.connection?.sentDataChannelMessages || [];
    const sentEvents = sentPayloads.map((entry) => {
      try {
        return JSON.parse(entry.payload);
      } catch {
        return {};
      }
    });
    const functionOutput = sentEvents.find((event) => event.item?.type === "function_call_output");
    assertSmoke(
      result.avatar?.mood === "happy",
      "avatar mood did not update from Realtime tool call",
      result.avatar,
    );
    assertSmoke(
      result.avatar?.action === "nod",
      "avatar action did not update from Realtime tool call",
      result.avatar,
    );
    assertSmoke(
      result.bridge?.avatarTools?.calls?.some((call) => call.name === "update_avatar_state"),
      "Realtime bridge did not record the avatar tool call",
      result.bridge?.avatarTools,
    );
    assertSmoke(
      functionOutput?.item?.call_id === "call_avatar_state_smoke",
      "avatar tool call did not emit a function_call_output",
      sentEvents,
    );
    assertSmoke(
      !sentEvents.some((event) => event.type === "response.create"),
      "avatar visual-only tool call unexpectedly requested a follow-up response",
      sentEvents,
    );

    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await browser.close();
  }
}

export async function avatarVisualSmoke() {
  const { chromium } = await import("playwright");
  const config = getRuntimeConfig();
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript({
      content: buildAvatarInitScript({
        botName: "Avatar Visual Smoke Bot",
        disableLive2D: true,
        enableVisualTestHooks: true,
      }),
    });
    await context.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
      }),
    });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.waitForFunction(
      async () =>
        window.MAB_AVATAR_READY?.ok === true &&
        window.MAB_AVATAR_VISUAL_TEST &&
        (await window.MAB_REALTIME_CLIENT?.connect?.()) &&
        (window.MAB_REALTIME_BRIDGE as RealtimeBridgeSnapshot | null | undefined)?.connection
          ?.dataChannelOpen === true,
      null,
      { timeout: 10_000 },
    );

    const result = (await page.evaluate(async () => {
      const visualTest = window.MAB_AVATAR_VISUAL_TEST as unknown as AvatarVisualTestHarness;
      const neutralInput = { label: "neutral-idle", mood: "neutral", action: "idle", timeMs: 1200 };
      const speakingInput = {
        label: "speaking-emphasize",
        mood: "surprised",
        action: "emphasize",
        intensity: 1.15,
        timeMs: 1200,
      };
      const actionInput = {
        label: "neutral-shake",
        mood: "neutral",
        action: "shake",
        intensity: 1.6,
        timeMs: 1200,
      };
      const hudInputs = [
        { label: "hud-thinking", statusKind: "thinking", statusText: "Thinking" },
        { label: "hud-writing", statusKind: "writing_code", statusText: "Writing code" },
        { label: "hud-preview", statusKind: "opening_preview", statusText: "Opening preview" },
        { label: "hud-blocked", statusKind: "blocked", statusText: "Blocked" },
        { label: "hud-done", statusKind: "done", statusText: "Done" },
      ];
      const neutral = visualTest.renderSnapshot(neutralInput);
      const speaking = visualTest.renderSnapshot(speakingInput);
      const action = visualTest.renderSnapshot(actionInput);
      const hudSnapshots = hudInputs.map((input) =>
        visualTest.renderSnapshot({
          ...neutralInput,
          ...input,
          timeMs: 1200,
        }),
      );
      const mouthDiff = visualTest.compareSnapshots(neutralInput, speakingInput, {
        x: 760,
        y: 430,
        width: 400,
        height: 250,
      });
      const actionDiff = visualTest.compareSnapshots(neutralInput, actionInput, {
        x: 600,
        y: 130,
        width: 720,
        height: 680,
      });

      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "response.function_call_arguments.done",
            name: "update_avatar_state",
            call_id: "call_avatar_visual_smoke",
            arguments: JSON.stringify({
              mood: "happy",
              action: "emphasize",
              intensity: 1.1,
              status_kind: "writing_code",
              status_text: "Writing code",
            }),
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-worker-result", {
          detail: {
            id: "job_avatar_visual_smoke",
            task: "mock HUD completion",
            status: "completed",
            result: "done",
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        snapshots: { neutral, speaking, action },
        hudSnapshots,
        hudSignals: ((window as any).MAB_AVATAR_HUD_SIGNALS?.() || []) as Array<{
          label?: string;
          value?: string;
          level?: string;
        }>,
        diffs: { mouthDiff, actionDiff },
        liveHash: visualTest.getLiveHash(),
        avatar: window.MAB_AVATAR_STATE,
        ready: window.MAB_AVATAR_READY,
        bridge: window.MAB_REALTIME_BRIDGE,
      };
    })) as {
      snapshots?: {
        neutral?: AvatarVisualSnapshot;
        speaking?: AvatarVisualSnapshot;
        action?: AvatarVisualSnapshot;
      };
      hudSnapshots?: AvatarVisualSnapshot[];
      hudSignals?: Array<{ label?: string; value?: string; level?: string }>;
      diffs?: { mouthDiff?: AvatarVisualDiff; actionDiff?: AvatarVisualDiff };
      liveHash?: string;
      avatar?: AvatarStateSnapshot;
      ready?: unknown;
      bridge?: RealtimeBridgeSnapshot;
    };

    const hashes = Object.values(result.snapshots || {}).map((snapshot) => snapshot.hash);
    const uniqueHashes = new Set(hashes);
    const sentEvents = (result.bridge?.connection?.sentDataChannelMessages || []).map((entry) => {
      try {
        return JSON.parse(entry.payload);
      } catch {
        return {};
      }
    });
    assertSmoke(
      hashes.length === 3 && uniqueHashes.size === 3,
      "avatar visual snapshots did not produce distinct hashes",
      result.snapshots,
    );
    assertSmoke(
      result.snapshots?.neutral?.face?.nonBackgroundRatio > 0.05,
      "neutral avatar snapshot looks blank",
      result.snapshots?.neutral,
    );
    assertSmoke(
      result.snapshots?.speaking?.mouth?.nonBackgroundRatio >
        result.snapshots?.neutral?.mouth?.nonBackgroundRatio,
      "speaking mouth did not add visible mouth pixels",
      result.snapshots,
    );
    assertSmoke(
      result.diffs?.mouthDiff?.changedRatio > 0.015,
      "mouth visual diff was too small",
      result.diffs?.mouthDiff,
    );
    assertSmoke(
      result.diffs?.actionDiff?.changedRatio > 0.02,
      "action visual diff was too small",
      result.diffs?.actionDiff,
    );
    assertSmoke(
      (result.hudSnapshots || []).length === 5 &&
        (result.hudSnapshots || []).every((snapshot) => snapshot.status?.nonBackgroundRatio > 0.12),
      "avatar HUD visual smoke did not render all fixed status states",
      result.hudSnapshots,
    );
    assertSmoke(
      ["连接", "音频", "回合", "说", "工具", "错误"].every((label) =>
        (result.hudSignals || []).some((signal) => signal.label === label),
      ),
      "avatar HUD visual smoke did not expose all runtime signal chips",
      result.hudSignals,
    );
    assertSmoke(
      result.avatar?.mood === "happy",
      "avatar visual smoke did not update mood through Realtime tool",
      result.avatar,
    );
    assertSmoke(
      result.avatar?.updates?.some(
        (update) => update.kind === "status" && update.statusKind === "writing_code",
      ),
      "avatar visual smoke did not update HUD status through Realtime tool",
      result.avatar,
    );
    assertSmoke(
      result.avatar?.statusKind === "done" && result.avatar?.statusText === "Done",
      "avatar visual smoke did not update HUD status through mock worker completion",
      result.avatar,
    );
    assertSmoke(
      result.avatar?.updates?.some(
        (update) => update.kind === "action" && update.action === "emphasize",
      ),
      "avatar visual smoke did not observe emphasize action state",
      result.avatar,
    );
    assertSmoke(
      sentEvents.some(
        (event) =>
          event.item?.type === "function_call_output" &&
          event.item?.call_id === "call_avatar_visual_smoke",
      ),
      "avatar visual smoke did not emit function_call_output",
      sentEvents,
    );

    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await browser.close();
  }
}

export async function avatarVRMSmoke() {
  const { chromium } = await import("playwright");
  const config = getRuntimeConfig();
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "--use-gl=angle",
      "--enable-webgl",
    ],
  });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript({
      content: buildAvatarInitScript({
        botName: "VRM Avatar Smoke Bot",
        avatarRenderer: "vrm",
        enableVisualTestHooks: true,
      }),
    });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.waitForFunction(
      () =>
        window.MAB_AVATAR_READY?.ok === true &&
        window.MAB_AVATAR_RENDERER &&
        window.MAB_AVATAR_VISUAL_TEST,
      null,
      { timeout: 60_000 },
    );
    await page.waitForFunction(
      () =>
        Number((window.MAB_AVATAR_RENDERER as Record<string, unknown> | null)?.vrmFrames || 0) > 10,
      null,
      { timeout: 20_000 },
    );

    const result = (await page.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const visualTest = window.MAB_AVATAR_VISUAL_TEST;
      const controller = window.MAB_AVATAR_CONTROLLER;
      const neutral = visualTest.captureSourceSnapshot({ label: "vrm-neutral" });
      controller?.updateState({
        mood: "happy",
        action: "speak",
        intensity: 1.1,
        actionHoldMs: 2600,
      });
      window.MAB_AVATAR_AUDIO_BUS?.setSyntheticSpeech?.(true, { holdMs: 2200 });
      await wait(650);
      const expressive = visualTest.captureSourceSnapshot({ label: "vrm-happy-speak" });
      return {
        ready: window.MAB_AVATAR_READY,
        renderer: window.MAB_AVATAR_RENDERER,
        avatar: window.MAB_AVATAR_STATE,
        snapshots: { neutral, expressive },
      };
    })()`)) as {
      ready?: unknown;
      renderer?: {
        renderer?: string;
        vrmLoaded?: boolean;
        vrmFrames?: number;
        vrmSpeechFrames?: number;
        vrmMouthLevel?: number;
        vrmViseme?: string;
      };
      avatar?: AvatarStateSnapshot | null;
      snapshots?: { neutral?: AvatarVisualSnapshot; expressive?: AvatarVisualSnapshot };
    };

    assertSmoke(result.renderer?.renderer === "vrm", "VRM renderer did not activate", result);
    assertSmoke(result.renderer?.vrmLoaded === true, "VRM model did not load", result.renderer);
    assertSmoke((result.renderer?.vrmFrames || 0) > 10, "VRM render loop did not advance", result);
    assertSmoke(
      result.snapshots?.neutral?.ok === true && result.snapshots?.expressive?.ok === true,
      "VRM source snapshots failed",
      result.snapshots,
    );
    assertSmoke(
      result.snapshots?.neutral?.face?.nonBackgroundRatio > 0.015,
      "VRM neutral snapshot looks blank",
      result.snapshots?.neutral,
    );
    assertSmoke(
      result.snapshots?.neutral?.hash !== result.snapshots?.expressive?.hash,
      "VRM state change did not alter pixels",
      result.snapshots,
    );
    assertSmoke(
      result.avatar?.mood === "happy" &&
        result.avatar?.updates?.some(
          (update) => update.kind === "action" && update.action === "speak",
        ),
      "VRM smoke did not route avatar controller state",
      result.avatar,
    );
    assertSmoke(
      (result.renderer?.vrmSpeechFrames || 0) > 0 &&
        (result.renderer?.vrmMouthLevel || 0) > 0.05 &&
        result.renderer?.vrmViseme !== "closed",
      "VRM smoke did not drive lip sync from avatar audio",
      result.renderer,
    );
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await browser.close();
  }
}

export async function hiyoriLive2dSmoke() {
  const { chromium } = await import("playwright");
  const config = getRuntimeConfig();
  const requireLive2D = process.env.MAB_REQUIRE_HIYORI_LIVE2D === "1";
  const executablePath =
    config.chromiumExecutablePath && existsSync(config.chromiumExecutablePath)
      ? config.chromiumExecutablePath
      : undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "--use-gl=angle",
      "--enable-webgl",
    ],
  });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript({
      content: buildAvatarInitScript({
        botName: "Hiyori Live2D Smoke Bot",
        disableLive2D: false,
        enableVisualTestHooks: true,
      }),
    });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.waitForFunction(
      () =>
        window.MAB_AVATAR_READY?.ok === true &&
        window.MAB_AVATAR_RENDERER &&
        window.MAB_AVATAR_VISUAL_TEST,
      null,
      { timeout: 60_000 },
    );

    const readiness = (await page.evaluate(() => ({
      ready: window.MAB_AVATAR_READY,
      renderer: window.MAB_AVATAR_RENDERER,
      state: window.MAB_AVATAR_STATE,
    }))) as {
      ready?: unknown;
      renderer?: { live2dLoaded?: boolean; [key: string]: unknown } | null;
      state?: AvatarStateSnapshot | null;
    };
    if (!readiness.renderer?.live2dLoaded) {
      assertSmoke(!requireLive2D, "Hiyori Live2D did not load", readiness);
      console.log(
        JSON.stringify(
          {
            ok: true,
            skipped: true,
            reason: "hiyori_live2d_not_loaded",
            note: "Set MAB_REQUIRE_HIYORI_LIVE2D=1 on a WebGL-capable runner to make this smoke mandatory.",
            ...readiness,
          },
          null,
          2,
        ),
      );
      return;
    }

    await page.waitForFunction(
      () =>
        ((window.MAB_AVATAR_STATE as AvatarStateSnapshot | null | undefined)
          ?.live2dParameterFrames || 0) > 20,
      null,
      {
        timeout: 15_000,
      },
    );
    const result = (await page.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const visualTest = window.MAB_AVATAR_VISUAL_TEST;
      const controller = window.MAB_AVATAR_CONTROLLER;
      const neutral = visualTest.captureSourceSnapshot({
        label: "live2d-neutral",
      });
      controller?.updateState({
        mood: "happy",
        action: "emphasize",
        intensity: 1.15,
      });
      await wait(1200);
      const expressive = visualTest.captureSourceSnapshot({
        label: "live2d-happy-emphasize",
      });
      return {
        ready: window.MAB_AVATAR_READY,
        renderer: window.MAB_AVATAR_RENDERER,
        avatar: window.MAB_AVATAR_STATE,
        snapshots: { neutral, expressive },
      };
    })()`)) as {
      ready?: unknown;
      renderer?: { live2dLoaded?: boolean; [key: string]: unknown } | null;
      avatar?: AvatarStateSnapshot | null;
      snapshots?: { neutral?: AvatarVisualSnapshot; expressive?: AvatarVisualSnapshot };
    };

    assertSmoke(
      result.renderer?.live2dLoaded === true,
      "Hiyori renderer did not stay in Live2D mode",
      result.renderer,
    );
    assertSmoke(
      result.avatar?.live2dParameterFrames > 20,
      "Hiyori Live2D parameters were not driven",
      result.avatar,
    );
    assertSmoke(
      result.snapshots?.neutral?.ok === true,
      "Hiyori neutral live snapshot failed",
      result.snapshots?.neutral,
    );
    assertSmoke(
      result.snapshots?.expressive?.ok === true,
      "Hiyori expressive live snapshot failed",
      result.snapshots?.expressive,
    );
    assertSmoke(
      result.snapshots?.neutral?.face?.nonBackgroundRatio > 0.02,
      "Hiyori neutral live snapshot looks blank",
      result.snapshots?.neutral,
    );
    assertSmoke(
      result.snapshots?.neutral?.hash !== result.snapshots?.expressive?.hash,
      "Hiyori Live2D state change did not alter pixels",
      result.snapshots,
    );
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await browser.close();
  }
}

export async function runtimeAcceptanceSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-runtime-acceptance-"));
  const env = {
    MAB_MEETING_PORT: "18894",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18894",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18894/healthz");
    const join = await postJson("http://127.0.0.1:18894/join/google-meet", {
      sessionId: "runtime_acceptance_smoke",
      meetUrl: `${fixture.url}?participantAudio=1&runtimeAcceptance=1`,
      botName: "Runtime Acceptance Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installWorkerResultBridge: true,
      installRealtimeBridge: true,
      realtimeBridgeMode: "webrtc-mock",
      includeParticipantAudio: true,
      autoConnectRealtime: true,
      sendRealtimeSessionUpdate: true,
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "runtime acceptance did not join fixture",
      join,
    );
    assertSmoke(
      join.result?.fixtureState?.participantAudio?.trackIds?.length === 1,
      "runtime acceptance fixture did not expose participant audio",
      join.result?.fixtureState,
    );

    const report = await postJson("http://127.0.0.1:18894/worker/report", {
      id: "job_runtime_acceptance",
      status: "completed",
      task: "verify integrated runtime acceptance",
      result: "Runtime acceptance worker result.",
      context: {
        source: "meeting-runtime-acceptance-smoke",
        session_kind: "meeting_copilot",
        meeting_session_id: "runtime_acceptance_smoke",
      },
    });
    assertSmoke(report.ok === true, "runtime acceptance worker report failed", report);

    const statusAfterWorker = await waitForJoinStatus(
      "http://127.0.0.1:18894/join/status",
      (body) =>
        body.active?.realtimeBridge?.workerResults?.some(
          (job) => job.jobId === "job_runtime_acceptance",
        ),
      20_000,
    );

    const meetChat = await postJson("http://127.0.0.1:18894/meet/chat", {
      text: "Direct Meet chat from runtime acceptance smoke.",
    });
    assertSmoke(meetChat.ok === true, "runtime acceptance direct Meet chat failed", meetChat);
    assertSmoke(
      meetChat.fixtureState?.chatMessages?.some(
        (entry) => entry.text === "Direct Meet chat from runtime acceptance smoke.",
      ),
      "runtime acceptance direct Meet chat message was not recorded by the fixture",
      meetChat.fixtureState,
    );

    const finalStatus = await waitForJoinStatus(
      "http://127.0.0.1:18894/join/status",
      (body) => {
        const bridge = body.active?.realtimeBridge;
        const avatar = body.active?.avatarReady?.avatarState;
        return (
          avatar?.mood === "happy" &&
          avatar?.updates?.some(
            (update) => update.kind === "action" && update.action === "emphasize",
          ) &&
          bridge?.workerTools?.calls?.some((call) => call.name === "delegate_to_worker") &&
          bridge?.meetTools?.calls?.some((call) => call.name === "send_meet_chat") &&
          body.active?.fixtureState?.chatMessages?.some(
            (entry) => entry.text === "Direct Meet chat from runtime acceptance smoke.",
          ) &&
          body.active?.fixtureState?.chatMessages?.some(
            (entry) => entry.text === "Realtime hello from runtime acceptance smoke.",
          ) &&
          bridge?.connection?.participantAudioTracksDiscovered > 0
        );
      },
      20_000,
    );

    const active = finalStatus.active;
    const bridge = active?.realtimeBridge;
    const sentEvents = (bridge?.connection?.sentDataChannelMessages || []).map((entry) => {
      try {
        return JSON.parse(entry.payload);
      } catch {
        return {};
      }
    });
    assertSmoke(
      !bridge?.errors?.length,
      "runtime acceptance bridge reported errors",
      bridge?.errors,
    );
    assertSmoke(
      !bridge?.avatarTools?.errors?.length,
      "runtime acceptance avatar tools reported errors",
      bridge?.avatarTools,
    );
    assertSmoke(
      !bridge?.workerTools?.errors?.length,
      "runtime acceptance worker tools reported errors",
      bridge?.workerTools,
    );
    assertSmoke(
      !bridge?.meetTools?.errors?.length,
      "runtime acceptance Meet tools reported errors",
      bridge?.meetTools,
    );
    assertSmoke(
      active?.avatarReady?.avatarState?.mood === "happy",
      "runtime acceptance avatar mood did not update",
      active?.avatarReady?.avatarState,
    );
    assertSmoke(
      active?.avatarReady?.avatarState?.updates?.some(
        (update) => update.kind === "action" && update.action === "emphasize",
      ),
      "runtime acceptance avatar action was not observed",
      active?.avatarReady?.avatarState,
    );
    assertSmoke(
      bridge?.session?.configured === true,
      "runtime acceptance did not send session.update",
      bridge?.session,
    );
    assertSmoke(
      bridge?.connection?.dataChannelOpen === true,
      "runtime acceptance data channel did not open",
      bridge?.connection,
    );
    assertSmoke(
      bridge?.connection?.participantAudioTracksDiscovered > 0,
      "runtime acceptance did not discover participant audio",
      bridge?.connection,
    );
    assertSmoke(
      bridge?.connection?.remoteAudioRoutedToAvatarBus === true,
      "runtime acceptance did not route remote audio to avatar mic bus",
      bridge?.connection,
    );
    assertSmoke(
      sentEvents.some(
        (event) =>
          event.item?.type === "function_call_output" &&
          event.item?.call_id === "call_runtime_acceptance_avatar",
      ),
      "runtime acceptance avatar tool did not emit function_call_output",
      sentEvents,
    );
    assertSmoke(
      sentEvents.some(
        (event) =>
          event.item?.type === "function_call_output" &&
          event.item?.call_id === "call_runtime_acceptance_delegate",
      ),
      "runtime acceptance worker tool did not emit function_call_output",
      sentEvents,
    );
    assertSmoke(
      sentEvents.some(
        (event) =>
          event.item?.type === "function_call_output" &&
          event.item?.call_id === "call_runtime_acceptance_meet_chat",
      ),
      "runtime acceptance Meet chat tool did not emit function_call_output",
      sentEvents,
    );
    assertSmoke(
      active?.fixtureState?.chatMessages?.some(
        (entry) => entry.text === "Realtime hello from runtime acceptance smoke.",
      ),
      "runtime acceptance Meet chat message was not recorded by the fixture",
      active?.fixtureState,
    );

    const workerJobs = await (await fetch("http://127.0.0.1:18894/worker/jobs")).json();
    const stop = await postJson("http://127.0.0.1:18894/join/stop", {
      reason: "runtime_acceptance_smoke_done",
    });
    assertSmoke(stop.ok === true, "runtime acceptance stop failed", stop);
    console.log(
      JSON.stringify({ ok: true, join, statusAfterWorker, finalStatus, workerJobs, stop }, null, 2),
    );
  } finally {
    await postJson("http://127.0.0.1:18894/join/stop", {
      reason: "runtime_acceptance_cleanup",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function realtimeSdkSmoke() {
  const config = getRuntimeConfig();
  const shouldRunLive = shouldRunOptionalSmoke("MAB_RUN_REALTIME_SDK", "MAB_REQUIRE_REALTIME_SDK");
  if (!config.openaiApiKey || !shouldRunLive) {
    const skipped = {
      ok: true,
      skipped: true,
      reason: config.openaiApiKey
        ? "MAB_RUN_REALTIME_SDK not enabled"
        : "MAB_OPENAI_API_KEY/OPENAI_API_KEY missing",
      note: "Set MAB_RUN_REALTIME_SDK=1 to run this optional smoke. Set MAB_REQUIRE_REALTIME_SDK=1 to make it mandatory.",
    };
    if (process.env.MAB_REQUIRE_REALTIME_SDK === "1") {
      assertSmoke(
        false,
        "MAB_OPENAI_API_KEY or OPENAI_API_KEY is required when MAB_REQUIRE_REALTIME_SDK=1",
        skipped,
      );
    }
    console.log(JSON.stringify(skipped, null, 2));
    return;
  }

  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-realtime-sdk-"));
  const env = {
    MAB_MEETING_PORT: "18889",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18889",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18889/healthz");
    const join = await postJson("http://127.0.0.1:18889/join/google-meet", {
      sessionId: "realtime_sdk_smoke",
      meetUrl: fixture.url,
      botName: "Realtime SDK Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installWorkerResultBridge: false,
      installRealtimeBridge: true,
      realtimeBridgeMode: "agents-sdk",
      realtimeAgentRuntime: "agents-sdk",
      autoConnectRealtime: true,
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "Realtime SDK smoke did not join fixture",
      join,
    );

    const status = await waitForJoinStatus(
      "http://127.0.0.1:18889/join/status",
      (body) =>
        body.active?.realtimeBridge?.connected === true ||
        (body.active?.realtimeBridge?.errors || []).length > 0,
      20_000,
    );
    const bridge = status.active?.realtimeBridge;
    assertSmoke(bridge?.errors?.length === 0, "Realtime SDK bridge reported errors", bridge);
    assertSmoke(
      bridge?.connection?.dataChannelOpen === true,
      "Realtime data channel did not open",
      bridge,
    );
    assertSmoke(
      bridge?.agentRuntime?.sdkConnected === true,
      "Realtime Agents SDK session did not connect",
      bridge,
    );
    assertSmoke(
      bridge?.connection?.realtimeInputPlaceholderAdded === true,
      "Realtime SDK bridge did not add an input sender placeholder",
      bridge?.connection,
    );

    console.log(JSON.stringify({ ok: true, join, status }, null, 2));
  } finally {
    await postJson("http://127.0.0.1:18889/join/stop", { reason: "realtime_sdk_smoke_done" }).catch(
      () => {},
    );
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export const realtimeSdpSmoke = realtimeSdkSmoke;
