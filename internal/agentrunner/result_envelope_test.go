package agentrunner

import (
	"strings"
	"testing"
)

func TestWorkerResultEnvelopeBoundsCompletedResult(t *testing.T) {
	job := Job{
		ID:       "job_123",
		Provider: "codex",
		Mode:     "analysis",
		Status:   StatusCompleted,
		Result:   "第一行结论\n" + strings.Repeat("长内容", 20),
	}

	envelope := BuildWorkerResultEnvelope(job, WorkerResultEnvelopeOptions{MaxResultRunes: 32, MaxSummaryRunes: 12})
	if envelope.Schema != WorkerResultEnvelopeSchema {
		t.Fatalf("Schema = %q, want %q", envelope.Schema, WorkerResultEnvelopeSchema)
	}
	if envelope.JobID != "job_123" || envelope.Provider != "codex" || envelope.Mode != "analysis" {
		t.Fatalf("metadata = %#v, want job metadata", envelope)
	}
	if !envelope.Truncated {
		t.Fatal("Truncated = false, want true for long result")
	}
	if !strings.Contains(envelope.Result, "[worker result truncated]") {
		t.Fatalf("Result = %q, want truncation marker", envelope.Result)
	}
	if strings.Contains(envelope.Result, strings.Repeat("长内容", 20)) {
		t.Fatalf("Result was not bounded: %q", envelope.Result)
	}
	if envelope.Summary != "第一行结论" {
		t.Fatalf("Summary = %q, want first line", envelope.Summary)
	}
}

func TestWorkerResultEnvelopeDoesNotExposePartialResultForFailures(t *testing.T) {
	job := Job{
		ID:          "job_timeout",
		Status:      StatusTimeout,
		FailureCode: FailureTimeout,
		Result:      "partial: started reading private scratch logs",
		Error:       "job timed out after 120s",
	}

	envelope := NewWorkerResultEnvelope(job)
	if envelope.Result != "" {
		t.Fatalf("Result = %q, want empty for non-completed worker", envelope.Result)
	}
	if envelope.Error != "job timed out after 120s" {
		t.Fatalf("Error = %q, want bounded error", envelope.Error)
	}
	if envelope.ResultChars == 0 {
		t.Fatal("ResultChars = 0, want raw length metadata without raw partial text")
	}
	if WorkerResultEnvelopeCompletedText(envelope) != "" {
		t.Fatalf("completed text = %q, want empty for timeout", WorkerResultEnvelopeCompletedText(envelope))
	}
}

func TestNormalizeWorkerResultEnvelopeDefendsInput(t *testing.T) {
	input := WorkerResultEnvelope{
		Status: StatusFailed,
		Result: "raw partial should be dropped",
	}

	envelope := NormalizeWorkerResultEnvelope(input, WorkerResultEnvelopeOptions{})
	if envelope.Schema != WorkerResultEnvelopeSchema {
		t.Fatalf("Schema = %q, want default schema", envelope.Schema)
	}
	if envelope.Source != "agentrunner" {
		t.Fatalf("Source = %q, want default source", envelope.Source)
	}
	if envelope.Result != "" {
		t.Fatalf("Result = %q, want non-completed normalized result dropped", envelope.Result)
	}
	if envelope.Error != workerResultEnvelopeUnknownFailureText {
		t.Fatalf("Error = %q, want fallback failure text", envelope.Error)
	}
}
