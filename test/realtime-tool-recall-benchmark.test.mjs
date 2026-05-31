import assert from "node:assert/strict";
import test from "node:test";

import { scoreCase } from "../scripts/realtime-tool-recall-benchmark.mjs";

test("Realtime tool recall flags assistant text without expected tool as fake execution", () => {
  const score = scoreCase(
    { expectedToolNames: ["list_shareable_windows", "share_existing_app_window"] },
    { calls: [], assistantText: "好的，稍等一下，有结果我会马上告诉你。" },
  );

  assert.equal(score.ok, false);
  assert.equal(score.kind, "positive");
  assert.equal(score.reason, "assistant_text_without_expected_tool");
  assert.equal(score.fakeExecution, true);
});

test("Realtime tool recall passes when expected tool is called before or with assistant text", () => {
  const score = scoreCase(
    { expectedToolNames: ["list_shareable_windows", "share_existing_app_window"] },
    { calls: ["list_shareable_windows"], assistantText: "我先看一下可共享窗口。" },
  );

  assert.equal(score.ok, true);
  assert.equal(score.reason, "expected_tool_called");
  assert.equal(score.fakeExecution, false);
});

test("Realtime tool recall distinguishes silence from fake execution", () => {
  const score = scoreCase(
    { expectedToolNames: ["control_shared_app_window"] },
    { calls: [], assistantText: "" },
  );

  assert.equal(score.ok, false);
  assert.equal(score.reason, "expected_tool_missing");
  assert.equal(score.fakeExecution, false);
});
