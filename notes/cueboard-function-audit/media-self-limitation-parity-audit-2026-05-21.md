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
5. When the answer actually depends on file contents, Oneesama should delegate file reading to a worker/tool path rather than treating non-image media as inherently unreadable. Images use `slack.fetchImage`; other Slack files use `slack.fetchFile`.

## New Failure

New Oneesama Pi-first foreground received metadata-only video context and chose `decision=reply` with visible self-limitation text. That violates the old visible-output contract and repeats the `lying-closed / fallback-text` family of regressions: exposing internal inability as if it helped the user.

## Fix

- Prompt-level guard: Oneesama Pi must not post visible self-limitations such as "I can't view this video/file/image" or "我看不了视频/文件/图片".
- Normalization guard: if Pi still returns a self-limiting media reply, Go removes visible text. If a valid reaction intent exists and reactions are allowed, downgrade to `react`; otherwise downgrade to `stay_silent`.
- Slack file reader: added `slack.fetchFile`, a generic Slack file fetch tool. It uses `files.info`, downloads the protected Slack file with the bot token into a workspace-scoped local artifact, optionally inlines small files, and returns `local_path` / type / size metadata for worker-side readers.
- Worker media prompt: delegated workers with non-image Slack media are told to call `slack.fetchFile` before answering when the answer depends on video/audio/PDF/archive/document contents. If the file cannot be fetched or remains insufficient, they return no visible result rather than saying they cannot view media.
- Tool bridge + memory: worker `slack_api` bridge allows `slack.fetchFile`, and multimodal memory candidates treat `fetch_file` reader evidence as relevant.
- Media evidence guidance: metadata summaries may be used only when useful; content-reading blockers must not become the main visible reply.

## Regression Coverage

- `TestNormalizeOneesamaPIResponseRequiresDecisionPayloads`
  - Chinese video limitation reply -> `stay_silent`
  - English video limitation reply -> `stay_silent`
  - video limitation reply + valid reaction -> `react`
- `TestActionFetchFileDownloadsNonImageToWorkspaceArtifact`
  - non-image Slack file downloads to a workspace `.tmp/slack-file-fetch` artifact and preserves protected auth.
- `TestActionFetchFileCanInlineSmallFileWhenExplicitlyRequested`
  - small files can be inlined for worker readers when explicitly requested.
- `TestActionFetchFileRejectsOverCapDownload`
  - over-cap downloads fail closed instead of exhausting the Slack agent.
- `TestPersonaDelegatedWorkerSlackContextForVideoCarriesFileReader`
  - video delegate context includes `slack.fetchFile`, file id, `local_path`, and no-visible-result fallback.
- `TestSlackWorkerToolBridgeAllowsFetchFile`
  - worker tool bridge permits the new reader method.
- `TestMultimodalMemoryCandidateKeepsFetchFileEvidence`
  - fetch-file reader evidence is preserved in multimodal Memory candidates.
