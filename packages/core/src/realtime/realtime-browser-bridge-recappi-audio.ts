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
  lastRawRms: 0,
  lastRawPeak: 0,
  adaptiveGain: 0,
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

const RECAPPI_PROCESS_AUDIO_TARGET_RMS = 0.025;
const RECAPPI_PROCESS_AUDIO_BOOST_BELOW_RMS = 0.01;
const RECAPPI_PROCESS_AUDIO_MAX_ADAPTIVE_GAIN = 48;
const RECAPPI_PROCESS_AUDIO_PEAK_CEILING = 0.8;

function rawMeetAudioInputGainConfigured() {
  return (rawBridgeConfig as Record<string, unknown>).meetAudioInputGain !== undefined;
}

function sampleEnergy(samples: Float32Array) {
  let sumSquares = 0;
  let peak = 0;
  for (const sample of samples) {
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sumSquares += sample * sample;
  }
  const rms = samples.length ? Math.sqrt(sumSquares / samples.length) : 0;
  return { rms, peak };
}

function adaptiveRecappiProcessInputGain(samples: Float32Array) {
  const configured = configuredRecappiProcessInputGain();
  const energy = sampleEnergy(samples);
  if (rawMeetAudioInputGainConfigured() || !samples.length || energy.rms <= 0) {
    return { gain: configured, ...energy, adaptive: false };
  }
  if (energy.rms >= RECAPPI_PROCESS_AUDIO_BOOST_BELOW_RMS) {
    return { gain: configured, ...energy, adaptive: false };
  }
  const rmsGain = RECAPPI_PROCESS_AUDIO_TARGET_RMS / Math.max(energy.rms, 0.000001);
  const peakGain =
    energy.peak > 0
      ? RECAPPI_PROCESS_AUDIO_PEAK_CEILING / energy.peak
      : RECAPPI_PROCESS_AUDIO_MAX_ADAPTIVE_GAIN;
  const gain = normalizeMeetAudioInputGain(
    Math.max(configured, Math.min(rmsGain, peakGain, RECAPPI_PROCESS_AUDIO_MAX_ADAPTIVE_GAIN)),
    configured,
  );
  return { gain, ...energy, adaptive: gain !== configured };
}

function markRecappiAudioInputConnected(payload: Record<string, unknown> = {}) {
  const source = String(payload.source || "recappi_process_audio");
  const inputDescriptor =
    source === "host_meet_audio_pcm"
      ? {
          trackId: "host-meet-audio-pcm",
          label: "Host-forwarded Meet surface PCM",
          realtimeInputSource: "host_meet_audio_pcm",
          replaceReason: "host-meet-audio-pcm",
        }
      : {
          trackId: "recappi-process-audio",
          label:
            source === "recappi_global_audio"
              ? "Recappi global system audio"
              : "Recappi Chrome process audio",
          realtimeInputSource: "recappi_process_audio_tap",
          replaceReason: "recappi-process-audio",
        };
  if (source === "recappi_process_audio" || source === "host_meet_audio_pcm") {
    const inputGain =
      source === "host_meet_audio_pcm"
        ? normalizeMeetAudioInputGain(config.meetAudioInputGain, DEFAULT_MEET_AUDIO_INPUT_GAIN)
        : configuredRecappiProcessInputGain();
    updateRoutingInputGain(inputGain, `${source.replace(/_/g, "-")}-connected`);
    let disconnectedFallbackSources = 0;
    for (const entry of routedMeetAudioSources || []) {
      if (entry.connected === true) {
        disconnectedFallbackSources += disconnectMeetAudioSource(entry, `${source}-connected`)
          ? 1
          : 0;
      }
    }
    if (disconnectedFallbackSources > 0) {
      recordTimeline("meet_audio_receiver_diagnostic_disconnected", {
        reason: `${source}_connected`,
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
  if (source === "host_meet_audio_pcm") {
    recappiConnection.hostMeetAudioInput = {
      ...recappiConnection.hostMeetAudioInput,
      enabled: true,
      connected: true,
      sampleRate: Number(
        payload.sampleRate || recappiConnection.hostMeetAudioInput?.sampleRate || 0,
      ),
      channels: Number(payload.channels || recappiConnection.hostMeetAudioInput?.channels || 0),
      source,
    };
  }
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
      (entry) =>
        !["recappi_process_audio", "recappi_global_audio", "host_meet_audio_pcm"].includes(
          entry.source,
        ),
    ),
    {
      trackId: inputDescriptor.trackId,
      readyState: "live",
      enabled: true,
      muted: false,
      connected: true,
      disconnectReason: "",
      source,
      label: inputDescriptor.label,
    },
  ].slice(-10);
  if (routingDestination) {
    const [mixedTrack] = routingDestination.stream.getAudioTracks();
    rememberRealtimeInputTrack(inputDescriptor.realtimeInputSource, mixedTrack, {
      lastRealtimeInputReplaceReason: inputDescriptor.replaceReason,
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
  const source = String(payload.source || "recappi_process_audio");
  recordTimeline(
    source === "host_meet_audio_pcm"
      ? "host_meet_audio_input_connected"
      : "recappi_audio_input_connected",
    {
      sampleRate: Number(payload.sampleRate || 0),
      channels: Number(payload.channels || 0),
      source,
    },
  );
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

function rememberHostMeetAudioParticipantSource(payload: Record<string, unknown>) {
  const label = String(payload.label || "host-meet-audio");
  const streamId = String(payload.streamId || "");
  const trackIds = Array.isArray(payload.trackIds)
    ? payload.trackIds.map((trackId) => String(trackId || "")).filter(Boolean)
    : [];
  const knownParticipantSource = state.connection.participantAudioSources.some(
    (source) =>
      (streamId && source.streamId === streamId) ||
      (!streamId && source.label === label && source.source === "host_meet_audio_pcm"),
  );
  if (!knownParticipantSource) {
    state.connection.participantAudioTracksDiscovered += Math.max(1, trackIds.length || 1);
    state.connection.participantAudioSources.push({
      ts: new Date().toISOString(),
      label,
      streamId,
      trackIds,
      source: "host_meet_audio_pcm",
    });
    state.connection.participantAudioSources = state.connection.participantAudioSources.slice(-20);
    recordTimeline("participant_audio_discovered", {
      forwardingEnabled: state.connection.participantAudioForwardingEnabled === true,
      meetAudioForwardingEnabled: state.connection.meetAudioForwardingEnabled === true,
      label,
      streamId,
      trackIds,
      source: "host_meet_audio_pcm",
      metadataOnly: Boolean(payload.metadataOnly),
    });
  }
  return { label, streamId, trackIds };
}

function pushExternalMeetAudioSamples(payload: Record<string, unknown> = {}) {
  const source = String(payload.source || "recappi_process_audio");
  const samples = normalizeRecappiSamples(payload.samples);
  const metadataOnly = source === "host_meet_audio_pcm" && payload.metadataOnly === true;
  if (source === "host_meet_audio_pcm") {
    rememberHostMeetAudioParticipantSource(payload);
  }
  if (!samples.length) {
    if (metadataOnly) {
      recappiConnection.hostMeetAudioInput = {
        ...recappiConnection.hostMeetAudioInput,
        enabled: true,
        sampleRate: Number(
          payload.sampleRate || recappiConnection.hostMeetAudioInput?.sampleRate || 0,
        ),
        channels: Number(payload.channels || recappiConnection.hostMeetAudioInput?.channels || 0),
        source: "host_meet_audio_pcm",
      };
      updateFeedback();
      return {
        ok: true,
        source,
        metadataOnly: true,
        participantAudioTracksDiscovered: state.connection.participantAudioTracksDiscovered,
      };
    }
    return {
      ok: false,
      error:
        source === "host_meet_audio_pcm"
          ? "empty_host_meet_audio_samples"
          : "empty_recappi_audio_samples",
    };
  }
  ensureRecappiAudioInputNode(payload);
  const mono = downmixRecappiSamples(samples, payload.channels);
  const queued = resampleRecappiSamples(
    mono,
    Number(payload.sampleRate || 0),
    routingAudioContext.sampleRate,
  );
  const gain = adaptiveRecappiProcessInputGain(queued);
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
  updateRoutingInputGain(
    gain.gain,
    gain.adaptive ? `${source.replace(/_/g, "-")}-adaptive-gain` : source.replace(/_/g, "-"),
  );
  recappiConnection.recappiAudioInput = {
    ...getRecappiAudioInputState(),
    chunks: Number(getRecappiAudioInputState()?.chunks || 0) + 1,
    samplesReceived: Number(getRecappiAudioInputState()?.samplesReceived || 0) + samples.length,
    samplesQueued: recappiAudioQueuedSamples,
    lastRawRms: gain.rms,
    lastRawPeak: gain.peak,
    adaptiveGain: gain.gain,
    lastChunkAt: new Date().toISOString(),
    lastPushAt: new Date().toISOString(),
  };
  if (String(payload.source || "") === "host_meet_audio_pcm") {
    recappiConnection.hostMeetAudioInput = {
      ...recappiConnection.hostMeetAudioInput,
      enabled: true,
      connected: true,
      chunks: Number(recappiConnection.hostMeetAudioInput?.chunks || 0) + 1,
      samplesReceived:
        Number(recappiConnection.hostMeetAudioInput?.samplesReceived || 0) + samples.length,
      samplesQueued: recappiAudioQueuedSamples,
      lastRawRms: gain.rms,
      lastRawPeak: gain.peak,
      lastChunkAt: new Date().toISOString(),
      lastPushAt: new Date().toISOString(),
      source: "host_meet_audio_pcm",
    };
  }
  updateFeedback();
  return {
    ok: true,
    source,
    queuedSamples: recappiAudioQueuedSamples,
    chunks: getRecappiAudioInputState().chunks,
  };
}

function pushRecappiAudioSamples(payload: Record<string, unknown> = {}) {
  if (config.meetAudioInputSource !== "recappi_process_audio") {
    return { ok: false, error: "recappi_audio_input_disabled" };
  }
  if (String(payload.source || "") === "recappi_global_audio") {
    return { ok: false, error: "recappi_global_audio_rejected" };
  }
  return pushExternalMeetAudioSamples({
    ...payload,
    source: payload.source || "recappi_process_audio",
  });
}

function pushHostMeetAudioSamples(payload: Record<string, unknown> = {}) {
  if (config.allowHostMeetAudioPcmInput !== true) {
    return { ok: false, error: "host_meet_audio_pcm_input_disabled" };
  }
  return pushExternalMeetAudioSamples({
    ...payload,
    source: "host_meet_audio_pcm",
  });
}
