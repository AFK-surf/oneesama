package slackagent

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const (
	semanticMemoryProviderName     = "local_semantic"
	semanticMemoryDefaultDimension = 256
	semanticMemoryMinimumScore     = 0.18
)

type semanticMemoryProvider struct {
	SlackMemoryNoopProvider
	enabled     bool
	indexPath   string
	workspace   string
	mu          sync.Mutex
	documents   []semanticMemoryDocument
	dimension   int
	initialized bool
}

type semanticMemoryDocument struct {
	ID         string    `json:"id,omitempty"`
	Kind       string    `json:"kind,omitempty"`
	Source     string    `json:"source"`
	SourcePath string    `json:"sourcePath,omitempty"`
	Title      string    `json:"title,omitempty"`
	Content    string    `json:"content"`
	StartLine  int       `json:"startLine,omitempty"`
	EndLine    int       `json:"endLine,omitempty"`
	Vector     []float64 `json:"vector,omitempty"`
}

type semanticMemoryIndexFile struct {
	Schema    string                   `json:"schema,omitempty"`
	Provider  string                   `json:"provider,omitempty"`
	Dimension int                      `json:"dimension,omitempty"`
	Documents []semanticMemoryDocument `json:"documents"`
}

func newSemanticMemoryProvider(cfg appconfig.SlackMemoryConfig) SlackMemoryProvider {
	return &semanticMemoryProvider{
		enabled:   cfg.SemanticEnabled,
		indexPath: strings.TrimSpace(cfg.SemanticIndexPath),
	}
}

func (p *semanticMemoryProvider) Name() string { return semanticMemoryProviderName }

func (p *semanticMemoryProvider) Available() bool {
	return p != nil && p.enabled
}

func (p *semanticMemoryProvider) Initialize(_ context.Context, init SlackMemoryProviderInit) error {
	if p == nil || !p.enabled {
		return nil
	}
	p.workspace = strings.TrimSpace(init.WorkspaceDir)
	if p.indexPath == "" && p.workspace != "" {
		p.indexPath = filepath.Join(p.workspace, "memory", "indexes", "semantic-memory.json")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.documents = nil
	p.dimension = 0
	p.initialized = true
	if p.indexPath == "" {
		return nil
	}
	raw, err := os.ReadFile(p.indexPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var index semanticMemoryIndexFile
	if err := json.Unmarshal(raw, &index); err != nil {
		return err
	}
	p.dimension = index.Dimension
	for _, document := range index.Documents {
		document.Content = strings.TrimSpace(document.Content)
		if document.Content == "" {
			continue
		}
		if p.dimension <= 0 && len(document.Vector) > 0 {
			p.dimension = len(document.Vector)
		}
		if len(document.Vector) == 0 {
			document.Vector = semanticMemoryVector(document.Content, p.dimension)
		}
		if p.dimension <= 0 {
			p.dimension = len(document.Vector)
		}
		p.documents = append(p.documents, document)
	}
	return nil
}

func (p *semanticMemoryProvider) Search(_ context.Context, request SlackMemoryProviderSearchRequest) (SlackMemoryProviderSearchResult, error) {
	result := SlackMemoryProviderSearchResult{Provider: semanticMemoryProviderName, Status: "ok"}
	if p == nil || !p.enabled {
		result.Status = "disabled"
		return result, nil
	}
	query := strings.TrimSpace(request.Query)
	if query == "" {
		result.Status = "no_query"
		return result, nil
	}
	p.mu.Lock()
	documents := append([]semanticMemoryDocument(nil), p.documents...)
	dimension := p.dimension
	p.mu.Unlock()
	if len(documents) == 0 {
		result.Status = "empty"
		return result, nil
	}
	if dimension <= 0 {
		dimension = semanticMemoryDefaultDimension
	}
	queryVector := semanticMemoryVector(query, dimension)
	type scoredDocument struct {
		document semanticMemoryDocument
		score    float64
	}
	var scored []scoredDocument
	for _, document := range documents {
		vector := document.Vector
		if len(vector) == 0 {
			vector = semanticMemoryVector(document.Content, dimension)
		}
		score := cosineSimilarity(queryVector, vector)
		if score < semanticMemoryMinimumScore {
			continue
		}
		scored = append(scored, scoredDocument{document: document, score: score})
	}
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].score == scored[j].score {
			return scored[i].document.Source < scored[j].document.Source
		}
		return scored[i].score > scored[j].score
	})
	limit := request.Limit
	if limit <= 0 {
		limit = relatedMemoryDefaultLimit
	}
	for _, item := range scored {
		if len(result.Records) >= limit {
			break
		}
		document := item.document
		record := SlackRelatedMemoryRecord{
			Kind:       firstNonEmpty(strings.TrimSpace(document.Kind), "semantic_memory"),
			Source:     firstNonEmpty(strings.TrimSpace(document.Source), strings.TrimSpace(document.ID), semanticMemoryProviderName),
			SourcePath: strings.TrimSpace(document.SourcePath),
			SourceRef:  strings.TrimSpace(document.ID),
			Title:      strings.TrimSpace(document.Title),
			StartLine:  document.StartLine,
			EndLine:    document.EndLine,
			Content:    truncateSlackContextText(strings.TrimSpace(document.Content), relatedMemorySnippetLimit),
			Score:      item.score,
			Reasons:    []string{"semantic_vector_match"},
		}
		result.Records = append(result.Records, record)
	}
	if len(result.Records) == 0 {
		result.Status = "no_relevant_memory"
	}
	return result, nil
}

func (p *semanticMemoryProvider) OnMemoryWrite(_ context.Context, event SlackMemoryProviderWriteEvent) error {
	if p == nil || !p.enabled || strings.TrimSpace(event.Content) == "" {
		return nil
	}
	content := strings.TrimSpace(event.Content)
	source := firstNonEmpty(strings.TrimSpace(event.Path), strings.TrimSpace(event.Source), "memory_write")
	p.mu.Lock()
	defer p.mu.Unlock()
	dimension := p.dimension
	if dimension <= 0 {
		dimension = semanticMemoryDefaultDimension
		p.dimension = dimension
	}
	p.documents = append(p.documents, semanticMemoryDocument{
		ID:      source,
		Kind:    "memory_write",
		Source:  source,
		Title:   semanticMemoryTitle(content),
		Content: content,
		Vector:  semanticMemoryVector(content, dimension),
	})
	return nil
}

func semanticMemoryVector(text string, dimension int) []float64 {
	if dimension <= 0 {
		dimension = semanticMemoryDefaultDimension
	}
	vector := make([]float64, dimension)
	tokens := relatedMemoryTokens(text)
	if len(tokens) == 0 {
		tokens = memoryKeywords(text)
	}
	for _, token := range tokens {
		token = strings.TrimSpace(strings.ToLower(token))
		if token == "" {
			continue
		}
		for _, bucket := range semanticMemoryTokenBuckets(token, dimension) {
			vector[bucket.index] += bucket.weight
		}
	}
	norm := 0.0
	for _, value := range vector {
		norm += value * value
	}
	if norm <= 0 {
		return vector
	}
	norm = math.Sqrt(norm)
	for i := range vector {
		vector[i] = vector[i] / norm
	}
	return vector
}

type semanticMemoryBucket struct {
	index  int
	weight float64
}

func semanticMemoryTokenBuckets(token string, dimension int) []semanticMemoryBucket {
	hash := fnv1a64(token)
	out := []semanticMemoryBucket{{index: int(hash % uint64(dimension)), weight: 1}}
	if len(token) >= 5 {
		for i := 0; i+3 <= len(token) && len(out) < 4; i += 2 {
			gram := token[i:minInt(i+3, len(token))]
			out = append(out, semanticMemoryBucket{index: int(fnv1a64(gram) % uint64(dimension)), weight: 0.35})
		}
	}
	return out
}

func fnv1a64(value string) uint64 {
	const (
		offset = uint64(14695981039346656037)
		prime  = uint64(1099511628211)
	)
	h := offset
	for i := 0; i < len(value); i++ {
		h ^= uint64(value[i])
		h *= prime
	}
	return h
}

func cosineSimilarity(a, b []float64) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	limit := minInt(len(a), len(b))
	sum := 0.0
	for i := 0; i < limit; i++ {
		sum += a[i] * b[i]
	}
	if math.IsNaN(sum) || math.IsInf(sum, 0) {
		return 0
	}
	return sum
}

func semanticMemoryTitle(content string) string {
	for _, line := range strings.Split(strings.TrimSpace(content), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(line, "#"))
		if line != "" {
			return truncateSlackContextText(line, 80)
		}
	}
	return ""
}
