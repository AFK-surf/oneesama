(() => {
  interface RealtimeToolLike {
    name?: string;
    server_label?: string;
    type?: string;
    [key: string]: unknown;
  }

  interface RealtimeSessionShape {
    type?: string;
    model?: string;
    output_modalities?: string[];
    outputModalities?: string[];
    modalities?: string[];
    audio?: {
      input?: {
        format?: Record<string, unknown>;
        turn_detection?: unknown;
        transcription?: unknown;
        [key: string]: unknown;
      };
      output?: {
        format?: Record<string, unknown>;
        voice?: string;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    turn_detection?: unknown;
    instructions?: string;
    tools?: unknown[];
    voice?: string;
    [key: string]: unknown;
  }

  interface BuildSessionUpdateOptions {
    session?: RealtimeSessionShape & { schema?: string; session_schema?: string };
    instructions?: string;
    tools?: RealtimeToolLike[];
    toolChoice?: string;
    sessionSchema?: string;
  }

  function normalizeToolNames(tools: RealtimeToolLike[] = []): string[] {
    return tools
      .map((tool) => tool?.name || tool?.server_label || tool?.type || "")
      .filter(Boolean);
  }

  function isLegacyRealtimeSessionSchema(value: unknown): boolean {
    return ["legacy", "v1", "1", "1.5", "realtime-1.5"].includes(String(value || "").toLowerCase());
  }

  function normalizeTurnDetectionConfig(value: unknown) {
    if (value === null) return null;
    if (typeof value === "object" && value !== undefined) {
      return { ...(value as Record<string, unknown>) };
    }
    const normalized = String(value || "").trim();
    if (!normalized || normalized === "none") return null;
    if (normalized.startsWith("{")) {
      try {
        const parsed = JSON.parse(normalized);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { ...parsed };
        }
      } catch {
        // Fall through to treating the value as a literal turn_detection type.
      }
    }
    switch (normalized.toLowerCase()) {
      case "steady":
        return { type: "semantic_vad", eagerness: "low" };
      case "balanced":
        return { type: "semantic_vad", eagerness: "auto" };
      case "fast":
        return { type: "semantic_vad", eagerness: "high" };
    }
    return { type: normalized };
  }

  function defaultRealtimeTruncation(value: unknown) {
    if (value !== undefined && value !== null && value !== "") return value;
    return {
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: {
        post_instructions: 8000,
      },
    };
  }

  function defaultRealtime2Session(session: RealtimeSessionShape = {}): RealtimeSessionShape {
    const merged: RealtimeSessionShape & {
      reasoning?: { effort?: string };
      voice?: string;
    } = { ...session };
    merged.type = merged.type || "realtime";
    merged.model = merged.model || "gpt-realtime-2";
    merged.output_modalities = merged.output_modalities ||
      merged.outputModalities ||
      merged.modalities || ["audio"];
    delete merged.outputModalities;
    delete merged.modalities;
    const inputTurnDetection =
      merged.audio?.input?.turn_detection ?? merged.turn_detection ?? "steady";
    merged.truncation = defaultRealtimeTruncation((merged as Record<string, unknown>).truncation);
    merged.audio = {
      ...(merged.audio || {}),
      input: {
        ...(merged.audio?.input || {}),
        format: {
          type: "audio/pcm",
          rate: 24000,
          ...(merged.audio?.input?.format || {}),
        },
        turn_detection: normalizeTurnDetectionConfig(inputTurnDetection),
      },
      output: {
        ...(merged.audio?.output || {}),
        format: {
          type: "audio/pcm",
          rate: 24000,
          ...(merged.audio?.output?.format || {}),
        },
        voice: merged.audio?.output?.voice || merged.voice || "marin",
      },
    };
    delete merged.voice;
    delete merged.turn_detection;
    if (!merged.reasoning && String(merged.model || "").includes("gpt-realtime-2")) {
      merged.reasoning = { effort: "high" };
    }
    return merged;
  }

  function buildSessionUpdateEvent(options: BuildSessionUpdateOptions = {}) {
    const schema = String(
      options.session?.schema ||
        options.session?.session_schema ||
        options.sessionSchema ||
        "realtime-2",
    ).toLowerCase();
    const session: RealtimeSessionShape & {
      schema?: string;
      session_schema?: string;
      tool_choice?: string;
    } = isLegacyRealtimeSessionSchema(schema)
      ? { ...(options.session || {}) }
      : defaultRealtime2Session(options.session || {});
    delete session.schema;
    delete session.session_schema;
    const instructions = options.instructions ?? session.instructions;
    const tools = Array.isArray(options.tools) ? options.tools : session.tools;
    if (instructions) session.instructions = instructions;
    if (Array.isArray(tools) && tools.length) session.tools = tools;
    if (options.toolChoice) session.tool_choice = options.toolChoice;
    return {
      type: "session.update" as const,
      session,
    };
  }

  (window as any).__MAB_REALTIME_SESSION_HELPERS = {
    normalizeToolNames,
    defaultRealtime2Session,
    buildSessionUpdateEvent,
  };
})();
