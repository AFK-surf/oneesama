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

test("Realtime contract enables input audio transcription by default", () => {
  const session = buildRealtimeSessionConfig();

  assert.deepEqual(session.audio.input.transcription, {
    model: "gpt-4o-mini-transcribe",
  });
});

test("Realtime contract allows input audio transcription override and disable", () => {
  const overridden = buildRealtimeSessionConfig({
    inputAudioTranscription: { model: "custom-transcribe", language: "zh" },
  });
  const disabled = buildRealtimeSessionConfig({
    inputAudioTranscription: "disabled",
  });

  assert.deepEqual(overridden.audio.input.transcription, {
    model: "custom-transcribe",
    language: "zh",
  });
  assert.equal(Object.hasOwn(disabled.audio.input, "transcription"), false);
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
  assert.match(
    session.instructions,
    /Always answer in concise English, regardless of the user's language/,
  );
  assert.match(session.instructions, /Chinese share intent has priority over arithmetic/);
  assert.match(session.instructions, /“共享一下”/);
  assert.match(session.instructions, /“Pencil 这个 app”/);
  assert.match(session.instructions, /Screen-share action mandate:/);
  assert.match(session.instructions, /Fake-execution ban:/);
  assert.match(session.instructions, /before emitting the corresponding tool call/);
  assert.doesNotMatch(session.instructions, /Speak concise Chinese by default/);
  assert.doesNotMatch(session.instructions, /summarize the result in concise Chinese/);
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
  assert.equal(control, undefined);
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
  assert.deepEqual(kwwk.parameters.properties.instruction.type, ["string", "null"]);
  assert.deepEqual(Object.keys(kwwk.parameters.properties).sort(), [
    "applicationName",
    "bundleIdentifier",
    "instruction",
    "processId",
    "session_id",
    "windowId",
    "windowTitle",
  ]);
  assert.equal(kwwk.parameters.properties.job_id, undefined);
  assert.equal(kwwk.parameters.properties.operations, undefined);
  assert.equal(kwwk.parameters.properties.executionMode, undefined);
  assert.equal(kwwk.parameters.properties.wait, undefined);
  assert.equal(kwwk.parameters.properties.timeoutMs, undefined);
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
  const planner = readFileSync(
    new URL("../packages/core/src/meeting/kwwk-cu-planner.swift", import.meta.url),
    "utf8",
  );
  const executor = readFileSync(
    new URL("../packages/core/src/meeting/kwwk-cu-executor.swift", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(helper, /Continue with concrete click\/type_text\/press_key\/scroll\/drag/);
  assert.doesNotMatch(helper, /context\["operations"\]/);
  assert.match(executor, /operationsFromParams\(params\["operations"\]\)/);
  assert.match(
    planner,
    /operationsFromInstruction\(instruction, target: target, observation: observation\)/,
  );
  assert.match(planner, /appControlInstructionHasStateIntent/);
  assert.match(planner, /appControlInstructionHasActionIntent/);
  assert.match(planner, /&& !appControlInstructionHasActionIntent\(lower\)/);
  assert.doesNotMatch(helper, /func operationsFromInstruction/);
  assert.doesNotMatch(helper, /func clickOperationsFromObservation/);
  assert.doesNotMatch(helper, /func operationsFromParams/);
  assert.doesNotMatch(helper, /func controlSharedAppWindow/);
});

test("KWWK app-control helper records native cursor telemetry for pointer actions", () => {
  const cursor = readFileSync(
    new URL("../packages/core/src/meeting/kwwk-cu-cursor.swift", import.meta.url),
    "utf8",
  );

  assert.match(cursor, /func cursorCoordinateSpace\(target:/);
  assert.match(cursor, /func requireCursorCoordinateSpace\(target:/);
  assert.match(cursor, /cursor_unmappable/);
  assert.match(cursor, /func cursorEvent\(kind:/);
  assert.match(cursor, /coordinateSpaceId/);
  assert.match(cursor, /normalizedX/);
  assert.match(cursor, /normalizedY/);
  assert.match(cursor, /cursor\.click/);
  assert.match(cursor, /cursor\.double_click/);
  assert.match(cursor, /cursor\.drag\.begin/);
  assert.match(cursor, /cursor\.drag\.end/);
});

test("KWWK app-control helper materializes a native foreground cursor overlay", () => {
  const router = readFileSync(
    new URL("../packages/core/src/meeting/kwwk-cu-router.swift", import.meta.url),
    "utf8",
  );
  const cursor = readFileSync(
    new URL("../packages/core/src/meeting/kwwk-cu-cursor.swift", import.meta.url),
    "utf8",
  );

  assert.match(cursor, /final class KWWKForegroundCursorPanel: NSPanel/);
  assert.match(cursor, /override var canBecomeKey: Bool\s*\{\s*false\s*\}/);
  assert.match(cursor, /override var canBecomeMain: Bool\s*\{\s*false\s*\}/);
  assert.match(cursor, /final class KWWKForegroundCursorView: NSView/);
  assert.match(cursor, /override func hitTest\(_: NSPoint\) -> NSView\?\s*\{\s*nil\s*\}/);
  assert.match(cursor, /styleMask: \[\.borderless, \.nonactivatingPanel\]/);
  assert.match(cursor, /newPanel\.backgroundColor = \.clear/);
  assert.match(cursor, /newPanel\.isOpaque = false/);
  assert.match(cursor, /newPanel\.ignoresMouseEvents = true/);
  assert.match(cursor, /renderSize: CGFloat = 28/);
  assert.match(cursor, /hotspot = CGPoint\(x: 17\.0 \/ 101\.0, y: 13\.0 \/ 101\.0\)/);
  assert.match(
    cursor,
    /KWWKForegroundCursorOverlay\.shared\.present\(quartzPoint: point, kind: "click"/,
  );
  assert.match(
    cursor,
    /KWWKForegroundCursorOverlay\.shared\.present\(quartzPoint: point, kind: "double_click"/,
  );
  assert.match(cursor, /func nativeCursorOverlayProbe\(params:/);
  assert.match(router, /case "app_control\.native_cursor_overlay_probe"/);
});

test("KWWK app-control helper attaches coordinate metadata to screenshots", () => {
  const observation = readFileSync(
    new URL("../packages/core/src/meeting/kwwk-cu-observation.swift", import.meta.url),
    "utf8",
  );

  assert.match(observation, /screenshot\["coordinateSpaceId"\] = "kwwk_window_points"/);
  assert.match(
    observation,
    /screenshot\["coordinateSpace"\] = cursorCoordinateSpace\(target: target\)/,
  );
});

test("KWWK app-control helper records action, verification, and latency telemetry", () => {
  const executor = readFileSync(
    new URL("../packages/core/src/meeting/kwwk-cu-executor.swift", import.meta.url),
    "utf8",
  );
  const verification = readFileSync(
    new URL("../packages/core/src/meeting/kwwk-cu-verification.swift", import.meta.url),
    "utf8",
  );

  assert.match(executor, /func actionTelemetryEntry\(operation:/);
  assert.match(executor, /"actionTelemetry": actionTelemetry/);
  assert.match(executor, /verifyPostActionState/);
  assert.match(executor, /"verification": verification/);
  assert.match(verification, /func verifyPostActionState/);
  assert.match(verification, /oneesama\.kwwk-cu-verification\.v1/);
  assert.match(verification, /failed_verification/);
  assert.match(executor, /oneesama\.kwwk-app-control-timings\.v1/);
  assert.match(executor, /func appControlTimingSegments\(totalStarted:/);
  assert.match(executor, /"observeMs"/);
  assert.match(executor, /"executeMs"/);
  assert.match(executor, /"verifyMs"/);
});

test("KWWK app-control helper captures focused app and target window metadata", () => {
  const observation = readFileSync(
    new URL("../packages/core/src/meeting/kwwk-cu-observation.swift", import.meta.url),
    "utf8",
  );

  assert.match(observation, /func focusedApplicationPayload\(\)/);
  assert.match(observation, /NSWorkspace\.shared\.frontmostApplication/);
  assert.match(observation, /result\["focusedApplication"\] = focusedApplication/);
  assert.match(observation, /result\["window"\] = window/);
});

test("KWWK visible cursor helper preserves Bridge-style marker and coordinate assumptions", () => {
  const cursor = readFileSync(
    new URL("../packages/core/src/meeting/kwwk-cu-cursor.swift", import.meta.url),
    "utf8",
  );

  assert.match(cursor, /private final class AutomationClickIndicatorView: NSView/);
  assert.match(cursor, /override func hitTest\(_: NSPoint\) -> NSView\?/);
  assert.match(cursor, /nil\s*\n\s*}/);
  assert.match(cursor, /func showClickIndicator\(at point: CGPoint, in rootView: NSView\)/);
  assert.match(cursor, /DispatchQueue\.main\.asyncAfter\(deadline: \.now\(\) \+ \.seconds\(3\)\)/);
  assert.match(cursor, /indicator\.removeFromSuperview\(\)/);
  assert.match(cursor, /func capturedPixelScale\(capturedWidth:/);
  assert.match(cursor, /capturedWidth \/ windowFrameWidth/);
  assert.match(cursor, /func capturedPixelToAppKitPoint\(/);
  assert.match(cursor, /flipped \? flippedY : unflippedY/);
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
