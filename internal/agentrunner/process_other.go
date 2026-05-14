//go:build !unix

package agentrunner

import "os/exec"

func prepareCommand(command *exec.Cmd) {}

func terminateCommand(command *exec.Cmd) error {
	if command.Process == nil {
		return nil
	}
	return command.Process.Kill()
}
