package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCollectInventoryFindsFunctionsAndMethods(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "service.go"), `package sample

func Exported() {}

func internal() {}

type Service struct{}

func (s *Service) Handle() {}

type Box[T any] struct{}

func (b Box[T]) Generic() {}
`)
	writeTestFile(t, filepath.Join(root, "service_test.go"), `package sample

func TestIgnoredByDefault() {}
`)

	specs, err := parseRootSpecs([]string{"sample=" + root})
	if err != nil {
		t.Fatalf("parse specs: %v", err)
	}
	records, err := collectInventory(specs, false)
	if err != nil {
		t.Fatalf("collect inventory: %v", err)
	}

	got := make([]string, 0, len(records))
	for _, record := range records {
		got = append(got, record.Name)
	}
	want := []string{"Exported", "internal", "(*Service).Handle", "(Box).Generic"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("function names mismatch\n got: %v\nwant: %v", got, want)
	}
	if !records[0].Exported {
		t.Fatalf("Exported function should be marked exported")
	}
	if records[1].Exported {
		t.Fatalf("internal function should not be marked exported")
	}
}

func TestIncludeTestsAddsTestFunctions(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "service.go"), "package sample\nfunc Runtime() {}\n")
	writeTestFile(t, filepath.Join(root, "service_test.go"), "package sample\nfunc TestRuntime() {}\n")

	specs, err := parseRootSpecs([]string{root})
	if err != nil {
		t.Fatalf("parse specs: %v", err)
	}
	records, err := collectInventory(specs, true)
	if err != nil {
		t.Fatalf("collect inventory: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("expected runtime + test functions, got %d records: %#v", len(records), records)
	}
}

func TestFormatMarkdownUsesAuditSchema(t *testing.T) {
	records := []functionRecord{{
		Module:     "slack",
		SourceFile: "scanner.go",
		Name:       "(*Scanner).Run",
		Kind:       "method",
		Exported:   true,
		StartLine:  10,
		EndLine:    25,
	}}
	output := formatMarkdown(records, outputOptions{
		Title:       "Test Inventory",
		Status:      "unreviewed",
		GeneratedAt: time.Date(2026, 5, 17, 0, 0, 0, 0, time.UTC),
		Command:     "go run ./cmd/cueboard-function-inventory --root slack=/tmp/slack",
	})

	for _, needle := range []string{
		"# Test Inventory",
		"Status enum: `identical` / `verbatim_port` / `partial` / `drift` / `missing` / `product_excluded` / `unreviewed`.",
		"| Module | Source file | Function | Kind | Exported | Lines | Suggested status | Oneesama target | Evidence | Notes |",
		"| slack | scanner.go | `(*Scanner).Run` | method | yes | 10-25 | unreviewed |  |  |  |",
	} {
		if !strings.Contains(output, needle) {
			t.Fatalf("expected output to contain %q\n%s", needle, output)
		}
	}
}

func writeTestFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
}
