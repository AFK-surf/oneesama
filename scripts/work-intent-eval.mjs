// Intent-compile eval (RFC P1.6 / D9 gate 2): recall + zero-false-trigger
// numbers over the committed corpus.
//
//   vp run eval:work-intent
//
// Flags: --json-out path        artifact (default /tmp/oneesama-work-intent-eval-latest.json)
//        --append-history       append to test/evals/work-intent-history.jsonl
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileWorkIntent } from "../packages/core/src/work/work-intent-compiler.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_PATH = join(ROOT, "test/fixtures/work/intent-corpus.jsonl");
const HISTORY_PATH = join(ROOT, "test/evals/work-intent-history.jsonl");

const args = { jsonOut: "/tmp/oneesama-work-intent-eval-latest.json", appendHistory: false };
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--json-out") args.jsonOut = String(process.argv[++i] || args.jsonOut);
  else if (process.argv[i] === "--append-history") args.appendHistory = true;
}

const corpus = readFileSync(CORPUS_PATH, "utf8")
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const report = {
  schema: "oneesama.work_intent_eval.v1",
  generatedAt: new Date().toISOString(),
  corpusSize: corpus.length,
  commands: 0,
  distractors: 0,
  hits: 0,
  misses: [],
  falseTriggers: [],
  queryMisses: [],
  recall: 0,
  falseTriggerRate: 0,
};

for (const entry of corpus) {
  const compilation = await compileWorkIntent(entry.transcript);
  if (entry.expected === "job") {
    report.commands += 1;
    if (compilation.decision !== "job") {
      report.misses.push(entry.transcript);
    } else {
      report.hits += 1;
      if (
        entry.queryIncludes &&
        !compilation.query.toLowerCase().includes(String(entry.queryIncludes).toLowerCase())
      ) {
        report.queryMisses.push(`${entry.transcript} -> ${compilation.query}`);
      }
    }
  } else {
    report.distractors += 1;
    if (compilation.decision !== "not_a_command") {
      report.falseTriggers.push(`${entry.transcript} -> ${compilation.query}`);
    }
  }
}

report.recall = report.commands > 0 ? report.hits / report.commands : 0;
report.falseTriggerRate =
  report.distractors > 0 ? report.falseTriggers.length / report.distractors : 0;

writeFileSync(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `work-intent-eval corpus=${report.corpusSize} recall=${(report.recall * 100).toFixed(1)}% ` +
    `falseTriggers=${report.falseTriggers.length} queryMisses=${report.queryMisses.length}`,
);
console.log(`artifact: ${args.jsonOut}`);

if (args.appendHistory) {
  mkdirSync(dirname(HISTORY_PATH), { recursive: true });
  appendFileSync(
    HISTORY_PATH,
    `${JSON.stringify({
      ts: report.generatedAt,
      corpusSize: report.corpusSize,
      recall: report.recall,
      falseTriggers: report.falseTriggers.length,
    })}\n`,
  );
}

const gateOk = report.recall >= 0.95 && report.falseTriggers.length === 0;
if (!gateOk) {
  console.error(
    "D9 GATE FAILED:",
    JSON.stringify({ misses: report.misses, falseTriggers: report.falseTriggers }),
  );
}
process.exit(gateOk ? 0 : 1);
