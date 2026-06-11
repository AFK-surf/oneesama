import type { VoiceState } from "./useVoice.ts";
import { voiceBarView } from "./voiceBarView.ts";

export function VoiceBar({ voice, connected }: { voice: VoiceState; connected: boolean }) {
  const view = voiceBarView(voice, connected);

  return (
    <section className="op-voice">
      <div className="op-panel-head compact">
        <div>
          <h2>Mic</h2>
          <p id="mic-state">{view.micStateLabel}</p>
        </div>
        <div className="op-voice-meter" aria-label="mic energy">
          <span className="op-voice-meter-fill" style={{ width: view.energyWidth }} />
        </div>
      </div>

      <div className="op-voice-controls">
        <select
          className="op-select"
          id="voice-device-select"
          value={voice.selectedDeviceId}
          onChange={(event) => voice.setSelectedDeviceId(event.target.value)}
        >
          <option value="">Default mic</option>
          {view.deviceOptions.map((device) => (
            <option key={device.key} value={device.value}>
              {device.label}
            </option>
          ))}
        </select>
        <button
          className="btn"
          id="refresh-voice-devices-button"
          onClick={() => void voice.refreshDevices()}
          type="button"
        >
          Refresh
        </button>
        {view.showStopMic ? (
          <button className="btn" id="voice-button" onClick={voice.stopMic} type="button">
            Stop mic
          </button>
        ) : (
          <button
            className="btn primary"
            id="voice-button"
            onClick={() => void voice.startMic().catch(() => undefined)}
            type="button"
            disabled={view.startMicDisabled}
          >
            Start mic
          </button>
        )}
        <button
          className="btn"
          id="voice-mute-button"
          onClick={voice.toggleMute}
          type="button"
          disabled={view.muteDisabled}
          aria-pressed={view.mutePressed}
        >
          {view.muteLabel}
        </button>
        <button
          className="btn"
          id="voice-ptt-button"
          onPointerDown={() => void voice.startPushToTalk().catch(() => undefined)}
          onPointerUp={voice.finishPushToTalk}
          onPointerCancel={voice.finishPushToTalk}
          type="button"
          aria-pressed={view.pushToTalkPressed}
          disabled={view.pushToTalkDisabled}
        >
          PTT
        </button>
        <label className="op-check">
          <input
            id="local-vad-toggle"
            type="checkbox"
            checked={view.localVadChecked}
            onChange={(event) => voice.setLocalVadEnabled(event.target.checked)}
          />
          <span>Local VAD</span>
        </label>
        <span className="op-inline-state" id="local-vad-state">
          {view.localVadStateLabel}
        </span>
      </div>
    </section>
  );
}
