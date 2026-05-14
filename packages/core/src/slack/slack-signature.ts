import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_AGE_SECONDS = 60 * 5;

export interface SignSlackRequestBodyArgs {
  signingSecret: string;
  timestamp: string | number;
  rawBody: string;
}

export function signSlackRequestBody({
  signingSecret,
  timestamp,
  rawBody,
}: SignSlackRequestBodyArgs): string {
  const base = `v0:${timestamp}:${rawBody}`;
  const digest = createHmac("sha256", signingSecret).update(base).digest("hex");
  return `v0=${digest}`;
}

export interface VerifySlackRequestOptions {
  signingSecret?: string;
  timestamp?: string | number;
  signature?: string;
  rawBody?: string;
  nowSeconds?: number;
  maxAgeSeconds?: number;
}

export function verifySlackRequest(options: VerifySlackRequestOptions = {}) {
  const {
    signingSecret = "",
    timestamp = "",
    signature = "",
    rawBody = "",
    nowSeconds = Math.floor(Date.now() / 1000),
    maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
  } = options;

  if (!signingSecret) {
    return { ok: true, skipped: true, reason: "missing_signing_secret" };
  }

  const requestTimestamp = Number.parseInt(String(timestamp), 10);
  if (!Number.isFinite(requestTimestamp)) {
    return { ok: false, error: "missing_or_invalid_timestamp" };
  }

  if (Math.abs(nowSeconds - requestTimestamp) > maxAgeSeconds) {
    return { ok: false, error: "stale_timestamp" };
  }

  if (!signature.startsWith("v0=")) {
    return { ok: false, error: "missing_or_invalid_signature" };
  }

  const expected = signSlackRequestBody({ signingSecret, timestamp, rawBody: rawBody || "" });
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length) {
    return { ok: false, error: "signature_mismatch" };
  }

  if (!timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { ok: false, error: "signature_mismatch" };
  }

  return { ok: true, skipped: false };
}
