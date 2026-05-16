import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRealtimeSessionConfig,
  realtimeToolSchemas,
} from "../packages/core/src/realtime/realtime-contract.ts";

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

test("Realtime contract keeps identity data out of product instructions", () => {
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
  assert.match(session.instructions, /Identity contract:/);
  assert.doesNotMatch(session.instructions, /老大|Peng Xiao|彭潇|肖鹏|peng@example\.com|pengxiao|pengx17/);
  assert.doesNotMatch(session.instructions, /Codex|codex|delegate_to_|worker|fetch_url|present_video_stage|send_meet_chat|update_avatar_state/);
});

test("Realtime contract exposes product identity resolver tool", () => {
  const resolver = realtimeToolSchemas.find((tool) => tool.name === "resolve_speaker_identity");
  assert.ok(resolver);
  assert.deepEqual(resolver.parameters.required, ["display_name"]);
});
