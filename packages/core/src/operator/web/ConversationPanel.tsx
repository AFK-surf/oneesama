import { useEffect, useMemo, useRef, useState } from "react";

import type { DebugState } from "../lan-operator-debug-state.ts";
import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";
import type { CanonicalEvent, RealtimeState } from "./useRealtime.ts";

export interface Turn {
  role: "you" | "bot";
  text: string;
  status: string;
}

export function turnsFromEvents(events: CanonicalEvent[]): Turn[] {
  const turns: Turn[] = [];
  const assistantByResponse = new Map<string, Turn>();
  for (const ev of events) {
    if (ev.type === "transcript_completed" && ev.text) {
      turns.push({ role: "you", text: String(ev.text), status: "heard" });
    } else if (ev.type === "assistant_text_delta" || ev.type === "assistant_text_completed") {
      const key = String(ev.responseId || "r");
      let turn = assistantByResponse.get(key);
      if (!turn) {
        turn = { role: "bot", text: "", status: "speaking" };
        assistantByResponse.set(key, turn);
        turns.push(turn);
      }
      if (ev.type === "assistant_text_completed") {
        if (ev.text) turn.text = String(ev.text);
        turn.status = "final";
      } else if (ev.text) {
        turn.text += String(ev.text);
      }
    }
  }
  return turns;
}

export function ConversationPanel({
  realtime,
  runtime,
}: {
  realtime: RealtimeState;
  runtime: OperatorRuntimeState;
}) {
  const [draft, setDraft] = useState("");
  const streamRef = useRef<HTMLDivElement | null>(null);
  const turns = useMemo(() => turnsFromEvents(realtime.events), [realtime.events]);
  const timeline = runtime.debug.timeline as DebugState["timeline"] | undefined;
  const latestTurn = timeline?.turns?.at(-1) || null;
  const output = runtime.debug.output as DebugState["output"] | undefined;
  const control = runtime.debug.conversation?.control;
  const connected = String(runtime.debug.conversation?.status || realtime.status) === "connected";

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, output?.assistantText?.currentText]);

  return (
    <section className="op-conversation">
      <div className="op-panel-head">
        <div>
          <h2>Conversation</h2>
          <p>
            {latestTurn?.latestEvent || realtime.events.at(-1)?.type || "idle"} /{" "}
            {timeline?.currentTurnId || "no turn"}
          </p>
        </div>
        <div className="op-mini-metrics">
          <Metric label="events" value={String(realtime.events.length)} />
          <Metric
            label="speech"
            value={String(runtime.debug.conversation?.eventCounts?.speech_started || 0)}
          />
          <Metric label="control" value={control?.lastResult || control?.lastCommand || "idle"} />
        </div>
      </div>

      {latestTurn ? <Milestones turn={latestTurn} /> : null}

      <div className="op-stream" ref={streamRef}>
        {turns.length === 0 && !output?.assistantText?.currentText ? (
          <div className="op-empty">No messages yet. Connect, then speak or type below.</div>
        ) : (
          turns.map((turn, index) => (
            <div key={index} className={`op-turn op-turn-${turn.role}`}>
              <span className="op-turn-role">{turn.role}</span>
              <span className="op-turn-text">{turn.text || "..."}</span>
              <span className="op-turn-status">{turn.status}</span>
            </div>
          ))
        )}
        {output?.assistantText?.currentText ? (
          <div className="op-turn op-turn-bot live">
            <span className="op-turn-role">bot</span>
            <span className="op-turn-text">{output.assistantText.currentText}</span>
            <span className="op-turn-status">live</span>
          </div>
        ) : null}
        {realtime.error || runtime.runtimeError ? (
          <div className="op-error">{realtime.error || runtime.runtimeError}</div>
        ) : null}
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
        <button className="btn primary" type="submit" disabled={!connected}>
          Send
        </button>
      </form>
    </section>
  );
}

function Milestones({ turn }: { turn: NonNullable<DebugState["timeline"]["turns"][number]> }) {
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
