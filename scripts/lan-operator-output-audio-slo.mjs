function assistantAudio(report) {
  return (
    report?.output?.assistantAudio ||
    report?.debugReport?.debug?.output?.assistantAudio ||
    report?.runtimeStatus?.debug?.output?.assistantAudio ||
    {}
  );
}

export function assistantAudioPlaybackRequired(report) {
  const audio = assistantAudio(report);
  return (
    audio.enabled === true ||
    Boolean(report?.output?.assistantAudio || report?.debugReport || report?.runtimeStatus)
  );
}

export function assistantAudioPlaybackCount(report) {
  const audio = assistantAudio(report);
  const received = Number(audio.chunksReceivedDelta ?? audio.chunksReceived ?? 0);
  const played = Number(audio.chunksPlayedDelta ?? audio.chunksPlayed ?? 0);
  const bytes = Number(audio.bytesReceivedDelta ?? audio.bytesReceived ?? 0);
  const status = String(audio.status || "");
  return audio.enabled !== false &&
    received >= 1 &&
    played >= 1 &&
    bytes > 0 &&
    Number(audio.rms || 0) > 0 &&
    ["playing", "stopped"].includes(status)
    ? 1
    : 0;
}
