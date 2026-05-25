package meetingagent

import (
	"os"
	"strings"
	"testing"
)

const (
	wantRealtimeToolHashWithoutDemoSurface = "10ad11ce49b5f6a78a6467f02a7406ed55ba61944383ab845b35b78e1abba6b5"
	wantRealtimeToolHashWithDemoSurface    = "79ef1d74893b68790e8c0e428f30422a27f11cd7fef2352f6b913242c3cd75f9"
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
