// Supervised live AX run (RFC AX3): drive a REAL macOS app via kwwk-cu, with
// the operator's OpenAI stepwise planner on top of WorkSurfacePort.
//
//   vp run work:ax-live -- "open the link back to search" --app "Google Chrome"
//
// ⚠️ This moves the REAL cursor/keyboard on your desktop and acts inside the
// target app. Run it supervised. Requires:
//   - macOS Accessibility permission for the kwwk-cu helper (granted already
//     if `state` returns app data).
//   - an OpenAI key (loaded from ~/.config/oneesama/live-env or env).
//   - the target app open and showing what you want operated.
//
// Read-only by default unless you pass --act (so you can inspect the observed
// state + the planner's first proposed operation without touching anything).
import { loadLanOperatorBackendLiveEnv } from "../packages/core/src/operator/lan-operator-backend-live-env.ts";
import { createWorkExecutor } from "../packages/core/src/work/work-executor.ts";
import { compileWorkIntent } from "../packages/core/src/work/work-intent-compiler.ts";
import { createOpenAIWorkPlanner } from "../packages/core/src/work/work-openai-planner.ts";
import { createWorkAxSurface } from "../packages/core/src/work/work-ax-surface.ts";
import { createKwwkStdioTransport } from "../packages/core/src/work/work-ax-transport.ts";

const args = { command: "", app: "Google Chrome", act: false, maxSteps: 8 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--app") args.app = String(process.argv[++i] || args.app);
  else if (a === "--act") args.act = true;
  else if (a === "--max-steps") args.maxSteps = Math.max(1, Number(process.argv[++i] || 8));
  else if (!a.startsWith("--") && !args.command) args.command = a;
}
if (!args.command) {
  console.error('usage: vp run work:ax-live -- "<command>" --app "<App Name>" [--act]');
  process.exit(2);
}

loadLanOperatorBackendLiveEnv();

console.log(`\n[1/4] intent: ${JSON.stringify(args.command)}`);
const compilation = await compileWorkIntent(args.command);
if (compilation.decision !== "job" || !compilation.job) {
  console.log(`  -> not_a_command (${compilation.reason})`);
  process.exit(1);
}
console.log(`  -> job: ${compilation.job.intent}`);
console.log(
  `     verify: ${compilation.job.postConditions.map((c) => `${c.kind}:${c.value}`).join("; ")}`,
);

console.log(
  `\n[2/4] kwwk-cu AX backend, target app: ${args.app} (${args.act ? "LIVE ACT" : "observe-only"})`,
);
const transport = await createKwwkStdioTransport();
const surface = createWorkAxSurface({ app: args.app, transport });

try {
  const obs = await surface.observe();
  const refCount = obs.refs.length;
  console.log(`\n[3/4] observation: ${refCount} elements, url=${obs.url || "(n/a)"}`);
  console.log(`     title: ${obs.title}`);
  if (refCount === 0) {
    console.log("     (no elements — is the app focused and showing content? AX/permissions?)");
  }

  if (!args.act) {
    // Read-only: show what the planner WOULD do first, without acting.
    const planner = createOpenAIWorkPlanner({ baseUrlHint: args.app });
    const first = await planner.decide({ job: compilation.job, observation: obs, steps: [] });
    console.log(`\n[4/4] planner's first proposed operation (NOT executed):`);
    console.log(`     ${JSON.stringify(first)}`);
    console.log(`\n(observe-only. re-run with --act to let it drive the desktop.)`);
  } else {
    console.log(`\n[3/4] executing (real cursor) …`);
    const executor = createWorkExecutor({
      surface,
      planner: createOpenAIWorkPlanner({ baseUrlHint: args.app }),
      maxSteps: args.maxSteps,
      onEvent: (event) => {
        if (event.type === "operation" && event.operation) {
          const op = event.operation;
          console.log(
            `  step ${event.step}: ${op.type}${op.target?.ref ? ` ref=${op.target.ref}` : ""}` +
              `${op.value ? ` ${JSON.stringify(String(op.value).slice(0, 40))}` : ""}` +
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
      `\n[4/4] ${result.status.toUpperCase()} — ${result.steps.length} steps, ${result.totalMs}ms`,
    );
    for (const c of result.postConditions)
      console.log(`  ${c.ok ? "✓" : "✗"} ${c.condition.kind}: ${c.condition.value}`);
    if (result.extracted) console.log(`  extracted: ${result.extracted.slice(0, 300)}`);
    if (result.blocker) console.log(`  blocker: ${result.blocker}`);
    process.exitCode = result.status === "done" ? 0 : 1;
  }
} finally {
  await transport.close();
}
