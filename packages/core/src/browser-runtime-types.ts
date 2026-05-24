export interface AvatarStateUpdate {
  mood?: string;
  action?: string;
  intensity?: number;
  expressionHoldMs?: number;
  actionHoldMs?: number;
  statusText?: string;
  statusKind?: string;
  statusHoldMs?: number;
  status_text?: string;
  status_kind?: string;
  status_hold_ms?: number;
}

export interface AvatarExpressionOptions {
  holdMs?: number;
}

export interface AvatarActionOptions {
  holdMs?: number;
  durationMs?: number;
}

export interface AvatarController {
  updateState(state: AvatarStateUpdate): unknown;
  setExpression?(mood?: string, options?: AvatarExpressionOptions): unknown;
  setAction?(action?: string, intensity?: number, options?: AvatarActionOptions): unknown;
}

export interface AudioPlaybackResult {
  ok: boolean;
  durationMs?: number;
  [key: string]: unknown;
}

export interface AvatarAudioBus {
  playAudioDataUrl(
    audioDataUrl: string,
    options?: { label?: string; gain?: number },
  ): Promise<AudioPlaybackResult>;
  injectTone?(options?: {
    label?: string;
    frequency?: number;
    durationMs?: number;
    gain?: number;
  }): AudioPlaybackResult;
  setSyntheticSpeech?(active: boolean, detail?: Record<string, unknown>): unknown;
  addStream?(
    stream: MediaStream | null | undefined,
    options?: { label?: string; gain?: number },
  ): { ok?: boolean; [key: string]: unknown };
  getMouthLevel?(): number;
}

export interface LocalDialogConfig {
  enabled?: boolean;
  turnUrl?: string;
  sessionId?: string;
  ttsMode?: string;
  ttsUrl?: string;
  ttsGain?: number;
  ttsMinDurationMs?: number;
  ttsMaxDurationMs?: number;
  sttProvider?: string;
  ttsProvider?: string;
  avatarMood?: string;
  avatarAction?: string;
  botName?: string;
}

export interface LocalDialogInput {
  text?: string;
  utterance?: string;
  source?: string;
  context?: Record<string, unknown>;
  sessionId?: string;
  mode?: string;
  allowCodeChanges?: boolean;
  timeoutMs?: number;
}

export interface LocalDialogSpeakOptions {
  label?: string;
  frequency?: number;
  context?: Record<string, unknown>;
}

export interface LocalDialogController {
  state?: unknown;
  sendUtterance(input?: LocalDialogInput): Promise<unknown>;
  injectTranscript?(input?: LocalDialogInput): Promise<unknown>;
  speakText?(text: string, options?: LocalDialogSpeakOptions): Promise<unknown>;
  terminalStatuses?: string[];
}

export interface CaptionEvent {
  ts: string;
  speaker: string;
  text: string;
  streamId: string;
  source?: string;
}

export interface CaptionCaptureState {
  ok: boolean;
  installedAt: string;
  containerFound: boolean;
  captions: CaptionEvent[];
  latest: CaptionEvent | null;
  errors: string[];
}

export interface PromptDismisser {
  timer: number;
  dismissOnce: () => boolean;
}

export interface LocalPlaybackMuteState {
  ok: true;
  installedAt: string;
  mutedElements: number;
  lastMutedAt: string;
  errors: string[];
}

export interface LocalPlaybackMuteController {
  observer: MutationObserver;
  state: LocalPlaybackMuteState;
  sweep: () => { ok: true; muted: number; state: LocalPlaybackMuteState };
}

export interface ScreenShareState {
  ok: boolean;
  enabled: boolean;
  active: boolean;
  startedAt: string;
  stoppedAt: string;
  streamId: string;
  trackIds: string[];
  frames: number;
  displayMediaCalls: number;
  mode: string;
  title: string;
  subtitle: string;
  videoUrl: string;
  videoReady: boolean;
  videoError: string;
  errors: string[];
}

export interface ScreenShareStartOptions {
  title?: string;
  subtitle?: string;
  videoUrl?: string;
  url?: string;
  path?: string;
  preview?: boolean;
}

export interface ScreenShareController {
  start(options?: ScreenShareStartOptions): Promise<{ ok: boolean; state: ScreenShareState }>;
  stop(): Promise<{ ok: boolean; state: ScreenShareState }>;
  state(): ScreenShareState;
  status?(): ScreenShareState | { ok: boolean; error?: string };
  mode: string;
}

export interface RealtimeClient {
  state?: unknown;
  connect?(options?: unknown): unknown;
  reconnect?(reason?: string): unknown;
  cancelActiveResponse?(reason?: string): unknown;
  sendSessionUpdate?(options?: unknown): unknown;
  runLocalAvatarTool?(toolName: string, args?: unknown): unknown;
  runLocalWorkerTool?(toolName: string, args?: unknown): unknown;
  discoverParticipantAudioStreams?(): unknown;
  registerParticipantAudioStream?(
    stream: MediaStream | null | undefined,
    options?: unknown,
  ): unknown;
  stopMeetAudioCapture?(reason?: string): Promise<unknown>;
  injectWorkerResult?(payload: unknown): unknown;
  sendWorkerResult?(payload: unknown): unknown;
  sendRealtimeEvent?(payload: unknown): unknown;
  runLocalMeetTool?(toolName: string, payload: unknown): Promise<unknown>;
  [key: string]: unknown;
}

export interface VideoStageState {
  ok: boolean;
  title: string;
  videoUrl: string;
  frames: number;
  playing: boolean;
  errors: string[];
  currentTime?: number;
  duration?: number;
}

/**
 * PIXI / Live2D are loaded as external <script> tags at runtime, so we declare
 * a narrow surface area covering the API we actually use. Methods we don't call
 * are intentionally omitted — fall back to (window.PIXI as PixiNamespace) when
 * extending this shape.
 */
export interface PixiApplication {
  stage: { addChild(child: unknown): unknown };
  ticker: { add(callback: () => void, context: unknown, priority?: number): unknown };
  view?: HTMLCanvasElement;
}

export interface PixiLive2DModel {
  scale: { set(scale: number): void };
  anchor: { set(x: number, y?: number): void };
  x: number;
  y: number;
  width: number;
  height: number;
  motion?(group: string, index?: number, priority?: number): Promise<unknown> | unknown;
  internalModel?: {
    coreModel?: Record<string, unknown>;
    motionManager?: {
      startRandomMotion?: (...args: unknown[]) => unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PixiNamespace {
  Application: new (options: Record<string, unknown>) => PixiApplication;
  UPDATE_PRIORITY: { LOW: number; NORMAL: number; HIGH: number; [key: string]: number };
  live2d: {
    Live2DModel: {
      from(url: string, options?: Record<string, unknown>): Promise<PixiLive2DModel>;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface HiyoriAvatarConfig {
  modelUrl?: string;
  modelFallbackUrls?: string[];
  deferRendererUntilExplicitStart?: boolean;
  modelBase?: string;
  width?: number;
  height?: number;
  modelScale?: number;
  defaultMood?: string;
  defaultAction?: string;
  bgColor?: string;
  [key: string]: unknown;
}

export interface HiyoriAvatarState {
  ready?: boolean;
  mood?: string;
  action?: string;
  intensity?: number;
  statusText?: string;
  statusKind?: string;
  statusUpdatedAt?: string;
  statusVisibleUntil?: number;
  expressionHoldMs?: number;
  actionHoldMs?: number;
  errors?: string[];
  [key: string]: unknown;
}

declare global {
  interface Window {
    __meetingAvatarBotInjected?: boolean;
    __meetingAvatarLocalDialogInjected?: boolean;
    __meetingAvatarRealtimeBridge?: boolean;
    __meetingAvatarMeetAudioCaptureChunk?: (payload: unknown) => Promise<unknown>;
    __meetingAvatarMeetAudioCaptureEvent?: (payload: unknown) => Promise<unknown>;
    __meetingAvatarWorkerResultBridge?: boolean;
    __meetingAvatarRealtimePeerConnectionHook?: boolean | ((pc: RTCPeerConnection) => void);
    __mabOnCaptionCapture?: (event: CaptionEvent) => void;
    __MAB_CAPTION_CAPTURE_INSTALLED?: boolean;
    __MAB_CAPTION_CAPTURE_SCAN?: () => void;
    __MAB_MEET_FIXTURE?: Record<string, unknown> | null;
    __MAB_MEET_LOCAL_PLAYBACK_MUTE?: LocalPlaybackMuteController;
    __MAB_MEET_PROMPT_DISMISSER?: PromptDismisser;
    MAB_AVATAR_AUDIO?: Record<string, unknown> | null;
    MAB_AVATAR_AUDIO_BUS?: AvatarAudioBus;
    MAB_AVATAR_CONFIG?: HiyoriAvatarConfig | null;
    MAB_AVATAR_CONTROLLER?: AvatarController;
    MAB_AVATAR_READY?: Record<string, unknown> | null;
    MAB_AVATAR_START_RENDERER?: (() => Promise<unknown>) | null;
    MAB_AVATAR_RENDERER?:
      | (Record<string, unknown> & {
          renderer?: string;
          live2dLoaded?: boolean;
          fallbackReason?: string;
        })
      | null;
    MAB_AVATAR_STATE?: HiyoriAvatarState | null;
    MAB_AVATAR_VISUAL_TEST?: Record<string, unknown> | null;
    PIXI?: PixiNamespace;
    Live2DCubismCore?: Record<string, unknown>;
    trustedTypes?: {
      createPolicy?: (name: string, rules: Record<string, unknown>) => unknown;
      [key: string]: unknown;
    };
    MAB_CAPTION_CAPTURE?: CaptionCaptureState;
    MAB_MEETING_AWARENESS?: any;
    MAB_LOCAL_DIALOG?: Record<string, unknown> | null;
    MAB_LOCAL_DIALOG_CONFIG?: LocalDialogConfig | null;
    MAB_LOCAL_DIALOG_CONTROLLER?: LocalDialogController | null;
    MAB_REALTIME_BRIDGE?: Record<string, unknown> | null;
    MAB_REALTIME_BRIDGE_CONFIG?: Record<string, unknown> | null;
    MAB_REALTIME_CLIENT?: RealtimeClient | null;
    MAB_REALTIME_DATA_CHANNEL?: RTCDataChannel | null;
    MAB_REALTIME_DC?: RTCDataChannel | null;
    MAB_REALTIME_PEER_CONNECTION?: RTCPeerConnection | null;
    MAB_SCREEN_SHARE?: ScreenShareState | null;
    MAB_SCREEN_SHARE_CONTROLLER?: ScreenShareController | null;
    MAB_VIDEO_STAGE?: VideoStageState | null;
    MAB_WORKER_RESULT_CONFIG?: Record<string, unknown> | null;
    MAB_WORKER_RESULT_BRIDGE?: Record<string, unknown> | null;
    MAB_WORKER_RESULT_BRIDGE_API?: {
      pollOnce?: () => Promise<unknown>;
      stop?: () => void;
      start?: () => void;
    } | null;
    webkitAudioContext?: typeof AudioContext;
  }
}
