package meetingagent

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixedClock(t *testing.T, base time.Time) func() time.Time {
	t.Helper()
	calls := 0
	return func() time.Time {
		calls++
		return base.Add(time.Duration(calls-1) * time.Second)
	}
}

// TestDemoSessionStoreTriggerCreatesFirstRow pins the contract that the
// first audit row is always result=started / reason=session_triggered, so
// the runbook can grep one line per session start. Task #312.
func TestDemoSessionStoreTriggerCreatesFirstRow(t *testing.T) {
	base := time.Date(2026, 5, 21, 12, 0, 0, 0, time.UTC)
	store := NewDemoSessionStore().WithClock(fixedClock(t, base))

	thread := DemoSessionThreadKey{Surface: "slack", ChannelID: "C1", ThreadTS: "1779000000.000100"}
	entry, err := store.RecordTrigger(DemoSessionTriggerRequest{
		SessionID: "demo_abc",
		Actor:     "U_PENG",
		ThreadKey: thread,
		URL:       "https://github.com/anthropics/claude-code/pull/42",
	})
	if err != nil {
		t.Fatalf("RecordTrigger error: %v", err)
	}
	if entry.Sequence != 1 {
		t.Fatalf("Sequence = %d, want 1", entry.Sequence)
	}
	if entry.Result != DemoSessionResultStarted {
		t.Fatalf("Result = %q, want started", entry.Result)
	}
	if entry.ReasonCode != "session_triggered" {
		t.Fatalf("ReasonCode = %q, want session_triggered", entry.ReasonCode)
	}
	if entry.ActionClass != DemoActionOpenURL {
		t.Fatalf("ActionClass = %q, want open_url", entry.ActionClass)
	}
	snap, ok := store.Snapshot("demo_abc")
	if !ok {
		t.Fatalf("Snapshot missing for demo_abc")
	}
	if snap.StartedAt != base {
		t.Fatalf("StartedAt = %v, want %v", snap.StartedAt, base)
	}
	if snap.Closed {
		t.Fatalf("fresh session should not be closed")
	}
	if got, _ := store.SessionForThread(thread); got != "demo_abc" {
		t.Fatalf("SessionForThread = %q, want demo_abc", got)
	}
}

func TestDemoSessionStoreDuplicateTriggerRejected(t *testing.T) {
	store := NewDemoSessionStore()
	req := DemoSessionTriggerRequest{SessionID: "demo_dup", Actor: "U", URL: "https://example.com/"}
	if _, err := store.RecordTrigger(req); err != nil {
		t.Fatalf("first trigger error: %v", err)
	}
	_, err := store.RecordTrigger(req)
	if !errors.Is(err, errDemoSessionAlreadyExists) {
		t.Fatalf("second trigger err = %v, want errDemoSessionAlreadyExists", err)
	}
}

func TestDemoSessionStoreMissingIDRejected(t *testing.T) {
	store := NewDemoSessionStore()
	cases := []struct {
		name string
		op   func() error
	}{
		{"trigger", func() error {
			_, err := store.RecordTrigger(DemoSessionTriggerRequest{})
			return err
		}},
		{"action", func() error {
			_, err := store.RecordAction(DemoSessionActionRequest{})
			return err
		}},
		{"close", func() error {
			_, err := store.RecordClose("", DemoSessionResultStopped, "x")
			return err
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.op(); !errors.Is(err, errDemoSessionMissingID) {
				t.Fatalf("%s err = %v, want errDemoSessionMissingID", tc.name, err)
			}
		})
	}
}

func TestDemoSessionStoreActionAppendsAndUpdatesSnapshot(t *testing.T) {
	store := NewDemoSessionStore().WithClock(fixedClock(t, time.Unix(1700000000, 0).UTC()))
	if _, err := store.RecordTrigger(DemoSessionTriggerRequest{
		SessionID: "demo_seq",
		Actor:     "U_PENG",
		URL:       "https://github.com/a/b/pull/1",
	}); err != nil {
		t.Fatalf("trigger: %v", err)
	}
	if _, err := store.RecordAction(DemoSessionActionRequest{
		SessionID:   "demo_seq",
		ActionClass: DemoActionCapture,
		Result:      DemoSessionResultAllowed,
		ReasonCode:  "read_only_action",
		ArtifactRefs: []string{
			"runtime/demo-surfaces/demo_seq/frames/0001.jpg",
		},
	}); err != nil {
		t.Fatalf("action capture: %v", err)
	}
	if _, err := store.RecordAction(DemoSessionActionRequest{
		SessionID:   "demo_seq",
		ActionClass: DemoActionScroll,
		Result:      DemoSessionResultDryRun,
		ReasonCode:  "dry_run_passive_mutation",
	}); err != nil {
		t.Fatalf("action scroll: %v", err)
	}
	entries, ok := store.Entries("demo_seq")
	if !ok {
		t.Fatalf("Entries missing")
	}
	if len(entries) != 3 {
		t.Fatalf("Entries len = %d, want 3", len(entries))
	}
	seq := []int{entries[0].Sequence, entries[1].Sequence, entries[2].Sequence}
	if seq[0] != 1 || seq[1] != 2 || seq[2] != 3 {
		t.Fatalf("Sequence chain = %v, want [1 2 3]", seq)
	}
	snap, _ := store.Snapshot("demo_seq")
	if snap.LastAction != DemoActionScroll {
		t.Fatalf("LastAction = %q, want scroll", snap.LastAction)
	}
	if snap.LastResult != DemoSessionResultDryRun {
		t.Fatalf("LastResult = %q, want dry_run", snap.LastResult)
	}
	if snap.LastReason != "dry_run_passive_mutation" {
		t.Fatalf("LastReason = %q, want dry_run_passive_mutation", snap.LastReason)
	}
	if snap.EntryCount != 3 {
		t.Fatalf("EntryCount = %d, want 3", snap.EntryCount)
	}
	if len(snap.ArtifactRefs) != 1 || snap.ArtifactRefs[0] != "runtime/demo-surfaces/demo_seq/frames/0001.jpg" {
		t.Fatalf("ArtifactRefs = %v, want one frame ref", snap.ArtifactRefs)
	}
	if snap.Closed {
		t.Fatalf("session must not auto-close on action")
	}
}

func TestDemoSessionStoreCloseTerminates(t *testing.T) {
	store := NewDemoSessionStore().WithClock(fixedClock(t, time.Unix(1700000000, 0).UTC()))
	if _, err := store.RecordTrigger(DemoSessionTriggerRequest{SessionID: "demo_close", Actor: "U"}); err != nil {
		t.Fatalf("trigger: %v", err)
	}
	if _, err := store.RecordClose("demo_close", DemoSessionResultStopped, "user_said_stop"); err != nil {
		t.Fatalf("close: %v", err)
	}
	snap, _ := store.Snapshot("demo_close")
	if !snap.Closed {
		t.Fatalf("Closed = false, want true")
	}
	if snap.EndedAt.IsZero() {
		t.Fatalf("EndedAt zero, want set")
	}
	if snap.LastReason != "user_said_stop" {
		t.Fatalf("LastReason = %q, want user_said_stop", snap.LastReason)
	}
	if _, err := store.RecordAction(DemoSessionActionRequest{SessionID: "demo_close", ActionClass: DemoActionScroll}); !errors.Is(err, errDemoSessionAlreadyClosed) {
		t.Fatalf("post-close action err = %v, want errDemoSessionAlreadyClosed", err)
	}
	if _, err := store.RecordClose("demo_close", DemoSessionResultStopped, "again"); !errors.Is(err, errDemoSessionAlreadyClosed) {
		t.Fatalf("double-close err = %v, want errDemoSessionAlreadyClosed", err)
	}
}

func TestDemoSessionStoreThreadMapping(t *testing.T) {
	store := NewDemoSessionStore()
	slack := DemoSessionThreadKey{Surface: "slack", ChannelID: "C1", ThreadTS: "1779.001"}
	meet := DemoSessionThreadKey{Surface: "meeting", ChannelID: "MEET-42", ThreadTS: ""}

	if _, err := store.RecordTrigger(DemoSessionTriggerRequest{SessionID: "s1", Actor: "U", ThreadKey: slack}); err != nil {
		t.Fatalf("trigger s1: %v", err)
	}
	if _, err := store.RecordTrigger(DemoSessionTriggerRequest{SessionID: "s2", Actor: "U", ThreadKey: meet}); err != nil {
		t.Fatalf("trigger s2: %v", err)
	}
	if got, _ := store.SessionForThread(slack); got != "s1" {
		t.Fatalf("SessionForThread(slack) = %q, want s1", got)
	}
	if got, _ := store.SessionForThread(meet); got != "s2" {
		t.Fatalf("SessionForThread(meet) = %q, want s2", got)
	}
	if got, ok := store.SessionForThread(DemoSessionThreadKey{}); ok || got != "" {
		t.Fatalf("SessionForThread(zero) = (%q,%v), want empty", got, ok)
	}
	gotThread, ok := store.ThreadForSession("s1")
	if !ok || gotThread != slack {
		t.Fatalf("ThreadForSession(s1) = (%+v,%v), want slack/true", gotThread, ok)
	}
}

func TestDemoSessionStoreThreadKeySurfaceIsolation(t *testing.T) {
	store := NewDemoSessionStore()
	a := DemoSessionThreadKey{Surface: "slack", ChannelID: "C1", ThreadTS: "T"}
	b := DemoSessionThreadKey{Surface: "meeting", ChannelID: "C1", ThreadTS: "T"}
	if a.Normalized() == b.Normalized() {
		t.Fatalf("normalized collision across surfaces: %q vs %q", a.Normalized(), b.Normalized())
	}
	if _, err := store.RecordTrigger(DemoSessionTriggerRequest{SessionID: "sa", ThreadKey: a, Actor: "U"}); err != nil {
		t.Fatalf("trigger sa: %v", err)
	}
	if _, err := store.RecordTrigger(DemoSessionTriggerRequest{SessionID: "sb", ThreadKey: b, Actor: "U"}); err != nil {
		t.Fatalf("trigger sb: %v", err)
	}
	if id, _ := store.SessionForThread(a); id != "sa" {
		t.Fatalf("slack→%q, want sa", id)
	}
	if id, _ := store.SessionForThread(b); id != "sb" {
		t.Fatalf("meet→%q, want sb", id)
	}
}

func TestDemoSessionStoreActiveSessionIDsSortedByStart(t *testing.T) {
	store := NewDemoSessionStore().WithClock(fixedClock(t, time.Unix(1700000000, 0).UTC()))
	for _, id := range []string{"s_late", "s_mid", "s_early"} {
		if _, err := store.RecordTrigger(DemoSessionTriggerRequest{SessionID: id, Actor: "U"}); err != nil {
			t.Fatalf("trigger %s: %v", id, err)
		}
	}
	// Close one — must drop from active list.
	if _, err := store.RecordClose("s_mid", DemoSessionResultStopped, "mid_done"); err != nil {
		t.Fatalf("close s_mid: %v", err)
	}
	ids := store.ActiveSessionIDs()
	if len(ids) != 2 {
		t.Fatalf("active len = %d, want 2; ids=%v", len(ids), ids)
	}
	// fixedClock advances per call; trigger order was s_late, s_mid, s_early
	// so by start time the active set is [s_late, s_early].
	if ids[0] != "s_late" || ids[1] != "s_early" {
		t.Fatalf("active order = %v, want [s_late s_early]", ids)
	}
}

func TestDemoSessionStoreSnapshotReturnsCopy(t *testing.T) {
	store := NewDemoSessionStore()
	if _, err := store.RecordTrigger(DemoSessionTriggerRequest{SessionID: "demo_copy", Actor: "U"}); err != nil {
		t.Fatalf("trigger: %v", err)
	}
	if _, err := store.RecordAction(DemoSessionActionRequest{
		SessionID:    "demo_copy",
		ActionClass:  DemoActionCapture,
		Result:       DemoSessionResultAllowed,
		ReasonCode:   "read_only_action",
		ArtifactRefs: []string{"x.jpg"},
	}); err != nil {
		t.Fatalf("action: %v", err)
	}
	snap, _ := store.Snapshot("demo_copy")
	snap.ArtifactRefs[0] = "MUTATED"
	snap2, _ := store.Snapshot("demo_copy")
	if snap2.ArtifactRefs[0] == "MUTATED" {
		t.Fatalf("Snapshot must return a defensive copy; internal state was mutated")
	}
}

func TestDemoSessionStoreEntriesReturnsCopy(t *testing.T) {
	store := NewDemoSessionStore()
	if _, err := store.RecordTrigger(DemoSessionTriggerRequest{SessionID: "demo_e", Actor: "U"}); err != nil {
		t.Fatalf("trigger: %v", err)
	}
	entries, _ := store.Entries("demo_e")
	entries[0].ReasonCode = "MUTATED"
	again, _ := store.Entries("demo_e")
	if again[0].ReasonCode == "MUTATED" {
		t.Fatalf("Entries must return a defensive copy")
	}
}

func TestDemoSessionStoreWritesFeedbackPackage(t *testing.T) {
	root := t.TempDir()
	base := time.Date(2026, 5, 22, 3, 0, 0, 0, time.UTC)
	store := NewPersistentDemoSessionStore(root).WithClock(fixedClock(t, base))

	if _, err := store.RecordTrigger(DemoSessionTriggerRequest{
		SessionID: "demo feedback/unsafe",
		Actor:     "U_PENG",
		URL:       "https://example.test/demo",
	}); err != nil {
		t.Fatalf("trigger: %v", err)
	}
	if _, err := store.RecordAction(DemoSessionActionRequest{
		SessionID:    "demo feedback/unsafe",
		ActionClass:  DemoActionCapture,
		Result:       DemoSessionResultAllowed,
		ReasonCode:   "read_only_action",
		ArtifactRefs: []string{"frames/001.png"},
	}); err != nil {
		t.Fatalf("action: %v", err)
	}
	if _, err := store.RecordClose("demo feedback/unsafe", DemoSessionResultStopped, "done"); err != nil {
		t.Fatalf("close: %v", err)
	}

	snap, ok := store.Snapshot("demo feedback/unsafe")
	if !ok {
		t.Fatal("snapshot missing")
	}
	if snap.FeedbackDir == "" || snap.AuditJSONL == "" || snap.SummaryJSON == "" {
		t.Fatalf("feedback paths missing from snapshot: %#v", snap)
	}
	if !strings.Contains(snap.FeedbackDir, "demo_feedback_unsafe") {
		t.Fatalf("FeedbackDir = %q, want sanitized session id", snap.FeedbackDir)
	}
	auditBytes, err := os.ReadFile(snap.AuditJSONL)
	if err != nil {
		t.Fatalf("read audit jsonl: %v", err)
	}
	if lines := strings.Count(strings.TrimSpace(string(auditBytes)), "\n") + 1; lines != 3 {
		t.Fatalf("audit jsonl lines = %d, want 3\n%s", lines, string(auditBytes))
	}
	var pkg DemoSessionFeedbackPackage
	if err := readJSONFile(snap.SummaryJSON, &pkg); err != nil {
		t.Fatalf("read summary: %v", err)
	}
	if pkg.Snapshot.SessionID != "demo feedback/unsafe" || !pkg.Snapshot.Closed {
		t.Fatalf("summary snapshot = %#v, want closed feedback session", pkg.Snapshot)
	}
	if len(pkg.Entries) != 3 || len(pkg.RunbookLines) != 3 {
		t.Fatalf("summary entries/runbook = %d/%d, want 3/3", len(pkg.Entries), len(pkg.RunbookLines))
	}
	if !strings.Contains(pkg.RunbookLines[1], "action=capture") {
		t.Fatalf("runbook lines = %#v, want capture action line", pkg.RunbookLines)
	}
	if filepath.Base(pkg.Snapshot.AuditJSONL) != "audit.jsonl" || filepath.Base(pkg.Snapshot.SummaryJSON) != "summary.json" {
		t.Fatalf("summary paths = %#v, want stable file names", pkg.Snapshot)
	}
}

func TestDemoSessionStoreRecentSnapshots(t *testing.T) {
	store := NewDemoSessionStore().WithClock(fixedClock(t, time.Unix(1700000000, 0).UTC()))
	for _, id := range []string{"first", "second", "third"} {
		if _, err := store.RecordTrigger(DemoSessionTriggerRequest{SessionID: id, Actor: "U"}); err != nil {
			t.Fatalf("trigger %s: %v", id, err)
		}
	}
	recent := store.RecentSnapshots(2)
	if len(recent) != 2 || recent[0].SessionID != "third" || recent[1].SessionID != "second" {
		t.Fatalf("recent = %#v, want [third second]", recent)
	}
}

func TestDemoSessionStoreSnapshotMissingSession(t *testing.T) {
	store := NewDemoSessionStore()
	if _, ok := store.Snapshot("nope"); ok {
		t.Fatalf("Snapshot(unknown) should report not found")
	}
	if _, ok := store.Entries("nope"); ok {
		t.Fatalf("Entries(unknown) should report not found")
	}
	if _, ok := store.ThreadForSession("nope"); ok {
		t.Fatalf("ThreadForSession(unknown) should report not found")
	}
}

func TestDemoSessionStoreActionOnUnknownRejected(t *testing.T) {
	store := NewDemoSessionStore()
	if _, err := store.RecordAction(DemoSessionActionRequest{SessionID: "ghost"}); !errors.Is(err, errDemoSessionNotFound) {
		t.Fatalf("action err = %v, want errDemoSessionNotFound", err)
	}
	if _, err := store.RecordClose("ghost", DemoSessionResultStopped, "x"); !errors.Is(err, errDemoSessionNotFound) {
		t.Fatalf("close err = %v, want errDemoSessionNotFound", err)
	}
}

func TestFormatRunbookLineStableShape(t *testing.T) {
	entry := DemoSessionAuditEntry{
		SessionID:   "demo_run",
		Sequence:    2,
		Actor:       "U_PENG",
		ThreadKey:   DemoSessionThreadKey{Surface: "slack", ChannelID: "C1", ThreadTS: "1779.001"},
		ActionClass: DemoActionScroll,
		URL:         "https://github.com/a/b/pull/1",
		Result:      DemoSessionResultDryRun,
		ReasonCode:  "dry_run_passive_mutation",
		ArtifactRefs: []string{
			"runtime/demo-surfaces/demo_run/frames/0002.jpg",
			"runtime/demo-surfaces/demo_run/frames/0003.jpg",
		},
		RecordedAt: time.Date(2026, 5, 21, 4, 30, 0, 0, time.UTC),
	}
	line := FormatRunbookLine(entry)
	want := []string{
		"2026-05-21T04:30:00Z",
		"session=demo_run",
		"seq=2",
		"actor=U_PENG",
		"thread=slack|C1|1779.001",
		"action=scroll",
		"url=https://github.com/a/b/pull/1",
		"result=dry_run",
		"reason=dry_run_passive_mutation",
		"artifacts=2",
	}
	for _, w := range want {
		if !strings.Contains(line, w) {
			t.Fatalf("runbook line missing %q: %q", w, line)
		}
	}
}

func TestFormatRunbookLineUsesDashForEmpty(t *testing.T) {
	entry := DemoSessionAuditEntry{
		SessionID:  "demo_empty",
		Sequence:   1,
		Result:     DemoSessionResultStarted,
		ReasonCode: "session_triggered",
		RecordedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	}
	line := FormatRunbookLine(entry)
	for _, want := range []string{"actor=-", "thread=-", "action=-", "url=-"} {
		if !strings.Contains(line, want) {
			t.Fatalf("runbook line missing %q: %q", want, line)
		}
	}
}

func readJSONFile(path string, out any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}
