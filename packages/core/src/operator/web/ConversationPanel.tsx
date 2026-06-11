import { useEffect, useMemo, useRef, useState } from "react";

import { conversationView, type ConversationTimelineTurn } from "./conversationView.ts";
import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";
import type { RealtimeState } from "./useRealtime.ts";

export function ConversationPanel({
  realtime,
  runtime,
}: {
  realtime: RealtimeState;
  runtime: OperatorRuntimeState;
}) {
  const [draft, setDraft] = useState("");
  const streamRef = useRef<HTMLDivElement | null>(null);
  const view = useMemo(
    () => conversationView(runtime, realtime),
    [realtime.error, realtime.events, realtime.status, runtime.debug, runtime.runtimeError],
  );

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.turns.length, view.liveAssistantText]);

  return (
    <section className="op-conversation">
      <div className="op-panel-head">
        <div>
          <h2>Conversation</h2>
          <p>
            {view.latestEventLabel} / {view.currentTurnLabel}
          </p>
        </div>
        <div className="op-mini-metrics">
          <Metric label="events" value={view.eventCountLabel} />
          <Metric label="speech" value={view.speechStartedCountLabel} />
          <Metric label="control" value={view.controlLabel} />
        </div>
      </div>

      {view.latestTurn ? <Milestones turn={view.latestTurn} /> : null}

      <div className="op-stream" ref={streamRef}>
        {view.empty ? (
          <div className="op-empty">No messages yet. Connect, then speak or type below.</div>
        ) : (
          view.turns.map((turn, index) => (
            <div key={index} className={`op-turn op-turn-${turn.role}`}>
              <span className="op-turn-role">{turn.role}</span>
              <span className="op-turn-text">{turn.text || "..."}</span>
              <span className="op-turn-status">{turn.status}</span>
            </div>
          ))
        )}
        {view.liveAssistantText ? (
          <div className="op-turn op-turn-bot live">
            <span className="op-turn-role">bot</span>
            <span className="op-turn-text">{view.liveAssistantText}</span>
            <span className="op-turn-status">live</span>
          </div>
        ) : null}
        {view.errorText ? <div className="op-error">{view.errorText}</div> : null}
      </div>

      <form
        className="op-composer"
        onSubmit={(event) => {
          event.preventDefault();
          realtime.sendText(draft);
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Type a message..."
          autoComplete="off"
        />
        <button className="btn primary" type="submit" disabled={!view.connected}>
          Send
        </button>
      </form>
    </section>
  );
}

function Milestones({ turn }: { turn: ConversationTimelineTurn }) {
  const milestones = turn.milestones || {};
  return (
    <div className="op-milestones">
      {Object.entries(milestones).map(([name, done]) => (
        <span key={name} className={done ? "done" : ""}>
          {name}
        </span>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="op-mini-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}
