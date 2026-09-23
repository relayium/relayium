package linksession

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func allTables(tb tables) []*Table { return []*Table{tb.disc, tb.link, tb.file, tb.text} }

// Every (class, state, event) triple has exactly one row. Duplicates panic at
// init (Table.add), so reaching this test at all proves uniqueness.
func TestTablesAreTotal(t *testing.T) {
	want := map[string]int{"discovery": 192, "link": 640, "file-lane": 522, "text-lane": 240}
	total := 0
	for _, tb := range allTables(defaultTables) {
		if m := tb.Missing(); len(m) > 0 {
			t.Errorf("%s: %d missing triples, first: %v", tb.Name, len(m), m[:min(5, len(m))])
		}
		n := len(tb.Rows())
		if n != len(tb.Classes)*len(tb.States)*len(tb.Events) || n != want[tb.Name] {
			t.Errorf("%s: %d rows, want %d", tb.Name, n, want[tb.Name])
		}
		total += n
		counts := map[Outcome]int{}
		for _, r := range tb.Rows() {
			counts[r.Result]++
		}
		t.Logf("%-10s classes=%d states=%d events=%d rows=%d outcomes=%v",
			tb.Name, len(tb.Classes), len(tb.States), len(tb.Events), n, counts)
	}
	if total != 1594 {
		t.Errorf("total rows %d, want 1594", total)
	}
}

// Every row fires exactly as declared from a machine placed in its From state.
func TestEveryRowFires(t *testing.T) {
	n := 0
	for _, tb := range allTables(defaultTables) {
		for _, r := range tb.Rows() {
			m := NewMachine(tb, r.Class, r.From)
			got := m.Fire(r.On)
			want := r.From
			if r.To != Same {
				want = r.To
			}
			if m.State != want || got.Result != r.Result || strings.Join(got.Do, ",") != strings.Join(r.Do, ",") {
				t.Fatalf("%s %s: got state %s result %s", tb.Name, rowName(tb, r), tb.States[m.State], got.Result)
			}
			n++
		}
	}
	if n != 1594 {
		t.Fatalf("fired %d rows", n)
	}
	t.Logf("fired %d rows", n)
}

func rowName(tb *Table, r Row) string {
	return tb.Classes[r.Class] + "/" + tb.States[r.From] + "/" + tb.Events[r.On]
}

// ---------------------------------------------------------------- properties P1–P9
//
// Each property is a function returning its violations, so the mutation
// meta-test below can show every one of them able to fail.

// P1 no timing guess: a timer never selects a wire, and never sends a FIRST
// frame (a hello, a reply hello, a legacy commit or the upgrade notice). The
// only frame a timer may send is a cadence RETRY of a hello already sent.
func checkP1(tb tables) (out []string) {
	for _, r := range tb.disc.Rows() {
		if r.On != DDeadline && r.On != DRetryTick {
			continue
		}
		if r.To == DLink || r.To == DLegacy || r.To == DGreeting || r.To == DPassive {
			out = append(out, "timer-chooses:"+rowName(tb.disc, r))
		}
		for _, a := range []string{AAnnounce, AHelloOnce, ALegacyCommit, ALegacyUpgrade} {
			if has(r.Do, a) {
				out = append(out, "timer-first-frame:"+rowName(tb.disc, r))
			}
		}
	}
	return
}

// P2 a top-level-kind frame (which every shipped app treats as "old CLI" and
// ends on) is emitted only where the peer is proven legacy or the server
// cannot tell us otherwise, and a link hello is never the first frame towards
// an unhinted peer that has not spoken.
func checkP2(tb tables) (out []string) {
	for _, r := range tb.disc.Rows() {
		if has(r.Do, ALegacyCommit) || has(r.Do, ALegacyUpgrade) {
			provenLegacy := r.On == DSigLegacyCommit && r.From == DPassive
			noHints := r.On == DServerNoHints && r.From == DJoining && r.Class == DCLegacy
			if !provenLegacy && !noHints {
				out = append(out, "kind-without-proof:"+rowName(tb.disc, r))
			}
		}
		if has(r.Do, AAnnounce) && !(r.On == DPeerHinted || (r.On == DServerNoHints && r.Class == DCPair)) {
			out = append(out, "hello-unhinted:"+rowName(tb.disc, r))
		}
		if has(r.Do, AHelloOnce) && !(r.From == DPassive && (r.On == DSigHelloLink || r.On == DSigLinkOffer || r.On == DSigLinkOther)) {
			out = append(out, "reply-hello-unprovoked:"+rowName(tb.disc, r))
		}
	}
	return
}

// P3 protected content is never decrypted or written outside InRecv, drained
// only in InDrain, and content outside consent fails the lane closed. Text
// content is decrypted only in Open (deliver) or EndWait (drain).
func checkP3(tb tables) (out []string) {
	for _, r := range tb.file.Rows() {
		if has(r.Do, ADecryptWrite) && r.From != FInRecv {
			out = append(out, "decrypt:"+rowName(tb.file, r))
		}
		if has(r.Do, ADrain) && r.From != FInDrain {
			out = append(out, "drain:"+rowName(tb.file, r))
		}
		if r.On == FPeerContent && r.From != FInRecv && r.From != FInDrain && r.From != FEnded && r.Result != FailLane {
			out = append(out, "content-not-fail-closed:"+rowName(tb.file, r))
		}
	}
	for _, r := range tb.text.Rows() {
		if has(r.Do, TADeliver) && r.From != TOpen {
			out = append(out, "text-deliver:"+rowName(tb.text, r))
		}
		if has(r.Do, TADrain) && r.From != TEndWait {
			out = append(out, "text-drain:"+rowName(tb.text, r))
		}
	}
	return
}

// P4 consent bytes: ACCEPT only from a prompt on a LOCAL accept (which the
// session produces only when admitted and authorised); an expired file prompt
// emits neither ACCEPT nor REJECT.
func checkP4(tb tables) (out []string) {
	for _, r := range tb.file.Rows() {
		if has(r.Do, AAttachAccept) && !(r.From == FInPrompt && r.On == FLocalAccept) {
			out = append(out, "file-accept:"+rowName(tb.file, r))
		}
		if r.From == FInExpired && (has(r.Do, AAttachAccept) || has(r.Do, AFReject)) {
			out = append(out, "expired-answered:"+rowName(tb.file, r))
		}
	}
	for _, r := range tb.text.Rows() {
		if has(r.Do, TAAttachAccept) && !(r.From == TIncoming && r.On == TLocalAccept) {
			out = append(out, "text-accept:"+rowName(tb.text, r))
		}
	}
	return
}

// P5 unknown / legacy / resume file frames fail the file lane closed; the
// text lane ignores unknown first bytes (relay-renew 0x0d) but a short kind 9
// is fatal to it.
func checkP5(tb tables) (out []string) {
	for _, r := range tb.file.Rows() {
		if (r.On == FPeerUnroutable || r.On == FPeerLegacy || r.On == FPeerResumeStart || r.On == FPeerResumeReq) &&
			r.From != FEnded && r.Result != FailLane {
			out = append(out, "file-not-fail-closed:"+rowName(tb.file, r))
		}
	}
	for _, r := range tb.text.Rows() {
		if r.On == TPeerUnknown && (r.Result != Ignore || r.To != Same || len(r.Do) > 0) {
			out = append(out, "text-unknown-acted:"+rowName(tb.text, r))
		}
		if r.On == TPeerShort9 && r.From != TFailed && r.Result != FailLane {
			out = append(out, "short9-not-fatal:"+rowName(tb.text, r))
		}
	}
	return
}

// P6 refused leaves and resumes never produce a reply (a reply would reveal
// link state to the relay).
func checkP6(tb tables) (out []string) {
	for _, r := range tb.link.Rows() {
		if !(r.On == LLeaveInvalid || r.On == LResume || (r.On == LLeaveValid && r.From != LOpen && r.From != LRestarting)) {
			continue
		}
		if hasPrefix(r.Do, "send:") {
			out = append(out, "reply:"+rowName(tb.link, r))
		}
		if r.Result != Drop {
			out = append(out, "not-dropped:"+rowName(tb.link, r))
		}
	}
	return
}

// P7 key discipline: derive only on a VALID reveal; the responder reveals only
// after verifying the initiator's reveal; an answer is sent only after the
// peer commit was recorded; lanes attach only on entering Open.
func checkP7(tb tables) (out []string) {
	for _, r := range tb.link.Rows() {
		if has(r.Do, ADerive) && r.On != LPeerRevealValid {
			out = append(out, "derive:"+rowName(tb.link, r))
		}
		if r.Class == LCResponder && has(r.Do, ASendReveal) && r.On != LPeerRevealValid {
			out = append(out, "responder-reveal:"+rowName(tb.link, r))
		}
		if has(r.Do, ASendAnswer) && !has(r.Do, ARecordCommit) {
			out = append(out, "answer-before-commit:"+rowName(tb.link, r))
		}
		if has(r.Do, AAttach) && r.To != LOpen {
			out = append(out, "attach:"+rowName(tb.link, r))
		}
	}
	return
}

// P8 terminal states are absorbing and emit nothing.
func checkP8(tb tables) (out []string) {
	check := func(t *Table, s int) {
		for _, r := range t.Rows() {
			if r.From == s && (r.To != Same || len(r.Do) > 0 || (r.Result != Ignore && r.Result != Drop)) {
				out = append(out, t.Name+":"+rowName(t, r))
			}
		}
	}
	check(tb.disc, DFailed)
	check(tb.link, LClosed)
	check(tb.file, FEnded)
	check(tb.text, TFailed)
	return
}

// P9 every path that ends a link after its handshake began destroys the keys.
func checkP9(tb tables) (out []string) {
	for _, r := range tb.link.Rows() {
		if r.To == LClosed && r.From != LIdle && r.From != LClosed && !has(r.Do, ADestroy) {
			if r.From == LRequesting && r.On == LRequestTimeout {
				continue // no peer commit, no derived key: nothing but the handshake identity, which the session drops
			}
			out = append(out, "close-without-destroy:"+rowName(tb.link, r))
		}
	}
	return
}

var properties = []struct {
	name  string
	check func(tables) []string
}{
	{"P1 timer never chooses a wire", checkP1},
	{"P2 first-frame safety", checkP2},
	{"P3 no decrypt before consent", checkP3},
	{"P4 consent only from local accept", checkP4},
	{"P5 fail-closed file / ignore-unknown text", checkP5},
	{"P6 silent refusals", checkP6},
	{"P7 key discipline", checkP7},
	{"P8 terminal absorbing", checkP8},
	{"P9 close destroys keys", checkP9},
}

func TestSafetyProperties(t *testing.T) {
	for _, p := range properties {
		if v := p.check(defaultTables); len(v) > 0 {
			t.Errorf("%s violated: %v", p.name, v)
		}
	}
}

// ---------------------------------------------------------------- mutation meta-test

func mutate(tb tables, which string, class, from, on, to int, res Outcome, do ...string) tables {
	c := tb
	var src *Table
	switch which {
	case "disc":
		src = tb.disc
	case "link":
		src = tb.link
	case "file":
		src = tb.file
	case "text":
		src = tb.text
	}
	m := src.clone(src.Name + "-mutant")
	k := [3]int{class, from, on}
	r := m.rows[k]
	r.To, r.Result, r.Do = to, res, append([]string(nil), do...)
	m.rows[k] = r
	switch which {
	case "disc":
		c.disc = m
	case "link":
		c.link = m
	case "file":
		c.file = m
	case "text":
		c.text = m
	}
	return c
}

// seeded defects, one per property; each MUST be caught, or that property
// test proves nothing.
var mutants = []struct {
	name     string
	property int // index into properties
	tb       func() tables
}{
	{"1.5 s grace: deadline sends a hello", 0, func() tables {
		return mutate(defaultTables, "disc", DCLegacy, DPassive, DDeadline, DGreeting, OK, AAnnounce)
	}},
	{"hello to an unhinted silent peer", 1, func() tables {
		return mutate(defaultTables, "disc", DCLegacy, DJoining, DPeerUnhinted, DGreeting, OK, AAnnounce, AReplay)
	}},
	{"decrypt before consent (Idle content)", 2, func() tables {
		return mutate(defaultTables, "file", LCInitiator, FIdle, FPeerContent, FInRecv, OK, ADecryptWrite)
	}},
	{"accept after expiry", 3, func() tables {
		return mutate(defaultTables, "file", LCResponder, FInExpired, FLocalAccept, FInRecv, OK, AAttachAccept)
	}},
	{"text lane fails closed on relay-renew 0x0d", 4, func() tables {
		return mutate(defaultTables, "text", LCInitiator, TOpen, TPeerUnknown, TFailed, FailLane)
	}},
	{"forged leave answered busy", 5, func() tables {
		return mutate(defaultTables, "link", LCInitiator, LOpen, LLeaveInvalid, Same, Drop, ASendBusy)
	}},
	{"responder reveals on an invalid reveal", 6, func() tables {
		return mutate(defaultTables, "link", LCResponder, LAnswered, LPeerRevealInvalid, LKeyedLanesPending, OK, ASendReveal, ADerive)
	}},
	{"ended file lane still answers BUSY", 7, func() tables {
		return mutate(defaultTables, "file", LCInitiator, FEnded, FPeerManifest, Same, OK, AFBusy)
	}},
	{"transport loss keeps the keys", 8, func() tables {
		return mutate(defaultTables, "link", LCInitiator, LOpen, LTransportLost, LClosed, FailLink, "report:connection-lost(no-recovery)")
	}},
}

func TestPropertyChecksCanFail(t *testing.T) {
	for _, mu := range mutants {
		v := properties[mu.property].check(mu.tb())
		if len(v) == 0 {
			t.Errorf("mutant %q not caught by %s", mu.name, properties[mu.property].name)
		} else {
			t.Logf("mutant %q caught by %s: %v", mu.name, properties[mu.property].name, v)
		}
	}
}

// TestExportTables writes every row as JSON when LINKSESSION_TABLES names a
// file, in the draft-vector machine shape, so the tables can be diffed against
// link-session-vectors.draft.json. It writes nothing otherwise.
func TestExportTables(t *testing.T) {
	path := os.Getenv("LINKSESSION_TABLES")
	if path == "" {
		t.Skip("set LINKSESSION_TABLES to export")
	}
	type row struct {
		Class, From, On, To string
		Result              Outcome
		Do                  []string
	}
	type machine struct {
		Name                    string
		Classes, States, Events []string
		Rows                    []row
	}
	var out []machine
	for _, tb := range allTables(defaultTables) {
		m := machine{Name: tb.Name, Classes: tb.Classes, States: tb.States, Events: tb.Events}
		for _, r := range tb.Rows() {
			to := tb.States[r.From]
			if r.To != Same {
				to = tb.States[r.To]
			}
			m.Rows = append(m.Rows, row{tb.Classes[r.Class], tb.States[r.From], tb.Events[r.On], to, r.Result, r.Do})
		}
		out = append(out, m)
	}
	b, err := json.MarshalIndent(out, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}
