import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { realtimeLiveRoutingSmokePlan } from "../src/cli/realtime-tools.ts";

test("Realtime live routing smoke defaults to the live-safe Meet tool surface", () => {
  const plan = realtimeLiveRoutingSmokePlan();
  const names = new Set(plan.toolNames);
  const expectedTools = new Set(plan.cases.flatMap((entry) => entry.expectedTools));

  assert.ok(names.has("share_existing_app_window"));
  assert.ok(names.has("kwwk_computer_use"));
  assert.equal(names.has("control_shared_app_window"), false);
  assert.ok(names.has("list_shareable_windows"));
  assert.ok(names.has("stop_video_stage"));
  assert.equal(names.has("open_shared_browser_surface"), false);
  assert.equal(names.has("create_shared_workspace"), false);
  assert.equal(names.has("control_shared_browser_surface"), false);
  assert.equal(names.has("stop_shared_browser_surface"), false);
  assert.equal(expectedTools.has("open_shared_browser_surface"), false);
  assert.equal(expectedTools.has("create_shared_workspace"), false);
  assert.equal(expectedTools.has("stop_shared_browser_surface"), false);
});

test("Realtime live routing smoke keeps browser-surface cases behind explicit opt-in", () => {
  const plan = realtimeLiveRoutingSmokePlan({ includeDemoSurfaceRouting: true });
  const names = new Set(plan.toolNames);
  const ids = new Set(plan.cases.map((entry) => entry.id));

  assert.ok(plan.includeDemoSurfaceRouting);
  assert.ok(names.has("open_shared_browser_surface"));
  assert.ok(names.has("create_shared_workspace"));
  assert.ok(names.has("stop_shared_browser_surface"));
  assert.ok(ids.has("browser_url"));
  assert.ok(ids.has("generate_snake"));
  assert.ok(ids.has("create_dashboard"));
});
