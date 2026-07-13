package account

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

// initUpload starts a chunked upload and returns its uploadId.
func initUpload(t *testing.T, ts *httptest.Server, cookie *http.Cookie, encManifest []byte, size, ttl int) string {
	t.Helper()
	var body bytes.Buffer
	_ = binary.Write(&body, binary.BigEndian, uint32(len(encManifest)))
	body.Write(encManifest)
	req, _ := http.NewRequest("POST", ts.URL+"/api/uploads?ttl="+strconv.Itoa(ttl)+"&size="+strconv.Itoa(size), &body)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("init: %d %s", resp.StatusCode, b)
	}
	var out struct {
		UploadID  string `json:"uploadId"`
		ChunkSize int    `json:"chunkSize"`
	}
	decodeJSON(t, resp, &out)
	if out.UploadID == "" || out.ChunkSize == 0 {
		t.Fatalf("bad init response: %+v", out)
	}
	return out.UploadID
}

// patchChunk PATCHes blob[start:end] and returns (status, received).
func patchChunk(t *testing.T, ts *httptest.Server, cookie *http.Cookie, uploadID string, blob []byte, start, end, total int) (int, int64) {
	t.Helper()
	req, _ := http.NewRequest("PATCH", ts.URL+"/api/uploads/"+uploadID, bytes.NewReader(blob[start:end]))
	req.AddCookie(cookie)
	req.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end-1, total))
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Received int64 `json:"received"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out.Received
}

func TestResumableUploadRoundTrip(t *testing.T) {
	ts, _, _, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "up@example.com")

	encManifest := []byte("MANIFEST-BYTES")
	blob := bytes.Repeat([]byte("Z"), 900) // under MaxFileSize=1024
	uploadID := initUpload(t, ts, cookie, encManifest, len(blob), 0)

	for _, r := range [][2]int{{0, 300}, {300, 600}, {600, 900}} {
		code, received := patchChunk(t, ts, cookie, uploadID, blob, r[0], r[1], len(blob))
		if code != 200 || received != int64(r[1]) {
			t.Fatalf("chunk %v: code=%d received=%d", r, code, received)
		}
	}

	freq, _ := http.NewRequest("POST", ts.URL+"/api/uploads/"+uploadID+"/finalize", nil)
	freq.AddCookie(cookie)
	fresp, _ := ts.Client().Do(freq)
	if fresp.StatusCode != 200 {
		b, _ := io.ReadAll(fresp.Body)
		t.Fatalf("finalize: %d %s", fresp.StatusCode, b)
	}
	var fin struct {
		ID string `json:"id"`
	}
	decodeJSON(t, fresp, &fin)

	// The finalized file round-trips through /meta and /blob.
	mresp, _ := ts.Client().Get(ts.URL + "/api/files/" + fin.ID + "/meta")
	var meta struct {
		Size int64 `json:"size"`
	}
	decodeJSON(t, mresp, &meta)
	if meta.Size != int64(len(blob)) {
		t.Fatalf("meta size = %d, want %d", meta.Size, len(blob))
	}
	bresp, _ := ts.Client().Get(ts.URL + "/api/files/" + fin.ID + "/blob")
	got, _ := io.ReadAll(bresp.Body)
	bresp.Body.Close()
	if !bytes.Equal(got, blob) {
		t.Fatalf("assembled blob mismatch: %d vs %d bytes", len(got), len(blob))
	}
}

func TestResumableUploadResume(t *testing.T) {
	ts, _, _, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "resume@example.com")

	blob := bytes.Repeat([]byte("Q"), 900)
	uploadID := initUpload(t, ts, cookie, []byte("M"), len(blob), 0)

	// Two chunks land, then we "lose the ack" and re-check the offset.
	patchChunk(t, ts, cookie, uploadID, blob, 0, 300, len(blob))
	patchChunk(t, ts, cookie, uploadID, blob, 300, 600, len(blob))

	sresp, _ := func() (*http.Response, error) {
		req, _ := http.NewRequest("GET", ts.URL+"/api/uploads/"+uploadID, nil)
		req.AddCookie(cookie)
		return ts.Client().Do(req)
	}()
	var st struct {
		Received int64 `json:"received"`
	}
	decodeJSON(t, sresp, &st)
	if st.Received != 600 {
		t.Fatalf("status received = %d, want 600", st.Received)
	}

	// Re-sending an already-received chunk is idempotent (acks current offset).
	if code, received := patchChunk(t, ts, cookie, uploadID, blob, 0, 300, len(blob)); code != 200 || received != 600 {
		t.Fatalf("idempotent resend: code=%d received=%d, want 200/600", code, received)
	}
	// A gap (start past the offset) is refused with the real offset.
	if code, received := patchChunk(t, ts, cookie, uploadID, blob, 700, 900, len(blob)); code != http.StatusConflict || received != 600 {
		t.Fatalf("gap: code=%d received=%d, want 409/600", code, received)
	}
	// Continue correctly and finish.
	if code, received := patchChunk(t, ts, cookie, uploadID, blob, 600, 900, len(blob)); code != 200 || received != 900 {
		t.Fatalf("resume tail: code=%d received=%d", code, received)
	}
}

func TestResumableUploadOwnershipAndCap(t *testing.T) {
	ts, svc, _, mail := newFileServer(t)
	cookieA := loginCookie(t, ts, mail, "a@example.com")
	cookieB := loginCookie(t, ts, mail, "b@example.com")

	blob := bytes.Repeat([]byte("A"), 900)
	uploadID := initUpload(t, ts, cookieA, []byte("M"), len(blob), 0)

	// Another user cannot touch A's upload → 404.
	req, _ := http.NewRequest("GET", ts.URL+"/api/uploads/"+uploadID, nil)
	req.AddCookie(cookieB)
	r, _ := ts.Client().Do(req)
	r.Body.Close()
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("foreign access: %d, want 404", r.StatusCode)
	}

	// Cumulative MaxFileSize (1024) enforced across chunks → 413 on overflow.
	big := bytes.Repeat([]byte("B"), 2000)
	up2 := initUpload(t, ts, cookieA, []byte("M"), len(big), 0)
	patchChunk(t, ts, cookieA, up2, big, 0, 800, len(big))
	if code, _ := patchChunk(t, ts, cookieA, up2, big, 800, 1600, len(big)); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("cumulative cap: code=%d, want 413", code)
	}

	// The reaper drops an abandoned session (and its blob): afterwards the
	// uploadId is unknown → 404.
	svc.ReapPendingUploads(svc.now().Unix() + pendingUploadTTL + 1)
	req2, _ := http.NewRequest("GET", ts.URL+"/api/uploads/"+uploadID, nil)
	req2.AddCookie(cookieA)
	r2, _ := ts.Client().Do(req2)
	r2.Body.Close()
	if r2.StatusCode != http.StatusNotFound {
		t.Fatalf("after reap: %d, want 404", r2.StatusCode)
	}
}
