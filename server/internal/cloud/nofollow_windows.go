//go:build windows

package cloud

// Windows has no O_NOFOLLOW; symlink creation there is privileged and the
// download path never creates them, so leave the flag off.
const oNoFollow = 0
