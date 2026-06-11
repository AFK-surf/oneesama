import { useState } from "react";

import type { DebugState } from "../lan-operator-debug-state.ts";
import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";
import type { WorkState } from "./useWork.ts";

const PHASE_LABEL: Record<string, string> = {
  idle: "idle",
  running: "running…",
  done: "done",
  not_a_command: "not a command",
  error: "error",
};

export function WorkPanel({ work, runtime }: { work: WorkState; runtime: OperatorRuntimeState }) {
  const [draft, setDraft] = useState("");
  const running = work.phase === "running";
  const kwwk = runtime.debug.kwwk as DebugState["kwwk"] | undefined;
  const verification = kwwk?.verification;

  return (
    <div className="op-work">
      <div className="op-panel-head">
        <div>
          <h2>Work</h2>
          <p>
            {kwwk?.status || work.phase} / {kwwk?.latestActionKind || work.backend || "manual"}
          </p>
        </div>
        <button
          className="btn"
          onClick={() => runtime.cancelTool()}
          type="button"
          disabled={!/queued|observing|planning|executing|verifying/i.test(kwwk?.status || "")}
        >
          Stop action
        </button>
      </div>

      <form
        className="op-input"
        onSubmit={(e) => {
          e.preventDefault();
          work.run(draft);
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Tell oneesama what to do…"
          autoComplete="off"
        />
        <button className="btn primary" type="submit" disabled={running}>
          Run
        </button>
      </form>

      <div className="op-work-body">
        <div className="op-work-kwwk">
          <span className={"op-work-phase phase-" + (kwwk?.status || "idle")}>
            {kwwk?.status || "idle"}
          </span>
          <span>job {kwwk?.currentJobId || "-"}</span>
          <span>cursor {kwwk?.cursorEventCount || 0}</span>
          <span>actions {kwwk?.actionCount || 0}</span>
          <span>
            verify{" "}
            {verification?.ok == null
              ? verification?.status || "-"
              : verification.ok
                ? "ok"
                : "failed"}
          </span>
        </div>
        {kwwk?.blocker ? <div className="op-error">blocked: {kwwk.blocker}</div> : null}
        {kwwk?.actions?.length ? (
          <div className="op-work-actions">
            {kwwk.actions.slice(-5).map((action, index) => (
              <div key={`${action.ts}-${index}`}>
                <strong>{action.kind}</strong>
                <span>{action.label}</span>
                <em>{action.status}</em>
              </div>
            ))}
          </div>
        ) : null}

        {work.phase === "idle" ? (
          <div className="op-empty">
            Type a command — e.g. “look up what changed in 2.0”. Runs on the kwwk-cu backend.
          </div>
        ) : (
          <>
            <div className="op-work-head">
              <span className={"op-work-phase phase-" + work.phase}>{PHASE_LABEL[work.phase]}</span>
              {work.backend ? <span className="op-work-tag">{work.backend}</span> : null}
            </div>
            {work.intent ? <div className="op-work-intent">{work.intent}</div> : null}

            {work.steps.length > 0 ? (
              <ol className="op-work-steps">
                {work.steps.map((s, i) => (
                  <li key={i} className={s.failed ? "failed" : ""}>
                    <span className="op-work-step-op">
                      {s.type}
                      {s.ref ? ` ref=${s.ref}` : ""}
                    </span>
                    {s.rationale ? <span className="op-work-step-why">{s.rationale}</span> : null}
                    {s.error ? <span className="op-work-step-err">✗ {s.error}</span> : null}
                  </li>
                ))}
              </ol>
            ) : null}

            {work.result ? (
              <div className="op-work-result">
                {(work.result.postConditions || []).map((c, i) => (
                  <div key={i} className="op-work-check">
                    {c.ok ? "✓" : "✗"} {c.condition?.kind}: {c.condition?.value}
                  </div>
                ))}
                {work.result.extracted ? (
                  <div className="op-work-extract">{work.result.extracted}</div>
                ) : null}
                {work.result.blocker ? (
                  <div className="op-work-step-err">blocked: {work.result.blocker}</div>
                ) : null}
              </div>
            ) : null}

            {work.error ? <div className="op-error">⚠ {work.error}</div> : null}
          </>
        )}
      </div>
    </div>
  );
}
