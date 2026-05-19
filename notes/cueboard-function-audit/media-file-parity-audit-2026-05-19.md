# Media/File App Mention Parity Audit — 2026-05-19

## Scope

Production regression class: users ask Bridge/Oneesama to inspect Slack media or files, for example "look at the channel videos and organize the useful素材 into a thread". The new Oneesama app_mention path already carried Slack file metadata, but the worker prompt did not make the content boundary explicit enough. That lets a worker sound like it watched a video when only metadata is available.

## Cueboard Source

- `agent-framework/internal/bridge/slack/scanner.go:459-461`
- `agent-framework/internal/bridge/slack/slack_api_tool.go:17-31`
- `agent-framework/internal/bridge/slack/slack_api_tool_fetch.go:179-224`

## New Oneesama Source

- `internal/slackagent/app_mention_context.go:239-245`
- `internal/slackagent/app_mention_context.go:394-438`
- `internal/slackagent/app_mention_media_evidence.go:10-107`
- `internal/slackagent/app_mention_tool_evidence.go:16-21`

## Behavior 1: Preserve Slack File Metadata In Thread Context

- Old does: scanner renders each Slack file as `[file_id:<id>, name: <name>, type: <mimetype>]` in message context (`scanner.go:459-461`).
- New does: app_mention rich context records normalized `Files`, `CanvasFiles`, and `ImageParts`, and renders file lines into transcript context (`app_mention_context.go:239-245`, `394-438`).
- Diff: new context is richer than old for image/canvas classification, but the worker could still miss the operational meaning of "these are only metadata-backed files".
- Decision: keep the richer new context; add explicit first-class file evidence for media/file inspection requests.
- Fixture: `TestAppMentionMediaRequestAddsFileContextEvidence`.

## Behavior 2: Image Fetch Is A Tool, Video/Binary Reading Is Not

- Old does: `slack_api` exposes `slack.fetchImage`, `slack.fetchCanvas`, and `slack.uploadFile` (`slack_api_tool.go:17-31`); `slack.fetchImage` returns "not an image" for non-image files instead of pretending to view them (`slack_api_tool_fetch.go:195-197`).
- New does: app_mention prompt already tells workers that image references can be fetched with `slack.fetchImage`, but video/binary content is not decoded unless another tool result exists.
- Diff: before this patch, media requests only had raw file metadata and no first-class evidence boundary; workers could over-answer from filenames.
- Decision: add `slack_file_context` evidence when the user explicitly asks to inspect/organize media/files. The evidence counts images/videos/canvases/other files, lists metadata, and instructs workers not to claim they watched videos or read binary contents.
- Fixture: `TestAppMentionMediaRequestAddsFileContextEvidence`.

## Behavior 3: Avoid Treating Any File Attachment As A Media Inspection Request

- Old does: file metadata is available as context, but a bot action still depends on the user request/tool decision.
- New does: `collectAppMentionMediaEvidence` only runs when there are files and the mention text asks for media/file inspection. Transcript file markers alone do not trigger it.
- Diff: a naive implementation would have treated every `[file: ...]` transcript line as media intent.
- Decision: detect intent from mention/raw mention text, not generated transcript file metadata.
- Fixture: `TestAppMentionFileMetadataDoesNotAddMediaEvidenceWithoutMediaIntent`.

## Remaining Work

- This patch is a bounded parity/safety improvement, not full video understanding.
- True video/PDF/binary inspection should be handled through a delegated agent/tool path with explicit evidence, not by Go pretending to decode media.
- The media intent keyword list is still a Class 2 routing heuristic in Go; externalize it with the other triage intent keyword templates during the #199 polish pass.
