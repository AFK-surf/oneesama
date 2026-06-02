/* eslint-disable no-unused-vars */
function meetAudioInputGain() {
  return normalizeMeetAudioInputGain(
    state.connection.meetAudioInputGain || config.meetAudioInputGain,
  );
}

function configuredRecappiProcessInputGain() {
  return normalizeMeetAudioInputGain(
    (rawBridgeConfig as Record<string, unknown>).meetAudioInputGain,
    DEFAULT_RECAPPI_PROCESS_AUDIO_INPUT_GAIN,
  );
}

function updateRoutingInputGain(nextGain, reason = "") {
  const normalized = normalizeMeetAudioInputGain(nextGain, meetAudioInputGain());
  if (state.connection.meetAudioInputGain === normalized && routingInputGate) return;
  state.connection.meetAudioInputGain = normalized;
  if (routingInputGate) routingInputGate.gain.value = normalized;
  recordTimeline("meet_audio_input_gain_updated", { gain: normalized, reason });
}

function recappiProcessAudioConnected() {
  return (state.connection as any).recappiAudioInput?.connected === true;
}
