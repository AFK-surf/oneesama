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
  redactSecret
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
  CutoverEvidenceManifest
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
  postSignedSlackJson
} from "./support.js";

export async function stateProviderSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-state-provider-"));
  const sessionPath = pathJoin(dataDir, "sessions.json");
  const jobsPath = pathJoin(dataDir, "worker-reports.json");
  const sqlitePath = pathJoin(dataDir, "state.sqlite3");
  const closeables = [];
  try {
    const sessions = createSessionStore({ provider: "json-file", filePath: sessionPath });
    const session = sessions.create({
      source: "state-provider-smoke",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      requestedBy: "smoke",
    });
    sessions.update(session.id, { status: "joined" });

    const restoredSessions = createSessionStore({ provider: "json-file", filePath: sessionPath });
    const restoredSession = restoredSessions.get(session.id);
    assertSmoke(
      restoredSessions.provider === "json-file",
      "session store did not report json-file provider",
      restoredSessions,
    );
    assertSmoke(
      restoredSession?.status === "joined",
      "json-file session provider did not restore updated session",
      restoredSession,
    );

    const reports = createWorkerReportStore({ provider: "json-file", filePath: jobsPath });
    const job = reports.create({
      id: "job_state_provider_smoke",
      status: "completed",
      task: "persist this worker result",
      result: "worker result survived restart",
    });
    const ready = reports.pollReadyForSlack({ limit: 1, markDelivered: true });
    assertSmoke(ready[0]?.id === job.id, "json-file worker provider did not poll ready job", ready);

    const restoredReports = createWorkerReportStore({ provider: "json-file", filePath: jobsPath });
    const restoredJob = restoredReports.get(job.id);
    assertSmoke(
      restoredReports.provider === "json-file",
      "worker report store did not report json-file provider",
      restoredReports,
    );
    assertSmoke(
      restoredJob?.deliveredToSlack === true,
      "json-file worker provider did not persist delivery marker",
      restoredJob,
    );

    const memorySessions = createSessionStore({
      provider: "memory",
      filePath: pathJoin(dataDir, "ignored.json"),
    });
    const memorySession = memorySessions.create({ source: "memory-provider-smoke" });
    const freshMemorySessions = createSessionStore({
      provider: "memory",
      filePath: pathJoin(dataDir, "ignored.json"),
    });
    assertSmoke(
      memorySessions.provider === "memory" && memorySessions.path === "",
      "memory state provider did not stay in-memory",
      memorySessions,
    );
    assertSmoke(
      !freshMemorySessions.get(memorySession.id),
      "memory state provider unexpectedly restored state",
      {
        original: memorySession,
        restored: freshMemorySessions.get(memorySession.id),
      },
    );

    const legacyDb = new Database(sqlitePath);
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS thread_case (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        channel_id TEXT,
        thread_ts TEXT,
        status TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS meeting (
        id TEXT PRIMARY KEY,
        meet_url TEXT,
        status TEXT,
        updated_at TEXT
      );
      INSERT OR REPLACE INTO thread_case (id, workspace_id, channel_id, thread_ts, status, updated_at)
      VALUES ('legacy_thread_case', 'T_SMOKE', 'C_SMOKE', '123.456', 'open', '2026-05-08T00:00:00.000Z');
      INSERT OR REPLACE INTO meeting (id, meet_url, status, updated_at)
      VALUES ('legacy_meeting', 'https://meet.google.com/abc-defg-hij', 'scheduled', '2026-05-08T00:00:00.000Z');
    `);
    legacyDb.close();

    const sqliteSessions = createSessionStore({
      provider: "sqlite",
      sqlitePath,
      collection: "slack_sessions",
    });
    closeables.push(sqliteSessions);
    const sqliteSession = sqliteSessions.create({
      source: "sqlite-state-provider-smoke",
      meetUrl: "https://meet.google.com/sql-ite-smk",
      requestedBy: "smoke",
    });
    sqliteSessions.update(sqliteSession.id, { status: "sqlite_joined" });
    const restoredSqliteSessions = createSessionStore({
      provider: "sqlite",
      sqlitePath,
      collection: "slack_sessions",
    });
    closeables.push(restoredSqliteSessions);
    const restoredSqliteSession = restoredSqliteSessions.get(sqliteSession.id);
    assertSmoke(
      restoredSqliteSessions.provider === "sqlite",
      "session store did not report sqlite provider",
      restoredSqliteSessions,
    );
    assertSmoke(
      restoredSqliteSession?.status === "sqlite_joined",
      "sqlite session provider did not restore updated session",
      restoredSqliteSession,
    );

    const sqliteReports = createWorkerReportStore({
      provider: "sqlite",
      sqlitePath,
      collection: "worker_reports",
    });
    closeables.push(sqliteReports);
    const sqliteJob = sqliteReports.create({
      id: "job_sqlite_state_provider_smoke",
      status: "completed",
      task: "persist this sqlite worker result",
      result: "sqlite worker result survived restart",
    });
    const sqliteReady = sqliteReports.pollReadyForSlack({ limit: 1, markDelivered: true });
    assertSmoke(
      sqliteReady[0]?.id === sqliteJob.id,
      "sqlite worker provider did not poll ready job",
      sqliteReady,
    );
    const restoredSqliteReports = createWorkerReportStore({
      provider: "sqlite",
      sqlitePath,
      collection: "worker_reports",
    });
    closeables.push(restoredSqliteReports);
    const restoredSqliteJob = restoredSqliteReports.get(sqliteJob.id);
    assertSmoke(
      restoredSqliteJob?.deliveredToSlack === true,
      "sqlite worker provider did not persist delivery marker",
      restoredSqliteJob,
    );

    const concurrentA = createSessionStore({
      provider: "sqlite",
      sqlitePath,
      collection: "concurrent_sessions",
    });
    const concurrentB = createSessionStore({
      provider: "sqlite",
      sqlitePath,
      collection: "concurrent_sessions",
    });
    closeables.push(concurrentA, concurrentB);
    const concurrentSessionA = concurrentA.create({
      source: "sqlite-concurrent-a",
      requestedBy: "a",
    });
    const concurrentSessionB = concurrentB.create({
      source: "sqlite-concurrent-b",
      requestedBy: "b",
    });
    concurrentA.update(concurrentSessionA.id, { status: "writer_a_updated" });
    concurrentB.update(concurrentSessionB.id, { status: "writer_b_updated" });
    const concurrentReader = createSessionStore({
      provider: "sqlite",
      sqlitePath,
      collection: "concurrent_sessions",
    });
    closeables.push(concurrentReader);
    assertSmoke(
      concurrentReader.get(concurrentSessionA.id)?.status === "writer_a_updated" &&
        concurrentReader.get(concurrentSessionB.id)?.status === "writer_b_updated",
      "sqlite state provider did not survive interleaved writers",
      {
        a: concurrentReader.get(concurrentSessionA.id),
        b: concurrentReader.get(concurrentSessionB.id),
      },
    );

    const inspectDb = new Database(sqlitePath, { readonly: true });
    const tableNames = inspectDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    const migrations = inspectDb
      .prepare("SELECT version, name FROM mab_schema_migrations ORDER BY version")
      .all();
    inspectDb.close();
    for (const expectedTable of [
      "mab_schema_migrations",
      "mab_state_collection",
      "thread_case",
      "meeting",
    ]) {
      assertSmoke(
        tableNames.includes(expectedTable),
        `sqlite compatibility table missing: ${expectedTable}`,
        tableNames,
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          providers: ["memory", "json-file", "sqlite"],
          sessionPath,
          jobsPath,
          sqlitePath,
          restoredSession,
          restoredJob,
          memory: { provider: memorySessions.provider, path: memorySessions.path },
          sqlite: {
            restoredSession: restoredSqliteSession,
            restoredJob: restoredSqliteJob,
            concurrent: concurrentReader.list(),
            migrations,
            tableNames,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    for (const closeable of closeables) closeable.close?.();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function workerBridgeSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-worker-bridge-"));
  const env = {
    MAB_MEETING_PORT: "18886",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18886",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18886/healthz");
    const workerResultMinCreatedAt = new Date(Date.now() - 1000).toISOString();
    const longWorkerResult = [
      "Worker bridge smoke long detail sentinel.",
      "This is intentionally long so the bridge writes the full result to Meet chat instead of asking Realtime to read it aloud.",
      "DETAIL_SENTINEL_".repeat(70),
    ].join("\n");
    const reported = await postJson("http://127.0.0.1:18886/worker/report", {
      id: "job_worker_bridge_smoke",
      status: "completed",
      task: "prepare a spoken status update",
      result: longWorkerResult,
      context: {
        source: "meeting-worker-bridge-smoke",
        session_kind: "meeting_copilot",
        meeting_session_id: "worker_bridge_smoke",
      },
    });
    assertSmoke(reported.ok === true, "worker report route failed", reported);

    const join = await postJson("http://127.0.0.1:18886/join/google-meet", {
      sessionId: "worker_bridge_smoke",
      meetUrl: fixture.url,
      botName: "Worker Bridge Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      workerPollUrl: "http://127.0.0.1:18886/worker/poll-realtime",
      workerResultMinCreatedAt,
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "worker bridge smoke did not join fixture",
      join,
    );

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const status = await (await fetch("http://127.0.0.1:18886/join/status")).json();
    const workerJobs = await (await fetch("http://127.0.0.1:18886/worker/jobs")).json();
    const deliveredJob = workerJobs.jobs.find((job) => job.id === "job_worker_bridge_smoke");
    assertSmoke(
      deliveredJob?.deliveredToRealtime === true,
      "worker job was not marked delivered to realtime",
      {
        workerJobs,
        workerResultBridge: status.active?.workerResultBridge,
        meetPage: status.active?.meetPage,
      },
    );
    const realtimeTexts = (status.active?.fixtureState?.realtimeEvents || [])
      .flatMap((event) => event.item?.content || [])
      .map((content) => String(content.text || ""));
    assertSmoke(
      (status.active?.fixtureState?.chatMessages || []).some((entry) =>
        String(entry.text || "").includes("Worker bridge smoke long detail sentinel"),
      ),
      "long worker result was not written to Meet chat",
      status.active?.fixtureState,
    );
    assertSmoke(
      realtimeTexts.some((text) => text.includes("完整结果我已经发到 Meet chat")),
      "long worker result did not use short voice handoff text",
      realtimeTexts,
    );
    assertSmoke(
      !realtimeTexts.some((text) => text.includes("DETAIL_SENTINEL_DETAIL_SENTINEL")),
      "long worker result leaked into realtime voice context",
      realtimeTexts,
    );
    assertSmoke(
      status.active?.workerResultBridge?.delivered?.some(
        (job) => job.jobId === "job_worker_bridge_smoke",
      ),
      "worker bridge did not deliver the meeting-scoped worker job to the browser",
      status.active?.workerResultBridge,
    );

    console.log(JSON.stringify({ ok: true, reported, join, status, workerJobs }, null, 2));
  } finally {
    await postJson("http://127.0.0.1:18886/join/stop", {
      reason: "worker_bridge_smoke_done",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function realtimeBrowserSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-realtime-browser-"));
  const env = {
    MAB_MEETING_PORT: "18887",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18887",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18887/healthz");
    const workerResultMinCreatedAt = new Date(Date.now() - 1000).toISOString();
    const reported = await postJson("http://127.0.0.1:18887/worker/report", {
      id: "job_realtime_browser_smoke",
      status: "completed",
      task: "summarize completed browser bridge work",
      result: "Realtime browser bridge smoke result.",
      context: {
        source: "meeting-realtime-browser-smoke",
        session_kind: "meeting_copilot",
        meeting_session_id: "realtime_browser_smoke",
      },
    });
    assertSmoke(reported.ok === true, "realtime browser worker report failed", reported);

    const join = await postJson("http://127.0.0.1:18887/join/google-meet", {
      sessionId: "realtime_browser_smoke",
      meetUrl: fixture.url,
      botName: "Realtime Browser Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      workerPollUrl: "http://127.0.0.1:18887/worker/poll-realtime",
      workerResultMinCreatedAt,
      installRealtimeBridge: true,
      realtimeBridgeMode: "mock",
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "realtime browser smoke did not join fixture",
      join,
    );

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const status = await (await fetch("http://127.0.0.1:18887/join/status")).json();
    const workerJobs = await (await fetch("http://127.0.0.1:18887/worker/jobs")).json();
    const realtimeEvents = status.active?.fixtureState?.realtimeEvents || [];
    const eventTypes = new Set(realtimeEvents.map((event) => event.type));
    const deliveredJob = workerJobs.jobs.find((job) => job.id === "job_realtime_browser_smoke");
    assertSmoke(
      deliveredJob?.deliveredToRealtime === true,
      "worker job was not marked delivered to realtime",
      {
        workerJobs,
        workerResultBridge: status.active?.workerResultBridge,
        realtimeBridge: status.active?.realtimeBridge,
      },
    );
    assertSmoke(
      eventTypes.has("conversation.item.create"),
      "worker result did not create a realtime conversation item",
      status,
    );
    assertSmoke(
      eventTypes.has("response.create"),
      "worker result did not request a realtime response",
      status,
    );
    assertSmoke(
      status.active?.realtimeBridge?.responsesRequested >= 1,
      "browser realtime bridge did not record a response request",
      status.active?.realtimeBridge,
    );

    console.log(JSON.stringify({ ok: true, reported, join, status, workerJobs }, null, 2));
  } finally {
    await postJson("http://127.0.0.1:18887/join/stop", {
      reason: "realtime_browser_smoke_done",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function realtimeWebrtcSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-realtime-webrtc-"));
  const env = {
    MAB_MEETING_PORT: "18888",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18888",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18888/healthz");
    const workerResultMinCreatedAt = new Date(Date.now() - 1000).toISOString();
    const reported = await postJson("http://127.0.0.1:18888/worker/report", {
      id: "job_realtime_webrtc_smoke",
      status: "completed",
      task: "verify data-channel worker result reporting",
      result: "Realtime WebRTC smoke result.",
      context: {
        source: "meeting-realtime-webrtc-smoke",
        session_kind: "meeting_copilot",
        meeting_session_id: "realtime_webrtc_smoke",
      },
    });
    assertSmoke(reported.ok === true, "realtime webrtc worker report failed", reported);

    const join = await postJson("http://127.0.0.1:18888/join/google-meet", {
      sessionId: "realtime_webrtc_smoke",
      meetUrl: fixture.url,
      botName: "Realtime WebRTC Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      workerPollUrl: "http://127.0.0.1:18888/worker/poll-realtime",
      workerResultMinCreatedAt,
      installRealtimeBridge: true,
      realtimeBridgeMode: "webrtc-mock",
      autoConnectRealtime: true,
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "realtime webrtc smoke did not join fixture",
      join,
    );

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const status = await (await fetch("http://127.0.0.1:18888/join/status")).json();
    const workerJobs = await (await fetch("http://127.0.0.1:18888/worker/jobs")).json();
    const bridge = status.active?.realtimeBridge;
    const eventTypes = new Set((bridge?.outbound || []).map((entry) => entry.event?.type));
    const sentPayloadTypes = new Set(
      (bridge?.connection?.sentDataChannelMessages || []).map((entry) => {
        try {
          return JSON.parse(entry.payload).type;
        } catch {
          return "";
        }
      }),
    );
    const deliveredJob = workerJobs.jobs.find((job) => job.id === "job_realtime_webrtc_smoke");
    assertSmoke(
      deliveredJob?.deliveredToRealtime === true,
      "worker job was not marked delivered to realtime",
      { workerJobs, workerResultBridge: status.active?.workerResultBridge, realtimeBridge: bridge },
    );
    assertSmoke(
      bridge?.connected === true,
      "browser realtime bridge did not connect in WebRTC mock mode",
      bridge,
    );
    assertSmoke(
      bridge?.connection?.dataChannelOpen === true,
      "browser realtime data channel did not open",
      bridge?.connection,
    );
    assertSmoke(
      eventTypes.has("conversation.item.create"),
      "worker result did not create a realtime conversation item",
      bridge,
    );
    assertSmoke(
      eventTypes.has("response.create"),
      "worker result did not request a realtime response",
      bridge,
    );
    assertSmoke(
      sentPayloadTypes.has("conversation.item.create"),
      "conversation item was not sent over data-channel seam",
      bridge?.connection,
    );
    assertSmoke(
      sentPayloadTypes.has("response.create"),
      "response request was not sent over data-channel seam",
      bridge?.connection,
    );

    console.log(JSON.stringify({ ok: true, reported, join, status, workerJobs }, null, 2));
  } finally {
    await postJson("http://127.0.0.1:18888/join/stop", {
      reason: "realtime_webrtc_smoke_done",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function realtimeAudioRouteSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-realtime-audio-route-"));
  const env = {
    MAB_MEETING_PORT: "18890",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18890",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18890/healthz");
    const join = await postJson("http://127.0.0.1:18890/join/google-meet", {
      sessionId: "realtime_audio_route_smoke",
      meetUrl: fixture.url,
      botName: "Realtime Audio Route Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installWorkerResultBridge: false,
      installRealtimeBridge: true,
      realtimeBridgeMode: "webrtc-mock",
      autoConnectRealtime: true,
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "realtime audio route smoke did not join fixture",
      join,
    );
    assertSmoke(
      join.result?.fixtureState?.media?.audioTracks?.length === 1,
      "fixture did not receive the avatar fake mic track",
      join.result?.fixtureState?.media,
    );

    const status = await waitForJoinStatus(
      "http://127.0.0.1:18890/join/status",
      (body) =>
        body.active?.realtimeBridge?.connection?.mockRemoteAudioInjected === true ||
        (body.active?.realtimeBridge?.errors || []).length > 0,
      8_000,
    );
    const bridge = status.active?.realtimeBridge;
    const avatarAudio = status.active?.avatarAudio;
    assertSmoke(
      bridge?.errors?.length === 0,
      "Realtime audio route bridge reported errors",
      bridge,
    );
    assertSmoke(
      bridge?.connection?.remoteAudioRoutedToAvatarBus === true,
      "Realtime remote audio was not routed to the avatar audio bus",
      bridge?.connection,
    );
    assertSmoke(
      avatarAudio?.injectedTones >= 1 || avatarAudio?.routedStreams >= 1,
      "avatar audio bus did not record a routed remote audio source",
      avatarAudio,
    );

    console.log(JSON.stringify({ ok: true, join, status }, null, 2));
  } finally {
    await postJson("http://127.0.0.1:18890/join/stop", {
      reason: "realtime_audio_route_smoke_done",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function realtimeParticipantAudioSmoke() {
  const dataDir = await mkdtemp(
    pathJoin(tmpdir(), "meeting-avatar-bot-realtime-participant-audio-"),
  );
  const env = {
    MAB_MEETING_PORT: "18891",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18891",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DRY_RUN_AGENT: "1",
    MAB_DATA_DIR: dataDir,
  };
  const fixture = await startLocalMeetFixtureServer();
  const fixtureUrl = `${fixture.url}?participantAudio=1`;
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18891/healthz");
    const join = await postJson("http://127.0.0.1:18891/join/google-meet", {
      sessionId: "realtime_participant_audio_smoke",
      meetUrl: fixtureUrl,
      botName: "Realtime Participant Audio Bot",
      dryRun: false,
      allowNonGoogleMeet: true,
      collectFixtureState: true,
      disableLive2D: true,
      installWorkerResultBridge: false,
      installRealtimeBridge: true,
      realtimeBridgeMode: "webrtc-mock",
      autoConnectRealtime: true,
    });
    assertSmoke(
      join.result?.fixtureState?.joined === true,
      "participant audio smoke did not join fixture",
      join,
    );
    assertSmoke(
      join.result?.fixtureState?.participantAudio?.trackIds?.length === 1,
      "fixture did not create participant audio",
      join.result?.fixtureState,
    );

    const status = await waitForJoinStatus(
      "http://127.0.0.1:18891/join/status",
      (body) =>
        (body.active?.realtimeBridge?.connection?.participantAudioTracksDiscovered >= 1 &&
          body.active?.realtimeBridge?.connection?.dataChannelOpen === true) ||
        (body.active?.realtimeBridge?.errors || []).length > 0,
      8_000,
    );
    const bridge = status.active?.realtimeBridge;
    assertSmoke(bridge?.errors?.length === 0, "participant audio bridge reported errors", bridge);
    assertSmoke(
      bridge?.connection?.participantAudioTracksDiscovered >= 1,
      "Realtime bridge did not discover participant audio tracks",
      bridge?.connection,
    );
    assertSmoke(
      bridge?.connection?.participantAudioSources?.some(
        (source) => source.label === "fixture-participant-audio",
      ),
      "Realtime bridge did not record the fixture participant source",
      bridge?.connection,
    );
    assertSmoke(
      bridge?.connection?.meetAudioTracksForwarded >= 1,
      "Realtime bridge did not forward participant audio into the Realtime input mix",
      bridge?.connection,
    );
    const audioBlockers = new Set(bridge?.feedback?.blockers || []);
    assertSmoke(
      !audioBlockers.has("waiting_for_meet_audio"),
      "Realtime harness did not prove it is using Meet participant audio",
      bridge?.feedback,
    );
    assertSmoke(
      bridge?.timeline?.some((entry) => entry.type === "meet_audio_track_forwarded"),
      "Realtime bridge did not record participant audio forwarding in the timeline",
      bridge?.timeline,
    );
    assertSmoke(
      bridge?.connected === true,
      "Realtime bridge did not connect in participant audio smoke",
      bridge,
    );
    assertSmoke(
      bridge?.connection?.dataChannelOpen === true,
      "Realtime data channel did not open in participant audio smoke",
      bridge,
    );

    console.log(JSON.stringify({ ok: true, join, status }, null, 2));
  } finally {
    await postJson("http://127.0.0.1:18891/join/stop", {
      reason: "realtime_participant_audio_smoke_done",
    }).catch(() => {});
    meeting.child.kill("SIGTERM");
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function realtimeRepeatGuardSmoke() {
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
        botName: "Realtime Repeat Guard Bot",
        disableLive2D: true,
      }),
    });
    await context.addInitScript({
      content: buildRealtimeBrowserInitScript({ mode: "webrtc-mock", autoConnect: true }),
    });
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.waitForFunction(
      () => {
        const ready = window.MAB_AVATAR_READY as { ok?: boolean } | null | undefined;
        const bridge = window.MAB_REALTIME_BRIDGE as
          | { connection?: { dataChannelOpen?: boolean } }
          | null
          | undefined;
        return ready?.ok === true && bridge?.connection?.dataChannelOpen === true;
      },
      null,
      { timeout: 10_000 },
    );

    type RepeatGuardResult = {
      firstDelivery?: unknown;
      duplicateDelivery?: { duplicate?: boolean };
      bridge?: RealtimeBridgeSnapshot;
    };
    const result = (await page.evaluate(() => {
      const job = {
        id: "job_repeat_guard_smoke",
        status: "completed",
        task: "verify duplicate worker guard",
        result: "Only one spoken report should be requested.",
      };
      const client = window.MAB_REALTIME_CLIENT as
        | { injectWorkerResult?: (job: unknown) => unknown }
        | null
        | undefined;
      const firstDelivery = client?.injectWorkerResult?.(job);
      const duplicateDelivery = client?.injectWorkerResult?.(job);
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "response.created",
            response: { id: "resp_repeat_guard_smoke" },
          },
        }),
      );
      window.dispatchEvent(new CustomEvent("meeting-avatar-user-speech-started"));
      return {
        firstDelivery,
        duplicateDelivery,
        bridge: window.MAB_REALTIME_BRIDGE,
      };
    })) as RepeatGuardResult;
    const eventTypes = (result.bridge?.outbound || []).map((entry) => entry.event?.type);
    const sentPayloadTypes = (result.bridge?.connection?.sentDataChannelMessages || []).map(
      (entry) => {
        try {
          return JSON.parse(String(entry.payload || "")).type as string | undefined;
        } catch {
          return "";
        }
      },
    );
    assertSmoke(
      result.duplicateDelivery?.duplicate === true,
      "duplicate worker result was not skipped",
      result,
    );
    assertSmoke(
      result.bridge?.protection?.duplicateWorkerResultsSkipped === 1,
      "duplicate worker skip counter did not increment",
      result.bridge?.protection,
    );
    assertSmoke(
      eventTypes.filter((type) => type === "response.create").length === 1,
      "repeat guard requested more than one response for a duplicate worker result",
      result.bridge?.outbound,
    );
    assertSmoke(
      eventTypes.includes("response.cancel"),
      "user speech did not cancel active response",
      result.bridge?.outbound,
    );
    assertSmoke(
      sentPayloadTypes.includes("response.cancel"),
      "response.cancel was not sent over data channel",
      result.bridge?.connection,
    );
    assertSmoke(
      result.bridge?.protection?.userSpeechCancels === 1,
      "user speech cancel counter did not increment",
      result.bridge?.protection,
    );

    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await browser.close();
  }
}

