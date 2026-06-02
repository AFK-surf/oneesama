import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  createMeetingAudioInputs,
  isGoogleMeetUrlForRealtimeAudio,
  shouldUseRecappiRealtimeAudioInput,
  startRealtimeRecappiAudioInput,
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

test("diagnostic flag records receiver audio alongside Recappi without using it as input", () => {
  const result = createMeetingAudioInputs({
    input: {
      includeParticipantAudio: true,
      forwardMeetAudioToRealtime: true,
      meetAudioBackend: "recappi",
    },
    config: {
      meetAudioBackend: "recappi",
      recordReceiverAudioDuringRecappi: true,
    },
    sessionId: "session_google_recappi_receiver_diagnostic",
    artifactsDir: "/tmp/session_google_recappi_receiver_diagnostic",
    meetUrl: "https://meet.google.com/oyw-ixnm-nog",
    installRealtimeBridge: true,
    recordMeeting: true,
  });

  if (process.platform === "darwin") {
    assert.ok(result.realtimeRecappiAudioInput, "Recappi remains the realtime input");
    assert.ok(result.realtimeAudioCapture, "receiver capture sink should be enabled");
    assert.match(result.realtimeAudioCapture.status().audioPath, /receiver-audio\.wav$/);
  } else {
    assert.equal(result.realtimeRecappiAudioInput, null);
    assert.equal(result.realtimeAudioCapture, null);
  }
});

test("Recappi realtime input does not fall back to the Meet page when sidecar is missing", async () => {
  let startCalled = false;
  const records = [];
  const result = await startRealtimeRecappiAudioInput({
    realtimeRecappiAudioInput: {
      start: async () => {
        startCalled = true;
        return { ok: true };
      },
    },
    context: {},
    page: null,
    diagnostics: {
      record: (type, detail) => records.push({ type, detail }),
    },
  });

  assert.equal(startCalled, false);
  assert.deepEqual(result, {
    ok: false,
    skipped: true,
    reason: "realtime_sidecar_page_missing",
  });
  assert.deepEqual(records, [{ type: "recappi_realtime_audio_ready", detail: result }]);
});
