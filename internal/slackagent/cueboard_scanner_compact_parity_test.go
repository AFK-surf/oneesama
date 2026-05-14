//go:build cueboardparity

package slackagent

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCueboardParityCompactSizeThreshold(t *testing.T) {
	tests := []struct {
		name   string
		size   int
		wantOK bool
	}{
		{"empty", 0, false},
		{"below threshold", compactSizeThreshold - 1, false},
		{"at threshold", compactSizeThreshold, true},
		{"above threshold", compactSizeThreshold + 100, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var data []byte
			if tt.size > 0 {
				base := strings.Repeat("## h\n", compactHeadingThreshold)
				if len(base) >= tt.size {
					data = []byte(base[:tt.size])
				} else {
					data = []byte(base + strings.Repeat("x", tt.size-len(base)))
				}
			}
			if got := shouldCompactDailyNote(data); got != tt.wantOK {
				t.Errorf("size=%d: got eligible=%v, want %v", tt.size, got, tt.wantOK)
			}
		})
	}
}

func TestCueboardParityCompactHeadingThreshold(t *testing.T) {
	makeContent := func(headings int) string {
		var sb strings.Builder
		for i := range headings {
			fmt.Fprintf(&sb, "## Heading %d\nSome text.\n\n", i)
		}
		return sb.String()
	}

	tests := []struct {
		name     string
		headings int
		wantOK   bool
	}{
		{"zero headings", 0, false},
		{"below threshold", compactHeadingThreshold - 1, false},
		{"at threshold", compactHeadingThreshold, true},
		{"above threshold", compactHeadingThreshold + 5, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			content := strings.Repeat("x", compactSizeThreshold) + "\n" + makeContent(tt.headings)
			if got := shouldCompactDailyNote([]byte(content)); got != tt.wantOK {
				t.Errorf("headings=%d: got eligible=%v, want %v", tt.headings, got, tt.wantOK)
			}
		})
	}
}

func TestCueboardParityCompactHashDedup(t *testing.T) {
	data := []byte("## Entry 1\nSome notes about a meeting.\n\n## Entry 2\nMore notes.\n")

	hash1 := sha256sum(data)
	hash2 := sha256sum(data)
	if hash1 != hash2 {
		t.Fatalf("same data produced different hashes: %s vs %s", hash1, hash2)
	}

	altered := append([]byte{}, data...)
	altered = append(altered, "## Entry 3\nExtra.\n"...)
	hash3 := sha256sum(altered)
	if hash1 == hash3 {
		t.Fatalf("different data produced same hash: %s", hash1)
	}

	key := dailyNoteCompactHash(data)
	if key == "" {
		t.Fatal("cooldown key is empty")
	}
	key2 := dailyNoteCompactHash(altered)
	if key == key2 {
		t.Fatal("different data produced same cooldown key")
	}
}

func TestCueboardParityCompactEligibility(t *testing.T) {
	tmpDir := t.TempDir()
	memDir := filepath.Join(tmpDir, "memory")
	if err := os.MkdirAll(memDir, 0o755); err != nil {
		t.Fatal(err)
	}

	var sb strings.Builder
	for i := range compactHeadingThreshold + 2 {
		fmt.Fprintf(&sb, "## Topic %d\n", i)
		sb.WriteString(strings.Repeat("x", 400))
		sb.WriteString("\n\n")
	}
	content := sb.String()

	notePath := filepath.Join(memDir, "2026-01-01.md")
	if err := os.WriteFile(notePath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(notePath)
	if err != nil {
		t.Fatal(err)
	}
	if !shouldCompactDailyNote(data) {
		t.Fatalf("expected file to be eligible for compaction")
	}

	hash := dailyNoteCompactHash(data)
	hash2 := dailyNoteCompactHash(data)
	if hash != hash2 {
		t.Fatalf("identical content produced different hashes")
	}
}

func TestCueboardParityCompactPromptNoMemoryMd(t *testing.T) {
	today := "2026-01-01"
	prompt := buildDailyNoteCompactionPrompt(today)

	lines := strings.Split(prompt, "\n")
	for _, line := range lines {
		if strings.Contains(line, "MEMORY.md") && !strings.Contains(line, "Do NOT read or write MEMORY.md") {
			t.Errorf("compact prompt references MEMORY.md outside prohibition: %q", line)
		}
	}
}
