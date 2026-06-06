export interface LanOperatorVoiceChunk {
  sessionId: string;
  sequence: number | null;
  voiceStreamId: string | null;
  voiceStreamGeneration: number | null;
  monotonicMs: number | null;
  sentAt: string | null;
  receivedAt: string;
  receiveLagMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  durationMs: number | null;
  energy: number;
  bytes: number;
  dataBase64: string;
  source: string;
  surfaceContext?: Record<string, unknown>;
}

export interface LanOperatorVoiceForwardResult {
  ok?: boolean;
  error?: string;
  reason?: string;
  [key: string]: unknown;
}
