package linksession

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/linkwire"
)

func lastDo(m *Machine) []string { return m.Trace[len(m.Trace)-1].Do }

func sent(m *Machine, action string) int {
	n := 0
	for _, st := range m.Trace {
		if has(st.Do, action) {
			n++
		}
	}
	return n
}

func accept(t *testing.T, l *loop, e *end) {
	t.Helper()
	if err := l.on(e)(e.s.AcceptFiles(lastPrompt(e.effs, EffPromptFiles))); err != nil {
		t.Fatalf("%s accept: %v", e.name, err)
	}
}

func wantStates(t *testing.T, e *end, file, text string) {
	t.Helper()
	_, _, f, x := e.s.States()
	if (file != "" && f != file) || (text != "" && x != text) {
		t.Fatalf("%s: file=%s text=%s, want file=%s text=%s\n%s", e.name, f, x, file, text, kinds(e.effs))
	}
}

// ---------------------------------------------------------------- many files and texts, both directions

// Many files and texts, both directions, within one pairing session, with a
// cancel and a retry in the middle. The codecs are the SAME objects from the
// first frame to the last (link §5.5): no batch, conversation or cancel ever
// constructs one, and every sequence keeps counting.
func TestMultiBatchMultiTextBothDirections(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	a, b := l.a, l.b
	ftx, frx, ttx, trx := a.s.lk.fileTx, a.s.lk.fileRx, a.s.lk.textTx, a.s.lk.textRx

	// batch 1, a -> b: a multi-chunk file, an empty file, a tiny file
	p1 := [][]byte{payload(3*linkwire.ChunkSize+17, 1), payload(0, 2), payload(5, 3)}
	l.sendBatch(a, p1...)
	wantStates(t, b, "InPrompt", "")
	accept(t, l, b)
	l.pushData(a, p1...)
	wantStates(t, a, "Idle", "")
	wantStates(t, b, "Idle", "")
	pr := lastPrompt(b.effs, EffPromptFiles)
	for i, p := range p1 {
		if !sameBytes(b.written[pr][i], p) {
			t.Fatalf("batch1 file %d differs", i)
		}
	}
	if !hasReport(a.effs, "delivered-and-verified") || !hasReport(b.effs, "saved(verified,durable)") {
		t.Fatal("batch 1 not reported delivered/saved")
	}

	// batch 2, b -> a
	p2 := [][]byte{payload(700000, 9)}
	l.sendBatch(b, p2...)
	accept(t, l, a)
	l.pushData(b, p2...)
	if !sameBytes(a.written[lastPrompt(a.effs, EffPromptFiles)][0], p2[0]) {
		t.Fatal("batch 2 differs")
	}

	// conversation 1, a asks; pair auto-accepts text; both send; a ends
	l.on(a)(a.s.RequestText())
	wantStates(t, a, "", "Open")
	wantStates(t, b, "", "Open")
	l.on(a)(a.s.SendText([]byte("hello"), 0))
	l.on(b)(b.s.SendText([]byte("héllo \U0001F30D\n  "), 0))
	l.on(a)(a.s.SendText([]byte(""), 0))
	l.on(a)(a.s.EndText())
	wantStates(t, a, "", "Idle")
	wantStates(t, b, "", "Idle")
	if strings.Join(b.texts, "|") != "hello|" || strings.Join(a.texts, "|") != "héllo \U0001F30D\n  " {
		t.Fatalf("texts a=%q b=%q", a.texts, b.texts)
	}

	// batch 3, a -> b, cancelled mid-send, then retried on the same link
	p3 := [][]byte{payload(2*linkwire.ChunkSize, 4)}
	l.sendBatch(a, p3...)
	accept(t, l, b)
	cancelledPrompt := lastPrompt(b.effs, EffPromptFiles)
	l.on(a)(a.s.SendChunk(p3[0][:linkwire.ChunkSize]))
	l.on(a)(a.s.CancelOutgoing())
	wantStates(t, a, "Idle", "")
	wantStates(t, b, "Idle", "")
	if count(b.effs, EffDiscardPartial, -1) != 1 || !hasReport(b.effs, "sender-cancelled") {
		t.Fatalf("cancel not discarded truthfully: %s", kinds(b.effs))
	}
	l.sendBatch(a, p3...)
	accept(t, l, b)
	l.pushData(a, p3...)
	retry := lastPrompt(b.effs, EffPromptFiles)
	if retry == cancelledPrompt || !sameBytes(b.written[retry][0], p3[0]) {
		t.Fatal("retry after cancel not delivered on the same link")
	}

	// conversation 2, b asks this time
	l.on(b)(b.s.RequestText())
	l.on(b)(b.s.SendText([]byte("second"), 0))
	l.on(b)(b.s.EndText())
	if a.texts[len(a.texts)-1] != "second" {
		t.Fatalf("second conversation: %q", a.texts)
	}

	if a.s.lk.fileTx != ftx || a.s.lk.fileRx != frx || a.s.lk.textTx != ttx || a.s.lk.textRx != trx {
		t.Fatal("a codec was reconstructed while the link was open")
	}
	if a.s.linkM.State != LOpen || !a.s.lk.alive() || sent(a.s.linkM, ADestroy) != 0 {
		t.Fatal("link or keys disturbed")
	}
	if a.s.lk.fileTx.NextSeq() != b.s.lk.fileRx.ExpectedSeq() || b.s.lk.fileTx.NextSeq() != a.s.lk.fileRx.ExpectedSeq() ||
		a.s.lk.textTx.NextSeq() != b.s.lk.textRx.ExpectedSeq() {
		t.Fatal("sequences out of step")
	}
	t.Logf("a file seq %d, b file seq %d, a text seq %d, b text seq %d; one link, codecs retained",
		a.s.lk.fileTx.NextSeq(), b.s.lk.fileTx.NextSeq(), a.s.lk.textTx.NextSeq(), b.s.lk.textTx.NextSeq())
}

// ---------------------------------------------------------------- admission != authorisation

func TestAdmissionIsNotAuthorisation(t *testing.T) {
	// pair --verify on a: nothing consented before the SAS is confirmed, and
	// confirming the SAS does not accept a prompted batch.
	l := newLoop(t, CmdPair, CmdPair, true, false)
	l.start()
	a, b := l.a, l.b
	if a.s.Admission() != AdmPendingSAS || b.s.Admission() != AdmAdmitted {
		t.Fatalf("admission a=%d b=%d", a.s.Admission(), b.s.Admission())
	}
	if a.s.SAS() == "" || a.s.SAS() != b.s.SAS() {
		t.Fatal("SAS not derived identically")
	}
	if err := l.on(a)(a.s.OfferFiles([]linkwire.FileMeta{{Name: "x", Size: 1}})); !errors.Is(err, ErrNotAdmitted) {
		t.Fatalf("unadmitted side offered: %v", err)
	}
	l.sendBatch(b, payload(10, 1))
	l.on(b)(b.s.RequestText())
	p := lastPrompt(a.effs, EffPromptFiles)
	if err := l.on(a)(a.s.AcceptFiles(p)); !errors.Is(err, ErrNotAdmitted) {
		t.Fatalf("accepted before admission: %v", err)
	}
	wantStates(t, a, "InPrompt", "Incoming")
	if count(a.effs, EffSendFile, int(linkwire.CtrlAccept)) != 0 || count(a.effs, EffSendText, int(linkwire.CtrlAccept)) != 0 {
		t.Fatal("consent byte left before admission")
	}
	l.on(a)(a.s.ConfirmSAS(true))
	wantStates(t, a, "InPrompt", "Open") // text auto-accepted for pair once admitted; files still asked
	accept(t, l, a)
	l.pushData(b, payload(10, 1))
	wantStates(t, a, "Idle", "")

	// receive <code>: AutoOnce, still waits for the SAS, and only once
	r := newLoop(t, CmdReceive, CmdPair, true, false)
	r.start()
	r.sendBatch(r.b, payload(10, 1))
	wantStates(t, r.a, "InPrompt", "")
	if count(r.a.effs, EffPromptFiles, -1) != 0 {
		t.Fatal("receive <code> must not prompt")
	}
	r.on(r.a)(r.a.s.ConfirmSAS(true))
	wantStates(t, r.a, "InRecv", "")
	r.pushData(r.b, payload(10, 1))
	wantStates(t, r.a, "Idle", "")
	r.sendBatch(r.b, payload(20, 2))
	wantStates(t, r.a, "Idle", "")
	if count(r.a.effs, EffSendFile, int(linkwire.CtrlReject)) != 1 || !hasReport(r.b.effs, "declined") {
		t.Fatal("receive accepted a second batch")
	}
	if err := r.on(r.a)(r.a.s.AcceptFiles(1)); !errors.Is(err, ErrNotAuthorised) {
		t.Fatalf("receive accepted interactively: %v", err)
	}

	// SAS rejected: prompt rejected, leave sent, keys destroyed, peer ends too
	x := newLoop(t, CmdPair, CmdPair, true, false)
	x.start()
	x.sendBatch(x.b, payload(10, 1))
	x.on(x.a)(x.a.s.ConfirmSAS(false))
	if x.a.s.lk.alive() || count(x.a.effs, EffSendFile, int(linkwire.CtrlReject)) != 1 {
		t.Fatalf("SAS rejection did not refuse and destroy: %s", kinds(x.a.effs))
	}
	if ended, code := x.b.s.Ended(); !ended || code != "peer-ended-session" {
		t.Fatalf("peer did not see an authenticated leave: %v %q\n%s", ended, code, kinds(x.b.effs))
	}
}

// send / receive / text refuse what they do not receive, at once, without a
// prompt and even before admission.
func TestNonInteractiveCommandsRefuseOtherKinds(t *testing.T) {
	l := openLoop(t, CmdSend, CmdPair)
	l.sendBatch(l.b, payload(10, 1))
	l.on(l.b)(l.b.s.RequestText())
	wantStates(t, l.a, "Idle", "Idle")
	if count(l.a.effs, EffPromptFiles, -1)+count(l.a.effs, EffPromptText, -1) != 0 {
		t.Fatal("send prompted")
	}
	if !hasReport(l.b.effs, "declined") {
		t.Fatal("peer not told")
	}
	x := openLoop(t, CmdText, CmdPair)
	x.sendBatch(x.b, payload(10, 1))
	wantStates(t, x.a, "Idle", "")
	x.on(x.b)(x.b.s.RequestText())
	wantStates(t, x.a, "", "Open") // text consents to text
}

// ---------------------------------------------------------------- glare

func TestGlare(t *testing.T) {
	i := NewMachine(FileTable, LCInitiator, FIdle)
	r := NewMachine(FileTable, LCResponder, FIdle)
	i.Fire(FLocalOffer)
	r.Fire(FLocalOffer)
	i.Fire(FPeerManifest)
	r.Fire(FPeerManifest)
	if i.State != FOutWait || !has(lastDo(i), AFBusy) {
		t.Fatal("initiator did not keep")
	}
	if r.State != FInPrompt || !has(lastDo(r), ABatchAbort) || !has(lastDo(r), ARequeue) {
		t.Fatal("responder did not yield")
	}
	r.Fire(FPeerBusy)
	if r.State != FInPrompt {
		t.Fatal("late BUSY disturbed the yielded responder")
	}
	i.Fire(FPeerBatchAbort)
	if i.State != FOutWait {
		t.Fatal("peer abort of the yielded batch disturbed the keeper")
	}

	ti := NewMachine(TextTable, LCInitiator, TIdle)
	tr := NewMachine(TextTable, LCResponder, TIdle)
	ti.Fire(TLocalRequest)
	tr.Fire(TLocalRequest)
	ti.Fire(TPeerRequest)
	tr.Fire(TPeerRequest)
	if ti.State != TWaitAccept || tr.State != TIncoming {
		t.Fatalf("text glare: ini=%s rsp=%s", TextTable.States[ti.State], TextTable.States[tr.State])
	}
	tr.Fire(TPeerReject)
	tr.Fire(TLocalAccept)
	ti.Fire(TPeerAccept)
	if ti.State != TOpen || tr.State != TOpen {
		t.Fatal("text glare did not converge")
	}
}

// Both sides offer at once over the real codecs: the initiator's batch goes
// first, the responder's is requeued exactly once and delivered after it.
func TestSessionGlare(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	a, b := l.a, l.b // a initiates
	pa, pb := payload(1000, 1), payload(2000, 2)
	l.hold(a)(a.s.OfferFiles([]linkwire.FileMeta{{Name: "a", Size: uint64(len(pa))}}))
	l.hold(b)(b.s.OfferFiles([]linkwire.FileMeta{{Name: "b", Size: uint64(len(pb))}}))
	l.pump()
	wantStates(t, a, "OutWait", "")
	wantStates(t, b, "InPrompt", "")
	accept(t, l, b)
	l.pushData(a, pa)
	// b's yielded batch is re-offered by itself once its lane is idle
	wantStates(t, b, "OutWait", "")
	wantStates(t, a, "InPrompt", "")
	accept(t, l, a)
	l.pushData(b, pb)
	if !sameBytes(b.written[lastPrompt(b.effs, EffPromptFiles)][0], pa) || !sameBytes(a.written[lastPrompt(a.effs, EffPromptFiles)][0], pb) {
		t.Fatal("glare lost a batch")
	}
	if n := count(b.effs, EffSendFile, int(linkwire.CtrlBatchAbort)); n != 1 {
		t.Fatalf("responder aborted %d times", n)
	}

	// text glare through the sessions
	l.hold(a)(a.s.RequestText())
	l.hold(b)(b.s.RequestText())
	l.pump()
	wantStates(t, a, "", "Open")
	wantStates(t, b, "", "Open")
}

// ---------------------------------------------------------------- cancel races

func TestCancelRaces(t *testing.T) {
	snd := NewMachine(FileTable, LCInitiator, FOutSend)
	rcv := NewMachine(FileTable, LCResponder, FInRecv)
	snd.Fire(FLocalCancelOut)
	rcv.Fire(FLocalCancelIn)
	rcv.Fire(FPeerContent)
	rcv.Fire(FPeerBatchAbort)
	snd.Fire(FPeerReject)
	if snd.State != FIdle || rcv.State != FIdle || sent(snd, ABatchAbort) != 1 || has(rcv.Trace[2].Do, ADecryptWrite) {
		t.Fatal("crossing cancel")
	}
	p := NewMachine(FileTable, LCInitiator, FInPrompt)
	p.Fire(FConsentTimeout)
	p.Fire(FLocalAccept)
	p.Fire(FLocalReject)
	p.Fire(FPeerContent)
	if p.State != FEnded || sent(p, AAttachAccept) != 0 || sent(p, AFReject) != 0 || !has(lastDo(p), ANoDecrypt) {
		t.Fatal("expired prompt answered or decrypted")
	}
	d := NewMachine(FileTable, LCInitiator, FOutWait)
	d.Fire(FPeerAccept)
	d.Fire(FPeerAccept)
	if d.State != FOutSend || sent(d, ASendData) != 1 {
		t.Fatal("duplicate ACCEPT restarted data")
	}
	c := NewMachine(FileTable, LCInitiator, FOutFinish)
	c.Fire(FLocalCancelOut)
	c.Fire(FPeerComplete)
	if c.State != FIdle || !strings.Contains(strings.Join(c.Trace[0].Do, ","), "receiver-may-have-saved") {
		t.Fatal("late cancel must not claim nothing was saved")
	}
}

// Sender cancels while the receiver stops the same batch: frames cross, both
// settle idle, the in-flight data is authenticated and discarded, and a retry
// succeeds on the same link.
func TestSessionCancelCrossing(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	a, b := l.a, l.b
	p := payload(3*linkwire.ChunkSize, 5)
	l.sendBatch(a, p)
	accept(t, l, b)
	// one chunk in flight when both cancel
	l.hold(a)(a.s.SendChunk(p[:linkwire.ChunkSize]))
	l.hold(a)(a.s.CancelOutgoing())
	l.hold(b)(b.s.CancelIncoming())
	written := len(b.written[lastPrompt(b.effs, EffPromptFiles)][0])
	l.pump()
	wantStates(t, a, "Idle", "")
	wantStates(t, b, "Idle", "")
	if len(b.written[lastPrompt(b.effs, EffPromptFiles)][0]) != written {
		t.Fatal("a drained chunk was written")
	}
	if count(a.effs, EffSendFile, int(linkwire.CtrlBatchAbort)) != 1 || count(b.effs, EffSendFile, int(linkwire.CtrlReject)) != 1 {
		t.Fatalf("controls: a=%s b=%s", kinds(a.effs), kinds(b.effs))
	}
	l.sendBatch(a, p)
	accept(t, l, b)
	l.pushData(a, p)
	if !sameBytes(b.written[lastPrompt(b.effs, EffPromptFiles)][0], p) {
		t.Fatal("retry failed")
	}
}

func TestTextEndRaces(t *testing.T) {
	a := NewMachine(TextTable, LCInitiator, TOpen)
	a.Fire(TLocalEnd)
	a.Fire(TPeerContent)
	if has(lastDo(a), TADeliver) {
		t.Fatal("delivered after local END")
	}
	a.Fire(TPeerEnd)
	if a.State != TIdle {
		t.Fatal("END ack not honoured")
	}
	b := NewMachine(TextTable, LCInitiator, TOpen)
	b.Fire(TLocalEnd)
	b.Fire(TEndAckTimeout)
	if b.State != TFailed {
		t.Fatal("unacknowledged END must retire the text codecs")
	}
}

// A message in flight behind our END is authenticated and discarded, never
// delivered, and the sequence stays aligned for the next conversation.
func TestSessionTextEndDrain(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	a, b := l.a, l.b
	l.on(a)(a.s.RequestText())
	l.hold(b)(b.s.SendText([]byte("late"), 0))
	l.hold(a)(a.s.EndText())
	l.pump()
	if len(a.texts) != 0 {
		t.Fatalf("delivered after END: %q", a.texts)
	}
	wantStates(t, a, "", "Idle")
	l.on(b)(b.s.RequestText())
	l.on(b)(b.s.SendText([]byte("next"), 0))
	if len(a.texts) != 1 || a.texts[0] != "next" {
		t.Fatalf("sequence broken after drain: %q", a.texts)
	}
}

// ---------------------------------------------------------------- lane isolation, unknown frames

func TestLaneIsolation(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	a, b := l.a, l.b
	l.on(a)(a.s.TextFrame(a.s.Epoch(), []byte{linkwire.KindText, 0, 0})) // short kind 9
	wantStates(t, a, "Idle", "Failed")
	if a.s.linkM.State != LOpen {
		t.Fatal("text failure spread to the link")
	}
	l.sendBatch(a, payload(99, 1))
	accept(t, l, b)
	l.pushData(a, payload(99, 1))
	wantStates(t, a, "Idle", "Failed")

	u := openLoop(t, CmdPair, CmdPair)
	u.on(u.a)(u.a.s.FileFrame(u.a.s.Epoch(), []byte{0x42})) // unroutable
	wantStates(t, u.a, "Ended", "Idle")
	if err := u.on(u.a)(u.a.s.OfferFiles([]linkwire.FileMeta{{Name: "x", Size: 1}})); !errors.Is(err, ErrWrongState) {
		t.Fatalf("offer on a dead file lane: %v", err)
	}
	u.on(u.a)(u.a.s.RequestText())
	u.on(u.a)(u.a.s.SendText([]byte("still here"), 0))
	if len(u.b.texts) != 1 || u.a.s.linkM.State != LOpen {
		t.Fatal("file failure spread to text")
	}
}

// relay-renew/1 rides the text lane with first byte 0x0d; a non-renewing peer
// must ignore it (relay-renew-v1 §8) and it must never reach the AEAD.
func TestRelayRenewControlIgnored(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	a, b := l.a, l.b
	l.on(b)(b.s.RequestText())
	exp := a.s.lk.textRx.ExpectedSeq()
	for _, f := range [][]byte{{0x0d}, {0x0d, 1, 2, 3}, append([]byte{0x0d}, make([]byte, 64)...), {0xfd}, {0xf8}, {}} {
		effs, err := a.s.TextFrame(a.s.Epoch(), f)
		if err != nil || len(effs) != 0 {
			t.Fatalf("frame %x acted: %v %s", f, err, kinds(effs))
		}
	}
	if a.s.lk.textRx.ExpectedSeq() != exp {
		t.Fatal("an ignored frame reached the receiver")
	}
	l.on(b)(b.s.SendText([]byte("after renew"), 0))
	if len(a.texts) != 1 || a.texts[0] != "after renew" {
		t.Fatalf("conversation broken: %q", a.texts)
	}
}

// ---------------------------------------------------------------- P3 / P4 at run time

// feedsOutsideConsent is the run-time P3 check: every protected content frame
// that reached the AEAD receiver did so in InRecv or InDrain.
func feedsOutsideConsent(s *Session) []string {
	var out []string
	for _, st := range s.contentFeeds {
		if st != FInRecv && st != FInDrain {
			out = append(out, FileTable.States[st])
		}
	}
	return out
}

// answeredAfterExpiry is the run-time P4 check over a file machine's trace.
func answeredAfterExpiry(m *Machine) []string {
	var out []string
	for _, st := range m.Trace {
		if st.From == "InExpired" && (has(st.Do, AAttachAccept) || has(st.Do, AFReject)) {
			out = append(out, st.On)
		}
	}
	return out
}

func TestContentBeforeConsentNeverDecrypts(t *testing.T) {
	run := func(tb tables) (*loop, []Effect) {
		l := newLoop(t, CmdPair, CmdPair, false, false)
		s, _ := newSession(Config{Cmd: CmdPair, Clock: l.clk, Rand: newRand(1)}, tb)
		l.a.s = s
		l.start()
		frames, err := l.b.s.lk.fileTx.ChunkFrames(payload(100, 1), DefaultMaxFrameBytes)
		if err != nil {
			t.Fatal(err)
		}
		effs, _ := l.a.s.FileFrame(l.a.s.Epoch(), frames[0])
		return l, effs
	}
	l, effs := run(defaultTables)
	wantStates(t, l.a, "Ended", "Idle")
	if !hasReport(effs, "content-before-consent") || l.a.s.lk.fileRx.ExpectedSeq() != 0 || len(l.a.s.contentFeeds) != 0 {
		t.Fatalf("content before consent reached the receiver: %s", kinds(effs))
	}
	// negative control: the same frame against a session built from the
	// "decrypt before consent" mutant IS fed to the AEAD, and the run-time
	// check sees it.
	m, _ := run(mutate(defaultTables, "file", LCInitiator, FIdle, FPeerContent, FInRecv, OK, ADecryptWrite))
	if v := feedsOutsideConsent(m.a.s); len(v) == 0 || m.a.s.lk.fileRx.ExpectedSeq() != 1 {
		t.Fatalf("negative control: mutant decrypt not observed (%v)", v)
	} else {
		t.Logf("negative control: mutant session decrypted in %v; check caught it", v)
	}
}

func TestAcceptAfterExpiry(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	a, b := l.a, l.b
	l.sendBatch(b, payload(10, 1))
	p := lastPrompt(a.effs, EffPromptFiles)
	l.clk.Advance(FileConsent)
	l.on(a)(a.s.Tick()) // only the receiver's window has run out so far
	wantStates(t, a, "InExpired", "")
	if count(a.effs, EffPromptWithdrawn, -1) == 0 {
		t.Fatal("expired prompt not withdrawn")
	}
	if err := l.on(a)(a.s.AcceptFiles(p)); !errors.Is(err, ErrStalePrompt) {
		t.Fatalf("late accept: %v", err)
	}
	if err := l.on(a)(a.s.RejectFiles(p)); !errors.Is(err, ErrStalePrompt) {
		t.Fatalf("late reject: %v", err)
	}
	if count(a.effs, EffSendFile, int(linkwire.CtrlAccept))+count(a.effs, EffSendFile, int(linkwire.CtrlReject)) != 0 {
		t.Fatal("expired prompt answered")
	}
	l.on(b)(b.s.Tick()) // sender's window: BATCH_ABORT, which retires it on a
	wantStates(t, a, "Idle", "")
	wantStates(t, b, "Idle", "")
	if !hasReport(b.effs, "no-answer") || len(answeredAfterExpiry(a.s.fileM)) != 0 {
		t.Fatal("expiry not truthful")
	}
	// scheduling lag: the window runs out and the user clicks BEFORE the
	// driver's next Tick. The click itself fires the overdue timer first.
	l.sendBatch(b, payload(30, 3))
	lag := lastPrompt(a.effs, EffPromptFiles)
	l.clk.Advance(FileConsent)
	if err := l.on(a)(a.s.AcceptFiles(lag)); !errors.Is(err, ErrStalePrompt) {
		t.Fatalf("late accept honoured through tick lag: %v", err)
	}
	if count(a.effs, EffSendFile, int(linkwire.CtrlAccept)) != 0 || a.s.fileM.State != FInExpired {
		t.Fatal("consent byte after expiry")
	}
	l.on(b)(b.s.Tick())
	wantStates(t, a, "Idle", "")

	// the NEXT batch is unaffected by anything from the expired one
	l.sendBatch(b, payload(20, 2))
	accept(t, l, a)
	l.pushData(b, payload(20, 2))
	wantStates(t, a, "Idle", "")

	// negative control: a session on the "accept after expiry" mutant table,
	// with the API guard bypassed, emits ACCEPT from InExpired and the
	// run-time check catches it. The public API refuses even on the mutant.
	m := newLoop(t, CmdPair, CmdPair, false, false)
	ms, _ := newSession(Config{Cmd: CmdPair, Clock: m.clk, Rand: newRand(1)},
		mutate(defaultTables, "file", LCInitiator, FInExpired, FLocalAccept, FInRecv, OK, AAttachAccept))
	m.a.s = ms
	m.start()
	m.sendBatch(m.b, payload(10, 1))
	m.clk.Advance(FileConsent)
	m.on(m.a)(m.a.s.Tick())
	if err := m.on(m.a)(m.a.s.AcceptFiles(lastPrompt(m.a.effs, EffPromptFiles))); !errors.Is(err, ErrStalePrompt) {
		t.Fatalf("API guard: %v", err)
	}
	m.a.s.out = nil
	m.a.s.fireFile(FLocalAccept) // bypass
	if v := answeredAfterExpiry(m.a.s.fileM); len(v) == 0 {
		t.Fatal("negative control: accept-after-expiry not caught")
	} else {
		t.Logf("negative control: mutant answered from InExpired on %v; check caught it", v)
	}
}

// ---------------------------------------------------------------- establishment, fences, leave

func TestEstablishmentOrdering(t *testing.T) {
	r := NewMachine(LinkTable, LCResponder, LIdle)
	r.Fire(LStart)
	r.Fire(LPeerRevealValid)
	if r.State != LClosed {
		t.Fatal("reveal without commit accepted")
	}
	a := NewMachine(LinkTable, LCResponder, LIdle)
	a.Fire(LStart)
	a.Fire(LPeerOffer)
	a.Fire(LPeerOfferDup)
	if a.State != LAnswered || sent(a, ASendAnswer) != 1 {
		t.Fatal("duplicate offer answered twice")
	}
	b := NewMachine(LinkTable, LCInitiator, LIdle)
	b.Fire(LStart)
	b.Fire(LPeerBusy)
	if b.State != LClosed {
		t.Fatal("busy while connecting did not fail fast")
	}
	o := NewMachine(LinkTable, LCInitiator, LOpen)
	o.Fire(LDisconnected)
	o.Fire(LDisconnected)
	if sent(o, ARestartOffer) != 1 {
		t.Fatal("more than one ICE restart")
	}
}

// responderAt returns a responder session in link Requesting with peer "a".
func responderAt(t *testing.T) (*Session, *fakeClock) {
	t.Helper()
	clk := newClock()
	s, err := NewSession(Config{Cmd: CmdPair, Clock: clk, Rand: newRand(3)})
	if err != nil {
		t.Fatal(err)
	}
	s.Room(s.Epoch(), RoomView{SelfID: "b", PeerID: "a", ServerHints: true, PeerHinted: true})
	s.Signal(s.Epoch(), "a", []byte(`{"caps":["link/1"]}`))
	if s.linkM == nil || s.linkM.State != LRequesting {
		t.Fatalf("not requesting: %v", s)
	}
	return s, clk
}

func fakeOffer(commit []byte, sdp string) []byte {
	b, _ := json.Marshal(map[string]any{"link": true, "sdp": map[string]string{"type": "offer", "sdp": sdp},
		"commit": base64.StdEncoding.EncodeToString(commit), "caps": []string{"link/1"}})
	return b
}

func TestSessionEstablishmentOrdering(t *testing.T) {
	// a reveal before any commit is a hard failure that destroys the handshake
	s, _ := responderAt(t)
	rv := revealFrame(make([]byte, 32), make([]byte, 32))
	effs, _ := s.Signal(s.Epoch(), "a", rv)
	if s.linkM.State != LClosed || !hasReport(effs, "reveal-without-commit") || s.lk.self != nil {
		t.Fatalf("reveal without commit: %s", kinds(effs))
	}
	// a byte-identical duplicate offer is dropped, never answered twice; a
	// different offer with the SAME commit before open is dropped too
	s, _ = responderAt(t)
	commit := make([]byte, 32)
	commit[0] = 7
	off := fakeOffer(commit, "v=0 one")
	e1, _ := s.Signal(s.Epoch(), "a", off)
	e2, _ := s.Signal(s.Epoch(), "a", off)
	e3, _ := s.Signal(s.Epoch(), "a", fakeOffer(commit, "v=0 two"))
	if count(e1, EffSendAnswer, -1) != 1 || len(e2) != 0 || len(e3) != 0 || s.linkM.State != LAnswered {
		t.Fatalf("offers: %s | %s | %s", kinds(e1), kinds(e2), kinds(e3))
	}
	// a reveal that does not open the recorded commit ends the link
	e4, _ := s.Signal(s.Epoch(), "a", rv)
	if s.linkM.State != LClosed || !hasReport(e4, "commit-mismatch") {
		t.Fatalf("mismatched reveal: %s", kinds(e4))
	}
	// an offer with no valid commit is never answered
	s, _ = responderAt(t)
	e5, _ := s.Signal(s.Epoch(), "a", []byte(`{"link":true,"sdp":{"type":"offer","sdp":"x"},"commit":"short"}`))
	if len(e5) != 0 || s.linkM.State != LRequesting {
		t.Fatalf("commitless offer answered: %s", kinds(e5))
	}
}

// Late reorder: a lane frame that arrives before the peer key is verified is
// captured and replayed only after both lane owners are attached.
func TestLaneCaptureBeforeReveal(t *testing.T) {
	l := newLoop(t, CmdPair, CmdPair, false, false)
	l.lanesFirst = true
	l.startWith(RoomView{SelfID: "a", PeerID: "b", ServerHints: true, PeerHinted: true},
		RoomView{SelfID: "b", PeerID: "a", ServerHints: true, PeerHinted: true})
	// With lanesFirst both sides pass through LanesKeyPending.
	for _, e := range []*end{l.a, l.b} {
		seen := false
		for _, st := range e.s.linkM.Trace {
			seen = seen || st.To == "LanesKeyPending"
		}
		if !seen || e.s.linkM.State != LOpen {
			t.Fatalf("%s did not open lanes-before-reveal", e.name)
		}
	}
	// Now force the reorder on a fresh pair: deliver b's first text frame to a
	// while a is still LanesKeyPending.
	l = newLoop(t, CmdPair, CmdPair, false, false)
	l.lanesFirst = true
	l.hold(l.a)(l.a.s.Room(l.a.s.Epoch(), RoomView{SelfID: "a", PeerID: "b", ServerHints: true, PeerHinted: true}))
	l.hold(l.b)(l.b.s.Room(l.b.s.Epoch(), RoomView{SelfID: "b", PeerID: "a", ServerHints: true, PeerHinted: true}))
	for l.b.s.linkM == nil || l.b.s.linkM.State != LOpen {
		if len(l.q) == 0 {
			t.Fatal("b never opened")
		}
		l.stepOne()
	}
	if l.a.s.linkM.State != LLanesKeyPending {
		t.Fatalf("a is %s", l.a.s.linkM.StateName())
	}
	l.hold(l.b)(l.b.s.RequestText())
	// move b's REQUEST ahead of b's reveal: signalling and data are independent
	last := l.q[len(l.q)-1]
	l.q = append([]delivery{last}, l.q[:len(l.q)-1]...)
	l.stepOne()
	if len(l.a.s.laneCap) != 1 || l.a.s.textM.State != TIdle {
		t.Fatal("frame not captured before the key was verified")
	}
	l.pump()
	wantStates(t, l.a, "", "Open")
	wantStates(t, l.b, "", "Open")
}

func TestEpochFencesAndPeerGeneration(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	a := l.a
	ep := a.s.Epoch()
	forged := []byte(`{"link":true,"leave":true,"auth":"` + strings.Repeat("A", 43) + `="}`)
	effs, _ := a.s.Signal(ep, "b", forged)
	if len(effs) != 0 || a.s.linkM.State != LOpen || a.s.leaveSpent != 1 {
		t.Fatalf("forged leave acted: %s", kinds(effs))
	}
	smuggled := []byte(`{"link":true,"leave":true,"auth":"` + strings.Repeat("A", 43) + `=","busy":true}`)
	effs, _ = a.s.Signal(ep, "b", smuggled)
	if len(effs) != 0 || a.s.leaveSpent != 1 || a.s.linkM.State != LOpen {
		t.Fatal("a leave with an extra key was acted on or cost an HMAC")
	}
	// a stale transport epoch never reaches a lane
	stale := Epoch{Room: ep.Room, Link: ep.Link - 1, Transport: ep.Transport}
	if _, err := a.s.FileFrame(stale, []byte{linkwire.CtrlAccept}); !errors.Is(err, ErrStale) {
		t.Fatal("stale transport frame applied")
	}
	if _, err := a.s.Signal(Epoch{Room: ep.Room + 1}, "b", []byte(`{"link":true,"busy":true}`)); !errors.Is(err, ErrStale) {
		t.Fatal("signal from another room epoch applied")
	}
	// another peer id (a reconnected tab) is a different peer: an offer is
	// answered busy; its busy is NOT answered (no ping-pong); nothing else acts
	effs, _ = a.s.Signal(ep, "c", fakeOffer(make([]byte, 32), "x"))
	if len(effs) != 1 || effs[0].To != "c" || string(effs[0].Bytes) != string(linkwire.BusySignal()) {
		t.Fatalf("foreign offer: %s", kinds(effs))
	}
	effs, _ = a.s.Signal(ep, "c", linkwire.BusySignal())
	if len(effs) != 0 || a.s.linkM.State != LOpen {
		t.Fatal("foreign busy acted")
	}
	// transport loss ends everything truthfully and destroys the keys
	effs, _ = a.s.TransportLost(ep)
	if a.s.linkM.State != LClosed || a.s.lk.alive() || a.s.fileM.State != FEnded || a.s.textM.State != TFailed ||
		!hasReport(effs, "connection-lost(no-recovery)") || a.s.Epoch().Link == ep.Link {
		t.Fatalf("transport loss: %s", kinds(effs))
	}
	for _, f := range []func() ([]Effect, error){
		func() ([]Effect, error) { return a.s.FileFrame(ep, []byte{linkwire.CtrlAccept}) },
		func() ([]Effect, error) { return a.s.TextFrame(ep, []byte{linkwire.CtrlTextRequest}) },
		func() ([]Effect, error) { return a.s.Signal(ep, "b", forged) },
		func() ([]Effect, error) { return a.s.Tick() },
	} {
		if effs, err := f(); err == nil || len(effs) != 0 {
			t.Fatal("input after close acted")
		}
	}
}

func TestLeave(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	l.on(l.a)(l.a.s.Close())
	if ended, code := l.b.s.Ended(); !ended || code != "peer-ended-session" || l.b.s.lk.alive() {
		t.Fatalf("valid leave: %v %q", ended, code)
	}
	// a leave reflected back at its own sender fails verification (the tag
	// covers from/to): replay a's own leave INTO a fresh pair's a
	x := openLoop(t, CmdPair, CmdPair)
	var leave []byte
	for _, e := range l.a.effs {
		if e.Kind == EffSendSignal && strings.Contains(string(e.Bytes), `"leave"`) {
			leave = e.Bytes
		}
	}
	effs, _ := x.a.s.Signal(x.a.s.Epoch(), "b", leave)
	if len(effs) != 0 || x.a.s.linkM.State != LOpen {
		t.Fatal("a leave from another link verified")
	}
}

func TestLegacyHandoffAndCapture(t *testing.T) {
	clk := newClock()
	s, _ := NewSession(Config{Cmd: CmdSend, Clock: clk})
	commit := []byte(`{"kind":"commit","commit":"AAAA"}`)
	effs, _ := s.Signal(s.Epoch(), "old", commit) // beats our roster: captured
	if len(effs) != 0 {
		t.Fatal("acted before the room view")
	}
	effs, _ = s.Room(s.Epoch(), RoomView{SelfID: "new", PeerID: "old", ServerHints: true})
	if len(effs) != 1 || effs[0].Kind != EffBeginLegacy || string(effs[0].Bytes) != string(commit) {
		t.Fatalf("legacy handoff: %s", kinds(effs))
	}
	effs, _ = s.Signal(s.Epoch(), "old", []byte(`{"kind":"reveal"}`))
	if len(effs) != 1 || effs[0].Kind != EffLegacyFrame {
		t.Fatalf("legacy frame: %s", kinds(effs))
	}
	// pair meets an old CLI: one upgrade notice, then the session ends
	p, _ := NewSession(Config{Cmd: CmdPair, Clock: clk})
	p.Room(p.Epoch(), RoomView{SelfID: "new", PeerID: "old", ServerHints: true})
	effs, _ = p.Signal(p.Epoch(), "old", commit)
	if len(effs) < 2 || string(effs[0].Bytes) != string(upgradeFrame) || !hasReport(effs, "peer-is-older-cli") {
		t.Fatalf("pair vs old CLI: %s", kinds(effs))
	}
}
