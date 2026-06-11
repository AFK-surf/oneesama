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
    runLocalMeetTool(
      name: string,
      args?: Record<string, unknown>,
      meta?: Record<string, unknown>,
    ): unknown;
    runLocalWorkspaceTool(name: string, args?: Record<string, unknown>): unknown;
    isLocalToolExposed(name: string): boolean;
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
  const localWorkerTools = new Set(["delegate_to_worker", "worker_status"]);
  const localMeetTools = new Set([
    "send_meet_chat",
    "present_video_stage",
    "stop_video_stage",
    "list_shareable_windows",
    "share_existing_app_window",
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
    "kwwk_computer_use",
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

  function resultRecord(value: unknown): Record<string, any> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  }

  function compactToolStatus(result: unknown) {
    const record = resultRecord(result);
    const status = String(record.status || "")
      .trim()
      .toLowerCase();
    if (record.ok === false || ["failed", "blocked", "timeout", "error"].includes(status)) {
      return status || "blocked";
    }
    if (["completed", "done", "success", "succeeded"].includes(status)) return "completed";
    if (["accepted", "queued", "running", "started"].includes(status)) return status;
    if (record.ok === true) return "completed";
    return status || "completed";
  }

  function shouldStoreCompactToolResult(kind: LocalToolKind, name: string) {
    if (name === "kwwk_computer_use") return true;
    return (
      kind === "meet" &&
      [
        "list_shareable_windows",
        "share_existing_app_window",
        "present_video_stage",
        "stop_video_stage",
      ].includes(name)
    );
  }

  function createToolState(state: Record<string, any>) {
    function rememberToolCall(kind: LocalToolKind, call: Record<string, unknown>) {
      const calls = state[`${kind}Tools`].calls;
      const next = { ts: new Date().toISOString(), ...call };
      const callId = String(call.callId || "");
      const name = String(call.name || "");
      const existingIndex =
        callId && name
          ? calls.findIndex(
              (entry: Record<string, unknown>) =>
                String(entry.callId || "") === callId && String(entry.name || "") === name,
            )
          : -1;
      if (existingIndex >= 0) {
        calls[existingIndex] = { ...calls[existingIndex], ...next };
      } else {
        calls.push(next);
      }
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
    function runLocalToolByKind(
      kind: LocalToolKind,
      name: string,
      args = {},
      meta: Record<string, unknown> = {},
    ) {
      if (kind === "worker") return deps.runLocalWorkerTool(name, args);
      if (kind === "meet") return deps.runLocalMeetTool(name, args, meta);
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

    function assertLocalToolExposed(kind: LocalToolKind, name: string, callId = "", source = "") {
      if (deps.isLocalToolExposed(name)) return;
      deps.recordTimeline("realtime_local_tool_not_in_session_schema", {
        kind,
        name,
        callId,
        source,
        reason: "local_tool_not_in_session_schema",
      });
      throw new Error("local_tool_not_in_session_schema");
    }

    async function runLocalToolForSDK(name: string, args = {}, callId = "") {
      deps.recordTimeline("realtime_agent_sdk_tool_start", { name, callId });
      const kind = localToolKind(name);
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      rememberLocalToolCallByKind(kind, {
        name,
        callId,
        arguments: args,
        runtime: "agents-sdk",
        status: "running",
        stage: "running",
        startedAt,
        ts: startedAt,
      });
      deps.updateFeedback();
      try {
        assertLocalToolExposed(kind, name, callId, "agents_sdk_execute");
        const result = await runLocalToolByKind(kind, name, args, {
          callId,
          responseId: deps.state.responses?.activeResponseId || "",
        });
        const delivery = deps.prepareFunctionToolResult(
          { kind, name, callId, result },
          { sendOutput: false, handledOutputChannel: "agents_sdk_execute_return" },
        );
        const storedResult = shouldStoreCompactToolResult(kind, name)
          ? delivery.compactResult || delivery.modelResult?.result || result
          : result;
        const call = {
          name,
          callId,
          arguments: args,
          result: storedResult,
          resultCompacted: storedResult !== result || undefined,
          runtime: "agents-sdk",
          status: compactToolStatus(result),
          stage: compactToolStatus(result) === "completed" ? "verified" : compactToolStatus(result),
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedMs,
          delivery,
        };
        rememberLocalToolCallByKind(kind, call);
        deps.recordTimeline("realtime_agent_sdk_tool_end", { name, callId, ok: true });
        deps.updateFeedback();
        return { result, delivery };
      } catch (error) {
        const finishedAt = new Date().toISOString();
        deps.recordTimeline("realtime_agent_sdk_tool_end", {
          name,
          callId,
          ok: false,
          error: String((error as { message?: string })?.message || error).slice(0, 300),
        });
        rememberLocalToolCallByKind(kind, {
          name,
          callId,
          arguments: args,
          runtime: "agents-sdk",
          status: "blocked",
          stage: "blocked",
          startedAt,
          finishedAt,
          durationMs: Date.now() - startedMs,
        });
        rememberLocalToolErrorByKind(kind, error, { name, callId });
        const delivery = deps.prepareFunctionToolError(
          { kind, name, callId, error },
          { sendOutput: false, handledOutputChannel: "agents_sdk_execute_return" },
        );
        deps.updateFeedback();
        return {
          ok: false,
          error: String((error as { message?: string })?.message || error),
          result: delivery.modelResult,
          delivery,
        };
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
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      rememberLocalToolCallByKind(kind, {
        name: toolCall.name,
        callId: toolCall.callId,
        arguments: toolCall.arguments,
        status: "running",
        stage: "running",
        startedAt,
        ts: startedAt,
      });
      deps.updateFeedback();
      return Promise.resolve()
        .then(() => {
          assertLocalToolExposed(
            kind,
            toolCall.name,
            toolCall.callId,
            (event as { type?: string })?.type || "server_event",
          );
          return runLocalToolByKind(kind, toolCall.name, toolCall.arguments, {
            callId: toolCall.callId,
            responseId: deps.state.responses?.activeResponseId || "",
          });
        })
        .then((result) => {
          const finishedAt = new Date().toISOString();
          const delivery = deps.deliverFunctionToolResult({
            kind,
            name: toolCall.name,
            callId: toolCall.callId,
            result,
          }) as Record<string, any>;
          const storedResult = shouldStoreCompactToolResult(kind, toolCall.name)
            ? delivery.compactResult || delivery.modelResult?.result || result
            : result;
          rememberLocalToolCallByKind(kind, {
            name: toolCall.name,
            callId: toolCall.callId,
            arguments: toolCall.arguments,
            result: storedResult,
            resultCompacted: storedResult !== result || undefined,
            status: compactToolStatus(result),
            stage:
              compactToolStatus(result) === "completed" ? "verified" : compactToolStatus(result),
            startedAt,
            finishedAt,
            durationMs: Date.now() - startedMs,
            delivery,
          });
          return { ok: true, result, delivery };
        })
        .catch((error) => {
          const finishedAt = new Date().toISOString();
          rememberLocalToolCallByKind(kind, {
            name: toolCall.name,
            callId: toolCall.callId,
            arguments: toolCall.arguments,
            status: "blocked",
            stage: "blocked",
            startedAt,
            finishedAt,
            durationMs: Date.now() - startedMs,
          });
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
