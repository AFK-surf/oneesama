package slackagent

import (
	"strings"
	"unicode"
)

type slackLookupUser struct {
	ID                    string
	Name                  string
	RealName              string
	RealNameNormalized    string
	DisplayName           string
	DisplayNameNormalized string
	FirstName             string
	LastName              string
	Deleted               bool
	IsBot                 bool
	IsAppUser             bool
}

func normalizeSlackLookupToken(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, "@")
	value = strings.TrimPrefix(value, "<@")
	value = strings.TrimSuffix(value, ">")
	if value == "" {
		return ""
	}

	var b strings.Builder
	for _, r := range value {
		switch {
		case unicode.IsLetter(r), unicode.IsNumber(r):
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

func slackUserLookupCandidates(user slackLookupUser) []string {
	raw := []string{
		user.ID,
		user.Name,
		user.RealName,
		user.RealNameNormalized,
		user.DisplayName,
		user.DisplayNameNormalized,
		user.FirstName,
		user.LastName,
	}

	seen := make(map[string]struct{}, len(raw))
	var out []string
	for _, item := range raw {
		token := normalizeSlackLookupToken(item)
		if token == "" {
			continue
		}
		if _, ok := seen[token]; ok {
			continue
		}
		seen[token] = struct{}{}
		out = append(out, token)
	}
	return out
}

func bestSlackUserMatch(query string, users []slackLookupUser) (slackLookupUser, int, bool) {
	query = normalizeSlackLookupToken(query)
	if query == "" {
		return slackLookupUser{}, 0, false
	}

	var best slackLookupUser
	bestScore := 0
	found := false
	ambiguous := false
	for _, user := range users {
		if user.Deleted || user.IsBot || user.IsAppUser {
			continue
		}

		score := 0
		if normalizeSlackLookupToken(user.ID) == query {
			score = 100
		} else {
			for _, candidate := range slackUserLookupCandidates(user) {
				switch {
				case candidate == query:
					score = max(score, 95)
				case strings.HasPrefix(candidate, query), strings.HasPrefix(query, candidate):
					score = max(score, 80)
				case strings.Contains(candidate, query), strings.Contains(query, candidate):
					score = max(score, 70)
				}
			}
		}

		if score == 0 {
			continue
		}
		if !found || score > bestScore {
			best = user
			bestScore = score
			found = true
			ambiguous = false
			continue
		}
		if score == bestScore && user.ID != best.ID {
			ambiguous = true
		}
	}

	if !found || ambiguous {
		return slackLookupUser{}, 0, false
	}
	return best, bestScore, true
}
