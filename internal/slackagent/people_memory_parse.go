package slackagent

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type teamMeetingMemoryDoc struct {
	Title         string
	Participants  []string
	StableContext []string
	ActionItems   []string
}

func parseTeamMeetingMemoryDoc(body string) teamMeetingMemoryDoc {
	doc := teamMeetingMemoryDoc{Title: "Meeting"}
	section := ""
	for _, rawLine := range strings.Split(body, "\n") {
		line := strings.TrimSpace(rawLine)
		switch {
		case strings.HasPrefix(line, "# Team Memory:"):
			doc.Title = strings.TrimSpace(strings.TrimPrefix(line, "# Team Memory:"))
		case strings.HasPrefix(line, "- Participants:"):
			doc.Participants = splitCommaList(strings.TrimSpace(strings.TrimPrefix(line, "- Participants:")))
		case strings.HasPrefix(line, "## "):
			section = strings.TrimSpace(strings.TrimPrefix(line, "## "))
		case strings.HasPrefix(line, "- "):
			item := strings.TrimSpace(strings.TrimPrefix(line, "- "))
			switch section {
			case "Stable Context":
				doc.StableContext = append(doc.StableContext, item)
			case "Action Items":
				doc.ActionItems = append(doc.ActionItems, item)
			}
		}
	}
	return doc
}

func splitCommaList(value string) []string {
	var out []string
	for _, part := range strings.Split(value, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func loadIdentityNotes(workspaceDir string) map[string][]string {
	out := make(map[string][]string)
	raw, err := os.ReadFile(filepath.Join(workspaceDir, "MEMORY.md"))
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "- "))
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		rest = strings.TrimSpace(rest)
		if name != "" && rest != "" {
			out[name] = append(out[name], rest)
		}
	}
	return out
}

func loadExistingPeopleOperatorNotes(workspaceDir string) map[string][]string {
	out := make(map[string][]string)
	peopleDir := filepath.Join(workspaceDir, "memory", "people")
	entries, err := os.ReadDir(peopleDir)
	if err != nil {
		return out
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(peopleDir, entry.Name()))
		if err != nil {
			continue
		}
		profile := parsePeopleMemoryProfile(filepath.ToSlash(filepath.Join("memory", "people", entry.Name())), string(raw))
		if profile.Name != "" && len(profile.OperatorNotes) > 0 {
			out[profile.Name] = append(out[profile.Name], profile.OperatorNotes...)
		}
	}
	return out
}

func writePeopleMemoryProfile(workspaceDir string, profile *personMemoryProfile) error {
	if profile == nil || profile.Name == "" {
		return nil
	}
	return writeWorkspaceMemoryFile(workspaceDir, profile.Source, renderPeopleMemoryProfile(profile))
}

func renderPeopleMemoryProfile(profile *personMemoryProfile) string {
	var sb strings.Builder
	_, _ = fmt.Fprintf(&sb, "# Person Memory: %s\n\n", profile.Name)
	appendMemoryBullets(&sb, "Identity Map", profile.IdentityMap)
	appendMemoryBullets(&sb, "Durable Context", profile.DurableContext)
	appendMemoryBullets(&sb, "Current Responsibilities", profile.CurrentResponsibilities)
	appendMemoryBullets(&sb, "Recent Meetings", profile.RecentMeetings)
	appendMemoryBullets(&sb, "Operator Notes", profile.OperatorNotes)
	return strings.TrimSpace(sb.String())
}

func loadPeopleMemoryProfiles(workspaceDir string) ([]personMemoryProfile, error) {
	peopleDir := filepath.Join(workspaceDir, "memory", "people")
	entries, err := os.ReadDir(peopleDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var profiles []personMemoryProfile
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(peopleDir, entry.Name()))
		if err != nil {
			continue
		}
		profile := parsePeopleMemoryProfile(filepath.ToSlash(filepath.Join("memory", "people", entry.Name())), string(raw))
		if profile.Name != "" {
			profiles = append(profiles, profile)
		}
	}
	sort.SliceStable(profiles, func(i, j int) bool { return profiles[i].Name < profiles[j].Name })
	return profiles, nil
}

func parsePeopleMemoryProfile(source string, body string) personMemoryProfile {
	profile := personMemoryProfile{Source: source}
	section := ""
	for _, rawLine := range strings.Split(body, "\n") {
		line := strings.TrimSpace(rawLine)
		switch {
		case strings.HasPrefix(line, "# Person Memory:"):
			profile.Name = strings.TrimSpace(strings.TrimPrefix(line, "# Person Memory:"))
		case strings.HasPrefix(line, "## "):
			section = strings.TrimSpace(strings.TrimPrefix(line, "## "))
		case strings.HasPrefix(line, "- "):
			item := strings.TrimSpace(strings.TrimPrefix(line, "- "))
			switch section {
			case "Identity Map":
				profile.IdentityMap = append(profile.IdentityMap, item)
			case "Durable Context":
				profile.DurableContext = append(profile.DurableContext, item)
			case "Current Responsibilities", "Open Action Items":
				profile.CurrentResponsibilities = append(profile.CurrentResponsibilities, item)
			case "Recent Meetings":
				profile.RecentMeetings = append(profile.RecentMeetings, item)
			case "Operator Notes":
				profile.OperatorNotes = append(profile.OperatorNotes, item)
			}
		}
	}
	return profile
}

func ownerFromActionLine(line string) string {
	line = strings.TrimSpace(strings.TrimPrefix(line, "- "))
	marker := "owner:"
	idx := strings.Index(strings.ToLower(line), marker)
	if idx < 0 {
		return ""
	}
	owner := strings.TrimSpace(line[idx+len(marker):])
	if cut := strings.Index(owner, " — "); cut >= 0 {
		owner = strings.TrimSpace(owner[:cut])
	}
	return owner
}
