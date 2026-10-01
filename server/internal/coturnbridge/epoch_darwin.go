package coturnbridge

import (
	"errors"
	"fmt"

	"golang.org/x/sys/unix"
)

// darwin support exists for the local provider harness only; production
// coturn hosts are Linux.

func bootID() (string, error) {
	tv, err := unix.SysctlTimeval("kern.boottime")
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("darwin-boot-%d-%06d", tv.Sec, tv.Usec), nil
}

// processStart returns the process name and its start time in microseconds
// since the epoch.
func processStart(pid int) (string, uint64, error) {
	k, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		// x/sys reports a PID with no process as EIO: the sysctl returns no
		// kinfo_proc record, which it checks by size.
		if errors.Is(err, unix.ESRCH) || errors.Is(err, unix.EIO) {
			return "", 0, errNoProcess
		}
		return "", 0, err
	}
	if int(k.Proc.P_pid) != pid {
		return "", 0, errNoProcess
	}
	var name []byte
	for _, c := range k.Proc.P_comm {
		if c == 0 {
			break
		}
		name = append(name, byte(c))
	}
	st := k.Proc.P_starttime
	start := uint64(st.Sec)*1_000_000 + uint64(st.Usec)
	if start == 0 {
		return "", 0, errors.New("no start time")
	}
	return string(name), start, nil
}
