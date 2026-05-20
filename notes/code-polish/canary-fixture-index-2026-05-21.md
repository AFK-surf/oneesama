# Canary Fixture Index

Status: documentation for task #296. Curated index of behavioural canaries that lock specific product contracts (not a comprehensive list of every test). Update when a new canary is added or an existing one is retired.

Scope: a canary here is a test that pins a real product contract (PR / incident / feature acceptance gate) and is meant to fail loudly if regression sneaks in. Boilerplate per-package unit tests are not catalogued here; `cueboard_*_parity_test.go` files are catalogued as a group rather than file-by-file.

## Quality canaries (JSON fixture driven)

### Bridge quality canary — `internal/slackagent/bridge_quality_canary_test.go`

Driven by `internal/slackagent/testdata/bridge_quality_fixtures/case_*.json`. Each case replays a real past-week Bridge mention prompt against the new Oneesama worker pipeline and asserts the evidence + decision + tool-call envelope matches (or improves on) what old Slack Agent D produced. Schema: see fixture `README.md`.

| Fixture | Contract item | Anchor task | Notes |
|---|---|---|---|
| `case_001_jc_case_study.json` | `C4_related_memory_evidence_injected` | #219 | "jc 录的 5 个 Case Study 视频" memory recall |
| `case_002_bridge_video_assets.json` | `C220_media_file_evidence` | #220 | Bridge video/media evidence parity |
| `case_003_pr_review_workflow.json` | `C223_workflow_intent_recognition` | #223 | PR review workflow intent over generic link reply |
| `case_004_twitter_review_memory_ranking.json` | `C222_memory_recall_ranking_parity` | #222 | Memory ranking parity vs old Agent D traces |
| `case_007_pi_first_foreground_pending.json` | `C237_pi_first_foreground_no_pre_pi_runner` | #237 | Pi-first foreground must not spawn pre-Pi runner |
| `case_008_workspace_policy_engagement_pending.json` | `C238_workspace_policy_engagement` | #238 | Workspace policy gates engagement |
| `case_009_link_commentary_synthesis.json` | `C241_link_commentary_synthesis` | #241 | Link commentary requires memory/multi-source synthesis, not headline restate |

Schema invariants enforced in every case (via `expected_decision_shape.must_not_contain`): no `127.0.0.1`, `/slack/tools/call`, `curl`, `exit status`, `localhost` leaks. Equivalent to contract `C7_tool_fail_closed`.

### Memory quality canary — `internal/slackagent/memory_quality_canary_test.go`

Driven by `internal/slackagent/testdata/memory_quality_fixtures/case_*.json`. Each case wires a controlled scenario (durable write, search merge, semantic recall, turn extraction, entity graph, multimodal ingest) and asserts provider events + search anchors.

| Fixture | Contract | Anchor task | Notes |
|---|---|---|---|
| `case_001_durable_write_replay.json` | `OnMemoryWrite` reaches provider | #226 / #232 | Anchor for Pi `memory_write` → provider write hook |
| `case_002_provider_search_merge.json` | provider records merge with workspace search | #232 | Pluggable backend contract |
| `case_003_semantic_recall.json` | hybrid lexical+vector recall | #229 | Semantic provider behaviour |
| `case_004_sync_turn_extraction.json` | turn history → durable candidate | #230 | Auto-extraction provider |
| `case_005_entity_graph_resolution.json` | person/project relationship recall | #231 | Entity graph provider |
| `case_006_multimodal_ingestion.json` | delegated file/image/video reader → searchable evidence | #233 | Multimodal provider |

Schema invariants: every case enforces a `must_not_contain` list against any rendered worker text (same fail-closed boundary as bridge canary).

## Dedicated regression canaries (Go-side fixtures)

These pin specific incidents or behaviour contracts without an external JSON file. Listed because they are the live tripwires for known regressions.

| Test | File | Anchor task / incident | What it pins |
|---|---|---|---|
| `TestSlackWorkerResultTextFailClosesOnJobTimeout` | `service_worker_jobs_test.go` | #279 | Worker timeout in Slack reply must use safe Chinese routing text, never leak raw `job timed out` / partial result |
| `TestSlackWorkerResultTextMapsTypedFailures` | `service_worker_jobs_test.go` | #293 | Typed `FailureCode` (auth / canceled) renders user-safe Chinese text, suppresses internal error markers |
| `TestSlackWorkerResultTextFailClosesInternalGatewayLeak` | `service_worker_jobs_test.go` | C7 (cross-cutting) | Worker reply must not leak local gateway URL/path/curl text |
| `TestPersonaDelegatedWorkerAllowedBySecretaryPolicyFixtures` | `persona_shadow_test.go` | #283 | Secretary delegation policy: 4 historical worker prompts (3 in-scope + #279 out-of-scope) + 2 boundary cases (explicit scope override, oneesama self-reference override) |
| `TestSlackTriagePiFirstLiveBlocksExternalProjectDebugDelegation` | `persona_shadow_test.go` | #283 | End-to-end: #279 staging perf prompt → blocked → reply downgrade → metadata `delegate_worker_scope_blocks=1` |
| `TestSearchRelatedMemoryLabelsPersonaMemoryWrites` | `related_memory_test.go` | #268 / `dc604ca` | `memory/persona/writes/` → kind `persona_memory_write` + family boost reason fires |
| `TestMemoryProviderNamesAndAvailability` | `memory_provider_ownership_test.go` | #284 | 4 providers register with expected names + availability flag wiring |
| `TestRelatedMemoryFamilyBoostMatrix` | `memory_provider_ownership_test.go` | #284 | Full kind → boost weight table (incl. zero-boost kinds) |
| `TestRelatedMemoryLegacyToolTraceBoostMatrix` | `memory_provider_ownership_test.go` | #284 | Legacy-tool-trace +0.22 boost edge conditions |
| `TestRelatedMemoryKindForPathMatrix` | `memory_provider_ownership_test.go` | #284 | Path → kind classification (incl. legacy slack-agent-d paths) |
| `TestMultimodalMemoryDoubleIndexOverlap` | `memory_provider_ownership_test.go` | #284 (known overlap) | Multimodal scanner + provider double-index is currently both present; test flips when overlap is resolved |
| `TestSearchRelatedMemoryBoostsPersonProfileForOwnerQuery` | `related_memory_test.go` | (foundational) | Person profile owner-token family boost |
| `TestSlackWorkerToolRequestStartsContinuationWithDispatcherEvidence` | `service_worker_jobs_test.go` | #221 / `b3ed69e` | Native worker tool loop with dispatcher evidence, not prompt-only curl |
| `TestSlackWorkerToolRequestRejectsUnsafeSlackPost` | `service_worker_jobs_test.go` | #221 | Tool bridge rejects unsafe `chat.postMessage` |

## Cueboard parity test suite (catalogued as a group)

There are 62 `*_parity_test.go` files across `internal/slackagent` (45), `internal/meetingagent` (8), and `internal/agentrunner` (2) that pin old-cueboard-vs-new-Oneesama behavioural parity. These are NOT individually catalogued here because:

- they live under a self-documenting naming convention (`cueboard_<surface>_parity_test.go`);
- they are run on every CI build under the `cueboardparity` build tag;
- adding a new parity test does not need an index entry — it lives under the same convention.

When porting a new surface from old slack-agent-d / meet-d / agent-runner, follow the existing pattern and place the parity test next to the surface it verifies. Reference: `notes/cueboard-function-audit/migration-lessons-audit-method.md`.

## Replay tools (production-data canary surface)

| Tool | Path | Notes |
|---|---|---|
| `oneesama-triage-replay` | `cmd/oneesama-triage-replay/` | Live 24h backfill triage replay CLI. Used by driver / supervisor for after-the-fact triage quality sweeps. Supports `--live --channel`, `--persistence-dir` opt-in. Schema documented inline. |
| `backfill_replay_*.go` | `internal/slackagent/` | Library functions powering the replay CLI; reuses classifier so production code paths and replay paths stay aligned. |

## Ownership

Single repo, two-agent rotation (@劲霸仁波切 driver / @喵喵 supervisor). Ownership of canary maintenance follows the surface the canary covers:

- **Bridge quality canary set + memory quality canary set**: shared. New cases land via whichever agent owns the surface being added.
- **Worker / timeout / secretary delegation canaries**: surface owners (driver for delegation policy + typed failures, supervisor for fail-closed text + ground-truth fixtures).
- **Memory provider ownership matrix tests**: supervisor (matches #284 ownership).
- **Cueboard parity tests**: surface owners — whoever ports a cueboard surface adds the parity test alongside.

If a canary fails in CI and the owner area is unclear, treat it as joint-owned and triage in `#meeting-avatar`.

## Maintenance rules

- New JSON fixture under `bridge_quality_fixtures/` or `memory_quality_fixtures/` → add a row to the matching table above in the same commit.
- New dedicated Go-side regression canary that pins a specific incident or shipped contract → add to the "Dedicated regression canaries" table.
- Renamed or retired canary → update or remove the row in the same commit; do not silently delete.
- Fixture schemas live in the per-directory `README.md`; this index links to them, it does not duplicate them.
