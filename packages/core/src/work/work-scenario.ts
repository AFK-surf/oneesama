import type { WorkJob } from "./work-job.ts";
import { validateWorkJob } from "./work-job.ts";
import type { WorkOperation } from "./work-operations.ts";
import type { WorkPlannerPort, WorkPlannerRecord } from "./work-planner.ts";

/**
 * Recordings must be port-agnostic: the fixture server picks an ephemeral
 * port per session, so URLs are normalized to this placeholder on write and
 * substituted back on load.
 */
export const WORK_FIXTURE_BASE_PLACEHOLDER = "{{FIXTURE_BASE}}";

export function serializeWorkPlannerRecords(records: WorkPlannerRecord[], baseUrl: string): string {
  return `${JSON.stringify(records, null, 2).replaceAll(baseUrl, WORK_FIXTURE_BASE_PLACEHOLDER)}\n`;
}

export function parseWorkPlannerRecords(text: string, baseUrl: string): WorkPlannerRecord[] {
  return JSON.parse(text.replaceAll(WORK_FIXTURE_BASE_PLACEHOLDER, baseUrl)) as WorkPlannerRecord[];
}

/**
 * A committed, deterministic family-A scenario: the unit of the execution
 * success-rate matrix (RFC P0.2/D8). Evals run only against fixture pages;
 * live demos use real sites and are never part of the gate.
 */
export interface WorkScenario {
  schema: "oneesama.work_scenario.v1";
  id: string;
  description: string;
  job: WorkJob;
  /**
   * Deterministic plan hints for the fixture planner: enough to act like an
   * "ideal LLM" offline. Live planners ignore this.
   */
  fixturePlan: {
    query: string;
    resultLink: string;
    passageNeedle: string;
    summary: string;
  };
}

export interface WorkScenarioValidation {
  ok: boolean;
  errors: string[];
  scenario?: WorkScenario;
}

export function validateWorkScenario(input: unknown): WorkScenarioValidation {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  if (!raw) return { ok: false, errors: ["scenario_not_object"] };
  const errors: string[] = [];
  const id = String(raw.id || "").trim();
  if (!id) errors.push("scenario_id_required");
  const jobValidation = validateWorkJob(raw.job);
  if (!jobValidation.ok || !jobValidation.job) {
    errors.push(...jobValidation.errors.map((error) => `job:${error}`));
  }
  const plan =
    raw.fixturePlan && typeof raw.fixturePlan === "object"
      ? (raw.fixturePlan as Record<string, unknown>)
      : null;
  for (const key of ["query", "resultLink", "passageNeedle", "summary"]) {
    if (!String(plan?.[key] || "").trim()) errors.push(`fixture_plan_${key}_required`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors,
    scenario: {
      schema: "oneesama.work_scenario.v1",
      id,
      description: String(raw.description || ""),
      job: jobValidation.job as WorkJob,
      fixturePlan: {
        query: String(plan?.query),
        resultLink: String(plan?.resultLink),
        passageNeedle: String(plan?.passageNeedle),
        summary: String(plan?.summary),
      },
    },
  };
}

function operation(type: WorkOperation["type"], extra: Partial<WorkOperation>): WorkOperation {
  return { schema: "oneesama.work_operation.v1", type, ...extra };
}

/**
 * Deterministic "ideal planner" for a scenario: resolves refs from the live
 * observation like a real planner, but follows the committed plan hints.
 * Used to bring the harness up and to smoke the record/replay machinery;
 * live LLM planners replace it behind the same port.
 */
export function createFixturePlanPlanner(scenario: WorkScenario, baseUrl: string): WorkPlannerPort {
  const plan = scenario.fixturePlan;
  return {
    id: `fixture_plan(${scenario.id})`,
    async decide({ observation, steps }) {
      const find = (role: string, needle: string) =>
        observation.refs.find((ref) => ref.role === role && ref.name.includes(needle));
      switch (steps.length) {
        case 0:
          return operation("navigate", { value: `${baseUrl}/search.html` });
        case 1: {
          const input = find("textbox", "Search query");
          return operation("type-text", {
            target: { ref: input?.ref || "" },
            value: plan.query,
            rationale: "enter search query",
          });
        }
        case 2: {
          const button = find("button", "Search");
          return operation("click", {
            target: { ref: button?.ref || "" },
            rationale: "run search",
          });
        }
        case 3: {
          const link = find("link", plan.resultLink);
          return operation("click", {
            target: { ref: link?.ref || "" },
            rationale: `open ${plan.resultLink}`,
          });
        }
        case 4: {
          const passage = find("text", plan.passageNeedle);
          return operation("extract", {
            target: { ref: passage?.ref || "" },
            rationale: "highlight the key passage",
          });
        }
        default:
          return operation("done", { summary: plan.summary });
      }
    },
  };
}
