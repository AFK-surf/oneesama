package meetingagent

import "strings"

type joinSessionStatus string

const (
	joinSessionStatusQueued    joinSessionStatus = "queued"
	joinSessionStatusPrepared  joinSessionStatus = "prepared"
	joinSessionStatusWaiting   joinSessionStatus = "waiting"
	joinSessionStatusJoined    joinSessionStatus = "joined"
	joinSessionStatusStopped   joinSessionStatus = "stopped"
	joinSessionStatusDone      joinSessionStatus = "done"
	joinSessionStatusFailed    joinSessionStatus = "failed"
	joinSessionStatusRemoved   joinSessionStatus = "removed_from_meeting"
	joinSessionStatusCanceled  joinSessionStatus = "canceled"
	joinSessionStatusCancelled joinSessionStatus = "cancelled"
	joinSessionStatusStale     joinSessionStatus = "stale"
)

type joinSessionStatusSpec struct {
	Terminal      bool
	Redeliverable bool
}

// joinSessionStatusSpecs is the contract for join-session lifecycle categories.
// Runner-specific states can still be stored as opaque non-terminal statuses, but
// terminal/redelivery behavior must be added here instead of scattered string
// switches across join, stale recovery, and redelivery code.
var joinSessionStatusSpecs = map[joinSessionStatus]joinSessionStatusSpec{
	joinSessionStatusQueued:    {},
	joinSessionStatusPrepared:  {},
	joinSessionStatusWaiting:   {},
	joinSessionStatusJoined:    {},
	joinSessionStatusStopped:   {Terminal: true, Redeliverable: true},
	joinSessionStatusDone:      {Terminal: true, Redeliverable: true},
	joinSessionStatusFailed:    {Terminal: true, Redeliverable: true},
	joinSessionStatusRemoved:   {Terminal: true, Redeliverable: true},
	joinSessionStatusCanceled:  {Terminal: true},
	joinSessionStatusCancelled: {Terminal: true},
	joinSessionStatusStale:     {Terminal: true, Redeliverable: true},
}

func normalizeJoinSessionStatus(status string) joinSessionStatus {
	return joinSessionStatus(strings.ToLower(strings.TrimSpace(status)))
}

func joinSessionStatusString(status joinSessionStatus) string {
	return string(status)
}

func joinSessionStatusSpecFor(status string) joinSessionStatusSpec {
	return joinSessionStatusSpecs[normalizeJoinSessionStatus(status)]
}

func isTerminalJoinSessionStatus(status string) bool {
	return joinSessionStatusSpecFor(status).Terminal
}

func isRedeliverableJoinSessionStatus(status string) bool {
	return joinSessionStatusSpecFor(status).Redeliverable
}
