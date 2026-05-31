(() => {
  interface RealtimeAgentAudioHelperDeps {
    state: Record<string, any>;
    updateFeedback(): void;
  }

  function create(deps: RealtimeAgentAudioHelperDeps) {
    const { state, updateFeedback } = deps;
    let realtimeRemoteAudioStatsTimer = 0;
    let realtimeRemoteAudioTrackId = "";

    async function sampleRealtimeRemoteAudioTrackStats(
      pc: RTCPeerConnection | null | undefined,
      track: MediaStreamTrack | null | undefined,
      reason = "interval",
    ) {
      if (!pc?.getReceivers || !track?.id) return;
      const receiver = (pc.getReceivers() || []).find((entry) => entry?.track?.id === track.id);
      if (!receiver?.getStats) {
        state.connection.realtimeRemoteAudioTrackStats = {
          supported: false,
          reason: "receiver_get_stats_unavailable",
          trackId: track.id,
          checkedAt: new Date().toISOString(),
        };
        updateFeedback();
        return;
      }
      try {
        const report = await receiver.getStats();
        let inbound: any = null;
        let mediaSource: any = null;
        report?.forEach?.((entry: any) => {
          const kind = entry.kind || entry.mediaType;
          if (!inbound && entry.type === "inbound-rtp" && (!kind || kind === "audio")) {
            inbound = entry;
          }
          if (
            !mediaSource &&
            (entry.type === "track" || entry.type === "media-source") &&
            (!kind || kind === "audio")
          ) {
            mediaSource = entry;
          }
        });
        const previous = state.connection.realtimeRemoteAudioTrackStats || {};
        const totalAudioEnergy = Number(
          inbound?.totalAudioEnergy ?? mediaSource?.totalAudioEnergy ?? 0,
        );
        const totalSamplesDuration = Number(
          inbound?.totalSamplesDuration ?? mediaSource?.totalSamplesDuration ?? 0,
        );
        const audioLevel = Number(inbound?.audioLevel ?? mediaSource?.audioLevel ?? 0);
        const bytesReceived = Number(inbound?.bytesReceived || 0);
        const packetsReceived = Number(inbound?.packetsReceived || 0);
        state.connection.realtimeRemoteAudioTrackStats = {
          supported: true,
          reason,
          checkedAt: new Date().toISOString(),
          trackId: track.id,
          trackReadyState: track.readyState || "",
          trackMuted: track.muted === true,
          audioLevel,
          totalAudioEnergy,
          totalSamplesDuration,
          energyDelta: totalAudioEnergy - Number(previous.totalAudioEnergy || 0),
          observed: Boolean(previous.observed || totalAudioEnergy > 0 || audioLevel > 0),
          bytesReceived,
          bytesDelta: bytesReceived - Number(previous.bytesReceived || 0),
          packetsReceived,
          packetsDelta: packetsReceived - Number(previous.packetsReceived || 0),
        };
        updateFeedback();
      } catch (error) {
        state.connection.realtimeRemoteAudioTrackStats = {
          supported: false,
          reason: "receiver_get_stats_failed",
          trackId: track.id,
          checkedAt: new Date().toISOString(),
          error: String((error && (error as Error).message) || error).slice(0, 240),
        };
        updateFeedback();
      }
    }

    function monitorRealtimeRemoteAudioTrack(
      pc: RTCPeerConnection | null | undefined,
      track: MediaStreamTrack | null | undefined,
      reason = "agents-sdk-ontrack",
    ) {
      if (!pc || !track?.id) return;
      realtimeRemoteAudioTrackId = track.id;
      sampleRealtimeRemoteAudioTrackStats(pc, track, reason);
      if (realtimeRemoteAudioStatsTimer) return;
      realtimeRemoteAudioStatsTimer = window.setInterval(() => {
        const activeTrack =
          (pc.getReceivers?.() || []).find(
            (entry) => entry?.track?.id === realtimeRemoteAudioTrackId,
          )?.track || track;
        sampleRealtimeRemoteAudioTrackStats(pc, activeTrack, "interval");
      }, 1000);
    }

    function clearRealtimeRemoteAudioTrackStats() {
      if (realtimeRemoteAudioStatsTimer) {
        window.clearInterval(realtimeRemoteAudioStatsTimer);
        realtimeRemoteAudioStatsTimer = 0;
      }
      realtimeRemoteAudioTrackId = "";
    }

    function createRealtimeAgentSDKDecodeElement() {
      const element = document.createElement("audio");
      element.autoplay = true;
      element.muted = true;
      element.volume = 0;
      element.setAttribute("aria-hidden", "true");
      element.setAttribute("data-meeting-avatar-realtime-decode-only", "1");
      return element;
    }

    return {
      clearRealtimeRemoteAudioTrackStats,
      createRealtimeAgentSDKDecodeElement,
      monitorRealtimeRemoteAudioTrack,
    };
  }

  (window as any).__MAB_REALTIME_AGENT_AUDIO_HELPERS = { create };
})();
