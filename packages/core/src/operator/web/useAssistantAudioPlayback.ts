import { useEffect, useRef } from "react";

import { pcm16ToFloat32 } from "./protocol.ts";
import type { CanonicalEvent } from "./useRealtime.ts";

export type CanonicalEventSubscriber = (listener: (event: CanonicalEvent) => void) => () => void;

export function assistantAudioBase64(event: CanonicalEvent): string {
  return String(
    event.audioBase64 || (event.detail as { audioBase64?: string } | undefined)?.audioBase64 || "",
  );
}

export function assistantAudioSampleRate(event: CanonicalEvent): number {
  return Number((event.detail as { sampleRate?: number } | undefined)?.sampleRate || 24000);
}

export function useAssistantAudioPlayback(subscribe: CanonicalEventSubscriber) {
  const playCtxRef = useRef<AudioContext | null>(null);
  const scheduledAtRef = useRef(0);

  useEffect(() => {
    const playChunk = (event: CanonicalEvent) => {
      if (event.type !== "assistant_audio_chunk") return;
      const audioBase64 = assistantAudioBase64(event);
      if (!audioBase64) return;
      if (!playCtxRef.current) {
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        playCtxRef.current = new Ctor();
      }
      const context = playCtxRef.current;
      void context.resume?.();
      const sampleRate = assistantAudioSampleRate(event);
      const mono = pcm16ToFloat32(audioBase64);
      if (mono.length === 0) return;
      const buffer = context.createBuffer(1, mono.length, sampleRate);
      buffer.getChannelData(0).set(mono);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const at = Math.max(context.currentTime, scheduledAtRef.current);
      source.start(at);
      scheduledAtRef.current = at + buffer.duration;
    };

    const unsubscribe = subscribe(playChunk);
    return () => {
      unsubscribe();
      scheduledAtRef.current = 0;
      void playCtxRef.current?.close?.();
      playCtxRef.current = null;
    };
  }, [subscribe]);
}
