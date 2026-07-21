package account

import (
	"bytes"
	"net/http"
	"testing"
)

// A single PATCH must not commit more than maxAppendBytes past the committed
// offset. That bound is what caps the finalize-vs-in-flight-append race: without
// it a lone slow-drip PATCH could write the whole remaining budget (~MaxSize)
// after finalize billed the smaller committed size. We shrink the bound so tiny
// payloads exercise it (production keeps it at 16 MiB, above any real chunk).
func TestUploadChunkBoundedPerRequest(t *testing.T) {
	orig := maxAppendBytes
	maxAppendBytes = 100
	t.Cleanup(func() { maxAppendBytes = orig })

	ts, _, _, mail := newFileServer(t) // MaxFileSize=1024, so the per-append bound binds first
	cookie := loginCookie(t, ts, mail, "cap@example.com")

	blob := bytes.Repeat([]byte("Z"), 900)
	uploadID := initUpload(t, ts, cookie, []byte("M"), len(blob), 0)

	// A PATCH offering 300 bytes commits at most maxAppendBytes (100) — the excess
	// is not read, so the append can't drip more than one bound past the offset.
	// The client just resumes from the returned offset.
	if code, recv := patchChunk(t, ts, cookie, uploadID, blob, 0, 300, len(blob)); code != 200 || recv != 100 {
		t.Fatalf("over-bound chunk must truncate to the cap: code=%d received=%d, want 200/100", code, recv)
	}
	// Resume from the bound and finish in further bounded steps.
	if code, recv := patchChunk(t, ts, cookie, uploadID, blob, 100, 300, len(blob)); code != 200 || recv != 200 {
		t.Fatalf("resume chunk: code=%d received=%d, want 200/200", code, recv)
	}

	// The whole-file MaxSize (1024) is still enforced as a 413, not silently
	// truncated away by the per-append bound.
	big := bytes.Repeat([]byte("Z"), 2000)
	bigID := initUpload(t, ts, cookie, []byte("M"), 1024, 0)
	// Walk up to the cap in bound-sized steps, then the step that would exceed
	// MaxSize must 413.
	var off int
	for off = 0; off+100 <= 1024; off += 100 {
		if code, _ := patchChunk(t, ts, cookie, bigID, big, off, off+100, 2000); code != 200 {
			t.Fatalf("chunk at %d: code=%d, want 200", off, code)
		}
	}
	if code, _ := patchChunk(t, ts, cookie, bigID, big, off, off+100, 2000); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("chunk past MaxSize: code=%d, want 413", code)
	}
}
