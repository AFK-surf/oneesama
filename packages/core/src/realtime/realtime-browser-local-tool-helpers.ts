(() => {
  interface AvatarToolArgs {
    mood?: string;
    holdMs?: number;
    action?: string;
    intensity?: number;
    durationMs?: number;
    [key: string]: unknown;
  }

  interface WorkerToolArgs {
    task?: string;
    context?: Record<string, unknown>;
    mode?: string;
    allowCodeChanges?: boolean;
    allow_code_changes?: boolean;
    jobId?: string;
    job_id?: string;
    id?: string;
    [key: string]: unknown;
  }

  interface RealtimeLocalToolHelperDeps {
    config: Record<string, unknown>;
    state: Record<string, any>;
    localWorkspaceTools: Set<string>;
    isLocalToolName(name: string): boolean;
    recordTimeline(type: string, detail?: Record<string, unknown>): void;
    rememberAvatarToolError(error: unknown, detail?: Record<string, unknown>): void;
  }

  function create(deps: RealtimeLocalToolHelperDeps) {
    const {
      config,
      state,
      localWorkspaceTools,
      isLocalToolName,
      recordTimeline,
      rememberAvatarToolError,
    } = deps;

    function parseToolArguments(rawArguments) {
      if (!rawArguments) return {};
      if (typeof rawArguments === "object") return rawArguments;
      try {
        return JSON.parse(String(rawArguments));
      } catch {
        return {};
      }
    }

    function extractLocalToolCall(event) {
      if (event.type === "response.function_call_arguments.done" && isLocalToolName(event.name)) {
        return {
          name: event.name,
          callId: event.call_id || event.callId || "",
          arguments: parseToolArguments(event.arguments),
        };
      }
      const item = event.item || event.output_item || {};
      if (
        event.type === "response.output_item.done" &&
        item.type === "function_call" &&
        isLocalToolName(item.name)
      ) {
        return {
          name: item.name,
          callId: item.call_id || item.callId || event.call_id || "",
          arguments: parseToolArguments(item.arguments),
        };
      }
      if (event.type === "response.done") {
        const output = event.response?.output || [];
        const functionCall = output.find(
          (entry) => entry?.type === "function_call" && isLocalToolName(entry.name),
        );
        if (functionCall) {
          return {
            name: functionCall.name,
            callId: functionCall.call_id || functionCall.callId || "",
            arguments: parseToolArguments(functionCall.arguments),
          };
        }
      }
      return null;
    }

    function runLocalAvatarTool(name: string, args: AvatarToolArgs = {}) {
      const controller = (window as any).MAB_AVATAR_CONTROLLER;
      if (!controller) throw new Error("avatar controller is not available");
      if (name === "set_avatar_expression") {
        if (!controller.setExpression) throw new Error("controller.setExpression not available");
        return controller.setExpression(args.mood || "neutral", { holdMs: args.holdMs });
      }
      if (name === "set_avatar_action") {
        if (!controller.setAction) throw new Error("controller.setAction not available");
        return controller.setAction(args.action || "idle", args.intensity ?? 0.8, {
          holdMs: args.holdMs,
          durationMs: args.durationMs,
        });
      }
      if (name === "update_avatar_state") return controller.updateState(args);
      throw new Error(`unsupported local avatar tool: ${name}`);
    }

    function updateAvatarHudStatus(
      statusKind: string,
      statusText: string,
      options: { mood?: string; action?: string; holdMs?: number } = {},
    ) {
      try {
        const controller = (window as any).MAB_AVATAR_CONTROLLER;
        const update = {
          mood: options.mood,
          action: options.action,
          status_kind: statusKind,
          status_text: statusText,
          status_hold_ms: options.holdMs ?? 15000,
        };
        if (controller?.updateState) {
          const result = controller.updateState(update);
          recordTimeline("avatar_status_hud", {
            statusKind,
            statusText: statusText.slice(0, 80),
            hostForwarded: false,
          });
          return { ok: true, result };
        }
        const host = (window as any).MAB_HOST_UPDATE_AVATAR_HUD;
        if (typeof host === "function") {
          Promise.resolve(
            host({
              statusKind,
              statusText,
              mood: options.mood,
              action: options.action,
              holdMs: options.holdMs ?? 15000,
            }),
          )
            .then((result: any) => {
              recordTimeline("avatar_status_hud", {
                statusKind,
                statusText: statusText.slice(0, 80),
                hostForwarded: true,
                ok: result?.ok === true,
                error: result?.ok === false ? result?.error || result?.reason || "" : "",
              });
              return undefined;
            })
            .catch((error) => {
              rememberAvatarToolError(error, { name: "avatar_status_hud_host" });
              recordTimeline("avatar_status_hud", {
                statusKind,
                statusText: statusText.slice(0, 80),
                hostForwarded: true,
                ok: false,
                error: String((error && error.message) || error),
              });
            });
          return { ok: true, forwarded: true };
        }
        return { ok: false, reason: "avatar_controller_missing" };
      } catch (error) {
        rememberAvatarToolError(error, { name: "avatar_status_hud" });
        return { ok: false, error: String((error && error.message) || error) };
      }
    }

    async function updateKWWKCursorFeedback(
      kind: "move" | "click" | "press" | "drag" | "target" | "blocked" | "done",
      label: string,
      point: { x?: number; y?: number } = {},
    ) {
      try {
        const payload = { kind, label, x: point.x ?? 0.5, y: point.y ?? 0.52 };
        const update = (window as any).MAB_KWWK_CURSOR_FEEDBACK;
        if (typeof update === "function") update(payload);
        const host = (window as any).MAB_HOST_UPDATE_KWWK_CURSOR_FEEDBACK;
        if (typeof host === "function") {
          try {
            const result = await Promise.resolve(host(payload));
            recordTimeline("kwwk_cursor_feedback_host", {
              ok: result?.ok === true,
              kind,
              hostForwarded: true,
              error: result?.ok === false ? result?.error || result?.reason || "" : "",
            });
          } catch (error) {
            rememberAvatarToolError(error, { name: "kwwk_cursor_feedback_host" });
            recordTimeline("kwwk_cursor_feedback_host", {
              ok: false,
              kind,
              hostForwarded: true,
              error: String((error && error.message) || error),
            });
          }
        }
      } catch (error) {
        rememberAvatarToolError(error, { name: "kwwk_cursor_feedback" });
      }
    }

    function finiteUnitNumber(value: unknown): number | undefined {
      const numberValue = Number(value);
      if (!Number.isFinite(numberValue)) return undefined;
      return Math.max(0, Math.min(1, numberValue));
    }

    function parseMaybeJSONValue(value: unknown): unknown {
      if (typeof value !== "string") return null;
      const text = value.trim();
      if (!text || !/^[{[]/.test(text)) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }

    function collectKWWKCursorEvents(value: unknown, depth = 0): Array<Record<string, unknown>> {
      if (!value || depth > 6) return [];
      if (typeof value === "string") {
        const parsed = parseMaybeJSONValue(value);
        return parsed ? collectKWWKCursorEvents(parsed, depth + 1) : [];
      }
      if (typeof value !== "object") return [];
      if (Array.isArray(value)) {
        return value.flatMap((entry) => collectKWWKCursorEvents(entry, depth + 1));
      }
      const record = value as Record<string, unknown>;
      const ownEvents =
        record.schema === "oneesama.kwwk-cursor-events.v1" && Array.isArray(record.events)
          ? (record.events as Array<Record<string, unknown>>)
          : [];
      return [
        ...ownEvents,
        ...[
          "cursor",
          "metadata",
          "backendResult",
          "workerResult",
          "result",
          "resultEnvelope",
          "result_envelope",
        ].flatMap((key) => collectKWWKCursorEvents(record[key], depth + 1)),
      ];
    }

    function compactKWWKActionTelemetryEntry(entry: Record<string, unknown>) {
      const kind = String(entry.kind || entry.action || "")
        .trim()
        .slice(0, 48);
      if (!kind) return null;
      const target = recordFromUnknown(entry.target);
      return {
        kind,
        target,
        durationMs: Number.isFinite(Number(entry.durationMs)) ? Number(entry.durationMs) : 0,
        success: entry.success !== false,
        error: String(entry.error || "")
          .trim()
          .slice(0, 120),
        source: String(entry.source || "kwwk")
          .trim()
          .slice(0, 48),
      };
    }

    function collectKWWKActionTelemetry(value: unknown, depth = 0): Array<Record<string, unknown>> {
      if (!value || depth > 6) return [];
      if (typeof value === "string") {
        const parsed = parseMaybeJSONValue(value);
        return parsed ? collectKWWKActionTelemetry(parsed, depth + 1) : [];
      }
      if (typeof value !== "object") return [];
      if (Array.isArray(value)) {
        return value.flatMap((entry) => collectKWWKActionTelemetry(entry, depth + 1));
      }
      const record = value as Record<string, unknown>;
      const ownTelemetry = Array.isArray(record.actionTelemetry)
        ? (record.actionTelemetry as Array<Record<string, unknown>>)
            .map((entry) => compactKWWKActionTelemetryEntry(recordFromUnknown(entry)))
            .filter(Boolean)
        : [];
      return [
        ...(ownTelemetry as Array<Record<string, unknown>>),
        ...[
          "metadata",
          "backendResult",
          "workerResult",
          "result",
          "resultEnvelope",
          "result_envelope",
        ].flatMap((key) => collectKWWKActionTelemetry(record[key], depth + 1)),
      ];
    }

    function rememberKWWKActionTelemetry(result: unknown) {
      const telemetry = collectKWWKActionTelemetry(result).slice(-20);
      if (!telemetry.length) return telemetry;
      const summary = telemetry.map((entry) => entry.kind).join(",");
      state.kwwkAppControl = {
        ...state.kwwkAppControl,
        actionTelemetry: telemetry,
        lastActionKinds: telemetry.map((entry) => entry.kind),
        lastUpdatedAt: new Date().toISOString(),
      };
      recordTimeline("realtime_app_control_action_telemetry", {
        actions: telemetry.length,
        actionKinds: summary.slice(0, 200),
      });
      return telemetry;
    }

    function latestKWWKCursorFeedbackPoint(result: unknown) {
      const events = collectKWWKCursorEvents(result);
      const latest = events
        .slice()
        .reverse()
        .find((event) => {
          return (
            finiteUnitNumber(event.normalizedX) !== undefined &&
            finiteUnitNumber(event.normalizedY) !== undefined
          );
        });
      if (!latest) return null;
      const eventKind = String(latest.kind || "");
      return {
        x: finiteUnitNumber(latest.normalizedX),
        y: finiteUnitNumber(latest.normalizedY),
        kind: eventKind.includes("drag") ? "drag" : eventKind.includes("click") ? "click" : "move",
      } as { x?: number; y?: number; kind: "move" | "click" | "drag" };
    }

    async function postJson(url: string, body: unknown) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.toolCallbackToken) {
        headers["X-Oneesama-Internal-Key"] = String(config.toolCallbackToken);
      }
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = { ok: false, error: "invalid_json_response" };
      }
      if (!response.ok) {
        return { ok: false, status: response.status, body: payload };
      }
      return payload as { ok?: boolean; [key: string]: unknown };
    }

    function recordFromUnknown(value: unknown): Record<string, unknown> {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
      const text = String(value || "").trim();
      return text ? { context_text: text } : {};
    }

    function localServiceUrl(path: string): string {
      try {
        return new URL(
          path,
          new URL(config.tokenUrl as string, window.location.href).origin,
        ).toString();
      } catch {
        return path;
      }
    }

    async function runLocalWorkerTool(name: string, args: WorkerToolArgs = {}) {
      if (name === "delegate_to_worker") {
        if (!args.task) throw new Error("delegate_to_worker requires task");
        if (config.dryRunLocalTools) {
          return {
            ok: true,
            dryRun: true,
            tool: name,
            status: "queued",
            jobId: "dry_run_worker_job",
            summary: "Dry-run accepted the background worker task without launching a worker.",
            arguments: args,
          };
        }
        const rawContext = recordFromUnknown(args.context);
        const context = {
          ...rawContext,
          source: rawContext.source || "meeting-realtime-worker",
          sessionId: rawContext.sessionId || state.sessionId || String(config.sessionId || ""),
          session_id: rawContext.session_id || state.sessionId || String(config.sessionId || ""),
          meeting_session_id:
            rawContext.meeting_session_id || state.sessionId || String(config.sessionId || ""),
        };
        return postJson(config.workerDelegateUrl as string, {
          task: args.task,
          context,
          mode: args.mode || "analysis",
          allowCodeChanges: Boolean(args.allowCodeChanges || args.allow_code_changes),
        });
      }
      if (name === "worker_status") {
        if (config.dryRunLocalTools) {
          const jobId = String(args.jobId || args.job_id || args.id || "dry_run_worker_job");
          return {
            ok: true,
            dryRun: true,
            tool: name,
            status: "completed",
            job: {
              id: jobId,
              status: "completed",
              summary: "Dry-run worker job completed.",
            },
            arguments: args,
          };
        }
        return postJson(config.workerStatusUrl as string, {
          jobId: args.jobId || args.job_id || args.id || "",
        });
      }
      throw new Error(`unsupported local worker tool: ${name}`);
    }

    const demoSurfaceWorkspaceTools = new Set([
      "open_shared_browser_surface",
      "create_shared_workspace",
      "control_shared_browser_surface",
      "stop_shared_browser_surface",
    ]);

    const deprecatedDemoSurfaceWorkspaceTools = new Set([
      "start_demo_surface",
      "start_demo_execution",
      "control_demo_surface",
      "cancel_demo_surface",
    ]);

    function demoSurfaceToolsExposed() {
      const demoSurface = (config.demoSurface || {}) as Record<string, unknown>;
      if (demoSurface.toolsExposed === true) return true;
      return config.allowDemoSurfaceTools === true;
    }

    function sanitizeWorkspaceToolArgs(
      name: string,
      args: Record<string, unknown> = {},
    ): Record<string, unknown> {
      if (name !== "kwwk_computer_use") {
        return args;
      }
      const context =
        args.context && typeof args.context === "object" && !Array.isArray(args.context)
          ? (args.context as Record<string, unknown>)
          : null;
      const hasTopLevelOperations = Object.prototype.hasOwnProperty.call(args, "operations");
      const hasContextOperations = Boolean(
        context && Object.prototype.hasOwnProperty.call(context, "operations"),
      );
      const currentSessionId = String(
        args.session_id || args.sessionId || state.sessionId || config.sessionId || "",
      ).trim();
      const shouldInjectSessionId = Boolean(
        currentSessionId && !args.session_id && !args.sessionId,
      );
      if (!hasTopLevelOperations && !hasContextOperations && !shouldInjectSessionId) {
        return args;
      }
      const sanitized: Record<string, unknown> = { ...args };
      if (shouldInjectSessionId) {
        sanitized.session_id = currentSessionId;
      }
      if (!hasTopLevelOperations && !hasContextOperations) {
        return sanitized;
      }
      const contextOperations = context ? context.operations : undefined;
      const operations =
        (Array.isArray(args.operations) ? (args.operations as Array<unknown>).length : 0) +
        (Array.isArray(contextOperations) ? (contextOperations as Array<unknown>).length : 0);
      delete sanitized.operations;
      if (context) {
        const sanitizedContext = { ...context };
        delete sanitizedContext.operations;
        sanitized.context = sanitizedContext;
      }
      recordTimeline("realtime_app_control_foreground_operations_stripped", {
        name,
        operations,
        topLevel: hasTopLevelOperations,
        context: hasContextOperations,
      });
      return sanitized;
    }

    function dryRunWorkspaceToolResult(name: string, args: Record<string, unknown> = {}) {
      if (name !== "kwwk_computer_use") {
        return { ok: true, dryRun: true, tool: name, arguments: args };
      }
      return {
        ok: true,
        dryRun: true,
        tool: name,
        arguments: args,
        summary: "Dry-run kept the app-control executor running after the first state observation.",
        actions: ["state"],
        metadata: {
          state: {
            ok: true,
            window: {
              applicationName: String(args.applicationName || "Pencil"),
              title: String(args.windowTitle || "Pencil"),
              windowId: Number(args.windowId || 12345),
              frame: { x: 0, y: 0, width: 960, height: 720 },
            },
            screenshotIncluded: true,
          },
        },
      };
    }

    function appControlTargetLabel(args: Record<string, unknown> = {}) {
      return String(args.applicationName || args.application_name || args.windowTitle || "共享应用")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 32);
    }

    function appControlExecutorStillWorking(result: unknown) {
      const record = recordFromUnknown(result);
      const nested = recordFromUnknown(record.result);
      if (record.ok === false || nested.ok === false) return false;
      const actions = [record.actions, nested.actions].flatMap((value) =>
        Array.isArray(value) ? value.map((action) => String(action || "").toLowerCase()) : [],
      );
      return actions.length > 0 && actions.every((action) => action === "state");
    }

    function appControlBlockerText(result: unknown) {
      const record = recordFromUnknown(result);
      const nested = recordFromUnknown(record.result);
      const displayText = String(
        record.displayText ||
          record.display_text ||
          record.answer_hint_en ||
          record.answerHintEn ||
          record.answer_hint_zh ||
          nested.displayText ||
          nested.display_text ||
          nested.answer_hint_en ||
          nested.answerHintEn ||
          nested.answer_hint_zh ||
          "",
      )
        .trim()
        .slice(0, 24);
      if (displayText) return displayText;
      const reason = [
        record.blocker,
        record.error,
        record.status,
        nested.blocker,
        nested.error,
        nested.status,
      ]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");
      if (/permission|accessibility|screen_recording|blocked_permission/.test(reason)) {
        return "需要权限";
      }
      if (/ambiguous|blocked_ambiguous_target/.test(reason)) {
        return "目标不明确";
      }
      if (/no_target|target_app|window_not_found|shared_window_not_found/.test(reason)) {
        return "找不到窗口";
      }
      if (/needs_background_agent/.test(reason)) {
        return "交给后台";
      }
      return "操作失败";
    }

    async function runLocalWorkspaceTool(name, args = {}) {
      if (!localWorkspaceTools.has(name))
        throw new Error(`unsupported local workspace tool: ${name}`);
      const toolArgs = sanitizeWorkspaceToolArgs(name, args);
      if (deprecatedDemoSurfaceWorkspaceTools.has(name)) {
        recordTimeline("realtime_deprecated_demo_surface_tool_rejected", {
          name,
          reason: "deprecated_demo_surface_tool",
        });
        throw new Error("deprecated_demo_surface_tool");
      }
      if (demoSurfaceWorkspaceTools.has(name) && !demoSurfaceToolsExposed()) {
        recordTimeline("realtime_demo_surface_tool_rejected", {
          name,
          reason: "demo_surface_tools_not_exposed",
        });
        throw new Error("demo_surface_tool_not_exposed");
      }
      if (config.dryRunLocalTools) return dryRunWorkspaceToolResult(name, toolArgs);
      if (name === "create_shared_workspace") {
        updateAvatarHudStatus("writing_code", "Writing code", {
          mood: "thinking",
          action: "think",
          holdMs: 30000,
        });
      } else if (name === "kwwk_computer_use") {
        const targetLabel = appControlTargetLabel(toolArgs);
        updateAvatarHudStatus("opening_preview", `正在操作 ${targetLabel}`, {
          mood: "thinking",
          action: "lean_forward",
          holdMs: 45000,
        });
      } else if (
        name === "open_shared_browser_surface" ||
        name === "control_shared_browser_surface"
      ) {
        updateAvatarHudStatus("opening_preview", "Opening preview", {
          mood: "thinking",
          action: "lean_forward",
          holdMs: 15000,
        });
      }
      const result = await postJson(
        localServiceUrl(`/tools/${encodeURIComponent(name)}`),
        toolArgs,
      );
      if (name === "create_shared_workspace") {
        const status = (result as { status?: string; ok?: boolean; error?: string })?.status || "";
        if ((result as { ok?: boolean })?.ok === false) {
          updateAvatarHudStatus("blocked", "Blocked", { mood: "sad", action: "shrug" });
        } else if (status === "started") {
          updateAvatarHudStatus("writing_code", "Writing code", {
            mood: "thinking",
            action: "think",
            holdMs: 30000,
          });
        }
      }
      if (name === "kwwk_computer_use") {
        rememberKWWKActionTelemetry(result);
        const cursorPoint = latestKWWKCursorFeedbackPoint(result);
        const status = String((result as { status?: unknown })?.status || "")
          .trim()
          .toLowerCase();
        if ((result as { ok?: boolean })?.ok === false) {
          const blockerText = appControlBlockerText(result);
          updateAvatarHudStatus("blocked", blockerText, { mood: "sad", action: "shrug" });
          if (cursorPoint) await updateKWWKCursorFeedback("blocked", blockerText, cursorPoint);
        } else if (["queued", "accepted", "running", "started"].includes(status)) {
          updateAvatarHudStatus("opening_preview", `正在操作 ${appControlTargetLabel(toolArgs)}`, {
            mood: "thinking",
            action: "lean_forward",
            holdMs: 45000,
          });
          if (cursorPoint) await updateKWWKCursorFeedback("move", "操作中", cursorPoint);
        } else if (appControlExecutorStillWorking(result)) {
          updateAvatarHudStatus("thinking", "正在操作应用", {
            mood: "thinking",
            action: "think",
            holdMs: 45000,
          });
          if (cursorPoint) await updateKWWKCursorFeedback("move", "操作中", cursorPoint);
        } else {
          updateAvatarHudStatus("done", "操作完成", { mood: "happy", action: "emphasize" });
          if (cursorPoint)
            await updateKWWKCursorFeedback(cursorPoint.kind || "done", "完成", cursorPoint);
        }
      }
      return result;
    }

    return {
      extractLocalToolCall,
      runLocalAvatarTool,
      updateAvatarHudStatus,
      updateKWWKCursorFeedback,
      latestKWWKCursorFeedbackPoint,
      rememberKWWKActionTelemetry,
      postJson,
      localServiceUrl,
      runLocalWorkerTool,
      runLocalWorkspaceTool,
    };
  }

  (window as any).__MAB_REALTIME_LOCAL_TOOL_HELPERS = { create };
})();
