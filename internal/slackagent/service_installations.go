package slackagent

import (
	"context"
	"fmt"
	"slices"
	"strings"
)

type SlackInstallationQuery struct {
	InstallationID string `json:"installation_id,omitempty"`
	TeamID         string `json:"team_id,omitempty"`
	EnterpriseID   string `json:"enterprise_id,omitempty"`
}

type SlackInstallationLookupResult struct {
	Found        bool                      `json:"found"`
	MatchedBy    string                    `json:"matched_by,omitempty"`
	Query        SlackInstallationQuery    `json:"query"`
	Installation *SlackInstallationSummary `json:"installation,omitempty"`
}

func (s *Service) ListInstallations(ctx context.Context) ([]SlackInstallationSummary, error) {
	store, err := s.installationCollection()
	if err != nil {
		return nil, err
	}

	records, err := store.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list slack installations: %w", err)
	}

	summaries := make([]SlackInstallationSummary, 0, len(records))
	for _, record := range records {
		summaries = append(summaries, record.Summary())
	}
	slices.SortFunc(summaries, func(a, b SlackInstallationSummary) int {
		return strings.Compare(a.InstallationID, b.InstallationID)
	})
	return summaries, nil
}

func (s *Service) ResolveInstallation(ctx context.Context, query SlackInstallationQuery) (SlackInstallationLookupResult, error) {
	result := SlackInstallationLookupResult{
		Query: SlackInstallationQuery{
			InstallationID: strings.TrimSpace(query.InstallationID),
			TeamID:         strings.TrimSpace(query.TeamID),
			EnterpriseID:   strings.TrimSpace(query.EnterpriseID),
		},
	}

	store, err := s.installationCollection()
	if err != nil {
		return result, err
	}

	if result.Query.InstallationID != "" {
		record, ok, err := store.Get(ctx, result.Query.InstallationID)
		if err != nil {
			return result, fmt.Errorf("get slack installation %s: %w", result.Query.InstallationID, err)
		}
		if !ok {
			return result, nil
		}
		summary := record.Summary()
		result.Found = true
		result.MatchedBy = "installation_id"
		result.Installation = &summary
		return result, nil
	}

	records, err := store.List(ctx)
	if err != nil {
		return result, fmt.Errorf("list slack installations for resolve: %w", err)
	}
	for _, record := range records {
		switch {
		case result.Query.EnterpriseID != "" && strings.TrimSpace(record.EnterpriseID) == result.Query.EnterpriseID:
			summary := record.Summary()
			result.Found = true
			result.MatchedBy = "enterprise_id"
			result.Installation = &summary
			return result, nil
		case result.Query.TeamID != "" && strings.TrimSpace(record.TeamID) == result.Query.TeamID:
			summary := record.Summary()
			result.Found = true
			result.MatchedBy = "team_id"
			result.Installation = &summary
			return result, nil
		}
	}

	return result, nil
}
