# Meet Contract Matrix

This matrix tracks the fixture-level Google Meet contracts needed before the open-source stack can replace Meet D. It keeps local CI strict without requiring a live Google account or a real Meet room.

Run:

```bash
npm run smoke:meet-contract
```

## Covered In `smoke:meet-contract`

| Contract               | Coverage                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| URL validation         | Accepts canonical `https://meet.google.com/...` URLs; rejects non-Meet URLs unless `allowNonGoogleMeet` is explicitly enabled for fixtures |
| Dry-run plan           | Verifies provider, Meet URL, bot name, avatar/realtime/worker bridge defaults, screenshot directory, and join-click plan steps             |
| Meeting Agent route    | Exercises `POST /join/google-meet` in dry-run mode and proves the API rejects invalid Meet URLs                                            |
| Local fixture join     | Runs Playwright Chromium against the local Meet fixture with `dryRun=false`                                                                |
| Guest display name     | Fills the bot name into the fixture and verifies the fixture receives it                                                                   |
| Fake mic/cam           | Verifies injected avatar camera and mic tracks reach `getUserMedia()` in the fixture                                                       |
| Participant audio seam | Creates a fixture participant audio stream and verifies the Realtime bridge discovers the labeled source                                   |
| Diagnostics            | Writes screenshots, button inventory, and diagnostics JSON for the join attempt                                                            |
| Single-bot lifecycle   | Starts a second join and verifies the first browser is stopped before the second bot becomes active                                        |
| Status/leave           | Verifies `GET /join/status` tracks the active session and `POST /join/stop` closes it cleanly                                              |

## Covered By Adjacent Smokes

| Contract                                                                               | Smoke                                                           |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Minimal non-dry-run fixture join and stop-before-start guard                           | `npm run smoke:meet`                                            |
| Optional real Google Meet join / waiting-room evidence                                 | `MAB_REAL_MEET_URL=... npm run smoke:real-meet`                 |
| Participant audio discovery in Realtime mock mode                                      | `npm run smoke:realtime-participant-audio`                      |
| Remote audio routing into the avatar fake mic bus                                      | `npm run smoke:realtime-audio-route`                            |
| Joined runtime with participant audio, worker result, Realtime tools, and avatar state | `npm run smoke:runtime-acceptance`                              |
| Local AgentRunner dialog loop in a fixture room                                        | `npm run smoke:local-agent-dialog`                              |
| Optional real Google Meet + local provider dialog loop                                 | `MAB_REAL_MEET_URL=... npm run smoke:real-local-dialog`         |
| Hiyori/fallback visual state gates                                                     | `npm run smoke:avatar-visual` and `npm run smoke:hiyori-live2d` |
| Browser-level screen-share stream bridge                                               | `npm run smoke:screen-share`                                    |

## Known Gaps

| Gap                                       | Why It Remains                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Google account login                      | Requires user-owned credentials or a throwaway Google account; keep out of public default CI                                            |
| Waiting-room/admit policy                 | Needs a live host in a real room or a managed test room                                                                                 |
| Real multi-participant audio              | Fixture creates a synthetic participant stream; live acceptance still needs a real speaker in Meet                                      |
| Browser anti-automation drift             | Real Meet UI/anti-automation changes must be caught by optional `smoke:real-meet` or nightly canary                                     |
| Captions/STT from real participant speech | STT provider seam exists, but real participant-audio transcription is not fixture-covered yet                                           |
| Real Google Meet present-click acceptance | The synthetic display-media bridge is fixture-covered, but the live Google Meet Present UI still needs a room-level operator acceptance |
| Screenshare/background text quality       | Camera background experiments were rejected; readable content should use screen share/OBS, not avatar camera                            |
| Scheduled canary room                     | Needs Peng-approved room/account strategy before enabling recurring live acceptance                                                     |
