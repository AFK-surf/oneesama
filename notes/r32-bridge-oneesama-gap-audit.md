# R32 Bridge vs Oneesama Conversation Gap Audit

Source permalink: Slack channel `C0AQ0C0KVMH`, thread `1778772007.043069`.

## Thread Evidence

| Time | Sender | Behavior |
|---|---|---|
| `1778772007.043069` | User -> old bridge | Asked for a prose doc about the Slack bot team architecture. |
| `1778772238.870629` / `.876449` | old `bridge_bot` | Created a Slack Canvas, posted a concise summary and feedback footer. Also sent a short "I'll write this into a canvas" acknowledgement. |
| `1778772507.700179` | new `imoutochan` | Posted a long inline article in-thread, including implementation/user-facing terms like `work "<task>"` and repo-specific internals. No Canvas link. |
| `1778772561.193459` | old `bridge_bot` | Noticed later user additions, created a new Canvas version, summarized exactly what was merged. |
| `1778774199.812719` / `1778774226.500879` / `.507009` / `1778774239.597339` | old `bridge_bot` | Continued to track follow-up additions and update the Canvas. |
| `1778774202.716529` | new `imoutochan` | Misrouted the task as a Go rewrite worker issue, saying thread context fetch failed with `slackAppMention.fetchOk=false` / `invalid_arguments`. |

## Missing Or Regressed Behavior

| Gap | Old bridge behavior | New oneesama behavior | Action |
|---|---|---|---|
| Thread context fetch | Reads full thread context before answering follow-ups like "看看补充的信息". | `conversations.replies` call failed with `invalid_arguments`, so worker only saw the latest mention. | Fixed in this slice: use Slack-compatible query params for `conversations.replies` instead of JSON POST. |
| General writing Canvas flow | Creates Slack Canvas for long drafting tasks and posts concise Canvas links. | Long writing answer is posted inline; general assistant path does not decide "this belongs in Canvas." | Follow-up: route long drafting/summarization outputs through `CanvasPublisher` / Slack Canvas. |
| Canvas revision flow | When Slack assistant session cannot edit the old Canvas, old bridge creates a new version and explains the delta. | No equivalent revision/update flow for non-meeting docs. | Follow-up with general Canvas versioning behavior. |
| Workspace assistant persona | Answers as a general Slack teammate, using thread/user context. | Worker identified itself as `oneesama-go-rewrite` and treated writing as out-of-project. | Follow-up: separate workspace-assistant prompt/context from repo-worker prompt. |
| Natural follow-up handling | Understands "看到我后面补充了吗" / "看看补充的信息" as "merge the later thread messages." | Misclassified the latest supplement as unrelated commentary once fetch failed. | Mostly unblocked by fetch fix; add regression covering follow-up merge intent. |
| Feedback footer | Old bridge appends `Cueboard Agent | <hash>` feedback overflow. | New replies lack a comparable feedback footer on natural assistant replies. | Optional follow-up if feedback collection is still desired. |
| Concise progress style | Old bridge sends short ack + final Canvas summary, not a giant in-thread draft. | New reply dumps a full article into the thread. | Follow-up tied to Canvas routing and response length policy. |

## Additional Audit From Raw Slack Blocks

Raw Slack evidence shows an important rendering/process gap:

- Old `bridge_bot` messages are `section` Block Kit blocks with `text.type=mrkdwn`.
- New `imoutochan` worker and triage messages are plain `text` posts that Slack stores as `rich_text`.
- In the long imoutochan draft, Slack preserved literal Markdown such as `##`, `###`, `**bold**`, Markdown tables, `---`, and partial code fences. That is why the rendered result looks completely different.

This is not because the Go repo has no Markdown renderer. It has `markdownToBlocks`, `markdownToMrkdwn`, and `buildSlackThreadReplyBlocks`, and parity tests exist. The renderer is not wired into the relevant posting paths:

- `postSlackWorkerResult` posts worker completion with `PostMessageInput{Text: text}` and no `Blocks`.
- `executeSlackTriageDirectActions` posts direct triage replies with `PostMessageInput{Text: action.Message}` and no `Blocks`.
- `buildSlackThreadReplyBlocks` is currently tested but not used by the generic worker/triage final delivery paths.

Also, the old bridge's visible thread behavior is not only formatting. It is a product flow:

1. short acknowledgement in thread,
2. long-form output in Slack Canvas,
3. short final summary with Canvas file/link,
4. follow-up merge into the document or new Canvas version,
5. feedback footer.

New oneesama currently treats a long writing request as a background worker result and posts the entire draft back into the thread, so even a perfect mrkdwn renderer would still be the wrong surface for this case.

## More Related Missing Pieces

| Gap | Evidence | Why it matters |
|---|---|---|
| Worker result renderer not wired | `postSlackWorkerResult` posts only `Text`; raw Slack block is `rich_text`; `**` and tables leak visibly. | Any worker final answer with Markdown will render unlike old bridge. |
| Triage direct reply renderer not wired | `executeSlackTriageDirectActions` posts only `Text`; raw Slack block is `rich_text`. | Low-risk auto replies will also have wrong Markdown/Block Kit behavior. |
| Old bridge workspace prompt not ported | Old session metadata has a rich `workspace assistant` prompt plus `SOUL.md`; current `buildPrompt` hard-codes "background worker for the oneesama Go rewrite." | Causes repo-worker identity leaks and refusal on normal writing/workspace tasks. |
| Workspace bootstrap is not automatic | Default templates exist, but live `runtime/live-workspace` contains memory files only, no `AGENTS.md`, `SOUL.md`, `CODEX_GUIDANCE.md`, or Slack docs. | Even if the prompt were fixed, the worker does not reliably receive the intended workspace identity/runbook. |
| Mention routing has no quick-answer vs workspace-worker vs repo-worker split | `RunAvatarCommand` maps most natural mentions to `work`; `buildPrompt` is repo-worker specific. | Generic Slack teammate asks should not all become repo background jobs. |
| Triage is too willing to speak in active human/assistant threads | In this thread, new oneesama posted a casual GPT reliability acknowledgement while old bridge was already handling the document flow. | Triage should not interject just because it can add a loosely-related memory hit; old behavior was lower-friction but still context-aware. |
| Mention batching/merge behavior is only partial | Prior audit says true queued merge behavior is not 1:1; this thread has repeated follow-up mentions. | Follow-ups during an ongoing document/task should merge into one active work item rather than creating separate/conflicting replies. |
| Canvas fetch/read is only represented, not actually used for doc revision | Thread context records Canvas IDs/files, but there is no generic fetch/edit/revision worker loop for existing Canvas docs. | Follow-up prompts like "补进最新版" need real doc state, not only message snippets. |
| Slack API tool parity remains partial | Workspace templates mention reading files/canvases and posting blocks, but worker provider does not expose old Slack toolset to Codex in the same way. | Old bridge could use Slack/canvas tools as part of the assistant loop; new Go mostly wraps Slack behavior outside the worker. |
| Feedback identity differs | Old footer says `Cueboard Agent | 8c87bd6c`; new footer (when used) says `Onee Sama Agent`, and many result paths omit footer entirely. | Feedback/review affordance is inconsistent and makes old-vs-new behavior visually different. |

## Immediate Root Cause Fixed

`internal/slackagent/slack_thread_fetch.go` used JSON `POST` for `conversations.replies`. Slack returned `invalid_arguments` in live, matching the worker's complaint. The working API shape is query/form parameters; the fix switches the fetcher to authenticated `GET /conversations.replies?channel=...&ts=...&limit=...` and adds a regression test.

## Suggested Migration Order

1. Treat generic Slack writing/summarization as a workspace-assistant flow, not a repo-worker flow.
2. Wire worker/triage final delivery through the same Slack `mrkdwn` Block Kit renderer as old bridge.
3. Add a Canvas decision layer: long-form writing, summaries, and document updates create/edit Slack Canvas; thread gets short ack/final link only.
4. Add follow-up merge tests using this exact thread shape: initial ask, later additions, "看到补充了吗", "后面又补充了一条".
5. Tighten triage silence policy for threads already actively handled by a mentioned human/assistant, especially when the only reason to speak is a loose memory association.
6. Port old workspace assistant identity/prompt and ensure live workspace bootstrap actually installs `AGENTS.md`, `SOUL.md`, and Slack tool docs before worker jobs run.

## Source References

- Raw Slack thread JSON: `/tmp/bridge-imoutochan-thread-1778772007.json`.
- Old Cueboard workspace prompt: `agent-framework/internal/bridge/slack/defaults.go::DefaultSystemPromptTemplate`.
- Old Cueboard startup bootstrap: `agent-framework/cmd/slack-agentd/main.go::EnsureWorkspaceFiles`.
- New worker prompt: `internal/agentrunner/prompt.go::buildPrompt`.
- New natural mention dispatch: `internal/slackagent/service_avatar.go::RunAvatarCommand`.
- New worker result delivery: `internal/slackagent/service_worker_jobs.go::postSlackWorkerResult`.
- New triage direct delivery: `internal/slackagent/service_triage.go::executeSlackTriageDirectActions`.
- New renderer helpers: `internal/slackagent/mention_render.go`, `internal/slackagent/mrkdwn.go`, `internal/slackagent/mrkdwn_blocks.go`.
- Prior migration warning: `notes/r25-test-port-sweep.md` marked Slack renderer parity incomplete even though some mrkdwn tests were ported.
