import { useCallback, useEffect, useReducer, useRef } from "react";

import type { CanonicalEvent, OperatorBoot } from "./useRealtime.ts";
import { rmsEnergy, wsUrl } from "./protocol.ts";
import { useAssistantAudioPlayback } from "./useAssistantAudioPlayback.ts";
import { useLatestRef } from "./useLatestRef.ts";
import {
  CAPTURE_SAMPLE_RATE,
  PROCESSOR_FRAMES,
  canSendVoiceChunk,
  createVoiceCaptureAudioContext,
  shouldPublishVoiceChunkCount,
  stopVoiceCaptureResources,
  voiceAudioConstraints,
} from "./voiceCaptureResources.ts";
import { INITIAL_VOICE_VIEW, voiceViewReducer } from "./voiceState.ts";
import type { VoiceViewState } from "./voiceState.ts";
import {
  listVoiceInputDevices,
  selectedVoiceDeviceMissing,
  type VoiceDevice,
} from "./voiceDevices.ts";
import {
  LOCAL_VAD_THRESHOLD,
  createVoiceStreamId,
  localVadConfiguredMessage,
  micArmedMessage,
  micBlockedMessage,
  micDisarmedMessage,
  micMutedMessage,
  voiceChunkMessage,
  voiceDevicesRefreshedMessage,
  voiceEngineControl,
  voiceStreamOpenedMessage,
} from "./voiceEvents.ts";

export interface VoiceState extends VoiceViewState {
  refreshDevices: () => Promise<VoiceDevice[]>;
  setSelectedDeviceId: (deviceId: string) => void;
  setLocalVadEnabled: (enabled: boolean) => void;
  startMic: () => Promise<void>;
  stopMic: () => void;
  toggleMute: () => void;
  startPushToTalk: () => Promise<void>;
  finishPushToTalk: () => void;
}

/**
 * Voice for the React cockpit: mic capture (PCM16 @24k over the voice WS),
 * assistant audio playback, device selection, PTT, and local-VAD telemetry.
 */
export function useVoice(
  boot: OperatorBoot,
  subscribe: (listener: (event: CanonicalEvent) => void) => () => void,
  sendOperatorEvent: (message: Record<string, unknown>) => void,
): VoiceState {
  const [voiceView, dispatch] = useReducer(voiceViewReducer, INITIAL_VOICE_VIEW);

  const mutedRef = useLatestRef(voiceView.muted);
  const micOnRef = useLatestRef(voiceView.micOn);
  const localVadEnabledRef = useLatestRef(voiceView.localVadEnabled);
  const localVadActiveRef = useLatestRef(voiceView.localVadActive);
  const energyRef = useLatestRef(voiceView.energy);
  const devicesLengthRef = useLatestRef(voiceView.devices.length);
  const selectedDeviceIdRef = useLatestRef(voiceView.selectedDeviceId);
  const pushToTalkActiveRef = useLatestRef(voiceView.pushToTalkActive);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const voiceWsRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(0);
  const streamIdRef = useRef("");
  const pttPreviousMutedRef = useRef(false);
  const pttStartedMicRef = useRef(false);

  useAssistantAudioPlayback(subscribe);

  const setMuted = useCallback((next: boolean) => {
    mutedRef.current = next;
    dispatch({ type: "set_muted", muted: next });
  }, []);

  const reportMicBlocked = useCallback(
    (error: unknown) => {
      sendOperatorEvent(
        micBlockedMessage({
          error,
          muted: mutedRef.current,
          deviceId: selectedDeviceIdRef.current,
          availableDeviceCount: devicesLengthRef.current,
        }),
      );
    },
    [sendOperatorEvent],
  );

  const emitLocalVadConfigured = useCallback(
    (enabled: boolean, active = localVadActiveRef.current, lastEnergy = energyRef.current) => {
      sendOperatorEvent(
        localVadConfiguredMessage({
          enabled,
          active,
          lastEnergy,
          micOn: micOnRef.current,
          deviceId: selectedDeviceIdRef.current,
        }),
      );
    },
    [sendOperatorEvent],
  );

  const setLocalVadEnabled = useCallback(
    (enabled: boolean) => {
      localVadEnabledRef.current = enabled;
      dispatch({ type: "set_local_vad_enabled", enabled });
      if (!enabled) localVadActiveRef.current = false;
      emitLocalVadConfigured(enabled);
    },
    [emitLocalVadConfigured],
  );

  const refreshDevices = useCallback(async () => {
    const nextDevices = await listVoiceInputDevices(navigator.mediaDevices);
    let nextSelectedDeviceId = selectedDeviceIdRef.current;
    if (selectedVoiceDeviceMissing(nextDevices, selectedDeviceIdRef.current)) {
      nextSelectedDeviceId = "";
      selectedDeviceIdRef.current = nextSelectedDeviceId;
    }
    dispatch({
      type: "set_devices",
      devices: nextDevices,
      selectedDeviceId: nextSelectedDeviceId,
    });
    sendOperatorEvent(
      voiceDevicesRefreshedMessage({
        availableDeviceCount: nextDevices.length,
        enabled: localVadEnabledRef.current,
        active: localVadActiveRef.current,
        lastEnergy: energyRef.current,
        micOn: micOnRef.current,
        deviceId: selectedDeviceIdRef.current,
      }),
    );
    return nextDevices;
  }, [sendOperatorEvent]);

  const setVoiceMuted = useCallback(
    (nextMuted: boolean, reason = "operator_web_set_mute") => {
      setMuted(nextMuted);
      sendOperatorEvent(
        voiceEngineControl(boot.sessionId, "set_voice_muted", reason, { muted: nextMuted }),
      );
      sendOperatorEvent(
        micMutedMessage({
          muted: nextMuted,
          micOn: micOnRef.current,
          deviceId: selectedDeviceIdRef.current,
          availableDeviceCount: devicesLengthRef.current,
        }),
      );
    },
    [boot.sessionId, sendOperatorEvent, setMuted],
  );

  useEffect(() => {
    void refreshDevices().catch(() => undefined);
  }, [refreshDevices]);

  const stopMic = useCallback(() => {
    stopVoiceCaptureResources({
      processor: processorRef.current,
      stream: streamRef.current,
      audioContext: captureCtxRef.current,
      websocket: voiceWsRef.current,
    });
    processorRef.current = null;
    streamRef.current = null;
    captureCtxRef.current = null;
    voiceWsRef.current = null;
    dispatch({ type: "mic_stopped" });
    sendOperatorEvent(
      micDisarmedMessage({
        muted: mutedRef.current,
        deviceId: selectedDeviceIdRef.current,
        availableDeviceCount: devicesLengthRef.current,
      }),
    );
    sendOperatorEvent(
      voiceEngineControl(boot.sessionId, "set_voice_armed", "operator_web_stop_mic", {
        armed: false,
      }),
    );
  }, [boot.sessionId, sendOperatorEvent]);

  const startMic = useCallback(async () => {
    if (micOnRef.current) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    try {
      const deviceId = selectedDeviceIdRef.current;
      stream = await navigator.mediaDevices.getUserMedia(voiceAudioConstraints(deviceId));
      streamRef.current = stream;
      void refreshDevices().catch(() => undefined);
      const track = stream.getAudioTracks()[0] || null;
      ctx = await createVoiceCaptureAudioContext(window);
      captureCtxRef.current = ctx;

      const ws = new WebSocket(wsUrl(boot.token, "/operator/voice/ws"));
      voiceWsRef.current = ws;
      streamIdRef.current = createVoiceStreamId();
      seqRef.current = 0;
      dispatch({ type: "set_chunks_sent", chunksSent: 0 });
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify(voiceStreamOpenedMessage(boot.sessionId, streamIdRef.current)));
        sendOperatorEvent(
          voiceEngineControl(boot.sessionId, "set_voice_armed", "operator_web_start_mic", {
            armed: true,
          }),
        );
        sendOperatorEvent(
          micArmedMessage({
            muted: mutedRef.current,
            deviceId: selectedDeviceIdRef.current,
            deviceLabel: track?.label || "",
            availableDeviceCount: devicesLengthRef.current,
          }),
        );
      });

      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(PROCESSOR_FRAMES, 1, 1);
      processorRef.current = processor;
      const sink = ctx.createGain();
      sink.gain.value = 0;
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const energyValue = rmsEnergy(input);
        dispatch({ type: "set_energy", energy: energyValue });
        const vadActive = energyValue >= LOCAL_VAD_THRESHOLD;
        if (localVadEnabledRef.current) {
          localVadActiveRef.current = vadActive;
          dispatch({ type: "set_local_vad_active", active: vadActive });
        }
        if (
          !canSendVoiceChunk({
            muted: mutedRef.current,
            readyState: ws.readyState,
            bufferedAmount: ws.bufferedAmount,
          })
        ) {
          return;
        }
        const sequence = seqRef.current++;
        ws.send(
          JSON.stringify(
            voiceChunkMessage({
              samples: input,
              sampleRate: ctx?.sampleRate || CAPTURE_SAMPLE_RATE,
              energy: energyValue,
              monotonicMs: performance.now(),
              sentAt: new Date().toISOString(),
              sequence,
              voiceStreamId: streamIdRef.current,
              sessionId: boot.sessionId,
            }),
          ),
        );
        if (shouldPublishVoiceChunkCount(sequence)) {
          dispatch({ type: "set_chunks_sent", chunksSent: sequence + 1 });
        }
      };
      source.connect(processor);
      processor.connect(sink);
      sink.connect(ctx.destination);
      dispatch({ type: "mic_started" });
    } catch (error) {
      stopVoiceCaptureResources({
        processor: processorRef.current,
        stream,
        audioContext: ctx,
        websocket: voiceWsRef.current,
      });
      processorRef.current = null;
      streamRef.current = null;
      if (captureCtxRef.current === ctx) captureCtxRef.current = null;
      voiceWsRef.current = null;
      dispatch({ type: "mic_stopped" });
      reportMicBlocked(error);
      throw error;
    }
  }, [boot.sessionId, boot.token, refreshDevices, reportMicBlocked, sendOperatorEvent]);

  const setSelectedDeviceId = useCallback(
    (deviceId: string) => {
      selectedDeviceIdRef.current = deviceId;
      dispatch({ type: "set_selected_device", deviceId });
      if (micOnRef.current) {
        stopMic();
        window.setTimeout(() => void startMic().catch(() => undefined), 0);
      }
    },
    [startMic, stopMic],
  );

  const toggleMute = useCallback(() => {
    setVoiceMuted(!mutedRef.current, "operator_web_toggle_mute");
  }, [setVoiceMuted]);

  const startPushToTalk = useCallback(async () => {
    if (pushToTalkActiveRef.current) return;
    pushToTalkActiveRef.current = true;
    dispatch({ type: "set_push_to_talk_active", active: true });
    pttPreviousMutedRef.current = mutedRef.current;
    pttStartedMicRef.current = !micOnRef.current;
    try {
      if (!micOnRef.current) await startMic();
      setVoiceMuted(false, "operator_web_ptt_start");
    } catch (error) {
      pushToTalkActiveRef.current = false;
      dispatch({ type: "set_push_to_talk_active", active: false });
      setVoiceMuted(pttPreviousMutedRef.current, "operator_web_ptt_failed");
      throw error;
    }
  }, [setVoiceMuted, startMic]);

  const finishPushToTalk = useCallback(() => {
    if (!pushToTalkActiveRef.current) return;
    pushToTalkActiveRef.current = false;
    dispatch({ type: "set_push_to_talk_active", active: false });
    setVoiceMuted(
      pttStartedMicRef.current ? true : pttPreviousMutedRef.current,
      "operator_web_ptt_finish",
    );
  }, [setVoiceMuted]);

  useEffect(() => () => stopMic(), [stopMic]);

  return {
    ...voiceView,
    refreshDevices,
    setSelectedDeviceId,
    setLocalVadEnabled,
    startMic,
    stopMic,
    toggleMute,
    startPushToTalk,
    finishPushToTalk,
  };
}
