/* eslint-disable no-unused-vars */

function rememberParticipantSource(
  label: string | undefined,
  stream: MediaStream,
  tracks: MediaStreamTrack[],
) {
  const source = {
    ts: new Date().toISOString(),
    label: label || "participant-audio",
    streamId: stream.id || "",
    trackIds: tracks.map((track) => track.id),
  };
  state.connection.participantAudioSources.push(source);
  state.connection.participantAudioSources = state.connection.participantAudioSources.slice(-20);
}

interface ParticipantStreamOptions {
  label?: string;
}

function allowParticipantAudioStreamInput() {
  return (
    config.allowParticipantAudioStreamEvents === true ||
    ["mock", "webrtc-mock", "agents-sdk-mock"].includes(String(config.mode || ""))
  );
}

function registerParticipantAudioStream(
  stream: MediaStream | null | undefined,
  options: ParticipantStreamOptions = {},
) {
  try {
    if (!allowParticipantAudioStreamInput()) {
      recordTimeline("participant_audio_stream_registration_rejected", {
        label: options.label || "",
        mode: config.mode || "",
        reason: "participant_audio_stream_registration_disabled",
      });
      updateFeedback();
      return {
        ok: false,
        error: "participant_audio_stream_registration_disabled",
        added: 0,
      };
    }
    const tracks = stream?.getAudioTracks?.() || [];
    const freshTracks = tracks.filter((track) => !participantTrackIds.has(track.id));
    if (!freshTracks.length) return { ok: true, added: 0, duplicate: tracks.length > 0 };
    for (const track of freshTracks) participantTrackIds.add(track.id);
    participantStreams.push(stream);
    state.connection.participantAudioTracksDiscovered += freshTracks.length;
    rememberParticipantSource(options.label, stream, freshTracks);
    const forwardedToRealtime = freshTracks.reduce(
      (count, track) =>
        count +
        (forwardMeetAudioTrackToRealtime(track, {
          label: options.label || "participant-audio",
          source: "participant-audio-stream",
          streamId: stream.id || "",
        })
          ? 1
          : 0),
      0,
    );
    const addedToPeerConnection = 0;
    recordTimeline("participant_audio_discovered", {
      forwardingEnabled: state.connection.participantAudioForwardingEnabled === true,
      meetAudioForwardingEnabled: state.connection.meetAudioForwardingEnabled === true,
      label: options.label || "participant-audio",
      streamId: stream.id || "",
      trackIds: freshTracks.map((track) => track.id),
      forwardedToRealtime,
      addedToPeerConnection,
      directParticipantAudioDisabled: true,
    });
    updateFeedback();
    return { ok: true, added: freshTracks.length, addedToPeerConnection, forwardedToRealtime };
  } catch (error) {
    rememberError(error);
    return { ok: false, error: String((error && error.message) || error) };
  }
}

function discoverParticipantAudioStreams() {
  if (!shouldRouteGenericMediaElementAudio()) {
    state.connection.participantAudioElementDiscoverySkipped = true;
    if (!state.connection.participantAudioElementDiscoverySkipLogged) {
      state.connection.participantAudioElementDiscoverySkipLogged = true;
      recordTimeline("participant_audio_element_discovery_skipped", {
        reason: "generic_media_element_audio_disabled_on_google_meet",
      });
    }
    updateFeedback();
    return state.connection.participantAudioTracksDiscovered;
  }
  const mediaElements = Array.from(document.querySelectorAll<HTMLMediaElement>("audio, video"));
  for (const element of mediaElements) {
    const provider = element.srcObject;
    if (!provider || !(provider instanceof MediaStream)) continue;
    if (provider.getAudioTracks?.().length) {
      registerParticipantAudioStream(provider, {
        label:
          element.dataset?.meetingAvatarParticipant || element.id || element.tagName.toLowerCase(),
      });
    }
  }
  return state.connection.participantAudioTracksDiscovered;
}

interface ParticipantAudioEventDetail {
  stream?: MediaStream;
  label?: string;
}

function allowParticipantAudioStreamEvents() {
  return allowParticipantAudioStreamInput();
}

function installParticipantAudioDiscovery() {
  window.addEventListener("meeting-avatar-participant-audio-stream", (event: Event) => {
    const detail = (event as CustomEvent<ParticipantAudioEventDetail>).detail || {};
    if (!allowParticipantAudioStreamEvents()) {
      recordTimeline("participant_audio_stream_event_rejected", {
        label: detail.label || "",
        mode: config.mode || "",
        reason: "participant_audio_stream_event_disabled",
      });
      updateFeedback();
      return;
    }
    registerParticipantAudioStream(detail.stream, {
      label: detail.label || "participant-audio-event",
    });
  });
  const run = () => {
    try {
      discoverParticipantAudioStreams();
    } catch (error) {
      rememberError(error);
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
  const installObserver = () => {
    if (!document.documentElement) return;
    const observer = new MutationObserver(run);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) {
    installObserver();
  } else {
    document.addEventListener("DOMContentLoaded", installObserver, { once: true });
  }
  window.setInterval(run, 1500);
}
