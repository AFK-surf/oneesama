import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";
import type { OperatorBoot, RealtimeState } from "./useRealtime.ts";

const STATUS_TONE: Record<string, string> = {
  connected: "ok",
  connecting: "warn",
  degraded: "warn",
  failed: "bad",
  not_connected: "idle",
};

export function CommandBar({
  boot,
  realtime,
  runtime,
}: {
  boot: OperatorBoot;
  realtime: RealtimeState;
  runtime: OperatorRuntimeState;
}) {
  const providerConfig = runtime.providerConfig;
  const selectedProvider = runtime.selectedProvider;
  const selectedTransport =
    selectedProvider?.transport ||
    providerConfig?.selectedLiveTransport ||
    providerConfig?.selectedTransport ||
    realtime.transport;
  const connectionStatus =
    String(runtime.debug.conversation?.status || realtime.status || "not_connected") ||
    "not_connected";
  const health = String(runtime.snapshot?.health || "starting");
  const switching = runtime.providerSwitch.status === "switching";
  const canConnect = realtime.wsOpen && connectionStatus !== "connected";
  const canStopAction =
    /started|streaming|running|observing|planning|executing|verifying/i.test(
      String(runtime.debug.toolRouting?.status || runtime.debug.kwwk?.status || ""),
    ) || Number(runtime.debug.conversation?.control?.inFlight || 0) > 0;

  return (
    <header className="op-command">
      <div className="op-brand">
        <div className="op-brand-name">{boot.botName || "Oneesama"}</div>
        <div className="op-brand-sub">Local Operator Cockpit</div>
      </div>

      <div className="op-command-center">
        <label className="op-provider">
          <span>Provider</span>
          <select
            className="op-select"
            value={selectedTransport}
            disabled={!providerConfig?.runtimeSwitchSupported || switching}
            onChange={(event) => void runtime.switchProvider(event.target.value)}
            id="conversation-provider-select"
          >
            {(providerConfig?.providers || []).map((provider) => (
              <option
                key={provider.transport}
                value={provider.transport}
                disabled={!provider.keyConfigured}
              >
                {provider.label}
                {provider.keyConfigured ? "" : " (missing key)"}
              </option>
            ))}
            {!providerConfig?.providers?.length ? (
              <option value={selectedTransport}>{selectedTransport || "unknown"}</option>
            ) : null}
          </select>
        </label>

        <div className="op-provider-detail" id="conversation-provider-status">
          <span>{selectedProvider?.model || selectedTransport || "unknown"}</span>
          <span>{selectedProvider?.keySource || "no key source"}</span>
          <span>{switching ? "switching" : "selected"}</span>
        </div>
      </div>

      <div className="op-command-actions">
        <StatusPill label="runtime" value={health} tone={health === "ready" ? "ok" : "warn"} />
        <StatusPill
          label="events"
          value={realtime.wsOpen ? "ws open" : "ws closed"}
          tone={realtime.wsOpen ? "ok" : "idle"}
        />
        <StatusPill
          label="session"
          value={connectionStatus}
          tone={STATUS_TONE[connectionStatus] || "idle"}
          id="operator-realtime-mode-status"
        />
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard?.writeText?.(selectedProvider?.runCommand || "");
          }}
          type="button"
          disabled={!selectedProvider?.runCommand}
        >
          Copy Env
        </button>

        {connectionStatus === "connected" ? (
          <button className="btn" onClick={realtime.disconnect} type="button">
            Disconnect
          </button>
        ) : (
          <button
            className="btn primary"
            onClick={realtime.connect}
            type="button"
            disabled={!canConnect}
          >
            Connect
          </button>
        )}
        <button
          className="btn"
          onClick={() => runtime.sendEngineControl("cancel_response")}
          type="button"
          disabled={!runtime.debug.output?.assistantText?.currentText}
          id="cancel-response-button"
        >
          Stop reply
        </button>
        <button
          className="btn"
          onClick={() => runtime.cancelTool()}
          type="button"
          disabled={!canStopAction}
          id="cancel-tool-button"
        >
          Stop action
        </button>
        <button
          className="btn"
          onClick={() => runtime.sendEngineControl("clear_audio_buffer")}
          type="button"
        >
          Clear audio
        </button>
        <button
          className="btn danger"
          onClick={() => {
            if (window.confirm("Reset the Realtime session?")) {
              runtime.sendEngineControl("reset_session");
            }
          }}
          type="button"
        >
          Reset
        </button>
      </div>
    </header>
  );
}

function StatusPill({
  label,
  value,
  tone,
  id,
}: {
  label: string;
  value: string;
  tone: string;
  id?: string;
}) {
  return (
    <span className={`op-status-pill tone-${tone}`} id={id}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}
