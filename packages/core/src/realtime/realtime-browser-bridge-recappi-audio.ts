/* eslint-disable no-unused-vars */
const recappiConnection = state.connection as Record<string, any>;
recappiConnection.recappiAudioInput = recappiConnection.recappiAudioInput || {
  enabled: config.meetAudioInputSource === "recappi_process_audio",
  connected: false,
  sampleRate: 0,
  channels: 0,
  chunks: 0,
  samplesReceived: 0,
  samplesQueued: 0,
  samplesDropped: 0,
  noiseSuppressedChunks: 0,
  noiseSuppressedSamples: 0,
  lastSuppressedRms: 0,
  lastSuppressedReason: "",
  underflows: 0,
  lastChunkAt: "",
  lastPushAt: "",
  source: "",
};

function getRecappiAudioInputState() {
  return recappiConnection.recappiAudioInput;
}

let recappiAudioInputProcessor = null;
let recappiAudioInputSource = null;
const recappiAudioInputQueue = [];
let recappiAudioQueuedSamples = 0;

function markRecappiAudioInputConnected(payload: Record<string, unknown> = {}) {
  const source = String(payload.source || "recappi_process_audio");
  const label =
    source === "recappi_global_audio"
      ? "Recappi global system audio"
      : "Recappi Chrome process audio";
  if (source === "recappi_process_audio") {
    updateRoutingInputGain(configuredRecappiProcessInputGain(), "recappi-process-audio-connected");
    let disconnectedFallbackSources = 0;
    for (const entry of routedMeetAudioSources || []) {
      if (entry.connected === true) {
        disconnectedFallbackSources += disconnectMeetAudioSource(
          entry,
          "recappi-process-audio-connected",
        )
          ? 1
          : 0;
      }
    }
    if (disconnectedFallbackSources > 0 || state.connection.recappiReceiverFallbackActive) {
      state.connection.recappiReceiverFallbackActive = false;
      state.connection.recappiReceiverFallbackDisconnectedAt = new Date().toISOString();
      recordTimeline("meet_audio_receiver_fallback_disconnected", {
        reason: "recappi_process_audio_connected",
        disconnectedSources: disconnectedFallbackSources,
      });
    }
  }
  recappiConnection.recappiAudioInput = {
    ...getRecappiAudioInputState(),
    enabled: true,
    connected: true,
    sampleRate: Number(payload.sampleRate || getRecappiAudioInputState()?.sampleRate || 0),
    channels: Number(payload.channels || getRecappiAudioInputState()?.channels || 0),
    source,
  };
  state.connection.meetAudioTracksForwarded = Math.max(
    1,
    Number(state.connection.meetAudioTracksForwarded || 0),
  );
  state.connection.meetAudioSourcesActive = Math.max(
    1,
    Number(state.connection.meetAudioSourcesActive || 0),
  );
  state.connection.meetAudioSourcesUnmuted = Math.max(
    1,
    Number(state.connection.meetAudioSourcesUnmuted || 0),
  );
  state.connection.meetAudioTrackStates = [
    ...(state.connection.meetAudioTrackStates || []).filter(
      (entry) => !["recappi_process_audio", "recappi_global_audio"].includes(entry.source),
    ),
    {
      trackId: "recappi-process-audio",
      readyState: "live",
      enabled: true,
      muted: false,
      connected: true,
      disconnectReason: "",
      source,
      label,
    },
  ].slice(-10);
  if (routingDestination) {
    const [mixedTrack] = routingDestination.stream.getAudioTracks();
    rememberRealtimeInputTrack("recappi_process_audio_tap", mixedTrack, {
      lastRealtimeInputReplaceReason: "recappi-process-audio",
      lastRealtimeInputReplaceAt: new Date().toISOString(),
    });
  }
  refreshMeetAudioTrackStates();
}

function fillRecappiAudioOutput(output: Float32Array) {
  let offset = 0;
  while (offset < output.length) {
    const head = recappiAudioInputQueue[0];
    if (!head || !head.length) {
      output.fill(0, offset);
      getRecappiAudioInputState().underflows += 1;
      return;
    }
    const take = Math.min(head.length, output.length - offset);
    output.set(head.subarray(0, take), offset);
    offset += take;
    if (take === head.length) {
      recappiAudioInputQueue.shift();
    } else {
      recappiAudioInputQueue[0] = head.subarray(take);
    }
    recappiAudioQueuedSamples = Math.max(0, recappiAudioQueuedSamples - take);
  }
}

function ensureRecappiAudioInputNode(payload: Record<string, unknown> = {}) {
  ensureMeetAudioRoutingContext();
  if (recappiAudioInputProcessor) return;
  recappiAudioInputProcessor = routingAudioContext.createScriptProcessor(4096, 1, 1);
  recappiAudioInputProcessor.onaudioprocess = (event) => {
    fillRecappiAudioOutput(event.outputBuffer.getChannelData(0));
  };
  recappiAudioInputSource = routingAudioContext.createConstantSource();
  recappiAudioInputSource.offset.value = 0;
  recappiAudioInputSource.connect(recappiAudioInputProcessor);
  recappiAudioInputProcessor.connect(routingInputGate);
  recappiAudioInputSource.start();
  markRecappiAudioInputConnected(payload);
  recordTimeline("recappi_audio_input_connected", {
    sampleRate: Number(payload.sampleRate || 0),
    channels: Number(payload.channels || 0),
    source: String(payload.source || "recappi_process_audio"),
  });
}

function downmixRecappiSamples(samples: number[], channels: unknown) {
  const channelCount = Math.max(1, Number(channels || 1));
  if (channelCount === 1) return Float32Array.from(samples, (sample) => Number(sample || 0));
  const frames = Math.floor(samples.length / channelCount);
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      sum += Number(samples[frame * channelCount + channel] || 0);
    }
    mono[frame] = sum / channelCount;
  }
  return mono;
}

function resampleRecappiSamples(monoSamples: Float32Array, sourceRate: number, targetRate: number) {
  const inputRate = Number(sourceRate || targetRate || 48000);
  const outputRate = Number(targetRate || inputRate || 48000);
  if (!monoSamples.length || Math.abs(inputRate - outputRate) < 1) return monoSamples;
  const outputLength = Math.max(1, Math.round((monoSamples.length * outputRate) / inputRate));
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index += 1) {
    output[index] = monoSamples[Math.min(monoSamples.length - 1, Math.floor(index * ratio))] || 0;
  }
  return output;
}

function normalizeRecappiSamples(value: unknown) {
  if (Array.isArray(value)) return value as number[];
  const arrayLike = value as any;
  if (ArrayBuffer.isView(value) && typeof arrayLike.length === "number") {
    return Array.from(arrayLike as ArrayLike<number>, (sample) => Number(sample || 0));
  }
  if (value && typeof value === "object" && typeof arrayLike.length === "number") {
    return Array.from(arrayLike as ArrayLike<number>, (sample) => Number(sample || 0));
  }
  return [];
}

function pushRecappiAudioSamples(payload: Record<string, unknown> = {}) {
  if (config.meetAudioInputSource !== "recappi_process_audio") {
    return { ok: false, error: "recappi_audio_input_disabled" };
  }
  if (String(payload.source || "") === "recappi_global_audio") {
    return { ok: false, error: "recappi_global_audio_rejected" };
  }
  const samples = normalizeRecappiSamples(payload.samples);
  if (!samples.length) return { ok: false, error: "empty_recappi_audio_samples" };
  ensureRecappiAudioInputNode(payload);
  const mono = downmixRecappiSamples(samples, payload.channels);
  const queued = resampleRecappiSamples(
    mono,
    Number(payload.sampleRate || 0),
    routingAudioContext.sampleRate,
  );
  const maxQueuedSamples = routingAudioContext.sampleRate * 2;
  if (recappiAudioQueuedSamples + queued.length > maxQueuedSamples) {
    const drop = recappiAudioQueuedSamples + queued.length - maxQueuedSamples;
    let remaining = drop;
    while (remaining > 0 && recappiAudioInputQueue.length) {
      const head = recappiAudioInputQueue[0];
      if (head.length <= remaining) {
        remaining -= head.length;
        recappiAudioInputQueue.shift();
      } else {
        recappiAudioInputQueue[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
    recappiAudioQueuedSamples = Math.max(0, recappiAudioQueuedSamples - drop);
    getRecappiAudioInputState().samplesDropped += drop;
  }
  recappiAudioInputQueue.push(queued);
  recappiAudioQueuedSamples += queued.length;
  markRecappiAudioInputConnected(payload);
  recappiConnection.recappiAudioInput = {
    ...getRecappiAudioInputState(),
    chunks: Number(getRecappiAudioInputState()?.chunks || 0) + 1,
    samplesReceived: Number(getRecappiAudioInputState()?.samplesReceived || 0) + samples.length,
    samplesQueued: recappiAudioQueuedSamples,
    lastChunkAt: new Date().toISOString(),
    lastPushAt: new Date().toISOString(),
  };
  updateFeedback();
  return {
    ok: true,
    source: String(payload.source || "recappi_process_audio"),
    queuedSamples: recappiAudioQueuedSamples,
    chunks: getRecappiAudioInputState().chunks,
  };
}
