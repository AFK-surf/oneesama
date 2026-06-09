import {
  normalizeConversationTransport,
  type ConversationTransport,
} from "../avatar-runtime/contracts.ts";

export type LanOperatorConversationTransportSource =
  | "explicit_env"
  | "gemini_api_key"
  | "openai_api_key"
  | "runtime_provider_switch"
  | "default_openai_realtime";

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
  if (trimmed(env.ONEESAMA_OPENAI_API_KEY)) return "ONEESAMA_OPENAI_API_KEY";
  if (trimmed(env.MAB_OPENAI_API_KEY)) return "MAB_OPENAI_API_KEY";
  if (trimmed(env.OPENAI_API_KEY)) return "OPENAI_API_KEY";
  return "";
}

function geminiApiKeySource(env: Record<string, string | undefined>) {
  if (trimmed(env.ONEESAMA_GEMINI_API_KEY)) return "ONEESAMA_GEMINI_API_KEY";
  if (trimmed(env.MAB_GEMINI_API_KEY)) return "MAB_GEMINI_API_KEY";
  if (trimmed(env.GEMINI_API_KEY)) return "GEMINI_API_KEY";
  if (trimmed(env.GOOGLE_API_KEY)) return "GOOGLE_API_KEY";
  return "";
}

function apiKeySourceForTransport(
  env: Record<string, string | undefined>,
  transport: ConversationTransport,
) {
  if (transport === "gemini_live") return geminiApiKeySource(env);
  if (transport === "openai_realtime") return apiKeySource(env);
  return apiKeySource(env) || geminiApiKeySource(env);
}

export function resolveLanOperatorConversationTransport(
  env: Record<string, string | undefined> = process.env,
): LanOperatorConversationTransportSelection {
  const explicitTransport = trimmed(env.MAB_LAN_OPERATOR_TRANSPORT);
  if (explicitTransport) {
    const transport = normalizeConversationTransport(explicitTransport);
    const keySource = apiKeySourceForTransport(env, transport);
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
  const keySource = apiKeySource(env);
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
  const geminiKeySource = geminiApiKeySource(env);
  if (geminiKeySource) {
    return {
      schema: "oneesama.lan_operator_conversation_transport_selection.v1",
      transport: "gemini_live",
      source: "gemini_api_key",
      explicit: false,
      apiKeyConfigured: true,
      apiKeySource: geminiKeySource,
      diagnosticFallback: false,
      fallbackReason: "",
    };
  }
  return {
    schema: "oneesama.lan_operator_conversation_transport_selection.v1",
    transport: "openai_realtime",
    source: "default_openai_realtime",
    explicit: false,
    apiKeyConfigured: false,
    apiKeySource: "",
    diagnosticFallback: false,
    fallbackReason: "openai_realtime_api_key_missing",
  };
}
