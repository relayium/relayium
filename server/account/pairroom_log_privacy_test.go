package account

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

func TestPairJoinFailureLogsContainNoSensitiveJoinValues(t *testing.T) {
	var out bytes.Buffer
	oldWriter := log.Writer()
	oldFlags := log.Flags()
	oldPrefix := log.Prefix()
	log.SetOutput(&out)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(oldWriter)
		log.SetFlags(oldFlags)
		log.SetPrefix(oldPrefix)
	})

	logPairJoinGenerationMismatch()
	logPairJoinFlushFailure()
	logPairJoinRetryFailure()
	got := out.String()
	for _, required := range []string{"stale join observation ignored", "queued join write failed", "queued join retry failed"} {
		if !strings.Contains(got, required) {
			t.Errorf("log lacks fixed diagnostic %q: %s", required, got)
		}
	}
	for _, sensitive := range []string{
		"424242", "account-secret", "user-secret", "203.0.113.9",
		"generation-secret", "room-secret", "token-secret",
	} {
		if strings.Contains(got, sensitive) {
			t.Errorf("join failure log contains %q: %s", sensitive, got)
		}
	}
}
