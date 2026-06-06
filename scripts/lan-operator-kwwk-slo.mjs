const REQUIRED_KWWK_BLOCKER_PHASES = Object.freeze(["observe", "plan", "execute", "verify"]);

function phaseHasReadableBlocker(entry) {
  const evidence = entry?.evidence || {};
  if (
    entry?.source !== "host_kwwk_helper_probe" ||
    entry?.ok !== true ||
    evidence.thrown === true ||
    !String(entry?.blocker || "")
  )
    return false;
  if (entry.phase === "plan") return evidence.plannerProvider === "model_first_local_fixture";
  if (entry.phase === "execute")
    return Boolean(evidence.executionError || evidence.responseErrorMessage);
  if (entry.phase === "verify")
    return (
      evidence.verificationSchema === "oneesama.kwwk-cu-verification.v1" &&
      evidence.verificationBlocker === "failed_verification" &&
      Number(evidence.failedCheckCount) >= 1
    );
  return (
    entry.phase === "observe" &&
    (Boolean(evidence.observationMode) || evidence.observationProvided === true)
  );
}

export function kwwkPhaseBlockerMatrixCount(report) {
  const matrix = report?.kwwk?.phaseBlockers || {};
  const entries = Array.isArray(matrix.entries) ? matrix.entries : [];
  return REQUIRED_KWWK_BLOCKER_PHASES.filter((phase) =>
    entries.some((entry) => entry?.phase === phase && phaseHasReadableBlocker(entry)),
  ).length;
}
