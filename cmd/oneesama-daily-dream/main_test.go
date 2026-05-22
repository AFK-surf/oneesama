package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunDailyDreamDryRunPrintsCandidates(t *testing.T) {
	input := strings.Join([]string{
		`{"source":"approval_card","reason_code":"missing_evidence_anchor","proposed_action":"gate_fixture","subject":"visible_reply_quality","source_type":"approval_card","refs":["slack:C1/100"],"content":"missing source"}`,
		`{"source":"triage_sweep","reason_code":"missing_evidence_anchor","proposed_action":"gate_fixture","subject":"visible_reply_quality","source_type":"approval_card","refs":["sweep:100"],"content":"shadow block"}`,
	}, "\n")
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	code := run([]string{"--date", "2026-05-22"}, strings.NewReader(input), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("run exit = %d stderr=%s", code, stderr.String())
	}
	if output := stdout.String(); !strings.Contains(output, "Oneesama Daily Dream Candidates") ||
		!strings.Contains(output, "visible_reply_quality|missing_evidence_anchor|approval_card|gate_fixture") ||
		!strings.Contains(output, "Review notes: repeated_pattern") {
		t.Fatalf("stdout = %q, want repeated dream candidate", output)
	}
	if !strings.Contains(stderr.String(), "daily dream dry-run: signals=2 candidates=1") {
		t.Fatalf("stderr = %q, want dry-run summary", stderr.String())
	}
}

func TestRunDailyDreamRejectsBadNDJSON(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	code := run(nil, strings.NewReader(`{"source":`), &stdout, &stderr)
	if code != 1 || !strings.Contains(stderr.String(), "read signals") {
		t.Fatalf("exit=%d stdout=%q stderr=%q, want read error", code, stdout.String(), stderr.String())
	}
}
