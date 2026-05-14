//go:build !unix

package meetrunner

import "os/exec"

func prepareCommand(command *exec.Cmd) {}

func terminateCommand(command *exec.Cmd) error {
	if command == nil || command.Process == nil {
		return nil
	}
	return command.Process.Kill()
}
