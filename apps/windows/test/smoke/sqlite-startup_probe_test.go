package sqlitestartup_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
)

// Compiled as a standalone test file by the fixture, using the server module's
// real dependency graph. It does not add tests to the Linux account shards.
func TestSQLiteColdStart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fresh.db")
	for _, phase := range []string{"cold", "reopen"} {
		started := time.Now()
		store, err := account.OpenSQLite(path)
		if err != nil {
			t.Fatalf("%s OpenSQLite: %v", phase, err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err = store.Ping(ctx)
		cancel()
		closeErr := store.Close()
		if err != nil || closeErr != nil {
			t.Fatalf("%s database health=%v close=%v", phase, err, closeErr)
		}
		t.Logf("%s OpenSQLite, writable health probe and close: %s", phase, time.Since(started))
	}
}
