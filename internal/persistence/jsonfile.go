package persistence

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const jsonFileSchema = "oneesama.collection.v1"

type jsonFileEnvelope struct {
	Schema     string          `json:"schema"`
	Collection string          `json:"collection,omitempty"`
	UpdatedAt  string          `json:"updated_at"`
	Items      []jsonFileEntry `json:"items"`
}

type jsonFileEntry struct {
	ID    string          `json:"id"`
	Value json.RawMessage `json:"value"`
}

type legacyJSONFileEnvelope struct {
	Items []json.RawMessage `json:"items"`
}

type jsonFileCollection struct {
	mu         sync.RWMutex
	collection string
	filePath   string
	items      map[string]json.RawMessage
}

func newJSONFileCollection(filePath string, collection string) (Collection, error) {
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return nil, fmt.Errorf("create json-file collection directory: %w", err)
	}

	items, err := loadJSONFileItems(filePath)
	if err != nil {
		return nil, err
	}

	return &jsonFileCollection{
		collection: strings.TrimSpace(collection),
		filePath:   filePath,
		items:      items,
	}, nil
}

func (c *jsonFileCollection) Provider() Provider {
	return ProviderJSONFile
}

func (c *jsonFileCollection) Name() string {
	return c.collection
}

func (c *jsonFileCollection) Path() string {
	return c.filePath
}

func (c *jsonFileCollection) Get(_ context.Context, id string) (Entry, bool, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	value, ok := c.items[id]
	if !ok {
		return Entry{}, false, nil
	}
	return Entry{
		ID:    id,
		Value: cloneJSON(value),
	}, true, nil
}

func (c *jsonFileCollection) Put(_ context.Context, entry Entry) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.items[entry.ID] = cloneJSON(entry.Value)
	return c.saveLocked()
}

func (c *jsonFileCollection) Delete(_ context.Context, id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	delete(c.items, id)
	return c.saveLocked()
}

func (c *jsonFileCollection) List(_ context.Context) ([]Entry, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	return mapEntries(c.items), nil
}

func (c *jsonFileCollection) Close() error {
	return nil
}

func (c *jsonFileCollection) saveLocked() error {
	envelope := jsonFileEnvelope{
		Schema:     jsonFileSchema,
		Collection: c.collection,
		UpdatedAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Items:      make([]jsonFileEntry, 0, len(c.items)),
	}

	for _, entry := range mapEntries(c.items) {
		envelope.Items = append(envelope.Items, jsonFileEntry{
			ID:    entry.ID,
			Value: cloneJSON(entry.Value),
		})
	}

	payload, err := json.MarshalIndent(envelope, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal json-file collection %s: %w", c.collection, err)
	}

	tmpPath := fmt.Sprintf("%s.%d.tmp", c.filePath, os.Getpid())
	if err := os.WriteFile(tmpPath, append(payload, '\n'), 0o644); err != nil {
		return fmt.Errorf("write json-file collection %s: %w", c.collection, err)
	}
	if err := os.Rename(tmpPath, c.filePath); err != nil {
		return fmt.Errorf("replace json-file collection %s: %w", c.collection, err)
	}
	return nil
}

func loadJSONFileItems(filePath string) (map[string]json.RawMessage, error) {
	items := make(map[string]json.RawMessage)

	raw, err := os.ReadFile(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return items, nil
		}
		return nil, fmt.Errorf("read json-file collection: %w", err)
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return items, nil
	}

	var envelope jsonFileEnvelope
	if err := json.Unmarshal(raw, &envelope); err == nil && isWrappedJSONFileEnvelope(envelope) {
		for _, item := range envelope.Items {
			if strings.TrimSpace(item.ID) == "" {
				return nil, fmt.Errorf("load json-file collection: item missing id")
			}
			items[item.ID] = cloneJSON(item.Value)
		}
		return items, nil
	}

	var legacy legacyJSONFileEnvelope
	if err := json.Unmarshal(raw, &legacy); err != nil {
		return nil, fmt.Errorf("parse json-file collection: %w", err)
	}

	for _, item := range legacy.Items {
		id, err := extractLegacyID(item)
		if err != nil {
			return nil, fmt.Errorf("load legacy json-file collection: %w", err)
		}
		items[id] = cloneJSON(item)
	}
	return items, nil
}

func isWrappedJSONFileEnvelope(envelope jsonFileEnvelope) bool {
	if envelope.Schema == jsonFileSchema {
		return true
	}
	if len(envelope.Items) == 0 {
		return false
	}
	for _, item := range envelope.Items {
		if len(item.Value) == 0 {
			return false
		}
	}
	return true
}

func extractLegacyID(payload json.RawMessage) (string, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(payload, &object); err != nil {
		return "", fmt.Errorf("decode legacy item: %w", err)
	}

	rawID, ok := object["id"]
	if !ok {
		return "", fmt.Errorf("legacy item is missing id")
	}

	var id string
	if err := json.Unmarshal(rawID, &id); err != nil {
		return "", fmt.Errorf("decode legacy item id: %w", err)
	}
	if strings.TrimSpace(id) == "" {
		return "", fmt.Errorf("legacy item id is empty")
	}
	return id, nil
}

func mapEntries(items map[string]json.RawMessage) []Entry {
	ids := make([]string, 0, len(items))
	for id := range items {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	entries := make([]Entry, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, Entry{
			ID:    id,
			Value: cloneJSON(items[id]),
		})
	}
	return entries
}

func cloneJSON(payload json.RawMessage) json.RawMessage {
	if payload == nil {
		return nil
	}
	return append(json.RawMessage(nil), payload...)
}
