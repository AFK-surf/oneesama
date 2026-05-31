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
    create_response: true,
    interrupt_response: true,
  });
});

test("Realtime contract defaults to steady semantic turn detection", () => {
  const session = buildRealtimeSessionConfig();

  assert.deepEqual(session.audio.input.turn_detection, {
    type: "semantic_vad",
    eagerness: "low",
    create_response: true,
    interrupt_response: true,
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
  assert.match(session.instructions, /Fake-execution ban:/);
  assert.match(session.instructions, /before emitting the corresponding tool call/);
  assert.match(session.instructions, /结果出来告诉你/);
  assert.match(
    session.instructions,
    /first action in that turn must be list_shareable_windows or share_existing_app_window/,
  );
  assert.match(session.instructions, /Do not answer that a window list is processing/);
  assert.match(session.instructions, /App-control identity boundary:/);
  assert.match(session.instructions, /bot's host Mac/);
  assert.match(session.instructions, /这台 Mac mini/);
  assert.match(session.instructions, /“你用电脑控制”/);
  assert.match(session.instructions, /call control_shared_app_window/);
  assert.match(
    session.instructions,
    /Never satisfy an app-control request with a visual\/HUD-only update/,
  );
  assert.match(session.instructions, /Do not tell the human to share Chrome to you/);
});

test("Realtime contract exposes product identity resolver tool", () => {
  const resolver = realtimeToolSchemas.find((tool) => tool.name === "resolve_speaker_identity");
  assert.ok(resolver);
  assert.equal(resolver.strict, undefined);
  assert.ok(resolver.parameters.required.includes("display_name"));
  assert.equal(resolver.parameters.properties.display_name.type, "string");
  assert.deepEqual(resolver.parameters.properties.channel.type, ["string", "null"]);
});

test("Realtime contract exposes application share tools", () => {
  const list = realtimeToolSchemas.find((tool) => tool.name === "list_shareable_windows");
  const present = realtimeToolSchemas.find((tool) => tool.name === "share_existing_app_window");
  const control = realtimeToolSchemas.find((tool) => tool.name === "control_shared_app_window");
  assert.ok(list);
  assert.ok(present);
  assert.ok(control);
  assert.deepEqual(present.parameters.properties.applicationName.type, ["string", "null"]);
  assert.match(present.description, /共享一下/);
  assert.match(present.description, /Pencil\/喷手\/铅笔/);
  assert.match(list.description, /应用\/窗口\/屏幕/);
  assert.equal(control.strict, undefined);
  assert.equal(control.parameters.additionalProperties, false);
  assert.ok(control.parameters.required.includes("instruction"));
  assert.match(control.description, /Computer Use/);
  assert.match(control.description, /bot host's shared window/);
  assert.match(control.description, /not the human's personal computer/);
  assert.match(control.description, /switch accounts/);
  assert.match(control.description, /still call this tool/);
  assert.match(control.description, /leave target fields null/);
  assert.match(control.description, /在搜索框输入/);
  assert.match(control.description, /queues the app-control work asynchronously/);
  assert.match(control.description, /observe -> plan -> act -> verify/);
  assert.match(control.description, /Do not invent click\/drag primitives/);
  assert.deepEqual(control.parameters.properties.job_id.type, ["string", "null"]);
  assert.deepEqual(control.parameters.properties.instruction.type, ["string", "null"]);
  assert.equal(control.parameters.properties.operations, undefined);
  assert.equal(control.parameters.properties.wait, undefined);
  assert.equal(control.parameters.properties.timeoutMs, undefined);
});

test("Realtime tool schemas are strict-compatible", () => {
  for (const tool of realtimeToolSchemas) {
    assert.equal(tool.strict, undefined, `${tool.name} must not send unsupported Realtime strict`);
    assertStrictObjectSchema(tool.parameters, `${tool.name}.parameters`);
  }
});

test("Realtime tool descriptions fence off delegation tools", () => {
  const worker = realtimeToolSchemas.find((tool) => tool.name === "delegate_to_worker");

  assert.match(worker.description, /external workspace lookup/);
  assert.match(worker.description, /后台任务/);
  assert.match(worker.description, /写脚本/);
  assert.match(worker.description, /GitHub\/Linear\/Slack\/Notion/);
  const workerStatus = realtimeToolSchemas.find((tool) => tool.name === "worker_status");
  const meetChat = realtimeToolSchemas.find((tool) => tool.name === "read_meet_chat");
  assert.match(workerStatus.description, /codex 那个活儿/);
  assert.match(workerStatus.parameters.properties.jobId.description, /latest or previous/);
  assert.match(meetChat.description, /会议聊天/);
});

test("Realtime foreground tool surface hides unwired and legacy fine-grained tools", () => {
  const names = new Set(realtimeToolSchemas.map((tool) => tool.name));
  for (const hidden of [
    "delegate_to_codex",
    "delegate_status",
    "fetch_url",
    "search_team_members",
    "linear_query",
    "linear_user_issues",
    "google_calendar",
    "slack_search",
    "notion_search",
    "github_search",
    "memory_write",
    "memory_read",
    "set_avatar_expression",
    "set_avatar_action",
    "update_avatar_state",
  ]) {
    assert.equal(names.has(hidden), false, `${hidden} should stay behind the foreground surface`);
  }
});

function assertStrictObjectSchema(schema, path) {
  assert.ok(
    schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object")),
    `${path}.type`,
  );
  assert.equal(schema.additionalProperties, false, `${path}.additionalProperties`);
  const propertyNames = Object.keys(schema.properties || {}).toSorted();
  assert.deepEqual(schema.required, propertyNames, `${path}.required`);
  for (const [name, child] of Object.entries(schema.properties || {})) {
    assertStrictChildSchema(child, `${path}.properties.${name}`);
  }
}

function assertStrictChildSchema(schema, path) {
  if (schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"))) {
    assertStrictObjectSchema(schema, path);
  }
  if (schema.items) {
    assertStrictChildSchema(schema.items, `${path}.items`);
  }
}
