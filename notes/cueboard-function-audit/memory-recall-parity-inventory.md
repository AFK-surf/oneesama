# Memory Recall Parity Inventory

Task: #194  
Scope: Cueboard / OpenClaw-style related-memory recall behavior for Slack triage, delayed no-reply, and backfill replay.

## Why This Exists

Peng's target behavior is not "there is a `memory_search` tool". The product behavior is:

- Someone asks or shares something in Slack.
- Humans do not answer for a while, or the link/article/thread is a weak invitation for synthesis.
- Oneesama searches relevant past memory before speaking.
- The reply uses that memory as evidence, cites where it came from, and stays lightweight.

The migration drift is concrete: Oneesama ported memory surfaces and some keyword search plumbing, but did not preserve the Cueboard behavior where triage could use memory as part of a social reply.

## Cueboard Behavior We Need To Preserve

Cueboard had three layers that worked together:

| Layer                       | Evidence                                                                                                                                                                                                                                                                                                             | Behavior                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Triage prompt memory access | `internal/bridge/slack/scanner_triage.go:106-109` called `injectWorkspaceMemory(...)`; `internal/bridge/slack/defaults.go:266-303` injected date, workspace config snippets, memory access hints, and recent feedback.                                                                                               | Triage was a tool-using agent session, not a fixed Go classifier. The prompt told the model when to use memory instead of hardcoding a few result strings.                     |
| Memory retrieval tool       | `internal/core/tools/memorytool/search.go`; `internal/core/memory/search.go:9-16`; `internal/core/memory/chunker.go:49-52`.                                                                                                                                                                                          | `memory_search` returned snippets with `file_path`, `start_line`, `end_line`, `content`, and `score`. It searched chunked Markdown, so results were smaller and auditable.     |
| Structured memory corpus    | Workspace memory contained `MEMORY.md`, `memory/YYYY-MM-DD.md`, `memory/people/`, `memory/team/{meetings,decisions,actions,questions,facts}/`, `memory/lessons/candidates/`, and feedback notes. `defaults.go:392-403` explicitly told the agent which memory family to use for identity, team context, and lessons. | Recall was not only full-text grep. The file layout itself encoded topic/person/project/team meaning, which made weak Slack prompts answerable from recent or durable context. |

Important nuance: Cueboard's default `KeywordSearcher` was still lexical, not true vector memory (`search.go:30-32` even labels vector search as future work). The "Aha" quality came from the combination of agent-driven tool use, chunked/cited snippets, structured memory paths, and prompt policy, not from embeddings alone.

## OpenClaw-Style Behavior In This Context

Peng compared the desired Oneesama memory to OpenClaw/Linger-style memory. I did not find a single canonical "OpenClaw" memory module in this repo, but the local Linger/OpenClaw-mini work gives the relevant behavior contract:

| Pattern                                                                 | Evidence                                                                                                                                                                                                                                    | What Oneesama Should Learn                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Curated memory + recent episodes + working memory are injected together | `/Users/pengx17/Documents/telegram-pi-agent/src/runtime/memory.ts` builds `Memory Index`, semantic user/agent memory, working memory, today's/yesterday's episode memory, and relevant historical memory into a `<memory-context>` wrapper. | Related memory should be assembled as an evidence bundle, not a raw grep dump.                          |
| Historical transcript search is a separate recall surface               | `/Users/pengx17/Documents/telegram-pi-agent/src/runtime/session-search.ts` exposes `session_search` backed by SQLite FTS5 and explicitly says it is separate from curated memory.                                                           | Slack triage should be able to search recent conversation history separately from durable memory files. |
| Long-term world/context has typed entities and audit source refs        | `/Users/pengx17/Documents/telegram-pi-agent/docs/world-model.md` defines `world/entities`, `world/arcs`, `world/events`, `world/state`, source turn ids, and relevance read-back metrics.                                                   | Oneesama memory should carry type, source, and read-back telemetry; not just free text.                 |

So for #195-#197, "OpenClaw-style" means: typed memory records, recent-session recall, curated durable facts, source references, and measured read-back. It does **not** mean putting a giant private memory blob into every Slack prompt.

## Current Oneesama Behavior

| Surface           | Current implementation                                                                                                                                                                              | Gap                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live triage       | `startSlackTriage` calls `SearchLocalMemory(digest, 5)` and injects the top five results as `Relevant local memory` (`service_triage.go:720-733`, `triage_decision.go:130-144`).                    | The search happens once with the raw digest. There is no query expansion, no "must search before answering unanswered question", no evidence requirement, and no canary proving memory affected the reply. |
| Memory search     | `SearchLocalMemory` scans local seed rows, feedback rows, workspace files, and triage projections (`service_memory.go:31-53`). File scoring is keyword-hit ratio (`local_memory_search.go:13-118`). | Results are whole-file snippets, not chunked line ranges. Scores are simple substring hits. Source paths exist, but evidence is weaker than Cueboard snippets.                                             |
| Mention assistant | App mention context includes `localSlackMemory` when a rich thread context is built (`service_avatar.go`).                                                                                          | This helps direct mentions, but does not solve scanner/backfill/delayed-no-reply Aha behavior.                                                                                                             |
| Delayed no-reply  | `delayed_no_reply` followups classify and later surface if nobody replied.                                                                                                                          | The surfacing path does not perform related memory recall before posting.                                                                                                                                  |
| Backfill replay   | Backfill classifies candidates, now delegates link/article reading after task #198.                                                                                                                 | Backfill does not search related memory before deciding whether a candidate is `review_ready`; it can only mark leads as needing context/agent read.                                                       |
| Tool registry     | `memory_search` / `memory_get` are active local tools.                                                                                                                                              | Tool availability was mistaken for behavior parity. No test requires the tool to be used in the Aha-style scenario.                                                                                        |

## Migration Failure Classification

This is the same failure pattern Peng pointed out:

- We migrated API surfaces (`memory_search`, `memory_get`, `person_memory`, team-memory files).
- We did not migrate the behavioral contract: "unanswered useful Slack item → search memory → reply with cited relevant context".
- Function-level audit labeled multiple memory rows as `ported/partial`, but the acceptance test was "tool exists and returns rows", not "triage uses memory to help a real thread".

This should be treated as a product-behavior parity bug, not a missing helper.

## Required Capabilities

These are the acceptance capabilities for tasks #195-#197.

### #195 Memory Indexing

- [ ] Index memories as typed records, not only files:
  - `daily_note`
  - `person_profile`
  - `team_decision`
  - `team_action`
  - `team_question`
  - `team_fact`
  - `lesson_candidate`
  - `triage_projection`
  - `feedback`
- [ ] Preserve source evidence on every result:
  - `source_path`
  - `start_line` / `end_line` when file-backed
  - `source_ref` when store-backed
  - `created_at` / `updated_at` or best-effort timestamp
- [ ] Query should support at least lexical + structured boosts:
  - named people / Slack mentions
  - project names / repo names / PR URLs
  - recent-day boost
  - memory family boost (`people`, `team`, `lessons`, `daily`)
- [ ] Return explicit `no_relevant_memory` when there are no credible hits; do not manufacture memory.

### #196 Wiring

- [ ] Live triage must run related-memory recall for:
  - unanswered questions
  - delayed no-reply candidates
  - synthesis-eligible shared links/articles/RFCs/PDFs
  - "someone asked for review / owner / prior decision" workflow messages
- [ ] Delayed no-reply surfacing must re-run memory recall immediately before posting.
- [ ] Backfill replay must include memory evidence in the report before a candidate can become `review_ready`.
- [ ] Replies must say when they are using memory, and cite enough evidence for audit:
  - good: "我翻到最近的 memory/team/questions/... 里有一条相关 open question..."
  - bad: "我记得我们之前聊过..."
- [ ] If memory hits are weak, candidate status should be `needs_context`, not `review_ready`.

### #197 Canaries

Add canaries that fail if memory is only present as a tool surface:

- [ ] `aha_unanswered_question_with_recent_memory`
- [ ] `delayed_no_reply_uses_memory_before_reply`
- [ ] `backfill_review_ready_requires_memory_or_agent_read`
- [ ] `weak_memory_hit_stays_needs_context`
- [ ] `person_project_memory_cites_source`

Each canary should assert:

- Memory search was performed.
- At least one source citation is present when replying.
- The reply does not overclaim ("I remember") without evidence.
- If no credible memory exists, the bot stays quiet or marks the item as needing context.

## Acceptance Fixtures

### Fixture A: Aha Unanswered Question

Input:

```text
Root Slack message: "现在我们这个 bridge memory 到底什么时候会写长期记忆？"
No human reply for 90 minutes.
Memory contains memory/2026-03-21.md:
"long-term memory is model-driven rather than deterministic; even if a user says remember this, persistence depends on an actual memory_write call."
```

Expected:

- Candidate escalates from wait-for-human to MAYBE/REPLY.
- Memory recall returns the daily note with a source path and line range.
- Reply gives a short answer based on that note and cites the source.

### Fixture B: Review Request Is Workflow, Not Opinion

Input:

```text
Slack message: "https://github.com/AFK-surf/cueboard/pull/1917 @A @B 来 review，没问题就 approve 然后推进到合并"
```

Expected:

- No generic article opinion.
- Candidate is `needs_context` or a routing/action candidate.
- If memory knows reviewer/project ownership, it can cite that context; otherwise stay quiet.

### Fixture C: Shared Article With Related Prior Decision

Input:

```text
Slack message: "这个 agent memory 方案感觉怎么样？ <link>"
Memory contains a recent team decision about "memory should be agent-delegated, not parsed inside Go".
```

Expected:

- Delegated agent reads the link or marks read pending.
- Related memory recall finds the prior decision.
- Reply, if any, separates "from the link" and "from our prior memory".

### Fixture D: Weak Memory Hit

Input:

```text
Slack message: "谁知道这个测试为什么挂？"
Memory hit only contains an unrelated old "tests were flaky" note.
```

Expected:

- No confident answer.
- Candidate remains `needs_context` or "repo inspection required".
- No "I remember" language.

### Fixture E: Person/Project Recall

Input:

```text
Slack message: "@oneesama 这块应该找谁 review？"
memory/people/*.md and memory/team/actions/*.md identify current owner.
```

Expected:

- Person/project memory is searched.
- Reply cites the person profile or team action source.
- If multiple owners match, ask a narrow clarification instead of guessing.

## Implementation Order

1. Finish #194 with this inventory and fixtures.
2. #195: build a related-memory query/index layer that returns evidence-rich records.
3. #196: wire it into live triage, delayed no-reply, and backfill report generation.
4. #197: add canaries that prove the behavior, not just the tool registry.
5. #199: after #195-#197, run the code-quality pass and specifically remove any cognition hidden in hardcoded Go templates.

## Non-Goals

- Do not implement PDF parsing inside Go for this feature. Link/article reading belongs to the connected agent/delegated reader path from task #198.
- Do not mark candidates `review_ready` only because a keyword matched memory.
- Do not silently inject unverifiable "memory" into Slack replies.
