import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  attachOpenAIRealtimeFailureDiagnostics,
  classifyOpenAIRealtimeProviderFailure,
} from "../scripts/lan-operator-openai-live-diagnostics.mjs";

test("OpenAI live diagnostics classify invalid API keys without leaking secrets", () => {
  const report = attachOpenAIRealtimeFailureDiagnostics({
    ok: false,
    conversationEngine: {
      providerEventCounts: { error: 1, "response.failed": 1 },
      recentProviderEvents: [
        {
          providerEventType: "error",
          error: "Incorrect API key provided: sk-test-secret",
        },
      ],
    },
    debugReport: {
      timeline: [
        {
          ok: false,
          blocker: "Incorrect API key provided: sk-test-secret",
        },
      ],
    },
  });

  assert.equal(report.acceptanceBlocker, "openai_realtime_api_key_invalid");
  assert.equal(report.provider.failure.category, "invalid_api_key");
  assert.equal(report.provider.failure.message.includes("sk-test-secret"), false);
  assert.match(report.provider.failure.message, /redacted_openai_api_key/);
  assert.deepEqual(report.provider.failure.providerEventTypes, ["error"]);
});

test("OpenAI live diagnostics distinguish quota, model, and websocket failures", () => {
  assert.equal(
    classifyOpenAIRealtimeProviderFailure({ ok: false, error: "insufficient_quota" }).blocker,
    "openai_realtime_quota_or_billing_blocked",
  );
  assert.equal(
    classifyOpenAIRealtimeProviderFailure({
      ok: false,
      error: "The model gpt-realtime-9 does not exist",
    }).blocker,
    "openai_realtime_model_unavailable",
  );
  assert.equal(
    classifyOpenAIRealtimeProviderFailure({
      ok: false,
      conversationEngine: { providerEventCounts: { "response.failed": 1 } },
      timeline: [{ ok: false, blocker: "websocket_closed" }],
    }).blocker,
    "openai_realtime_websocket_closed",
  );
});
