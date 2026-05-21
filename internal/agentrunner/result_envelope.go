package agentrunner

import "strings"

const (
	WorkerResultEnvelopeSchema             = "oneesama.worker_result.v1"
	defaultWorkerResultEnvelopeMaxResult   = 12000
	defaultWorkerResultEnvelopeMaxError    = 1200
	defaultWorkerResultEnvelopeMaxSummary  = 240
	workerResultEnvelopeTruncationSuffix   = "\n\n[worker result truncated]"
	workerResultEnvelopeUnknownFailureText = "worker did not complete"
)

type WorkerResultEnvelope struct {
	Schema      string      `json:"schema"`
	JobID       string      `json:"job_id,omitempty"`
	Provider    string      `json:"provider,omitempty"`
	Mode        string      `json:"mode,omitempty"`
	Status      JobStatus   `json:"status"`
	FailureCode FailureCode `json:"failure_code,omitempty"`
	Summary     string      `json:"summary,omitempty"`
	Result      string      `json:"result,omitempty"`
	Error       string      `json:"error,omitempty"`
	ResultChars int         `json:"result_chars,omitempty"`
	ErrorChars  int         `json:"error_chars,omitempty"`
	Truncated   bool        `json:"truncated,omitempty"`
	Source      string      `json:"source,omitempty"`
}

type WorkerResultEnvelopeOptions struct {
	MaxResultRunes  int
	MaxErrorRunes   int
	MaxSummaryRunes int
	Source          string
}

func NewWorkerResultEnvelope(job Job) WorkerResultEnvelope {
	return BuildWorkerResultEnvelope(job, WorkerResultEnvelopeOptions{})
}

func BuildWorkerResultEnvelope(job Job, options WorkerResultEnvelopeOptions) WorkerResultEnvelope {
	options = normalizeWorkerResultEnvelopeOptions(options)
	result := strings.TrimSpace(job.Result)
	errText := strings.TrimSpace(job.Error)
	envelope := WorkerResultEnvelope{
		Schema:      WorkerResultEnvelopeSchema,
		JobID:       strings.TrimSpace(job.ID),
		Provider:    strings.TrimSpace(job.Provider),
		Mode:        strings.TrimSpace(job.Mode),
		Status:      job.Status,
		FailureCode: job.FailureCode,
		ResultChars: len([]rune(result)),
		ErrorChars:  len([]rune(errText)),
		Source:      strings.TrimSpace(options.Source),
	}
	if envelope.Status == "" {
		envelope.Status = StatusQueued
	}
	if envelope.Source == "" {
		envelope.Source = "agentrunner"
	}
	if envelope.Status == StatusCompleted {
		envelope.Result, envelope.Truncated = truncateWorkerResultEnvelopeText(result, options.MaxResultRunes, workerResultEnvelopeTruncationSuffix)
		envelope.Summary = truncateWorkerResultEnvelopeTextNoMarker(firstWorkerResultEnvelopeLine(envelope.Result), options.MaxSummaryRunes)
		return envelope
	}
	envelope.Error, envelope.Truncated = truncateWorkerResultEnvelopeText(firstNonEmptyEnvelope(errText, string(job.FailureCode), workerResultEnvelopeUnknownFailureText), options.MaxErrorRunes, workerResultEnvelopeTruncationSuffix)
	envelope.Summary = truncateWorkerResultEnvelopeTextNoMarker(firstWorkerResultEnvelopeLine(envelope.Error), options.MaxSummaryRunes)
	return envelope
}

func NormalizeWorkerResultEnvelope(envelope WorkerResultEnvelope, options WorkerResultEnvelopeOptions) WorkerResultEnvelope {
	options = normalizeWorkerResultEnvelopeOptions(options)
	envelope.Schema = firstNonEmptyEnvelope(strings.TrimSpace(envelope.Schema), WorkerResultEnvelopeSchema)
	envelope.JobID = strings.TrimSpace(envelope.JobID)
	envelope.Provider = strings.TrimSpace(envelope.Provider)
	envelope.Mode = strings.TrimSpace(envelope.Mode)
	envelope.Source = firstNonEmptyEnvelope(strings.TrimSpace(envelope.Source), strings.TrimSpace(options.Source), "agentrunner")
	if envelope.Status == "" {
		envelope.Status = StatusQueued
	}
	envelope.Result = strings.TrimSpace(envelope.Result)
	envelope.Error = strings.TrimSpace(envelope.Error)
	envelope.Summary = strings.TrimSpace(envelope.Summary)
	envelope.ResultChars = maxEnvelopeInt(envelope.ResultChars, len([]rune(envelope.Result)))
	envelope.ErrorChars = maxEnvelopeInt(envelope.ErrorChars, len([]rune(envelope.Error)))
	if envelope.Status == StatusCompleted {
		result, truncated := truncateWorkerResultEnvelopeText(envelope.Result, options.MaxResultRunes, workerResultEnvelopeTruncationSuffix)
		envelope.Result = result
		envelope.Error = ""
		envelope.Truncated = envelope.Truncated || truncated
		if envelope.Summary == "" {
			envelope.Summary = firstWorkerResultEnvelopeLine(envelope.Result)
		}
	} else {
		envelope.Result = ""
		errText := firstNonEmptyEnvelope(envelope.Error, string(envelope.FailureCode), workerResultEnvelopeUnknownFailureText)
		errText, truncated := truncateWorkerResultEnvelopeText(errText, options.MaxErrorRunes, workerResultEnvelopeTruncationSuffix)
		envelope.Error = errText
		envelope.Truncated = envelope.Truncated || truncated
		if envelope.Summary == "" {
			envelope.Summary = firstWorkerResultEnvelopeLine(envelope.Error)
		}
	}
	envelope.Summary = truncateWorkerResultEnvelopeTextNoMarker(envelope.Summary, options.MaxSummaryRunes)
	return envelope
}

func WorkerResultEnvelopeCompletedText(envelope WorkerResultEnvelope) string {
	if envelope.Status != StatusCompleted {
		return ""
	}
	return strings.TrimSpace(envelope.Result)
}

func normalizeWorkerResultEnvelopeOptions(options WorkerResultEnvelopeOptions) WorkerResultEnvelopeOptions {
	if options.MaxResultRunes <= 0 {
		options.MaxResultRunes = defaultWorkerResultEnvelopeMaxResult
	}
	if options.MaxErrorRunes <= 0 {
		options.MaxErrorRunes = defaultWorkerResultEnvelopeMaxError
	}
	if options.MaxSummaryRunes <= 0 {
		options.MaxSummaryRunes = defaultWorkerResultEnvelopeMaxSummary
	}
	return options
}

func truncateWorkerResultEnvelopeText(value string, maxRunes int, suffix string) (string, bool) {
	trimmed := strings.TrimSpace(value)
	if maxRunes <= 0 || len([]rune(trimmed)) <= maxRunes {
		return trimmed, false
	}
	suffix = strings.TrimSpace(suffix)
	if suffix == "" {
		suffix = "..."
	}
	suffixRunes := []rune(suffix)
	limit := maxRunes - len(suffixRunes) - 2
	if limit < 1 {
		limit = maxRunes
		return strings.TrimSpace(string([]rune(trimmed)[:limit])), true
	}
	return strings.TrimSpace(string([]rune(trimmed)[:limit])) + "\n\n" + suffix, true
}

func truncateWorkerResultEnvelopeTextNoMarker(value string, maxRunes int) string {
	trimmed := strings.TrimSpace(value)
	if maxRunes <= 0 || len([]rune(trimmed)) <= maxRunes {
		return trimmed
	}
	runes := []rune(trimmed)
	if maxRunes == 1 {
		return "…"
	}
	return strings.TrimSpace(string(runes[:maxRunes-1])) + "…"
}

func firstWorkerResultEnvelopeLine(value string) string {
	for _, line := range strings.Split(strings.TrimSpace(value), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" && !strings.HasPrefix(trimmed, "[worker result truncated]") {
			return trimmed
		}
	}
	return ""
}

func firstNonEmptyEnvelope(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func maxEnvelopeInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
