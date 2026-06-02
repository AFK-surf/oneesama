import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";

const stdoutProtocolRoots = [
  "meet-runner/src",
  "packages/core/src/meeting",
  "packages/core/src/realtime",
];

async function listSourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(path)));
      continue;
    }
    if (/\.(ts|js)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

test("meet-runner JSON-RPC stdout stays reserved for protocol responses", async () => {
  const files = (await Promise.all(stdoutProtocolRoots.map(listSourceFiles))).flat();
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const matches = [...source.matchAll(/\bconsole\.log\s*\(/g)];
    if (matches.length === 0) continue;
    for (const match of matches) {
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${file}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "meet-runner stdout is the JSON-RPC channel; use console.error/stderr for logs",
  );
});
