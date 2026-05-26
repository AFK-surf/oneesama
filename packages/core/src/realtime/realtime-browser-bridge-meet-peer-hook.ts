/* eslint-disable no-unused-vars */
  function isRoutingDestinationTrack(track: MediaStreamTrack | null | undefined) {
    if (!track || !routingDestination) return false;
    return routingDestination.stream.getAudioTracks().includes(track);
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
    if (!sender || sender.__meetingAvatarRealtimeInstrumented) return sender;
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
    }
    if (sender.track?.kind === "video") {
      handleMeetOutboundVideoSender(pc, pcId, sender, sender.track, source);
    }
    return sender;
  }

  function scanMeetOutboundSenders(pc, pcId) {
    if (pc === activePeerConnection || typeof pc.getSenders !== "function") return;
    pc.getSenders().forEach((sender, index) => instrumentMeetSender(pc, pcId, sender, `scan[${index}]`));
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

  function installMeetPeerConnectionHook() {
    if (peerConnectionHookInstalled || window.__meetingAvatarRealtimePeerConnectionHook) return;
    if (typeof window.RTCPeerConnection !== "function") return;
    const OriginalRTCPeerConnection = window.RTCPeerConnection;
    let pcCounter = 0;
    function HookedRTCPeerConnection(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      const pc = new OriginalRTCPeerConnection(...args);
      const pcId = ++pcCounter;
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
  }

  installMeetPeerConnectionHook();
