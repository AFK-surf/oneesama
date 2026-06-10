export type WorkJobRiskLevel = "read_only" | "write";

export type WorkJobPostConditionKind =
  | "url_includes"
  | "text_present"
  | "text_absent"
  | "element_present";

export interface WorkJobPostCondition {
  kind: WorkJobPostConditionKind;
  value: string;
}

export type WorkJobSource = "operator_command" | "intent_compiler" | "fixture";

/**
 * Backend-agnostic typed work job (RFC D10): the frozen seam between intent
 * compilation upstream and surface execution downstream. Nothing in here may
 * reference a concrete backend (CDP refs, AX paths) — those live in
 * operations resolved per-step against an observation.
 */
export interface WorkJob {
  schema: "oneesama.work_job.v1";
  id: string;
  surfaceId: string;
  intent: string;
  constraints: string[];
  postConditions: WorkJobPostCondition[];
  riskLevel: WorkJobRiskLevel;
  source: WorkJobSource;
  createdAt: string;
}

export interface WorkJobValidation {
  ok: boolean;
  errors: string[];
  job?: WorkJob;
}

const POST_CONDITION_KINDS = new Set<WorkJobPostConditionKind>([
  "url_includes",
  "text_present",
  "text_absent",
  "element_present",
]);
const RISK_LEVELS = new Set<WorkJobRiskLevel>(["read_only", "write"]);
const JOB_SOURCES = new Set<WorkJobSource>(["operator_command", "intent_compiler", "fixture"]);

export function validateWorkJob(input: unknown): WorkJobValidation {
  const errors: string[] = [];
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  if (!raw) return { ok: false, errors: ["job_not_object"] };
  const id = String(raw.id || "").trim();
  if (!id) errors.push("job_id_required");
  const surfaceId = String(raw.surfaceId || "").trim();
  if (!surfaceId) errors.push("job_surface_id_required");
  const intent = String(raw.intent || "").trim();
  if (!intent) errors.push("job_intent_required");
  const riskLevel = String(raw.riskLevel || "read_only") as WorkJobRiskLevel;
  if (!RISK_LEVELS.has(riskLevel)) errors.push(`job_risk_level_invalid:${riskLevel}`);
  const source = String(raw.source || "operator_command") as WorkJobSource;
  if (!JOB_SOURCES.has(source)) errors.push(`job_source_invalid:${source}`);
  const rawConditions = Array.isArray(raw.postConditions) ? raw.postConditions : [];
  const postConditions: WorkJobPostCondition[] = [];
  for (const [index, entry] of rawConditions.entries()) {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const kind = String(record?.kind || "") as WorkJobPostConditionKind;
    const value = String(record?.value || "").trim();
    if (!POST_CONDITION_KINDS.has(kind)) {
      errors.push(`job_post_condition_kind_invalid:${index}`);
      continue;
    }
    if (!value) {
      errors.push(`job_post_condition_value_required:${index}`);
      continue;
    }
    postConditions.push({ kind, value });
  }
  if (postConditions.length === 0) errors.push("job_post_conditions_required");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors,
    job: {
      schema: "oneesama.work_job.v1",
      id,
      surfaceId,
      intent,
      constraints: Array.isArray(raw.constraints) ? raw.constraints.map((c) => String(c)) : [],
      postConditions,
      riskLevel,
      source,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    },
  };
}
