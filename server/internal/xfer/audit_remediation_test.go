package xfer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Regressions for the 2026-09-13 audit findings AUD-01, AUD-05 and AUD-06.
//
// Each "must" test below fails on the audited baseline (78b3d2da5); the
// "protection" tests already passed there and exist so the fix cannot buy one
// property by losing another.

// ── shared drivers ──────────────────────────────────────────────────────────

// pipeTransfer runs a real Send against a real Receive over net.Pipe, which is
// what the CLI composes: the receiver's behaviour is exercised through the
// actual sender, not through a hand-built frame stream.
func pipeTransfer(t *testing.T, m Manifest, srcs []string, dst string, sopts SendOpts, ropts RecvOpts) (rep Report, sent int64, serr, rerr error) {
	t.Helper()
	cSend, cRecv := net.Pipe()
	deadline := time.Now().Add(10 * time.Second)
	cSend.SetDeadline(deadline)
	cRecv.SetDeadline(deadline)
	errc := make(chan error, 1)
	counted := &countingConn{Conn: cSend}
	go func() {
		_, err := Send(counted, m, srcs, sopts)
		cSend.Close()
		errc <- err
	}()
	rep, rerr = Receive(cRecv, dst, ropts)
	cRecv.Close()
	return rep, counted.n, <-errc, rerr
}

// countingConn counts the bytes the sender actually puts on the wire, which is
// the only honest way to tell "resumed from an offset" from "re-sent in full":
// Progress reports a cumulative position that ends at the file size either way.
type countingConn struct {
	net.Conn
	n int64
}

func (c *countingConn) Write(b []byte) (int, error) {
	n, err := c.Conn.Write(b)
	c.n += int64(n)
	return n, err
}

// scriptedPeer replays a fixed frame stream at the receiver and swallows
// whatever it writes back, so a transfer can be cut off at an exact point.
type scriptedPeer struct {
	io.Reader
	out bytes.Buffer
}

func (p *scriptedPeer) Write(b []byte) (int, error) { return p.out.Write(b) }

func stagingFiles(t *testing.T, dir string) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dir, ".relayium-recv-*"))
	if err != nil {
		t.Fatal(err)
	}
	return files
}

// oneFileSource writes body into a fresh directory and returns the manifest for
// that single file (manifest path "victim.txt").
func oneFileSource(t *testing.T, body string) (Manifest, []string) {
	t.Helper()
	src := filepath.Join(t.TempDir(), "victim.txt")
	if err := os.WriteFile(src, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := BuildManifest([]string{src})
	if err != nil {
		t.Fatal(err)
	}
	return m, srcs
}

// ── AUD-01: a peer's Hello.Sync must not grant replacement ──────────────────

// The receiving side of `receive` and `pull` never asked to replace anything.
// On the baseline the sender's own flag decided: Sync=true turned a one-shot
// receive into an overwrite of a file the receiving user already had.
func TestOneShotReceiveRefusesPeerRequestedReplacement(t *testing.T) {
	dst := t.TempDir()
	victim := filepath.Join(dst, "victim.txt")
	writeFileMtime(t, victim, "ORIGINAL-PERSONAL-DATA", 1000)
	before, err := os.Stat(victim)
	if err != nil {
		t.Fatal(err)
	}

	m, srcs := oneFileSource(t, "new")
	_, _, serr, rerr := pipeTransfer(t, m, srcs, dst, SendOpts{Sync: true}, RecvOpts{})

	if rerr == nil {
		t.Fatal("a receiver that never authorized replacement accepted the peer's Hello.Sync")
	}
	got, err := os.ReadFile(victim)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "ORIGINAL-PERSONAL-DATA" {
		t.Fatalf("the receiving user's file was replaced with %q by a sender-set flag", got)
	}
	after, err := os.Stat(victim)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Errorf("mtime changed (%v → %v); a refused transfer must not touch the file", before.ModTime(), after.ModTime())
	}
	if serr == nil {
		t.Error("the sender was not told the transfer was refused")
	}
	if len(stagingFiles(t, dst)) != 0 {
		t.Errorf("refused transfer left staging files: %v", stagingFiles(t, dst))
	}
}

// A peer's Hello.Sync must not create files either, when the receiver never
// authorized sync: the refusal is the whole transfer, not a per-file fallback.
func TestUnauthorizedSyncWritesNothingAtAll(t *testing.T) {
	dst := t.TempDir()
	m, srcs := oneFileSource(t, "new")
	_, _, _, rerr := pipeTransfer(t, m, srcs, dst, SendOpts{Sync: true}, RecvOpts{})
	if rerr == nil {
		t.Fatal("unauthorized sync was accepted")
	}
	entries, err := os.ReadDir(dst)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("a refused sync wrote %d entries into the destination", len(entries))
	}
}

// Protection: an ordinary (non-sync) push is unaffected by the new gate.
func TestOrdinaryPushStillLandsAndStillRefusesCollisions(t *testing.T) {
	dst := t.TempDir()
	m, srcs := oneFileSource(t, "fresh")
	if _, _, serr, rerr := pipeTransfer(t, m, srcs, dst, SendOpts{}, RecvOpts{}); serr != nil || rerr != nil {
		t.Fatalf("ordinary push: send=%v recv=%v", serr, rerr)
	}
	if got, _ := os.ReadFile(filepath.Join(dst, "victim.txt")); string(got) != "fresh" {
		t.Fatalf("ordinary push delivered %q", got)
	}
	_, _, _, rerr := pipeTransfer(t, m, srcs, dst, SendOpts{}, RecvOpts{})
	if rerr == nil || !strings.Contains(rerr.Error(), "destination already exists") {
		t.Fatalf("collision refusal changed: %v", rerr)
	}
}

// ── AUD-05: a destination that is not a prefix of the source ────────────────

// An ordinary edit that makes a file longer ("old" → "NEW-CONTENT") leaves the
// receiver holding a shorter file that is NOT a prefix of the new one. The
// baseline advertised it as a resume offset anyway, so verification failed and
// the stale copy survived — on every retry, forever.
func TestSyncCompletesWhenTheDestinationIsNotAPrefixOfTheSource(t *testing.T) {
	dst := t.TempDir()
	writeFileMtime(t, filepath.Join(dst, "victim.txt"), "old", 1000)
	m, srcs := oneFileSource(t, "NEW-CONTENT")

	rep, _, serr, rerr := pipeTransfer(t, m, srcs, dst, SendOpts{Sync: true}, RecvOpts{AllowSync: true})
	if serr != nil || rerr != nil {
		t.Fatalf("sync: send=%v recv=%v", serr, rerr)
	}
	if len(rep.Failed) != 0 {
		t.Fatalf("sync reported %v as failed; a changed, longer file must still sync", rep.Failed)
	}
	got, err := os.ReadFile(filepath.Join(dst, "victim.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "NEW-CONTENT" {
		t.Fatalf("destination is %q, want the source content", got)
	}
	if len(stagingFiles(t, dst)) != 0 {
		t.Errorf("recovery left staging files: %v", stagingFiles(t, dst))
	}
}

// Protection: a destination that IS a genuine prefix (an append-only file that
// grew) must still resume, i.e. put fewer bytes on the wire than a full send.
func TestSyncStillResumesAGenuinePrefix(t *testing.T) {
	full := bytes.Repeat([]byte("abcdefgh"), 8<<10) // 64 KiB
	m, srcs := oneFileSourceBytes(t, full)

	resumed := t.TempDir()
	writeFileMtime(t, filepath.Join(resumed, "victim.txt"), string(full[:48<<10]), 1000)
	repR, sentR, serr, rerr := pipeTransfer(t, m, srcs, resumed, SendOpts{Sync: true}, RecvOpts{AllowSync: true})
	if serr != nil || rerr != nil {
		t.Fatalf("resume: send=%v recv=%v", serr, rerr)
	}
	if len(repR.Failed) != 0 {
		t.Fatalf("resume reported failures: %v", repR.Failed)
	}
	if got, _ := os.ReadFile(filepath.Join(resumed, "victim.txt")); !bytes.Equal(got, full) {
		t.Fatalf("resumed file is %d bytes, want %d", len(got), len(full))
	}

	fresh := t.TempDir()
	_, sentF, serr, rerr := pipeTransfer(t, m, srcs, fresh, SendOpts{Sync: true}, RecvOpts{AllowSync: true})
	if serr != nil || rerr != nil {
		t.Fatalf("full send: send=%v recv=%v", serr, rerr)
	}
	if sentR >= sentF {
		t.Fatalf("resume put %d bytes on the wire and a full send %d: the matching prefix was not reused", sentR, sentF)
	}
}

func oneFileSourceBytes(t *testing.T, body []byte) (Manifest, []string) {
	t.Helper()
	src := filepath.Join(t.TempDir(), "victim.txt")
	if err := os.WriteFile(src, body, 0o600); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := BuildManifest([]string{src})
	if err != nil {
		t.Fatal(err)
	}
	return m, srcs
}

// ── AUD-06: staging must never outlive a failed transfer ────────────────────

// frameUpToBody replays hello/manifest/filestart plus the whole file body, so
// the receiver has written and fsynced a complete staging file and is waiting
// for the hash frame. What follows tail is whatever the test wants to happen
// next (nothing at all = EOF).
func frameUpToBody(t *testing.T, body string, sync bool, tail func(w io.Writer)) *scriptedPeer {
	t.Helper()
	var raw bytes.Buffer
	if err := WriteJSON(&raw, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: sync}); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(&raw, MsgManifest, Manifest{Files: []FileEntry{
		{Path: "victim.txt", Size: int64(len(body)), Mode: 0o644},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(&raw, MsgFileStart, FileStart{}); err != nil {
		t.Fatal(err)
	}
	raw.WriteString(body)
	if tail != nil {
		tail(&raw)
	}
	return &scriptedPeer{Reader: bytes.NewReader(raw.Bytes())}
}

// The body is written and fsynced, then the peer disappears before the hash
// frame. The baseline left the unverified content behind as .relayium-recv-*.
func TestStagingRemovedWhenTheHashFrameNeverArrives(t *testing.T) {
	dir := t.TempDir()
	if _, err := Receive(frameUpToBody(t, "secret", false, nil), dir, RecvOpts{}); err == nil {
		t.Fatal("expected the truncated stream to fail")
	}
	if left := stagingFiles(t, dir); len(left) != 0 {
		t.Fatalf("a failed transfer left unverified staging behind: %v", left)
	}
}

// Same exit, reached through a malformed hash frame rather than EOF.
func TestStagingRemovedWhenTheHashFrameIsMalformed(t *testing.T) {
	dir := t.TempDir()
	peer := frameUpToBody(t, "secret", false, func(w io.Writer) {
		if err := WriteFrame(w, MsgFileHash, []byte("{not json")); err != nil {
			t.Fatal(err)
		}
	})
	if _, err := Receive(peer, dir, RecvOpts{}); err == nil {
		t.Fatal("expected the malformed hash frame to fail")
	}
	if left := stagingFiles(t, dir); len(left) != 0 {
		t.Fatalf("a failed transfer left unverified staging behind: %v", left)
	}
}

// Protection: the verification-failure path already cleaned up, and must keep
// doing so while leaving the file the receiving user already had untouched.
func TestStagingRemovedWhenTheHashDoesNotMatch(t *testing.T) {
	dir := t.TempDir()
	victim := filepath.Join(dir, "victim.txt")
	writeFileMtime(t, victim, "ORIGINAL", 1000)
	peer := frameUpToBody(t, "secret", true, func(w io.Writer) {
		if err := WriteJSON(w, MsgFileHash, FileHash{SHA256: strings.Repeat("0", 64)}); err != nil {
			t.Fatal(err)
		}
	})
	rep, err := Receive(peer, dir, RecvOpts{AllowSync: true})
	if err != nil {
		t.Fatalf("receive: %v", err)
	}
	if len(rep.Failed) != 1 {
		t.Fatalf("Failed = %v, want the one mismatching file", rep.Failed)
	}
	if got, _ := os.ReadFile(victim); string(got) != "ORIGINAL" {
		t.Fatalf("a file that failed verification was installed anyway: %q", got)
	}
	if left := stagingFiles(t, dir); len(left) != 0 {
		t.Fatalf("verification failure left staging behind: %v", left)
	}
}

// Protection: success must not leave staging either.
func TestNoStagingLeftAfterASuccessfulTransfer(t *testing.T) {
	dir := t.TempDir()
	sum := sha256.Sum256([]byte("secret"))
	peer := frameUpToBody(t, "secret", false, func(w io.Writer) {
		if err := WriteJSON(w, MsgFileHash, FileHash{SHA256: hex.EncodeToString(sum[:])}); err != nil {
			t.Fatal(err)
		}
	})
	rep, err := Receive(peer, dir, RecvOpts{})
	if err != nil {
		t.Fatalf("receive: %v", err)
	}
	if rep.Files != 1 {
		t.Fatalf("Files = %d, want 1", rep.Files)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "victim.txt")); string(got) != "secret" {
		t.Fatalf("destination = %q", got)
	}
	if left := stagingFiles(t, dir); len(left) != 0 {
		t.Fatalf("successful transfer left staging behind: %v", left)
	}
}

// ── AUD-05 rolling upgrades: both mixed pairs, stated explicitly ────────────

// OLD SENDER → NEW RECEIVER. The sender cannot prove a prefix or restart a
// file, so it is never handed an offset: it sends the changed file whole. That
// costs bandwidth and fixes AUD-05 for this pair as soon as the RECEIVER is
// updated. Skipping an unchanged file merges no bytes and is unaffected.
func TestOldSenderIsGivenNoOffsetButStillSkipsUnchangedFiles(t *testing.T) {
	dst := t.TempDir()
	writeFileMtime(t, filepath.Join(dst, "a.txt"), "hello", 1000) // identical → skip
	writeFileMtime(t, filepath.Join(dst, "b.txt"), "old", 2000)   // shorter, NOT a prefix
	m := Manifest{Files: []FileEntry{
		{Path: "a.txt", Size: 5, Mode: 0o644, ModTime: 1000},
		{Path: "b.txt", Size: 11, Mode: 0o644, ModTime: 4000},
	}}
	const body = "NEW-CONTENT"

	c1, c2 := net.Pipe()
	deadline := time.Now().Add(10 * time.Second)
	c1.SetDeadline(deadline)
	c2.SetDeadline(deadline)
	type result struct {
		rep Report
		err error
	}
	resc := make(chan result, 1)
	go func() {
		rep, err := Receive(c2, dst, RecvOpts{AllowSync: true})
		c2.Close()
		resc <- result{rep, err}
	}()

	// Exactly what a pre-ResumeProof sender puts on the wire.
	mustWrite(t, c1, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true})
	mustWrite(t, c1, MsgManifest, m)
	var rs ResumeState
	if _, err := ReadJSON(c1, &rs); err != nil {
		t.Fatal(err)
	}
	if len(rs.Entries) != 0 {
		t.Fatalf("the receiver offered %+v to a sender that cannot prove a prefix", rs.Entries)
	}
	if rs.ResumeProof {
		t.Error("ResumeProof echoed to a sender that never announced it")
	}
	if len(rs.Skip) != 1 || rs.Skip[0] != 0 {
		t.Fatalf("Skip = %v, want [0]: an unchanged file must still be skipped", rs.Skip)
	}
	mustWrite(t, c1, MsgFileStart, FileStart{Index: 1, Offset: 0})
	if _, err := io.WriteString(c1, body); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(body))
	mustWrite(t, c1, MsgFileHash, FileHash{Index: 1, SHA256: hex.EncodeToString(sum[:])})
	var res Result
	if _, err := ReadJSON(c1, &res); err != nil {
		t.Fatal(err)
	}
	c1.Close()

	got := <-resc
	if got.err != nil {
		t.Fatalf("receive: %v", got.err)
	}
	if len(got.rep.Failed) != 0 {
		t.Fatalf("Failed = %v", got.rep.Failed)
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "b.txt")); string(b) != body {
		t.Fatalf("b.txt = %q, want %q", b, body)
	}
	if a, _ := os.ReadFile(filepath.Join(dst, "a.txt")); string(a) != "hello" {
		t.Fatalf("the skipped file changed: %q", a)
	}
}

// NEW SENDER → OLD RECEIVER. An old receiver rejects any offset it did not
// negotiate, so the sender must NOT unilaterally restart at 0; it keeps the
// negotiated offset, and must not block waiting for a verdict that will never
// come. AUD-05 therefore remains present in an un-updated receiver: the fix is
// receiver-side and is not claimed for binaries that do not carry it.
func TestNewSenderKeepsANegotiatedOffsetWhenTheReceiverCannotAnswer(t *testing.T) {
	full := []byte("0123456789")
	m, srcs := oneFileSourceBytes(t, full)

	c1, c2 := net.Pipe()
	deadline := time.Now().Add(10 * time.Second)
	c1.SetDeadline(deadline)
	c2.SetDeadline(deadline)
	serrc := make(chan error, 1)
	go func() {
		_, err := Send(c1, m, srcs, SendOpts{Sync: true})
		c1.Close()
		serrc <- err
	}()

	var hello Hello
	if _, err := ReadJSON(c2, &hello); err != nil {
		t.Fatal(err)
	}
	if !hello.ResumeProof {
		t.Fatal("a current sender must announce that it can prove a prefix and restart")
	}
	var seen Manifest
	if _, err := ReadJSON(c2, &seen); err != nil {
		t.Fatal(err)
	}
	// The old receiver's answer: an offset, and no ResumeProof echo.
	mustWrite(t, c2, MsgResume, ResumeState{Entries: []ResumeEntry{{Index: 0, Have: 4}}})

	var start FileStart
	if _, err := ReadJSON(c2, &start); err != nil {
		t.Fatal(err)
	}
	if start.Offset != 4 {
		t.Fatalf("FileStart.Offset = %d: the sender changed an offset this receiver never renegotiated, which an old receiver rejects outright", start.Offset)
	}
	if start.PrefixSHA256 != "" {
		t.Errorf("a proof was sent to a receiver that never announced it could check one: %q", start.PrefixSHA256)
	}
	// No verdict is written here, because an old receiver has none to write. The
	// sender must stream the tail rather than wait (a deadline failure below is
	// exactly the deadlock this asserts against).
	tail := make([]byte, 6)
	if _, err := io.ReadFull(c2, tail); err != nil {
		t.Fatalf("the sender did not stream the tail: %v", err)
	}
	if string(tail) != "456789" {
		t.Fatalf("tail = %q, want the bytes after the negotiated offset", tail)
	}
	var fh FileHash
	if _, err := ReadJSON(c2, &fh); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, c2, MsgResult, Result{OK: true})
	c2.Close()
	if serr := <-serrc; serr != nil {
		t.Fatalf("send against a receiver without the fix: %v", serr)
	}

	// The honest limitation, asserted rather than asserted-away: had that old
	// receiver held "XXXX" instead of the real prefix, the merge it performs
	// still would not match the hash the sender computed over the whole file.
	wrong := sha256.Sum256(append([]byte("XXXX"), tail...))
	if hex.EncodeToString(wrong[:]) == fh.SHA256 {
		t.Fatal("unreachable: a mismatching prefix cannot produce the source hash")
	}
}

// The verdict itself, on the wire: a proof that does not match this disk is
// answered Resume=false before any body byte is accepted.
func TestReceiverAnswersAMismatchingPrefixProofWithAFullResend(t *testing.T) {
	dst := t.TempDir()
	writeFileMtime(t, filepath.Join(dst, "victim.txt"), "old", 1000)
	const body = "NEW-CONTENT"
	m := Manifest{Files: []FileEntry{{Path: "victim.txt", Size: int64(len(body)), Mode: 0o644, ModTime: 4000}}}

	c1, c2 := net.Pipe()
	deadline := time.Now().Add(10 * time.Second)
	c1.SetDeadline(deadline)
	c2.SetDeadline(deadline)
	rerrc := make(chan error, 1)
	go func() {
		_, err := Receive(c2, dst, RecvOpts{AllowSync: true})
		c2.Close()
		rerrc <- err
	}()

	mustWrite(t, c1, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true, ResumeProof: true})
	mustWrite(t, c1, MsgManifest, m)
	var rs ResumeState
	if _, err := ReadJSON(c1, &rs); err != nil {
		t.Fatal(err)
	}
	if !rs.ResumeProof {
		t.Fatal("the receiver did not announce that it answers prefix proofs")
	}
	if len(rs.Entries) != 1 || rs.Entries[0].Have != 3 {
		t.Fatalf("Entries = %+v, want one offset of 3", rs.Entries)
	}
	// Claim a prefix this destination does not hold.
	bogus := sha256.Sum256([]byte("XYZ"))
	mustWrite(t, c1, MsgFileStart, FileStart{Index: 0, Offset: 3, PrefixSHA256: hex.EncodeToString(bogus[:])})
	var v ResumeVerdict
	typ, err := ReadJSON(c1, &v)
	if err != nil {
		t.Fatal(err)
	}
	if typ != MsgResumeVerdict {
		t.Fatalf("frame type %d, want MsgResumeVerdict", typ)
	}
	if v.Index != 0 || v.Resume {
		t.Fatalf("verdict = %+v, want a refusal to reuse those bytes", v)
	}
	// Now the file from 0, as the verdict asked.
	if _, err := io.WriteString(c1, body); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(body))
	mustWrite(t, c1, MsgFileHash, FileHash{Index: 0, SHA256: hex.EncodeToString(sum[:])})
	var res Result
	if _, err := ReadJSON(c1, &res); err != nil {
		t.Fatal(err)
	}
	c1.Close()
	if rerr := <-rerrc; rerr != nil {
		t.Fatalf("receive: %v", rerr)
	}
	if !res.OK {
		t.Fatalf("result = %+v", res)
	}
	if got, _ := os.ReadFile(filepath.Join(dst, "victim.txt")); string(got) != body {
		t.Fatalf("destination = %q, want %q", got, body)
	}
}

// A matching proof is answered Resume=true, so a real append-only resume is
// still a resume and not a silent full re-send.
func TestReceiverAcceptsAMatchingPrefixProof(t *testing.T) {
	dst := t.TempDir()
	writeFileMtime(t, filepath.Join(dst, "victim.txt"), "NEW", 1000)
	const body = "NEW-CONTENT"
	m := Manifest{Files: []FileEntry{{Path: "victim.txt", Size: int64(len(body)), Mode: 0o644, ModTime: 4000}}}

	c1, c2 := net.Pipe()
	deadline := time.Now().Add(10 * time.Second)
	c1.SetDeadline(deadline)
	c2.SetDeadline(deadline)
	rerrc := make(chan error, 1)
	go func() {
		_, err := Receive(c2, dst, RecvOpts{AllowSync: true})
		c2.Close()
		rerrc <- err
	}()

	mustWrite(t, c1, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true, ResumeProof: true})
	mustWrite(t, c1, MsgManifest, m)
	var rs ResumeState
	if _, err := ReadJSON(c1, &rs); err != nil {
		t.Fatal(err)
	}
	good := sha256.Sum256([]byte("NEW"))
	mustWrite(t, c1, MsgFileStart, FileStart{Index: 0, Offset: 3, PrefixSHA256: hex.EncodeToString(good[:])})
	var v ResumeVerdict
	if _, err := ReadJSON(c1, &v); err != nil {
		t.Fatal(err)
	}
	if !v.Resume {
		t.Fatal("a prefix that really is on disk was refused; resume would be dead")
	}
	if _, err := io.WriteString(c1, body[3:]); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(body))
	mustWrite(t, c1, MsgFileHash, FileHash{Index: 0, SHA256: hex.EncodeToString(sum[:])})
	var res Result
	if _, err := ReadJSON(c1, &res); err != nil {
		t.Fatal(err)
	}
	c1.Close()
	if rerr := <-rerrc; rerr != nil {
		t.Fatalf("receive: %v", rerr)
	}
	if got, _ := os.ReadFile(filepath.Join(dst, "victim.txt")); string(got) != body {
		t.Fatalf("destination = %q, want the resumed result %q", got, body)
	}
}

// writeFileBody refuses a symlinked destination, so the prefix check must not
// read through one either: it answers "not a prefix" and the file goes on to
// fail exactly as it did before, rather than hashing a file outside destDir.
func TestPrefixCheckNeverReadsThroughASymlink(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("SECRET"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "victim.txt")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	sum := sha256.Sum256([]byte("SECRET"))
	if prefixMatches(link, 6, hex.EncodeToString(sum[:])) {
		t.Fatal("the prefix check followed a symlink out of the destination")
	}
}

func mustWrite(t *testing.T, w io.Writer, typ MsgType, v any) {
	t.Helper()
	if err := WriteJSON(w, typ, v); err != nil {
		t.Fatal(err)
	}
}
