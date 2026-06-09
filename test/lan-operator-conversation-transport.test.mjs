import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { resolveLanOperatorConversationTransport } from "../packages/core/src/operator/lan-operator-conversation-transport.ts";
import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";

const EMPTY_LIVE_ENV_DIR = join(tmpdir(), "oneesama-live-env-empty-test");

function baseEnv(overrides = {}) {
  return {
    MAB_LAN_OPERATOR_TRANSPORT: "",
    ONEESAMA_OPENAI_API_KEY: "",
    MAB_OPENAI_API_KEY: "",
    OPENAI_API_KEY: "",
    ONEESAMA_GEMINI_API_KEY: "",
    MAB_GEMINI_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
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
    baseEnv({ MAB_OPENAI_API_KEY: "test-mab-key" }),
  );

  assert.equal(selection.transport, "openai_realtime");
  assert.equal(selection.source, "openai_api_key");
  assert.equal(selection.explicit, false);
  assert.equal(selection.apiKeyConfigured, true);
  assert.equal(selection.apiKeySource, "MAB_OPENAI_API_KEY");
  assert.equal(selection.diagnosticFallback, false);
});

test("LAN operator transport resolver accepts the Oneesama backend OpenAI key", () => {
  const selection = resolveLanOperatorConversationTransport(
    baseEnv({ ONEESAMA_OPENAI_API_KEY: "test-oneesama-key" }),
  );

  assert.equal(selection.transport, "openai_realtime");
  assert.equal(selection.source, "openai_api_key");
  assert.equal(selection.explicit, false);
  assert.equal(selection.apiKeyConfigured, true);
  assert.equal(selection.apiKeySource, "ONEESAMA_OPENAI_API_KEY");
  assert.equal(selection.diagnosticFallback, false);
});

test("LAN operator transport resolver keeps an explicit diagnostic transport", () => {
  const selection = resolveLanOperatorConversationTransport(
    baseEnv({ MAB_LAN_OPERATOR_TRANSPORT: "mock", MAB_OPENAI_API_KEY: "test-mab-key" }),
  );

  assert.equal(selection.transport, "mock");
  assert.equal(selection.source, "explicit_env");
  assert.equal(selection.explicit, true);
  assert.equal(selection.apiKeyConfigured, true);
  assert.equal(selection.diagnosticFallback, false);
});

test("LAN operator transport resolver accepts an explicit Gemini Live transport", () => {
  const selection = resolveLanOperatorConversationTransport(
    baseEnv({ MAB_LAN_OPERATOR_TRANSPORT: "gemini", GEMINI_API_KEY: "test-gemini-key" }),
  );

  assert.equal(selection.transport, "gemini_live");
  assert.equal(selection.source, "explicit_env");
  assert.equal(selection.explicit, true);
  assert.equal(selection.apiKeyConfigured, true);
  assert.equal(selection.apiKeySource, "GEMINI_API_KEY");
  assert.equal(selection.diagnosticFallback, false);
});

test("LAN operator transport resolver selects Gemini Live when only a Gemini key exists", () => {
  const selection = resolveLanOperatorConversationTransport(
    baseEnv({ ONEESAMA_GEMINI_API_KEY: "test-oneesama-gemini-key" }),
  );

  assert.equal(selection.transport, "gemini_live");
  assert.equal(selection.source, "gemini_api_key");
  assert.equal(selection.explicit, false);
  assert.equal(selection.apiKeyConfigured, true);
  assert.equal(selection.apiKeySource, "ONEESAMA_GEMINI_API_KEY");
  assert.equal(selection.diagnosticFallback, false);
});

test("LAN operator transport resolver defaults live and records missing backend key", () => {
  const selection = resolveLanOperatorConversationTransport(baseEnv());

  assert.equal(selection.transport, "openai_realtime");
  assert.equal(selection.source, "default_openai_realtime");
  assert.equal(selection.apiKeyConfigured, false);
  assert.equal(selection.diagnosticFallback, false);
  assert.equal(selection.fallbackReason, "openai_realtime_api_key_missing");
});

test("LAN operator surface context includes Gemini Live transport selection evidence", () => {
  const selection = resolveLanOperatorConversationTransport(
    baseEnv({ ONEESAMA_GEMINI_API_KEY: "test-oneesama-gemini-key" }),
  );
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-gemini-transport-selection",
    conversationTransport: selection.transport,
    conversationTransportSelection: selection,
  });
  const status = surface.status();

  assert.equal(status.debug.conversation.engineId, "gemini_live");
  assert.equal(status.debug.surfaceContext.operatorMode.conversationTransport, "gemini_live");
  assert.equal(status.debug.surfaceContext.conversationTransportSelection.source, "gemini_api_key");
  assert.equal(
    status.debug.surfaceContext.conversationTransportSelection.apiKeySource,
    "ONEESAMA_GEMINI_API_KEY",
  );
});

test("LAN operator surface context includes conversation transport selection evidence", () => {
  const selection = resolveLanOperatorConversationTransport(
    baseEnv({ OPENAI_API_KEY: "test-openai-key" }),
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
    ONEESAMA_LIVE_DEFAULT_ENV_DIR: EMPTY_LIVE_ENV_DIR,
    MAB_LAN_OPERATOR_HOST: "127.0.0.1",
    MAB_LAN_OPERATOR_PORT: "0",
    MAB_LAN_OPERATOR_ENABLE_TRUSTED_LAN: "",
    MAB_LAN_OPERATOR_TRUSTED_LAN: "",
    MAB_LAN_OPERATOR_OPEN_BROWSER: "0",
    MAB_LAN_OPERATOR_TRANSPORT: "",
    ONEESAMA_OPENAI_API_KEY: "",
    MAB_OPENAI_API_KEY: "test-cli-key",
    OPENAI_API_KEY: "",
    ONEESAMA_GEMINI_API_KEY: "",
    MAB_GEMINI_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  });

  assert.equal(startup.ok, true);
  assert.equal(startup.conversationTransport, "openai_realtime");
  assert.equal(startup.conversationTransportSelection.source, "openai_api_key");
  assert.equal(startup.conversationTransportSelection.apiKeySource, "MAB_OPENAI_API_KEY");
});

test("LAN operator CLI loads backend live env before selecting default transport", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oneesama-live-env-test-"));
  try {
    const liveEnvDir = join(tmp, "oneesama", "live-env");
    await mkdir(liveEnvDir, { recursive: true });
    const keyName = "ONEESAMA_OPENAI_API_KEY";
    await writeFile(
      join(liveEnvDir, "oneesama-openai-live.sh"),
      `export ${keyName}='test-backend-live-key'\n`,
    );
    const startup = await readFirstJsonFromCli({
      ...process.env,
      XDG_CONFIG_HOME: tmp,
      ONEESAMA_LIVE_DEFAULT_ENV_DIR: "",
      MAB_LAN_OPERATOR_HOST: "127.0.0.1",
      MAB_LAN_OPERATOR_PORT: "0",
      MAB_LAN_OPERATOR_ENABLE_TRUSTED_LAN: "",
      MAB_LAN_OPERATOR_TRUSTED_LAN: "",
      MAB_LAN_OPERATOR_OPEN_BROWSER: "0",
      MAB_LAN_OPERATOR_TRANSPORT: "",
      ONEESAMA_OPENAI_API_KEY: "",
      MAB_OPENAI_API_KEY: "",
      OPENAI_API_KEY: "",
      ONEESAMA_GEMINI_API_KEY: "",
      MAB_GEMINI_API_KEY: "",
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
    });

    assert.equal(startup.ok, true);
    assert.equal(startup.conversationTransport, "openai_realtime");
    assert.equal(startup.conversationTransportSelection.source, "openai_api_key");
    assert.equal(startup.conversationTransportSelection.apiKeySource, keyName);
    assert.deepEqual(startup.backendLiveEnv.keys, [keyName]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("LAN operator CLI loads Gemini backend live env before selecting default transport", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oneesama-gemini-live-env-test-"));
  try {
    const liveEnvDir = join(tmp, "oneesama", "live-env");
    await mkdir(liveEnvDir, { recursive: true });
    const keyName = "ONEESAMA_GEMINI_API_KEY";
    await writeFile(
      join(liveEnvDir, "oneesama-gemini-live.sh"),
      `export ${keyName}='test-backend-gemini-live-key'\n`,
    );
    const startup = await readFirstJsonFromCli({
      ...process.env,
      XDG_CONFIG_HOME: tmp,
      ONEESAMA_LIVE_DEFAULT_ENV_DIR: "",
      MAB_LAN_OPERATOR_HOST: "127.0.0.1",
      MAB_LAN_OPERATOR_PORT: "0",
      MAB_LAN_OPERATOR_ENABLE_TRUSTED_LAN: "",
      MAB_LAN_OPERATOR_TRUSTED_LAN: "",
      MAB_LAN_OPERATOR_OPEN_BROWSER: "0",
      MAB_LAN_OPERATOR_TRANSPORT: "",
      ONEESAMA_OPENAI_API_KEY: "",
      MAB_OPENAI_API_KEY: "",
      OPENAI_API_KEY: "",
      ONEESAMA_GEMINI_API_KEY: "",
      MAB_GEMINI_API_KEY: "",
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
    });

    assert.equal(startup.ok, true);
    assert.equal(startup.conversationTransport, "gemini_live");
    assert.equal(startup.conversationTransportSelection.source, "gemini_api_key");
    assert.equal(startup.conversationTransportSelection.apiKeySource, keyName);
    assert.deepEqual(startup.backendLiveEnv.keys, [keyName]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("LAN operator CLI only uses mock when explicitly forced for diagnostics", async () => {
  const startup = await readFirstJsonFromCli({
    ...process.env,
    ONEESAMA_LIVE_DEFAULT_ENV_DIR: EMPTY_LIVE_ENV_DIR,
    MAB_LAN_OPERATOR_HOST: "127.0.0.1",
    MAB_LAN_OPERATOR_PORT: "0",
    MAB_LAN_OPERATOR_ENABLE_TRUSTED_LAN: "",
    MAB_LAN_OPERATOR_TRUSTED_LAN: "",
    MAB_LAN_OPERATOR_OPEN_BROWSER: "0",
    MAB_LAN_OPERATOR_TRANSPORT: "mock",
    ONEESAMA_OPENAI_API_KEY: "test-oneesama-key",
    MAB_OPENAI_API_KEY: "",
    OPENAI_API_KEY: "",
    ONEESAMA_GEMINI_API_KEY: "",
    MAB_GEMINI_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  });

  assert.equal(startup.ok, true);
  assert.equal(startup.conversationTransport, "mock");
  assert.equal(startup.conversationTransportSelection.source, "explicit_env");
  assert.equal(startup.conversationTransportSelection.explicit, true);
  assert.equal(startup.conversationTransportSelection.apiKeySource, "ONEESAMA_OPENAI_API_KEY");
});

test("LAN operator CLI defaults to live Realtime even before backend key is injected", async () => {
  const startup = await readFirstJsonFromCli({
    ...process.env,
    ONEESAMA_LIVE_DEFAULT_ENV_DIR: EMPTY_LIVE_ENV_DIR,
    MAB_LAN_OPERATOR_HOST: "127.0.0.1",
    MAB_LAN_OPERATOR_PORT: "0",
    MAB_LAN_OPERATOR_ENABLE_TRUSTED_LAN: "",
    MAB_LAN_OPERATOR_TRUSTED_LAN: "",
    MAB_LAN_OPERATOR_OPEN_BROWSER: "0",
    MAB_LAN_OPERATOR_TRANSPORT: "",
    ONEESAMA_OPENAI_API_KEY: "",
    MAB_OPENAI_API_KEY: "",
    OPENAI_API_KEY: "",
    ONEESAMA_GEMINI_API_KEY: "",
    MAB_GEMINI_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  });

  assert.equal(startup.ok, true);
  assert.equal(startup.conversationTransport, "openai_realtime");
  assert.equal(startup.conversationTransportSelection.source, "default_openai_realtime");
  assert.equal(startup.conversationTransportSelection.apiKeyConfigured, false);
  assert.equal(
    startup.conversationTransportSelection.fallbackReason,
    "openai_realtime_api_key_missing",
  );
});
