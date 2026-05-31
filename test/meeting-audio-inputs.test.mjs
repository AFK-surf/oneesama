import assert from "node:assert/strict";
import test from "node:test";

import {
  createMeetingAudioInputs,
  isGoogleMeetUrlForRealtimeAudio,
  shouldUseRecappiRealtimeAudioInput,
} from "../packages/core/src/meeting/meeting-audio-inputs.ts";

test("Recappi realtime input is allowed for a real Google Meet URL", () => {
  assert.equal(isGoogleMeetUrlForRealtimeAudio("https://meet.google.com/oyw-ixnm-nog"), true);
  assert.equal(
    shouldUseRecappiRealtimeAudioInput({
      platform: "darwin",
      meetUrl: "https://meet.google.com/oyw-ixnm-nog",
      realtimeWantsMeetAudio: true,
      recorderBackend: "recappi",
      recappiTapAvailable: true,
    }),
    true,
  );
});

test("Recappi realtime input stays off for non-Google fixtures", () => {
  assert.equal(isGoogleMeetUrlForRealtimeAudio("http://127.0.0.1:4173/fixture"), false);
  assert.equal(
    shouldUseRecappiRealtimeAudioInput({
      platform: "darwin",
      meetUrl: "http://127.0.0.1:4173/fixture",
      realtimeWantsMeetAudio: true,
      recorderBackend: "recappi",
      recappiTapAvailable: true,
    }),
    false,
  );
});

test("permissive runner mode still uses Recappi realtime input for real Meet URLs", () => {
  const result = createMeetingAudioInputs({
    input: {
      allowNonGoogleMeet: true,
      includeParticipantAudio: true,
      forwardMeetAudioToRealtime: true,
      meetAudioBackend: "recappi",
    },
    config: { meetAudioBackend: "recappi" },
    sessionId: "session_test",
    artifactsDir: "/tmp/session_test",
    meetUrl: "https://meet.google.com/oyw-ixnm-nog",
    installRealtimeBridge: true,
    recordMeeting: true,
  });

  if (process.platform === "darwin") {
    assert.ok(result.realtimeRecappiAudioInput, "real Google Meet joins should get Recappi input");
    assert.equal(result.realtimeAudioCapture, null);
  } else {
    assert.equal(result.realtimeRecappiAudioInput, null);
  }
});

test("permissive fixture mode keeps Recappi realtime input disabled off Google Meet", () => {
  const result = createMeetingAudioInputs({
    input: {
      allowNonGoogleMeet: true,
      includeParticipantAudio: true,
      forwardMeetAudioToRealtime: true,
      meetAudioBackend: "recappi",
    },
    config: { meetAudioBackend: "recappi" },
    sessionId: "session_fixture",
    artifactsDir: "/tmp/session_fixture",
    meetUrl: "http://127.0.0.1:4173/fixture",
    installRealtimeBridge: true,
    recordMeeting: true,
  });

  assert.equal(result.realtimeRecappiAudioInput, null);
  assert.ok(result.realtimeAudioCapture, "fixtures should keep the browser WebRTC capture path");
});

test("Google Meet realtime audio never falls back to browser WebRTC capture", () => {
  const result = createMeetingAudioInputs({
    input: {
      includeParticipantAudio: true,
      forwardMeetAudioToRealtime: true,
      meetAudioBackend: "none",
    },
    config: { meetAudioBackend: "none" },
    sessionId: "session_google_no_recappi",
    artifactsDir: "/tmp/session_google_no_recappi",
    meetUrl: "https://meet.google.com/oyw-ixnm-nog",
    installRealtimeBridge: true,
    recordMeeting: true,
  });

  assert.equal(result.realtimeRecappiAudioInput, null);
  assert.equal(result.realtimeAudioCapture, null);
});
