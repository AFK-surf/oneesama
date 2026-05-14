package slackagent

import (
	"testing"
	"time"
)

func TestSignSlackRequestBody(t *testing.T) {
	got := SignSlackRequestBody("secret", "1715550000", "token=abc")
	want := "v0=6fee27ffd5e74e067febe725f3ccbfbb9c3bbafaeb7d35b67669a1086d7d044b"
	if got != want {
		t.Fatalf("SignSlackRequestBody() = %q, want %q", got, want)
	}
}

func TestVerifySlackRequestSkipsWithoutSecret(t *testing.T) {
	result := VerifySlackRequest(VerifySlackRequestOptions{})
	if !result.OK || !result.Skipped || result.Reason != "missing_signing_secret" {
		t.Fatalf("VerifySlackRequest() = %#v", result)
	}
}

func TestVerifySlackRequestRejectsInvalidTimestamp(t *testing.T) {
	result := VerifySlackRequest(VerifySlackRequestOptions{
		SigningSecret: "secret",
		Timestamp:     "nope",
		Signature:     "v0=abc",
		RawBody:       "token=abc",
	})
	if result.OK || result.Reason != "missing_or_invalid_timestamp" {
		t.Fatalf("VerifySlackRequest() = %#v", result)
	}
}

func TestVerifySlackRequestRejectsStaleTimestamp(t *testing.T) {
	result := VerifySlackRequest(VerifySlackRequestOptions{
		SigningSecret: "secret",
		Timestamp:     "1715550000",
		Signature:     "v0=abc",
		RawBody:       "token=abc",
		Now:           time.Unix(1715550000, 0).Add(10 * time.Minute),
	})
	if result.OK || result.Reason != "stale_timestamp" {
		t.Fatalf("VerifySlackRequest() = %#v", result)
	}
}

func TestVerifySlackRequestRejectsInvalidSignaturePrefix(t *testing.T) {
	result := VerifySlackRequest(VerifySlackRequestOptions{
		SigningSecret: "secret",
		Timestamp:     "1715550000",
		Signature:     "abc",
		RawBody:       "token=abc",
		Now:           time.Unix(1715550000, 0),
	})
	if result.OK || result.Reason != "missing_or_invalid_signature" {
		t.Fatalf("VerifySlackRequest() = %#v", result)
	}
}

func TestVerifySlackRequestRejectsMismatch(t *testing.T) {
	result := VerifySlackRequest(VerifySlackRequestOptions{
		SigningSecret: "secret",
		Timestamp:     "1715550000",
		Signature:     "v0=bad",
		RawBody:       "token=abc",
		Now:           time.Unix(1715550000, 0),
	})
	if result.OK || result.Reason != "signature_mismatch" {
		t.Fatalf("VerifySlackRequest() = %#v", result)
	}
}

func TestVerifySlackRequestAcceptsValidRequest(t *testing.T) {
	timestamp := "1715550000"
	rawBody := "token=abc"
	signature := SignSlackRequestBody("secret", timestamp, rawBody)

	result := VerifySlackRequest(VerifySlackRequestOptions{
		SigningSecret: "secret",
		Timestamp:     timestamp,
		Signature:     signature,
		RawBody:       rawBody,
		Now:           time.Unix(1715550000, 0),
	})
	if !result.OK || result.Skipped || result.Reason != "" {
		t.Fatalf("VerifySlackRequest() = %#v", result)
	}
}
