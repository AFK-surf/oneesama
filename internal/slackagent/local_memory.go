package slackagent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const slackMemorySnippetLimit = 900

type localSlackMemory struct {
	enabled      bool
	rootDir      string
	workspaceDir string
	seed         map[string]any
}

func newLocalSlackMemory(cfg appconfig.SlackMemoryConfig) *localSlackMemory {
	rootDir := strings.TrimSpace(cfg.Dir)
	if rootDir == "" {
		rootDir = "./runtime/slack-memory"
	}
	absRoot, err := filepath.Abs(rootDir)
	if err == nil {
		rootDir = absRoot
	}
	memory := &localSlackMemory{
		enabled:      cfg.Enabled,
		rootDir:      rootDir,
		workspaceDir: filepath.Join(rootDir, "workspace"),
	}
	memory.seed = memory.readSeed()
	return memory
}

func (m *localSlackMemory) Summary() SlackMemorySummary {
	if m == nil {
		return SlackMemorySummary{}
	}
	return SlackMemorySummary{
		Enabled:      m.enabled,
		RootDir:      m.rootDir,
		WorkspaceDir: m.workspaceDir,
		Manifest:     m.readJSONFile(filepath.Join(m.rootDir, "manifest.json")),
		FileCount:    len(m.listWorkspaceMemoryFiles()),
		Seed: SlackMemorySeedSummary{
			OK:              boolFromAny(m.seed["ok"], false),
			ChannelBrain:    len(arrayFromAny(m.seed["channelBrain"])),
			ThreadLedger:    len(arrayFromAny(m.seed["threadLedger"])),
			Channels:        len(arrayFromAny(m.seed["channels"])),
			FeedbackEntries: len(arrayFromAny(m.seed["feedbackEntries"])),
			TriageRuns:      len(arrayFromAny(m.seed["triageRuns"])),
		},
	}
}

func arrayFromAny(value any) []any {
	switch typed := value.(type) {
	case []any:
		return typed
	default:
		return nil
	}
}

func (m *localSlackMemory) Search(query string, limit int) []SlackMemoryResult {
	if m == nil || !m.enabled {
		return nil
	}
	keywords := memoryKeywords(query)
	if len(keywords) == 0 {
		return nil
	}
	results := append(m.fileSearchResults(keywords, limit), m.seedSearchResults(keywords, limit)...)
	sort.SliceStable(results, func(i, j int) bool {
		if results[i].Score == results[j].Score {
			if results[i].Kind == results[j].Kind {
				return results[i].Source < results[j].Source
			}
			return results[i].Kind < results[j].Kind
		}
		return results[i].Score > results[j].Score
	})
	return limitMemoryResults(results, limit)
}

func (m *localSlackMemory) BuildAgentContext(query string, limit int) SlackMemoryAgentContext {
	if m == nil || !m.enabled {
		return SlackMemoryAgentContext{Enabled: false}
	}
	results := m.Search(query, limit)
	return SlackMemoryAgentContext{
		Enabled:     true,
		Provenance:  "Local private Slack Agent D memory seed. Content lives in MAB_SLACK_MEMORY_DIR and is intentionally not committed.",
		Query:       strings.TrimSpace(query),
		ResultCount: len(results),
		Results:     results,
	}
}

func (m *localSlackMemory) readSeed() map[string]any {
	return m.readJSONFile(filepath.Join(m.rootDir, "legacy-slack-agent-seed.json"))
}

func (m *localSlackMemory) readJSONFile(path string) map[string]any {
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{}
	}
	return out
}

func (m *localSlackMemory) listWorkspaceMemoryFiles() []string {
	var files []string
	_ = filepath.WalkDir(m.workspaceDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(m.workspaceDir, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if isAllowedMemoryPath(rel) {
			files = append(files, rel)
		}
		return nil
	})
	sort.Strings(files)
	return files
}
