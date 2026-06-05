function firstNonEmpty(...values: Array<unknown>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
}

function hasJoinedMeetPageEvidence(meetPage: any): boolean {
  return (
    meetPage?.inMeeting === true &&
    meetPage?.waitingForAdmit !== true &&
    meetPage?.preJoin !== true &&
    meetPage?.signIn !== true &&
    meetPage?.cannotJoin !== true
  );
}

export function deriveStartedStatus(result: any): string {
  if (
    result?.fixtureState?.joined === true ||
    hasJoinedMeetPageEvidence(result?.meetPage) ||
    result?.admission?.state === "admitted"
  ) {
    return "joined";
  }
  if (result?.admission?.state === "waiting" || result?.meetPage?.waitingForAdmit === true) {
    return "waiting";
  }
  if (result?.clickedJoinSelector) {
    return "join_requested";
  }
  return "starting";
}

export function hasJoinAcceptedEvidence(result: any): boolean {
  return deriveStartedStatus(result) !== "starting" || result?.captions?.ok === true;
}

export function joinFailureMessage(result: any): string {
  return firstNonEmpty(
    result?.webDriver?.message,
    result?.guestName?.message,
    result?.error,
    "google meet join failed",
  );
}

export function joinFailureDetails(result: any) {
  const error = firstNonEmpty(result?.error, "google_meet_join_failed");
  const reason = firstNonEmpty(
    result?.webDriver?.status,
    result?.guestName?.reason,
    result?.admission?.state,
    result?.meetPage?.cannotJoin === true ? "cannot_join_meeting" : "",
    error,
  );
  const message = joinFailureMessage(result);
  return {
    error,
    reason,
    message,
    diagnostics_path: firstNonEmpty(result?.diagnosticsPath),
    screenshot_dir: firstNonEmpty(result?.screenshotDir),
    web_driver: result?.webDriver,
    meet_page: result?.meetPage,
  };
}

export async function recoverAcceptedJoinAfterError(
  error: unknown,
  joiner: { status: () => Promise<any> },
) {
  const message = error instanceof Error ? error.message : String(error);
  let runtime = null;
  try {
    runtime = await joiner.status();
  } catch {
    runtime = null;
  }
  const active = runtime?.active || null;
  if (!hasJoinAcceptedEvidence(active)) {
    throw error;
  }
  return {
    ...active,
    ok: true,
    recovered_after_error: message,
  };
}
