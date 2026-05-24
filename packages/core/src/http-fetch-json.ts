export interface UpstreamError extends Error {
  status?: number;
  payload?: { error?: string; detail?: string; message?: string; [key: string]: unknown };
}

export type FetchJsonOptions = RequestInit & {
  timeoutMs?: number;
};

const defaultFetchJsonTimeoutMs = 20_000;

function upstreamError(message: string, status?: number, payload?: UpstreamError["payload"]) {
  const error = new Error(message) as UpstreamError;
  error.status = status;
  error.payload = payload;
  return error;
}

function parseJsonPayload(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function requestSignalWithTimeout(
  signal: AbortSignal | null | undefined,
  timeoutMs: number,
): { signal?: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal: signal || undefined, timedOut: () => false, cleanup: () => {} };
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("upstream_timeout"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

export async function fetchJson<T = Record<string, unknown>>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T> {
  const { timeoutMs = defaultFetchJsonTimeoutMs, signal, ...fetchOptions } = options;
  const requestSignal = requestSignalWithTimeout(signal, timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { ...fetchOptions, signal: requestSignal.signal });
  } catch (error) {
    if (requestSignal.timedOut()) throw upstreamError("upstream_timeout", 504);
    if (signal?.aborted) throw upstreamError("upstream_request_aborted", 499);
    throw error;
  } finally {
    requestSignal.cleanup();
  }

  const payload = parseJsonPayload(await response.text());
  if (!response.ok) {
    throw upstreamError(
      `upstream_http_${response.status}`,
      response.status,
      payload as UpstreamError["payload"],
    );
  }
  return payload as T;
}
