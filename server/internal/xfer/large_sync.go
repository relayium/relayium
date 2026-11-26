package xfer

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"path"
	"strings"
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

// SyncBatches returns exclusive end offsets for the existing wire manifest
// limits. Reserve the real digest width so planning never opens a source file.
func SyncBatches(m Manifest) ([]int, error) {
	start, used, total := 0, 0, int64(0)
	var ends []int
	digest := strings.Repeat("0", sha256.Size*2)
	var classicSizes []int
	for i, entry := range m.Files {
		if err := validateSyncEntry(entry, total, i); err != nil {
			return nil, err
		}
		total += entry.Size
		entry.SHA256 = digest
		body, err := json.Marshal(entry)
		if err != nil {
			return nil, err
		}
		// One comma per entry plus one extra byte per page covers the
		// surrounding brackets. A partial page counts in the budget too.
		n := len(body) + 1
		if (i-start)%manifestPageFiles == 0 {
			n++
		}
		if i-start == MaxSyncFiles || n > maxPagedManifestBytes-used {
			ends = appendSyncBatch(ends, start, i, classicSizes)
			start, used = i, 0
			n = len(body) + 2
			classicSizes = classicSizes[:0]
		}
		if i-start < maxManifestFiles {
			classicSizes = append(classicSizes, len(body)+1)
		}
		used += n
	}
	return appendSyncBatch(ends, start, len(m.Files), classicSizes), nil
}

func appendSyncBatch(ends []int, start, end int, classicSizes []int) []int {
	if end-start <= maxManifestFiles {
		// A short batch is sent in one control frame. Reserve the manifest
		// envelope, including the surrounding brackets and the Files key.
		used := 32
		for i, size := range classicSizes {
			if size > maxFramePayload-used {
				ends = append(ends, start+i)
				used = 32
			}
			used += size
		}
	}
	return append(ends, end)
}

func validateSyncEntry(f FileEntry, total int64, index int) error {
	if f.Path == "" || len(f.Path) > maxManifestPathBytes {
		return fmt.Errorf("invalid manifest path at index %d", index)
	}
	if f.Size < 0 || total > math.MaxInt64-f.Size {
		return fmt.Errorf("invalid manifest size at index %d", index)
	}
	return nil
}

// ValidateBatchedSync checks all batches together, before the first write.
// The conservative folded comparison protects case-insensitive destinations
// even when the sender or an older receiver cannot report filesystem behavior.
func ValidateBatchedSync(m Manifest) error {
	seen := make(map[string]struct{}, len(m.Files))
	for _, f := range m.Files {
		key := strings.ToLower(path.Clean(f.Path))
		if _, ok := seen[key]; ok {
			return fmt.Errorf("duplicate destination across sync batches: %q", f.Path)
		}
		seen[key] = struct{}{}
	}
	for key := range seen {
		for parent := path.Dir(key); parent != "." && parent != "/"; parent = path.Dir(parent) {
			if _, ok := seen[parent]; ok {
				return fmt.Errorf("sync destination is both a file and a parent: %q", parent)
			}
		}
	}
	return nil
}

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
