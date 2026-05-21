package meetingagent

import "testing"

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
