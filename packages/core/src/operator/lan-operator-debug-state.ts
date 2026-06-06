import type { CanonicalConversationEvent } from "./lan-operator-conversation-engine.ts";
import type { ConversationEngineControlType } from "./lan-operator-conversation-engine.ts";

export type VoiceStats = {
  websocketConnections: number;
  armed: boolean;
  muted: boolean;
  captureMode: string | null;
  captureStatus: string | null;
  captureError: string | null;
  permissionState: string | null;
  deviceId: string | null;
  deviceLabel: string | null;
  availableDeviceCount: number;
  activeStreamId: string | null;
  activeStreamGeneration: number;
  streamOpenCount: number;
  lastStreamOpenedAt: string | null;
  staleChunksRejected: number;
  lastRejectedStreamId: string | null;
  localVad: {
    enabled: boolean;
    role: "disabled" | "telemetry";
    active: boolean;
    threshold: number;
    lastEnergy: number | null;
    lastUpdatedAt: string | null;
  };
  chunksReceived: number;
  bytesReceived: number;
  dropsDetected: number;
  lastSequence: number | null;
  lastChunkAt: string | null;
  lastChunkSentAt: string | null;
  lastChunkReceivedAt: string | null;
  lastReceiveLagMs: number | null;
  maxReceiveLagMs: number | null;
  receiveLagClock: "client_wall_to_host_wall";
  ackCount: number;
  lastAckSequence: number | null;
  lastAckAt: string | null;
  lastAckRttMs: number | null;
  maxAckRttMs: number | null;
  ackClock: "client_send_to_ack_wall";
  lastEnergy: number | null;
  sampleRate: number | null;
  channels: number | null;
  durationMs: number | null;
  forwardedChunks: number;
  forwardFailures: number;
  forwardBackpressureDrops: number;
  forwardInFlight: number;
  lastForwardAt: string | null;
  lastForwardError: string | null;
};

export type CompositionState = {
  mode: "operator_side";
  localComposedTrack: boolean;
  localComposedStreamId: string | null;
  trackId: string | null;
  trackKind: string | null;
  trackReadyState: string | null;
  trackMuted: boolean;
  width: number;
  height: number;
  targetFps: number;
  renderedFrameCount: number;
  lastRenderedFrameAt: string | null;
  lastRenderedFrameAgeMs: number | null;
  layoutRevision: number;
  sourceRects: Record<string, { x: number; y: number; width: number; height: number }>;
  focusedSourceId: string | null;
  overlayCount: number;
};

export type VisualState = {
  transport: "webrtc";
  connectionState: "not_connected" | "connecting" | "connected" | "degraded";
  iceConnectionState: string | null;
  peerConnectionState: string | null;
  signalingState: string | null;
  receiverWebSocketState: "closed" | "connecting" | "open";
  hostPublisherConnections: number;
  trackCount: number;
  sources: Array<{
    id: string;
    label: string;
    kind: string;
    state: string;
    streamId?: string | null;
    trackId?: string | null;
    trackReadyState?: string | null;
    width?: number | null;
    height?: number | null;
    frameRate?: number | null;
    frameAgeMs?: number | null;
    lastFrameAt?: string | null;
    sourceMode?: string | null;
    captureStatus?: string | null;
    captureError?: string | null;
    captureAttemptCount?: number | null;
    captureLastAttemptAt?: string | null;
    captureLastSuccessAt?: string | null;
    captureLastErrorAt?: string | null;
    displaySurface?: string | null;
    trackLabel?: string | null;
    avatarRenderer?: string | null;
    avatarReady?: boolean | null;
  }>;
  composition: CompositionState;
};

export type OutputState = {
  assistantText: {
    deltaCount: number;
    completedCount: number;
    currentText: string;
    completedText: string;
    lastTextAt: string | null;
    lastResponseId: string | null;
  };
  assistantAudio: {
    enabled: boolean;
    status: "idle" | "playing" | "stopped" | "blocked" | "failed";
    chunksReceived: number;
    chunksPlayed: number;
    bytesReceived: number;
    sampleRate: number | null;
    channels: number | null;
    queuedMs: number;
    rms: number | null;
    peak: number | null;
    lastChunkAt: string | null;
    lastPlaybackAt: string | null;
    lastError: string | null;
  };
};

export type KwwkPhaseEvidence = {
  status: string | null;
  durationMs: number | null;
  summary: string | null;
  detail: Record<string, unknown>;
  lastUpdatedAt: string | null;
};

export type TransportConnectionState = {
  state: "closed" | "connecting" | "open" | "reconnecting" | "failed";
  connectCount: number;
  reconnectCount: number;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastPacketAt: string | null;
  lastError: string | null;
  rttMs: number | null;
  nextReconnectAt: string | null;
};

export type TransportState = {
  events: TransportConnectionState;
  voice: TransportConnectionState;
  visual: TransportConnectionState;
  hostVisual: TransportConnectionState;
};

export type DebugState = {
  transport: TransportState;
  surfaceContext: Record<string, unknown>;
  voice: VoiceStats;
  visual: VisualState;
  output: OutputState;
  toolRouting: {
    expectedTool: string | null;
    actualTool: string | null;
    callId: string | null;
    itemId: string | null;
    status:
      | "idle"
      | "started"
      | "streaming"
      | "completed"
      | "result_accepted"
      | "cancelled"
      | "failed";
    argumentsText: string;
    parsedArguments: Record<string, unknown> | null;
    functionOutputDelivered: boolean;
    functionOutput: Record<string, unknown> | string | null;
    argumentSafety: {
      naturalLanguageInstruction: boolean;
      safeTargetHint: boolean;
      exposesRawOperations: boolean;
      exposesCoordinates: boolean;
      ok: boolean;
    };
    lastUpdatedAt: string | null;
    cancel: {
      requestedCount: number;
      lastRequestedAt: string | null;
      lastCallId: string | null;
      lastJobId: string | null;
      lastReason: string | null;
      lastResult: "requested" | "delivered" | "failed" | null;
      lastError: string | null;
    };
    errors: Array<{ ts: string; error: string }>;
    calls: Array<{
      ts: string;
      event: string;
      expectedTool: string | null;
      actualTool: string | null;
      callId: string | null;
      itemId: string | null;
      status: string;
      argumentsText: string;
      functionOutputDelivered: boolean;
    }>;
  };
  kwwk: {
    currentJobId: string | null;
    status:
      | "idle"
      | "queued"
      | "observing"
      | "planning"
      | "executing"
      | "verifying"
      | "completed"
      | "cancelled"
      | "blocked"
      | "failed";
    target: Record<string, unknown>;
    blocker: string | null;
    latestActionKind: string | null;
    cursorEventCount: number;
    actionCount: number;
    timings: {
      observeMs: number | null;
      planMs: number | null;
      executeMs: number | null;
      verifyMs: number | null;
      totalMs: number | null;
    };
    verification: {
      schema: string | null;
      ok: boolean | null;
      status: string | null;
      reason: string | null;
      blocker: string | null;
      checkCount: number;
      failedCheckCount: number;
      checks: Array<{ name: string; passed: boolean | null }>;
      lastUpdatedAt: string | null;
    };
    phaseEvidence: {
      observe: KwwkPhaseEvidence;
      plan: KwwkPhaseEvidence;
      execute: KwwkPhaseEvidence;
      verify: KwwkPhaseEvidence;
    };
    lastUpdatedAt: string | null;
    actions: Array<{
      ts: string;
      kind: string;
      label: string;
      status: string;
      durationMs: number | null;
    }>;
  };
  artifacts: {
    reportCopyCount: number;
    reportDownloadCount: number;
    interestingMarks: Array<{ ts: string; label: string; note: string }>;
    largeArtifacts: Array<{
      ts: string;
      label: string;
      kind: string;
      href: string;
      bytes: number | null;
      contentType: string | null;
      reason: string;
      policy: "linked_only";
    }>;
    bundleCount: number;
    bundles: Array<{
      ts: string;
      id: string;
      label: string;
      href: string | null;
      entryCount: number;
      entries: Array<{
        id: string;
        kind: string;
        label: string;
        href: string | null;
        bytes: number | null;
        contentType: string | null;
        policy: "inline_report" | "linked_only" | "generated";
      }>;
    }>;
    lastReportAt: string | null;
    lastReportAction: "copy" | "download" | "mark" | "bundle" | null;
  };
  timeline: {
    currentTurnId: string | null;
    lastEventAt: string | null;
    turns: Array<{
      turnId: string;
      startedAt: string;
      lastEventAt: string;
      durationMs: number | null;
      status: "active" | "completed" | "blocked" | "failed";
      responseIds: string[];
      latestEvent: string;
      blocker: string | null;
      milestones: {
        heard: boolean;
        speechStarted: boolean;
        transcript: boolean;
        tool: boolean;
        kwwk: boolean;
        verification: boolean;
        output: boolean;
      };
      events: string[];
    }>;
    rows: Array<{
      id: string;
      at: string;
      layer:
        | "transport"
        | "audio_input"
        | "conversation_engine"
        | "tool_routing"
        | "kwwk"
        | "visual"
        | "output_audio"
        | "operator";
      event: string;
      ok: boolean;
      durationMs: number | null;
      turnId: string | null;
      responseId: string | null;
      blocker: string | null;
      detail: Record<string, unknown>;
    }>;
  };
  conversation: {
    engineId: string;
    status: "not_connected" | "connected" | "degraded" | "failed";
    control: {
      inFlight: number;
      commandCounts: Partial<Record<ConversationEngineControlType, number>>;
      lastCommand: ConversationEngineControlType | null;
      lastCommandAt: string | null;
      lastDetail: Record<string, unknown> | null;
      lastResult: string | null;
      lastError: string | null;
    };
    canonicalEvents: CanonicalConversationEvent[];
    eventCounts: Record<string, number>;
    provider: {
      adapterKind: string | null;
      rawEventDrilldownAvailable: boolean;
      latestProviderEventType: string | null;
      providerEventCounts: Record<string, number>;
      recentEvents: Array<{
        ts: string;
        provider: string;
        providerEventType: string;
        providerEventId: string | null;
        canonicalType: string;
        turnId: string | null;
        responseId: string | null;
        itemId: string | null;
        callId: string | null;
        toolName: string | null;
        status: string | null;
        reason: string | null;
        error: string | null;
        inputMode: string | null;
        itemType: string | null;
        detailKeys: string[];
        summary: string;
      }>;
    };
    lastEventAt: string | null;
    errors: Array<{ ts: string; error: string }>;
  };
};

export const DEFAULT_SOURCE_RECTS: CompositionState["sourceRects"] = {
  "host-app": { x: 0.04, y: 0.08, width: 0.7, height: 0.72 },
  avatar: { x: 0.72, y: 0.54, width: 0.22, height: 0.34 },
};

function defaultTransportConnectionState(): TransportConnectionState {
  return {
    state: "closed",
    connectCount: 0,
    reconnectCount: 0,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastPacketAt: null,
    lastError: null,
    rttMs: null,
    nextReconnectAt: null,
  };
}

export function defaultDebugState(): DebugState {
  return {
    transport: {
      events: defaultTransportConnectionState(),
      voice: defaultTransportConnectionState(),
      visual: defaultTransportConnectionState(),
      hostVisual: defaultTransportConnectionState(),
    },
    surfaceContext: {
      schema: "oneesama.lan_operator_surface_context.v1",
      updatedAt: null,
      surfaceKind: "lan_operator",
      trustedLanOperatorMode: true,
      lanModeExplicitlyEnabled: true,
    },
    voice: {
      websocketConnections: 0,
      armed: false,
      muted: false,
      captureMode: null,
      captureStatus: "idle",
      captureError: null,
      permissionState: null,
      deviceId: null,
      deviceLabel: null,
      availableDeviceCount: 0,
      activeStreamId: null,
      activeStreamGeneration: 0,
      streamOpenCount: 0,
      lastStreamOpenedAt: null,
      staleChunksRejected: 0,
      lastRejectedStreamId: null,
      localVad: {
        enabled: false,
        role: "disabled",
        active: false,
        threshold: 0.02,
        lastEnergy: null,
        lastUpdatedAt: null,
      },
      chunksReceived: 0,
      bytesReceived: 0,
      dropsDetected: 0,
      lastSequence: null,
      lastChunkAt: null,
      lastChunkSentAt: null,
      lastChunkReceivedAt: null,
      lastReceiveLagMs: null,
      maxReceiveLagMs: null,
      receiveLagClock: "client_wall_to_host_wall",
      ackCount: 0,
      lastAckSequence: null,
      lastAckAt: null,
      lastAckRttMs: null,
      maxAckRttMs: null,
      ackClock: "client_send_to_ack_wall",
      lastEnergy: null,
      sampleRate: null,
      channels: null,
      durationMs: null,
      forwardedChunks: 0,
      forwardFailures: 0,
      forwardBackpressureDrops: 0,
      forwardInFlight: 0,
      lastForwardAt: null,
      lastForwardError: null,
    },
    visual: {
      transport: "webrtc",
      connectionState: "not_connected",
      iceConnectionState: null,
      peerConnectionState: null,
      signalingState: null,
      receiverWebSocketState: "closed",
      hostPublisherConnections: 0,
      trackCount: 0,
      sources: [
        { id: "host-app", label: "Host app", kind: "desktop_app", state: "synthetic" },
        { id: "avatar", label: "Avatar", kind: "avatar", state: "synthetic" },
      ],
      composition: {
        mode: "operator_side",
        localComposedTrack: false,
        localComposedStreamId: null,
        trackId: null,
        trackKind: null,
        trackReadyState: null,
        trackMuted: false,
        width: 1280,
        height: 720,
        targetFps: 30,
        renderedFrameCount: 0,
        lastRenderedFrameAt: null,
        lastRenderedFrameAgeMs: null,
        layoutRevision: 0,
        sourceRects: DEFAULT_SOURCE_RECTS,
        focusedSourceId: "host-app",
        overlayCount: 0,
      },
    },
    output: {
      assistantText: {
        deltaCount: 0,
        completedCount: 0,
        currentText: "",
        completedText: "",
        lastTextAt: null,
        lastResponseId: null,
      },
      assistantAudio: {
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
      },
    },
    toolRouting: {
      expectedTool: null,
      actualTool: null,
      callId: null,
      itemId: null,
      status: "idle",
      argumentsText: "",
      parsedArguments: null,
      functionOutputDelivered: false,
      functionOutput: null,
      argumentSafety: {
        naturalLanguageInstruction: false,
        safeTargetHint: false,
        exposesRawOperations: false,
        exposesCoordinates: false,
        ok: false,
      },
      lastUpdatedAt: null,
      cancel: {
        requestedCount: 0,
        lastRequestedAt: null,
        lastCallId: null,
        lastJobId: null,
        lastReason: null,
        lastResult: null,
        lastError: null,
      },
      errors: [],
      calls: [],
    },
    kwwk: {
      currentJobId: null,
      status: "idle",
      target: {},
      blocker: null,
      latestActionKind: null,
      cursorEventCount: 0,
      actionCount: 0,
      timings: {
        observeMs: null,
        planMs: null,
        executeMs: null,
        verifyMs: null,
        totalMs: null,
      },
      verification: {
        schema: null,
        ok: null,
        status: null,
        reason: null,
        blocker: null,
        checkCount: 0,
        failedCheckCount: 0,
        checks: [],
        lastUpdatedAt: null,
      },
      phaseEvidence: {
        observe: defaultKwwkPhaseEvidence(),
        plan: defaultKwwkPhaseEvidence(),
        execute: defaultKwwkPhaseEvidence(),
        verify: defaultKwwkPhaseEvidence(),
      },
      lastUpdatedAt: null,
      actions: [],
    },
    artifacts: {
      reportCopyCount: 0,
      reportDownloadCount: 0,
      interestingMarks: [],
      largeArtifacts: [],
      bundleCount: 0,
      bundles: [],
      lastReportAt: null,
      lastReportAction: null,
    },
    timeline: {
      currentTurnId: null,
      lastEventAt: null,
      turns: [],
      rows: [],
    },
    conversation: {
      engineId: "",
      status: "not_connected",
      control: {
        inFlight: 0,
        commandCounts: {},
        lastCommand: null,
        lastCommandAt: null,
        lastDetail: null,
        lastResult: null,
        lastError: null,
      },
      canonicalEvents: [],
      eventCounts: {},
      provider: {
        adapterKind: null,
        rawEventDrilldownAvailable: false,
        latestProviderEventType: null,
        providerEventCounts: {},
        recentEvents: [],
      },
      lastEventAt: null,
      errors: [],
    },
  };
}

function defaultKwwkPhaseEvidence(): KwwkPhaseEvidence {
  return {
    status: null,
    durationMs: null,
    summary: null,
    detail: {},
    lastUpdatedAt: null,
  };
}
