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
        if (!controller?.updateState) return { ok: false, reason: "avatar_controller_missing" };
        const result = controller.updateState({
          mood: options.mood,
          action: options.action,
          status_kind: statusKind,
          status_text: statusText,
          status_hold_ms: options.holdMs ?? 15000,
        });
        recordTimeline("avatar_status_hud", {
          statusKind,
          statusText: statusText.slice(0, 80),
        });
        return { ok: true, result };
      } catch (error) {
        rememberAvatarToolError(error, { name: "avatar_status_hud" });
        return { ok: false, error: String((error && error.message) || error) };
      }
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
      if (name === "delegate_to_worker" || name === "delegate_to_codex") {
        if (!args.task) throw new Error("delegate_to_worker requires task");
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
      if (name === "worker_status" || name === "delegate_status") {
        return postJson(config.workerStatusUrl as string, {
          jobId: args.jobId || args.job_id || args.id || "",
        });
      }
      throw new Error(`unsupported local worker tool: ${name}`);
    }

    function normalizeWorkspaceToolName(name: string) {
      if (name === "open_shared_browser_surface") return "start_demo_surface";
      if (name === "create_shared_workspace") return "start_demo_execution";
      if (name === "control_shared_browser_surface") return "control_demo_surface";
      if (name === "stop_shared_browser_surface") return "cancel_demo_surface";
      return name;
    }

    function dryRunWorkspaceToolResult(name: string, args: Record<string, unknown> = {}) {
      if (name !== "control_shared_app_window") {
        return { ok: true, dryRun: true, tool: name, arguments: args };
      }
      const operations = Array.isArray(args.operations)
        ? (args.operations as Array<{ kind?: unknown }>)
        : [];
      const actions = operations.map((operation) => String(operation?.kind || ""));
      const hasDirectOperation = actions.some((kind) => kind && kind !== "state");
      return {
        ok: true,
        dryRun: true,
        tool: name,
        arguments: args,
        summary: hasDirectOperation
          ? "Dry-run executed low-level app-control operations."
          : "Dry-run kept the app-control executor running after the first state observation.",
        actions,
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
      const text = [record.summary, record.result, nested.summary, nested.reason, nested.error]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase())
        .join("\n");
      return (
        (actions.length > 0 && actions.every((action) => action === "state")) ||
        text.includes("structured_operations_required") ||
        text.includes("continue with concrete")
      );
    }

    async function runLocalWorkspaceTool(name, args = {}) {
      if (!localWorkspaceTools.has(name))
        throw new Error(`unsupported local workspace tool: ${name}`);
      if (config.dryRunLocalTools) return dryRunWorkspaceToolResult(name, args);
      if (name === "create_shared_workspace" || name === "start_demo_execution") {
        updateAvatarHudStatus("writing_code", "Writing code", {
          mood: "thinking",
          action: "think",
          holdMs: 30000,
        });
      } else if (name === "control_shared_app_window") {
        updateAvatarHudStatus("opening_preview", `正在操作 ${appControlTargetLabel(args)}`, {
          mood: "thinking",
          action: "lean_forward",
          holdMs: 45000,
        });
      } else if (
        name === "open_shared_browser_surface" ||
        name === "start_demo_surface" ||
        name === "control_shared_browser_surface" ||
        name === "control_demo_surface"
      ) {
        updateAvatarHudStatus("opening_preview", "Opening preview", {
          mood: "thinking",
          action: "lean_forward",
          holdMs: 15000,
        });
      }
      const backendName = normalizeWorkspaceToolName(name);
      const result = await postJson(
        localServiceUrl(`/tools/${encodeURIComponent(backendName)}`),
        args,
      );
      if (name === "create_shared_workspace" || name === "start_demo_execution") {
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
      if (name === "control_shared_app_window") {
        const status = String((result as { status?: unknown })?.status || "")
          .trim()
          .toLowerCase();
        if ((result as { ok?: boolean })?.ok === false) {
          updateAvatarHudStatus("blocked", "操作受阻", { mood: "sad", action: "shrug" });
        } else if (["queued", "accepted", "running", "started"].includes(status)) {
          updateAvatarHudStatus("opening_preview", `正在操作 ${appControlTargetLabel(args)}`, {
            mood: "thinking",
            action: "lean_forward",
            holdMs: 45000,
          });
        } else if (appControlExecutorStillWorking(result)) {
          updateAvatarHudStatus("thinking", "正在操作应用", {
            mood: "thinking",
            action: "think",
            holdMs: 45000,
          });
        } else {
          updateAvatarHudStatus("done", "操作完成", { mood: "happy", action: "emphasize" });
        }
      }
      return result;
    }

    return {
      extractLocalToolCall,
      runLocalAvatarTool,
      updateAvatarHudStatus,
      postJson,
      localServiceUrl,
      runLocalWorkerTool,
      runLocalWorkspaceTool,
    };
  }

  (window as any).__MAB_REALTIME_LOCAL_TOOL_HELPERS = { create };
})();
