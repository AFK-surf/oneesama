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

export async function codexAppServerProviderSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-codex-app-server-"));
  const env = {
    ...process.env,
    MAB_AGENT_RUNNER: "codex-app-server",
    MAB_DRY_RUN_CODEX: "1",
    MAB_DATA_DIR: dataDir,
    MAB_CODEX_APP_SERVER_SESSIONS_PATH: pathJoin(dataDir, "codex-app-server-sessions.json"),
    MAB_CODEX_APP_SERVER_WORKSPACE_ROOT: pathJoin(dataDir, "codex-workspaces"),
  };
  const context = {
    sessionId: "meet_app_server_smoke",
    slack: {
      workspaceId: "T_APP",
      channelId: "C_APP",
      threadTs: "1778517300.000100",
      userId: "U_PENG",
    },
  };
  const firstRunner = createAgentRunner({ provider: "codex-app-server", env });
  const first = await firstRunner.startTask({
    task: "Check Codex App Server runner session mapping.",
    mode: "smoke",
    allowCodeChanges: false,
    context,
  });
  const second = await firstRunner.startTask({
    task: "Reuse the same Slack thread session.",
    mode: "smoke",
    allowCodeChanges: false,
    context,
  });
  const other = await firstRunner.startTask({
    task: "Create a separate Slack thread session.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      ...context,
      slack: { ...context.slack, threadTs: "1778517301.000200" },
    },
  });
  const teammate = await firstRunner.startTask({
    task: "Reuse the same Slack thread when a different participant replies.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      ...context,
      requestedBy: "U_TEAMMATE",
      slack: { ...context.slack, userId: "U_TEAMMATE" },
    },
  });
  const rootUserA = await firstRunner.startTask({
    task: "Create a channel-root Slack session for one user.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      source: "slack-agent",
      requestedBy: "U_PENG",
      slack: {
        workspaceId: "T_APP",
        channelId: "C_APP",
        userId: "U_PENG",
      },
    },
  });
  const rootUserB = await firstRunner.startTask({
    task: "Create a separate channel-root Slack session for another user.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      source: "slack-agent",
      requestedBy: "U_TEAMMATE",
      slack: {
        workspaceId: "T_APP",
        channelId: "C_APP",
        userId: "U_TEAMMATE",
      },
    },
  });
  const rootSession = await firstRunner.startTask({
    task: "Create a channel-root Slack session scoped to an explicit meeting session.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      source: "slack-agent",
      sessionId: "meet_bound_delegate",
      slack: {
        workspaceId: "T_APP",
        channelId: "C_APP",
        userId: "U_PENG",
      },
    },
  });
  const rootSentinel = await firstRunner.startTask({
    task: "Treat channel-root sentinel as no Slack thread.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      source: "slack-agent",
      requestedBy: "U_PENG",
      slack: {
        workspaceId: "T_APP",
        channelId: "C_APP",
        threadTs: "channel-root",
        userId: "U_PENG",
      },
    },
  });
  const topLevelTriage = await firstRunner.startTask({
    task: "Scope top-level Slack triage context to its explicit triage session.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      source: "slack-triage",
      sessionId: "triage:C_APP:smoke",
      workspaceId: "T_APP",
      channelId: "C_APP",
      threadTs: "channel-root",
      messageCount: 1,
    },
  });
  const explicit = await firstRunner.startTask({
    task: "Honor an explicit App Server business session key.",
    mode: "smoke",
    allowCodeChanges: false,
    context: {
      codexAppServerSessionKey: "manual:acceptance:session",
      slack: {
        workspaceId: "T_APP",
        channelId: "C_APP",
        threadTs: "1778517302.000300",
        userId: "U_PENG",
      },
    },
  });
  const secondRunner = createAgentRunner({ provider: "codex-app-server", env });
  const resumed = await secondRunner.startTask({
    task: "Resume the persisted Slack thread session after runner restart.",
    mode: "smoke",
    allowCodeChanges: false,
    context,
  });
  const meeting = await secondRunner.startTask({
    task: "Create a separate Meet session mapping.",
    mode: "smoke",
    allowCodeChanges: false,
    context: { sessionId: "meet_app_server_smoke" },
  });
  const codexModeRunner = createAgentRunner({
    provider: "codex",
    env: { ...env, MAB_AGENT_RUNNER: "codex", MAB_CODEX_RUNNER_MODE: "app-server" },
  });
  const codexMode = await codexModeRunner.startTask({
    task: "Select App Server through MAB_CODEX_RUNNER_MODE.",
    mode: "smoke",
    allowCodeChanges: false,
    context,
  });

  const firstSession = ((first.context as { codexAppServer?: Record<string, unknown> } | undefined)
    ?.codexAppServer || {}) as Record<string, unknown>;
  const secondSession = ((
    second.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const otherSession = ((other.context as { codexAppServer?: Record<string, unknown> } | undefined)
    ?.codexAppServer || {}) as Record<string, unknown>;
  const teammateSession = ((
    teammate.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const rootUserASession = ((
    rootUserA.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const rootUserBSession = ((
    rootUserB.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const rootExplicitSession = ((
    rootSession.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const rootSentinelSession = ((
    rootSentinel.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const topLevelTriageSession = ((
    topLevelTriage.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const explicitSession = ((
    explicit.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const resumedSession = ((
    resumed.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const meetingSession = ((
    meeting.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  const codexModeSession = ((
    codexMode.context as { codexAppServer?: Record<string, unknown> } | undefined
  )?.codexAppServer || {}) as Record<string, unknown>;
  assertSmoke(
    first.provider === "codex-app-server",
    "Codex App Server provider returned the wrong provider",
    first,
  );
  assertSmoke(first.status === "completed", "Codex App Server dry-run job did not complete", first);
  assertSmoke(
    Boolean(firstSession.sessionKey),
    "Codex App Server job did not expose session key",
    first,
  );
  assertSmoke(
    firstSession.sessionKey === "slack:T_APP:C_APP:1778517300.000100",
    "Slack thread key should be thread-scoped and not user-scoped",
    firstSession,
  );
  assertSmoke(
    firstSession.sessionKey === secondSession.sessionKey,
    "Same Slack thread did not reuse business session key",
    { first, second },
  );
  assertSmoke(
    firstSession.codexThreadId === secondSession.codexThreadId,
    "Same runner did not reuse Codex thread id",
    { first, second },
  );
  assertSmoke(
    firstSession.codexThreadId === teammateSession.codexThreadId,
    "Same Slack thread with a different user should reuse Codex thread id",
    { first, teammate },
  );
  assertSmoke(
    firstSession.codexThreadId === resumedSession.codexThreadId,
    "Persisted runner did not resume Codex thread id",
    { first, resumed },
  );
  assertSmoke(
    firstSession.codexThreadId !== otherSession.codexThreadId,
    "Different Slack thread reused the same Codex thread id",
    { first, other },
  );
  assertSmoke(
    rootUserASession.sessionKey === "slack:T_APP:C_APP:channel-root:U_PENG",
    "Slack channel-root session should stay user-scoped without an explicit thread/session",
    rootUserA,
  );
  assertSmoke(
    rootUserBSession.sessionKey === "slack:T_APP:C_APP:channel-root:U_TEAMMATE",
    "Slack channel-root session should preserve user isolation",
    rootUserB,
  );
  assertSmoke(
    rootUserASession.codexThreadId !== rootUserBSession.codexThreadId,
    "Different channel-root users reused the same Codex thread id",
    { rootUserA, rootUserB },
  );
  assertSmoke(
    rootExplicitSession.sessionKey === "slack:T_APP:C_APP:session:meet_bound_delegate",
    "Slack channel-root delegate with an explicit session should be session-scoped",
    rootSession,
  );
  assertSmoke(
    rootSentinelSession.sessionKey === rootUserASession.sessionKey,
    "Slack channel-root sentinel should not become a real thread session",
    { rootUserA, rootSentinel },
  );
  assertSmoke(
    rootSentinelSession.codexThreadId === rootUserASession.codexThreadId,
    "Slack channel-root sentinel should reuse the user-scoped channel-root session",
    { rootUserA, rootSentinel },
  );
  assertSmoke(
    topLevelTriageSession.sessionKey === "slack:T_APP:C_APP:session:triage:C_APP:smoke",
    "Top-level Slack triage context should use a Slack session key, not adhoc",
    topLevelTriage,
  );
  assertSmoke(
    explicitSession.sessionKey === "manual:acceptance:session",
    "Explicit App Server session key was not honored",
    explicit,
  );
  assertSmoke(
    meetingSession.sessionKey === "meeting:meet_app_server_smoke",
    "Meet session did not use the meeting business key",
    meeting,
  );
  assertSmoke(
    firstSession.sessionKey !== meetingSession.sessionKey,
    "Slack and Meet sessions should stay isolated",
    { first, meeting },
  );
  assertSmoke(
    codexMode.provider === "codex-app-server",
    "MAB_CODEX_RUNNER_MODE=app-server did not select App Server runner",
    codexMode,
  );
  assertSmoke(
    codexModeSession.codexThreadId === firstSession.codexThreadId,
    "Codex provider app-server mode did not reuse persisted Slack thread",
    { first, codexMode },
  );
  assertSmoke(
    firstSession.workspacePath === resumedSession.workspacePath,
    "Persisted runner did not reuse workspace path",
    { first, resumed },
  );
  const commandProgress = codexAppServerRunnerInternals.codexProgressFromEvent({
    method: "item/started",
    params: {
      item: {
        type: "commandExecution",
        command: "/bin/zsh -lc pwd",
      },
    },
  });
  assertSmoke(
    commandProgress?.status === "Running command: /bin/zsh -lc pwd" &&
      commandProgress?.toolName === "exec_command",
    "Codex App Server progress mapper did not label command execution events",
    commandProgress,
  );
  const toolProgress = codexAppServerRunnerInternals.codexProgressFromEvent({
    method: "item/mcpToolCall/progress",
    params: {
      toolName: "spawn_agent",
    },
  });
  assertSmoke(
    toolProgress?.status === "Delegating to worker..." && toolProgress?.toolName === "spawn_agent",
    "Codex App Server progress mapper did not label MCP tool events",
    toolProgress,
  );
  const replyProgress = codexAppServerRunnerInternals.codexProgressFromEvent({
    method: "item/agentMessage/delta",
    params: { delta: "tool-ok" },
  });
  assertSmoke(
    replyProgress?.status === "Composing reply..." && replyProgress?.toolName === "agent_message",
    "Codex App Server progress mapper did not label agent message deltas",
    replyProgress,
  );
  const completedCommandProgress = codexAppServerRunnerInternals.codexProgressFromEvent({
    method: "item/completed",
    params: {
      item: {
        type: "commandExecution",
        command: "/bin/zsh -lc pwd",
      },
    },
  });
  assertSmoke(
    completedCommandProgress === null,
    "Codex App Server progress mapper should not downgrade completed commands back to generic thinking",
    completedCommandProgress,
  );
  await (codexModeRunner as { close?: () => unknown | Promise<unknown> }).close?.();
  await (firstRunner as { close?: () => unknown | Promise<unknown> }).close?.();
  await (secondRunner as { close?: () => unknown | Promise<unknown> }).close?.();
  let live: { skipped: boolean; reason?: string; job?: unknown; toolJob?: unknown } = {
    skipped: true,
  };
  if (process.env.MAB_RUN_CODEX_APP_SERVER_LIVE_SMOKE === "1") {
    const liveDataDir = await mkdtemp(
      pathJoin(tmpdir(), "meeting-avatar-bot-codex-app-server-live-"),
    );
    const liveRunner = createAgentRunner({
      provider: "codex-app-server",
      env: {
        ...process.env,
        MAB_AGENT_RUNNER: "codex-app-server",
        MAB_DRY_RUN_CODEX: "0",
        MAB_CODEX_APP_SERVER_PORT: process.env.MAB_CODEX_APP_SERVER_PORT || "18768",
        MAB_DATA_DIR: liveDataDir,
        MAB_CODEX_APP_SERVER_SESSIONS_PATH: pathJoin(liveDataDir, "codex-app-server-sessions.json"),
        MAB_CODEX_APP_SERVER_WORKSPACE_ROOT: pathJoin(liveDataDir, "codex-workspaces"),
      },
    });
    try {
      const liveJob = await liveRunner.startTask({
        task: "Reply with exactly: app-server-ok",
        mode: "smoke",
        allowCodeChanges: false,
        context: {
          slack: {
            workspaceId: "T_APP_LIVE",
            channelId: "C_APP_LIVE",
            threadTs: "1778517302.000300",
            userId: "U_PENG",
          },
        },
      });
      const completed = await waitForRunnerJob(liveRunner, liveJob.id, 120_000);
      assertSmoke(
        completed.provider === "codex-app-server",
        "Live Codex App Server job returned wrong provider",
        completed,
      );
      assertSmoke(
        completed.status === "completed",
        "Live Codex App Server job did not complete",
        completed,
      );
      assertSmoke(
        String(completed.result || "")
          .toLowerCase()
          .includes("app-server-ok"),
        "Live Codex App Server job did not return the expected marker",
        completed,
      );
      assertSmoke(
        Boolean(completed.context?.codexAppServer?.codexThreadId),
        "Live Codex App Server job did not record a thread id",
        completed,
      );
      const toolJob = await liveRunner.startTask({
        task: "Run the shell command `pwd` once, then reply with exactly: tool-ok",
        mode: "smoke",
        allowCodeChanges: false,
        context: {
          slack: {
            workspaceId: "T_APP_LIVE",
            channelId: "C_APP_LIVE",
            threadTs: "1778517303.000400",
            userId: "U_PENG",
          },
        },
      });
      const toolCompleted = await waitForRunnerJob(liveRunner, toolJob.id, 120_000);
      assertSmoke(
        toolCompleted.status === "completed",
        "Live Codex App Server tool-progress job did not complete",
        toolCompleted,
      );
      assertSmoke(
        String(toolCompleted.result || "")
          .toLowerCase()
          .includes("tool-ok"),
        "Live Codex App Server tool-progress job did not return the expected marker",
        toolCompleted,
      );
      assertSmoke(
        toolCompleted.progressEvents?.some((event) => event.status?.startsWith("Running command:")),
        "Live Codex App Server tool-progress job did not record command execution progress",
        toolCompleted,
      );
      assertSmoke(
        toolCompleted.progressEvents?.some((event) => event.status === "Composing reply..."),
        "Live Codex App Server tool-progress job did not record reply composition progress",
        toolCompleted,
      );
      live = { skipped: false, job: completed, toolJob: toolCompleted };
    } finally {
      await (liveRunner as { close?: () => unknown | Promise<unknown> }).close?.();
      await rm(liveDataDir, { recursive: true, force: true });
    }
  }
  await rm(dataDir, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        ok: true,
        sessionCases: {
          sameSlackThread: firstSession.sessionKey,
          sameSlackThreadOtherUser: teammateSession.sessionKey,
          otherSlackThread: otherSession.sessionKey,
          channelRootUserA: rootUserASession.sessionKey,
          channelRootUserB: rootUserBSession.sessionKey,
          channelRootExplicitSession: rootExplicitSession.sessionKey,
          channelRootSentinel: rootSentinelSession.sessionKey,
          topLevelTriage: topLevelTriageSession.sessionKey,
          explicit: explicitSession.sessionKey,
          meeting: meetingSession.sessionKey,
        },
        first,
        second,
        other,
        resumed,
        meeting,
        codexMode,
        live,
      },
      null,
      2,
    ),
  );
}

export async function ollamaProviderSmoke() {
  const dryRunRunner = createAgentRunner({
    provider: "ollama",
    dryRun: true,
    env: { ...process.env, MAB_AGENT_RUNNER: "ollama", MAB_DRY_RUN_AGENT: "1" },
  });
  const dryRunJob = await dryRunRunner.startTask({
    task: "Check Ollama provider dry-run contract.",
    mode: "smoke",
    context: { provider: "ollama", runner: "ollama" },
  });
  assertSmoke(
    dryRunJob.provider === "ollama",
    "Ollama provider returned the wrong provider",
    dryRunJob,
  );
  assertSmoke(
    dryRunJob.status === "completed",
    "Ollama provider dry-run did not complete",
    dryRunJob,
  );

  const requireLive = (process.env.MAB_REQUIRE_OLLAMA_PROVIDER || "") === "1";
  const runLive = requireLive || (process.env.MAB_RUN_OLLAMA_PROVIDER_SMOKE || "") === "1";
  let live: { skipped: boolean; reason?: string; job?: unknown } = {
    skipped: true,
    reason:
      "set MAB_RUN_OLLAMA_PROVIDER_SMOKE=1 or MAB_REQUIRE_OLLAMA_PROVIDER=1 to run Ollama live",
  };
  if (runLive) {
    const runner = createAgentRunner({
      provider: "ollama",
      env: { ...process.env, MAB_AGENT_RUNNER: "ollama" },
    });
    const job = await runner.startTask({
      task: "用一句中文说明 Ollama provider 已接入 meeting-avatar-bot。",
      mode: "smoke",
      context: { provider: "ollama", live: true },
    });
    const completed = await waitForRunnerJob(runner, job.id, 120_000);
    assertSmoke(
      completed.provider === "ollama",
      "Ollama provider live job returned wrong provider",
      completed,
    );
    assertSmoke(
      completed.status === "completed",
      "Ollama provider live job did not complete",
      completed,
    );
    assertSmoke(
      Boolean(completed.result?.trim()),
      "Ollama provider live job returned an empty result",
      completed,
    );
    live = { skipped: false, job: completed };
  }

  console.log(JSON.stringify({ ok: true, dryRunJob, live }, null, 2));
}

export async function slackAgentDProviderSmoke() {
  const dryRunRunner = createAgentRunner({
    provider: "slack-agent-d",
    dryRun: true,
    env: { ...process.env, MAB_AGENT_RUNNER: "slack-agent-d", MAB_DRY_RUN_AGENT: "1" },
  });
  const dryRunJob = await dryRunRunner.startTask({
    task: "Check Slack Agent D adapter dry-run contract.",
    mode: "smoke",
    context: { provider: "slack-agent-d", runner: "legacy" },
  });
  assertSmoke(
    dryRunJob.provider === "slack-agent-d",
    "Slack Agent D adapter returned the wrong provider",
    dryRunJob,
  );
  assertSmoke(
    dryRunJob.status === "completed",
    "Slack Agent D adapter dry-run did not complete",
    dryRunJob,
  );

  let captured = null;
  const server = createJsonServer({
    name: "slack-agent-d-provider-smoke",
    port: 18914,
    routes: {
      "GET /healthz": () => ({ ok: true }),
      "POST /agent/run": async ({ req, body }) => {
        captured = {
          body,
          authorization: req.headers.authorization || "",
          bridgeToken: req.headers["x-meeting-avatar-bot-token"] || "",
        };
        return {
          body: {
            ok: true,
            status: "completed",
            jobId: "legacy_job_smoke",
            result: `Slack Agent D adapter received: ${body.task}`,
          },
        };
      },
    },
  });

  try {
    await server.listen();
    const runner = createAgentRunner({
      provider: "slack-agent-d",
      env: {
        ...process.env,
        MAB_AGENT_RUNNER: "slack-agent-d",
        MAB_SLACK_AGENT_D_URL: "http://127.0.0.1:18914/agent/run",
        MAB_SLACK_AGENT_D_TOKEN: "adapter-smoke-token",
      },
    });
    const job = await runner.startTask({
      task: "Check Slack Agent D adapter live bridge.",
      mode: "smoke",
      allowCodeChanges: false,
      context: {
        sessionId: "session_smoke",
        channelId: "C_SMOKE",
        token: "must-not-leak",
        response_url: "https://hooks.slack.com/must-not-leak",
        nested: {
          trigger_id: "must-not-leak",
          apiKey: "must-not-leak",
          safe: "kept",
        },
      },
    });
    const completed = await waitForRunnerJob(runner, job.id);
    assertSmoke(
      completed.provider === "slack-agent-d",
      "Slack Agent D adapter live job returned wrong provider",
      completed,
    );
    assertSmoke(
      completed.status === "completed",
      "Slack Agent D adapter live job did not complete",
      completed,
    );
    assertSmoke(
      completed.providerJobId === "legacy_job_smoke",
      "Slack Agent D adapter did not preserve upstream job id",
      completed,
    );
    assertSmoke(
      completed.result.includes("Check Slack Agent D adapter live bridge."),
      "Slack Agent D adapter did not receive the task",
      completed,
    );
    assertSmoke(
      captured?.authorization === "Bearer adapter-smoke-token",
      "Slack Agent D adapter did not send bearer token",
      captured,
    );
    assertSmoke(
      captured?.bridgeToken === "adapter-smoke-token",
      "Slack Agent D adapter did not send bridge token header",
      captured,
    );
    const capturedJson = JSON.stringify(captured?.body || {});
    for (const forbidden of ["token", "response_url", "trigger_id", "apiKey", "must-not-leak"]) {
      assertSmoke(
        !capturedJson.includes(forbidden),
        `Slack Agent D adapter leaked private field ${forbidden}`,
        captured,
      );
    }
    assertSmoke(
      captured?.body?.context?.nested?.safe === "kept",
      "Slack Agent D adapter removed safe nested context",
      captured,
    );
    console.log(JSON.stringify({ ok: true, dryRunJob, completed, captured }, null, 2));
  } finally {
    await new Promise((resolve) => server.server.close(resolve));
  }
}

