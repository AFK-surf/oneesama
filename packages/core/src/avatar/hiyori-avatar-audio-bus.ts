interface AudioBusInput {
  config: Record<string, unknown>;
  clamp01: (value: unknown) => number;
}

interface StreamOptions {
  label?: string;
  gain?: number;
}

interface InjectToneOptions extends StreamOptions {
  frequency?: number;
  durationMs?: number;
}

export function createAvatarAudioBus({ config, clamp01 }: AudioBusInput) {
  const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextImpl({ sampleRate: 48000 });
  const destination = audioContext.createMediaStreamDestination();
  const masterGain = audioContext.createGain();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.18;
  const waveform = new Uint8Array(analyser.fftSize);
  let smoothedMouthLevel = 0;
  let syntheticSpeechActive = false;
  let syntheticSpeechUntil = 0;
  masterGain.gain.value = Number(config.fakeMicGain ?? 1);
  masterGain.connect(destination);
  masterGain.connect(analyser);

  const state = {
    ok: true,
    sampleRate: audioContext.sampleRate,
    audioContextState: audioContext.state || "",
    outputTrackId: destination.stream.getAudioTracks()[0]?.id || "",
    outputTrackReadyState: destination.stream.getAudioTracks()[0]?.readyState || "",
    outputTrackMuted: destination.stream.getAudioTracks()[0]?.muted === true,
    lipSyncEnabled: true,
    mouthLevel: 0,
    mouthRms: 0,
    outputEnergy: {
      observed: false,
      rms: 0,
      peak: 0,
      maxRms: 0,
      lastEnergyAt: "",
      lastCheckedAt: "",
      thresholdRms: 0.012,
      thresholdPeak: 0.03,
    },
    syntheticSpeechActive: false,
    routedStreams: 0,
    routedElements: 0,
    routedBuffers: 0,
    injectedTones: 0,
    lastResumeAt: "",
    lastResumeError: "",
    lastRoute: null as Record<string, unknown> | null,
    errors: [] as Array<Record<string, unknown>>,
  };

  function rememberError(error: unknown): void {
    const err = error as { message?: string };
    state.errors.push({
      ts: new Date().toISOString(),
      message: String((err && err.message) || error).slice(0, 300),
    });
    state.errors = state.errors.slice(-20);
  }

  function touch(kind: string, detail: Record<string, unknown> = {}): void {
    state.lastRoute = { ts: new Date().toISOString(), kind, ...detail };
    state.audioContextState = audioContext.state || "";
    const track = destination.stream.getAudioTracks()[0];
    state.outputTrackReadyState = track?.readyState || "";
    state.outputTrackMuted = track?.muted === true;
    audioContext.resume?.()
      .then(() => {
        state.audioContextState = audioContext.state || "";
        state.lastResumeAt = new Date().toISOString();
        state.lastResumeError = "";
        return undefined;
      })
      .catch((error: unknown) => {
        state.audioContextState = audioContext.state || "";
        state.lastResumeError = String((error as { message?: string })?.message || error).slice(
          0,
          240,
        );
        return undefined;
      });
  }

  function addStream(stream: MediaStream | null | undefined, options: StreamOptions = {}) {
    try {
      if (!stream || !stream.getAudioTracks || stream.getAudioTracks().length === 0) {
        throw new Error("stream has no audio tracks");
      }
      const track = stream.getAudioTracks()[0];
      const audioContextWithTrackSource = audioContext as AudioContext & {
        createMediaStreamTrackSource?: (track: MediaStreamTrack) => MediaStreamAudioSourceNode;
      };
      const source =
        track && typeof audioContextWithTrackSource.createMediaStreamTrackSource === "function"
          ? audioContextWithTrackSource.createMediaStreamTrackSource(track)
          : audioContext.createMediaStreamSource(stream);
      const gain = audioContext.createGain();
      gain.gain.value = Number(options.gain ?? 1);
      source.connect(gain);
      gain.connect(masterGain);
      state.routedStreams += 1;
      touch("stream", {
        label: options.label || "",
        trackIds: stream.getAudioTracks().map((entry) => entry.id),
      });
      return { ok: true };
    } catch (error) {
      rememberError(error);
      return { ok: false, error: String(((error as { message?: string }) || {}).message || error) };
    }
  }

  function sampleOutputEnergy() {
    analyser.getByteTimeDomainData(waveform);
    let sumSquares = 0;
    let peak = 0;
    for (const sample of waveform) {
      const centered = (sample - 128) / 128;
      const abs = Math.abs(centered);
      if (abs > peak) peak = abs;
      sumSquares += centered * centered;
    }
    const rms = Math.sqrt(sumSquares / waveform.length);
    const now = new Date();
    const thresholdRms = state.outputEnergy.thresholdRms;
    const thresholdPeak = state.outputEnergy.thresholdPeak;
    const energetic = rms >= thresholdRms || peak >= thresholdPeak;
    const lastEnergyAt = energetic ? now.toISOString() : state.outputEnergy.lastEnergyAt;
    const maxRms = Math.max(Number(state.outputEnergy.maxRms || 0), rms);
    state.audioContextState = audioContext.state || "";
    state.mouthRms = Number(rms.toFixed(4));
    state.outputEnergy = {
      observed: Boolean(state.outputEnergy.observed || energetic),
      rms: Number(rms.toFixed(5)),
      peak: Number(peak.toFixed(5)),
      maxRms: Number(maxRms.toFixed(5)),
      lastEnergyAt,
      lastCheckedAt: now.toISOString(),
      thresholdRms,
      thresholdPeak,
    };
    return { rms, peak };
  }

  function getMouthLevel() {
    try {
      const { rms } = sampleOutputEnergy();
      const gated = Math.max(0, rms - 0.012);
      const syntheticActive = syntheticSpeechActive || performance.now() < syntheticSpeechUntil;
      const t = performance.now() / 1000;
      const synthetic = syntheticActive
        ? 0.2 + 0.24 * (0.5 + 0.5 * Math.sin(t * 18)) + 0.16 * (0.5 + 0.5 * Math.sin(t * 31 + 0.8))
        : 0;
      const target = clamp01(Math.max(gated * 5.8, synthetic));
      const coefficient = target > smoothedMouthLevel ? 0.52 : 0.22;
      smoothedMouthLevel += (target - smoothedMouthLevel) * coefficient;
      state.mouthLevel = Number(smoothedMouthLevel.toFixed(4));
      state.syntheticSpeechActive = syntheticActive;
      return smoothedMouthLevel;
    } catch (error) {
      rememberError(error);
      return 0;
    }
  }

  function setSyntheticSpeech(active: boolean, options: { holdMs?: number } = {}) {
    syntheticSpeechActive = Boolean(active);
    syntheticSpeechUntil = syntheticSpeechActive ? performance.now() + Number(options.holdMs ?? 1600) : 0;
    state.syntheticSpeechActive = syntheticSpeechActive;
    touch("synthetic_speech", { active: syntheticSpeechActive });
    return { ok: true, active: syntheticSpeechActive };
  }

  function addElement(audioElement: HTMLMediaElement, options: StreamOptions = {}) {
    try {
      const source = audioContext.createMediaElementSource(audioElement);
      const gain = audioContext.createGain();
      gain.gain.value = Number(options.gain ?? 1);
      source.connect(gain);
      gain.connect(masterGain);
      state.routedElements += 1;
      touch("element", { label: options.label || "" });
      return { ok: true };
    } catch (error) {
      rememberError(error);
      const err = error as { message?: string };
      return { ok: false, error: String((err && err.message) || error) };
    }
  }

  function injectTone(options: InjectToneOptions = {}) {
    try {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = Number(options.frequency ?? 440);
      gain.gain.value = Number(options.gain ?? 0.0001);
      oscillator.connect(gain);
      gain.connect(masterGain);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + Number(options.durationMs ?? 120) / 1000);
      state.injectedTones += 1;
      touch("tone", { label: options.label || "mock-remote-audio" });
      return { ok: true };
    } catch (error) {
      rememberError(error);
      const err = error as { message?: string };
      return { ok: false, error: String((err && err.message) || error) };
    }
  }

  async function playAudioDataUrl(audioDataUrl: string, options: StreamOptions = {}) {
    try {
      const response = await fetch(audioDataUrl);
      const arrayBuffer = await response.arrayBuffer();
      const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      const source = audioContext.createBufferSource();
      const gain = audioContext.createGain();
      source.buffer = decoded;
      gain.gain.value = Number(options.gain ?? 1);
      source.connect(gain);
      gain.connect(masterGain);
      source.start();
      state.routedBuffers += 1;
      touch("buffer", { label: options.label || "", durationMs: Math.round(decoded.duration * 1000) });
      return { ok: true, durationMs: Math.round(decoded.duration * 1000) };
    } catch (error) {
      rememberError(error);
      const err = error as { message?: string };
      return { ok: false, error: String((err && err.message) || error) };
    }
  }

  const keeper = audioContext.createConstantSource();
  const keeperGain = audioContext.createGain();
  keeper.offset.value = 0;
  keeperGain.gain.value = 0;
  keeper.connect(keeperGain);
  keeperGain.connect(masterGain);
  keeper.start();
  window.setInterval(sampleOutputEnergy, 250);

  const bus = {
    state,
    audioContext,
    stream: destination.stream,
    track: destination.stream.getAudioTracks()[0],
    addStream,
    addElement,
    playAudioDataUrl,
    injectTone,
    getMouthLevel,
    sampleOutputEnergy,
    setSyntheticSpeech,
  };
  window.MAB_AVATAR_AUDIO_BUS = bus;
  window.MAB_AVATAR_AUDIO = state;

  window.addEventListener("meeting-avatar-audio-stream", (event: Event) => {
    const detail = (event as CustomEvent).detail as
      | { stream?: MediaStream; label?: string; gain?: number }
      | undefined;
    addStream(detail?.stream, {
      label: detail?.label || "meeting-avatar-audio-stream",
      gain: detail?.gain,
    });
  });

  return bus;
}
