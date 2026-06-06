import type { AvatarRuntimeSessionConfig } from "../avatar-runtime/contracts.ts";
import type { DebugState } from "./lan-operator-debug-state.ts";

export function buildLanOperatorSurfaceContext(
  config: Readonly<AvatarRuntimeSessionConfig>,
  debug: DebugState,
  clientContext: Record<string, unknown> = {},
) {
  const focusedSourceId = debug.visual.composition.focusedSourceId || "host-app";
  const selectedSource =
    debug.visual.sources.find((source) => source.id === focusedSourceId) || null;
  const trustedLanOperatorMode = debug.surfaceContext.trustedLanOperatorMode ?? true;
  const lanModeExplicitlyEnabled = debug.surfaceContext.lanModeExplicitlyEnabled ?? true;
  const lanPeerEvidence = debug.surfaceContext.lanPeerEvidence || null;
  const lanReachability = debug.surfaceContext.lanReachability || null;
  const conversationTransportSelection =
    debug.surfaceContext.conversationTransportSelection || null;
  const renderer = (config.renderer || {}) as { webrtcIceServers?: unknown };
  const webrtcIceServers = Array.isArray(renderer.webrtcIceServers)
    ? renderer.webrtcIceServers
    : [];
  return {
    schema: "oneesama.lan_operator_surface_context.v1",
    updatedAt: new Date().toISOString(),
    surfaceKind: config.surfaceKind,
    sessionId: config.sessionId,
    trustedLanOperatorMode,
    lanModeExplicitlyEnabled,
    operatorMode: {
      voiceMode: config.conversation.mode,
      conversationTransport: config.conversationTransport,
      localVadEnabled: debug.voice.localVad.enabled,
      voiceArmed: debug.voice.armed,
      voiceMuted: debug.voice.muted,
    },
    selectedSource: selectedSource
      ? {
          id: selectedSource.id,
          label: selectedSource.label,
          kind: selectedSource.kind,
          state: selectedSource.state,
          trackId: selectedSource.trackId || null,
          frameAgeMs: selectedSource.frameAgeMs ?? null,
          frameRate: selectedSource.frameRate ?? null,
          sourceMode: selectedSource.sourceMode || null,
          captureStatus: selectedSource.captureStatus || null,
          captureError: selectedSource.captureError || null,
          captureAttemptCount: selectedSource.captureAttemptCount ?? null,
          displaySurface: selectedSource.displaySurface || null,
          avatarRenderer: selectedSource.avatarRenderer || null,
        }
      : null,
    visual: {
      transport: debug.visual.transport,
      connectionState: debug.visual.connectionState,
      receiverWebSocketState: debug.visual.receiverWebSocketState,
      hostPublisherConnections: debug.visual.hostPublisherConnections,
      trackCount: debug.visual.trackCount,
      focusedSourceId,
      sourceCount: debug.visual.sources.length,
      iceServerCount: webrtcIceServers.length,
    },
    composition: {
      mode: debug.visual.composition.mode,
      localComposedTrack: debug.visual.composition.localComposedTrack,
      trackId: debug.visual.composition.trackId,
      trackReadyState: debug.visual.composition.trackReadyState,
      width: debug.visual.composition.width,
      height: debug.visual.composition.height,
      targetFps: debug.visual.composition.targetFps,
      layoutRevision: debug.visual.composition.layoutRevision,
      sourceRects: debug.visual.composition.sourceRects,
      overlayCount: debug.visual.composition.overlayCount,
    },
    lanReachability,
    lanPeerEvidence,
    conversationTransportSelection,
    clientContext,
  };
}
