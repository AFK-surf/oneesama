//go:build unix

package processutil

import (
	"fmt"
	"os/exec"
	"strings"
	"syscall"
)

// PrepareGroup configures the command so the child runs in its own process
// group. This lets us deliver signals to the entire process tree later, which
// matches Cueboard's behavior for both Codex worker subprocesses and the
// meet-runner Node bridge.
func PrepareGroup(command *exec.Cmd) {
	if command == nil {
		return
	}
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.Setpgid = true
}

// KillGroup sends SIGKILL to the process group rooted at command.Process,
// matching the prior agentrunner/meetrunner behavior. ESRCH (process already
// gone) is treated as a success because the caller's intent was to stop the
// subprocess, and "already stopped" satisfies that intent.
//
// label is used to give callers a recognizable error prefix without each
// runner having to format its own message.
func KillGroup(label string, command *exec.Cmd) error {
	if command == nil || command.Process == nil {
		return nil
	}
	pid := command.Process.Pid
	if pid <= 0 {
		return command.Process.Kill()
	}
	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
		return fmt.Errorf("kill %s process group %d: %w", strings.TrimSpace(label), pid, err)
	}
	return nil
}
