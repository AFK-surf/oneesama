package meetrunner

import "bytes"

type limitedBuffer struct {
	buffer    bytes.Buffer
	maxBytes  int
	written   int
	truncated bool
}

func newLimitedBuffer(maxBytes int) *limitedBuffer {
	return &limitedBuffer{maxBytes: maxBytes}
}

func (b *limitedBuffer) Write(payload []byte) (int, error) {
	b.written += len(payload)
	remaining := b.maxBytes - b.buffer.Len()
	if remaining <= 0 {
		b.truncated = true
		return len(payload), nil
	}
	if len(payload) > remaining {
		payload = payload[:remaining]
		b.truncated = true
	}
	_, err := b.buffer.Write(payload)
	return len(payload), err
}

func (b *limitedBuffer) String() string {
	if !b.truncated {
		return b.buffer.String()
	}
	return b.buffer.String() + "\n[output truncated]"
}
