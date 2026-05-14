# R25 Function-Level Source Port Audit

Status: audit first. R24.11 empty-room code exists only as local draft and must not be pushed/hot-updated until this audit is reviewed.

Scope: cueboard `slack-agentd` / `meetd` / `meeting-joiner` functions that affect the Slack -> Meet -> transcript -> summary -> Canvas user chain.

Legend:
- `✅` implemented and verified on live or controlled dogfood.
- `⚠️` implemented but branch/local-only, partial, or not verified on the real user path.
- `❌` missing or known broken.
- `🚫` intentionally out of scope by product decision.

## Top Gaps

| Priority | Source function / behavior | Current status | Next action |
|---|---|---|---|
| P0 | `meeting-joiner/src/meet-session/ui.ts::waitForMeetingEnd` empty-room auto leave | ❌ live `956d268` stayed in Meet after Peng left; local R24.11 draft exists but unpushed | R24.11: port participant count + alone timeout, verify host leaves -> bot self-leaves -> post-meeting result |
| P0 | `internal/meeting/asr.go::TranscribeAudio` / Gemini ASR provider | ❌ not in Go live path; R24.10 used fixture transcript only | R25: port ASR provider/config; verify audio/chunk -> transcript artifact |
| P0 | `internal/meeting/summary.go::LLMSummarizer.Summarize` and `Calibrate` | ❌ Go post-meeting uses heuristic fallback; no configured summary provider parity | R25: configured Opus summary provider via env/config only; no private model ID in code/user-visible logs |
| P0 | `Runtime.joinMeeting` -> ASR checkpoint/final transcript mix | ❌ Go direct join does not run old audio ASR/checkpoint loop | R25: integrate captured audio/ASR with live captions before summary |
| P0 | Cueboard recording artifact fidelity | ⚠️ R24.13a live uploads `transcript.txt` and renders Cueboard-style Canvas; audio recorder/upload path is wired but must be proven by a new real/fake-media meeting | Hard gate every recording dogfood on five artifacts: `captions.count > 0`, `transcript.txt` file card, non-silent `audio.mp3` file card, Cueboard-style Canvas, original-thread notification |
| P0 | `Service.ProcessMeetdMeetingEnd` empty transcript path | ⚠️ direct join fail-loud is implemented; scheduled meetd path still marks done/no transcript without `meeting.result` | R24.11/R25: make all end paths publish visible result or failure |
| P1 | `meeting-joiner` true Google Meet caption/ASR from audio | ⚠️ captions DOM capture plumbed and fixture transcript verified; true ASR/caption generation not verified | R25: fake-audio dogfood with Chrome fake media |
| P1 | `meeting_webhook.go` copilot digest/tool effects | ⚠️ partially ported/partly deferred; not needed for join-card acceptance | R26+: decide product scope after main meeting lifecycle is stable |

## Startup / Config

| Source function | Old behavior | Go counterpart | Status | Next action |
|---|---|---|---|---|
| `cmd/slack-agentd/main.go::main` | Boots Slack bridge, Socket Mode, webhook server, tool gates, validate-only mode | `cmd/oneesama/main.go::run`; `internal/slackagent/server.go`; `service_socketmode.go`; `runtime_validate.go` | ✅ live health/status and `--validate` verified in R23b/R24 promote | Keep regression baseline |
| `cmd/slack-agentd/main.go::scrubSlackAgentProcessSecrets` | Redacts process argv secrets | `pkg/config/redact.go::RedactForLogging`; runtime logs use config redaction | ⚠️ config redaction exists, process argv scrub not 1:1 | Add explicit process-secret scrub audit if secrets appear in ps/logs |
| `cmd/slack-agentd/main.go::augmentLoopOptions` | Adds/removes workspace tools per Slack session context | `internal/agentrunner/*`; `internal/slackagent/service_avatar.go::buildAgentRunnerContext` | ⚠️ Codex/runner context exists; old tool gating not 1:1 | R26 BackgroundJob/tool streaming will revisit |
| `cmd/slack-agentd/main.go::unregisterToolRegistryByName` / `filterToolRegistryByName` | Blocks tools by run mode | `internal/agentrunner/capabilities.go`; provider-level capability checks | ⚠️ equivalent capability surface, not strict registry copy | Only port if specific tool leakage is found |
| `cmd/meetd/main.go::main` | Boots meetd store/runtime/http/webhook sender | unified `cmd/oneesama/main.go`; `internal/meetingagent/server.go`; `StartMeetdRuntime` | ✅ zero-config webhook + mock meeting -> Canvas verified in R23b | Keep regression baseline |
| `cmd/meetd/config.go::loadConfig` | Loads meetd secrets/config/env: watch interval, webhook, ASR, summary, audio, bot name | `pkg/config.Load`; `applyMeetdEnvOverrides`; `applyDerivedRuntimeDefaults` | ⚠️ webhook/caption defaults ported; ASR/summary config missing | R25: add ASR + summary config keys, private model via env/config only |
| `cmd/meetd/config.go::loadMeetdSecretsFileFromEnv` / `loadMeetdFileConfigFromEnv` | Loads secret/config JSON files | `pkg/config/load.go::loadFile`; `derived_defaults.go` runtime secret | ⚠️ config file path supported; meetd-specific secrets not full parity | Add provider secret fields only when R25 ports providers |
| `cmd/meetd/config.go::requireEnv` / `firstNonEmptyEnv` / `lookupEnvBool` | Small env helpers | `pkg/config/load.go::getenv*` | ✅ implemented | None |

## Slack Mention / Ingress

| Source function | Old behavior | Go counterpart | Status | Next action |
|---|---|---|---|---|
| `mention.go::handleMention` | App mention -> reaction -> queue/session -> reply | `service_events.go::HandleSlackEvent` -> `handleEventAvatarCommand`; `service_reactions.go` | ✅ help + emoji lifecycle live verified | Keep as baseline |
| `mention.go::processQueuedMentions` / `processMentionBatch` | Batches same-thread mentions and runs one agent turn | `claimSlackMentionEvent`; thread context; no batch queue | ⚠️ dedupe exists and single-card dogfood passed; true queued merge behavior not 1:1 | Keep watch; only port batching if duplicate/merge regressions recur |
| `mention.go::clearMergedMentionIndicators` | Clears stale eyes when merged | `finishMentionReaction` only on handled command | ⚠️ no batch merge stale-eye cleanup | Low priority unless queued merge returns |
| `mention.go::postQueuedMentionAck` | Interim queued reply | `slackImmediateCommandAckText`; response/card updates | ⚠️ visible feedback exists for join; not a generic queued ack | No immediate action |
| `mention.go::mentionFailureReply` / `handleSlackMentionFailure` | Posts friendly failure and warning reaction | `handleEventAvatarCommand`; `reactionEmojiForCommand`; `dispatchEventPost` | ✅/⚠️ help/join failures visible; broad agent-loop failure taxonomy not fully dogfooded | Add fail-loud reason logs for all no-op paths |
| `mention.go::newMentionHooks` | Agent hooks: interim replies, history, progress/status | `agentrunner` jobs + `assistant_status.go`; R26 BackgroundJobStreaming planned | ⚠️ basic status works; Codex stream not observable | R26 normalized background job events |
| `mention.go::newSlackMentionStatusListener` | Assistant status updates with throttling | `assistant_status.go::scheduleAssistantThreadStatus` | ✅ live status flips verified | Keep baseline |
| `mention.go::handleSlackMentionResult` | Posts final answer, updates reactions, history, thread ledger | `RunAvatarCommand`; `dispatchEventPost`; memory/ledger helpers | ⚠️ command replies verified; full old ledger/result history partially ported | R26/R27 will add job stream/card history |
| `mention.go::allowMentionUser` / `handleUnauthorizedMention` | User allowlist and friendly rejection | OAuth/permission model + install flow | ⚠️ workspace install model exists; mention allowlist parity not checked | Audit permissions separately before OSS multi-workspace |
| `mention_render.go::postThreadReply` / `postSlackThreadReply` | Block Kit reply with thinking/footer/session metadata | `poster.PostMessage`; `meeting_webhook_render.go`; `service_join_interaction.go` | ✅ join/status/result visible; generic thread reply renderer not 1:1 | Not blocker for meeting chain |
| `mention_render.go::buildSlackThreadReplyBlocks` / `softenSlackThreadReplyMarkdown` | Slack mrkdwn cleanup and block splitting | `meeting_webhook_render.go`; `canvas_helpers.go`; old mrkdwn helpers partially ported | ⚠️ meeting blocks OK; generic answer rendering parity not audited here | Keep in Slack reply audit, not R24 blocker |
| `mention_render.go::addReaction` / `removeReaction` | Slack reactions.add/remove | `reactions.go`; `service_reactions.go` | ✅ R23a live accepted | Keep regression tests |
| `mention_render.go::stripMention` | Removes `<@bot>` from command text | `events_command.go::stripSlackBotMentions`; `findSlackMeetURL` | ✅ R24.8 real Slack wrapped URL fixed and dogfooded | Keep Slack entity fixtures |
| `apps/slack-agent::isBotMentionFallbackMessage` | Handles root/thread message fallback before buffer | `message_mention_fallback.go` | ✅/⚠️ R24.4 ported; real root card dogfood succeeded | Need one real thread reply dogfood later |

## Slack Interactions / Cards

| Source function | Old behavior | Go counterpart | Status | Next action |
|---|---|---|---|---|
| `interaction.go::handleInteraction` | Dispatches Slack Block Kit actions | `handler_interactions.go`; `service_interaction_dispatch.go`; `socketmode_dispatch.go::handleInteractive` | ✅ real Slack UI click verified in R24.10 | Keep Socket + HTTP tests separate |
| `interaction.go::stripActionBlocks` / `stripBlocksByID` | Removes buttons after action | `StartJoinSetupInteraction` replace/update flow | ⚠️ join flow disables/replaces card; generic pending-action strip exists separately | Not R24 blocker |
| `interaction.go::handleDismissCard` / `handleDismissAction` | Dismiss cards/pending actions | `service_pending_actions.go`; interactions handlers | ✅/⚠️ task #98 says pending taxonomy ported; not part of meeting chain | No action unless pending card bug appears |
| `interaction.go::handleConfirmAction` | Confirms pending actions and executes | `service_pending_actions.go`; `triage_action_card.go`; `Execute...` adapters | ✅/🚫 non-meeting third-party action mutations were later marked out of scope | Do not spend R24/R25 time here |
| `interaction.go::executeJoinMeeting` | Pending action can create/join meeting | `service_join_card.go`; `service_join_interaction.go`; `service_avatar_meeting.go` | ✅ join card UX verified on real Slack UI | Keep one-card/dedupe regression |
| `interaction.go::updateInteractiveMessage` | Updates card via Slack API/response transport | `postSlackInteractionResponse`; response_url two-stage update; thread status | ✅ real Slack UI saw Joining -> Joined and thread status | Keep response_url test; add chat.update fallback only if response_url fails |
| `service_join_card.go::buildJoinSetupBlocks` | New product join card: caption select + Join buttons | no exact cueboard source; product requirement | ✅ R24.10 real Slack UI verified | Keep card copy/user-shape tests |
| `service_join_card.go::joinSetupCommandInputFromInteraction` | Reconstructs confirmed join with caption/realtime flags | no old direct equivalent; replaces session command shape | ✅ real Slack click created real session | Keep payload from real card fixture |
| `service_join_interaction.go::finishJoinSetupInteraction` | Runs join async, posts joined/failure visible state | old `meeting.joined` webhook copy via `meetingJoinedBlocks` | ✅ R24.10 user-facing joined copy verified | Keep session id hidden from user copy |

## Slack Meeting Webhook / Canvas

| Source function | Old behavior | Go counterpart | Status | Next action |
|---|---|---|---|---|
| `meeting_webhook.go::startWebhookServer` / `handleMeetingWebhook` | HTTP webhook endpoint with HMAC | `handler_meeting_webhook.go`; `signature.go`; `service_meeting_webhook.go` | ✅ R23b zero-config webhook + HMAC smoke verified | Keep baseline |
| `meeting_webhook.go::handleWebhookJoined` | Posts joined blocks and sets assistant status Recording | `handleMeetingWebhookJoined`; `buildMeetingJoinedPost`; `scheduleAssistantThreadStatus` | ✅ R24.10 joined copy/status verified | Keep oneesama-branded copy |
| `meeting_webhook.go::handleWebhookProcessing` | Sets "Generating meeting summary..." | `handleMeetingWebhookProcessing` | ✅/⚠️ fixture transcript path hit processing; true auto-end unverified | Verify with auto empty-room after R24.11 |
| `meeting_webhook.go::handleWebhookResult` | Reserves result, posts summary, uploads artifacts/Canvas, clears status | `handleMeetingWebhookResult`; `publishMeetingSummary`; `meetingWebhookStore` | ✅ fixture transcript -> Canvas/thread verified | Verify with true caption/ASR transcript in R25 |
| `meeting_webhook.go::postMeetingResultFailureNotice` | Visible failure result | `postMeetingFailureResult`; `buildMeetingFailurePost` | ✅/⚠️ empty direct stop fail-loud verified in dogfood; scheduled empty still partial | Make scheduled empty transcript visible |
| `meeting_webhook.go::collectMeetingArtifactLinks` / upload/materialize helpers | Upload transcript/audio artifacts to Slack | `canvas_publisher.go`; `meetingCanvasArtifact`; artifact paths in summary | ⚠️ transcript artifact path shown; audio upload/materialization not parity | R25 when audio ASR/artifacts land |
| `meeting_webhook.go::enqueueCopilotDigest` / `copilotRunner` / `runCopilotOnce` | In-meeting copilot digest and side effects | `packages/core/src/slack/meeting-copilot-runner.ts`; partial Go meeting worker/realtime tools | ⚠️ not in R24 acceptance; requires separate scope | R26+ if product wants active meeting copilot |
| `meeting_webhook.go::meetingJoinedBlocks` | User-facing joined Block Kit | `buildMeetingJoinedPost` | ✅ R24.10 copy parity verified | Keep tests |
| `meeting_webhook.go::resolveThread` | Maps webhook payload to Slack channel/thread | `meeting_webhook_store.ResolveRef`; `meetingSlackRefFromPayload` | ✅ fixture direct join preserved original thread | Keep force-delivery tests |

## Meet Runtime / Scheduled MeetD

| Source function | Old behavior | Go counterpart | Status | Next action |
|---|---|---|---|---|
| `runtime.go::NewRuntime` / `Start` | Owns store, watcher, callbacks, active joiners | `Service.StartMeetdRuntime`; `TickMeetdRuntime`; stores in persistence | ✅/⚠️ meetd runtime tick tests and R23b mock tick verified | Continue scheduled path parity audit |
| `runtime.go::RegisterActiveJoiner` / `GetActiveJoiner` | Tracks live joiner for chat/captions | `SessionRecord`; `meetRunner.StatusSession`; `service_join_monitor.go` | ⚠️ direct runtime status exists; scheduled active joiner equivalence partial | Verify chat/caption active session operations after R24.11 |
| `runtime.go::ScheduleMeeting` | Creates pending scheduled meeting | `handleMeetdMeetings`; `CreateMeetdMeeting`; `SetMeetdMeetingSession` | ✅/⚠️ API compatibility tests pass; live scheduling not recent dogfood | Not R24 immediate blocker |
| `watcher.go::startWatcher` | Cleanup stale, recover processing, poll calendar, process ready, cleanup raw audio | `runMeetdRuntime`; `TickMeetdRuntime`; no raw-audio cleanup parity | ⚠️ runtime core ported; raw audio cleanup absent | Add audio artifact cleanup after ASR port |
| `watcher.go::checkUpcomingMeetings` | Calendar source -> pending meetings | current calendar integration mostly deferred/removed; manual/API schedule path exists | 🚫/⚠️ Google Calendar/credentialed app integrations de-prioritized; scheduled API remains | Do not block current join card on Calendar |
| `watcher.go::processReadyMeetings` | Pending -> joining within window | `processReadyMeetdMeetings` | ✅ tests cover tick claims ready meetings | Keep |
| `watcher.go::joinMeeting` status `"in_meeting"` | Mark active, register joiner, notify joined, start copilot + ASR checkpoint | `joinMeetdMeeting`; `JoinGoogleMeet`; `NotifyMeetdWebhook("meeting.joined")` | ⚠️ joined notification works; copilot + ASR checkpoint missing | R25: ASR checkpoint/final audio; R26: copilot |
| `watcher.go::joinMeeting` event `"caption"` | Upserts live captions with dedupe | `AddMeetdCaption`; `captionsFromStopRuntime` for direct joins | ⚠️ direct stop reads runtime captions; scheduled live caption stream not fully proven | True caption dogfood |
| `watcher.go::joinMeeting` event `"chat_message"` / `"chat_sent"` | Persists incoming/outgoing Meet chat | `service_meetd_chat.go`; `sendMeetChat` bridge | ⚠️ chat persistence tests exist; not part of R24 dogfood | Verify before realtime meeting chat feature |
| `watcher.go::joinMeeting` event `"meeting_ended"` | Mark processing and process end | `ProcessMeetdMeetingEnd`; direct monitor calls `StopJoin` | ❌ empty-room real user path failed; scheduled end path not dogfooded | R24.11 + real host-leaves dogfood |
| `watcher.go::recoverProcessingMeetings` | Resumes processing after daemon restart | `recoverMeetdProcessing` | ⚠️ unit covered; live restart during active meeting unverified | Add restart recovery smoke later |
| `watcher.go::parseEventTime` | Calendar date/datetime parsing | equivalent in create/schedule helpers | ✅ tests cover basic create/list | Low risk |

## Meet Runner / Browser Session

| Source function | Old behavior | Go counterpart | Status | Next action |
|---|---|---|---|---|
| `meeting-joiner/src/index.ts::emit` / `cleanupSession` / signal handlers | Emits JSON events and cleans browser/audio on exit | `meet-runner/src/protocol.ts`; `handleStopSession`; `Session.Close` | ⚠️ stop works manually; auto cleanup tied to monitor gap | Re-test after empty-room auto leave |
| `MeetSession.run` | Launch, join, install caption/chat observers, record audio, wait for end | `packages/core/src/meeting/google-meet-joiner.ts::createGoogleMeetJoiner.join` | ⚠️ true join verified; audio recording/end waiting not full parity | R25 fake-audio/ASR dogfood |
| `meet-session/ui.ts::dismissFirstVisible` / `clickFirstVisible` | Common Meet UI helpers | `google-meet-joiner.ts::clickFirstVisible`; `caption-capture.ts` | ✅/⚠️ join worked on real Meet | Keep diagnostics |
| `ui.ts::ensureChatPanelOpen` | Opens Meet chat | `sendMeetChat`/`readMeetChat` in current joiner | ⚠️ tests exist; not dogfooded in current live | Verify when chat feature is next |
| `ui.ts::detectAdmissionDeniedMessage` / `waitForAdmission` | Detects denied/waiting admission | `clickMeetJoinButton`; `evaluateMeetPageState` | ⚠️ real open room worked; denied/admit cases unverified | Add admit/denied smoke if guest access used |
| `ui.ts::enableCaptionsViaSettings` | Sets caption language in Google Meet settings | `caption-capture.ts::enableCaptionsViaSettings`; current join request `CaptionLanguage` | ⚠️ plumbed; real language setting not verified | R25 fake-audio/caption dogfood should capture evidence |
| `ui.ts::getParticipantCount` | Reads People button badge/aria/tiles | local R24.11 draft in `evaluateMeetPageState` + `runtimeParticipantCount` | ⚠️ local draft only, unpushed | Finish after audit; verify on real host-leaves path |
| `ui.ts::waitForMeetingEnd` | Leave button disappearance, hard timeout, participant<=1 for 30s, emits end | no live equivalent; local monitor draft in Go | ❌ live bug confirmed | R24.11 |
| `observers.ts::installCaptionObserver` | MutationObserver emits caption deltas | `caption-capture.ts::installMeetCaptionCapture` | ⚠️ installed in joiner; true capture not dogfooded | R25 |
| `observers.ts::installChatObserver` | MutationObserver emits chat messages | current chat read/send and runtime status | ⚠️ partial | Verify before depending on meeting chat transcript |
| `meet-runner/src/index.ts::handleJoinRequest` | Persistent JSON-RPC join bridge | current meet-runner | ✅ real Slack card -> true Meet join verified | Keep |
| `meet-runner/src/index.ts::handleStopSession` | Stop and return beforeStop runtime | current meet-runner | ✅ manual/fixture stop verified | Re-test with auto stop |
| `meet-runner/src/session-status.ts::statusSession` | Returns active runtime state | current meet-runner status | ⚠️ status returns inMeeting/count in local draft; live count already observed via raw state | R24.11 uses this as auto-leave signal |

## ASR / Summary / Post-Meeting

| Source function | Old behavior | Go counterpart | Status | Next action |
|---|---|---|---|---|
| `asr.go::TranscribeAudio` | Audio file -> captions with `Source=asr` | none in Go `internal/postmeeting`; TS artifact pipeline has other providers but not Go live | ❌ missing in live Go path | R25 port |
| `asr.go::downsampleForASR` | ffmpeg 16k mono MP3 downsample | none | ❌ missing | R25 port with ffmpeg availability check |
| `asr.go::runASR` | provider switch: Gemini / whisper.cpp / apple-speech | none in Go live; config has no ASR provider | ❌ missing | R25: at least Gemini parity; optional old providers later |
| `asr.go::runGeminiASR` / `runGeminiASRDirect` | Upload audio/chunk and transcribe | none | ❌ missing | R25 |
| `asr.go::geminiASRConfig` / `geminiAPIKey` / `geminiModel` | Reads env/config for API key/model | no `GEMINI_API_KEY` / ASR model config in Go config | ❌ missing | R25, env/config only |
| `asr.go::writeChunkTranscript` / `readAndMergeChunkTranscripts` | Sidecar chunk transcript merge with timestamps | none | ❌ missing | R25 with artifact tests |
| `asr.go::geminiUploadFile` / `geminiGenerate` / `geminiDeleteFile` | Gemini Files API lifecycle | none | ❌ missing | R25; ensure cleanup on failure |
| `asr.go::runWhisperCPPASR` / `runAppleASR` | Alternate ASR providers | none | 🚫 not immediate; old default is Gemini | Defer unless required |
| `summary.go::NewLLMSummarizer` | LLM summary provider object | none; `postmeeting.NewPipeline` only | ❌ missing | R25 |
| `summary.go::LLMSummarizer.Summarize` | Caption transcript + ASR transcript -> structured summary JSON | `postmeeting.buildFallbackSummary` heuristic only | ❌ missing provider parity | R25: configured model/provider call; preserve JSON schema |
| `summary.go::LLMSummarizer.Calibrate` | Caption/ASR calibration before summary | none | ❌ missing | R25 after ASR port |
| `summary.go::chatLLM` | Direct chat + streaming fallback with timeouts | none | ❌ missing | R25 using configured provider/gateway; no private model ID in code/public logs |
| `summary.go::cleanResponseText` / `extractJSONCandidate` / `parseSummaryJSON` | Robust LLM output cleanup/repair | no equivalent; fallback parser not needed because no LLM call | ❌ missing | Port parser tests |
| `summary.go::buildFallbackSummary` | Fallback when LLM parse fails | `postmeeting.buildFallbackSummary` | ⚠️ fallback exists but weaker/different | Keep fallback as safety only, not primary summary |
| `postmeeting.Pipeline.PostProcess` | New Go artifact writer from given transcript | no old exact source; replaces part of old finalize | ✅ fixture transcript -> summary/action-items -> Canvas verified | Keep as downstream path |
| `service_join_finalize.go::finalizeStoppedJoin` | Direct join stop -> processing/result webhook | no old exact source; bridges new join card to old webhook contract | ✅ fixture transcript dogfood; ⚠️ auto end unverified | Re-run after R24.11 |
| `service_meetd_runtime.go::ProcessMeetdMeetingEnd` | Scheduled meeting end -> summary/result | old `processMeetingEnd` equivalent | ⚠️ heuristic summary, no ASR, empty captions silent | R25 and empty-result fix |

## Store / HTTP API

| Source function | Old behavior | Go counterpart | Status | Next action |
|---|---|---|---|---|
| `store.go::NewStore` / `migrate` | SQLite schema for meetings/captions/chat/summary/webhook state | persistence collections + `Meetd*Store`; old direct SQLite compatibility partial | ⚠️ core CRUD exists; exact SQLite schema not 1:1 | Only required if direct DB migration/cutover uses old DB files |
| `store.go::UpsertMeeting` / `GetMeeting*` / `ClaimMeetingForJoin` / `UpdateMeetingStatus` | Meeting lifecycle CRUD | `CreateMeetdMeeting`; `ClaimMeetdMeetingForJoin`; `UpdateMeetdMeetingState` | ✅/⚠️ runtime tests pass; live scheduling not dogfooded | Keep |
| `store.go::InsertCaption` / `UpdateCaptionText` / `ListCaptions*` | Caption persistence/dedupe | `AddMeetdCaption`; `ListMeetdCaptions`; direct stop reads runtime captions | ⚠️ persistence works; true live caption capture not dogfooded | R25 |
| `store.go::UpsertMeetingChat` / `ListMeetingChats*` | Meeting chat persistence | `service_meetd_chat.go` | ⚠️ tests exist; not dogfooded | Later |
| `store.go::UpsertMeetingSummary` / `SaveMeetingSummaryAndMarkDone` | Atomic summary + done | `SetMeetdMeetingSummary`; `UpdateMeetdMeetingState`; direct result webhook | ⚠️ not atomic old parity; sufficient for current dogfood | Improve if race appears |
| `httpapi.go::handleHealth` | health endpoint | `handler.go`; `pkg/contract/health.go` | ✅ live health verified | Keep |
| `httpapi.go::createMeeting` / `listMeetings` / `getMeeting` / `cancelMeeting` | MeetD REST compatibility | `handler_meetd.go`; `handler_meetd_ops.go` | ✅ tests pass; not recent live dogfood | Keep |
| `httpapi.go::redeliverMeeting` / `resummarizeMeeting` | Result redelivery/resummary | `handler_meetd_ops.go`; `LoadStoredMeetdMeetingResult`; `ProcessMeetdMeetingEnd(force)` | ⚠️ redelivery tests exist; summary provider missing | Re-test after R25 summary provider |
| `httpapi.go::sendMeetingChat` | Send chat into active meeting | `service_meetd_chat.go`; meet-runner chat bridge | ⚠️ not current acceptance | Verify before using live |
| `httpapi.go::getMeetingCaptions` / `parseCaptionSource` / `listCaptionsForSource` | Caption API and filters | `handler_meetd.go`; `ListMeetdCaptions` | ✅/⚠️ API tests; real capture unverified | R25 |
| `httpapi.go::getMeetingArtifact` / `resolveMeetingArtifactPath` | Transcript/audio artifact download | `handler_postmeeting.go`; `resolveMeetdArtifactPath` | ⚠️ transcript artifact works; audio artifact missing | R25 audio artifact |

## Product Decisions / Guardrails

- Docker default remains realtime-only and no Live2D; host-native can later restore Live2D.
- Concrete private summary model IDs must exist only in env/config/private runtime. Do not hard-code them in Go defaults, public docs, user-facing text, or channel updates.
- Fixture transcript is a test harness. It proves transcript -> summary/action-items -> Canvas. It does not prove Google Meet ASR/caption generation.
- Manual `/join/stop` is cleanup. It does not satisfy the auto empty-room leave requirement.
- A recording-meeting run is not green when only a summary appears. It must prove all five user-facing artifacts in the original Slack thread: caption count, `transcript.txt` file card, non-silent `audio.mp3` file card, Cueboard-style Canvas sections, and short Canvas notification.
- Credentialed third-party app actions (Linear/Calendar/Figma/Notion/admin/debug) were explicitly de-prioritized by tasks #106/#107 and should not block meeting lifecycle parity.

## Fix Queue From This Audit

1. **R24.11 empty-room auto leave**
   - Port participant count signal from old `getParticipantCount`.
   - Auto stop after bot is alone for 30s.
   - Same stop must trigger post-meeting result/fail-loud path.
   - Acceptance: Peng/driver host leaves, bot self-leaves, Slack thread gets summary or explicit no-transcript result.

2. **R25 ASR provider parity**
   - Add ASR config/env.
   - Port Gemini file upload/generate/delete and chunk sidecars.
   - Acceptance: fake audio/chunk -> ASR transcript artifact. No fixture transcript substitution.

3. **R25 summary provider parity**
   - Add configured summary model/provider env/config with no private model ID in code/user-visible logs.
   - Port LLM summary prompt, JSON repair, calibration.
   - Acceptance: known transcript -> configured provider call -> structured summary/action items.

4. **R25 true ASR/caption dogfood**
   - Chrome fake media or equivalent audio injection.
   - Acceptance: Slack card -> real Meet -> fake audio -> Google/ASR transcript -> summary/action-items -> Canvas/thread, with all five recording gates present (`captions.count > 0`, `transcript.txt`, non-silent `audio.mp3`, Cueboard-style Canvas, original-thread notification).

5. **Scheduled meetd end consistency**
   - Make scheduled `ProcessMeetdMeetingEnd` behave like direct join finalization for empty transcript and webhook result delivery.
   - Acceptance: scheduled meeting with no captions posts visible failure, not silent done.
