package account

// A keyed replay asked WITHOUT a body and WITHOUT "Expect: 100-continue" --
// what the origin sees when a recovery probe comes through a reverse proxy
// that answers Expect itself (nginx, request buffering off). The origin must
// answer from the key at once: net/http would otherwise try to drain up to
// 256 KiB of the unread body before writing the header, and the client never
// sends it. Real Routes, real SQLite, raw TCP (the quota harness).

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

// idemLoseAnswerN is idemLoseAnswer for an n-byte body.
func (h *quotaHarness) idemLoseAnswerN(key string, n int) string {
	h.t.Helper()
	h.hook.arm(qpPersistAfter)
	conn, _ := h.idemSend(h.cookie, "POST", "/api/files?ttl=7200", quotaSingleBody(n),
		map[string]string{"Idempotency-Key": key})
	select {
	case <-h.hook.entered:
	case d := <-h.done:
		h.t.Fatalf("handler returned %d before committing", d.code)
	case <-time.After(20 * time.Second):
		h.t.Fatal("never committed")
	}
	_ = conn.Close()
	h.hook.open()
	h.waitDone("POST", "/api/files")
	var id string
	if err := h.store.db.QueryRow(`SELECT id FROM stored_files WHERE user_id=?`, h.userID).Scan(&id); err != nil {
		h.t.Fatalf("the lost answer's object: %v", err)
	}
	return id
}

// headOnly sends the request head of a keyed upload -- Content-Length of an
// n-byte upload body, NO Expect -- and never the body. It returns the answer,
// failing if none arrives within the bound.
func (h *quotaHarness) headOnly(key, query string, n int) (idemResp, http.Header) {
	h.t.Helper()
	conn, err := net.Dial("tcp", h.ts.Listener.Addr().String())
	if err != nil {
		h.t.Fatal(err)
	}
	defer conn.Close()
	head := fmt.Sprintf("POST /api/files%s HTTP/1.1\r\nHost: example.test\r\nCookie: %s=%s\r\n"+
		"Content-Length: %d\r\nIdempotency-Key: %s\r\n\r\n",
		query, h.cookie.Name, h.cookie.Value, len(quotaSingleBody(n)), key)
	if _, err := io.WriteString(conn, head); err != nil {
		h.t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", h.ts.URL+"/api/files"+query, nil)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	start := time.Now()
	r, hdr, err := idemReadHeader(conn, req)
	if err != nil {
		h.t.Fatalf("no answer to a body-less keyed request within %s (n=%d): %v -- the origin waited to drain a body that never comes", time.Since(start).Round(time.Millisecond), n, err)
	}
	h.waitDone("POST", "/api/files")
	return r, hdr
}

// idemReadHeader is idemRead that also returns the response headers.
func idemReadHeader(conn net.Conn, req *http.Request) (idemResp, http.Header, error) {
	resp, err := http.ReadResponse(bufio.NewReader(conn), req)
	if err != nil {
		return idemResp{}, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	out := idemResp{code: resp.StatusCode, replay: resp.Header.Get("Idempotent-Replay"), text: string(b)}
	_ = json.Unmarshal(b, &out.body)
	// ReadResponse turns "Connection: close" into resp.Close and drops the
	// header; put it back so callers can assert on it.
	hdr := resp.Header.Clone()
	if resp.Close {
		hdr.Set("Connection", "close")
	}
	return out, hdr, nil
}

func TestUploadReplayWithoutBodyOrExpectIsAnsweredAtOnce(t *testing.T) {
	for _, n := range []int{0, 1, 900, 200 << 10} {
		t.Run(fmt.Sprintf("body_%d", n), func(t *testing.T) {
			h := newQuotaHarness(t, quotaOpts{})
			key := fmt.Sprintf("nobody-key-%06d-0123456789", n)
			id := h.idemLoseAnswerN(key, n)
			before := h.assertOneDebitPerObject("lost answer")
			ops := h.opRows()

			r, hdr := h.headOnly(key, "?ttl=7200", n)
			if r.code != http.StatusOK || r.id() != id || r.replay != "true" {
				t.Fatalf("replay: %d %q replay=%q, want 200 id=%s", r.code, r.text, r.replay, id)
			}
			if hdr.Get("Connection") != "close" {
				t.Fatalf("replay answered without Connection: close (%q)", hdr.Get("Connection"))
			}
			after := h.assertOneDebitPerObject("after replay")
			if after != before || h.opRows() != ops {
				t.Fatalf("a body-less replay changed the ledger: %+v -> %+v (ops %d -> %d)", before, after, ops, h.opRows())
			}
		})
	}
}

// The other definite answers (422 different request, 410 gone) are equally
// immediate; a request the key does NOT answer keeps its normal behaviour.
func TestUploadKeyedRefusalsWithoutBodyAreAnsweredAtOnce(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	key := "nobody-refusal-0123456789abc"
	id := h.idemLoseAnswerN(key, 900)

	r, hdr := h.headOnly(key, "?ttl=60", 900) // different retention: different request
	if r.code != http.StatusUnprocessableEntity || hdr.Get("Connection") != "close" {
		t.Fatalf("conflict: %d %q conn=%q", r.code, r.text, hdr.Get("Connection"))
	}
	if _, err := h.store.db.Exec(`UPDATE stored_files SET expires_at = 1 WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	r, hdr = h.headOnly(key, "?ttl=7200", 900)
	if r.code != http.StatusGone || hdr.Get("Connection") != "close" {
		t.Fatalf("gone: %d %q conn=%q", r.code, r.text, hdr.Get("Connection"))
	}
	// An unkeyed, ordinary upload is untouched by this: it still succeeds and
	// its connection is not forced closed.
	fresh := h.upload("", "?ttl=7200", 900)
	if fresh.code != http.StatusOK {
		t.Fatalf("ordinary upload: %d %q", fresh.code, fresh.text)
	}
}
