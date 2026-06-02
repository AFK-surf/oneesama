import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createJsonServer } from "../packages/core/src/http-json.ts";

async function listenOnEphemeralPort(service) {
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const address = service.server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

test("createJsonServer rejects request bodies over the configured limit", async () => {
  const service = createJsonServer({
    name: "test-json",
    port: 0,
    maxBodyBytes: 4,
    routes: {
      "POST /echo": ({ body }) => ({ ok: true, body }),
    },
  });
  const baseURL = await listenOnEphemeralPort(service);
  try {
    const response = await fetch(`${baseURL}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ too: "large" }),
    });
    const body = await response.json();

    assert.equal(response.status, 413);
    assert.equal(body.ok, false);
    assert.equal(body.error, "request_body_too_large");
    assert.equal(body.maxBodyBytes, 4);
  } finally {
    await new Promise((resolve, reject) => {
      service.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("createJsonServer listens on the configured host", async () => {
  const service = createJsonServer({
    name: "test-json-host",
    host: "127.0.0.1",
    port: 0,
    routes: {
      "GET /healthz": () => ({ ok: true }),
    },
  });

  try {
    await service.listen();
    const address = service.server.address();
    assert.equal(typeof address, "object");
    assert.equal(address.address, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
  } finally {
    await new Promise((resolve, reject) => {
      service.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
