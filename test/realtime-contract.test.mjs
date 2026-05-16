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

test("Realtime contract maps fast turn detection preset for browser sessions", () => {
  const session = buildRealtimeSessionConfig({}, {
    openaiRealtimeTurnDetection: "fast",
  });

  assert.deepEqual(session.audio.input.turn_detection, {
    type: "semantic_vad",
    eagerness: "high",
  });
});

test("Realtime contract parses JSON turn detection config strings", () => {
  const session = buildRealtimeSessionConfig({}, {
    openaiRealtimeTurnDetection: '{"type":"semantic_vad","eagerness":"low"}',
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
    currentUserAliases: ["彭潇", "肖鹏", "Operator"],
  });

  assert.equal(session.model, "gpt-realtime-2");
  assert.match(session.instructions, /Current speaker\/user: 老大/);
  assert.match(session.instructions, /Current user aliases: 老大 \/ Peng Xiao \/ 彭潇 \/ 肖鹏 \/ Operator/);
  assert.match(session.instructions, /email peng@example\.com/);
  assert.match(session.instructions, /Linear pengxiao/);
});
