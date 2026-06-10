import { WORK_OPERATION_TYPES } from "./work-operations.ts";
import type { WorkPlannerDecideInput, WorkPlannerPort } from "./work-planner.ts";

export interface OpenAIWorkPlannerOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Work-surface base URL hint inserted into the system prompt (e.g. the fixture site). */
  baseUrlHint?: string;
  fetchImpl?: typeof fetch;
  maxCompletionTokens?: number;
}

export function defaultWorkPlannerModel(env: NodeJS.ProcessEnv = process.env) {
  return env.MAB_WORK_PLANNER_MODEL || env.MAB_CODEX_MODEL || "gpt-5.5";
}

function defaultApiKey(env: NodeJS.ProcessEnv = process.env) {
  return env.ONEESAMA_OPENAI_API_KEY || env.MAB_OPENAI_API_KEY || env.OPENAI_API_KEY || "";
}

function defaultBaseUrl(env: NodeJS.ProcessEnv = process.env) {
  return (
    env.ONEESAMA_OPENAI_BASE_URL ||
    env.MAB_OPENAI_BASE_URL ||
    "https://api.openai.com/v1"
  ).replace(/\/$/u, "");
}

const SYSTEM_PROMPT = (
  startHint: string,
) => `You operate a work browser for a precise meeting assistant. Each turn you
receive the job intent, the current page observation (an outline where every
actionable element carries [ref=eN]), and the step history. Respond with
EXACTLY ONE JSON object for the single next operation:

{"type": "<one of: ${WORK_OPERATION_TYPES.join(", ")}>",
 "target": {"ref": "eN"},        // required for click / type-text / set-value / extract
 "value": "...",                 // navigate: url; type-text/set-value: text; press-key: key; wait-for: text; scroll: up|down
 "rationale": "...",             // one short line, shown on the shared cursor
 "summary": "...",               // ONLY with type "done": 1-2 sentences answering the intent from extracted text
 "blocker": "..."}               // ONLY with type "blocked": why the job cannot proceed

Rules, in priority order:
1. Precision over speed. Only use refs that appear in the CURRENT observation.
   Never invent refs or URLs.
2. ${startHint}
3. Typical research flow: navigate to the search page, type the query into the
   search textbox, click the search button, click the most relevant result
   link, extract the passage (text ref) that answers the intent, then done.
4. Before "done", you must have extracted the supporting passage with
   "extract". The summary must come from extracted text, not memory.
5. If two steps in a row made no progress, prefer "blocked" with a clear
   blocker over guessing.`;

function userPrompt(input: WorkPlannerDecideInput) {
  const history = input.steps
    .map(
      (step) =>
        `${step.step}. ${step.operation.type}` +
        `${step.operation.target?.ref ? ` ref=${step.operation.target.ref}` : ""}` +
        `${step.operation.value ? ` value=${JSON.stringify(step.operation.value.slice(0, 60))}` : ""}` +
        ` -> ${step.ok ? "ok" : `FAILED:${step.error || step.blocked || ""}`}` +
        `${step.extracted ? ` extracted=${JSON.stringify(step.extracted.slice(0, 120))}` : ""}`,
    )
    .join("\n");
  return `JOB INTENT: ${input.job.intent}
CONSTRAINTS: ${input.job.constraints.join("; ") || "none"}
POST-CONDITIONS TO SATISFY: ${input.job.postConditions
    .map((condition) => `${condition.kind}:${condition.value}`)
    .join("; ")}

CURRENT PAGE: ${input.observation.title} (${input.observation.url})
OBSERVATION:
${input.observation.outline || "(empty page)"}

STEP HISTORY:
${history || "(no steps yet)"}

Next operation (one JSON object only):`;
}

/** Live stepwise planner on OpenAI chat completions (RFC D4/D5/D7). */
export function createOpenAIWorkPlanner(options: OpenAIWorkPlannerOptions = {}): WorkPlannerPort {
  const apiKey = options.apiKey ?? defaultApiKey();
  const baseUrl = options.baseUrl ?? defaultBaseUrl();
  const model = options.model ?? defaultWorkPlannerModel();
  const fetchImpl = options.fetchImpl ?? fetch;
  const startHint = options.baseUrlHint
    ? `The work site lives at ${options.baseUrlHint} — start research at ${options.baseUrlHint}/search.html when you are not already on a useful page.`
    : "Start from the page you are on.";

  return {
    id: `openai_work_planner(${model})`,
    async decide(input) {
      if (!apiKey) {
        return {
          schema: "oneesama.work_operation.v1",
          type: "blocked",
          blocker: "openai_api_key_missing",
        };
      }
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT(startHint) },
            { role: "user", content: userPrompt(input) },
          ],
          response_format: { type: "json_object" },
          max_completion_tokens: options.maxCompletionTokens ?? 2000,
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          schema: "oneesama.work_operation.v1",
          type: "blocked",
          blocker: `openai_planner_http_${response.status}:${body.slice(0, 160)}`,
        };
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content || "";
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        return { schema: "oneesama.work_operation.v1", ...parsed } as never;
      } catch {
        return {
          schema: "oneesama.work_operation.v1",
          type: "blocked",
          blocker: `openai_planner_invalid_json:${content.slice(0, 120)}`,
        };
      }
    },
  };
}
