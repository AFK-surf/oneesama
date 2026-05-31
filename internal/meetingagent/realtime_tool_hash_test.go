package meetingagent

import (
	"os"
	"strings"
	"testing"
)

const (
	wantRealtimeToolHashWithoutDemoSurface = "123b94e8eb59bc32fdff53340339f5498cd2eef6477973b5dc210bec4ee4cca9"
	wantRealtimeToolHashWithDemoSurface    = "fb6f365a636cc2806d568924621233512272a2ea0e2cad514f32f40a39f95f59"
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
