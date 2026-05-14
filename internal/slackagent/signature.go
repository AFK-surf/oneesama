package slackagent

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const defaultSlackRequestMaxAge = 5 * time.Minute

type VerifySlackRequestOptions struct {
	SigningSecret string
	Timestamp     string
	Signature     string
	RawBody       string
	Now           time.Time
	MaxAge        time.Duration
}

type SlackRequestVerification struct {
	OK      bool
	Skipped bool
	Reason  string
}

func SignSlackRequestBody(signingSecret string, timestamp string, rawBody string) string {
	mac := hmac.New(sha256.New, []byte(signingSecret))
	_, _ = mac.Write([]byte(fmt.Sprintf("v0:%s:%s", timestamp, rawBody)))
	return "v0=" + hex.EncodeToString(mac.Sum(nil))
}

func VerifySlackRequest(options VerifySlackRequestOptions) SlackRequestVerification {
	signingSecret := strings.TrimSpace(options.SigningSecret)
	if signingSecret == "" {
		return SlackRequestVerification{
			OK:      true,
			Skipped: true,
			Reason:  "missing_signing_secret",
		}
	}

	requestTimestamp, err := strconv.ParseInt(strings.TrimSpace(options.Timestamp), 10, 64)
	if err != nil {
		return SlackRequestVerification{Reason: "missing_or_invalid_timestamp"}
	}

	now := options.Now
	if now.IsZero() {
		now = time.Now()
	}
	maxAge := options.MaxAge
	if maxAge <= 0 {
		maxAge = defaultSlackRequestMaxAge
	}

	if delta := now.Sub(time.Unix(requestTimestamp, 0)); delta > maxAge || delta < -maxAge {
		return SlackRequestVerification{Reason: "stale_timestamp"}
	}

	signature := strings.TrimSpace(options.Signature)
	if !strings.HasPrefix(signature, "v0=") {
		return SlackRequestVerification{Reason: "missing_or_invalid_signature"}
	}

	expected := SignSlackRequestBody(signingSecret, options.Timestamp, options.RawBody)
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return SlackRequestVerification{Reason: "signature_mismatch"}
	}

	return SlackRequestVerification{OK: true}
}
