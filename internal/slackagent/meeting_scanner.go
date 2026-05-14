package slackagent

import "time"

const meetingApprovalLeadTime = time.Minute

func meetingScannerLookahead(interval time.Duration) time.Duration {
	if interval <= 0 {
		interval = time.Minute
	}
	return meetingApprovalLeadTime + interval + 15*time.Second
}

func shouldSuggestMeetingApprovalAt(now time.Time, start time.Time, interval time.Duration) bool {
	if interval <= 0 {
		interval = time.Minute
	}
	untilStart := start.Sub(now)
	if untilStart > meetingApprovalLeadTime {
		return false
	}
	return untilStart >= -(interval + 15*time.Second)
}
