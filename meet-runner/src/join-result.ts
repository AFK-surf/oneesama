function firstNonEmpty(...values: Array<unknown>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
}

export function deriveStartedStatus(result: any): string {
  if (
    result?.fixtureState?.joined === true ||
    result?.meetPage?.inMeeting === true ||
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
  return firstNonEmpty(result?.error, "google meet join failed");
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
