package linksession

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/linkwire"
)

// Fuzz targets: the signal classifier and the lane demux against the tables.
// Properties: never panic; never emit consent (an ACCEPT on either lane, an
// attached sink, a delivered text or a written chunk) that no local accept
// produced; never feed protected content to the AEAD outside InRecv/InDrain;
// never answer an expired prompt.

func signalSeeds() [][]byte {
	return [][]byte{
		[]byte(`{"kind":"commit","commit":"AAAA"}`),
		[]byte(`{"kind":"commit","mode":"text"}`),
		[]byte(`{"kind":null,"caps":["link/1"]}`),
		[]byte(`{"kind":7}`),
		[]byte(`{"caps":["link/1"]}`),
		[]byte(`{"caps":[]}`),
		[]byte(`{"caps":"link/1"}`),
		[]byte(`{"caps":["LINK/1","link/2",1,null]}`),
		[]byte(`{"link":true,"linkRequest":true}`),
		[]byte(`{"link":true,"linkRequest":true,"sdp":null}`),
		[]byte(`{"link":true,"sdp":{"type":"offer","sdp":"x"},"commit":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","caps":["link/1"]}`),
		[]byte(`{"link":true,"sdp":{"type":"answer","sdp":"x"},"commit":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`),
		[]byte(`{"link":true,"reveal":{"key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}`),
		[]byte(`{"link":true,"ice":{"candidate":"c","sdpMid":"0"}}`),
		[]byte(`{"link":true,"busy":true}`),
		[]byte(`{"link":true,"leave":true,"auth":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`),
		[]byte(`{"link":true,"leave":true,"auth":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","busy":true}`),
		[]byte(`{"resume":true,"link":true,"sdp":{"type":"offer"}}`),
		[]byte(`{"sdp":{"type":"offer","sdp":"x"}}`),
		[]byte(`{"text":true,"sdp":{"type":"offer"}}`),
		[]byte(`{"relayRtt":12}`),
		[]byte(`[1,2,3]`), []byte(`"x"`), []byte(`null`), []byte(``), []byte(`{`),
		[]byte("{\"caps\":[\"\\ud800\"]}"), []byte("{\"kind\":\"\xff\"}"),
		[]byte(`{"link":true,"link":false,"caps":["link/1"]}`),
	}
}

// consentEffects counts effects that would amount to consent or content.
func consentEffects(effs []Effect) int {
	n := 0
	for _, e := range effs {
		switch e.Kind {
		case EffAttachSink, EffDeliverText, EffWriteChunk, EffTextOpened:
			n++
		case EffSendFile, EffSendText:
			if len(e.Bytes) == 1 && e.Bytes[0] == linkwire.CtrlAccept {
				n++
			}
		}
	}
	return n
}

func FuzzClassifySignal(f *testing.F) {
	for _, s := range signalSeeds() {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		in := classifySignal(raw)
		if in.event < DSigLegacyCommit || in.event > DSigIgnorable {
			t.Fatalf("classifier left the signal range: %d", in.event)
		}
		// a top-level STRING kind is always legacy, whatever else is present
		var m map[string]json.RawMessage
		if json.Unmarshal(raw, &m) == nil && in.fields != nil {
			var k string
			if v, ok := m["kind"]; ok && len(v) > 0 && v[0] == '"' && json.Unmarshal(v, &k) == nil {
				if in.event != DSigLegacyCommit && in.event != DSigLegacyOther {
					t.Fatalf("string kind not classified legacy: %s -> %d", raw, in.event)
				}
			}
		}
		// the link sub-classifier and field readers are total too
		_ = classifyLinkShape(in)
		_, _ = signalCommit(in)
		_, _, _ = signalReveal(in)
	})
}

// FuzzSignalSession feeds one arbitrary signal to sessions in every
// discovery phase and to an open link, from the bound peer and a stranger.
func FuzzSignalSession(f *testing.F) {
	for i, s := range signalSeeds() {
		f.Add(s, byte(i))
	}
	f.Fuzz(func(t *testing.T, raw []byte, sel byte) {
		clk := newClock()
		fresh := func(cmd Cmd, view *RoomView) *Session {
			s, _ := NewSession(Config{Cmd: cmd, Clock: clk, Rand: newRand(sel)})
			if view != nil {
				s.Room(s.Epoch(), *view)
			}
			return s
		}
		cmd := Cmd(sel % 4)
		sessions := []*Session{
			fresh(cmd, nil), // Joining
			fresh(cmd, &RoomView{SelfID: "a", PeerID: "b", ServerHints: true}),                   // Passive
			fresh(cmd, &RoomView{SelfID: "a", PeerID: "b", ServerHints: true, PeerHinted: true}), // Greeting
			fresh(cmd, &RoomView{SelfID: "a", PeerID: "b"}),                                      // no hints
		}
		l := openLoop(t, cmd, CmdPair)
		sessions = append(sessions, l.a.s, l.b.s)
		for _, s := range sessions {
			for _, from := range []string{"b", "a", "c"} {
				effs, _ := s.Signal(s.Epoch(), from, raw)
				if n := consentEffects(effs); n != 0 {
					t.Fatalf("a signal produced consent: %s", kinds(effs))
				}
				for _, e := range effs {
					if e.Kind == EffAdmitted {
						t.Fatal("a signal admitted a link")
					}
				}
			}
		}
		// an open link is never ended by an unauthenticated signal except
		// through the rows that say so (busy/revocation apply only pre-open)
		if st := l.a.s.linkM.State; st != LOpen && st != LRestarting && st != LClosed {
			t.Fatalf("open link moved to %s on a signal", l.a.s.linkM.StateName())
		}
		if l.a.s.linkM.State == LClosed && l.a.s.leaveSpent == 0 {
			t.Fatalf("open link closed by an unverified signal: %s", kinds(l.a.effs))
		}
	})
}

// splitFrames cuts fuzz data into frames: [len][bytes]...
func splitFrames(data []byte) [][]byte {
	var out [][]byte
	for len(data) > 0 {
		n := int(data[0])
		data = data[1:]
		if n > len(data) {
			n = len(data)
		}
		out = append(out, data[:n])
		data = data[n:]
	}
	return out
}

func laneSeeds(f *testing.F) {
	for _, s := range [][]byte{
		{1, 0xfe}, {1, 0xff}, {1, 0xfd}, {1, 0xf9}, {1, 0xf8}, {1, 0xfa}, {1, 0xfb}, {1, 0x0d},
		{2, 0xfe, 0xfe}, {5, 7, 0, 0, 0, 0}, {5, 1, 0, 0, 0, 0}, {5, 8, 0, 0, 0, 0}, {5, 2, 0, 0, 0, 0},
		{5, 3, 0, 0, 0, 0}, {5, 4, 0, 0, 0, 0}, {5, 5, 0, 0, 0, 0}, {13, 6, 0, 0, 0, 0, 0x41, 0x30, 0, 0, 0, 0, 0, 0},
		{12, 6, 0, 0, 0, 0, 0x41, 0x30, 0, 0, 0, 0, 0}, {3, 9, 0, 0}, {21, 9, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16},
		{5, 12, 0, 0, 0, 0}, {0}, {1, 0xfa, 21, 9, 0, 0, 0, 0},
	} {
		f.Add(s)
	}
}

func demuxLoop(t *testing.T) *loop {
	l := openLoop(t, CmdPair, CmdPair)
	l.a.s.authz = Authz{Files: PolicyPrompt, Text: PolicyPrompt}
	return l
}

func checkLaneInvariants(t *testing.T, s *Session, effs []Effect) {
	t.Helper()
	if n := consentEffects(effs); n != 0 {
		t.Fatalf("lane input produced consent without a local accept: %s", kinds(effs))
	}
	if v := feedsOutsideConsent(s); len(v) != 0 {
		t.Fatalf("content reached the AEAD in %v", v)
	}
	if v := answeredAfterExpiry(s.fileM); len(v) != 0 {
		t.Fatalf("expired prompt answered on %v", v)
	}
}

func FuzzFileLaneDemux(f *testing.F) {
	laneSeeds(f)
	f.Fuzz(func(t *testing.T, data []byte) {
		l := demuxLoop(t)
		s := l.a.s
		for _, fr := range splitFrames(data) {
			effs, _ := s.FileFrame(s.Epoch(), fr)
			checkLaneInvariants(t, s, effs)
		}
	})
}

func FuzzTextLaneDemux(f *testing.F) {
	laneSeeds(f)
	f.Fuzz(func(t *testing.T, data []byte) {
		l := demuxLoop(t)
		s := l.a.s
		// an open conversation, so content frames reach the decrypt rows
		l.on(l.a)(s.RequestText())
		for _, fr := range splitFrames(data) {
			effs, _ := s.TextFrame(s.Epoch(), fr)
			for _, e := range effs {
				if e.Kind == EffDeliverText {
					t.Fatal("random bytes authenticated as text")
				}
				if (e.Kind == EffSendText || e.Kind == EffSendFile) && len(e.Bytes) == 1 && e.Bytes[0] == linkwire.CtrlAccept {
					t.Fatal("text ACCEPT without a local accept")
				}
			}
		}
	})
}

// FuzzLaneScript drives a with VALID frames sealed by the peer's real codecs,
// interleaved with local decisions, clock jumps and raw frames, so the
// fuzzer reaches InPrompt/InRecv/InDrain/InExpired and the text states.
// Consent may appear only on the op that is a local accept, from a prompt,
// once admitted.
func FuzzLaneScript(f *testing.F) {
	for _, s := range [][]byte{
		{0, 5, 1, 2, 12},             // manifest, accept, chunk, done, durable
		{0, 4, 60, 5, 1},             // manifest, 10 min, late accept, chunk
		{0, 5, 1, 7, 1, 3, 4},        // accept, chunk, cancel, chunk (drained), abort
		{8, 3, 0, 0, 5},              // we offer, peer accepts, glare manifest
		{10, 0, 11, 0, 10, 3, 10, 3}, // text request, accept, content
		{1, 2, 0, 9, 3, 1, 2, 3},
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, ops []byte) {
		if len(ops) > 256 {
			ops = ops[:256]
		}
		l := demuxLoop(t)
		a, peer := l.a.s, l.b.s.lk
		next := func(i *int) byte {
			*i++
			if *i < len(ops) {
				return ops[*i]
			}
			return 0
		}
		feedFile := func(frames [][]byte) (out []Effect) {
			for _, fr := range frames {
				e, _ := a.FileFrame(a.Epoch(), fr)
				out = append(out, e...)
			}
			return
		}
		for i := 0; i < len(ops) && !a.ended; i++ {
			op := ops[i] % 13
			preFile, preText, preAdm := a.fileM.State, a.textM.State, a.adm
			var effs []Effect
			switch op {
			case 0:
				fr, err := peer.fileTx.BatchFrames([]linkwire.FileMeta{{Name: "n", Size: 5}}, DefaultMaxFrameBytes)
				if err == nil {
					effs = feedFile(fr)
				}
			case 1:
				fr, err := peer.fileTx.ChunkFrames([]byte("hello"), DefaultMaxFrameBytes)
				if err == nil {
					effs = feedFile(fr)
				}
			case 2:
				if fr, err := peer.fileTx.DoneFrame(); err == nil {
					effs = feedFile([][]byte{fr})
				}
			case 3:
				ctl := []byte{linkwire.CtrlAccept, linkwire.CtrlReject, linkwire.CtrlComplete, linkwire.CtrlBusy, linkwire.CtrlBatchAbort}[next(&i)%5]
				effs = feedFile([][]byte{{ctl}})
			case 4:
				l.clk.Advance(time.Duration(next(&i)) * 10 * time.Second)
				effs, _ = a.Tick()
			case 5:
				effs, _ = a.AcceptFiles(a.filePrompt)
			case 6:
				effs, _ = a.RejectFiles(a.filePrompt)
			case 7:
				effs, _ = a.CancelIncoming()
			case 8:
				effs, _ = a.OfferFiles([]linkwire.FileMeta{{Name: "o", Size: 3}})
			case 9:
				n := int(next(&i))
				raw := make([]byte, 0, n)
				for k := 0; k < n; k++ {
					raw = append(raw, next(&i))
				}
				e1, _ := a.FileFrame(a.Epoch(), raw)
				e2, _ := a.TextFrame(a.Epoch(), raw)
				effs = append(e1, e2...)
			case 10:
				switch next(&i) % 4 {
				case 0:
					effs, _ = a.TextFrame(a.Epoch(), []byte{linkwire.CtrlTextRequest})
				case 1:
					effs, _ = a.TextFrame(a.Epoch(), []byte{linkwire.CtrlAccept})
				case 2:
					effs, _ = a.TextFrame(a.Epoch(), []byte{linkwire.CtrlTextEnd})
				case 3:
					if fr, err := peer.textTx.Seal([]byte("hi")); err == nil {
						effs, _ = a.TextFrame(a.Epoch(), fr)
					}
				}
			case 11:
				switch next(&i) % 3 {
				case 0:
					effs, _ = a.AcceptText(a.textPrompt)
				case 1:
					effs, _ = a.RequestText()
				case 2:
					effs, _ = a.EndText()
				}
			case 12:
				effs, _ = a.FileDurable(a.Epoch(), a.fin.received)
			}
			// consent legitimacy: an ACCEPT only on a local accept op, from
			// the prompt, admitted; content only after an ACCEPT existed
			for _, e := range effs {
				isAccept := len(e.Bytes) == 1 && e.Bytes[0] == linkwire.CtrlAccept
				if e.Kind == EffSendFile && isAccept && !(op == 5 && preFile == FInPrompt && preAdm == AdmAdmitted) {
					t.Fatalf("file ACCEPT on op %d from %s", op, FileTable.States[preFile])
				}
				if e.Kind == EffSendText && isAccept && !(op == 11 && preText == TIncoming && preAdm == AdmAdmitted) {
					t.Fatalf("text ACCEPT on op %d from %s", op, TextTable.States[preText])
				}
				if e.Kind == EffWriteChunk && preFile != FInRecv {
					t.Fatalf("write from %s", FileTable.States[preFile])
				}
				if e.Kind == EffDeliverText && preText != TOpen {
					t.Fatalf("text delivered from %s", TextTable.States[preText])
				}
			}
			if v := feedsOutsideConsent(a); len(v) != 0 {
				t.Fatalf("content reached the AEAD in %v", v)
			}
			if v := answeredAfterExpiry(a.fileM); len(v) != 0 {
				t.Fatalf("expired prompt answered on %v", v)
			}
		}
	})
}
