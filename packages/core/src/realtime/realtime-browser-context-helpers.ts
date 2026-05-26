(() => {
  interface RealtimeEventSummary {
    type: string;
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
      const response = eventObj.response as { id?: string } | undefined;
      if (response?.id) summary.responseId = response.id;
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
            text: text.slice(0, 2000),
          });
          state.transcripts.output = state.transcripts.output.slice(-10);
        }
        state.transcripts.currentOutput = "";
        return;
      }
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
            text: text.slice(0, 2000),
          });
          state.transcripts.input = state.transcripts.input.slice(-10);
        }
        state.transcripts.currentInput = "";
      }
    }

    function classifyRealtimeFeedback() {
      const checks = {
        peerConnected:
          state.connected === true ||
          ["connected", "completed"].includes(state.connection.peerConnectionState),
        dataChannelOpen: state.connection.dataChannelOpen === true,
        sessionConfigured: state.session.configured === true,
        participantAudioForwardingEnabled:
          state.connection.participantAudioForwardingEnabled === true,
        meetAudioForwardingEnabled: state.connection.meetAudioForwardingEnabled === true,
        localAudioFallbackEnabled: state.connection.localAudioFallbackEnabled === true,
        localAudioRoutedToRealtimeMix: state.connection.localAudioRoutedToRealtimeMix === true,
        realtimeInputPlaceholderAdded: state.connection.realtimeInputPlaceholderAdded === true,
        inputAudioAdded:
          state.connection.participantAudioTracksAdded > 0 ||
          state.connection.meetAudioTracksForwarded > 0 ||
          state.connection.localAudioTrackAdded === true,
        participantAudioAdded: state.connection.participantAudioTracksAdded > 0,
        meetAudioTracksForwarded: state.connection.meetAudioTracksForwarded,
        localAudioTrackAdded: state.connection.localAudioTrackAdded === true,
        recvOnlyAudioTransceiverAdded: state.connection.recvOnlyAudioTransceiverAdded === true,
        inboundEvents: state.inbound.length,
        responseEvents: state.inbound.filter((entry) =>
          String(entry.event?.type || "").startsWith("response."),
        ).length,
        remoteAudioAttached: state.connection.remoteAudioAttached === true,
        remoteAudioRoutedToAvatarBus: state.connection.remoteAudioRoutedToAvatarBus === true,
        avatarToolCalls: state.avatarTools.calls.length,
        workerToolCalls: state.workerTools.calls.length,
        meetToolCalls: state.meetTools.calls.length,
        workspaceToolCalls: state.workspaceTools.calls.length,
        inputTranscriptChars: state.transcripts.input.reduce(
          (sum, entry) => sum + String(entry.text || "").length,
          0,
        ),
        outputTranscriptChars: state.transcripts.output.reduce(
          (sum, entry) => sum + String(entry.text || "").length,
          0,
        ),
        errors: state.errors.length,
      };
      const blockers = [];
      let status = "ready";
      let summary;

      if (state.connection.lastTokenError && !checks.peerConnected) {
        const tokenStatus = Number(state.connection.lastTokenError.status || 0);
        status = "blocked";
        summary =
          tokenStatus === 429
            ? "Realtime client secret request is rate limited; reconnect retry is scheduled."
            : "Realtime client secret request failed before the peer connection opened.";
        blockers.push(
          tokenStatus === 429 ? "realtime_token_rate_limited" : "realtime_token_failed",
        );
      } else if (state.connection.lastSdpError && !checks.peerConnected) {
        const sdpStatus = Number(state.connection.lastSdpError.status || 0);
        status = "blocked";
        summary =
          sdpStatus === 429
            ? "Realtime SDP exchange is rate limited; reconnect retry is scheduled."
            : "Realtime SDP exchange failed before the peer connection opened.";
        blockers.push(sdpStatus === 429 ? "realtime_sdp_rate_limited" : "realtime_sdp_failed");
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
      } else if (!checks.inboundEvents) {
        if (!checks.inputAudioAdded) {
          status = "waiting_for_turn";
          summary = checks.realtimeInputPlaceholderAdded
            ? "Realtime is connected with a silent input placeholder; waiting for Meet participant audio."
            : "Realtime is connected in output-only mode; send a text/tool turn or enable Meet audio forwarding.";
          blockers.push(
            checks.realtimeInputPlaceholderAdded
              ? "waiting_for_meet_audio"
              : "input_audio_not_configured",
          );
        } else {
          status = "waiting_for_model";
          summary = "Realtime is connected, but no server events have been received yet.";
          blockers.push("no_realtime_server_events");
        }
      } else if (!checks.responseEvents) {
        status = "waiting_for_response";
        summary = "Realtime server events are arriving, but no response events have been observed.";
        blockers.push("no_response_events");
      } else if (!checks.remoteAudioAttached) {
        status = "output_blocked";
        summary = "Realtime response events exist, but no remote audio track is attached.";
        blockers.push("remote_audio_not_attached");
      } else if (!checks.remoteAudioRoutedToAvatarBus) {
        status = "output_blocked";
        summary = "Realtime remote audio is attached but not routed into the avatar audio bus.";
        blockers.push("remote_audio_not_routed");
      } else {
        summary = checks.inputAudioAdded
          ? "Realtime E2E transport is healthy: input track, model events, output audio, and avatar audio route are present."
          : "Realtime output path is healthy for text/tool turns; audio input is intentionally disabled to avoid avatar self-echo.";
      }

      return {
        status,
        summary,
        blockers,
        checks,
        updatedAt: new Date().toISOString(),
      };
    }

    function updateFeedback() {
      state.feedback = classifyRealtimeFeedback();
      return state.feedback;
    }

    function rememberInboundEvent(event, source = "data-channel") {
      const summary = summarizeRealtimeEvent(event);
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
      rememberSessionContext,
      rememberTranscriptEvent,
      summarizeRealtimeEvent,
      updateContextHealthFromHistory,
      updateFeedback,
    };
  }

  (window as any).__MAB_REALTIME_CONTEXT_HELPERS = { create };
})();
