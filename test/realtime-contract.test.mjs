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
  const session = buildRealtimeSessionConfig(
    {},
    {
      openaiRealtimeTurnDetection: "fast",
    },
  );

  assert.deepEqual(session.audio.input.turn_detection, {
    type: "semantic_vad",
    eagerness: "high",
  });
});

test("Realtime contract defaults to steady semantic turn detection", () => {
  const session = buildRealtimeSessionConfig();

  assert.deepEqual(session.audio.input.turn_detection, {
    type: "semantic_vad",
    eagerness: "low",
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
  const session = buildRealtimeSessionConfig(
    {},
    {
      openaiRealtimeTurnDetection: '{"type":"semantic_vad","eagerness":"low"}',
    },
  );

  assert.deepEqual(session.audio.input.turn_detection, {
    type: "semantic_vad",
    eagerness: "low",
  });
});

test("Realtime contract keeps identity data out of product instructions", () => {
  const session = buildRealtimeSessionConfig(
    {},
    {
      botName: "Onee Sama",
      currentUserName: "老大",
      currentUserEnglishName: "Peng Xiao",
      currentUserEmail: "peng@example.com",
      currentUserLinear: "pengxiao",
      currentUserGithub: "pengx17",
      currentUserRole: "owner",
      currentUserAliases: ["彭潇", "肖鹏", "Operator"],
    },
  );

  assert.equal(session.model, "gpt-realtime-2");
  assert.match(session.instructions, /Identity contract:/);
  assert.match(session.instructions, /status queued or running/);
  assert.match(session.instructions, /Do not claim completion/);
  assert.doesNotMatch(
    session.instructions,
    /老大|Peng Xiao|彭潇|肖鹏|peng@example\.com|pengxiao|pengx17/,
  );
  assert.doesNotMatch(
    session.instructions,
    /Codex|codex|delegate_to_|worker|fetch_url|present_video_stage|send_meet_chat|update_avatar_state/,
  );
});

test("Realtime contract keeps short voice checks and self-introductions on topic", () => {
  const session = buildRealtimeSessionConfig({}, { botName: "Onee Sama" });

  assert.match(session.instructions, /newest explicit spoken request first/);
  assert.match(session.instructions, /Voice checks such as/);
  assert.match(session.instructions, /one short confirmation/);
  assert.match(
    session.instructions,
    /Do not expand into microphone, camera, permission, or troubleshooting advice/,
  );
  assert.match(session.instructions, /introduce yourself as Onee Sama/);
  assert.match(session.instructions, /Do not answer as the user/);
  assert.match(session.instructions, /room echo/);
  assert.match(session.instructions, /Do not continue your own previous answer/);
  assert.match(session.instructions, /Chinese share intent has priority over arithmetic/);
  assert.match(session.instructions, /“共享一下”/);
  assert.match(session.instructions, /“Pencil 这个 app”/);
  assert.match(session.instructions, /Screen-share action mandate:/);
  assert.match(session.instructions, /first action in that turn must be list_shareable_windows or share_existing_app_window/);
  assert.match(session.instructions, /Do not answer that a window list is processing/);
});

test("Realtime contract exposes product identity resolver tool", () => {
  const resolver = realtimeToolSchemas.find((tool) => tool.name === "resolve_speaker_identity");
  assert.ok(resolver);
  assert.deepEqual(resolver.parameters.required, ["display_name"]);
});

test("Realtime contract exposes application share tools", () => {
  const list = realtimeToolSchemas.find((tool) => tool.name === "list_shareable_windows");
  const present = realtimeToolSchemas.find((tool) => tool.name === "share_existing_app_window");
  const control = realtimeToolSchemas.find((tool) => tool.name === "control_shared_app_window");
  assert.ok(list);
  assert.ok(present);
  assert.ok(control);
  assert.equal(present.parameters.properties.applicationName.type, "string");
  assert.match(present.description, /共享一下/);
  assert.match(present.description, /Pencil\/喷手\/铅笔/);
  assert.match(list.description, /应用\/窗口\/屏幕/);
  assert.deepEqual(control.parameters.required, []);
  assert.match(control.description, /Computer Use/);
  assert.match(control.description, /queues the app-control work asynchronously/);
  assert.match(control.description, /observe -> plan -> act -> verify/);
  assert.match(control.description, /Do not invent click\/drag primitives/);
  assert.equal(control.parameters.properties.job_id.type, "string");
  assert.equal(control.parameters.properties.wait.default, false);
  assert.equal(control.parameters.properties.operations.type, "array");
  assert.match(
    control.parameters.properties.operations.description,
    /Optional low-level app-control operations/,
  );
  assert.deepEqual(control.parameters.properties.operations.items.required, ["kind"]);
  assert.ok(control.parameters.properties.operations.items.properties.kind.enum.includes("drag"));
  assert.ok(
    !control.parameters.properties.operations.items.properties.kind.enum.includes(
      "perform_secondary_action",
    ),
  );
});
