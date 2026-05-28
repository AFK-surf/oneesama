#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const defaultLimits = {
  go: 900,
  goTest: 1200,
  script: 1200,
};

const sourceExtensions = new Set([".cjs", ".go", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const ignoredPrefixes = [
  "node_modules/",
  "runtime/",
  "dist/",
  "coverage/",
  "downloads/",
  "output/",
  "reports/",
  "tmp/",
  "snake-mobile-app/",
];

function gitFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "buffer" },
  );
  return output.toString("utf8").split("\0").filter(Boolean);
}

function extensionOf(file) {
  const match = file.match(/(\.[^.]+)$/);
  return match ? match[1] : "";
}

function shouldCheck(file) {
  if (ignoredPrefixes.some((prefix) => file.startsWith(prefix))) return false;
  if (file.endsWith(".d.ts")) return false;
  return sourceExtensions.has(extensionOf(file));
}

function lineCount(file) {
  const body = readFileSync(file, "utf8");
  if (!body) return 0;
  const parts = body.split(/\r\n|\r|\n/);
  return parts.at(-1) === "" ? parts.length - 1 : parts.length;
}

function limitFor(file) {
  if (file.startsWith("packages/core/src/realtime/realtime-browser-bridge")) {
    return { limit: 500, reason: "realtime-bridge-shard" };
  }
  if (file.endsWith("_test.go")) return { limit: defaultLimits.goTest, reason: "go-test" };
  if (file.endsWith(".go")) return { limit: defaultLimits.go, reason: "go" };
  return { limit: defaultLimits.script, reason: "script" };
}

const checked = [];
const failures = [];
for (const file of gitFiles().filter(shouldCheck)) {
  const lines = lineCount(file);
  const { limit, reason } = limitFor(file);
  checked.push(file);
  if (lines > limit) failures.push({ file, lines, limit, reason });
}

if (failures.length > 0) {
  console.error("Source file line limits exceeded:");
  for (const failure of failures.toSorted((a, b) => b.lines - a.lines)) {
    console.error(
      `  ${failure.file}: ${failure.lines} lines > ${failure.limit} (${failure.reason})`,
    );
  }
  console.error("\nSplit the file until it satisfies the configured hard line limit.");
  process.exit(1);
}

console.log(`Checked ${checked.length} source files against line limits.`);
