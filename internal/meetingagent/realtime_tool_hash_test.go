package meetingagent

import (
	"os"
	"strings"
	"testing"
)

const (
	wantRealtimeToolHashWithoutDemoSurface = "5f6a7b224b1e561fa8136894206434b0c27203daf94e333b2e4b74392109ea34"
	wantRealtimeToolHashWithDemoSurface    = "4ef0d16b21ad535026d3ee14de7ee272bd9383cdb9c1a9a0eebfc7f2291b72b8"
)

func TestRealtimeToolSchemaStableHashIsDeterministic(t *testing.T) {
	first, err := RealtimeToolSchemaStableHash(false)
	if err != nil {
		t.Fatalf("RealtimeToolSchemaStableHash(false): %v", err)
	}
	second, err := RealtimeToolSchemaStableHash(false)
	if err != nil {
		t.Fatalf("RealtimeToolSchemaStableHash(false) second call: %v", err)
	}
	if first == "" || first != second {
		t.Fatalf("hash = %q then %q, want non-empty deterministic hash", first, second)
	}
}

func TestRealtimeToolSchemaStableHashCapturesDemoSurfaceGate(t *testing.T) {
	withoutDemoSurface, err := RealtimeToolSchemaStableHash(false)
	if err != nil {
		t.Fatalf("RealtimeToolSchemaStableHash(false): %v", err)
	}
	withDemoSurface, err := RealtimeToolSchemaStableHash(true)
	if err != nil {
		t.Fatalf("RealtimeToolSchemaStableHash(true): %v", err)
	}
	if withoutDemoSurface == withDemoSurface {
		t.Fatalf("hash without demo surface = hash with demo surface = %s, want gate to be visible", withoutDemoSurface)
	}
}

func TestRealtimeToolSchemaStableHashGolden(t *testing.T) {
	withoutDemoSurface, err := RealtimeToolSchemaStableHash(false)
	if err != nil {
		t.Fatalf("RealtimeToolSchemaStableHash(false): %v", err)
	}
	withDemoSurface, err := RealtimeToolSchemaStableHash(true)
	if err != nil {
		t.Fatalf("RealtimeToolSchemaStableHash(true): %v", err)
	}
	if withoutDemoSurface != wantRealtimeToolHashWithoutDemoSurface {
		t.Fatalf("RealtimeToolSchemaStableHash(false) = %q, want %q", withoutDemoSurface, wantRealtimeToolHashWithoutDemoSurface)
	}
	if withDemoSurface != wantRealtimeToolHashWithDemoSurface {
		t.Fatalf("RealtimeToolSchemaStableHash(true) = %q, want %q", withDemoSurface, wantRealtimeToolHashWithDemoSurface)
	}
}

func TestRealtimeToolSchemaStableHashesAreDocumented(t *testing.T) {
	const inventoryPath = "../../notes/code-polish/harness-foreground-tool-inventory-2026-05-21.md"
	data, err := os.ReadFile(inventoryPath)
	if err != nil {
		t.Fatalf("read foreground tool inventory note: %v", err)
	}
	note := string(data)
	for _, hash := range []string{wantRealtimeToolHashWithoutDemoSurface, wantRealtimeToolHashWithDemoSurface} {
		if !strings.Contains(note, hash) {
			t.Fatalf("foreground tool inventory note does not document realtime tool hash %s", hash)
		}
	}
}
