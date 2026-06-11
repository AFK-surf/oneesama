import type { VoiceState } from "./useVoice.ts";

export function VoiceBar({ voice, connected }: { voice: VoiceState; connected: boolean }) {
  const energyPercent = Math.min(100, Math.round(voice.energy * 420));

  return (
    <section className="op-voice">
      <div className="op-panel-head compact">
        <div>
          <h2>Mic</h2>
          <p id="mic-state">
            {voice.micOn ? "armed" : "idle"} / {voice.muted ? "muted" : "open"}
          </p>
        </div>
        <div className="op-voice-meter" aria-label="mic energy">
          <span className="op-voice-meter-fill" style={{ width: `${energyPercent}%` }} />
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
          {voice.devices.map((device) => (
            <option key={device.deviceId || device.index} value={device.deviceId}>
              {device.label || `Microphone ${device.index + 1}`}
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
        {voice.micOn ? (
          <button className="btn" id="voice-button" onClick={voice.stopMic} type="button">
            Stop mic
          </button>
        ) : (
          <button
            className="btn primary"
            id="voice-button"
            onClick={() => void voice.startMic().catch(() => undefined)}
            type="button"
            disabled={!connected}
          >
            Start mic
          </button>
        )}
        <button
          className="btn"
          id="voice-mute-button"
          onClick={voice.toggleMute}
          type="button"
          disabled={!voice.micOn}
          aria-pressed={voice.muted}
        >
          {voice.muted ? "Unmute" : "Mute"}
        </button>
        <button
          className="btn"
          id="voice-ptt-button"
          onPointerDown={() => void voice.startPushToTalk().catch(() => undefined)}
          onPointerUp={voice.finishPushToTalk}
          onPointerCancel={voice.finishPushToTalk}
          type="button"
          aria-pressed={voice.pushToTalkActive}
          disabled={!connected}
        >
          PTT
        </button>
        <label className="op-check">
          <input
            id="local-vad-toggle"
            type="checkbox"
            checked={voice.localVadEnabled}
            onChange={(event) => voice.setLocalVadEnabled(event.target.checked)}
          />
          <span>Local VAD</span>
        </label>
        <span className="op-inline-state" id="local-vad-state">
          {voice.localVadEnabled ? (voice.localVadActive ? "active" : "quiet") : "disabled"}{" "}
          {Math.round(voice.energy * 100) / 100}
        </span>
      </div>
    </section>
  );
}
