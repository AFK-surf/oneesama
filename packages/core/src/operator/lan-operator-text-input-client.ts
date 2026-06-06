export function buildLanOperatorTextInputClientScript() {
  return `(() => {
  function create(input) {
    const state = input.state;
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
    textInput.style.minWidth = "190px";
    const sendButton = document.createElement("button");
    sendButton.id = "operator-text-send-button";
    sendButton.className = "btn";
    sendButton.type = "submit";
    sendButton.textContent = "Send Text";
    form.append(textInput, sendButton);
    toolbar?.insertBefore(form, voiceTools || null);

    function nextInputId() {
      return "text_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
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

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = textInput.value;
      const result = sendText(value);
      if (result.ok) textInput.value = "";
    });

    return { sendText, form, textInput };
  }

  window.MAB_LAN_OPERATOR_TEXT_INPUT = { create };
})();`;
}
