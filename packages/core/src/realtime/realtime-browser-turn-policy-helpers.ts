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

  interface FunctionToolDeliveryOptions {
    sendOutput?: boolean;
    handledOutputChannel?: string;
  }

  interface FunctionToolErrorInput {
    kind: "worker" | "meet" | "workspace" | "avatar";
    name: string;
    callId: string;
    error: unknown;
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
    shouldVoiceAckWorkerResult(job: any): boolean;
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
      shouldVoiceAckWorkerResult,
      buildWorkerResultVoiceText,
      buildWorkerResultText,
      meetingEvents,
    } = deps;

    function resultRecord(value: unknown): Record<string, unknown> {
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    }

    function errorMessage(error: unknown): string {
      return String((error as { message?: string })?.message || error || "tool_error").slice(
        0,
        500,
      );
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

    function appControlResultRecords(result: unknown): Record<string, unknown>[] {
      const record = resultRecord(result);
      const records = [record];
      const nested = resultRecord(record.result);
      if (Object.keys(nested).length > 0) {
        records.push(nested);
      }
      return records;
    }

    function resultActions(result: unknown): string[] {
      return appControlResultRecords(result).flatMap((record) => {
        const actions = record.actions;
        return Array.isArray(actions)
          ? actions
              .map((action) =>
                String(action || "")
                  .trim()
                  .toLowerCase(),
              )
              .filter(Boolean)
          : [];
      });
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

    function numberOrUndefined(value: unknown): number | undefined {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? numberValue : undefined;
    }

    function booleanOrUndefined(value: unknown): boolean | undefined {
      return typeof value === "boolean" ? value : undefined;
    }

    function assignString(
      target: Record<string, unknown>,
      key: string,
      value: unknown,
      maxLength = 500,
    ) {
      const text = String(value || "").trim();
      if (text) target[key] = text.slice(0, maxLength);
    }

    function assignNumber(target: Record<string, unknown>, key: string, value: unknown) {
      const numberValue = numberOrUndefined(value);
      if (numberValue !== undefined) target[key] = numberValue;
    }

    function assignBoolean(target: Record<string, unknown>, key: string, value: unknown) {
      const boolValue = booleanOrUndefined(value);
      if (boolValue !== undefined) target[key] = boolValue;
    }

    function compactActionList(value: unknown) {
      if (!Array.isArray(value)) return undefined;
      const actions = value
        .map((action) => String(action || "").trim())
        .filter(Boolean)
        .slice(0, 12)
        .map((action) => action.slice(0, 160));
      return actions.length ? actions : undefined;
    }

    function compactFrame(value: unknown) {
      const frame = resultRecord(value);
      const compact: Record<string, unknown> = {};
      assignNumber(compact, "x", frame.x);
      assignNumber(compact, "y", frame.y);
      assignNumber(compact, "width", frame.width);
      assignNumber(compact, "height", frame.height);
      return Object.keys(compact).length ? compact : undefined;
    }

    function compactShareableApp(value: unknown) {
      const app = resultRecord(value);
      const compact: Record<string, unknown> = {};
      assignString(compact, "applicationName", app.applicationName || app.appName || app.name);
      assignString(compact, "title", app.title || app.windowTitle || app.name);
      assignString(compact, "bundleIdentifier", app.bundleIdentifier || app.bundleId);
      assignString(compact, "source", app.source);
      assignNumber(compact, "windowId", app.windowId || app.windowID);
      assignNumber(compact, "processId", app.processId || app.pid);
      const frame = compactFrame(app.frame);
      if (frame) compact.frame = frame;
      return compact;
    }

    function compactScreenShareState(value: unknown) {
      const screenShare = resultRecord(value);
      const compact: Record<string, unknown> = {};
      assignBoolean(compact, "active", screenShare.active);
      assignBoolean(compact, "ok", screenShare.ok);
      assignString(compact, "mode", screenShare.mode);
      assignString(
        compact,
        "applicationName",
        screenShare.applicationName || screenShare.appName || screenShare.name,
      );
      assignString(
        compact,
        "bundleIdentifier",
        screenShare.bundleIdentifier || screenShare.bundleId,
      );
      assignString(compact, "windowTitle", screenShare.windowTitle);
      assignString(compact, "title", screenShare.title);
      assignString(compact, "subtitle", screenShare.subtitle);
      assignString(compact, "source", screenShare.source);
      assignNumber(compact, "windowId", screenShare.windowId || screenShare.windowID);
      assignNumber(compact, "processId", screenShare.processId || screenShare.pid);
      assignNumber(compact, "width", screenShare.width);
      assignNumber(compact, "height", screenShare.height);
      assignNumber(compact, "fps", screenShare.fps);
      assignNumber(compact, "frames", screenShare.frames);
      assignBoolean(compact, "imageReady", screenShare.imageReady);
      assignBoolean(compact, "videoReady", screenShare.videoReady);
      assignString(compact, "startedAt", screenShare.startedAt);
      assignString(compact, "stoppedAt", screenShare.stoppedAt);
      return Object.keys(compact).length ? compact : undefined;
    }

    function compactShareResult(input: FunctionToolPolicyInput, result: unknown) {
      const record = resultRecord(result);
      const compact: Record<string, unknown> = {
        ok: record.ok !== false,
      };
      assignString(compact, "status", record.status);
      assignString(compact, "error", record.error);
      assignString(compact, "detail", record.detail);
      assignString(compact, "note", record.note);
      assignString(compact, "source", record.source);
      assignNumber(compact, "count", record.count);
      assignString(compact, "session_id", resultSessionId(record));

      if (Array.isArray(record.applications)) {
        compact.applications = record.applications.slice(0, 20).map(compactShareableApp);
        compact.count = numberOrUndefined(record.count) ?? record.applications.length;
      }

      const app = compactShareableApp(record.app);
      if (Object.keys(app).length) compact.app = app;

      const screenShare = [
        compactScreenShareState(record.screenShare),
        compactScreenShareState(nestedRecord(record, "state")),
        compactScreenShareState(nestedRecord(record, "postcheck").screenShare),
        compactScreenShareState(nestedRecord(record, "present").screenShare),
        compactScreenShareState(
          nestedRecord(nestedRecord(record, "present"), "postcheck").screenShare,
        ),
        compactScreenShareState(nestedRecord(record, "start").screenShare),
        compactScreenShareState(nestedRecord(nestedRecord(record, "capture"), "loop").update),
      ].reduce<Record<string, unknown>>(
        (merged, candidate) => (candidate ? Object.assign(merged, candidate) : merged),
        {},
      );
      if (Object.keys(screenShare).length) compact.screenShare = screenShare;

      const capture = resultRecord(record.capture);
      if (Object.keys(capture).length) {
        const captureSummary: Record<string, unknown> = {};
        assignString(captureSummary, "mode", capture.mode);
        assignString(captureSummary, "source", capture.source);
        assignNumber(captureSummary, "width", capture.width || capture.sourceWidth);
        assignNumber(captureSummary, "height", capture.height || capture.sourceHeight);
        assignNumber(captureSummary, "windowId", capture.windowId || capture.windowID);
        if (Object.keys(captureSummary).length) compact.capture = captureSummary;
      }

      return compact;
    }

    function compactAppControlResult(result: unknown, depth = 0) {
      const record = resultRecord(result);
      const compact: Record<string, unknown> = {};
      assignBoolean(compact, "ok", record.ok);
      assignString(compact, "status", record.status);
      assignString(compact, "provider", record.provider);
      assignString(compact, "error", record.error);
      assignString(compact, "blocker", record.blocker);
      assignString(compact, "reason", record.reason);
      assignString(
        compact,
        "displayText",
        record.displayText || record.display_text || record.answer_hint_en || record.answerHintEn,
        80,
      );
      assignString(compact, "summary", record.summary, 800);
      assignString(compact, "answer_hint_en", record.answer_hint_en || record.answerHintEn, 240);
      assignString(compact, "created_at", record.created_at || record.createdAt);
      assignString(compact, "started_at", record.started_at || record.startedAt);
      assignString(compact, "finished_at", record.finished_at || record.finishedAt);
      const jobId = firstNonEmptyString(
        record.job_id,
        record.jobId,
        resultRecord(record.job).id,
        resultRecord(record.report).id,
      );
      if (jobId) compact.job_id = jobId;
      assignString(compact, "session_id", record.session_id || record.sessionId);
      assignNumber(compact, "operations", record.operations);
      assignNumber(compact, "confidence", record.confidence);
      const actions = compactActionList(record.actions);
      if (actions) compact.actions = actions;
      if (record.screenShare !== undefined) {
        compact.screenShare = compactScreenShareState(record.screenShare) || null;
      }
      if (record.currentShareStatus !== undefined) {
        compact.currentShareStatus = compactScreenShareState(record.currentShareStatus) || null;
      }
      const nested = resultRecord(record.result);
      if (depth < 1 && Object.keys(nested).length > 0) {
        const nestedCompact = compactAppControlResult(nested, depth + 1);
        if (Object.keys(nestedCompact).length > 0) compact.result = nestedCompact;
        if (compact.summary === undefined && nestedCompact.summary !== undefined) {
          compact.summary = nestedCompact.summary;
        }
        if (compact.actions === undefined && nestedCompact.actions !== undefined) {
          compact.actions = nestedCompact.actions;
        }
      }
      return compact;
    }

    function compactFunctionToolResult(input: FunctionToolPolicyInput, result: unknown) {
      if (
        input.kind === "meet" &&
        [
          "list_shareable_windows",
          "share_existing_app_window",
          "present_video_stage",
          "stop_video_stage",
        ].includes(input.name)
      ) {
        return compactShareResult(input, result);
      }
      if (input.name === "kwwk_computer_use") {
        return compactAppControlResult(result);
      }
      return result;
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

    function appControlExecutorStillWorking(result: unknown): boolean {
      if (resultStatus(result) === "running") return true;
      if (appControlResultRecords(result).some((record) => record.ok === false)) return false;
      const actions = resultActions(result);
      return actions.length > 0 && actions.every((action) => action === "state");
    }

    function workerResultEnvelope(job: any): Record<string, unknown> {
      return resultRecord(job?.resultEnvelope || job?.result_envelope);
    }

    function workerResultMeetingSessionId(job: any): string {
      const context = resultRecord(job?.context);
      return firstNonEmptyString(
        context.meeting_session_id,
        context.session_id,
        context.sessionId,
        job?.session_id,
        job?.sessionId,
      );
    }

    function appControlWorkerExecutorStillWorking(job: any): boolean {
      if (shouldVoiceAckWorkerResult(job)) return false;
      if (
        String(job?.status || "")
          .trim()
          .toLowerCase() !== "completed"
      )
        return false;
      const envelope = workerResultEnvelope(job);
      const result = resultRecord(envelope.result);
      const actions = [job?.actions, envelope.actions, result.actions].flatMap((value) =>
        Array.isArray(value)
          ? value
              .map((action) =>
                String(action || "")
                  .trim()
                  .toLowerCase(),
              )
              .filter(Boolean)
          : [],
      );
      return actions.length > 0 && actions.every((action) => action === "state");
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
      if (policy.reason === "app_control_executor_running") return "running";
      if (["queued", "accepted", "started"].includes(status)) return "accepted";
      if (status === "running") return "running";
      if (["completed", "done", "success", "succeeded"].includes(status)) return "completed";
      if (resultRecord(result).ok === true) return "completed";
      return "running";
    }

    function functionToolPolicy(input: FunctionToolPolicyInput): RealtimeTurnPolicy {
      const { kind, name, result } = input;
      const appControlTool = name === "kwwk_computer_use";
      if (!appControlTool && resultIsBlocked(result)) {
        return {
          channel: "blocked",
          autoRespond: true,
          reason: `${kind}_tool_blocked`,
          responseInstructions:
            "The tool result failed or is blocked. State the exact blocker in one short English sentence. Do not mention ids, queues, tools, backends, routing names, or debug state.",
        };
      }

      if (kind === "worker") {
        return {
          channel: "voice",
          autoRespond: config.autoRespondToWorkerToolCalls !== false,
          reason: name === "delegate_to_worker" ? "worker_delegated" : "worker_status",
          responseInstructions:
            name === "delegate_to_worker"
              ? "Tell the user briefly in English that you will handle it; if the result is already complete, summarize it now. Do not mention internal routing names."
              : "Summarize the background status in concise English without mentioning internal routing names.",
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
              "The screen/app share result lacks active visibility evidence. State the exact blocker in one short English sentence. Do not tell the user to switch views, and do not blame Meet or the receiver.",
          };
        }
        return {
          channel: name === "send_meet_chat" ? "meet_chat" : "voice",
          autoRespond: config.autoRespondToMeetToolCalls !== false,
          reason: name === "send_meet_chat" ? "meet_chat_sent" : "meet_tool_result",
          responseInstructions:
            name === "send_meet_chat"
              ? "Confirm briefly in English that the Meet chat message was sent."
              : "Answer from the returned Meet chat messages/links in concise English.",
        };
      }

      if (kind === "workspace") {
        if (name === "current_user_identity") {
          return {
            channel: "voice",
            autoRespond: true,
            reason: "workspace_identity_resolved",
            responseInstructions:
              "If the prior user request only asked who they are, answer with the resolved identity in concise English. If the prior user request asked for their own workspace data, tasks, issues, GitHub, Linear, Slack, Notion, calendar, docs, URL, or repo lookup, continue by starting the appropriate background job using the resolved identity context instead of stopping after identity.",
          };
        }
        if (appControlTool) {
          if (resultIsBlocked(result)) {
            return {
              channel: "blocked",
              autoRespond: true,
              reason: "app_control_blocked",
              responseInstructions:
                "The app-control result failed or is blocked. State the exact blocker in one short English sentence. Do not mention ids, queues, tools, backends, routing names, or debug state.",
            };
          }
          if (appControlExecutorStillWorking(result)) {
            return {
              channel: "silent",
              autoRespond: false,
              reason: "app_control_executor_running",
              responseInstructions: "",
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
              "The app-control result completed. Summarize the visible outcome in one short English sentence without mentioning ids, queues, tools, backends, routing names, or debug state.",
          };
        }
        return {
          channel: resultIsBlocked(result) ? "blocked" : "voice",
          autoRespond: true,
          reason: resultIsBlocked(result) ? "workspace_tool_blocked" : "workspace_tool_completed",
          responseInstructions:
            "Summarize the result in concise English. If it failed, state the exact blocker without mentioning internal routing names.",
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
      if (input.name === "kwwk_computer_use") return "";
      if (policy.channel === "blocked") return "tool_result.blocked";
      if (policy.channel === "visual_only") return "tool_result.visual_only";
      if (policy.channel === "meet_chat") return "tool_result.meet_chat";
      if (policy.channel === "silent") return "tool_result.silent";
      return "tool_result.voice";
    }

    function appControlVisibleModelResult(
      input: FunctionToolPolicyInput,
      policy: RealtimeTurnPolicy,
    ) {
      if (input.name !== "kwwk_computer_use" || policy.reason !== "app_control_executor_running") {
        return input.result;
      }
      const jobId = resultJobId(input.result);
      const visible: Record<string, unknown> = {
        ok: true,
        status: "running",
        summary:
          "App-control executor is still observing, planning, acting, or verifying internally. Do not summarize completion yet.",
      };
      if (jobId) visible.job_id = jobId;
      return visible;
    }

    function sendFunctionCallOutput(callId: string, result: unknown, policy: RealtimeTurnPolicy) {
      if (!callId) return { ok: true, skipped: true, reason: "missing_call_id" };
      const outputChannel = sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          metadata: {
            source: "function_tool_output",
            policyChannel: policy.channel,
            policyReason: policy.reason,
          },
          output: JSON.stringify(result),
        },
      });
      let responseChannel = "";
      if (policy.autoRespond) {
        responseChannel = sendRealtimeEvent({
          type: "response.create",
          metadata: {
            source: "function_tool_output",
            reason: policy.reason,
          },
          response: {
            instructions: policy.responseInstructions || "Continue after applying the result.",
          },
        });
        state.responsesRequested += 1;
      }
      return { ok: true, outputChannel, responseChannel };
    }

    function functionToolModelResult(input: FunctionToolPolicyInput, policy: RealtimeTurnPolicy) {
      const result = appControlVisibleModelResult(input, policy);
      return {
        ok: resultRecord(result).ok !== false,
        result: compactFunctionToolResult(input, result),
        turnPolicy: {
          channel: policy.channel,
          autoRespond: policy.autoRespond,
          reason: policy.reason,
          instructions: policy.responseInstructions,
        },
      };
    }

    function prepareFunctionToolResult(
      input: FunctionToolPolicyInput,
      options: FunctionToolDeliveryOptions = {},
    ) {
      const policy = functionToolPolicy(input);
      const compactResult = compactFunctionToolResult(input, input.result);
      const outputResult = compactFunctionToolResult(
        input,
        appControlVisibleModelResult(input, policy),
      );
      const delivery =
        options.sendOutput === false
          ? {
              ok: true,
              skipped: true,
              reason: "caller_handles_function_call_output",
              outputChannel: String(options.handledOutputChannel || "caller_returned_output"),
              responseChannel: "",
            }
          : sendFunctionCallOutput(input.callId, outputResult, policy);
      const event =
        input.name === "kwwk_computer_use"
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
      return {
        ...delivery,
        policy,
        decision,
        meetingEvent: event,
        compactResult,
        modelResult: functionToolModelResult(input, policy),
      };
    }

    function deliverFunctionToolResult(input: FunctionToolPolicyInput) {
      return prepareFunctionToolResult(input);
    }

    function prepareFunctionToolError(
      input: FunctionToolErrorInput,
      options: FunctionToolDeliveryOptions = {},
    ) {
      return prepareFunctionToolResult(
        {
          kind: input.kind,
          name: input.name,
          callId: input.callId,
          result: {
            ok: false,
            status: "error",
            error: errorMessage(input.error),
          },
        },
        options,
      );
    }

    function deliverFunctionToolError(input: FunctionToolErrorInput) {
      return prepareFunctionToolError(input);
    }

    async function deliverWorkerResult(job, options: WorkerResultPolicyInput = {}) {
      const scope = meetingEvents.shouldDeliverWorkerResult(job);
      if (!scope.ok) return rememberSuppressedWorkerResult(job, scope.reason, scope);

      let chatDelivery = null;
      const appControlExecutorRunning = appControlWorkerExecutorStillWorking(job);
      const sendToMeetChat = !appControlExecutorRunning && shouldSendWorkerResultToMeetChat(job);
      const voiceAck = shouldVoiceAckWorkerResult(job);
      if (sendToMeetChat) {
        chatDelivery = await sendMeetChat({ text: buildWorkerResultChatText(job) }).catch(
          (error) => ({
            ok: false,
            error: String((error && error.message) || error),
          }),
        );
      }
      const policy: RealtimeTurnPolicy = {
        channel: appControlExecutorRunning ? "silent" : sendToMeetChat ? "meet_chat" : "voice",
        autoRespond: appControlExecutorRunning
          ? false
          : voiceAck && config.autoRespondToWorkerResults !== false,
        reason: appControlExecutorRunning
          ? "app_control_executor_running"
          : sendToMeetChat
            ? voiceAck
              ? "worker_result_sent_to_meet_chat"
              : "app_control_result_sent_to_meet_chat"
            : "worker_result_voice_summary",
        responseInstructions: appControlExecutorRunning
          ? ""
          : "Summarize the completed background result proactively in concise English without mentioning internal routing names.",
      };
      let itemChannel = "";
      if (!appControlExecutorRunning && (voiceAck || !sendToMeetChat)) {
        itemChannel = sendRealtimeEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "system",
            metadata: {
              source: "worker_result",
              jobId: job.id || "",
            },
            content: [
              {
                type: "input_text",
                text: sendToMeetChat
                  ? buildWorkerResultVoiceText(job, chatDelivery)
                  : buildWorkerResultText(job),
              },
            ],
          },
        });
      }
      let responseChannel = "";
      if (policy.autoRespond) {
        responseChannel = sendRealtimeEvent({
          type: "response.create",
          metadata: {
            source: appControlExecutorRunning ? "app_control" : "worker_result",
            reason: policy.reason,
          },
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
      const sessionId = workerResultMeetingSessionId(job);
      const event = appControlExecutorRunning
        ? meetingEvents.rememberMeetingEvent({
            type: "app_control.running",
            source: "app_control",
            sessionId,
            turnId: job.id || "",
            jobId: job.id || "",
            status: "running",
            visibility: policy.channel,
            interruptible: meetingEvents.eventIsInterruptible(policy.channel),
            reason: policy.reason,
            detail: {
              chatOk: false,
              interruptedResponse: Boolean(
                options.interrupt && !(options.interrupt as any).skipped,
              ),
              workerStatus: job.status || "",
            },
          })
        : meetingEvents.rememberMeetingEvent({
            type: `worker_result.${String(job.status || "completed").toLowerCase()}`,
            source: "worker",
            sessionId,
            turnId: job.id || "",
            jobId: job.id || "",
            status: job.status || "",
            visibility: policy.channel,
            interruptible: meetingEvents.eventIsInterruptible(policy.channel),
            reason: policy.reason,
            detail: {
              chatOk: chatDelivery ? chatDelivery.ok === true : false,
              interruptedResponse: Boolean(
                options.interrupt && !(options.interrupt as any).skipped,
              ),
            },
          });
      if (appControlExecutorRunning) {
        meetingEvents.rememberAppControlJob({
          event,
          sessionId,
          callId: "",
          jobId: job.id || "",
          status: "running",
          visibility: policy.channel,
          interruptible: Boolean(event.interruptible),
          reason: policy.reason,
        });
      }
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
      deliverFunctionToolError,
      prepareFunctionToolResult,
      prepareFunctionToolError,
      deliverWorkerResult,
      rememberSuppressedWorkerResult,
      shouldDeliverWorkerResult: meetingEvents.shouldDeliverWorkerResult,
      isVisualShareToolName,
    };
  }

  (window as any).__MAB_REALTIME_TURN_POLICY_HELPERS = { create };
})();
