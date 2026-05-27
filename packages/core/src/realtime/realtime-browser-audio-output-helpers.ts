(() => {
  interface MockDataChannel {
    readyState: RTCDataChannelState;
    send(payload: unknown): void;
    close(): void;
  }

  interface RouteRemoteAudioOptions {
    label?: string;
    gain?: number;
    timeoutMs?: number;
  }

  interface MockRemoteAudioOptions extends RouteRemoteAudioOptions {
    durationMs?: number;
  }

  interface RealtimeAudioOutputHelperDeps {
    state: Record<string, any>;
    rememberError(error: unknown): void;
    recordTimeline(type: string, detail?: Record<string, unknown>): void;
    updateFeedback(): void;
  }

  function create(deps: RealtimeAudioOutputHelperDeps) {
    const { state, rememberError, recordTimeline, updateFeedback } = deps;

    function createMockDataChannel(): MockDataChannel {
      const channel: MockDataChannel = {
        readyState: "open",
        send(payload: unknown) {
          state.connection.sentDataChannelMessages.push({
            ts: new Date().toISOString(),
            payload,
          });
          state.connection.sentDataChannelMessages =
            state.connection.sentDataChannelMessages.slice(-100);
        },
        close() {
          channel.readyState = "closed";
          state.connected = false;
          state.connection.dataChannelOpen = false;
        },
      };
      return channel;
    }

    async function waitForAvatarAudioBus(timeoutMs = 2500) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((window as any).MAB_AVATAR_AUDIO_BUS) return (window as any).MAB_AVATAR_AUDIO_BUS;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return (window as any).MAB_AVATAR_AUDIO_BUS || null;
    }

    async function routeRemoteAudioStream(
      stream: MediaStream | null | undefined,
      options: RouteRemoteAudioOptions = {},
    ) {
      const bus = await waitForAvatarAudioBus(options.timeoutMs);
      if (!bus?.addStream) {
        rememberError(new Error("avatar audio bus is not available for remote audio routing"));
        return { ok: false, error: "avatar_audio_bus_missing" };
      }
      const result = bus.addStream(stream, {
        label: options.label || "openai-realtime-remote-audio",
        gain: options.gain,
      });
      state.connection.remoteAudioAttached = result.ok === true;
      state.connection.remoteAudioRoutedToAvatarBus = result.ok === true;
      recordTimeline("remote_audio_route", {
        ok: result.ok === true,
        label: options.label || "openai-realtime-remote-audio",
        trackIds: stream?.getAudioTracks?.().map((track) => track.id) || [],
      });
      updateFeedback();
      return result;
    }

    async function injectMockRemoteAudio(options: MockRemoteAudioOptions = {}) {
      const bus = await waitForAvatarAudioBus(options.timeoutMs);
      if (!bus?.injectTone) {
        rememberError(
          new Error("avatar audio bus is not available for mock remote audio injection"),
        );
        return { ok: false, error: "avatar_audio_bus_missing" };
      }
      const result = bus.injectTone({
        label: options.label || "webrtc-mock-remote-audio",
        gain: options.gain ?? 0.0001,
        durationMs: options.durationMs ?? 120,
      });
      state.connection.remoteAudioAttached = result.ok === true;
      state.connection.remoteAudioRoutedToAvatarBus = result.ok === true;
      state.connection.mockRemoteAudioInjected = result.ok === true;
      recordTimeline("mock_remote_audio_route", { ok: result.ok === true });
      updateFeedback();
      return result;
    }

    return {
      createMockDataChannel,
      routeRemoteAudioStream,
      injectMockRemoteAudio,
    };
  }

  (window as any).__MAB_REALTIME_AUDIO_OUTPUT_HELPERS = { create };
})();
