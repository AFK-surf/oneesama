export const PUSH_TO_TALK_START_REASON = "operator_web_ptt_start";
export const PUSH_TO_TALK_FAILED_REASON = "operator_web_ptt_failed";
export const PUSH_TO_TALK_FINISH_REASON = "operator_web_ptt_finish";

export interface PushToTalkMuteDecision {
  muted: boolean;
  reason: string;
}

export interface BeginPushToTalkInput {
  active: boolean;
  muted: boolean;
  micOn: boolean;
}

export interface BeginPushToTalkDecision {
  shouldActivate: boolean;
  shouldStartMic: boolean;
  previousMuted: boolean;
  startedMic: boolean;
  mute: PushToTalkMuteDecision | null;
}

export interface FinishPushToTalkInput {
  active: boolean;
  previousMuted: boolean;
  startedMic: boolean;
}

export interface FinishPushToTalkDecision {
  shouldDeactivate: boolean;
  mute: PushToTalkMuteDecision | null;
}

export function beginPushToTalk(input: BeginPushToTalkInput): BeginPushToTalkDecision {
  if (input.active) {
    return {
      shouldActivate: false,
      shouldStartMic: false,
      previousMuted: input.muted,
      startedMic: false,
      mute: null,
    };
  }

  const startedMic = !input.micOn;
  return {
    shouldActivate: true,
    shouldStartMic: startedMic,
    previousMuted: input.muted,
    startedMic,
    mute: {
      muted: false,
      reason: PUSH_TO_TALK_START_REASON,
    },
  };
}

export function failPushToTalk(previousMuted: boolean): PushToTalkMuteDecision {
  return {
    muted: previousMuted,
    reason: PUSH_TO_TALK_FAILED_REASON,
  };
}

export function finishPushToTalk(input: FinishPushToTalkInput): FinishPushToTalkDecision {
  if (!input.active) {
    return {
      shouldDeactivate: false,
      mute: null,
    };
  }

  return {
    shouldDeactivate: true,
    mute: {
      muted: input.startedMic ? true : input.previousMuted,
      reason: PUSH_TO_TALK_FINISH_REASON,
    },
  };
}
