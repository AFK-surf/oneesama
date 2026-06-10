import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

import { compileWorkIntent } from "../packages/core/src/work/work-intent-compiler.ts";

const CORPUS_PATH = fileURLToPath(new URL("./fixtures/work/intent-corpus.jsonl", import.meta.url));

function loadCorpus() {
  return readFileSync(CORPUS_PATH, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// D9 gate 2: intent compilation ≥95% exact-match with ZERO distractor
// false-triggers (a false action is worse than a miss). Grammar-only —
// deterministic and offline, so it can hard-gate CI.
test("intent compiler meets the D9 gate on the committed corpus", async () => {
  const corpus = loadCorpus();
  const commands = corpus.filter((entry) => entry.expected === "job");
  const distractors = corpus.filter((entry) => entry.expected === "not_a_command");
  assert.ok(commands.length >= 30, `expected >=30 commands, found ${commands.length}`);
  assert.ok(distractors.length >= 20, `expected >=20 distractors, found ${distractors.length}`);

  const misses = [];
  const falseTriggers = [];
  const queryMisses = [];
  for (const entry of corpus) {
    const compilation = await compileWorkIntent(entry.transcript);
    if (entry.expected === "job") {
      if (compilation.decision !== "job") {
        misses.push(entry.transcript);
      } else {
        assert.ok(compilation.job, `job missing for: ${entry.transcript}`);
        assert.equal(compilation.job.riskLevel, "read_only");
        if (
          entry.queryIncludes &&
          !compilation.query.toLowerCase().includes(String(entry.queryIncludes).toLowerCase())
        ) {
          queryMisses.push(`${entry.transcript} -> ${compilation.query}`);
        }
      }
    } else if (compilation.decision !== "not_a_command") {
      falseTriggers.push(`${entry.transcript} -> ${compilation.query}`);
    }
  }

  const recall = (commands.length - misses.length) / commands.length;
  assert.equal(
    falseTriggers.length,
    0,
    `false triggers (must be zero): ${JSON.stringify(falseTriggers)}`,
  );
  assert.ok(
    recall >= 0.95,
    `recall ${recall.toFixed(3)} < 0.95; misses: ${JSON.stringify(misses)}`,
  );
  assert.equal(queryMisses.length, 0, `query extraction misses: ${JSON.stringify(queryMisses)}`);
});

test("compiled jobs carry the precision contract", async () => {
  const compilation = await compileWorkIntent("帮我查一下 Fixture Product 2.0 更新了什么");
  assert.equal(compilation.decision, "job");
  const job = compilation.job;
  assert.ok(job);
  assert.equal(job.schema, "oneesama.work_job.v1");
  assert.equal(job.source, "intent_compiler");
  assert.ok(job.postConditions.length >= 1);
  assert.match(job.intent, /Research and explain/);
});
