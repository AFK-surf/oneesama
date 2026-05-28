import { avatarCommandUsage, parseAvatarCommand, slackTextResponse } from "../../../packages/core/src/control-plane/avatar-command.js";
import { appendShadowTapEvent, normalizeShadowSlackCommand, shadowTapSummary, verifyShadowTapRequest } from "../../../packages/core/src/shadow/shadow-tap.js";
import { verifySlackRequest } from "../../../packages/core/src/slack/slack-signature.js";

type SlackHandlerInput = Record<string, any>;
type SlackPayloadLike = Record<string, any>;

export function createSlackCommandHandlers(ctx: any) {
  const {
    config, sessions, cutover, runner, workspaceContext, localSlackMemory,
    rememberSlackCommand, postJson, getJson, resolveSession, reportFinishedWorkerJob, pollMeetingWorkerResults,
  } = ctx;

function summarizeSession(
  session: { id?: string; status?: string; meetUrl?: string } | null | undefined,
): string {
  if (!session) return "no active session";
  return `${session.id} ${session.status} ${session.meetUrl || "(no meet url)"}`;
}

interface CutoverDecisionLike {
  mode?: string;
  reason?: string;
  bucket?: string | number;
  canaryPercent?: number;
  primaryStack?: string;
  shadowStack?: string;
  shouldRunNewStack?: boolean;
  shouldRecordShadow?: boolean;
  [key: string]: unknown;
}

function buildAutoRollbackDecision({
  originalDecision,
  meetingAgent,
}: {
  originalDecision: CutoverDecisionLike;
  meetingAgent: { status?: number; body?: { error?: string; detail?: string; [key: string]: unknown } };
}) {
  return {
    mode: "rollback",
    primaryStack: "old",
    shadowStack: "",
    shouldRunNewStack: false,
    shouldRecordShadow: true,
    bucket: originalDecision.bucket,
    canaryPercent: originalDecision.canaryPercent,
    reason: "auto_rollback_new_stack_failed",
    triggeredBy: {
      mode: originalDecision.mode,
      reason: originalDecision.reason,
      status: meetingAgent.status,
      error: meetingAgent.body?.error || meetingAgent.body?.detail || "",
    },
  };
}

type ParsedAvatarCommand = import("../../../packages/core/src/control-plane/avatar-command.js").AvatarCommandResult;

function shadowCommandPlan(parsed: ParsedAvatarCommand) {
  const common = {
    action: parsed.action,
    accepted: true,
    sideEffects: "suppressed",
  };
  if (parsed.action === "join") {
    return {
      ...common,
      accepted: parsed.validMeetUrl,
      meetUrl: parsed.meetUrl,
      avatar: parsed.avatar,
      botName: parsed.botName || config.botName,
      dryRunJoiner: parsed.dryRunJoiner,
      startJoiner: parsed.startJoiner,
      wouldStartMeetingAgent: parsed.validMeetUrl,
    };
  }
  if (parsed.action === "delegate") {
    return {
      ...common,
      accepted: Boolean(parsed.task),
      sessionId: parsed.sessionId,
      task: parsed.task,
      mode: parsed.requestedMode,
      allowCodeChanges: parsed.allowCodeChanges,
      wouldStartWorker: Boolean(parsed.task),
    };
  }
  if (parsed.action === "status" || parsed.action === "stop" || parsed.action === "jobs") {
    return {
      ...common,
      sessionId: parsed.sessionId,
    };
  }
  return {
    ...common,
    accepted: parsed.action === "help",
  };
}

interface ShadowCommandCheck {
  name: string;
  pass: boolean;
  [key: string]: unknown;
}

function shadowCommandChecks({
  parsed,
  newStack,
}: {
  parsed: ParsedAvatarCommand;
  newStack: ReturnType<typeof shadowCommandPlan>;
}): ShadowCommandCheck[] {
  const checks: ShadowCommandCheck[] = [
    { name: "side_effects_suppressed", pass: newStack.sideEffects === "suppressed" },
  ];
  const stack = newStack as ReturnType<typeof shadowCommandPlan> & {
    wouldStartMeetingAgent?: boolean;
    wouldStartWorker?: boolean;
  };
  if (parsed.action === "join") {
    checks.push(
      {
        name: "join_meet_url_valid",
        pass: Boolean(parsed.validMeetUrl),
        meetUrl: parsed.meetUrl,
      },
      {
        name: "join_would_start_new_stack_when_cutover_allows",
        pass: stack.wouldStartMeetingAgent === parsed.validMeetUrl,
      },
    );
  } else if (parsed.action === "delegate") {
    checks.push(
      { name: "delegate_task_present", pass: Boolean(parsed.task), task: parsed.task },
      {
        name: "delegate_worker_suppressed",
        pass:
          stack.wouldStartWorker === Boolean(parsed.task) &&
          stack.sideEffects === "suppressed",
      },
    );
  } else {
    checks.push({
      name: "command_parsed",
      pass: Boolean(parsed.action),
      action: parsed.action,
    });
  }
  return checks;
}

async function handleShadowSlackCommand({
  req,
  body,
}: {
  req: import("node:http").IncomingMessage;
  body: SlackPayloadLike & SlackHandlerInput;
}) {
  const auth = verifyShadowTapRequest({ secret: config.shadowTapSecret, req });
  if (!auth.ok) {
    return {
      status: auth.status,
      body: { ok: false, error: auth.error },
    };
  }

  const normalized = normalizeShadowSlackCommand(body);
  const parsed = parseAvatarCommand(normalized.text);
  const summary = shadowTapSummary(body);
  const cutoverDecision = cutover.decide({
    command: `shadow_tap:${parsed.action}`,
    workspaceId: normalized.team_id,
    channelId: normalized.channel_id,
    userId: normalized.user_id,
    sessionId: String(
      (body.oldStack as { sessionId?: string; meetingId?: string } | null | undefined)?.sessionId ||
        (body.oldStack as { sessionId?: string; meetingId?: string } | null | undefined)
          ?.meetingId ||
        body.eventId ||
        body.event_id ||
        "",
    ),
  });
  const newStack = shadowCommandPlan(parsed);
  const checks = shadowCommandChecks({ parsed, newStack });
  const ok = checks.every((check) => check.pass);
  const event = await appendShadowTapEvent(config.shadowTapReportPath || config.cutoverReportPath, {
    type: "shadow_slack_command",
    ok,
    summary,
    normalized,
    parsed: {
      action: parsed.action,
      meetUrl: parsed.meetUrl,
      validMeetUrl: parsed.validMeetUrl,
      sessionId: parsed.sessionId,
      avatar: parsed.avatar,
      botName: parsed.botName,
      task: parsed.task,
    },
    cutoverDecision,
    oldStack: body.oldStack || null,
    newStack,
    checks,
  });
  return {
    body: {
      ok,
      mode: "shadow_tap_receiver",
      sideEffects: "suppressed",
      event,
    },
  };
}

interface SlackAvatarCommandBody extends SlackHandlerInput {
  text?: string;
  raw?: string;
  user_id?: string;
  user?: string;
  channel_id?: string;
  channel?: string;
  team_id?: string;
  team?: string;
  command?: string;
  trigger_id?: string;
  response_url?: string;
}

interface SlackVerificationResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  source?: string;
  error?: string;
}

async function handleAvatarCommand({
  req,
  body,
  rawBody,
}: {
  req: import("node:http").IncomingMessage;
  body: SlackAvatarCommandBody;
  rawBody: string;
}) {
  const timestampRaw = req.headers["x-slack-request-timestamp"];
  const signatureRaw = req.headers["x-slack-signature"];
  const verification = verifySlackRequest({
    signingSecret: config.slackSigningSecret,
    timestamp: Array.isArray(timestampRaw) ? timestampRaw[0] || "" : timestampRaw || "",
    signature: Array.isArray(signatureRaw) ? signatureRaw[0] || "" : signatureRaw || "",
    rawBody,
  }) as SlackVerificationResult;
  if (!verification.ok) {
    return {
      status: 401,
      body: slackTextResponse(`Slack request verification failed: ${verification.error}`, {
        ok: false,
      }),
    };
  }

  return executeAvatarCommand({ body, verification });
}

async function executeAvatarCommand({
  body,
  verification = { ok: true, skipped: true, source: "internal" },
}: {
  body: SlackAvatarCommandBody;
  verification?: SlackVerificationResult;
}) {
  const parsed = parseAvatarCommand(body.text || body.raw || "");
  if (parsed.action === "help") {
    rememberSlackCommand({ body, parsed });
    return slackTextResponse(avatarCommandUsage());
  }

  if (parsed.action === "join") {
    if (!parsed.validMeetUrl) {
      return {
        status: 400,
        body: slackTextResponse(
          `Usage error: expected a Google Meet URL.\n\n${avatarCommandUsage()}`,
          { ok: false },
        ),
      };
    }
    const session = sessions.create({
      source: "slack",
      meetUrl: parsed.meetUrl,
      avatar: parsed.avatar,
      requestedBy: body.user_id || body.user || "unknown",
    });
    const { slackContext, domainContext } = rememberSlackCommand({ body, parsed, session });
    const cutoverDecision = cutover.decide({
      command: "join",
      workspaceId: body.team_id || "",
      channelId: body.channel_id || "",
      userId: body.user_id || body.user || "",
      sessionId: session.id,
    });

    if (!cutoverDecision.shouldRunNewStack) {
      const status =
        cutoverDecision.mode === "rollback"
          ? "rollback_old_stack_primary"
          : "shadow_old_stack_primary";
      sessions.update(session.id, { status, cutoverDecision });
      const report = await cutover.record({
        type: "join_shadow_decision",
        session: sessions.get(session.id),
        decision: cutoverDecision,
        oldStack: { primary: true, invokedByOpenSourceRepo: false },
        newStack: { shadow: cutoverDecision.shadowStack === "new", sideEffects: "suppressed" },
      });
      const decisionKind = cutoverDecision.mode === "rollback" ? "rollback" : "shadow";
      return slackTextResponse(
        `Cutover ${cutoverDecision.mode}: old stack remains primary for ${session.meetUrl}; new repo recorded a ${decisionKind} decision only.`,
        {
          extra: {
            session: sessions.get(session.id),
            slackContext,
            domainContext,
            cutoverDecision,
            cutoverReport: report,
            slackVerification: verification,
          },
        },
      );
    }

    const meetingAgent = await postJson(`${config.meetingAgentUrl}/sessions`, {
      source: "slack-agent",
      sessionId: session.id,
      meetUrl: session.meetUrl,
      avatar: session.avatar,
      requestedBy: session.requestedBy,
      botName: parsed.botName || config.botName,
      startJoiner: parsed.startJoiner,
      dryRunJoiner: parsed.dryRunJoiner,
    });
    if (!meetingAgent.ok && config.cutoverAutoRollbackOnFailure) {
      const rollbackDecision = buildAutoRollbackDecision({
        originalDecision: cutoverDecision,
        meetingAgent,
      });
      sessions.update(session.id, {
        status: "auto_rollback_old_stack_primary",
        meetingAgentStatus: meetingAgent.status,
        cutoverDecision,
        rollbackDecision,
      });
      const report = await cutover.record({
        type: "join_auto_rollback_decision",
        session: sessions.get(session.id),
        decision: rollbackDecision,
        originalDecision: cutoverDecision,
        oldStack: { primary: true, invokedByOpenSourceRepo: false },
        newStack: {
          primary: false,
          ok: false,
          status: meetingAgent.status,
          error: meetingAgent.body?.error || "meeting_agent_failed",
        },
      });
      return slackTextResponse(
        `Auto rollback: new stack failed for ${session.meetUrl}; old stack remains primary and the rollback decision was recorded.`,
        {
          extra: {
            session: sessions.get(session.id),
            slackContext,
            domainContext,
            meetingAgent: meetingAgent.body,
            cutoverDecision,
            rollbackDecision,
            cutoverReport: report,
            slackVerification: verification,
          },
        },
      );
    }
    sessions.update(session.id, {
      status: meetingAgent.ok ? "meeting_agent_started" : "meeting_agent_failed",
      meetingAgentStatus: meetingAgent.status,
      cutoverDecision,
    });
    const report = await cutover.record({
      type: "join_primary_decision",
      session: sessions.get(session.id),
      decision: cutoverDecision,
      newStack: { primary: true, ok: meetingAgent.ok, status: meetingAgent.status },
    });
    return slackTextResponse(
      `Session ${session.id} created for ${session.meetUrl} (${parsed.dryRunJoiner ? "dry-run joiner" : "real joiner"}).`,
      {
        extra: {
          session: sessions.get(session.id),
          slackContext,
          domainContext,
          meetingAgent: meetingAgent.body,
          cutoverDecision,
          cutoverReport: report,
          slackVerification: verification,
        },
      },
    );
  }

  if (parsed.action === "status") {
    const session = resolveSession(parsed);
    const { slackContext, domainContext } = rememberSlackCommand({ body, parsed, session });
    const joinStatus = await getJson(`${config.meetingAgentUrl}/join/status`);
    return slackTextResponse(
      `Status: ${summarizeSession(session)}\nWorker jobs: ${runner.listJobs().length}`,
      {
        extra: {
          session,
          slackContext,
          domainContext,
          sessions: sessions.list(),
          joinStatus: joinStatus.body,
          jobs: runner.listJobs(),
          slackVerification: verification,
        },
      },
    );
  }

  if (parsed.action === "stop") {
    const session = resolveSession(parsed);
    const { slackContext, domainContext } = rememberSlackCommand({ body, parsed, session });
    const flags = (parsed.flags as { reason?: string } | undefined) || {};
    const reason = flags.reason || `slack_stop:${body.user_id || body.user || "unknown"}`;
    const stopResult = await postJson(`${config.meetingAgentUrl}/join/stop`, { reason });
    if (session) sessions.update(session.id, { status: "stopped", stoppedReason: reason });
    return slackTextResponse(`Stop requested for ${session?.id || "current meeting joiner"}.`, {
      extra: {
        session: session ? sessions.get(session.id) : null,
        slackContext,
        domainContext,
        stopResult: stopResult.body,
        slackVerification: verification,
      },
    });
  }

  if (parsed.action === "delegate") {
    if (!parsed.task) {
      return {
        status: 400,
        body: slackTextResponse(`Usage error: missing task.\n\n${avatarCommandUsage()}`, {
          ok: false,
        }),
      };
    }
    const session = resolveSession(parsed);
    const { slackContext, domainContext } = rememberSlackCommand({ body, parsed, session });
    const richThreadContext = (body.richThreadContext as { mentionText?: string } | null) || null;
    const memoryQuery = richThreadContext?.mentionText || parsed.task;
    const job = await runner.startTask({
      task: parsed.task,
      context: {
        ...workspaceContext.buildAgentContext({
          body,
          parsed: parsed as unknown as Record<string, unknown>,
          session,
          remembered: slackContext,
        }),
        slackAppMention: richThreadContext,
        localSlackMemory: localSlackMemory.buildAgentContext({
          query: [memoryQuery, slackContext?.channelName, body.user_name].filter(Boolean).join(" "),
          limit: 5,
        }),
      },
      mode: parsed.requestedMode,
      allowCodeChanges: parsed.allowCodeChanges,
    });
    const report = await reportFinishedWorkerJob(job);
    if (session)
      sessions.update(session.id, { status: "worker_delegated", lastWorkerJobId: job.id });
    return slackTextResponse(`Delegated to ${job.provider}: ${job.id} (${job.status}).`, {
      extra: {
        session: session ? sessions.get(session.id) : null,
        slackContext,
        domainContext,
        richThreadContext,
        job,
        meetingReport: report?.body || null,
        slackVerification: verification,
      },
    });
  }

  if (parsed.action === "jobs") {
    const session = resolveSession(parsed);
    const { slackContext, domainContext } = rememberSlackCommand({ body, parsed, session });
    const meetingJobs = await getJson(`${config.meetingAgentUrl}/worker/jobs`);
    const readyForSlack = await pollMeetingWorkerResults({ limit: 10, markDelivered: true });
    return slackTextResponse(
      [
        `Worker jobs: local=${runner.listJobs().length}, meeting=${meetingJobs.body?.jobs?.length || 0}`,
        readyForSlack.messages.length ? readyForSlack.text : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      {
        extra: {
          slackContext,
          domainContext,
          jobs: runner.listJobs(),
          meetingJobs: meetingJobs.body,
          readyForSlack,
          slackVerification: verification,
        },
      },
    );
  }

  return {
    status: 400,
    body: slackTextResponse(`Unknown command: ${parsed.action}\n\n${avatarCommandUsage()}`, {
      ok: false,
    }),
  };
}

  return { executeAvatarCommand, handleAvatarCommand, handleShadowSlackCommand, summarizeSession };
}
