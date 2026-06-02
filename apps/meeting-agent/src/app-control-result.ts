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

function appControlDisplayTextZh(ok: boolean, status: string, blocker: string, error: string) {
  if (ok) return "";
  const reason = `${blocker} ${error} ${status}`.trim().toLowerCase();
  if (
    reason.includes("blocked_permission") ||
    reason.includes("permission") ||
    reason.includes("accessibility") ||
    reason.includes("screen_recording")
  ) {
    return "需要权限";
  }
  if (reason.includes("blocked_ambiguous_target") || reason.includes("ambiguous")) {
    return "目标不明确";
  }
  if (
    reason.includes("blocked_no_target_app") ||
    reason.includes("no_target") ||
    reason.includes("target_app") ||
    reason.includes("window_not_found") ||
    reason.includes("shared_window_not_found")
  ) {
    return "找不到窗口";
  }
  if (reason.includes("needs_background_agent")) return "交给后台";
  if (
    reason.includes("blocked_unsupported_instruction") ||
    reason.includes("instruction_not_directly_executable") ||
    reason.includes("unsupported_instruction") ||
    reason.includes("unsupported_operation")
  ) {
    return "暂不支持";
  }
  if (reason.includes("failed_verification")) return "验证失败";
  return "操作失败";
}

export function compactMeetingAgentAppControlResult(result: unknown) {
  const record = recordValue(result);
  const ok = record.ok === true;
  const status = compactString(record.status, 80) || (ok ? "completed" : "failed");
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
    compactString(record.displayText || record.answer_hint_zh, 80) ||
    appControlDisplayTextZh(ok, status, blocker, error);
  if (displayText) {
    compact.displayText = displayText;
    compact.answer_hint_zh = displayText;
  }
  return compact;
}
