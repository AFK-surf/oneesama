import { slackTextResponse } from "../../../packages/core/src/control-plane/avatar-command.js";
import { verifySlackRequest } from "../../../packages/core/src/slack/slack-signature.js";
import {
  MAX_APP_MENTION_THREAD_MESSAGES,
  buildSlackAppMentionContext,
} from "../../../packages/core/src/slack/app-mention-context.js";
import {
  buildSlackTriageActionBlocks,
  buildSlackTriageActionText,
  buildSlackTriagePrompt,
  parsePendingActionInteraction,
  parseSlackTriageDecision,
  suggestSlackTriageFallback,
} from "../../../packages/core/src/slack/triage-flow.js";
import {
  formatTriageContexts,
  loadTriageContextProjection,
  normalizeTriageContext,
  persistTriageContextProjection,
} from "../../../packages/core/src/slack/triage-context.js";
import { createSlackAssistantMeetingHandlers } from "./events-assistant-meeting.js";

type SlackEventLike = Record<string, any>;
type SlackPayloadLike = Record<string, any>;
type SlackJobLike = Record<string, any>;
type SlackMessageLike = Record<string, any>;

export function createSlackEventHandlers(ctx: any) {
  const {
    config,
    slackDomainStore,
    finalizedTriageJobs,
    triageJobResults,
    localSlackMemory,
    slackWorkspaceDir,
    slackInbound,
    runner,
    poster,
    slackMessageBuffers,
    workspaceContext,
    activeSlackMentionThreads,
    recentSlackMentionEvents,
    executeAvatarCommand,
    callSlackApi,
    startSlackSocketMode,
    shouldKeepAssistantStatusUntilWorkerDone,
    slackImmediateWorkerAckText,
  } = ctx;
  let slackSocketReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function parseSlackInteractionPayload(body: SlackPayloadLike = {}) {
    if (typeof body.payload === "string") {
      try {
        return JSON.parse(body.payload);
      } catch {
        return null;
      }
    }
    return body.payload || body;
  }

  function stripSlackBotMention(text = "") {
    return String(text || "")
      .replace(/<@[^>]+>\s*/g, "")
      .trim();
  }

  function eventTextToAvatarCommand(event: SlackEventLike = {}) {
    const text = stripSlackBotMention(event.text || "");
    if (!text) return "";
    const first = text.split(/\s+/, 1)[0]?.toLowerCase() || "";
    if (["join", "status", "stop", "delegate", "jobs", "help"].includes(first)) return text;
    const meetUrl = text.match(
      /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#]\S*)?/i,
    )?.[0];
    if (meetUrl) return `join ${meetUrl}`;
    return `delegate ${text}`;
  }

  function commandBodyFromSlackEvent(event: SlackEventLike = {}, payload: SlackPayloadLike = {}) {
    return {
      team_id: payload.team_id || payload.team?.id || "",
      team_domain: payload.team?.domain || "",
      channel_id: event.channel || "",
      channel_name: "",
      user_id: event.user || "",
      user_name: "",
      command: event.channel_type === "im" ? "dm" : "app_mention",
      text: eventTextToAvatarCommand(event),
      response_url: "",
      trigger_id: "",
      event_ts: event.ts || event.event_ts || "",
      thread_ts: event.thread_ts || event.ts || "",
    };
  }

  function slackBotUserId() {
    return process.env.MAB_SLACK_BOT_USER_ID || process.env.SLACK_BOT_USER_ID || "";
  }

  interface SlackCommandBodyShape {
    team_id?: string;
    team_domain?: string;
    channel_id?: string;
    channel_name?: string;
    user_id?: string;
    user_name?: string;
    command?: string;
    text?: string;
    response_url?: string;
    trigger_id?: string;
    event_ts?: string;
    thread_ts?: string;
    richThreadContext?: Record<string, unknown> | null;
    [key: string]: unknown;
  }

  function mentionThreadKey(commandBody: SlackCommandBodyShape = {}): string {
    return [
      commandBody.team_id || "workspace",
      commandBody.channel_id || "channel",
      commandBody.thread_ts || commandBody.event_ts || "thread",
    ].join(":");
  }

  function threadMessagesFixture(event: SlackEventLike = {}, payload: SlackPayloadLike = {}) {
    const candidates = [
      payload.thread_messages,
      payload.threadMessages,
      payload.replies,
      payload.thread?.messages,
      payload.thread?.replies,
      event.thread_messages,
      event.threadMessages,
      event.replies,
      event.thread?.messages,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length) return candidate;
    }
    return null;
  }

  async function fetchSlackMentionThreadMessages(
    event: SlackEventLike = {},
    payload: SlackPayloadLike = {},
    commandBody: SlackCommandBodyShape = {},
  ) {
    const fixture = threadMessagesFixture(event, payload) as SlackMessageLike[] | null;
    if (fixture) {
      return {
        ok: true,
        source: "fixture",
        messages: fixture.slice(0, MAX_APP_MENTION_THREAD_MESSAGES),
      };
    }

    const channel = commandBody.channel_id || event.channel || "";
    const threadTs = commandBody.thread_ts || event.thread_ts || event.ts || "";
    if (!channel || !threadTs) {
      return { ok: true, source: "event_only", messages: [event] };
    }
    if (config.slackApiMock || !config.slackBotToken) {
      return {
        ok: true,
        source: config.slackApiMock ? "mock_event_only" : "event_only",
        messages: [event],
      };
    }

    const result = await callSlackApi({
      botToken: config.slackBotToken,
      method: "conversations.replies",
      payload: {
        channel,
        ts: threadTs,
        limit: MAX_APP_MENTION_THREAD_MESSAGES,
      },
    });
    if (!result.ok) {
      return {
        ok: false,
        source: "slack_web_api",
        error: result.error,
        detail: result,
        messages: [event],
      };
    }
    return {
      ok: true,
      source: "slack_web_api",
      messages: ((result.body?.messages as SlackMessageLike[] | undefined) || [event]).slice(
        0,
        MAX_APP_MENTION_THREAD_MESSAGES,
      ),
    };
  }

  function durableMentionContext(commandBody: SlackCommandBodyShape = {}): string {
    if (!slackDomainStore) return "";
    const context = slackDomainStore.context({
      workspaceId: commandBody.team_id || "workspace",
      channelId: commandBody.channel_id || "channel",
      threadTs: commandBody.thread_ts || "channel-root",
      limit: 3,
    }) as {
      threadLedger?: { summary?: string; latestTask?: string; [key: string]: unknown } | null;
      channelBrain?: { summary?: string; last_session_id?: string; [key: string]: unknown } | null;
    };
    const parts: string[] = [];
    if (context.threadLedger?.summary || context.threadLedger?.latestTask) {
      parts.push(`Thread ledger: ${JSON.stringify(context.threadLedger)}`);
    }
    if (context.channelBrain?.summary || context.channelBrain?.last_session_id) {
      parts.push(`Channel brain: ${JSON.stringify(context.channelBrain)}`);
    }
    return parts.join("\n");
  }

  interface SlackThreadContextOptions {
    richThreadContext?: boolean;
    [key: string]: unknown;
  }

  async function commandBodyFromSlackEventWithContext(
    event: SlackEventLike = {},
    payload: SlackPayloadLike = {},
    options: SlackThreadContextOptions = {},
  ): Promise<SlackCommandBodyShape> {
    const commandBody = commandBodyFromSlackEvent(event, payload) as SlackCommandBodyShape;
    if (!options.richThreadContext) return commandBody;

    const thread = (await fetchSlackMentionThreadMessages(event, payload, commandBody)) as {
      ok: boolean;
      source?: string;
      messages: SlackMessageLike[];
      error?: string;
    };
    const richThreadContext = buildSlackAppMentionContext({
      event,
      messages: thread.messages,
      botUserId: slackBotUserId(),
      channelId: commandBody.channel_id,
      threadTs: commandBody.thread_ts,
      userId: commandBody.user_id,
      source: thread.source,
      meetingContext: String(
        payload.meeting_context || payload.meetingContext || event.meeting_context || "",
      ),
      durableContext: durableMentionContext(commandBody),
      threadPermalink: String(
        payload.thread_permalink || payload.threadPermalink || event.thread_permalink || "",
      ),
    }) as Record<string, unknown> & { fetchOk?: boolean; fetchError?: string };
    richThreadContext.fetchOk = thread.ok;
    richThreadContext.fetchError = thread.error || "";
    commandBody.richThreadContext = richThreadContext;

    const currentCommand = commandBody.text || "";
    const rawFirst =
      String((richThreadContext as { rawMentionText?: string }).rawMentionText || "")
        .split(/\s+/, 1)[0]
        ?.toLowerCase() || "";
    const explicitCommand = ["delegate", "join", "status", "stop", "jobs", "help"].includes(
      rawFirst,
    );
    const delegateTask =
      richThreadContext.mentionText ||
      "Respond to this Slack thread using the attached rich context.";
    if (explicitCommand) {
      return commandBody;
    }
    if (!currentCommand || currentCommand.startsWith("delegate ")) {
      commandBody.text = `delegate ${JSON.stringify(delegateTask)}`;
    }
    return commandBody;
  }

  async function runMentionWithThreadGuard(commandBody, run) {
    const key = mentionThreadKey(commandBody);
    if (activeSlackMentionThreads.has(key)) {
      return {
        status: 409,
        body: {
          ok: true,
          ignored: true,
          reason: "active_thread_in_progress",
          threadKey: key,
        },
      };
    }
    activeSlackMentionThreads.add(key);
    try {
      return await run();
    } finally {
      activeSlackMentionThreads.delete(key);
    }
  }

  function slackMentionEventKey(event: SlackEventLike = {}, payload: SlackPayloadLike = {}) {
    const teamId = payload.team_id || payload.team?.id || "workspace";
    const channelId = event.channel || "channel";
    const eventTs = event.ts || event.event_ts || "ts";
    const userId = event.user || "user";
    const text = String(event.text || "").trim();
    return [teamId, channelId, eventTs, userId, text].join(":");
  }

  function pruneRecentSlackMentionEvents(now = Date.now()) {
    const ttlMs = 10 * 60 * 1000;
    for (const [key, seenAt] of recentSlackMentionEvents.entries()) {
      if (now - seenAt > ttlMs) recentSlackMentionEvents.delete(key);
    }
  }

  function claimSlackMentionEvent(event: SlackEventLike = {}, payload: SlackPayloadLike = {}) {
    const now = Date.now();
    pruneRecentSlackMentionEvents(now);
    const key = slackMentionEventKey(event, payload);
    if (recentSlackMentionEvents.has(key)) {
      return { claimed: false, key };
    }
    recentSlackMentionEvents.set(key, now);
    return { claimed: true, key };
  }

  function shouldIgnoreSlackMessageEvent(event: SlackEventLike = {}) {
    if (!event.text) return true;
    const isBotMessage = Boolean(event.bot_id || event.subtype === "bot_message");
    if (event.subtype && !(config.slackEventAllowBotMessages && event.subtype === "bot_message"))
      return true;
    if (event.bot_id && !config.slackEventAllowBotMessages) return true;
    if (!event.user && !(config.slackEventAllowBotMessages && isBotMessage)) return true;
    return false;
  }

  function isBotMentionFallbackMessage(event: SlackEventLike = {}) {
    if (event.bot_id || event.subtype) return false;
    if (event.type !== "message" || event.channel_type === "im") return false;
    const text = String(event.text || "");
    if (!text.includes("<@")) return false;
    const configuredBotUserId =
      process.env.MAB_SLACK_BOT_USER_ID || process.env.SLACK_BOT_USER_ID || "";
    if (!configuredBotUserId) return /<@[^>]+>/.test(text);
    return text.includes(`<@${configuredBotUserId}>`);
  }

  const {
    assistantStatusTextForJob,
    assistantThreadRefFromEvent,
    handleMeetingWebhookPayload,
    postSlackMessage,
    scheduleSlackAssistantThreadStatus,
    setSlackAssistantSuggestedPrompts,
  } = createSlackAssistantMeetingHandlers(ctx);

  function compactSlackMessageEvent(event: SlackEventLike = {}, payload: SlackPayloadLike = {}) {
    return {
      teamId: payload.team_id || payload.team?.id || "",
      channelId: event.channel || "",
      channelType: event.channel_type || "",
      userId: event.user || event.bot_id || "",
      text: String(event.text || "").trim(),
      ts: event.ts || event.event_ts || "",
      threadTs: event.thread_ts || "",
    };
  }

  function renderSlackActivityDigest(channelId, messages = []) {
    const lines = ["=== Slack Activity ===", "", `#${channelId}`];
    for (const msg of messages) {
      const thread = msg.threadTs ? ` thread=${msg.threadTs}` : "";
      lines.push(`- ${msg.ts || new Date().toISOString()} <@${msg.userId}>${thread}: ${msg.text}`);
    }
    return `${lines.join("\n")}\n`;
  }

  function updateBufferChannelStats(channelId, count) {
    slackInbound.eventBuffer.channels[channelId] = {
      pending: count,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  function scheduleSlackSocketReconnect(delayMs = 1500) {
    if (slackSocketReconnectTimer) return;
    slackSocketReconnectTimer = setTimeout(() => {
      slackSocketReconnectTimer = null;
      startSlackSocketMode().catch((error) => {
        slackInbound.socketMode.lastError = String(error?.message || error);
        scheduleSlackSocketReconnect(delayMs);
      });
    }, delayMs);
    slackSocketReconnectTimer.unref?.();
  }

  function isTerminalJob(job) {
    return ["completed", "failed", "timeout"].includes(job?.status);
  }

  function lastMessageThreadTs(messages = []) {
    const latest = messages[messages.length - 1] || {};
    return latest.threadTs || latest.ts || "";
  }

  function triageActionRows(actions = []) {
    return actions.map((action) => ({
      tool: action.type,
      channel: action.channelId,
      brief: action.title,
    }));
  }

  interface SlackTriageActionInput {
    action?: {
      type?: string;
      channelId?: string;
      threadTs?: string;
      title?: string;
      brief?: string;
      workspaceId?: string;
      [key: string]: unknown;
    };
    pendingAction?: { id?: number | string; [key: string]: unknown };
    runId?: number | string;
  }

  async function postSlackTriageActionCard({
    action,
    pendingAction,
    runId,
  }: SlackTriageActionInput = {}) {
    if (!config.slackTriagePostActions || !pendingAction?.id || !action?.channelId) {
      return { ok: false, skipped: true, reason: "triage_action_post_disabled_or_missing_channel" };
    }
    const text = buildSlackTriageActionText({ action, pendingAction });
    const blocks = buildSlackTriageActionBlocks({ action, pendingAction });
    const post = await poster.postMessage({
      channel: action.channelId,
      threadTs: action.threadTs,
      text,
      blocks,
      dedupKey: `slack-triage-action:${runId}:${pendingAction.id}`,
    });
    if (post.ok && slackDomainStore) {
      slackDomainStore.setPendingActionCardTs(pendingAction.id, post.ts || "");
      slackDomainStore.recordThreadLedgerAction({
        workspaceId: action.workspaceId || "workspace",
        channelId: action.channelId,
        threadTs: action.threadTs,
        actionType: action.type,
        actionStatus: "pending",
      });
      slackDomainStore.recordThreadLedgerOutbound({
        workspaceId: action.workspaceId || "workspace",
        channelId: action.channelId,
        threadTs: action.threadTs,
        summary: `Triage suggested ${action.type}: ${action.title}`,
      });
    }
    return post;
  }

  async function finalizeSlackTriageJob(job: SlackJobLike) {
    if (!job?.id) return null;
    if (finalizedTriageJobs.has(job.id)) return triageJobResults.get(job.id) || null;
    finalizedTriageJobs.add(job.id);
    if (!slackDomainStore) return null;

    const context = (job.context || {}) as {
      channelId?: string;
      messages?: unknown[];
      threadTs?: string;
      triageRunId?: number | string;
      sessionId?: string;
      digest?: string;
      [key: string]: unknown;
    };
    const channelId = String(context.channelId || "");
    const messages = (Array.isArray(context.messages) ? context.messages : []) as Array<{
      teamId?: string;
      [key: string]: unknown;
    }>;
    const threadTs = String(context.threadTs || lastMessageThreadTs(messages) || "");
    const fallback = config.slackTriageHeuristicFallback
      ? suggestSlackTriageFallback({
          channelId,
          messages: messages as unknown as Parameters<
            typeof suggestSlackTriageFallback
          >[0]["messages"],
        })
      : { summary: `Slack triage finished for ${channelId}.`, actions: [] };
    const decision = parseSlackTriageDecision(String(job.result || job.error || ""), {
      ...fallback,
      channelId,
      threadTs,
    });
    const ok = job.status === "completed";
    const actions = ok ? decision.actions : [];
    const runId = Number.parseInt(String(context.triageRunId ?? "0"), 10);
    const runPatch = {
      id: runId,
      sessionId: context.sessionId || job.id,
      status: ok ? "success" : "failed",
      summary: ok ? decision.summary : `Triage failed: ${job.error || job.result || job.status}`,
      error: ok ? "" : String(job.error || job.result || job.status || "triage_failed"),
      digest: context.digest || "",
      channels: channelId ? [channelId] : [],
      steps: 1,
      mutations: actions.length,
      failures: ok ? 0 : 1,
      rawOutput: job.result || job.error || "",
    };
    const updatedRun = runId
      ? slackDomainStore.updateTriageRun({
          run: runPatch,
          actions: triageActionRows(actions),
          toolCalls: [
            {
              tool: "agent_runner",
              action: "slack_triage",
              args: { provider: job.provider, jobId: job.id, parseOk: decision.parseOk },
              success: ok,
              brief: ok ? "AgentRunner triage completed" : "AgentRunner triage failed",
              result: job.result || job.error || "",
            },
          ],
        })
      : slackDomainStore.recordTriageRun({
          run: runPatch,
          actions: triageActionRows(actions),
          toolCalls: [],
        });

    const contextWorkspaceId = String(
      (context as { workspaceId?: string }).workspaceId || "workspace",
    );
    if (ok && decision.summary) {
      slackDomainStore.upsertChannelBrainSummary({
        workspaceId: contextWorkspaceId,
        channelId,
        summary: decision.summary,
      });
    }

    const pendingActions = [];
    for (const action of actions.filter((entry) => entry.requiresConfirmation)) {
      const pendingAction = slackDomainStore.insertPendingAction({
        channelId: action.channelId || channelId,
        threadTs: action.threadTs || threadTs,
        actionType: action.type,
        params: {
          source: "slack-triage",
          runId: updatedRun?.id || runId,
          jobId: job.id,
          title: action.title,
          message: action.message,
          reason: action.reason,
          confidence: action.confidence,
        },
      });
      const post = await postSlackTriageActionCard({
        action: {
          ...action,
          workspaceId: contextWorkspaceId,
          channelId: action.channelId || channelId,
          threadTs: action.threadTs || threadTs,
        },
        pendingAction,
        runId: updatedRun?.id || runId,
      });
      pendingActions.push({ action, pendingAction, post });
    }

    const finalization = { run: updatedRun, decision, pendingActions };
    persistSlackTriageProjection(updatedRun, {
      actions: triageActionRows(actions),
      toolCalls: [
        {
          tool: "agent_runner",
          action: "slack_triage",
          args: { provider: job.provider, jobId: job.id, parseOk: decision.parseOk },
          success: ok,
          brief: ok ? "AgentRunner triage completed" : "AgentRunner triage failed",
        },
      ],
    });
    triageJobResults.set(job.id, finalization);
    return finalization;
  }

  interface StartSlackTriageArgs {
    channelId?: string;
    messages?: Array<{ teamId?: string; [key: string]: unknown }>;
    digest?: string;
  }

  async function startSlackTriage({
    channelId,
    messages = [],
    digest = "",
  }: StartSlackTriageArgs = {}) {
    const workspaceId = messages[0]?.teamId || "workspace";
    const threadTs = lastMessageThreadTs(messages);
    const triageSessionId = `triage:${channelId}:${Date.now()}`;
    const localMemoryContext = localSlackMemory.buildAgentContext({ query: digest, limit: 5 });
    const domainContext =
      slackDomainStore?.context({
        workspaceId,
        channelId,
        threadTs: threadTs || "channel-root",
        limit: 8,
      }) || null;
    const previousTriageContext = buildPreviousTriagePromptContext({
      workspaceId,
      channelId,
      limit: 20,
    });
    const run =
      slackDomainStore?.recordTriageRun({
        run: {
          sessionId: triageSessionId,
          status: "pending",
          summary: `Triage pending for ${messages.length} Slack message(s) in ${channelId}`,
          digest,
          channels: [channelId],
          steps: 0,
        },
        actions: [],
        toolCalls: [],
      }) || null;
    const prompt = buildSlackTriagePrompt({
      channelId,
      messages: messages as unknown as Parameters<typeof buildSlackTriagePrompt>[0]["messages"],
      digest,
      channelBrain: (domainContext as { channelBrain?: unknown } | null)?.channelBrain,
      localMemory: localMemoryContext,
      previousTriage: previousTriageContext,
    });
    const job = await runner.startTask({
      task: prompt,
      context: {
        source: "slack-triage",
        sessionId: triageSessionId,
        channelId,
        workspaceId,
        threadTs: threadTs || "channel-root",
        messageCount: messages.length,
        messages,
        digest,
        triageRunId: run?.id || 0,
        localSlackMemory: localMemoryContext,
        domainContext,
        previousTriage: previousTriageContext,
        expectedOutput: "JSON triage decision with summary and actions[]",
      },
      mode: "analysis",
      allowCodeChanges: false,
    });
    slackInbound.eventBuffer.lastTriageJobId = job.id;
    const finalization = isTerminalJob(job) ? await finalizeSlackTriageJob(job) : null;
    return { run, job, finalization };
  }

  function buildPreviousTriagePromptContext({
    workspaceId = "workspace",
    channelId = "",
    limit = 20,
  } = {}) {
    const storeRows = slackDomainStore?.listTriageContexts?.(limit) || [];
    const projectedRows = loadTriageContextProjection(slackWorkspaceDir);
    const contexts = [...storeRows, ...projectedRows]
      .map(normalizeTriageContext)
      .filter(
        (context) =>
          !channelId || context.channels.length === 0 || context.channels.includes(channelId),
      )
      .toSorted((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, limit);
    const text = formatTriageContexts(contexts);
    return {
      workspaceId,
      channelId,
      count: contexts.length,
      text,
    };
  }

  function persistSlackTriageProjection(run, { actions = [], toolCalls = [] } = {}) {
    if (!run) return null;
    return persistTriageContextProjection({
      workspaceDir: slackWorkspaceDir,
      context: {
        ...run,
        actions,
        tool_calls: toolCalls,
      },
    });
  }

  async function flushSlackMessageBuffer(channelId) {
    const buffer = slackMessageBuffers.get(channelId);
    if (!buffer || !buffer.messages.length) return null;
    if (buffer.timer) clearTimeout(buffer.timer);
    slackMessageBuffers.delete(channelId);
    updateBufferChannelStats(channelId, 0);

    const messages = [...buffer.messages].toSorted((a, b) =>
      String(a.ts).localeCompare(String(b.ts)),
    );
    const digest = renderSlackActivityDigest(channelId, messages);
    slackInbound.eventBuffer.flushes += 1;
    slackInbound.eventBuffer.lastFlushAt = new Date().toISOString();
    slackInbound.eventBuffer.lastFlushChannel = channelId;
    slackInbound.eventBuffer.lastFlushCount = messages.length;

    const syntheticBody = {
      team_id: messages[0]?.teamId || "",
      channel_id: channelId,
      channel_name: channelId,
      user_id: "slack-event-buffer",
      user_name: "slack-event-buffer",
      command: "socket_message_buffer",
      text: digest,
    };
    const syntheticParsed = { action: "slack_activity", task: digest };
    workspaceContext.rememberCommand({
      body: syntheticBody,
      parsed: syntheticParsed,
    });
    slackDomainStore?.recordSlackCommand({
      body: {
        ...syntheticBody,
      },
      parsed: syntheticParsed,
      responseSummary: `Buffered Slack digest with ${messages.length} message(s).`,
    });

    let triage = null;
    if (config.slackEventTriage) {
      triage = await startSlackTriage({ channelId, messages, digest });
    } else {
      slackDomainStore?.recordTriageRun({
        run: {
          sessionId: `buffer:${channelId}:${slackInbound.eventBuffer.flushes}`,
          status: "recorded",
          summary: `Buffered ${messages.length} Slack message(s) for ${channelId}`,
          digest,
          channels: [channelId],
          steps: 0,
        },
        actions: [],
        toolCalls: [],
      });
    }
    return { channelId, messages, digest, triage };
  }

  function bufferSlackMessageEvent(event: SlackEventLike = {}, payload: SlackPayloadLike = {}) {
    if (!config.slackEventBuffer || shouldIgnoreSlackMessageEvent(event)) {
      return { buffered: false, ignored: true };
    }
    const msg = compactSlackMessageEvent(event, payload);
    if (!msg.channelId || !msg.text) return { buffered: false, ignored: true };
    slackDomainStore?.recordSlackMessageEvent(event, payload);

    let buffer = slackMessageBuffers.get(msg.channelId);
    if (!buffer) {
      buffer = { messages: [], timer: null };
      slackMessageBuffers.set(msg.channelId, buffer);
    }
    buffer.messages.push(msg);
    slackInbound.eventBuffer.bufferedMessages += 1;
    slackInbound.eventBuffer.lastBufferedAt = new Date().toISOString();
    updateBufferChannelStats(msg.channelId, buffer.messages.length);

    if (buffer.timer) clearTimeout(buffer.timer);
    if (buffer.messages.length >= config.slackEventMaxBatch) {
      flushSlackMessageBuffer(msg.channelId).catch((error) => {
        slackInbound.eventBuffer.lastError = String(error?.message || error);
      });
    } else {
      buffer.timer = setTimeout(() => {
        flushSlackMessageBuffer(msg.channelId).catch((error) => {
          slackInbound.eventBuffer.lastError = String(error?.message || error);
        });
      }, config.slackEventDebounceMs);
      buffer.timer.unref?.();
    }

    return { buffered: true, channelId: msg.channelId, pending: buffer.messages.length };
  }

  interface SlackInteractionAction {
    value?: string;
    selected_option?: { value?: string };
    [key: string]: unknown;
  }

  interface SlackInteractionPayload {
    actions?: SlackInteractionAction[];
    team?: { id?: string; domain?: string };
    team_id?: string;
    channel?: { id?: string; name?: string };
    channel_id?: string;
    user?: { id?: string; username?: string; name?: string };
    user_id?: string;
    response_url?: string;
    trigger_id?: string;
    message?: { thread_ts?: string; ts?: string };
    [key: string]: unknown;
  }

  function commandBodyFromInteraction(payload: SlackInteractionPayload = {}) {
    const action: SlackInteractionAction = payload.actions?.[0] || {};
    let value: string = String(action.value || action.selected_option?.value || "");
    if (value && value.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(value) as {
          commandText?: string;
          command?: string;
          text?: string;
        };
        value = parsed.commandText || parsed.command || parsed.text || value;
      } catch {
        // Keep the original value when it is not JSON.
      }
    }
    return {
      team_id: payload.team?.id || payload.team_id || "",
      team_domain: payload.team?.domain || "",
      channel_id: payload.channel?.id || payload.channel_id || "",
      channel_name: payload.channel?.name || "",
      user_id: payload.user?.id || payload.user_id || "",
      user_name: payload.user?.username || payload.user?.name || "",
      command: "interactive",
      text: String(value || "").trim(),
      response_url: payload.response_url || "",
      trigger_id: payload.trigger_id || "",
      thread_ts: payload.message?.thread_ts || payload.message?.ts || "",
    };
  }

  async function handlePendingActionInteraction(payload: SlackInteractionPayload = {}) {
    const pending = parsePendingActionInteraction(payload);
    if (!pending?.id || !slackDomainStore) return null;
    const existing = slackDomainStore.getPendingAction(pending.id);
    if (!existing) {
      return slackTextResponse(`Pending action ${pending.id} was not found.`, { ok: false });
    }
    const result = {
      source: "slack_interaction",
      actionId: pending.actionId,
      userId: pending.userId,
      assigneeUserId: pending.assigneeUserId,
      snoozeMinutes: pending.snoozeMinutes,
      channelId: pending.channelId,
      threadTs: pending.threadTs,
      at: new Date().toISOString(),
    };
    const updated = slackDomainStore.setPendingActionStatus(
      pending.id,
      String(pending.status || ""),
      String(pending.userId || ""),
      JSON.stringify({ ...result }),
    );
    const existingRow = existing as {
      channel_id?: string;
      thread_ts?: string;
      action_type?: string;
    };
    slackDomainStore.recordThreadLedgerAction({
      channelId: existingRow.channel_id,
      threadTs: existingRow.thread_ts,
      actionType: existingRow.action_type,
      actionStatus: String(pending.status || ""),
    });
    const suffix =
      pending.status === "assigned" && pending.assigneeUserId
        ? ` to <@${pending.assigneeUserId}>`
        : "";
    return slackTextResponse(`Pending action ${pending.id} ${pending.status}${suffix}.`, {
      ok: true,
      extra: {
        pendingAction: updated,
        interaction: result,
      },
    });
  }

  async function handleSlackEventsApi({ req, body, rawBody, verificationOverride = null }) {
    const verification =
      verificationOverride ||
      verifySlackRequest({
        signingSecret: config.slackSigningSecret,
        timestamp: req.headers["x-slack-request-timestamp"] || "",
        signature: req.headers["x-slack-signature"] || "",
        rawBody,
      });
    if (!verification.ok) {
      return { status: 401, body: { ok: false, error: verification.error } };
    }

    if (body.type === "url_verification" && body.challenge) {
      return { body: { challenge: body.challenge } };
    }

    if (body.type !== "event_callback") {
      return { body: { ok: true, ignored: true, type: body.type || "" } };
    }

    const event = body.event || {};
    if (event.type === "assistant_thread_started") {
      const ref = assistantThreadRefFromEvent(event);
      const prompts = await setSlackAssistantSuggestedPrompts(ref);
      return {
        body: {
          ok: prompts.ok !== false,
          handled: true,
          mode: "assistant_thread_started",
          assistantThread: ref,
          suggestedPrompts: {
            ok: prompts.ok,
            error:
              (prompts as { error?: string }).error ||
              (prompts as { body?: { error?: string } }).body?.error ||
              "",
          },
        },
      };
    }
    if (event.type === "assistant_thread_context_changed") {
      return {
        body: {
          ok: true,
          handled: true,
          mode: "assistant_thread_context_changed",
          assistantThread: assistantThreadRefFromEvent(event),
        },
      };
    }
    const allowedBotMessageForBuffer =
      config.slackEventAllowBotMessages &&
      event.type === "message" &&
      event.channel_type !== "im" &&
      Boolean(event.bot_id || event.subtype === "bot_message");
    if ((event.bot_id || event.subtype) && !allowedBotMessageForBuffer) {
      return { body: { ok: true, ignored: true, reason: "bot_or_subtype" } };
    }
    if (isBotMentionFallbackMessage(event)) {
      const mentionClaim = claimSlackMentionEvent(event, body);
      if (!mentionClaim.claimed) {
        return {
          body: {
            ok: true,
            ignored: true,
            reason: "duplicate_mention_event",
            eventKey: mentionClaim.key,
          },
        };
      }
      const commandBody = await commandBodyFromSlackEventWithContext(event, body, {
        richThreadContext: true,
      });
      if (!commandBody.text) {
        return { body: { ok: true, ignored: true, reason: "empty_mention_fallback_text" } };
      }
      let keepAssistantStatusForWorker = false;
      await scheduleSlackAssistantThreadStatus({
        channelId: commandBody.channel_id,
        threadTs: commandBody.thread_ts,
        status: "Thinking...",
        immediate: true,
      });
      try {
        const result = await runMentionWithThreadGuard(commandBody, async () =>
          executeAvatarCommand({
            body: commandBody,
            verification: { ...verification, source: "events_api_message_mention" },
          }),
        );
        if (result.body?.ignored) {
          return { status: result.status || 200, body: result.body };
        }
        const responseBody = result.body || result;
        keepAssistantStatusForWorker = shouldKeepAssistantStatusUntilWorkerDone(responseBody);
        const responseText = slackImmediateWorkerAckText(responseBody);
        if (commandBody.channel_id && responseText) {
          await poster.postMessage({
            channel: commandBody.channel_id,
            threadTs: commandBody.thread_ts,
            text: responseText,
            dedupKey: `events-api-message-mention:${body.event_id || commandBody.event_ts}:${commandBody.channel_id}`,
          });
        }
        return {
          status: result.status || 200,
          body: {
            ok: responseBody?.ok !== false,
            handled: true,
            mode: "message_mention",
            response: responseBody,
          },
        };
      } finally {
        if (!keepAssistantStatusForWorker) {
          await scheduleSlackAssistantThreadStatus({
            channelId: commandBody.channel_id,
            threadTs: commandBody.thread_ts,
            status: "",
            immediate: true,
          });
        }
      }
    }
    if (event.type === "message" && event.channel_type !== "im") {
      const buffered = bufferSlackMessageEvent(event, body);
      return { body: { ok: true, handled: buffered.buffered, mode: "event_buffer", ...buffered } };
    }
    if (
      event.type !== "app_mention" &&
      !(event.type === "message" && event.channel_type === "im")
    ) {
      return { body: { ok: true, ignored: true, eventType: event.type || "" } };
    }
    if (event.type === "app_mention") {
      const mentionClaim = claimSlackMentionEvent(event, body);
      if (!mentionClaim.claimed) {
        return {
          body: {
            ok: true,
            ignored: true,
            reason: "duplicate_mention_event",
            eventKey: mentionClaim.key,
          },
        };
      }
    }

    const commandBody = await commandBodyFromSlackEventWithContext(event, body, {
      richThreadContext: event.type === "app_mention",
    });
    if (!commandBody.text) {
      return { body: { ok: true, ignored: true, reason: "empty_event_text" } };
    }
    const shouldShowAssistantStatus =
      event.type === "app_mention" || (event.type === "message" && event.channel_type === "im");
    if (shouldShowAssistantStatus) {
      await scheduleSlackAssistantThreadStatus({
        channelId: commandBody.channel_id,
        threadTs: commandBody.thread_ts,
        status: "Thinking...",
        immediate: true,
      });
    }
    let keepAssistantStatusForWorker = false;
    try {
      const runCommand = () =>
        executeAvatarCommand({
          body: commandBody,
          verification: { ...verification, source: "events_api" },
        });
      const result =
        event.type === "app_mention"
          ? await runMentionWithThreadGuard(commandBody, runCommand)
          : await runCommand();
      if (result.body?.ignored) {
        return { status: result.status || 200, body: result.body };
      }
      const responseBody = result.body || result;
      keepAssistantStatusForWorker = shouldKeepAssistantStatusUntilWorkerDone(responseBody);
      const responseText = slackImmediateWorkerAckText(responseBody);
      if (commandBody.channel_id && responseText) {
        await poster.postMessage({
          channel: commandBody.channel_id,
          threadTs: commandBody.thread_ts,
          text: responseText,
          dedupKey: `events-api:${body.event_id || commandBody.event_ts}:${commandBody.channel_id}`,
        });
      }
      return {
        status: result.status || 200,
        body: {
          ok: responseBody?.ok !== false,
          handled: true,
          mode:
            event.type === "message" && event.channel_type === "im" ? "dm_command" : "app_mention",
          response: responseBody,
        },
      };
    } finally {
      if (shouldShowAssistantStatus && !keepAssistantStatusForWorker) {
        await scheduleSlackAssistantThreadStatus({
          channelId: commandBody.channel_id,
          threadTs: commandBody.thread_ts,
          status: "",
          immediate: true,
        });
      }
    }
  }

  async function handleSlackInteraction({ req, body, rawBody }) {
    const verification = verifySlackRequest({
      signingSecret: config.slackSigningSecret,
      timestamp: req.headers["x-slack-request-timestamp"] || "",
      signature: req.headers["x-slack-signature"] || "",
      rawBody,
    });
    if (!verification.ok) {
      return {
        status: 401,
        body: slackTextResponse(`Slack request verification failed: ${verification.error}`, {
          ok: false,
        }),
      };
    }
    const payload = parseSlackInteractionPayload(body);
    if (!payload) {
      return {
        status: 400,
        body: slackTextResponse("Invalid Slack interaction payload.", { ok: false }),
      };
    }
    const pendingActionResponse = await handlePendingActionInteraction(payload);
    if (pendingActionResponse) {
      return {
        status: pendingActionResponse.ok === false ? 404 : 200,
        body: pendingActionResponse,
      };
    }
    const commandBody = commandBodyFromInteraction(payload);
    if (!commandBody.text) {
      return slackTextResponse(
        "Action received. This interactive control has no meeting-avatar command attached yet.",
      );
    }
    return executeAvatarCommand({
      body: commandBody,
      verification: { ...verification, source: "interaction" },
    });
  }

  return {
    assistantStatusTextForJob,
    bufferSlackMessageEvent,
    commandBodyFromInteraction,
    finalizeSlackTriageJob,
    flushSlackMessageBuffer,
    handleMeetingWebhookPayload,
    handlePendingActionInteraction,
    handleSlackEventsApi,
    handleSlackInteraction,
    postSlackMessage,
    renderSlackActivityDigest,
    scheduleSlackAssistantThreadStatus,
    scheduleSlackSocketReconnect,
    startSlackTriage,
  };
}
