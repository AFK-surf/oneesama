interface ScreenShareInitOptions {
  enabled?: boolean;
  width?: number | string;
  screenShareWidth?: number | string;
  height?: number | string;
  screenShareHeight?: number | string;
  fps?: number | string;
  screenShareFps?: number | string;
  mode?: string;
  title?: string;
  subtitle?: string;
  videoUrl?: string;
  imageUrl?: string;
  muted?: boolean;
  autoStart?: boolean;
}

export function buildScreenShareInitScript(options: ScreenShareInitOptions = {}) {
  const config = {
    enabled: options.enabled !== false,
    width: Number.parseInt(String(options.width ?? options.screenShareWidth ?? 2560), 10),
    height: Number.parseInt(String(options.height ?? options.screenShareHeight ?? 1440), 10),
    fps: Number.parseInt(String(options.fps ?? options.screenShareFps ?? 25), 10),
    mode: options.mode || "synthetic",
    title: options.title || "Meeting Avatar Bot",
    subtitle: options.subtitle || "Shared agent workspace",
    videoUrl: options.videoUrl || "",
    imageUrl: options.imageUrl || "",
    muted: options.muted !== false,
    autoStart: Boolean(options.autoStart),
  };

  return `(() => {
    const config = ${JSON.stringify(config)};
    if (!config.enabled || window.MAB_SCREEN_SHARE_CONTROLLER) return;

    const state = {
      ok: true,
      enabled: true,
      active: false,
      startedAt: "",
      stoppedAt: "",
      streamId: "",
      trackIds: [],
      frames: 0,
      displayMediaCalls: 0,
      mode: config.mode,
      title: config.title,
      subtitle: config.subtitle,
      videoUrl: config.videoUrl,
      imageUrl: config.imageUrl,
      width: config.width,
      height: config.height,
      fps: config.fps,
      videoReady: false,
      videoError: "",
      imageReady: false,
      imageError: "",
      errors: [],
    };
    window.MAB_SCREEN_SHARE = state;

    let canvas = null;
    let ctx = null;
    let stream = null;
    let timer = null;
    let frame = 0;
    let video = null;
    let image = null;

    function clampDimension(value, fallback, min, max) {
      const parsed = Number.parseInt(String(value ?? ""), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
      return Math.max(min, Math.min(max, parsed));
    }

    function clampFps(value, fallback) {
      const parsed = Number.parseInt(String(value ?? ""), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
      return Math.max(1, Math.min(30, parsed));
    }

    function ensureCanvas() {
      if (canvas) return canvas;
      canvas = document.createElement("canvas");
      canvas.width = state.width;
      canvas.height = state.height;
      canvas.style.cssText = "position:fixed;right:12px;bottom:12px;width:256px;height:144px;z-index:2147483647;border:1px solid rgba(0,0,0,.25);background:#101418;display:none";
      canvas.dataset.meetingAvatarScreenShare = "1";
      document.documentElement.appendChild(canvas);
      ctx = canvas.getContext("2d");
      return canvas;
    }

    function resizeCanvas(width, height) {
      const nextWidth = clampDimension(width, state.width || config.width, 320, 4096);
      const nextHeight = clampDimension(height, state.height || config.height, 180, 2304);
      state.width = nextWidth;
      state.height = nextHeight;
      if (canvas && (canvas.width !== nextWidth || canvas.height !== nextHeight)) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
    }

    function ensureVideo() {
      if (!state.videoUrl) return null;
      if (video) return video;
      video = document.createElement("video");
      video.src = state.videoUrl;
      video.crossOrigin = "anonymous";
      video.muted = config.muted;
      video.loop = true;
      video.playsInline = true;
      video.autoplay = true;
      video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none";
      video.addEventListener("loadeddata", () => { state.videoReady = true; });
      video.addEventListener("canplay", () => { state.videoReady = true; });
      video.addEventListener("error", () => {
        state.videoError = "video_error";
        state.errors.push("video_error");
      });
      document.documentElement.appendChild(video);
      video.play().catch((error) => {
        state.videoError = String(error && error.message || error);
        state.errors.push("video_play_failed: " + state.videoError);
      });
      return video;
    }

    function ensureImage() {
      if (!state.imageUrl) return null;
      if (image) return image;
      image = document.createElement("img");
      image.crossOrigin = "anonymous";
      if (/\\.mjpg(?:[?#]|$)|[?&]mjpeg=1(?:&|$)|multipart/i.test(state.imageUrl)) {
        state.imageReady = true;
      }
      image.src = state.imageUrl;
      image.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none";
      image.addEventListener("load", () => { state.imageReady = true; });
      image.addEventListener("error", () => {
        state.imageReady = false;
        state.imageError = "image_error";
        state.errors.push("image_error");
      });
      document.documentElement.appendChild(image);
      return image;
    }

    function drawContainVideo(videoEl, w, h) {
      const vw = videoEl.videoWidth || 0;
      const vh = videoEl.videoHeight || 0;
      if (!vw || !vh) return false;
      const scale = Math.min(w / vw, h / vh);
      const dw = Math.round(vw * scale);
      const dh = Math.round(vh * scale);
      const dx = Math.round((w - dw) / 2);
      const dy = Math.round((h - dh) / 2);
      ctx.fillStyle = "#05070a";
      ctx.fillRect(0, 0, w, h);
      try {
        ctx.drawImage(videoEl, dx, dy, dw, dh);
        return true;
      } catch (error) {
        state.videoError = String(error && error.message || error);
        state.errors.push("draw_video_failed: " + state.videoError);
        return false;
      }
    }

    function drawContainImage(imageEl, w, h) {
      const iw = imageEl.naturalWidth || imageEl.width || 0;
      const ih = imageEl.naturalHeight || imageEl.height || 0;
      if (!iw || !ih) return false;
      const scale = Math.min(w / iw, h / ih);
      const dw = Math.round(iw * scale);
      const dh = Math.round(ih * scale);
      const dx = Math.round((w - dw) / 2);
      const dy = Math.round((h - dh) / 2);
      ctx.fillStyle = "#05070a";
      ctx.fillRect(0, 0, w, h);
      try {
        ctx.drawImage(imageEl, dx, dy, dw, dh);
        return true;
      } catch (error) {
        state.imageError = String(error && error.message || error);
        state.errors.push("draw_image_failed: " + state.imageError);
        return false;
      }
    }

    function drawFrame() {
      ensureCanvas();
      frame += 1;
      state.frames = frame;
      const w = canvas.width;
      const h = canvas.height;
      const t = frame / Math.max(1, state.fps || config.fps);
      const imageEl = ensureImage();
      if (imageEl && state.imageReady && drawContainImage(imageEl, w, h)) {
        ctx.fillStyle = "rgba(5, 7, 10, .70)";
        ctx.fillRect(40, h - 116, Math.min(w - 80, 760), 72);
        ctx.fillStyle = "#ffffff";
        ctx.font = "700 26px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillText(state.title || config.title, 64, h - 76);
        ctx.font = "400 18px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,.78)";
        ctx.fillText(state.subtitle || config.subtitle, 66, h - 50);
        return;
      }
      const videoEl = ensureVideo();
      if (videoEl && videoEl.readyState >= 2 && drawContainVideo(videoEl, w, h)) {
        ctx.fillStyle = "rgba(5, 7, 10, .70)";
        ctx.fillRect(40, h - 132, Math.min(w - 80, 720), 86);
        ctx.fillStyle = "#ffffff";
        ctx.font = "700 30px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillText(state.title || config.title, 64, h - 84);
        ctx.font = "400 20px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,.78)";
        ctx.fillText(state.subtitle || config.subtitle, 66, h - 54);
        return;
      }
      const hue = Math.round((t * 24) % 360);
      const gradient = ctx.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, "hsl(" + hue + " 72% 18%)");
      gradient.addColorStop(0.55, "#182332");
      gradient.addColorStop(1, "hsl(" + ((hue + 80) % 360) + " 70% 24%)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);

      ctx.fillStyle = "rgba(255,255,255,.08)";
      for (let i = 0; i < 12; i += 1) {
        const x = ((i * 173 + frame * 7) % (w + 160)) - 80;
        ctx.fillRect(x, 96 + i * 44, 220, 2);
      }

      ctx.fillStyle = "#ffffff";
      ctx.font = "700 64px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillText(state.title || config.title, 72, 150);
      ctx.font = "400 32px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,.82)";
      ctx.fillText(state.subtitle || config.subtitle, 76, 204);

      const boxY = 300;
      ctx.fillStyle = "rgba(255,255,255,.12)";
      ctx.fillRect(72, boxY, w - 144, 230);
      ctx.fillStyle = "rgba(255,255,255,.88)";
      ctx.font = "600 30px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillText("Live agent screen share", 104, boxY + 58);
      ctx.font = "400 24px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = "rgba(255,255,255,.70)";
      ctx.fillText("frame=" + frame + "  fps=" + (state.fps || config.fps) + "  " + new Date().toLocaleTimeString(), 104, boxY + 106);
      ctx.fillText("source=meeting-avatar synthetic display", 104, boxY + 148);

      ctx.fillStyle = "rgba(77, 218, 163, .9)";
      ctx.beginPath();
      ctx.arc(w - 118, 118, 18 + Math.sin(t * 4) * 4, 0, Math.PI * 2);
      ctx.fill();
    }

    function createStream() {
      ensureCanvas();
      drawFrame();
      stream = canvas.captureStream(state.fps || config.fps);
      state.streamId = stream.id;
      state.trackIds = stream.getVideoTracks().map((track) => track.id);
      return stream;
    }

    function decorateDisplayTrack(track, constraints) {
      try {
        track.contentHint = "detail";
      } catch (_) {
        // Optional browser hint.
      }
      try {
        Object.defineProperty(track, "label", { value: "Meeting Avatar Bot synthetic display", configurable: true });
      } catch (_) {
        // Some Chromium builds expose label as readonly; the track still works.
      }
      const originalGetSettings = track.getSettings?.bind(track);
      const originalGetCapabilities = track.getCapabilities?.bind(track);
      const originalGetConstraints = track.getConstraints?.bind(track);
      track.getSettings = () => ({
          ...(originalGetSettings ? originalGetSettings() : {}),
        width: state.width || config.width,
        height: state.height || config.height,
        frameRate: state.fps || config.fps,
        aspectRatio: (state.width || config.width) / (state.height || config.height),
        displaySurface: "monitor",
        logicalSurface: true,
        cursor: "always",
      });
      track.getCapabilities = () => ({
          ...(originalGetCapabilities ? originalGetCapabilities() : {}),
        width: { min: state.width || config.width, max: state.width || config.width },
        height: { min: state.height || config.height, max: state.height || config.height },
        frameRate: { min: state.fps || config.fps, max: state.fps || config.fps },
        displaySurface: ["monitor"],
        logicalSurface: [true],
        cursor: ["always"],
      });
      track.getConstraints = () => ({
        ...(originalGetConstraints ? originalGetConstraints() : {}),
        video: constraints.video === undefined ? true : constraints.video,
      });
      return track;
    }

    async function start(options = {}) {
      try {
        const nextWidth = options.width ?? options.screenShareWidth ?? state.width ?? config.width;
        const nextHeight = options.height ?? options.screenShareHeight ?? state.height ?? config.height;
        const nextFps = clampFps(options.fps ?? options.screenShareFps, state.fps || config.fps);
        const fpsChanged = nextFps !== state.fps;
        resizeCanvas(nextWidth, nextHeight);
        state.fps = nextFps;
        if (fpsChanged && timer) {
          window.clearInterval(timer);
          timer = null;
        }
        state.title = options.title || state.title || config.title;
        state.subtitle = options.subtitle || state.subtitle || config.subtitle;
        const nextImageUrl = options.imageUrl || options.imagePath || options.framePath || state.imageUrl || config.imageUrl;
        if (nextImageUrl && nextImageUrl !== state.imageUrl) {
          state.imageUrl = nextImageUrl;
          state.imageReady = false;
          state.imageError = "";
          if (image) image.remove();
          image = null;
          ensureImage();
        }
        state.videoUrl = options.videoUrl || options.url || options.path || state.videoUrl || config.videoUrl;
        if (state.videoUrl && (!video || video.src !== state.videoUrl)) {
          if (video) video.remove();
          video = null;
          ensureVideo();
        }
        if (!stream) createStream();
        if (!timer) {
          timer = window.setInterval(drawFrame, Math.max(16, Math.round(1000 / state.fps)));
        }
        state.active = true;
        state.startedAt = new Date().toISOString();
        state.stoppedAt = "";
        canvas.style.display = options.preview === true ? "block" : "none";
        window.dispatchEvent(new CustomEvent("meeting-avatar-screen-share-stream", {
          detail: {
            label: "meeting-avatar-screen-share",
            stream,
            state: { ...state },
          },
        }));
        return { ok: true, state: { ...state } };
      } catch (error) {
        state.errors.push(String(error && error.message || error));
        return { ok: false, error: state.errors[state.errors.length - 1], state: { ...state } };
      }
    }

    async function stop() {
      if (timer) window.clearInterval(timer);
      timer = null;
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }
      stream = null;
      state.active = false;
      state.stoppedAt = new Date().toISOString();
      state.streamId = "";
      state.trackIds = [];
      return { ok: true, state: { ...state } };
    }

    const mediaDevices = navigator.mediaDevices || {};
    navigator.mediaDevices = mediaDevices;
    const originalGetDisplayMedia = mediaDevices.getDisplayMedia?.bind(mediaDevices);
    const fakeGetDisplayMedia = async (constraints = {}) => {
      state.displayMediaCalls += 1;
      const result = await start({ preview: false });
      if (!result.ok) throw new Error(result.error || "screen share failed");
      const tracks = [];
      if (constraints.video !== false) {
        tracks.push(...stream.getVideoTracks().map((track) => {
          const clone = track.clone();
          return decorateDisplayTrack(clone, constraints);
        }));
      }
      return new MediaStream(tracks);
    };
    if (config.mode !== "native") {
      try {
        mediaDevices.getDisplayMedia = fakeGetDisplayMedia;
      } catch (error) {
        state.errors.push("install instance getDisplayMedia failed: " + String(error && error.message || error));
      }
      try {
        Object.defineProperty(Object.getPrototypeOf(mediaDevices), "getDisplayMedia", {
          configurable: true,
          writable: true,
          value: fakeGetDisplayMedia,
        });
      } catch (error) {
        state.errors.push("install prototype getDisplayMedia failed: " + String(error && error.message || error));
      }
    }

    window.MAB_SCREEN_SHARE_CONTROLLER = {
      start,
      stop,
      state: () => ({ ...state }),
      originalGetDisplayMedia: Boolean(originalGetDisplayMedia),
      mode: config.mode,
    };

    if (config.autoStart) {
      window.addEventListener("DOMContentLoaded", () => {
        window.setTimeout(() => start({ preview: false }), 500);
      }, { once: true });
    }
  })();`;
}
