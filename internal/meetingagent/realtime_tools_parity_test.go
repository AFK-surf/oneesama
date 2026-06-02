package meetingagent

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func TestRealtimeToolSchemasMatchTypescriptSource(t *testing.T) {
	repoRoot := findRepoRootForRealtimeToolsTest(t)
	script := `
		import { defaultRealtimeToolSchemas, realtimeToolSchemas } from "./packages/core/src/realtime/realtime-contract.ts";
		console.log(JSON.stringify({ defaultRealtimeToolSchemas, realtimeToolSchemas }));
	`
	cmd := exec.Command("node", "--import", "tsx", "--input-type=module", "-e", script)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			t.Fatalf("render TS realtime tool schemas: %v\n%s", err, string(exitErr.Stderr))
		}
		t.Fatalf("render TS realtime tool schemas: %v", err)
	}
	var tsTools struct {
		DefaultRealtimeToolSchemas []map[string]any `json:"defaultRealtimeToolSchemas"`
		RealtimeToolSchemas        []map[string]any `json:"realtimeToolSchemas"`
	}
	if err := json.Unmarshal(output, &tsTools); err != nil {
		t.Fatalf("parse TS realtime tools: %v\n%s", err, string(output))
	}
	for _, tc := range []struct {
		name    string
		goTools []map[string]any
		tsTools []map[string]any
	}{
		{
			name:    "default live-safe",
			goTools: defaultRealtimeToolSchemas(),
			tsTools: tsTools.DefaultRealtimeToolSchemas,
		},
		{
			name:    "full demo opt-in",
			goTools: realtimeToolSchemas(true),
			tsTools: tsTools.RealtimeToolSchemas,
		},
	} {
		if !reflect.DeepEqual(tc.goTools, tc.tsTools) {
			goJSON, _ := json.Marshal(tc.goTools)
			tsJSON, _ := json.Marshal(tc.tsTools)
			t.Fatalf("Go realtime tool schema %s drifted from TS source\nGo: %s\nTS: %s", tc.name, goJSON, tsJSON)
		}
	}
}

func findRepoRootForRealtimeToolsTest(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "package.json")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("package.json not found from test working directory")
		}
		dir = parent
	}
}
