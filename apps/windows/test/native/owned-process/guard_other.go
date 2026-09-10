//go:build !windows

package main

import (
	"fmt"
	"runtime"
)

// Launch refuses, on every host that is not Windows.
//
// There is no portable stand-in here and there must not be one. A Job Object is
// the entire point of this program: a POSIX substitute — a process group, a
// pgid kill — has different semantics, would pass different tests, and would
// let a green run on a developer's Mac be mistaken for evidence about Windows
// cleanup. The build closes here so the whole program still compiles and its
// platform-independent parts are still testable; the guarantee it exists to
// make is claimed only where it is real.
func Launch(Config) (Guarded, error) {
	return nil, fmt.Errorf("the Windows Job Object guardian has no meaning on %s: "+
		"nothing here can account for a process tree the way a job object does, "+
		"and a substitute that passed would be evidence of nothing", runtime.GOOS)
}
