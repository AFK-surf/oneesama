export const CAPTURE_SAMPLE_RATE = 24000; // matches the session's declared pcm rate
export const PROCESSOR_FRAMES = 1024;
export const VOICE_WS_BACKPRESSURE_BYTES = 1_000_000;
export const VOICE_WS_OPEN_STATE = 1;

export interface VoiceAudioContextWindow {
  AudioContext?: VoiceAudioContextConstructor;
  webkitAudioContext?: VoiceAudioContextConstructor;
}

export interface VoiceAudioContextConstructor {
  new (options?: AudioContextOptions): AudioContext;
}

export interface VoiceChunkSendState {
  muted: boolean;
  readyState: number;
  bufferedAmount: number;
}

export interface VoiceCaptureResourceHandles {
  processor?: Pick<ScriptProcessorNode, "disconnect"> | null;
  stream?: Pick<MediaStream, "getTracks"> | null;
  audioContext?: Pick<AudioContext, "close"> | null;
  websocket?: Pick<WebSocket, "close"> | null;
}

export interface VoiceCaptureGraphInput {
  audioContext: Pick<
    AudioContext,
    "createGain" | "createMediaStreamSource" | "createScriptProcessor" | "destination"
  >;
  stream: MediaStream;
  onAudioProcess: (event: AudioProcessingEvent) => void;
  processorFrames?: number;
}

export function voiceAudioConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };
}

export function connectVoiceCaptureGraph(input: VoiceCaptureGraphInput): ScriptProcessorNode {
  const source = input.audioContext.createMediaStreamSource(input.stream);
  const processor = input.audioContext.createScriptProcessor(
    input.processorFrames ?? PROCESSOR_FRAMES,
    1,
    1,
  );
  const sink = input.audioContext.createGain();
  sink.gain.value = 0;
  processor.onaudioprocess = input.onAudioProcess;
  source.connect(processor);
  processor.connect(sink);
  sink.connect(input.audioContext.destination);
  return processor;
}

export async function createVoiceCaptureAudioContext(
  windowLike: VoiceAudioContextWindow,
): Promise<AudioContext> {
  const Ctor = windowLike.AudioContext || windowLike.webkitAudioContext;
  if (!Ctor) throw new Error("operator_voice_audio_context_unavailable");

  let ctx: AudioContext;
  try {
    ctx = new Ctor({ sampleRate: CAPTURE_SAMPLE_RATE });
  } catch {
    ctx = new Ctor();
  }
  await ctx.resume?.();
  return ctx;
}

export function canSendVoiceChunk(state: VoiceChunkSendState): boolean {
  return (
    !state.muted &&
    state.readyState === VOICE_WS_OPEN_STATE &&
    state.bufferedAmount <= VOICE_WS_BACKPRESSURE_BYTES
  );
}

export function shouldPublishVoiceChunkCount(sequence: number): boolean {
  return sequence % 8 === 0;
}

export function stopVoiceCaptureResources(resources: VoiceCaptureResourceHandles): void {
  resources.processor?.disconnect();
  resources.stream?.getTracks().forEach((track) => track.stop());
  void resources.audioContext?.close();
  resources.websocket?.close();
}
