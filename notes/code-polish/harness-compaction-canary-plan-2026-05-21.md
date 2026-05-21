# Harness Compaction Canary Plan

Task #330. This note turns the RFC's compression rule into executable gates
before Oneesama wires any automatic idle compaction into foreground cognition.

## Contract

Any compaction path that feeds Pi / realtime / worker foreground context must
preserve two things:

1. Stable prefix bytes stay stable.
2. Source attribution survives compaction.

Compaction may shorten content, merge duplicated facts, and rank evidence. It
must not:

- rewrite the stable prompt / foreground tool schema;
- collapse attributed evidence into anonymous prose;
- drop `source_ref` / citation refs when a source-backed fact remains;
- expose raw worker scratch logs as a replacement for compact evidence.

## Canonical Canary Shape

Code anchor: `internal/persona/compaction_canary.go`.

```go
persona.SourcePreservingCompactionCanary{
  Surface: "slack_triage",
  StablePromptHashBefore: beforeHash,
  StablePromptHashAfter: afterHash,
  SourceRefsBefore: []string{"slack:C123:1700.1", "memory/team.md:12"},
  SourceRefsAfter: []string{"slack:C123:1700.1", "memory/team.md:12"},
}
```

Pass condition:

- `StablePromptHashBefore == StablePromptHashAfter`
- every non-empty `SourceRefsBefore` item appears in `SourceRefsAfter`

Failure codes:

- `stable_prefix_changed`
- `source_attribution_lost`

## Surfaces

| Surface | Current status | Gate before automation |
|---|---|---|
| Slack daily note compaction | Existing worker path (`memory_compact`) | Add audit row with input hash, output hash, preserved source refs, result |
| Slack triage channel/thread context | Not automatic yet | Any compacted `MemoryRecord` / `ContextItem` must carry source refs |
| Meeting transcript summary | Existing post-meeting summary path | Summary artifacts must retain transcript/caption/audio source refs |
| Realtime observation bus | Compact observation context exists | Observation compaction must keep artifact refs / frame paths |

## Implementation Order

- [x] Add provider-neutral `SourcePreservingCompactionCanary` helper.
- [x] Add tests for pass, missing source ref, and stable prompt drift.
- [ ] Add Slack daily-note compaction audit rows when compaction actually runs.
- [ ] Add meeting transcript compaction audit rows beside summary artifacts.
- [ ] Add monitor/daily rollup counts for `stable_prefix_changed` and
  `source_attribution_lost`.
- [ ] Only then enable idle compaction for any foreground request path.

## Operator Checklist

- [ ] Compacted output has fewer bytes/tokens than input.
- [ ] Every source-backed conclusion retains a `source_ref`, citation, artifact
  ref, or frame path.
- [ ] The stable prompt hash before/after compaction matches.
- [ ] Worker scratch logs are absent from the compacted foreground payload.
- [ ] The audit row is visible in the same run/session that consumed the
  compacted context.

## Review Note

Do not accept a future compaction PR whose only proof is "summary looks good".
The gate is structural: stable prefix unchanged plus source refs preserved.
