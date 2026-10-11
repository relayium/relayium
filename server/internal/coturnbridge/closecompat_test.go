package coturnbridge

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// closeSpool releases a directly opened spool's directory lock.
func closeSpool(sp *Spool) { sp.Close() }

// recordFilesOnDisk counts allocation records in both tiers by listing the
// directories (independent of the spool's own accounting).
func recordFilesOnDisk(t *testing.T, dir string) int {
	t.Helper()
	n := 0
	for _, d := range []string{dir, filepath.Join(dir, "overflow")} {
		ents, err := os.ReadDir(d)
		if err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		for _, e := range ents {
			if !e.IsDir() && strings.HasSuffix(e.Name(), spoolExt) {
				n++
			}
		}
	}
	return n
}
