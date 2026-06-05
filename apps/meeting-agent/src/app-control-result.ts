function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compactString(value: unknown, maxLength: number) {
  return String(value || "")
    .trim()
    .slice(0, maxLength);
}

function compactActions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((action) => compactString(action, 160))
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeAppControlStatus(value: unknown) {
  return compactString(value, 80).toLowerCase();
}

function appControlStatusIsSuccess(status: string) {
  return status === "completed" || status === "done";
}

function appControlStatusIsPending(status: string) {
  return status === "" || status === "queued" || status === "running";
}

function appControlStatusIsFailure(status: string) {
  return ["failed", "timeout", "blocked", "error", "stale", "canceled", "cancelled"].includes(
    status,
  );
}

function appControlStatusIsTerminalFailure(status: string) {
  if (appControlStatusIsFailure(status)) return true;
  if (appControlStatusIsSuccess(status) || appControlStatusIsPending(status)) return false;
  return true;
}

function appControlDisplayTextEn(ok: boolean, status: string, blocker: string, error: string) {
  if (ok) return "";
  const reason = `${blocker} ${error} ${status}`.trim().toLowerCase();
  if (
    reason.includes("blocked_permission") ||
    reason.includes("permission") ||
    reason.includes("accessibility") ||
    reason.includes("screen_recording")
  ) {
    return "Permission is required.";
  }
  if (reason.includes("blocked_ambiguous_target") || reason.includes("ambiguous")) {
    return "Target is ambiguous.";
  }
  if (
    reason.includes("blocked_no_target_app") ||
    reason.includes("no_target") ||
    reason.includes("target_app") ||
    reason.includes("window_not_found") ||
    reason.includes("shared_window_not_found")
  ) {
    return "Could not find the target window.";
  }
  if (reason.includes("needs_background_agent")) return "Needs background handling.";
  if (
    reason.includes("blocked_unsupported_instruction") ||
    reason.includes("instruction_not_directly_executable") ||
    reason.includes("unsupported_instruction") ||
    reason.includes("unsupported_operation")
  ) {
    return "This action is not supported yet.";
  }
  if (reason.includes("failed_verification")) return "Verification failed.";
  return "Operation failed.";
}

export function compactMeetingAgentAppControlResult(result: unknown) {
  const record = recordValue(result);
  const rawOK = record.ok === true;
  const status = normalizeAppControlStatus(record.status) || (rawOK ? "completed" : "failed");
  const ok = rawOK && !appControlStatusIsTerminalFailure(status);
  const summary = compactString(record.summary, 800);
  const blocker = compactString(record.blocker, 800);
  const error = compactString(record.error, 800) || (ok ? "" : blocker || "app_control_blocked");
  const confidence = Number(record.confidence || 0);
  const actions = compactActions(record.actions);
  const compact: Record<string, unknown> = {
    ok,
    provider: "kwwk",
    status,
  };
  if (summary) compact.summary = summary;
  if (actions.length > 0) compact.actions = actions;
  if (Number.isFinite(confidence) && confidence > 0) compact.confidence = confidence;
  if (blocker) compact.blocker = blocker;
  if (error) compact.error = error;
  const displayText =
    compactString(record.displayText || record.answer_hint_en || record.answer_hint_zh, 80) ||
    appControlDisplayTextEn(ok, status, blocker, error);
  if (displayText) {
    compact.displayText = displayText;
    compact.answer_hint_en = displayText;
  }
  return compact;
}
