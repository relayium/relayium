package xfer

import (
	"bytes"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLargeSyncValidatesAcrossPagesBeforeWrites(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "destination")
	count := maxManifestFiles + 1
	manifest := Manifest{Files: make([]FileEntry, count)}
	for i := range manifest.Files {
		manifest.Files[i] = FileEntry{Path: fmt.Sprintf("file-%04d", i), SHA256: strings.Repeat("0", 64)}
	}
	manifest.Files[count-1] = manifest.Files[0]

	client, server := net.Pipe()
	defer client.Close()
	done := make(chan error, 1)
	go func() {
		defer server.Close()
		_, err := Receive(server, dest, RecvOpts{AllowSync: true, CreateDestDir: true})
		done <- err
	}()

	if err := preflight(client, SendOpts{}, true); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(client, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true, ContentCheck: true, ManifestFiles: count}); err != nil {
		t.Fatal(err)
	}
	if err := writeManifestPages(client, manifest); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil || !strings.Contains(err.Error(), "duplicate destination") {
		t.Fatalf("received %v, want a duplicate-path refusal", err)
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatalf("destination was touched before manifest validation: %v", err)
	}
}

func TestLargeSyncRejectsInvalidManifestPage(t *testing.T) {
	for _, payload := range []string{
		`{"Files":[]}`,
		`[]`,
		`[{"Path":"a"},{"Path":"b"}]`,
		`[{"Path":"a"}] []`,
	} {
		if err := decodeManifestPage([]byte(payload), make([]FileEntry, 1)); err == nil {
			t.Fatalf("accepted invalid page %s", payload)
		}
	}
	var wire bytes.Buffer
	if err := WriteJSON(&wire, MsgManifest, Manifest{}); err != nil {
		t.Fatal(err)
	}
	if _, err := readManifestPages(&wire, maxManifestFiles+1); err == nil || !strings.Contains(err.Error(), "expected manifest page") {
		t.Fatalf("expected wrong frame refusal, got %v", err)
	}
	if _, err := readManifestPages(&wire, MaxSyncFiles+1); err == nil {
		t.Fatal("accepted a count above the large-sync limit")
	}
}

func TestLargeSyncRoundTripsMaximumFileCount(t *testing.T) {
	m := Manifest{Files: make([]FileEntry, MaxSyncFiles)}
	digest := strings.Repeat("0", 64)
	for i := range m.Files {
		m.Files[i] = FileEntry{Path: fmt.Sprintf("root/%06d", i), Size: int64(i), SHA256: digest}
	}
	var wire bytes.Buffer
	if err := writeManifestPages(&wire, m); err != nil {
		t.Fatal(err)
	}
	got, err := readManifestPages(&wire, len(m.Files))
	if err != nil {
		t.Fatal(err)
	}
	if wire.Len() != 0 || len(got.Files) != len(m.Files) {
		t.Fatalf("decoded %d entries with %d bytes remaining", len(got.Files), wire.Len())
	}
	for i := range m.Files {
		if got.Files[i] != m.Files[i] {
			t.Fatalf("entry %d = %+v, want %+v", i, got.Files[i], m.Files[i])
		}
	}
}
