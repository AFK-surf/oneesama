import {
  normalizeConversationTransport,
  type ConversationTransport,
} from "../avatar-runtime/contracts.ts";

export type LanOperatorConversationTransportSource =
  | "explicit_env"
  | "openai_api_key"
  | "diagnostic_missing_openai_key";

export interface LanOperatorConversationTransportSelection {
  schema: "oneesama.lan_operator_conversation_transport_selection.v1";
  transport: ConversationTransport;
  source: LanOperatorConversationTransportSource;
  explicit: boolean;
  apiKeyConfigured: boolean;
  apiKeySource: string;
  diagnosticFallback: boolean;
  fallbackReason: string;
}

function trimmed(value: unknown) {
  return String(value || "").trim();
}

function apiKeySource(env: Record<string, string | undefined>) {
  if (trimmed(env.MAB_OPENAI_API_KEY)) return "MAB_OPENAI_API_KEY";
  if (trimmed(env.OPENAI_API_KEY)) return "OPENAI_API_KEY";
  return "";
}

export function resolveLanOperatorConversationTransport(
  env: Record<string, string | undefined> = process.env,
): LanOperatorConversationTransportSelection {
  const explicitTransport = trimmed(env.MAB_LAN_OPERATOR_TRANSPORT);
  const keySource = apiKeySource(env);
  if (explicitTransport) {
    const transport = normalizeConversationTransport(explicitTransport);
    return {
      schema: "oneesama.lan_operator_conversation_transport_selection.v1",
      transport,
      source: "explicit_env",
      explicit: true,
      apiKeyConfigured: Boolean(keySource),
      apiKeySource: keySource,
      diagnosticFallback: false,
      fallbackReason: "",
    };
  }
  if (keySource) {
    return {
      schema: "oneesama.lan_operator_conversation_transport_selection.v1",
      transport: "openai_realtime",
      source: "openai_api_key",
      explicit: false,
      apiKeyConfigured: true,
      apiKeySource: keySource,
      diagnosticFallback: false,
      fallbackReason: "",
    };
  }
  return {
    schema: "oneesama.lan_operator_conversation_transport_selection.v1",
    transport: "mock",
    source: "diagnostic_missing_openai_key",
    explicit: false,
    apiKeyConfigured: false,
    apiKeySource: "",
    diagnosticFallback: true,
    fallbackReason: "openai_realtime_api_key_missing",
  };
}
