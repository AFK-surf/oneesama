import { copyProviderRunCommand } from "./commandBarActions.ts";
import { commandBarView } from "./commandBarView.ts";
import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";
import type { OperatorBoot, RealtimeState } from "./useRealtime.ts";

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
  const view = commandBarView(runtime, realtime);

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
            value={view.selectedTransport}
            disabled={!providerConfig?.runtimeSwitchSupported || view.switching}
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
              <option value={view.selectedTransport}>{view.selectedTransport || "unknown"}</option>
            ) : null}
          </select>
        </label>

        <div className="op-provider-detail" id="conversation-provider-status">
          <span>{view.providerModel}</span>
          <span>{view.providerKeySource}</span>
          <span>{view.providerStatus}</span>
        </div>
      </div>

      <div className="op-command-actions">
        <StatusPill label="runtime" value={view.health} tone={view.runtimeTone} />
        <StatusPill label="events" value={view.eventsLabel} tone={view.eventsTone} />
        <StatusPill
          label="session"
          value={view.connectionStatus}
          tone={view.sessionTone}
          id="operator-realtime-mode-status"
        />
        <button
          className="btn"
          onClick={() => {
            void copyProviderRunCommand(selectedProvider?.runCommand || "", navigator.clipboard);
          }}
          type="button"
          disabled={view.copyEnvDisabled}
        >
          Copy Env
        </button>

        {view.connectionStatus === "connected" ? (
          <button className="btn" onClick={realtime.disconnect} type="button">
            Disconnect
          </button>
        ) : (
          <button
            className="btn primary"
            onClick={realtime.connect}
            type="button"
            disabled={view.connectButtonDisabled}
          >
            Connect
          </button>
        )}
        <button
          className="btn"
          onClick={() => runtime.sendEngineControl("cancel_response")}
          type="button"
          disabled={view.stopReplyDisabled}
          id="cancel-response-button"
        >
          Stop reply
        </button>
        <button
          className="btn"
          onClick={() => runtime.cancelTool()}
          type="button"
          disabled={view.stopActionDisabled}
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
