package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"os"
	"runtime"
	"testing"
)

// tarGzNamed builds a gzip+tar archive holding one regular file with the given
// entry name, so a test can serve an archive whose payload is NOT called
// "relayium".
func tarGzNamed(t *testing.T, entry, content string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	body := []byte(content)
	if err := tw.WriteHeader(&tar.Header{Name: entry, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// AssetPrefix / BinaryName select a non-CLI artifact of the same release. The
// fake release below serves ONLY the node's archive, so an Update that ignored
// the override would 404 rather than quietly install the wrong program.
func TestUpdateInstallsOverriddenArtifact(t *testing.T) {
	asset := AssetNameFor("relayium-node", runtime.GOOS, runtime.GOARCH)
	fr := &fakeRelease{tag: "v9.9.9", asset: asset, archive: tarGzNamed(t, "relayium-node", "NODE-BINARY")}
	srv := fr.server(t)
	defer srv.Close()

	target := writeTarget(t, "OLD")
	o := baseOpts(srv, target)
	o.AssetPrefix = "relayium-node"
	o.BinaryName = "relayium-node"
	if _, _, changed, err := Update(context.Background(), o, io.Discard); err != nil || !changed {
		t.Fatalf("Update: changed=%v err=%v", changed, err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "NODE-BINARY" {
		t.Fatalf("target = %q, want the node archive's %q", got, "NODE-BINARY")
	}
}

// Empty overrides must keep the CLI's exact names — `relayium update` passes
// neither field and its behaviour must not change.
func TestOptionsDefaultToCLIArtifactNames(t *testing.T) {
	var o Options
	o.GOOS, o.GOARCH = "darwin", "arm64"
	if got, want := o.assetName(), "relayium_darwin_arm64.tar.gz"; got != want {
		t.Errorf("assetName = %q, want %q", got, want)
	}
	if got := o.binaryName(); got != "relayium" {
		t.Errorf("binaryName = %q, want %q", got, "relayium")
	}
	if got, want := AssetName("linux", "amd64"), AssetNameFor("relayium", "linux", "amd64"); got != want {
		t.Errorf("AssetName = %q, want %q", got, want)
	}
}

func TestIsPlainVersion(t *testing.T) {
	for _, s := range []string{"v1.2.3", "1.2.3", "v0.0.0"} {
		if !IsPlainVersion(s) {
			t.Errorf("IsPlainVersion(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "dev", "latest", "v1.2", "v1.2.3-rc1", "v1.2.3+meta", "1.2.3.4"} {
		if IsPlainVersion(s) {
			t.Errorf("IsPlainVersion(%q) = true, want false", s)
		}
	}
}
