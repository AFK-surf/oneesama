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

export async function slackResultSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-result-"));
  const env = {
    MAB_SLACK_PORT: "18895",
    MAB_MEETING_PORT: "18896",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18896",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    SLACK_SIGNING_SECRET: "slack-result-signing-secret",
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const slack = startService("apps/slack-agent/src/index.js", env);

  try {
    await waitForHealth("http://127.0.0.1:18896/healthz");
    await waitForHealth("http://127.0.0.1:18895/healthz");
    const reported = await postJson("http://127.0.0.1:18896/worker/report", {
      id: "job_slack_result_smoke",
      status: "completed",
      task: "summarize the worker result loop",
      result: "Slack result smoke delivered this worker result exactly once.",
    });
    assertSmoke(reported.ok === true, "Slack result smoke could not report a worker job", reported);

    const firstPoll = await postJson("http://127.0.0.1:18895/jobs/poll-meeting", {
      limit: 5,
      markDelivered: true,
    });
    assertSmoke(firstPoll.ok === true, "Slack result smoke poll route failed", firstPoll);
    assertSmoke(
      firstPoll.jobs?.length === 1,
      "Slack result smoke did not return exactly one job",
      firstPoll,
    );
    assertSmoke(
      firstPoll.messages?.[0]?.includes(
        "Slack result smoke delivered this worker result exactly once.",
      ),
      "Slack result smoke did not format the worker result for Slack",
      firstPoll,
    );

    const workerJobs = await (await fetch("http://127.0.0.1:18896/worker/jobs")).json();
    const deliveredJob = workerJobs.jobs.find((job) => job.id === "job_slack_result_smoke");
    assertSmoke(
      deliveredJob?.deliveredToSlack === true,
      "worker job was not marked delivered to Slack",
      workerJobs,
    );

    const secondPoll = await postJson("http://127.0.0.1:18895/jobs/poll-meeting", {
      limit: 5,
      markDelivered: true,
    });
    assertSmoke(secondPoll.ok === true, "Slack result smoke second poll failed", secondPoll);
    assertSmoke(
      secondPoll.jobs?.length === 0,
      "Slack result smoke delivered a duplicate job",
      secondPoll,
    );

    console.log(JSON.stringify({ ok: true, reported, firstPoll, workerJobs, secondPoll }, null, 2));
  } finally {
    for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function slackPostingSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-slack-posting-"));
  const env = {
    MAB_SLACK_PORT: "18897",
    MAB_MEETING_PORT: "18898",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18898",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    MAB_SLACK_POSTER_MOCK: "1",
    SLACK_SIGNING_SECRET: "slack-posting-signing-secret",
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const slack = startService("apps/slack-agent/src/index.js", env);

  try {
    await waitForHealth("http://127.0.0.1:18898/healthz");
    await waitForHealth("http://127.0.0.1:18897/healthz");
    const reported = await postJson("http://127.0.0.1:18898/worker/report", {
      id: "job_slack_posting_smoke",
      status: "completed",
      task: "post this worker result to a Slack thread",
      result: "Slack posting smoke delivered this worker result to a mock thread exactly once.",
    });
    assertSmoke(
      reported.ok === true,
      "Slack posting smoke could not report a worker job",
      reported,
    );

    const firstPoll = await postJson("http://127.0.0.1:18897/jobs/poll-meeting", {
      limit: 5,
      channel: "C_SMOKE",
      threadTs: "1710000000.000000",
      markDelivered: true,
      postToSlack: true,
    });
    assertSmoke(firstPoll.ok === true, "Slack posting smoke poll route failed", firstPoll);
    assertSmoke(
      firstPoll.jobs?.length === 1,
      "Slack posting smoke did not return exactly one job",
      firstPoll,
    );
    assertSmoke(
      firstPoll.posts?.length === 1,
      "Slack posting smoke did not create exactly one Slack post",
      firstPoll,
    );
    assertSmoke(
      firstPoll.posts?.[0]?.post?.mock === true,
      "Slack posting smoke did not use the mock poster",
      firstPoll.posts?.[0],
    );
    assertSmoke(
      firstPoll.posts?.[0]?.post?.channel === "C_SMOKE",
      "Slack posting smoke did not preserve channel",
      firstPoll.posts?.[0],
    );
    assertSmoke(
      firstPoll.posts?.[0]?.post?.threadTs === "1710000000.000000",
      "Slack posting smoke did not preserve thread ts",
      firstPoll.posts?.[0],
    );
    assertSmoke(
      firstPoll.posts?.[0]?.post?.dedupKey?.includes("job_slack_posting_smoke"),
      "Slack posting smoke did not assign a worker dedup key",
      firstPoll.posts?.[0],
    );

    const workerJobs = await (await fetch("http://127.0.0.1:18898/worker/jobs")).json();
    const deliveredJob = workerJobs.jobs.find((job) => job.id === "job_slack_posting_smoke");
    assertSmoke(
      deliveredJob?.deliveredToSlack === true,
      "worker job was not marked delivered to Slack",
      workerJobs,
    );
    assertSmoke(
      deliveredJob?.slackDelivery?.channel === "C_SMOKE",
      "worker job did not record Slack delivery channel",
      deliveredJob,
    );
    assertSmoke(
      deliveredJob?.slackDelivery?.threadTs === "1710000000.000000",
      "worker job did not record Slack delivery thread",
      deliveredJob,
    );
    assertSmoke(
      deliveredJob?.slackDelivery?.mock === true,
      "worker job did not record mock delivery mode",
      deliveredJob,
    );

    const secondPoll = await postJson("http://127.0.0.1:18897/jobs/poll-meeting", {
      limit: 5,
      channel: "C_SMOKE",
      threadTs: "1710000000.000000",
      markDelivered: true,
      postToSlack: true,
    });
    assertSmoke(secondPoll.ok === true, "Slack posting smoke second poll failed", secondPoll);
    assertSmoke(
      secondPoll.jobs?.length === 0,
      "Slack posting smoke delivered a duplicate job",
      secondPoll,
    );
    assertSmoke(
      secondPoll.posts?.length === 0,
      "Slack posting smoke posted a duplicate Slack message",
      secondPoll,
    );

    console.log(JSON.stringify({ ok: true, reported, firstPoll, workerJobs, secondPoll }, null, 2));
  } finally {
    for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function cutoverShadowSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-cutover-"));
  const reportPath = pathJoin(dataDir, "cutover-report.jsonl");

  async function runScenario({
    name,
    slackPort,
    meetingPort,
    mode,
    canaryPercent = "0",
    shouldStartMeeting,
    expectedStatus,
  }) {
    const env = {
      MAB_SLACK_PORT: String(slackPort),
      MAB_MEETING_PORT: String(meetingPort),
      MAB_MEETING_AGENT_URL: `http://127.0.0.1:${meetingPort}`,
      MAB_DRY_RUN_AGENT: "1",
      MAB_BROWSER_HEADLESS: "true",
      MAB_DATA_DIR: pathJoin(dataDir, name),
      MAB_CUTOVER_MODE: mode,
      MAB_CUTOVER_CANARY_PERCENT: String(canaryPercent),
      MAB_CUTOVER_REPORT_PATH: reportPath,
      SLACK_SIGNING_SECRET: `cutover-${name}-signing-secret`,
    };
    const meeting = startService("apps/meeting-agent/src/index.js", env);
    const slack = startService("apps/slack-agent/src/index.js", env);

    try {
      await waitForHealth(`http://127.0.0.1:${meetingPort}/healthz`);
      await waitForHealth(`http://127.0.0.1:${slackPort}/healthz`);
      const join = await postSignedSlackCommand(
        `http://127.0.0.1:${slackPort}/slack/commands/avatar`,
        "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name CutoverBot",
        { signingSecret: env.SLACK_SIGNING_SECRET, userId: `U_${name.toUpperCase()}` },
      );
      assertSmoke(join.ok === true, `${name} cutover join command failed`, join);
      assertSmoke(
        join.cutoverDecision?.mode === mode,
        `${name} did not use expected cutover mode`,
        join.cutoverDecision,
      );
      assertSmoke(
        join.session?.status === expectedStatus,
        `${name} session status mismatch`,
        join.session,
      );

      const meetingSessions = await (
        await fetch(`http://127.0.0.1:${meetingPort}/sessions`)
      ).json();
      assertSmoke(
        shouldStartMeeting
          ? meetingSessions.sessions.length === 1
          : meetingSessions.sessions.length === 0,
        `${name} meeting side effect mismatch`,
        meetingSessions,
      );

      const report = await (await fetch(`http://127.0.0.1:${slackPort}/cutover/report`)).json();
      assertSmoke(
        report.events.length >= 1,
        `${name} cutover report did not record an event`,
        report,
      );
      return { join, meetingSessions, report };
    } finally {
      for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    }
  }

  try {
    const shadow = await runScenario({
      name: "shadow",
      slackPort: 18901,
      meetingPort: 18902,
      mode: "shadow",
      shouldStartMeeting: false,
      expectedStatus: "shadow_old_stack_primary",
    });
    const rollback = await runScenario({
      name: "rollback",
      slackPort: 18903,
      meetingPort: 18904,
      mode: "rollback",
      shouldStartMeeting: false,
      expectedStatus: "rollback_old_stack_primary",
    });
    const canary = await runScenario({
      name: "canary",
      slackPort: 18905,
      meetingPort: 18906,
      mode: "canary",
      canaryPercent: "100",
      shouldStartMeeting: true,
      expectedStatus: "meeting_agent_started",
    });
    console.log(JSON.stringify({ ok: true, reportPath, shadow, rollback, canary }, null, 2));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function cutoverRollbackSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-rollback-"));
  const reportPath = pathJoin(dataDir, "cutover-report.jsonl");
  const slackPort = 18939;
  const missingMeetingPort = 18938;
  const signingSecret = "cutover-rollback-signing-secret";
  const env = {
    MAB_SLACK_PORT: String(slackPort),
    MAB_MEETING_PORT: String(missingMeetingPort),
    MAB_MEETING_AGENT_URL: `http://127.0.0.1:${missingMeetingPort}`,
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: dataDir,
    MAB_CUTOVER_MODE: "new",
    MAB_CUTOVER_AUTO_ROLLBACK_ON_FAILURE: "1",
    MAB_CUTOVER_REPORT_PATH: reportPath,
    SLACK_SIGNING_SECRET: signingSecret,
  };
  const slack = startService("apps/slack-agent/src/index.js", env);

  try {
    await waitForServiceHealth(slack, `http://127.0.0.1:${slackPort}/healthz`);
    const join = await postSignedSlackCommand(
      `http://127.0.0.1:${slackPort}/slack/commands/avatar`,
      "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name RollbackBot --dry-run false",
      { signingSecret, userId: "U_ROLLBACK" },
    );
    assertSmoke(
      join.httpStatus === 200 && join.ok === true,
      "rollback smoke join command failed",
      join,
    );
    assertSmoke(
      join.session?.status === "auto_rollback_old_stack_primary",
      "rollback smoke did not mark the session as old-stack-primary",
      join.session,
    );
    assertSmoke(
      join.session?.meetingAgentStatus === 0,
      "rollback smoke did not capture missing Meeting Agent failure",
      join.session,
    );
    assertSmoke(
      join.cutoverDecision?.mode === "new",
      "rollback smoke did not start from new-stack mode",
      join.cutoverDecision,
    );
    assertSmoke(
      join.rollbackDecision?.mode === "rollback",
      "rollback smoke did not emit rollback decision",
      join.rollbackDecision,
    );
    assertSmoke(
      join.rollbackDecision?.reason === "auto_rollback_new_stack_failed",
      "rollback smoke recorded the wrong rollback reason",
      join.rollbackDecision,
    );

    const sessions = await (await fetch(`http://127.0.0.1:${slackPort}/sessions`)).json();
    const storedSession = sessions.sessions.find((session) => session.id === join.session.id);
    assertSmoke(
      storedSession?.status === "auto_rollback_old_stack_primary",
      "rollback smoke session store did not persist rollback status",
      sessions,
    );

    const report = await (await fetch(`http://127.0.0.1:${slackPort}/cutover/report`)).json();
    const autoRollbackEvent = report.events.find(
      (event) => event.type === "join_auto_rollback_decision",
    );
    assertSmoke(
      report.autoRollbackOnFailure === true,
      "rollback smoke report did not expose auto-rollback setting",
      report,
    );
    assertSmoke(
      Boolean(autoRollbackEvent),
      "rollback smoke did not write auto rollback event",
      report,
    );
    assertSmoke(
      autoRollbackEvent?.decision?.mode === "rollback",
      "rollback smoke event did not record rollback decision",
      autoRollbackEvent,
    );
    assertSmoke(
      autoRollbackEvent?.originalDecision?.mode === "new",
      "rollback smoke event did not preserve original new-stack decision",
      autoRollbackEvent,
    );
    assertSmoke(
      autoRollbackEvent?.newStack?.ok === false && autoRollbackEvent?.oldStack?.primary === true,
      "rollback smoke event did not capture failover shape",
      autoRollbackEvent,
    );

    console.log(JSON.stringify({ ok: true, reportPath, join, sessions, report }, null, 2));
  } finally {
    slack.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function shadowParitySmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-shadow-parity-"));
  const signingSecret = "shadow-parity-signing-secret";
  const oldStack = await startOldStackFixture({ port: 18907 });
  const env = {
    MAB_SLACK_PORT: "18908",
    MAB_MEETING_PORT: "18909",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18909",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: pathJoin(dataDir, "new-stack"),
    SLACK_SIGNING_SECRET: signingSecret,
  };
  const meeting = startService("apps/meeting-agent/src/index.js", env);
  const slack = startService("apps/slack-agent/src/index.js", env);
  const commands = [];

  function addCheck(checks, name, pass, details = {}) {
    checks.push({ name, pass: Boolean(pass), ...details });
  }

  function recordCommand(action, oldResult, newResult, checks) {
    const ok = checks.every((check) => check.pass);
    const entry = { action, ok, old: oldResult, new: newResult, checks };
    commands.push(entry);
    assertSmoke(ok, `shadow parity ${action} mismatch`, entry);
    return entry;
  }

  try {
    await waitForHealth("http://127.0.0.1:18907/healthz");
    await waitForHealth("http://127.0.0.1:18909/healthz");
    await waitForHealth("http://127.0.0.1:18908/healthz");

    const joinCommand =
      "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name ParityBot";
    const oldJoin = await postSignedSlackCommand(
      "http://127.0.0.1:18907/slack/commands/avatar",
      joinCommand,
      { signingSecret },
    );
    const newJoin = await postSignedSlackCommand(
      "http://127.0.0.1:18908/slack/commands/avatar",
      joinCommand,
      { signingSecret },
    );
    const joinChecks = [];
    addCheck(joinChecks, "both_accept_join", oldJoin.ok === true && newJoin.ok === true, {
      oldOk: oldJoin.ok,
      newOk: newJoin.ok,
    });
    addCheck(
      joinChecks,
      "meet_url_matches",
      oldJoin.session?.meetUrl === newJoin.session?.meetUrl,
      { oldMeetUrl: oldJoin.session?.meetUrl, newMeetUrl: newJoin.session?.meetUrl },
    );
    addCheck(joinChecks, "avatar_matches", oldJoin.session?.avatar === newJoin.session?.avatar, {
      oldAvatar: oldJoin.session?.avatar,
      newAvatar: newJoin.session?.avatar,
    });
    addCheck(
      joinChecks,
      "new_stack_started_meeting_agent",
      newJoin.session?.status === "meeting_agent_started",
      { newStatus: newJoin.session?.status },
    );
    addCheck(
      joinChecks,
      "old_fixture_started_primary",
      oldJoin.session?.status === "meeting_agent_started",
      { oldStatus: oldJoin.session?.status },
    );
    recordCommand("join", summarizeParityJoin(oldJoin), summarizeParityJoin(newJoin), joinChecks);

    const oldSessionId = oldJoin.session?.id;
    const newSessionId = newJoin.session?.id;
    const delegateTask = "Summarize the meeting avatar bot shadow parity runner.";
    const oldDelegate = await postSignedSlackCommand(
      "http://127.0.0.1:18907/slack/commands/avatar",
      `delegate --session ${oldSessionId} ${delegateTask}`,
      { signingSecret },
    );
    const newDelegate = await postSignedSlackCommand(
      "http://127.0.0.1:18908/slack/commands/avatar",
      `delegate --session ${newSessionId} ${delegateTask}`,
      { signingSecret },
    );
    const delegateChecks = [];
    addCheck(delegateChecks, "both_delegate", oldDelegate.ok === true && newDelegate.ok === true, {
      oldOk: oldDelegate.ok,
      newOk: newDelegate.ok,
    });
    addCheck(
      delegateChecks,
      "both_completed",
      oldDelegate.job?.status === "completed" && newDelegate.job?.status === "completed",
      { oldStatus: oldDelegate.job?.status, newStatus: newDelegate.job?.status },
    );
    addCheck(delegateChecks, "task_matches", oldDelegate.job?.task === newDelegate.job?.task, {
      oldTask: oldDelegate.job?.task,
      newTask: newDelegate.job?.task,
    });
    addCheck(
      delegateChecks,
      "result_matches",
      oldDelegate.job?.result === newDelegate.job?.result,
      { oldResult: oldDelegate.job?.result, newResult: newDelegate.job?.result },
    );
    recordCommand(
      "delegate",
      summarizeParityJob(oldDelegate.job),
      summarizeParityJob(newDelegate.job),
      delegateChecks,
    );

    const oldJobs = await postSignedSlackCommand(
      "http://127.0.0.1:18907/slack/commands/avatar",
      `jobs --session ${oldSessionId}`,
      { signingSecret },
    );
    const newJobs = await postSignedSlackCommand(
      "http://127.0.0.1:18908/slack/commands/avatar",
      `jobs --session ${newSessionId}`,
      { signingSecret },
    );
    const jobChecks = [];
    addCheck(jobChecks, "both_list_jobs", oldJobs.ok === true && newJobs.ok === true, {
      oldOk: oldJobs.ok,
      newOk: newJobs.ok,
    });
    addCheck(
      jobChecks,
      "both_include_worker_result",
      oldJobs.text?.includes(delegateTask) && newJobs.text?.includes(delegateTask),
      { oldText: oldJobs.text, newText: newJobs.text },
    );
    addCheck(
      jobChecks,
      "new_meeting_result_ready_for_slack",
      newJobs.readyForSlack?.jobs?.length === 1,
      { readyForSlackCount: newJobs.readyForSlack?.jobs?.length || 0 },
    );
    recordCommand(
      "jobs",
      { text: oldJobs.text, jobs: oldJobs.jobs?.length || 0 },
      { text: newJobs.text, jobs: newJobs.jobs?.length || 0 },
      jobChecks,
    );

    const oldStop = await postSignedSlackCommand(
      "http://127.0.0.1:18907/slack/commands/avatar",
      `stop ${oldSessionId} --reason parity_done`,
      { signingSecret },
    );
    const newStop = await postSignedSlackCommand(
      "http://127.0.0.1:18908/slack/commands/avatar",
      `stop ${newSessionId} --reason parity_done`,
      { signingSecret },
    );
    const stopChecks = [];
    addCheck(stopChecks, "both_stop", oldStop.ok === true && newStop.ok === true, {
      oldOk: oldStop.ok,
      newOk: newStop.ok,
    });
    addCheck(
      stopChecks,
      "both_mark_stopped",
      oldStop.session?.status === "stopped" && newStop.session?.status === "stopped",
      { oldStatus: oldStop.session?.status, newStatus: newStop.session?.status },
    );
    recordCommand("stop", summarizeParityJoin(oldStop), summarizeParityJoin(newStop), stopChecks);

    const meetingSessions = await (await fetch("http://127.0.0.1:18909/sessions")).json();
    const oldSessions = await (await fetch("http://127.0.0.1:18907/sessions")).json();
    const report = {
      ok: true,
      mode: "fixture_shadow_parity",
      summary: {
        commandCount: commands.length,
        passed: commands.filter((entry) => entry.ok).length,
        failed: commands.filter((entry) => !entry.ok).length,
      },
      oldStack: {
        kind: "fixture",
        sessions: oldSessions.sessions?.length || 0,
      },
      newStack: {
        kind: "local",
        meetingSessions: meetingSessions.sessions?.length || 0,
      },
      commands,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    for (const service of [slack, meeting]) service.child.kill("SIGTERM");
    await oldStack.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function shadowTapSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-shadow-tap-"));
  const reportPath = pathJoin(dataDir, "shadow-tap-report.jsonl");
  const secret = "shadow-tap-smoke-secret";
  const env = {
    MAB_SLACK_PORT: "18910",
    MAB_MEETING_PORT: "18911",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18911",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: pathJoin(dataDir, "new-stack"),
    MAB_CUTOVER_MODE: "shadow",
    MAB_SHADOW_TAP_SECRET: secret,
    MAB_SHADOW_TAP_REPORT_PATH: reportPath,
    SLACK_SIGNING_SECRET: "shadow-tap-slack-signing-secret",
  };
  const slack = startService("apps/slack-agent/src/index.js", env);

  async function postShadow(body, providedSecret = secret) {
    const response = await fetch("http://127.0.0.1:18910/shadow/slack-command", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mab-shadow-tap-secret": providedSecret,
      },
      body: JSON.stringify(body),
    });
    return { httpStatus: response.status, body: await response.json() };
  }

  try {
    await waitForHealth("http://127.0.0.1:18910/healthz");

    const invalidSecret = await postShadow({ text: "status" }, "wrong-secret");
    assertSmoke(
      invalidSecret.httpStatus === 401 && invalidSecret.body?.ok === false,
      "shadow tap accepted an invalid secret",
      invalidSecret,
    );

    const mirrored = [
      {
        name: "join",
        text: "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name ShadowTapBot",
        oldStack: {
          source: "legacy-slack-agentd",
          sessionId: "meet_old_0001",
          status: "meeting_agent_started",
        },
      },
      {
        name: "delegate",
        text: "delegate --session meet_old_0001 Summarize the shadow tap smoke.",
        oldStack: {
          source: "legacy-slack-agentd",
          sessionId: "meet_old_0001",
          jobId: "job_old_0001",
          status: "completed",
        },
      },
      {
        name: "jobs",
        text: "jobs --session meet_old_0001",
        oldStack: { source: "legacy-slack-agentd", sessionId: "meet_old_0001", jobs: 1 },
      },
      {
        name: "stop",
        text: "stop meet_old_0001 --reason shadow_tap_done",
        oldStack: { source: "legacy-slack-agentd", sessionId: "meet_old_0001", status: "stopped" },
      },
    ];

    const results = [];
    for (const commandBody of mirrored) {
      const result = await postShadow({
        source: "legacy-slack-agentd",
        eventId: `evt_shadow_${commandBody.name}`,
        team_id: "T_SHADOW",
        channel_id: "C_SHADOW",
        user_id: "U_SHADOW",
        text: commandBody.text,
        oldStack: commandBody.oldStack,
      });
      assertSmoke(
        result.httpStatus === 200 && result.body?.ok === true,
        `shadow tap ${commandBody.name} failed`,
        result,
      );
      assertSmoke(
        result.body?.sideEffects === "suppressed",
        `shadow tap ${commandBody.name} had side effects`,
        result,
      );
      assertSmoke(
        result.body?.event?.parsed?.action === commandBody.name,
        `shadow tap ${commandBody.name} parsed the wrong action`,
        result,
      );
      results.push({ name: commandBody.name, result: result.body });
    }

    const sessions = await (await fetch("http://127.0.0.1:18910/sessions")).json();
    assertSmoke(sessions.sessions.length === 0, "shadow tap created Slack sessions", sessions);

    const report = await (await fetch("http://127.0.0.1:18910/shadow/report")).json();
    assertSmoke(
      report.events.length === mirrored.length,
      "shadow tap report did not record all mirrored commands",
      report,
    );
    assertSmoke(
      report.events.every(
        (event) => event.sideEffects !== "started" && event.newStack?.sideEffects === "suppressed",
      ),
      "shadow tap report includes an unsafe side effect",
      report,
    );

    console.log(
      JSON.stringify({ ok: true, reportPath, invalidSecret, results, sessions, report }, null, 2),
    );
  } finally {
    slack.child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function shadowTransmitterSmoke() {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), "meeting-avatar-bot-shadow-transmitter-"));
  const reportPath = pathJoin(dataDir, "shadow-transmitter-report.jsonl");
  const secret = "shadow-transmitter-smoke-secret";
  const endpoint = "http://127.0.0.1:18912/shadow/slack-command";
  const env = {
    MAB_SLACK_PORT: "18912",
    MAB_MEETING_PORT: "18913",
    MAB_MEETING_AGENT_URL: "http://127.0.0.1:18913",
    MAB_DRY_RUN_AGENT: "1",
    MAB_BROWSER_HEADLESS: "true",
    MAB_DATA_DIR: pathJoin(dataDir, "new-stack"),
    MAB_CUTOVER_MODE: "shadow",
    MAB_SHADOW_TAP_SECRET: secret,
    MAB_SHADOW_TAP_REPORT_PATH: reportPath,
    SLACK_SIGNING_SECRET: "shadow-transmitter-slack-signing-secret",
  };
  const slack = startService("apps/slack-agent/src/index.js", env);

  try {
    await waitForHealth("http://127.0.0.1:18912/healthz");

    function runTransmitterHook(
      input: Record<string, unknown>,
      extraEnv: NodeJS.ProcessEnv = {},
    ): ShadowHookResult {
      const result = spawnSync(process.execPath, ["src/cli.js", "shadow-transmitter-hook"], {
        cwd: process.cwd(),
        encoding: "utf8",
        input: JSON.stringify(input),
        env: {
          ...process.env,
          MAB_SHADOW_TAP_ENABLED: "1",
          MAB_SHADOW_TAP_URL: endpoint,
          MAB_SHADOW_TAP_SECRET: secret,
          MAB_SHADOW_TAP_SOURCE: "legacy-slack-agentd",
          ...extraEnv,
        },
      });
      let body: ShadowHookBody = {};
      try {
        body = JSON.parse(result.stdout || "{}");
      } catch {
        body = { ok: false, error: "invalid_hook_output", raw: result.stdout };
      }
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, body };
    }

    const disabledHook = runTransmitterHook({ text: "status" }, { MAB_SHADOW_TAP_ENABLED: "0" });
    assertSmoke(
      disabledHook.status === 0 && disabledHook.body?.disabled === true,
      "shadow transmitter hook did not stay disabled by default",
      disabledHook,
    );

    const missingConfigHook = runTransmitterHook({ text: "status" }, { MAB_SHADOW_TAP_SECRET: "" });
    assertSmoke(
      missingConfigHook.status !== 0 &&
        missingConfigHook.body?.error === "shadow_tap_not_configured",
      "shadow transmitter hook accepted missing config",
      missingConfigHook,
    );

    const missingSecret = await postShadowTap({
      endpoint,
      secret: "",
      payload: createShadowTapPayload({ text: "status" }),
    });
    assertSmoke(
      missingSecret.ok === false && missingSecret.status === 0,
      "shadow transmitter accepted a missing secret",
      missingSecret,
    );

    const commands = [
      {
        name: "join",
        text: "join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name ShadowTransmitterBot",
        sessionId: "meet_old_transmitter_0001",
        status: "meeting_agent_started",
      },
      {
        name: "delegate",
        text: "delegate --session meet_old_transmitter_0001 Draft a transmitter shadow report.",
        sessionId: "meet_old_transmitter_0001",
        jobId: "job_old_transmitter_0001",
        status: "completed",
      },
      {
        name: "jobs",
        text: "jobs --session meet_old_transmitter_0001",
        sessionId: "meet_old_transmitter_0001",
        status: "jobs_listed",
      },
      {
        name: "stop",
        text: "stop meet_old_transmitter_0001 --reason shadow_transmitter_done",
        sessionId: "meet_old_transmitter_0001",
        status: "stopped",
      },
    ];

    const results = [];
    for (const commandBody of commands) {
      const hook = runTransmitterHook({
        source: "legacy-slack-agentd",
        eventId: `evt_transmitter_${commandBody.name}`,
        team_id: "T_TRANSMITTER",
        team_domain: "transmitter-smoke",
        channel_id: "C_TRANSMITTER",
        channel_name: "meeting-avatar-shadow",
        user_id: "U_TRANSMITTER",
        user_name: "old-stack-user",
        text: commandBody.text,
        token: "must-not-leak",
        response_url: "https://hooks.slack.com/commands/must-not-leak",
        trigger_id: "must-not-leak",
        oldStack: {
          source: "legacy-slack-agentd",
          sessionId: commandBody.sessionId,
          jobId: commandBody.jobId,
          status: commandBody.status,
          commandTs: `1700000000.${commandBody.name.length}`,
          token: "must-not-leak",
        },
      });
      assertSmoke(
        hook.status === 0 && hook.body?.ok === true,
        `shadow transmitter hook ${commandBody.name} failed`,
        hook,
      );
      assertNoPrivateSlackFields(hook.body.payload);
      const post = { status: hook.body.status, body: hook.body.response };
      assertSmoke(
        post.status === 200 && post.body?.ok === true,
        `shadow transmitter ${commandBody.name} post failed`,
        post,
      );
      assertSmoke(
        post.body?.sideEffects === "suppressed",
        `shadow transmitter ${commandBody.name} caused side effects`,
        post,
      );
      assertSmoke(
        post.body?.event?.summary?.source === "legacy-slack-agentd",
        `shadow transmitter ${commandBody.name} lost source`,
        post.body?.event?.summary,
      );
      assertSmoke(
        post.body?.event?.parsed?.action === commandBody.name,
        `shadow transmitter ${commandBody.name} parsed wrong action`,
        post.body?.event?.parsed,
      );
      results.push({ name: commandBody.name, payload: hook.body.payload, post: post.body });
    }

    const sessions = (await (await fetch("http://127.0.0.1:18912/sessions")).json()) as {
      sessions: unknown[];
    };
    assertSmoke(
      sessions.sessions.length === 0,
      "shadow transmitter created Slack sessions",
      sessions,
    );

    const report = (await (await fetch("http://127.0.0.1:18912/shadow/report")).json()) as {
      events: ShadowReportEvent[];
    };
    assertSmoke(
      report.events.length === commands.length,
      "shadow transmitter report did not record all mirrored commands",
      report,
    );
    assertSmoke(
      report.events.every(
        (event) =>
          event.newStack?.sideEffects === "suppressed" &&
          event.summary?.source === "legacy-slack-agentd",
      ),
      "shadow transmitter report includes unsafe side effects or wrong source",
      report,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          reportPath,
          disabledHook: disabledHook.body,
          missingConfigHook: missingConfigHook.body,
          missingSecret,
          results,
          sessions,
          report,
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

