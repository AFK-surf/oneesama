package slackagent

import (
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	slackMemoryFactKindPersonProfile      = "person_profile"
	slackMemoryFactKindTeamFact           = "team_fact"
	slackMemoryFactKindTeamDecision       = "team_decision"
	slackMemoryFactKindTeamAction         = "team_action"
	slackMemoryFactKindEpisode            = "episode"
	slackMemoryFactKindWorkerResult       = "worker_result"
	slackMemoryFactKindForegroundIdentity = "foreground_identity"
	slackMemoryFactKindLesson             = "lesson"

	slackMemoryFactScopeForeground = "foreground"
	slackMemoryFactScopeWorker     = "worker"
	slackMemoryFactScopeSlack      = "slack"
	slackMemoryFactScopePerson     = "person"
	slackMemoryFactScopeTeam       = "team"

	slackMemoryFactStatusActive              = "active"
	slackMemoryFactStatusContradictionReview = "contradiction_review"

	slackMemoryStalenessFresh   = "fresh"
	slackMemoryStalenessAging   = "aging"
	slackMemoryStalenessStale   = "stale"
	slackMemoryStalenessExpired = "expired"

	slackMemoryLowTrustThreshold = 0.5
)

type SlackMemoryFact struct {
	ID                string                     `json:"id"`
	Kind              string                     `json:"kind"`
	SourceKind        string                     `json:"sourceKind,omitempty"`
	Subject           string                     `json:"subject,omitempty"`
	Scope             string                     `json:"scope"`
	AppliesTo         []string                   `json:"appliesTo,omitempty"`
	DoNotGeneralizeTo []string                   `json:"doNotGeneralizeTo,omitempty"`
	Content           string                     `json:"content"`
	SourceRefs        []string                   `json:"sourceRefs"`
	Trust             SlackMemoryFactTrust       `json:"trust"`
	Staleness         SlackMemoryFactStaleness   `json:"staleness"`
	Status            string                     `json:"status"`
	Supersedes        []string                   `json:"supersedes,omitempty"`
	SupersededBy      string                     `json:"supersededBy,omitempty"`
	Contradictions    []SlackMemoryContradiction `json:"contradictions,omitempty"`
}

type SlackMemoryFactTrust struct {
	Score  float64 `json:"score"`
	Reason string  `json:"reason"`
}

type SlackMemoryFactStaleness struct {
	Status      string `json:"status"`
	AgeDays     int    `json:"ageDays"`
	HorizonDays int    `json:"horizonDays"`
	Reason      string `json:"reason,omitempty"`
}

type SlackMemoryContradiction struct {
	FactID string `json:"factId"`
	Reason string `json:"reason"`
}

type SlackMemoryQualityAuditSummary struct {
	TotalCount           int                             `json:"totalCount"`
	MeanTrust            float64                         `json:"meanTrust"`
	MeanStalenessAgeDays float64                         `json:"meanStalenessAgeDays"`
	LowTrustCount        int                             `json:"lowTrustCount"`
	StaleCount           int                             `json:"staleCount"`
	ExpiredCount         int                             `json:"expiredCount"`
	ByKind               []SlackMemoryQualityKindSummary `json:"byKind"`
}

type SlackMemoryQualityKindSummary struct {
	Kind                 string  `json:"kind"`
	Count                int     `json:"count"`
	MeanTrust            float64 `json:"meanTrust"`
	MeanStalenessAgeDays float64 `json:"meanStalenessAgeDays"`
	LowTrustCount        int     `json:"lowTrustCount"`
	StaleCount           int     `json:"staleCount"`
	ExpiredCount         int     `json:"expiredCount"`
}

func SlackMemoryFactFromRelatedMemoryRecord(record SlackRelatedMemoryRecord, now time.Time) SlackMemoryFact {
	if now.IsZero() {
		now = timeNow()
	}
	kind := slackMemoryFactKindForRecord(record)
	fact := SlackMemoryFact{
		ID:         slackMemoryFactID(record),
		Kind:       kind,
		SourceKind: strings.TrimSpace(record.Kind),
		Subject:    slackMemoryFactSubject(record, kind),
		Scope:      slackMemoryFactScopeForRecord(record, kind),
		Content:    strings.TrimSpace(record.Content),
		SourceRefs: slackMemoryFactSourceRefs(record),
		Trust:      slackMemoryFactTrustForRecord(record, kind),
		Staleness:  slackMemoryFactStalenessForRecord(record, kind, now),
		Status:     slackMemoryFactStatusActive,
	}
	if slackMemoryRecordIsWorkerIdentity(record) {
		fact.DoNotGeneralizeTo = []string{slackMemoryFactScopeForeground}
	}
	return fact
}

func SlackMemoryFactsFromRelatedMemoryRecords(records []SlackRelatedMemoryRecord, now time.Time) []SlackMemoryFact {
	if len(records) == 0 {
		return nil
	}
	facts := make([]SlackMemoryFact, 0, len(records))
	for _, record := range records {
		facts = append(facts, SlackMemoryFactFromRelatedMemoryRecord(record, now))
	}
	return facts
}

func BuildSlackMemoryQualityAuditSummary(records []SlackRelatedMemoryRecord, now time.Time) SlackMemoryQualityAuditSummary {
	return BuildSlackMemoryQualityAuditSummaryForFacts(SlackMemoryFactsFromRelatedMemoryRecords(records, now))
}

func BuildSlackMemoryQualityAuditSummaryForFacts(facts []SlackMemoryFact) SlackMemoryQualityAuditSummary {
	summary := SlackMemoryQualityAuditSummary{TotalCount: len(facts)}
	if len(facts) == 0 {
		return summary
	}
	byKind := make(map[string]*SlackMemoryQualityKindSummary)
	for _, fact := range facts {
		summary.MeanTrust += fact.Trust.Score
		summary.MeanStalenessAgeDays += float64(fact.Staleness.AgeDays)
		if fact.Trust.Score < slackMemoryLowTrustThreshold {
			summary.LowTrustCount++
		}
		if fact.Staleness.Status == slackMemoryStalenessStale {
			summary.StaleCount++
		}
		if fact.Staleness.Status == slackMemoryStalenessExpired {
			summary.ExpiredCount++
		}
		kindSummary := byKind[fact.Kind]
		if kindSummary == nil {
			kindSummary = &SlackMemoryQualityKindSummary{Kind: fact.Kind}
			byKind[fact.Kind] = kindSummary
		}
		kindSummary.Count++
		kindSummary.MeanTrust += fact.Trust.Score
		kindSummary.MeanStalenessAgeDays += float64(fact.Staleness.AgeDays)
		if fact.Trust.Score < slackMemoryLowTrustThreshold {
			kindSummary.LowTrustCount++
		}
		if fact.Staleness.Status == slackMemoryStalenessStale {
			kindSummary.StaleCount++
		}
		if fact.Staleness.Status == slackMemoryStalenessExpired {
			kindSummary.ExpiredCount++
		}
	}
	summary.MeanTrust /= float64(summary.TotalCount)
	summary.MeanStalenessAgeDays /= float64(summary.TotalCount)
	kinds := make([]string, 0, len(byKind))
	for kind := range byKind {
		kinds = append(kinds, kind)
	}
	sort.Strings(kinds)
	for _, kind := range kinds {
		kindSummary := *byKind[kind]
		kindSummary.MeanTrust /= float64(kindSummary.Count)
		kindSummary.MeanStalenessAgeDays /= float64(kindSummary.Count)
		summary.ByKind = append(summary.ByKind, kindSummary)
	}
	return summary
}

func slackMemoryFactKindForRecord(record SlackRelatedMemoryRecord) string {
	if slackMemoryRecordIsForegroundIdentity(record) {
		return slackMemoryFactKindForegroundIdentity
	}
	switch record.Kind {
	case "person_profile":
		return slackMemoryFactKindPersonProfile
	case "team_fact":
		return slackMemoryFactKindTeamFact
	case "team_decision":
		return slackMemoryFactKindTeamDecision
	case "team_action":
		return slackMemoryFactKindTeamAction
	case "feedback", "lesson_candidate":
		return slackMemoryFactKindLesson
	case "worker_result":
		return slackMemoryFactKindWorkerResult
	default:
		return slackMemoryFactKindEpisode
	}
}

func slackMemoryFactScopeForRecord(record SlackRelatedMemoryRecord, kind string) string {
	if slackMemoryRecordIsForegroundIdentity(record) {
		return slackMemoryFactScopeForeground
	}
	if slackMemoryRecordIsWorkerIdentity(record) || kind == slackMemoryFactKindWorkerResult {
		return slackMemoryFactScopeWorker
	}
	switch kind {
	case slackMemoryFactKindPersonProfile:
		return slackMemoryFactScopePerson
	case slackMemoryFactKindTeamFact, slackMemoryFactKindTeamDecision, slackMemoryFactKindTeamAction:
		return slackMemoryFactScopeTeam
	default:
		return slackMemoryFactScopeSlack
	}
}

func slackMemoryFactTrustForRecord(record SlackRelatedMemoryRecord, kind string) SlackMemoryFactTrust {
	if kind == slackMemoryFactKindForegroundIdentity {
		return SlackMemoryFactTrust{Score: 0.95, Reason: "foreground_identity"}
	}
	if strings.HasPrefix(record.SourcePath, "memory/legacy/slack-agent-d/") ||
		strings.HasPrefix(record.Source, "memory/legacy/slack-agent-d/") ||
		record.Kind == "legacy_triage_archive" ||
		record.Kind == "legacy_memory_index" ||
		record.Kind == "legacy_memory_file" ||
		record.Kind == "legacy_slack_db" {
		return SlackMemoryFactTrust{Score: 0.25, Reason: "legacy_until_corroborated"}
	}
	switch kind {
	case slackMemoryFactKindPersonProfile, slackMemoryFactKindTeamFact, slackMemoryFactKindTeamDecision, slackMemoryFactKindTeamAction:
		return SlackMemoryFactTrust{Score: 0.85, Reason: "source_backed_workspace_memory"}
	case slackMemoryFactKindLesson:
		return SlackMemoryFactTrust{Score: 0.8, Reason: "review_or_feedback_signal"}
	case slackMemoryFactKindWorkerResult:
		return SlackMemoryFactTrust{Score: 0.55, Reason: "worker_result_medium_trust"}
	default:
		return SlackMemoryFactTrust{Score: 0.6, Reason: "episode_memory_default"}
	}
}

func slackMemoryFactStalenessForRecord(record SlackRelatedMemoryRecord, kind string, now time.Time) SlackMemoryFactStaleness {
	horizon := slackMemoryFactStalenessHorizonDays(kind)
	ageDays, reason := slackMemoryFactAgeDays(record, now)
	status := slackMemoryStalenessFresh
	switch {
	case ageDays >= horizon*2:
		status = slackMemoryStalenessExpired
	case ageDays >= horizon:
		status = slackMemoryStalenessStale
	case ageDays >= maxInt(1, horizon/2):
		status = slackMemoryStalenessAging
	}
	return SlackMemoryFactStaleness{
		Status:      status,
		AgeDays:     ageDays,
		HorizonDays: horizon,
		Reason:      reason,
	}
}

func slackMemoryFactStalenessHorizonDays(kind string) int {
	switch kind {
	case slackMemoryFactKindForegroundIdentity, slackMemoryFactKindPersonProfile, slackMemoryFactKindTeamFact, slackMemoryFactKindTeamDecision:
		return 365
	case slackMemoryFactKindTeamAction, slackMemoryFactKindEpisode, slackMemoryFactKindWorkerResult:
		return 30
	case slackMemoryFactKindLesson:
		return 180
	default:
		return 90
	}
}

func slackMemoryFactAgeDays(record SlackRelatedMemoryRecord, now time.Time) (int, string) {
	timestamp, source := slackMemoryFactRecordTime(record)
	if timestamp.IsZero() || now.IsZero() {
		return 0, "timestamp_missing"
	}
	if timestamp.After(now) {
		return 0, "timestamp_in_future"
	}
	return int(now.Sub(timestamp).Hours() / 24), source
}

func slackMemoryFactRecordTime(record SlackRelatedMemoryRecord) (time.Time, string) {
	for _, candidate := range []struct {
		value  string
		source string
	}{
		{record.UpdatedAt, "updated_at"},
		{record.CreatedAt, "created_at"},
	} {
		if strings.TrimSpace(candidate.value) == "" {
			continue
		}
		if parsed, err := time.Parse(time.RFC3339, candidate.value); err == nil {
			return parsed, candidate.source
		}
	}
	return time.Time{}, ""
}

func slackMemoryFactSubject(record SlackRelatedMemoryRecord, kind string) string {
	if kind == slackMemoryFactKindForegroundIdentity {
		return "oneesama"
	}
	source := firstNonEmpty(record.SourcePath, record.Source, record.SourceRef)
	source = filepath.ToSlash(strings.TrimSpace(source))
	base := strings.TrimSuffix(filepath.Base(source), filepath.Ext(source))
	base = strings.TrimSpace(strings.ToLower(base))
	if base == "" || base == "." {
		return "unknown"
	}
	return base
}

func slackMemoryFactSourceRefs(record SlackRelatedMemoryRecord) []string {
	var refs []string
	for _, ref := range []string{record.SourceRef, record.SourcePath, record.Source} {
		ref = strings.TrimSpace(ref)
		if ref == "" || slackMemoryFactContainsString(refs, ref) {
			continue
		}
		refs = append(refs, ref)
	}
	return refs
}

func slackMemoryFactID(record SlackRelatedMemoryRecord) string {
	ref := firstNonEmpty(record.SourceRef, record.SourcePath, record.Source, record.Title, record.Kind)
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "memory_fact:unknown"
	}
	if record.StartLine > 0 {
		return "memory_fact:" + ref + ":" + strconv.Itoa(record.StartLine)
	}
	return "memory_fact:" + ref
}

func slackMemoryFactContainsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
