# Video Avatar State Matrix

This matrix turns the video-avatar kickoff decision into an implementation and
asset checklist. It intentionally keeps v1 small: replace the Live2D visual
identity with video, but do not create a full cinematic state library yet.

Source of decision: `notes/avatar-state-machine-kickoff.md`.

## Locked Decisions

1. **Renderer direction**: use a video avatar as the on-camera identity.
2. **Lip-sync direction**: "insensitive" lip-sync only. Do not attempt phoneme
   sync, precise mouth retiming, or a Live2D/canvas mouth overlay in v1.
3. **State count**: v1 has only two video states: `idle` and `speaking`.
4. **Progress/status states**: `tool-running`, `done`, `blocked`, and `error`
   stay in the existing HUD/status layer, not separate video clips.
5. **Identity**: use Peng's provided photorealistic portrait reference. Keep
   face, hair, glasses, blazer, shirt, and pearl necklace consistent across
   generated clips.

## Runtime Contract

The video renderer maps the existing avatar state surface into a coarse visual
switch:

| Runtime signal            | Video state                   | HUD/status behavior                                             |
| ------------------------- | ----------------------------- | --------------------------------------------------------------- |
| Bot output audio inactive | `idle`                        | HUD hidden when healthy                                         |
| Bot output audio active   | `speaking`                    | HUD hidden unless status/error exists                           |
| User speaking/listening   | `idle`                        | Optional listening status may be visual-only, not a video state |
| Model thinking            | `idle`                        | Optional thinking status may be visual-only, not a video state  |
| App-control/CU running    | `idle` unless bot is speaking | Existing tool HUD shows progress                                |
| Tool done                 | `idle` unless bot is speaking | Existing done HUD shows completion briefly                      |
| Tool blocked/error        | `idle` unless bot is speaking | Existing blocked/error HUD shows concise blocker                |

Priority rule: `speaking` wins whenever bot output audio is active. Otherwise
use `idle` and let the HUD communicate non-speaking state.

## State Matrix

| State      | Purpose                                                                                                                  | Video asset                        | Enter                                                                          | Exit                                    | Acceptance                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `idle`     | Default attentive avatar; also covers listening, thinking, tool-running, done, and blocked while the bot is not speaking | `oneesama-video-idle-loop.mp4`     | Meeting camera starts; bot output audio inactive; fallback after speaking ends | Bot output audio becomes active         | Looks alive but calm; can hold for minutes; no mouth motion that reads as speaking         |
| `speaking` | Generic low-amplitude talking visual while Realtime audio is routed to Meet                                              | `oneesama-video-speaking-loop.mp4` | First reliable bot output-audio activity                                       | Output audio stops and debounce expires | Mouth movement is low-amplitude and generic; mismatch is not jarring; no video audio plays |

## Asset Requirements

| Requirement      | `idle`                                                                      | `speaking`                                                                      |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Duration         | 5-8s seamless loop                                                          | 5-8s seamless loop                                                              |
| First/last frame | Nearly identical for clean looping                                          | Nearly identical for clean looping                                              |
| Motion           | Blink, subtle breathing, tiny head/shoulder movement, occasional soft smile | Generic low-amplitude talking mouth, light head movement, restrained expression |
| Mouth emphasis   | Closed or barely moving                                                     | Small motion; do not exaggerate lips                                            |
| Audio            | Muted source file                                                           | Muted source file                                                               |
| Format           | MP4/H.264 or browser-safe equivalent                                        | MP4/H.264 or browser-safe equivalent                                            |
| Canvas target    | 16:9, 1280x720 minimum                                                      | 16:9, 1280x720 minimum                                                          |
| Fallback         | Static reference frame or fallback canvas                                   | Crossfade to idle/static frame if missing                                       |

## Seedance / Generation Brief

Use the same portrait reference and same identity prompt for both clips.

### Shared Identity Prompt

Photorealistic on-camera female meeting avatar, black hair with bangs,
black-framed glasses, navy blazer, white shirt, pearl necklace, warm intelligent
presence, clean studio lighting, simple meeting-friendly background, centered
chest-up framing, no subtitles, no text, no logos, no extra people.

### `idle` Motion Prompt

Neutral warm smile, gentle breathing, natural blinking, very small head and
shoulder movement, attentive but not talking. First and last frames should match
closely for a seamless loop.

### `speaking` Motion Prompt

Same identity and framing. Low-amplitude generic talking mouth movement, subtle
head motion, friendly expression. The mouth should not be exaggerated and should
not look like precise lip-sync. First and last frames should match closely for a
seamless loop.

## Implementation Requirements

- Add a `video` avatar renderer preset instead of creating a separate meeting
  mode.
- The source video must stay muted; Realtime output audio remains the only voice
  sent to Meet.
- Switch `idle` -> `speaking` from bot output-audio activity, not from text
  tokens or response-created events alone.
- Switch `speaking` -> `idle` only after output audio stops plus a short debounce
  to avoid flicker between audio chunks.
- Crossfade video state changes; never show a black frame.
- Keep the existing HUD/status overlay on top of the video. Do not bake HUD text
  into the video.
- Missing video assets must degrade to static reference/fallback canvas without
  crashing the Meet camera track.

## Playground Acceptance

The standalone playground is the first validation surface.

| Check                 | Pass condition                                                          |
| --------------------- | ----------------------------------------------------------------------- |
| Preset                | A video avatar preset appears beside current Live2D/fallback presets    |
| Manual state switch   | Operator can switch between `idle` and `speaking`                       |
| Audio gate simulation | Fake output-audio activity flips to `speaking`; stop returns to `idle`  |
| HUD coexistence       | Tool/done/blocked HUD remains readable over both clips                  |
| Fallback              | Missing video file falls back without breaking the canvas/camera stream |

## Live Meet Acceptance

Run after playground acceptance.

| Scenario                           | Expected result                                                        |
| ---------------------------------- | ---------------------------------------------------------------------- |
| Bot joins empty room               | Idle video appears as Meet camera                                      |
| Human speaks                       | Avatar remains idle/listening visually; it does not switch to speaking |
| Bot speaks                         | Speaking loop starts with audible Realtime output                      |
| Bot stops speaking                 | Avatar returns to idle after debounce                                  |
| CU/app-control runs                | HUD shows progress while video remains idle unless bot is speaking     |
| CU/app-control completes or blocks | HUD shows done/blocked briefly; no separate completion video required  |

## Non-Goals For V1

- No phoneme-level lip-sync.
- No audio-driven mouth mesh/canvas overlay.
- No separate video clips for listening/thinking/tool/done/blocked.
- No transition clip library.
- No baked subtitles, status text, or UI in the video asset.

## Definition Of Done

- Peng accepts this matrix as the video-avatar v1 source of truth.
- `idle` and `speaking` clips exist locally and match the identity reference.
- Video preset loads in the avatar playground.
- Playground smoke covers video preset selection, audio-active switching, HUD
  coexistence, and fallback.
- One real Meet run proves idle/speaking switching does not disrupt Realtime
  audio, Meet camera output, or CU/HUD behavior.
