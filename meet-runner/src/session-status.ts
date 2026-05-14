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
  return {
    ok: runtime?.ok !== false,
    active: runtime?.active || null,
    session: sessionView(state),
    runtime,
  };
}
