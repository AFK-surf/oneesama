package slackagent

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type personMemoryProfile struct {
	Name                    string
	Source                  string
	IdentityMap             []string
	DurableContext          []string
	CurrentResponsibilities []string
	RecentMeetings          []string
	OperatorNotes           []string
}

func RefreshPeopleMemoryProjection(workspaceDir string) error {
	return refreshPeopleMemoryProjection(context.Background(), workspaceDir)
}

func refreshPeopleMemoryProjection(ctx context.Context, workspaceDir string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	profiles, err := buildPeopleMemoryProfiles(workspaceDir)
	if err != nil {
		return err
	}
	for _, profile := range profiles {
		if err := writePeopleMemoryProfile(workspaceDir, profile); err != nil {
			return err
		}
	}
	return nil
}

func buildPeopleMemoryProfiles(workspaceDir string) (map[string]*personMemoryProfile, error) {
	identity := loadIdentityNotes(workspaceDir)
	existingNotes := loadExistingPeopleOperatorNotes(workspaceDir)
	profiles := make(map[string]*personMemoryProfile)
	knownNames := make([]string, 0, len(identity))
	for name := range identity {
		knownNames = append(knownNames, name)
	}
	sort.Strings(knownNames)

	ensure := func(name string) *personMemoryProfile {
		canonical := canonicalPersonName(name, knownNames)
		if canonical == "" {
			return nil
		}
		profile := profiles[canonical]
		if profile == nil {
			profile = &personMemoryProfile{Name: canonical, Source: filepath.ToSlash(filepath.Join("memory", "people", normalizeMemoryTag(canonical)+".md"))}
			profiles[canonical] = profile
		}
		profile.IdentityMap = compactUniqueStrings(append(profile.IdentityMap, identity[canonical]...))
		profile.OperatorNotes = compactUniqueStrings(append(profile.OperatorNotes, existingNotes[canonical]...))
		return profile
	}
	for _, name := range knownNames {
		ensure(name)
	}

	meetingDir := filepath.Join(workspaceDir, filepath.FromSlash(teamMemoryMeetingsDir))
	entries, err := os.ReadDir(meetingDir)
	if err != nil {
		if os.IsNotExist(err) {
			return profiles, nil
		}
		return nil, err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(meetingDir, entry.Name()))
		if err != nil {
			continue
		}
		doc := parseTeamMeetingMemoryDoc(string(raw))
		for _, participant := range doc.Participants {
			if profile := ensure(participant); profile != nil {
				profile.RecentMeetings = compactUniqueStrings(append(profile.RecentMeetings, doc.Title))
			}
		}
		for _, fact := range doc.StableContext {
			if name := matchPersonNameForText(fact, knownNames); name != "" {
				profile := ensure(name)
				profile.DurableContext = compactUniqueStrings(append(profile.DurableContext, fact))
				profile.RecentMeetings = compactUniqueStrings(append(profile.RecentMeetings, doc.Title))
			}
		}
		for _, action := range doc.ActionItems {
			owner := ownerFromActionLine(action)
			if owner == "" {
				continue
			}
			profile := ensure(owner)
			profile.CurrentResponsibilities = compactUniqueStrings(append(profile.CurrentResponsibilities, action))
			profile.RecentMeetings = compactUniqueStrings(append(profile.RecentMeetings, doc.Title))
		}
	}
	return profiles, nil
}
