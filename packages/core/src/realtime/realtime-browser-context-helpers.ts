/* eslint-disable max-lines */
(() => {
  interface RealtimeEventSummary {
    type: string;
    source?: string;
    reason?: string;
    responseId?: string;
    itemType?: string;
    name?: string;
    callId?: string;
    error?: string;
    delta?: string;
    transcript?: string;
    text?: string;
  }

  interface RealtimeContextHelperDeps {
    config: Record<string, any>;
    state: Record<string, any>;
    getRealtimeAgentSession(): any;
    recordTimeline(type: string, detail?: Record<string, unknown>): void;
    sendRealtimeEvent(event: unknown): string;
  }

  interface FailureMatrixCell {
    status: "ok" | "waiting" | "blocked" | "disabled";
    reason: string;
    signals: Record<string, unknown>;
  }

  interface AudioInputPolicy {
    status: FailureMatrixCell["status"];
    reason: string;
    ready: boolean;
    expected: boolean;
    source: string;
    blockers: string[];
    signals: Record<string, unknown>;
  }

  type AvatarHudFeedbackStatus = {
    statusKind: "blocked" | "thinking";
    statusText: string;
    holdMs: number;
  };

  function create(deps: RealtimeContextHelperDeps) {
    const { config, state, getRealtimeAgentSession, recordTimeline, sendRealtimeEvent } = deps;

    function contextLifecycleConfig() {
      const raw = (config.contextLifecycle || {}) as Record<string, unknown>;
      return {
        enabled: raw.enabled !== false,
        compactTokenThreshold: Number(raw.compactTokenThreshold || 80000),
        compactItemThreshold: Number(raw.compactItemThreshold || 200),
        recentItems: Math.max(5, Math.min(Number(raw.recentItems || 20), 80)),
        dedupeWindowMs: Math.max(1000, Number(raw.dedupeWindowMs || 5000)),
        summaryMaxChars: Math.max(800, Number(raw.summaryMaxChars || 3000)),
      };
    }

    function estimateHistoryTokens(history: unknown[]): number {
      return Math.ceil(JSON.stringify(history || []).length / 4);
    }

    function textFromHistoryContent(content: unknown): string {
      if (typeof content === "string") return content.slice(0, 500);
      if (!Array.isArray(content)) return "";
      return content
        .map((part) => {
          const item = (part || {}) as Record<string, unknown>;
          return String(item.text || item.transcript || item.content || "").trim();
        })
        .filter(Boolean)
        .join(" ")
        .slice(0, 500);
    }

    function uniqueStrings(values: string[]): string[] {
      return [...new Set(values.filter(Boolean))];
    }

    function summarizeHistoryItem(item: unknown) {
      const entry = (item || {}) as Record<string, unknown>;
      return {
        type: String(entry.type || ""),
        role: String(entry.role || ""),
        name: String(entry.name || entry.tool_name || ""),
        callId: String(entry.call_id || entry.callId || ""),
        text: textFromHistoryContent(entry.content || entry.output || entry.text),
      };
    }

    const shareToolNames = new Set([
      "list_shareable_windows",
      "share_existing_app_window",
      "kwwk_computer_use",
      "delegate_to_worker",
      "read_meet_chat",
    ]);
    const shareIntentPattern =
      /(共享|分享|演示|展示|给.*看|share|present|show).*(浏览器|chrome|窗口|屏幕|app|应用|pencil|vscode|vs code|notion|terminal)|((浏览器|chrome|窗口|屏幕|app|应用|pencil|vscode|vs code|notion|terminal).*(共享|分享|演示|展示|share|present|show))/i;
    const controlIntentPattern =
      /(控制|操作|点击|输入|回车|滚动|切到|处理.*卡住|画|涂|编辑|修改|control|click|type|scroll|press|draw|edit)/i;
    const delegateIntentPattern =
      /(后台|codex|写脚本|脚本|调研|报告|处理.*文件|跑.*测试|查代码|改.*repo|研究|research|script|debug|investigate|五子棋|gomoku|实现.*web|开发.*web|build.*web|implement.*web|create.*web)/i;
    const meetChatIntentPattern =
      /(会议|meet|聊天|chat).*(说了啥|说什么|刚说|聊天|消息|内容|read|what)|(read|what).*(meeting|meet).*(chat|message)/i;

    function historyToolName(item: unknown): string {
      const entry = (item || {}) as Record<string, unknown>;
      const name = String(entry.name || entry.tool_name || entry.toolName || "").trim();
      if (name) return name;
      const itemObj = (entry.item || {}) as Record<string, unknown>;
      return String(itemObj.name || itemObj.tool_name || itemObj.toolName || "").trim();
    }

    function historyRole(item: unknown): string {
      const entry = (item || {}) as Record<string, unknown>;
      return String(entry.role || (entry as any).item?.role || "").trim();
    }

    function historyText(item: unknown): string {
      const entry = (item || {}) as Record<string, unknown>;
      return textFromHistoryContent(
        entry.content || entry.output || entry.text || (entry as any).item?.content,
      );
    }

    function functionalIntentForText(text: string) {
      const value = String(text || "");
      if (controlIntentPattern.test(value)) return "control";
      if (shareIntentPattern.test(value)) return "share";
      if (delegateIntentPattern.test(value)) return "delegate";
      if (meetChatIntentPattern.test(value)) return "meet_chat";
      return "";
    }

    function expectedToolsForIntent(intent: string) {
      if (intent === "control") return ["kwwk_computer_use"];
      if (intent === "share") return ["list_shareable_windows", "share_existing_app_window"];
      if (intent === "delegate") return ["delegate_to_worker"];
      if (intent === "meet_chat") return ["read_meet_chat"];
      return [];
    }

    function modelTurnSignalCount() {
      const responseEvents = state.inbound.filter((entry) =>
        String(entry.event?.type || "").startsWith("response."),
      ).length;
      const agentModelEvents = state.inbound.filter((entry) =>
        [
          "agents_sdk.agent_start",
          "agents_sdk.agent_end",
          "agents_sdk.audio_start",
          "agents_sdk.audio_stopped",
          "agents_sdk.audio_interrupted",
        ].includes(String(entry.event?.type || "")),
      ).length;
      const avatarAudio = (window as any).MAB_AVATAR_AUDIO || {};
      const avatarOutputEnergy = avatarAudio.outputEnergy || {};
      return responseEvents + agentModelEvents + (avatarOutputEnergy.observed === true ? 1 : 0);
    }

    function toolCallName(call: unknown): string {
      const entry = (call || {}) as Record<string, unknown>;
      return String(entry.name || entry.toolName || entry.tool_name || "").trim();
    }

    function toolCallTime(call: unknown): number {
      const ts = String((call as Record<string, unknown>)?.ts || "");
      const parsed = Date.parse(ts);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function recentFunctionalToolNamesForTurn(turn: Record<string, any>, turnTime: number) {
      const baselineMeetToolCalls = Math.max(0, Number(turn.baselineMeetToolCalls || 0));
      const baselineWorkspaceToolCalls = Math.max(0, Number(turn.baselineWorkspaceToolCalls || 0));
      return uniqueStrings(
        [
          ...(state.meetTools.calls || []).slice(baselineMeetToolCalls),
          ...(state.workspaceTools.calls || []).slice(baselineWorkspaceToolCalls),
        ]
          .filter((call) => toolCallTime(call) >= turnTime)
          .map(toolCallName)
          .filter((name) => shareToolNames.has(name)),
      );
    }

    function analyzeManualFunctionalTurnFallback(
      historyTurn: Record<string, any>,
      history: unknown[] = [],
    ) {
      if (historyTurn.observed) return historyTurn;
      const turns = Array.isArray(state.turnPolicy.manualFunctionalTurns)
        ? state.turnPolicy.manualFunctionalTurns
        : [];
      const turn = turns[turns.length - 1] || null;
      if (!turn) return historyTurn;
      const turnTime = Date.parse(String(turn.ts || ""));
      const recent = Number.isFinite(turnTime) && Date.now() - turnTime < 5 * 60 * 1000;
      if (!recent) return historyTurn;
      const expectedToolNames = Array.isArray(turn.expectedToolNames)
        ? turn.expectedToolNames
        : expectedToolsForIntent(String(turn.intent || ""));
      const toolNames = recentFunctionalToolNamesForTurn(turn, turnTime);
      const toolCalled = toolNames.some((name) => expectedToolNames.includes(name));
      const modelTurnObserved = modelTurnSignalCount() > Number(turn.baselineModelTurnSignals || 0);
      const historyObserved = history.some(
        (item) =>
          historyRole(item) === "user" &&
          historyText(item).includes(String(turn.userText || "").slice(0, 120)),
      );
      const fakeExecution = !toolCalled && modelTurnObserved;
      return {
        observed: true,
        source: String(turn.source || "manual_text_turn"),
        historyObserved,
        intent: turn.intent || "",
        userIndex: -1,
        userText: String(turn.userText || "").slice(0, 800),
        expectedToolNames,
        toolNames,
        assistantText: "",
        modelTurnObserved,
        toolCalled,
        fakeExecution,
        reason: toolCalled
          ? "expected_tool_observed_after_manual_functional_turn"
          : fakeExecution
            ? "manual_functional_turn_model_turn_without_expected_tool"
            : historyObserved
              ? "manual_functional_turn_in_history_waiting_for_tool"
              : "manual_functional_turn_missing_from_sdk_history",
      };
    }

    function analyzeLatestFunctionalTurn(history: unknown[] = []) {
      let userIndex = -1;
      let userText = "";
      let intent = "";
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const role = historyRole(history[index]);
        if (role !== "user") continue;
        const text = historyText(history[index]);
        const detected = functionalIntentForText(text);
        if (!detected) continue;
        userIndex = index;
        userText = text;
        intent = detected;
        break;
      }
      if (userIndex < 0) {
        return analyzeManualFunctionalTurnFallback(
          {
            observed: false,
            fakeExecution: false,
            toolCalled: false,
            reason: "no_recent_functional_user_turn",
          },
          history,
        );
      }
      const expectedToolNames = expectedToolsForIntent(intent);
      const afterUser = history.slice(userIndex + 1);
      const toolNames = uniqueStrings(
        afterUser.map(historyToolName).filter((name) => shareToolNames.has(name)),
      );
      const assistantText = afterUser
        .filter((item) => historyRole(item) === "assistant")
        .map(historyText)
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 800);
      const toolCalled = toolNames.some((name) => expectedToolNames.includes(name));
      const fakeExecution = !toolCalled && Boolean(assistantText);
      return {
        observed: true,
        intent,
        userIndex,
        userText: userText.slice(0, 800),
        expectedToolNames,
        toolNames,
        assistantText,
        toolCalled,
        fakeExecution,
        reason: toolCalled
          ? "expected_tool_observed_in_history"
          : fakeExecution
            ? "assistant_text_without_expected_tool"
            : "expected_tool_missing",
      };
    }

    function recordManualFunctionalTextTurn(text: string, detail: Record<string, unknown> = {}) {
      const userText = String(text || "").trim();
      const intent = functionalIntentForText(userText);
      if (!intent) return { ok: true, skipped: true, reason: "not_functional_turn" };
      const entry = {
        ts: new Date().toISOString(),
        source: "manual_text_turn",
        userText: userText.slice(0, 800),
        intent,
        expectedToolNames: expectedToolsForIntent(intent),
        baselineModelTurnSignals: modelTurnSignalCount(),
        baselineMeetToolCalls: state.meetTools.calls.length,
        baselineWorkspaceToolCalls: state.workspaceTools.calls.length,
        ...detail,
      };
      state.turnPolicy.manualFunctionalTurns.push(entry);
      state.turnPolicy.manualFunctionalTurns = state.turnPolicy.manualFunctionalTurns.slice(-40);
      recordTimeline("realtime_manual_functional_turn_recorded", {
        intent,
        chars: userText.length,
        baselineModelTurnSignals: entry.baselineModelTurnSignals,
        baselineMeetToolCalls: entry.baselineMeetToolCalls,
        baselineWorkspaceToolCalls: entry.baselineWorkspaceToolCalls,
      });
      updateContextHealthFromHistory(currentHistorySnapshot());
      return { ok: true, ...entry };
    }

    function recordAudioFunctionalTranscript(text: string, detail: Record<string, unknown> = {}) {
      const userText = String(text || "").trim();
      const intent = functionalIntentForText(userText);
      if (!intent) return { ok: true, skipped: true, reason: "not_functional_audio_transcript" };
      const entry = {
        ts: new Date().toISOString(),
        source: "audio_transcript",
        userText: userText.slice(0, 800),
        intent,
        expectedToolNames: expectedToolsForIntent(intent),
        baselineModelTurnSignals: modelTurnSignalCount(),
        baselineMeetToolCalls: state.meetTools.calls.length,
        baselineWorkspaceToolCalls: state.workspaceTools.calls.length,
        ...detail,
      };
      state.turnPolicy.manualFunctionalTurns.push(entry);
      state.turnPolicy.manualFunctionalTurns = state.turnPolicy.manualFunctionalTurns.slice(-40);
      recordTimeline("realtime_audio_functional_turn_recorded", {
        intent,
        chars: userText.length,
        baselineModelTurnSignals: entry.baselineModelTurnSignals,
        baselineMeetToolCalls: entry.baselineMeetToolCalls,
        baselineWorkspaceToolCalls: entry.baselineWorkspaceToolCalls,
      });
      updateContextHealthFromHistory(currentHistorySnapshot());
      return { ok: true, ...entry };
    }

    function maybeDirectRouteAudioFunctionalTranscript(text: string) {
      if (config.directTextTurnToolRouting !== true) {
        return { ok: true, skipped: true, reason: "direct_audio_tool_routing_disabled" };
      }
      const router = (window as any).__MAB_REALTIME_DIRECT_TOOL_ROUTING || {};
      if (
        typeof router.preferredToolChoice !== "function" ||
        typeof router.shouldDirectRouteTool !== "function" ||
        typeof router.queue !== "function"
      ) {
        return { ok: false, skipped: true, reason: "direct_tool_router_missing" };
      }
      const toolChoice = router.preferredToolChoice(text);
      const toolName = String(toolChoice?.name || "");
      if (!toolName || !router.shouldDirectRouteTool(toolName)) {
        return { ok: true, skipped: true, reason: "no_direct_audio_tool_choice" };
      }
      router.queue(toolName, text, { source: "audio_transcript" });
      recordTimeline("realtime_audio_transcript_direct_tool_requested", {
        toolName,
        chars: String(text || "").length,
      });
      return { ok: true, toolName };
    }

    function currentHistorySnapshot(): unknown[] {
      const history = getRealtimeAgentSession()?.history;
      return Array.isArray(history) ? history : [];
    }

    function updateContextHealthFromHistory(history = currentHistorySnapshot()) {
      const lifecycle = contextLifecycleConfig();
      state.contextHealth.enabled = lifecycle.enabled;
      state.contextHealth.itemsCount = history.length;
      state.contextHealth.tokenEstimate = estimateHistoryTokens(history);
      state.contextHealth.nextCompactThreshold = lifecycle.compactTokenThreshold;
      state.contextHealth.recentItemsRetained = lifecycle.recentItems;
      state.contextHealth.lastHistoryTail = history.slice(-8).map(summarizeHistoryItem);
      state.contextHealth.latestFunctionalTurn = analyzeLatestFunctionalTurn(history);
      return state.contextHealth;
    }

    function rememberSessionContext(kind: string, value: unknown, reason = "update") {
      if (!kind) return state.contextHealth;
      const cache = state.contextHealth.cache as Record<string, unknown>;
      if (kind === "identity") cache.identity = value;
      else if (kind === "meetingAwareness") cache.meetingAwareness = value;
      else if (kind === "currentTask") cache.currentTask = value;
      state.contextHealth.refreshCount += 1;
      state.contextHealth.lastRefreshAt = new Date().toISOString();
      state.contextHealth.lastRefreshReason = reason;
      recordTimeline("realtime_context_refresh", {
        kind,
        reason,
        tokenEstimate: state.contextHealth.tokenEstimate,
      });
      return state.contextHealth;
    }

    function displayNameFromIdentity(identity: unknown): string {
      const value = (identity || {}) as Record<string, unknown>;
      return String(
        value.preferredName ||
          value.preferred_name ||
          value.canonicalName ||
          value.canonical_name ||
          value.name ||
          "",
      ).trim();
    }

    function buildSessionContextSummary(): string {
      const cache = state.contextHealth.cache as Record<string, unknown>;
      const awareness = (cache.meetingAwareness || {}) as Record<string, any>;
      const identity = cache.identity || null;
      const speaker = awareness.activeSpeaker || awareness.active_speaker || null;
      const speakerIdentity = speaker?.identity || null;
      const speakerName = displayNameFromIdentity(speakerIdentity) || String(speaker?.name || "");
      const currentUserName = displayNameFromIdentity(identity);
      const participants = Array.isArray(awareness.participants)
        ? awareness.participants
            .map((entry) => displayNameFromIdentity(entry?.identity) || String(entry?.name || ""))
            .filter(Boolean)
            .slice(0, 12)
        : [];
      const currentTask = (cache.currentTask || {}) as Record<string, unknown>;
      const lines = [
        "会议上下文快照：",
        currentUserName ? `当前用户：${currentUserName}` : "",
        speakerName ? `当前或最近说话的人：${speakerName}` : "",
        speakerIdentity?.isCurrentUser === true || speakerIdentity?.is_current_user === true
          ? "这位说话者就是当前用户。"
          : "",
        participants.length ? `当前可见参会者：${participants.join("、")}` : "",
        currentTask.summary ? `当前正在处理的事：${String(currentTask.summary).slice(0, 500)}` : "",
        "回答时自然使用这些事实；如果事实不确定，简短澄清，不要猜。",
      ].filter(Boolean);
      return lines.join("\n").slice(0, contextLifecycleConfig().summaryMaxChars);
    }

    function makeContextSummaryItem(reason = "manual") {
      return {
        itemId: `ctx_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        type: "message",
        role: "system",
        status: "completed",
        content: [{ type: "input_text", text: buildSessionContextSummary() }],
        metadata: { source: "meeting_context_snapshot", reason },
      };
    }

    function buildCompactedHistory(history: unknown[] = [], reason = "manual") {
      const lifecycle = contextLifecycleConfig();
      const recentItems = Array.isArray(history) ? history.slice(-lifecycle.recentItems) : [];
      updateContextHealthFromHistory(history);
      return [makeContextSummaryItem(reason), ...recentItems];
    }

    function compactRealtimeHistory(reason = "manual") {
      const lifecycle = contextLifecycleConfig();
      if (!lifecycle.enabled) {
        return { ok: false, skipped: true, reason: "context_lifecycle_disabled" };
      }
      const session = getRealtimeAgentSession();
      if (!session || typeof session.updateHistory !== "function") {
        return { ok: false, skipped: true, reason: "sdk_history_unavailable" };
      }
      const before = currentHistorySnapshot();
      const beforeItems = before.length;
      const nextHistory = buildCompactedHistory(before, reason);
      session.updateHistory(() => nextHistory);
      const afterItems = nextHistory.length;
      state.contextHealth.compactCount += 1;
      state.contextHealth.lastCompactAt = new Date().toISOString();
      state.contextHealth.lastCompactReason = reason;
      state.contextHealth.lastCompactBeforeItems = beforeItems;
      state.contextHealth.lastCompactAfterItems = afterItems;
      state.contextHealth.lastSummaryChars = String(
        (nextHistory[0] as any)?.content?.[0]?.text || "",
      ).length;
      state.contextHealth.itemsCount = afterItems;
      state.contextHealth.tokenEstimate = estimateHistoryTokens(nextHistory);
      recordTimeline("realtime_context_compact", {
        reason,
        beforeItems,
        afterItems,
        summaryChars: state.contextHealth.lastSummaryChars,
        retainedRecentItems: Math.max(0, nextHistory.length - 1),
      });
      return {
        ok: true,
        reason,
        beforeItems,
        afterItems,
        retainedRecentItems: Math.max(0, nextHistory.length - 1),
        summaryChars: state.contextHealth.lastSummaryChars,
      };
    }

    function maybeCompactRealtimeHistory(reason = "history_updated") {
      const lifecycle = contextLifecycleConfig();
      const history = currentHistorySnapshot();
      updateContextHealthFromHistory(history);
      if (!lifecycle.enabled) return { ok: false, skipped: true, reason: "disabled" };
      if (
        history.length >= lifecycle.compactItemThreshold ||
        state.contextHealth.tokenEstimate >= lifecycle.compactTokenThreshold
      ) {
        return compactRealtimeHistory(reason);
      }
      return { ok: true, skipped: true, reason: "below_threshold" };
    }

    function pushSessionContext(
      input: {
        text?: string;
        signature?: string;
        reason?: string;
        kind?: string;
        value?: unknown;
        force?: boolean;
      } = {},
    ) {
      const lifecycle = contextLifecycleConfig();
      const signature = String(input.signature || input.text || input.reason || "").slice(0, 800);
      const nowMs = Date.now();
      if (
        !input.force &&
        signature &&
        signature === state.contextHealth.lastSignature &&
        nowMs - Number(state.contextHealth.lastSignatureAt || 0) < lifecycle.dedupeWindowMs
      ) {
        state.contextHealth.dedupeSkips += 1;
        recordTimeline("realtime_context_push_deduped", {
          reason: input.reason || "",
          signature: signature.slice(0, 120),
        });
        return { ok: true, skipped: true, reason: "dedupe_window" };
      }
      if (input.kind) rememberSessionContext(input.kind, input.value, input.reason || "push");
      state.contextHealth.lastSignature = signature;
      state.contextHealth.lastSignatureAt = nowMs;
      const text = String(input.text || buildSessionContextSummary()).trim();
      if (!text) return { ok: true, skipped: true, reason: "empty_context" };
      const channel = sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          metadata: {
            source: "context_push",
            reason: input.reason || "",
            kind: input.kind || "",
          },
          content: [{ type: "input_text", text }],
        },
      });
      recordTimeline("realtime_context_pushed", {
        reason: input.reason || "",
        kind: input.kind || "",
        channel,
        chars: text.length,
      });
      maybeCompactRealtimeHistory(input.reason || "context_push");
      return { ok: true, channel, chars: text.length };
    }

    function summarizeRealtimeEvent(event: unknown): RealtimeEventSummary {
      const eventObj = (typeof event === "object" && event !== null ? event : {}) as Record<
        string,
        unknown
      >;
      const summary: RealtimeEventSummary = {
        type: (eventObj.type as string | undefined) || typeof event,
      };
      const metadata = eventObj.metadata as { source?: string; reason?: string } | undefined;
      if (metadata?.source) summary.source = String(metadata.source).slice(0, 120);
      if (metadata?.reason) summary.reason = String(metadata.reason).slice(0, 200);
      const response = eventObj.response as { id?: string } | undefined;
      const responseId = response?.id || eventObj.response_id || eventObj.responseId;
      if (responseId) summary.responseId = String(responseId);
      const item = eventObj.item as { type?: string } | undefined;
      if (item?.type) summary.itemType = item.type;
      if (eventObj.name) summary.name = String(eventObj.name);
      const callId = (eventObj.call_id || eventObj.callId) as string | undefined;
      if (callId) summary.callId = callId;
      const errorObj = eventObj.error as { message?: string } | undefined;
      if (errorObj?.message) summary.error = String(errorObj.message).slice(0, 300);
      if (typeof eventObj.delta === "string") summary.delta = eventObj.delta.slice(0, 300);
      if (typeof eventObj.transcript === "string")
        summary.transcript = eventObj.transcript.slice(0, 500);
      if (typeof eventObj.text === "string") summary.text = eventObj.text.slice(0, 500);
      if (typeof event === "string") summary.text = event.slice(0, 300);
      return summary;
    }

    function rememberTranscriptEvent(event) {
      const type = String(event?.type || "");
      if (
        type === "conversation.item.input_audio_transcription.delta" &&
        typeof event.delta === "string"
      ) {
        state.transcripts.currentInput += event.delta;
        state.transcripts.currentInput = state.transcripts.currentInput.slice(-4000);
        return;
      }
      if (type === "conversation.item.input_audio_transcription.completed") {
        const text = String(event.transcript || state.transcripts.currentInput || "").trim();
        if (text) {
          state.transcripts.input.push({
            ts: new Date().toISOString(),
            itemId: String(event.item_id || event.itemId || ""),
            text: text.slice(0, 2000),
          });
          state.transcripts.input = state.transcripts.input.slice(-20);
          recordAudioFunctionalTranscript(text, {
            itemId: String(event.item_id || event.itemId || ""),
            eventType: type,
          });
          maybeDirectRouteAudioFunctionalTranscript(text);
        }
        state.transcripts.currentInput = "";
        return;
      }
      if (type === "response.output_audio_transcript.delta" && typeof event.delta === "string") {
        state.transcripts.currentOutput += event.delta;
        state.transcripts.currentOutput = state.transcripts.currentOutput.slice(-4000);
        return;
      }
      if (type === "response.output_audio_transcript.done") {
        const text = String(event.transcript || state.transcripts.currentOutput || "").trim();
        if (text) {
          state.transcripts.output.push({
            ts: new Date().toISOString(),
            responseId: String(event.response_id || event.responseId || ""),
            itemId: String(event.item_id || event.itemId || ""),
            text: text.slice(0, 2000),
          });
          state.transcripts.output = state.transcripts.output.slice(-10);
        }
        state.transcripts.currentOutput = "";
        return;
      }
    }

    function responseIdFromEvent(event): string {
      return String(event?.response?.id || event?.response_id || event?.responseId || "").trim();
    }

    function nativeInterruptionState() {
      state.protection.nativeInterruption = state.protection.nativeInterruption || {
        speech_started_at: "",
        api_interruption_at: "",
        response_cancelled_at: "",
        avatar_audio_stopped_at: "",
        truncate_sent_at: "",
        last_self_echo_suppressed_at: "",
        last_self_echo_reason: "",
        self_echo_suppressed_count: 0,
        last_self_echo_evidence: null,
        last_output_item_id: "",
        last_output_content_index: 0,
        last_output_audio_started_at: "",
        last_output_audio_event_at: "",
        last_output_audio_elapsed_ms: 0,
        truncate_count: 0,
        avatar_audio_stop_count: 0,
        last_event_type: "",
        last_source: "",
        last_stop_result: null,
      };
      return state.protection.nativeInterruption;
    }

    function outputItemIdFromEvent(event): string {
      return String(
        event?.item_id ||
          event?.itemId ||
          event?.output_item?.id ||
          event?.outputItem?.id ||
          event?.item?.id ||
          "",
      ).trim();
    }

    function outputContentIndexFromEvent(event): number {
      const raw = Number(event?.content_index ?? event?.contentIndex ?? 0);
      return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
    }

    function rememberRealtimeOutputAudioEvent(event) {
      const type = String(event?.type || "");
      if (
        type !== "response.output_audio.delta" &&
        type !== "response.output_audio.done" &&
        type !== "response.output_audio_transcript.delta" &&
        type !== "response.output_audio_transcript.done" &&
        type !== "response.output_item.added" &&
        type !== "response.output_item.done"
      ) {
        return;
      }
      const itemId = outputItemIdFromEvent(event);
      const contentIndex = outputContentIndexFromEvent(event);
      const interruption = nativeInterruptionState();
      if (itemId) interruption.last_output_item_id = itemId;
      interruption.last_output_content_index = contentIndex;
      interruption.last_output_audio_event_at = new Date().toISOString();
      if (type === "response.output_audio.delta" && !interruption.last_output_audio_started_at) {
        interruption.last_output_audio_started_at = new Date().toISOString();
      }
    }

    function selfEchoSuppressionWindowMs(): number {
      const raw = Number(config.selfEchoSuppressionWindowMs ?? 350);
      return Number.isFinite(raw) && raw > 0 ? raw : 0;
    }

    function selfEchoEventMarker(event): string {
      const values = [
        event?.source,
        event?.reason,
        event?.origin,
        event?.audio_source,
        event?.audioSource,
        event?.meeting_avatar_source,
        event?.meetingAvatarSource,
      ].map((value) => String(value || "").toLowerCase());
      if (event?.self_echo === true || event?.selfEcho === true) return "explicit_self_echo";
      if (event?.avatar_feedback === true || event?.avatarFeedback === true) {
        return "explicit_avatar_feedback";
      }
      if (values.some((value) => value.includes("avatar") || value.includes("self_echo"))) {
        return "event_source_avatar_feedback";
      }
      return "";
    }

    function avatarOutputSelfEchoEvidence(windowMs: number) {
      const avatarAudio = (window as any).MAB_AVATAR_AUDIO || {};
      const avatarBusState = (window as any).MAB_AVATAR_AUDIO_BUS?.state || {};
      const outputEnergy = avatarAudio.outputEnergy || avatarBusState.outputEnergy || {};
      const lastEnergyAt = String(outputEnergy.lastEnergyAt || "");
      const energyAgeMs = lastEnergyAt ? millisSinceIso(lastEnergyAt) : Number.POSITIVE_INFINITY;
      const syntheticSpeechActive =
        avatarAudio.syntheticSpeechActive === true || avatarBusState.syntheticSpeechActive === true;
      const recentEnergy =
        outputEnergy.observed === true &&
        lastEnergyAt &&
        Number.isFinite(energyAgeMs) &&
        energyAgeMs <= windowMs;
      return {
        recent: Boolean(syntheticSpeechActive || recentEnergy),
        reason: syntheticSpeechActive ? "avatar_synthetic_speech_active" : "avatar_output_energy",
        windowMs,
        energyAgeMs: Number.isFinite(energyAgeMs) ? Math.round(energyAgeMs) : null,
        outputEnergyObserved: outputEnergy.observed === true,
        outputEnergyRms: Number(outputEnergy.rms || 0),
        outputEnergyPeak: Number(outputEnergy.peak || 0),
        outputEnergyLastAt: lastEnergyAt,
        syntheticSpeechActive,
      };
    }

    function suppressSelfEchoSpeechStartedIfNeeded(event, source, now, interruption) {
      if (String(event?.type || "") !== "input_audio_buffer.speech_started") {
        return false;
      }
      const windowMs = selfEchoSuppressionWindowMs();
      if (windowMs <= 0) return false;
      const explicitMarker = selfEchoEventMarker(event);
      const avatarEvidence = avatarOutputSelfEchoEvidence(windowMs);
      if (!explicitMarker && !avatarEvidence.recent) return false;
      const reason = explicitMarker || avatarEvidence.reason;
      interruption.last_event_type = "input_audio_buffer.speech_started";
      interruption.last_source = source;
      interruption.last_self_echo_suppressed_at = now;
      interruption.last_self_echo_reason = reason;
      interruption.self_echo_suppressed_count =
        Number(interruption.self_echo_suppressed_count || 0) + 1;
      interruption.last_self_echo_evidence = avatarEvidence;
      try {
        (event as any).__meetingAvatarSelfEchoSuppressed = true;
      } catch {
        // Event summaries are best effort; immutable SDK payloads can still be suppressed locally.
      }
      recordTimeline("realtime_native_interruption_self_echo_suppressed", {
        type: "input_audio_buffer.speech_started",
        source,
        reason,
        evidence: avatarEvidence,
      });
      return true;
    }

    function shouldUseWebSocketTruncationFallback() {
      const mode = String(state.connection?.mode || config.mode || "").toLowerCase();
      const transport = String(config.transport || config.realtimeTransport || "").toLowerCase();
      return mode === "websocket" || transport === "websocket";
    }

    function computePlayedAudioMs(interruption) {
      const started = Date.parse(String(interruption.last_output_audio_started_at || ""));
      if (!Number.isFinite(started) || started <= 0) return 0;
      return Math.max(0, Math.round(Date.now() - started));
    }

    function maybeSendRealtimeTruncate(interruption) {
      if (!shouldUseWebSocketTruncationFallback()) {
        return { ok: true, skipped: true, reason: "server_managed_transport" };
      }
      const itemId = String(interruption.last_output_item_id || "").trim();
      if (!itemId) return { ok: false, skipped: true, reason: "missing_output_item_id" };
      const truncated = (interruption.truncated_output_item_ids || []) as string[];
      if (truncated.includes(itemId)) {
        return { ok: true, skipped: true, reason: "already_truncated", itemId };
      }
      const audioEndMs = computePlayedAudioMs(interruption);
      const channel = sendRealtimeEvent({
        type: "conversation.item.truncate",
        item_id: itemId,
        content_index: Number(interruption.last_output_content_index || 0),
        audio_end_ms: audioEndMs,
      });
      interruption.truncated_output_item_ids = [...truncated, itemId].slice(-20);
      interruption.truncate_sent_at = new Date().toISOString();
      interruption.truncate_count = Number(interruption.truncate_count || 0) + 1;
      interruption.last_output_audio_elapsed_ms = audioEndMs;
      recordTimeline("realtime_native_interruption_truncate_sent", {
        itemId,
        audioEndMs,
        channel,
      });
      return { ok: true, channel, itemId, audioEndMs };
    }

    function stopAvatarAudioForRealtimeInterruption(event, source) {
      const interruption = nativeInterruptionState();
      const bus = (window as any).MAB_AVATAR_AUDIO_BUS;
      const result =
        typeof bus?.interruptOutput === "function"
          ? bus.interruptOutput({ reason: "realtime_native_interruption" })
          : { ok: false, error: "avatar_audio_bus_interrupt_missing" };
      interruption.avatar_audio_stopped_at = new Date().toISOString();
      interruption.avatar_audio_stop_count = Number(interruption.avatar_audio_stop_count || 0) + 1;
      interruption.last_stop_result = result;
      recordTimeline("realtime_native_interruption_avatar_audio_stop", {
        type: String(event?.type || ""),
        source,
        ok: result?.ok !== false,
        stoppedBufferedSources: Number(result?.stoppedBufferedSources || 0),
        error: String(result?.error || ""),
      });
      return result;
    }

    function handleRealtimeNativeInterruption(event, source = "data-channel") {
      const type = String(event?.type || "");
      if (
        type !== "input_audio_buffer.speech_started" &&
        type !== "response.cancelled" &&
        type !== "agents_sdk.audio_interrupted" &&
        type !== "audio_interrupted"
      ) {
        return;
      }
      const now = new Date().toISOString();
      const interruption = nativeInterruptionState();
      if (suppressSelfEchoSpeechStartedIfNeeded(event, source, now, interruption)) {
        return;
      }
      interruption.last_event_type = type;
      interruption.last_source = source;
      if (type === "input_audio_buffer.speech_started") {
        state.protection.lastInputSpeechStartedAt = now;
        interruption.speech_started_at = now;
      }
      if (
        type === "response.cancelled" ||
        type === "agents_sdk.audio_interrupted" ||
        type === "audio_interrupted"
      ) {
        interruption.api_interruption_at = now;
      }
      if (type === "response.cancelled") {
        interruption.response_cancelled_at = now;
      }
      const stopResult = stopAvatarAudioForRealtimeInterruption(event, source);
      const truncateResult = maybeSendRealtimeTruncate(interruption);
      recordTimeline("realtime_native_interruption", {
        type,
        source,
        transport: String(state.connection?.mode || config.mode || ""),
        stopOk: stopResult?.ok !== false,
        truncate: truncateResult,
      });
    }

    function rememberResponseLifecycleEvent(event) {
      const type = String(event?.type || "");
      if (type === "response.created") {
        const responseId = responseIdFromEvent(event);
        if (responseId) state.protection.activeResponseId = responseId;
        return;
      }
      if (
        type === "response.done" ||
        type === "response.failed" ||
        type === "response.cancelled" ||
        type === "response.incomplete"
      ) {
        const responseId = responseIdFromEvent(event);
        if (!responseId || state.protection.activeResponseId === responseId) {
          state.protection.activeResponseId = "";
        }
      }
    }

    function appControlJobStaleMs(): number {
      const raw = Number(config.appControlJobStaleMs || config.turnPolicy?.appControlJobStaleMs);
      return Number.isFinite(raw) && raw > 0 ? raw : 45000;
    }

    function appControlJobStatus(value: unknown): string {
      return String((value as Record<string, unknown>)?.status || "")
        .trim()
        .toLowerCase();
    }

    function summarizeAppControlJobs(nowMs = Date.now()) {
      const jobs = Object.values(state.turnPolicy?.appControlJobs || {}) as Record<
        string,
        unknown
      >[];
      const staleMs = appControlJobStaleMs();
      let pending = 0;
      let stale = 0;
      let blocked = 0;
      let completed = 0;
      let newestUpdatedAt = "";
      let newestJobId = "";
      for (const job of jobs) {
        const status = appControlJobStatus(job);
        const jobId = String(job.jobId || "");
        const updatedAt = String(job.updatedAt || "");
        if (!newestUpdatedAt || updatedAt > newestUpdatedAt) {
          newestUpdatedAt = updatedAt;
          newestJobId = jobId;
        }
        if (["blocked", "failed", "error", "timeout"].includes(status)) {
          blocked += 1;
          continue;
        }
        if (["completed", "done", "success", "succeeded"].includes(status)) {
          completed += 1;
          continue;
        }
        if (["accepted", "queued", "running", "started"].includes(status)) {
          pending += 1;
          const updatedMs = Date.parse(updatedAt);
          if (Number.isFinite(updatedMs) && nowMs - updatedMs > staleMs) stale += 1;
        }
      }
      return {
        total: jobs.length,
        pending,
        stale,
        blocked,
        completed,
        staleMs,
        newestJobId,
        newestUpdatedAt,
      };
    }

    function matrixCell(
      status: FailureMatrixCell["status"],
      reason: string,
      signals: Record<string, unknown> = {},
    ): FailureMatrixCell {
      return { status, reason, signals };
    }

    function statusProblem(entry: FailureMatrixCell | null | undefined): boolean {
      return entry?.status === "blocked" || entry?.status === "waiting";
    }

    function hudStatusForFeedback(feedback: Record<string, any>): AvatarHudFeedbackStatus | null {
      const matrix = (feedback.failureMatrix || {}) as Record<string, FailureMatrixCell>;
      const checks = (feedback.checks || {}) as Record<string, any>;
      const transport = matrix.transport;
      if (statusProblem(transport)) {
        const reason = String(transport?.reason || "");
        return {
          statusKind: transport?.status === "blocked" ? "blocked" : "thinking",
          statusText:
            reason === "peer_not_connected" || reason === "data_channel_not_open"
              ? "Realtime 未连接"
              : "Realtime 连接中",
          holdMs: 6000,
        };
      }

      const audioInput = matrix.audioInput;
      if (statusProblem(audioInput)) {
        const reason = String(audioInput?.reason || "");
        return {
          statusKind: audioInput?.status === "blocked" ? "blocked" : "thinking",
          statusText:
            reason.includes("energy") || reason.includes("audio") ? "等待会议音频" : "音频未就绪",
          holdMs: 6000,
        };
      }

      const audioOutput = matrix.audioOutput;
      const hasModelOutput =
        Number(checks.outputTranscriptChars || 0) > 0 || Number(checks.responseEvents || 0) > 0;
      if (
        statusProblem(audioOutput) &&
        hasModelOutput &&
        audioOutput?.reason !== "waiting_for_model_response"
      ) {
        return {
          statusKind: "blocked",
          statusText: "语音输出无声",
          holdMs: 6000,
        };
      }

      const toolTurns = matrix.toolTurns;
      if (toolTurns?.status === "blocked") {
        return {
          statusKind: "blocked",
          statusText: "工具卡住",
          holdMs: 6000,
        };
      }

      return null;
    }

    function publishFeedbackHudStatus(feedback: Record<string, any>) {
      const hudState = ((state as any).feedbackHud ||= {
        lastKey: "",
        lastSentAt: 0,
      });
      const status = hudStatusForFeedback(feedback);
      const key = status ? `${status.statusKind}:${status.statusText}` : "";
      const now = Date.now();
      if (!key && !hudState.lastKey) return;
      if (key && key === hudState.lastKey && now - Number(hudState.lastSentAt || 0) < 5000) {
        return;
      }

      hudState.lastKey = key;
      hudState.lastSentAt = now;
      const payload = status
        ? {
            statusKind: status.statusKind,
            statusText: status.statusText,
            holdMs: status.holdMs,
          }
        : { statusKind: "idle", statusText: "", holdMs: 0 };

      const controller = (window as any).MAB_AVATAR_CONTROLLER;
      if (typeof controller?.updateState === "function") {
        const result = controller.updateState({
          status_kind: payload.statusKind,
          status_text: payload.statusText,
          status_hold_ms: payload.holdMs,
        });
        recordTimeline("realtime_feedback_hud", {
          statusKind: payload.statusKind,
          statusText: payload.statusText,
          hostForwarded: false,
          ok: result?.ok !== false,
        });
        return;
      }

      const host = (window as any).MAB_HOST_UPDATE_AVATAR_HUD;
      if (typeof host !== "function") return;
      Promise.resolve(host(payload))
        .then((result: any) => {
          recordTimeline("realtime_feedback_hud", {
            statusKind: payload.statusKind,
            statusText: payload.statusText,
            hostForwarded: true,
            ok: result?.ok === true,
            error: result?.ok === false ? result?.error || result?.reason || "" : "",
          });
          return undefined;
        })
        .catch((error) => {
          recordTimeline("realtime_feedback_hud", {
            statusKind: payload.statusKind,
            statusText: payload.statusText,
            hostForwarded: true,
            ok: false,
            error: String((error && error.message) || error).slice(0, 240),
          });
        });
    }

    function millisSinceIso(value: unknown) {
      const parsed = Date.parse(String(value || ""));
      if (!Number.isFinite(parsed)) return 0;
      return Math.max(0, Date.now() - parsed);
    }

    function classifyAudioInput(checks): AudioInputPolicy {
      const missingInputSince =
        state.connection.lastRealtimeInputReplaceAt ||
        state.connection.lastInboundEventAt ||
        state.connection.lastOutboundEventAt ||
        "";
      const missingInputMs = millisSinceIso(missingInputSince);
      const missingInputBlockAfterMs = 15_000;
      const signals = {
        participantAudioTracksAdded: state.connection.participantAudioTracksAdded,
        meetAudioTracksForwarded: state.connection.meetAudioTracksForwarded,
        realtimeInputPlaceholderAdded: checks.realtimeInputPlaceholderAdded,
        pendingMeetAudioTrackCount: state.connection.pendingMeetAudioTrackCount,
        currentRealtimeInputTrackId: state.connection.currentRealtimeInputTrackId,
        currentRealtimeInputSource: state.connection.currentRealtimeInputSource,
        currentRealtimeInputIsRoutingMix: state.connection.currentRealtimeInputIsRoutingMix,
        lastRealtimeInputReplaceReason: state.connection.lastRealtimeInputReplaceReason,
        meetAudioContextState: state.connection.meetAudioContextState || "",
        meetAudioSourcesActive: state.connection.meetAudioSourcesActive || 0,
        meetAudioSourcesUnmuted: state.connection.meetAudioSourcesUnmuted || 0,
        meetAudioTrackStates: state.connection.meetAudioTrackStates || [],
        recappiAudioInput: (state.connection as any).recappiAudioInput || null,
        meetAudioEnergy: state.connection.meetAudioEnergy,
        inputAudioMissingSince: missingInputSince,
        inputAudioMissingMs: missingInputMs,
        inputAudioMissingBlockAfterMs: missingInputBlockAfterMs,
      };
      if (!checks.meetParticipantAudioExpected && !checks.inputAudioAdded) {
        return {
          status: "disabled",
          reason: "audio_input_intentionally_disabled",
          ready: false,
          expected: false,
          source: "disabled",
          blockers: [],
          signals,
        };
      }
      if (checks.meetParticipantAudioExpected && !checks.meetParticipantAudioReady) {
        const blocked = missingInputMs >= missingInputBlockAfterMs;
        if (checks.meetAudioTracksForwarded > 0 && !checks.meetAudioRoutedToRealtimeInput) {
          return {
            status: blocked ? "blocked" : "waiting",
            reason: "meet_audio_not_routed_to_realtime_input",
            ready: false,
            expected: true,
            source: checks.currentRealtimeInputSource || "unknown",
            blockers: ["waiting_for_meet_audio", "meet_audio_not_routed_to_realtime_input"],
            signals,
          };
        }
        if (checks.realtimeInputPlaceholderAdded) {
          return {
            status: blocked ? "blocked" : "waiting",
            reason: "silent_input_placeholder_only",
            ready: false,
            expected: true,
            source: "silent_placeholder",
            blockers: ["waiting_for_meet_audio", "silent_input_placeholder_only"],
            signals,
          };
        }
      }
      if (!checks.inputAudioAdded) {
        const blocked =
          checks.meetParticipantAudioExpected && missingInputMs >= missingInputBlockAfterMs;
        return {
          status: blocked ? "blocked" : "waiting",
          reason: "input_audio_not_configured",
          ready: false,
          expected: checks.meetParticipantAudioExpected,
          source: "none",
          blockers: ["input_audio_not_configured"],
          signals,
        };
      }
      if (checks.meetParticipantAudioExpected && checks.meetAudioRoutedToRealtimeInput) {
        const source = checks.currentRealtimeInputSource || "unknown";
        const routedSourceNeedsEnergy = [
          "meet_audio_mix",
          "host_meet_audio_pcm",
          "recappi_process_audio_tap",
        ].includes(source);
        if (routedSourceNeedsEnergy && !checks.meetAudioEnergyObserved) {
          const blocked = missingInputMs >= missingInputBlockAfterMs;
          return {
            status: blocked ? "blocked" : "waiting",
            reason: "meet_audio_no_energy_observed",
            ready: false,
            expected: true,
            source,
            blockers: ["waiting_for_meet_audio", "meet_audio_no_energy_observed"],
            signals,
          };
        }
        if (
          routedSourceNeedsEnergy &&
          checks.meetAudioEnergyObserved &&
          checks.meetAudioSilenceMs > checks.meetAudioEnergyStaleMs
        ) {
          const blocked = checks.meetAudioSilenceMs >= missingInputBlockAfterMs;
          return {
            status: blocked ? "blocked" : "waiting",
            reason: "meet_audio_energy_stale",
            ready: false,
            expected: true,
            source,
            blockers: ["waiting_for_meet_audio", "meet_audio_energy_stale"],
            signals,
          };
        }
      }
      return {
        status: "ok",
        reason: "input_audio_ready",
        ready: true,
        expected: checks.meetParticipantAudioExpected,
        source: checks.meetParticipantAudioReady ? "meet_participant_audio" : "none",
        blockers: [],
        signals,
      };
    }

    function buildFailureMatrix(checks, appControlJobs, audioInputPolicy: AudioInputPolicy) {
      const transport = (() => {
        if (state.connection.lastTokenError && !checks.peerConnected) {
          return matrixCell("blocked", "token_exchange_failed", {
            status: state.connection.lastTokenError.status || "",
            retryScheduled: Boolean(state.connection.reconnecting),
          });
        }
        if (!checks.peerConnected) {
          return matrixCell("blocked", "peer_not_connected", {
            peerConnectionState: state.connection.peerConnectionState || "",
          });
        }
        if (!checks.dataChannelOpen) return matrixCell("blocked", "data_channel_not_open");
        if (!checks.sessionConfigured) return matrixCell("blocked", "session_not_configured");
        return matrixCell("ok", "peer_data_channel_and_session_ready", {
          peerConnectionState: state.connection.peerConnectionState || "",
        });
      })();

      const audioInput = matrixCell(
        audioInputPolicy.status,
        audioInputPolicy.reason,
        audioInputPolicy.signals,
      );

      const modelTurn = (() => {
        if (!checks.inboundEvents) return matrixCell("waiting", "no_realtime_server_events");
        if (
          checks.meetParticipantAudioExpected &&
          checks.meetAudioRoutedToRealtimeInput &&
          !checks.meetAudioEnergyObserved
        ) {
          return matrixCell("waiting", "meet_audio_no_energy_observed", {
            rms: checks.meetAudioEnergyRms,
            peak: checks.meetAudioEnergyPeak,
            lastCheckedAt: state.connection.meetAudioEnergy?.lastCheckedAt || "",
          });
        }
        if (
          checks.meetParticipantAudioExpected &&
          checks.meetAudioRoutedToRealtimeInput &&
          checks.meetAudioEnergyObserved &&
          checks.meetAudioSilenceMs > checks.meetAudioEnergyStaleMs &&
          !checks.modelTurnEvents
        ) {
          return matrixCell("waiting", "meet_audio_energy_stale", {
            silenceMs: checks.meetAudioSilenceMs,
            staleMs: checks.meetAudioEnergyStaleMs,
            lastEnergyAt: checks.meetAudioLastEnergyAt,
            rms: checks.meetAudioEnergyRms,
            peak: checks.meetAudioEnergyPeak,
          });
        }
        if (!checks.modelTurnEvents) return matrixCell("waiting", "no_model_turn_events");
        return matrixCell("ok", "model_turn_observed", {
          inboundEvents: checks.inboundEvents,
          responseEvents: checks.responseEvents,
          agentModelEvents: checks.agentModelEvents,
          avatarAudioOutputObserved: checks.avatarAudioOutputObserved,
          outputTranscriptChars: checks.outputTranscriptChars,
        });
      })();

      const toolTurns = (() => {
        if (checks.latestFunctionalTurnFakeExecution) {
          return matrixCell(
            "blocked",
            "assistant_text_without_expected_functional_tool",
            checks.latestFunctionalTurn || {},
          );
        }
        if (appControlJobs.blocked > 0) {
          return matrixCell("blocked", "app_control_job_blocked", appControlJobs);
        }
        if (appControlJobs.stale > 0) {
          return matrixCell("blocked", "app_control_job_stale", appControlJobs);
        }
        if (appControlJobs.pending > 0) {
          return matrixCell("waiting", "app_control_job_pending", appControlJobs);
        }
        return matrixCell("ok", "no_pending_tool_turns", appControlJobs);
      })();

      const audioOutput = (() => {
        if (!checks.modelTurnEvents) return matrixCell("waiting", "waiting_for_model_response");
        if (!checks.remoteAudioAttached) return matrixCell("blocked", "remote_audio_not_attached");
        if (!checks.remoteAudioRoutedToAvatarBus)
          return matrixCell("blocked", "remote_audio_not_routed");
        if (!checks.avatarAudioOutputObserved) {
          const reason = checks.realtimeRemoteAudioTrackObserved
            ? "avatar_bus_silent_despite_remote_audio"
            : "remote_audio_routed_but_silent";
          return matrixCell("waiting", reason, {
            maxRms: checks.avatarAudioOutputMaxRms,
            remoteAudioObserved: checks.realtimeRemoteAudioTrackObserved,
            remoteAudioEnergy: checks.realtimeRemoteAudioTrackEnergy,
            remoteAudioBytes: checks.realtimeRemoteAudioTrackBytes,
          });
        }
        return matrixCell("ok", "avatar_audio_energy_observed", {
          maxRms: checks.avatarAudioOutputMaxRms,
        });
      })();

      return {
        transport,
        audioInput,
        modelTurn,
        toolTurns,
        audioOutput,
      };
    }

    function deriveRuntimeState(feedback) {
      const matrix = feedback.failureMatrix || {};
      const firstBlockingCell = ["transport", "audioInput", "toolTurns", "modelTurn", "audioOutput"]
        .map((key) => [key, matrix[key]])
        .find(([, cell]) => cell?.status === "blocked" || cell?.status === "waiting");
      const phase = firstBlockingCell
        ? `${firstBlockingCell[0]}:${firstBlockingCell[1].reason}`
        : "ready";
      return {
        status: feedback.status,
        phase,
        reason: firstBlockingCell?.[1]?.reason || "ready",
        blockers: feedback.blockers || [],
        audioInputReady: feedback.audioInputPolicy?.ready === true,
        audioInputSource: feedback.audioInputPolicy?.source || "",
        canSpeak:
          matrix.audioOutput?.status === "ok" ||
          matrix.modelTurn?.status === "waiting" ||
          feedback.status === "waiting_for_model",
        toolTurnsHealthy: matrix.toolTurns?.status === "ok",
        updatedAt: feedback.updatedAt,
      };
    }

    function classifyRealtimeFeedback() {
      const appControlJobs = summarizeAppControlJobs();
      const avatarAudio = (window as any).MAB_AVATAR_AUDIO || {};
      const avatarOutputEnergy = avatarAudio.outputEnergy || {};
      const remoteAudioTrackStats = state.connection.realtimeRemoteAudioTrackStats || {};
      const responseEvents = state.inbound.filter((entry) =>
        String(entry.event?.type || "").startsWith("response."),
      ).length;
      const agentModelEvents = state.inbound.filter((entry) =>
        [
          "agents_sdk.agent_start",
          "agents_sdk.agent_end",
          "agents_sdk.audio_start",
          "agents_sdk.audio_stopped",
          "agents_sdk.audio_interrupted",
        ].includes(String(entry.event?.type || "")),
      ).length;
      const avatarAudioOutputObserved = avatarOutputEnergy.observed === true;
      const checks = {
        peerConnected:
          state.connected === true ||
          ["connected", "completed"].includes(state.connection.peerConnectionState),
        dataChannelOpen: state.connection.dataChannelOpen === true,
        sessionConfigured: state.session.configured === true,
        participantAudioForwardingEnabled:
          state.connection.participantAudioForwardingEnabled === true,
        meetAudioForwardingEnabled: state.connection.meetAudioForwardingEnabled === true,
        realtimeInputPlaceholderAdded: state.connection.realtimeInputPlaceholderAdded === true,
        inputAudioAdded:
          state.connection.participantAudioTracksAdded > 0 ||
          state.connection.meetAudioTracksForwarded > 0 ||
          (state.connection as any).recappiAudioInput?.connected === true,
        participantAudioAdded: state.connection.participantAudioTracksAdded > 0,
        meetAudioTracksForwarded: state.connection.meetAudioTracksForwarded,
        pendingMeetAudioTrackCount: state.connection.pendingMeetAudioTrackCount,
        currentRealtimeInputTrackId: state.connection.currentRealtimeInputTrackId,
        currentRealtimeInputSource: state.connection.currentRealtimeInputSource,
        currentRealtimeInputIsRoutingMix:
          state.connection.currentRealtimeInputIsRoutingMix === true,
        lastRealtimeInputReplaceReason: state.connection.lastRealtimeInputReplaceReason,
        meetAudioEnergyObserved: state.connection.meetAudioEnergy?.observed === true,
        meetAudioEnergyRms: Number(state.connection.meetAudioEnergy?.rms || 0),
        meetAudioEnergyPeak: Number(state.connection.meetAudioEnergy?.peak || 0),
        meetAudioLastEnergyAt: state.connection.meetAudioEnergy?.lastEnergyAt || "",
        meetAudioSilenceMs: Number(state.connection.meetAudioEnergy?.silenceMs || 0),
        meetAudioEnergyStaleMs: Number(state.connection.meetAudioEnergyStaleMs || 10000),
        meetParticipantAudioExpected:
          state.connection.participantAudioForwardingEnabled === true ||
          state.connection.meetAudioForwardingEnabled === true,
        meetParticipantAudioReady:
          (state.connection as any).recappiAudioInput?.connected === true ||
          (state.connection.meetAudioTracksForwarded === 0 &&
            state.connection.participantAudioTracksAdded > 0 &&
            state.connection.currentRealtimeInputSource === "direct_participant_audio") ||
          (state.connection.meetAudioTracksForwarded > 0 &&
            state.connection.currentRealtimeInputIsRoutingMix === true),
        meetAudioRoutedToRealtimeInput:
          (state.connection.meetAudioTracksForwarded > 0 ||
            (state.connection as any).recappiAudioInput?.connected === true) &&
          state.connection.currentRealtimeInputIsRoutingMix === true,
        recvOnlyAudioTransceiverAdded: state.connection.recvOnlyAudioTransceiverAdded === true,
        inboundEvents: state.inbound.length,
        responseEvents,
        agentModelEvents,
        modelTurnEvents: responseEvents + agentModelEvents + (avatarAudioOutputObserved ? 1 : 0),
        remoteAudioAttached: state.connection.remoteAudioAttached === true,
        remoteAudioRoutedToAvatarBus: state.connection.remoteAudioRoutedToAvatarBus === true,
        realtimeRemoteAudioTrackObserved: remoteAudioTrackStats.observed === true,
        realtimeRemoteAudioTrackEnergy: Number(remoteAudioTrackStats.totalAudioEnergy || 0),
        realtimeRemoteAudioTrackBytes: Number(remoteAudioTrackStats.bytesReceived || 0),
        avatarAudioOutputObserved,
        avatarAudioOutputMaxRms: Number(avatarOutputEnergy.maxRms || 0),
        avatarToolCalls: state.avatarTools.calls.length,
        workerToolCalls: state.workerTools.calls.length,
        meetToolCalls: state.meetTools.calls.length,
        workspaceToolCalls: state.workspaceTools.calls.length,
        latestFunctionalTurn: state.contextHealth.latestFunctionalTurn || null,
        latestFunctionalTurnFakeExecution:
          state.contextHealth.latestFunctionalTurn?.fakeExecution === true,
        latestFunctionalTurnToolCalled:
          state.contextHealth.latestFunctionalTurn?.toolCalled === true,
        appControlJobTotal: appControlJobs.total,
        appControlJobsPending: appControlJobs.pending,
        appControlJobsStale: appControlJobs.stale,
        appControlJobsBlocked: appControlJobs.blocked,
        outputTranscriptChars: state.transcripts.output.reduce(
          (sum, entry) => sum + String(entry.text || "").length,
          0,
        ),
        blockedUserTextEvents: state.connection.blockedUserTextEvents || 0,
        errors: state.errors.length,
      };
      const audioInputPolicy = classifyAudioInput(checks);
      const failureMatrix = buildFailureMatrix(checks, appControlJobs, audioInputPolicy);
      const blockers = [];
      let status = "ready";
      let summary;

      if (state.connection.lastTokenError && !checks.peerConnected) {
        const tokenStatus = Number(state.connection.lastTokenError.status || 0);
        const tokenReason = String(state.connection.lastTokenError.reason || "");
        status = "blocked";
        if (tokenReason === "realtime_token_insufficient_quota") {
          summary = "Realtime client secret request is blocked by OpenAI quota/billing.";
          blockers.push("realtime_token_insufficient_quota");
        } else {
          summary =
            tokenStatus === 429
              ? "Realtime client secret request is rate limited; reconnect retry is scheduled."
              : "Realtime client secret request failed before the peer connection opened.";
          blockers.push(
            tokenStatus === 429 ? "realtime_token_rate_limited" : "realtime_token_failed",
          );
        }
      } else if (checks.errors) {
        status = "error";
        summary = "Realtime bridge reported errors.";
        blockers.push("bridge_errors_present");
      } else if (!checks.peerConnected) {
        status = "blocked";
        summary = "Realtime peer connection is not connected.";
        blockers.push("peer_not_connected");
      } else if (!checks.dataChannelOpen) {
        status = "blocked";
        summary = "Realtime data channel is not open.";
        blockers.push("data_channel_not_open");
      } else if (!checks.sessionConfigured) {
        status = "blocked";
        summary = "Realtime session.update has not been sent.";
        blockers.push("session_not_configured");
      } else if (checks.latestFunctionalTurnFakeExecution) {
        status = "tool_blocked";
        summary =
          state.contextHealth.latestFunctionalTurn?.source === "manual_text_turn"
            ? "Realtime text-turn replay produced model activity without SDK history evidence or a matching share/control tool call."
            : "Realtime answered a functional share/control request without an observed matching tool call in the SDK history tail.";
        blockers.push("assistant_text_without_expected_functional_tool");
      } else if (
        audioInputPolicy.expected &&
        !audioInputPolicy.ready &&
        audioInputPolicy.blockers.length
      ) {
        const audioInputBlocked = audioInputPolicy.status === "blocked";
        status = audioInputBlocked ? "blocked" : "waiting_for_turn";
        summary = audioInputBlocked
          ? "Realtime is connected, but required Meet/Recappi audio input never became available."
          : "Realtime is connected with a silent input placeholder; waiting for Meet participant audio.";
        blockers.push(...audioInputPolicy.blockers);
      } else if (appControlJobs.blocked > 0) {
        status = "tool_blocked";
        summary = "Realtime has a blocked app-control job that needs a visible recovery path.";
        blockers.push("app_control_job_blocked");
      } else if (appControlJobs.stale > 0) {
        status = "tool_blocked";
        summary = "Realtime has an app-control job that stayed pending too long.";
        blockers.push("app_control_job_stale");
      } else if (!checks.inboundEvents) {
        if (!audioInputPolicy.ready) {
          status = "waiting_for_turn";
          summary =
            audioInputPolicy.reason === "silent_input_placeholder_only"
              ? "Realtime is connected with a silent input placeholder; waiting for Meet participant audio."
              : "Realtime is connected in output-only mode; send a text/tool turn or enable Meet audio forwarding.";
          blockers.push(
            ...(audioInputPolicy.blockers.length
              ? audioInputPolicy.blockers
              : [audioInputPolicy.reason]),
          );
        } else {
          status = "waiting_for_model";
          summary = "Realtime is connected, but no server events have been received yet.";
          blockers.push("no_realtime_server_events");
        }
      } else if (
        checks.meetParticipantAudioExpected &&
        checks.meetAudioRoutedToRealtimeInput &&
        !checks.meetAudioEnergyObserved &&
        !checks.modelTurnEvents
      ) {
        status = "waiting_for_turn";
        summary =
          "Realtime input is routed through the Meet audio mix, but no mixer energy has been observed yet.";
        blockers.push("meet_audio_no_energy_observed");
      } else if (
        checks.meetParticipantAudioExpected &&
        checks.meetAudioRoutedToRealtimeInput &&
        checks.meetAudioEnergyObserved &&
        checks.meetAudioSilenceMs > checks.meetAudioEnergyStaleMs &&
        !checks.modelTurnEvents
      ) {
        status = "waiting_for_turn";
        summary =
          "Realtime input is routed through the Meet audio mix, but recent mixer energy is stale.";
        blockers.push("meet_audio_energy_stale");
      } else if (!checks.modelTurnEvents) {
        status = "waiting_for_response";
        summary =
          "Realtime server events are arriving, but no model turn activity has been observed.";
        blockers.push("no_model_turn_events");
      } else if (!checks.remoteAudioAttached) {
        status = "output_blocked";
        summary = "Realtime response events exist, but no remote audio track is attached.";
        blockers.push("remote_audio_not_attached");
      } else if (!checks.remoteAudioRoutedToAvatarBus) {
        status = "output_blocked";
        summary = "Realtime remote audio is attached but not routed into the avatar audio bus.";
        blockers.push("remote_audio_not_routed");
      } else {
        summary = audioInputPolicy.ready
          ? "Realtime E2E transport is healthy: input track, model events, output audio, and avatar audio route are present."
          : "Realtime output path is healthy for text/tool turns; audio input is intentionally disabled to avoid avatar self-echo.";
      }

      if (
        checks.latestFunctionalTurnFakeExecution &&
        !blockers.includes("assistant_text_without_expected_functional_tool")
      ) {
        blockers.push("assistant_text_without_expected_functional_tool");
      }

      const feedback = {
        status,
        summary,
        blockers,
        checks,
        audioInputPolicy,
        failureMatrix,
        updatedAt: new Date().toISOString(),
      };
      return { ...feedback, runtimeState: deriveRuntimeState(feedback) };
    }

    function updateFeedback() {
      updateContextHealthFromHistory(currentHistorySnapshot());
      state.feedback = classifyRealtimeFeedback();
      state.audioInputPolicy = state.feedback.audioInputPolicy;
      state.runtimeState = state.feedback.runtimeState;
      publishFeedbackHudStatus(state.feedback);
      return state.feedback;
    }

    function rememberInboundEvent(event, source = "data-channel") {
      const summary = summarizeRealtimeEvent(event);
      if (summary.type === "session.created") {
        const sessionId = String((event as any)?.session?.id || "");
        if (sessionId) state.connection.openaiSessionId = sessionId;
      }
      state.inbound.push({
        ts: new Date().toISOString(),
        source,
        event: summary,
      });
      state.inbound = state.inbound.slice(-100);
      state.connection.dataChannelMessagesReceived += 1;
      state.connection.lastInboundEventAt = new Date().toISOString();
      state.connection.lastInboundEventType = summary.type || "";
      rememberTranscriptEvent(event);
      rememberRealtimeOutputAudioEvent(event);
      rememberResponseLifecycleEvent(event);
      handleRealtimeNativeInterruption(event, source);
      recordTimeline("realtime_inbound", { source, ...summary });
      updateFeedback();
    }

    return {
      buildCompactedHistory,
      buildSessionContextSummary,
      compactRealtimeHistory,
      currentHistorySnapshot,
      maybeCompactRealtimeHistory,
      pushSessionContext,
      rememberInboundEvent,
      recordManualFunctionalTextTurn,
      rememberSessionContext,
      rememberTranscriptEvent,
      summarizeRealtimeEvent,
      updateContextHealthFromHistory,
      updateFeedback,
    };
  }

  (window as any).__MAB_REALTIME_CONTEXT_HELPERS = { create };
})();
