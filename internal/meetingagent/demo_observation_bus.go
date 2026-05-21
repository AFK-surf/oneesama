package meetingagent

import (
	"fmt"
	"strings"
	"sync"
)

const defaultDemoObservationContextLimit = 5

type DemoObservationBus struct {
	mu         sync.RWMutex
	bySession  map[string][]DemoObservation
	maxPerSess int
}

func NewDemoObservationBus() *DemoObservationBus {
	return &DemoObservationBus{
		bySession:  map[string][]DemoObservation{},
		maxPerSess: 50,
	}
}

func (b *DemoObservationBus) Publish(obs DemoObservation) DemoObservation {
	if b == nil {
		return obs
	}
	sessionID := strings.TrimSpace(obs.SessionID)
	if sessionID == "" {
		return obs
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.bySession[sessionID] = append(b.bySession[sessionID], obs)
	limit := b.maxPerSess
	if limit <= 0 {
		limit = 50
	}
	if len(b.bySession[sessionID]) > limit {
		b.bySession[sessionID] = append([]DemoObservation(nil), b.bySession[sessionID][len(b.bySession[sessionID])-limit:]...)
	}
	return obs
}

func (b *DemoObservationBus) Recent(sessionID string, limit int) []DemoObservation {
	if b == nil {
		return nil
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil
	}
	if limit <= 0 {
		limit = defaultDemoObservationContextLimit
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	observations := b.bySession[sessionID]
	if len(observations) > limit {
		observations = observations[len(observations)-limit:]
	}
	return append([]DemoObservation(nil), observations...)
}

func (b *DemoObservationBus) Context(sessionID string, limit int) string {
	observations := b.Recent(sessionID, limit)
	if len(observations) == 0 {
		return ""
	}
	lines := make([]string, 0, len(observations))
	for _, obs := range observations {
		summary := strings.TrimSpace(obs.Summary)
		if summary == "" {
			summary = "no summary"
		}
		lines = append(lines, fmt.Sprintf("- #%d %s: %s", obs.Sequence, firstNonEmpty(obs.Kind, "observation"), summary))
	}
	return strings.Join(lines, "\n")
}
