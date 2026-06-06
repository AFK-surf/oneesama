export function buildLanOperatorVoiceClientScript() {
  return `(() => {
  const DEFAULT_PROCESSOR_SIZE = 1024;
  const MAX_BUFFERED_BYTES = 1_000_000;

  function clampSample(sample) {
    return Math.max(-1, Math.min(1, Number(sample) || 0));
  }

  function pcm16Base64(samples) {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = clampSample(samples[index]);
      const pcm = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(index * 2, Math.round(pcm), true);
    }
    let binary = "";
    const batch = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += batch) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + batch));
    }
    return btoa(binary);
  }

  function sampleEnergy(samples) {
    if (!samples.length) return 0;
    let sum = 0;
    for (const sample of samples) sum += clampSample(sample) * clampSample(sample);
    return Math.sqrt(sum / samples.length);
  }

  function create(options) {
    const state = options.state;
    let audioContext = null;
    let stream = null;
    let source = null;
    let processor = null;
    let sink = null;
    let sequence = 0;

    function patchVoiceState(patch = {}) {
      state.voiceCapture = { ...(state.voiceCapture || {}), ...patch };
      options.syncDebug?.();
    }

    function currentLocalVad(energy) {
      const threshold = Number(state.voiceLocalVad?.threshold ?? 0.02);
      const enabled = state.localVadEnabled !== false;
      return {
        enabled,
        role: enabled ? "telemetry" : "disabled",
        active: enabled && energy >= threshold,
        threshold,
        lastEnergy: energy,
        lastUpdatedAt: new Date().toISOString(),
      };
    }

    function sendChunk(samples) {
      const voiceWs = options.getVoiceSocket?.();
      if (!voiceWs || voiceWs.readyState !== WebSocket.OPEN) return false;
      if (state.voiceMuted) return false;
      if (voiceWs.bufferedAmount > MAX_BUFFERED_BYTES) {
        state.voiceDroppedChunks = Number(state.voiceDroppedChunks || 0) + 1;
        patchVoiceState({ droppedChunks: state.voiceDroppedChunks, bufferedAmount: voiceWs.bufferedAmount });
        options.sendOperatorEvent?.({
          type: "operator_voice_chunk_dropped",
          reason: "websocket_backpressure",
          bufferedAmount: voiceWs.bufferedAmount,
        });
        return false;
      }
      sequence += 1;
      const sampleRate = audioContext ? audioContext.sampleRate : 0;
      const energy = sampleEnergy(samples);
      const localVad = currentLocalVad(energy);
      const sentAt = new Date().toISOString();
      state.voiceLocalVad = localVad;
      const payload = {
        type: "voice_chunk",
        source: "operator_mic_pcm16",
        sessionId: state.sessionId,
        sequence,
        voiceStreamId: state.voiceStreamId || "",
        voiceStreamGeneration: Number(state.voiceStreamGeneration || 0),
        monotonicMs: performance.now(),
        sentAt,
        sampleRate,
        channels: 1,
        durationMs: sampleRate > 0 ? (samples.length / sampleRate) * 1000 : 0,
        energy,
        localVad,
        capture: {
          armed: state.voiceArmed,
          muted: state.voiceMuted,
          mode: "microphone_pcm16",
          status: "recording",
          deviceId: state.voiceDeviceId || "",
          deviceLabel: state.voiceCapture?.deviceLabel || "",
          permissionState: state.voiceCapture?.permissionState || "granted",
          availableDeviceCount: Number(state.voiceDevices?.length || 0),
        },
        dataBase64: pcm16Base64(samples),
      };
      voiceWs.send(JSON.stringify(payload));
      state.voiceChunksSent = Math.max(Number(state.voiceChunksSent || 0), sequence);
      patchVoiceState({
        mode: "microphone_pcm16",
        sampleRate,
        channels: 1,
        chunkFrames: samples.length,
        lastEnergy: payload.energy,
        localVad,
        chunksSent: state.voiceChunksSent,
        bufferedAmount: voiceWs.bufferedAmount,
        lastChunkAt: sentAt,
      });
      return true;
    }

    async function startMicrophone(input = {}) {
      if (stream) return { ok: true, stream, alreadyStarted: true };
      const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextImpl) throw new Error("audio_context_unavailable");
      const requestedDeviceId = String(input.deviceId || state.voiceDeviceId || "").trim();
      const audio = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (requestedDeviceId) audio.deviceId = { exact: requestedDeviceId };
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (error) {
        patchVoiceState({
          status: "blocked",
          permissionState: "denied_or_unavailable",
          error: String(error?.message || error),
        });
        throw error;
      }
      audioContext = new AudioContextImpl();
      await audioContext.resume?.();
      source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(DEFAULT_PROCESSOR_SIZE, 1, 1);
      sink = audioContext.createGain();
      sink.gain.value = 0;
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        sendChunk(input);
      };
      source.connect(processor);
      processor.connect(sink);
      sink.connect(audioContext.destination);
      const track = stream.getAudioTracks()[0];
      const settings = track?.getSettings?.() || {};
      const deviceId = String(settings.deviceId || requestedDeviceId || "");
      state.voiceDeviceId = deviceId;
      state.voiceArmed = true;
      state.voiceMuted = false;
      patchVoiceState({
        mode: "microphone_pcm16",
        status: "recording",
        armed: true,
        muted: false,
        sampleRate: audioContext.sampleRate,
        trackCount: stream.getAudioTracks().length,
        deviceId,
        deviceLabel: track?.label || "",
        permissionState: "granted",
        availableDeviceCount: Number(state.voiceDevices?.length || 0),
        startedAt: new Date().toISOString(),
        error: "",
      });
      options.sendOperatorEvent?.({
        type: "operator_mic_armed",
        armed: true,
        muted: false,
        trackCount: stream.getAudioTracks().length,
        sampleRate: audioContext.sampleRate,
        deviceId,
        deviceLabel: track?.label || "",
        permissionState: "granted",
        availableDeviceCount: Number(state.voiceDevices?.length || 0),
        capture: state.voiceCapture,
        localVad: state.voiceLocalVad,
      });
      return { ok: true, stream };
    }

    async function stopMicrophone(reason = "operator_disarmed") {
      processor?.disconnect?.();
      source?.disconnect?.();
      sink?.disconnect?.();
      stream?.getTracks?.().forEach((track) => track.stop());
      await audioContext?.close?.().catch(() => undefined);
      processor = null;
      source = null;
      sink = null;
      stream = null;
      audioContext = null;
      state.voiceArmed = false;
      patchVoiceState({
        status: "stopped",
        armed: false,
        stoppedAt: new Date().toISOString(),
        stopReason: reason,
      });
      options.sendOperatorEvent?.({
        type: "operator_mic_disarmed",
        reason,
        armed: false,
        muted: state.voiceMuted,
        capture: state.voiceCapture,
        localVad: state.voiceLocalVad,
      });
      return { ok: true, reason };
    }

    function setMuted(muted) {
      state.voiceMuted = Boolean(muted);
      patchVoiceState({ muted: state.voiceMuted, armed: state.voiceArmed });
      options.sendOperatorEvent?.({
        type: "operator_mic_muted",
        armed: state.voiceArmed,
        muted: state.voiceMuted,
        capture: state.voiceCapture,
        localVad: state.voiceLocalVad,
      });
      return { ok: true, muted: state.voiceMuted };
    }

    return { sendChunk, startMicrophone, stopMicrophone, setMuted };
  }

  window.MAB_LAN_OPERATOR_AUDIO_CAPTURE = { create, pcm16Base64, sampleEnergy };
})();`;
}
