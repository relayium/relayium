package signal

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// The link-pairing roster hint (relayium-signaling-v1 "Protocol hint").
//
// What these tests pin, in order of how much damage breaking it would do:
//
//  1. A peer that sends no hint — every client shipped today — gets the exact
//     bytes it got before hints existed: welcome and roster alike.
//  2. A malformed hint can never fail a join. Older servers ignore unknown
//     fields, so a decoder that rejected the envelope would turn a harmless
//     optional field into a refused connection.
//  3. The server never repeats a string it does not know.
//  4. The LAN room ignores the field, and device grouping is untouched by it.

func TestParseProtoHint(t *testing.T) {
	valid := []struct {
		raw  string
		want ProtoHint
	}{
		{`["link/1"]`, ProtoHint{"link/1"}},
		// JSON escaping is decoded before the byte comparison, so this is the
		// same token and not a different spelling of one.
		{`["link\/1"]`, ProtoHint{"link/1"}},
		// Duplicates of a known token are within the rule; the echo is
		// canonical (once each), so repetition carries no information.
		{`["link/1","link/1"]`, ProtoHint{"link/1"}},
		{`["link/1","link/1","link/1","link/1"]`, ProtoHint{"link/1"}},
	}
	for _, tc := range valid {
		if got := ParseProtoHint([]byte(tc.raw)); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("ParseProtoHint(%s) = %#v, want %#v", tc.raw, got, tc.want)
		}
	}

	absent := []string{
		`null`,
		`[]`,
		`"link/1"`,
		`{"link/1":true}`,
		`1`,
		`true`,
		`[1]`,
		`[null]`,
		`[["link/1"]]`,
		`[{"t":"link/1"}]`,
		`["LINK/1"]`,
		`["link/2"]`,
		`["link/1 "]`,
		`[" link/1"]`,
		`["link/1\u0000"]`,
		`[""]`,
		`["preupload/1"]`,
		// One unknown token poisons the whole hint: partial acceptance would
		// let the rest of the array ride along as a probe.
		`["link/1","covert"]`,
		`["covert","link/1"]`,
		`["link/1",1]`,
		// Oversize: five entries, even of the known token, is not truncated.
		`["link/1","link/1","link/1","link/1","link/1"]`,
	}
	for _, raw := range absent {
		if got := ParseProtoHint([]byte(raw)); got != nil {
			t.Errorf("ParseProtoHint(%s) = %#v, want absent (nil)", raw, got)
		}
	}
}

// The canonical form is also enforced on hints a Go caller builds by hand, so
// the hub's rule does not depend on the wire decoder having run.
func TestProtoHintCanonical(t *testing.T) {
	cases := []struct {
		in   ProtoHint
		want ProtoHint
	}{
		{nil, nil},
		{ProtoHint{}, nil},
		{ProtoHint{"link/1"}, ProtoHint{"link/1"}},
		{ProtoHint{"link/1", "link/1"}, ProtoHint{"link/1"}},
		{ProtoHint{"bogus"}, nil},
		{ProtoHint{"link/1", "bogus"}, nil},
		{ProtoHint{"link/1", "link/1", "link/1", "link/1", "link/1"}, nil},
	}
	for _, tc := range cases {
		if got := tc.in.Canonical(); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%#v.Canonical() = %#v, want %#v", tc.in, got, tc.want)
		}
	}
	if !(ProtoHint{"link/1"}).Has(ProtoLink1) || (ProtoHint(nil)).Has(ProtoLink1) {
		t.Fatal("Has must report exactly the named token")
	}
}

// A bad hint must not make the envelope undecodable. Before hints, `proto` was
// an unknown field and every one of these joins was admitted.
func TestDecodeEnvelopeToleratesAnyProto(t *testing.T) {
	for _, proto := range []string{`"link/1"`, `{}`, `5`, `null`, `[1,2]`, `["x","y","z","w","v"]`, `[["link/1"]]`} {
		frame := `{"type":"join","name":"cli","proto":` + proto + `}`
		e, err := DecodeEnvelope([]byte(frame))
		if err != nil {
			t.Fatalf("%s: decode failed: %v", frame, err)
		}
		if e.Type != TypeJoin || e.Name != "cli" || e.Proto != nil {
			t.Fatalf("%s: got %+v, want a join with an absent hint", frame, e)
		}
	}
	e, err := DecodeEnvelope([]byte(`{"type":"join","name":"cli","proto":["link/1"]}`))
	if err != nil || !reflect.DeepEqual(e.Proto, ProtoHint{"link/1"}) {
		t.Fatalf("valid hint: got %+v err=%v", e, err)
	}
}

// Unhinted shapes are byte-for-byte what the server emitted before hints.
func TestUnhintedEncodingUnchanged(t *testing.T) {
	cases := []struct {
		e    Envelope
		want string
	}{
		{Envelope{Type: TypeWelcome, Name: "p1", IP: "127.0.0.1"}, `{"type":"welcome","name":"p1","ip":"127.0.0.1"}`},
		{Envelope{Type: TypeWelcome, Name: "p1", IP: "127.0.0.1", Proto: ProtoHint{}}, `{"type":"welcome","name":"p1","ip":"127.0.0.1"}`},
		{Envelope{Type: TypePeers, Peers: []Peer{{ID: "p1", Name: "A"}, {ID: "p2", Name: "B", Proto: ProtoHint{}}}},
			`{"type":"peers","peers":[{"id":"p1","name":"A"},{"id":"p2","name":"B"}]}`},
		{Envelope{Type: TypePeers}, `{"type":"peers","peers":[]}`},
	}
	for _, tc := range cases {
		b, err := EncodeEnvelope(tc.e)
		if err != nil || string(b) != tc.want {
			t.Errorf("EncodeEnvelope(%+v) = %s (err %v), want %s", tc.e, b, err, tc.want)
		}
	}
}

// ── through the real websocket path ──────────────────────────────────────────

// readRaw reads frames until one of type typ arrives and returns its exact
// bytes. Raw bytes, not a decoded Envelope, because "byte-identical" is the
// claim under test.
func readRaw(t *testing.T, ctx context.Context, c *websocket.Conn, typ string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		rctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		_, data, err := c.Read(rctx)
		cancel()
		if err != nil {
			t.Fatalf("read %s: %v", typ, err)
		}
		var head struct{ Type string }
		if json.Unmarshal(data, &head) == nil && head.Type == typ {
			return string(data)
		}
	}
	t.Fatalf("no %s frame", typ)
	return ""
}

// readRosterRaw reads until a roster with `want` entries arrives.
func readRosterRaw(t *testing.T, ctx context.Context, c *websocket.Conn, want int) string {
	t.Helper()
	for i := 0; i < 8; i++ {
		raw := readRaw(t, ctx, c, TypePeers)
		e, err := DecodeEnvelope([]byte(raw))
		if err == nil && len(e.Peers) == want {
			return raw
		}
	}
	t.Fatalf("no roster with %d entries", want)
	return ""
}

// Two peers that send no hint: exactly the frames the pre-hint server sent.
// These literals were produced by the server at 723481c78, before this change
// (see the A08a log); the test is the regression pin for that equality.
func TestCodeRoomUnhintedBytesIdentical(t *testing.T) {
	dial, ctx := wsFixture(t, "c:123456", 2, false)
	a := dial()
	writeFrame(t, ctx, a, map[string]any{"type": "join", "name": "A"})
	if got, want := readRaw(t, ctx, a, TypeWelcome), `{"type":"welcome","name":"p1","ip":"127.0.0.1"}`; got != want {
		t.Fatalf("welcome = %s, want %s", got, want)
	}
	b := dial()
	writeFrame(t, ctx, b, map[string]any{"type": "join", "name": "B"})
	if got, want := readRaw(t, ctx, b, TypeWelcome), `{"type":"welcome","name":"p2","ip":"127.0.0.1"}`; got != want {
		t.Fatalf("welcome = %s, want %s", got, want)
	}
	want := `{"type":"peers","peers":[{"id":"p1","name":"A"},{"id":"p2","name":"B"}]}`
	for _, c := range []*websocket.Conn{a, b} {
		if got := readRosterRaw(t, ctx, c, 2); got != want {
			t.Fatalf("roster = %s, want %s", got, want)
		}
	}
}

// A hinted peer next to an unhinted one: the echo reaches only the hinted
// joiner, the hint rides only on its own entry, and the unhinted peer's welcome
// and entry keep the old bytes.
func TestCodeRoomHintEchoAndRoster(t *testing.T) {
	dial, ctx := wsFixture(t, "c:123456", 2, false)
	cli := dial()
	writeFrame(t, ctx, cli, map[string]any{"type": "join", "name": "A", "proto": []string{"link/1"}})
	if got, want := readRaw(t, ctx, cli, TypeWelcome), `{"type":"welcome","name":"p1","ip":"127.0.0.1","proto":["link/1"]}`; got != want {
		t.Fatalf("hinted welcome = %s, want %s", got, want)
	}
	app := dial()
	writeFrame(t, ctx, app, map[string]any{"type": "join", "name": "B"})
	if got, want := readRaw(t, ctx, app, TypeWelcome), `{"type":"welcome","name":"p2","ip":"127.0.0.1"}`; got != want {
		t.Fatalf("unhinted welcome = %s, want %s", got, want)
	}
	want := `{"type":"peers","peers":[{"id":"p1","name":"A","proto":["link/1"]},{"id":"p2","name":"B"}]}`
	for _, c := range []*websocket.Conn{cli, app} {
		if got := readRosterRaw(t, ctx, c, 2); got != want {
			t.Fatalf("roster = %s, want %s", got, want)
		}
	}
}

// Every invalid hint is admitted as an unhinted join: same welcome bytes, same
// roster bytes, no echo of anything the client wrote.
func TestCodeRoomInvalidHintIsAbsent(t *testing.T) {
	bad := []any{
		"link/1",
		[]string{},
		[]string{"LINK/1"},
		[]string{"link/2"},
		[]string{"link/1", "covert"},
		[]string{"link/1", "link/1", "link/1", "link/1", "link/1"},
		[]any{1},
		map[string]any{"link/1": true},
		nil,
	}
	for _, proto := range bad {
		dial, ctx := wsFixture(t, "c:654321", 2, false)
		c := dial()
		writeFrame(t, ctx, c, map[string]any{"type": "join", "name": "A", "proto": proto})
		if got, want := readRaw(t, ctx, c, TypeWelcome), `{"type":"welcome","name":"p1","ip":"127.0.0.1"}`; got != want {
			t.Fatalf("proto=%#v: welcome = %s, want %s", proto, got, want)
		}
		if got, want := readRosterRaw(t, ctx, c, 1), `{"type":"peers","peers":[{"id":"p1","name":"A"}]}`; got != want {
			t.Fatalf("proto=%#v: roster = %s, want %s", proto, got, want)
		}
	}
}

// The LAN room ignores the hint entirely, the way a code room ignores deviceId,
// and a hint does not change how installations are grouped there.
func TestLanRoomIgnoresHint(t *testing.T) {
	dial, ctx := wsFixture(t, "ip:198.51.100.4", 0, true)
	a1 := dial()
	a2 := dial()
	b := dial()
	writeFrame(t, ctx, a1, map[string]any{"type": "join", "name": "A", "deviceId": devA, "active": true, "proto": []string{"link/1"}})
	if got := readRaw(t, ctx, a1, TypeWelcome); strings.Contains(got, "proto") {
		t.Fatalf("LAN welcome echoed a hint: %s", got)
	}
	writeFrame(t, ctx, a2, map[string]any{"type": "join", "name": "A", "deviceId": devA, "proto": []string{"link/1"}})
	writeFrame(t, ctx, b, map[string]any{"type": "join", "name": "B", "deviceId": devB})
	got := readRosterRaw(t, ctx, b, 1)
	if want := `{"type":"peers","peers":[{"id":"p1","name":"A"}]}`; got != want {
		t.Fatalf("LAN roster = %s, want %s (one grouped entry, no hint)", got, want)
	}
}

// A peer cannot make a hint appear on a relayed frame: the field is
// server-authored on welcome and roster only.
func TestRelayedSignalCarriesNoHint(t *testing.T) {
	dial, ctx := wsFixture(t, "c:123456", 2, false)
	a := dial()
	b := dial()
	writeFrame(t, ctx, a, map[string]any{"type": "join", "name": "A"})
	writeFrame(t, ctx, b, map[string]any{"type": "join", "name": "B"})
	readRosterRaw(t, ctx, a, 2)
	writeFrame(t, ctx, a, map[string]any{"type": "signal", "to": "p2", "data": map[string]any{"x": 1}, "proto": []string{"link/1"}})
	if got, want := readRaw(t, ctx, b, TypeSignal), `{"type":"signal","from":"p1","to":"p2","data":{"x":1}}`; got != want {
		t.Fatalf("relayed = %s, want %s", got, want)
	}
}

// ── the hub directly ─────────────────────────────────────────────────────────

// The hub re-validates whatever a Go caller hands it.
func TestHubRevalidatesHint(t *testing.T) {
	h := syncHub()
	c := &fakeConn{}
	h.JoinDeviceLimitedObservedMembers("r", "p1", "A", c, 0, "", "", false, "link/1", "covert")
	if w := c.sent[0]; w.Type != TypeWelcome || w.Proto != nil {
		t.Fatalf("welcome carried an invalid hint: %+v", w)
	}
	if r := c.last(); r.Type != TypePeers || r.Peers[0].Proto != nil {
		t.Fatalf("roster carried an invalid hint: %+v", r)
	}
}

// Grouping is a function of deviceId alone. The same membership with and
// without hints yields the same entries, representatives and order; the hint
// on each entry is the representative's own.
func TestHintDoesNotChangeGrouping(t *testing.T) {
	type join struct {
		id, name, device string
		active           bool
		proto            ProtoHint
	}
	joins := []join{
		{"p1", "A", devA, true, ProtoHint{"link/1"}},
		{"p2", "A", devA, false, nil},
		{"p3", "B", devB, false, ProtoHint{"link/1"}},
		{"p4", "C", "", false, ProtoHint{"link/1"}},
		{"p5", "C", "", false, nil},
	}
	run := func(withHints bool) (map[string][]Peer, []bool) {
		h := syncHub()
		conns := map[string]*fakeConn{}
		var admitted []bool
		for _, j := range joins {
			c := &fakeConn{}
			conns[j.id] = c
			var p ProtoHint
			if withHints {
				p = j.proto
			}
			ok, _, _ := h.JoinDeviceLimitedObservedMembers("lan", j.id, j.name, c, 4, "", j.device, j.active, p...)
			admitted = append(admitted, ok)
		}
		out := map[string][]Peer{}
		for id, c := range conns {
			if countType(c, TypePeers) > 0 {
				out[id] = c.last().Peers
			}
		}
		return out, admitted
	}
	plain, admittedPlain := run(false)
	hinted, admittedHinted := run(true)
	if !reflect.DeepEqual(admittedPlain, admittedHinted) {
		t.Fatalf("admission differs: %v vs %v", admittedPlain, admittedHinted)
	}
	strip := func(ps []Peer) []Peer {
		out := make([]Peer, len(ps))
		for i, p := range ps {
			out[i] = Peer{ID: p.ID, Name: p.Name}
		}
		return out
	}
	protoOf := map[string]ProtoHint{}
	for _, j := range joins {
		protoOf[j.id] = j.proto.Canonical()
	}
	for id, ps := range plain {
		if !reflect.DeepEqual(ps, strip(hinted[id])) {
			t.Fatalf("recipient %s: grouping differs\nplain  %+v\nhinted %+v", id, ps, hinted[id])
		}
		for _, p := range ps {
			if p.Proto != nil {
				t.Fatalf("recipient %s: unhinted run leaked a hint: %+v", id, p)
			}
		}
		for _, p := range hinted[id] {
			if !reflect.DeepEqual(p.Proto, protoOf[p.ID]) {
				t.Fatalf("recipient %s: entry %s carries %#v, its representative sent %#v", id, p.ID, p.Proto, protoOf[p.ID])
			}
		}
	}
	// Sanity on the fixture itself: the A group is represented by the active
	// page, so the hint shown for device A is p1's.
	if got := hinted["p3"]; len(got) != 3 || got[0].ID != "p1" || !got[0].Proto.Has(ProtoLink1) {
		t.Fatalf("B's roster = %+v, want A represented by p1 (hinted)", got)
	}
}

// ── the cross-language fixture row ───────────────────────────────────────────

// The roster tolerance row in realtime-wire-vectors.json is what the Web,
// Apple and Android decoders are pinned against. This test makes it a claim
// about THIS server: the frames are exactly what it encodes for that room.
func TestRosterHintFixtureIsServerBytes(t *testing.T) {
	raw, err := os.ReadFile("../../../apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var doc struct {
		Roster struct {
			ProtoHint struct {
				WelcomeFrame string `json:"welcomeFrame"`
				PeersFrame   string `json:"peersFrame"`
				SelfID       string `json:"selfId"`
				IP           string `json:"ip"`
				Peers        []struct {
					ID    string   `json:"id"`
					Name  string   `json:"name"`
					Proto []string `json:"proto"`
				} `json:"peers"`
			} `json:"protoHint"`
		} `json:"roster"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	row := doc.Roster.ProtoHint
	if row.PeersFrame == "" || len(row.Peers) == 0 {
		t.Fatal("fixture has no roster.protoHint row; run `node scripts/gen-realtime-wire-vectors.mjs` from web/")
	}
	welcome, _ := EncodeEnvelope(Envelope{Type: TypeWelcome, Name: row.SelfID, IP: row.IP, Proto: ProtoHint{ProtoLink1}})
	if string(welcome) != row.WelcomeFrame {
		t.Fatalf("server welcome %s != fixture %s", welcome, row.WelcomeFrame)
	}
	peers := make([]Peer, 0, len(row.Peers))
	hinted, unhinted := 0, 0
	for _, p := range row.Peers {
		peers = append(peers, Peer{ID: p.ID, Name: p.Name, Proto: ProtoHint(p.Proto).Canonical()})
		if len(p.Proto) > 0 {
			hinted++
		} else {
			unhinted++
		}
	}
	if hinted == 0 || unhinted == 0 {
		t.Fatalf("the row must mix a hinted and an unhinted entry, got %d/%d", hinted, unhinted)
	}
	roster, _ := EncodeEnvelope(Envelope{Type: TypePeers, Peers: peers})
	if string(roster) != row.PeersFrame {
		t.Fatalf("server roster %s != fixture %s", roster, row.PeersFrame)
	}
	// And the server's own decoder reads it back to the same entries.
	e, err := DecodeEnvelope([]byte(row.PeersFrame))
	if err != nil || !reflect.DeepEqual(e.Peers, peers) {
		t.Fatalf("decode fixture roster: %+v err=%v", e.Peers, err)
	}
}
