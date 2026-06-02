# Bridge Quality Fixtures

These fixtures back task #219: build old-vs-new quality canaries from
past-week Bridge logs. Each fixture is a JSON case that replays a real
production app-mention prompt and asserts the new Oneesama worker
pipeline produces evidence + decision + tool calls equivalent to (or
better than) what old Slack Agent D did.

## Fixture schema

Each `case_NNN_<slug>.json` file has:

```json
{
  "case_id": "case_001_jc_case_study",
  "source": {
    "old_slack_db_run_id": 12992,
    "occurred_at": "2026-05-15T08:36:52Z",
    "channel_id": "C09LH8P4M0R",
    "mention_text": "<bridge mention> + user prompt"
  },
  "input": {
    "channel_id": "C09LH8P4M0R",
    "user_name": "vincent",
    "mention_text": "jc说之前录制了5个Case Study的视频，这个有吗？",
    "transcript": "[1779155703.395489] <@U1>: jc说之前录制了5个Case Study的视频，这个有吗？",
    "external_links": [],
    "linked_slack_threads": [],
    "files": []
  },
  "expected_contract_items": ["C4_related_memory_evidence_injected"],
  "expected_evidence_anchors": [
    "memory/team/meetings/jc-case-study.md",
    "not a recorded Case Study"
  ],
  "expected_tools_invoked": [],
  "expected_decision_shape": {
    "type": "reply_with_cite",
    "min_chars": 40,
    "max_chars": 600,
    "must_not_contain": ["127.0.0.1", "/slack/tools/call", "curl", "exit status", "localhost"]
  },
  "contract_mapping": {
    "C1": "Socket -> app_mention job (basic path)",
    "C2": "Scanner reconciliation for missed Socket",
    "C3": "Orphan recovery across restart",
    "C4": "Related-memory evidence injection",
    "C5": "Canvas read/write/reuse",
    "C6": "Entity attribution / person-project recall",
    "C7": "Tool fail-closed at output boundary",
    "C218": "Link-derived related-memory query",
    "C220": "Media/file/video parity",
    "C221": "Interactive worker tool loop",
    "C222": "Memory recall ranking parity",
    "C223": "Workflow / product-context intent"
  }
}
```

`expected_contract_items` is the subset of 7-point entry-parity contract
items (plus follow-on tasks) that this fixture exercises. A new fixture
should add a case where at least one item is being tested.

`expected_evidence_anchors` are substrings that must appear in the
worker prompt (i.e. injected evidence is reachable to Codex). They are
the proof that the new system can recover the same evidence chain.

`expected_decision_shape` constrains the worker's visible output. The
`must_not_contain` list pins the fail-closed rule (`C7`) on every case.

For `C222_memory_recall_ranking_parity`, the first
`expected_evidence_anchors` entry is also the required top
`relatedMemoryEvidence` citation. This pins ranking, not only
presence.

## Adding a new fixture

When a new task in #219–#223 ships, drop the production-anchor case in
this directory as `case_NNN_<slug>.json` and:

1. Cite the slack.db `run_id` in `source.old_slack_db_run_id` if drawn
   from past traffic, or leave that field null if synthetic.
2. List the `expected_contract_items` keys it exercises.
3. Run `go test ./internal/slackagent -run TestBridgeQualityCanary -count=1`.
4. If new contract items exist, extend the `contract_mapping` block
   here in the README.

## Methodology anchor

This fixture suite is the operational form of the audit method written
in `notes/cueboard-function-audit/migration-lessons-audit-method.md`.
The fixtures are reference instances of the per-entry-point parity
contracts described there. A regression in any one of them is by
construction a regression of one of the named drift classes.

## Source data discovery

The candidate Bridge production cases came from
`~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/slack.db`,
specifically table `triage_run` joined with `triage_tool_call`. The
2026-05-19 13:00 sweep enumerated 1828 total runs since 2026-05-12,
307 Bridge-related, 56 mutating. The 56 mutating Bridge-related runs
are the primary fixture pool; the audit author selects representative
cases per drift class rather than replaying all of them.
