import { rmsEnergy } from "./protocol.ts";
import {
  CAPTURE_SAMPLE_RATE,
  canSendVoiceChunk,
  shouldPublishVoiceChunkCount,
} from "./voiceCaptureResources.ts";
import { LOCAL_VAD_THRESHOLD, voiceChunkMessage } from "./voiceEvents.ts";

export interface VoiceCaptureFrameInput {
  samples: Float32Array;
  sampleRate?: number;
  localVadEnabled: boolean;
  muted: boolean;
  readyState: number;
  bufferedAmount: number;
  sequence: number;
  voiceStreamId: string;
  voiceStreamGeneration?: number;
  sessionId: string;
  monotonicMs: number;
  sentAt: string;
}

export interface VoiceCaptureFrameDecision {
  energy: number;
  vadActive: boolean;
  updateLocalVad: boolean;
  nextSequence: number;
  chunkMessage?: ReturnType<typeof voiceChunkMessage>;
  chunksSent?: number;
}

export interface VoiceEnergyPublishInput {
  previousEnergy: number;
  nextEnergy: number;
  lastPublishedAtMs: number;
  nowMs: number;
  minIntervalMs?: number;
  minDelta?: number;
}

const DEFAULT_ENERGY_PUBLISH_INTERVAL_MS = 125;
const DEFAULT_ENERGY_PUBLISH_DELTA = 0.02;

export function shouldPublishVoiceEnergy(input: VoiceEnergyPublishInput): boolean {
  if (input.lastPublishedAtMs <= 0) return true;
  const minIntervalMs = input.minIntervalMs ?? DEFAULT_ENERGY_PUBLISH_INTERVAL_MS;
  if (input.nowMs - input.lastPublishedAtMs >= minIntervalMs) return true;
  const minDelta = input.minDelta ?? DEFAULT_ENERGY_PUBLISH_DELTA;
  return Math.abs(input.nextEnergy - input.previousEnergy) >= minDelta;
}

export function voiceCaptureFrameDecision(
  input: VoiceCaptureFrameInput,
): VoiceCaptureFrameDecision {
  const energy = rmsEnergy(input.samples);
  const vadActive = energy >= LOCAL_VAD_THRESHOLD;
  const shouldSend = canSendVoiceChunk({
    muted: input.muted,
    readyState: input.readyState,
    bufferedAmount: input.bufferedAmount,
  });
  if (!shouldSend) {
    return {
      energy,
      vadActive,
      updateLocalVad: input.localVadEnabled,
      nextSequence: input.sequence,
    };
  }

  const sequence = input.sequence;
  return {
    energy,
    vadActive,
    updateLocalVad: input.localVadEnabled,
    nextSequence: sequence + 1,
    chunkMessage: voiceChunkMessage({
      samples: input.samples,
      sampleRate: input.sampleRate || CAPTURE_SAMPLE_RATE,
      energy,
      monotonicMs: input.monotonicMs,
      sentAt: input.sentAt,
      sequence,
      voiceStreamId: input.voiceStreamId,
      voiceStreamGeneration: input.voiceStreamGeneration,
      sessionId: input.sessionId,
    }),
    ...(shouldPublishVoiceChunkCount(sequence) ? { chunksSent: sequence + 1 } : {}),
  };
}
