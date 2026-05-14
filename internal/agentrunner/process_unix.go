//go:build unix

package agentrunner

import (
	"fmt"
	"os/exec"
	"syscall"
)

func prepareCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateCommand(command *exec.Cmd) error {
	if command.Process == nil {
		return nil
	}

	pid := command.Process.Pid
	if pid <= 0 {
		return command.Process.Kill()
	}

	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
		return fmt.Errorf("kill process group %d: %w", pid, err)
	}
	return nil
}
