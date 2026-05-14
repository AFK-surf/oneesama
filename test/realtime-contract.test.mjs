import assert from "node:assert/strict";
import test from "node:test";

import { buildRealtimeSessionConfig } from "../packages/core/src/realtime/realtime-contract.ts";

test("Realtime contract preserves structured turn detection overrides", () => {
  const session = buildRealtimeSessionConfig({
    turnDetection: {
      type: "semantic_vad",
      eagerness: "low",
    },
  });

  assert.deepEqual(session.audio.input.turn_detection, {
    type: "semantic_vad",
    eagerness: "low",
  });
});

test("Realtime contract builds identity-aware instructions from runtime config", () => {
  const session = buildRealtimeSessionConfig({}, {
    botName: "Onee Sama",
    currentUserName: "老大",
    currentUserEnglishName: "Peng Xiao",
    currentUserEmail: "peng@example.com",
    currentUserLinear: "pengxiao",
    currentUserGithub: "pengx17",
    currentUserRole: "owner",
  });

  assert.equal(session.model, "gpt-realtime-2");
  assert.match(session.instructions, /Current speaker\/user: 老大/);
  assert.match(session.instructions, /email peng@example\.com/);
  assert.match(session.instructions, /Linear pengxiao/);
});
