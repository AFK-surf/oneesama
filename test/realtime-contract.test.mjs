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

test("Realtime contract applies product truncation defaults", () => {
  const session = buildRealtimeSessionConfig();

  assert.deepEqual(session.truncation, {
    type: "retention_ratio",
    retention_ratio: 0.8,
    token_limits: {
      post_instructions: 8000,
    },
  });
});

test("Realtime contract allows explicit truncation override", () => {
  const session = buildRealtimeSessionConfig({
    truncation: {
      type: "retention_ratio",
      retention_ratio: 0.6,
      token_limits: { post_instructions: 4000 },
    },
  });

  assert.deepEqual(session.truncation, {
    type: "retention_ratio",
    retention_ratio: 0.6,
    token_limits: { post_instructions: 4000 },
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

test("Realtime contract exposes application share tools", () => {
  const list = realtimeToolSchemas.find((tool) => tool.name === "list_shareable_apps");
  const present = realtimeToolSchemas.find((tool) => tool.name === "present_app_share");
  assert.ok(list);
  assert.ok(present);
  assert.equal(present.parameters.properties.applicationName.type, "string");
});
