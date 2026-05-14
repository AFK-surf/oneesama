package persistence

import (
	"context"
	"encoding/json"
	"fmt"
)

type TypedCollection[T any] struct {
	base Collection
}

func OpenTyped[T any](options Options) (*TypedCollection[T], error) {
	base, err := Open(options)
	if err != nil {
		return nil, err
	}
	return &TypedCollection[T]{base: base}, nil
}

func (c *TypedCollection[T]) Provider() Provider {
	return c.base.Provider()
}

func (c *TypedCollection[T]) Name() string {
	return c.base.Name()
}

func (c *TypedCollection[T]) Path() string {
	return c.base.Path()
}

func (c *TypedCollection[T]) Get(ctx context.Context, id string) (T, bool, error) {
	entry, ok, err := c.base.Get(ctx, id)
	if err != nil {
		var zero T
		return zero, false, err
	}
	if !ok {
		var zero T
		return zero, false, nil
	}

	value, err := decodeValue[T](entry.Value)
	if err != nil {
		var zero T
		return zero, false, fmt.Errorf("decode %s/%s: %w", c.base.Name(), id, err)
	}
	return value, true, nil
}

func (c *TypedCollection[T]) Set(ctx context.Context, id string, value T) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshal %s/%s: %w", c.base.Name(), id, err)
	}
	return c.base.Put(ctx, Entry{
		ID:    id,
		Value: payload,
	})
}

func (c *TypedCollection[T]) Delete(ctx context.Context, id string) error {
	return c.base.Delete(ctx, id)
}

func (c *TypedCollection[T]) List(ctx context.Context) ([]T, error) {
	entries, err := c.base.List(ctx)
	if err != nil {
		return nil, err
	}

	values := make([]T, 0, len(entries))
	for _, entry := range entries {
		value, err := decodeValue[T](entry.Value)
		if err != nil {
			return nil, fmt.Errorf("decode %s/%s: %w", c.base.Name(), entry.ID, err)
		}
		values = append(values, value)
	}
	return values, nil
}

func (c *TypedCollection[T]) Close() error {
	return c.base.Close()
}

func decodeValue[T any](payload []byte) (T, error) {
	var value T
	if err := json.Unmarshal(payload, &value); err != nil {
		return value, err
	}
	return value, nil
}
