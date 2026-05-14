package slackagent

import "github.com/AFK-surf/oneesama/internal/agentrunner"

const slackImmediateWorkerFailureText = "我接到了，但后台处理失败了，正在把错误收口。"

func slackImmediateCommandAckText(response AvatarCommandResponse) string {
	status, hasJob := avatarCommandJobStatus(response)
	if !hasJob {
		return response.Text
	}
	if status == agentrunner.StatusFailed {
		return slackImmediateWorkerFailureText
	}
	return ""
}

func shouldKeepAssistantStatusUntilWorkerDone(response AvatarCommandResponse) bool {
	status, hasJob := avatarCommandJobStatus(response)
	return hasJob && status == agentrunner.StatusRunning
}

func avatarCommandJobStatus(response AvatarCommandResponse) (agentrunner.JobStatus, bool) {
	if response.Metadata == nil {
		return "", false
	}
	job, ok := response.Metadata["job"]
	if !ok || job == nil {
		return "", false
	}

	switch value := job.(type) {
	case agentrunner.Job:
		return value.Status, true
	case *agentrunner.Job:
		if value == nil {
			return "", false
		}
		return value.Status, true
	case map[string]any:
		return jobStatusFromMap(value)
	case map[string]string:
		return agentrunner.JobStatus(value["status"]), value["status"] != ""
	default:
		return "", false
	}
}

func jobStatusFromMap(value map[string]any) (agentrunner.JobStatus, bool) {
	status, ok := value["status"].(string)
	if !ok || status == "" {
		return "", false
	}
	return agentrunner.JobStatus(status), true
}
