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
      sessionId: input.sessionId,
    }),
    ...(shouldPublishVoiceChunkCount(sequence) ? { chunksSent: sequence + 1 } : {}),
  };
}
