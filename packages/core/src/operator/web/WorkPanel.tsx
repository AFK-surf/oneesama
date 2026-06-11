import { useState } from "react";

import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";
import type { WorkState } from "./useWork.ts";
import { workPanelView } from "./workPanelView.ts";

export function WorkPanel({ work, runtime }: { work: WorkState; runtime: OperatorRuntimeState }) {
  const [draft, setDraft] = useState("");
  const view = workPanelView(work, runtime);

  return (
    <div className="op-work">
      <div className="op-panel-head">
        <div>
          <h2>Work</h2>
          <p>
            {view.headerStatus} / {view.headerBackend}
          </p>
        </div>
        <button
          className="btn"
          onClick={() => runtime.cancelTool()}
          type="button"
          disabled={view.stopActionDisabled}
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
        <button className="btn primary" type="submit" disabled={view.runButtonDisabled}>
          Run
        </button>
      </form>

      <div className="op-work-body">
        <div className="op-work-kwwk">
          <span className={"op-work-phase " + view.kwwkPhaseClass}>{view.kwwkStatus}</span>
          <span>job {view.jobLabel}</span>
          <span>cursor {view.cursorLabel}</span>
          <span>actions {view.actionCountLabel}</span>
          <span>verify {view.verificationLabel}</span>
        </div>
        {view.blockerText ? <div className="op-error">{view.blockerText}</div> : null}
        {view.recentActions.length ? (
          <div className="op-work-actions">
            {view.recentActions.map((action) => (
              <div key={action.key}>
                <strong>{action.kind}</strong>
                <span>{action.label}</span>
                <em>{action.status}</em>
              </div>
            ))}
          </div>
        ) : null}

        {view.empty ? (
          <div className="op-empty">
            Type a command — e.g. “look up what changed in 2.0”. Runs on the kwwk-cu backend.
          </div>
        ) : (
          <>
            <div className="op-work-head">
              <span className={"op-work-phase " + view.workPhaseClass}>{view.phaseLabel}</span>
              {view.backendLabel ? <span className="op-work-tag">{view.backendLabel}</span> : null}
            </div>
            {view.intentText ? <div className="op-work-intent">{view.intentText}</div> : null}

            {view.steps.length > 0 ? (
              <ol className="op-work-steps">
                {view.steps.map((s, i) => (
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

            {view.result ? (
              <div className="op-work-result">
                {(view.result.postConditions || []).map((c, i) => (
                  <div key={i} className="op-work-check">
                    {c.ok ? "✓" : "✗"} {c.condition?.kind}: {c.condition?.value}
                  </div>
                ))}
                {view.result.extracted ? (
                  <div className="op-work-extract">{view.result.extracted}</div>
                ) : null}
                {view.result.blocker ? (
                  <div className="op-work-step-err">blocked: {view.result.blocker}</div>
                ) : null}
              </div>
            ) : null}

            {view.errorText ? <div className="op-error">⚠ {view.errorText}</div> : null}
          </>
        )}
      </div>
    </div>
  );
}
