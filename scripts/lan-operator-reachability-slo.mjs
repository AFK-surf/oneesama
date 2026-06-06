function reachability(report) {
  return (
    report?.host?.reachability ||
    report?.lanEvidence?.surfaceReachability ||
    report?.debugReport?.summaries?.surfaceContext?.lanReachability ||
    report?.debugReport?.debug?.surfaceContext?.lanReachability ||
    report?.runtimeStatus?.debug?.surfaceContext?.lanReachability ||
    {}
  );
}

export function lanOperatorReachabilityRequired(report) {
  return Boolean(report?.host?.reachability || report?.debugReport || report?.runtimeStatus);
}

export function lanOperatorReachabilityCount(report) {
  const info = reachability(report);
  const hasUrl = typeof info.advertisedUrl === "string" && info.advertisedUrl.startsWith("http");
  const localOk = info.localOnlyMode === true && typeof info.loopbackUrl === "string";
  const lanOk =
    info.localOnlyMode === false &&
    info.trustedLanOperatorMode === true &&
    Number(info.lanAddressCount || 0) >= 1;
  return info.schema === "oneesama.lan_operator_reachability.v1" &&
    Number(info.port || 0) > 0 &&
    hasUrl &&
    (localOk || lanOk)
    ? 1
    : 0;
}
