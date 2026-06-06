export function buildLanOperatorOutputClientScript() {
  return `
(() => {
  function ensureOutputState(state) {
    state.output = state.output || {};
    state.output.assistantText = state.output.assistantText || {
      deltaCount: 0,
      completedCount: 0,
      currentText: "",
      completedText: "",
      lastTextAt: null,
      lastResponseId: null,
    };
    state.output.assistantAudio = state.output.assistantAudio || {
      enabled: true,
      status: "idle",
      chunksReceived: 0,
      chunksPlayed: 0,
      bytesReceived: 0,
      sampleRate: null,
      channels: null,
      queuedMs: 0,
      rms: null,
      peak: null,
      lastChunkAt: null,
      lastPlaybackAt: null,
      lastError: null,
    };
    return state.output;
  }

  function decodeBase64(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function pcm16ToFloat32(bytes) {
    const samples = new Float32Array(Math.floor(bytes.length / 2));
    for (let index = 0; index < samples.length; index += 1) {
      const lo = bytes[index * 2];
      const hi = bytes[index * 2 + 1];
      const value = (hi << 8) | lo;
      const signed = value >= 0x8000 ? value - 0x10000 : value;
      samples[index] = Math.max(-1, Math.min(1, signed / 32768));
    }
    return samples;
  }

  function energy(samples) {
    if (!samples.length) return { rms: 0, peak: 0 };
    let sum = 0;
    let peak = 0;
    for (const sample of samples) {
      const abs = Math.abs(sample);
      peak = Math.max(peak, abs);
      sum += sample * sample;
    }
    return {
      rms: Math.round(Math.sqrt(sum / samples.length) * 10000) / 10000,
      peak: Math.round(peak * 10000) / 10000,
    };
  }

  window.MAB_LAN_OPERATOR_OUTPUT = {
    create(input) {
      const state = input.state;
      const output = ensureOutputState(state);
      let audioContext = null;
      let scheduledAt = 0;
      const activeSources = new Set();

      function emitOutputState() {
        input.sendOperatorEvent?.({ type: "assistant_output_state", output: state.output });
      }

      function sync() {
        emitOutputState();
        input.syncDebug?.();
      }

      function context() {
        if (!audioContext) {
          const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
          if (!AudioContextCtor) throw new Error("audio_context_unavailable");
          audioContext = new AudioContextCtor();
        }
        if (audioContext.state === "suspended") {
          void audioContext.resume().catch((error) => {
            output.assistantAudio.status = "blocked";
            output.assistantAudio.lastError = String(error?.message || error);
            sync();
          });
        }
        return audioContext;
      }

      function playPcm16Chunk(event) {
        const audio = output.assistantAudio;
        const bytes = decodeBase64(event.audioBase64 || "");
        const sampleRate = Number(event.detail?.sampleRate || event.detail?.sample_rate || 24000);
        const channels = Math.max(1, Number(event.detail?.channels || 1));
        const mono = pcm16ToFloat32(bytes);
        const chunkEnergy = energy(mono);
        audio.chunksReceived += 1;
        audio.bytesReceived += bytes.length;
        audio.sampleRate = sampleRate;
        audio.channels = channels;
        audio.rms = chunkEnergy.rms;
        audio.peak = chunkEnergy.peak;
        audio.lastChunkAt = new Date().toISOString();
        if (!audio.enabled || !mono.length) {
          audio.status = audio.enabled ? "stopped" : "blocked";
          sync();
          return;
        }
        try {
          const ctx = context();
          const frames = Math.floor(mono.length / channels);
          const buffer = ctx.createBuffer(channels, frames, sampleRate);
          for (let channel = 0; channel < channels; channel += 1) {
            const channelData = buffer.getChannelData(channel);
            for (let frame = 0; frame < frames; frame += 1) {
              channelData[frame] = mono[frame * channels + channel] || 0;
            }
          }
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          activeSources.add(source);
          const now = ctx.currentTime;
          scheduledAt = Math.max(now, scheduledAt);
          source.start(scheduledAt);
          scheduledAt += buffer.duration;
          audio.status = "playing";
          audio.chunksPlayed += 1;
          audio.queuedMs = Math.max(0, Math.round((scheduledAt - now) * 1000));
          audio.lastPlaybackAt = new Date().toISOString();
          audio.lastError = null;
          source.addEventListener("ended", () => {
            activeSources.delete(source);
            if (audio.status === "playing" && ctx.currentTime >= scheduledAt - 0.05) {
              audio.status = "stopped";
              audio.queuedMs = 0;
              sync();
            }
          });
        } catch (error) {
          audio.status = "failed";
          audio.lastError = String(error?.message || error);
        }
        sync();
      }

      function handleCanonicalEvent(event) {
        const text = output.assistantText;
        const audio = output.assistantAudio;
        if (event.type === "assistant_text_delta") {
          text.deltaCount += 1;
          text.currentText += String(event.text || "");
          text.lastTextAt = new Date().toISOString();
          text.lastResponseId = event.responseId || text.lastResponseId;
          sync();
        }
        if (event.type === "assistant_text_completed") {
          text.completedCount += 1;
          text.completedText = String(event.text || text.currentText || "");
          text.currentText = "";
          text.lastTextAt = new Date().toISOString();
          text.lastResponseId = event.responseId || text.lastResponseId;
          sync();
        }
        if (event.type === "assistant_audio_started") {
          audio.status = "playing";
          audio.lastChunkAt = new Date().toISOString();
          sync();
        }
        if (event.type === "assistant_audio_chunk") playPcm16Chunk(event);
        if (event.type === "assistant_audio_stopped") {
          audio.status = "stopped";
          audio.queuedMs = 0;
          sync();
        }
      }

      function setAudioEnabled(enabled) {
        output.assistantAudio.enabled = Boolean(enabled);
        if (!enabled) {
          stopAudio("disabled");
          output.assistantAudio.status = "blocked";
        }
        sync();
        return state.output;
      }

      function stopAudio(reason = "operator_control") {
        for (const source of activeSources) {
          try {
            source.stop();
          } catch {
            // Already stopped sources are harmless.
          }
        }
        activeSources.clear();
        scheduledAt = audioContext?.currentTime || 0;
        output.assistantAudio.status = "stopped";
        output.assistantAudio.queuedMs = 0;
        output.assistantAudio.lastPlaybackAt = new Date().toISOString();
        output.assistantAudio.lastError = reason === "disabled" ? "audio_disabled" : null;
        sync();
        return state.output;
      }

      return {
        handleCanonicalEvent,
        setAudioEnabled,
        stopAudio,
        emitOutputState,
      };
    },
  };
})();
`;
}
