(() => {
  type MeetingEventVisibility = "voice" | "meet_chat" | "visual_only" | "silent" | "blocked";
  type MeetingEventSource = "worker" | "meet" | "workspace" | "avatar" | "app_control";

  interface MeetingEventInput {
    type: string;
    source: MeetingEventSource;
    visibility: MeetingEventVisibility;
    interruptible: boolean;
    turnId?: string;
    callId?: string;
    jobId?: string;
    toolName?: string;
    status?: string;
    reason?: string;
    sessionId?: string;
    detail?: Record<string, unknown>;
  }

  interface AppControlJobInput {
    event: Record<string, unknown>;
    sessionId: string;
    callId: string;
    jobId: string;
    status: string;
    visibility: MeetingEventVisibility;
    interruptible: boolean;
    reason: string;
    toolName?: string;
    stage?: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    blocker?: string;
  }

  interface WorkerResultScope {
    ok: boolean;
    reason: string;
    currentSessionId: string;
    jobSessionId: string;
  }

  interface MeetingEventHelperDeps {
    config: Record<string, unknown>;
    state: Record<string, any>;
    recordTimeline(type: string, detail?: Record<string, unknown>): void;
  }

  function create(deps: MeetingEventHelperDeps) {
    const { config, state, recordTimeline } = deps;

    function resultRecord(value: unknown): Record<string, unknown> {
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    }

    function firstNonEmptyString(...values: unknown[]): string {
      for (const value of values) {
        const text = String(value || "").trim();
        if (text) return text;
      }
      return "";
    }

    function currentSessionId(): string {
      return firstNonEmptyString(state.sessionId, config.sessionId);
    }

    function workerResultSessionId(job: any): string {
      const context = resultRecord(job?.context);
      const envelope = resultRecord(job?.resultEnvelope || job?.result_envelope);
      const envelopeContext = resultRecord(envelope.context);
      return firstNonEmptyString(
        context.meeting_session_id,
        context.session_id,
        context.sessionId,
        envelopeContext.meeting_session_id,
        envelopeContext.session_id,
        envelopeContext.sessionId,
        job?.meeting_session_id,
        job?.session_id,
        job?.sessionId,
      );
    }

    function shouldDeliverWorkerResult(job: any): WorkerResultScope {
      const activeSessionId = currentSessionId();
      const jobSessionId = workerResultSessionId(job);
      if (activeSessionId && !jobSessionId) {
        return {
          ok: false,
          reason: "worker_result_session_missing",
          currentSessionId: activeSessionId,
          jobSessionId,
        };
      }
      if (activeSessionId && jobSessionId && activeSessionId !== jobSessionId) {
        return {
          ok: false,
          reason: "worker_result_session_mismatch",
          currentSessionId: activeSessionId,
          jobSessionId,
        };
      }
      return {
        ok: true,
        reason: "worker_result_session_match",
        currentSessionId: activeSessionId,
        jobSessionId,
      };
    }

    function eventIsInterruptible(channel: MeetingEventVisibility): boolean {
      return channel === "voice" || channel === "meet_chat" || channel === "blocked";
    }

    function rememberMeetingEvent(input: MeetingEventInput) {
      state.turnPolicy = state.turnPolicy || {};
      state.turnPolicy.events = Array.isArray(state.turnPolicy.events)
        ? state.turnPolicy.events
        : [];
      const sessionId = firstNonEmptyString(input.sessionId, state.sessionId, config.sessionId);
      const turnId = firstNonEmptyString(
        input.turnId,
        input.callId,
        input.jobId,
        state.protection?.activeResponseId,
      );
      const entry = {
        ts: new Date().toISOString(),
        type: input.type,
        source: input.source,
        sessionId,
        turnId,
        callId: input.callId || "",
        jobId: input.jobId || "",
        toolName: input.toolName || "",
        status: input.status || "",
        visibility: input.visibility,
        interruptible: input.interruptible,
        reason: input.reason || "",
        detail: input.detail || {},
      };
      state.turnPolicy.events.push(entry);
      state.turnPolicy.events = state.turnPolicy.events.slice(-100);
      state.meetingEvents = state.turnPolicy.events;
      recordTimeline("meeting_event", {
        type: entry.type,
        source: entry.source,
        sessionId: entry.sessionId,
        turnId: entry.turnId,
        callId: entry.callId,
        jobId: entry.jobId,
        visibility: entry.visibility,
        interruptible: entry.interruptible,
      });
      return entry;
    }

    function rememberAppControlJob(input: AppControlJobInput) {
      if (!input.jobId) return null;
      state.turnPolicy = state.turnPolicy || {};
      state.turnPolicy.appControlJobs = resultRecord(state.turnPolicy.appControlJobs);
      state.turnPolicy.appControlJobs[input.jobId] = {
        updatedAt: input.event.ts || new Date().toISOString(),
        sessionId: input.sessionId,
        turnId: input.event.turnId || "",
        callId: input.callId,
        jobId: input.jobId,
        status: input.status,
        visibility: input.visibility,
        interruptible: input.interruptible,
        reason: input.reason,
        toolName: input.toolName || "kwwk_computer_use",
        stage: input.stage || input.status,
        startedAt: input.startedAt || "",
        finishedAt: input.finishedAt || "",
        durationMs: input.durationMs,
        blocker: input.blocker || "",
      };
      return state.turnPolicy.appControlJobs[input.jobId];
    }

    return {
      rememberMeetingEvent,
      rememberAppControlJob,
      shouldDeliverWorkerResult,
      eventIsInterruptible,
    };
  }

  (window as any).__MAB_REALTIME_MEETING_EVENT_HELPERS = { create };
})();
