export type WorkOperationType =
  | "navigate"
  | "click"
  | "type-text"
  | "set-value"
  | "press-key"
  | "scroll"
  | "wait-for"
  | "extract"
  | "get-app-state"
  | "done"
  | "blocked";

export const WORK_OPERATION_TYPES: WorkOperationType[] = [
  "navigate",
  "click",
  "type-text",
  "set-value",
  "press-key",
  "scroll",
  "wait-for",
  "extract",
  "get-app-state",
  "done",
  "blocked",
];

export interface WorkOperationTarget {
  ref?: string;
  description?: string;
}

export interface WorkOperation {
  schema: "oneesama.work_operation.v1";
  type: WorkOperationType;
  target?: WorkOperationTarget;
  /** navigate: url; type-text/set-value: text; press-key: key name; wait-for: text to appear; scroll: "up" | "down". */
  value?: string;
  /** One-line reason from the planner; surfaces on the cursor label / Intent Card. */
  rationale?: string;
  /** Terminal "done": spoken-summary source text. */
  summary?: string;
  /** Terminal "blocked": why the job cannot proceed. */
  blocker?: string;
}

export interface WorkOperationValidation {
  ok: boolean;
  errors: string[];
  operation?: WorkOperation;
}

const REF_TARGET_TYPES = new Set<WorkOperationType>(["click", "type-text", "set-value", "extract"]);
const VALUE_REQUIRED_TYPES = new Set<WorkOperationType>([
  "navigate",
  "type-text",
  "set-value",
  "press-key",
  "wait-for",
]);

export function validateWorkOperation(input: unknown): WorkOperationValidation {
  const errors: string[] = [];
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  if (!raw) return { ok: false, errors: ["operation_not_object"] };
  const type = String(raw.type || "") as WorkOperationType;
  if (!WORK_OPERATION_TYPES.includes(type)) errors.push(`operation_type_invalid:${type}`);
  const target =
    raw.target && typeof raw.target === "object" ? (raw.target as Record<string, unknown>) : null;
  const ref = target ? String(target.ref || "") : "";
  if (REF_TARGET_TYPES.has(type) && !ref) errors.push(`operation_target_ref_required:${type}`);
  const value = raw.value == null ? "" : String(raw.value);
  if (VALUE_REQUIRED_TYPES.has(type) && !value) errors.push(`operation_value_required:${type}`);
  if (type === "done" && !String(raw.summary || "")) errors.push("operation_summary_required:done");
  if (type === "blocked" && !String(raw.blocker || ""))
    errors.push("operation_blocker_required:blocked");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors,
    operation: {
      schema: "oneesama.work_operation.v1",
      type,
      ...(target
        ? {
            target: {
              ...(ref ? { ref } : {}),
              ...(target.description ? { description: String(target.description) } : {}),
            },
          }
        : {}),
      ...(value ? { value } : {}),
      ...(raw.rationale ? { rationale: String(raw.rationale) } : {}),
      ...(raw.summary ? { summary: String(raw.summary) } : {}),
      ...(raw.blocker ? { blocker: String(raw.blocker) } : {}),
    },
  };
}
