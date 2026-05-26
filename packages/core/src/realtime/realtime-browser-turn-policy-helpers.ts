(() => {
  type TurnPolicyChannel = "voice" | "meet_chat" | "visual_only" | "silent" | "blocked";
  type AppControlEventStatus = "accepted" | "running" | "completed" | "blocked";

  interface FunctionToolPolicyInput {
    kind: "worker" | "meet" | "workspace" | "avatar";
    name: string;
    callId: string;
    result: unknown;
  }

  interface WorkerResultPolicyInput {
    interrupt?: unknown;
  }

  interface WorkerResultScope {
    ok: boolean;
    reason: string;
    currentSessionId: string;
    jobSessionId: string;
  }

  interface MeetingEventHelpers {
    rememberMeetingEvent(input: Record<string, unknown>): Record<string, unknown>;
    rememberAppControlJob(input: Record<string, unknown>): Record<string, unknown> | null;
    shouldDeliverWorkerResult(job: any): WorkerResultScope;
    eventIsInterruptible(channel: TurnPolicyChannel): boolean;
  }

  interface RealtimeTurnPolicyDeps {
    config: Record<string, unknown>;
    state: Record<string, any>;
    sendRealtimeEvent(event: unknown): string;
    sendMeetChat(input: { text: string }): Promise<any>;
    recordTimeline(type: string, detail?: Record<string, unknown>): void;
    buildWorkerResultChatText(job: any): string;
    shouldSendWorkerResultToMeetChat(job: any): boolean;
    buildWorkerResultVoiceText(job: any, chatDelivery: any): string;
    buildWorkerResultText(job: any): string;
    meetingEvents: MeetingEventHelpers;
  }

  interface RealtimeTurnPolicy {
    channel: TurnPolicyChannel;
    autoRespond: boolean;
    reason: string;
    responseInstructions: string;
  }

  function create(deps: RealtimeTurnPolicyDeps) {
    const {
      config,
      state,
      sendRealtimeEvent,
      sendMeetChat,
      recordTimeline,
      buildWorkerResultChatText,
      shouldSendWorkerResultToMeetChat,
      buildWorkerResultVoiceText,
      buildWorkerResultText,
      meetingEvents,
    } = deps;

    function resultRecord(value: unknown): Record<string, unknown> {
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    }

    function firstNonEmptyString(...values: unknown[]): string {
      for (const value of values) {
        const text = String(value || "").trim();
        if (text) return text;
      }
      return "";
    }

    function nestedRecord(value: unknown, key: string): Record<string, unknown> {
      return resultRecord(resultRecord(value)[key]);
    }

    function isVisualShareToolName(name: string) {
      return /share|stage/i.test(name);
    }

    function resultStatus(result: unknown): string {
      return String(resultRecord(result).status || "")
        .trim()
        .toLowerCase();
    }

    function resultJobId(result: unknown): string {
      const record = resultRecord(result);
      return firstNonEmptyString(
        record.job_id,
        record.jobId,
        record.id,
        resultRecord(record.job).id,
        resultRecord(record.result).job_id,
        resultRecord(record.result).jobId,
        resultRecord(record.result).id,
      );
    }

    function resultSessionId(result: unknown): string {
      const record = resultRecord(result);
      return firstNonEmptyString(
        record.session_id,
        record.sessionId,
        resultRecord(record.screenShare).session_id,
        resultRecord(record.screenShare).sessionId,
        state.sessionId,
        config.sessionId,
      );
    }

    function resultActions(result: unknown): string[] {
      const actions = resultRecord(result).actions;
      return Array.isArray(actions)
        ? actions
            .map((action) =>
              String(action || "")
                .trim()
                .toLowerCase(),
            )
            .filter(Boolean)
        : [];
    }

    function resultHasActiveScreenShare(value: unknown): boolean {
      const direct = resultRecord(value);
      const candidates = [
        nestedRecord(direct, "screenShare"),
        nestedRecord(direct, "state"),
        nestedRecord(nestedRecord(direct, "postcheck"), "screenShare"),
        nestedRecord(nestedRecord(direct, "present"), "screenShare"),
        nestedRecord(nestedRecord(nestedRecord(direct, "present"), "postcheck"), "screenShare"),
        nestedRecord(nestedRecord(direct, "start"), "screenShare"),
      ];
      return candidates.some((candidate) => candidate.active === true);
    }

    function resultIsBlocked(result: unknown): boolean {
      const record = resultRecord(result);
      const status = resultStatus(record);
      return (
        record.ok === false ||
        status === "failed" ||
        status === "blocked" ||
        status === "timeout" ||
        status === "error"
      );
    }

    function appControlNeedsPrimitiveFollowup(result: unknown): boolean {
      const record = resultRecord(result);
      const actions = resultActions(record);
      const text = [record.reason, record.error, record.summary]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase())
        .join("\n");
      return (
        (actions.length > 0 && actions.every((action) => action === "state")) ||
        text.includes("structured_operations_required") ||
        text.includes("continue with concrete")
      );
    }

    function appControlIsAsyncAccepted(result: unknown): boolean {
      return ["accepted", "queued", "running", "started"].includes(resultStatus(result));
    }

    function appControlEventStatus(
      result: unknown,
      policy: RealtimeTurnPolicy,
    ): AppControlEventStatus {
      const status = resultStatus(result);
      if (policy.channel === "blocked" || resultIsBlocked(result)) return "blocked";
      if (policy.reason === "app_control_needs_primitive_followup") return "running";
      if (["queued", "accepted", "started"].includes(status)) return "accepted";
      if (status === "running") return "running";
      if (["completed", "done", "success", "succeeded"].includes(status)) return "completed";
      if (resultRecord(result).ok === true) return "completed";
      return "running";
    }

    function functionToolPolicy(input: FunctionToolPolicyInput): RealtimeTurnPolicy {
      const { kind, name, result } = input;
      if (kind === "worker") {
        return {
          channel: "voice",
          autoRespond: config.autoRespondToWorkerToolCalls !== false,
          reason: name === "delegate_to_worker" ? "worker_delegated" : "worker_status",
          responseInstructions:
            name === "delegate_to_worker"
              ? "Tell the user briefly in Chinese that you will handle it; if the result is already complete, summarize it now. Do not mention internal routing names."
              : "Summarize the background status in concise Chinese without mentioning internal routing names.",
        };
      }

      if (kind === "meet") {
        if (isVisualShareToolName(name) && resultRecord(result).ok === true) {
          if (resultHasActiveScreenShare(result)) {
            return {
              channel: "visual_only",
              autoRespond: false,
              reason: "active_share_visible",
              responseInstructions: "",
            };
          }
          return {
            channel: "blocked",
            autoRespond: config.autoRespondToMeetToolCalls !== false,
            reason: "share_lacks_active_evidence",
            responseInstructions:
              "The screen/app share result lacks active visibility evidence. State the exact blocker in one short Chinese sentence. Do not tell the user to switch views, and do not blame Meet or the receiver.",
          };
        }
        return {
          channel: name === "send_meet_chat" ? "meet_chat" : "voice",
          autoRespond: config.autoRespondToMeetToolCalls !== false,
          reason: name === "send_meet_chat" ? "meet_chat_sent" : "meet_tool_result",
          responseInstructions:
            name === "send_meet_chat"
              ? "Confirm briefly in Chinese that the Meet chat message was sent."
              : "Answer from the returned Meet chat messages/links in concise Chinese.",
        };
      }

      if (kind === "workspace") {
        if (name === "control_shared_app_window") {
          if (resultIsBlocked(result)) {
            return {
              channel: "blocked",
              autoRespond: true,
              reason: "app_control_blocked",
              responseInstructions:
                "The app-control result failed or is blocked. State the exact blocker in one short Chinese sentence. Do not mention ids, queues, tools, backends, routing names, or debug state.",
            };
          }
          if (appControlNeedsPrimitiveFollowup(result)) {
            return {
              channel: "silent",
              autoRespond: true,
              reason: "app_control_needs_primitive_followup",
              responseInstructions:
                "The app-control result only captured state or requires structured operations. Do not summarize yet; Continue by calling control_shared_app_window again with concrete primitive operations such as click, type_text, press_key, scroll, or drag.",
            };
          }
          if (appControlIsAsyncAccepted(result)) {
            return {
              channel: "silent",
              autoRespond: false,
              reason: "app_control_async_accepted",
              responseInstructions: "",
            };
          }
          return {
            channel: "voice",
            autoRespond: true,
            reason: "app_control_completed",
            responseInstructions:
              "The app-control result completed. Summarize the visible outcome in one short Chinese sentence without mentioning ids, queues, tools, backends, routing names, or debug state.",
          };
        }
        return {
          channel: resultIsBlocked(result) ? "blocked" : "voice",
          autoRespond: true,
          reason: resultIsBlocked(result) ? "workspace_tool_blocked" : "workspace_tool_completed",
          responseInstructions:
            "Summarize the result in concise Chinese. If it failed, state the exact blocker without mentioning internal routing names.",
        };
      }

      return {
        channel: "visual_only",
        autoRespond: config.autoRespondToAvatarToolCalls === true,
        reason: "avatar_visual_state",
        responseInstructions: "Continue after applying the avatar visual state.",
      };
    }

    function rememberPolicy(scope: string, detail: Record<string, unknown>) {
      state.turnPolicy = state.turnPolicy || { decisions: [] };
      const entry = { ts: new Date().toISOString(), scope, ...detail };
      state.turnPolicy.decisions.push(entry);
      state.turnPolicy.decisions = state.turnPolicy.decisions.slice(-80);
      recordTimeline("realtime_turn_policy", {
        scope,
        channel: detail.channel,
        reason: detail.reason,
        name: detail.name,
        callId: detail.callId,
      });
      return entry;
    }

    function rememberAppControlEvent(input: FunctionToolPolicyInput, policy: RealtimeTurnPolicy) {
      const jobId = resultJobId(input.result);
      const status = appControlEventStatus(input.result, policy);
      const sessionId = resultSessionId(input.result);
      const event = meetingEvents.rememberMeetingEvent({
        type: `app_control.${status}`,
        source: "app_control",
        sessionId,
        turnId: firstNonEmptyString(jobId, input.callId),
        callId: input.callId,
        jobId,
        toolName: input.name,
        status,
        visibility: policy.channel,
        interruptible: meetingEvents.eventIsInterruptible(policy.channel),
        reason: policy.reason,
        detail: {
          rawStatus: resultStatus(input.result),
          hasJobId: Boolean(jobId),
        },
      });
      if (jobId) {
        meetingEvents.rememberAppControlJob({
          event,
          sessionId,
          callId: input.callId,
          jobId,
          status,
          visibility: policy.channel,
          interruptible: Boolean(event.interruptible),
          reason: policy.reason,
        });
      }
      return event;
    }

    function functionToolEventType(input: FunctionToolPolicyInput, policy: RealtimeTurnPolicy) {
      if (input.name === "control_shared_app_window") return "";
      if (policy.channel === "blocked") return "tool_result.blocked";
      if (policy.channel === "visual_only") return "tool_result.visual_only";
      if (policy.channel === "meet_chat") return "tool_result.meet_chat";
      if (policy.channel === "silent") return "tool_result.silent";
      return "tool_result.voice";
    }

    function sendFunctionCallOutput(callId: string, result: unknown, policy: RealtimeTurnPolicy) {
      if (!callId) return { ok: true, skipped: true, reason: "missing_call_id" };
      const outputChannel = sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(result),
        },
      });
      let responseChannel = "";
      if (policy.autoRespond) {
        responseChannel = sendRealtimeEvent({
          type: "response.create",
          response: {
            instructions: policy.responseInstructions || "Continue after applying the result.",
          },
        });
        state.responsesRequested += 1;
      }
      return { ok: true, outputChannel, responseChannel };
    }

    function deliverFunctionToolResult(input: FunctionToolPolicyInput) {
      const policy = functionToolPolicy(input);
      const delivery = sendFunctionCallOutput(input.callId, input.result, policy);
      const event =
        input.name === "control_shared_app_window"
          ? rememberAppControlEvent(input, policy)
          : meetingEvents.rememberMeetingEvent({
              type: functionToolEventType(input, policy),
              source: input.kind,
              sessionId: resultSessionId(input.result),
              turnId: input.callId,
              callId: input.callId,
              toolName: input.name,
              status: resultStatus(input.result),
              visibility: policy.channel,
              interruptible: meetingEvents.eventIsInterruptible(policy.channel),
              reason: policy.reason,
            });
      const decision = rememberPolicy("function_tool", {
        kind: input.kind,
        name: input.name,
        callId: input.callId,
        channel: policy.channel,
        reason: policy.reason,
        autoRespond: policy.autoRespond,
        outputChannel: delivery.outputChannel || "",
        responseChannel: delivery.responseChannel || "",
      });
      return { ...delivery, policy, decision, meetingEvent: event };
    }

    async function deliverWorkerResult(job, options: WorkerResultPolicyInput = {}) {
      const scope = meetingEvents.shouldDeliverWorkerResult(job);
      if (!scope.ok) return rememberSuppressedWorkerResult(job, scope.reason, scope);

      let chatDelivery = null;
      if (shouldSendWorkerResultToMeetChat(job)) {
        chatDelivery = await sendMeetChat({ text: buildWorkerResultChatText(job) }).catch(
          (error) => ({
            ok: false,
            error: String((error && error.message) || error),
          }),
        );
      }
      const policy: RealtimeTurnPolicy = {
        channel: chatDelivery ? "meet_chat" : "voice",
        autoRespond: config.autoRespondToWorkerResults !== false,
        reason: chatDelivery ? "worker_result_sent_to_meet_chat" : "worker_result_voice_summary",
        responseInstructions:
          "Summarize the completed background result proactively in concise Chinese without mentioning internal routing names.",
      };
      const itemChannel = sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: chatDelivery
                ? buildWorkerResultVoiceText(job, chatDelivery)
                : buildWorkerResultText(job),
            },
          ],
        },
      });
      let responseChannel = "";
      if (policy.autoRespond) {
        responseChannel = sendRealtimeEvent({
          type: "response.create",
          response: { instructions: policy.responseInstructions },
        });
        state.responsesRequested += 1;
      }
      const decision = rememberPolicy("worker_result", {
        name: "worker_result",
        jobId: job.id || "",
        status: job.status || "",
        channel: policy.channel,
        reason: policy.reason,
        autoRespond: policy.autoRespond,
        itemChannel,
        responseChannel,
      });
      const event = meetingEvents.rememberMeetingEvent({
        type: `worker_result.${String(job.status || "completed").toLowerCase()}`,
        source: "worker",
        sessionId: firstNonEmptyString(
          resultRecord(job.context).meeting_session_id,
          resultRecord(job.context).session_id,
          resultRecord(job.context).sessionId,
          job.session_id,
          job.sessionId,
        ),
        turnId: job.id || "",
        jobId: job.id || "",
        status: job.status || "",
        visibility: policy.channel,
        interruptible: meetingEvents.eventIsInterruptible(policy.channel),
        reason: policy.reason,
        detail: {
          chatOk: chatDelivery ? chatDelivery.ok === true : false,
          interruptedResponse: Boolean(options.interrupt && !(options.interrupt as any).skipped),
        },
      });
      return {
        ts: new Date().toISOString(),
        jobId: job.id,
        status: job.status,
        interrupt: options.interrupt,
        meetChat: chatDelivery,
        itemChannel,
        responseChannel,
        policy,
        decision,
        meetingEvent: event,
      };
    }

    function rememberSuppressedWorkerResult(
      job: any,
      reason = "worker_result_suppressed",
      scope: WorkerResultScope = meetingEvents.shouldDeliverWorkerResult(job),
    ) {
      const policy: RealtimeTurnPolicy = {
        channel: "silent",
        autoRespond: false,
        reason,
        responseInstructions: "",
      };
      const decision = rememberPolicy("worker_result", {
        name: "worker_result",
        jobId: job?.id || "",
        status: job?.status || "",
        channel: policy.channel,
        reason,
        autoRespond: false,
      });
      const event = meetingEvents.rememberMeetingEvent({
        type: "worker_result.suppressed",
        source: "worker",
        sessionId: scope.jobSessionId || scope.currentSessionId,
        turnId: job?.id || "",
        jobId: job?.id || "",
        status: job?.status || "",
        visibility: policy.channel,
        interruptible: false,
        reason,
        detail: {
          currentSessionId: scope.currentSessionId,
          jobSessionId: scope.jobSessionId,
        },
      });
      return {
        ts: new Date().toISOString(),
        jobId: job?.id,
        status: job?.status,
        suppressed: true,
        reason,
        policy,
        decision,
        meetingEvent: event,
      };
    }

    return {
      deliverFunctionToolResult,
      deliverWorkerResult,
      rememberSuppressedWorkerResult,
      shouldDeliverWorkerResult: meetingEvents.shouldDeliverWorkerResult,
      isVisualShareToolName,
    };
  }

  (window as any).__MAB_REALTIME_TURN_POLICY_HELPERS = { create };
})();
