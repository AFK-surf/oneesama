(() => {
  interface RealtimeAgentTransportHelperDeps {
    state: Record<string, any>;
    recordTimeline(type: string, detail?: Record<string, unknown>): void;
  }

  function create(deps: RealtimeAgentTransportHelperDeps) {
    const { state, recordTimeline } = deps;

    function createMockRealtimeAgentTransport() {
      const listeners = new Map<string, Function[]>();
      const emit = (type: string, event: Record<string, unknown> = {}) => {
        const callbacks = listeners.get(type) || [];
        for (const callback of callbacks) callback(event);
      };
      const sendEvent = (event: Record<string, unknown>) => {
        state.connection.sentDataChannelMessages.push({
          ts: new Date().toISOString(),
          payload: JSON.stringify(event),
          runtime: "agents-sdk",
        });
        state.connection.sentDataChannelMessages =
          state.connection.sentDataChannelMessages.slice(-100);
        emit("transport_event", event);
      };
      const transport: any = {
        status: "disconnected",
        muted: false,
        on(type: string, callback: Function) {
          const callbacks = listeners.get(type) || [];
          callbacks.push(callback);
          listeners.set(type, callbacks);
          return this;
        },
        off(type: string, callback: Function) {
          const callbacks = listeners.get(type) || [];
          listeners.set(
            type,
            callbacks.filter((entry) => entry !== callback),
          );
          return this;
        },
        once(type: string, callback: Function) {
          const wrapped = (event: Record<string, unknown>) => {
            transport.off(type, wrapped);
            callback(event);
          };
          transport.on(type, wrapped);
          return this;
        },
        emit,
        async connect(options: Record<string, unknown> = {}) {
          transport.status = "connecting";
          recordTimeline("realtime_agent_sdk_mock_connecting", {
            model: options?.model || "",
            hasApiKey: Boolean(options?.apiKey),
          });
          transport.status = "connected";
          emit("transport_event", { type: "connected", model: options?.model || "" });
        },
        close() {
          transport.status = "disconnected";
          emit("transport_event", { type: "disconnected" });
        },
        sendEvent,
        requestResponse(response: Record<string, unknown> = {}) {
          sendEvent({ type: "response.create", response: response || {} });
        },
        sendMessage(
          message: unknown,
          otherEventData: Record<string, unknown> = {},
          options: { triggerResponse?: boolean } = {},
        ) {
          sendEvent({ type: "conversation.item.create", message, ...otherEventData });
          if (options.triggerResponse) transport.requestResponse();
        },
        addImage(image: unknown) {
          sendEvent({ type: "conversation.item.create", image });
        },
        sendAudio(_audio: unknown, options: { commit?: boolean } = {}) {
          sendEvent({ type: "input_audio_buffer.append", commit: options.commit === true });
        },
        updateSessionConfig(sessionConfig: Record<string, unknown>) {
          sendEvent({ type: "session.update", session: sessionConfig || {} });
        },
        sendFunctionCallOutput(toolCall: any, output: unknown, startResponse: boolean) {
          sendEvent({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: toolCall?.callId || toolCall?.call_id || "",
              output,
            },
          });
          if (startResponse) transport.requestResponse();
        },
        mute(muted: boolean) {
          transport.muted = Boolean(muted);
        },
        interrupt() {
          sendEvent({ type: "response.cancel" });
        },
        resetHistory(oldHistory: unknown[] = [], newHistory: unknown[] = []) {
          sendEvent({
            type: "mock.reset_history",
            oldItems: Array.isArray(oldHistory) ? oldHistory.length : 0,
            newItems: Array.isArray(newHistory) ? newHistory.length : 0,
          });
          emit("transport_event", {
            type: "history_updated",
            oldItems: Array.isArray(oldHistory) ? oldHistory.length : 0,
            newItems: Array.isArray(newHistory) ? newHistory.length : 0,
          });
        },
        sendMcpResponse() {},
      };
      return transport;
    }

    return { createMockRealtimeAgentTransport };
  }

  (window as any).__MAB_REALTIME_AGENT_TRANSPORT_HELPERS = { create };
})();
