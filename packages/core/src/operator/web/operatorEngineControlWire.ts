export type OperatorEngineControlWireMessage = Record<string, unknown> & {
  type: "engine_control";
  sessionId: string;
  control: {
    type: string;
    reason: string;
    detail: Record<string, unknown>;
    responseId?: string;
  };
};

export function operatorEngineControlWireMessage(input: {
  sessionId: string;
  type: string;
  reason: string;
  detail?: Record<string, unknown>;
  responseId?: string;
}): OperatorEngineControlWireMessage {
  return {
    type: "engine_control",
    sessionId: input.sessionId,
    control: {
      type: input.type,
      reason: input.reason,
      ...(input.responseId == null ? {} : { responseId: input.responseId }),
      detail: { source: "operator_web", ...input.detail },
    },
  };
}
