async function updateAppControlWorkerHud(job, delivery) {
  if (shouldVoiceAckWorkerResult(job)) return;
  const status = String(job?.status || "")
    .trim()
    .toLowerCase();
  rememberKWWKActionTelemetry(job);
  const cursorPoint = latestKWWKCursorFeedbackPoint(job);
  if (delivery?.policy?.reason === "app_control_executor_running") {
    updateAvatarHudStatus("thinking", "正在操作应用", {
      mood: "thinking",
      action: "think",
      holdMs: 45000,
    });
    if (cursorPoint) await updateKWWKCursorFeedback("move", "操作中", cursorPoint);
  } else if (status === "failed" || status === "timeout") {
    updateAvatarHudStatus("blocked", "操作受阻", { mood: "sad", action: "shrug" });
    if (cursorPoint) await updateKWWKCursorFeedback("blocked", "操作受阻", cursorPoint);
  } else if (status === "completed") {
    updateAvatarHudStatus("done", "操作完成", { mood: "happy", action: "emphasize" });
    if (cursorPoint) await updateKWWKCursorFeedback(cursorPoint.kind, "完成", cursorPoint);
  }
}

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
  const interrupt = shouldVoiceAckWorkerResult(job)
    ? cancelActiveResponse("worker_result_ready")
    : { skipped: true, reason: "worker_result_meet_chat_only" };
  const delivery = await deliverWorkerResult(job, { interrupt });
  await updateAppControlWorkerHud(job, delivery);
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

function observeCaptionSpeakerSignal(
  rawEvent: { text?: unknown; speaker?: unknown; streamId?: unknown; ts?: unknown } = {},
) {
  const text = normalizeCaptionTurnText(rawEvent.text || "");
  const speaker = normalizeCaptionTurnText(rawEvent.speaker || "unknown") || "unknown";
  const streamId = normalizeCaptionTurnText(rawEvent.streamId || speaker || "caption");
  if (!text) return { ok: true, skipped: true, reason: "empty_caption_turn" };
  state.connection.captionTurnsObserved = (state.connection.captionTurnsObserved || 0) + 1;
  state.connection.lastCaptionTurnAt = new Date().toISOString();
  state.connection.lastCaptionTurnSpeaker = speaker;
  state.connection.lastCaptionTurnText = "";
  state.connection.lastCaptionTurnTextChars = text.length;
  // Observation only: caption/event turns may identify the active speaker, but
  // their transcript text is not useful Realtime input. The speech path is the
  // Meet audio mix.
  recordTimeline("meet_caption_turn_observed", {
    speaker,
    streamId,
    chars: text.length,
    ignored: true,
    reason: "caption_turn_speaker_signal_only",
  });
  updateFeedback();
  return {
    ok: true,
    skipped: true,
    reason: "caption_turn_speaker_signal_only",
    streamId,
    speakerSignal: { name: speaker, streamId },
  };
}

async function simulateRealtimeAgentToolCall(name, args = {}) {
  const simulationAllowed =
    ["mock", "webrtc-mock", "agents-sdk-mock"].includes(String(config.mode || "")) ||
    config.allowMockToolSimulation === true;
  if (!simulationAllowed) {
    recordTimeline("realtime_agent_sdk_mock_tool_call_rejected", {
      name,
      mode: config.mode || "",
      reason: "mock_tool_simulation_disabled",
    });
    updateFeedback();
    return { ok: false, error: "mock_tool_simulation_disabled", name };
  }
  if (!isLocalToolName(name)) {
    throw new Error(`unsupported local tool for SDK smoke: ${name}`);
  }
  const callId = `mock_call_${randomEventId()}`;
  const execution = await runLocalToolForSDK(name, args, callId);
  recordTimeline("realtime_agent_sdk_mock_tool_call", { name, callId });
  if (execution?.ok === false) {
    return {
      ok: false,
      name,
      callId,
      error: execution.error || "local_tool_failed",
      delivery: execution.delivery,
    };
  }
  return { ok: true, name, callId, result: execution.result, delivery: execution.delivery };
}

function sendRealtimeControlEvent(event = {}) {
  const type = String((event as { type?: unknown })?.type || "").trim();
  if (type === "conversation.item.input_audio_transcription.completed") {
    const transcript = String((event as { transcript?: unknown })?.transcript || "").trim();
    if (!transcript) {
      recordTimeline("realtime_control_event_rejected", {
        type,
        reason: "realtime_transcript_required",
      });
      updateFeedback();
      return "realtime-control-event-not-allowed";
    }
    window.dispatchEvent(
      new CustomEvent("meeting-avatar-realtime-server-event", {
        detail: {
          ...(event as Record<string, unknown>),
          __meetingAvatarTrustedControlEvent: true,
        },
      }),
    );
    return "trusted-control-event";
  }
  if (type !== "response.cancel" && type !== "input_audio_buffer.clear") {
    recordTimeline("realtime_control_event_rejected", {
      type,
      reason: "realtime_control_event_type_not_allowed",
    });
    updateFeedback();
    return "realtime-control-event-not-allowed";
  }
  return sendRealtimeEvent(event);
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
  simulateRealtimeAgentToolCall,
  sendRealtimeControlEvent,
  requestRealtimeTextTurn,
  pushSessionContext,
  rememberSessionContext,
  contextHealth: () => updateContextHealthFromHistory(currentHistorySnapshot()),
  buildCompactedHistory,
  compactRealtimeHistory,
  resetHistory: compactRealtimeHistory,
  pushHostMeetAudioSamples,
  pushRealtimeOutputPcmFrames: routeSidecarPcmFrames,
  pushRecappiAudioSamples,
  stopMeetAudioCapture,
  observeCaptionSpeakerSignal,
  injectWorkerResult,
};

window.MAB_REALTIME_BRIDGE = state as unknown as Record<string, unknown>;

function allowCustomRealtimeServerEvents() {
  return (
    ["mock", "webrtc-mock"].includes(String(config.mode || "")) ||
    config.allowCustomRealtimeServerEvents === true
  );
}

function allowCustomWorkerResultEvents() {
  return (
    ["mock", "webrtc-mock"].includes(String(config.mode || "")) ||
    config.allowCustomWorkerResultEvents === true
  );
}

function rememberCustomWorkerResultEventDiagnostic(detail: any, reason: string) {
  const suppressed = rememberSuppressedWorkerResult(detail, reason);
  state.workerResults.push(suppressed);
  state.workerResults = state.workerResults.slice(-50);
  return suppressed;
}

window.addEventListener("meeting-avatar-worker-result", (event: Event) => {
  try {
    const detail = (event as CustomEvent).detail || {};
    if (!allowCustomWorkerResultEvents()) {
      recordTimeline("realtime_custom_worker_result_event_rejected", {
        id: detail?.id || "",
        status: detail?.status || "",
        mode: config.mode || "",
        reason: "custom_worker_result_event_disabled",
      });
      rememberCustomWorkerResultEventDiagnostic(detail, "custom_worker_result_event_disabled");
      return;
    }
    recordTimeline("realtime_custom_worker_result_event_diagnostic", {
      id: detail?.id || "",
      status: detail?.status || "",
      mode: config.mode || "",
      reason: "custom_worker_result_event_diagnostic_only",
    });
    rememberCustomWorkerResultEventDiagnostic(detail, "custom_worker_result_event_diagnostic_only");
  } catch (error) {
    rememberError(error);
  }
});

window.addEventListener("meeting-avatar-realtime-server-event", (event: Event) => {
  const detail = (event as CustomEvent).detail as Record<string, any> & {
    __meetingAvatarInboundRecorded?: boolean;
    __meetingAvatarTrustedControlEvent?: boolean;
  };
  const trustedControlEvent = detail?.__meetingAvatarTrustedControlEvent === true;
  if (!trustedControlEvent && !allowCustomRealtimeServerEvents()) {
    recordTimeline("realtime_custom_server_event_rejected", {
      type: detail?.type || "",
      mode: config.mode || "",
      reason: "custom_server_event_disabled",
    });
    return;
  }
  if (detail?.__meetingAvatarInboundRecorded !== true) {
    rememberInboundEvent(detail, trustedControlEvent ? "control-event" : "custom-event");
  }
  if (detail?.type === "session.created") {
    state.connection.openaiSessionId = String((detail as any).session?.id || "");
    updateFeedback();
  }
  if (detail?.type === "input_audio_buffer.speech_started") {
    if (detail.__meetingAvatarSelfEchoSuppressed === true) {
      recordTimeline("realtime_input_speech_started_self_echo_suppressed", {
        source: "meeting-avatar-realtime-server-event",
      });
    } else {
      state.protection.lastInputSpeechStartedAt = new Date().toISOString();
      updateFeedback();
    }
  }
  handleLocalToolCallEvent(detail).catch(rememberError);
});

window.addEventListener("meeting-avatar-user-speech-started", () => {
  if (!allowCustomRealtimeServerEvents()) {
    recordTimeline("realtime_custom_speech_event_rejected", {
      source: "meeting-avatar-user-speech-started",
      mode: config.mode || "",
      reason: "custom_speech_event_disabled",
    });
    return;
  }
  state.protection.lastInputSpeechStartedAt = new Date().toISOString();
  recordTimeline("realtime_input_speech_started", { source: "meeting-avatar-user-speech-started" });
});

installParticipantAudioDiscovery();

if (config.autoConnect && shouldAutoConnectInCurrentDocument()) {
  window.setTimeout(() => connectRealtime(), 0);
}
