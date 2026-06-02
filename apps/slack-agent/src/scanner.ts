import { callSlackApi } from "../../../packages/core/src/slack/canvas-publisher.js";
import { buildDailyNoteCompactionTask } from "../../../packages/core/src/slack/scanner-compaction.js";
import {
  buildSlackOAuthAuthorizeUrl,
  validateSlackAppManifest,
} from "../../../packages/core/src/slack/slack-app-manifest.js";

type SlackHandlerInput = Record<string, any>;
type SlackChannelLike = Record<string, any>;
type SlackMessageLike = Record<string, any>;
interface SlackApiPageResult<T = unknown> {
  ok: boolean;
  items?: T[];
  error?: string;
  method?: string;
  fixture?: boolean;
  detail?: unknown;
  status?: number;
  source?: string;
  messages?: T[];
}

export function createSlackScannerHandlers(ctx: any) {
  const {
    config,
    expectedSlackManifest,
    loadConfiguredSlackManifest,
    slackDomainStore,
    runner,
    slackInbound,
    slackWorkspaceDir,
    bufferSlackMessageEvent,
    flushSlackMessageBuffer,
  } = ctx;
  const scannerState = ctx.scannerState || { lastScannerCompactionHash: "" };

  async function collectSlackApiPages<T = unknown>(
    method: string,
    payload: Record<string, unknown> = {},
    itemKey: string = "",
  ): Promise<SlackApiPageResult<T>> {
    const items: T[] = [];
    let cursor = "";
    do {
      const result = await callSlackApi({
        botToken: config.slackBotToken,
        method,
        payload: {
          ...payload,
          ...(cursor ? { cursor } : {}),
        },
      });
      if (!result.ok)
        return { ok: false, error: result.error, method, detail: result } as SlackApiPageResult<T>;
      const body = result.body as Record<string, unknown> | undefined;
      const chunk = (body?.[itemKey] as T[] | undefined) || [];
      items.push(...chunk);
      const metadata = body?.response_metadata as { next_cursor?: string } | undefined;
      cursor = metadata?.next_cursor || "";
    } while (cursor);
    return { ok: true, items };
  }

  function slackInstallModel(inputManifest = null) {
    const redirectUri =
      config.slackRedirectUri || `${config.publicBaseUrl.replace(/\/+$/, "")}/slack/oauth`;
    const manifest = expectedSlackManifest;
    const configuredManifest = inputManifest || loadConfiguredSlackManifest();
    const manifestValidation = configuredManifest
      ? validateSlackAppManifest(configuredManifest, { expected: manifest })
      : { ok: false, skipped: true, reason: "no_manifest_supplied" };
    const installUrl = buildSlackOAuthAuthorizeUrl({
      clientId: config.slackClientId,
      redirectUri,
    });
    return {
      ok: true,
      manifest,
      manifestValidation,
      oauth: {
        configured: Boolean(config.slackClientId && config.slackClientSecret),
        installUrl,
        redirectUri,
        clientIdConfigured: Boolean(config.slackClientId),
        clientSecretConfigured: Boolean(config.slackClientSecret),
      },
      permissionModel: {
        mode: "socket_mode_plus_assistant_dm",
        notes: [
          "Manifest/App Home changes must be followed by Reinstall to Workspace.",
          "Live event handling should stay disabled until local validation and self-trigger-loop smokes are green.",
        ],
      },
    };
  }

  async function refreshSlackDomainCache(input: SlackHandlerInput = {}) {
    if (!slackDomainStore) return { ok: false, error: "slack_domain_store_disabled" };
    const workspaceId =
      input.workspace || input.workspaceId || input.team || input.team_id || "workspace";
    const source: SlackApiPageResult<SlackChannelLike> =
      Array.isArray(input.channels) && input.channels.length
        ? { ok: true, items: input.channels, fixture: true }
        : await collectSlackApiPages<SlackChannelLike>(
            "conversations.list",
            {
              exclude_archived: input.excludeArchived !== false,
              types: input.types || "public_channel,private_channel",
              limit: Number(input.limit || 200),
            },
            "channels",
          );
    if (!source.ok) return source;

    const refreshed = [];
    for (const channel of source.items || []) {
      const channelId = channel.id || channel.channel_id || "";
      if (!channelId) continue;
      const type =
        channel.type ||
        (channel.is_im
          ? "im"
          : channel.is_mpim
            ? "mpim"
            : channel.is_private
              ? "private_channel"
              : "public_channel");
      const stored = slackDomainStore.upsertChannel({
        id: channelId,
        name: channel.name || channel.name_normalized || channelId,
        type,
      });
      let members: string[] = Array.isArray(channel.members) ? channel.members : [];
      if (!members.length && input.fetchMembers !== false && !source.fixture) {
        const memberResult = await collectSlackApiPages<string>(
          "conversations.members",
          {
            channel: channelId,
            limit: Number(input.memberLimit || 1000),
          },
          "members",
        );
        if (memberResult.ok) members = memberResult.items || [];
        else
          refreshed.push({
            workspaceId,
            channelId,
            memberError: memberResult.error,
            fixture: false,
          });
      }
      const membership = slackDomainStore.syncChannelMembers(channelId, members);
      refreshed.push({
        workspaceId,
        channel: stored,
        memberCount: membership.memberCount,
        fixture: Boolean(source.fixture),
      });
    }
    slackDomainStore.setEventCursor(`domain-refresh:${workspaceId}`, new Date().toISOString());
    return {
      ok: true,
      workspaceId,
      source: source.fixture ? "fixture" : "slack_web_api",
      refreshed,
      channelCount: refreshed.length,
      memberCount: refreshed.reduce((sum, item) => sum + Number(item.memberCount || 0), 0),
      domain: slackDomainStore.stats(),
    };
  }

  function slackTsAfter(value = "", cursor = "") {
    if (!cursor) return true;
    const current = Number(value);
    const previous = Number(cursor);
    if (Number.isFinite(current) && Number.isFinite(previous)) return current > previous;
    return String(value || "") > String(cursor || "");
  }

  interface NormalizedSweepChannel {
    id: string;
    name: string;
    type: string;
    messages: SlackMessageLike[];
  }

  function normalizeSweepChannels(input: SlackHandlerInput = {}): NormalizedSweepChannel[] {
    if (Array.isArray(input.channels) && input.channels.length) {
      return input.channels
        .map((channel) => ({
          id: channel.id || channel.channel || channel.channel_id || "",
          name: channel.name || "",
          type: channel.type || channel.channel_type || "public_channel",
          messages: Array.isArray(channel.messages) ? channel.messages : [],
        }))
        .filter((channel) => channel.id);
    }
    const channelId = input.channel || input.channel_id || "";
    if (!channelId) return [];
    return [
      {
        id: channelId,
        name: input.channelName || input.channel_name || "",
        type: input.channelType || input.channel_type || "public_channel",
        messages: Array.isArray(input.messages) ? input.messages : [],
      },
    ];
  }

  async function collectSlackHistory(
    channelId: string,
    input: SlackHandlerInput = {},
    cursor = "",
  ): Promise<SlackApiPageResult<SlackMessageLike> & { messages?: SlackMessageLike[] }> {
    if (Array.isArray(input.messages))
      return { ok: true, messages: input.messages, source: "fixture" };
    const result = await collectSlackApiPages<SlackMessageLike>(
      "conversations.history",
      {
        channel: channelId,
        oldest: cursor || input.oldest || "0",
        inclusive: false,
        limit: Number(input.limit || 100),
      },
      "messages",
    );
    if (!result.ok) return result;
    return { ok: true, messages: result.items || [], source: "slack_web_api" };
  }

  async function sweepSlackScanner(input: SlackHandlerInput = {}) {
    if (!slackDomainStore) return { ok: false, error: "slack_domain_store_disabled" };
    const workspaceId =
      input.workspace || input.workspaceId || input.team || input.team_id || "workspace";
    const channels = normalizeSweepChannels(input);
    if (!channels.length) return { ok: false, error: "channel_required" };

    const sweeps = [];
    for (const channel of channels) {
      slackDomainStore.upsertChannel({
        id: channel.id,
        name: channel.name || channel.id,
        type: channel.type,
      });
      const cursorKey = `scanner:${workspaceId}:${channel.id}`;
      const previousCursor = slackDomainStore.getEventCursor(cursorKey)?.value || "";
      const history = channel.messages.length
        ? { ok: true, messages: channel.messages, source: "fixture" }
        : await collectSlackHistory(channel.id, input, previousCursor);
      if (!history.ok) {
        sweeps.push({ channelId: channel.id, ok: false, error: history.error, previousCursor });
        continue;
      }
      const messages = [...history.messages]
        .filter((message) => slackTsAfter(message.ts || message.event_ts || "", previousCursor))
        .toSorted((a, b) =>
          String(a.ts || a.event_ts || "").localeCompare(String(b.ts || b.event_ts || "")),
        );
      let nextCursor = previousCursor;
      let buffered = 0;
      for (const message of messages) {
        const event = {
          type: "message",
          channel: channel.id,
          channel_type: channel.type,
          user: message.user || message.bot_id || "",
          bot_id: message.bot_id || "",
          subtype: message.subtype || "",
          text: message.text || "",
          ts: message.ts || message.event_ts || "",
          event_ts: message.event_ts || message.ts || "",
          thread_ts: message.thread_ts || "",
        };
        const result = bufferSlackMessageEvent(event, { team_id: workspaceId });
        if (result.buffered) buffered += 1;
        if (slackTsAfter(event.ts, nextCursor)) nextCursor = event.ts;
      }
      if (nextCursor && nextCursor !== previousCursor)
        slackDomainStore.setEventCursor(cursorKey, nextCursor);
      let flushed = null;
      if (input.flush !== false && buffered > 0) {
        flushed = await flushSlackMessageBuffer(channel.id);
      }
      sweeps.push({
        channelId: channel.id,
        ok: true,
        source: history.source,
        previousCursor,
        nextCursor,
        scanned: history.messages.length,
        buffered,
        flushed: flushed ? { count: flushed.messages.length, digest: flushed.digest } : null,
      });
    }
    return {
      ok: sweeps.every((sweep) => sweep.ok),
      workspaceId,
      sweeps,
      inbound: slackInbound,
    };
  }

  async function compactSlackDailyNotes(input: SlackHandlerInput = {}) {
    const workspaceDir = input.workspaceDir || input.workspace_dir || slackWorkspaceDir;
    const task = buildDailyNoteCompactionTask({
      workspaceDir,
      date: input.date || "",
    });
    if (!task.ok || !task.eligible) return task;
    if (task.hash && task.hash === scannerState.lastScannerCompactionHash) {
      return { ...task, eligible: false, skipped: true, reason: "duplicate_hash" };
    }
    if (input.run === true || input.run === "true") {
      const job = await runner.startTask({
        task: task.prompt,
        context: {
          kind: task.sessionKind,
          workspaceDir,
          date: task.date,
          path: task.path,
          hash: task.hash,
        },
        mode: "analysis",
        allowCodeChanges: false,
      });
      scannerState.lastScannerCompactionHash = task.hash;
      return { ...task, job };
    }
    return task;
  }

  function slackFollowupStatus(input: SlackHandlerInput = {}) {
    const limit = Number.parseInt(String(input.limit ?? "20"), 10);
    return {
      ok: true,
      outboundActions: slackDomainStore?.listOutboundActions({ limit }) || [],
      threadRecommendations: slackDomainStore?.listThreadRecommendations({ limit }) || [],
      heartbeatFollowups:
        slackDomainStore?.listHeartbeatFollowups({ status: input.status || "", limit }) || [],
      heartbeatSurfaces: slackDomainStore?.listHeartbeatSurfaces({ limit }) || [],
    };
  }

  function createSlackFollowupSurface(input: SlackHandlerInput = {}) {
    if (!slackDomainStore) return { ok: false, error: "slack_domain_store_disabled" };
    const channelId = input.channel || input.channel_id || "C_FOLLOWUP";
    const threadTs = input.threadTs || input.thread_ts || "channel-root";
    const sessionId = input.sessionId || input.session_id || "";
    const title = input.title || "Follow up on Slack activity";
    const summary = input.summary || title;
    const followup = slackDomainStore.createHeartbeatFollowup({
      kind: input.kind || "followup",
      title,
      summary,
      sourceKind: input.sourceKind || input.source_kind || "thread",
      channelId,
      threadTs,
      sourceRef: input.sourceRef || input.source_ref || `${channelId}:${threadTs}`,
      priority: input.priority || "normal",
      dueAt: input.dueAt || input.due_at || "",
      nextCheckAt: input.nextCheckAt || input.next_check_at || "",
      metadata: input.metadata || {},
    });
    const surface = slackDomainStore.recordHeartbeatSurface({
      followupId: followup.id,
      sessionId,
      title,
      summary,
      requestedSurface: input.requestedSurface || input.requested_surface || "slack_thread",
      deliveredSurface: input.deliveredSurface || input.delivered_surface || "slack_thread",
      channelId,
      threadTs,
      status: input.surfaceStatus || input.surface_status || "sent",
      blockReason: input.blockReason || input.block_reason || "",
      error: input.error || "",
    });
    let recommendation = null;
    if (input.recommendationType || input.recommendation_type) {
      const reserved = slackDomainStore.reserveThreadRecommendation({
        channelId,
        threadTs,
        recommendationType: input.recommendationType || input.recommendation_type,
      });
      recommendation = reserved.id
        ? slackDomainStore.setThreadRecommendationStatus(
            reserved.id,
            input.recommendationStatus || input.recommendation_status || "active",
            input.cardTs || input.card_ts || surface.id,
          )
        : reserved;
    }
    let outbound = null;
    if (input.outboundActionType || input.outbound_action_type) {
      const reserved = slackDomainStore.reserveOutboundAction({
        actionType: input.outboundActionType || input.outbound_action_type,
        target: input.target || channelId,
        reference: input.reference || `${channelId}:${threadTs}:${surface.id}`,
        sessionId,
        summary,
      });
      outbound = reserved.id
        ? slackDomainStore.setOutboundActionStatus(
            reserved.id,
            input.outboundStatus || input.outbound_status || "sent",
          )
        : reserved;
    }
    const finalFollowup =
      input.followupStatus || input.followup_status
        ? slackDomainStore.setHeartbeatFollowupStatus(
            followup.id,
            input.followupStatus || input.followup_status,
          )
        : followup;
    return {
      ok: true,
      followup: finalFollowup,
      surface,
      recommendation,
      outbound,
      status: slackFollowupStatus({ limit: input.limit || 20 }),
    };
  }

  return {
    compactSlackDailyNotes,
    createSlackFollowupSurface,
    refreshSlackDomainCache,
    slackInstallModel,
    slackFollowupStatus,
    sweepSlackScanner,
  };
}
