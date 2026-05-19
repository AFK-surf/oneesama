package slackagent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const entityGraphMemoryProviderName = "entity_graph"

var (
	entityGraphAliasLineRE = regexp.MustCompile(`(?i)\b([@A-Za-z][@A-Za-z0-9_.-]{1,})\s+(?:aliases?|aka|又名|别名)\s*(?:are|is|:|=|为|是)?\s*([^\n.。;；]+)`)
	entityGraphContactRE   = regexp.MustCompile(`(?i)\b([@A-Za-z][@A-Za-z0-9_.-]{1,})\b[^\n.。;；]{0,48}\b(?:contact|owner)\b[^\n.。;；]{0,20}(?:is|:|=)\s*([@A-Za-z][@A-Za-z0-9_.-]{1,})`)
	entityGraphOrgRE       = regexp.MustCompile(`(?i)\b([@A-Za-z][@A-Za-z0-9_.-]{1,})\b[^\n.。;；]{0,36}\b(?:org|organization|team|company)\b[^\n.。;；]{0,20}(?:is|:|=)\s*([@A-Za-z][@A-Za-z0-9_.-]{1,})`)
	entityGraphNotRE       = regexp.MustCompile(`(?i)\b([@A-Za-z][@A-Za-z0-9_.-]{1,})\b[^\n.。;；]{0,36}\b(?:not related to|not in|unrelated to|no relation to)\b[^\n.。;；]{0,20}\b([@A-Za-z][@A-Za-z0-9_.-]{1,})\b`)
	entityGraphTokenRE     = regexp.MustCompile(`@?[A-Za-z][A-Za-z0-9_.-]{1,}`)
)

type entityGraphMemoryProvider struct {
	SlackMemoryNoopProvider
	enabled      bool
	workspaceDir string
}

type entityGraphRelation struct {
	Subject    string
	Predicate  string
	Object     string
	SourcePath string
	Evidence   string
	Negative   bool
}

type entityGraphIndex struct {
	aliases   map[string]string
	display   map[string]string
	relations []entityGraphRelation
}

func newEntityGraphMemoryProvider(cfg appconfig.SlackMemoryConfig) SlackMemoryProvider {
	return &entityGraphMemoryProvider{enabled: cfg.Enabled}
}

func (p *entityGraphMemoryProvider) Name() string { return entityGraphMemoryProviderName }

func (p *entityGraphMemoryProvider) Available() bool {
	return p != nil && p.enabled
}

func (p *entityGraphMemoryProvider) Initialize(_ context.Context, init SlackMemoryProviderInit) error {
	if p == nil || !p.enabled {
		return nil
	}
	p.workspaceDir = strings.TrimSpace(init.WorkspaceDir)
	return nil
}

func (p *entityGraphMemoryProvider) Search(_ context.Context, request SlackMemoryProviderSearchRequest) (SlackMemoryProviderSearchResult, error) {
	result := SlackMemoryProviderSearchResult{Provider: entityGraphMemoryProviderName, Status: "ok"}
	if p == nil || !p.enabled {
		result.Status = "disabled"
		return result, nil
	}
	query := strings.TrimSpace(request.Query)
	if query == "" {
		result.Status = "no_query"
		return result, nil
	}
	index := buildEntityGraphIndex(p.workspaceDir)
	if len(index.relations) == 0 {
		result.Status = "empty"
		return result, nil
	}
	records := searchEntityGraph(index, query, request.Tokens, request.Limit)
	result.Records = records
	if len(result.Records) == 0 {
		result.Status = "no_relevant_memory"
	}
	return result, nil
}

func buildEntityGraphIndex(workspaceDir string) entityGraphIndex {
	index := entityGraphIndex{
		aliases: map[string]string{},
		display: map[string]string{},
	}
	index.addPeopleProfiles(workspaceDir)
	for _, relPath := range listDirectWorkspaceMemoryFiles(workspaceDir) {
		fullPath := filepath.Join(workspaceDir, filepath.FromSlash(relPath))
		raw, err := os.ReadFile(fullPath)
		if err != nil {
			continue
		}
		index.addDocument(relPath, string(raw))
	}
	return index
}

func (g *entityGraphIndex) addPeopleProfiles(workspaceDir string) {
	profiles, err := loadPeopleMemoryProfiles(workspaceDir)
	if err != nil {
		return
	}
	for _, profile := range profiles {
		g.addAlias(profile.Name, profile.Name)
		for _, alias := range profile.IdentityMap {
			g.addAlias(alias, profile.Name)
		}
		for _, fact := range append(append([]string{}, profile.DurableContext...), profile.CurrentResponsibilities...) {
			g.addDocument(profile.Source, fact)
		}
	}
}

func (g *entityGraphIndex) addDocument(relPath string, content string) {
	content = strings.TrimSpace(content)
	if content == "" {
		return
	}
	for _, match := range entityGraphAliasLineRE.FindAllStringSubmatch(content, -1) {
		canonical := g.canonical(match[1])
		for _, alias := range splitEntityAliases(match[2]) {
			g.addAlias(alias, canonical)
		}
	}
	for _, match := range entityGraphContactRE.FindAllStringSubmatch(content, -1) {
		g.addRelation(match[1], "contact", match[2], relPath, match[0], false)
	}
	for _, match := range entityGraphOrgRE.FindAllStringSubmatch(content, -1) {
		g.addRelation(match[1], "organization", match[2], relPath, match[0], false)
	}
	for _, match := range entityGraphNotRE.FindAllStringSubmatch(content, -1) {
		g.addRelation(match[1], "not_related_to", match[2], relPath, match[0], true)
	}
	g.addChineseRelations(relPath, content)
}

func (g *entityGraphIndex) addChineseRelations(relPath string, content string) {
	contextSubject := ""
	contextObject := ""
	for _, clause := range splitEntityGraphClauses(content) {
		entities := entityGraphEntitiesInText(clause)
		switch {
		case strings.Contains(clause, "contact") || strings.Contains(clause, "联系人") || strings.Contains(clause, "负责人"):
			if len(entities) >= 2 {
				g.addRelation(entities[0], "contact", entities[1], relPath, clause, false)
				contextSubject, contextObject = g.canonical(entities[0]), g.canonical(entities[1])
			}
		case strings.Contains(clause, "人在") || strings.Contains(clause, "组织") || strings.Contains(clause, "公司"):
			if len(entities) >= 1 && contextObject != "" {
				g.addRelation(contextObject, "organization", entities[len(entities)-1], relPath, clause, false)
			} else if len(entities) >= 2 {
				g.addRelation(entities[0], "organization", entities[1], relPath, clause, false)
			}
		case strings.Contains(clause, "没关系") || strings.Contains(clause, "无关") || strings.Contains(clause, "不属于"):
			if len(entities) >= 2 {
				g.addRelation(entities[0], "not_related_to", entities[len(entities)-1], relPath, clause, true)
			} else if len(entities) == 1 && contextSubject != "" {
				g.addRelation(contextSubject, "not_related_to", entities[0], relPath, clause, true)
			}
		}
	}
}

func (g *entityGraphIndex) addRelation(subject string, predicate string, object string, sourcePath string, evidence string, negative bool) {
	subject = g.canonical(subject)
	object = g.canonical(object)
	if subject == "" || object == "" || subject == object {
		return
	}
	relation := entityGraphRelation{
		Subject:    subject,
		Predicate:  strings.TrimSpace(predicate),
		Object:     object,
		SourcePath: filepath.ToSlash(sourcePath),
		Evidence:   strings.TrimSpace(evidence),
		Negative:   negative,
	}
	for _, existing := range g.relations {
		if existing.Subject == relation.Subject && existing.Predicate == relation.Predicate && existing.Object == relation.Object && existing.SourcePath == relation.SourcePath {
			return
		}
	}
	g.relations = append(g.relations, relation)
}

func (g *entityGraphIndex) addAlias(alias string, canonical string) {
	alias = strings.TrimSpace(alias)
	canonical = strings.TrimSpace(canonical)
	if alias == "" || canonical == "" {
		return
	}
	canonical = strings.TrimPrefix(canonical, "@")
	g.display[entityGraphKey(canonical)] = canonical
	for _, value := range entityGraphAliasVariants(alias) {
		g.aliases[entityGraphKey(value)] = canonical
	}
	for _, value := range entityGraphAliasVariants(canonical) {
		g.aliases[entityGraphKey(value)] = canonical
	}
}

func (g *entityGraphIndex) canonical(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	key := entityGraphKey(raw)
	if canonical, ok := g.aliases[key]; ok {
		return canonical
	}
	canonical := strings.TrimPrefix(raw, "@")
	g.addAlias(canonical, canonical)
	return canonical
}

func searchEntityGraph(index entityGraphIndex, query string, tokens []string, limit int) []SlackRelatedMemoryRecord {
	if limit <= 0 {
		limit = relatedMemoryDefaultLimit
	}
	queryEntities := entityGraphQueryEntities(index, query, tokens)
	if len(queryEntities) == 0 {
		return nil
	}
	seen := map[string]struct{}{}
	for _, entity := range queryEntities {
		seen[entity] = struct{}{}
	}
	var selected []entityGraphRelation
	for depth := 0; depth < 2; depth++ {
		added := false
		for _, relation := range index.relations {
			_, subjectSeen := seen[relation.Subject]
			_, objectSeen := seen[relation.Object]
			if !subjectSeen && !objectSeen {
				continue
			}
			if !entityGraphRelationIncluded(selected, relation) {
				selected = append(selected, relation)
				added = true
			}
			if !subjectSeen {
				seen[relation.Subject] = struct{}{}
			}
			if !objectSeen {
				seen[relation.Object] = struct{}{}
			}
		}
		if !added {
			break
		}
	}
	if len(selected) == 0 {
		return nil
	}
	sort.SliceStable(selected, func(i, j int) bool {
		if selected[i].SourcePath == selected[j].SourcePath {
			return entityGraphRelationText(selected[i]) < entityGraphRelationText(selected[j])
		}
		return selected[i].SourcePath < selected[j].SourcePath
	})
	content := renderEntityGraphEvidence(queryEntities, selected)
	source := firstNonEmpty(selected[0].SourcePath, "entity_graph")
	return []SlackRelatedMemoryRecord{{
		Kind:       "entity_graph",
		Source:     "entity_graph:" + source,
		SourcePath: source,
		Title:      "Entity graph evidence",
		Content:    truncateSlackContextText(content, relatedMemorySnippetLimit),
		Score:      entityGraphScore(queryEntities, selected),
		Reasons:    []string{"entity_graph_match", fmt.Sprintf("entity_graph_entities:%d", len(seen))},
	}}
}

func renderEntityGraphEvidence(queryEntities []string, relations []entityGraphRelation) string {
	var lines []string
	lines = append(lines, "Entity graph evidence")
	lines = append(lines, "Query entities: "+strings.Join(queryEntities, ", "))
	for _, relation := range relations {
		line := "- " + entityGraphRelationText(relation)
		if relation.SourcePath != "" {
			line += " (source: " + relation.SourcePath + ")"
		}
		if relation.Evidence != "" {
			line += " evidence: " + relation.Evidence
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func entityGraphRelationText(relation entityGraphRelation) string {
	switch relation.Predicate {
	case "contact":
		return fmt.Sprintf("%s contact is %s", relation.Subject, relation.Object)
	case "organization":
		return fmt.Sprintf("%s organization is %s", relation.Subject, relation.Object)
	case "not_related_to":
		return fmt.Sprintf("%s is not related to %s", relation.Subject, relation.Object)
	default:
		if relation.Negative {
			return fmt.Sprintf("%s is not %s %s", relation.Subject, relation.Predicate, relation.Object)
		}
		return fmt.Sprintf("%s %s %s", relation.Subject, relation.Predicate, relation.Object)
	}
}

func entityGraphScore(queryEntities []string, relations []entityGraphRelation) float64 {
	score := 0.74 + 0.04*float64(len(queryEntities)) + 0.03*float64(len(relations))
	if score > 0.98 {
		return 0.98
	}
	return score
}

func entityGraphQueryEntities(index entityGraphIndex, query string, tokens []string) []string {
	var out []string
	for _, token := range append(entityGraphEntitiesInText(query), tokens...) {
		canonical := index.canonical(token)
		if canonical == "" || entityGraphStopEntity(canonical) {
			continue
		}
		for _, relation := range index.relations {
			if relation.Subject == canonical || relation.Object == canonical {
				out = append(out, canonical)
				break
			}
		}
	}
	return compactUniqueStrings(out)
}

func entityGraphRelationIncluded(relations []entityGraphRelation, candidate entityGraphRelation) bool {
	for _, relation := range relations {
		if relation.Subject == candidate.Subject && relation.Predicate == candidate.Predicate && relation.Object == candidate.Object && relation.SourcePath == candidate.SourcePath {
			return true
		}
	}
	return false
}

func entityGraphEntitiesInText(text string) []string {
	var out []string
	for _, match := range entityGraphTokenRE.FindAllString(text, -1) {
		match = strings.Trim(match, " \t\r\n.,;:!?()[]{}<>\"'")
		if match == "" || entityGraphStopEntity(match) {
			continue
		}
		out = append(out, strings.TrimPrefix(match, "@"))
	}
	return compactUniqueStrings(out)
}

func splitEntityGraphClauses(content string) []string {
	return strings.FieldsFunc(content, func(r rune) bool {
		return r == '\n' || r == '.' || r == '。' || r == ';' || r == '；' || r == ',' || r == '，'
	})
}

func splitEntityAliases(text string) []string {
	var aliases []string
	for _, part := range strings.FieldsFunc(text, func(r rune) bool {
		return r == ',' || r == '，' || r == '/' || r == '、' || r == ';' || r == '；'
	}) {
		for _, candidate := range entityGraphEntitiesInText(part) {
			aliases = append(aliases, candidate)
		}
	}
	return compactUniqueStrings(aliases)
}

func entityGraphAliasVariants(value string) []string {
	value = strings.TrimSpace(value)
	value = strings.Trim(value, " \t\r\n.,;:!?()[]{}<>\"'")
	value = strings.TrimPrefix(value, "@")
	if value == "" {
		return nil
	}
	var out []string
	out = append(out, value, "@"+value)
	if entityGraphASCII(value) {
		out = append(out, "大"+value)
	}
	return compactUniqueStrings(out)
}

func entityGraphKey(value string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(value), "@"))
}

func entityGraphASCII(value string) bool {
	for _, r := range value {
		if r > 127 {
			return false
		}
	}
	return value != ""
}

func entityGraphStopEntity(value string) bool {
	switch strings.ToLower(strings.TrimPrefix(strings.TrimSpace(value), "@")) {
	case "", "contact", "owner", "organization", "org", "team", "company", "source", "memory", "entity", "graph", "evidence", "product", "line", "not", "related", "to", "is", "are", "the", "and", "with", "aliases", "aka":
		return true
	default:
		return false
	}
}
