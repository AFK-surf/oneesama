package meetingagent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/AFK-surf/oneesama/internal/persistence"
)

const (
	identityUsersCollection = "meeting_identity_users"
	defaultSlackAPIBaseURL  = "https://slack.com/api"
	slackUsersCacheTTL      = 15 * time.Minute
)

type IdentityUserRecord struct {
	ID                  string   `json:"id"`
	CanonicalName       string   `json:"canonical_name"`
	PreferredName       string   `json:"preferred_name,omitempty"`
	HonorificPreference string   `json:"honorific_preference,omitempty"`
	Role                string   `json:"role,omitempty"`
	Aliases             []string `json:"aliases,omitempty"`
	MeetDisplayNames    []string `json:"meet_display_names,omitempty"`
	SlackUserID         string   `json:"slack_user_id,omitempty"`
	SlackTeamID         string   `json:"slack_team_id,omitempty"`
	Email               string   `json:"email,omitempty"`
	CalendarEmails      []string `json:"calendar_emails,omitempty"`
	Linear              string   `json:"linear,omitempty"`
	GitHub              string   `json:"github,omitempty"`
	Sources             []string `json:"sources,omitempty"`
	UpdatedAt           string   `json:"updated_at,omitempty"`
}

type resolveSpeakerIdentityInput struct {
	DisplayName       string                  `json:"display_name"`
	Source            string                  `json:"source"`
	Channel           string                  `json:"channel"`
	Workspace         string                  `json:"workspace"`
	MeetingURL        string                  `json:"meeting_url"`
	CalendarAttendees []identityAttendeeInput `json:"calendar_attendees"`
	Learn             *identityLearnInput     `json:"learn"`
}

type identityAttendeeInput struct {
	Name        string   `json:"name"`
	DisplayName string   `json:"display_name"`
	Email       string   `json:"email"`
	Aliases     []string `json:"aliases"`
	Role        string   `json:"role"`
}

type identityLearnInput struct {
	CanonicalName       string   `json:"canonical_name"`
	PreferredName       string   `json:"preferred_name"`
	HonorificPreference string   `json:"honorific_preference"`
	Role                string   `json:"role"`
	Aliases             []string `json:"aliases"`
	MeetDisplayNames    []string `json:"meet_display_names"`
	SlackUserID         string   `json:"slack_user_id"`
	SlackTeamID         string   `json:"slack_team_id"`
	Email               string   `json:"email"`
	CalendarEmails      []string `json:"calendar_emails"`
	Linear              string   `json:"linear"`
	GitHub              string   `json:"github"`
}

type identityMatchCandidate struct {
	record   IdentityUserRecord
	score    int
	evidence []string
	sources  map[string]bool
}

func (s *Service) resolveSpeakerIdentity(ctx context.Context, input resolveSpeakerIdentityInput) map[string]any {
	name := strings.TrimSpace(input.DisplayName)
	source := strings.TrimSpace(input.Source)
	if name == "" {
		return identityFallback("", source, []string{"missing_display_name"})
	}

	if input.Learn != nil {
		if record := identityRecordFromLearn(*input.Learn); record.ID != "" {
			if err := s.upsertIdentityRecord(ctx, record); err != nil {
				s.logger.Warn("identity resolver people_memory write failed", "error", err)
			}
		}
	}

	records := s.identityCandidateRecords(ctx, input)
	match, ok, ambiguous := bestIdentityMatch(name, records)
	if !ok || ambiguous {
		evidence := []string{"fallback:display_name"}
		if ambiguous {
			evidence = []string{"ambiguous_match", "fallback:display_name"}
		}
		s.logger.Warn(
			"speaker identity low_confidence_fallback",
			"display_name", name,
			"source", source,
			"evidence", evidence,
		)
		return identityFallback(name, source, evidence)
	}

	result := identityResult(name, source, match)
	if result["confidence"] == "low" {
		s.logger.Warn(
			"speaker identity low_confidence_fallback",
			"display_name", name,
			"source", source,
			"evidence", result["evidence"],
		)
	}
	return result
}

func (s *Service) identityCandidateRecords(ctx context.Context, input resolveSpeakerIdentityInput) []IdentityUserRecord {
	var records []IdentityUserRecord
	current := s.currentUserIdentityRecord()
	if current.ID != "" {
		records = append(records, current)
		_ = s.upsertIdentityRecord(ctx, current)
	}
	if stored, err := s.listIdentityRecords(ctx); err == nil {
		records = append(records, stored...)
	} else {
		s.logger.Warn("identity resolver people_memory read failed", "error", err)
	}
	if slackRecords, err := s.slackIdentityRecords(ctx); err == nil {
		records = append(records, slackRecords...)
	} else {
		s.logger.Warn("identity resolver slack users.list failed", "error", err)
	}
	records = append(records, s.calendarIdentityRecords(ctx, input.MeetingURL, input.CalendarAttendees)...)
	return mergeIdentityRecords(records)
}

func (s *Service) currentUserIdentityRecord() IdentityUserRecord {
	currentUser := s.realtimeCurrentUser()
	aliases := compactCurrentUserAliases(currentUser.Aliases, currentUser.Name, currentUser.EnglishName, currentUser.English)
	canonical := firstNonEmpty(currentUser.Name, currentUser.EnglishName)
	if strings.TrimSpace(canonical) == "" && len(aliases) > 0 {
		canonical = aliases[0]
	}
	if strings.TrimSpace(canonical) == "" {
		return IdentityUserRecord{}
	}
	return IdentityUserRecord{
		ID:               "workspace:current_user",
		CanonicalName:    canonical,
		PreferredName:    firstNonEmpty(currentUser.Name, currentUser.EnglishName, canonical),
		Role:             "current_user",
		Aliases:          aliases,
		MeetDisplayNames: aliases,
		Email:            strings.TrimSpace(currentUser.Email),
		Linear:           strings.TrimSpace(currentUser.Linear),
		GitHub:           strings.TrimSpace(currentUser.GitHub),
		Sources:          []string{"workspace_owner_config"},
		UpdatedAt:        time.Now().UTC().Format(time.RFC3339Nano),
	}
}

func (s *Service) identityCollection() (*persistence.TypedCollection[IdentityUserRecord], error) {
	s.identityMu.Lock()
	defer s.identityMu.Unlock()
	if s.identityStore != nil {
		return s.identityStore, nil
	}
	store, err := persistence.OpenTyped[IdentityUserRecord](persistence.Options{
		Provider:   persistence.NormalizeProvider(s.persistence.Provider),
		Collection: identityUsersCollection,
		DataDir:    s.persistence.DataDir,
		SQLitePath: s.persistence.SQLitePath,
	})
	if err != nil {
		return nil, fmt.Errorf("open identity user store: %w", err)
	}
	s.identityStore = store
	return store, nil
}

func (s *Service) upsertIdentityRecord(ctx context.Context, record IdentityUserRecord) error {
	record = normalizeIdentityRecord(record)
	if record.ID == "" {
		return nil
	}
	store, err := s.identityCollection()
	if err != nil {
		return err
	}
	if existing, ok, err := store.Get(ctx, record.ID); err == nil && ok {
		record = mergeIdentityRecord(existing, record)
	}
	return store.Set(ctx, record.ID, record)
}

func (s *Service) listIdentityRecords(ctx context.Context) ([]IdentityUserRecord, error) {
	store, err := s.identityCollection()
	if err != nil {
		return nil, err
	}
	records, err := store.List(ctx)
	if err != nil {
		return nil, err
	}
	for i := range records {
		records[i] = normalizeIdentityRecord(records[i])
	}
	return records, nil
}

func (s *Service) slackIdentityRecords(ctx context.Context) ([]IdentityUserRecord, error) {
	if strings.TrimSpace(s.slackBotToken) == "" {
		return nil, nil
	}
	s.slackUsersMu.Lock()
	if time.Since(s.slackUsersFetchedAt) < slackUsersCacheTTL && s.slackUsersCache != nil {
		cached := append([]IdentityUserRecord(nil), s.slackUsersCache...)
		s.slackUsersMu.Unlock()
		return cached, nil
	}
	s.slackUsersMu.Unlock()

	records, err := s.fetchSlackIdentityRecords(ctx)
	if err != nil {
		s.slackUsersMu.Lock()
		s.slackUsersCache = []IdentityUserRecord{}
		s.slackUsersFetchedAt = time.Now()
		s.slackUsersMu.Unlock()
		return nil, err
	}
	for _, record := range records {
		if err := s.upsertIdentityRecord(ctx, record); err != nil {
			s.logger.Warn("identity resolver slack user persist failed", "slack_user_id", record.SlackUserID, "error", err)
		}
	}

	s.slackUsersMu.Lock()
	s.slackUsersCache = append([]IdentityUserRecord(nil), records...)
	s.slackUsersFetchedAt = time.Now()
	s.slackUsersMu.Unlock()
	return records, nil
}

func (s *Service) fetchSlackIdentityRecords(ctx context.Context) ([]IdentityUserRecord, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(s.slackAPIBaseURL), "/")
	if baseURL == "" {
		baseURL = defaultSlackAPIBaseURL
	}

	var out []IdentityUserRecord
	cursor := ""
	for page := 0; page < 10; page++ {
		values := url.Values{}
		values.Set("limit", "200")
		if cursor != "" {
			values.Set("cursor", cursor)
		}
		requestURL := baseURL + "/users.list?" + values.Encode()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Authorization", "Bearer "+s.slackBotToken)

		response, err := s.httpClient.Do(request)
		if err != nil {
			return nil, fmt.Errorf("slack users.list: %w", err)
		}
		var body slackUsersListResponse
		decodeErr := json.NewDecoder(response.Body).Decode(&body)
		_ = response.Body.Close()
		if decodeErr != nil {
			return nil, fmt.Errorf("decode slack users.list: %w", decodeErr)
		}
		if !body.OK {
			return nil, fmt.Errorf("slack users.list: %s", firstNonEmpty(body.Error, response.Status))
		}
		for _, member := range body.Members {
			if record := identityRecordFromSlackUser(member); record.ID != "" {
				out = append(out, record)
			}
		}
		cursor = strings.TrimSpace(body.ResponseMetadata.NextCursor)
		if cursor == "" {
			break
		}
	}
	return out, nil
}

type slackUsersListResponse struct {
	OK               bool              `json:"ok"`
	Error            string            `json:"error"`
	Members          []slackUserMember `json:"members"`
	ResponseMetadata struct {
		NextCursor string `json:"next_cursor"`
	} `json:"response_metadata"`
}

type slackUserMember struct {
	ID        string `json:"id"`
	TeamID    string `json:"team_id"`
	Name      string `json:"name"`
	RealName  string `json:"real_name"`
	Deleted   bool   `json:"deleted"`
	IsBot     bool   `json:"is_bot"`
	IsAppUser bool   `json:"is_app_user"`
	Profile   struct {
		RealName              string `json:"real_name"`
		RealNameNormalized    string `json:"real_name_normalized"`
		DisplayName           string `json:"display_name"`
		DisplayNameNormalized string `json:"display_name_normalized"`
		Email                 string `json:"email"`
		FirstName             string `json:"first_name"`
		LastName              string `json:"last_name"`
	} `json:"profile"`
}

func identityRecordFromSlackUser(member slackUserMember) IdentityUserRecord {
	if strings.TrimSpace(member.ID) == "" || member.Deleted || member.IsBot || member.IsAppUser {
		return IdentityUserRecord{}
	}
	canonical := firstNonEmpty(member.Profile.RealName, member.RealName, member.Profile.DisplayName, member.Name, member.ID)
	aliases := compactUniqueIdentityStrings([]string{
		member.Name,
		member.RealName,
		member.Profile.RealName,
		member.Profile.RealNameNormalized,
		member.Profile.DisplayName,
		member.Profile.DisplayNameNormalized,
		member.Profile.FirstName,
		member.Profile.LastName,
		member.ID,
	})
	return normalizeIdentityRecord(IdentityUserRecord{
		ID:               "slack:" + strings.TrimSpace(member.ID),
		CanonicalName:    canonical,
		PreferredName:    firstNonEmpty(member.Profile.DisplayName, canonical),
		Role:             "workspace_member",
		Aliases:          aliases,
		MeetDisplayNames: compactUniqueIdentityStrings([]string{member.Profile.DisplayName, member.Profile.RealName, member.RealName}),
		SlackUserID:      strings.TrimSpace(member.ID),
		SlackTeamID:      strings.TrimSpace(member.TeamID),
		Email:            strings.TrimSpace(member.Profile.Email),
		Sources:          []string{"slack_users_list"},
		UpdatedAt:        time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (s *Service) calendarIdentityRecords(ctx context.Context, meetingURL string, attendees []identityAttendeeInput) []IdentityUserRecord {
	var records []IdentityUserRecord
	for _, attendee := range attendees {
		if record := identityRecordFromCalendarAttendee(attendee, meetingURL); record.ID != "" {
			records = append(records, record)
			_ = s.upsertIdentityRecord(ctx, record)
		}
	}
	meetURL := strings.TrimSpace(meetingURL)
	if meetURL == "" {
		return records
	}
	for _, attendee := range s.calendarAttendeesForMeet(ctx, meetURL) {
		record := identityRecordFromCalendarAttendee(identityAttendeeInput{
			Name:  stringFromAny(attendee["name"]),
			Email: stringFromAny(attendee["email"]),
			Role:  stringFromAny(attendee["role"]),
		}, meetURL)
		if record.ID != "" {
			records = append(records, record)
			_ = s.upsertIdentityRecord(ctx, record)
		}
	}
	return records
}

func (s *Service) calendarAttendeesForMeet(ctx context.Context, meetingURL string) []map[string]any {
	meetURL := strings.TrimSpace(meetingURL)
	if meetings, err := s.ListMeetdMeetings(ctx, ""); err == nil {
		var selected *MeetdMeetingRecord
		for _, meeting := range meetings {
			if meetURL != "" && normalizeIdentityToken(meeting.MeetURL) != normalizeIdentityToken(meetURL) {
				continue
			}
			if selected == nil || meeting.StartTime.After(selected.StartTime) {
				copy := meeting
				selected = &copy
			}
		}
		if selected == nil {
			return []map[string]any{}
		}
		out := make([]map[string]any, 0, len(selected.Attendees))
		for _, attendee := range selected.Attendees {
			name, email := parseAttendeeNameEmail(attendee)
			if name == "" {
				name = attendee
			}
			out = append(out, map[string]any{
				"name":       name,
				"email":      email,
				"role":       "external",
				"source":     "calendar_attendees",
				"meeting_id": selected.ID,
				"meet_url":   selected.MeetURL,
			})
		}
		return out
	}
	return []map[string]any{}
}

func identityRecordFromCalendarAttendee(attendee identityAttendeeInput, meetingURL string) IdentityUserRecord {
	name := firstNonEmpty(attendee.DisplayName, attendee.Name)
	email := strings.TrimSpace(attendee.Email)
	if parsedName, parsedEmail := parseAttendeeNameEmail(name); parsedName != "" || parsedEmail != "" {
		name = firstNonEmpty(parsedName, name)
		email = firstNonEmpty(email, parsedEmail)
	}
	canonical := firstNonEmpty(name, email)
	if strings.TrimSpace(canonical) == "" {
		return IdentityUserRecord{}
	}
	id := "calendar:" + normalizeIdentityToken(firstNonEmpty(email, canonical, meetingURL))
	return normalizeIdentityRecord(IdentityUserRecord{
		ID:               id,
		CanonicalName:    canonical,
		PreferredName:    canonical,
		Role:             firstNonEmpty(attendee.Role, "external"),
		Aliases:          compactUniqueIdentityStrings(append(attendee.Aliases, name, emailLocalPart(email))),
		MeetDisplayNames: compactUniqueIdentityStrings([]string{name}),
		Email:            email,
		CalendarEmails:   compactUniqueIdentityStrings([]string{email}),
		Sources:          []string{"calendar_attendees"},
		UpdatedAt:        time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func identityRecordFromLearn(input identityLearnInput) IdentityUserRecord {
	canonical := strings.TrimSpace(input.CanonicalName)
	if canonical == "" {
		canonical = firstNonEmpty(input.PreferredName, input.Email, input.SlackUserID)
	}
	if canonical == "" {
		return IdentityUserRecord{}
	}
	id := "person:" + normalizeIdentityToken(firstNonEmpty(input.Email, input.SlackUserID, canonical))
	return normalizeIdentityRecord(IdentityUserRecord{
		ID:                  id,
		CanonicalName:       canonical,
		PreferredName:       input.PreferredName,
		HonorificPreference: input.HonorificPreference,
		Role:                input.Role,
		Aliases:             input.Aliases,
		MeetDisplayNames:    input.MeetDisplayNames,
		SlackUserID:         input.SlackUserID,
		SlackTeamID:         input.SlackTeamID,
		Email:               input.Email,
		CalendarEmails:      input.CalendarEmails,
		Linear:              input.Linear,
		GitHub:              input.GitHub,
		Sources:             []string{"people_memory"},
		UpdatedAt:           time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func bestIdentityMatch(displayName string, records []IdentityUserRecord) (identityMatchCandidate, bool, bool) {
	query := normalizeIdentityToken(displayName)
	if query == "" {
		return identityMatchCandidate{}, false, false
	}
	matches := map[string]*identityMatchCandidate{}
	for _, record := range records {
		score, evidence := scoreIdentityRecord(query, record)
		if score == 0 {
			continue
		}
		key := identityRecordKey(record)
		if key == "" {
			key = normalizeIdentityToken(record.CanonicalName)
		}
		match := matches[key]
		if match == nil {
			record = normalizeIdentityRecord(record)
			match = &identityMatchCandidate{
				record:  record,
				sources: map[string]bool{},
			}
			matches[key] = match
		} else {
			match.record = mergeIdentityRecord(match.record, record)
		}
		if score > match.score {
			match.score = score
		}
		match.evidence = compactUniqueIdentityStrings(append(match.evidence, evidence...))
		for _, source := range record.Sources {
			match.sources[source] = true
		}
	}
	if len(matches) == 0 {
		return identityMatchCandidate{}, false, false
	}
	var best *identityMatchCandidate
	ambiguous := false
	for _, match := range matches {
		if best == nil || match.score > best.score || (match.score == best.score && match.record.Role == "current_user" && best.record.Role != "current_user") {
			best = match
			ambiguous = false
			continue
		}
		if match.score == best.score && match.record.Role != "current_user" && best.record.Role != "current_user" {
			ambiguous = true
		}
	}
	if best == nil {
		return identityMatchCandidate{}, false, false
	}
	return *best, true, ambiguous
}

func scoreIdentityRecord(query string, record IdentityUserRecord) (int, []string) {
	record = normalizeIdentityRecord(record)
	score := 0
	var evidence []string
	for _, token := range identityRecordTokens(record) {
		normalized := normalizeIdentityToken(token.value)
		if normalized == "" {
			continue
		}
		switch {
		case normalized == query:
			score = max(score, token.score)
			evidence = append(evidence, fmt.Sprintf("exact_%s:%s", token.kind, token.value))
		case len(query) >= 3 && len(normalized) >= 3 && (strings.HasPrefix(normalized, query) || strings.HasPrefix(query, normalized)):
			score = max(score, min(token.score-15, 80))
			evidence = append(evidence, fmt.Sprintf("prefix_%s:%s", token.kind, token.value))
		case len(query) >= 4 && len(normalized) >= 4 && (strings.Contains(normalized, query) || strings.Contains(query, normalized)):
			score = max(score, min(token.score-25, 70))
			evidence = append(evidence, fmt.Sprintf("partial_%s:%s", token.kind, token.value))
		}
	}
	if score > 0 && record.Role == "current_user" {
		score += 10
	}
	return score, compactUniqueIdentityStrings(evidence)
}

type identityToken struct {
	kind  string
	value string
	score int
}

func identityRecordTokens(record IdentityUserRecord) []identityToken {
	var tokens []identityToken
	add := func(kind string, score int, values ...string) {
		for _, value := range values {
			if strings.TrimSpace(value) != "" {
				tokens = append(tokens, identityToken{kind: kind, value: value, score: score})
			}
		}
	}
	add("canonical_name", 100, record.CanonicalName)
	add("preferred_name", 98, record.PreferredName, record.HonorificPreference)
	add("slack_user_id", 100, record.SlackUserID)
	add("email", 96, record.Email)
	add("linear", 92, record.Linear)
	add("github", 92, record.GitHub)
	for _, email := range record.CalendarEmails {
		add("calendar_email", 96, email, emailLocalPart(email))
	}
	for _, alias := range record.Aliases {
		add("alias", 95, alias)
	}
	for _, displayName := range record.MeetDisplayNames {
		add("meet_display_name", 95, displayName)
	}
	return tokens
}

func identityResult(displayName string, source string, match identityMatchCandidate) map[string]any {
	record := normalizeIdentityRecord(match.record)
	sourceNames := boolMapKeys(match.sources)
	sourceCount := len(sourceNames)
	confidence := "low"
	if record.Role == "current_user" || sourceCount >= 2 {
		confidence = "high"
	} else if match.score >= 90 {
		confidence = "medium"
	}
	preferred := firstNonEmpty(record.HonorificPreference, record.PreferredName, record.CanonicalName, displayName)
	crossServiceIDs := map[string]any{
		"slack_user_id":      record.SlackUserID,
		"slack_team_id":      record.SlackTeamID,
		"calendar_emails":    record.CalendarEmails,
		"email":              record.Email,
		"linear":             record.Linear,
		"github":             record.GitHub,
		"meet_display_names": record.MeetDisplayNames,
	}
	evidence := compactUniqueIdentityStrings(append(match.evidence, sourceEvidence(sourceNames)...))
	return map[string]any{
		"display_name":       strings.TrimSpace(displayName),
		"canonical_name":     firstNonEmpty(record.CanonicalName, displayName),
		"preferred_name":     preferred,
		"role":               firstNonEmpty(record.Role, "external"),
		"aliases":            record.Aliases,
		"confidence":         confidence,
		"evidence":           evidence,
		"is_current_user":    record.Role == "current_user",
		"source":             strings.TrimSpace(source),
		"sources":            sourceNames,
		"source_match_count": sourceCount,
		"resolver":           "identity_resolver_v2",
		"privacy_context":    "safe_for_prompt",
		"pii_fields_used":    piiFieldsUsed(record),
		"pii_fields_shown":   []string{},
		"cross_service_ids":  crossServiceIDs,
	}
}

func identityFallback(displayName string, source string, evidence []string) map[string]any {
	name := strings.TrimSpace(displayName)
	role := "external"
	if name == "" {
		role = "unknown"
	}
	return map[string]any{
		"display_name":       name,
		"canonical_name":     name,
		"preferred_name":     name,
		"role":               role,
		"aliases":            []string{},
		"confidence":         "low",
		"evidence":           compactUniqueIdentityStrings(evidence),
		"is_current_user":    false,
		"source":             strings.TrimSpace(source),
		"sources":            []string{},
		"source_match_count": 0,
		"resolver":           "identity_resolver_v2",
		"privacy_context":    "safe_for_prompt",
		"pii_fields_used":    []string{"display_name"},
		"pii_fields_shown":   []string{},
		"cross_service_ids":  map[string]any{},
	}
}

func normalizeIdentityRecord(record IdentityUserRecord) IdentityUserRecord {
	record.ID = strings.TrimSpace(record.ID)
	record.CanonicalName = strings.TrimSpace(record.CanonicalName)
	record.PreferredName = strings.TrimSpace(record.PreferredName)
	record.HonorificPreference = strings.TrimSpace(record.HonorificPreference)
	record.Role = strings.TrimSpace(record.Role)
	record.SlackUserID = strings.TrimSpace(record.SlackUserID)
	record.SlackTeamID = strings.TrimSpace(record.SlackTeamID)
	record.Email = strings.TrimSpace(record.Email)
	record.Linear = strings.TrimSpace(record.Linear)
	record.GitHub = strings.TrimSpace(record.GitHub)
	record.Aliases = compactUniqueIdentityStrings(record.Aliases)
	record.MeetDisplayNames = compactUniqueIdentityStrings(record.MeetDisplayNames)
	record.CalendarEmails = compactUniqueIdentityStrings(record.CalendarEmails)
	record.Sources = compactUniqueIdentityStrings(record.Sources)
	if record.Role == "" {
		record.Role = "external"
	}
	if record.PreferredName == "" {
		record.PreferredName = record.CanonicalName
	}
	if record.UpdatedAt == "" {
		record.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	return record
}

func mergeIdentityRecords(records []IdentityUserRecord) []IdentityUserRecord {
	merged := map[string]IdentityUserRecord{}
	order := []string{}
	for _, record := range records {
		record = normalizeIdentityRecord(record)
		if record.ID == "" {
			continue
		}
		key := identityRecordKey(record)
		if key == "" {
			key = record.ID
		}
		if existing, ok := merged[key]; ok {
			merged[key] = mergeIdentityRecord(existing, record)
		} else {
			merged[key] = record
			order = append(order, key)
		}
	}
	out := make([]IdentityUserRecord, 0, len(order))
	for _, key := range order {
		out = append(out, merged[key])
	}
	return out
}

func mergeIdentityRecord(base IdentityUserRecord, next IdentityUserRecord) IdentityUserRecord {
	base = normalizeIdentityRecord(base)
	next = normalizeIdentityRecord(next)
	if next.ID != "" && strings.HasPrefix(next.ID, "workspace:") {
		base.ID = next.ID
	}
	base.CanonicalName = firstNonEmpty(base.CanonicalName, next.CanonicalName)
	if next.Role == "current_user" || base.Role == "" {
		base.Role = next.Role
	}
	base.PreferredName = firstNonEmpty(next.PreferredName, base.PreferredName, base.CanonicalName)
	base.HonorificPreference = firstNonEmpty(next.HonorificPreference, base.HonorificPreference)
	base.SlackUserID = firstNonEmpty(base.SlackUserID, next.SlackUserID)
	base.SlackTeamID = firstNonEmpty(base.SlackTeamID, next.SlackTeamID)
	base.Email = firstNonEmpty(base.Email, next.Email)
	base.Linear = firstNonEmpty(base.Linear, next.Linear)
	base.GitHub = firstNonEmpty(base.GitHub, next.GitHub)
	base.Aliases = compactUniqueIdentityStrings(append(base.Aliases, next.Aliases...))
	base.MeetDisplayNames = compactUniqueIdentityStrings(append(base.MeetDisplayNames, next.MeetDisplayNames...))
	base.CalendarEmails = compactUniqueIdentityStrings(append(base.CalendarEmails, next.CalendarEmails...))
	base.Sources = compactUniqueIdentityStrings(append(base.Sources, next.Sources...))
	base.UpdatedAt = firstNonEmpty(next.UpdatedAt, base.UpdatedAt)
	return normalizeIdentityRecord(base)
}

func identityRecordKey(record IdentityUserRecord) string {
	if email := normalizeIdentityToken(firstNonEmpty(record.Email, firstString(record.CalendarEmails))); email != "" {
		return "email:" + email
	}
	if record.SlackUserID != "" {
		return "slack:" + normalizeIdentityToken(record.SlackUserID)
	}
	if record.Role == "current_user" {
		return "current_user"
	}
	if record.ID != "" {
		return record.ID
	}
	return normalizeIdentityToken(record.CanonicalName)
}

func normalizeIdentityToken(value string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(strings.ToLower(strings.NewReplacer("·", " ", "・", " ").Replace(value))) {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func normalizeSpeakerIdentityText(value string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(strings.NewReplacer("·", " ", "・", " ").Replace(value)))), " ")
}

func preferredSpeakerAddress(aliases []string, fallback string) string {
	for _, alias := range aliases {
		for _, r := range alias {
			if r >= '\u4e00' && r <= '\u9fff' {
				return alias
			}
		}
	}
	return fallback
}

func compactUniqueIdentityStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		text := strings.TrimSpace(value)
		if text == "" {
			continue
		}
		key := normalizeIdentityToken(text)
		if key == "" {
			key = strings.ToLower(text)
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, text)
	}
	return out
}

func boolMapKeys(values map[string]bool) []string {
	out := make([]string, 0, len(values))
	for key := range values {
		if strings.TrimSpace(key) != "" {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}

func sourceEvidence(sources []string) []string {
	out := make([]string, 0, len(sources))
	for _, source := range sources {
		out = append(out, "source:"+source)
	}
	return out
}

func piiFieldsUsed(record IdentityUserRecord) []string {
	fields := []string{"display_name"}
	if record.Email != "" || len(record.CalendarEmails) > 0 {
		fields = append(fields, "email")
	}
	if record.SlackUserID != "" {
		fields = append(fields, "slack_user_id")
	}
	if record.Linear != "" {
		fields = append(fields, "linear")
	}
	if record.GitHub != "" {
		fields = append(fields, "github")
	}
	return compactUniqueIdentityStrings(fields)
}

func parseAttendeeNameEmail(value string) (string, string) {
	text := strings.TrimSpace(value)
	if text == "" {
		return "", ""
	}
	if start := strings.LastIndex(text, "<"); start >= 0 && strings.HasSuffix(text, ">") {
		name := strings.TrimSpace(text[:start])
		email := strings.TrimSpace(strings.TrimSuffix(text[start+1:], ">"))
		return name, email
	}
	if strings.Contains(text, "@") && !strings.Contains(text, " ") {
		return "", text
	}
	return text, ""
}

func emailLocalPart(email string) string {
	email = strings.TrimSpace(email)
	if index := strings.Index(email, "@"); index > 0 {
		return email[:index]
	}
	return ""
}

func firstString(values []string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
