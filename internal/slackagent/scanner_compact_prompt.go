package slackagent

import "fmt"

func buildDailyNoteCompactionPrompt(date string) string {
	return fmt.Sprintf(`You are a memory maintenance worker. Your ONLY job is to compact today's daily notes.

Today's date: %s

Instructions:
1. Read the current daily note: memory_get(path="memory/%s.md")
2. Compact the daily note:
   - Merge duplicate/related topics into single entries
   - Keep each entry to 2-3 lines; record conclusions, not play-by-play
   - Drop trivial items: casual chat, jokes, routine status checks, spam
   - Target: 5-8 entries max
3. Write the compacted daily note: memory_write(path="memory/%s.md", mode="write", content="...")

Do NOT read or write MEMORY.md. Do NOT add new information. Only compress and organize what is already there.`, date, date, date)
}
