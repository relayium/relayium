package selfupdate

import (
	"context"
	"io"
	"os"
	"runtime"
	"strings"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
		ok   bool
	}{
		{"v1.2.3", "v1.2.3", 0, true},
		{"v1.2.4", "v1.2.3", 1, true},
		{"v1.2.3", "v1.3.0", -1, true},
		{"v2.0.0", "v1.9.9", 1, true},
		{"1.0.0", "v1.0.0", 0, true},       // leading v optional
		{"dev", "v1.0.0", 0, false},        // unparseable → incomparable
		{"v1.2", "v1.2.0", 0, false},       // wrong arity
		{"v1.2.3-rc1", "v1.2.3", 0, false}, // pre-release → incomparable
	}
	for _, c := range cases {
		got, ok := compareVersions(c.a, c.b)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("compareVersions(%q,%q) = (%d,%v), want (%d,%v)", c.a, c.b, got, ok, c.want, c.ok)
		}
	}
}

// Update must refuse a release older than the running version (a compromised /
// rolled-back release host serving an old tag) unless --force is set.
func TestUpdateRefusesDowngrade(t *testing.T) {
	fr := &fakeRelease{tag: "v1.0.0", asset: AssetName(runtime.GOOS, runtime.GOARCH), archive: tarGzWith(t, "OLD-RELEASE")}
	srv := fr.server(t)
	defer srv.Close()

	target := writeTarget(t, "CURRENT")
	o := baseOpts(srv, target)
	o.CurrentVersion = "v9.9.9" // newer than the offered v1.0.0

	_, _, changed, err := Update(context.Background(), o, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "downgrade") {
		t.Fatalf("want a downgrade-refusal error, got changed=%v err=%v", changed, err)
	}
	if got, _ := os.ReadFile(target); string(got) != "CURRENT" {
		t.Fatalf("binary must be untouched on a refused downgrade, got %q", got)
	}
}

// --force overrides the downgrade guard for a deliberate rollback.
func TestUpdateForceAllowsDowngrade(t *testing.T) {
	fr := &fakeRelease{tag: "v1.0.0", asset: AssetName(runtime.GOOS, runtime.GOARCH), archive: tarGzWith(t, "ROLLED-BACK")}
	srv := fr.server(t)
	defer srv.Close()

	target := writeTarget(t, "CURRENT")
	o := baseOpts(srv, target)
	o.CurrentVersion = "v9.9.9"
	o.Force = true

	_, _, changed, err := Update(context.Background(), o, io.Discard)
	if err != nil || !changed {
		t.Fatalf("force downgrade: changed=%v err=%v", changed, err)
	}
	if got, _ := os.ReadFile(target); string(got) != "ROLLED-BACK" {
		t.Fatalf("force downgrade should install the older build, got %q", got)
	}
}

// A "dev" (unparseable) current version is never blocked by the guard.
func TestUpdateDevVersionNotBlocked(t *testing.T) {
	fr := &fakeRelease{tag: "v1.0.0", asset: AssetName(runtime.GOOS, runtime.GOARCH), archive: tarGzWith(t, "REL")}
	srv := fr.server(t)
	defer srv.Close()

	target := writeTarget(t, "DEVBIN")
	o := baseOpts(srv, target)
	o.CurrentVersion = "dev"

	_, _, changed, err := Update(context.Background(), o, io.Discard)
	if err != nil || !changed {
		t.Fatalf("dev → release must proceed: changed=%v err=%v", changed, err)
	}
}
