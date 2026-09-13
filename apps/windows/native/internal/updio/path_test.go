// Which layouts this will anchor on, and which it refuses.
package updio

import "testing"

func TestSplitPhysicalAcceptsAnOrdinaryUserRoot(t *testing.T) {
	// The path that actually matters: a per-user install's data root.
	volume, components, err := SplitPhysical(`\\?\C:\Users\someone\AppData\Local\Relayium`)
	if err != nil {
		t.Fatalf("an ordinary user root must remain usable: %v", err)
	}
	if volume != "C:" {
		t.Fatalf("volume %q", volume)
	}
	want := []string{"Users", "someone", "AppData", "Local", "Relayium"}
	if len(components) != len(want) {
		t.Fatalf("components %v", components)
	}
	for i := range want {
		if components[i] != want[i] {
			t.Fatalf("components %v", components)
		}
	}
	// Every one of those is a directory the traversal will hold, which is the
	// point: the chain above the app root is what a parent rename would move.
}

func TestSplitPhysicalWithoutTheExtendedPrefix(t *testing.T) {
	volume, components, err := SplitPhysical(`C:\Users\someone\AppData\Local\Relayium`)
	if err != nil || volume != "C:" || len(components) != 5 {
		t.Fatalf("plain path: %q %v %v", volume, components, err)
	}
}

func TestSplitPhysicalRefusesWhatItCannotPin(t *testing.T) {
	for _, c := range []struct {
		name string
		path string
		code string
	}{
		{"UNC via the extended prefix", `\\?\UNC\server\share\Relayium`, CodeRedirected},
		{"bare UNC", `\\server\share\Relayium`, CodeRedirected},
		{"device path", `\\.\PhysicalDrive0\Relayium`, CodeRedirected},
		{"volume GUID", `\\?\Volume{11111111-2222-3333-4444-555555555555}\Relayium`, CodeRedirected},
		{"relative", `Relayium\updates`, CodeBadName},
		{"drive with no root", `C:Relayium`, CodeBadName},
		{"volume root itself", `\\?\C:\`, CodeBadName},
		{"traversal left in", `C:\Users\..\Relayium`, CodeBadName},
	} {
		_, _, err := SplitPhysical(c.path)
		if err == nil {
			t.Fatalf("%s was accepted: %q", c.name, c.path)
		}
		if !IsCode(err, c.code) {
			t.Fatalf("%s: got %v, want %s", c.name, err, c.code)
		}
	}
}
