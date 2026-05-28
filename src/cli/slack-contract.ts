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

export async function slackContractSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-contract-"));
  const env = {
    MAB_SLACK_PORT: "18920",
    MAB_MEETING_PORT: "18921",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18921",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    MAB_CUTOVER_MODE: "new",
    MAB_SLACK_API_MOCK: "1",
    MAB_SLACK_EVENT_ALLOW_BOT_MESSAGES: "1",
    MAB_SLACK_POSTER_MOCK: "1",
    MAB_SLACK_BOT_USER_ID: "U_BOT",
    SLACK_BOT_TOKEN: "placeholder-bot-token",
    SLACK_SIGNING_SECRET: "slack-contract-signing-secret",
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const slack = startService("apps/slack-agent/src/index.js", env);

  try {
    const parserJoin = parseAvatarCommand(
      'join https://meet.google.com/abc-defg-hij?authuser=2 --avatar hiyori --bot-name "Contract Bot" --dry-run false --start-joiner false',
    );
    assertSmoke(parserJoin.action === "join", "Slack parser did not parse join action", parserJoin);
    assertSmoke(
      parserJoin.validMeetUrl === true,
      "Slack parser rejected valid Meet URL with query",
      parserJoin,
    );
    assertSmoke(
      parserJoin.botName === "Contract Bot",
      "Slack parser did not preserve quoted bot name",
      parserJoin,
    );
    assertSmoke(
      parserJoin.dryRunJoiner === false,
      "Slack parser did not parse --dry-run false",
      parserJoin,
    );
    assertSmoke(
      parserJoin.startJoiner === false,
      "Slack parser did not parse --start-joiner false",
      parserJoin,
    );

    const parserDelegate = parseAvatarCommand(
      'delegate --session meet_contract_123 --mode code --write true "Fix the flaky Slack contract"',
    );
    assertSmoke(
      parserDelegate.action === "delegate",
      "Slack parser did not parse delegate action",
      parserDelegate,
    );
    assertSmoke(
      parserDelegate.sessionId === "meet_contract_123",
      "Slack parser did not parse --session",
      parserDelegate,
    );
    assertSmoke(
      parserDelegate.requestedMode === "code",
      "Slack parser did not parse --mode",
      parserDelegate,
    );
    assertSmoke(
      parserDelegate.allowCodeChanges === true,
      "Slack parser did not parse --write true",
      parserDelegate,
    );
    assertSmoke(
      parserDelegate.task === "Fix the flaky Slack contract",
      "Slack parser did not preserve quoted task",
      parserDelegate,
    );

    const parserStop = parseAvatarCommand('stop meet_contract_123 --reason "contract done"');
    assertSmoke(parserStop.action === "stop", "Slack parser did not parse stop action", parserStop);
    assertSmoke(
      parserStop.sessionId === "meet_contract_123",
      "Slack parser did not parse positional stop session",
      parserStop,
    );
    assertSmoke(
      parserStop.flags.reason === "contract done",
      "Slack parser did not preserve quoted stop reason",
      parserStop,
    );

    const nowSeconds = Math.floor(Date.now() / 1000);
    const rawBody = buildSlackCommandForm("status", { userId: "U_CONTRACT" });
    const validSignature = signSlackRequestBody({
      signingSecret: env.SLACK_SIGNING_SECRET,
      timestamp: String(nowSeconds),
      rawBody,
    });
    assertSmoke(
      verifySlackRequest({
        signingSecret: env.SLACK_SIGNING_SECRET,
        timestamp: String(nowSeconds),
        signature: validSignature,
        rawBody,
        nowSeconds,
      }).ok === true,
      "Slack signature verifier rejected valid fixture signature",
    );
    assertSmoke(
      verifySlackRequest({
        signingSecret: env.SLACK_SIGNING_SECRET,
        timestamp: String(nowSeconds - 999),
        signature: signSlackRequestBody({
          signingSecret: env.SLACK_SIGNING_SECRET,
          timestamp: String(nowSeconds - 999),
          rawBody,
        }),
        rawBody,
        nowSeconds,
      }).error === "stale_timestamp",
      "Slack signature verifier did not reject stale timestamp",
    );
    assertSmoke(
      verifySlackRequest({
        signingSecret: env.SLACK_SIGNING_SECRET,
        timestamp: String(nowSeconds),
        signature: "v0=bad",
        rawBody,
        nowSeconds,
      }).error === "signature_mismatch",
      "Slack signature verifier did not reject mismatched signature",
    );

    await waitForHealth("http://127.0.0.1:18921/healthz");
    await waitForHealth("http://127.0.0.1:18920/healthz");

    const botDmEvent = await postSignedSlackJson(
      "http://127.0.0.1:18920/slack/events",
      {
        team_id: "T_CONTRACT",
        api_app_id: "A_CONTRACT",
        event_id: "EvBOTDMCONTRACT",
        type: "event_callback",
        event: {
          type: "message",
          channel: "D_CONTRACT",
          channel_type: "im",
          user: "U_BOT",
          bot_id: "B_CONTRACT",
          subtype: "bot_message",
          text: "Delegated to codex: job_contract (running).",
          ts: "1778517200.000100",
        },
      },
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      botDmEvent.ok === true &&
        botDmEvent.ignored === true &&
        botDmEvent.reason === "bot_or_subtype",
      "Slack Events API allowed a bot DM message to re-enter the command path",
      botDmEvent,
    );
    const jobsAfterBotDm = await (await fetch("http://127.0.0.1:18920/jobs")).json();
    assertSmoke(
      jobsAfterBotDm.jobs?.length === 0,
      "Bot DM message created a worker job and would self-trigger",
      jobsAfterBotDm,
    );

    const assistantThreadStarted = await postSignedSlackJson(
      "http://127.0.0.1:18920/slack/events",
      {
        team_id: "T_CONTRACT",
        api_app_id: "A_CONTRACT",
        event_id: "EvASSISTANTTHREADCONTRACT",
        type: "event_callback",
        event: {
          type: "assistant_thread_started",
          assistant_thread: {
            channel_id: "D_CONTRACT",
            thread_ts: "1778517200.000200",
            user_id: "U_CONTRACT",
          },
        },
      },
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      assistantThreadStarted.ok === true && assistantThreadStarted.handled === true,
      "Slack assistant thread started event was not handled",
      assistantThreadStarted,
    );

    const assistantDmEvent = await postSignedSlackJson(
      "http://127.0.0.1:18920/slack/events",
      {
        team_id: "T_CONTRACT",
        api_app_id: "A_CONTRACT",
        event_id: "EvASSISTANTDMCONTRACT",
        type: "event_callback",
        event: {
          type: "message",
          channel: "D_CONTRACT",
          channel_type: "im",
          user: "U_CONTRACT",
          text: "jobs",
          ts: "1778517200.000300",
          thread_ts: "1778517200.000200",
        },
      },
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      assistantDmEvent.ok === true &&
        assistantDmEvent.handled === true &&
        assistantDmEvent.mode === "dm_command",
      "Slack assistant DM event did not enter the command path",
      assistantDmEvent,
    );
    const assistantStatus = await (
      await fetch("http://127.0.0.1:18920/slack/assistant/status")
    ).json();
    const assistantMethods = assistantStatus.calls?.map((call) => call.method) || [];
    assertSmoke(
      assistantMethods.includes("assistant.threads.setSuggestedPrompts"),
      "Slack assistant suggested prompts were not sent",
      assistantStatus,
    );
    assertSmoke(
      assistantStatus.calls?.some(
        (call) =>
          call.method === "assistant.threads.setStatus" && call.payload?.status === "Thinking...",
      ),
      "Slack assistant thinking status was not sent",
      assistantStatus,
    );
    assertSmoke(
      assistantStatus.calls?.some(
        (call) =>
          call.method === "assistant.threads.setStatus" &&
          call.payload?.status === "" &&
          !("loading_messages" in call.payload),
      ),
      "Slack assistant clear status should not send empty loading_messages",
      assistantStatus,
    );

    const fallbackMention = await postSignedSlackJson(
      "http://127.0.0.1:18920/slack/events",
      {
        team_id: "T_CONTRACT",
        api_app_id: "A_CONTRACT",
        event_id: "EvMESSAGEFALLBACKMENTIONCONTRACT",
        type: "event_callback",
        event: {
          type: "message",
          channel: "C_CONTRACT",
          channel_type: "channel",
          user: "U_CONTRACT",
          text: "<@U_BOT> hello from fallback",
          ts: "1778517200.000350",
        },
      },
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      fallbackMention.ok === true &&
        fallbackMention.handled === true &&
        fallbackMention.mode === "message_mention",
      "Slack message fallback mention did not enter the command path",
      fallbackMention,
    );
    const fallbackStatus = await (
      await fetch("http://127.0.0.1:18920/slack/assistant/status")
    ).json();
    assertSmoke(
      fallbackStatus.calls?.some(
        (call) =>
          call.method === "assistant.threads.setStatus" &&
          call.payload?.channel_id === "C_CONTRACT" &&
          call.payload?.thread_ts === "1778517200.000350" &&
          call.payload?.status === "Thinking...",
      ),
      "Slack message fallback mention did not set Thinking status",
      fallbackStatus,
    );
    assertSmoke(
      fallbackStatus.calls?.some(
        (call) =>
          call.method === "assistant.threads.setStatus" &&
          call.payload?.channel_id === "C_CONTRACT" &&
          call.payload?.thread_ts === "1778517200.000350" &&
          call.payload?.status === "",
      ),
      "Slack message fallback mention did not clear Thinking status after worker completion",
      fallbackStatus,
    );

    const richMention = await postSignedSlackJson(
      "http://127.0.0.1:18920/slack/events",
      {
        team_id: "T_CONTRACT",
        api_app_id: "A_CONTRACT",
        event_id: "EvAPPMENTIONRICHCONTRACT",
        type: "event_callback",
        thread_messages: [
          {
            type: "message",
            channel: "C_CONTRACT",
            user: "U_PARENT",
            ts: "1778517200.000400",
            text: "Boss demo room: https://meet.google.com/abc-defg-hij",
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "Decision: *record the demo* and include Canvas context.",
                },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Open brief" },
                    url: "https://example.com/brief",
                  },
                ],
              },
            ],
            attachments: [
              {
                title: "Demo Canvas",
                title_link: "https://slack.com/canvas/ABC",
                text: "Canvas-backed launch notes",
                files: [
                  {
                    id: "F_CANVAS",
                    name: "Launch Canvas",
                    title: "Launch Canvas",
                    filetype: "quip",
                    mimetype: "application/vnd.slack-docs",
                    size: 2048,
                  },
                ],
              },
            ],
            files: [
              {
                id: "F_IMG",
                name: "avatar.png",
                title: "Avatar frame",
                filetype: "png",
                mimetype: "image/png",
                size: 12345,
                permalink: "https://files.example/avatar.png",
              },
            ],
            reactions: [{ name: "eyes", count: 2 }],
          },
          {
            type: "app_mention",
            channel: "C_CONTRACT",
            user: "U_CONTRACT",
            ts: "1778517200.000500",
            thread_ts: "1778517200.000400",
            text: "<@U_BOT>",
          },
        ],
        event: {
          type: "app_mention",
          channel: "C_CONTRACT",
          user: "U_CONTRACT",
          text: "<@U_BOT>",
          ts: "1778517200.000500",
          thread_ts: "1778517200.000400",
        },
      },
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      richMention.ok === true && richMention.handled === true && richMention.mode === "app_mention",
      "Slack rich app_mention fixture did not enter command path",
      richMention,
    );
    const richMentionDuplicate = await postSignedSlackJson(
      "http://127.0.0.1:18920/slack/events",
      {
        team_id: "T_CONTRACT",
        api_app_id: "A_CONTRACT",
        event_id: "EvAPPMENTIONRICHCONTRACTDUP",
        type: "event_callback",
        event: {
          type: "message",
          channel: "C_CONTRACT",
          channel_type: "channel",
          user: "U_CONTRACT",
          text: "<@U_BOT>",
          ts: "1778517200.000500",
          thread_ts: "1778517200.000400",
        },
      },
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      richMentionDuplicate.ok === true &&
        richMentionDuplicate.ignored === true &&
        richMentionDuplicate.reason === "duplicate_mention_event",
      "Slack duplicate app_mention/message fallback created a second command path",
      richMentionDuplicate,
    );
    const richContext =
      richMention.response?.richThreadContext ||
      richMention.response?.job?.context?.slackAppMention ||
      {};
    assertSmoke(
      richContext.injectedJoinRequest === true,
      "empty rich mention with Meet URL did not inject join request",
      richContext,
    );
    assertSmoke(
      richContext.transcript?.includes("Boss demo room"),
      "rich mention transcript missed parent text",
      richContext,
    );
    assertSmoke(
      richContext.transcript?.includes("[canvas:"),
      "rich mention transcript missed Canvas file",
      richContext,
    );
    assertSmoke(
      richContext.transcript?.includes("[file: avatar.png"),
      "rich mention transcript missed image file metadata",
      richContext,
    );
    assertSmoke(
      richContext.transcript?.includes("[reactions:"),
      "rich mention transcript missed reactions",
      richContext,
    );
    assertSmoke(
      richContext.imageParts?.length === 1,
      "rich mention did not expose image metadata",
      richContext,
    );
    assertSmoke(
      richMention.response?.job?.task?.includes("请帮我加入这个会议") &&
        richMention.response?.job?.context?.slackAppMention?.prompt?.includes("Thread context:"),
      "rich mention delegate job did not carry the expected thread prompt",
      richMention.response?.job,
    );
    const richMentionJobs = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      "jobs",
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      richMentionJobs.readyForSlack?.jobs?.some((job) => job.id === richMention.response?.job?.id),
      "rich app_mention worker result was not available for Slack post-back",
      richMentionJobs,
    );
    const slackPostingStatus = await (
      await fetch("http://127.0.0.1:18920/slack/assistant/status")
    ).json();
    assertSmoke(
      slackPostingStatus.calls?.some(
        (call) =>
          call.method === "chat.postMessage" &&
          /Dry-run (agent runner|Codex App Server runner) accepted the task\./.test(
            call.payload?.text || "",
          ),
      ),
      "rich app_mention final worker result was not posted back to Slack",
      slackPostingStatus,
    );

    const help = await postSignedSlackCommand("http://127.0.0.1:18920/commands/avatar", "help", {
      signingSecret: env.SLACK_SIGNING_SECRET,
    });
    assertSmoke(
      help.httpStatus === 200 && help.text?.includes("/avatar join"),
      "Slack help contract failed",
      help,
    );

    const badSignature = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      "status",
      { signingSecret: "wrong-contract-secret" },
    );
    assertSmoke(
      badSignature.httpStatus === 401 && badSignature.ok === false,
      "Slack service accepted wrong signature",
      badSignature,
    );

    const staleSignature = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      "status",
      { signingSecret: env.SLACK_SIGNING_SECRET, timestamp: String(nowSeconds - 999) },
    );
    assertSmoke(
      staleSignature.httpStatus === 401 && staleSignature.text?.includes("stale_timestamp"),
      "Slack service accepted stale timestamp",
      staleSignature,
    );

    const invalidJoin = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      "join https://example.com/not-meet",
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      invalidJoin.httpStatus === 400 && invalidJoin.ok === false,
      "Slack service accepted invalid Meet URL",
      invalidJoin,
    );

    const unknown = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      "dance",
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      unknown.httpStatus === 400 && unknown.text?.includes("Unknown command: dance"),
      "Slack service accepted unknown command",
      unknown,
    );

    const join = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      'join https://meet.google.com/abc-defg-hij?authuser=2 --avatar hiyori --bot-name "Contract Bot"',
      {
        signingSecret: env.SLACK_SIGNING_SECRET,
        userId: "U_CONTRACT",
        formOverrides: {
          team_id: "T_CONTRACT",
          channel_id: "C_CONTRACT",
          response_url: "https://hooks.slack.com/commands/contract",
          trigger_id: "contract-trigger",
        },
      },
    );
    const sessionId = join.session?.id;
    assertSmoke(
      join.httpStatus === 200 && join.ok === true && sessionId,
      "Slack join contract did not create a session",
      join,
    );
    assertSmoke(
      join.session?.requestedBy === "U_CONTRACT",
      "Slack join did not preserve Slack user id",
      join.session,
    );
    assertSmoke(
      join.session?.status === "meeting_agent_started",
      "Slack join did not start Meeting Agent in dry-run mode",
      join.session,
    );
    assertSmoke(
      join.meetingAgent?.session?.meetUrl?.includes("abc-defg-hij"),
      "Slack join did not hand the Meet URL to Meeting Agent",
      join.meetingAgent,
    );
    assertSmoke(
      join.slackVerification?.ok === true && join.slackVerification?.skipped === false,
      "Slack join did not include successful verification metadata",
      join.slackVerification,
    );

    const meetingSessions = await (await fetch("http://127.0.0.1:18921/sessions")).json();
    assertSmoke(
      meetingSessions.sessions?.length === 1,
      "Meeting Agent did not receive exactly one session",
      meetingSessions,
    );

    const status = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      `status ${sessionId}`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      status.httpStatus === 200 && status.session?.id === sessionId,
      "Slack status contract did not resolve session id",
      status,
    );
    assertSmoke(
      Array.isArray(status.jobs),
      "Slack status contract did not include local runner jobs",
      status,
    );

    const missingDelegateTask = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      `delegate --session ${sessionId}`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      missingDelegateTask.httpStatus === 400 && missingDelegateTask.text?.includes("missing task"),
      "Slack delegate accepted a missing task",
      missingDelegateTask,
    );

    const delegate = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      `delegate --session ${sessionId} --mode code --write true "Summarize Slack contract matrix"`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      delegate.httpStatus === 200 && delegate.job?.status === "completed",
      "Slack delegate contract did not complete dry-run job",
      delegate,
    );
    assertSmoke(
      delegate.job?.mode === "code",
      "Slack delegate did not preserve requested mode",
      delegate.job,
    );
    assertSmoke(
      delegate.job?.allowCodeChanges === true,
      "Slack delegate did not preserve write permission flag",
      delegate.job,
    );
    assertSmoke(
      delegate.job?.context?.sessionId === sessionId,
      "Slack delegate did not attach session context",
      delegate.job,
    );
    assertSmoke(
      delegate.job?.context?.slack?.workspaceId === "T_SMOKE",
      "Slack delegate did not attach workspace id",
      delegate.job?.context,
    );
    assertSmoke(
      delegate.job?.context?.slack?.channelId === "C_SMOKE",
      "Slack delegate did not attach channel id",
      delegate.job?.context,
    );
    assertSmoke(
      delegate.job?.context?.workspaceContext?.recentCommands?.length >= 1,
      "Slack delegate did not attach recent workspace context",
      delegate.job?.context,
    );
    assertSmoke(
      !JSON.stringify(delegate.job?.context || {}).includes("response_url"),
      "Slack delegate leaked private Slack response_url into agent context",
      delegate.job?.context,
    );
    assertSmoke(
      delegate.meetingReport?.job?.id === delegate.job?.id,
      "Slack delegate did not report completed job to Meeting Agent",
      delegate.meetingReport,
    );

    const firstJobs = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      `jobs --session ${sessionId}`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      firstJobs.httpStatus === 200 && firstJobs.readyForSlack?.jobs?.length === 1,
      "Slack jobs did not return one ready Meeting Agent job",
      firstJobs,
    );
    assertSmoke(
      firstJobs.text?.includes("Summarize Slack contract matrix"),
      "Slack jobs did not format the worker task",
      firstJobs,
    );

    const secondJobs = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      `jobs --session ${sessionId}`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      secondJobs.httpStatus === 200 && secondJobs.readyForSlack?.jobs?.length === 0,
      "Slack jobs delivered a duplicate worker result",
      secondJobs,
    );

    const stop = await postSignedSlackCommand(
      "http://127.0.0.1:18920/slack/commands/avatar",
      `stop ${sessionId} --reason contract_done`,
      { signingSecret: env.SLACK_SIGNING_SECRET },
    );
    assertSmoke(
      stop.httpStatus === 200 && stop.session?.status === "stopped",
      "Slack stop contract did not mark session stopped",
      stop,
    );
    assertSmoke(
      stop.session?.stoppedReason === "contract_done",
      "Slack stop did not preserve reason",
      stop.session,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          parser: { join: parserJoin, delegate: parserDelegate, stop: parserStop },
          signature: { valid: true, staleRejected: true, mismatchRejected: true },
          service: {
            help,
            badSignature,
            staleSignature,
            botDmEvent,
            jobsAfterBotDm,
            assistantThreadStarted,
            assistantDmEvent,
            assistantStatus,
            richMention,
            richMentionJobs,
            invalidJoin,
            unknown,
            join,
            meetingSessions,
            status,
            missingDelegateTask,
            delegate,
            firstJobs,
            secondJobs,
            stop,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

