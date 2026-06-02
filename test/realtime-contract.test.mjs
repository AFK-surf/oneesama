import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import {
  buildRealtimeSessionConfig,
  defaultRealtimeToolSchemas,
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
  assert.match(session.instructions, /call kwwk_computer_use/);
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
  const kwwk = realtimeToolSchemas.find((tool) => tool.name === "kwwk_computer_use");
  const control = realtimeToolSchemas.find((tool) => tool.name === "control_shared_app_window");
  assert.ok(list);
  assert.ok(present);
  assert.ok(kwwk);
  assert.ok(control);
  assert.deepEqual(present.parameters.properties.applicationName.type, ["string", "null"]);
  assert.match(present.description, /共享一下/);
  assert.match(present.description, /Pencil\/喷手\/铅笔/);
  assert.match(list.description, /应用\/窗口\/屏幕/);
  assert.equal(kwwk.strict, undefined);
  assert.equal(kwwk.parameters.additionalProperties, false);
  assert.ok(kwwk.parameters.required.includes("instruction"));
  assert.match(kwwk.description, /KWWK Computer Use/);
  assert.match(kwwk.description, /generic direct app-operation tool/);
  assert.match(kwwk.description, /simple app actions/);
  assert.match(kwwk.description, /do not invent click coordinates/);
  assert.match(kwwk.description, /operation arrays/);
  assert.match(kwwk.description, /not the human's personal computer/);
  assert.deepEqual(kwwk.parameters.properties.job_id.type, ["string", "null"]);
  assert.deepEqual(kwwk.parameters.properties.instruction.type, ["string", "null"]);
  assert.equal(kwwk.parameters.properties.operations, undefined);
  assert.equal(kwwk.parameters.properties.executionMode, undefined);
  assert.equal(kwwk.parameters.properties.wait, undefined);
  assert.equal(kwwk.parameters.properties.timeoutMs, undefined);
  assert.equal(control.strict, undefined);
  assert.equal(control.parameters.additionalProperties, false);
  assert.ok(control.parameters.required.includes("instruction"));
  assert.match(control.description, /Compatibility app-control entrypoint/);
  assert.match(control.description, /Prefer kwwk_computer_use/);
  assert.match(control.description, /Codex Computer Use/);
  assert.match(control.description, /bot host/);
  assert.match(control.description, /not the human's personal computer/);
  assert.match(control.description, /natural language instruction/);
  assert.match(control.description, /do not invent click coordinates/);
  assert.deepEqual(control.parameters.properties.job_id.type, ["string", "null"]);
  assert.deepEqual(control.parameters.properties.instruction.type, ["string", "null"]);
  assert.deepEqual(control.parameters.properties.executionMode.enum, ["direct", "delegate", null]);
  assert.equal(control.parameters.properties.executionMode.default, "direct");
  assert.equal(control.parameters.properties.operations, undefined);
  assert.equal(control.parameters.properties.wait, undefined);
  assert.equal(control.parameters.properties.timeoutMs, undefined);
});

test("Realtime session config defaults to the live-safe tool surface", () => {
  const defaultNames = new Set(defaultRealtimeToolSchemas.map((tool) => tool.name));
  const sessionNames = new Set(buildRealtimeSessionConfig().tools.map((tool) => tool.name));

  for (const hidden of [
    "open_shared_browser_surface",
    "create_shared_workspace",
    "control_shared_browser_surface",
    "stop_shared_browser_surface",
  ]) {
    assert.equal(defaultNames.has(hidden), false, `${hidden} must stay out of live-safe defaults`);
    assert.equal(sessionNames.has(hidden), false, `${hidden} must stay out of default sessions`);
  }
  assert.ok(sessionNames.has("share_existing_app_window"));
  assert.ok(sessionNames.has("kwwk_computer_use"));
  assert.equal(sessionNames.has("control_shared_app_window"), false);
  assert.doesNotMatch(buildRealtimeSessionConfig().instructions, /create a shared workspace/);
  assert.doesNotMatch(buildRealtimeSessionConfig().instructions, /做一个贪吃蛇/);
});

test("Realtime session config only exposes browser-surface tools by explicit opt-in", () => {
  const session = buildRealtimeSessionConfig({ tools: realtimeToolSchemas });
  const sessionNames = new Set(session.tools.map((tool) => tool.name));

  assert.ok(sessionNames.has("open_shared_browser_surface"));
  assert.ok(sessionNames.has("control_shared_browser_surface"));
  assert.match(session.instructions, /create a shared workspace/);
  assert.match(session.instructions, /做一个贪吃蛇/);
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
    "start_screen_share",
    "present_screen_share",
    "stop_screen_share",
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

test("KWWK app-control helper accepts explicit internal operations but not hidden context operations", () => {
  const helper = readFileSync(
    new URL("../packages/core/src/meeting/app-control-helper.swift", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(helper, /Continue with concrete click\/type_text\/press_key\/scroll\/drag/);
  assert.doesNotMatch(helper, /context\["operations"\]/);
  assert.match(helper, /operationsFromParams\(params\["operations"\]\)/);
  assert.match(
    helper,
    /operationsFromInstruction\(instruction, target: target, observation: observation\)/,
  );
  assert.match(helper, /appControlInstructionHasStateIntent/);
  assert.match(helper, /appControlInstructionHasActionIntent/);
  assert.match(helper, /&& !appControlInstructionHasActionIntent\(lower\)/);
});

test("KWWK app-control helper records native cursor telemetry for pointer actions", () => {
  const helper = readFileSync(
    new URL("../packages/core/src/meeting/app-control-helper.swift", import.meta.url),
    "utf8",
  );

  assert.match(helper, /oneesama\.kwwk-cursor-events\.v1/);
  assert.match(helper, /func cursorCoordinateSpace\(target:/);
  assert.match(helper, /func requireCursorCoordinateSpace\(target:/);
  assert.match(helper, /cursor_unmappable/);
  assert.match(helper, /func cursorEvent\(kind:/);
  assert.match(helper, /coordinateSpaceId/);
  assert.match(helper, /normalizedX/);
  assert.match(helper, /normalizedY/);
  assert.match(helper, /cursor\.click/);
  assert.match(helper, /cursor\.double_click/);
  assert.match(helper, /cursor\.drag\.begin/);
  assert.match(helper, /cursor\.drag\.end/);
});

test("KWWK app-control helper materializes a native foreground cursor overlay", () => {
  const helper = readFileSync(
    new URL("../packages/core/src/meeting/app-control-helper.swift", import.meta.url),
    "utf8",
  );

  assert.match(helper, /final class KWWKForegroundCursorPanel: NSPanel/);
  assert.match(helper, /override var canBecomeKey: Bool\s*\{\s*false\s*\}/);
  assert.match(helper, /override var canBecomeMain: Bool\s*\{\s*false\s*\}/);
  assert.match(helper, /final class KWWKForegroundCursorView: NSView/);
  assert.match(helper, /override func hitTest\(_: NSPoint\) -> NSView\?\s*\{\s*nil\s*\}/);
  assert.match(helper, /styleMask: \[\.borderless, \.nonactivatingPanel\]/);
  assert.match(helper, /newPanel\.backgroundColor = \.clear/);
  assert.match(helper, /newPanel\.isOpaque = false/);
  assert.match(helper, /newPanel\.ignoresMouseEvents = true/);
  assert.match(helper, /renderSize: CGFloat = 28/);
  assert.match(helper, /hotspot = CGPoint\(x: 17\.0 \/ 101\.0, y: 13\.0 \/ 101\.0\)/);
  assert.match(
    helper,
    /KWWKForegroundCursorOverlay\.shared\.present\(quartzPoint: point, kind: "click"/,
  );
  assert.match(
    helper,
    /KWWKForegroundCursorOverlay\.shared\.present\(quartzPoint: point, kind: "double_click"/,
  );
  assert.match(helper, /func nativeCursorOverlayProbe\(params:/);
  assert.match(helper, /case "app_control\.native_cursor_overlay_probe"/);
});

test("KWWK app-control helper attaches coordinate metadata to screenshots", () => {
  const helper = readFileSync(
    new URL("../packages/core/src/meeting/app-control-helper.swift", import.meta.url),
    "utf8",
  );

  assert.match(helper, /screenshot\["coordinateSpaceId"\] = "kwwk_window_points"/);
  assert.match(helper, /screenshot\["coordinateSpace"\] = cursorCoordinateSpace\(target: target\)/);
});

test("KWWK app-control helper records action and latency telemetry", () => {
  const helper = readFileSync(
    new URL("../packages/core/src/meeting/app-control-helper.swift", import.meta.url),
    "utf8",
  );

  assert.match(helper, /func actionTelemetryEntry\(operation:/);
  assert.match(helper, /"actionTelemetry": actionTelemetry/);
  assert.match(helper, /oneesama\.kwwk-app-control-timings\.v1/);
  assert.match(helper, /func appControlTimingSegments\(totalStarted:/);
  assert.match(helper, /"observeMs"/);
  assert.match(helper, /"executeMs"/);
  assert.match(helper, /"verifyMs"/);
});

test("KWWK app-control helper captures focused app and target window metadata", () => {
  const helper = readFileSync(
    new URL("../packages/core/src/meeting/app-control-helper.swift", import.meta.url),
    "utf8",
  );

  assert.match(helper, /func focusedApplicationPayload\(\)/);
  assert.match(helper, /NSWorkspace\.shared\.frontmostApplication/);
  assert.match(helper, /result\["focusedApplication"\] = focusedApplication/);
  assert.match(helper, /result\["window"\] = window/);
});

test("KWWK visible cursor helper preserves Bridge-style marker and coordinate assumptions", () => {
  const helper = readFileSync(
    new URL("../packages/core/src/meeting/app-control-helper.swift", import.meta.url),
    "utf8",
  );

  assert.match(helper, /private final class AutomationClickIndicatorView: NSView/);
  assert.match(helper, /override func hitTest\(_: NSPoint\) -> NSView\?/);
  assert.match(helper, /nil\s*\n\s*}/);
  assert.match(helper, /func showClickIndicator\(at point: CGPoint, in rootView: NSView\)/);
  assert.match(helper, /DispatchQueue\.main\.asyncAfter\(deadline: \.now\(\) \+ \.seconds\(3\)\)/);
  assert.match(helper, /indicator\.removeFromSuperview\(\)/);
  assert.match(helper, /func capturedPixelScale\(capturedWidth:/);
  assert.match(helper, /capturedWidth \/ windowFrameWidth/);
  assert.match(helper, /func capturedPixelToAppKitPoint\(/);
  assert.match(helper, /flipped \? flippedY : unflippedY/);
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
