package persistence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

const (
	DefaultCollection     = "default"
	DefaultDataDir        = "./runtime/state"
	defaultSQLiteFileName = "state.sqlite3"
)

type Provider string

const (
	ProviderMemory   Provider = "memory"
	ProviderJSONFile Provider = "json-file"
	ProviderSQLite   Provider = "sqlite"
)

type Entry struct {
	ID    string
	Value json.RawMessage
}

type Collection interface {
	Provider() Provider
	Name() string
	Path() string
	Get(ctx context.Context, id string) (Entry, bool, error)
	Put(ctx context.Context, entry Entry) error
	Delete(ctx context.Context, id string) error
	List(ctx context.Context) ([]Entry, error)
	Close() error
}

type Options struct {
	Provider   Provider
	Collection string
	DataDir    string
	FilePath   string
	SQLitePath string
}

func NormalizeProvider(raw string) Provider {
	switch normalized := strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(raw))); normalized {
	case "", "file", "persistent":
		return ProviderJSONFile
	case "memory", "in-memory":
		return ProviderMemory
	case "json-file":
		return ProviderJSONFile
	case "sqlite", "sqlite3", "better-sqlite3":
		return ProviderSQLite
	default:
		return Provider(normalized)
	}
}

func CollectionFilePath(dataDir string, collection string) string {
	resolvedDir := strings.TrimSpace(dataDir)
	if resolvedDir == "" {
		resolvedDir = DefaultDataDir
	}
	return filepath.Join(resolvedDir, fmt.Sprintf("%s.json", strings.TrimSpace(collection)))
}

func SQLiteFilePath(dataDir string) string {
	resolvedDir := strings.TrimSpace(dataDir)
	if resolvedDir == "" {
		resolvedDir = DefaultDataDir
	}
	return filepath.Join(resolvedDir, defaultSQLiteFileName)
}

func Open(options Options) (Collection, error) {
	resolved, err := options.withDefaults()
	if err != nil {
		return nil, err
	}

	switch resolved.Provider {
	case ProviderMemory:
		return newMemoryCollection(resolved.Collection), nil
	case ProviderJSONFile:
		return newJSONFileCollection(resolved.FilePath, resolved.Collection)
	case ProviderSQLite:
		return newSQLiteCollection(resolved.SQLitePath, resolved.Collection)
	default:
		return nil, fmt.Errorf("unsupported persistence provider %q", resolved.Provider)
	}
}

func (o Options) withDefaults() (Options, error) {
	resolved := o
	resolved.Provider = NormalizeProvider(resolved.Provider.String())
	if resolved.Provider == "" {
		resolved.Provider = ProviderJSONFile
	}
	if strings.TrimSpace(resolved.Collection) == "" {
		resolved.Collection = DefaultCollection
	}
	if strings.TrimSpace(resolved.DataDir) == "" {
		resolved.DataDir = DefaultDataDir
	}
	if strings.TrimSpace(resolved.FilePath) == "" {
		resolved.FilePath = CollectionFilePath(resolved.DataDir, resolved.Collection)
	}
	if strings.TrimSpace(resolved.SQLitePath) == "" {
		resolved.SQLitePath = SQLiteFilePath(resolved.DataDir)
	}
	if err := validateCollectionName(resolved.Collection); err != nil {
		return Options{}, err
	}
	return resolved, nil
}

func validateCollectionName(collection string) error {
	name := strings.TrimSpace(collection)
	if name == "" {
		return errors.New("collection name is required")
	}
	if strings.ContainsRune(name, filepath.Separator) {
		return fmt.Errorf("collection name %q must not contain path separators", collection)
	}
	return nil
}

func (p Provider) String() string {
	return string(p)
}
