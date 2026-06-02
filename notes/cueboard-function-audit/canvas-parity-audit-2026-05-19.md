# Canvas Read/Write/Reuse Parity Audit — 2026-05-19

## Scope

- Cueboard source: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/slack_api_tool_canvas.go`
- Cueboard registry: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/slack_api_tool.go`
- New Oneesama: `internal/slackagent/slack_canvas_fetch.go`, `internal/slackagent/slack_canvas_mutation.go`, `internal/slackagent/service_pending_canvas.go`, `internal/slackagent/service_worker_jobs.go`, `internal/slackagent/slack_thread_fetch.go`

This audit was triggered by Peng's migration rule on 2026-05-19: do not re-derive migrated behavior from memory or product intent; inspect the old implementation first, then port or explicitly justify any divergence.

## Summary

| Behavior               | Old Cueboard Agent D                                                                                     | New Oneesama after this audit                                                                                                                                           | Decision                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Read Canvas            | `slack_api/fetch_canvas` downloads Canvas HTML and returns Markdown.                                     | `slack.fetch_canvas` is active, fetches via `files.info`, converts HTML to Markdown, and enforces prompt-size caps.                                                     | Keep new implementation; stronger bounded read path. |
| Create Canvas          | `slack_api/create_canvas` directly calls `canvases.create` with `title`, `markdown`, optional `channel`. | Direct `slack_api(create_canvas)` is now active and calls `canvases.create`; suggest_action confirmation remains available.                                             | Port direct tool parity.                             |
| Edit Canvas            | `slack_api/edit_canvas` directly calls `canvases.edit`, defaulting `operation=insert_at_end`.            | Direct `slack_api(edit_canvas)` is now active; pending-action edit path still requires human confirmation.                                                              | Port direct tool parity.                             |
| Reuse existing Canvas  | Old assistant could fetch/edit an existing Canvas by `canvas_id`.                                        | App-mention context hydrates linked Slack threads and Canvas file IDs; worker Canvas publish now edits the first linked Canvas instead of always creating a new Canvas. | Fix drift; keep explicit ID-based reuse.             |
| Meeting summary Canvas | Old meet publish creates Canvas and posts a Slack link.                                                  | New CanvasPublisher creates/edits Slack Canvas, retries sanitized Markdown on validation errors, and posts thread notifications.                                        | Keep new implementation; stricter fallback.          |

## Behavior 1: Fetch Canvas Content

- Old does: `actionFetchCanvas` requires `canvas_id`, then calls `downloadCanvasContent` and returns trimmed Markdown (`slack_api_tool_canvas.go:40-62`). The old download path first tries the team-specific `files-pri/{teamID}-{canvasID}/download/canvas` URL and falls back to `files.info` `URLPrivateDownload` (`slack_api_tool_canvas.go:89-110`).
- New does: `actionFetchCanvas` accepts `file_id` / `canvas_id` aliases, calls `files.info`, verifies the file is a Canvas, downloads a private URL, converts HTML to Markdown, and caps the result (`slack_canvas_fetch.go:60-124`).
- Diff:
  - New path is stricter about file type.
  - New path is bounded by `defaultCanvasMarkdownSizeLimit` and `defaultCanvasHTMLFetchLimit`; old path returned full content.
  - New path returns JSON with metadata; old path returned raw text.
- Decision: keep new behavior. The metadata and caps are useful safety improvements, and the assistant can still read the Markdown body.
- Fixtures: `TestActionFetchCanvasReturnsMarkdownSnippet`, `TestActionFetchCanvasRejectsNonCanvasFile`, `TestActionFetchCanvasTruncatesOversizedMarkdown`.

## Behavior 2: Create Canvas

- Old does: `actionCreateCanvas` requires `title` and `markdown`, accepts optional `channel`, then calls `bridge.createCanvas` and returns the Canvas ID (`slack_api_tool_canvas.go:17-38`). The action is first-class in old `assistantAllowedSlackActions` (`slack_api_tool.go:73-85`).
- Previous new state: `slack_api(create_canvas)` was `registered_unavailable`; only `suggest_action(create_canvas)` could create after a human confirmed the card.
- New does now: `slack_api(create_canvas)` dispatches to `actionCreateCanvas`, calls Slack `canvases.create`, retries once with sanitized Markdown on validation-class errors, and returns JSON with `canvas_id`, `team_id`, `permalink`, `error`, and `detail` (`slack_api_tool_messages.go:77-80`, `slack_canvas_mutation.go:9-34`, `slack_canvas_mutation.go:73-86`).
- Diff:
  - New direct tool returns JSON rather than old plain text.
  - New direct tool supports sanitize-and-retry; old did not.
  - New suggest_action confirmation flow remains available as an additional safer route.
- Decision: port direct tool parity. The prior `registered_unavailable` status was a re-derived guardrail, not a port of old Agent D behavior.
- Fixtures: `TestSlackAPIToolCreateCanvasCallsSlackAPI`, `TestSlackAPIToolCreateCanvasRetriesWithSanitizedMarkdown`, `TestSlackAPIMethodParityBucketsRegisteredUnavailable`.

## Behavior 3: Edit Canvas

- Old does: `actionEditCanvas` requires `canvas_id` and `markdown`, defaults empty `operation` to `insert_at_end`, preserves optional `section_id`, and posts `canvases.edit` with a single Markdown change (`slack_api_tool_canvas.go:64-87`, `slack_api_tool_canvas.go:113-158`). The action is first-class in old `assistantAllowedSlackActions` (`slack_api_tool.go:73-85`).
- Previous new state: `slack_api(edit_canvas)` was `registered_unavailable`; only `suggest_action(edit_canvas)` could edit after confirmation and required explicit `file_id`.
- New does now: `slack_api(edit_canvas)` dispatches to `actionEditCanvas`, accepts `canvas_id` / `file_id` aliases, defaults `operation=insert_at_end`, passes optional `section_id`, retries sanitized Markdown on validation-class errors, and returns JSON (`slack_api_tool_messages.go:77-80`, `slack_canvas_mutation.go:36-71`, `slack_canvas_mutation.go:88-101`).
- Diff:
  - New direct path accepts both `operation` and `op`; old only used `operation`.
  - New direct path accepts `file_id` alias because Slack Canvas IDs are file IDs in the new app-mention context.
  - New direct path returns JSON rather than old plain text.
- Decision: port direct edit parity with harmless aliases.
- Fixtures: `TestSlackAPIToolEditCanvasCallsSlackAPI`, `TestSlackAPIMethodParityBucketsRegisteredUnavailable`.

## Behavior 4: Reuse An Existing Canvas From A Linked Thread

- Old does: the assistant could combine `fetch_canvas` + `edit_canvas(canvas_id=...)` directly because both were first-class Slack API actions.
- Previous new state: linked Slack thread hydration exposed Canvas file metadata, but final app-mention worker publication created a new Canvas even when `CanvasFiles` contained an existing Canvas. The notification text said "updated" while the input had no `CanvasID`.
- New does now:
  - `fetchLinkedSlackThreadContexts` fetches linked threads, extracts Canvas files, and merges them into `SlackAppMentionContext.CanvasFiles` (`slack_thread_fetch.go:32-46`, `slack_thread_fetch.go:179-212`).
  - `workerResultCanvasInput` now sets `CanvasID` to the first linked Canvas file and `Operation=insert_at_end`, so a "write this into the Canvas" result edits/reuses the existing Canvas instead of creating a duplicate (`service_worker_jobs.go:131-149`).
- Diff:
  - Old reuse was an explicit assistant tool call; new worker auto-reuse happens for final app-mention results with Canvas context.
  - The explicit path is also available now because direct `edit_canvas` parity is restored.
- Decision: fix auto-reuse drift and keep direct edit as the precise old-parity route.
- Fixtures: `TestWorkerResultCanvasInputReusesExistingCanvasFile`.

## Behavior 5: Meeting Summary Canvas

- Old does: meeting publish created a Canvas and sent a Slack link to the meeting thread.
- New does: `CanvasPublisher` creates or edits a Slack Canvas, retries with sanitized Markdown on validation-class errors, records a manifest, and posts an anchoring thread notification (`canvas_publisher.go:220-292`).
- Diff:
  - New path has retry and manifest/audit metadata.
  - New path uses the shared CanvasPublisher rather than the old bridge client wrapper.
- Decision: keep new implementation. It preserves the product behavior while adding validation fallback and auditability.
- Fixtures: `TestCanvasPublisherCreatesSlackCanvas`, `TestCanvasPublisherForcedSlackCanvasPostsThreadNotification`, `TestPublishSlackCanvasRetriesWithSanitizedMarkdownOnValidationError`.

## Open Follow-Ups

1. Externalize Canvas intent routing keywords in `slackWorkerJobRequestsCanvas` (`"canvas"` / `"画布"`) with the other Class 2 routing keywords.
2. Add an app-mention entry-level fixture that links to a Slack thread containing an existing Canvas, asks "写 Canvas 里", and asserts the worker output routes to `canvases.edit` rather than `canvases.create`.
3. Re-run the old-Agent-D comparison harness for one real Canvas thread after deploy: old behavior and new behavior should both be able to read the linked Canvas and update/reuse it with a cited response.
