# Triage Log Delta Sweep — 2026-05-19

## Scope

Compare today's old Slack Agent D triage mutations with new Oneesama live triage runs after the Pi foreground cutover.

Window: `2026-05-18T16:00:00Z` through `2026-05-19T09:00:00Z`.

## Aggregate Signal

- Old Slack Agent D: 196 triage runs, 8 mutation runs.
- New Oneesama: 97 triage runs, 2 mutation runs; both were synthetic/live-positive probes.
- Conclusion: the new system was healthy, but automatic scanner triage was materially more conservative than old Slack Agent D.

## Old Mutation Cases

1. `13663` / `C0AKGM5HCBA` — User asked for help drafting around an external X link. Old Agent D read the link, searched memory and the web, then replied.
2. `13749` / `C09L0TAN31T` — Cumora/yetone/Isoform/Alma entity attribution. Fixed earlier by entity graph and legacy trace import.
3. `13764` / `C0ALMF2AD70` — User addressed old Bridge about Bridge 2.0 "what's new" and Canvas. New Oneesama should not intercept old bot identity traffic.
4. `13790` / `C09L0TAN31T` — Fresh factual/current-events model speculation. Old Agent D searched and posted one light answer; new Oneesama classified the thread as casual and stayed silent.
5. `13816` / `C0AQ0C0KVMH` — Identity/persona chat around meeting agent behavior. Old Agent D joined with one persona-aware reply; new Oneesama stayed silent.
6. `13817` / `C0AN9NDQUPN` — Copy/delivery follow-up ("文案呢哥，还是晚上发"). Old Agent D nudged and recorded a high-priority follow-up; new Oneesama did not create an equivalent visible action.
7. `13820` — Heartbeat follow-up resolution; old self-growth/followup loop confirmed delivery before EOD. Covered by the separate self-growth/followup parity track.
8. `13835` / `C09KVPBMLJ3` — Quota reset question. Old Agent D recalled meeting-84 memory; new Oneesama stayed silent. Fixed by ranking fresh triage memory questions and filtering skipped projections.

## Root Cause Classes

### Persona Silence Suppressed Vetted Candidate Replies

After Pi foreground cutover, the old runner could still produce a filtered `post_thread_reply` candidate, but foreground execution correctly made Pi the only visible-reply owner. If Pi returned `stay_silent`, the already-filtered candidate was dropped.

This explains the class where old Agent D answered with one verified fact while new Oneesama stayed silent even though the runner had enough evidence to propose a safe reply.

### Scanner Prompt Underweighted Fresh Factual Questions

The triage prompt already allowed verified facts and link synthesis, but it did not explicitly say that fresh factual/current-events questions in casual threads are synthesis-eligible. Old Agent D was willing to search and answer these lightly.

### Old Bridge Mentions Are Benchmarks, Not Traffic To Intercept

When the user explicitly mentions the old Bridge bot identity, new Oneesama must not answer in that thread. These cases are useful as quality examples, but they are not missing-entry bugs unless the product decision changes and the old identity is retired.

## Fixes Added

- Keep Pi as the only visible-reply owner: filtered runner replies are passed into the persona request as `triage_candidate_actions`, not posted directly by Go.
- Keep the old-Bridge mention guard: if a user addressed another bot, filtered candidate actions are empty and Pi has no candidate to adopt.
- Add candidate action detail to the persona request so Pi sees the specific vetted action it is deciding to approve, rewrite, or reject.
- Update the scanner prompt to treat fresh factual/current-events questions as lightweight synthesis candidates after tool verification.

## Regression Coverage

- `TestSlackTriageLivePersonaRequestIncludesFilteredCandidateButPiOwnsVisibleReply`
- `TestSlackTriageLivePersonaStaySilentDoesNotPostOldBridgeMentionCandidate`
- `TestBuildSlackTriagePersonaRequestIncludesDecisionAndMemory`
- `TestBuildSlackTriagePromptUsesCueboardTwoPassPolicy`

## Remaining Follow-Ups

- Replay old mutation cases as a daily quality gate, not only spot-checks.
- Build a follow-up parity fixture for the "文案呢哥" delivery-nudge class.
- Keep old Bridge identity traffic out of new Oneesama until the product retirement path is explicitly decided.
