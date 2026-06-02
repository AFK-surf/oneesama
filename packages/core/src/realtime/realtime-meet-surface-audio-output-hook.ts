(() => {
  if ((window as any).__meetingAvatarMeetSurfaceAudioOutputHook) return;
  if (window.top !== window) return;
  (window as any).__meetingAvatarMeetSurfaceAudioOutputHook = true;

  const bridge = ((window as any).MAB_REALTIME_BRIDGE = (window as any).MAB_REALTIME_BRIDGE || {});
  bridge.connection = bridge.connection || {};
  bridge.timeline = Array.isArray(bridge.timeline) ? bridge.timeline : [];
  const connection = bridge.connection;

  connection.meetSurfaceAudioOutputHookInstalled = true;
  connection.meetSurfaceAudioOutputHookStatus = "installing";
  connection.primaryMeetAudioSenderUsingAvatarBus =
    connection.primaryMeetAudioSenderUsingAvatarBus === true;
  connection.primaryMeetAudioSenderTrackId = connection.primaryMeetAudioSenderTrackId || "";
  connection.primaryMeetAudioSenderStats = connection.primaryMeetAudioSenderStats || null;
  connection.primaryMeetAudioSenderAttachAttempts = Number(
    connection.primaryMeetAudioSenderAttachAttempts || 0,
  );
  connection.meetOutboundAudioSenderCandidates = Array.isArray(
    connection.meetOutboundAudioSenderCandidates,
  )
    ? connection.meetOutboundAudioSenderCandidates
    : [];

  let primaryMeetAudioSender: RTCRtpSender | null = null;
  let primaryMeetAudioSenderPcId = 0;
  let primaryMeetAudioSenderStatsTimer = 0;
  let primaryMeetAudioSenderAttachRetryTimer = 0;
  const primaryMeetAudioSenderAttachInFlight = new WeakSet<RTCRtpSender>();
  const avatarAudioBusSenderTrackClones = new WeakSet<MediaStreamTrack>();
  const senderCandidateIds = new WeakMap<RTCRtpSender, number>();
  let senderCandidateCounter = 0;

  function recordTimeline(type: string, detail: Record<string, unknown> = {}) {
    bridge.timeline.push({ ts: new Date().toISOString(), type, detail });
    bridge.timeline = bridge.timeline.slice(-120);
  }

  function avatarAudioBusTrack() {
    const bus = (window as any).MAB_AVATAR_AUDIO_BUS;
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

  function isAvatarAudioBusSenderTrack(track: MediaStreamTrack | null | undefined) {
    const sourceTrack = avatarAudioBusTrack();
    return Boolean(
      track &&
      (avatarAudioBusSenderTrackClones.has(track) ||
        (track as any).__meetingAvatarAudioBusClone === true ||
        (sourceTrack && track.id === sourceTrack.id)),
    );
  }

  function senderId(sender: RTCRtpSender) {
    let id = senderCandidateIds.get(sender);
    if (!id) {
      id = ++senderCandidateCounter;
      senderCandidateIds.set(sender, id);
    }
    return id;
  }

  function compactTrack(track: MediaStreamTrack | null | undefined) {
    return {
      kind: track?.kind || "",
      id: track?.id || "",
      label: String(track?.label || "").slice(0, 120),
      readyState: track?.readyState || "",
      enabled: track?.enabled !== false,
      muted: track?.muted === true,
    };
  }

  function rememberCandidate(
    pcId: number,
    sender: RTCRtpSender,
    source: string,
    reason: string,
    hint: Record<string, unknown> = {},
  ) {
    const candidate = {
      id: senderId(sender),
      pcId,
      source,
      reason,
      checkedAt: new Date().toISOString(),
      track: compactTrack(sender.track),
      hintKind: String(hint.kind || ""),
      direction: String(hint.direction || ""),
      currentDirection: String(hint.currentDirection || ""),
      stats: hint.stats || null,
    };
    connection.meetOutboundAudioSenderCandidates = [
      ...connection.meetOutboundAudioSenderCandidates,
      candidate,
    ].slice(-24);
    connection.meetSurfaceAudioOutputLastCandidateAt = candidate.checkedAt;
    return candidate;
  }

  function outboundAudioStats(report: RTCStatsReport | null | undefined) {
    let selected: RTCStats | null = null;
    report?.forEach?.((entry: RTCStats) => {
      if (selected) return;
      const kind = (entry as any).kind || (entry as any).mediaType;
      if (entry.type === "outbound-rtp" && (!kind || kind === "audio")) selected = entry;
    });
    if (!selected) return null;
    return {
      bytesSent: Number((selected as any).bytesSent || 0),
      packetsSent: Number((selected as any).packetsSent || 0),
      kind: String((selected as any).kind || (selected as any).mediaType || ""),
      id: String(selected.id || ""),
    };
  }

  function updatePrimaryMeetAudioSenderState(sender: RTCRtpSender | null) {
    const senderTrack = sender?.track || null;
    connection.primaryMeetAudioSenderTrackId = senderTrack?.id || "";
    connection.primaryMeetAudioSenderUsingAvatarBus = isAvatarAudioBusSenderTrack(senderTrack);
  }

  async function samplePrimaryMeetAudioSenderStats(reason = "interval") {
    const sender = primaryMeetAudioSender;
    const now = new Date().toISOString();
    if (!sender?.getStats) {
      connection.primaryMeetAudioSenderStats = {
        supported: false,
        reason: "sender_get_stats_unavailable",
        checkedAt: now,
      };
      return;
    }
    try {
      const selected = outboundAudioStats(await sender.getStats());
      if (!selected) {
        connection.primaryMeetAudioSenderStats = {
          supported: false,
          reason: "outbound_audio_stats_missing",
          checkedAt: now,
          trackId: sender.track?.id || "",
          trackReadyState: sender.track?.readyState || "",
          usingAvatarBus: connection.primaryMeetAudioSenderUsingAvatarBus === true,
        };
        return;
      }
      const previous = connection.primaryMeetAudioSenderStats || {};
      connection.primaryMeetAudioSenderStats = {
        supported: true,
        checkedAt: now,
        reason,
        trackId: sender.track?.id || "",
        trackReadyState: sender.track?.readyState || "",
        trackEnabled: sender.track?.enabled !== false,
        trackMuted: sender.track?.muted === true,
        usingAvatarBus: connection.primaryMeetAudioSenderUsingAvatarBus === true,
        bytesSent: selected.bytesSent,
        packetsSent: selected.packetsSent,
        bytesDelta: selected.bytesSent - Number(previous.bytesSent || 0),
        packetsDelta: selected.packetsSent - Number(previous.packetsSent || 0),
      };
    } catch (error) {
      connection.primaryMeetAudioSenderStats = {
        supported: false,
        reason: "sender_get_stats_failed",
        checkedAt: now,
        error: String((error as { message?: string })?.message || error).slice(0, 240),
      };
    }
  }

  function ensurePrimaryMeetAudioSenderStatsMonitor(reason = "sender-ready") {
    if (!primaryMeetAudioSender || primaryMeetAudioSenderStatsTimer) return;
    void samplePrimaryMeetAudioSenderStats(reason);
    primaryMeetAudioSenderStatsTimer = window.setInterval(
      () => void samplePrimaryMeetAudioSenderStats("interval"),
      1000,
    );
  }

  function schedulePrimaryMeetAudioAttachRetry(pcId: number, source: string) {
    if (primaryMeetAudioSenderAttachRetryTimer) return;
    primaryMeetAudioSenderAttachRetryTimer = window.setTimeout(() => {
      primaryMeetAudioSenderAttachRetryTimer = 0;
      if (primaryMeetAudioSender)
        attachAvatarAudioToPrimaryMeetSender(primaryMeetAudioSender, pcId, `${source}.retry`);
    }, 250);
  }

  function attachAvatarAudioToPrimaryMeetSender(
    sender: RTCRtpSender,
    pcId: number,
    source: string,
  ) {
    if (!sender || sender !== primaryMeetAudioSender) return;
    updatePrimaryMeetAudioSenderState(sender);
    const avatarTrack = avatarAudioBusTrack();
    if (!avatarTrack) {
      connection.meetSurfaceAudioOutputHookStatus = "waiting_for_avatar_audio_bus";
      schedulePrimaryMeetAudioAttachRetry(pcId, source);
      return;
    }
    if (isAvatarAudioBusSenderTrack(sender.track) && sender.track?.readyState !== "ended") {
      connection.meetSurfaceAudioOutputHookStatus = "attached";
      ensurePrimaryMeetAudioSenderStatsMonitor("already-attached");
      return;
    }
    if (primaryMeetAudioSenderAttachInFlight.has(sender)) return;
    primaryMeetAudioSenderAttachInFlight.add(sender);
    connection.primaryMeetAudioSenderAttachAttempts =
      Number(connection.primaryMeetAudioSenderAttachAttempts || 0) + 1;
    const replacementTrack = cloneAvatarAudioBusTrack();
    if (!replacementTrack) {
      connection.meetSurfaceAudioOutputHookStatus = "waiting_for_avatar_audio_bus";
      schedulePrimaryMeetAudioAttachRetry(pcId, source);
      return;
    }
    sender
      .replaceTrack(replacementTrack)
      .then(() => {
        connection.primaryMeetAudioSenderTrackId = replacementTrack.id;
        connection.primaryMeetAudioSenderUsingAvatarBus = true;
        connection.lastPrimaryMeetAudioAttachAt = new Date().toISOString();
        connection.lastPrimaryMeetAudioAttachError = "";
        connection.meetSurfaceAudioOutputHookStatus = "attached";
        recordTimeline("meet_surface_primary_audio_sender_attached", {
          pcId,
          source,
          trackId: replacementTrack.id,
          sourceTrackId: avatarTrack.id,
        });
        void samplePrimaryMeetAudioSenderStats("avatar-bus-attached");
        ensurePrimaryMeetAudioSenderStatsMonitor("avatar-bus-attached");
        return undefined;
      })
      .catch((error) => {
        const message = String((error as { message?: string })?.message || error).slice(0, 240);
        connection.lastPrimaryMeetAudioAttachError = message;
        connection.meetSurfaceAudioOutputHookStatus = "attach_failed";
        recordTimeline("meet_surface_primary_audio_sender_attach_failed", {
          pcId,
          source,
          error: message,
        });
      })
      .finally(() => {
        primaryMeetAudioSenderAttachInFlight.delete(sender);
      });
  }

  function selectMeetOutboundAudioSender(
    pcId: number,
    sender: RTCRtpSender,
    source: string,
    reason: string,
    hint: Record<string, unknown> = {},
  ) {
    const candidate = rememberCandidate(pcId, sender, source, reason, hint);
    if (!primaryMeetAudioSender) {
      primaryMeetAudioSender = sender;
      primaryMeetAudioSenderPcId = pcId;
      connection.meetSurfaceAudioOutputHookStatus = "primary_selected";
      recordTimeline("meet_surface_primary_audio_sender_selected", {
        pcId,
        source,
        reason,
        candidateId: candidate.id,
        trackId: sender.track?.id || "",
      });
      ensurePrimaryMeetAudioSenderStatsMonitor("primary-selected");
    }
    if (sender === primaryMeetAudioSender)
      attachAvatarAudioToPrimaryMeetSender(sender, pcId, source);
  }

  async function probeSenderStats(
    pcId: number,
    sender: RTCRtpSender,
    source: string,
    hint: Record<string, unknown> = {},
  ) {
    if (!sender?.getStats) {
      rememberCandidate(pcId, sender, source, "stats_unavailable", hint);
      return;
    }
    if ((sender as any).__meetingAvatarMeetSurfaceStatsProbeInFlight) return;
    (sender as any).__meetingAvatarMeetSurfaceStatsProbeInFlight = true;
    try {
      const selected = outboundAudioStats(await sender.getStats());
      if (!selected) {
        rememberCandidate(pcId, sender, source, "stats_no_outbound_audio", hint);
        return;
      }
      selectMeetOutboundAudioSender(pcId, sender, source, "stats_outbound_audio", {
        ...hint,
        stats: selected,
      });
    } catch (error) {
      rememberCandidate(pcId, sender, source, "stats_probe_failed", {
        ...hint,
        error: String((error as { message?: string })?.message || error).slice(0, 240),
      });
    } finally {
      (sender as any).__meetingAvatarMeetSurfaceStatsProbeInFlight = false;
    }
  }

  function instrumentMeetSender(
    pc: RTCPeerConnection,
    pcId: number,
    sender: RTCRtpSender,
    source: string,
    hint: Record<string, unknown> = {},
  ) {
    if (!sender) return sender;
    const hintKind = String(hint.kind || "").toLowerCase();
    if (!(sender as any).__meetingAvatarMeetSurfaceInstrumented) {
      (sender as any).__meetingAvatarMeetSurfaceInstrumented = true;
      const originalReplaceTrack = sender.replaceTrack?.bind(sender);
      if (originalReplaceTrack) {
        sender.replaceTrack = async function (track: MediaStreamTrack | null) {
          const result = await originalReplaceTrack(track);
          if (track?.kind === "audio") {
            selectMeetOutboundAudioSender(
              pcId,
              sender,
              `${source}.replaceTrack`,
              "replace_track_audio",
              hint,
            );
          }
          return result;
        };
      }
    }
    if (sender.track?.kind === "audio") {
      selectMeetOutboundAudioSender(pcId, sender, source, "sender_track_audio", hint);
    } else if (hintKind === "audio") {
      selectMeetOutboundAudioSender(pcId, sender, source, "audio_kind_hint", hint);
    } else {
      void probeSenderStats(pcId, sender, source, hint);
    }
    return sender;
  }

  function scanMeetOutboundSenders(pc: RTCPeerConnection, pcId: number) {
    if (typeof pc.getSenders !== "function") return;
    connection.meetSurfaceAudioOutputLastScanAt = new Date().toISOString();
    pc.getSenders().forEach((sender, index) => {
      instrumentMeetSender(pc, pcId, sender, `scan[${index}]`);
    });
    if (primaryMeetAudioSender) {
      attachAvatarAudioToPrimaryMeetSender(
        primaryMeetAudioSender,
        primaryMeetAudioSenderPcId,
        "scan.retry-primary",
      );
    }
  }

  if (typeof window.RTCPeerConnection !== "function") {
    connection.meetSurfaceAudioOutputHookStatus = "rtc_peer_connection_unavailable";
    return;
  }

  const OriginalRTCPeerConnection = window.RTCPeerConnection;
  let pcCounter = 0;
  function HookedRTCPeerConnection(...args: ConstructorParameters<typeof RTCPeerConnection>) {
    const pc = new OriginalRTCPeerConnection(...args);
    const pcId = ++pcCounter;
    recordTimeline("meet_surface_peer_connection_created", { pcId });

    const originalAddTrack = pc.addTrack?.bind(pc);
    if (originalAddTrack) {
      pc.addTrack = function (track: MediaStreamTrack, ...streams: MediaStream[]) {
        const sender = originalAddTrack(track, ...streams);
        instrumentMeetSender(pc, pcId, sender, "addTrack", { kind: track?.kind || "" });
        return sender;
      };
    }

    const originalAddTransceiver = pc.addTransceiver?.bind(pc);
    if (originalAddTransceiver) {
      pc.addTransceiver = function (
        trackOrKind: MediaStreamTrack | string,
        init?: RTCRtpTransceiverInit,
      ) {
        const transceiver = originalAddTransceiver(trackOrKind as any, init);
        const kind = typeof trackOrKind === "string" ? trackOrKind : trackOrKind?.kind || "";
        instrumentMeetSender(pc, pcId, transceiver.sender, "addTransceiver", {
          kind,
          direction: transceiver.direction || init?.direction || "",
          currentDirection: transceiver.currentDirection || "",
        });
        return transceiver;
      };
    }

    const timer = window.setInterval(() => {
      if (pc.connectionState === "closed") {
        window.clearInterval(timer);
        return;
      }
      scanMeetOutboundSenders(pc, pcId);
    }, 1000);
    return pc;
  }

  HookedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  Object.setPrototypeOf(HookedRTCPeerConnection, OriginalRTCPeerConnection);
  window.RTCPeerConnection = HookedRTCPeerConnection as unknown as typeof RTCPeerConnection;
  connection.meetSurfaceAudioOutputHookStatus = "installed";
  recordTimeline("meet_surface_audio_output_hook_installed");
})();
