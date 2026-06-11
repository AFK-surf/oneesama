import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  createOperatorRuntimeClient,
  extractLiveProviderConfig,
} from "../packages/core/src/operator/web/operatorRuntimeClient.ts";

test("operator runtime client keeps HTTP auth and provider-switch contracts", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("/runtime/report")) {
      return new Response(JSON.stringify({ ok: true, report: { health: "ready" } }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        conversationTransport: "gemini_live",
        liveProviderConfig: {
          providers: [],
          runtimeSwitchSupported: true,
          selectedLiveTransport: "gemini_live",
          selectedTransport: "gemini_live",
        },
      }),
      {
        headers: { "content-type": "application/json" },
        status: 200,
      },
    );
  };

  try {
    const client = createOperatorRuntimeClient("token value");
    const status = await client.refreshStatus();
    const provider = await client.switchProvider("gemini_live");
    const report = await client.fetchReportText();

    assert.equal(status.ok, true);
    assert.equal(provider.conversationTransport, "gemini_live");
    assert.equal(report, JSON.stringify({ health: "ready" }, null, 2));
    assert.equal(calls[0].url, "/runtime/status?token=token%20value");
    assert.equal(calls[1].url, "/runtime/provider?token=token%20value");
    assert.equal(calls[1].init.method, "POST");
    assert.equal(calls[1].init.headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(calls[1].init.body), {
      transport: "gemini_live",
      connect: true,
    });
    assert.equal(calls[2].url, "/runtime/report?token=token%20value");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("operator runtime client extracts provider config from debug fallback", () => {
  const config = {
    providers: [{ label: "OpenAI", transport: "openai_realtime", keyConfigured: true }],
    runtimeSwitchSupported: true,
    selectedLiveTransport: "openai_realtime",
    selectedTransport: "openai_realtime",
  };

  assert.deepEqual(
    extractLiveProviderConfig({
      debug: { surfaceContext: { liveProviderConfig: config } },
    }),
    config,
  );
});
