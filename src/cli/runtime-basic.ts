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

export async function avatarSmoke() {
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
      content: `
        (() => {
          if (typeof globalThis.__name !== "function") {
            Object.defineProperty(globalThis, "__name", {
              value: (fn) => fn,
              configurable: true,
            });
          }
        })();
      `,
    });
    await context.addInitScript({
      content: buildAvatarInitScript({
        botName: "Avatar Smoke Bot",
        disableLive2D: true,
      }),
    });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.waitForFunction(() => window.MAB_AVATAR_READY?.ok === true, null, {
      timeout: 10_000,
    });
    const result = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      return {
        ready: window.MAB_AVATAR_READY,
        videoTracks: stream.getVideoTracks().map((track) => ({
          id: track.id,
          readyState: track.readyState,
          settings: track.getSettings(),
        })),
        audioTracks: stream.getAudioTracks().map((track) => ({
          id: track.id,
          readyState: track.readyState,
          settings: track.getSettings(),
        })),
        devices: await navigator.mediaDevices.enumerateDevices(),
      };
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await browser.close();
  }
}

export async function realtimeSmoke() {
  const config = getRuntimeConfig();
  const session = buildRealtimeSessionConfig({ botName: "Smoke Bot" }, config) as unknown as {
    model?: string;
    output_modalities?: string[];
    reasoning?: { effort?: string };
    audio?: { input?: { turn_detection?: { type?: string } } };
    [key: string]: unknown;
  };
  const reports = createWorkerReportStore();
  const job = reports.create({
    id: "job_smoke",
    status: "completed",
    task: "smoke worker completion",
    result: "Worker result is ready.",
  });
  const polled = reports.pollReadyForRealtime({ limit: 1, markDelivered: true });
  assertSmoke(
    session.model === "gpt-realtime-2",
    "Realtime default model is not gpt-realtime-2",
    session,
  );
  assertSmoke(
    Boolean(session.output_modalities?.includes("audio")),
    "Realtime 2 session did not request audio output",
    session,
  );
  assertSmoke(
    session.reasoning?.effort === "high",
    "Realtime 2 default reasoning effort should be high",
    session,
  );
  assertSmoke(
    session.audio?.input?.turn_detection?.type === "semantic_vad",
    "Realtime 2 session should default to semantic_vad",
    session,
  );
  assertSmoke(
    !("modalities" in session),
    "Realtime 2 session should not use legacy modalities",
    session,
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        instructions: buildRealtimeInstructions({ botName: "Smoke Bot" }),
        toolNames: realtimeToolSchemas.map((tool) => tool.name),
        session,
        job,
        polled,
        afterPoll: reports.get(job.id),
      },
      null,
      2,
    ),
  );
}

export async function meetSmoke() {
  const fixture = await startLocalMeetFixtureServer();
  const joiner = createGoogleMeetJoiner({ allowNonGoogleMeet: true });
  try {
    const first = await joiner.join({
      sessionId: "meet_smoke_first",
      meetUrl: fixture.url,
      botName: "Meet Smoke Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      disableLive2D: true,
      collectFixtureState: true,
    });
    assertSmoke(first.clickedJoinSelector, "fixture join button was not clicked", first);
    assertSmoke(
      first.fixtureState?.joined === true,
      "fixture did not observe joined state",
      first.fixtureState,
    );
    assertSmoke(
      first.fixtureState?.name === "Meet Smoke Bot",
      "fixture did not receive bot display name",
      first.fixtureState,
    );
    assertSmoke(
      first.fixtureState?.media?.videoTracks?.length === 1,
      "fixture did not receive fake video track",
      first.fixtureState?.media,
    );
    assertSmoke(
      first.fixtureState?.media?.audioTracks?.length === 1,
      "fixture did not receive fake audio track",
      first.fixtureState?.media,
    );

    const second = await joiner.join({
      sessionId: "meet_smoke_second",
      meetUrl: fixture.url,
      botName: "Meet Smoke Bot 2",
      dryRun: false,
      allowNonGoogleMeet: true,
      disableLive2D: true,
      collectFixtureState: true,
    });
    assertSmoke(
      second.replacementStop?.stopped === true,
      "second join did not stop the first active browser",
      second.replacementStop,
    );
    assertSmoke(
      second.fixtureState?.joined === true,
      "second fixture join failed",
      second.fixtureState,
    );
    const status = await joiner.status();
    assertSmoke(
      status.active?.sessionId === "meet_smoke_second",
      "joiner status did not track the second session",
      status,
    );
    const stop = await joiner.stop("meet_smoke_done");
    assertSmoke(stop.stopped === true, "joiner stop did not close active browser", stop);
    console.log(
      JSON.stringify({ ok: true, fixtureUrl: fixture.url, first, second, status, stop }, null, 2),
    );
  } finally {
    await joiner.stop("meet_smoke_cleanup").catch(() => {});
    await fixture.close();
  }
}

export async function meetContractSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-meet-contract-"));
  const screenshotDir = pathJoin(dataDir, "screenshots");
  const env = {
    MAB_MEETING_PORT: "18922",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18922",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
    MAB_SCREENSHOT_DIR: screenshotDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const fixtureUrl = `${fixture.url}?participantAudio=1`;
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const directJoiner = createGoogleMeetJoiner();

  try {
    const dryRun = await directJoiner.join({
      sessionId: "meet_contract_dry_run",
      meetUrl: "https://meet.google.com/abc-defg-hij?authuser=2",
      botName: "Meet Contract Bot",
      dryRun: true,
    });
    assertSmoke(dryRun.dryRun === true, "Meet dry-run contract did not return dryRun=true", dryRun);
    assertSmoke(
      dryRun.plan?.provider === "google-meet",
      "Meet dry-run plan did not report google-meet provider",
      dryRun,
    );
    assertSmoke(
      dryRun.plan?.botName === "Meet Contract Bot",
      "Meet dry-run plan did not preserve bot name",
      dryRun,
    );
    assertSmoke(
      dryRun.plan?.meetUrl?.includes("abc-defg-hij"),
      "Meet dry-run plan did not preserve Meet URL",
      dryRun,
    );
    assertSmoke(
      dryRun.plan?.steps?.some((step) => step.includes("click Join")),
      "Meet dry-run plan did not include join click step",
      dryRun.plan,
    );

    let invalidUrlError = "";
    try {
      await directJoiner.join({
        sessionId: "meet_contract_invalid",
        meetUrl: "https://example.com/not-a-meet",
        dryRun: true,
      });
    } catch (error) {
      invalidUrlError = String(error?.message || error);
    }
    assertSmoke(
      invalidUrlError.includes("Google Meet URL"),
      "Meet joiner accepted a non-Google Meet URL without allowNonGoogleMeet",
      { invalidUrlError },
    );

    const fixtureDryRun = await directJoiner.join({
      sessionId: "meet_contract_fixture_dry_run",
      meetUrl: fixture.url,
      botName: "Fixture Contract Bot",
      dryRun: true,
      allowNonGoogleMeet: true,
      installRealtimeBridge: false,
      installWorkerResultBridge: false,
    });
    assertSmoke(
      fixtureDryRun.plan?.allowNonGoogleMeet === true &&
        fixtureDryRun.plan?.meetUrl === fixture.url,
      "Meet joiner did not honor allowNonGoogleMeet for fixture dry-run",
      fixtureDryRun,
    );

    await waitForHealth("http://127.0.0.1:18922/healthz");

    const serviceDryRun = await postJson("http://127.0.0.1:18922/join/google-meet", {
      sessionId: "meet_contract_service_dry_run",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      botName: "Service Dry Run Bot",
      dryRun: true,
    });
    assertSmoke(
      serviceDryRun.ok === true && serviceDryRun.result?.dryRun === true,
      "Meeting Agent dry-run route failed",
      serviceDryRun,
    );
    assertSmoke(
      serviceDryRun.result?.plan?.installAvatar === true,
      "Meeting Agent dry-run did not install avatar by default",
      serviceDryRun,
    );

    const serviceInvalid = await postJsonWithStatus("http://127.0.0.1:18922/join/google-meet", {
      sessionId: "meet_contract_service_invalid",
      meetUrl: "https://example.com/not-a-meet",
      botName: "Invalid Service Bot",
      dryRun: true,
    });
    assertSmoke(
      serviceInvalid.httpStatus === 500 && serviceInvalid.detail?.includes("Google Meet URL"),
      "Meeting Agent route accepted invalid Meet URL",
      serviceInvalid,
    );

    const firstJoin = await postJson("http://127.0.0.1:18922/join/google-meet", {
      sessionId: "meet_contract_first",
      meetUrl: fixtureUrl,
      botName: "Meet Contract First",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installWorkerResultBridge: false,
      installRealtimeBridge: true,
      realtimeBridgeMode: "webrtc-mock",
      autoConnectRealtime: true,
    });
    const first = firstJoin.result;
    assertSmoke(
      first?.clickedJoinSelector,
      "Meet contract first join did not click Join",
      firstJoin,
    );
    assertSmoke(
      first?.fixtureState?.joined === true,
      "Meet contract fixture did not enter joined state",
      first?.fixtureState,
    );
    assertSmoke(
      first?.fixtureState?.name === "Meet Contract First",
      "Meet contract fixture did not preserve bot name",
      first?.fixtureState,
    );
    assertSmoke(
      first?.fixtureState?.media?.videoTracks?.length === 1,
      "Meet contract fixture did not receive fake video",
      first?.fixtureState?.media,
    );
    assertSmoke(
      first?.fixtureState?.media?.audioTracks?.length === 1,
      "Meet contract fixture did not receive fake audio",
      first?.fixtureState?.media,
    );
    assertSmoke(
      first?.fixtureState?.participantAudio?.trackIds?.length === 1,
      "Meet contract fixture did not expose participant audio",
      first?.fixtureState,
    );
    assertSmoke(
      first?.avatarReady?.ok === true,
      "Meet contract avatar runtime was not ready",
      first?.avatarReady,
    );
    assertSmoke(
      first?.avatarAudio?.ok === true,
      "Meet contract avatar fake mic bus was not ready",
      first?.avatarAudio,
    );
    assertSmoke(
      first?.screenshots?.length >= 2,
      "Meet contract did not capture diagnostics screenshots",
      first?.screenshots,
    );
    assertSmoke(
      existsSync(first?.diagnosticsPath || ""),
      "Meet contract diagnostics JSON was not written",
      { diagnosticsPath: first?.diagnosticsPath },
    );
    assertSmoke(
      first?.buttonInventories?.some((inventory) =>
        inventory.buttons?.some((button) => /join now/i.test(button.aria || button.text || "")),
      ),
      "Meet contract diagnostics did not record the fixture join button",
      first?.buttonInventories,
    );

    const participantStatus = await waitForJoinStatus(
      "http://127.0.0.1:18922/join/status",
      (body) =>
        body.active?.realtimeBridge?.connection?.participantAudioTracksDiscovered >= 1 ||
        (body.active?.realtimeBridge?.errors || []).length > 0,
      8_000,
    );
    const bridge = participantStatus.active?.realtimeBridge;
    assertSmoke(!bridge?.errors?.length, "Meet contract Realtime bridge reported errors", bridge);
    assertSmoke(
      bridge?.connection?.participantAudioTracksDiscovered >= 1,
      "Meet contract did not discover participant audio through the bridge",
      bridge?.connection,
    );
    assertSmoke(
      bridge?.connection?.participantAudioSources?.some(
        (source) => source.label === "fixture-participant-audio",
      ),
      "Meet contract did not preserve participant audio source label",
      bridge?.connection,
    );

    const secondJoin = await postJson("http://127.0.0.1:18922/join/google-meet", {
      sessionId: "meet_contract_second",
      meetUrl: fixture.url,
      botName: "Meet Contract Second",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installRealtimeBridge: false,
      installWorkerResultBridge: false,
    });
    const second = secondJoin.result;
    assertSmoke(
      second?.replacementStop?.stopped === true,
      "Meet contract second join did not stop the first browser",
      second?.replacementStop,
    );
    assertSmoke(
      second?.replacementStop?.sessionId === "meet_contract_first",
      "Meet contract replacement stopped the wrong session",
      second?.replacementStop,
    );
    assertSmoke(
      second?.fixtureState?.joined === true,
      "Meet contract second fixture join failed",
      second?.fixtureState,
    );

    const status = await (await fetch("http://127.0.0.1:18922/join/status")).json();
    assertSmoke(
      status.active?.sessionId === "meet_contract_second",
      "Meet contract status did not track second active session",
      status,
    );
    assertSmoke(
      status.active?.fixtureState?.joined === true,
      "Meet contract status did not refresh fixture state",
      status.active,
    );

    const stop = await postJson("http://127.0.0.1:18922/join/stop", {
      reason: "meet_contract_done",
    });
    assertSmoke(
      stop.result?.stopped === true,
      "Meet contract stop route did not close active browser",
      stop,
    );
    assertSmoke(
      stop.result?.sessionId === "meet_contract_second",
      "Meet contract stop closed the wrong session",
      stop,
    );
    const afterStop = await (await fetch("http://127.0.0.1:18922/join/status")).json();
    assertSmoke(
      afterStop.active === null,
      "Meet contract status remained active after stop",
      afterStop,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          contracts: {
            dryRun,
            invalidUrlRejected: true,
            fixtureDryRun,
            serviceDryRun,
            serviceInvalid,
            firstJoin,
            participantStatus,
            secondJoin,
            status,
            stop,
            afterStop,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await postJson("http://127.0.0.1:18922/join/stop", { reason: "meet_contract_cleanup" }).catch(
      () => {},
    );
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function screenShareSmoke() {
  const fixture = await startLocalMeetFixtureServer();
  const joiner = createGoogleMeetJoiner({ allowNonGoogleMeet: true });
  try {
    const join = await joiner.join({
      sessionId: "screen_share_smoke",
      meetUrl: fixture.url,
      botName: "Screen Share Smoke Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installRealtimeBridge: false,
      installWorkerResultBridge: false,
      installScreenShareBridge: true,
      autoStartScreenShare: false,
      screenShareTitle: "Meeting Avatar Bot",
      screenShareSubtitle: "Screen share smoke",
    });
    assertSmoke(
      join.ok === true && join.clickedJoinSelector,
      "screen-share smoke did not join fixture",
      join,
    );
    const present = await joiner.presentScreenShare({
      title: "Meeting Avatar Bot",
      subtitle: "Screen share smoke",
      waitMs: 700,
    });
    assertSmoke(
      present.ok === true && present.clickedSelector,
      "screen-share present path did not click share control",
      present,
    );
    assertSmoke(
      present.screenShare?.active === true,
      "screen-share bridge did not become active",
      present.screenShare,
    );
    assertSmoke(
      present.fixtureState?.screenShare?.videoTracks?.length === 1,
      "fixture did not receive screen-share stream",
      present.fixtureState?.screenShare,
    );
    assertSmoke(
      present.fixtureState?.screenShare?.videoTracks?.[0]?.settings?.width >= 640,
      "screen-share stream did not expose useful video settings",
      present.fixtureState?.screenShare,
    );
    const status = await joiner.status();
    assertSmoke(
      status.active?.screenShare?.active === true,
      "joiner status did not expose active screen-share state",
      status,
    );
    const stoppedShare = await joiner.stopScreenShare();
    assertSmoke(
      stoppedShare.ok === true && stoppedShare.screenShare?.active === false,
      "screen-share stop did not deactivate stream",
      stoppedShare,
    );
    const stop = await joiner.stop("screen_share_smoke_done");
    assertSmoke(stop.stopped === true, "screen-share smoke did not close active browser", stop);
    console.log(
      JSON.stringify(
        { ok: true, fixtureUrl: fixture.url, join, present, status, stoppedShare, stop },
        null,
        2,
      ),
    );
  } finally {
    await joiner.stop("screen_share_smoke_cleanup").catch(() => {});
    await fixture.close();
  }
}

export async function realMeetSmoke() {
  const meetUrl = process.env.MAB_REAL_MEET_URL || "";
  const required = process.env.MAB_REQUIRE_REAL_MEET === "1";
  if (!meetUrl) {
    const skipped = {
      ok: true,
      skipped: true,
      reason: "MAB_REAL_MEET_URL missing",
      note: "Set MAB_REAL_MEET_URL and MAB_REQUIRE_REAL_MEET=1 to make this optional smoke mandatory.",
    };
    if (required) {
      assertSmoke(false, "MAB_REAL_MEET_URL is required when MAB_REQUIRE_REAL_MEET=1", skipped);
    }
    console.log(JSON.stringify(skipped, null, 2));
    return;
  }

  const sessionId = process.env.MAB_REAL_MEET_SESSION_ID || `real_meet_${Date.now()}`;
  const botName = process.env.MAB_REAL_MEET_BOT_NAME || "Meeting Avatar Real Smoke";
  const waitMs = Number.parseInt(process.env.MAB_REAL_MEET_WAIT_MS || "8000", 10);
  const joiner = createGoogleMeetJoiner();
  try {
    const join = await joiner.join({
      sessionId,
      meetUrl,
      botName,
      dryRun: false,
      disableLive2D: process.env.MAB_REAL_MEET_DISABLE_LIVE2D === "1",
      installWorkerResultBridge: true,
      installRealtimeBridge: true,
      realtimeBridgeMode: "mock",
      autoConnectRealtime: false,
      sendRealtimeSessionUpdate: false,
    });
    assertSmoke(
      join.ok === true && join.dryRun === false,
      "real Meet smoke did not perform a non-dry-run join",
      join,
    );
    assertSmoke(join.clickedJoinSelector, "real Meet smoke did not click a join button", join);
    assertSmoke(
      join.avatarReady?.ok === true,
      "real Meet smoke avatar/fake media was not ready",
      join.avatarReady,
    );
    assertSmoke(
      join.avatarAudio?.ok === true,
      "real Meet smoke avatar audio bus was not ready",
      join.avatarAudio,
    );

    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const status = (await joiner.status()) as {
      active?: {
        avatarReady?: unknown;
        avatarAudio?: unknown;
        realtimeBridge?: {
          connection?: { participantAudioTracksDiscovered?: number };
          [key: string]: unknown;
        };
        [key: string]: unknown;
      };
    };
    const active = status.active || {};
    type ButtonInventoryEntry = {
      buttons?: Array<{ visible?: boolean; aria?: string; text?: string }>;
    };
    const inventories = ((join as { buttonInventories?: ButtonInventoryEntry[] })
      .buttonInventories || []) as ButtonInventoryEntry[];
    const latestInventory: ButtonInventoryEntry = inventories.at(-1) || {};
    const latestButtons = latestInventory.buttons || [];
    const visibleButtonLabels = latestButtons
      .filter((button) => button.visible)
      .map((button) => button.aria || button.text || "")
      .filter(Boolean);
    const inCallControlsVisible = visibleButtonLabels.some((label) =>
      /leave call|turn off microphone|turn off camera/i.test(label),
    );
    const participantAudioTracks =
      active.realtimeBridge?.connection?.participantAudioTracksDiscovered || 0;
    assertSmoke(
      inCallControlsVisible || participantAudioTracks > 0,
      "real Meet smoke did not observe in-call controls or participant audio tracks",
      { visibleButtonLabels, participantAudioTracks, join, status },
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          meetUrl,
          sessionId,
          botName,
          clickedJoinSelector: join.clickedJoinSelector,
          diagnosticsPath: join.diagnosticsPath,
          screenshots: join.screenshots,
          visibleButtonLabels,
          inCallControlsVisible,
          participantAudioTracks,
          avatarReady: active.avatarReady || join.avatarReady,
          avatarAudio: active.avatarAudio || join.avatarAudio,
          realtimeBridge: active.realtimeBridge || null,
        },
        null,
        2,
      ),
    );
  } finally {
    await joiner.stop("real_meet_smoke_done").catch(() => {});
  }
}

export async function persistenceSmokeForProvider({ provider, slackPort, meetingPort }) {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), `meeting-avatar-bot-persist-${provider}-`));
  const sqlitePath = pathJoin(dataDir, "state.sqlite3");
  const env = {
    MAB_SLACK_PORT: String(slackPort),
    MAB_MEETING_PORT: String(meetingPort),
    MAB_MEETING_AGENT_URL: `http://127.0.0.1:${meetingPort}`,
    MAB_STATE_PROVIDER: provider,
    MAB_STATE_SQLITE_PATH: sqlitePath,
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    SLACK_SIGNING_SECRET: `persist-signing-secret-${provider}`,
  };
  const slackUrl = `http://127.0.0.1:${slackPort}`;
  const meetingUrl = `http://127.0.0.1:${meetingPort}`;

  let meeting = null;
  let slack = null;
  try {
    meeting = startService("apps/meeting-agent/src/index.js", env);
    slack = startService("apps/slack-agent/src/index.js", env);
    await waitForServiceHealth(meeting, `${meetingUrl}/healthz`);
    await waitForServiceHealth(slack, `${slackUrl}/healthz`);
    const firstSlackHealth = await (await fetch(`${slackUrl}/healthz`)).json();
    const firstMeetingHealth = await (await fetch(`${meetingUrl}/healthz`)).json();
    assertSmoke(
      firstSlackHealth.state?.provider === provider,
      `Slack Agent did not use ${provider} state provider`,
      firstSlackHealth,
    );
    assertSmoke(
      firstMeetingHealth.state?.provider === provider,
      `Meeting Agent did not use ${provider} state provider`,
      firstMeetingHealth,
    );
    assertSmoke(
      firstMeetingHealth.state?.workerReportProvider === provider,
      `Meeting worker reports did not use ${provider} state provider`,
      firstMeetingHealth,
    );
    if (provider === "sqlite") {
      assertSmoke(
        firstSlackHealth.state?.sessionPath === sqlitePath,
        "Slack Agent sqlite path mismatch",
        firstSlackHealth,
      );
      assertSmoke(
        firstMeetingHealth.state?.workerReportPath === sqlitePath,
        "Meeting worker sqlite path mismatch",
        firstMeetingHealth,
      );
    }

    const join = await postSignedSlackCommand(
      `${slackUrl}/slack/commands/avatar`,
      `join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name Persist${provider}`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    const sessionId = join.session?.id;
    assertSmoke(
      sessionId,
      `persistence smoke did not create a Slack session for ${provider}`,
      join,
    );

    const delegate = await postSignedSlackCommand(
      `${slackUrl}/slack/commands/avatar`,
      `delegate --session ${sessionId} remember this completed ${provider} worker job`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      delegate.job?.status === "completed",
      `persistence smoke worker did not complete for ${provider}`,
      delegate,
    );

    for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));

    meeting = startService("apps/meeting-agent/src/index.js", env);
    slack = startService("apps/slack-agent/src/index.js", env);
    await waitForServiceHealth(meeting, `${meetingUrl}/healthz`);
    await waitForServiceHealth(slack, `${slackUrl}/healthz`);
    const secondSlackHealth = await (await fetch(`${slackUrl}/healthz`)).json();
    const secondMeetingHealth = await (await fetch(`${meetingUrl}/healthz`)).json();
    assertSmoke(
      secondSlackHealth.state?.provider === provider,
      `Slack Agent state provider changed after restart for ${provider}`,
      secondSlackHealth,
    );
    assertSmoke(
      secondMeetingHealth.state?.workerReportProvider === provider,
      `Meeting worker report provider changed after restart for ${provider}`,
      secondMeetingHealth,
    );

    const sessionsAfterRestart = await (await fetch(`${slackUrl}/sessions`)).json();
    assertSmoke(
      sessionsAfterRestart.sessions.some((session) => session.id === sessionId),
      `Slack session was not restored after service restart for ${provider}`,
      sessionsAfterRestart,
    );

    const jobsAfterRestart = await (await fetch(`${meetingUrl}/worker/jobs`)).json();
    assertSmoke(
      jobsAfterRestart.jobs.some((job) => job.id === delegate.job.id),
      `Meeting worker job was not restored after service restart for ${provider}`,
      jobsAfterRestart,
    );

    return {
      provider,
      dataDir,
      sqlitePath: provider === "sqlite" ? sqlitePath : "",
      health: { firstSlackHealth, firstMeetingHealth, secondSlackHealth, secondMeetingHealth },
      join,
      delegate,
      sessionsAfterRestart,
      jobsAfterRestart,
    };
  } finally {
    for (const service of [slack, meeting]) {
      if (service) service.child.kill("SIGTERM");
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function persistenceSmoke() {
  const jsonFile = await persistenceSmokeForProvider({
    provider: "json-file",
    slackPort: 18884,
    meetingPort: 18885,
  });
  const sqlite = await persistenceSmokeForProvider({
    provider: "sqlite",
    slackPort: 18894,
    meetingPort: 18895,
  });
  console.log(
    JSON.stringify(
      { ok: true, providers: ["json-file", "sqlite"], results: [jsonFile, sqlite] },
      null,
      2,
    ),
  );
}
