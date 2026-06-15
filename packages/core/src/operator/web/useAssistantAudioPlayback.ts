import { useEffect, useRef } from "react";

import type { DebugState } from "../lan-operator-debug-state.ts";
import { pcm16ToFloat32 } from "./protocol.ts";
import type { CanonicalEvent } from "./useRealtime.ts";

export type CanonicalEventSubscriber = (listener: (event: CanonicalEvent) => void) => () => void;
export type AssistantOutputState = DebugState["output"];
export type AssistantAudioStatus = AssistantOutputState["assistantAudio"]["status"];

export interface AssistantAudioChunkFold {
  audioBase64: string;
  channels: number;
  sampleRate: number;
  samples: Float32Array;
}

export interface AssistantOutputFoldResult {
  audioChunk?: AssistantAudioChunkFold;
  changed: boolean;
  output: AssistantOutputState;
}

export function assistantAudioBase64(event: CanonicalEvent): string {
  return String(
    event.audioBase64 || (event.detail as { audioBase64?: string } | undefined)?.audioBase64 || "",
  );
}

export function assistantAudioSampleRate(event: CanonicalEvent): number {
  return Number((event.detail as { sampleRate?: number } | undefined)?.sampleRate || 24000);
}

export function assistantAudioChannels(event: CanonicalEvent): number {
  const detail = event.detail as { channels?: number } | undefined;
  return Math.max(1, Number(detail?.channels || 1));
}

export function createAssistantOutputState(): AssistantOutputState {
  return {
    assistantText: {
      deltaCount: 0,
      completedCount: 0,
      currentText: "",
      completedText: "",
      lastTextAt: null,
      lastResponseId: null,
    },
    assistantAudio: {
      enabled: true,
      status: "idle",
      chunksReceived: 0,
      chunksPlayed: 0,
      bytesReceived: 0,
      sampleRate: null,
      channels: null,
      queuedMs: 0,
      rms: null,
      peak: null,
      lastChunkAt: null,
      lastPlaybackAt: null,
      lastError: null,
    },
  };
}

export function cloneAssistantOutputState(output: AssistantOutputState): AssistantOutputState {
  return {
    assistantText: { ...output.assistantText },
    assistantAudio: { ...output.assistantAudio },
  };
}

export function assistantOutputStateMessage(output: AssistantOutputState) {
  return {
    type: "assistant_output_state",
    output: cloneAssistantOutputState(output),
  };
}

export function foldAssistantOutputEvent(
  output: AssistantOutputState,
  event: CanonicalEvent,
  nowIso = new Date().toISOString(),
): AssistantOutputFoldResult {
  if (event.type === "assistant_text_delta") {
    const next = cloneAssistantOutputState(output);
    next.assistantText.deltaCount += 1;
    next.assistantText.currentText += String(event.text || "");
    next.assistantText.lastTextAt = nowIso;
    next.assistantText.lastResponseId = event.responseId || next.assistantText.lastResponseId;
    return { changed: true, output: next };
  }
  if (event.type === "assistant_text_completed") {
    const next = cloneAssistantOutputState(output);
    next.assistantText.completedCount += 1;
    next.assistantText.completedText = String(event.text || next.assistantText.currentText || "");
    next.assistantText.currentText = "";
    next.assistantText.lastTextAt = nowIso;
    next.assistantText.lastResponseId = event.responseId || next.assistantText.lastResponseId;
    return { changed: true, output: next };
  }
  if (event.type === "assistant_audio_started") {
    const next = cloneAssistantOutputState(output);
    next.assistantAudio.status = "playing";
    next.assistantAudio.lastChunkAt = nowIso;
    return { changed: true, output: next };
  }
  if (event.type === "assistant_audio_stopped") {
    return {
      changed: true,
      output: markAssistantAudioStatus(output, "stopped", null, nowIso, 0),
    };
  }
  if (event.type !== "assistant_audio_chunk") return { changed: false, output };

  const audioBase64 = assistantAudioBase64(event);
  if (!audioBase64) return { changed: false, output };
  const samples = pcm16ToFloat32(audioBase64);
  const next = cloneAssistantOutputState(output);
  const audio = next.assistantAudio;
  const stats = assistantAudioStats(samples);
  audio.chunksReceived += 1;
  audio.bytesReceived += samples.length * 2;
  audio.sampleRate = assistantAudioSampleRate(event);
  audio.channels = assistantAudioChannels(event);
  audio.rms = stats.rms;
  audio.peak = stats.peak;
  audio.lastChunkAt = nowIso;
  if (samples.length === 0) {
    audio.status = audio.enabled ? "stopped" : "blocked";
    audio.queuedMs = 0;
  }
  return {
    audioChunk: {
      audioBase64,
      channels: audio.channels || 1,
      sampleRate: audio.sampleRate || 24000,
      samples,
    },
    changed: true,
    output: next,
  };
}

export function markAssistantAudioPlayed(
  output: AssistantOutputState,
  input: { queuedMs: number; nowIso?: string },
): AssistantOutputState {
  const next = cloneAssistantOutputState(output);
  next.assistantAudio.status = "playing";
  next.assistantAudio.chunksPlayed += 1;
  next.assistantAudio.queuedMs = Math.max(0, input.queuedMs);
  next.assistantAudio.lastPlaybackAt = input.nowIso || new Date().toISOString();
  next.assistantAudio.lastError = null;
  return next;
}

export function markAssistantAudioStatus(
  output: AssistantOutputState,
  status: AssistantAudioStatus,
  error: string | null,
  nowIso = new Date().toISOString(),
  queuedMs = output.assistantAudio.queuedMs,
): AssistantOutputState {
  const next = cloneAssistantOutputState(output);
  next.assistantAudio.status = status;
  next.assistantAudio.queuedMs = Math.max(0, queuedMs);
  next.assistantAudio.lastPlaybackAt = nowIso;
  next.assistantAudio.lastError = error;
  return next;
}

export function assistantAudioStats(samples: Float32Array) {
  if (samples.length === 0) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (const sample of samples) {
    const abs = Math.abs(sample);
    peak = Math.max(peak, abs);
    sum += sample * sample;
  }
  return {
    rms: Math.round(Math.sqrt(sum / samples.length) * 10000) / 10000,
    peak: Math.round(peak * 10000) / 10000,
  };
}

export function useAssistantAudioPlayback(
  subscribe: CanonicalEventSubscriber,
  sendOperatorEvent?: (message: Record<string, unknown>) => void,
) {
  const playCtxRef = useRef<AudioContext | null>(null);
  const scheduledAtRef = useRef(0);
  const outputRef = useRef<AssistantOutputState>(createAssistantOutputState());

  useEffect(() => {
    const emitOutputState = () => {
      sendOperatorEvent?.(assistantOutputStateMessage(outputRef.current));
    };

    const playChunk = (event: CanonicalEvent) => {
      const folded = foldAssistantOutputEvent(outputRef.current, event);
      if (!folded.changed) return;
      outputRef.current = folded.output;
      if (!folded.audioChunk) {
        emitOutputState();
        return;
      }
      if (!folded.audioChunk.samples.length) {
        emitOutputState();
        return;
      }
      if (!playCtxRef.current) {
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) {
          outputRef.current = markAssistantAudioStatus(
            outputRef.current,
            "failed",
            "audio_context_unavailable",
          );
          emitOutputState();
          return;
        }
        playCtxRef.current = new Ctor();
      }
      const context = playCtxRef.current;
      void context.resume?.().catch((error) => {
        outputRef.current = markAssistantAudioStatus(
          outputRef.current,
          "blocked",
          String((error as Error)?.message || error),
        );
        emitOutputState();
        return undefined;
      });
      try {
        const { channels, sampleRate, samples } = folded.audioChunk;
        const frames = Math.floor(samples.length / channels);
        if (!frames) {
          emitOutputState();
          return;
        }
        const buffer = context.createBuffer(channels, frames, sampleRate);
        for (let channel = 0; channel < channels; channel += 1) {
          const channelData = buffer.getChannelData(channel);
          for (let frame = 0; frame < frames; frame += 1) {
            channelData[frame] = samples[frame * channels + channel] || 0;
          }
        }
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        const at = Math.max(context.currentTime, scheduledAtRef.current);
        source.start(at);
        scheduledAtRef.current = at + buffer.duration;
        outputRef.current = markAssistantAudioPlayed(outputRef.current, {
          queuedMs: Math.round(Math.max(0, scheduledAtRef.current - context.currentTime) * 1000),
        });
        source.addEventListener("ended", () => {
          if (context.currentTime < scheduledAtRef.current - 0.05) return;
          scheduledAtRef.current = 0;
          outputRef.current = markAssistantAudioStatus(
            outputRef.current,
            "stopped",
            null,
            undefined,
            0,
          );
          emitOutputState();
        });
      } catch (error) {
        outputRef.current = markAssistantAudioStatus(
          outputRef.current,
          "failed",
          String((error as Error)?.message || error),
        );
      }
      emitOutputState();
    };

    const unsubscribe = subscribe(playChunk);
    return () => {
      unsubscribe();
      scheduledAtRef.current = 0;
      void playCtxRef.current?.close?.();
      playCtxRef.current = null;
    };
  }, [sendOperatorEvent, subscribe]);
}
