export function buildLanOperatorTextInputClientScript() {
  return `(() => {
  function create(input) {
    const state = input.state;
    // Prefer the right-side Ledger composer dock (conversation lives there);
    // fall back to the legacy bottom input dock / toolbar for older surfaces.
    const inputDock =
      document.getElementById("operator-composer-dock") ||
      document.getElementById("operator-input-dock");
    const toolbar = document.querySelector(".stage-toolbar");
    const voiceTools = document.querySelector(".voice-tools");
    const form = document.createElement("form");
    form.className = "toolbar-group";
    form.setAttribute("data-operator-text-input", "true");
    const textInput = document.createElement("input");
    textInput.id = "operator-text-input";
    textInput.className = "voice-device";
    textInput.type = "text";
    textInput.placeholder = "Type message to bot";
    textInput.autocomplete = "off";
    const modeStatus = document.createElement("span");
    modeStatus.id = "operator-realtime-mode-status";
    modeStatus.className = "dock-status";
    modeStatus.title = "Text chat provider";
    const connectButton = document.createElement("button");
    connectButton.id = "operator-realtime-connect-button";
    connectButton.className = "btn";
    connectButton.type = "button";
    const disconnectButton = document.createElement("button");
    disconnectButton.id = "operator-realtime-disconnect-button";
    disconnectButton.className = "btn danger";
    disconnectButton.type = "button";
    disconnectButton.textContent = "Disconnect";
    disconnectButton.hidden = true;
    // Connect + Disconnect share the top-right slot of the composer grid.
    const connectActions = document.createElement("div");
    connectActions.className = "composer-actions";
    connectActions.append(disconnectButton, connectButton);
    const sendButton = document.createElement("button");
    sendButton.id = "operator-text-send-button";
    sendButton.className = "btn";
    sendButton.type = "submit";
    sendButton.textContent = "Send";
    // Two independent rows so the action buttons (Disconnect/Reconnect) never
    // dictate the width of the message input row — the input fills all the space.
    const statusRow = document.createElement("div");
    statusRow.className = "composer-row composer-row-status";
    statusRow.append(modeStatus, connectActions);
    const inputRow = document.createElement("div");
    inputRow.className = "composer-row composer-row-input";
    inputRow.append(textInput, sendButton);
    form.append(statusRow, inputRow);
    if (inputDock) {
      inputDock.append(form);
    } else {
      toolbar?.insertBefore(form, voiceTools || null);
    }

    function nextInputId() {
      return "text_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    }

    function conversationTransport() {
      return String(
        state.liveProviderConfig?.selectedTransport ||
        state.conversation?.provider?.adapterKind ||
        input.boot?.conversationTransport ||
        "mock"
      );
    }

    function conversationStatus() {
      return String(state.conversation?.status || "not_connected");
    }

    function isLiveTransport(transport) {
      return transport === "openai_realtime" || transport === "gemini_live";
    }

    function liveTransportLabel(transport) {
      if (transport === "gemini_live") return "Gemini Live";
      if (transport === "openai_realtime") return "OpenAI Realtime";
      return "Realtime";
    }

    function liveTextConnectReason(transport) {
      return transport === "openai_realtime"
        ? "operator_realtime_text_connect"
        : "operator_" + transport + "_text_connect";
    }

    function engineControlMessage(type, reason, detail) {
      return {
        type: "engine_control",
        control: { type, reason, detail },
      };
    }

    function renderStatus() {
      const transport = conversationTransport();
      const status = conversationStatus();
      const engineId = String(state.conversation?.engineId || transport || "engine");
      const live = isLiveTransport(transport);
      const liveLabel = liveTransportLabel(transport);
      const failed = status === "failed";
      const connected = status === "connected";
      const statusLabel = connected ? "connected" : failed ? "failed" : "not connected";
      modeStatus.className = "dock-status " + (live ? (failed ? "bad" : connected ? "ok" : "warn") : "warn");
      modeStatus.textContent = live
        ? liveLabel + " " + statusLabel
        : "Diagnostic " + engineId;
      modeStatus.title = live
        ? "Text input is configured for the server-side " + liveLabel + " engine: " + engineId + "; session status: " + statusLabel + "."
        : "Diagnostic text input is using the local engine: " + engineId + ".";
      connectButton.hidden = !live;
      connectButton.disabled = !live;
      connectButton.textContent = connected ? "Reconnect" : "Connect";
      connectButton.title = connected
        ? "Reconnect the " + liveLabel + " text session"
        : "Connect the " + liveLabel + " text session";
      // Disconnect is only meaningful while a live session is actually open —
      // it closes the connection (e.g. to stop a metered Gemini/OpenAI live WS).
      disconnectButton.hidden = !live || !connected;
      disconnectButton.disabled = !live || !connected;
      disconnectButton.title = "Disconnect the " + liveLabel + " session (closes the live connection)";
    }

    function connectRealtime() {
      const transport = conversationTransport();
      if (!isLiveTransport(transport)) {
        return { ok: false, error: transport + "_not_configured" };
      }
      const detail = { source: "operator_text_input", inputMode: "text" };
      const control = input.sendEngineControl
        ? input.sendEngineControl("connect", { reason: liveTextConnectReason(transport), detail })
        : input.sendOperatorEvent(engineControlMessage("connect", liveTextConnectReason(transport), detail));
      renderStatus();
      return { ok: Boolean(control), control: "connect" };
    }

    function disconnectRealtime() {
      const transport = conversationTransport();
      if (!isLiveTransport(transport)) {
        return { ok: false, error: transport + "_not_live" };
      }
      const detail = { source: "operator_text_input", inputMode: "text" };
      const control = input.sendEngineControl
        ? input.sendEngineControl("disconnect", { reason: "operator_realtime_disconnect", detail })
        : input.sendOperatorEvent(engineControlMessage("disconnect", "operator_realtime_disconnect", detail));
      renderStatus();
      return { ok: Boolean(control), control: "disconnect" };
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
          conversationTransport: conversationTransport(),
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

    disconnectButton.addEventListener("click", () => {
      disconnectRealtime();
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = textInput.value;
      const result = sendText(value);
      if (result.ok) textInput.value = "";
    });

    renderStatus();

    return {
      sendText,
      connectRealtime,
      disconnectRealtime,
      renderStatus,
      form,
      textInput,
      modeStatus,
      connectButton,
      disconnectButton,
    };
  }

  window.MAB_LAN_OPERATOR_TEXT_INPUT = { create };
})();`;
}
