# Media Self-Limitation Parity Audit · 2026-05-21

## Trigger

Peng reported a live Oneesama triage reply in `C09KVPBMLJ3`:

> 能简单描述一下 timeout 的具体情况吗？我看不了视频文件。

The message was a Slack video upload (`timeout.mov`) in a thread about staging conversation-loading slowness.

## Read-Old-First Chain

Old Cueboard/slackd archive evidence:

- Archive: `/Users/pengx17/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/workspace/memory/triage-archive/2026-04-30.json`
- Around line 13259, old slackd handled a video-only demo share:
  - input: `CatsJuice: "这够不够节目效果？"` with `Area.mp4`
  - cognition: fetched thread context, searched Memory/person profile
  - visible side-effect: added `:smart:` reaction
  - private reasoning explicitly avoided pretending it watched the video
- The old path did not post a visible "I cannot watch this video" reply. It either used metadata/context to add a lightweight reaction or stayed silent.

Old behavior contract:

1. Video metadata alone is valid evidence for lightweight triage decisions.
2. If the content cannot be read, that limitation is internal reasoning, not user-facing Slack text.
3. A reaction is acceptable when it adds lightweight acknowledgement without claiming video contents.
4. If no useful context exists, stay silent.

## New Failure

New Oneesama Pi-first foreground received metadata-only video context and chose `decision=reply` with visible self-limitation text. That violates the old visible-output contract and repeats the `lying-closed / fallback-text` family of regressions: exposing internal inability as if it helped the user.

## Fix

- Prompt-level guard: Oneesama Pi must not post visible self-limitations such as "I can't view this video/file/image" or "我看不了视频/文件/图片".
- Normalization guard: if Pi still returns a self-limiting media reply, Go removes visible text. If a valid reaction intent exists and reactions are allowed, downgrade to `react`; otherwise downgrade to `stay_silent`.
- Worker media prompt: delegated workers with non-image Slack media are told to return no visible result rather than saying they cannot view media.
- Media evidence guidance: metadata summaries may be used only when useful; content-reading blockers must not become the main visible reply.

## Regression Coverage

- `TestNormalizeOneesamaPIResponseRequiresDecisionPayloads`
  - Chinese video limitation reply -> `stay_silent`
  - English video limitation reply -> `stay_silent`
  - video limitation reply + valid reaction -> `react`
- `TestPersonaDelegatedWorkerSlackContextForVideoForbidsVisibleSelfLimitation`
  - video delegate context includes non-image media rule and `return no visible result` contract.

