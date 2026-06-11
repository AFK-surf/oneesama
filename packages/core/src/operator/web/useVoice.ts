import { useCallback, useEffect, useRef, useState } from "react";

import type { CanonicalEvent, OperatorBoot } from "./useRealtime.ts";
import { pcm16Base64, pcm16ToFloat32, rmsEnergy, wsUrl } from "./protocol.ts";

export interface VoiceState {
  micOn: boolean;
  muted: boolean;
  energy: number;
  voiceWsOpen: boolean;
  startMic: () => Promise<void>;
  stopMic: () => void;
  toggleMute: () => void;
}

const CAPTURE_SAMPLE_RATE = 24000; // matches the session's declared pcm rate
const PROCESSOR_FRAMES = 1024;

/**
 * Voice for the React surface: mic capture (PCM16 @24k over the voice WS, the
 * same wire format the legacy surface uses) and assistant audio playback
 * (decode assistant_audio_chunk events → scheduled WebAudio). Playback is fed
 * by the realtime event subscription (audio chunks are excluded from the
 * rendered events list); capture opens its own voice WS.
 */
export function useVoice(
  boot: OperatorBoot,
  subscribe: (listener: (event: CanonicalEvent) => void) => () => void,
): VoiceState {
  const [micOn, setMicOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [energy, setEnergy] = useState(0);
  const [voiceWsOpen, setVoiceWsOpen] = useState(false);

  const captureCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const voiceWsRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(0);
  const streamIdRef = useRef("");
  const mutedRef = useRef(false);

  // --- assistant audio playback (fed by the event subscription) ---
  const playCtxRef = useRef<AudioContext | null>(null);
  const scheduledAtRef = useRef(0);

  useEffect(() => {
    const playChunk = (ev: CanonicalEvent) => {
      if (ev.type !== "assistant_audio_chunk") return;
      const b64 = String(
        ev.audioBase64 || (ev.detail as { audioBase64?: string })?.audioBase64 || "",
      );
      if (!b64) return;
      if (!playCtxRef.current) {
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        playCtxRef.current = new Ctor();
      }
      const ctx = playCtxRef.current;
      void ctx.resume?.();
      const rate = Number((ev.detail as { sampleRate?: number })?.sampleRate || 24000);
      const mono = pcm16ToFloat32(b64);
      if (mono.length === 0) return;
      const buffer = ctx.createBuffer(1, mono.length, rate);
      buffer.getChannelData(0).set(mono);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const at = Math.max(ctx.currentTime, scheduledAtRef.current);
      src.start(at);
      scheduledAtRef.current = at + buffer.duration;
    };
    return subscribe(playChunk);
  }, [subscribe]);

  const stopMic = useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void captureCtxRef.current?.close?.();
    captureCtxRef.current = null;
    voiceWsRef.current?.close();
    voiceWsRef.current = null;
    setMicOn(false);
    setEnergy(0);
  }, []);

  const startMic = useCallback(async () => {
    if (micOn) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    streamRef.current = stream;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ sampleRate: CAPTURE_SAMPLE_RATE });
    } catch {
      ctx = new Ctor();
    }
    captureCtxRef.current = ctx;
    await ctx.resume?.();

    const ws = new WebSocket(wsUrl(boot.token, "/operator/voice/ws"));
    voiceWsRef.current = ws;
    streamIdRef.current = "web_voice_" + Date.now().toString(36);
    seqRef.current = 0;
    ws.addEventListener("open", () => {
      setVoiceWsOpen(true);
      ws.send(
        JSON.stringify({
          type: "operator_voice_stream_opened",
          sessionId: boot.sessionId,
          voiceStreamId: streamIdRef.current,
          voiceStreamGeneration: 1,
          openedAt: new Date().toISOString(),
        }),
      );
    });
    ws.addEventListener("close", () => setVoiceWsOpen(false));

    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(PROCESSOR_FRAMES, 1, 1);
    processorRef.current = processor;
    const sink = ctx.createGain();
    sink.gain.value = 0;
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const energyValue = rmsEnergy(input);
      setEnergy(energyValue);
      if (mutedRef.current) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 1_000_000) return; // backpressure drop
      ws.send(
        JSON.stringify({
          type: "voice_chunk",
          source: "operator_web_pcm16",
          sessionId: boot.sessionId,
          sequence: seqRef.current++,
          voiceStreamId: streamIdRef.current,
          voiceStreamGeneration: 1,
          monotonicMs: performance.now(),
          sentAt: new Date().toISOString(),
          sampleRate: ctx.sampleRate,
          channels: 1,
          durationMs: (input.length / ctx.sampleRate) * 1000,
          energy: energyValue,
          dataBase64: pcm16Base64(input),
        }),
      );
    };
    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);
    setMicOn(true);
  }, [boot.sessionId, boot.token, micOn]);

  const toggleMute = useCallback(() => {
    mutedRef.current = !mutedRef.current;
    setMuted(mutedRef.current);
  }, []);

  useEffect(() => () => stopMic(), [stopMic]);

  return { micOn, muted, energy, voiceWsOpen, startMic, stopMic, toggleMute };
}
