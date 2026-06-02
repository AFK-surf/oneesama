function normalizedStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase();
}

function instructionWithoutNegativeClauses(value = "") {
  return String(value || "")
    .replace(/\bdo\s+not\b[^.;。；]*/giu, "")
    .replace(/\bdon't\b[^.;。；]*/giu, "")
    .replace(/不要[^.;。；]*/gu, "")
    .replace(/别[^.;。；]*/gu, "");
}

export function appControlStatusHasCompactBlocker(value = {}) {
  const status = normalizedStatus(value.status);
  if (!["blocked", "failed"].includes(status) || value.ok === true) return false;
  const blocker = String(value.blocker || "").trim();
  if (!blocker) return false;
  if (["app_control_timeout", "timeout", "stale"].includes(blocker.toLowerCase())) return false;
  return blocker.length <= 240;
}

export function appControlInstructionNeedsNonObserveAction(instruction = "") {
  const lower = instructionWithoutNegativeClauses(instruction).toLowerCase();
  if (!lower.trim()) return false;
  return /click|press|type|scroll|drag|switch|close|open|navigate|change|edit|draw|handle|点击|点一下|按|敲|输入|键入|滚动|下滑|上滑|拖|切换|关闭|打开|导航|改变|编辑|画|绘制|处理/u.test(
    lower,
  );
}

export function appControlActionsHaveNonObserveAction(actions = []) {
  if (!Array.isArray(actions)) return false;
  return actions.some((action) => {
    const normalized = String(action || "")
      .trim()
      .toLowerCase();
    return normalized !== "" && normalized !== "observe" && normalized !== "state";
  });
}

export function appControlActionSemanticsPass(value = {}, options = {}) {
  if (!appControlInstructionNeedsNonObserveAction(options.instruction || "")) return true;
  if (appControlStatusHasCompactBlocker(value)) return true;
  return appControlActionsHaveNonObserveAction(value.actions);
}
