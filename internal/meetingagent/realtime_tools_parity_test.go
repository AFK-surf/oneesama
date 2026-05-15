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
		import { realtimeToolSchemas } from "./packages/core/src/realtime/realtime-contract.ts";
		console.log(JSON.stringify(realtimeToolSchemas));
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
	var tsTools []map[string]any
	if err := json.Unmarshal(output, &tsTools); err != nil {
		t.Fatalf("parse TS realtime tools: %v\n%s", err, string(output))
	}
	goTools := defaultRealtimeToolSchemas()
	if !reflect.DeepEqual(goTools, tsTools) {
		goJSON, _ := json.Marshal(goTools)
		tsJSON, _ := json.Marshal(tsTools)
		t.Fatalf("Go realtime tool schema drifted from TS source\nGo: %s\nTS: %s", goJSON, tsJSON)
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
