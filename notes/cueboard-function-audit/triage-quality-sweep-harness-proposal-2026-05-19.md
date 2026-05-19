# 7d Triage Quality Sweep Harness Proposal — 2026-05-19

## Goal

Define the data shape and tooling contract for the 7-day production
triage quality sweep that lands as Phase 1 of the Pi-first RFC
(`notes/rfc/foreground-cognition-pivot-rfc-2026-05-19.md`).

Driver's 17:48 6h self-check named "0 mutation ≠ green" as a real
quality signal — Pi systematically tends to `stay_silent` where old
slackd would have engaged. Today's fixture suite (4 active + 2
pending) pins per-event contracts; it does not measure
**distributional** quality across 7d of production traffic. That
is what this sweep harness provides.

## Scope

- Compare new oneesama `slack_triage_runs.json` + persona shadow
  records vs cueboard `slack.db.triage_run` over the same 7d
  window.
- Score by mutation rate, decision distribution, evidence injection
  rate, tool-call distribution, reply length, source-citation rate.
- Output Markdown report per day + 7d rollup, ready to paste into
  Slack or attach to a PR.
- Re-runnable offline (no live tokens, no Slack writes); the same
  CLI runs in CI for daily snapshots.

## CLI Contract

Extend `cmd/oneesama-triage-replay` with two new modes:

```
oneesama-triage-replay \
  --sweep \
  --since 7d \
  --old-slack-db ~/Documents/cueboard/.../slack.db \
  --new-state runtime/live-state/slack_triage_runs.json \
  --new-persona-records runtime/live-state/persona_foreground_results.json \
  --report-dir reports/triage-quality-sweep/
```

Output a directory of Markdown:

- `2026-05-19.md` (per-day report)
- `7d-rollup-2026-05-13_to_2026-05-19.md`
- `cases/` subdir: one `.md` per case where distribution differs
  meaningfully (Pi stay_silent + old slackd ACT) — these are the
  individual production failures to inspect

## Per-Day Report Schema

Each daily Markdown contains a fixed set of tables. Programmatic
reviewers (and dashboards) parse the tables; human reviewers read
the prose.

### 1. Decision Distribution

| System | runs | reply | stay_silent | delegate_worker | memory_write | failed |
|---|--:|--:|--:|--:|--:|--:|
| old slackd | N | n1 | n2 | n3 | n4 | n5 |
| new oneesama (codex_then_pi) | N | n1 | n2 | n3 | n4 | n5 |
| Δ | — | Δ1 | Δ2 | Δ3 | Δ4 | Δ5 |

Acceptance gate: |Δ stay_silent| / N < threshold% during shadow
phase; if Pi is systematically silent where old wasn't, this lights
yellow / red.

### 2. Mutation Rate

| System | mutations | non-mutation runs | mutation rate % |
|---|--:|--:|--:|
| old slackd | M | N-M | M/N% |
| new oneesama | M' | N-M' | M'/N% |
| Δ | — | — | Δ% |

### 3. Evidence Injection Rate

| System | runs with cited evidence | runs without evidence | evidence rate % |
|---|--:|--:|--:|

### 4. Tool Call Distribution

| Tool | old slackd calls | new oneesama calls | Δ |
|---|--:|--:|--:|
| slack_api/fetch_thread | … | … | … |
| exa_search | … | … | … |
| exa_contents | … | … | … |
| memory_search | … | … | … |
| memory_get | … | … | … |
| person_memory | … | … | … |

### 5. Reply Quality Proxies

| Metric | old slackd | new oneesama |
|---|--:|--:|
| Avg reply length (chars) | … | … |
| % replies with cited source path | … | … |
| % replies on threads with linked external content | … | … |
| % replies that mention specific person/project entities | … | … |

### 6. Notable Cases (auto-extracted)

Cases where decision differs in a way worth human inspection:

- old slackd `decision=reply`, new oneesama `decision=stay_silent`
  AND old slackd reply included a source citation. (Pi missed a
  worth-engaging case.)
- new oneesama `decision=reply` AND reply contains hedge markers
  ("可能" / "也许" / "maybe" / "seems") as primary content
  disposition. (Pi hedged where it should have delegated.)
- new oneesama `decision=reply` AND new reply length < 50% of old
  reply length on the same thread. (New reply may be thin.)
- new oneesama `agent_runner.StartTask` before Pi.Decide while
  `foreground_chain` is supposed to be `pi_first_live`. (Drift
  pattern back.)

## 7d Rollup

Daily reports aggregate into a 7d rollup with the same tables. The
rollup includes:

- Trend: did Pi mutation rate move toward / away from old slackd
  baseline day over day?
- Quality regression alerts: which cases flagged in the cases/
  subdir recurred more than once.
- Cumulative SLO compliance:
  - Pi p95 latency on foreground path
  - Codex pre-Pi runner invocations on foreground path (must be 0
    in pi_first_live mode)
  - Decision-shape distribution match within tolerance

## Acceptance Gate Mapping

Each sweep table maps to an RFC Acceptance Gate:

- "Decision Distribution + Mutation Rate" → RFC Quality Gates "Pi-first
  decisions must match or improve the current chain on should-port
  cases" + "0 mutation ≠ green" parity gate.
- "Evidence Injection Rate" → RFC Quality Gates "Meeting/quota/person/project
  Memory cases cite Memory/provider evidence."
- "Tool Call Distribution" → RFC Architecture Gates "Codex/agent_runner
  jobs created from triage must have a preceding Pi delegate_worker
  decision recorded."
- "Reply Quality Proxies" → RFC Acceptance Gates "Pi-first decisions
  must match or improve the current chain on should-port cases."
- "Notable Cases" → RFC Risk Inventory item 5 "Worker task spec
  divergence" + Pi Capability Boundary "Pi cannot reply with hedged
  uncertainty."

## Open Questions

- Old slackd lives in cueboard; we have read-only filesystem
  access. Do we need a snapshot+sync cadence (e.g., daily rsync of
  slack.db) or can the sweep tool read live?
- Should the sweep harness exclude cases where the user explicitly
  addressed old Bridge identity (per the identity-migration drift
  class)? Probably yes — those are out-of-scope for new oneesama.
- Should the sweep include canary fixtures or production-only?
  Production-only seems right; canaries are pinned by unit tests.
- Granularity: per-channel rollup also useful, or 7d rollup is
  enough?

## Status

- Proposal only; no code yet.
- Implementation lands as part of Phase 1 dual-run if RFC review
  approves the dual-run phase.
