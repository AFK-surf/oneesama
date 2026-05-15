import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { realtimeToolSchemas } from "../packages/core/src/realtime/realtime-contract.ts";

function extractGoRealtimeToolSchemas(source) {
  const match = source.match(/const realtimeToolSchemasJSON = `([^`]+)`/s);
  if (!match) throw new Error("realtimeToolSchemasJSON const not found");
  return JSON.parse(match[1]);
}

test("TypeScript realtime tool schemas match the Go single-source fixture", async () => {
  const goSource = await readFile("internal/meetingagent/realtime_tools.go", "utf8");
  assert.deepEqual(realtimeToolSchemas, extractGoRealtimeToolSchemas(goSource));
});
