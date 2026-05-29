/* eslint-disable no-unused-vars */
function emptyRealtimeValidationCheckpoints() {
  return {
    lastCheckpoint: null as null | Record<string, unknown>,
    lastConnectionCleanup: null as null | Record<string, unknown>,
    lastInputSpeechStarted: null as null | Record<string, unknown>,
    lastOutputAudioCleared: null as null | Record<string, unknown>,
    lastOutputAudioDelta: null as null | Record<string, unknown>,
    lastOutputAudioStarted: null as null | Record<string, unknown>,
    lastOutputAudioStopped: null as null | Record<string, unknown>,
    lastReconnectScheduled: null as null | Record<string, unknown>,
    lastRemoteAudioRoute: null as null | Record<string, unknown>,
    lastResponseCreated: null as null | Record<string, unknown>,
    lastSessionCreated: null as null | Record<string, unknown>,
  };
}

function realtimeValidationCheckpoints() {
  if (!state.connection.validationCheckpoints) {
    state.connection.validationCheckpoints = emptyRealtimeValidationCheckpoints();
  }
  return state.connection.validationCheckpoints as Record<string, unknown>;
}

state.connection.validationCheckpoints = emptyRealtimeValidationCheckpoints();

function rememberRealtimeValidationCheckpoint(
  key: string,
  type: string,
  detail: Record<string, unknown> = {},
  ts = new Date().toISOString(),
) {
  const checkpoint = {
    ts,
    type,
    detail: {
      ...detail,
      session_id: String(detail.session_id || state.sessionId || config.sessionId || ""),
    },
  };
  const checkpoints = realtimeValidationCheckpoints();
  checkpoints.lastCheckpoint = checkpoint;
  checkpoints[key] = checkpoint;
  return checkpoint;
}

function rememberTimelineValidationCheckpoint(entry: {
  ts: string;
  type: string;
  detail: Record<string, unknown>;
}) {
  const keyByType: Record<string, string> = {
    realtime_connection_cleanup: "lastConnectionCleanup",
    realtime_output_audio_cleared: "lastOutputAudioCleared",
    realtime_reconnect_scheduled: "lastReconnectScheduled",
    remote_audio_route: "lastRemoteAudioRoute",
  };
  const key = keyByType[entry.type];
  if (key) rememberRealtimeValidationCheckpoint(key, entry.type, entry.detail, entry.ts);
}
