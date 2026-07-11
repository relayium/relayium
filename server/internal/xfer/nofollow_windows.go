//go:build windows

package xfer

// Windows has no O_NOFOLLOW; symlink creation there is privileged and the
// receive path never creates them, so leave the flag off.
const oNoFollow = 0
