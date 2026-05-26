(() => {
  type LocalToolKind = "worker" | "meet" | "workspace" | "avatar";

  interface LocalToolRouterDeps {
    state: Record<string, any>;
    handledLocalToolCallIds: Set<string>;
    extractLocalToolCall(event: unknown): null | {
      name: string;
      callId: string;
      arguments: Record<string, unknown>;
    };
    runLocalAvatarTool(name: string, args?: Record<string, unknown>): unknown;
    runLocalWorkerTool(name: string, args?: Record<string, unknown>): unknown;
    runLocalMeetTool(name: string, args?: Record<string, unknown>): unknown;
    runLocalWorkspaceTool(name: string, args?: Record<string, unknown>): unknown;
    deliverFunctionToolResult(input: Record<string, unknown>): unknown;
    deliverFunctionToolError(input: Record<string, unknown>): unknown;
    prepareFunctionToolResult(
      input: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Record<string, any>;
    prepareFunctionToolError(
      input: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Record<string, any>;
    rememberAvatarToolCall(call: Record<string, unknown>): void;
    rememberAvatarToolError(error: unknown, detail?: Record<string, unknown>): void;
    rememberWorkerToolCall(call: Record<string, unknown>): void;
    rememberWorkerToolError(error: unknown, detail?: Record<string, unknown>): void;
    rememberMeetToolCall(call: Record<string, unknown>): void;
    rememberMeetToolError(error: unknown, detail?: Record<string, unknown>): void;
    rememberWorkspaceToolCall(call: Record<string, unknown>): void;
    rememberWorkspaceToolError(error: unknown, detail?: Record<string, unknown>): void;
    recordTimeline(type: string, detail?: Record<string, unknown>): void;
    updateFeedback(): unknown;
  }

  const localAvatarTools = new Set([
    "set_avatar_expression",
    "set_avatar_action",
    "update_avatar_state",
  ]);
  const localWorkerTools = new Set([
    "delegate_to_worker",
    "worker_status",
    "delegate_to_codex",
    "delegate_status",
  ]);
  const localMeetTools = new Set([
    "send_meet_chat",
    "present_video_stage",
    "stop_video_stage",
    "list_shareable_windows",
    "share_existing_app_window",
    "list_shareable_apps",
    "present_app_share",
    "read_meet_chat",
    "meet_participants",
    "active_speaker",
  ]);
  const localWorkspaceTools = new Set([
    "current_user_identity",
    "resolve_speaker_identity",
    "search_team_members",
    "linear_query",
    "linear_user_issues",
    "google_calendar",
    "calendar_attendees",
    "slack_search",
    "notion_search",
    "github_search",
    "fetch_url",
    "open_shared_browser_surface",
    "create_shared_workspace",
    "control_shared_app_window",
    "control_shared_browser_surface",
    "stop_shared_browser_surface",
    "start_demo_surface",
    "start_demo_execution",
    "control_demo_surface",
    "cancel_demo_surface",
    "memory_write",
    "memory_read",
    "now",
  ]);

  function isLocalToolName(name: string) {
    return (
      localAvatarTools.has(name) ||
      localWorkerTools.has(name) ||
      localMeetTools.has(name) ||
      localWorkspaceTools.has(name)
    );
  }

  function localToolKind(name: string): LocalToolKind {
    if (localWorkerTools.has(name)) return "worker";
    if (localMeetTools.has(name)) return "meet";
    if (localWorkspaceTools.has(name)) return "workspace";
    return "avatar";
  }

  function createToolState(state: Record<string, any>) {
    function rememberToolCall(kind: LocalToolKind, call: Record<string, unknown>) {
      state[`${kind}Tools`].calls.push({ ts: new Date().toISOString(), ...call });
      state[`${kind}Tools`].calls = state[`${kind}Tools`].calls.slice(-40);
    }

    function rememberToolError(
      kind: LocalToolKind,
      error: unknown,
      detail: Record<string, unknown> = {},
    ) {
      state[`${kind}Tools`].errors.push({
        ts: new Date().toISOString(),
        message: String((error as { message?: string })?.message || error).slice(0, 400),
        ...detail,
      });
      state[`${kind}Tools`].errors = state[`${kind}Tools`].errors.slice(-20);
    }

    return {
      rememberAvatarToolCall: (call: Record<string, unknown>) => rememberToolCall("avatar", call),
      rememberAvatarToolError: (error: unknown, detail = {}) =>
        rememberToolError("avatar", error, detail),
      rememberWorkerToolCall: (call: Record<string, unknown>) => rememberToolCall("worker", call),
      rememberWorkerToolError: (error: unknown, detail = {}) =>
        rememberToolError("worker", error, detail),
      rememberMeetToolCall: (call: Record<string, unknown>) => rememberToolCall("meet", call),
      rememberMeetToolError: (error: unknown, detail = {}) =>
        rememberToolError("meet", error, detail),
      rememberWorkspaceToolCall: (call: Record<string, unknown>) =>
        rememberToolCall("workspace", call),
      rememberWorkspaceToolError: (error: unknown, detail = {}) =>
        rememberToolError("workspace", error, detail),
    };
  }

  function create(deps: LocalToolRouterDeps) {
    function runLocalToolByKind(kind: LocalToolKind, name: string, args = {}) {
      if (kind === "worker") return deps.runLocalWorkerTool(name, args);
      if (kind === "meet") return deps.runLocalMeetTool(name, args);
      if (kind === "workspace") return deps.runLocalWorkspaceTool(name, args);
      return deps.runLocalAvatarTool(name, args);
    }

    function rememberLocalToolCallByKind(kind: LocalToolKind, call: Record<string, unknown>) {
      if (kind === "worker") deps.rememberWorkerToolCall(call);
      else if (kind === "meet") deps.rememberMeetToolCall(call);
      else if (kind === "workspace") deps.rememberWorkspaceToolCall(call);
      else deps.rememberAvatarToolCall(call);
    }

    function rememberLocalToolErrorByKind(
      kind: LocalToolKind,
      error: unknown,
      detail: Record<string, unknown>,
    ) {
      if (kind === "worker") deps.rememberWorkerToolError(error, detail);
      else if (kind === "meet") deps.rememberMeetToolError(error, detail);
      else if (kind === "workspace") deps.rememberWorkspaceToolError(error, detail);
      else deps.rememberAvatarToolError(error, detail);
    }

    async function runLocalToolForSDK(name: string, args = {}, callId = "") {
      deps.recordTimeline("realtime_agent_sdk_tool_start", { name, callId });
      const kind = localToolKind(name);
      try {
        const result = await runLocalToolByKind(kind, name, args);
        const delivery = deps.prepareFunctionToolResult(
          { kind, name, callId, result },
          { sendOutput: false },
        );
        const call = { name, callId, arguments: args, result, runtime: "agents-sdk", delivery };
        rememberLocalToolCallByKind(kind, call);
        deps.recordTimeline("realtime_agent_sdk_tool_end", { name, callId, ok: true });
        deps.updateFeedback();
        return { result, delivery };
      } catch (error) {
        deps.recordTimeline("realtime_agent_sdk_tool_end", {
          name,
          callId,
          ok: false,
          error: String((error as { message?: string })?.message || error).slice(0, 300),
        });
        rememberLocalToolErrorByKind(kind, error, { name, callId });
        const delivery = deps.prepareFunctionToolError(
          { kind, name, callId, error },
          { sendOutput: false },
        );
        deps.updateFeedback();
        return { result: delivery.modelResult, delivery };
      }
    }

    function handleLocalToolCallEvent(event: unknown) {
      const toolCall = deps.extractLocalToolCall(event);
      if (!toolCall) return null;
      const toolCallKey = toolCall.callId ? `${toolCall.name}:${toolCall.callId}` : "";
      if (toolCallKey && deps.handledLocalToolCallIds.has(toolCallKey)) {
        deps.state.protection.duplicateLocalToolCallsSkipped += 1;
        deps.recordTimeline("duplicate_local_tool_call_skipped", {
          name: toolCall.name,
          callId: toolCall.callId,
          eventType: (event as { type?: string })?.type,
        });
        deps.updateFeedback();
        return { ok: true, duplicate: true, name: toolCall.name, callId: toolCall.callId };
      }
      if (toolCallKey) {
        deps.handledLocalToolCallIds.add(toolCallKey);
        deps.state.protection.handledLocalToolCallIds = Array.from(
          deps.handledLocalToolCallIds,
        ).slice(-80);
      }
      const kind = localToolKind(toolCall.name);
      return Promise.resolve()
        .then(() => runLocalToolByKind(kind, toolCall.name, toolCall.arguments))
        .then((result) => {
          const delivery = deps.deliverFunctionToolResult({
            kind,
            name: toolCall.name,
            callId: toolCall.callId,
            result,
          });
          rememberLocalToolCallByKind(kind, {
            name: toolCall.name,
            callId: toolCall.callId,
            arguments: toolCall.arguments,
            result,
            delivery,
          });
          return { ok: true, result, delivery };
        })
        .catch((error) => {
          rememberLocalToolErrorByKind(kind, error, {
            name: toolCall.name,
            callId: toolCall.callId,
          });
          const delivery = deps.deliverFunctionToolError({
            kind,
            name: toolCall.name,
            callId: toolCall.callId,
            error,
          });
          return {
            ok: false,
            error: String((error as { message?: string })?.message || error),
            delivery,
          };
        });
    }

    return { runLocalToolForSDK, handleLocalToolCallEvent };
  }

  (window as any).__MAB_REALTIME_LOCAL_TOOL_ROUTER_HELPERS = {
    create,
    createToolState,
    isLocalToolName,
    localWorkspaceTools,
  };
})();
