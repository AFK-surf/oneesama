//go:build unix

package meetrunner

import (
	"os/exec"

	"github.com/AFK-surf/oneesama/internal/processutil"
)

func prepareCommand(command *exec.Cmd) {
	processutil.PrepareGroup(command)
}

func terminateCommand(command *exec.Cmd) error {
	return processutil.KillGroup("meet-runner", command)
}
