package meetingagent

import "testing"

func TestRealtimeForegroundToolInventoryCoversEveryTool(t *testing.T) {
	inventory := RealtimeForegroundToolInventory(true)
	if len(inventory) != len(defaultRealtimeToolDefinitions()) {
		t.Fatalf("inventory length = %d, want %d", len(inventory), len(defaultRealtimeToolDefinitions()))
	}

	seen := map[string]bool{}
	for _, item := range inventory {
		if item.Name == "" {
			t.Fatalf("inventory item has empty name: %#v", item)
		}
		if seen[item.Name] {
			t.Fatalf("duplicate inventory item for %q", item.Name)
		}
		seen[item.Name] = true
		if item.Class == "" {
			t.Fatalf("tool %q has no inventory class", item.Name)
		}
		if item.Gate == "" {
			t.Fatalf("tool %q has no inventory gate", item.Name)
		}
	}

	for _, definition := range defaultRealtimeToolDefinitions() {
		if !seen[definition.Name] {
			t.Fatalf("tool %q missing from foreground inventory", definition.Name)
		}
	}
}

func TestRealtimeForegroundToolInventoryRespectsDemoSurfaceGate(t *testing.T) {
	withoutDemoSurface := RealtimeForegroundToolInventory(false)
	for _, item := range withoutDemoSurface {
		if item.Class == RealtimeToolClassOptionalForeground {
			t.Fatalf("optional tool %q visible when demo surface is disabled", item.Name)
		}
	}

	withDemoSurface := RealtimeForegroundToolInventory(true)
	optional := map[string]bool{}
	for _, item := range withDemoSurface {
		if item.Class == RealtimeToolClassOptionalForeground {
			optional[item.Name] = true
		}
	}
	for _, name := range []string{"open_shared_browser_surface", "create_shared_workspace", "control_shared_browser_surface", "stop_shared_browser_surface"} {
		if !optional[name] {
			t.Fatalf("optional demo-surface tool %q missing from enabled inventory", name)
		}
	}
}

func TestRealtimeForegroundToolInventoryPinsDeprecatedAliases(t *testing.T) {
	inventory := RealtimeForegroundToolInventory(true)
	classes := make(map[string]string, len(inventory))
	for _, item := range inventory {
		classes[item.Name] = item.Class
	}
	for _, name := range []string{"delegate_to_codex", "delegate_status"} {
		if classes[name] != RealtimeToolClassDeprecatedAlias {
			t.Fatalf("tool %q class = %q, want %q", name, classes[name], RealtimeToolClassDeprecatedAlias)
		}
	}
	if classes["delegate_to_worker"] != RealtimeToolClassStableForeground {
		t.Fatalf("delegate_to_worker class = %q, want %q", classes["delegate_to_worker"], RealtimeToolClassStableForeground)
	}
}
