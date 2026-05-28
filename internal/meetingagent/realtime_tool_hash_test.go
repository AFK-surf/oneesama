package meetingagent

import (
	"os"
	"strings"
	"testing"
)

const (
	wantRealtimeToolHashWithoutDemoSurface = "05fcbb10aec84639cf567df24365878970553f4f19429481302fd16684c37211"
	wantRealtimeToolHashWithDemoSurface    = "6c47eaf24f188e77bfd9f433beb3a96e6af2d15706148097c787b3ab483348ed"
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
