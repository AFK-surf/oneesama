package meetingagent

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// DemoSessionResult is the outcome class recorded for an action attempt.
type DemoSessionResult string

const (
	DemoSessionResultStarted  DemoSessionResult = "started"
	DemoSessionResultAllowed  DemoSessionResult = "allowed"
	DemoSessionResultDryRun   DemoSessionResult = "dry_run"
	DemoSessionResultBlocked  DemoSessionResult = "blocked"
	DemoSessionResultFailed   DemoSessionResult = "failed"
	DemoSessionResultStopped  DemoSessionResult = "stopped"
	DemoSessionResultCleaned  DemoSessionResult = "cleaned"
	DemoSessionResultObserved DemoSessionResult = "observed"
)

// DemoSessionThreadKey identifies the Slack or Meet thread that triggered
// the demo session. Surface lets one store carry both kinds without
// pulling Slack/Meet types into the audit layer (RFC: keep internal logs
// audit-only, never direct-posted to Slack/Meet).
type DemoSessionThreadKey struct {
	Surface   string // "slack", "meeting"
	ChannelID string
	ThreadTS  string
}

// Normalized returns a comparable map-key form. Empty fields are kept so a
// caller that drops only ThreadTS does not collide with a different
// channel.
func (k DemoSessionThreadKey) Normalized() string {
	return strings.ToLower(strings.TrimSpace(k.Surface)) + "|" +
		strings.TrimSpace(k.ChannelID) + "|" +
		strings.TrimSpace(k.ThreadTS)
}

// IsZero reports whether the key has no meaningful identification. Used to
// decide whether to bother indexing thread → session.
func (k DemoSessionThreadKey) IsZero() bool {
	return strings.TrimSpace(k.Surface) == "" &&
		strings.TrimSpace(k.ChannelID) == "" &&
		strings.TrimSpace(k.ThreadTS) == ""
}

// DemoSessionAuditEntry is one row in the per-session audit log. Reason
// codes are snake_case so the store can be grepped from a runbook.
type DemoSessionAuditEntry struct {
	SessionID    string
	Sequence     int
	Actor        string
	ThreadKey    DemoSessionThreadKey
	ActionClass  DemoActionKind
	URL          string
	Result       DemoSessionResult
	ReasonCode   string
	ArtifactRefs []string
	RecordedAt   time.Time
}

// DemoSessionStatusSnapshot is the operator-facing summary suitable for a
// /demo/status endpoint or runbook printout.
type DemoSessionStatusSnapshot struct {
	SessionID    string
	ThreadKey    DemoSessionThreadKey
	Actor        string
	URL          string
	StartedAt    time.Time
	EndedAt      time.Time
	LastAction   DemoActionKind
	LastResult   DemoSessionResult
	LastReason   string
	ArtifactRefs []string
	EntryCount   int
	Closed       bool
}

// DemoSessionTriggerRequest is the input for the first audit row.
type DemoSessionTriggerRequest struct {
	SessionID string
	Actor     string
	ThreadKey DemoSessionThreadKey
	URL       string
}

// DemoSessionActionRequest is the input for subsequent action rows.
type DemoSessionActionRequest struct {
	SessionID    string
	ActionClass  DemoActionKind
	URL          string
	Result       DemoSessionResult
	ReasonCode   string
	ArtifactRefs []string
}

// DemoSessionStore is the in-memory audit + thread mapping store. Safe for
// concurrent use. POC scope: no disk persistence; driver #305 already owns
// the on-disk runtime dir for frames/profiles. Mainline integration can
// swap this for a persistent implementation behind the same interface
// without touching callers (see runbook for the gate criteria).
type DemoSessionStore struct {
	now func() time.Time

	mu       sync.RWMutex
	bySession map[string]*demoSessionRecord
	byThread  map[string]string // normalized thread key → session id
}

type demoSessionRecord struct {
	snapshot DemoSessionStatusSnapshot
	entries  []DemoSessionAuditEntry
}

var (
	errDemoSessionAlreadyExists = errors.New("demo_session_already_exists")
	errDemoSessionNotFound      = errors.New("demo_session_not_found")
	errDemoSessionMissingID     = errors.New("demo_session_id_required")
	errDemoSessionAlreadyClosed = errors.New("demo_session_already_closed")
)

// NewDemoSessionStore returns an empty store using time.Now as the clock.
// Tests may inject a deterministic clock via WithClock.
func NewDemoSessionStore() *DemoSessionStore {
	return &DemoSessionStore{
		now:       time.Now,
		bySession: map[string]*demoSessionRecord{},
		byThread:  map[string]string{},
	}
}

// WithClock returns a copy of s using the given clock. Used by tests to
// pin RecordedAt timestamps. The clock is also used for trigger StartedAt
// and stop EndedAt when the caller does not supply them.
func (s *DemoSessionStore) WithClock(now func() time.Time) *DemoSessionStore {
	if now == nil {
		now = time.Now
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.now = now
	return s
}

// RecordTrigger creates a new session row. Returns the first audit entry.
// Returns errDemoSessionAlreadyExists if the session id has been used.
func (s *DemoSessionStore) RecordTrigger(req DemoSessionTriggerRequest) (DemoSessionAuditEntry, error) {
	id := strings.TrimSpace(req.SessionID)
	if id == "" {
		return DemoSessionAuditEntry{}, errDemoSessionMissingID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.bySession[id]; exists {
		return DemoSessionAuditEntry{}, errDemoSessionAlreadyExists
	}
	now := s.now()
	entry := DemoSessionAuditEntry{
		SessionID:   id,
		Sequence:    1,
		Actor:       strings.TrimSpace(req.Actor),
		ThreadKey:   req.ThreadKey,
		URL:         strings.TrimSpace(req.URL),
		ActionClass: DemoActionOpenURL,
		Result:      DemoSessionResultStarted,
		ReasonCode:  "session_triggered",
		RecordedAt:  now,
	}
	rec := &demoSessionRecord{
		snapshot: DemoSessionStatusSnapshot{
			SessionID:  id,
			ThreadKey:  req.ThreadKey,
			Actor:      entry.Actor,
			URL:        entry.URL,
			StartedAt:  now,
			LastAction: entry.ActionClass,
			LastResult: entry.Result,
			LastReason: entry.ReasonCode,
			EntryCount: 1,
		},
		entries: []DemoSessionAuditEntry{entry},
	}
	s.bySession[id] = rec
	if !req.ThreadKey.IsZero() {
		s.byThread[req.ThreadKey.Normalized()] = id
	}
	return entry, nil
}

// RecordAction appends an action row. The session must exist and not be
// closed.
func (s *DemoSessionStore) RecordAction(req DemoSessionActionRequest) (DemoSessionAuditEntry, error) {
	id := strings.TrimSpace(req.SessionID)
	if id == "" {
		return DemoSessionAuditEntry{}, errDemoSessionMissingID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.bySession[id]
	if !ok {
		return DemoSessionAuditEntry{}, errDemoSessionNotFound
	}
	if rec.snapshot.Closed {
		return DemoSessionAuditEntry{}, errDemoSessionAlreadyClosed
	}
	now := s.now()
	entry := DemoSessionAuditEntry{
		SessionID:    id,
		Sequence:     len(rec.entries) + 1,
		Actor:        rec.snapshot.Actor,
		ThreadKey:    rec.snapshot.ThreadKey,
		ActionClass:  req.ActionClass,
		URL:          strings.TrimSpace(req.URL),
		Result:       req.Result,
		ReasonCode:   strings.TrimSpace(req.ReasonCode),
		ArtifactRefs: append([]string(nil), req.ArtifactRefs...),
		RecordedAt:   now,
	}
	rec.entries = append(rec.entries, entry)
	rec.snapshot.EntryCount = len(rec.entries)
	rec.snapshot.LastAction = entry.ActionClass
	rec.snapshot.LastResult = entry.Result
	rec.snapshot.LastReason = entry.ReasonCode
	if len(entry.ArtifactRefs) > 0 {
		rec.snapshot.ArtifactRefs = append(rec.snapshot.ArtifactRefs, entry.ArtifactRefs...)
	}
	return entry, nil
}

// RecordClose appends a terminal row (stopped / cleaned / failed) and
// marks the session closed. Further RecordAction calls will reject.
func (s *DemoSessionStore) RecordClose(sessionID string, result DemoSessionResult, reason string) (DemoSessionAuditEntry, error) {
	id := strings.TrimSpace(sessionID)
	if id == "" {
		return DemoSessionAuditEntry{}, errDemoSessionMissingID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.bySession[id]
	if !ok {
		return DemoSessionAuditEntry{}, errDemoSessionNotFound
	}
	if rec.snapshot.Closed {
		return DemoSessionAuditEntry{}, errDemoSessionAlreadyClosed
	}
	now := s.now()
	entry := DemoSessionAuditEntry{
		SessionID:   id,
		Sequence:    len(rec.entries) + 1,
		Actor:       rec.snapshot.Actor,
		ThreadKey:   rec.snapshot.ThreadKey,
		ActionClass: DemoActionKind(""),
		Result:      result,
		ReasonCode:  strings.TrimSpace(reason),
		RecordedAt:  now,
	}
	rec.entries = append(rec.entries, entry)
	rec.snapshot.EntryCount = len(rec.entries)
	rec.snapshot.LastResult = entry.Result
	rec.snapshot.LastReason = entry.ReasonCode
	rec.snapshot.EndedAt = now
	rec.snapshot.Closed = true
	return entry, nil
}

// Snapshot returns the current status snapshot for the session, or false
// if no such session.
func (s *DemoSessionStore) Snapshot(sessionID string) (DemoSessionStatusSnapshot, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, ok := s.bySession[strings.TrimSpace(sessionID)]
	if !ok {
		return DemoSessionStatusSnapshot{}, false
	}
	snap := rec.snapshot
	if len(snap.ArtifactRefs) > 0 {
		snap.ArtifactRefs = append([]string(nil), snap.ArtifactRefs...)
	}
	return snap, true
}

// Entries returns a copy of the audit log for the session in recorded
// order, or false if no such session.
func (s *DemoSessionStore) Entries(sessionID string) ([]DemoSessionAuditEntry, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, ok := s.bySession[strings.TrimSpace(sessionID)]
	if !ok {
		return nil, false
	}
	out := make([]DemoSessionAuditEntry, len(rec.entries))
	copy(out, rec.entries)
	return out, true
}

// SessionForThread returns the session id last associated with the
// given thread key, or "" if none.
func (s *DemoSessionStore) SessionForThread(key DemoSessionThreadKey) (string, bool) {
	if key.IsZero() {
		return "", false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.byThread[key.Normalized()]
	return id, ok
}

// ThreadForSession returns the thread key the session was triggered from,
// or an empty key if none.
func (s *DemoSessionStore) ThreadForSession(sessionID string) (DemoSessionThreadKey, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, ok := s.bySession[strings.TrimSpace(sessionID)]
	if !ok {
		return DemoSessionThreadKey{}, false
	}
	return rec.snapshot.ThreadKey, !rec.snapshot.ThreadKey.IsZero()
}

// ActiveSessionIDs returns the list of open session ids in start order.
// Useful for a status endpoint that wants to list everything still
// running.
func (s *DemoSessionStore) ActiveSessionIDs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var ids []string
	for id, rec := range s.bySession {
		if !rec.snapshot.Closed {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool {
		return s.bySession[ids[i]].snapshot.StartedAt.Before(s.bySession[ids[j]].snapshot.StartedAt)
	})
	return ids
}

// FormatRunbookLine renders an audit entry as a single human-readable
// line for the runbook / operator grep. Format is stable so a sed/awk
// pipeline can parse it.
func FormatRunbookLine(e DemoSessionAuditEntry) string {
	thread := "-"
	if !e.ThreadKey.IsZero() {
		thread = e.ThreadKey.Normalized()
	}
	return fmt.Sprintf(
		"%s session=%s seq=%d actor=%s thread=%s action=%s url=%s result=%s reason=%s artifacts=%d",
		e.RecordedAt.UTC().Format(time.RFC3339),
		e.SessionID,
		e.Sequence,
		emptyDash(e.Actor),
		thread,
		emptyDash(string(e.ActionClass)),
		emptyDash(e.URL),
		emptyDash(string(e.Result)),
		emptyDash(e.ReasonCode),
		len(e.ArtifactRefs),
	)
}

func emptyDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "-"
	}
	return s
}
