// Typed acceptance entry for the work pipeline: one typed command, full loop.
//
//   vp run work:try -- "帮我查一下 Fixture Product 2.0 更新了什么"
//   vp run work:try -- "look up the team plan pricing" --headed
//
// Prints the intent compilation, narrates every planner step, and ends with
// the verified result + the passage the assistant would speak. Runs against
// the committed fixture site by default (--base <url> to point elsewhere,
// e.g. a real site; allowed hosts follow the base URL's host).
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

import { loadLanOperatorBackendLiveEnv } from "../packages/core/src/operator/lan-operator-backend-live-env.ts";
import { createWorkBrowserSurface } from "../packages/core/src/work/work-browser-surface.ts";
import { createWorkExecutor } from "../packages/core/src/work/work-executor.ts";
import { startWorkFixtureServer } from "../packages/core/src/work/work-fixture-server.ts";
import { compileWorkIntent } from "../packages/core/src/work/work-intent-compiler.ts";
import { createOpenAIWorkPlanner } from "../packages/core/src/work/work-openai-planner.ts";

const args = { utterance: "", headed: false, base: "", jsonOut: "" };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--headed") args.headed = true;
  else if (arg === "--base") args.base = String(process.argv[++i] || "");
  else if (arg === "--json-out") args.jsonOut = String(process.argv[++i] || "");
  else if (!arg.startsWith("--") && !args.utterance) args.utterance = arg;
}
if (!args.utterance) {
  console.error('usage: vp run work:try -- "帮我查一下 Fixture Product 2.0 更新了什么" [--headed]');
  process.exit(2);
}

loadLanOperatorBackendLiveEnv();

console.log(`\n[1/4] 意图编译: ${JSON.stringify(args.utterance)}`);
const compilation = await compileWorkIntent(args.utterance);
if (compilation.decision !== "job" || !compilation.job) {
  console.log(`  -> not_a_command (${compilation.reason}) — 不是工作指令，不执行。`);
  process.exit(1);
}
console.log(`  -> job: ${compilation.job.intent}`);
console.log(
  `     post-conditions: ${compilation.job.postConditions.map((c) => `${c.kind}:${c.value}`).join("; ")}`,
);

const fixture = args.base
  ? null
  : await startWorkFixtureServer(new URL("../test/fixtures/work", import.meta.url).pathname);
const baseUrl = args.base || fixture.url;
const allowedHosts = [new URL(baseUrl).hostname, "localhost", "127.0.0.1"];

console.log(
  `\n[2/4] 工作浏览器启动 (${args.headed ? "headed" : "headless"}), 工作站点: ${baseUrl}`,
);
const browser = await chromium.launch({ headless: !args.headed });
const page = await browser.newPage();
const surface = createWorkBrowserSurface({
  page,
  surfaceId: compilation.job.surfaceId,
  allowedHosts,
  onCursor: (event) => {
    console.log(
      `     🖱  cursor ${event.kind} @ (${event.x.toFixed(2)}, ${event.y.toFixed(2)}) — ${event.label}`,
    );
  },
});

console.log(`\n[3/4] 步进执行 (live planner):`);
const executor = createWorkExecutor({
  surface,
  planner: createOpenAIWorkPlanner({ baseUrlHint: baseUrl }),
  maxSteps: 10,
  onEvent: (event) => {
    if (event.type === "operation") {
      const op = event.operation;
      console.log(
        `  step ${event.step}: ${op.type}` +
          `${op.target?.ref ? ` ref=${op.target.ref}` : ""}` +
          `${op.value ? ` value=${JSON.stringify(String(op.value).slice(0, 50))}` : ""}` +
          `${op.rationale ? `  (${op.rationale})` : ""}`,
      );
    }
    if (event.type === "operation_result" && event.result && !event.result.ok) {
      console.log(`     ✗ ${event.result.error || event.result.blocked}`);
    }
  },
});

const result = await executor.run(compilation.job);

console.log(
  `\n[4/4] 结果: ${result.status.toUpperCase()}  (${result.steps.length} 步, ${result.totalMs}ms)`,
);
for (const entry of result.postConditions) {
  console.log(`  ${entry.ok ? "✓" : "✗"} ${entry.condition.kind}: ${entry.condition.value}`);
}
if (result.extracted) {
  console.log(`\n  圈中的内容:\n  "${result.extracted.slice(0, 300)}"`);
}
if (result.summary) console.log(`\n  口头总结底稿: ${result.summary}`);
if (result.blocker) console.log(`  blocker: ${result.blocker}`);

if (args.jsonOut) writeFileSync(args.jsonOut, `${JSON.stringify(result, null, 2)}\n`);

if (args.headed) {
  console.log("\n(headed 模式: 浏览器停留 8 秒供查看)");
  await new Promise((resolve) => setTimeout(resolve, 8000));
}
await surface.close().catch(() => {});
await browser.close();
if (fixture) await fixture.close();
process.exit(result.status === "done" ? 0 : 1);
