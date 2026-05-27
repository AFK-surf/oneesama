async function injectWorkerResult(job) {
  const scope = shouldDeliverWorkerResult(job);
  if (!scope.ok) {
    const suppressed = rememberSuppressedWorkerResult(job, scope.reason, scope);
    state.workerResults.push(suppressed);
    state.workerResults = state.workerResults.slice(-50);
    return suppressed;
  }
  if (rememberInjectedWorkerJob(job.id)) {
    const duplicate = {
      ts: new Date().toISOString(),
      jobId: job.id,
      status: job.status,
      duplicate: true,
    };
    state.workerResults.push(duplicate);
    state.workerResults = state.workerResults.slice(-50);
    return duplicate;
  }
  if (isNoActionWorkerJob(job)) {
    const suppressed = rememberSuppressedWorkerResult(job, "no_action_result", scope);
    state.workerResults.push(suppressed);
    state.workerResults = state.workerResults.slice(-50);
    return suppressed;
  }
  const interrupt = cancelActiveResponse("worker_result_ready");
  const delivery = await deliverWorkerResult(job, { interrupt });
  state.workerResults.push(delivery);
  state.workerResults = state.workerResults.slice(-50);
  return delivery;
}

function normalizeCaptionTurnText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function captionSpeakerMatchesBot(speaker) {
  const normalized = normalizeCaptionTurnText(speaker).toLowerCase();
  const botName = normalizeCaptionTurnText(config.botName || "").toLowerCase();
  if (!normalized || !botName) return false;
  return normalized === botName || normalized.includes(botName) || botName.includes(normalized);
}

function captionTurnDebounceMs() {
  const value = Number(config.captionTurnDebounceMs || 900);
  if (!Number.isFinite(value)) return 900;
  return Math.max(250, Math.min(value, 3000));
}

function injectCaptionTurn(
  rawEvent: { text?: unknown; speaker?: unknown; streamId?: unknown; ts?: unknown } = {},
) {
  if (config.captionTurnFallback === false) {
    return { ok: true, skipped: true, reason: "caption_turn_fallback_disabled" };
  }
  const text = normalizeCaptionTurnText(rawEvent.text || "");
  const speaker = normalizeCaptionTurnText(rawEvent.speaker || "unknown") || "unknown";
  const streamId = normalizeCaptionTurnText(rawEvent.streamId || speaker || "caption");
  if (!text) return { ok: true, skipped: true, reason: "empty_caption_turn" };
  if (captionSpeakerMatchesBot(speaker)) {
    return { ok: true, skipped: true, reason: "bot_caption_turn" };
  }

  state.connection.captionTurnsObserved = (state.connection.captionTurnsObserved || 0) + 1;
  const key = streamId || speaker;
  const signature = `${speaker}\n${text}`;
  if (captionTurnSubmitted.get(key) === signature) {
    return { ok: true, skipped: true, reason: "duplicate_caption_turn", key };
  }
  const pending = captionTurnTimers.get(key);
  if (pending) window.clearTimeout(pending);

  const delayMs = captionTurnDebounceMs();
  const timer = window.setTimeout(() => {
    captionTurnTimers.delete(key);
    state.connection.captionTurnsPending = captionTurnTimers.size;
    if (captionTurnSubmitted.get(key) === signature) return;
    captionTurnSubmitted.set(key, signature);
    if (captionTurnSubmitted.size > 60) {
      const firstKey = captionTurnSubmitted.keys().next().value;
      if (firstKey) captionTurnSubmitted.delete(firstKey);
    }
    const interrupt = cancelActiveResponse("meet_caption_observer");
    const itemChannel = sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        metadata: {
          source: "meet_caption_observer",
          speaker,
          streamId: key,
          captionTs: rawEvent.ts || "",
        },
        content: [
          {
            type: "input_text",
            text,
          },
        ],
      },
    });
    const responseChannel = sendRealtimeEvent({
      type: "response.create",
      response: {
        instructions:
          "Reply to the user's latest captioned speech in concise Chinese. Treat this as live meeting speech, not a debug transcript. Do not mention captions, fallback paths, routing, or internal state.",
      },
    });
    state.responsesRequested += 1;
    state.connection.captionTurnsInjected = (state.connection.captionTurnsInjected || 0) + 1;
    state.connection.lastCaptionTurnAt = new Date().toISOString();
    state.connection.lastCaptionTurnSpeaker = speaker;
    state.connection.lastCaptionTurnText = text.slice(0, 500);
    recordTimeline("meet_caption_turn_injected", {
      speaker,
      streamId: key,
      chars: text.length,
      itemChannel,
      responseChannel,
      interrupted: !interrupt?.skipped,
    });
    updateFeedback();
  }, delayMs);
  captionTurnTimers.set(key, timer);
  state.connection.captionTurnsPending = captionTurnTimers.size;
  recordTimeline("meet_caption_turn_scheduled", {
    speaker,
    streamId: key,
    chars: text.length,
    delayMs,
  });
  updateFeedback();
  return { ok: true, scheduled: true, key, delayMs };
}

async function simulateRealtimeAgentToolCall(name, args = {}) {
  if (!isLocalToolName(name)) {
    throw new Error(`unsupported local tool for SDK smoke: ${name}`);
  }
  const callId = `mock_call_${randomEventId()}`;
  const execution = await runLocalToolForSDK(name, args, callId);
  recordTimeline("realtime_agent_sdk_mock_tool_call", { name, callId });
  return { ok: true, name, callId, result: execution.result, delivery: execution.delivery };
}

window.MAB_REALTIME_CLIENT = {
  state,
  connect: connectRealtime,
  disconnect: cleanupRealtimeConnection,
  reconnect: (reason = "manual") => {
    cleanupRealtimeConnection(reason);
    return connectRealtime();
  },
  cancelActiveResponse,
  sendSessionUpdate,
  runLocalAvatarTool,
  runLocalWorkerTool,
  runLocalMeetTool,
  runRealtimeAgentSDKTool: simulateRealtimeAgentToolCall,
  simulateRealtimeAgentToolCall,
  sendRealtimeEvent,
  pushSessionContext,
  rememberSessionContext,
  contextHealth: () => updateContextHealthFromHistory(currentHistorySnapshot()),
  buildCompactedHistory,
  compactRealtimeHistory,
  resetHistory: compactRealtimeHistory,
  discoverParticipantAudioStreams,
  registerParticipantAudioStream,
  stopMeetAudioCapture,
  injectCaptionTurn,
  injectWorkerResult,
  sendWorkerResult: injectWorkerResult,
};

window.MAB_REALTIME_BRIDGE = state as unknown as Record<string, unknown>;

window.addEventListener("meeting-avatar-worker-result", (event: Event) => {
  try {
    const detail = (event as CustomEvent).detail || {};
    if (detail?.status === "failed") {
      updateAvatarHudStatus("blocked", "Blocked", { mood: "sad", action: "shrug" });
    } else if (detail?.status === "completed" || detail?.status === "done") {
      updateAvatarHudStatus("done", "Done", { mood: "happy", action: "emphasize" });
    }
    injectWorkerResult(detail);
  } catch (error) {
    rememberError(error);
  }
});

window.addEventListener("meeting-avatar-realtime-server-event", (event: Event) => {
  const detail = (event as CustomEvent).detail as { __meetingAvatarInboundRecorded?: boolean };
  if (detail?.__meetingAvatarInboundRecorded !== true) {
    rememberInboundEvent(detail, "custom-event");
  }
  handleRealtimeServerEvent(detail);
});

window.addEventListener("meeting-avatar-user-speech-started", () => {
  const result = cancelActiveResponse("user_speech_started");
  if (!result.skipped) state.protection.userSpeechCancels += 1;
});

installParticipantAudioDiscovery();

if (config.autoConnect && shouldAutoConnectInCurrentDocument()) {
  window.setTimeout(() => connectRealtime(), 0);
}
