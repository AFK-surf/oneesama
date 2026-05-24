package meetrunner

import (
	"bytes"
	"sync"
)

type limitedBuffer struct {
	buffer    bytes.Buffer
	maxBytes  int
	written   int
	truncated bool
	mu        sync.Mutex
}

func newLimitedBuffer(maxBytes int) *limitedBuffer {
	return &limitedBuffer{maxBytes: maxBytes}
}

func (b *limitedBuffer) Write(payload []byte) (int, error) {
	written := len(payload)

	b.mu.Lock()
	defer b.mu.Unlock()

	b.written += written
	remaining := b.maxBytes - b.buffer.Len()
	if remaining <= 0 {
		b.truncated = true
		return written, nil
	}
	if len(payload) > remaining {
		payload = payload[:remaining]
		b.truncated = true
	}
	_, err := b.buffer.Write(payload)
	return written, err
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()

	if !b.truncated {
		return b.buffer.String()
	}
	return b.buffer.String() + "\n[output truncated]"
}
