# Post-Cutover Bridge Validation Sweep — 2026-05-19

## Scope

Peng asked at 2026-05-19 12:38 SHA: search recent Slack messages where people @-mentioned Bridge, check whether the new Oneesama / Pi system handles them correctly.

This sweep looked at:

- Old Slack Agent D SQLite triage log: `slack.db`.
- Old Slack Agent D triage archive / workspace traces.
- New Oneesama live state: `runtime/live-state/slack_triage_runs.json`.
- New Oneesama scanner / workspace contexts: `runtime/live-state/slack_workspace_contexts.json`.

This doc is the second pass. The first pass (`bdd274c`) is reverted (`a2d00b3`) because it proposed the wrong fix; the data itself is preserved here with corrected interpretation.

## Counts

Old Slack Agent D, since `2026-05-12`:

| Query                                                        | Count |
| ------------------------------------------------------------ | ----: |
| All triage runs                                              |  1824 |
| Bridge-related runs (`Bridge` / `bridge` / `<@U09SF0MQZ5M>`) |   343 |
| Bridge-related mutating runs                                 |    17 |

New Oneesama live state, post-cutover window:

| Signal                                                    | Finding                                            |
| --------------------------------------------------------- | -------------------------------------------------- |
| `slack_triage_runs.json` Bridge-related hits              | Present, but mostly scanner-level triage summaries |
| `slack_workspace_contexts.json` old Bridge mention hits   | 3 item-level contexts                              |
| Old Bridge bot user ID still actively addressed by humans | `<@U09SF0MQZ5M>`                                   |
| Current Oneesama bot user ID                              | `<@U0AP5UFU0FR>`                                   |

## Representative Cases

| Case                                                              | Old/new signal                                                     | Disposition                                                                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `C09KVPBMLJ3:1779155610.872839` / `C0ALMF2AD70:1779155697.253139` | User asked about Jc's five Case Study videos.                      | Fixed earlier by app-mention related-memory injection (`36993d1`) + entity attribution import (`555feac`).                                                  |
| `C09L0TAN31T:1779165686.034869` / reply `1779165695.173579`       | User shared `agency-agents` and asked about prior discussion.      | Fixed by deriving related-memory queries from fetched link context (#218, `9fa69eb`).                                                                       |
| `C09SSC9Q5HS:1779166071.849179`                                   | User asked to inspect channel videos and organize usable material. | Not a clean app-mention parity case; needs media/file reasoning. **Watchlist → task #220**.                                                                 |
| `C0AN9NDQUPN:1779156913.102829`                                   | User asked about dashboard location addressed to old Bridge bot.   | Not a new Oneesama failure: user intentionally @-mentioned the still-live old Bridge, not the new Oneesama. **No fix required**; see "Misread Scope" below. |

## Misread Scope: Identity Migration ≠ Traffic Interception

The first pass of this sweep reached a wrong conclusion and shipped a fix that had to be reverted within 6 minutes.

What the data showed:

- 343 Bridge-related triage runs over the past week.
- Many of those reference the old Bridge bot user ID `<@U09SF0MQZ5M>`.
- The new Oneesama runtime only recognizes its current bot user ID `<@U0AP5UFU0FR>` as a mention target.

What the first pass concluded (wrong):

> "Users still address the old Bridge ID, the new Oneesama misses those events; add the old ID as a mention alias and route them into the app-mention worker."

What the first pass shipped (reverted):

- `bdd274c fix(slack): accept legacy bridge mentions` added `slack.bot_mention_user_ids` config + env var, taught scanner / mention fallback / event command stripping / bot-reply filtering to accept aliases, and live-configured `U09SF0MQZ5M` as an alias for the new Oneesama.

What Peng corrected (msg `d55ab352`):

> "成员就是在 at 老的 bridge bot，而不是新的。这时不要介入。"

What the fix actually did, in product terms:

- It would have made the new Oneesama silently intercept traffic that users intentionally addressed to a different live bot.
- That is identity hijacking, not entry-level parity.

What got reverted: `a2d00b3 Revert "fix(slack): accept legacy bridge mentions"` removed the code and live env var, returned `bot_mention_user_ids=null`, and restored `bot_user_id=U0AP5UFU0FR` as the sole mention target.

The lesson is a drift pattern in its own right and is recorded in
`migration-lessons-audit-method.md` under "Identity migration ≠ traffic interception":

- Migration scope must first answer "which identity is being retired and which is still live?"
- The new system only inherits traffic for identities that are explicitly being retired.
- If the old identity is still live and intentionally addressed by users, the new system must not route that traffic — doing so hijacks user intent.

## Real Gaps Surfaced By This Sweep

After removing the misread, four real quality regressions from this sweep are now first-class tasks (created 2026-05-19 13:30 SHA):

| Task | Gap                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| #219 | Bridge triage quality fixtures: build old-vs-new canaries from past week logs (the test infrastructure this sweep proves is needed). |
| #220 | App-mention media/file/video parity: provide file-context evidence and fail-closed on unviewed media.                                |
| #221 | Worker interactive tool-loop parity: replace remaining prompt-only tool assumptions with first-class dispatcher path.                |
| #222 | Memory recall ranking parity: compare old Agent D traces vs Oneesama query/ranking on real Bridge cases.                             |
| #223 | Product workflow intent parity: recognize PR review / task workflow requests instead of generic link commentary.                     |

Plus pre-existing follow-ups:

- #216 (in_review) shipped the bounded fresh-search dispatch (`5e21836`), not a full interactive loop.
- #218 link-derived related-memory query (`9fa69eb`) shipped earlier in the same hour.
- `b360e6e` persists explicit app-mention memory (sibling fix).

## What This Sweep Did NOT Prove

Worth being explicit:

- It did not enumerate every Bridge case in the past week. The 343 count is approximate; the 17 mutating count is the actionable subset, and tasks #219 / #222 will turn those into fixtures.
- It did not prove the new Oneesama answers any given case as well as old Agent D would have. Health is green, but health is not parity. Tasks #219 / #222 will close this.
- It did not exercise the media/file / interactive tool / workflow recognition gaps systematically — those are deferred to #220 / #221 / #223 with real cases as fixtures.
- It did not produce a Bridge-vs-Oneesama side-by-side replay. That is `#219`'s work.

## Remaining Watchlist

1. Media-heavy old-Bridge requests still need media/file worker parity (#220).
2. Full interactive worker tool loop is not complete; #216 shipped bounded first-class fresh search, not every old Agent D tool (#221).
3. Hardcoded Class 2 routing keywords should still be externalized during #199 polish.
4. Bridge case canary fixtures should anchor the next set of audits (#219).

## Notes on Method

This sweep is the validation step in the audit cycle established earlier today (`migration-lessons-audit-method.md` "Worked example: 240d9e2 canvas parity" etc.):

1. Production case surfaces (Peng's permalink, real Bridge usage).
2. Validation sweep enumerates the relevant traffic and what the new system did with it.
3. Drift classes are identified and named.
4. Each drift class becomes its own task with its own per-entry-point parity audit.
5. The fix reads the cueboard source first, writes a parity audit doc, ships the code + regression, and adds a worked example back to the audit method.

The first pass of THIS sweep skipped step 3 (drift identification) and conflated "old Bridge identity has traffic" with "new Oneesama should intercept". The revert + retry is the recovery, and identity-migration-vs-traffic-interception is now a named class.
