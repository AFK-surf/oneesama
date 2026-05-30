type VideoAvatarSource = {
  id: string;
  label: string;
  url: string;
  state: "idle" | "speaking";
  objectFit: "cover" | "contain";
  background: string;
  default: boolean;
};

type VideoRendererOptions = {
  config: Record<string, any>;
  avatarController: Record<string, any>;
  rendererState: Record<string, any>;
  drawFallback(ctx: CanvasRenderingContext2D, t?: number): void;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizeObjectFit(value: unknown): "cover" | "contain" {
  return String(value || "cover").toLowerCase() === "contain" ? "contain" : "cover";
}

function normalizeVideoSources(config: Record<string, any>): VideoAvatarSource[] {
  const sources: VideoAvatarSource[] = [];
  const seen = new Set<string>();
  const addSource = (source: Record<string, any> | undefined, fallbackState?: string) => {
    const url = String(source?.url || "").trim();
    if (!url || seen.has(url)) return;
    const state = String(source?.state || fallbackState || source?.action || "idle")
      .toLowerCase()
      .includes("speak")
      ? "speaking"
      : "idle";
    seen.add(url);
    sources.push({
      id: String(source?.id || state),
      label: String(source?.label || state),
      url,
      state,
      objectFit: normalizeObjectFit(source?.objectFit || config.videoObjectFit),
      background: String(source?.background || config.background),
      default: Boolean(source?.default),
    });
  };
  for (const source of Array.isArray(config.videoSources) ? config.videoSources : []) {
    addSource(source, undefined);
  }
  addSource({ id: "idle", label: "Idle", url: config.videoIdleUrl }, "idle");
  addSource({ id: "speaking", label: "Speaking", url: config.videoSpeakingUrl }, "speaking");
  return sources;
}

function drawVideoFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  source: VideoAvatarSource,
  alpha: number,
  config: Record<string, any>,
) {
  if (!video || video.readyState < 2) return false;
  const canvasW = Number(config.canvasWidth);
  const canvasH = Number(config.canvasHeight);
  const videoW = video.videoWidth || canvasW;
  const videoH = video.videoHeight || canvasH;
  const scale =
    source.objectFit === "contain"
      ? Math.min(canvasW / videoW, canvasH / videoH)
      : Math.max(canvasW / videoW, canvasH / videoH);
  const drawW = videoW * scale;
  const drawH = videoH * scale;
  const dx = (canvasW - drawW) / 2;
  const dy = (canvasH - drawH) / 2;
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.drawImage(video, dx, dy, drawW, drawH);
  ctx.restore();
  return true;
}

function createVideoElement(source: VideoAvatarSource, config: Record<string, any>) {
  const video = document.createElement("video");
  video.src = source.url;
  video.muted = config.videoMuted !== false;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.style.cssText =
    "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.documentElement.appendChild(video);
  return video;
}

async function loadVideoElement(video: HTMLVideoElement, source: VideoAvatarSource) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`video avatar source failed: ${source.label || source.url}`));
    };
    const cleanup = () => {
      video.removeEventListener("canplay", done);
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("canplay", done, { once: true });
    video.addEventListener("loadeddata", done, { once: true });
    video.addEventListener("error", fail, { once: true });
    video.load();
    if (video.readyState >= 2) done();
  });
  await video.play().catch(() => undefined);
  return video;
}

export async function createVideoAvatarRenderer(
  canvas: HTMLCanvasElement,
  { config, avatarController, rendererState, drawFallback }: VideoRendererOptions,
) {
  const sources = normalizeVideoSources(config);
  const idleSource = sources.find((source) => source.state === "idle") || sources[0];
  const speakingSource =
    sources.find((source) => source.state === "speaking") ||
    sources.find((source) => source.default) ||
    idleSource;
  if (!idleSource?.url) throw new Error("video avatar has no idle source");

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("video avatar canvas context unavailable");
  const idleVideo = createVideoElement(idleSource, config);
  const speakingVideo =
    speakingSource.url === idleSource.url ? idleVideo : createVideoElement(speakingSource, config);
  await Promise.all([
    loadVideoElement(idleVideo, idleSource),
    speakingVideo === idleVideo
      ? Promise.resolve(idleVideo)
      : loadVideoElement(speakingVideo, speakingSource),
  ]);

  const videoByState = {
    idle: idleVideo,
    speaking: speakingVideo,
  };
  const sourceByState = { idle: idleSource, speaking: speakingSource };
  const crossfadeMs = Math.max(0, Number(config.videoCrossfadeMs ?? 220));
  const debounceMs = Math.max(0, Number(config.videoSpeakingDebounceMs ?? 180));
  let currentState: "idle" | "speaking" = "idle";
  let previousState: "idle" | "speaking" = "idle";
  let transitionStartedAt = performance.now();
  let lastSpeakingAt = -Infinity;

  Object.assign(rendererState, {
    renderer: "video",
    live2dLoaded: false,
    vrmLoaded: false,
    videoLoaded: true,
    videoSources: sources.map(({ id, label, url, state }) => ({ id, label, url, state })),
    videoState: currentState,
    fallbackReason: "",
    layout: config.layout,
  });

  function updateTargetState(now: number) {
    const mouthLevel = window.MAB_AVATAR_AUDIO_BUS?.getMouthLevel?.() || 0;
    const explicitSpeak = avatarController.state.action === "speak";
    if (explicitSpeak || mouthLevel > 0.015) lastSpeakingAt = now;
    const nextState = now - lastSpeakingAt <= debounceMs ? "speaking" : "idle";
    rendererState.videoMouthLevel = Number(mouthLevel.toFixed(4));
    if (nextState !== currentState) {
      previousState = currentState;
      currentState = nextState;
      transitionStartedAt = now;
    }
    rendererState.videoState = currentState;
  }

  function tick(now: number) {
    updateTargetState(now);
    const background = sourceByState[currentState]?.background || sourceByState.idle.background;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, Number(config.canvasWidth), Number(config.canvasHeight));
    const fade = crossfadeMs <= 0 ? 1 : clamp((now - transitionStartedAt) / crossfadeMs, 0, 1);
    if (fade < 1 && previousState !== currentState) {
      drawVideoFrame(
        ctx,
        videoByState[previousState],
        sourceByState[previousState],
        1 - fade,
        config,
      );
    }
    const drew = drawVideoFrame(
      ctx,
      videoByState[currentState],
      sourceByState[currentState],
      fade,
      config,
    );
    if (!drew) drawFallback(ctx, now);
    rendererState.videoFrames += 1;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
