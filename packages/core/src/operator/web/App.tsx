import { useEffect, useMemo, useRef, useState } from "react";

import { Stage } from "./Stage.tsx";
import { useRealtime, type CanonicalEvent, type OperatorBoot } from "./useRealtime.ts";
import { useVoice } from "./useVoice.ts";

interface Turn {
  role: "you" | "bot";
  text: string;
  status: string;
}

// Collapse the canonical event stream into readable conversation turns:
// completed transcripts are what the bot heard; assistant text deltas/completes
// accumulate per responseId into one bot turn.
function turnsFromEvents(events: CanonicalEvent[]): Turn[] {
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

const STATUS_COLOR: Record<string, string> = {
  connected: "#0a7a52",
  connecting: "#9a6310",
  not_connected: "#8b909c",
  failed: "#b5322b",
};

export function App({ boot }: { boot: OperatorBoot }) {
  const rt = useRealtime(boot);
  const voice = useVoice(boot, rt.subscribe);
  const [draft, setDraft] = useState("");
  const turns = useMemo(() => turnsFromEvents(rt.events), [rt.events]);
  const connected = rt.status === "connected";
  const streamRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length]);

  return (
    <div className="op">
      <header className="op-header">
        <div className="op-title">{boot.botName || "Oneesama"} · Realtime</div>
        <div className="op-status">
          <span className="dot" style={{ background: STATUS_COLOR[rt.status] || "#8b909c" }} />
          {rt.status} · {rt.transport}
        </div>
      </header>

      <div className="op-body">
        <div className="op-left">
          <Stage boot={boot} />
          <div className="op-mic">
            {voice.micOn ? (
              <>
                <button className="btn" onClick={voice.stopMic} type="button">
                  Stop mic
                </button>
                <button
                  className="btn"
                  onClick={voice.toggleMute}
                  type="button"
                  aria-pressed={voice.muted}
                >
                  {voice.muted ? "Unmute" : "Mute"}
                </button>
                <span className="op-energy" aria-label="mic energy">
                  <span
                    className="op-energy-bar"
                    style={{ width: Math.min(100, voice.energy * 400) + "%" }}
                  />
                </span>
              </>
            ) : (
              <button
                className="btn primary"
                onClick={() => void voice.startMic()}
                type="button"
                disabled={!connected}
              >
                Start mic
              </button>
            )}
            {!connected ? <span className="op-mic-hint">connect first to speak</span> : null}
          </div>
        </div>

        <section className="op-conv">
          <div className="op-stream" ref={streamRef}>
            {turns.length === 0 ? (
              <div className="op-empty">No messages yet. Connect, then speak or type below.</div>
            ) : (
              turns.map((t, i) => (
                <div key={i} className={"op-turn op-turn-" + t.role}>
                  <span className="op-turn-role">{t.role}</span>
                  <span className="op-turn-text">{t.text || "…"}</span>
                  <span className="op-turn-status">{t.status}</span>
                </div>
              ))
            )}
            {rt.error ? <div className="op-error">⚠ {rt.error}</div> : null}
          </div>
          <footer className="op-composer">
            <div className="op-conn">
              <span className={"op-conn-label " + (connected ? "ok" : "off")}>
                {connected ? "connected" : rt.wsOpen ? "not connected" : "offline"}
              </span>
              {connected ? (
                <button className="btn" onClick={rt.disconnect} type="button">
                  Disconnect
                </button>
              ) : (
                <button
                  className="btn primary"
                  onClick={rt.connect}
                  disabled={!rt.wsOpen}
                  type="button"
                >
                  Connect
                </button>
              )}
            </div>
            <form
              className="op-input"
              onSubmit={(e) => {
                e.preventDefault();
                rt.sendText(draft);
                setDraft("");
              }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Type a message…"
                autoComplete="off"
              />
              <button className="btn" type="submit" disabled={!connected}>
                Send
              </button>
            </form>
          </footer>
        </section>
      </div>
    </div>
  );
}
