# Avatar State Machine — Kickoff Spec (video avatar)

Source: #meeting-avatar:979028ba, Peng decisions 2026-05-29 17:17. This is the one-page kickoff spec for the video-avatar renderer. Dev (@劲霸仁波切) picks up renderer integration + asset wiring after #413 (CU contract) closes; this spec defines the target so it's "照单开干".

## Decisions (Peng)
1. **Lip-sync**: precise video lip-sync is too hard → do only an "insensitive" version. No phoneme sync, no canvas/Live2D mouth overlay (too complex).
2. **Cut states**: reduce to the minimum.
3. **Identity locked**: use Peng's provided photorealistic portrait (black hair + bangs, black-framed glasses, navy blazer + white shirt + pearl necklace). Ref attachment id `60225807-0199-4aa8-b45b-835b66b11e10`. No style pivot.

## Identity / style
- Single ref image, photorealistic. Every Seedance clip generated from this one ref.
- Cross-clip consistency: same ref + same prompt template + human eyeball check per batch.

## Lip-sync strategy (insensitive)
- `speaking` clip = generic, low-amplitude "talking" mouth loop, **not aligned to audio**.
- `idle` ↔ `speaking` switched by bot-audio presence only — a **coarse on/off gate** (reuse the retained avatar audio bus amplitude; it only decides "talking or not", it does NOT drive mouth shapes).
- Photorealistic face + low mouth amplitude + mouth not emphasized → audio mismatch is not jarring. This is the whole point of "insensitive".

## State matrix (2 video states + HUD)
| State | First frame | Loop (5-8s seamless) | Enter | Transition |
|---|---|---|---|---|
| **idle** | ref, neutral smile | blink + gentle breath/head motion, occasional smile; **merges listening/thinking** (to a human it's just an attentive face) | default / bot not speaking | audio start → speaking (~200ms crossfade) |
| **speaking** | ref, mouth slightly open | low-amplitude generic talking mouth + light head motion, NOT audio-synced | bot audio active | audio stop → idle (crossfade) |

- `done` / `error` / `blocked` / `tool-running`: **no video state**, use HUD badge (existing).
- Priority: `speaking` > `idle`.
- Optional 3rd state `thinking` (brief considering beat, eyes up / slight head tilt): **not in v1**; add later only if 2-state feels lifeless.

## Seedance clip acceptance criteria
1. Character consistency vs the single ref (eyeball check per batch)
2. Mouth low-amplitude (no precise sync needed — that is the goal)
3. First frame ≈ last frame for seamless loop
4. 5-8s duration
5. Uniform fps / format / resolution
6. Load-failure fallback → static ref frame

## Work split
- **Me (@喵喵)**: this spec.
- **Dev (@劲霸仁波切)**: generate idle + speaking Seedance clips from the ref (speaking = 1 clip first; add variants only if it looks monotonous); renderer switches idle↔speaking on audio-active with crossfade; done/error/tool stay on HUD.
- Sequence: dev is on #413 (CU) first; video-avatar picks up after. Spec is ready so dev can implement directly.
