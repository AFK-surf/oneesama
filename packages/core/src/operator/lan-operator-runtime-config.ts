import { randomUUID } from "node:crypto";
import {
  defaultRuntimeDiagnosticsConfig,
  type AvatarRuntimeSessionConfig,
  type ConversationTransport,
} from "../avatar-runtime/contracts.ts";

export interface LanOperatorRuntimeConfigOptions {
  sessionId?: string;
  botName?: string;
  conversationTransport?: ConversationTransport;
  webrtcIceServers?: Array<Record<string, unknown>>;
}

function normalizedSessionId(value: string | undefined) {
  const trimmed = String(value || "").trim();
  return trimmed || `lan_operator_${randomUUID()}`;
}

function normalizeIceServer(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const urls = value.trim();
    return urls ? { urls } : null;
  }
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const urls = Array.isArray(input.urls)
    ? input.urls.map((item) => String(item || "").trim()).filter(Boolean)
    : String(input.urls || "").trim();
  if ((Array.isArray(urls) && urls.length === 0) || (!Array.isArray(urls) && !urls)) {
    return null;
  }
  const output: Record<string, unknown> = { urls };
  if (input.username != null) output.username = String(input.username);
  if (input.credential != null) output.credential = String(input.credential);
  if (input.credentialType != null) output.credentialType = String(input.credentialType);
  return output;
}

export function parseLanOperatorWebrtcIceServers(value: unknown): Array<Record<string, unknown>> {
  const raw = String(value || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const parsed = JSON.parse(raw) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map(normalizeIceServer).filter(Boolean) as Array<Record<string, unknown>>;
  }
  return raw
    .split(",")
    .map((item) => normalizeIceServer(item))
    .filter(Boolean) as Array<Record<string, unknown>>;
}

export function buildLanOperatorRuntimeSessionConfig(
  options: LanOperatorRuntimeConfigOptions = {},
): AvatarRuntimeSessionConfig {
  const sessionId = normalizedSessionId(options.sessionId);
  const botName = String(options.botName || "Oneesama").trim() || "Oneesama";
  return {
    sessionId,
    botName,
    surfaceKind: "lan_operator",
    conversationTransport: options.conversationTransport || "mock",
    renderer: {
      surface: "lan_operator",
      visualComposition: "operator_side",
      webrtcIceServers: options.webrtcIceServers || [],
    },
    conversation: {
      mode: "always_on_operator_voice",
      transport: options.conversationTransport || "mock",
    },
    inputPolicy: {
      audioInputs: ["local_mic"],
      textInputs: ["local_text"],
      continuousMic: true,
      pushToTalk: false,
      explicitLoopGuard: "headphones_required",
    },
    outputPolicy: {
      audioOutputs: ["local_speaker"],
      videoOutputs: ["dom_canvas", "capture_track"],
      allowLocalSpeaker: true,
    },
    capabilities: [
      {
        name: "operator_voice_input",
        description: "Always-on operator voice input over WebSocket PCM chunks",
        surfaceOnly: true,
        enabled: true,
      },
      {
        name: "host_visual_stream",
        description: "One-way host visual source tracks for operator context",
        surfaceOnly: true,
        enabled: true,
      },
      {
        name: "operator_visual_composition",
        description: "Operator-side movable canvas/video-track composition",
        surfaceOnly: true,
        enabled: true,
      },
      {
        name: "kwwk_visual_overlay",
        description: "Client-side KWWK cursor and action overlay rendering",
        surfaceOnly: true,
        enabled: true,
      },
      {
        name: "debug_panel",
        description: "Rich runtime diagnostics for voice, visual, tools, and events",
        surfaceOnly: true,
        enabled: true,
      },
    ],
    diagnostics: defaultRuntimeDiagnosticsConfig({
      defaultStatusView: "diagnostic",
      retainTraceArtifacts: true,
      redactByDefault: true,
    }),
  };
}
