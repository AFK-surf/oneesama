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

export async function slackDomainStoreSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-domain-"));
  const dbPath = pathJoin(dataDir, "slack-agent-domain.sqlite3");
  const store = createLegacySlackDomainStore({ dbPath });
  try {
    const body = {
      team_id: "T_SMOKE",
      team_domain: "smoke-team",
      channel_id: "C_SMOKE",
      channel_name: "xp-test",
      user_id: "U_PENG",
      user_name: "peng",
      command: "/avatar",
      text: "delegate summarize the latest meeting",
      thread_ts: "1778226000.000100",
    };
    const domain = store.recordSlackCommand({
      body,
      parsed: {
        action: "delegate",
        task: "summarize the latest meeting",
        requestedMode: "analysis",
      },
      session: { id: "sess_smoke" },
      responseSummary: "Delegated to codex: job_smoke.",
    });
    store.syncChannelMembers("C_SMOKE", ["U_PENG", "U_TEAM"]);
    store.setEventCursor("socket:C_SMOKE", "1778226001.000000");
    const pending = store.insertPendingAction({
      channelId: "C_SMOKE",
      threadTs: "1778226000.000100",
      actionType: "create_linear_issue",
      params: { title: "Follow up on meeting summary" },
    });
    const confirmed = store.setPendingActionStatus(
      pending.id as string | number,
      "confirmed",
      "U_PENG",
      JSON.stringify({ ok: true }),
    );
    const outbound = store.reserveOutboundAction({
      actionType: "canvas_publish",
      target: "C_SMOKE",
      reference: "artifact_smoke",
      sessionId: "sess_smoke",
      summary: "Publish meeting summary to Canvas",
    });
    if (outbound.id) store.setOutboundActionStatus(outbound.id, "sent");
    const heartbeat = store.createHeartbeatFollowup({
      kind: "followup",
      title: "Check meeting summary delivery",
      summary: "Make sure Canvas summary landed in Slack.",
      sourceKind: "thread",
      channelId: "C_SMOKE",
      threadTs: "1778226000.000100",
      sourceRef: "C_SMOKE:1778226000.000100",
      nextCheckAt: "2026-05-08T10:00:00.000Z",
    });
    const surface = store.recordHeartbeatSurface({
      followupId: heartbeat.id,
      sessionId: "sess_smoke",
      title: heartbeat.title,
      summary: heartbeat.summary,
      requestedSurface: "slack_thread",
      deliveredSurface: "slack_thread",
      channelId: "C_SMOKE",
      threadTs: "1778226000.000100",
    });
    const triage = store.recordTriageRun({
      run: {
        sessionId: "triage_sess_smoke",
        status: "success",
        summary: "One pending meeting follow-up confirmed.",
        digest: "Buffered Slack activity for xp-test.",
        steps: 2,
        mutations: 1,
        channels: ["C_SMOKE"],
      },
      actions: [
        {
          tool: "suggest_action",
          channel: "C_SMOKE",
          brief: "Ask Operator to confirm Canvas publish.",
        },
      ],
      toolCalls: [
        {
          tool: "suggest_action",
          action: "confirm",
          args: { actionType: "canvas_publish" },
          success: true,
          brief: "Confirmation card created.",
          result: { pendingActionId: pending.id },
        },
      ],
    });
    const triageContexts = store.listTriageContexts(5);
    const triageContext = triageContexts.find((entry) => entry.session_id === "triage_sess_smoke");
    const projectionOne = persistTriageContextProjection({
      workspaceDir: pathJoin(dataDir, "projection-workspace"),
      maxSize: 2,
      context: triageContext,
    });
    const projectionTwo = persistTriageContextProjection({
      workspaceDir: pathJoin(dataDir, "projection-workspace"),
      maxSize: 2,
      context: {
        session_id: "triage_sess_followup",
        status: "success",
        timestamp: "2026-05-08T10:00:00.000Z",
        channels: ["C_SMOKE"],
        actions: [
          { tool: "suggest_action", channel: "C_SMOKE", brief: "Follow up on the recap owner." },
        ],
      },
    });
    const projectionThree = persistTriageContextProjection({
      workspaceDir: pathJoin(dataDir, "projection-workspace"),
      maxSize: 2,
      context: {
        session_id: "triage_sess_actionless",
        status: "failed",
        timestamp: "2026-05-08T11:00:00.000Z",
        channels: ["C_SMOKE"],
        error: "agent runner timed out",
      },
    });
    const projectedTriage = loadTriageContextProjection(pathJoin(dataDir, "projection-workspace"));
    const previousTriageText = formatTriageContexts(projectedTriage);
    const compactWorkspace = pathJoin(dataDir, "compact-workspace");
    const compactDate = "2026-01-01";
    const compactNote = Array.from({ length: 12 }, (_, index) => {
      return `## Topic ${index + 1}\n${"x".repeat(420)}\n`;
    }).join("\n");
    await mkdir(pathJoin(compactWorkspace, "memory"), { recursive: true });
    await writeFile(pathJoin(compactWorkspace, "memory", `${compactDate}.md`), compactNote, "utf8");
    const compactTask = buildDailyNoteCompactionTask({
      workspaceDir: compactWorkspace,
      date: compactDate,
    });
    const compactPrompt = buildDailyNoteCompactionPrompt(compactDate);
    const feedback = store.recordFeedbackEntry({
      entryDate: "2026-05-08",
      entryTime: "18:30",
      action: "confirmed",
      channel: "C_SMOKE",
      actionType: "canvas_publish",
      summary: "Operator confirmed the Canvas publish action.",
      userId: "U_PENG",
    });
    const improvement = store.recordImprovementSignal({
      topic: "progress_noise",
      signalType: "complaint",
      summary: "Progress updates should be concise and tied to evidence.",
      desiredBehavior: "Report current state, blocker, and verification signal without filler.",
      severity: "medium",
      confidence: 0.9,
      channelId: "C_SMOKE",
      threadTs: "1778226000.000100",
      msgTs: "1778226002.000000",
      sessionId: "sess_smoke",
      clusterKey: "bot_experience",
      metadata: { source: "slack-domain-store-smoke" },
    });
    const context = store.context({
      workspaceId: "T_SMOKE",
      channelId: "C_SMOKE",
      threadTs: "1778226000.000100",
      limit: 5,
    });
    const stats = store.stats();
    assertSmoke(
      domain.threadLedger?.last_action_type === "delegate",
      "domain store did not record Slack command action",
      domain,
    );
    assertSmoke(
      context.channelBrain?.last_session_id === "sess_smoke",
      "domain store did not touch channel brain",
      context,
    );
    assertSmoke(
      context.threadLedger?.summary.includes("Delegated"),
      "domain store did not record outbound summary",
      context.threadLedger,
    );
    assertSmoke(
      store.listChannelMemberIds("C_SMOKE").length === 2,
      "domain store did not sync channel members",
    );
    assertSmoke(
      store.getEventCursor("socket:C_SMOKE")?.value === "1778226001.000000",
      "domain store did not persist event cursor",
    );
    assertSmoke(
      confirmed.status === "confirmed",
      "domain store did not confirm pending action",
      confirmed,
    );
    assertSmoke(
      outbound.reserved === true,
      "domain store did not reserve outbound action",
      outbound,
    );
    assertSmoke(
      surface.status === "sent",
      "domain store did not record heartbeat surface",
      surface,
    );
    assertSmoke(triage.status === "success", "domain store did not record triage run", triage);
    assertSmoke(
      triageContext?.actions?.[0]?.tool === "suggest_action",
      "domain store did not project triage actions",
      triageContexts,
    );
    assertSmoke(
      triageContext?.tool_calls?.[0]?.success === true,
      "domain store did not project triage tool calls",
      triageContexts,
    );
    assertSmoke(
      projectionOne.ok === true && projectionTwo.ok === true && projectionThree.ok === true,
      "triage projection persistence failed",
      { projectionOne, projectionTwo, projectionThree },
    );
    assertSmoke(
      projectedTriage.length === 2,
      "triage projection did not keep the bounded active window",
      projectedTriage,
    );
    assertSmoke(
      projectionThree.archived?.[0]?.path && existsSync(projectionThree.archived[0].path),
      "triage projection did not archive evicted entries",
      projectionThree,
    );
    assertSmoke(
      previousTriageText.includes("Previous Triage") &&
        previousTriageText.includes("suggest_action"),
      "triage projection did not format prompt context",
      previousTriageText,
    );
    assertSmoke(
      shouldCompactDailyNote(compactNote) === true,
      "daily note compaction threshold did not match Legacy behavior",
    );
    assertSmoke(
      dailyNoteCompactHash(compactNote) === compactTask.hash,
      "daily note compaction hash was not stable",
      compactTask,
    );
    assertSmoke(
      compactTask.eligible === true && compactTask.prompt.includes(`memory/${compactDate}.md`),
      "daily note compaction task did not build prompt",
      compactTask,
    );
    assertSmoke(
      compactPrompt
        .split("\n")
        .filter((line) => line.includes("MEMORY.md"))
        .every((line) => line.includes("Do NOT read or write MEMORY.md")),
      "daily note compaction prompt references MEMORY.md outside prohibition",
      compactPrompt,
    );
    assertSmoke(
      feedback.action === "confirmed",
      "domain store did not record feedback entry",
      feedback,
    );
    assertSmoke(
      improvement.status === "open",
      "domain store did not record improvement signal",
      improvement,
    );
    assertSmoke(
      store.listFeedbackEntries({ dates: ["2026-05-08"] }).length === 1,
      "domain store did not list feedback by date",
    );
    assertSmoke(
      store.listImprovementSignals({ clusterKey: "bot_experience" }).length === 1,
      "domain store did not list improvement signals",
    );
    for (const table of [
      "thread_case",
      "channel_brain",
      "thread_ledger",
      "pending_action",
      "heartbeat_followup",
      "triage_run",
      "feedback_entry",
      "improvement_signal",
    ]) {
      assertSmoke(stats.tables[table] >= 1, `domain store missing table rows for ${table}`, stats);
    }

    const slackPort = 18947;
    const slackUrl = `http://127.0.0.1:${slackPort}`;
    const refreshDbPath = pathJoin(dataDir, "slack-agent-domain-refresh.sqlite3");
    const slack = startService("apps/slack-agent/src/index.js", {
      MAB_SLACK_PORT: String(slackPort),
      MAB_DATA_DIR: pathJoin(dataDir, "service-data"),
      MAB_SLACK_DOMAIN_DB_PATH: refreshDbPath,
      MAB_DRY_RUN_AGENT: "1",
      MAB_SLACK_POSTER_MOCK: "1",
      SLACK_SIGNING_SECRET: "domain-refresh-smoke-signing-secret",
    });
    let refresh = null;
    let refreshedContext = null;
    try {
      await waitForServiceHealth(slack, `${slackUrl}/healthz`);
      refresh = await postJsonWithStatus(`${slackUrl}/slack/domain/refresh`, {
        workspace: "T_SMOKE",
        channels: [
          {
            id: "C_AUTO",
            name: "auto-cache",
            is_channel: true,
            members: ["U_PENG", "U_TEAM"],
          },
          {
            id: "G_PRIVATE",
            name: "private-cache",
            is_private: true,
            members: ["U_PENG"],
          },
        ],
      });
      assertSmoke(
        refresh.httpStatus === 200 && refresh.ok === true,
        "domain refresh route failed",
        refresh,
      );
      assertSmoke(
        refresh.channelCount === 2 && refresh.memberCount === 3,
        "domain refresh route did not sync fixture channels/members",
        refresh,
      );

      refreshedContext = await (
        await fetch(`${slackUrl}/slack/domain/context?workspace=T_SMOKE&channel=C_AUTO`)
      ).json();
      assertSmoke(
        refreshedContext.context?.channel?.name === "auto-cache",
        "domain refresh route did not store channel cache",
        refreshedContext,
      );
      assertSmoke(
        refreshedContext.context?.channelMembers?.length === 2,
        "domain refresh route did not store channel members",
        refreshedContext,
      );
    } finally {
      slack.child.kill("SIGTERM");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          dbPath,
          stats,
          context,
          pending: confirmed,
          outbound,
          heartbeat,
          surface,
          triage,
          triageContexts,
          projectedTriage,
          previousTriageText,
          compactTask,
          feedback,
          improvement,
          refresh,
          refreshedContext,
        },
        null,
        2,
      ),
    );
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function slackTriageFlowSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-triage-"));
  const env = {
    MAB_SLACK_PORT: "18944",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18945",
    MAB_AGENT_RUNNER: "command",
    MAB_AGENT_COMMAND: `node -e 'let input=""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { const job = JSON.parse(input || "{}"); const task = String(job.task || ""); const needsAction = task.includes("meet.google.com") || task.includes("pending action"); const payload = needsAction ? { summary: "join meeting suggested", actions: [{ type: "join_meeting", title: "Join demo room", message: "Join the demo room and summarize it.", confidence: 0.88, requiresConfirmation: true }] } : { summary: "No action.", actions: [] }; console.log(JSON.stringify({ status: "completed", result: JSON.stringify(payload) })); });'`,
    MAB_DATA_DIR: dataDir,
    MAB_SLACK_POSTER_MOCK: "1",
    MAB_SLACK_EVENT_TRIAGE: "1",
    MAB_SLACK_TRIAGE_POST_ACTIONS: "1",
    MAB_SLACK_TRIAGE_HEURISTIC_FALLBACK: "1",
    SLACK_SIGNING_SECRET: "slack-triage-flow-signing-secret",
  };
  const slack = startService("apps/slack-agent/src/index.js", env);
  try {
    await waitForHealth("http://127.0.0.1:18944/healthz");
    const messages = [
      {
        teamId: "T_TRIAGE",
        channelId: "C_TRIAGE",
        userId: "U_PENG",
        text: "todo: follow up with the team about the Canvas summary and meeting recording",
        ts: "1778232000.000100",
        threadTs: "1778232000.000100",
      },
      {
        teamId: "T_TRIAGE",
        channelId: "C_TRIAGE",
        userId: "U_TEAM",
        text: "blocked until the bot posts the recap",
        ts: "1778232002.000200",
        threadTs: "1778232000.000100",
      },
    ];
    const events = [];
    for (const [index, message] of messages.entries()) {
      const event = await postSignedSlackJson(
        "http://127.0.0.1:18944/slack/events",
        {
          token: "deprecated-verification-token",
          team_id: message.teamId,
          api_app_id: "A_TRIAGE",
          event_id: `EvTRIAGE${index}`,
          type: "event_callback",
          event: {
            type: "message",
            channel: message.channelId,
            channel_type: "channel",
            user: message.userId,
            text: message.text,
            ts: message.ts,
            thread_ts: message.threadTs,
          },
        },
        { signingSecret: env.SLACK_SIGNING_SECRET },
      );
      assertSmoke(
        event.ok === true && event.mode === "event_buffer",
        "Slack event was not buffered for triage",
        event,
      );
      events.push(event);
    }
    const flush = await postJsonWithStatus("http://127.0.0.1:18944/slack/inbound/flush", {
      channel: "C_TRIAGE",
    });
    assertSmoke(
      flush.ok === true && flush.flushed?.[0]?.count === 2,
      "Slack triage buffer flush failed",
      flush,
    );

    const sweepFirst = await postJsonWithStatus("http://127.0.0.1:18944/slack/scanner/sweep", {
      workspace: "T_TRIAGE",
      channels: [
        {
          id: "C_SWEEP",
          name: "scanner-sweep",
          type: "public_channel",
          messages: [
            { user: "U_PENG", text: "first scanner sweep message", ts: "1778233000.000100" },
            {
              user: "U_TEAM",
              text: "second scanner sweep message",
              ts: "1778233002.000200",
              thread_ts: "1778233000.000100",
            },
          ],
        },
      ],
    });
    assertSmoke(
      sweepFirst.httpStatus === 200 && sweepFirst.ok === true,
      "Slack scanner first sweep failed",
      sweepFirst,
    );
    assertSmoke(
      sweepFirst.sweeps?.[0]?.buffered === 2,
      "Slack scanner first sweep did not buffer both messages",
      sweepFirst,
    );
    assertSmoke(
      sweepFirst.sweeps?.[0]?.flushed?.count === 2,
      "Slack scanner first sweep did not flush buffered messages",
      sweepFirst,
    );

    const sweepSecond = await postJsonWithStatus("http://127.0.0.1:18944/slack/scanner/sweep", {
      workspace: "T_TRIAGE",
      channels: [
        {
          id: "C_SWEEP",
          name: "scanner-sweep",
          type: "public_channel",
          messages: [
            { user: "U_PENG", text: "first scanner sweep message", ts: "1778233000.000100" },
            {
              user: "U_TEAM",
              text: "second scanner sweep message",
              ts: "1778233002.000200",
              thread_ts: "1778233000.000100",
            },
            { user: "U_PENG", text: "new scanner sweep message", ts: "1778233004.000300" },
          ],
        },
      ],
    });
    assertSmoke(
      sweepSecond.httpStatus === 200 && sweepSecond.ok === true,
      "Slack scanner second sweep failed",
      sweepSecond,
    );
    assertSmoke(
      sweepSecond.sweeps?.[0]?.previousCursor === sweepFirst.sweeps?.[0]?.nextCursor,
      "Slack scanner second sweep did not reuse cursor",
      { sweepFirst, sweepSecond },
    );
    assertSmoke(
      sweepSecond.sweeps?.[0]?.buffered === 1,
      "Slack scanner second sweep did not skip previously seen messages",
      sweepSecond,
    );

    const sweepContext = await (
      await fetch("http://127.0.0.1:18944/slack/domain/context?workspace=T_TRIAGE&channel=C_SWEEP")
    ).json();
    assertSmoke(
      sweepContext.context?.channel?.id === "C_SWEEP",
      "Slack scanner sweep did not upsert channel context",
      sweepContext,
    );
    assertSmoke(
      sweepContext.context?.recentThreads?.some(
        (entry) => entry.channel_id === "C_SWEEP" && entry.thread_ts === "1778233004.000300",
      ),
      "Slack scanner sweep did not replay the newly discovered message",
      sweepContext,
    );

    const followupCreate = await postJsonWithStatus(
      "http://127.0.0.1:18944/slack/followups/create",
      {
        channel: "C_FOLLOW",
        threadTs: "1778235000.000100",
        sessionId: "sess_followup_smoke",
        title: "Check boss demo follow-up",
        summary: "Make sure the Slack follow-up surface can be tracked without a heartbeat loop.",
        recommendationType: "review_thread",
        recommendationStatus: "active",
        outboundActionType: "post_followup",
        outboundStatus: "sent",
        followupStatus: "open",
        metadata: { source: "smoke" },
      },
    );
    assertSmoke(
      followupCreate.httpStatus === 200 && followupCreate.ok === true,
      "Slack followup create route failed",
      followupCreate,
    );
    assertSmoke(
      followupCreate.followup?.status === "open",
      "Slack followup route did not persist heartbeat followup",
      followupCreate,
    );
    assertSmoke(
      followupCreate.surface?.status === "sent",
      "Slack followup route did not persist surfaced heartbeat",
      followupCreate,
    );
    assertSmoke(
      followupCreate.recommendation?.status === "active",
      "Slack followup route did not persist thread recommendation",
      followupCreate,
    );
    assertSmoke(
      followupCreate.outbound?.status === "sent",
      "Slack followup route did not persist outbound action",
      followupCreate,
    );

    const followupStatus = await (
      await fetch("http://127.0.0.1:18944/slack/followups/status?limit=20")
    ).json();
    assertSmoke(
      followupStatus.heartbeatFollowups?.some(
        (entry) => entry.title === "Check boss demo follow-up",
      ),
      "Slack followup status did not list heartbeat followup",
      followupStatus,
    );
    assertSmoke(
      followupStatus.heartbeatSurfaces?.some((entry) => entry.session_id === "sess_followup_smoke"),
      "Slack followup status did not list heartbeat surface",
      followupStatus,
    );
    assertSmoke(
      followupStatus.threadRecommendations?.some(
        (entry) => entry.recommendation_type === "review_thread",
      ),
      "Slack followup status did not list thread recommendation",
      followupStatus,
    );
    assertSmoke(
      followupStatus.outboundActions?.some(
        (entry) => entry.action_type === "post_followup" && entry.status === "sent",
      ),
      "Slack followup status did not list outbound action",
      followupStatus,
    );

    const compactDate = "2026-01-01";
    const compactNote = Array.from({ length: 12 }, (_, index) => {
      return `## Scanner Topic ${index + 1}\n${"daily-note".repeat(45)}\n`;
    }).join("\n");
    await mkdir(pathJoin(dataDir, "slack-workspace", "memory"), { recursive: true });
    await writeFile(
      pathJoin(dataDir, "slack-workspace", "memory", `${compactDate}.md`),
      compactNote,
      "utf8",
    );
    const compactRoute = await postJsonWithStatus("http://127.0.0.1:18944/slack/scanner/compact", {
      date: compactDate,
    });
    assertSmoke(
      compactRoute.httpStatus === 200 && compactRoute.ok === true,
      "Slack scanner compaction route failed",
      compactRoute,
    );
    assertSmoke(
      compactRoute.eligible === true && compactRoute.sessionKind === "memory_compact",
      "Slack scanner compaction route did not detect eligible daily note",
      compactRoute,
    );
    assertSmoke(
      compactRoute.prompt?.includes(`memory/${compactDate}.md`),
      "Slack scanner compaction route did not build the expected prompt",
      compactRoute,
    );

    const mutationTriage = await postJsonWithStatus("http://127.0.0.1:18944/slack/triage/run", {
      team_id: "T_TRIAGE",
      channel_id: "C_ACTIONS",
      user_id: "U_PENG",
      text: "https://meet.google.com/abc-defg-hij 帮我让 bot 进会",
      ts: "1778234000.000100",
      thread_ts: "1778234000.000100",
    });
    assertSmoke(
      mutationTriage.httpStatus === 200 && mutationTriage.ok === true,
      "Slack triage explicit mutation route failed",
      mutationTriage,
    );

    let status = await (await fetch("http://127.0.0.1:18944/slack/triage/status?limit=10")).json();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pending = status.triage?.pendingActions || [];
      if (
        pending.some(
          (entry) =>
            entry.action_type === "join_meeting" && entry.thread_ts === "1778234000.000100",
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await (await fetch("http://127.0.0.1:18944/slack/triage/status?limit=10")).json();
    }
    const runs = status.triage?.runs || [];
    const pendingActions = status.triage?.pendingActions || [];
    const projectedTriage = loadTriageContextProjection(pathJoin(dataDir, "slack-workspace"));
    assertSmoke(
      runs.some((entry) => entry.status === "success"),
      "Slack triage flow did not record a successful triage run",
      status,
    );
    assertSmoke(
      pendingActions.some((entry) => entry.action_type === "join_meeting"),
      "Slack triage flow did not create a pending action for explicit mutation",
      status,
    );
    assertSmoke(
      pendingActions.some((entry) => entry.card_ts && entry.card_ts.startsWith("mock.")),
      "Slack triage flow did not post a mock action card",
      status,
    );
    assertSmoke(
      projectedTriage.some(
        (entry) =>
          entry.actions.length >= 1 &&
          entry.tool_calls.some((call) => call.tool === "agent_runner"),
      ),
      "Slack triage flow did not persist projected triage context",
      projectedTriage,
    );

    const blockFixture = buildSlackTriageActionBlocks({
      action: {
        type: "join_meeting",
        title: "Join demo room",
        message: "Join the demo room and summarize it.",
        reason: "Meet link appeared in the thread.",
        confidence: 0.88,
        channelId: "C_ACTIONS",
        threadTs: "1778234000.000100",
      },
      pendingAction: {
        id: 4242,
        channel_id: "C_ACTIONS",
        thread_ts: "1778234000.000100",
        action_type: "join_meeting",
      },
    });
    type ActionBlock = {
      type?: string;
      elements?: Array<{ action_id?: string; type?: string; [key: string]: unknown }>;
      [key: string]: unknown;
    };
    const actionBlock: ActionBlock =
      (blockFixture as ActionBlock[]).find((block) => block.type === "actions") || {};
    const actionIds = new Set((actionBlock.elements || []).map((element) => element.action_id));
    for (const expectedActionId of [
      "mab_pending_action_confirm",
      "mab_pending_action_dismiss",
      "mab_pending_action_snooze",
      "mab_pending_action_open_thread",
      "mab_pending_action_assign",
    ]) {
      assertSmoke(
        actionIds.has(expectedActionId),
        `Slack pending action Block Kit missing ${expectedActionId}`,
        blockFixture,
      );
    }
    const assignElement = (actionBlock.elements || []).find(
      (element) => element.action_id === "mab_pending_action_assign",
    );
    assertSmoke(
      assignElement?.type === "users_select",
      "Slack pending action assign control should be a users_select",
      blockFixture,
    );
    assertSmoke(
      !Object.prototype.hasOwnProperty.call(assignElement || {}, "value"),
      "Slack pending action assign control should not set unsupported value field",
      blockFixture,
    );

    const interactionSpecs = [
      { label: "confirm", status: "confirmed", actionId: "mab_pending_action_confirm" },
      { label: "dismiss", status: "dismissed", actionId: "mab_pending_action_dismiss" },
      {
        label: "snooze",
        status: "snoozed",
        actionId: "mab_pending_action_snooze",
        extra: { snoozeMinutes: 60 },
      },
      {
        label: "open",
        status: "opened",
        actionId: "mab_pending_action_open_thread",
        extra: { channelId: "C_ACTIONS", threadTs: "1778234000.000100" },
      },
      {
        label: "assign",
        status: "assigned",
        actionId: "mab_pending_action_assign",
        selectedUser: "U_ASSIGNEE",
        omitValue: true,
      },
    ];
    const interactions = [];
    for (const [index, spec] of interactionSpecs.entries()) {
      const threadTs = `17782340${index}.000100`;
      const triageRun = await postJsonWithStatus("http://127.0.0.1:18944/slack/triage/run", {
        team: "T_TRIAGE",
        channel: "C_ACTIONS",
        messages: [
          {
            teamId: "T_TRIAGE",
            channelId: "C_ACTIONS",
            userId: "U_PENG",
            text: `todo: ${spec.label} this pending action https://meet.google.com/abc-defg-hij`,
            ts: threadTs,
            threadTs,
          },
        ],
      });
      let pendingAction = triageRun.status?.pendingActions?.[0]?.pendingAction || null;
      for (let attempt = 0; !pendingAction && attempt < 5; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const triageStatus = await (
          await fetch("http://127.0.0.1:18944/slack/triage/status?limit=20")
        ).json();
        pendingAction =
          (triageStatus.triage?.pendingActions || []).find(
            (entry) => entry.thread_ts === threadTs,
          ) || null;
      }
      assertSmoke(
        pendingAction?.id,
        `Slack triage run did not create a pending action for ${spec.label}`,
        triageRun,
      );
      const interaction = await postSignedSlackInteraction(
        "http://127.0.0.1:18944/slack/interactions",
        {
          type: "block_actions",
          team: { id: "T_TRIAGE" },
          user: { id: "U_REVIEWER", username: "reviewer" },
          channel: { id: "C_ACTIONS", name: "actions" },
          message: {
            ts: pendingAction.card_ts || `mock.${index}`,
            thread_ts: pendingAction.thread_ts,
          },
          actions: [
            {
              action_id: spec.actionId,
              block_id: `mab_pending_action:${pendingAction.id}`,
              ...(!spec.omitValue
                ? {
                    value: JSON.stringify({
                      kind: "mab_pending_action",
                      id: pendingAction.id,
                      status: spec.status,
                      ...spec.extra,
                    }),
                  }
                : {}),
              ...(spec.selectedUser ? { selected_user: spec.selectedUser } : {}),
            },
          ],
        },
        { signingSecret: env.SLACK_SIGNING_SECRET },
      );
      assertSmoke(
        interaction.httpStatus === 200 && interaction.ok === true,
        `Slack pending action ${spec.label} interaction failed`,
        interaction,
      );
      assertSmoke(
        interaction.pendingAction?.status === spec.status,
        `Slack pending action ${spec.label} did not persist status`,
        interaction,
      );
      if (spec.selectedUser) {
        assertSmoke(
          String(interaction.pendingAction?.result || "").includes(spec.selectedUser),
          "Slack pending action assign did not persist assignee",
          interaction,
        );
      }
      interactions.push({ label: spec.label, response: interaction });
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          events,
          flush,
          sweepFirst,
          sweepSecond,
          sweepContext,
          followupCreate,
          followupStatus,
          compactRoute,
          status,
          projectedTriage,
          blockFixture,
          interactions,
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

