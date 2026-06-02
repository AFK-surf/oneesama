import { callSlackApi } from "../../../packages/core/src/slack/canvas-publisher.js";
import {
  MEETING_RESULT_DELIVERY_RESERVATION_TTL_MS,
  buildMeetingCanvasArtifact,
  buildMeetingFailurePost,
  buildMeetingJoinedPost,
  buildMeetingResultPost,
  meetingProcessingStatus,
  meetingRecordingStatus,
  normalizeMeetingWebhookPayload,
  resolveMeetingSlackRef,
} from "../../../packages/core/src/slack/meeting-webhook-delivery.js";

type SlackEventLike = Record<string, any>;
type SlackPayloadLike = Record<string, any>;
type SlackJobLike = Record<string, any>;
type SlackHandlerInput = Record<string, any>;

export function createSlackAssistantMeetingHandlers(ctx: any) {
  const {
    config,
    slackDomainStore,
    assistantStatusByThread,
    assistantStatusMinIntervalMs,
    assistantToolStatusLabels,
    shouldBypassAssistantStatusThrottle,
    assistantStatusPriority,
    slackApiMockCalls,
    poster,
    canvasPublisher,
    meetingCopilotRunner,
  } = ctx;

  function assistantThreadRefFromEvent(event: SlackEventLike = {}) {
    type ThreadLike = {
      context?: { channel_id?: string; channelId?: string };
      channel_id?: string;
      channelId?: string;
      thread_ts?: string;
      threadTimeStamp?: string;
      user_id?: string;
      userId?: string;
      [key: string]: unknown;
    };
    const thread: ThreadLike =
      (event.assistant_thread as ThreadLike) ||
      (event.assistantThread as ThreadLike) ||
      (event.thread as ThreadLike) ||
      {};
    const context: { channel_id?: string; channelId?: string } =
      (thread.context as { channel_id?: string; channelId?: string }) ||
      (event.context as { channel_id?: string; channelId?: string }) ||
      {};
    return {
      channelId:
        thread.channel_id ||
        thread.channelId ||
        event.channel_id ||
        event.channel ||
        context.channel_id ||
        context.channelId ||
        "",
      threadTs:
        thread.thread_ts ||
        thread.threadTimeStamp ||
        event.thread_ts ||
        event.threadTimeStamp ||
        event.ts ||
        "",
      userId: thread.user_id || thread.userId || event.user || event.user_id || "",
    };
  }

  async function callSlackAssistantApi({ method, payload }) {
    if (config.slackApiMock) {
      const call = {
        at: new Date().toISOString(),
        method,
        payload,
        mock: true,
      };
      slackApiMockCalls.push(call);
      return {
        ok: true,
        status: 200,
        method,
        body: { ok: true, mock: true },
        mock: true,
      };
    }
    const result = await callSlackApi({
      botToken: config.slackBotToken,
      method,
      payload,
    });
    slackApiMockCalls.push({
      at: new Date().toISOString(),
      method,
      payload,
      mock: false,
      ok: result.ok,
      status: result.status,
      error: result.error || "",
      slackError: result.body?.error || "",
    });
    return result;
  }

  async function postSlackMessage(payload: SlackPayloadLike & SlackHandlerInput = {}) {
    if (config.slackApiMock) {
      const call = {
        at: new Date().toISOString(),
        method: "chat.postMessage",
        payload,
        mock: true,
      };
      slackApiMockCalls.push(call);
      return {
        ok: true,
        status: 200,
        method: "chat.postMessage",
        body: { ok: true, mock: true, ts: `mock.${Date.now()}` },
        mock: true,
      };
    }
    return callSlackApi({
      botToken: config.slackBotToken,
      method: "chat.postMessage",
      payload,
    });
  }

  function assistantStatusKey(channelId, threadTs) {
    return `${channelId || ""}:${threadTs || ""}`;
  }

  function assistantStatusTextForJob(job: SlackJobLike = {}) {
    const latestProgressStatus = (job as { latestProgressStatus?: string }).latestProgressStatus;
    if (latestProgressStatus) return latestProgressStatus;
    const toolName = String(
      (job as { toolName?: string; tool?: string; latestToolName?: string }).toolName ||
        (job as { tool?: string }).tool ||
        (job as { latestToolName?: string }).latestToolName ||
        "",
    );
    const mapped = (assistantToolStatusLabels as Record<string, string>)[toolName] || "";
    if (mapped) return mapped;
    if (job.status === "running") return "Working on it...";
    return "";
  }

  async function setSlackAssistantThreadStatus({
    channelId,
    threadTs,
    status,
  }: {
    channelId?: string;
    threadTs?: string;
    status?: string;
  }) {
    if (!channelId || !threadTs) {
      return { ok: false, skipped: true, reason: "missing_assistant_thread_ref" };
    }
    const result = await callSlackAssistantApi({
      method: "assistant.threads.setStatus",
      payload: {
        channel_id: channelId,
        thread_ts: threadTs,
        status: String(status || ""),
        ...(status ? { loading_messages: [String(status)] } : {}),
      },
    });
    if (!result.ok) {
      console.warn("[slack-agent] assistant status update failed", {
        channelId,
        threadTs,
        error: (result as { error?: string }).error,
        slackError: (result.body as { error?: string } | undefined)?.error,
      });
    }
    return result;
  }

  async function scheduleSlackAssistantThreadStatus({
    channelId,
    threadTs,
    status,
    immediate = false,
  }) {
    if (!channelId || !threadTs) {
      return { ok: false, skipped: true, reason: "missing_assistant_thread_ref" };
    }
    const key = assistantStatusKey(channelId, threadTs);
    const state = assistantStatusByThread.get(key) || {
      lastStatus: null,
      lastCallAt: 0,
      pendingTimer: null,
      pendingStatus: null,
    };
    assistantStatusByThread.set(key, state);

    if (status === state.lastStatus) {
      return { ok: true, skipped: true, reason: "duplicate_assistant_status" };
    }

    if (!status || immediate) {
      if (state.pendingTimer) clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
      state.pendingStatus = null;
      const result = await setSlackAssistantThreadStatus({ channelId, threadTs, status });
      if (result.ok !== false) {
        state.lastStatus = status;
        state.lastCallAt = Date.now();
      }
      return result;
    }

    const elapsed = Date.now() - state.lastCallAt;
    if (elapsed >= assistantStatusMinIntervalMs || shouldBypassAssistantStatusThrottle(status)) {
      const result = await setSlackAssistantThreadStatus({ channelId, threadTs, status });
      if (result.ok !== false) {
        state.lastStatus = status;
        state.lastCallAt = Date.now();
      }
      return result;
    }

    if (
      !state.pendingStatus ||
      assistantStatusPriority(status) >= assistantStatusPriority(state.pendingStatus)
    ) {
      state.pendingStatus = status;
    }
    if (!state.pendingTimer) {
      state.pendingTimer = setTimeout(() => {
        const pending = state.pendingStatus;
        state.pendingStatus = null;
        state.pendingTimer = null;
        if (pending && pending !== state.lastStatus) {
          setSlackAssistantThreadStatus({ channelId, threadTs, status: pending })
            .then((result) =>
              result.ok !== false
                ? Object.assign(state, { lastStatus: pending, lastCallAt: Date.now() })
                : undefined,
            )
            .catch((error) => {
              console.warn(
                "[slack-agent] assistant status throttle flush failed",
                String(error?.message || error),
              );
            });
        }
      }, assistantStatusMinIntervalMs - elapsed);
    }
    return { ok: true, queued: true };
  }

  async function setSlackAssistantSuggestedPrompts({ channelId, threadTs }) {
    if (!channelId || !threadTs) {
      return { ok: false, skipped: true, reason: "missing_assistant_thread_ref" };
    }
    const result = await callSlackAssistantApi({
      method: "assistant.threads.setSuggestedPrompts",
      payload: {
        channel_id: channelId,
        thread_ts: threadTs,
        title: "试试这些：",
        prompts: [
          { title: "今天日程", message: "今天有什么会议和日程安排？" },
          { title: "未读消息", message: "帮我看看有什么重要的未读消息？" },
          { title: "让 Codex 做事", message: "请委托 Codex 帮我查代码或处理任务。" },
        ],
      },
    });
    if (!result.ok) {
      console.warn("[slack-agent] assistant suggested prompts failed", {
        channelId,
        threadTs,
        error: (result as { error?: string }).error,
        slackError: (result.body as { error?: string } | undefined)?.error,
      });
    }
    return result;
  }

  function getMeetingThreadForPayload(payload: SlackPayloadLike = {}) {
    if (!slackDomainStore || !payload.meetingId) return null;
    return slackDomainStore.getMeetingThreadByRemoteId(String(payload.meetingId));
  }

  function persistMeetingThreadForPayload(
    payload: SlackPayloadLike = {},
    ref: { channelId?: string; threadTs?: string; [key: string]: unknown } = {},
    post: { ts?: string; [key: string]: unknown } = {},
  ) {
    if (!slackDomainStore || !payload.meetingId || !ref.channelId) return null;
    return slackDomainStore.insertMeetingThread({
      dedupeKey: `remote:${payload.meetingId}`,
      remoteMeetingId: String(payload.meetingId),
      channelId: String(ref.channelId),
      threadTs: String(ref.threadTs || post.ts || ""),
    });
  }

  function slackRefForMeetingWebhook(payload: SlackPayloadLike = {}) {
    const meetingThread = getMeetingThreadForPayload(payload);
    return resolveMeetingSlackRef({
      payload: payload as unknown as Parameters<typeof resolveMeetingSlackRef>[0]["payload"],
      meetingThread: meetingThread as Parameters<typeof resolveMeetingSlackRef>[0]["meetingThread"],
    });
  }

  async function handleMeetingWebhookJoined(payload: SlackPayloadLike = {}) {
    const ref = slackRefForMeetingWebhook(payload);
    if (!ref.channelId) {
      return {
        ok: true,
        skipped: true,
        event: payload.event,
        reason: "missing_slack_ref_no_dm_opener",
        meetingId: payload.meetingId,
      };
    }
    const message = buildMeetingJoinedPost(payload);
    const post = await poster.postMessage({
      channel: ref.channelId,
      threadTs: ref.threadTs,
      text: message.text,
      blocks: message.blocks,
      dedupKey: `meeting:${payload.meetingId}:joined:${ref.channelId}:${ref.threadTs || "root"}`,
    });
    const status = await scheduleSlackAssistantThreadStatus({
      channelId: ref.channelId,
      threadTs: ref.threadTs || post.ts || "",
      status: meetingRecordingStatus(),
      immediate: true,
    });
    const persisted = persistMeetingThreadForPayload(payload, ref, post);
    return {
      ok: post.ok !== false,
      event: payload.event,
      meetingId: payload.meetingId,
      slackRef: ref,
      post,
      assistantStatus: status,
      meetingThread: persisted,
    };
  }

  async function handleMeetingWebhookProcessing(payload: SlackPayloadLike = {}) {
    const ref = slackRefForMeetingWebhook(payload);
    if (!ref.channelId) {
      return {
        ok: true,
        skipped: true,
        event: payload.event,
        reason: "missing_slack_ref",
        meetingId: payload.meetingId,
      };
    }
    const status = await scheduleSlackAssistantThreadStatus({
      channelId: ref.channelId,
      threadTs: ref.threadTs,
      status: meetingProcessingStatus(),
      immediate: true,
    });
    return {
      ok: status.ok !== false,
      event: payload.event,
      meetingId: payload.meetingId,
      slackRef: ref,
      assistantStatus: status,
    };
  }

  function reserveMeetingWebhookResult(payload: SlackPayloadLike = {}) {
    if (!payload.meetingId) return { reserved: false, reason: "missing_meeting_id" };
    if (!slackDomainStore) return { reserved: true, inMemory: true };
    const cleanup = slackDomainStore.cleanupStalePendingMeetingResultDeliveries(
      MEETING_RESULT_DELIVERY_RESERVATION_TTL_MS,
    );
    const reservation = slackDomainStore.reserveMeetingResultDelivery(
      String(payload.meetingId || ""),
    );
    return { ...reservation, cleanup };
  }

  async function handleMeetingWebhookResult(payload: SlackPayloadLike = {}) {
    const reservation = reserveMeetingWebhookResult(payload);
    if (!reservation.reserved) {
      const r = reservation as { reason?: string; delivery?: unknown; cleanup?: unknown };
      return {
        ok: true,
        skipped: true,
        duplicate: true,
        event: payload.event,
        reason: r.reason || "delivery_already_reserved",
        meetingId: payload.meetingId,
        delivery: r.delivery || null,
        cleanup: r.cleanup || null,
      };
    }

    const copilotStop = meetingCopilotRunner.stop(payload.meetingId, "meeting_result");
    const ref = slackRefForMeetingWebhook(payload);
    let post = null;
    let published = null;
    try {
      if (payload.status === "failed") {
        if (ref.channelId) {
          const message = buildMeetingFailurePost(payload);
          post = await poster.postMessage({
            channel: ref.channelId,
            threadTs: ref.threadTs,
            text: message.text,
            dedupKey: `meeting:${payload.meetingId}:failed:${ref.channelId}:${ref.threadTs || "root"}`,
          });
        }
        if (slackDomainStore)
          slackDomainStore.confirmMeetingResultDelivery(String(payload.meetingId || ""));
        return {
          ok: post ? post.ok !== false : true,
          event: payload.event,
          meetingId: payload.meetingId,
          status: "failed",
          slackRef: ref,
          post,
          copilotStop,
          delivery:
            slackDomainStore?.getMeetingResultDelivery(String(payload.meetingId || "")) || null,
        };
      }

      if (!payload.summary) {
        if (slackDomainStore)
          slackDomainStore.failMeetingResultDelivery(String(payload.meetingId || ""));
        return {
          ok: false,
          event: payload.event,
          meetingId: payload.meetingId,
          error: "summary_required",
          copilotStop,
          delivery:
            slackDomainStore?.getMeetingResultDelivery(String(payload.meetingId || "")) || null,
        };
      }

      const payloadAsResult = payload as unknown as Parameters<typeof buildMeetingResultPost>[0];
      const message = buildMeetingResultPost(payloadAsResult);
      if (ref.channelId) {
        published = await canvasPublisher.publish({
          artifact: buildMeetingCanvasArtifact(payloadAsResult) as any,
          artifactId: `meeting-${payload.meetingId}`,
          title: message.summary.title || String(payload.title || ""),
          summaryMarkdown: message.text,
          channel: ref.channelId,
          threadTs: ref.threadTs,
          destination: "meeting-webhook",
          dedupKey: `meeting:${payload.meetingId}:summary:${ref.channelId}:${ref.threadTs || "root"}`,
        });
        post = published.slack || null;
      }
      if (slackDomainStore)
        slackDomainStore.confirmMeetingResultDelivery(String(payload.meetingId));
      await scheduleSlackAssistantThreadStatus({
        channelId: ref.channelId,
        threadTs: ref.threadTs,
        status: "",
        immediate: true,
      });
      return {
        ok: post ? post.ok !== false : true,
        event: payload.event,
        meetingId: payload.meetingId,
        status: payload.status || "done",
        slackRef: ref,
        post,
        published,
        copilotStop,
        delivery:
          slackDomainStore?.getMeetingResultDelivery(String(payload.meetingId || "")) || null,
      };
    } catch (error) {
      if (slackDomainStore)
        slackDomainStore.failMeetingResultDelivery(String(payload.meetingId || ""));
      return {
        ok: false,
        event: payload.event,
        meetingId: payload.meetingId,
        error: "meeting_result_delivery_failed",
        detail: String((error as { message?: string })?.message || error),
        post,
        published,
        copilotStop,
        delivery:
          slackDomainStore?.getMeetingResultDelivery(String(payload.meetingId || "")) || null,
      };
    }
  }

  async function handleMeetingWebhookPayload(rawPayload: Record<string, unknown> = {}) {
    const payload = normalizeMeetingWebhookPayload(
      rawPayload as Parameters<typeof normalizeMeetingWebhookPayload>[0],
    );
    if (!payload.event) return { ok: false, error: "missing_webhook_event" };
    const payloadAsSlack = payload as unknown as SlackPayloadLike;
    if (payload.event === "meeting.joined") return await handleMeetingWebhookJoined(payloadAsSlack);
    if (payload.event === "meeting.processing")
      return await handleMeetingWebhookProcessing(payloadAsSlack);
    if (payload.event === "meeting.result") return await handleMeetingWebhookResult(payloadAsSlack);
    if (payload.event === "meeting.digest") {
      return await meetingCopilotRunner.enqueue(
        payload as unknown as Parameters<typeof meetingCopilotRunner.enqueue>[0],
      );
    }
    return {
      ok: true,
      skipped: true,
      event: payload.event,
      reason: "unknown_meeting_webhook_event",
    };
  }

  return {
    assistantStatusTextForJob,
    assistantThreadRefFromEvent,
    handleMeetingWebhookPayload,
    postSlackMessage,
    scheduleSlackAssistantThreadStatus,
    setSlackAssistantSuggestedPrompts,
  };
}
