package agentrunner

import "bytes"

const maxCommandOutputBytes = 1 << 20

type limitedBuffer struct {
	buffer    bytes.Buffer
	maxBytes  int
	truncated bool
}

func newLimitedBuffer(maxBytes int) *limitedBuffer {
	return &limitedBuffer{maxBytes: maxBytes}
}

func (b *limitedBuffer) Write(payload []byte) (int, error) {
	written := len(payload)
	if b.maxBytes <= 0 {
		return written, nil
	}
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
	if !b.truncated {
		return b.buffer.String()
	}
	return b.buffer.String() + "\n[output truncated]"
}
