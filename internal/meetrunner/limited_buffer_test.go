package meetrunner

import "testing"

func TestLimitedBufferWriteReturnsOriginalPayloadLengthWhenTruncated(t *testing.T) {
	buffer := newLimitedBuffer(4)

	written, err := buffer.Write([]byte("abcdef"))
	if err != nil {
		t.Fatalf("Write returned error: %v", err)
	}
	if written != 6 {
		t.Fatalf("Write returned %d bytes, want original payload length 6", written)
	}
	if got := buffer.String(); got != "abcd\n[output truncated]" {
		t.Fatalf("String() = %q, want truncated output", got)
	}
}
