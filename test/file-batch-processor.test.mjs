import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "vite-plus/test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts/file-batch-processor.mjs");
const originalRequest = "用 codex 帮我写个脚本处理这批文件";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "oneesama-file-batch-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runProcessor(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("file-batch-processor pretty-prints JSON and records the original request", async () => {
  await withTempDir(async (dir) => {
    const inputDir = join(dir, "input");
    const outputDir = join(dir, "out");
    const summaryPath = join(dir, "summary.json");
    const logPath = join(dir, "events.jsonl");
    await mkdir(join(inputDir, "nested"), { recursive: true });
    await writeFile(join(inputDir, "nested", "case.json"), '{"z":1,"a":[2]}');

    const result = runProcessor([
      "--input",
      inputDir,
      "--output",
      outputDir,
      "--ext",
      ".json",
      "--operation",
      "pretty-json",
      "--write",
      "--summary",
      summaryPath,
      "--log",
      logPath,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(
      await readFile(join(outputDir, "nested", "case.json"), "utf8"),
      '{\n  "z": 1,\n  "a": [\n    2\n  ]\n}\n',
    );

    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    assert.equal(summary.request, originalRequest);
    assert.equal(summary.counts.written, 1);
    assert.equal(summary.counts.error, 0);
  });
});

test("file-batch-processor reads file lists relative to the list file and filters by extension", async () => {
  await withTempDir(async (dir) => {
    const inputDir = join(dir, "input");
    const listDir = join(dir, "lists");
    const manifestPath = join(dir, "manifest.json");
    await mkdir(inputDir, { recursive: true });
    await mkdir(listDir, { recursive: true });
    await writeFile(join(inputDir, "fixture.json"), '{"ok":true}\n');
    await writeFile(join(inputDir, "notes.txt"), "skip me\n");
    await writeFile(join(listDir, "inputs.txt"), "../input/fixture.json\n../input/notes.txt\n");

    const result = runProcessor([
      "--file-list",
      join(listDir, "inputs.txt"),
      "--operation",
      "metadata",
      "--manifest",
      manifestPath,
      "--ext",
      ".json",
      "--log",
      join(dir, "events.jsonl"),
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].path, "fixture.json");
    assert.equal(manifest[0].format.kind, "json");
  });
});

test("file-batch-processor protects existing outputs unless overwrite is enabled", async () => {
  await withTempDir(async (dir) => {
    const inputPath = join(dir, "demo.txt");
    const outputDir = join(dir, "out");
    const outputPath = join(outputDir, "demo.bak.txt");
    await mkdir(outputDir, { recursive: true });
    await writeFile(inputPath, "new\n");
    await writeFile(outputPath, "old\n");

    const blocked = runProcessor([
      "--files",
      inputPath,
      "--output",
      outputDir,
      "--operation",
      "rename",
      "--rename-template",
      "{base}.bak{ext}",
      "--write",
      "--log",
      join(dir, "blocked.jsonl"),
    ]);

    assert.equal(blocked.status, 1);
    assert.equal(await readFile(outputPath, "utf8"), "old\n");

    const overwritten = runProcessor([
      "--files",
      inputPath,
      "--output",
      outputDir,
      "--operation",
      "rename",
      "--rename-template",
      "{base}.bak{ext}",
      "--write",
      "--overwrite",
      "--log",
      join(dir, "overwritten.jsonl"),
    ]);

    assert.equal(overwritten.status, 0, overwritten.stderr || overwritten.stdout);
    assert.equal(await readFile(outputPath, "utf8"), "new\n");
    assert.equal(await pathExists(join(outputDir, "demo.txt")), false);
  });
});
