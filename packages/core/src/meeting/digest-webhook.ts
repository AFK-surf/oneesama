import crypto from "node:crypto";

interface DigestWebhookPayload {
  event?: string;
  [key: string]: unknown;
}

interface DigestWebhookOptions {
  url?: string;
  secret?: string;
  payload?: DigestWebhookPayload;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  retryDelayMs?: number;
}

interface DigestWebhookAttempt {
  attempt: number;
  ok: boolean;
  status: number;
  body?: string;
  error?: string;
  detail?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function computeDigestWebhookSignature(body: string, secret = ""): string {
  return crypto
    .createHmac("sha256", String(secret || ""))
    .update(body)
    .digest("hex");
}

export function verifyDigestWebhookSignature(body: string, signature = "", secret = ""): boolean {
  if (!secret) return true;
  const expected = computeDigestWebhookSignature(body, secret);
  const left = Buffer.from(String(signature || ""), "hex");
  const right = Buffer.from(expected, "hex");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export async function sendDigestWebhook({
  url,
  secret = "",
  payload = {},
  fetchImpl = fetch,
  maxAttempts = 5,
  retryDelayMs = 1000,
}: DigestWebhookOptions = {}) {
  if (!url) return { ok: false, error: "webhook_url_required", attempts: 0 };
  const body = JSON.stringify(payload);
  const signature = computeDigestWebhookSignature(body, secret);
  const attempts: DigestWebhookAttempt[] = [];
  let last: DigestWebhookAttempt | null = null;

  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": signature,
          "x-meeting-avatar-event": payload.event || "meeting.digest",
        },
        body,
      });
      last = {
        attempt,
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        body: await response.text().catch(() => ""),
      };
    } catch (error) {
      last = {
        attempt,
        ok: false,
        status: 0,
        error: "request_failed",
        detail: String(error?.message || error),
      };
    }
    attempts.push(last);
    if (last.ok || attempt === Math.max(1, maxAttempts)) break;
    await delay(retryDelayMs * attempt);
  }

  return {
    ok: Boolean(last?.ok),
    attempts: attempts.length,
    status: last?.status || 0,
    error: last?.ok ? "" : last?.error || `webhook_status_${last?.status || 0}`,
    signature,
    payloadBytes: Buffer.byteLength(body),
    history: attempts,
  };
}
