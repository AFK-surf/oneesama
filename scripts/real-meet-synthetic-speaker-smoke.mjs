#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { createGoogleMeetJoiner } from "../packages/core/src/meeting/google-meet-joiner.ts";
import { startLocalMeetFixtureServer } from "../packages/core/src/meeting/local-meet-fixture.ts";

const SELF = fileURLToPath(import.meta.url);

function envMs(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function jsonLine(prefix, payload) {
  console.log(`${prefix} ${JSON.stringify(payload)}`);
}

async function fetchJson(url, options = {}) {
  const headers = { "content-type": "application/json" };
  if (options.headers) Object.assign(headers, options.headers);
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${url}: ${text.slice(0, 400)}`);
    error.body = body;
    throw error;
  }
  return body;
}

async function postJson(url, body) {
  return await fetchJson(url, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, probe, timeoutMs, intervalMs = 1000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await probe();
    if (last?.done) return last;
    await sleep(intervalMs);
  }
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.last = last;
  throw error;
}

async function appendSilenceToPcmWav(filePath, silenceMs = 3000) {
  const wav = await readFile(filePath);
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`not a WAVE file: ${filePath}`);
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const bodyOffset = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: wav.readUInt16LE(bodyOffset),
        channels: wav.readUInt16LE(bodyOffset + 2),
        sampleRate: wav.readUInt32LE(bodyOffset + 4),
        bitsPerSample: wav.readUInt16LE(bodyOffset + 14),
      };
    } else if (id === "data") {
      data = { offset, bodyOffset, size };
      break;
    }
    offset = bodyOffset + size + (size % 2);
  }
  if (!fmt || !data || fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(`unsupported WAVE shape for silence padding: ${filePath}`);
  }
  const bytesPerFrame = Math.max(1, fmt.channels * (fmt.bitsPerSample / 8));
  const frames = Math.ceil((fmt.sampleRate * silenceMs) / 1000);
  const silence = Buffer.alloc(frames * bytesPerFrame);
  const beforeDataSize = wav.subarray(0, data.offset + 4);
  const dataSize = Buffer.alloc(4);
  dataSize.writeUInt32LE(data.size + silence.length, 0);
  const dataBytes = wav.subarray(data.bodyOffset, data.bodyOffset + data.size);
  const afterData = wav.subarray(data.bodyOffset + data.size);
  const padded = Buffer.concat([beforeDataSize, dataSize, dataBytes, silence, afterData]);
  padded.writeUInt32LE(padded.length - 8, 4);
  await writeFile(filePath, padded);
}

async function generateSpeakerWav(tmpDir) {
  const provided = process.env.MAB_SYNTHETIC_SPEAKER_WAV || "";
  if (provided) {
    if (!existsSync(provided)) throw new Error(`MAB_SYNTHETIC_SPEAKER_WAV not found: ${provided}`);
    return provided;
  }
  const text =
    process.env.MAB_SYNTHETIC_SPEAKER_TEXT ||
    [
      "Hello Onee Sama. This is an automated Google Meet speaker test.",
      "Please answer if you can hear this synthetic participant.",
      "Hello Onee Sama. This is an automated Google Meet speaker test.",
      "Please answer if you can hear this synthetic participant.",
    ].join(" ");
  const voice = process.env.MAB_SYNTHETIC_SPEAKER_VOICE || "Samantha";
  const aiffPath = pathJoin(tmpDir, "synthetic-speaker.aiff");
  const wavPath = pathJoin(tmpDir, "synthetic-speaker.wav");
  const say = spawnSync("say", ["-v", voice, "-o", aiffPath, text], {
    encoding: "utf8",
  });
  if (say.status !== 0) {
    throw new Error(`say failed: ${(say.stderr || say.stdout || "").trim()}`);
  }
  const convert = spawnSync("afconvert", ["-f", "WAVE", "-d", "LEI16@48000", aiffPath, wavPath], {
    encoding: "utf8",
  });
  if (convert.status !== 0) {
    throw new Error(`afconvert failed: ${(convert.stderr || convert.stdout || "").trim()}`);
  }
  await appendSilenceToPcmWav(wavPath);
  return wavPath;
}

function compactBridgeStatus(status) {
  const active =
    status?.active?.realtimeBridge || status?.active?.meetPage
      ? status.active
      : status?.runtime?.active || status?.active || null;
  const bridge = active?.realtimeBridge || null;
  const connection = bridge?.connection || {};
  const meetAudioEnergy = connection.meetAudioEnergy || {};
  const realtimeInputEnergy = connection.realtimeInputEnergy || {};
  const senderStats = connection.realtimeAudioSenderStats || {};
  const primaryMeetAudioSenderStats = connection.primaryMeetAudioSenderStats || {};
  const remoteAudioTrackStats = connection.realtimeRemoteAudioTrackStats || {};
  const avatarAudio = active?.avatarAudio || {};
  const avatarOutputEnergy = avatarAudio.outputEnergy || {};
  const timelineTypes = Array.isArray(bridge?.timeline)
    ? bridge.timeline
        .slice(-20)
        .flatMap((entry) => [entry?.type, entry?.detail?.type])
        .filter(Boolean)
    : [];
  const inboundTypes = Array.isArray(bridge?.inbound)
    ? bridge.inbound
        .slice(-20)
        .map((entry) => entry?.type || entry?.event?.type || entry?.detail?.type)
        .filter(Boolean)
    : [];
  return {
    activeSessionId: active?.sessionId || "",
    participantCount: active?.meetPage?.participantCount ?? null,
    activeSpeaker:
      active?.meetPage?.activeSpeaker || active?.meetingAwareness?.activeSpeaker || null,
    bridgeConnected: bridge?.connected === true,
    dataChannelOpen: connection.dataChannelOpen === true,
    currentRealtimeInputSource: connection.currentRealtimeInputSource || "",
    meetAudioInputGain: Number(connection.meetAudioInputGain || 0),
    senderTrackReadyState: senderStats.trackReadyState || "",
    senderBytesSent: Number(senderStats.bytesSent || 0),
    senderPacketsSent: Number(senderStats.packetsSent || 0),
    senderSourceAudioLevel: Number(senderStats.sourceAudioLevel || 0),
    senderSourceTotalAudioEnergy: Number(senderStats.sourceTotalAudioEnergy || 0),
    senderSourceTotalSamplesDuration: Number(senderStats.sourceTotalSamplesDuration || 0),
    meetAudioTracksForwarded: Number(connection.meetAudioTracksForwarded || 0),
    meetAudioSourcesActive: Number(connection.meetAudioSourcesActive || 0),
    meetAudioEnergy: {
      observed: meetAudioEnergy.observed === true,
      rms: Number(meetAudioEnergy.rms || 0),
      peak: Number(meetAudioEnergy.peak || 0),
      thresholdRms: Number(meetAudioEnergy.thresholdRms || 0.003),
      thresholdPeak: Number(meetAudioEnergy.thresholdPeak || 0.01),
      lastEnergyAt: meetAudioEnergy.lastEnergyAt || "",
    },
    realtimeInputEnergy: {
      observed: realtimeInputEnergy.observed === true,
      rms: Number(realtimeInputEnergy.rms || 0),
      peak: Number(realtimeInputEnergy.peak || 0),
      lastEnergyAt: realtimeInputEnergy.lastEnergyAt || "",
    },
    lastInboundEventType: connection.lastInboundEventType || "",
    lastInputSpeechStartedAt: bridge?.protection?.lastInputSpeechStartedAt || "",
    responsesRequested: Number(bridge?.responsesRequested || 0),
    remoteAudioRoutedToAvatarBus: connection.remoteAudioRoutedToAvatarBus === true,
    primaryMeetAudioSenderUsingAvatarBus: connection.primaryMeetAudioSenderUsingAvatarBus === true,
    realtimeRemoteAudioTrackStats: {
      supported: remoteAudioTrackStats.supported === true,
      observed: remoteAudioTrackStats.observed === true,
      trackReadyState: remoteAudioTrackStats.trackReadyState || "",
      trackMuted: remoteAudioTrackStats.trackMuted === true,
      audioLevel: Number(remoteAudioTrackStats.audioLevel || 0),
      totalAudioEnergy: Number(remoteAudioTrackStats.totalAudioEnergy || 0),
      energyDelta: Number(remoteAudioTrackStats.energyDelta || 0),
      bytesReceived: Number(remoteAudioTrackStats.bytesReceived || 0),
      bytesDelta: Number(remoteAudioTrackStats.bytesDelta || 0),
      packetsReceived: Number(remoteAudioTrackStats.packetsReceived || 0),
      packetsDelta: Number(remoteAudioTrackStats.packetsDelta || 0),
    },
    primaryMeetAudioSenderStats: {
      supported: primaryMeetAudioSenderStats.supported === true,
      usingAvatarBus: primaryMeetAudioSenderStats.usingAvatarBus === true,
      trackReadyState: primaryMeetAudioSenderStats.trackReadyState || "",
      bytesSent: Number(primaryMeetAudioSenderStats.bytesSent || 0),
      bytesDelta: Number(primaryMeetAudioSenderStats.bytesDelta || 0),
      packetsSent: Number(primaryMeetAudioSenderStats.packetsSent || 0),
      packetsDelta: Number(primaryMeetAudioSenderStats.packetsDelta || 0),
    },
    avatarAudio: {
      ok: avatarAudio.ok === true,
      audioContextState: avatarAudio.audioContextState || "",
      lastResumeAt: avatarAudio.lastResumeAt || "",
      lastResumeError: avatarAudio.lastResumeError || "",
      routedStreams: Number(avatarAudio.routedStreams || 0),
      routedElements: Number(avatarAudio.routedElements || 0),
      routedBuffers: Number(avatarAudio.routedBuffers || 0),
      mouthLevel: Number(avatarAudio.mouthLevel || 0),
      mouthRms: Number(avatarAudio.mouthRms || 0),
      outputEnergyObserved: avatarOutputEnergy.observed === true,
      outputEnergyRms: Number(avatarOutputEnergy.rms || 0),
      outputEnergyPeak: Number(avatarOutputEnergy.peak || 0),
      outputEnergyMaxRms: Number(avatarOutputEnergy.maxRms || 0),
      outputEnergyLastAt: avatarOutputEnergy.lastEnergyAt || "",
      lastRouteKind: avatarAudio.lastRoute?.kind || "",
    },
    outputTranscriptCount: Array.isArray(bridge?.transcripts?.output)
      ? bridge.transcripts.output.length
      : 0,
    timelineTypes,
    inboundTypes,
    feedback: bridge?.feedback || null,
  };
}

function gateStatus(compact) {
  const energy = compact.meetAudioEnergy || {};
  const meetEnergyOk =
    energy.observed === true ||
    energy.rms >= Math.max(energy.thresholdRms || 0.003, 0.003) ||
    energy.peak >= Math.max(energy.thresholdPeak || 0.01, 0.01);
  const responseSeen =
    compact.responsesRequested > 0 ||
    compact.outputTranscriptCount > 0 ||
    compact.inboundTypes.some((type) => String(type).startsWith("response.")) ||
    compact.timelineTypes.some((type) => String(type).startsWith("response.")) ||
    Number(compact.feedback?.checks?.responseEvents || 0) > 0 ||
    compact.feedback?.failureMatrix?.modelTurn?.status === "ok";
  const speechStarted =
    responseSeen ||
    Boolean(compact.lastInputSpeechStartedAt) ||
    compact.lastInboundEventType === "input_audio_buffer.speech_started" ||
    compact.timelineTypes.includes("input_audio_buffer.speech_started") ||
    compact.inboundTypes.includes("input_audio_buffer.speech_started") ||
    compact.timelineTypes.includes("agents_sdk.agent_start") ||
    compact.inboundTypes.includes("agents_sdk.agent_start");
  const avatarOutputObserved = compact.avatarAudio?.outputEnergyObserved === true;
  return {
    participantPresent:
      Number(compact.participantCount || 0) >= 2 || Boolean(compact.activeSpeaker),
    senderLive:
      compact.currentRealtimeInputSource === "meet_audio_mix" &&
      compact.senderTrackReadyState === "live" &&
      compact.senderBytesSent > 0,
    meetEnergyOk,
    speechStarted,
    responseSeen,
    outputRouted:
      responseSeen && avatarOutputObserved,
  };
}

async function runSpeakerWorker() {
  const meetUrl = process.env.MAB_REAL_MEET_URL || "";
  const wavPath = process.env.MAB_SYNTHETIC_SPEAKER_WAV || "";
  if (!meetUrl) throw new Error("MAB_REAL_MEET_URL is required");
  if (!wavPath) throw new Error("MAB_SYNTHETIC_SPEAKER_WAV is required");

  const sessionId = process.env.MAB_SYNTHETIC_SPEAKER_SESSION_ID || `speaker_${Date.now()}`;
  const botName = process.env.MAB_SYNTHETIC_SPEAKER_NAME || "Synthetic Speaker";
  const holdMs = envMs("MAB_SYNTHETIC_SPEAKER_HOLD_MS", 90_000);
  const joiner = createGoogleMeetJoiner();
  try {
    const join = await joiner.join({
      sessionId,
      meetUrl,
      botName,
      dryRun: false,
      installAvatar: false,
      installRealtimeBridge: false,
      installWorkerResultBridge: false,
      installLocalDialogBridge: false,
      installScreenShareBridge: false,
      captureCaptions: false,
      recordMeeting: false,
      disableLive2D: true,
      browserExtraArgs: `--use-file-for-fake-audio-capture=${wavPath}`,
    });
    const joined = join?.ok === true && join?.dryRun === false && !join?.error;
    jsonLine("SPEAKER_JOIN_RESULT", { joined, sessionId, botName, join });
    if (!joined) process.exitCode = 2;
    if (joined) await sleep(holdMs);
  } finally {
    await joiner.stop("synthetic_speaker_worker_done").catch(() => {});
  }
}

async function waitForSpeakerReady(child, timeoutMs) {
  let buffer = "";
  let lastLine = "";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`synthetic speaker did not join within ${timeoutMs}ms; last=${lastLine}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        lastLine = line;
        console.log(`[speaker] ${line}`);
        if (!line.startsWith("SPEAKER_JOIN_RESULT ")) continue;
        clearTimeout(timer);
        const payload = JSON.parse(line.slice("SPEAKER_JOIN_RESULT ".length));
        if (payload.joined) resolve(payload);
        else reject(new Error(`synthetic speaker join failed: ${JSON.stringify(payload.join)}`));
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[speaker:stderr] ${text}`);
    });
    child.on("exit", (code) => {
      if (code && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`synthetic speaker exited early with code ${code}; last=${lastLine}`));
      }
    });
  });
}

async function runMain() {
  const meetUrl = process.env.MAB_REAL_MEET_URL || "";
  if (!meetUrl) {
    throw new Error("Set MAB_REAL_MEET_URL to run the real Meet synthetic speaker smoke.");
  }
  const meetingAgentUrl = (process.env.MAB_MEETING_AGENT_URL || "http://127.0.0.1:8781").replace(
    /\/+$/,
    "",
  );
  const timeoutMs = envMs("MAB_REAL_MEET_SYNTHETIC_WAIT_MS", 120_000);
  const speakerJoinTimeoutMs = envMs("MAB_SYNTHETIC_SPEAKER_JOIN_TIMEOUT_MS", 120_000);
  const tmpDir = await mkdtemp(pathJoin(tmpdir(), "oneesama-real-meet-speaker-"));
  const wavPath = await generateSpeakerWav(tmpDir);
  const sessionId = process.env.MAB_REAL_MEET_SESSION_ID || `real_meet_synthetic_${Date.now()}`;
  const speakerSessionId = `${sessionId}_speaker`;
  const speakerDataDir = pathJoin(tmpDir, "speaker-data");
  const speaker = spawn(process.execPath, ["--import", "tsx", SELF, "--speaker-worker"], {
    env: {
      ...process.env,
      MAB_REAL_MEET_URL: meetUrl,
      MAB_SYNTHETIC_SPEAKER_WAV: wavPath,
      MAB_SYNTHETIC_SPEAKER_SESSION_ID: speakerSessionId,
      MAB_SYNTHETIC_SPEAKER_HOLD_MS: String(timeoutMs + 30_000),
      MAB_DATA_DIR: speakerDataDir,
      MAB_SCREENSHOT_DIR: pathJoin(tmpDir, "speaker-screenshots"),
      MAB_BROWSER_HEADLESS: process.env.MAB_SYNTHETIC_SPEAKER_HEADLESS || "true",
      MAB_MEET_PROFILE_MODE: "guest",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForSpeakerReady(speaker, speakerJoinTimeoutMs);
    await postJson(`${meetingAgentUrl}/join/stop`, {
      reason: "synthetic_speaker_smoke_preflight",
    }).catch(() => {});
    const join = await postJson(`${meetingAgentUrl}/join/google-meet`, {
      sessionId,
      session_id: sessionId,
      meetUrl,
      meeting_url: meetUrl,
      botName: process.env.MAB_REAL_MEET_BOT_NAME || "Onee Sama",
      display_name: process.env.MAB_REAL_MEET_BOT_NAME || "Onee Sama",
      dryRun: false,
      dry_run: false,
      disableLive2D: process.env.MAB_REAL_MEET_DISABLE_LIVE2D !== "0",
      installWorkerResultBridge: true,
      install_worker_result_bridge: true,
      installRealtimeBridge: true,
      install_realtime_bridge: true,
      realtimeBridgeMode: process.env.MAB_REAL_MEET_REALTIME_MODE || "agents-sdk",
      realtime_bridge_mode: process.env.MAB_REAL_MEET_REALTIME_MODE || "agents-sdk",
      autoConnectRealtime: true,
      auto_connect_realtime: true,
      sendRealtimeSessionUpdate: true,
      send_realtime_session_update: true,
      includeParticipantAudio: true,
      include_participant_audio: true,
      forwardMeetAudioToRealtime: true,
      forward_meet_audio_to_realtime: true,
      meetAudioInputGain: 1,
      meet_audio_input_gain: 1,
      captureCaptions: false,
      capture_captions: false,
    });
    const final = await waitFor(
      "real Meet synthetic speaker gate",
      async () => {
        const status = await fetchJson(`${meetingAgentUrl}/join/status`);
        const compact = compactBridgeStatus(status);
        const gates = gateStatus(compact);
        return {
          done:
            gates.participantPresent &&
            gates.senderLive &&
            gates.meetEnergyOk &&
            gates.speechStarted &&
            gates.responseSeen &&
            gates.outputRouted,
          gates,
          compact,
        };
      },
      timeoutMs,
      1500,
    );
    const result = { ok: true, meetUrl, sessionId, speakerSessionId, wavPath, join, final };
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const result = {
      ok: false,
      meetUrl,
      sessionId,
      speakerSessionId,
      error: String(error?.message || error),
      last: error?.last || null,
    };
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    await postJson(`${meetingAgentUrl}/join/stop`, {
      reason: "real_meet_synthetic_speaker_smoke_done",
    }).catch(() => {});
    speaker.kill("SIGTERM");
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runLocalFixtureMain() {
  const meetingAgentUrl = (process.env.MAB_MEETING_AGENT_URL || "http://127.0.0.1:8781").replace(
    /\/+$/,
    "",
  );
  const timeoutMs = envMs("MAB_REALTIME_SYNTHETIC_SPEECH_WAIT_MS", 90_000);
  const tmpDir = await mkdtemp(pathJoin(tmpdir(), "oneesama-realtime-speech-"));
  const wavPath = await generateSpeakerWav(tmpDir);
  const fixture = await startLocalMeetFixtureServer({ participantAudioFile: wavPath });
  const speechStartDelayMs = envMs("MAB_REALTIME_SYNTHETIC_SPEECH_START_DELAY_MS", 35000);
  const fixtureUrl = `${fixture.url}?participantSpeech=1&participantSpeechStartDelayMs=${speechStartDelayMs}`;
  const sessionId =
    process.env.MAB_REALTIME_SYNTHETIC_SESSION_ID || `realtime_speech_${Date.now()}`;
  try {
    await postJson(`${meetingAgentUrl}/join/stop`, {
      reason: "synthetic_speech_smoke_preflight",
    }).catch(() => {});
    const join = await postJson(`${meetingAgentUrl}/join/google-meet`, {
      sessionId,
      session_id: sessionId,
      meetUrl: fixtureUrl,
      meeting_url: fixtureUrl,
      botName: process.env.MAB_REAL_MEET_BOT_NAME || "Onee Sama Synthetic Speech",
      display_name: process.env.MAB_REAL_MEET_BOT_NAME || "Onee Sama Synthetic Speech",
      dryRun: false,
      dry_run: false,
      allowNonGoogleMeet: true,
      allow_non_google_meet: true,
      collectFixtureState: true,
      collect_fixture_state: true,
      disableLive2D: process.env.MAB_REAL_MEET_DISABLE_LIVE2D !== "0",
      installWorkerResultBridge: true,
      install_worker_result_bridge: true,
      installRealtimeBridge: true,
      install_realtime_bridge: true,
      realtimeBridgeMode: process.env.MAB_REAL_MEET_REALTIME_MODE || "agents-sdk",
      realtime_bridge_mode: process.env.MAB_REAL_MEET_REALTIME_MODE || "agents-sdk",
      autoConnectRealtime: true,
      auto_connect_realtime: true,
      sendRealtimeSessionUpdate: true,
      send_realtime_session_update: true,
      includeParticipantAudio: true,
      include_participant_audio: true,
      forwardMeetAudioToRealtime: true,
      forward_meet_audio_to_realtime: true,
      meetAudioInputGain: 1,
      meet_audio_input_gain: 1,
      captureCaptions: false,
      capture_captions: false,
    });
    const final = await waitFor(
      "local fixture synthetic speech gate",
      async () => {
        const status = await fetchJson(`${meetingAgentUrl}/join/status`);
        const compact = compactBridgeStatus(status);
        const gates = gateStatus(compact);
        return {
          done:
            gates.senderLive &&
            gates.meetEnergyOk &&
            gates.speechStarted &&
            gates.responseSeen &&
            gates.outputRouted,
          gates,
          compact,
        };
      },
      timeoutMs,
      1500,
    );
    const result = { ok: true, fixtureUrl, sessionId, wavPath, join, final };
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const result = {
      ok: false,
      fixtureUrl,
      sessionId,
      error: String(error?.message || error),
      last: error?.last || null,
    };
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    await postJson(`${meetingAgentUrl}/join/stop`, {
      reason: "realtime_synthetic_speech_smoke_done",
    }).catch(() => {});
    await fixture.close().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv.includes("--speaker-worker")) {
  await runSpeakerWorker();
} else if (process.argv.includes("--local-fixture")) {
  await runLocalFixtureMain();
} else {
  await runMain();
}
