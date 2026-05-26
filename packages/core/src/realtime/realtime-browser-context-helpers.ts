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

    function classifyAudioInput(checks): AudioInputPolicy {
      const signals = {
        participantAudioTracksAdded: state.connection.participantAudioTracksAdded,
        meetAudioTracksForwarded: state.connection.meetAudioTracksForwarded,
        localAudioTrackAdded: checks.localAudioTrackAdded,
        realtimeInputPlaceholderAdded: checks.realtimeInputPlaceholderAdded,
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
        if (checks.onlyLocalMicFallbackInput) {
          return {
            status: "waiting",
            reason: "only_local_mic_fallback_input",
            ready: false,
            expected: true,
            source: "local_mic_fallback",
            blockers: ["waiting_for_meet_audio", "only_local_mic_fallback_input"],
            signals,
          };
        }
        if (checks.realtimeInputPlaceholderAdded) {
          return {
            status: "waiting",
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
        return {
          status: "waiting",
          reason: "input_audio_not_configured",
          ready: false,
          expected: checks.meetParticipantAudioExpected,
          source: "none",
          blockers: ["input_audio_not_configured"],
          signals,
        };
      }
      return {
        status: "ok",
        reason: "input_audio_ready",
        ready: true,
        expected: checks.meetParticipantAudioExpected,
        source: checks.meetParticipantAudioReady ? "meet_participant_audio" : "local_mic",
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
        if (state.connection.lastSdpError && !checks.peerConnected) {
          return matrixCell("blocked", "sdp_exchange_failed", {
            status: state.connection.lastSdpError.status || "",
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
        if (!checks.responseEvents) return matrixCell("waiting", "no_response_events");
        return matrixCell("ok", "response_events_observed", {
          inboundEvents: checks.inboundEvents,
          responseEvents: checks.responseEvents,
          inputTranscriptChars: checks.inputTranscriptChars,
          outputTranscriptChars: checks.outputTranscriptChars,
        });
      })();

      const toolTurns = (() => {
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
        if (!checks.responseEvents) return matrixCell("waiting", "waiting_for_model_response");
        if (!checks.remoteAudioAttached) return matrixCell("blocked", "remote_audio_not_attached");
        if (!checks.remoteAudioRoutedToAvatarBus)
          return matrixCell("blocked", "remote_audio_not_routed");
        return matrixCell("ok", "remote_audio_routed_to_avatar_bus");
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
        meetParticipantAudioExpected:
          state.connection.participantAudioForwardingEnabled === true ||
          state.connection.meetAudioForwardingEnabled === true,
        meetParticipantAudioReady:
          state.connection.participantAudioTracksAdded > 0 ||
          state.connection.meetAudioTracksForwarded > 0,
        onlyLocalMicFallbackInput:
          state.connection.localAudioTrackAdded === true &&
          state.connection.participantAudioTracksAdded === 0 &&
          state.connection.meetAudioTracksForwarded === 0,
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
        appControlJobTotal: appControlJobs.total,
        appControlJobsPending: appControlJobs.pending,
        appControlJobsStale: appControlJobs.stale,
        appControlJobsBlocked: appControlJobs.blocked,
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
      } else if (state.connection.lastSdpError && !checks.peerConnected) {
        const sdpStatus = Number(state.connection.lastSdpError.status || 0);
        const sdpReason = String(state.connection.lastSdpError.reason || "");
        status = "blocked";
        if (sdpReason === "realtime_sdp_insufficient_quota") {
          summary = "Realtime SDP exchange is blocked by OpenAI quota/billing.";
          blockers.push("realtime_sdp_insufficient_quota");
        } else {
          summary =
            sdpStatus === 429
              ? "Realtime SDP exchange is rate limited; reconnect retry is scheduled."
              : "Realtime SDP exchange failed before the peer connection opened.";
          blockers.push(sdpStatus === 429 ? "realtime_sdp_rate_limited" : "realtime_sdp_failed");
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
      } else if (audioInputPolicy.expected && !audioInputPolicy.ready && audioInputPolicy.blockers.length) {
        status = "waiting_for_turn";
        summary = audioInputPolicy.source === "local_mic_fallback"
          ? "Realtime is connected with only local mic fallback; waiting for Meet participant audio."
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
          summary = audioInputPolicy.reason === "silent_input_placeholder_only"
            ? "Realtime is connected with a silent input placeholder; waiting for Meet participant audio."
            : "Realtime is connected in output-only mode; send a text/tool turn or enable Meet audio forwarding.";
          blockers.push(...(audioInputPolicy.blockers.length ? audioInputPolicy.blockers : [audioInputPolicy.reason]));
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
        summary = audioInputPolicy.ready
          ? "Realtime E2E transport is healthy: input track, model events, output audio, and avatar audio route are present."
          : "Realtime output path is healthy for text/tool turns; audio input is intentionally disabled to avoid avatar self-echo.";
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
      state.feedback = classifyRealtimeFeedback();
      state.audioInputPolicy = state.feedback.audioInputPolicy;
      state.runtimeState = state.feedback.runtimeState;
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
