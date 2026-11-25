package xfer

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// MaxSyncFiles bounds the full index kept in memory for one large sync.
// The separate encoded-byte limit also bounds directories with long paths.
const MaxSyncFiles = 100_000

// NeedsPagedSync reports whether a directory exceeds the classic wire format.
func NeedsPagedSync(fileCount int) bool {
	return fileCount > maxManifestFiles
}

const (
	// Even 256 paths of 4096 bytes, each requiring six bytes of JSON escaping,
	// fit in a control frame with room for the rest of the file entries.
	manifestPageFiles     = 256
	maxPagedManifestBytes = 32 << 20
)

var ErrLargeSyncUnsupported = errors.New("the receiver does not support large directory sync; update Relayium on the receiver or sync smaller directories")

func writeManifestPages(w io.Writer, m Manifest) error {
	remainingBytes := maxPagedManifestBytes
	for start := 0; start < len(m.Files); start += manifestPageFiles {
		end := min(start+manifestPageFiles, len(m.Files))
		for i, f := range m.Files[start:end] {
			if f.Path == "" || len(f.Path) > maxManifestPathBytes {
				return fmt.Errorf("invalid manifest path at index %d", start+i)
			}
		}
		payload, err := json.Marshal(m.Files[start:end])
		if err != nil {
			return err
		}
		if len(payload) > remainingBytes {
			return fmt.Errorf("%w: directory index exceeds %d MiB; sync smaller directories", errManifestTooLarge, maxPagedManifestBytes>>20)
		}
		remainingBytes -= len(payload)
		if err := WriteFrame(w, MsgManifestPage, payload); err != nil {
			return err
		}
	}
	return nil
}

func readManifestPages(r io.Reader, count int) (Manifest, error) {
	if count <= maxManifestFiles || count > MaxSyncFiles {
		return Manifest{}, fmt.Errorf("%w: invalid large sync count %d (allowed %d–%d)", errManifestTooLarge, count, maxManifestFiles+1, MaxSyncFiles)
	}
	m := Manifest{Files: make([]FileEntry, 0, count)}
	remainingBytes := maxPagedManifestBytes
	for len(m.Files) < count {
		t, payload, err := ReadFrame(r)
		if err != nil {
			return Manifest{}, err
		}
		if t != MsgManifestPage {
			return Manifest{}, fmt.Errorf("expected manifest page, got frame type %d", t)
		}
		if len(payload) > remainingBytes {
			return Manifest{}, fmt.Errorf("%w: directory index exceeds %d MiB", errManifestTooLarge, maxPagedManifestBytes>>20)
		}
		remainingBytes -= len(payload)
		start := len(m.Files)
		m.Files = m.Files[:min(start+manifestPageFiles, count)]
		if err := decodeManifestPage(payload, m.Files[start:]); err != nil {
			return Manifest{}, err
		}
	}
	return m, nil
}

// Decode exactly the negotiated number of entries. Unmarshaling straight
// into a slice would let one small frame allocate an arbitrary entry count.
func decodeManifestPage(payload []byte, page []FileEntry) error {
	dec := json.NewDecoder(bytes.NewReader(payload))
	open, err := dec.Token()
	if err != nil || open != json.Delim('[') {
		return errors.New("manifest page must be a JSON array")
	}
	for i := range page {
		if err := dec.Decode(&page[i]); err != nil {
			return fmt.Errorf("invalid manifest page entry %d: %w", i, err)
		}
	}
	close, err := dec.Token()
	if err != nil || close != json.Delim(']') {
		return errors.New("manifest page contains extra entries or is incomplete")
	}
	if _, err := dec.Token(); err != io.EOF {
		return errors.New("unexpected data after manifest page")
	}
	return nil
}
