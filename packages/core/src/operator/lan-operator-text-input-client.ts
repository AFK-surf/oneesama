export function buildLanOperatorTextInputClientScript() {
  return `(() => {
  function create(input) {
    const state = input.state;
    const inputDock = document.getElementById("operator-input-dock");
    const toolbar = document.querySelector(".stage-toolbar");
    const voiceTools = document.querySelector(".voice-tools");
    const form = document.createElement("form");
    form.className = "toolbar-group";
    form.setAttribute("data-operator-text-input", "true");
    const textInput = document.createElement("input");
    textInput.id = "operator-text-input";
    textInput.className = "voice-device";
    textInput.type = "text";
    textInput.placeholder = "Type debug input";
    textInput.autocomplete = "off";
    const modeStatus = document.createElement("span");
    modeStatus.id = "operator-realtime-mode-status";
    modeStatus.className = "dock-status";
    modeStatus.title = "Text chat provider";
    const connectButton = document.createElement("button");
    connectButton.id = "operator-realtime-connect-button";
    connectButton.className = "btn";
    connectButton.type = "button";
    const sendButton = document.createElement("button");
    sendButton.id = "operator-text-send-button";
    sendButton.className = "btn";
    sendButton.type = "submit";
    sendButton.textContent = "Send Text";
    form.append(modeStatus, connectButton, textInput, sendButton);
    if (inputDock) {
      inputDock.append(form);
    } else {
      toolbar?.insertBefore(form, voiceTools || null);
    }

    function nextInputId() {
      return "text_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    }

    function conversationTransport() {
      return String(input.boot?.conversationTransport || state.conversation?.provider?.adapterKind || "mock");
    }

    function conversationStatus() {
      return String(state.conversation?.status || "not_connected");
    }

    function renderStatus() {
      const transport = conversationTransport();
      const status = conversationStatus();
      const engineId = String(state.conversation?.engineId || transport || "engine");
      const live = transport === "openai_realtime";
      const failed = status === "failed";
      const connected = status === "connected";
      modeStatus.className = "dock-status " + (live ? (failed ? "bad" : connected ? "ok" : "warn") : "warn");
      modeStatus.textContent = live
        ? "live " + engineId + (connected ? " connected" : failed ? " failed" : " ready")
        : "diagnostic " + engineId;
      modeStatus.title = live
        ? "Text input will use the server-side OpenAI Realtime engine: " + engineId + "."
        : "Diagnostic text input is using the local engine: " + engineId + ".";
      connectButton.hidden = !live;
      connectButton.disabled = !live;
      connectButton.textContent = connected ? "Reconnect" : "Connect";
      connectButton.title = connected
        ? "Reconnect the OpenAI Realtime text session"
        : "Connect the OpenAI Realtime text session";
    }

    function connectRealtime() {
      if (conversationTransport() !== "openai_realtime") {
        return { ok: false, error: "openai_realtime_not_configured" };
      }
      const detail = { source: "operator_text_input", inputMode: "text" };
      const control = input.sendEngineControl
        ? input.sendEngineControl("connect", { reason: "operator_realtime_text_connect", detail })
        : input.sendOperatorEvent({
            type: "engine_control",
            control: { type: "connect", reason: "operator_realtime_text_connect", detail },
          });
      renderStatus();
      return { ok: Boolean(control), control: "connect" };
    }

    function sendText(text) {
      const value = String(text || "").trim();
      if (!value) return { ok: false, error: "empty_operator_text_input" };
      const inputId = nextInputId();
      const sent = Boolean(input.sendOperatorEvent({
        type: "operator_text_input",
        inputId,
        text: value,
        source: "operator_text_input",
        monotonicMs: performance.now(),
        surfaceContext: {
          focusedSourceId: state.focusedSourceId || "",
          visualConnectionState: state.visual?.connectionState || "",
          conversationTransport: input.boot.conversationTransport,
        },
      }));
      state.lastTextInput = {
        id: inputId,
        text: value,
        sent,
        ts: new Date().toISOString(),
      };
      input.syncDebug();
      return { ok: sent, inputId, text: value };
    }

    connectButton.addEventListener("click", () => {
      connectRealtime();
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = textInput.value;
      const result = sendText(value);
      if (result.ok) textInput.value = "";
    });

    renderStatus();

    return { sendText, connectRealtime, renderStatus, form, textInput, modeStatus, connectButton };
  }

  window.MAB_LAN_OPERATOR_TEXT_INPUT = { create };
})();`;
}
