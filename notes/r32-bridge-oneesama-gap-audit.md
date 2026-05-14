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

## Immediate Root Cause Fixed

`internal/slackagent/slack_thread_fetch.go` used JSON `POST` for `conversations.replies`. Slack returned `invalid_arguments` in live, matching the worker's complaint. The working API shape is query/form parameters; the fix switches the fetcher to authenticated `GET /conversations.replies?channel=...&ts=...&limit=...` and adds a regression test.
