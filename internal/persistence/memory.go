package persistence

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"sync"
)

type memoryCollection struct {
	mu         sync.RWMutex
	collection string
	items      map[string]json.RawMessage
}

func newMemoryCollection(collection string) Collection {
	return &memoryCollection{
		collection: strings.TrimSpace(collection),
		items:      make(map[string]json.RawMessage),
	}
}

func (c *memoryCollection) Provider() Provider {
	return ProviderMemory
}

func (c *memoryCollection) Name() string {
	return c.collection
}

func (c *memoryCollection) Path() string {
	return ""
}

func (c *memoryCollection) Get(_ context.Context, id string) (Entry, bool, error) {
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

func (c *memoryCollection) Put(_ context.Context, entry Entry) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.items[entry.ID] = cloneJSON(entry.Value)
	return nil
}

func (c *memoryCollection) Delete(_ context.Context, id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	delete(c.items, id)
	return nil
}

func (c *memoryCollection) List(_ context.Context) ([]Entry, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	ids := make([]string, 0, len(c.items))
	for id := range c.items {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	entries := make([]Entry, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, Entry{
			ID:    id,
			Value: cloneJSON(c.items[id]),
		})
	}
	return entries, nil
}

func (c *memoryCollection) Close() error {
	return nil
}
