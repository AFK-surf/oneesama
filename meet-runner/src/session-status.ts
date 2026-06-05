import type { StatusSessionParams } from "./types.ts";

type RunnerSessionState = {
  id: string;
  meeting_url: string;
  status: string;
  title: string;
  updated_at: string;
  started: boolean;
};

function firstNonEmpty(...values: Array<unknown>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
}

function sessionView(state?: RunnerSessionState) {
  if (!state) return null;
  return {
    id: state.id,
    meeting_url: state.meeting_url,
    status: state.status,
    title: state.title,
    updated_at: state.updated_at,
  };
}

function pageLooksRemovedFromMeeting(meetPage: any): boolean {
  if (!meetPage || typeof meetPage !== "object") return false;
  if (
    meetPage.inMeeting === true ||
    meetPage.waitingForAdmit === true ||
    meetPage.preJoin === true ||
    meetPage.signIn === true ||
    meetPage.cannotJoin === true
  ) {
    return false;
  }
  const url = String(meetPage.url || "").toLowerCase();
  if (url && !url.includes("meet.google.com/")) return true;
  const text = String(meetPage.textHead || "").toLowerCase();
  return (
    text.includes("left the meeting") ||
    text.includes("return to home screen") ||
    text.includes("you've been removed") ||
    text.includes("you have been removed")
  );
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

export function deriveRuntimeSessionStatus(state: RunnerSessionState, active: any): string {
  const meetPage = active?.meetPage || null;
  if (pageLooksRemovedFromMeeting(meetPage)) return "removed_from_meeting";
  if (hasJoinedMeetPageEvidence(meetPage)) return "joined";
  if (meetPage?.waitingForAdmit === true) return "waiting";
  if (meetPage?.cannotJoin === true) return "failed";
  return state.status;
}

export async function statusSession(
  params: StatusSessionParams,
  sessions: Map<string, RunnerSessionState>,
  joiner: { status: () => Promise<any> },
) {
  const requestedID = firstNonEmpty(params.session_id);
  const runtime = await joiner.status();
  const activeSessionID = firstNonEmpty(runtime?.active?.sessionId, runtime?.active?.session_id);
  const state = requestedID
    ? sessions.get(requestedID)
    : activeSessionID
      ? sessions.get(activeSessionID)
      : sessions.values().next().value;
  if (state && runtime?.active) {
    const nextStatus = deriveRuntimeSessionStatus(state, runtime.active);
    if (nextStatus && nextStatus !== state.status) {
      state.status = nextStatus;
      state.updated_at = new Date().toISOString();
      sessions.set(state.id, state);
    }
  }
  return {
    ok: runtime?.ok !== false,
    active: runtime?.active || null,
    session: sessionView(state),
    runtime,
  };
}
