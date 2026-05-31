package meetingagent

import (
	"os"
	"strings"
	"testing"
)

const (
	wantRealtimeToolHashWithoutDemoSurface = "49468ff77ff6f8c0fd61fd220eedf776f82ac265c066b67a1edceaffb412e563"
	wantRealtimeToolHashWithDemoSurface    = "7e009a3ce3f379e9d037041e7b943f77f3d848ef4f26ebc21c9cf06df8723c11"
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

func TestRealtimeToolSchemasAreStrictCompatible(t *testing.T) {
	for _, tool := range defaultRealtimeToolSchemas() {
		name, _ := tool["name"].(string)
		if _, ok := tool["strict"]; ok {
			t.Fatalf("%s strict = %#v, Realtime session tools do not accept strict", name, tool["strict"])
		}
		parameters, ok := tool["parameters"].(map[string]any)
		if !ok {
			t.Fatalf("%s parameters = %#v, want object", name, tool["parameters"])
		}
		assertStrictRealtimeObjectSchema(t, name+".parameters", parameters)
	}
}

func assertStrictRealtimeObjectSchema(t *testing.T, path string, schema map[string]any) {
	t.Helper()
	if !schemaTypeIncludes(schema["type"], "object") {
		t.Fatalf("%s.type = %#v, want object", path, schema["type"])
	}
	if schema["additionalProperties"] != false {
		t.Fatalf("%s.additionalProperties = %#v, want false", path, schema["additionalProperties"])
	}
	properties, _ := schema["properties"].(map[string]any)
	required := anyStringList(schema["required"])
	if len(required) != len(properties) {
		t.Fatalf("%s.required = %#v, want all %d properties", path, required, len(properties))
	}
	for key := range properties {
		if !stringSliceContains(required, key) {
			t.Fatalf("%s.required = %#v, missing property %q", path, required, key)
		}
	}
	for key, value := range properties {
		child, _ := value.(map[string]any)
		if child == nil {
			continue
		}
		if schemaTypeIncludes(child["type"], "object") {
			assertStrictRealtimeObjectSchema(t, path+".properties."+key, child)
		}
		if items, _ := child["items"].(map[string]any); items != nil && schemaTypeIncludes(items["type"], "object") {
			assertStrictRealtimeObjectSchema(t, path+".properties."+key+".items", items)
		}
	}
}

func schemaTypeIncludes(value any, want string) bool {
	if text, ok := value.(string); ok {
		return text == want
	}
	for _, item := range anyStringList(value) {
		if item == want {
			return true
		}
	}
	return false
}

func anyStringList(value any) []string {
	values, _ := value.([]any)
	out := make([]string, 0, len(values))
	for _, item := range values {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func stringSliceContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
