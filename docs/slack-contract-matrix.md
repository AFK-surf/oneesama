# Slack Contract Matrix

This matrix tracks the fixture-level Slack contracts needed before the open-source stack can replace Slack Agent D. The goal is to keep local CI strict without requiring a live Slack workspace token.

Run:

```bash
npm run smoke:slack-contract
```

## Covered In `smoke:slack-contract`

| Contract                   | Coverage                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slash command parser       | `join`, `status`, `stop`, `delegate`, `jobs`, quoted strings, `--session`, `--mode`, `--write`, `--bot-name`, `--dry-run`, `--start-joiner`         |
| Google Meet URL validation | Accepts canonical Meet URLs with query strings; rejects non-Meet URLs                                                                               |
| Slack signing secret       | Valid HMAC accepted; wrong secret rejected by service; stale timestamp rejected by verifier and service; malformed signature rejected by verifier   |
| URL-encoded slash payload  | Posts real `application/x-www-form-urlencoded` payloads with Slack-like `team_id`, `channel_id`, `user_id`, `response_url`, and `trigger_id` fields |
| Route compatibility        | Exercises both `/commands/avatar` and `/slack/commands/avatar`                                                                                      |
| Command happy paths        | `help`, `join`, `status`, `delegate`, `jobs`, `stop`                                                                                                |
| Command edge paths         | Invalid `join`, unknown command, missing `delegate` task                                                                                            |
| Meeting handoff            | `join` creates a Slack session and hands it to Meeting Agent in dry-run mode                                                                        |
| Worker delegation          | `delegate` uses the selected AgentRunner, attaches session context, and reports the completed job to Meeting Agent                                  |
| Slack job polling          | First `jobs` poll returns a completed Meeting Agent job; second poll proves no duplicate Slack delivery                                             |

## Covered By Adjacent Smokes

| Contract                                                                              | Smoke                              |
| ------------------------------------------------------------------------------------- | ---------------------------------- |
| Slack result formatting from Meeting Agent jobs                                       | `npm run smoke:slack-results`      |
| `chat.postMessage` mock/live seam, thread metadata, retry, dedup key, delivery marker | `npm run smoke:slack-posting`      |
| Old-stack shadow tap receiver auth and side-effect suppression                        | `npm run smoke:shadow-tap`         |
| Sanitized old-stack mirror transmitter payloads                                       | `npm run smoke:shadow-transmitter` |
| Fixture old/new join/delegate/jobs/stop parity                                        | `npm run smoke:shadow-parity`      |
| Shadow/canary/rollback cutover decisions                                              | `npm run smoke:cutover-shadow`     |

## Known Gaps

| Gap                               | Why It Remains                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack OAuth install flow          | Local manifest generator/validator and OAuth authorize/callback route shape are covered by `smoke:slack-install`; real workspace reinstall/token acceptance remains a live gate |
| Socket Mode connection            | Needs `SLACK_APP_TOKEN`; should be a live acceptance gate, not a fixture default                                                                                                |
| Events API subscriptions          | Endpoint shape is not implemented yet; add when workspace event mirroring is required                                                                                           |
| Interactive payloads              | Current control plane is slash-command first; buttons/modals are future UX                                                                                                      |
| `response_url` delayed responses  | Payload field is parsed/preserved in fixtures, but delayed response posting is not implemented                                                                                  |
| `files.upload` / file attachments | Not needed for current meeting control loop; future transcript/evidence upload feature                                                                                          |
| Live Slack token/channel posting  | `smoke:slack-posting` covers mock/live poster shape; live token acceptance needs Peng-provided dev workspace token                                                              |
