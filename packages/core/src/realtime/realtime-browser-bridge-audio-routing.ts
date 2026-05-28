/* eslint-disable no-unused-vars */
function meetAudioInputGain() {
  return normalizeMeetAudioInputGain(
    state.connection.meetAudioInputGain || config.meetAudioInputGain,
  );
}

function ensureMeetAudioRoutingContext() {
  if (routingDestination) return routingDestination;
  const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
  routingAudioContext = routingAudioContext || new AudioContextImpl({ sampleRate: 48000 });
  state.connection.meetAudioContextState = routingAudioContext.state || "";
  routingInputGate = routingInputGate || routingAudioContext.createGain();
  state.connection.meetAudioInputGain = meetAudioInputGain();
  routingInputGate.gain.value = state.connection.realtimeInputGateOpen
    ? state.connection.meetAudioInputGain
    : 0;
  routingDestination = routingDestination || routingAudioContext.createMediaStreamDestination();
  routingInputGate.connect(routingDestination);
  ensureMeetAudioEnergyMonitor();
  routingSilenceSource = routingSilenceSource || routingAudioContext.createConstantSource();
  routingSilenceSource.offset.value = 0;
  routingSilenceSource.connect(routingInputGate);
  routingSilenceSource.start();
  recordTimeline("meet_audio_routing_ready", {
    outputTrackId: routingDestination.stream.getAudioTracks()[0]?.id || "",
    audioContextState: routingAudioContext.state || "",
  });
  installMeetAudioResumeListeners();
  resumeMeetAudioRoutingContext("routing-ready");
  return routingDestination;
}

function isMeetAudioSourceRoutable(entry) {
  const track = entry?.track;
  return (
    track?.readyState === "live" &&
    track.muted !== true &&
    track.enabled !== false &&
    routingInputGate
  );
}

function disconnectMeetAudioSource(entry, reason = "") {
  if (!entry?.connected) return false;
  try {
    entry.source?.disconnect?.();
  } catch {
    // Best-effort cleanup; MediaStreamAudioSourceNode may already be detached.
  }
  try {
    entry.gain?.disconnect?.();
  } catch {
    // Best-effort cleanup; GainNode may already be detached.
  }
  entry.connected = false;
  entry.disconnectedAt = new Date().toISOString();
  entry.disconnectReason = reason;
  recordTimeline("meet_audio_source_disconnected", {
    trackId: entry.track?.id || "",
    readyState: entry.track?.readyState || "",
    muted: entry.track?.muted === true,
    enabled: entry.track?.enabled !== false,
    reason,
    source: entry.detail?.source || "",
  });
  return true;
}

function connectMeetAudioSource(entry, reason = "") {
  if (!entry || entry.connected || !isMeetAudioSourceRoutable(entry)) return false;
  try {
    entry.source.connect(entry.gain);
    entry.gain.connect(routingInputGate);
    entry.connected = true;
    entry.connectedAt = new Date().toISOString();
    entry.disconnectReason = "";
    recordTimeline("meet_audio_source_connected", {
      trackId: entry.track?.id || "",
      reason,
      source: entry.detail?.source || "",
    });
    return true;
  } catch (error) {
    rememberError(error);
    return false;
  }
}

function refreshMeetAudioSourceConnection(entry, reason = "") {
  if (isMeetAudioSourceRoutable(entry)) return connectMeetAudioSource(entry, reason);
  return disconnectMeetAudioSource(entry, reason);
}

function refreshMeetAudioSourceConnections(reason = "refresh") {
  for (const entry of routedMeetAudioSources) {
    refreshMeetAudioSourceConnection(entry, reason);
  }
}

function refreshMeetAudioTrackStates() {
  refreshMeetAudioSourceConnections("track-state-refresh");
  const liveSources = routedMeetAudioSources.filter(
    (entry) => entry.connected === true && entry.track?.readyState === "live",
  );
  const unmutedSources = liveSources.filter(
    (entry) => entry.track?.muted !== true && entry.track?.enabled !== false,
  );
  const recappiConnected = (state.connection as any).recappiAudioInput?.connected === true;
  state.connection.meetAudioSourcesActive = liveSources.length + (recappiConnected ? 1 : 0);
  state.connection.meetAudioSourcesUnmuted = unmutedSources.length + (recappiConnected ? 1 : 0);
  const trackStates = routedMeetAudioSources.slice(-10).map((entry) => ({
    trackId: entry.track?.id || "",
    readyState: entry.track?.readyState || "",
    enabled: entry.track?.enabled !== false,
    muted: entry.track?.muted === true,
    connected: entry.connected === true,
    disconnectReason: entry.disconnectReason || "",
    source: entry.detail?.source || "",
    label: entry.detail?.label || entry.track?.label || "",
  }));
  if (recappiConnected) {
    trackStates.push({
      trackId: "recappi-process-audio",
      readyState: "live",
      enabled: true,
      muted: false,
      connected: true,
      disconnectReason: "",
      source: "recappi_process_audio",
      label: "Recappi Chrome process audio",
    });
  }
  state.connection.meetAudioTrackStates = trackStates.slice(-10);
}

function installMeetAudioSourceLifecycle(entry) {
  const track = entry?.track;
  if (!track || entry.lifecycleInstalled) return;
  entry.lifecycleInstalled = true;
  const refresh = (reason) => {
    refreshMeetAudioSourceConnection(entry, reason);
    refreshMeetAudioTrackStates();
    updateFeedback();
  };
  if (typeof track.addEventListener === "function") {
    track.addEventListener("mute", () => refresh("track-muted"));
    track.addEventListener("unmute", () => refresh("track-unmuted"));
    track.addEventListener("ended", () => refresh("track-ended"));
  }
}

function sampleMeetAudioEnergy() {
  if (!routingAnalyser || !routingAnalyserBuffer) return;
  routingAnalyser.getFloatTimeDomainData(routingAnalyserBuffer);
  let sumSquares = 0;
  let peak = 0;
  for (const sample of routingAnalyserBuffer) {
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / routingAnalyserBuffer.length);
  const now = new Date();
  const thresholdRms = Number(state.connection.meetAudioEnergy?.thresholdRms || 0.003);
  const thresholdPeak = Number(state.connection.meetAudioEnergy?.thresholdPeak || 0.01);
  const energetic = rms >= thresholdRms || peak >= thresholdPeak;
  const lastEnergyAt = energetic
    ? now.toISOString()
    : String(state.connection.meetAudioEnergy?.lastEnergyAt || "");
  const lastEnergyMs = Date.parse(lastEnergyAt);
  const silenceMs =
    lastEnergyAt && Number.isFinite(lastEnergyMs) ? Math.max(0, now.getTime() - lastEnergyMs) : 0;
  state.connection.meetAudioEnergy = {
    rms,
    peak,
    observed: Boolean(state.connection.meetAudioEnergy?.observed || energetic),
    lastEnergyAt,
    lastCheckedAt: now.toISOString(),
    silenceMs,
    thresholdRms,
    thresholdPeak,
  };
  refreshMeetAudioTrackStates();
  if (energetic && !state.connection.meetAudioEnergyLogged) {
    state.connection.meetAudioEnergyLogged = true;
    recordTimeline("meet_audio_energy_observed", {
      rms,
      peak,
      sourceCount: state.connection.meetAudioSourcesActive,
    });
  }
  updateFeedback();
}

function ensureMeetAudioEnergyMonitor() {
  if (!routingInputGate || !routingAudioContext || routingAnalyser) return;
  routingAnalyser = routingAudioContext.createAnalyser();
  routingAnalyser.fftSize = 2048;
  routingAnalyserBuffer = new Float32Array(routingAnalyser.fftSize);
  routingInputGate.connect(routingAnalyser);
  if (!routingEnergyTimer) {
    routingEnergyTimer = window.setInterval(sampleMeetAudioEnergy, 250);
  }
  sampleMeetAudioEnergy();
}

function resumeMeetAudioRoutingContext(reason = "") {
  if (!routingAudioContext) return;
  state.connection.meetAudioContextState = routingAudioContext.state || "";
  if (routingAudioContext.state !== "suspended") return;
  routingAudioContext
    .resume()
    .then(() => {
      state.connection.meetAudioContextState = routingAudioContext.state || "";
      recordTimeline("meet_audio_context_resumed", {
        reason,
        state: routingAudioContext.state || "",
      });
      return updateFeedback();
    })
    .catch((error) => {
      recordTimeline("meet_audio_context_resume_failed", {
        reason,
        error: String((error && error.message) || error).slice(0, 240),
      });
    });
}

function installMeetAudioResumeListeners() {
  if (routingAudioResumeListenersInstalled) return;
  routingAudioResumeListenersInstalled = true;
  const resume = () => resumeMeetAudioRoutingContext("user-gesture");
  window.addEventListener("pointerdown", resume, { capture: true, passive: true });
  window.addEventListener("keydown", resume, { capture: true });
  window.addEventListener("click", resume, { capture: true, passive: true });
}

function isRealtimeRoutingMixTrack(track) {
  if (!track || !routingDestination) return false;
  return routingDestination.stream.getAudioTracks().includes(track);
}

function rememberRealtimeInputTrack(source, track, detail = {}) {
  state.connection.currentRealtimeInputTrackId = track?.id || "";
  state.connection.currentRealtimeInputSource = source || "";
  state.connection.currentRealtimeInputIsRoutingMix = isRealtimeRoutingMixTrack(track);
  Object.assign(state.connection, detail);
}

async function sampleRealtimeAudioSenderStats(reason = "interval") {
  const sender = realtimeAudioSender;
  const now = new Date().toISOString();
  if (!sender?.getStats) {
    state.connection.realtimeAudioSenderStats = {
      supported: false,
      reason: "sender_get_stats_unavailable",
      checkedAt: now,
    };
    updateFeedback();
    return;
  }
  try {
    const report = await sender.getStats();
    let selected = null;
    report?.forEach?.((entry) => {
      if (selected) return;
      const kind = entry.kind || entry.mediaType;
      if (entry.type === "outbound-rtp" && (!kind || kind === "audio")) selected = entry;
    });
    const bytesSent = Number(selected?.bytesSent || 0);
    const packetsSent = Number(selected?.packetsSent || 0);
    const previous = state.connection.realtimeAudioSenderStats || {};
    state.connection.realtimeAudioSenderStats = {
      supported: true,
      checkedAt: now,
      reason,
      trackId: sender.track?.id || "",
      trackReadyState: sender.track?.readyState || "",
      trackEnabled: sender.track?.enabled !== false,
      trackMuted: sender.track?.muted === true,
      currentRealtimeInputSource: state.connection.currentRealtimeInputSource || "",
      currentRealtimeInputIsRoutingMix: state.connection.currentRealtimeInputIsRoutingMix === true,
      bytesSent,
      packetsSent,
      bytesDelta: bytesSent - Number(previous.bytesSent || 0),
      packetsDelta: packetsSent - Number(previous.packetsSent || 0),
    };
    updateFeedback();
  } catch (error) {
    state.connection.realtimeAudioSenderStats = {
      supported: false,
      reason: "sender_get_stats_failed",
      checkedAt: now,
      error: String((error && error.message) || error).slice(0, 240),
    };
    updateFeedback();
  }
}

function ensureRealtimeAudioSenderStatsMonitor(reason = "sender-ready") {
  if (!realtimeAudioSender || realtimeAudioSenderStatsTimer) return;
  sampleRealtimeAudioSenderStats(reason);
  realtimeAudioSenderStatsTimer = window.setInterval(
    () => sampleRealtimeAudioSenderStats("interval"),
    1000,
  );
}

function setRealtimeInputGate(open, reason = "") {
  if (!routingInputGate || !routingAudioContext) return;
  if (!open && realtimeInputGateReopenTimer) {
    window.clearTimeout(realtimeInputGateReopenTimer);
    realtimeInputGateReopenTimer = 0;
  }
  state.connection.meetAudioInputGain = meetAudioInputGain();
  const target = open ? state.connection.meetAudioInputGain : 0;
  try {
    routingInputGate.gain.setTargetAtTime(target, routingAudioContext.currentTime, 0.015);
  } catch {
    routingInputGate.gain.value = target;
  }
  state.connection.realtimeInputGateOpen = open;
  recordTimeline("realtime_input_gate", { open, reason });
  updateFeedback();
}

function scheduleRealtimeInputGateOpen(reason = "", delayMs = 1200) {
  if (realtimeInputGateReopenTimer) window.clearTimeout(realtimeInputGateReopenTimer);
  realtimeInputGateReopenTimer = window.setTimeout(
    () => {
      realtimeInputGateReopenTimer = 0;
      setRealtimeInputGate(true, reason || "delayed-open");
    },
    Math.max(0, delayMs),
  );
  recordTimeline("realtime_input_gate_open_scheduled", { reason, delayMs });
  updateFeedback();
}

function replaceRealtimeInputWithRoutingMix(reason = "meet-audio") {
  if (!realtimeAudioSender || !routingDestination) return false;
  const [mixedTrack] = routingDestination.stream.getAudioTracks();
  if (!mixedTrack) return false;
  realtimeAudioSender
    .replaceTrack(mixedTrack)
    .then(() => {
      rememberRealtimeInputTrack("meet_audio_mix", mixedTrack, {
        lastRealtimeInputReplaceReason: reason,
        lastRealtimeInputReplaceAt: new Date().toISOString(),
      });
      recordTimeline("realtime_input_replace_track", {
        reason,
        trackId: mixedTrack.id,
        meetAudioTracksForwarded: state.connection.meetAudioTracksForwarded,
      });
      ensureRealtimeAudioSenderStatsMonitor("replace-track");
      return updateFeedback();
    })
    .catch((error) => rememberError(error));
  return true;
}

function forwardMeetAudioTrackToRealtime(track, detail = {}) {
  if (!track || track.kind !== "audio") return false;
  if (!state.connection.meetAudioForwardingEnabled) return false;
  if (config.meetAudioInputSource === "recappi_process_audio") {
    recordTimeline("meet_audio_track_skipped", {
      reason: "recappi_process_audio_selected",
      trackId: track.id,
      ...detail,
    });
    return false;
  }
  if (track.readyState === "ended") {
    recordTimeline("meet_audio_track_skipped", {
      reason: "track_ended",
      trackId: track.id,
      ...detail,
    });
    return false;
  }
  const avatarTrack = window.MAB_AVATAR_AUDIO_BUS?.track;
  if (avatarTrack && track.id === avatarTrack.id) {
    recordTimeline("meet_audio_track_skipped", {
      reason: "avatar_audio_bus_feedback",
      trackId: track.id,
      ...detail,
    });
    return false;
  }
  if (isRealtimeRoutingMixTrack(track)) {
    recordTimeline("meet_audio_track_skipped", {
      reason: "realtime_input_mix_feedback",
      trackId: track.id,
      ...detail,
    });
    return false;
  }
  if (routedMeetAudioTrackIds.has(track.id)) return false;
  routedMeetAudioTrackIds.add(track.id);
  ensureMeetAudioRoutingContext();
  try {
    const stream = new MediaStream([track]);
    const source = routingAudioContext.createMediaStreamSource(stream);
    const gain = routingAudioContext.createGain();
    gain.gain.value = 1;
    const entry = {
      track,
      stream,
      source,
      gain,
      detail,
      addedAt: new Date().toISOString(),
      connected: false,
      disconnectReason: "",
    };
    routedMeetAudioSources.push(entry);
    installMeetAudioSourceLifecycle(entry);
    refreshMeetAudioSourceConnection(entry, "track-forwarded");
    refreshMeetAudioTrackStates();
    state.connection.meetAudioTracksForwarded += 1;
    state.connection.lastMeetAudioTrackId = track.id;
    recordTimeline("meet_audio_track_forwarded", {
      trackId: track.id,
      label: track.label || "",
      sourcesRetained: routedMeetAudioSources.length,
      ...detail,
    });
    if (!realtimeAudioSender) {
      pendingMeetAudioTracks.push(track);
      state.connection.pendingMeetAudioTrackCount = pendingMeetAudioTracks.length;
      recordTimeline("meet_audio_track_pending", { trackId: track.id });
      maybeStartMeetAudioCapture("meet-audio-pending");
      updateFeedback();
      return true;
    }
    replaceRealtimeInputWithRoutingMix("meet-audio-forwarded");
    maybeStartMeetAudioCapture("meet-audio-forwarded");
    updateFeedback();
    return true;
  } catch (error) {
    rememberError(error);
    return false;
  }
}

function flushPendingMeetAudioTracks() {
  if (!realtimeAudioSender || !pendingMeetAudioTracks.length) return;
  pendingMeetAudioTracks.splice(0);
  state.connection.pendingMeetAudioTrackCount = 0;
  replaceRealtimeInputWithRoutingMix("pending-meet-audio-flush");
}
