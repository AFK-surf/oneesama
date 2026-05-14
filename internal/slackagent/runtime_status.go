package slackagent

import (
	"fmt"
	"strings"
	"time"
)

type slackRuntimeStatusData struct {
	RunMode                      string
	WorkspaceDir                 string
	ScanMode                     string
	Debounce                     string
	MaxBatch                     int
	Integrations                 map[string]bool
	HeartbeatInterval            time.Duration
	HeartbeatLoop                bool
	HeartbeatScopeLabel          string
	HeartbeatLastAt              time.Time
	HeartbeatLastFollowupID      int64
	HeartbeatLastResultHidden    bool
	HeartbeatNextTickAt          time.Time
	HeartbeatTitle               string
	HeartbeatSummary             string
	HeartbeatNotified            bool
	HeartbeatError               string
	HeartbeatGlobalPendingCount  int
	HeartbeatVisiblePendingCount int
	HeartbeatPendingByKind       map[string]int
	HeartbeatSelfImprovementOpen int
	HeartbeatStaleReminderCount  int
	HeartbeatPending             []runtimeHeartbeatFollowupView
	HeartbeatSurfaces            []runtimeHeartbeatSurfaceView
	HeartbeatLogPath             string
	RepoMountedPath              string
	RepoMounted                  bool
	RepoClonePath                string
	RepoCloneReady               bool
	RepoWorktreeDir              string
	RepoBranch                   string
	RepoHEAD                     string
	RepoError                    string
}

type runtimeHeartbeatFollowupView struct {
	ID             int64
	Kind           string
	Title          string
	Summary        string
	Priority       string
	SourceKind     string
	ChannelID      string
	ThreadTS       string
	DueAt          *time.Time
	PlannedSurface string
	BlockReason    string
}

type runtimeHeartbeatSurfaceView struct {
	Title            string
	Summary          string
	RequestedSurface string
	DeliveredSurface string
	Status           string
	ChannelID        string
	ThreadTS         string
}

type runtimeMeetingsSnapshot struct {
	Error      string
	Live       []runtimeMeetingView
	Processing []runtimeMeetingView
	Recent     []runtimeMeetingView
}

type runtimeMeetingView struct {
	ID             int64
	Title          string
	Status         string
	StartedAt      time.Time
	EndedAt        time.Time
	SlackChannelID string
	SlackThreadTS  string
	ErrorMessage   string
}

func formatRuntimeStatusHeartbeat(runtime *slackRuntimeStatusData) string {
	if runtime == nil {
		return "Heartbeat: unavailable"
	}
	lines := []string{
		fmt.Sprintf("Scope: %s", fallbackText(runtime.HeartbeatScopeLabel, "global")),
		fmt.Sprintf("Loop: %s", boolText(runtime.HeartbeatLoop, "running", "stopped")),
		fmt.Sprintf("Interval: %s", formatRuntimeDuration(runtime.HeartbeatInterval)),
		fmt.Sprintf("Next tick: %s", formatRuntimeTime(runtime.HeartbeatNextTickAt)),
	}
	switch {
	case runtime.HeartbeatLastResultHidden:
		lines = append(lines, "Last result: hidden outside this thread")
	case runtime.HeartbeatLastAt.IsZero():
		lines = append(lines, "Last result: none yet")
	default:
		lines = append(lines, fmt.Sprintf("Last result: %s", formatRuntimeTime(runtime.HeartbeatLastAt)))
	}
	if runtime.HeartbeatScopeLabel != "" && runtime.HeartbeatScopeLabel != "global" {
		lines = append(lines,
			fmt.Sprintf("Global pending follow-ups: %d", runtime.HeartbeatGlobalPendingCount),
			fmt.Sprintf("Visible pending follow-ups: %d", runtime.HeartbeatVisiblePendingCount),
		)
	} else {
		lines = append(lines, fmt.Sprintf("Pending follow-ups: %d", runtime.HeartbeatGlobalPendingCount))
	}
	lines = append(lines,
		fmt.Sprintf("Last status: %s", heartbeatLastStatus(runtime)),
		fmt.Sprintf("Title: %s", fallbackText(runtime.HeartbeatTitle, "none")),
		fmt.Sprintf("Summary: %s", fallbackText(runtime.HeartbeatSummary, "none")),
		fmt.Sprintf("Open self-improvement items: %d", runtime.HeartbeatSelfImprovementOpen),
		fmt.Sprintf("Stale reminders cleaned: %d", runtime.HeartbeatStaleReminderCount),
		fmt.Sprintf("Notify delivery: %s", heartbeatDeliveryLine(runtime)),
		fmt.Sprintf("Log path: %s", fallbackText(runtime.HeartbeatLogPath, "unknown")),
	)
	if len(runtime.HeartbeatPendingByKind) > 0 {
		lines = append(lines, fmt.Sprintf("By kind: pending_decision=%d, user_followup=%d, self_improvement=%d",
			runtime.HeartbeatPendingByKind["pending_decision"],
			runtime.HeartbeatPendingByKind["user_followup"]+runtime.HeartbeatPendingByKind["commitment"],
			runtime.HeartbeatPendingByKind["self_improvement"],
		))
	}
	if len(runtime.HeartbeatPending) > 0 {
		lines = append(lines, "Top pending:")
		for _, followup := range runtime.HeartbeatPending {
			lines = append(lines, runtimeHeartbeatPendingLine(followup))
		}
	}
	if recent := runtimeHeartbeatRecentSurfaceLines(runtime, 3); len(recent) > 0 {
		lines = append(lines, "Recent surfaces:")
		for _, line := range recent {
			lines = append(lines, "- "+line)
		}
	}
	if runtime.HeartbeatError != "" {
		lines = append(lines, fmt.Sprintf("Delivery error: %s", runtime.HeartbeatError))
	}
	return strings.Join(lines, "\n")
}

func runtimeHeartbeatPendingLine(followup runtimeHeartbeatFollowupView) string {
	hints := []string{followup.Priority}
	if followup.DueAt != nil {
		hints = append(hints, "due "+followup.DueAt.In(shanghaiLocation()).Format("2006-01-02 15:04"))
	}
	if followup.PlannedSurface != "" {
		hints = append(hints, "surface "+followup.PlannedSurface)
	}
	if followup.BlockReason != "" {
		hints = append(hints, "blocked "+followup.BlockReason)
	}
	source := followup.SourceKind
	if followup.ChannelID != "" && followup.ThreadTS != "" {
		source = fmt.Sprintf("%s %s/%s", source, followup.ChannelID, followup.ThreadTS)
	}
	return fmt.Sprintf("- #%d %s (%s, %s)", followup.ID, fallbackText(followup.Title, followup.Summary), source, strings.Join(hints, ", "))
}

func runtimeHeartbeatRecentSurfaceLines(runtime *slackRuntimeStatusData, limit int) []string {
	if runtime == nil || limit <= 0 {
		return nil
	}
	surfaces := runtime.HeartbeatSurfaces
	if len(surfaces) > limit {
		surfaces = surfaces[:limit]
	}
	lines := make([]string, 0, len(surfaces))
	for _, surface := range surfaces {
		lines = append(lines, fmt.Sprintf("%s via %s — %s", fallbackText(surface.Title, surface.Summary), fallbackText(surface.DeliveredSurface, surface.RequestedSurface, "auto"), surface.Status))
	}
	return lines
}

func formatRuntimeStatusRepos(runtime *slackRuntimeStatusData) string {
	if runtime == nil {
		return "Repo runtime: unavailable"
	}
	lines := []string{
		fmt.Sprintf("Source repo: %s", fallbackText(runtime.RepoMountedPath, "not discovered")),
		fmt.Sprintf("Available: %s", boolText(runtime.RepoMounted, "yes", "no")),
		fmt.Sprintf("Writable clone: %s", fallbackText(runtime.RepoClonePath, "not configured")),
		fmt.Sprintf("Clone ready: %s", boolText(runtime.RepoCloneReady, "yes", "no")),
		fmt.Sprintf("Worktree root: %s", fallbackText(runtime.RepoWorktreeDir, "not configured")),
		fmt.Sprintf("Host branch: %s", fallbackText(runtime.RepoBranch, "unknown")),
		fmt.Sprintf("Host HEAD: %s", fallbackText(runtime.RepoHEAD, "unknown")),
		"Code reads should use the available source repo. Code edits should use isolated worktrees under the worktree root, based on committed HEAD only.",
	}
	if runtime.RepoError != "" {
		lines = append(lines, fmt.Sprintf("Repo error: %s", runtime.RepoError))
	}
	return strings.Join(lines, "\n")
}

func formatRuntimeStatusMeetings(snapshot *runtimeMeetingsSnapshot) string {
	if snapshot == nil {
		return "Meetd: unavailable"
	}
	if snapshot.Error != "" {
		return "Meetd: unavailable (" + snapshot.Error + ")"
	}
	lines := []string{
		fmt.Sprintf("Live meetings: %d", len(snapshot.Live)),
		fmt.Sprintf("Post-processing: %d", len(snapshot.Processing)),
		fmt.Sprintf("Recent finished/failed: %d", len(snapshot.Recent)),
	}
	if len(snapshot.Live) > 0 {
		lines = append(lines, "Live join/listen activity:")
		for _, view := range snapshot.Live {
			lines = append(lines, runtimeMeetingLine(view))
		}
	}
	if len(snapshot.Processing) > 0 {
		lines = append(lines, "Post-processing activity:")
		for _, view := range snapshot.Processing {
			lines = append(lines, runtimeMeetingLine(view))
		}
	}
	if len(snapshot.Recent) > 0 {
		lines = append(lines, "Recent finished or failed:")
		for _, view := range snapshot.Recent {
			lines = append(lines, runtimeMeetingLine(view))
		}
	}
	if len(snapshot.Live) == 0 && len(snapshot.Processing) == 0 && len(snapshot.Recent) == 0 {
		lines = append(lines, "No recent meeting activity.")
	}
	return strings.Join(lines, "\n")
}

func formatRuntimeStatusOverview(runtime *slackRuntimeStatusData, meetings *runtimeMeetingsSnapshot) string {
	if runtime == nil {
		runtime = &slackRuntimeStatusData{}
	}
	lines := []string{
		fmt.Sprintf("Run mode: %s", fallbackText(runtime.RunMode, "unknown")),
		fmt.Sprintf("Workspace: %s", fallbackText(runtime.WorkspaceDir, "unknown")),
		fmt.Sprintf("Scanner: %s / debounce %s / max batch %d", fallbackText(runtime.ScanMode, "unknown"), fallbackText(runtime.Debounce, "unknown"), runtime.MaxBatch),
		fmt.Sprintf("Heartbeat: %s", heartbeatSummaryLine(runtime)),
		fmt.Sprintf("Meetings: %s", runtimeMeetingsSummaryLine(meetings)),
		fmt.Sprintf("Repo access: %s", repoSummaryLine(runtime)),
	}
	var integrations []string
	for _, name := range []string{"Google Calendar", "Linear", "Figma", "Notion", "Meet Agent"} {
		if runtime.Integrations[name] {
			integrations = append(integrations, name)
		}
	}
	if len(integrations) == 0 {
		lines = append(lines, "Integrations: none")
	} else {
		lines = append(lines, "Integrations: "+strings.Join(integrations, ", "))
	}
	return strings.Join(lines, "\n")
}

func runtimeMeetingLine(view runtimeMeetingView) string {
	hints := []string{strings.ToLower(strings.TrimSpace(view.Status))}
	if !view.StartedAt.IsZero() {
		hints = append(hints, "started "+formatRuntimeTime(view.StartedAt))
	}
	if !view.EndedAt.IsZero() {
		hints = append(hints, "ends "+formatRuntimeTime(view.EndedAt))
	}
	if view.SlackChannelID != "" && view.SlackThreadTS != "" {
		hints = append(hints, fmt.Sprintf("thread %s/%s", view.SlackChannelID, view.SlackThreadTS))
	}
	if view.ErrorMessage != "" {
		hints = append(hints, "error "+view.ErrorMessage)
	}
	return fmt.Sprintf("- #%d %s (%s)", view.ID, fallbackText(view.Title, "untitled"), strings.Join(hints, ", "))
}

func runtimeMeetingsSummaryLine(snapshot *runtimeMeetingsSnapshot) string {
	if snapshot == nil {
		return "unknown"
	}
	if snapshot.Error != "" {
		return "unavailable (" + snapshot.Error + ")"
	}
	parts := make([]string, 0, 3)
	if len(snapshot.Live) > 0 {
		parts = append(parts, fmt.Sprintf("%d live (%s)", len(snapshot.Live), strings.Join(runtimeMeetingCompactLabels(snapshot.Live, 2), ", ")))
	} else {
		parts = append(parts, "no live meetings")
	}
	if len(snapshot.Processing) > 0 {
		parts = append(parts, fmt.Sprintf("%d post-processing (%s)", len(snapshot.Processing), strings.Join(runtimeMeetingCompactLabels(snapshot.Processing, 2), ", ")))
	}
	if len(snapshot.Recent) > 0 {
		parts = append(parts, "recent: "+strings.Join(runtimeMeetingCompactLabels(snapshot.Recent, 2), ", "))
	}
	return strings.Join(parts, "; ")
}

func runtimeMeetingCompactLabels(meetings []runtimeMeetingView, limit int) []string {
	if limit <= 0 || len(meetings) == 0 {
		return nil
	}
	if len(meetings) > limit {
		meetings = meetings[:limit]
	}
	labels := make([]string, 0, len(meetings))
	for _, view := range meetings {
		labels = append(labels, fmt.Sprintf("%s=%s", fallbackText(view.Title, fmt.Sprintf("#%d", view.ID)), strings.ToLower(strings.TrimSpace(view.Status))))
	}
	return labels
}

func scopedRuntimeHeartbeat(runtime *slackRuntimeStatusData, followups []SlackHeartbeatFollowup, surfaces []SlackHeartbeatSurface, channelID string, threadTS string) *slackRuntimeStatusData {
	if runtime == nil {
		runtime = &slackRuntimeStatusData{}
	}
	scoped := *runtime
	scoped.HeartbeatScopeLabel = fmt.Sprintf("thread %s/%s", fallbackText(channelID, "unknown"), fallbackText(threadTS, "unknown"))
	scoped.HeartbeatGlobalPendingCount = len(followups)
	scoped.HeartbeatPending = nil
	for _, followup := range followups {
		if followup.ChannelID == channelID && followup.ThreadTS == threadTS {
			scoped.HeartbeatPending = append(scoped.HeartbeatPending, runtimeHeartbeatFollowupView{
				ID:         followup.ID,
				Kind:       followup.Kind,
				Title:      followup.Title,
				Summary:    followup.Summary,
				Priority:   followup.Priority,
				SourceKind: followup.SourceKind,
				ChannelID:  followup.ChannelID,
				ThreadTS:   followup.ThreadTS,
			})
		}
	}
	scoped.HeartbeatVisiblePendingCount = len(scoped.HeartbeatPending)
	scoped.HeartbeatSurfaces = nil
	for _, surface := range surfaces {
		if surface.ChannelID == channelID && surface.ThreadTS == threadTS {
			scoped.HeartbeatSurfaces = append(scoped.HeartbeatSurfaces, runtimeHeartbeatSurfaceView{
				Title:            surface.Title,
				Summary:          surface.Summary,
				RequestedSurface: surface.RequestedSurface,
				DeliveredSurface: surface.DeliveredSurface,
				Status:           surface.Status,
				ChannelID:        surface.ChannelID,
				ThreadTS:         surface.ThreadTS,
			})
		}
	}
	if scoped.HeartbeatLastFollowupID != 0 && !runtimeFollowupMatchesSource(followups, scoped.HeartbeatLastFollowupID, channelID, threadTS) {
		scoped.HeartbeatLastResultHidden = true
		scoped.HeartbeatTitle = ""
		scoped.HeartbeatSummary = ""
		scoped.HeartbeatNotified = false
		scoped.HeartbeatError = ""
	}
	return &scoped
}

func runtimeFollowupMatchesSource(followups []SlackHeartbeatFollowup, id int64, channelID string, threadTS string) bool {
	for _, followup := range followups {
		if followup.ID == id {
			return followup.ChannelID == channelID && followup.ThreadTS == threadTS
		}
	}
	return false
}

func heartbeatSummaryLine(runtime *slackRuntimeStatusData) string {
	if runtime == nil {
		return "unknown"
	}
	state := boolText(runtime.HeartbeatLoop, "running", "stopped")
	if runtime.HeartbeatLastAt.IsZero() {
		return fmt.Sprintf("%s, no result yet", state)
	}
	return fmt.Sprintf("%s, last %s", state, relRuntimeTime(runtime.HeartbeatLastAt))
}

func repoSummaryLine(runtime *slackRuntimeStatusData) string {
	if runtime == nil {
		return "unknown"
	}
	if !runtime.RepoMounted {
		if runtime.RepoError != "" {
			return runtime.RepoError
		}
		return "source repo unavailable"
	}
	if runtime.RepoCloneReady {
		return fmt.Sprintf("source repo at %s, writable clone ready", runtime.RepoMountedPath)
	}
	return fmt.Sprintf("source repo at %s, writable clone not ready", runtime.RepoMountedPath)
}

func heartbeatDeliveryLine(runtime *slackRuntimeStatusData) string {
	switch {
	case runtime == nil:
		return "unknown"
	case runtime.HeartbeatError != "":
		return "error"
	case runtime.HeartbeatNotified:
		return "sent"
	case runtime.HeartbeatLastAt.IsZero():
		return "none yet"
	default:
		return "no DM sent"
	}
}

func heartbeatLastStatus(runtime *slackRuntimeStatusData) string {
	switch {
	case runtime == nil || runtime.HeartbeatLastAt.IsZero():
		return "none yet"
	case runtime.HeartbeatError != "":
		return "delivery_error"
	case runtime.HeartbeatNotified:
		return "sent"
	default:
		return "suppressed"
	}
}

func formatRuntimeDuration(value time.Duration) string {
	if value <= 0 {
		return "unknown"
	}
	return value.String()
}

func formatRuntimeTime(value time.Time) string {
	if value.IsZero() {
		return "unknown"
	}
	return value.In(shanghaiLocation()).Format("2006-01-02 15:04:05")
}

func relRuntimeTime(value time.Time) string {
	if value.IsZero() {
		return "unknown"
	}
	return value.In(shanghaiLocation()).Format("2006-01-02 15:04:05")
}

func fallbackText(values ...string) string {
	return firstNonEmpty(values...)
}

func boolText(value bool, ifTrue string, ifFalse string) string {
	if value {
		return ifTrue
	}
	return ifFalse
}
