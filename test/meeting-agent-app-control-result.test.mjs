import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { compactMeetingAgentAppControlResult } from "../apps/meeting-agent/src/app-control-result.ts";

test("TS meeting-agent app-control compaction strips raw helper metadata", () => {
  const compact = compactMeetingAgentAppControlResult({
    ok: true,
    summary: "Executed one app-control operation.",
    actions: ["click", "type_text"],
    confidence: 0.8,
    operations: [{ kind: "click", x: 10, y: 20 }],
    metadata: {
      state: {
        window: {
          title: "Chrome",
          frame: { width: 1200, height: 900 },
        },
      },
    },
    result: {
      raw: "SHOULD_NOT_REACH_MODEL",
    },
    responseText: "SHOULD_NOT_REACH_MODEL",
  });

  assert.deepEqual(compact, {
    ok: true,
    provider: "kwwk",
    status: "completed",
    summary: "Executed one app-control operation.",
    actions: ["click", "type_text"],
    confidence: 0.8,
  });
  assert.equal(Object.hasOwn(compact, "operations"), false);
  assert.equal(Object.hasOwn(compact, "metadata"), false);
  assert.equal(Object.hasOwn(compact, "result"), false);
  assert.equal(Object.hasOwn(compact, "responseText"), false);
});

test("TS meeting-agent app-control compaction keeps compact blockers", () => {
  const compact = compactMeetingAgentAppControlResult({
    ok: false,
    summary: "Could not inspect the shared app/window.",
    blocker: "instruction_not_directly_executable",
    metadata: { state: { raw: "SHOULD_NOT_REACH_MODEL" } },
  });

  assert.deepEqual(compact, {
    ok: false,
    provider: "kwwk",
    status: "failed",
    summary: "Could not inspect the shared app/window.",
    blocker: "instruction_not_directly_executable",
    error: "instruction_not_directly_executable",
    displayText: "This action is not supported yet.",
    answer_hint_en: "This action is not supported yet.",
  });
});

test("TS meeting-agent app-control compaction treats terminal failure status as not ok", () => {
  const compact = compactMeetingAgentAppControlResult({
    ok: true,
    status: "blocked",
    summary: "Helper reported ok but status says blocked.",
    blocker: "permission_required",
  });

  assert.deepEqual(compact, {
    ok: false,
    provider: "kwwk",
    status: "blocked",
    summary: "Helper reported ok but status says blocked.",
    blocker: "permission_required",
    error: "permission_required",
    displayText: "Permission is required.",
    answer_hint_en: "Permission is required.",
  });
});

test("TS meeting-agent app-control compaction adds compact failure wording", () => {
  const cases = [
    ["blocked_ambiguous_target", "Target is ambiguous."],
    ["blocked_permission", "Permission is required."],
    ["blocked_no_target_app", "Could not find the target window."],
    ["blocked_unsupported_instruction", "This action is not supported yet."],
    ["needs_background_agent", "Needs background handling."],
    ["failed_execution", "Operation failed."],
    ["failed_verification", "Verification failed."],
  ];

  for (const [blocker, expected] of cases) {
    const compact = compactMeetingAgentAppControlResult({
      ok: false,
      status: blocker === "needs_background_agent" ? "needs_background_agent" : "blocked",
      blocker,
    });

    assert.equal(compact.blocker, blocker);
    assert.equal(compact.displayText, expected);
    assert.equal(compact.answer_hint_en, expected);
    assert.equal(compact.answer_hint_zh, undefined);
  }
});
