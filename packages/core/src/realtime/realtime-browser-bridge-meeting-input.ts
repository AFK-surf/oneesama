/* eslint-disable no-unused-vars */
let outputAudioGeneration = 0;
let outputAudioCompletionTimer: number | null = null;
let outputAudioStaleTimer: number | null = null;

function normalizedOutputAudioTimerMs(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function outputAudioDoneFallbackMs() {
  return normalizedOutputAudioTimerMs(
    (config as Record<string, unknown>).outputAudioDoneFallbackMs,
    4000,
  );
}

function outputAudioStaleFallbackMs() {
  return normalizedOutputAudioTimerMs(
    (config as Record<string, unknown>).outputAudioStaleFallbackMs,
    20000,
  );
}

function clearOutputAudioCompletionTimer() {
  if (outputAudioCompletionTimer === null) return;
  window.clearTimeout(outputAudioCompletionTimer);
  outputAudioCompletionTimer = null;
}

function clearOutputAudioStaleTimer() {
  if (outputAudioStaleTimer === null) return;
  window.clearTimeout(outputAudioStaleTimer);
  outputAudioStaleTimer = null;
}

function clearOutputAudioTimers() {
  clearOutputAudioCompletionTimer();
  clearOutputAudioStaleTimer();
}

function clearRealtimeOutputAudioActivity(reason = "output_audio_cleared") {
  const wasActive = state.protection.outputAudioActive === true;
  outputAudioGeneration += 1;
  clearOutputAudioTimers();
  window.MAB_AVATAR_AUDIO_BUS?.setSyntheticSpeech?.(false);
  state.protection.outputAudioActive = false;
  state.protection.lastOutputAudioStoppedAt = new Date().toISOString();
  if (wasActive) {
    recordTimeline("realtime_output_audio_cleared", {
      reason,
      activeResponseId: state.protection.activeResponseId || "",
    });
    updateFeedback();
  }
  return wasActive;
}

function scheduleOutputAudioCompletionFallback(reason: string) {
  clearOutputAudioCompletionTimer();
  const generation = outputAudioGeneration;
  const delayMs = outputAudioDoneFallbackMs();
  outputAudioCompletionTimer = window.setTimeout(() => {
    outputAudioCompletionTimer = null;
    if (generation !== outputAudioGeneration) return;
    if (state.protection.outputAudioActive !== true) return;
    clearRealtimeOutputAudioActivity(`${reason}_fallback`);
  }, delayMs);
}

function scheduleOutputAudioStaleFallback(reason: string) {
  clearOutputAudioStaleTimer();
  const generation = outputAudioGeneration;
  const delayMs = outputAudioStaleFallbackMs();
  outputAudioStaleTimer = window.setTimeout(() => {
    outputAudioStaleTimer = null;
    if (generation !== outputAudioGeneration) return;
    if (state.protection.outputAudioActive !== true) return;
    clearRealtimeOutputAudioActivity(`${reason}_stale_fallback`);
  }, delayMs);
}

function markRealtimeOutputAudioActive(reason: string) {
  if (state.protection.outputAudioActive !== true) outputAudioGeneration += 1;
  clearOutputAudioCompletionTimer();
  window.MAB_AVATAR_AUDIO_BUS?.setSyntheticSpeech?.(true);
  state.protection.outputAudioActive = true;
  if (reason === "output_audio_buffer.started" || !state.protection.lastOutputAudioStartedAt) {
    state.protection.lastOutputAudioStartedAt = new Date().toISOString();
    state.protection.lastOutputAudioStoppedAt = "";
  }
  scheduleOutputAudioStaleFallback(reason);
}

function handleRealtimeServerEvent(detail) {
  const event = detail || {};
  if (event.type === "session.created" && event.session?.id) {
    state.connection.openaiSessionId = event.session.id;
    recordTimeline("realtime_session_created", { openaiSessionId: event.session.id });
  }
  if (event.type === "response.created" && event.response?.id) {
    state.protection.activeResponseId = event.response.id;
    recordTimeline("realtime_input_continuous", { reason: "response-created" });
  }
  if (
    event.type === "output_audio_buffer.started" ||
    event.type === "response.output_audio.delta"
  ) {
    markRealtimeOutputAudioActive(event.type);
    recordTimeline("realtime_input_continuous", { reason: event.type });
  }
  if (event.type === "input_audio_buffer.speech_started") {
    state.protection.lastInputSpeechStartedAt = new Date().toISOString();
    if (state.protection.outputAudioActive === true) {
      const result = cancelActiveResponse("user_speech_started");
      if (!result.skipped) state.protection.userSpeechCancels += 1;
    } else {
      recordTimeline("realtime_input_speech_started", {
        cancelSkipped: true,
        reason: "no_output_audio_active",
        activeResponseId: state.protection.activeResponseId || "",
      });
    }
    setRealtimeInputGate(true, "user-speech-started");
  }
  if (
    ["response.done", "response.cancelled", "response.failed"].includes(event.type) &&
    event.response?.id &&
    event.response.id === state.protection.activeResponseId
  ) {
    state.protection.activeResponseId = "";
  }
  if (event.type === "output_audio_buffer.stopped") {
    clearRealtimeOutputAudioActivity("output_audio_buffer.stopped");
  }
  if (event.type === "response.cancelled" || event.type === "response.failed") {
    clearRealtimeOutputAudioActivity(event.type);
  }
  if (event.type === "response.done" || event.type === "response.output_audio.done") {
    if (state.protection.outputAudioActive) {
      scheduleOutputAudioCompletionFallback(event.type);
      recordTimeline("realtime_output_audio_completion_deferred", {
        reason: event.type,
        waitingFor: "output_audio_buffer.stopped",
        fallbackMs: outputAudioDoneFallbackMs(),
      });
    } else {
      window.MAB_AVATAR_AUDIO_BUS?.setSyntheticSpeech?.(false);
    }
  }
  handleLocalToolCallEvent(event);
}

function rememberParticipantSource(
  label: string | undefined,
  stream: MediaStream,
  tracks: MediaStreamTrack[],
) {
  const source = {
    ts: new Date().toISOString(),
    label: label || "participant-audio",
    streamId: stream.id || "",
    trackIds: tracks.map((track) => track.id),
  };
  state.connection.participantAudioSources.push(source);
  state.connection.participantAudioSources = state.connection.participantAudioSources.slice(-20);
}

function peerConnectionCanAcceptAudioTrack(pc) {
  if (!pc) return false;
  return (
    String(pc.signalingState || "") !== "closed" && String(pc.connectionState || "") !== "closed"
  );
}

function addParticipantTracksToPeerConnection(pc) {
  if (!pc) return 0;
  if (!state.connection.participantAudioForwardingEnabled) {
    return 0;
  }
  if (!peerConnectionCanAcceptAudioTrack(pc)) {
    recordTimeline("participant_audio_add_track_skipped", {
      reason: "peer_connection_closed",
      signalingState: String(pc.signalingState || ""),
      connectionState: String(pc.connectionState || ""),
    });
    updateFeedback();
    return 0;
  }
  let added = 0;
  for (const stream of participantStreams) {
    for (const track of stream.getAudioTracks()) {
      if (addedParticipantTrackIds.has(track.id)) continue;
      try {
        pc.addTrack(track, stream);
        addedParticipantTrackIds.add(track.id);
        added += 1;
      } catch (error) {
        const message = String((error && error.message) || error);
        if (
          /signalingState is 'closed'|peer.?connection.*closed|connectionState.*closed/i.test(
            message,
          )
        ) {
          recordTimeline("participant_audio_add_track_skipped", {
            reason: "peer_connection_closed",
            signalingState: String(pc.signalingState || ""),
            connectionState: String(pc.connectionState || ""),
            trackId: track.id || "",
          });
          continue;
        }
        rememberError(error);
      }
    }
  }
  state.connection.participantAudioTracksAdded += added;
  return added;
}

interface ParticipantStreamOptions {
  label?: string;
}

function registerParticipantAudioStream(
  stream: MediaStream | null | undefined,
  options: ParticipantStreamOptions = {},
) {
  try {
    const tracks = stream?.getAudioTracks?.() || [];
    const freshTracks = tracks.filter((track) => !participantTrackIds.has(track.id));
    if (!freshTracks.length) return { ok: true, added: 0, duplicate: tracks.length > 0 };
    for (const track of freshTracks) participantTrackIds.add(track.id);
    participantStreams.push(stream);
    state.connection.participantAudioTracksDiscovered += freshTracks.length;
    rememberParticipantSource(options.label, stream, freshTracks);
    const forwardedToRealtime = freshTracks.reduce(
      (count, track) =>
        count +
        (forwardMeetAudioTrackToRealtime(track, {
          label: options.label || "participant-audio",
          source: "participant-audio-stream",
          streamId: stream.id || "",
        })
          ? 1
          : 0),
      0,
    );
    const addedToPeerConnection = 0;
    recordTimeline("participant_audio_discovered", {
      forwardingEnabled: state.connection.participantAudioForwardingEnabled === true,
      meetAudioForwardingEnabled: state.connection.meetAudioForwardingEnabled === true,
      label: options.label || "participant-audio",
      streamId: stream.id || "",
      trackIds: freshTracks.map((track) => track.id),
      forwardedToRealtime,
      addedToPeerConnection,
      directParticipantAudioDisabled: true,
    });
    updateFeedback();
    return { ok: true, added: freshTracks.length, addedToPeerConnection, forwardedToRealtime };
  } catch (error) {
    rememberError(error);
    return { ok: false, error: String((error && error.message) || error) };
  }
}

function discoverParticipantAudioStreams() {
  if (!shouldRouteGenericMediaElementAudio()) {
    state.connection.participantAudioElementDiscoverySkipped = true;
    if (!state.connection.participantAudioElementDiscoverySkipLogged) {
      state.connection.participantAudioElementDiscoverySkipLogged = true;
      recordTimeline("participant_audio_element_discovery_skipped", {
        reason: "generic_media_element_audio_disabled_on_google_meet",
      });
    }
    updateFeedback();
    return state.connection.participantAudioTracksDiscovered;
  }
  const mediaElements = Array.from(document.querySelectorAll<HTMLMediaElement>("audio, video"));
  for (const element of mediaElements) {
    const provider = element.srcObject;
    if (!provider || !(provider instanceof MediaStream)) continue;
    if (provider.getAudioTracks?.().length) {
      registerParticipantAudioStream(provider, {
        label:
          element.dataset?.meetingAvatarParticipant || element.id || element.tagName.toLowerCase(),
      });
    }
  }
  return state.connection.participantAudioTracksDiscovered;
}

interface ParticipantAudioEventDetail {
  stream?: MediaStream;
  label?: string;
}

function installParticipantAudioDiscovery() {
  window.addEventListener("meeting-avatar-participant-audio-stream", (event: Event) => {
    const detail = (event as CustomEvent<ParticipantAudioEventDetail>).detail || {};
    registerParticipantAudioStream(detail.stream, {
      label: detail.label || "participant-audio-event",
    });
  });
  const run = () => {
    try {
      discoverParticipantAudioStreams();
    } catch (error) {
      rememberError(error);
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
  const installObserver = () => {
    if (!document.documentElement) return;
    const observer = new MutationObserver(run);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) {
    installObserver();
  } else {
    document.addEventListener("DOMContentLoaded", installObserver, { once: true });
  }
  window.setInterval(run, 1500);
}
