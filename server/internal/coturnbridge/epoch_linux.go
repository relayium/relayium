package coturnbridge

import (
	"errors"
	"os"
	"strconv"
	"strings"
)

// bootID is the kernel's per-boot random UUID.
func bootID() (string, error) {
	b, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// processStart returns the process name and its start time in clock ticks
// since boot (/proc/<pid>/stat field 22). The name is parsed from between the
// first '(' and the LAST ')', since it may itself contain spaces or ')'.
func processStart(pid int) (string, uint64, error) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", 0, errNoProcess
		}
		return "", 0, err
	}
	return parseProcStat(string(b))
}

// parseProcStat parses /proc/<pid>/stat content.
func parseProcStat(s string) (string, uint64, error) {
	open, close := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
	if open < 0 || close < open {
		return "", 0, errors.New("malformed stat")
	}
	name := s[open+1 : close]
	fields := strings.Fields(s[close+1:])
	// fields[0] is field 3 (state); starttime is field 22.
	if len(fields) < 20 {
		return "", 0, errors.New("short stat")
	}
	start, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil || start == 0 {
		return "", 0, errors.New("bad starttime")
	}
	return name, start, nil
}
