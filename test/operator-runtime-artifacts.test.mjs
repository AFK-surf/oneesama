import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  copyRuntimeReportText,
  downloadRuntimeReportText,
  runtimeReportFilename,
} from "../packages/core/src/operator/web/operatorRuntimeArtifacts.ts";

test("operator runtime artifacts copy report text and return text length", async () => {
  const writes = [];
  const length = await copyRuntimeReportText({
    fetchReportText: async () => '{"ok":true}',
    clipboard: { writeText: async (text) => writes.push(text) },
  });

  assert.equal(length, 11);
  assert.deepEqual(writes, ['{"ok":true}']);
});

test("operator runtime artifacts ignore clipboard write failures", async () => {
  const length = await copyRuntimeReportText({
    fetchReportText: async () => "report",
    clipboard: {
      writeText: async () => {
        throw new Error("clipboard denied");
      },
    },
  });

  assert.equal(length, 6);
});

test("operator runtime artifacts download report text and revoke object URL", async () => {
  const calls = [];
  let createdBlob = null;
  const anchor = {
    href: "",
    download: "",
    click: () => calls.push(["click", anchor.href, anchor.download]),
  };

  await downloadRuntimeReportText({
    fetchReportText: async () => '{"report":true}',
    document: { createElement: () => anchor },
    url: {
      createObjectURL: (blob) => {
        createdBlob = blob;
        calls.push(["createObjectURL"]);
        return "blob:operator-report";
      },
      revokeObjectURL: (href) => calls.push(["revokeObjectURL", href]),
    },
    nowMs: 1234,
  });

  assert.equal(await createdBlob.text(), '{"report":true}');
  assert.equal(createdBlob.type, "application/json");
  assert.deepEqual(calls, [
    ["createObjectURL"],
    ["click", "blob:operator-report", "lan-operator-report-1234.json"],
    ["revokeObjectURL", "blob:operator-report"],
  ]);
});

test("operator runtime artifacts build deterministic report filenames", () => {
  assert.equal(runtimeReportFilename(42), "lan-operator-report-42.json");
});
