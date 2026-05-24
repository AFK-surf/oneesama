import assert from "node:assert/strict";
import test from "node:test";

import { createAgentRunner } from "../packages/core/src/agent-runner/agent-runner.ts";

async function withMockFetch(mock, fn) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function hangingFetch(_url, init = {}) {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
}

async function waitForRunnerJob(runner, jobId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = runner.getJob(jobId);
    if (last && ["completed", "failed", "timeout"].includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${jobId}: ${JSON.stringify(last)}`);
}

function nodeCommand(source) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

test("command agent runner marks hanging jobs as timeout", async () => {
  const runner = createAgentRunner({
    provider: "command",
    env: {
      ...process.env,
      MAB_AGENT_RUNNER: "command",
      MAB_AGENT_COMMAND: nodeCommand("setTimeout(() => {}, 10000);"),
      MAB_AGENT_RUNNER_TIMEOUT_MS: "50",
    },
  });

  const job = await runner.startTask({ task: "hang", mode: "smoke" });
  const completed = await waitForRunnerJob(runner, job.id);

  assert.equal(completed.status, "timeout");
  assert.match(completed.error, /timed out after 50ms/);
});

test("command agent runner caps command output", async () => {
  const runner = createAgentRunner({
    provider: "command",
    env: {
      ...process.env,
      MAB_AGENT_RUNNER: "command",
      MAB_AGENT_COMMAND: nodeCommand("process.stdout.write('x'.repeat(100));"),
      MAB_AGENT_RUNNER_OUTPUT_MAX_BYTES: "16",
    },
  });

  const job = await runner.startTask({ task: "large output", mode: "smoke" });
  const completed = await waitForRunnerJob(runner, job.id);

  assert.equal(completed.status, "completed");
  assert.equal(completed.result, `${"x".repeat(16)}\n[output truncated]`);
});

test("HTTP agent runner marks hanging requests as timeout", async () => {
  await withMockFetch(
    hangingFetch,
    async () => {
      const runner = createAgentRunner({
        provider: "http",
        env: {
          ...process.env,
          MAB_AGENT_RUNNER: "http",
          MAB_AGENT_HTTP_URL: "https://example.invalid/agent",
          MAB_AGENT_RUNNER_TIMEOUT_MS: "50",
        },
      });

      const job = await runner.startTask({ task: "hang", mode: "smoke" });
      const completed = await waitForRunnerJob(runner, job.id);

      assert.equal(completed.status, "timeout");
      assert.match(completed.error, /timed out after 50ms/);
    },
  );
});
