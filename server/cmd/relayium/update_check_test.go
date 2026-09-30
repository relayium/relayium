package main

import (
	"strings"
	"testing"
)

// TestUpdateCheckVerdictOnlyOffersStrictlyNewerReleases pins CLI-2: `update
// --check` used to say "update available" whenever the latest tag merely
// differed from the running version, including when the latest release was
// OLDER — advice that `relayium update` itself then refuses as a downgrade.
func TestUpdateCheckVerdictOnlyOffersStrictlyNewerReleases(t *testing.T) {
	const avail = "update available"
	cases := []struct {
		latest, current string
		wantAvailable   bool
	}{
		{"v1.2.4", "1.2.3", true},
		{"v2.0.0", "1.9.9", true},
		{"v1.2.3", "1.2.3", false},
		{"v1.2.2", "1.2.3", false}, // latest is older: must not advertise it
		{"v0.9.0", "1.0.0", false},
		{"v1.2.3", "dev", true}, // unordered source build: latest is installable over it
	}
	for _, c := range cases {
		got := updateCheckVerdict(c.latest, c.current)
		if strings.HasPrefix(got, avail) != c.wantAvailable {
			t.Errorf("updateCheckVerdict(%q, %q) = %q, want available=%v", c.latest, c.current, got, c.wantAvailable)
		}
	}
}

// TestUpdateHelpDocumentsForceBypassesTheFloor pins CLI-2's documentation half:
// --force silently bypassing the minimum-version (security) floor must be stated.
func TestUpdateHelpDocumentsForceBypassesTheFloor(t *testing.T) {
	for _, want := range []string{"minimum-version floor", "downgrade"} {
		if !strings.Contains(updateUsage, want) {
			t.Errorf("updateUsage does not mention %q:\n%s", want, updateUsage)
		}
	}
}
