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
