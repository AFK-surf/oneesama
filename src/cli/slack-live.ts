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

export async function slackLiveApi(token, method, payload = {}) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return {
    ok: response.ok && body.ok === true,
    status: response.status,
    method,
    body,
  };
}

export async function slackLiveCapabilitySmoke() {
  const runLive = shouldRunOptionalSmoke(
    "MAB_RUN_SLACK_LIVE_CAPABILITY_SMOKE",
    "MAB_REQUIRE_SLACK_LIVE_CAPABILITY",
  );
  const envFile =
    process.env.MAB_SLACK_LIVE_ENV_FILE || process.env.MAB_SLACK_SHADOW_ENV_FILE || "";
  const envFileValues = parseEnvFile(envFile);
  const botToken = envValue(envFileValues, "SLACK_BOT_TOKEN");
  const appToken = envValue(envFileValues, "SLACK_APP_TOKEN");
  const signingSecret = envValue(envFileValues, "SLACK_SIGNING_SECRET");
  const testChannel =
    process.env.MAB_SLACK_LIVE_TEST_CHANNEL ||
    envFileValues.MAB_SLACK_LIVE_TEST_CHANNEL ||
    envFileValues.MAB_CANVAS_SLACK_CHANNEL ||
    "";

  if (!runLive) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          skipped: true,
          reason:
            "set MAB_RUN_SLACK_LIVE_CAPABILITY_SMOKE=1 or MAB_REQUIRE_SLACK_LIVE_CAPABILITY=1 to validate a real Slack bot key",
          envFile: envFile ? { path: envFile, exists: existsSync(envFile) } : null,
          configured: {
            botToken: Boolean(botToken),
            appToken: Boolean(appToken),
            signingSecret: Boolean(signingSecret),
            testChannel: Boolean(testChannel),
          },
          sideEffects: "none",
        },
        null,
        2,
      ),
    );
    return;
  }

  assertSmoke(Boolean(botToken), "SLACK_BOT_TOKEN is required for Slack live capability smoke", {
    envFile: envFile ? { path: envFile, exists: existsSync(envFile) } : null,
  });

  const botAuth = await slackLiveApi(botToken, "auth.test");
  assertSmoke(botAuth.ok, "Slack bot token auth.test failed", {
    status: botAuth.status,
    error: botAuth.body?.error,
  });

  let appConnection: {
    skipped: boolean;
    reason?: string;
    ok?: boolean;
    teamId?: string;
    urlIssued?: boolean;
    note?: string;
  } = {
    skipped: true,
    reason: "SLACK_APP_TOKEN missing; Socket Mode capability not checked",
  };
  if (appToken) {
    const opened = await slackLiveApi(appToken, "apps.connections.open");
    assertSmoke(
      opened.ok && Boolean(opened.body?.url),
      "Slack app token apps.connections.open failed",
      {
        status: opened.status,
        error: opened.body?.error,
      },
    );
    appConnection = {
      skipped: false,
      ok: true,
      teamId: opened.body?.team_id || "",
      urlIssued: Boolean(opened.body?.url),
      note: "Only requested a Socket Mode URL; this smoke does not open the WebSocket or ack real events.",
    };
  }

  let postMessage: {
    skipped: boolean;
    reason?: string;
    ok?: boolean;
    channel?: string;
    ts?: string;
  } = {
    skipped: true,
    reason: "set MAB_SLACK_LIVE_POST_TEST=1 and MAB_SLACK_LIVE_TEST_CHANNEL to post a test message",
  };
  if (process.env.MAB_SLACK_LIVE_POST_TEST === "1") {
    assertSmoke(
      Boolean(testChannel),
      "MAB_SLACK_LIVE_TEST_CHANNEL is required when MAB_SLACK_LIVE_POST_TEST=1",
    );
    const post = await slackLiveApi(botToken, "chat.postMessage", {
      channel: testChannel,
      text: "meeting-avatar-bot shadow validation smoke: Slack bot key can post here.",
      unfurl_links: false,
      unfurl_media: false,
    });
    assertSmoke(post.ok, "Slack live postMessage test failed", {
      status: post.status,
      error: post.body?.error,
      channel: testChannel,
    });
    postMessage = {
      skipped: false,
      ok: true,
      channel: post.body?.channel || testChannel,
      ts: post.body?.ts || "",
    };
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "shadow_live_capability",
        envFile: envFile ? { path: envFile, exists: existsSync(envFile) } : null,
        tokens: {
          botToken: botToken ? redactSecret(botToken) : "",
          appToken: appToken ? redactSecret(appToken) : "",
          signingSecret: Boolean(signingSecret),
        },
        botAuth: {
          ok: true,
          team: botAuth.body?.team || "",
          teamId: botAuth.body?.team_id || "",
          user: botAuth.body?.user || "",
          userId: botAuth.body?.user_id || "",
          botId: botAuth.body?.bot_id || "",
        },
        appConnection,
        postMessage,
        sideEffects: postMessage.skipped
          ? "no Slack messages posted; old Slack Agent D / Meet D untouched"
          : "posted one configured test message; old Slack Agent D / Meet D untouched",
      },
      null,
      2,
    ),
  );
}

export async function slackLiveSocketSmoke() {
  const runLive = shouldRunOptionalSmoke(
    "MAB_RUN_SLACK_LIVE_SOCKET_SMOKE",
    "MAB_REQUIRE_SLACK_LIVE_SOCKET",
  );
  const envFile =
    process.env.MAB_SLACK_LIVE_ENV_FILE || process.env.MAB_SLACK_SHADOW_ENV_FILE || "";
  const envFileValues = parseEnvFile(envFile);
  const botToken = envValue(envFileValues, "SLACK_BOT_TOKEN");
  const appToken = envValue(envFileValues, "SLACK_APP_TOKEN");
  const testChannel =
    process.env.MAB_SLACK_LIVE_TEST_CHANNEL ||
    envFileValues.MAB_SLACK_LIVE_TEST_CHANNEL ||
    envFileValues.MAB_CANVAS_SLACK_CHANNEL ||
    "";

  if (!runLive) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          skipped: true,
          reason:
            "set MAB_RUN_SLACK_LIVE_SOCKET_SMOKE=1 or MAB_REQUIRE_SLACK_LIVE_SOCKET=1 to run a real Socket Mode loop smoke",
          envFile: envFile ? { path: envFile, exists: existsSync(envFile) } : null,
          configured: {
            botToken: Boolean(botToken),
            appToken: Boolean(appToken),
            testChannel: Boolean(testChannel),
          },
          sideEffects: "none",
        },
        null,
        2,
      ),
    );
    return;
  }

  assertSmoke(Boolean(botToken), "SLACK_BOT_TOKEN is required for Slack live socket smoke", {
    envFile: envFile ? { path: envFile, exists: existsSync(envFile) } : null,
  });
  assertSmoke(Boolean(appToken), "SLACK_APP_TOKEN is required for Slack live socket smoke", {
    envFile: envFile ? { path: envFile, exists: existsSync(envFile) } : null,
  });
  assertSmoke(
    Boolean(testChannel),
    "MAB_SLACK_LIVE_TEST_CHANNEL is required for Slack live socket smoke",
  );

  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-live-socket-"));
  const port = Number.parseInt(process.env.MAB_SLACK_LIVE_SOCKET_PORT || "18931", 10);
  const slack = startService("apps/slack-agent/src/index.js", {
    MAB_SLACK_PORT: String(port),
    MAB_DATA_DIR: dataDir,
    MAB_SLACK_SOCKET_MODE: "1",
    MAB_SLACK_EVENT_BUFFER: "1",
    MAB_SLACK_EVENT_DEBOUNCE_MS: "750",
    MAB_SLACK_EVENT_MAX_BATCH: "1",
    MAB_SLACK_EVENT_ALLOW_BOT_MESSAGES: "1",
    MAB_AGENT_RUNNER: "dry-run",
    MAB_DRY_RUN_AGENT: "1",
    MAB_SLACK_POSTER_MOCK: "1",
    SLACK_BOT_TOKEN: botToken,
    SLACK_APP_TOKEN: appToken,
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const initialHealth = await waitForServiceHealth(slack, `${baseUrl}/healthz`, 10_000);
    let initialStatus = await (await fetch(`${baseUrl}/slack/inbound/status`)).json();
    const connectDeadline = Date.now() + 15_000;
    while (!initialStatus.inbound?.socketMode?.connected && Date.now() < connectDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      initialStatus = await (await fetch(`${baseUrl}/slack/inbound/status`)).json();
    }
    assertSmoke(
      initialStatus.inbound?.socketMode?.connected === true,
      "Slack live socket did not connect",
      {
        status: initialStatus,
        logs: slack.logs(),
      },
    );

    const marker = `meeting-avatar-bot live socket smoke ${Date.now()}`;
    const post = await slackLiveApi(botToken, "chat.postMessage", {
      channel: testChannel,
      text: marker,
      unfurl_links: false,
      unfurl_media: false,
    });
    assertSmoke(post.ok, "Slack live socket smoke could not post trigger message", {
      status: post.status,
      error: post.body?.error,
      channel: testChannel,
    });

    let finalStatus = initialStatus;
    const initialFlushes = Number(initialStatus.inbound?.eventBuffer?.flushes || 0);
    const eventDeadline = Date.now() + 20_000;
    while (Date.now() < eventDeadline) {
      finalStatus = await (await fetch(`${baseUrl}/slack/inbound/status`)).json();
      const buffer = finalStatus.inbound?.eventBuffer || {};
      const channelStats = buffer.channels?.[testChannel] || null;
      const sawChannel = Boolean(channelStats);
      const flushed =
        buffer.lastFlushChannel === testChannel && Number(buffer.flushes || 0) > initialFlushes;
      if (sawChannel || flushed) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const buffer = finalStatus.inbound?.eventBuffer || {};
    const channelStats = buffer.channels?.[testChannel] || null;
    const sawEvent =
      Boolean(channelStats) ||
      (buffer.lastFlushChannel === testChannel && Number(buffer.flushes || 0) > initialFlushes);
    assertSmoke(sawEvent, "Slack live socket did not observe the test channel event", {
      initialStatus,
      finalStatus,
      post: { ok: post.ok, channel: post.body?.channel || testChannel, ts: post.body?.ts || "" },
      logs: slack.logs(),
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "shadow_live_socket",
          envFile: envFile ? { path: envFile, exists: existsSync(envFile) } : null,
          service: {
            port,
            health: {
              ok: initialHealth.ok,
              service: initialHealth.service,
              socketMode: initialHealth.state?.slackInbound?.socketMode,
            },
          },
          triggerPost: {
            ok: true,
            channel: post.body?.channel || testChannel,
            ts: post.body?.ts || "",
          },
          socketMode: finalStatus.inbound?.socketMode,
          eventBuffer: {
            bufferedMessages: buffer.bufferedMessages,
            flushes: buffer.flushes,
            lastBufferedAt: buffer.lastBufferedAt,
            lastFlushAt: buffer.lastFlushAt,
            lastFlushChannel: buffer.lastFlushChannel,
            channel: channelStats,
          },
          note: "Self-triggered with bot messages allowed only for this smoke; production default still ignores bot messages to avoid loops.",
          sideEffects:
            "posted one configured test message; connected an isolated Slack Agent Socket Mode loop; old Slack Agent D / Meet D untouched",
        },
        null,
        2,
      ),
    );
  } finally {
    slack.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function slackMemorySeed() {
  const config = getRuntimeConfig();
  const manifest = seedLegacySlackMemory({
    targetDir: config.slackMemoryDir,
    sourceWorkspaceDir: config.legacySlackWorkspaceDir,
    sourceDbPath: config.legacySlackAgentDb,
  });
  console.log(JSON.stringify({ ok: true, manifest }, null, 2));
}

export async function slackMemorySmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-memory-"));
  const memoryDir = pathJoin(dataDir, "slack-memory");
  const sourceWorkspaceDir = pathJoin(dataDir, "old-workspace");
  const sourceDbPath = pathJoin(dataDir, "old-slack-agent.db");
  await mkdir(pathJoin(sourceWorkspaceDir, "memory", "team", "meetings"), { recursive: true });
  await writeFile(
    pathJoin(sourceWorkspaceDir, "MEMORY.md"),
    [
      "# Workspace Memory",
      "",
      "- Operator prefers Slack-first meeting control with persistent workspace context.",
      "- Use legacy workspace practice as a read-only reference.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    pathJoin(sourceWorkspaceDir, "memory", "team", "meetings", "meeting-42.md"),
    [
      "# Team Memory: Meeting Avatar",
      "",
      "## Decisions",
      "- Meeting avatar must publish transcript and summary to Slack Canvas.",
      "",
    ].join("\n"),
    "utf8",
  );
  const db = new Database(sourceDbPath);
  db.exec(`
    CREATE TABLE channel_brain (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      summary_version INTEGER NOT NULL DEFAULT 0,
      last_session_id TEXT NOT NULL DEFAULT '',
      last_thread_ts TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE thread_ledger (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      owner_user_id TEXT NOT NULL DEFAULT '',
      last_user_id TEXT NOT NULL DEFAULT '',
      last_action_type TEXT NOT NULL DEFAULT '',
      last_action_status TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  db.prepare("INSERT INTO channel_brain VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "T_SMOKE",
    "C_SMOKE",
    "Shared facts and conventions:\n- Meeting bot should remember Slack channel context before delegating work.",
    1,
    "meet_42",
    "1715155200.000000",
    "2026-05-08T07:30:00.000Z",
  );
  db.prepare("INSERT INTO thread_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "T_SMOKE",
    "C_SMOKE",
    "1715155200.000000",
    "active",
    "U_PENG",
    "U_PENG",
    "delegate",
    "completed",
    "Decision: publish meeting summary to Slack Canvas after ASR.",
    "2026-05-08T07:31:00.000Z",
  );
  db.close();

  const env = {
    MAB_SLACK_PORT: "18923",
    MAB_MEETING_PORT: "18924",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18924",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    MAB_SLACK_MEMORY_ENABLED: "1",
    MAB_SLACK_MEMORY_DIR: memoryDir,
    SLACK_SIGNING_SECRET: "slack-memory-signing-secret",
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const slack = startService("apps/slack-agent/src/index.js", env);

  try {
    const manifest = seedLegacySlackMemory({
      targetDir: memoryDir,
      sourceWorkspaceDir,
      sourceDbPath,
    });
    const privateFilePath = pathJoin(memoryDir, "workspace", "MEMORY.md");
    assertSmoke(
      existsSync(privateFilePath),
      "Slack memory seed did not copy private MEMORY.md",
      manifest,
    );
    assertSmoke(
      readFileSync(".gitignore", "utf8").includes("/local-data/") &&
        readFileSync(".gitignore", "utf8").includes("slack-memory/"),
      "gitignore does not protect local Slack memory directories",
    );
    const provider = createLocalSlackMemoryProvider({ enabled: true, rootDir: memoryDir });
    const search = provider.search("Slack Canvas meeting context", 6);
    assertSmoke(
      search.length >= 2,
      "local Slack memory provider did not find seeded file/db context",
      { search, manifest },
    );
    await waitForHealth("http://127.0.0.1:18924/healthz");
    await waitForHealth("http://127.0.0.1:18923/healthz");

    const memoryRoute = await (
      await fetch("http://127.0.0.1:18923/memory?q=Canvas&limit=5")
    ).json();
    assertSmoke(
      memoryRoute.summary?.seed?.channelBrain === 1,
      "Slack memory route did not expose private seed summary",
      memoryRoute,
    );
    assertSmoke(
      memoryRoute.results?.length >= 1,
      "Slack memory route did not search private seed",
      memoryRoute,
    );

    const join = await postSignedSlackCommand(
      "http://127.0.0.1:18923/slack/commands/avatar",
      "join https://meet.google.com/abc-defg-hij --start-joiner false",
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    const delegate = await postSignedSlackCommand(
      "http://127.0.0.1:18923/slack/commands/avatar",
      `delegate --session ${join.session?.id} "Use Slack Canvas context to summarize the meeting artifact pipeline"`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      delegate.job?.context?.localSlackMemory?.enabled === true,
      "delegate did not attach local Slack memory context",
      delegate.job?.context,
    );
    assertSmoke(
      delegate.job?.context?.localSlackMemory?.resultCount >= 1,
      "delegate local Slack memory context was empty",
      delegate.job?.context,
    );
    assertSmoke(
      !JSON.stringify(delegate.job?.context || {}).includes("response_url"),
      "delegate leaked private Slack response_url into agent context",
      delegate.job?.context,
    );

    console.log(
      JSON.stringify({ ok: true, manifest, search, memoryRoute, join, delegate }, null, 2),
    );
  } finally {
    for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}
