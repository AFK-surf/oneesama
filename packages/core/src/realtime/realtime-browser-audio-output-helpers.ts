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

  interface PcmPortPayload {
    label: string;
    format: string;
    sampleRate: number;
    channels: number;
    samples: number[];
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

    function isSidecarRuntime() {
      return (
        String(state.realtimeRuntimePlacement || "") === "sidecar" ||
        String((state as any).realtimePageRole || "") === "sidecar"
      );
    }

    async function enqueueSidecarPcmFrames(payload: PcmPortPayload) {
      const port = (window as any).MAB_REALTIME_OUTPUT_AUDIO_PORT;
      if (typeof port?.enqueuePcmFrames === "function") {
        return await port.enqueuePcmFrames(payload);
      }
      const host = (window as any).MAB_HOST_ENQUEUE_REALTIME_PCM;
      if (typeof host === "function") return await host(payload);
      return { ok: false, error: "realtime_output_audio_port_missing" };
    }

    async function routeSidecarPcmFrames(payload: PcmPortPayload) {
      const now = new Date().toISOString();
      const result = await enqueueSidecarPcmFrames(payload);
      const ok = result?.ok !== false;
      state.connection.remoteAudioAttached = true;
      state.connection.remoteAudioRoutedToAvatarBus = ok;
      state.connection.sidecarOutputPcmChunks =
        Number(state.connection.sidecarOutputPcmChunks || 0) + 1;
      state.connection.sidecarOutputPcmLastChunkAt = now;
      state.connection.realtimeOutputAudioPort = {
        ...state.connection.realtimeOutputAudioPort,
        ok,
        pending: false,
        mode: "sidecar-pcm",
        chunks: state.connection.sidecarOutputPcmChunks,
        lastChunkAt: now,
        localSpeakerSink: false,
        sinkNode: state.connection.realtimeOutputAudioPort?.sinkNode || "host-pcm-port",
      };
      if (result?.ok === false) {
        const lastError = String(result.error || result.reason || "pcm_enqueue_failed");
        state.connection.sidecarOutputPcmLastError = lastError;
        state.connection.realtimeOutputAudioPort.lastError = lastError;
      }
      recordTimeline("remote_audio_sidecar_pcm_chunk", {
        ok,
        label: payload.label || "",
        sampleRate: payload.sampleRate || 0,
        channels: payload.channels || 0,
        samples: Array.isArray(payload.samples) ? payload.samples.length : 0,
      });
      updateFeedback();
      return result;
    }

    function startSidecarRemoteAudioPcmTap(
      stream: MediaStream | null | undefined,
      options: RouteRemoteAudioOptions = {},
    ) {
      if (!stream?.getAudioTracks?.().length) {
        return { ok: false, error: "remote_audio_stream_missing" };
      }
      const AudioContextImpl = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextImpl) return { ok: false, error: "audio_context_unavailable" };
      const audioContext = new AudioContextImpl({ sampleRate: 48000 });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(2048, 2, 2);
      const sink = audioContext.createMediaStreamDestination();
      const label = options.label || "openai-realtime-sidecar-output";
      let chunks = 0;
      let lastError = "";
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer;
        const channels = Math.min(2, input.numberOfChannels || 1);
        const frameCount = input.length;
        const samples: number[] = Array.from({
          length: frameCount * channels,
        } as ArrayLike<number>);
        for (let frame = 0; frame < frameCount; frame += 1) {
          for (let channel = 0; channel < channels; channel += 1) {
            samples[frame * channels + channel] = input.getChannelData(channel)[frame] || 0;
          }
        }
        chunks += 1;
        if (state.connection.realtimeOutputAudioPort) {
          state.connection.realtimeOutputAudioPort.chunks = chunks;
        }
        void routeSidecarPcmFrames({
          label,
          format: "float32",
          sampleRate: input.sampleRate,
          channels,
          samples,
        })
          .then((result) => {
            if (result?.ok === false) {
              lastError = String(result.error || result.reason || "pcm_enqueue_failed");
              state.connection.sidecarOutputPcmLastError = lastError;
              if (state.connection.realtimeOutputAudioPort) {
                state.connection.realtimeOutputAudioPort.lastError = lastError;
              }
            }
            return undefined;
          })
          .catch((error) => {
            lastError = String((error as { message?: string })?.message || error);
            state.connection.sidecarOutputPcmLastError = lastError;
            if (state.connection.realtimeOutputAudioPort) {
              state.connection.realtimeOutputAudioPort.lastError = lastError;
            }
          });
      };
      source.connect(processor);
      processor.connect(sink);
      state.connection.remoteAudioAttached = true;
      state.connection.remoteAudioRoutedToAvatarBus = false;
      state.connection.realtimeOutputAudioPort = {
        ok: false,
        pending: true,
        mode: "sidecar-pcm",
        chunks,
        lastError,
        localSpeakerSink: false,
        sinkNode: "MediaStreamDestination",
        trackIds: stream.getAudioTracks().map((track) => track.id),
      };
      recordTimeline("remote_audio_sidecar_pcm_route", {
        ok: true,
        label,
        trackIds: stream.getAudioTracks().map((track) => track.id),
      });
      updateFeedback();
      return { ok: true, mode: "sidecar-pcm" };
    }

    async function routeRemoteAudioStream(
      stream: MediaStream | null | undefined,
      options: RouteRemoteAudioOptions = {},
    ) {
      if (isSidecarRuntime()) return startSidecarRemoteAudioPcmTap(stream, options);
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
      recordTimeline("mock_remote_audio_route", { ok: result.ok === true });
      updateFeedback();
      return result;
    }

    return {
      createMockDataChannel,
      routeRemoteAudioStream,
      routeSidecarPcmFrames,
      injectMockRemoteAudio,
    };
  }

  (window as any).__MAB_REALTIME_AUDIO_OUTPUT_HELPERS = { create };
})();
