export function buildLanOperatorWorkPanelClientScript() {
  return `(() => {
  function create(input) {
    const form = document.getElementById("operator-work-form");
    const field = document.getElementById("operator-work-input");
    const runButton = document.getElementById("operator-work-run-button");
    const statusEl = document.getElementById("operator-work-status");
    const frame = document.getElementById("operator-work-frame");
    const frameEmpty = document.getElementById("operator-work-frame-empty");
    const cursor = document.getElementById("operator-work-cursor");
    const intentEl = document.getElementById("operator-work-intent");
    const stepsEl = document.getElementById("operator-work-steps");
    const resultEl = document.getElementById("operator-work-result");
    if (!form || !field) return { handleWorkEvent() {}, handleWorkFrame() {} };

    function setStatus(text, state) {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.dataset.state = state || "";
    }
    function setRunning(running) {
      if (runButton) runButton.disabled = running;
      field.disabled = running;
    }
    function resetForRun(command) {
      if (stepsEl) stepsEl.textContent = "";
      if (resultEl) { resultEl.hidden = true; resultEl.textContent = ""; }
      if (intentEl) { intentEl.hidden = true; intentEl.textContent = ""; }
      if (cursor) cursor.hidden = true;
      setStatus("compiling…", "running");
      setRunning(true);
    }

    function renderIntent(detail) {
      if (!intentEl) return;
      intentEl.hidden = false;
      intentEl.textContent = "";
      const title = document.createElement("div");
      title.className = "work-intent-title";
      title.textContent = "Understood: " + String(detail.intent || "");
      const meta = document.createElement("div");
      meta.className = "work-pc";
      const pcs = Array.isArray(detail.postConditions) ? detail.postConditions : [];
      meta.textContent =
        "matched=" + String(detail.matchedBy || "") +
        " · risk=" + String(detail.riskLevel || "") +
        (pcs.length ? " · verify: " + pcs.map((p) => p.kind + ":" + p.value).join(", ") : "");
      intentEl.append(title, meta);
    }

    function appendStep(detail) {
      if (!stepsEl) return;
      const row = document.createElement("div");
      row.className = "work-step";
      if (detail.failed) row.dataset.failed = "true";
      const n = document.createElement("span");
      n.className = "work-step-n";
      n.textContent = "#" + String(detail.step != null ? detail.step : stepsEl.children.length);
      row.append(n);
      if (detail.failed) {
        const note = document.createElement("span");
        note.className = "work-step-note";
        note.textContent = "✗ " + String(detail.error || "failed");
        row.append(note);
      } else {
        const op = detail.operation || {};
        const opEl = document.createElement("span");
        opEl.className = "work-step-op";
        opEl.textContent = String(op.type || "");
        row.append(opEl);
        const note = document.createElement("span");
        note.className = "work-step-note";
        const parts = [];
        if (op.target && op.target.ref) parts.push(op.target.ref);
        if (op.value) parts.push(JSON.stringify(String(op.value).slice(0, 50)));
        if (op.rationale) parts.push("— " + op.rationale);
        note.textContent = parts.join(" ");
        row.append(note);
      }
      stepsEl.append(row);
      stepsEl.scrollTop = stepsEl.scrollHeight;
    }

    function renderResult(detail) {
      setRunning(false);
      const status = String(detail.status || "");
      setStatus(status, status);
      if (!resultEl) return;
      resultEl.hidden = false;
      resultEl.dataset.status = status;
      resultEl.textContent = "";
      const head = document.createElement("div");
      head.innerHTML = "";
      head.textContent =
        (status === "done" ? "✓ Done" : status === "blocked" ? "⚠ Blocked" : "✗ " + status) +
        " · " + String(detail.steps || 0) + " steps · " + String(detail.totalMs || 0) + "ms";
      resultEl.append(head);
      const pcs = Array.isArray(detail.postConditions) ? detail.postConditions : [];
      for (const pc of pcs) {
        const line = document.createElement("div");
        line.className = "work-pc-line";
        line.textContent = (pc.ok ? "✓ " : "✗ ") + pc.condition.kind + ": " + pc.condition.value;
        resultEl.append(line);
      }
      if (detail.summary) {
        const summary = document.createElement("div");
        summary.className = "work-result-summary";
        summary.textContent = String(detail.summary);
        resultEl.append(summary);
      } else if (detail.extracted) {
        const extracted = document.createElement("div");
        extracted.className = "work-result-summary";
        extracted.textContent = String(detail.extracted).slice(0, 400);
        resultEl.append(extracted);
      }
      if (detail.blocker) {
        const blocker = document.createElement("div");
        blocker.className = "work-pc-line";
        blocker.textContent = "blocker: " + String(detail.blocker);
        resultEl.append(blocker);
      }
    }

    function handleWorkEvent(event) {
      if (!event || typeof event !== "object") return;
      const detail = event.detail || {};
      if (event.type === "intent") { renderIntent(detail); setStatus("working…", "running"); }
      else if (event.type === "not_a_command") {
        setRunning(false);
        setStatus("not a command", "failed");
        if (resultEl) {
          resultEl.hidden = false;
          resultEl.dataset.status = "failed";
          resultEl.textContent = "Not a work command (" + String(detail.reason || "") + ") — nothing run.";
        }
      } else if (event.type === "step") appendStep(detail);
      else if (event.type === "cursor") {
        if (cursor) {
          cursor.hidden = false;
          cursor.style.left = (Number(detail.x) * 100) + "%";
          cursor.style.top = (Number(detail.y) * 100) + "%";
        }
      } else if (event.type === "result") renderResult(detail);
      else if (event.type === "error") {
        setRunning(false);
        setStatus("error", "failed");
        if (resultEl) {
          resultEl.hidden = false;
          resultEl.dataset.status = "failed";
          resultEl.textContent =
            String(detail.reason || detail.error || "error") +
            (detail.hint ? " — " + detail.hint : "");
        }
      }
    }

    function handleWorkFrame(payload) {
      if (!frame || !payload || !payload.dataBase64) return;
      frame.src = "data:image/jpeg;base64," + payload.dataBase64;
      if (frameEmpty) frameEmpty.hidden = true;
    }

    function submit(command) {
      const value = String(command || field.value || "").trim();
      if (!value) return { ok: false };
      resetForRun(value);
      input.sendOperatorEvent({ type: "work_run", command: value });
      return { ok: true, command: value };
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });

    return { handleWorkEvent, handleWorkFrame, submit };
  }

  window.MAB_LAN_OPERATOR_WORK_PANEL = { create };
})();`;
}
