import { getRuntimeConfig } from "../env.js";
import { buildRealtimeSessionConfig } from "./realtime-contract.js";

interface MintRealtimeClientSecretOptions {
  safetyIdentifier?: string;
  [key: string]: unknown;
}

export async function mintRealtimeClientSecret(options: MintRealtimeClientSecretOptions = {}) {
  const config = getRuntimeConfig();
  const session = buildRealtimeSessionConfig(options, config);
  if (!config.openaiApiKey) {
    return {
      ok: false,
      error: "MAB_OPENAI_API_KEY/OPENAI_API_KEY missing",
      dryRun: true,
      session,
      upstream: {
        baseUrl: config.openaiBaseUrl,
        clientSecretsUrl: config.openaiRealtimeClientSecretsUrl,
      },
    };
  }

  const response = await fetch(config.openaiRealtimeClientSecretsUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openaiApiKey}`,
      "content-type": "application/json",
      "openai-safety-identifier": options.safetyIdentifier || "meeting-avatar-bot-local",
    },
    body: JSON.stringify({
      session,
    }),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: "openai_realtime_upstream",
      status: response.status,
      detail: parsed,
      upstream: {
        baseUrl: config.openaiBaseUrl,
        clientSecretsUrl: config.openaiRealtimeClientSecretsUrl,
      },
    };
  }
  return {
    ok: true,
    upstream: {
      baseUrl: config.openaiBaseUrl,
      clientSecretsUrl: config.openaiRealtimeClientSecretsUrl,
    },
    ...parsed,
  };
}
