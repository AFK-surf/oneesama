import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "vite-plus/test";

import { resolveLanOperatorConversationTransport } from "../packages/core/src/operator/lan-operator-conversation-transport.ts";
import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";

function baseEnv(overrides = {}) {
  return {
    MAB_LAN_OPERATOR_TRANSPORT: "",
    MAB_OPENAI_API_KEY: "",
    OPENAI_API_KEY: "",
    ...overrides,
  };
}

async function readFirstJsonFromCli(env) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "packages/core/src/operator/lan-operator-surface-cli.ts"],
    {
      cwd: new URL("..", import.meta.url),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    const started = Date.now();
    while (Date.now() - started < 5_000) {
      const trimmed = stdout.trim();
      if (trimmed.startsWith("{")) {
        try {
          return JSON.parse(trimmed);
        } catch {
          // Keep waiting for the pretty-printed startup JSON to finish.
        }
      }
      if (child.exitCode !== null) throw new Error(`cli exited early: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`cli startup json timeout stdout=${stdout} stderr=${stderr}`);
  } finally {
    child.kill("SIGTERM");
  }
}

test("LAN operator transport resolver defaults to OpenAI Realtime when an API key exists", () => {
  const selection = resolveLanOperatorConversationTransport(
    baseEnv({ MAB_OPENAI_API_KEY: "sk-test" }),
  );

  assert.equal(selection.transport, "openai_realtime");
  assert.equal(selection.source, "openai_api_key");
  assert.equal(selection.explicit, false);
  assert.equal(selection.apiKeyConfigured, true);
  assert.equal(selection.apiKeySource, "MAB_OPENAI_API_KEY");
  assert.equal(selection.diagnosticFallback, false);
});

test("LAN operator transport resolver keeps an explicit diagnostic transport", () => {
  const selection = resolveLanOperatorConversationTransport(
    baseEnv({ MAB_LAN_OPERATOR_TRANSPORT: "mock", MAB_OPENAI_API_KEY: "sk-test" }),
  );

  assert.equal(selection.transport, "mock");
  assert.equal(selection.source, "explicit_env");
  assert.equal(selection.explicit, true);
  assert.equal(selection.apiKeyConfigured, true);
  assert.equal(selection.diagnosticFallback, false);
});

test("LAN operator transport resolver marks missing-key diagnostic fallback", () => {
  const selection = resolveLanOperatorConversationTransport(baseEnv());

  assert.equal(selection.transport, "mock");
  assert.equal(selection.source, "diagnostic_missing_openai_key");
  assert.equal(selection.apiKeyConfigured, false);
  assert.equal(selection.diagnosticFallback, true);
  assert.equal(selection.fallbackReason, "openai_realtime_api_key_missing");
});

test("LAN operator surface context includes conversation transport selection evidence", () => {
  const selection = resolveLanOperatorConversationTransport(
    baseEnv({ OPENAI_API_KEY: "sk-test-openai" }),
  );
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-transport-selection",
    conversationTransport: selection.transport,
    conversationTransportSelection: selection,
  });
  const status = surface.status();

  assert.equal(status.debug.conversation.engineId, "openai_realtime");
  assert.equal(status.debug.surfaceContext.operatorMode.conversationTransport, "openai_realtime");
  assert.equal(status.debug.surfaceContext.conversationTransportSelection.source, "openai_api_key");
  assert.equal(
    status.debug.surfaceContext.conversationTransportSelection.apiKeySource,
    "OPENAI_API_KEY",
  );
});

test("LAN operator CLI selects OpenAI Realtime by default when a key is configured", async () => {
  const startup = await readFirstJsonFromCli({
    ...process.env,
    MAB_LAN_OPERATOR_HOST: "127.0.0.1",
    MAB_LAN_OPERATOR_PORT: "0",
    MAB_LAN_OPERATOR_ENABLE_TRUSTED_LAN: "",
    MAB_LAN_OPERATOR_TRUSTED_LAN: "",
    MAB_LAN_OPERATOR_TRANSPORT: "",
    MAB_OPENAI_API_KEY: "sk-cli-test",
    OPENAI_API_KEY: "",
  });

  assert.equal(startup.ok, true);
  assert.equal(startup.conversationTransport, "openai_realtime");
  assert.equal(startup.conversationTransportSelection.source, "openai_api_key");
  assert.equal(startup.conversationTransportSelection.apiKeySource, "MAB_OPENAI_API_KEY");
});
