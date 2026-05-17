package slackagent

import (
	"context"
	"fmt"
	"strings"
	"time"
)

type SlackHeartbeatPrimeResult struct {
	OK                         bool `json:"ok"`
	FollowupsScanned           int  `json:"followups_scanned"`
	FollowupsRewritten         int  `json:"followups_rewritten"`
	DuplicateFollowupsClosed   int  `json:"duplicate_followups_closed"`
	ImprovementClustersSynced  int  `json:"improvement_clusters_synced"`
	ImprovementSignalsScanned  int  `json:"improvement_signals_scanned"`
	ImprovementClustersScanned int  `json:"improvement_clusters_scanned"`
}

type heartbeatPrimeFollowupPreference struct {
	ID        int64
	UpdatedAt string
	CreatedAt string
}

func (s *Service) primeHeartbeatState(ctx context.Context) (SlackHeartbeatPrimeResult, error) {
	result := SlackHeartbeatPrimeResult{OK: true}
	if s == nil {
		return result, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	now := timeNow().UTC()
	followupResult, err := s.followups.primeFollowupState(ctx, now)
	if err != nil {
		result.OK = false
		return result, err
	}
	result.FollowupsScanned = followupResult.FollowupsScanned
	result.FollowupsRewritten = followupResult.FollowupsRewritten
	result.DuplicateFollowupsClosed = followupResult.DuplicateFollowupsClosed
	improvementResult, err := s.syncOpenImprovementHeartbeatFollowups(ctx, now)
	if err != nil {
		result.OK = false
		return result, err
	}
	result.ImprovementSignalsScanned = improvementResult.ImprovementSignalsScanned
	result.ImprovementClustersScanned = improvementResult.ImprovementClustersScanned
	result.ImprovementClustersSynced = improvementResult.ImprovementClustersSynced
	if result.FollowupsRewritten > 0 || result.DuplicateFollowupsClosed > 0 || result.ImprovementClustersSynced > 0 {
		s.logger.Info(
			"slack heartbeat state primed",
			"followups_scanned", result.FollowupsScanned,
			"followups_rewritten", result.FollowupsRewritten,
			"duplicate_followups_closed", result.DuplicateFollowupsClosed,
			"improvement_signals_scanned", result.ImprovementSignalsScanned,
			"improvement_clusters_synced", result.ImprovementClustersSynced,
		)
	}
	return result, nil
}

func (s *Service) primeHeartbeatStateOnStart(ctx context.Context) {
	if s == nil {
		return
	}
	result, err := s.primeHeartbeatState(ctx)
	if err != nil {
		s.logger.Warn("slack heartbeat state prime failed", "error", err)
		return
	}
	if !result.OK {
		s.logger.Warn("slack heartbeat state prime incomplete")
	}
}

func (s *slackHeartbeatStore) primeFollowupState(ctx context.Context, now time.Time) (SlackHeartbeatPrimeResult, error) {
	result := SlackHeartbeatPrimeResult{OK: true}
	if s == nil || s.followups == nil {
		return result, nil
	}
	if now.IsZero() {
		now = timeNow().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.followups.List(ctx)
	if err != nil {
		return result, fmt.Errorf("list heartbeat followups for prime: %w", err)
	}
	result.FollowupsScanned = len(records)
	normalizedByID := make(map[int64]SlackHeartbeatFollowup, len(records))
	originalByID := make(map[int64]SlackHeartbeatFollowup, len(records))
	preferenceByID := make(map[int64]heartbeatPrimeFollowupPreference, len(records))
	bestOpenBySourceRef := map[string]int64{}
	for _, record := range records {
		normalized := normalizeHeartbeatFollowup(record)
		if normalized.ID == 0 {
			normalized.ID = newHeartbeatID()
		}
		normalizedByID[normalized.ID] = normalized
		originalByID[normalized.ID] = record
		preferenceByID[normalized.ID] = heartbeatPrimeFollowupPreference{
			ID:        normalized.ID,
			UpdatedAt: strings.TrimSpace(record.UpdatedAt),
			CreatedAt: strings.TrimSpace(record.CreatedAt),
		}
		if !strings.EqualFold(normalized.Status, "open") || strings.TrimSpace(normalized.SourceRef) == "" {
			continue
		}
		currentID := bestOpenBySourceRef[normalized.SourceRef]
		if currentID == 0 || heartbeatPrimePrefer(preferenceByID[normalized.ID], preferenceByID[currentID]) {
			bestOpenBySourceRef[normalized.SourceRef] = normalized.ID
		}
	}
	for id, normalized := range normalizedByID {
		original := originalByID[id]
		shouldWrite := heartbeatFollowupPrimeNeedsWrite(original, normalized)
		if strings.EqualFold(normalized.Status, "open") && normalized.SourceRef != "" {
			if keeperID := bestOpenBySourceRef[normalized.SourceRef]; keeperID != 0 && keeperID != id {
				normalized.Status = "done"
				if normalized.Metadata == nil {
					normalized.Metadata = map[string]any{}
				}
				normalized.Metadata["resolution"] = fmt.Sprintf("superseded_by:%d", keeperID)
				normalized.Metadata["superseded_by"] = keeperID
				normalized.UpdatedAt = now.Format(time.RFC3339Nano)
				result.DuplicateFollowupsClosed++
				shouldWrite = true
			}
		}
		if !shouldWrite {
			continue
		}
		if err := s.followups.Set(ctx, heartbeatKey(normalized.ID), normalized); err != nil {
			return result, fmt.Errorf("prime heartbeat followup %d: %w", normalized.ID, err)
		}
		result.FollowupsRewritten++
	}
	return result, nil
}

func heartbeatPrimePrefer(candidate heartbeatPrimeFollowupPreference, current heartbeatPrimeFollowupPreference) bool {
	candidateUpdated := firstNonEmpty(candidate.UpdatedAt, candidate.CreatedAt)
	currentUpdated := firstNonEmpty(current.UpdatedAt, current.CreatedAt)
	candidateTime := parseHeartbeatTime(candidateUpdated)
	currentTime := parseHeartbeatTime(currentUpdated)
	if candidateTime != nil && currentTime != nil && !candidateTime.Equal(*currentTime) {
		return candidateTime.After(*currentTime)
	}
	if candidateTime != nil && currentTime == nil {
		return true
	}
	if candidateTime == nil && currentTime != nil {
		return false
	}
	return candidate.ID > current.ID
}

func heartbeatFollowupPrimeNeedsWrite(original SlackHeartbeatFollowup, normalized SlackHeartbeatFollowup) bool {
	return original.ID != normalized.ID ||
		original.Kind != normalized.Kind ||
		strings.TrimSpace(original.Title) != normalized.Title ||
		strings.TrimSpace(original.Summary) != normalized.Summary ||
		strings.TrimSpace(original.SourceKind) != normalized.SourceKind ||
		strings.TrimSpace(original.ChannelID) != normalized.ChannelID ||
		strings.TrimSpace(original.ThreadTS) != normalized.ThreadTS ||
		strings.TrimSpace(original.SourceRef) != normalized.SourceRef ||
		firstNonEmpty(original.Status, "open") != normalized.Status ||
		firstNonEmpty(original.Priority, "normal") != normalized.Priority ||
		original.CreatedAt != normalized.CreatedAt ||
		(original.Metadata == nil && len(normalized.Metadata) > 0)
}

func (s *Service) syncOpenImprovementHeartbeatFollowups(ctx context.Context, now time.Time) (SlackHeartbeatPrimeResult, error) {
	result := SlackHeartbeatPrimeResult{OK: true}
	if s == nil || s.improvements == nil || s.followups == nil {
		return result, nil
	}
	if now.IsZero() {
		now = timeNow().UTC()
	}
	signals, err := s.improvements.ListSignals(ctx, 500, []string{improvementSignalStatusOpen, improvementSignalStatusAbsorbed}, time.Time{})
	if err != nil {
		return result, fmt.Errorf("list improvement signals for heartbeat sync: %w", err)
	}
	result.ImprovementSignalsScanned = len(signals)
	clusters := map[string]struct{}{}
	for _, signal := range signals {
		if clusterKey := strings.TrimSpace(signal.ClusterKey); clusterKey != "" {
			clusters[clusterKey] = struct{}{}
		}
	}
	result.ImprovementClustersScanned = len(clusters)
	for clusterKey := range clusters {
		followup, err := s.syncImprovementCluster(ctx, clusterKey, now)
		if err != nil {
			return result, fmt.Errorf("sync improvement cluster %s: %w", clusterKey, err)
		}
		if followup != nil {
			result.ImprovementClustersSynced++
		}
	}
	return result, nil
}
