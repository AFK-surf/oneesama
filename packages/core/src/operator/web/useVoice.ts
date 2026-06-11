import { useCallback, useEffect, useRef, useState } from "react";

import type { CanonicalEvent, OperatorBoot } from "./useRealtime.ts";
import { rmsEnergy, wsUrl } from "./protocol.ts";
import { useAssistantAudioPlayback } from "./useAssistantAudioPlayback.ts";
import { useLatestRef } from "./useLatestRef.ts";
import {
  LOCAL_VAD_THRESHOLD,
  createVoiceStreamId,
  localVadSnapshot,
  permissionStateForError,
  voiceChunkMessage,
  voiceCaptureSnapshot,
  voiceEngineControl,
  voiceStreamOpenedMessage,
} from "./voiceEvents.ts";

export interface VoiceDevice {
  index: number;
  deviceId: string;
  label: string;
  groupId: string;
}

export interface VoiceState {
  micOn: boolean;
  muted: boolean;
  pushToTalkActive: boolean;
  localVadEnabled: boolean;
  localVadActive: boolean;
  energy: number;
  devices: VoiceDevice[];
  selectedDeviceId: string;
  chunksSent: number;
  refreshDevices: () => Promise<VoiceDevice[]>;
  setSelectedDeviceId: (deviceId: string) => void;
  setLocalVadEnabled: (enabled: boolean) => void;
  startMic: () => Promise<void>;
  stopMic: () => void;
  toggleMute: () => void;
  startPushToTalk: () => Promise<void>;
  finishPushToTalk: () => void;
}

const CAPTURE_SAMPLE_RATE = 24000; // matches the session's declared pcm rate
const PROCESSOR_FRAMES = 1024;

/**
 * Voice for the React cockpit: mic capture (PCM16 @24k over the voice WS),
 * assistant audio playback, device selection, PTT, and local-VAD telemetry.
 */
export function useVoice(
  boot: OperatorBoot,
  subscribe: (listener: (event: CanonicalEvent) => void) => () => void,
  sendOperatorEvent: (message: Record<string, unknown>) => void,
): VoiceState {
  const [micOn, setMicOn] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [pushToTalkActive, setPushToTalkActive] = useState(false);
  const [localVadEnabled, setLocalVadEnabledState] = useState(false);
  const [localVadActive, setLocalVadActive] = useState(false);
  const [energy, setEnergy] = useState(0);
  const [devices, setDevices] = useState<VoiceDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceIdState] = useState("");
  const [chunksSent, setChunksSent] = useState(0);

  const mutedRef = useLatestRef(muted);
  const micOnRef = useLatestRef(micOn);
  const localVadEnabledRef = useLatestRef(localVadEnabled);
  const localVadActiveRef = useLatestRef(localVadActive);
  const energyRef = useLatestRef(energy);
  const devicesLengthRef = useLatestRef(devices.length);
  const selectedDeviceIdRef = useLatestRef(selectedDeviceId);
  const pushToTalkActiveRef = useLatestRef(pushToTalkActive);
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
    setMutedState(next);
  }, []);

  const reportMicBlocked = useCallback(
    (error: unknown) => {
      const message = String((error as Error)?.message || error || "microphone_blocked");
      sendOperatorEvent({
        type: "operator_mic_blocked",
        error: message,
        capture: voiceCaptureSnapshot({
          armed: false,
          muted: mutedRef.current,
          status: "blocked",
          error: message,
          permissionState: permissionStateForError(error),
          deviceId: selectedDeviceIdRef.current || null,
          availableDeviceCount: devicesLengthRef.current,
        }),
      });
    },
    [sendOperatorEvent],
  );

  const emitLocalVadConfigured = useCallback(
    (enabled: boolean, active = localVadActiveRef.current, lastEnergy = energyRef.current) => {
      sendOperatorEvent({
        type: "operator_local_vad_configured",
        localVad: localVadSnapshot({
          enabled,
          active: enabled ? active : false,
          lastEnergy,
        }),
        capture: {
          status: micOnRef.current ? "capturing" : "idle",
          deviceId: selectedDeviceIdRef.current || null,
        },
      });
    },
    [sendOperatorEvent],
  );

  const setLocalVadEnabled = useCallback(
    (enabled: boolean) => {
      localVadEnabledRef.current = enabled;
      setLocalVadEnabledState(enabled);
      if (!enabled) setLocalVadActive(false);
      emitLocalVadConfigured(enabled);
    },
    [emitLocalVadConfigured],
  );

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const nextDevices = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        index,
        deviceId: device.deviceId,
        label: device.label || `Microphone ${index + 1}`,
        groupId: device.groupId,
      }));
    setDevices(nextDevices);
    if (
      selectedDeviceIdRef.current &&
      !nextDevices.some((device) => device.deviceId === selectedDeviceIdRef.current)
    ) {
      selectedDeviceIdRef.current = "";
      setSelectedDeviceIdState("");
    }
    sendOperatorEvent({
      type: "operator_voice_devices_refreshed",
      availableDeviceCount: nextDevices.length,
      capture: {
        status: micOnRef.current ? "capturing" : "idle",
        deviceId: selectedDeviceIdRef.current || null,
      },
      localVad: localVadSnapshot({
        enabled: localVadEnabledRef.current,
        active: localVadEnabledRef.current && localVadActiveRef.current,
        lastEnergy: energyRef.current,
      }),
    });
    return nextDevices;
  }, [sendOperatorEvent]);

  const setVoiceMuted = useCallback(
    (nextMuted: boolean, reason = "operator_web_set_mute") => {
      setMuted(nextMuted);
      sendOperatorEvent(
        voiceEngineControl(boot.sessionId, "set_voice_muted", reason, { muted: nextMuted }),
      );
      sendOperatorEvent({
        type: "operator_mic_muted",
        capture: voiceCaptureSnapshot({
          armed: micOnRef.current,
          muted: nextMuted,
          status: micOnRef.current ? "capturing" : "idle",
          deviceId: selectedDeviceIdRef.current || null,
          availableDeviceCount: devicesLengthRef.current,
        }),
      });
    },
    [boot.sessionId, sendOperatorEvent, setMuted],
  );

  useEffect(() => {
    void refreshDevices().catch(() => undefined);
  }, [refreshDevices]);

  const stopMic = useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void captureCtxRef.current?.close?.();
    captureCtxRef.current = null;
    voiceWsRef.current?.close();
    voiceWsRef.current = null;
    setMicOn(false);
    setEnergy(0);
    setLocalVadActive(false);
    sendOperatorEvent({
      type: "operator_mic_disarmed",
      capture: voiceCaptureSnapshot({
        armed: false,
        muted: mutedRef.current,
        status: "idle",
        deviceId: selectedDeviceIdRef.current || null,
        availableDeviceCount: devicesLengthRef.current,
      }),
    });
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
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      void refreshDevices().catch(() => undefined);
      const track = stream.getAudioTracks()[0] || null;
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      try {
        ctx = new Ctor({ sampleRate: CAPTURE_SAMPLE_RATE });
      } catch {
        ctx = new Ctor();
      }
      captureCtxRef.current = ctx;
      await ctx.resume?.();

      const ws = new WebSocket(wsUrl(boot.token, "/operator/voice/ws"));
      voiceWsRef.current = ws;
      streamIdRef.current = createVoiceStreamId();
      seqRef.current = 0;
      setChunksSent(0);
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify(voiceStreamOpenedMessage(boot.sessionId, streamIdRef.current)));
        sendOperatorEvent(
          voiceEngineControl(boot.sessionId, "set_voice_armed", "operator_web_start_mic", {
            armed: true,
          }),
        );
        sendOperatorEvent({
          type: "operator_mic_armed",
          capture: voiceCaptureSnapshot({
            armed: true,
            muted: mutedRef.current,
            status: "capturing",
            permissionState: "granted",
            deviceId: selectedDeviceIdRef.current || null,
            deviceLabel: track?.label || "",
            availableDeviceCount: devicesLengthRef.current,
          }),
        });
      });

      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(PROCESSOR_FRAMES, 1, 1);
      processorRef.current = processor;
      const sink = ctx.createGain();
      sink.gain.value = 0;
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const energyValue = rmsEnergy(input);
        setEnergy(energyValue);
        const vadActive = energyValue >= LOCAL_VAD_THRESHOLD;
        if (localVadEnabledRef.current) setLocalVadActive(vadActive);
        if (mutedRef.current) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 1_000_000) return; // backpressure drop
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
        if (sequence % 8 === 0) setChunksSent(sequence + 1);
      };
      source.connect(processor);
      processor.connect(sink);
      sink.connect(ctx.destination);
      setMicOn(true);
    } catch (error) {
      processorRef.current?.disconnect();
      processorRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      void ctx?.close?.();
      if (captureCtxRef.current === ctx) captureCtxRef.current = null;
      voiceWsRef.current?.close();
      voiceWsRef.current = null;
      setMicOn(false);
      setEnergy(0);
      reportMicBlocked(error);
      throw error;
    }
  }, [boot.sessionId, boot.token, refreshDevices, reportMicBlocked, sendOperatorEvent]);

  const setSelectedDeviceId = useCallback(
    (deviceId: string) => {
      selectedDeviceIdRef.current = deviceId;
      setSelectedDeviceIdState(deviceId);
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
    setPushToTalkActive(true);
    pttPreviousMutedRef.current = mutedRef.current;
    pttStartedMicRef.current = !micOnRef.current;
    try {
      if (!micOnRef.current) await startMic();
      setVoiceMuted(false, "operator_web_ptt_start");
    } catch (error) {
      pushToTalkActiveRef.current = false;
      setPushToTalkActive(false);
      setVoiceMuted(pttPreviousMutedRef.current, "operator_web_ptt_failed");
      throw error;
    }
  }, [setVoiceMuted, startMic]);

  const finishPushToTalk = useCallback(() => {
    if (!pushToTalkActiveRef.current) return;
    pushToTalkActiveRef.current = false;
    setPushToTalkActive(false);
    setVoiceMuted(
      pttStartedMicRef.current ? true : pttPreviousMutedRef.current,
      "operator_web_ptt_finish",
    );
  }, [setVoiceMuted]);

  useEffect(() => () => stopMic(), [stopMic]);

  return {
    micOn,
    muted,
    pushToTalkActive,
    localVadEnabled,
    localVadActive,
    energy,
    devices,
    selectedDeviceId,
    chunksSent,
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
