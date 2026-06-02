import assert from "node:assert/strict";
import test from "node:test";

import { fetchJson } from "../packages/core/src/http-fetch-json.ts";

async function withMockFetch(mock, fn) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function hangingFetch(_url, init = {}) {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
}

test("fetchJson parses JSON responses", async () => {
  await withMockFetch(
    async () =>
      new Response(JSON.stringify({ ok: true, value: 42 }), {
        headers: { "content-type": "application/json" },
      }),
    async () => {
      assert.deepEqual(await fetchJson("https://example.invalid/test"), { ok: true, value: 42 });
    },
  );
});

test("fetchJson returns raw text when JSON parsing fails", async () => {
  await withMockFetch(
    async () => new Response("plain text", { headers: { "content-type": "text/plain" } }),
    async () => {
      assert.deepEqual(await fetchJson("https://example.invalid/text"), { raw: "plain text" });
    },
  );
});

test("fetchJson converts response failures into upstream errors", async () => {
  await withMockFetch(
    async () =>
      new Response(JSON.stringify({ error: "bad_token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      await assert.rejects(fetchJson("https://example.invalid/test"), {
        message: "upstream_http_401",
        status: 401,
        payload: { error: "bad_token" },
      });
    },
  );
});

test("fetchJson times out hanging upstream requests", async () => {
  await withMockFetch(hangingFetch, async () => {
    await assert.rejects(fetchJson("https://example.invalid/hang", { timeoutMs: 1 }), {
      message: "upstream_timeout",
      status: 504,
    });
  });
});
