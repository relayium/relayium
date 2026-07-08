package main

import (
	"path/filepath"
	"testing"
)

func TestParseDaemonURL(t *testing.T) {
	cases := []struct {
		in, want string
		wantErr  bool
	}{
		{"relayium://host", "host:9031", false},
		{"relayium://host:1234", "host:1234", false},
		{"relayium://127.0.0.1:9031", "127.0.0.1:9031", false},
		{"relayium://", "", true},
		{"relayium://host/sub", "", true},
	}
	for _, c := range cases {
		got, err := parseDaemonURL(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("%q: expected error, got %q", c.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: unexpected error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("%q: got %q, want %q", c.in, got, c.want)
		}
	}
}

func TestResolveConfigDirOverrideWins(t *testing.T) {
	if got, _ := resolveConfigDir("/etc/relayium"); got != "/etc/relayium" {
		t.Fatalf("override = %q, want /etc/relayium", got)
	}
}

func TestResolveConfigDirXDG(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/xdg")
	got, err := resolveConfigDir("")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join("/xdg", "relayium"); got != want {
		t.Fatalf("xdg = %q, want %q", got, want)
	}
}
