import type { ConversationTransport } from "../avatar-runtime/contracts.ts";
import type { LanOperatorConversationTransportSelection } from "./lan-operator-conversation-transport.ts";

export interface LanOperatorLiveProviderEntry {
  transport: "openai_realtime" | "gemini_live";
  label: string;
  selected: boolean;
  keyConfigured: boolean;
  keySource: string;
  acceptedKeyEnv: string[];
  model: string;
  modelSource: string;
  endpointHost: string;
  config: Record<string, string>;
  runEnv: Record<string, string>;
  runCommand: string;
}

export interface LanOperatorLiveProviderConfig {
  schema: "oneesama.lan_operator_live_provider_config.v1";
  selectedTransport: ConversationTransport;
  selectedLiveTransport: "openai_realtime" | "gemini_live" | "";
  runtimeSwitchSupported: true;
  restartRequiredForTransportChange: false;
  providers: LanOperatorLiveProviderEntry[];
}

interface BuildLanOperatorLiveProviderConfigOptions {
  env?: Record<string, string | undefined>;
  selectedTransport: ConversationTransport;
  conversationTransportSelection?: LanOperatorConversationTransportSelection | null;
}

const OPENAI_KEY_ENVS = ["ONEESAMA_OPENAI_API_KEY", "MAB_OPENAI_API_KEY", "OPENAI_API_KEY"];
const GEMINI_KEY_ENVS = [
  "ONEESAMA_GEMINI_API_KEY",
  "MAB_GEMINI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];
const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-realtime-2";
const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";

function trimmed(value: unknown) {
  return String(value || "").trim();
}

function firstSetEnv(env: Record<string, string | undefined>, names: string[]) {
  for (const name of names) {
    if (trimmed(env[name])) return name;
  }
  return "";
}

function envValueWithSource(
  env: Record<string, string | undefined>,
  names: string[],
  fallback: string,
) {
  const source = firstSetEnv(env, names);
  return { value: source ? trimmed(env[source]) : fallback, source: source || "default" };
}

function providerKeySource(
  env: Record<string, string | undefined>,
  names: string[],
  transport: ConversationTransport,
  selection?: LanOperatorConversationTransportSelection | null,
) {
  if (selection?.transport === transport && selection.apiKeySource) return selection.apiKeySource;
  return firstSetEnv(env, names);
}

function openAiModel(env: Record<string, string | undefined>) {
  return envValueWithSource(
    env,
    ["MAB_LAN_OPENAI_REALTIME_MODEL", "MAB_OPENAI_REALTIME_MODEL", "OPENAI_REALTIME_MODEL"],
    DEFAULT_OPENAI_REALTIME_MODEL,
  );
}

function geminiModel(env: Record<string, string | undefined>) {
  return envValueWithSource(
    env,
    ["MAB_LAN_GEMINI_LIVE_MODEL", "MAB_GEMINI_LIVE_MODEL", "GEMINI_LIVE_MODEL"],
    DEFAULT_GEMINI_LIVE_MODEL,
  );
}

function geminiThinkingLevel(env: Record<string, string | undefined>) {
  return envValueWithSource(
    env,
    ["MAB_LAN_GEMINI_THINKING_LEVEL", "MAB_GEMINI_THINKING_LEVEL", "GEMINI_THINKING_LEVEL"],
    "low",
  );
}

export function buildLanOperatorLiveProviderConfig({
  env = process.env,
  selectedTransport,
  conversationTransportSelection,
}: BuildLanOperatorLiveProviderConfigOptions): LanOperatorLiveProviderConfig {
  const openAiKeySource = providerKeySource(
    env,
    OPENAI_KEY_ENVS,
    "openai_realtime",
    conversationTransportSelection,
  );
  const geminiKeySource = providerKeySource(
    env,
    GEMINI_KEY_ENVS,
    "gemini_live",
    conversationTransportSelection,
  );
  const openAi = openAiModel(env);
  const gemini = geminiModel(env);
  const thinking = geminiThinkingLevel(env);
  const selectedLiveTransport =
    selectedTransport === "openai_realtime" || selectedTransport === "gemini_live"
      ? selectedTransport
      : "";
  return {
    schema: "oneesama.lan_operator_live_provider_config.v1",
    selectedTransport,
    selectedLiveTransport,
    runtimeSwitchSupported: true,
    restartRequiredForTransportChange: false,
    providers: [
      {
        transport: "openai_realtime",
        label: "OpenAI Realtime",
        selected: selectedTransport === "openai_realtime",
        keyConfigured: Boolean(openAiKeySource),
        keySource: openAiKeySource,
        acceptedKeyEnv: OPENAI_KEY_ENVS,
        model: openAi.value,
        modelSource: openAi.source,
        endpointHost: "api.openai.com",
        config: {},
        runEnv: {
          MAB_LAN_OPERATOR_TRANSPORT: "openai_realtime",
          MAB_LAN_OPENAI_REALTIME_MODEL: openAi.value,
        },
        runCommand: "MAB_LAN_OPERATOR_TRANSPORT=openai_realtime vp run dev:local-operator",
      },
      {
        transport: "gemini_live",
        label: "Gemini Live",
        selected: selectedTransport === "gemini_live",
        keyConfigured: Boolean(geminiKeySource),
        keySource: geminiKeySource,
        acceptedKeyEnv: GEMINI_KEY_ENVS,
        model: gemini.value,
        modelSource: gemini.source,
        endpointHost: "generativelanguage.googleapis.com",
        config: {
          thinkingLevel: thinking.value,
          thinkingLevelSource: thinking.source,
        },
        runEnv: {
          MAB_LAN_OPERATOR_TRANSPORT: "gemini_live",
          MAB_LAN_GEMINI_LIVE_MODEL: gemini.value,
          MAB_LAN_GEMINI_THINKING_LEVEL: thinking.value,
        },
        runCommand: "MAB_LAN_OPERATOR_TRANSPORT=gemini_live vp run dev:local-operator",
      },
    ],
  };
}
