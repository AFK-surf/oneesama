export function buildLanOperatorVoiceControlsClientScript() {
  return `(() => {
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function create(options) {
    const state = options.state;
    const nodes = {
      deviceSelect: document.getElementById("voice-device-select"),
      refreshButton: document.getElementById("refresh-voice-devices-button"),
      voiceButton: document.getElementById("voice-button"),
      muteButton: document.getElementById("voice-mute-button"),
      pttButton: document.getElementById("voice-ptt-button"),
      vadToggle: document.getElementById("local-vad-toggle"),
      energyBar: document.getElementById("voice-energy-bar"),
      energyLabel: document.getElementById("voice-energy-label"),
      micState: document.getElementById("mic-state"),
      vadState: document.getElementById("local-vad-state"),
    };
    let pttPreviousMuted = false;
    let pttStartedMic = false;

    function renderDeviceOptions() {
      const selected = state.voiceDeviceId || "";
      nodes.deviceSelect.replaceChildren();
      const defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = "Default mic";
      nodes.deviceSelect.appendChild(defaultOption);
      for (const device of state.voiceDevices) {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || "Microphone " + String(device.index + 1);
        nodes.deviceSelect.appendChild(option);
      }
      nodes.deviceSelect.value = selected;
    }

    function update() {
      const capture = state.voiceCapture || {};
      const localVad = state.voiceLocalVad || {};
      const energy = Number(capture.lastEnergy ?? localVad.lastEnergy ?? 0);
      nodes.voiceButton.textContent = state.voiceArmed ? "Disarm" : "Arm";
      nodes.voiceButton.classList.toggle("primary", !state.voiceArmed);
      nodes.muteButton.textContent = state.voiceMuted ? "Unmute" : "Mute";
      nodes.muteButton.disabled = !state.voiceArmed;
      nodes.pttButton.setAttribute("aria-pressed", state.voicePushToTalkActive ? "true" : "false");
      nodes.vadToggle.checked = state.localVadEnabled !== false;
      nodes.energyBar.style.width = String(clamp(energy * 420, 0, 100)) + "%";
      nodes.energyLabel.textContent = String(Math.round(energy * 100) / 100);
      nodes.micState.textContent = [
        state.voiceArmed ? "armed" : "idle",
        state.voiceMuted ? "muted" : "open",
        capture.status || "idle",
      ].join(" / ");
      nodes.vadState.textContent = localVad.enabled
        ? (localVad.active ? "active" : "quiet") + " " + String(Math.round(Number(localVad.threshold || 0) * 100) / 100)
        : "disabled";
    }

    async function refreshDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) {
        state.voiceCapture = { ...state.voiceCapture, status: "blocked", error: "media_devices_unavailable" };
        options.syncDebug?.();
        return [];
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      state.voiceDevices = devices
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({
          index,
          deviceId: device.deviceId,
          label: device.label,
          groupId: device.groupId,
        }));
      if (state.voiceDeviceId && !state.voiceDevices.some((device) => device.deviceId === state.voiceDeviceId)) {
        state.voiceDeviceId = "";
        options.persistUserState?.();
      }
      state.voiceCapture = { ...state.voiceCapture, availableDeviceCount: state.voiceDevices.length };
      renderDeviceOptions();
      options.sendOperatorEvent?.({
        type: "operator_voice_devices_refreshed",
        availableDeviceCount: state.voiceDevices.length,
        capture: state.voiceCapture,
        localVad: state.voiceLocalVad,
      });
      options.syncDebug?.();
      return state.voiceDevices;
    }

    function configureLocalVad(enabled) {
      state.localVadEnabled = Boolean(enabled);
      state.voiceLocalVad = {
        ...(state.voiceLocalVad || {}),
        enabled: state.localVadEnabled,
        role: state.localVadEnabled ? "telemetry" : "disabled",
        active: state.localVadEnabled ? Boolean(state.voiceLocalVad?.active) : false,
        threshold: Number(state.voiceLocalVad?.threshold ?? 0.02),
        lastUpdatedAt: new Date().toISOString(),
      };
      options.sendOperatorEvent?.({
        type: "operator_local_vad_configured",
        localVad: state.voiceLocalVad,
        capture: state.voiceCapture,
      });
      options.persistUserState?.();
      options.syncDebug?.();
      return state.voiceLocalVad;
    }

    function reportMicBlocked(error) {
      state.errors.push(String(error?.message || error));
      options.sendOperatorEvent?.({
        type: "operator_mic_blocked",
        error: String(error?.message || error),
        capture: state.voiceCapture,
        localVad: state.voiceLocalVad,
      });
      options.syncDebug?.();
    }

    async function toggleArm() {
      try {
        if (state.voiceArmed) await options.stopMicrophone("operator_disarmed");
        else await options.startMicrophone();
      } catch (error) {
        reportMicBlocked(error);
      }
    }

    async function changeDevice() {
      state.voiceDeviceId = nodes.deviceSelect.value || "";
      options.persistUserState?.();
      if (!state.voiceArmed) {
        options.syncDebug?.();
        return;
      }
      try {
        await options.stopMicrophone("operator_device_change");
        await options.startMicrophone();
      } catch (error) {
        reportMicBlocked(error);
      }
    }

    async function startPushToTalk() {
      if (state.voicePushToTalkActive) return;
      state.voicePushToTalkActive = true;
      pttPreviousMuted = state.voiceMuted;
      pttStartedMic = !state.voiceArmed;
      options.syncDebug?.();
      try {
        if (!state.voiceArmed) await options.startMicrophone();
        options.setVoiceMuted(false);
      } catch (error) {
        state.voicePushToTalkActive = false;
        reportMicBlocked(error);
      }
    }

    function finishPushToTalk() {
      if (!state.voicePushToTalkActive) return;
      state.voicePushToTalkActive = false;
      options.setVoiceMuted(pttStartedMic ? true : pttPreviousMuted);
      options.syncDebug?.();
    }

    function bind() {
      nodes.refreshButton.addEventListener("click", () => void refreshDevices().catch(reportMicBlocked));
      nodes.deviceSelect.addEventListener("change", () => void changeDevice());
      nodes.voiceButton.addEventListener("click", () => void toggleArm());
      nodes.muteButton.addEventListener("click", () => options.setVoiceMuted(!state.voiceMuted));
      nodes.vadToggle.addEventListener("change", () => configureLocalVad(nodes.vadToggle.checked));
      nodes.pttButton.addEventListener("pointerdown", () => void startPushToTalk());
      nodes.pttButton.addEventListener("pointerup", finishPushToTalk);
      nodes.pttButton.addEventListener("pointercancel", finishPushToTalk);
      nodes.pttButton.addEventListener("lostpointercapture", finishPushToTalk);
    }

    return { bind, update, renderDeviceOptions, refreshDevices, configureLocalVad };
  }

  window.MAB_LAN_OPERATOR_VOICE_CONTROLS = { create };
})();`;
}
