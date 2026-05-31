(() => {
  interface RealtimeAudioSenderStatsHelperDeps {
    state: Record<string, any>;
    updateFeedback(): void;
    getRealtimeAudioSender(): RTCRtpSender | null | undefined;
  }

  function create(deps: RealtimeAudioSenderStatsHelperDeps) {
    const { state, updateFeedback, getRealtimeAudioSender } = deps;
    let realtimeAudioSenderStatsTimer = 0;

    async function sampleRealtimeAudioSenderStats(reason = "interval") {
      const sender = getRealtimeAudioSender();
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
        let selected: any = null;
        let mediaSource: any = null;
        let senderTrack: any = null;
        report?.forEach?.((entry: any) => {
          const kind = entry.kind || entry.mediaType;
          if (!selected && entry.type === "outbound-rtp" && (!kind || kind === "audio")) {
            selected = entry;
          }
          if (!mediaSource && entry.type === "media-source" && (!kind || kind === "audio")) {
            mediaSource = entry;
          }
          if (!senderTrack && entry.type === "track" && (!kind || kind === "audio")) {
            senderTrack = entry;
          }
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
          currentRealtimeInputIsRoutingMix:
            state.connection.currentRealtimeInputIsRoutingMix === true,
          bytesSent,
          packetsSent,
          bytesDelta: bytesSent - Number(previous.bytesSent || 0),
          packetsDelta: packetsSent - Number(previous.packetsSent || 0),
          sourceAudioLevel: Number(mediaSource?.audioLevel ?? senderTrack?.audioLevel ?? 0),
          sourceTotalAudioEnergy: Number(
            mediaSource?.totalAudioEnergy ?? senderTrack?.totalAudioEnergy ?? 0,
          ),
          sourceTotalSamplesDuration: Number(
            mediaSource?.totalSamplesDuration ?? senderTrack?.totalSamplesDuration ?? 0,
          ),
        };
        updateFeedback();
      } catch (error) {
        state.connection.realtimeAudioSenderStats = {
          supported: false,
          reason: "sender_get_stats_failed",
          checkedAt: now,
          error: String((error && (error as Error).message) || error).slice(0, 240),
        };
        updateFeedback();
      }
    }

    function ensureRealtimeAudioSenderStatsMonitor(reason = "sender-ready") {
      if (!getRealtimeAudioSender() || realtimeAudioSenderStatsTimer) return;
      sampleRealtimeAudioSenderStats(reason);
      realtimeAudioSenderStatsTimer = window.setInterval(
        () => sampleRealtimeAudioSenderStats("interval"),
        1000,
      );
    }

    function clearRealtimeAudioSenderStatsMonitor() {
      if (!realtimeAudioSenderStatsTimer) return;
      window.clearInterval(realtimeAudioSenderStatsTimer);
      realtimeAudioSenderStatsTimer = 0;
    }

    return {
      clearRealtimeAudioSenderStatsMonitor,
      ensureRealtimeAudioSenderStatsMonitor,
      sampleRealtimeAudioSenderStats,
    };
  }

  (window as any).__MAB_REALTIME_AUDIO_SENDER_STATS_HELPERS = { create };
})();
