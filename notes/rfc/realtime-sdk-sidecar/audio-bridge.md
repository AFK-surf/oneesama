# Realtime SDK Sidecar Audio Bridge

Parent RFC:
[Realtime SDK Sidecar for Google Meet](../realtime-sdk-sidecar-rfc-2026-06-01.md)

This file isolates the audio migration because it is the riskiest part of the
sidecar architecture. Control-plane sidecar can pass before voice output is
fully moved; real-room acceptance must wait for this file's live evidence gates.

## Current Evidence

- Recappi process audio tap has real input energy in the live sample.
- Receiver/WebRTC track side recording was effectively digital silence in the
  captured run.
- Therefore this RFC does not promote receiver/WebRTC track capture to the live
  Realtime input source.
- Google Meet captions proving a human spoke is not sufficient evidence for the
  Realtime SDK turn path.

## Input Audio Policy

- Recappi remains the live Realtime input source unless a separate RFC or
  investigation proves a replacement.
- Receiver/WebRTC track capture may remain diagnostic-only.
- Input evidence must distinguish:
  - audio energy exists;
  - SDK formed a user turn;
  - model emitted a tool call in that turn.

## Output Audio Contract

Sidecar to Meet page:

- Realtime response audio frames converted to small PCM chunks;
- output track/energy diagnostics;
- end-of-utterance markers for lip-sync and route health.

Meet page:

- adds an explicit `MAB_AVATAR_AUDIO_BUS.enqueuePcmFrames(...)`-style API;
- routes PCM into the existing avatar audio bus;
- publishes the bus track into Meet through the existing fake mic sender;
- never creates an audible local speaker sink for Realtime output.

This avoids trying to transfer `MediaStreamTrack` objects across isolated pages.
The sidecar may still decode the SDK remote audio track internally, but the
cross-page contract is PCM frames plus metadata, not browser track identity.

## Phase Todo

- [x] Push Recappi process-tap chunks to the sidecar input audio port.
- [x] Preserve Recappi chunk timing, sample rate, and energy diagnostics.
- [x] Keep receiver/WebRTC track recording diagnostic-only.
- [x] Remove the legacy Recappi receiver fallback runtime state from bridge
      diagnostics.
- [x] Add sidecar output audio tap from SDK remote audio to PCM chunks.
- [x] Add an explicit Meet-page avatar audio bus PCM enqueue API.
- [x] Forward sidecar PCM chunks into the Meet avatar audio bus.
- [x] Verify avatar output energy after a model speech response.
- [x] Verify fixture/avatar fake-mic sender remains live while sidecar output
      is routed.
- [ ] Capture fresh real-room primary Meet fake-mic sender stats showing the
      avatar-bus sender is live and sending bytes in the same artifact.
- [x] Assert no Realtime local speaker sink is used in Meet sessions.

Implementation note, 2026-06-01: the first PCM bridge is wired in code and
covered by targeted unit/source tests. Fixture evidence pushes simulated
model-speech PCM through the sidecar output port into the Meet avatar audio bus
and observes output energy plus a live fake-mic track. Real-room session
`session_904489e8` then showed sidecar output PCM routed to the Meet avatar
audio bus, avatar output energy observed, and `localSpeakerSink: false`.
Because the same session exposed a separate app-control prompt-bloat timeout,
live-room reliability still needs one fresh combined acceptance rerun that
captures primary Meet fake-mic sender deltas and the post-hardening compact
app-control result before closing the parent RFC as accepted.

## Audio Acceptance

- [x] Recappi remains the live Realtime input source unless a separate RFC or
      investigation proves a replacement.
- [x] Receiver/WebRTC track capture is diagnostic-only and cannot be promoted to
      input source by this RFC.
- [x] Realtime output audio from the sidecar reaches the Meet page avatar audio
      bus through the output audio port.
- [x] Avatar output energy is observed after a model speech response.
- [x] Fixture/avatar fake-mic sender stays live while sidecar output audio is
      routed.
- [ ] Fresh real-room evidence records primary Meet fake-mic sender stats while
      sidecar output audio is routed.
- [x] No Realtime local speaker sink is used in the Meet session.

## Known Risks

- The output audio bridge is the only non-trivial media migration.
- Browser pages cannot safely share `MediaStreamTrack` identity as the primary
  contract, so the design uses PCM chunks into the existing Meet avatar audio
  bus.
- PCM bridging may add latency. The acceptance target should be "natural enough
  for live meeting response" rather than sample-perfect output.
- Real-room voice/output energy evidence now exists, but fresh real-room
  primary fake-mic sender stats and the post-hardening app-control gate still
  need to pass before the parent RFC can be accepted.
