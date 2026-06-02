/* eslint-disable no-unused-vars */
const avatarAudioBusSenderTrackClones = new WeakSet();

function isRoutingDestinationTrack(track: MediaStreamTrack | null | undefined) {
  if (!track || !routingDestination) return false;
  return routingDestination.stream.getAudioTracks().includes(track);
}

function avatarAudioBusTrack() {
  const bus = window.MAB_AVATAR_AUDIO_BUS as any;
  const track = bus?.track || bus?.stream?.getAudioTracks?.()[0] || null;
  return track?.kind === "audio" && track.readyState !== "ended" ? track : null;
}

function cloneAvatarAudioBusTrack() {
  const sourceTrack = avatarAudioBusTrack();
  if (!sourceTrack) return null;
  const clone = sourceTrack.clone();
  avatarAudioBusSenderTrackClones.add(clone);
  (clone as any).__meetingAvatarAudioBusClone = true;
  (clone as any).__meetingAvatarAudioBusSourceTrackId = sourceTrack.id || "";
  clone.enabled = true;
  return clone;
}

function isAvatarAudioBusSenderTrack(track) {
  const sourceTrack = avatarAudioBusTrack();
  return Boolean(
    track &&
    (avatarAudioBusSenderTrackClones.has(track) ||
      (track as any).__meetingAvatarAudioBusClone === true ||
      (sourceTrack && track.id === sourceTrack.id)),
  );
}

function updatePrimaryMeetAudioSenderState(sender) {
  const senderTrack = sender?.track || null;
  state.connection.primaryMeetAudioSenderTrackId = senderTrack?.id || "";
  state.connection.primaryMeetAudioSenderUsingAvatarBus = isAvatarAudioBusSenderTrack(senderTrack);
  updateFeedback();
}

function statsReportHasOutboundAudio(report) {
  let found = false;
  report?.forEach?.((entry) => {
    if (found) return;
    const kind = entry.kind || entry.mediaType;
    if (entry.type === "outbound-rtp" && (!kind || kind === "audio")) found = true;
  });
  return found;
}

async function probeMeetOutboundAudioSenderByStats(pc, pcId, sender, source) {
  if (!sender?.getStats) return;
  const now = Date.now();
  if (sender.__meetingAvatarRealtimeAudioStatsProbeInFlight) return;
  if (
    sender.__meetingAvatarRealtimeLastAudioStatsProbeAt &&
    now - sender.__meetingAvatarRealtimeLastAudioStatsProbeAt < 1000
  )
    return;
  sender.__meetingAvatarRealtimeLastAudioStatsProbeAt = now;
  sender.__meetingAvatarRealtimeAudioStatsProbeInFlight = true;
  try {
    const report = await sender.getStats();
    if (!statsReportHasOutboundAudio(report)) return;
    handleMeetOutboundAudioSender(
      pc,
      pcId,
      sender,
      sender.track?.kind === "audio" ? sender.track : avatarAudioBusTrack(),
      `${source}.statsProbe`,
    );
  } catch (error) {
    recordTimeline("meet_audio_sender_stats_probe_failed", {
      pcId,
      source,
      error: String((error && error.message) || error).slice(0, 240),
    });
  } finally {
    sender.__meetingAvatarRealtimeAudioStatsProbeInFlight = false;
  }
}

async function samplePrimaryMeetAudioSenderStats(reason = "interval") {
  const sender = primaryMeetAudioSender;
  const now = new Date().toISOString();
  if (!sender?.getStats) {
    state.connection.primaryMeetAudioSenderStats = {
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
    const previous = state.connection.primaryMeetAudioSenderStats || {};
    state.connection.primaryMeetAudioSenderStats = {
      supported: true,
      checkedAt: now,
      reason,
      trackId: sender.track?.id || "",
      trackReadyState: sender.track?.readyState || "",
      trackEnabled: sender.track?.enabled !== false,
      trackMuted: sender.track?.muted === true,
      usingAvatarBus: state.connection.primaryMeetAudioSenderUsingAvatarBus === true,
      bytesSent,
      packetsSent,
      bytesDelta: bytesSent - Number(previous.bytesSent || 0),
      packetsDelta: packetsSent - Number(previous.packetsSent || 0),
    };
    updateFeedback();
  } catch (error) {
    state.connection.primaryMeetAudioSenderStats = {
      supported: false,
      reason: "sender_get_stats_failed",
      checkedAt: now,
      error: String((error && error.message) || error).slice(0, 240),
    };
    updateFeedback();
  }
}

function ensurePrimaryMeetAudioSenderStatsMonitor(reason = "sender-ready") {
  if (!primaryMeetAudioSender || primaryMeetAudioSenderStatsTimer) return;
  samplePrimaryMeetAudioSenderStats(reason);
  primaryMeetAudioSenderStatsTimer = window.setInterval(
    () => samplePrimaryMeetAudioSenderStats("interval"),
    1000,
  );
}

function schedulePrimaryMeetAudioAttachRetry(pcId, source) {
  if (primaryMeetAudioSenderAttachRetryTimer) return;
  primaryMeetAudioSenderAttachRetryTimer = window.setTimeout(() => {
    primaryMeetAudioSenderAttachRetryTimer = 0;
    if (primaryMeetAudioSender) {
      attachAvatarAudioToPrimaryMeetSender(primaryMeetAudioSender, pcId, `${source}.retry`);
    }
  }, 250);
}

function attachAvatarAudioToPrimaryMeetSender(sender, pcId, source) {
  if (!sender || sender !== primaryMeetAudioSender) return;
  updatePrimaryMeetAudioSenderState(sender);
  const avatarTrack = avatarAudioBusTrack();
  if (!avatarTrack) {
    schedulePrimaryMeetAudioAttachRetry(pcId, source);
    return;
  }
  if (isAvatarAudioBusSenderTrack(sender.track) && sender.track?.readyState !== "ended") return;
  if (primaryMeetAudioSenderAttachInFlight.has(sender)) return;
  const replacementTrack = cloneAvatarAudioBusTrack();
  if (!replacementTrack) {
    schedulePrimaryMeetAudioAttachRetry(pcId, source);
    return;
  }
  primaryMeetAudioSenderAttachInFlight.add(sender);
  state.connection.primaryMeetAudioSenderAttachAttempts += 1;
  sender
    .replaceTrack(replacementTrack)
    .then(() => {
      state.connection.primaryMeetAudioSenderTrackId = replacementTrack.id;
      state.connection.primaryMeetAudioSenderUsingAvatarBus = true;
      state.connection.lastPrimaryMeetAudioAttachAt = new Date().toISOString();
      state.connection.lastPrimaryMeetAudioAttachError = "";
      recordTimeline("primary_meet_audio_sender_attached", {
        pcId,
        source,
        trackId: replacementTrack.id,
        sourceTrackId: avatarTrack.id,
      });
      samplePrimaryMeetAudioSenderStats("avatar-bus-attached");
      ensurePrimaryMeetAudioSenderStatsMonitor("avatar-bus-attached");
      return updateFeedback();
    })
    .catch((error) => {
      const message = String((error && error.message) || error).slice(0, 240);
      state.connection.lastPrimaryMeetAudioAttachError = message;
      recordTimeline("primary_meet_audio_sender_attach_failed", { pcId, source, error: message });
      rememberError(error);
    })
    .finally(() => {
      primaryMeetAudioSenderAttachInFlight.delete(sender);
    });
}

function silenceDuplicateMeetAudioSender(sender, pcId, source) {
  if (!sender || !silentMeetAudioTrack || sender === primaryMeetAudioSender) return;
  sender
    .replaceTrack(silentMeetAudioTrack.clone())
    .then(() => {
      state.connection.duplicateMeetAudioSendersMuted += 1;
      recordTimeline("duplicate_meet_audio_sender_muted", { pcId, source });
      return updateFeedback();
    })
    .catch((error) => rememberError(error));
}

function handleMeetOutboundAudioSender(pc, pcId, sender, track, source) {
  if (!sender || !track || track.kind !== "audio") return;
  if (pc === activePeerConnection) return;
  if (!primaryMeetAudioSender) {
    primaryMeetAudioSender = sender;
    recordTimeline("primary_meet_audio_sender_selected", { pcId, source, trackId: track.id });
    ensurePrimaryMeetAudioSenderStatsMonitor("primary-selected");
    attachAvatarAudioToPrimaryMeetSender(sender, pcId, source);
    return;
  }
  if (sender === primaryMeetAudioSender) {
    attachAvatarAudioToPrimaryMeetSender(sender, pcId, source);
    return;
  }
  if (sender !== primaryMeetAudioSender) {
    silenceDuplicateMeetAudioSender(sender, pcId, source);
  }
}

function isMeetingAvatarScreenShareTrack(track) {
  if (!track || track.kind !== "video") return false;
  const label = String(track.label || "");
  let settings = {};
  try {
    settings = track.getSettings?.() || {};
  } catch {
    settings = {};
  }
  return (
    track.contentHint === "detail" ||
    /meeting avatar bot synthetic display|meeting-avatar-screen-share|synthetic display/i.test(
      label,
    ) ||
    Boolean((settings as { displaySurface?: unknown }).displaySurface)
  );
}

function handleMeetOutboundVideoSender(pc, pcId, sender, track, source) {
  if (!sender || !track || track.kind !== "video") return;
  if (pc === activePeerConnection || !isMeetingAvatarScreenShareTrack(track)) return;
  try {
    track.contentHint = "detail";
  } catch {
    // Best-effort encoder hint.
  }
  const optimize = async () => {
    if (typeof sender.getParameters !== "function" || typeof sender.setParameters !== "function")
      return;
    const parameters = sender.getParameters() || {};
    parameters.degradationPreference = "maintain-resolution";
    if (Array.isArray(parameters.encodings) && parameters.encodings.length > 0) {
      parameters.encodings = parameters.encodings.map((encoding) => ({
        ...encoding,
        maxBitrate: Math.max(Number(encoding.maxBitrate) || 0, 8_000_000),
        priority: "high",
        networkPriority: "high",
      }));
    }
    await sender.setParameters(parameters);
    recordTimeline("screen_share_video_sender_optimized", {
      pcId,
      source,
      trackId: track.id,
      contentHint: track.contentHint || "",
      degradationPreference: parameters.degradationPreference || "",
      maxBitrate: parameters.encodings?.[0]?.maxBitrate || null,
    });
  };
  optimize().catch((error) => {
    recordTimeline("screen_share_video_sender_optimize_failed", {
      pcId,
      source,
      trackId: track.id,
      error: String((error && error.message) || error).slice(0, 240),
    });
  });
}

function instrumentMeetSender(pc, pcId, sender, source) {
  if (!sender) return sender;
  if (sender.__meetingAvatarRealtimeInstrumented) {
    if (sender.track?.kind === "audio") {
      handleMeetOutboundAudioSender(pc, pcId, sender, sender.track, source);
    } else {
      probeMeetOutboundAudioSenderByStats(pc, pcId, sender, source);
    }
    return sender;
  }
  sender.__meetingAvatarRealtimeInstrumented = true;
  const originalReplaceTrack = sender.replaceTrack?.bind(sender);
  if (originalReplaceTrack) {
    sender.replaceTrack = async function (track) {
      const result = await originalReplaceTrack(track);
      handleMeetOutboundAudioSender(pc, pcId, sender, track, `${source}.replaceTrack`);
      handleMeetOutboundVideoSender(pc, pcId, sender, track, `${source}.replaceTrack`);
      return result;
    };
  }
  if (sender.track?.kind === "audio") {
    handleMeetOutboundAudioSender(pc, pcId, sender, sender.track, source);
  } else {
    probeMeetOutboundAudioSenderByStats(pc, pcId, sender, source);
  }
  if (sender.track?.kind === "video") {
    handleMeetOutboundVideoSender(pc, pcId, sender, sender.track, source);
  }
  return sender;
}

function scanMeetOutboundSenders(pc, pcId) {
  if (pc === activePeerConnection || typeof pc.getSenders !== "function") return;
  pc.getSenders().forEach((sender, index) =>
    instrumentMeetSender(pc, pcId, sender, `scan[${index}]`),
  );
}
function scanMeetInboundReceivers(pc, pcId) {
  if (pc === activePeerConnection || typeof pc.getReceivers !== "function") return;
  pc.getReceivers().forEach((receiver, index) => {
    const track = receiver?.track;
    if (track?.kind === "audio" && track.readyState !== "ended") {
      forwardMeetAudioTrackToRealtime(track, { pcId, source: `scanReceiver[${index}]` });
    }
  });
}

function captureStreamFromMediaElement(element) {
  const capture = element.captureStream || element.mozCaptureStream;
  if (typeof capture !== "function") return { stream: null, error: "capture_stream_unavailable" };
  try {
    return { stream: capture.call(element), error: "" };
  } catch (error) {
    const message = String((error && error.message) || error).slice(0, 240);
    recordTimeline("meet_media_element_capture_failed", {
      tagName: String(element.tagName || "").toLowerCase(),
      error: message,
    });
    return { stream: null, error: message };
  }
}

function scanMeetMediaElementAudio() {
  const elements = Array.from(document.querySelectorAll("audio,video")) as Array<
    HTMLMediaElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    }
  >;
  state.connection.meetMediaElementsScanned = elements.length;
  if (!shouldRouteGenericMediaElementAudio()) {
    state.connection.meetMediaElementDiscoverySkipped = true;
    state.connection.meetMediaElementStates = elements.slice(-12).map((element) => {
      const srcObject = element.srcObject as MediaStream | null | undefined;
      return {
        tagName: String(element.tagName || "").toLowerCase(),
        muted: element.muted === true,
        paused: element.paused === true,
        readyState: element.readyState || 0,
        volume: element.volume,
        srcObjectAudioTracks: srcObject?.getAudioTracks?.().length || 0,
        captureAudioTracks: 0,
        captureError: "generic_media_element_audio_disabled_on_google_meet",
      };
    });
    if (!state.connection.meetMediaElementDiscoverySkipLogged) {
      state.connection.meetMediaElementDiscoverySkipLogged = true;
      recordTimeline("meet_media_element_audio_discovery_skipped", {
        reason: "generic_media_element_audio_disabled_on_google_meet",
        elements: elements.length,
      });
    }
    updateFeedback();
    return;
  }
  const elementStates = [];
  for (const element of elements) {
    const srcObject = element.srcObject as MediaStream | null | undefined;
    const srcObjectAudioTracks = srcObject?.getAudioTracks?.() || [];
    const participantStreamAlreadyDispatched =
      element.dataset?.meetingAvatarParticipantStreamDispatched === "1";
    const captured =
      routedMeetMediaElements.has(element) || participantStreamAlreadyDispatched
        ? { stream: null, error: "already_routed" }
        : captureStreamFromMediaElement(element);
    const captureAudioTracks =
      captured.stream?.getAudioTracks?.().filter((track) => track.readyState !== "ended") || [];
    elementStates.push({
      tagName: String(element.tagName || "").toLowerCase(),
      muted: element.muted === true,
      paused: element.paused === true,
      readyState: element.readyState || 0,
      volume: element.volume,
      srcObjectAudioTracks: srcObjectAudioTracks.length,
      captureAudioTracks: captureAudioTracks.length,
      captureError: captured.error || "",
    });
    if (routedMeetMediaElements.has(element) || participantStreamAlreadyDispatched) continue;
    const stream = captured.stream;
    const tracks = captureAudioTracks;
    if (!tracks.length) continue;
    routedMeetMediaElements.add(element);
    tracks.forEach((track, index) => {
      if (
        forwardMeetAudioTrackToRealtime(track, {
          source: `mediaElement.${String(element.tagName || "").toLowerCase()}.captureStream[${index}]`,
          elementMuted: element.muted === true,
          elementPaused: element.paused === true,
          elementReadyState: element.readyState || 0,
        })
      ) {
        state.connection.meetMediaElementAudioTracksAdded += 1;
      }
    });
  }
  state.connection.meetMediaElementStates = elementStates.slice(-12);
  updateFeedback();
}

function installMeetMediaElementAudioDiscovery() {
  scanMeetMediaElementAudio();
  window.setInterval(scanMeetMediaElementAudio, 1000);
}

function installMeetPeerConnectionHook() {
  if (peerConnectionHookInstalled || window.__meetingAvatarRealtimePeerConnectionHook) return;
  if (typeof window.RTCPeerConnection !== "function") return;
  const OriginalRTCPeerConnection = window.RTCPeerConnection;
  let pcCounter = 0;
  function HookedRTCPeerConnection(...args: ConstructorParameters<typeof RTCPeerConnection>) {
    const pc = new OriginalRTCPeerConnection(...args);
    const pcId = ++pcCounter;
    if ((window as any).__MAB_CREATING_REALTIME_AGENT_PEER_CONNECTION === true) {
      recordTimeline("peer_connection_created", { pcId, bypass: "realtime_agent" });
      return pc;
    }
    recordTimeline("peer_connection_created", { pcId });

    const originalAddTrack = pc.addTrack?.bind(pc);
    if (originalAddTrack) {
      pc.addTrack = function (track, ...streams) {
        const sender = originalAddTrack(track, ...streams);
        instrumentMeetSender(pc, pcId, sender, "addTrack");
        return sender;
      };
    }

    const originalAddTransceiver = pc.addTransceiver?.bind(pc);
    if (originalAddTransceiver) {
      pc.addTransceiver = function (trackOrKind, init) {
        const transceiver = originalAddTransceiver(trackOrKind, init);
        instrumentMeetSender(pc, pcId, transceiver.sender, "addTransceiver");
        if (trackOrKind && typeof trackOrKind === "object") {
          handleMeetOutboundAudioSender(
            pc,
            pcId,
            transceiver.sender,
            trackOrKind,
            "addTransceiver(track)",
          );
          handleMeetOutboundVideoSender(
            pc,
            pcId,
            transceiver.sender,
            trackOrKind,
            "addTransceiver(track)",
          );
        }
        return transceiver;
      };
    }

    pc.addEventListener("track", (event) => {
      if (pc === activePeerConnection) return;
      if (!event.track || event.track.kind !== "audio") return;
      forwardMeetAudioTrackToRealtime(event.track, { pcId, source: "pc.track" });
    });

    const timer = window.setInterval(() => {
      if (pc.connectionState === "closed") {
        window.clearInterval(timer);
        return;
      }
      scanMeetOutboundSenders(pc, pcId);
      scanMeetInboundReceivers(pc, pcId);
    }, 1000);

    return pc;
  }
  HookedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  Object.setPrototypeOf(HookedRTCPeerConnection, OriginalRTCPeerConnection);
  window.RTCPeerConnection = HookedRTCPeerConnection as unknown as typeof RTCPeerConnection;
  window.__meetingAvatarRealtimePeerConnectionHook = true;
  peerConnectionHookInstalled = true;
  recordTimeline("meet_peer_connection_hook_installed");
  installMeetMediaElementAudioDiscovery();
}

installMeetPeerConnectionHook();
