(() => {
  function parseRetryAfterMs(value: string | null | undefined) {
    const raw = String(value || "").trim();
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
    return 0;
  }

  function realtimeReconnectDelayMs(status: number, retryAfterMs = 0, attempt = 1) {
    const normalizedAttempt = Math.max(1, Number(attempt || 0));
    const baseMs = status === 429 ? 10000 : 1500;
    const backoffMs = Math.min(
      status === 429 ? 60000 : 30000,
      baseMs * 2 ** Math.min(normalizedAttempt - 1, 5),
    );
    const jitterMs = Math.floor(Math.random() * 400);
    return Math.max(retryAfterMs, backoffMs + jitterMs);
  }

  function formatRealtimeErrorValue(value: unknown) {
    if (!value) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function shouldRetryRealtimeConnectStatus(status: number) {
    return status === 429 || status === 408 || (status >= 500 && status <= 599);
  }

  function realtimeErrorCodeFromBody(text: string) {
    const parsed = parseJsonObject(text);
    const candidates = [
      parsed?.error?.code,
      parsed?.error?.type,
      parsed?.error?.message,
      parsed?.code,
      parsed?.type,
      parsed?.message,
      parsed?.detail?.error?.code,
      parsed?.detail?.error?.type,
      parsed?.detail?.error?.message,
    ];
    return candidates
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
      .join(" ");
  }

  function classifyRealtimeConnectFailure(status: number, bodyText: string, prefix: string) {
    const errorCode = realtimeErrorCodeFromBody(bodyText);
    if (errorCode.includes("insufficient_quota")) {
      return {
        reason: `${prefix}_insufficient_quota`,
        retryable: false,
        terminal: true,
      };
    }
    if (status === 429) {
      return {
        reason: `${prefix}_rate_limited`,
        retryable: true,
        terminal: false,
      };
    }
    return {
      reason: `${prefix}_request_failed`,
      retryable: shouldRetryRealtimeConnectStatus(status),
      terminal: false,
    };
  }

  async function readResponseText(response) {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  function parseJsonObject(text: string) {
    try {
      const value = JSON.parse(text);
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  function responseRequestId(response) {
    return (
      response.headers.get("x-request-id") ||
      response.headers.get("openai-request-id") ||
      response.headers.get("cf-ray") ||
      ""
    );
  }

  function retryAfterDetail(response) {
    const retryAfter = response.headers.get("retry-after") || "";
    return {
      retryAfter,
      retryAfterMs: parseRetryAfterMs(retryAfter),
    };
  }

  function shouldAutoConnectInCurrentDocument() {
    const href = String(window.location?.href || "");
    if (!href || href === "about:blank") return false;
    return true;
  }

  (window as any).__MAB_REALTIME_CONNECTION_HELPERS = {
    parseRetryAfterMs,
    realtimeReconnectDelayMs,
    formatRealtimeErrorValue,
    shouldRetryRealtimeConnectStatus,
    classifyRealtimeConnectFailure,
    readResponseText,
    parseJsonObject,
    responseRequestId,
    retryAfterDetail,
    shouldAutoConnectInCurrentDocument,
  };
})();
