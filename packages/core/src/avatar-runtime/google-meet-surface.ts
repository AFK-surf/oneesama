import {
  validateRuntimeSessionConfig,
  type AvatarRuntimeSessionConfig,
  type RuntimeEvent,
  type SurfaceCapability,
} from "./contracts.ts";
import { inferConversationTransportFromRealtimeMode } from "./runtime-init-builder.ts";

export interface GoogleMeetRuntimeSessionConfigOptions {
  sessionId: string;
  botName: string;
  conversationTransport: AvatarRuntimeSessionConfig["conversationTransport"];
  installAvatar: boolean;
  installRealtimeBridge: boolean;
  installLocalDialogBridge: boolean;
  installScreenShareBridge: boolean;
  installWorkerResultBridge: boolean;
}

export interface GoogleMeetRuntimeValidationOptions extends Omit<
  GoogleMeetRuntimeSessionConfigOptions,
  "conversationTransport"
> {
  realtimeBridgeMode: string;
}

export interface GoogleMeetRuntimeValidationResult {
  ok: boolean;
  config?: Readonly<AvatarRuntimeSessionConfig>;
  errors: string[];
  events: RuntimeEvent[];
  failure?: {
    ok: false;
    error: string;
    sessionId: string;
    runtimeSessionValidation: GoogleMeetRuntimeValidationResult["summary"];
  };
  summary: {
    ok: boolean;
    errors: string[];
    events: RuntimeEvent[];
  };
}

export function buildGoogleMeetRuntimeSessionConfig({
  sessionId,
  botName,
  conversationTransport,
  installAvatar,
  installRealtimeBridge,
  installLocalDialogBridge,
  installScreenShareBridge,
  installWorkerResultBridge,
}: GoogleMeetRuntimeSessionConfigOptions): AvatarRuntimeSessionConfig {
  const capabilities: SurfaceCapability[] = [];
  if (installAvatar) {
    capabilities.push({
      name: "meet_avatar_media",
      toolName: "meet_avatar_media",
      description: "Avatar camera and fake microphone tracks sent into Google Meet",
      surfaceOnly: true,
      enabled: true,
    });
  }
  if (installRealtimeBridge) {
    capabilities.push({
      name: "meet_realtime_conversation",
      toolName: "meet_realtime_conversation",
      description: "Google Meet remote audio and text context routed to Realtime",
      enabled: true,
    });
  }
  if (installLocalDialogBridge) {
    capabilities.push({
      name: "meet_local_dialog",
      toolName: "meet_local_dialog",
      description: "Local dialog acceptance bridge for fixture and operator text turns",
      surfaceOnly: true,
      enabled: true,
    });
  }
  if (installScreenShareBridge) {
    capabilities.push({
      name: "meet_screen_share",
      toolName: "meet_screen_share",
      description: "Synthetic or captured screen-share surface for Google Meet",
      surfaceOnly: true,
      enabled: true,
    });
  }
  if (installWorkerResultBridge) {
    capabilities.push({
      name: "worker_result_bridge",
      toolName: "worker_result_bridge",
      description: "Worker-result polling bridge owned by the runtime engine",
      enabled: true,
    });
  }

  return {
    sessionId,
    botName,
    surfaceKind: "google_meet",
    conversationTransport,
    renderer: {
      surface: "google_meet",
    },
    conversation: {
      mode: installRealtimeBridge ? "realtime" : "surface_only",
    },
    inputPolicy: {
      audioInputs: installRealtimeBridge ? ["meet_remote_audio"] : ["none"],
      // Caption/event observations may help identify the active speaker. They
      // must not become transcript text, ASR, or Realtime user input.
      textInputs: installRealtimeBridge ? ["meet_chat", "worker_internal"] : ["worker_internal"],
      continuousMic: false,
    },
    outputPolicy: {
      audioOutputs: installAvatar ? ["meet_sender"] : ["none"],
      videoOutputs: installScreenShareBridge
        ? ["meet_camera", "capture_track"]
        : installAvatar
          ? ["meet_camera"]
          : ["none"],
      allowLocalSpeaker: false,
    },
    capabilities,
    diagnostics: {
      eventLogEnabled: true,
      defaultStatusView: "diagnostic",
      retainTraceArtifacts: false,
      redactByDefault: true,
    },
  };
}

export function validateGoogleMeetRuntimeSessionConfig(
  options: GoogleMeetRuntimeValidationOptions,
): GoogleMeetRuntimeValidationResult {
  const validation = validateRuntimeSessionConfig(
    buildGoogleMeetRuntimeSessionConfig({
      ...options,
      conversationTransport: inferConversationTransportFromRealtimeMode(options.realtimeBridgeMode),
    }),
  );
  const result: GoogleMeetRuntimeValidationResult = {
    ok: validation.ok,
    config: validation.config,
    errors: validation.errors,
    events: validation.events,
    summary: {
      ok: validation.ok,
      errors: validation.errors,
      events: validation.events,
    },
  };
  if (!validation.ok) {
    result.failure = {
      ok: false,
      error: "runtime_session_config_invalid",
      sessionId: options.sessionId,
      runtimeSessionValidation: result.summary,
    };
  }
  return result;
}
