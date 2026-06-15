import { useCallback, useEffect, useReducer, useRef } from "react";

import type { CanonicalEvent, OperatorBoot } from "./useRealtime.ts";
import { wsUrl } from "./protocol.ts";
import { useAssistantAudioPlayback } from "./useAssistantAudioPlayback.ts";
import {
  VOICE_WS_OPEN_STATE,
  connectVoiceCaptureGraph,
  createVoiceCaptureAudioContext,
  stopVoiceCaptureResources,
  voiceAudioConstraints,
} from "./voiceCaptureResources.ts";
import { shouldPublishVoiceEnergy, voiceCaptureFrameDecision } from "./voiceCaptureFrames.ts";
import { INITIAL_VOICE_VIEW, voiceViewReducer } from "./voiceState.ts";
import type { VoiceViewAction, VoiceViewState } from "./voiceState.ts";
import {
  beginPushToTalk,
  failPushToTalk,
  finishPushToTalk as finishPushToTalkDecision,
} from "./voicePushToTalk.ts";
import {
  listVoiceInputDevices,
  selectedVoiceDeviceMissing,
  type VoiceDevice,
} from "./voiceDevices.ts";
import {
  createVoiceStreamId,
  localVadConfiguredMessage,
  micBlockedMessage,
  parseVoiceSocketPayload,
  voiceCaptureDisarmedMessages,
  voiceCaptureOpenedMessages,
  syntheticVoiceChunkMessage,
  voiceChunkAckObservedMessage,
  voiceDevicesRefreshedMessage,
  voiceMutedMessages,
  voiceStreamOpenedMessage,
} from "./voiceEvents.ts";

export interface SyntheticVoiceChunkInput {
  sequence?: number;
  voiceStreamId?: string;
  streamId?: string;
  voiceStreamGeneration?: number;
  sampleRate?: number;
  channels?: number;
  durationMs?: number;
  energy?: number;
  source?: string;
  dataBase64?: string;
}

export interface VoiceState extends VoiceViewState {
  refreshDevices: () => Promise<VoiceDevice[]>;
  setSelectedDeviceId: (deviceId: string) => void;
  setLocalVadEnabled: (enabled: boolean) => void;
  startMic: () => Promise<void>;
  stopMic: (reason?: string) => void;
  setVoiceMuted: (muted: boolean, reason?: string) => void;
  toggleMute: () => void;
  startPushToTalk: () => Promise<void>;
  finishPushToTalk: () => void;
  sendSyntheticVoiceChunk: (input?: SyntheticVoiceChunkInput) => boolean;
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
  const voiceViewRef = useRef(INITIAL_VOICE_VIEW);
  const [voiceView, rawDispatch] = useReducer(voiceViewReducer, INITIAL_VOICE_VIEW);
  const dispatch = useCallback((action: VoiceViewAction) => {
    voiceViewRef.current = voiceViewReducer(voiceViewRef.current, action);
    rawDispatch(action);
  }, []);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const voiceWsRef = useRef<WebSocket | null>(null);
  const syntheticVoiceWsRef = useRef<WebSocket | null>(null);
  const micStartPromiseRef = useRef<Promise<void> | null>(null);
  const captureGenerationRef = useRef(0);
  const seqRef = useRef(0);
  const streamIdRef = useRef("");
  const voiceStreamGenerationRef = useRef(0);
  const voiceReconnectTimerRef = useRef<number | null>(null);
  const energyPublishRef = useRef({ energy: 0, atMs: 0 });
  const syntheticSeqRef = useRef(0);
  const syntheticStreamIdRef = useRef("");
  const syntheticStreamGenerationRef = useRef(0);
  const pttPreviousMutedRef = useRef(false);
  const pttStartedMicRef = useRef(false);

  useAssistantAudioPlayback(subscribe, sendOperatorEvent);

  const setMuted = useCallback(
    (next: boolean) => {
      dispatch({ type: "set_muted", muted: next });
    },
    [dispatch],
  );

  const reportMicBlocked = useCallback(
    (error: unknown) => {
      sendOperatorEvent(
        micBlockedMessage({
          error,
          muted: voiceViewRef.current.muted,
          deviceId: voiceViewRef.current.selectedDeviceId,
          availableDeviceCount: voiceViewRef.current.devices.length,
        }),
      );
    },
    [sendOperatorEvent],
  );

  const handleVoiceSocketMessage = useCallback(
    (event: MessageEvent) => {
      const payload = parseVoiceSocketPayload(event.data);
      if (payload?.type !== "operator_voice_chunk_ack") return;
      sendOperatorEvent(voiceChunkAckObservedMessage(payload));
    },
    [sendOperatorEvent],
  );

  const clearVoiceReconnectTimer = useCallback(() => {
    if (voiceReconnectTimerRef.current == null) return;
    window.clearTimeout(voiceReconnectTimerRef.current);
    voiceReconnectTimerRef.current = null;
  }, []);

  const emitLocalVadConfigured = useCallback(
    (
      enabled: boolean,
      active = voiceViewRef.current.localVadActive,
      lastEnergy = voiceViewRef.current.energy,
    ) => {
      sendOperatorEvent(
        localVadConfiguredMessage({
          enabled,
          active,
          lastEnergy,
          micOn: voiceViewRef.current.micOn,
          deviceId: voiceViewRef.current.selectedDeviceId,
        }),
      );
    },
    [sendOperatorEvent],
  );

  const setLocalVadEnabled = useCallback(
    (enabled: boolean) => {
      dispatch({ type: "set_local_vad_enabled", enabled });
      emitLocalVadConfigured(enabled);
    },
    [dispatch, emitLocalVadConfigured],
  );

  const refreshDevices = useCallback(async () => {
    const nextDevices = await listVoiceInputDevices(navigator.mediaDevices);
    let nextSelectedDeviceId = voiceViewRef.current.selectedDeviceId;
    if (selectedVoiceDeviceMissing(nextDevices, voiceViewRef.current.selectedDeviceId)) {
      nextSelectedDeviceId = "";
    }
    dispatch({
      type: "set_devices",
      devices: nextDevices,
      selectedDeviceId: nextSelectedDeviceId,
    });
    sendOperatorEvent(
      voiceDevicesRefreshedMessage({
        availableDeviceCount: nextDevices.length,
        enabled: voiceViewRef.current.localVadEnabled,
        active: voiceViewRef.current.localVadActive,
        lastEnergy: voiceViewRef.current.energy,
        micOn: voiceViewRef.current.micOn,
        deviceId: nextSelectedDeviceId,
      }),
    );
    return nextDevices;
  }, [dispatch, sendOperatorEvent]);

  const setVoiceMuted = useCallback(
    (nextMuted: boolean, reason = "operator_web_set_mute") => {
      setMuted(nextMuted);
      const muted = voiceMutedMessages({
        sessionId: boot.sessionId,
        reason,
        muted: nextMuted,
        micOn: voiceViewRef.current.micOn,
        deviceId: voiceViewRef.current.selectedDeviceId,
        availableDeviceCount: voiceViewRef.current.devices.length,
      });
      for (const message of muted.operatorEvents) sendOperatorEvent(message);
    },
    [boot.sessionId, sendOperatorEvent, setMuted],
  );

  useEffect(() => {
    void refreshDevices().catch(() => undefined);
  }, [refreshDevices]);

  useEffect(() => {
    if (voiceView.micOn) {
      const socket = syntheticVoiceWsRef.current;
      syntheticVoiceWsRef.current = null;
      syntheticStreamIdRef.current = "";
      dispatch({ type: "set_synthetic_voice_ready", ready: false });
      socket?.close();
      return () => undefined;
    }

    let closed = false;
    let reconnectTimer: number | null = null;

    const connectSyntheticVoiceSocket = () => {
      const ws = new WebSocket(wsUrl(boot.token, "/operator/voice/ws"));
      syntheticVoiceWsRef.current = ws;
      dispatch({ type: "set_synthetic_voice_ready", ready: false });
      ws.addEventListener("open", () => {
        if (closed) return;
        syntheticStreamGenerationRef.current = 1;
        syntheticStreamIdRef.current = createVoiceStreamId();
        syntheticSeqRef.current = 0;
        ws.send(
          JSON.stringify(
            voiceStreamOpenedMessage(
              boot.sessionId,
              syntheticStreamIdRef.current,
              new Date().toISOString(),
            ),
          ),
        );
        dispatch({ type: "set_synthetic_voice_ready", ready: true });
      });
      ws.addEventListener("message", handleVoiceSocketMessage);
      ws.addEventListener("close", () => {
        if (syntheticVoiceWsRef.current === ws) syntheticVoiceWsRef.current = null;
        dispatch({ type: "set_synthetic_voice_ready", ready: false });
        if (closed) return;
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          if (!closed) connectSyntheticVoiceSocket();
        }, 1000);
      });
      ws.addEventListener("error", () => {
        dispatch({ type: "set_synthetic_voice_ready", ready: false });
      });
    };

    connectSyntheticVoiceSocket();

    return () => {
      closed = true;
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const socket = syntheticVoiceWsRef.current;
      syntheticVoiceWsRef.current = null;
      syntheticStreamIdRef.current = "";
      dispatch({ type: "set_synthetic_voice_ready", ready: false });
      socket?.close();
    };
  }, [boot.sessionId, boot.token, dispatch, handleVoiceSocketMessage, voiceView.micOn]);

  const stopMic = useCallback(
    (reason = "operator_web_stop_mic") => {
      captureGenerationRef.current += 1;
      micStartPromiseRef.current = null;
      clearVoiceReconnectTimer();
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
      energyPublishRef.current = { energy: 0, atMs: 0 };
      if (voiceViewRef.current.pushToTalkActive) {
        dispatch({ type: "set_push_to_talk_active", active: false });
      }
      pttStartedMicRef.current = false;
      pttPreviousMutedRef.current = voiceViewRef.current.muted;
      dispatch({ type: "mic_stopped" });
      const disarmed = voiceCaptureDisarmedMessages({
        sessionId: boot.sessionId,
        reason,
        muted: voiceViewRef.current.muted,
        deviceId: voiceViewRef.current.selectedDeviceId,
        availableDeviceCount: voiceViewRef.current.devices.length,
      });
      for (const message of disarmed.operatorEvents) sendOperatorEvent(message);
    },
    [boot.sessionId, clearVoiceReconnectTimer, dispatch, sendOperatorEvent],
  );

  const startMic = useCallback(() => {
    if (voiceViewRef.current.micOn) return Promise.resolve();
    if (micStartPromiseRef.current) return micStartPromiseRef.current;

    const generation = captureGenerationRef.current + 1;
    captureGenerationRef.current = generation;
    const promise = (async () => {
      let stream: MediaStream | null = null;
      let ctx: AudioContext | null = null;
      let processor: ScriptProcessorNode | null = null;
      try {
        const deviceId = voiceViewRef.current.selectedDeviceId;
        stream = await navigator.mediaDevices.getUserMedia(voiceAudioConstraints(deviceId));
        if (captureGenerationRef.current !== generation) {
          stopVoiceCaptureResources({
            processor,
            stream,
            audioContext: ctx,
            websocket: voiceWsRef.current,
          });
          return;
        }
        void refreshDevices().catch(() => undefined);
        const track = stream.getAudioTracks()[0] || null;
        ctx = await createVoiceCaptureAudioContext(window);
        if (captureGenerationRef.current !== generation) {
          stopVoiceCaptureResources({
            processor,
            stream,
            audioContext: ctx,
            websocket: voiceWsRef.current,
          });
          return;
        }

        seqRef.current = 0;
        dispatch({ type: "set_chunks_sent", chunksSent: 0 });

        const openCaptureVoiceSocket = () => {
          if (captureGenerationRef.current !== generation) return;
          clearVoiceReconnectTimer();
          const ws = new WebSocket(wsUrl(boot.token, "/operator/voice/ws"));
          const streamGeneration = voiceStreamGenerationRef.current + 1;
          voiceStreamGenerationRef.current = streamGeneration;
          streamIdRef.current = createVoiceStreamId();
          seqRef.current = 0;
          voiceWsRef.current = ws;
          ws.addEventListener("open", () => {
            if (captureGenerationRef.current !== generation || voiceWsRef.current !== ws) return;
            const opened = voiceCaptureOpenedMessages({
              sessionId: boot.sessionId,
              voiceStreamId: streamIdRef.current,
              voiceStreamGeneration: streamGeneration,
              muted: voiceViewRef.current.muted,
              deviceId: voiceViewRef.current.selectedDeviceId,
              deviceLabel: track?.label || "",
              availableDeviceCount: voiceViewRef.current.devices.length,
            });
            ws.send(JSON.stringify(opened.voiceMessage));
            for (const message of opened.operatorEvents) sendOperatorEvent(message);
          });
          ws.addEventListener("message", handleVoiceSocketMessage);
          ws.addEventListener("close", () => {
            if (voiceWsRef.current !== ws) return;
            voiceWsRef.current = null;
            if (captureGenerationRef.current !== generation) return;
            voiceReconnectTimerRef.current = window.setTimeout(() => {
              voiceReconnectTimerRef.current = null;
              openCaptureVoiceSocket();
            }, 650);
          });
          ws.addEventListener("error", () => {
            if (voiceWsRef.current !== ws) return;
            ws.close();
          });
        };

        openCaptureVoiceSocket();

        processor = connectVoiceCaptureGraph({
          audioContext: ctx,
          stream,
          onAudioProcess: (event) => {
            const ws = voiceWsRef.current;
            if (captureGenerationRef.current !== generation || !ws) return;
            const input = event.inputBuffer.getChannelData(0);
            const nowMs = performance.now();
            const frame = voiceCaptureFrameDecision({
              samples: input,
              sampleRate: ctx?.sampleRate,
              localVadEnabled: voiceViewRef.current.localVadEnabled,
              muted: voiceViewRef.current.muted,
              readyState: ws.readyState,
              bufferedAmount: ws.bufferedAmount,
              sequence: seqRef.current,
              voiceStreamId: streamIdRef.current,
              voiceStreamGeneration: voiceStreamGenerationRef.current,
              sessionId: boot.sessionId,
              monotonicMs: nowMs,
              sentAt: new Date().toISOString(),
            });
            if (
              shouldPublishVoiceEnergy({
                previousEnergy: energyPublishRef.current.energy,
                nextEnergy: frame.energy,
                lastPublishedAtMs: energyPublishRef.current.atMs,
                nowMs,
              })
            ) {
              energyPublishRef.current = { energy: frame.energy, atMs: nowMs };
              dispatch({ type: "set_energy", energy: frame.energy });
            }
            if (frame.updateLocalVad && frame.vadActive !== voiceViewRef.current.localVadActive) {
              dispatch({ type: "set_local_vad_active", active: frame.vadActive });
            }
            seqRef.current = frame.nextSequence;
            if (frame.chunkMessage) {
              ws.send(JSON.stringify(frame.chunkMessage));
            }
            if (frame.chunksSent != null) {
              dispatch({ type: "set_chunks_sent", chunksSent: frame.chunksSent });
            }
          },
        });
        if (captureGenerationRef.current !== generation) {
          stopVoiceCaptureResources({
            processor,
            stream,
            audioContext: ctx,
            websocket: voiceWsRef.current,
          });
          return;
        }
        streamRef.current = stream;
        captureCtxRef.current = ctx;
        processorRef.current = processor;
        dispatch({ type: "mic_started" });
      } catch (error) {
        clearVoiceReconnectTimer();
        stopVoiceCaptureResources({
          processor,
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
    })();
    micStartPromiseRef.current = promise;
    promise.then(
      () => {
        if (micStartPromiseRef.current === promise) micStartPromiseRef.current = null;
        return undefined;
      },
      () => {
        if (micStartPromiseRef.current === promise) micStartPromiseRef.current = null;
        return undefined;
      },
    );
    return promise;
  }, [
    boot.sessionId,
    boot.token,
    clearVoiceReconnectTimer,
    dispatch,
    handleVoiceSocketMessage,
    refreshDevices,
    reportMicBlocked,
    sendOperatorEvent,
  ]);

  const sendSyntheticVoiceChunk = useCallback(
    (input: SyntheticVoiceChunkInput = {}) => {
      const syntheticSocket = syntheticVoiceWsRef.current;
      const activeMicSocket = voiceWsRef.current;
      const ws =
        syntheticSocket?.readyState === VOICE_WS_OPEN_STATE
          ? syntheticSocket
          : activeMicSocket?.readyState === VOICE_WS_OPEN_STATE
            ? activeMicSocket
            : null;
      if (!ws) return false;
      const usingSyntheticSocket = ws === syntheticSocket;
      const fallbackSequence =
        (usingSyntheticSocket ? syntheticSeqRef.current : seqRef.current) + 1;
      const sequence = finiteNumber(input.sequence, fallbackSequence);
      const voiceStreamId = String(
        input.voiceStreamId ||
          input.streamId ||
          (usingSyntheticSocket ? syntheticStreamIdRef.current : streamIdRef.current) ||
          "",
      );
      if (!voiceStreamId) return false;
      const voiceStreamGeneration = finiteNumber(
        input.voiceStreamGeneration,
        usingSyntheticSocket
          ? syntheticStreamGenerationRef.current
          : voiceStreamGenerationRef.current,
      );
      const message = syntheticVoiceChunkMessage({
        sessionId: boot.sessionId,
        sequence,
        voiceStreamId,
        voiceStreamGeneration,
        monotonicMs: performance.now(),
        sentAt: new Date().toISOString(),
        sampleRate: finiteNumber(input.sampleRate, 24000),
        channels: finiteNumber(input.channels, 1),
        durationMs: finiteNumber(input.durationMs, 20),
        energy: finiteNumber(input.energy, 0.16),
        source: input.source || "synthetic_pcm16",
        dataBase64: input.dataBase64,
      });
      ws.send(JSON.stringify(message));
      if (usingSyntheticSocket)
        syntheticSeqRef.current = Math.max(syntheticSeqRef.current, sequence);
      const nextChunksSent = Math.max(voiceViewRef.current.chunksSent, sequence);
      dispatch({ type: "set_chunks_sent", chunksSent: nextChunksSent });
      return true;
    },
    [boot.sessionId, dispatch],
  );

  const setSelectedDeviceId = useCallback(
    (deviceId: string) => {
      dispatch({ type: "set_selected_device", deviceId });
      if (voiceViewRef.current.micOn) {
        stopMic();
        window.setTimeout(() => void startMic().catch(() => undefined), 0);
      }
    },
    [dispatch, startMic, stopMic],
  );

  const toggleMute = useCallback(() => {
    setVoiceMuted(!voiceViewRef.current.muted, "operator_web_toggle_mute");
  }, [setVoiceMuted]);

  const startPushToTalk = useCallback(async () => {
    const decision = beginPushToTalk({
      active: voiceViewRef.current.pushToTalkActive,
      muted: voiceViewRef.current.muted,
      micOn: voiceViewRef.current.micOn,
    });
    if (!decision.shouldActivate) return;
    dispatch({ type: "set_push_to_talk_active", active: true });
    pttPreviousMutedRef.current = decision.previousMuted;
    pttStartedMicRef.current = decision.startedMic;
    try {
      if (decision.shouldStartMic) await startMic();
      if (!voiceViewRef.current.pushToTalkActive) return;
      if (decision.mute) setVoiceMuted(decision.mute.muted, decision.mute.reason);
    } catch (error) {
      dispatch({ type: "set_push_to_talk_active", active: false });
      const failed = failPushToTalk(pttPreviousMutedRef.current);
      setVoiceMuted(failed.muted, failed.reason);
      throw error;
    }
  }, [dispatch, setVoiceMuted, startMic]);

  const finishPushToTalk = useCallback(() => {
    const decision = finishPushToTalkDecision({
      active: voiceViewRef.current.pushToTalkActive,
      previousMuted: pttPreviousMutedRef.current,
      startedMic: pttStartedMicRef.current,
    });
    if (!decision.shouldDeactivate) return;
    dispatch({ type: "set_push_to_talk_active", active: false });
    if (decision.mute) setVoiceMuted(decision.mute.muted, decision.mute.reason);
  }, [dispatch, setVoiceMuted]);

  useEffect(() => () => stopMic(), [stopMic]);

  return {
    ...voiceView,
    refreshDevices,
    setSelectedDeviceId,
    setLocalVadEnabled,
    startMic,
    stopMic,
    setVoiceMuted,
    toggleMute,
    startPushToTalk,
    finishPushToTalk,
    sendSyntheticVoiceChunk,
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
