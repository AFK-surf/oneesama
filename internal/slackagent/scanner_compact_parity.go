package slackagent

import (
	"crypto/sha256"
	"fmt"
)

const (
	compactSizeThreshold    = dailyNoteCompactSizeThreshold
	compactHeadingThreshold = dailyNoteCompactHeadingThreshold
)

func shouldCompactDailyNote(data []byte) bool {
	return len(data) >= compactSizeThreshold && countLinesWithPrefix(string(data), "## ") >= compactHeadingThreshold
}

func sha256sum(data []byte) string {
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%x", sum[:8])
}
