import type { DebugState } from "./lan-operator-debug-state.ts";

export function mergeHostVisualState(debug: DebugState, visual: Partial<DebugState["visual"]>) {
  debug.visual.connectionState = visual.connectionState || debug.visual.connectionState;
  debug.visual.iceConnectionState = visual.iceConnectionState ?? debug.visual.iceConnectionState;
  debug.visual.peerConnectionState = visual.peerConnectionState ?? debug.visual.peerConnectionState;
  debug.visual.signalingState = visual.signalingState ?? debug.visual.signalingState;
  debug.visual.receiverWebSocketState =
    visual.receiverWebSocketState || debug.visual.receiverWebSocketState;
  debug.visual.hostPublisherConnections = Number(
    visual.hostPublisherConnections ?? debug.visual.hostPublisherConnections,
  );
  debug.visual.trackCount = Number(visual.trackCount ?? debug.visual.trackCount);
  if (Array.isArray(visual.sources)) {
    debug.visual.sources = visual.sources.map((source) => ({
      id: String(source.id || ""),
      label: String(source.label || source.id || ""),
      kind: String(source.kind || ""),
      state: String(source.state || ""),
      streamId: source.streamId || null,
      trackId: source.trackId || null,
      trackReadyState: source.trackReadyState || null,
      width: Number(source.width) || null,
      height: Number(source.height) || null,
      frameRate: Number(source.frameRate) || null,
      frameAgeMs: Number(source.frameAgeMs) || null,
      lastFrameAt: source.lastFrameAt || null,
      sourceMode: source.sourceMode ? String(source.sourceMode) : null,
      captureStatus: source.captureStatus ? String(source.captureStatus) : null,
      captureError: source.captureError ? String(source.captureError) : null,
      captureAttemptCount:
        source.captureAttemptCount == null ? null : Number(source.captureAttemptCount) || 0,
      captureLastAttemptAt: source.captureLastAttemptAt
        ? String(source.captureLastAttemptAt)
        : null,
      captureLastSuccessAt: source.captureLastSuccessAt
        ? String(source.captureLastSuccessAt)
        : null,
      captureLastErrorAt: source.captureLastErrorAt ? String(source.captureLastErrorAt) : null,
      displaySurface: source.displaySurface ? String(source.displaySurface) : null,
      trackLabel: source.trackLabel ? String(source.trackLabel) : null,
      avatarRenderer: source.avatarRenderer ? String(source.avatarRenderer) : null,
      avatarPreset: source.avatarPreset ? String(source.avatarPreset) : null,
      requestedAvatarPreset: source.requestedAvatarPreset
        ? String(source.requestedAvatarPreset)
        : null,
      requestedAvatarRenderer: source.requestedAvatarRenderer
        ? String(source.requestedAvatarRenderer)
        : null,
      avatarFallbackReason: source.avatarFallbackReason
        ? String(source.avatarFallbackReason)
        : null,
      avatarReady: source.avatarReady == null ? null : Boolean(source.avatarReady),
    }));
  }
}

export function hostVisualRuntimeDetail(debug: DebugState) {
  return {
    connectionState: debug.visual.connectionState,
    iceConnectionState: debug.visual.iceConnectionState,
    peerConnectionState: debug.visual.peerConnectionState,
    signalingState: debug.visual.signalingState,
    receiverWebSocketState: debug.visual.receiverWebSocketState,
    hostPublisherConnections: debug.visual.hostPublisherConnections,
    trackCount: debug.visual.trackCount,
    sources: debug.visual.sources.map((source) => ({
      id: source.id,
      state: source.state,
      trackId: source.trackId,
      frameRate: source.frameRate,
      frameAgeMs: source.frameAgeMs,
      sourceMode: source.sourceMode,
      captureStatus: source.captureStatus,
      captureError: source.captureError,
      captureAttemptCount: source.captureAttemptCount,
      displaySurface: source.displaySurface,
      avatarRenderer: source.avatarRenderer,
      avatarPreset: source.avatarPreset,
      requestedAvatarPreset: source.requestedAvatarPreset,
      requestedAvatarRenderer: source.requestedAvatarRenderer,
      avatarFallbackReason: source.avatarFallbackReason,
    })),
  };
}

export function hostVisualStateSignature(debug: DebugState) {
  return JSON.stringify(hostVisualRuntimeDetail(debug));
}
