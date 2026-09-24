package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/relayium/relayium/internal/linkwire"
)

// Exercise real staging and installation, including names a Windows sender
// cannot create but a POSIX peer can announce. Never open the unsafe name on
// Windows: both the installed path and bytes must be the sanitized result.
func TestLinkSinkReservedDeviceNames(t *testing.T) {
	names := []string{"NUL", "con", "AuX.txt", "PRN", "COM1", "LPT9.log", "COM¹", "LPT².txt", "CONIN$", "CONOUT$", "NUL .txt"}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			dest := t.TempDir()
			want := name
			if runtime.GOOS == "windows" {
				want = "_" + name
			}
			meta := linkwire.FileMeta{Name: name, Size: 1}
			segs := sinkSegments(meta, 0)
			if len(segs) != 1 || segs[0] != want {
				t.Fatalf("segments = %q, want %q", segs, want)
			}
			// An existing sanitized destination must survive the collision.
			if err := os.WriteFile(filepath.Join(dest, want), []byte("keep"), 0600); err != nil {
				t.Fatal(err)
			}
			k, err := openLinkSink(dest, []linkwire.FileMeta{meta})
			if err != nil {
				t.Fatal(err)
			}
			defer k.close()
			sinkFill(t, k)
			if err := k.install(); err != nil {
				t.Fatal(err)
			}
			if k.rels[0] == want {
				t.Fatal("existing destination overwritten")
			}
			if got, err := os.ReadFile(filepath.Join(dest, k.rels[0])); err != nil || string(got) != "a" {
				t.Fatalf("received bytes = %q, %v", got, err)
			}
			if got, err := os.ReadFile(filepath.Join(dest, want)); err != nil || string(got) != "keep" {
				t.Fatalf("existing bytes = %q, %v", got, err)
			}
			sinkNoStaging(t, dest)
		})
	}
	t.Run("nested directory and ordinary lookalikes", func(t *testing.T) {
		for _, name := range []string{"NULL", "COM10", "LPT0", "console.txt", ".NUL"} {
			if got := sinkSegments(linkwire.FileMeta{Name: name}, 0); len(got) != 1 || got[0] != name {
				t.Fatalf("ordinary name %q changed to %q", name, got)
			}
		}
		dest := t.TempDir()
		k, err := openLinkSink(dest, []linkwire.FileMeta{sinkMeta("CON/NUL.txt")})
		if err != nil {
			t.Fatal(err)
		}
		defer k.close()
		sinkFill(t, k)
		if err := k.install(); err != nil {
			t.Fatal(err)
		}
		want := "CON/NUL.txt"
		if runtime.GOOS == "windows" {
			want = "_CON/_NUL.txt"
		}
		if k.rels[0] != want {
			t.Fatalf("path = %q, want %q", k.rels[0], want)
		}
		if got, err := os.ReadFile(filepath.Join(dest, filepath.FromSlash(want))); err != nil || string(got) != "a" {
			t.Fatalf("nested bytes = %q, %v", got, err)
		}
		sinkNoStaging(t, dest)
	})
}
