package xfer

import "testing"

// A host (or user) beginning with "-" would be handed to the ssh binary as an
// option (e.g. "-oProxyCommand=..."), turning a push/pull/sync target into
// arbitrary command execution. ParseEndpoint must reject it.
func TestParseEndpointRejectsDashHost(t *testing.T) {
	for _, s := range []string{
		"-oProxyCommand=id:path",
		"-l:path",
		"me@-oProxyCommand=id:path",
		"-badhost:.",
	} {
		if _, err := ParseEndpoint(s); err == nil {
			t.Errorf("ParseEndpoint(%q) = nil, want option-injection rejected", s)
		}
	}
}

func TestParseEndpointAllowsNormalHosts(t *testing.T) {
	for _, s := range []string{"host:path", "me@host:path", "192.168.1.5:.", "./local", "-"} {
		if _, err := ParseEndpoint(s); err != nil {
			t.Errorf("ParseEndpoint(%q) = err %v, want accepted", s, err)
		}
	}
}
