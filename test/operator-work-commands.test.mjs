import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { workRunMessage } from "../packages/core/src/operator/web/workCommands.ts";

test("operator work commands build trimmed work_run payloads", () => {
  assert.deepEqual(workRunMessage("  inspect the browser  "), {
    type: "work_run",
    command: "inspect the browser",
  });
});

test("operator work commands skip blank commands", () => {
  assert.equal(workRunMessage("  \n\t "), null);
});
