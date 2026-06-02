#!/usr/bin/env node
import { printHelp } from "./cli/common.js";
import {
  doctor,
  smoke,
  agentProviderSmoke,
  agentRealTaskSmoke,
  claudeProviderSmoke,
} from "./cli/providers.js";
import {
  codexAppServerProviderSmoke,
  ollamaProviderSmoke,
  slackAgentDProviderSmoke,
} from "./cli/providers-extra.js";
import {
  slackLiveCapabilitySmoke,
  slackLiveSocketSmoke,
  slackMemorySeed,
  slackMemorySmoke,
} from "./cli/slack-live.js";
import {
  localAgentDialogSmoke,
  captionLocalDialogSmoke,
  realLocalDialogSmoke,
  dialogProviderSmoke,
  postMeetingSmoke,
} from "./cli/dialog-post-meeting.js";
import {
  meetdApiCompatSmoke,
  meetdRuntimeStoreSmoke,
  digestWebhookSmoke,
  meetingCopilotSmoke,
} from "./cli/meetd-digest.js";
import {
  canvasPublisherSmoke,
  slackMrkdwnRendererSmoke,
  slackAssistantScheduleSmoke,
  slackAssistantScheduleServiceSmoke,
  slackWorkspaceBootstrapSmoke,
} from "./cli/slack-assistant.js";
import { slackInstallSmoke, slackToolRegistrySmoke } from "./cli/slack-registry.js";
import { slackDomainStoreSmoke, slackTriageFlowSmoke } from "./cli/slack-domain-triage.js";
import {
  avatarSmoke,
  realtimeSmoke,
  meetSmoke,
  meetContractSmoke,
  screenShareSmoke,
  realMeetSmoke,
  persistenceSmoke,
} from "./cli/runtime-basic.js";
import {
  stateProviderSmoke,
  workerBridgeSmoke,
  realtimeBrowserSmoke,
  realtimeWebrtcSmoke,
  realtimeAudioRouteSmoke,
  realtimeParticipantAudioSmoke,
  realtimeRepeatGuardSmoke,
} from "./cli/realtime-basic.js";
import {
  realtimeSessionUpdateSmoke,
  realtimeWorkerToolSmoke,
  realtimeLiveToolSmoke,
  realtimeLiveRoutingSmoke,
} from "./cli/realtime-tools.js";
import {
  avatarStateSmoke,
  avatarVisualSmoke,
  avatarVRMSmoke,
  hiyoriLive2dSmoke,
  runtimeAcceptanceSmoke,
  realtimeSdkSmoke,
  realtimeSdpSmoke,
} from "./cli/avatar-runtime.js";
import {
  slackResultSmoke,
  slackPostingSmoke,
  cutoverShadowSmoke,
  cutoverRollbackSmoke,
  shadowParitySmoke,
  shadowTapSmoke,
  shadowTransmitterSmoke,
} from "./cli/slack-cutover.js";
import {
  shadowTransmitterHook,
  cutoverEvidenceBundle,
  cutoverEvidenceSmoke,
} from "./cli/support.js";
import { slackContractSmoke } from "./cli/slack-contract.js";
import { slackSmoke } from "./cli/slack-smoke.js";
import { meetLiveAcceptance } from "./cli/meet-live-acceptance.js";

const command = process.argv[2] || "help";
const commands: Record<string, () => Promise<void> | void> = {
  doctor,
  smoke,
  "agent-provider-smoke": agentProviderSmoke,
  "agent-real-task-smoke": agentRealTaskSmoke,
  "claude-provider-smoke": claudeProviderSmoke,
  "codex-app-server-provider-smoke": codexAppServerProviderSmoke,
  "ollama-provider-smoke": ollamaProviderSmoke,
  "slack-agent-d-provider-smoke": slackAgentDProviderSmoke,
  "slack-live-capability-smoke": slackLiveCapabilitySmoke,
  "slack-live-socket-smoke": slackLiveSocketSmoke,
  "slack-memory-seed": slackMemorySeed,
  "slack-memory-smoke": slackMemorySmoke,
  "local-agent-dialog-smoke": localAgentDialogSmoke,
  "caption-local-dialog-smoke": captionLocalDialogSmoke,
  "dialog-provider-smoke": dialogProviderSmoke,
  "post-meeting-smoke": postMeetingSmoke,
  "meetd-api-compat-smoke": meetdApiCompatSmoke,
  "meetd-runtime-store-smoke": meetdRuntimeStoreSmoke,
  "digest-webhook-smoke": digestWebhookSmoke,
  "meeting-copilot-smoke": meetingCopilotSmoke,
  "canvas-publisher-smoke": canvasPublisherSmoke,
  "slack-mrkdwn-renderer-smoke": slackMrkdwnRendererSmoke,
  "slack-assistant-schedule-smoke": slackAssistantScheduleSmoke,
  "slack-assistant-schedule-service-smoke": slackAssistantScheduleServiceSmoke,
  "slack-workspace-bootstrap-smoke": slackWorkspaceBootstrapSmoke,
  "slack-install-smoke": slackInstallSmoke,
  "slack-tool-registry-smoke": slackToolRegistrySmoke,
  "slack-domain-store-smoke": slackDomainStoreSmoke,
  "slack-triage-flow-smoke": slackTriageFlowSmoke,
  "state-provider-smoke": stateProviderSmoke,
  "avatar-smoke": avatarSmoke,
  "realtime-smoke": realtimeSmoke,
  "meet-smoke": meetSmoke,
  "meet-contract-smoke": meetContractSmoke,
  "screen-share-smoke": screenShareSmoke,
  "real-meet-smoke": realMeetSmoke,
  "real-local-dialog-smoke": realLocalDialogSmoke,
  "persistence-smoke": persistenceSmoke,
  "worker-bridge-smoke": workerBridgeSmoke,
  "realtime-browser-smoke": realtimeBrowserSmoke,
  "realtime-webrtc-smoke": realtimeWebrtcSmoke,
  "realtime-participant-audio-smoke": realtimeParticipantAudioSmoke,
  "realtime-audio-route-smoke": realtimeAudioRouteSmoke,
  "realtime-repeat-guard-smoke": realtimeRepeatGuardSmoke,
  "realtime-session-update-smoke": realtimeSessionUpdateSmoke,
  "realtime-worker-tool-smoke": realtimeWorkerToolSmoke,
  "realtime-live-tool-smoke": realtimeLiveToolSmoke,
  "realtime-live-routing-smoke": realtimeLiveRoutingSmoke,
  "avatar-state-smoke": avatarStateSmoke,
  "avatar-visual-smoke": avatarVisualSmoke,
  "avatar-vrm-smoke": avatarVRMSmoke,
  "hiyori-live2d-smoke": hiyoriLive2dSmoke,
  "runtime-acceptance-smoke": runtimeAcceptanceSmoke,
  "slack-result-smoke": slackResultSmoke,
  "slack-posting-smoke": slackPostingSmoke,
  "slack-contract-smoke": slackContractSmoke,
  "cutover-shadow-smoke": cutoverShadowSmoke,
  "cutover-rollback-smoke": cutoverRollbackSmoke,
  "shadow-parity-smoke": shadowParitySmoke,
  "shadow-tap-smoke": shadowTapSmoke,
  "shadow-transmitter-smoke": shadowTransmitterSmoke,
  "shadow-transmitter-hook": shadowTransmitterHook,
  "cutover-evidence-bundle": cutoverEvidenceBundle,
  "cutover-evidence-smoke": cutoverEvidenceSmoke,
  "realtime-sdk-smoke": realtimeSdkSmoke,
  "realtime-sdp-smoke": realtimeSdpSmoke,
  "slack-smoke": slackSmoke,
  "meet-live-acceptance": meetLiveAcceptance,
};

await (commands[command] || printHelp)();
