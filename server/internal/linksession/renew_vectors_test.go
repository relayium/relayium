package linksession

// relay-renew/1 cross-platform vectors, consumed by Go (A11). The authority is
// web/src/lib/relay-renew-vectors.test.ts; the fixture is
// apps/RelayiumKit/Tests/Fixtures/relay-renew-vectors.json. Byte equality
// only: nothing here re-derives an expected value from the spec.

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/relayium/relayium/internal/linkcrypto"
)

const relayRenewVectorsPath = "../../../apps/RelayiumKit/Tests/Fixtures/relay-renew-vectors.json"

type rrVec struct {
	Case             string          `json:"case"`
	From             string          `json:"from"`
	To               string          `json:"to"`
	Epoch            uint32          `json:"epoch"`
	Round            uint32          `json:"round"`
	SDPType          string          `json:"sdpType"`
	SDP              string          `json:"sdp"`
	Candidate        string          `json:"candidate"`
	SDPMid           *string         `json:"sdpMid"`
	SDPMLineIndex    *uint32         `json:"sdpMLineIndex"`
	UsernameFragment string          `json:"usernameFragment"`
	Reason           string          `json:"reason"`
	Payload          string          `json:"payload"`
	PayloadUTF8Hex   string          `json:"payloadUtf8Hex"`
	Tag              string          `json:"tag"`
	Type             byte            `json:"type"`
	NonceHex         string          `json:"nonceHex"`
	NonceBase64      string          `json:"nonceBase64"`
	TagHex           string          `json:"tagHex"`
	FrameHex         string          `json:"frameHex"`
	JSON             json.RawMessage `json:"json"`
	Envelope         json.RawMessage `json:"envelope"`
	Pin              *struct {
		Fingerprints []string `json:"fingerprints"`
		Mids         []string `json:"mids"`
		Setup        string   `json:"setup"`
	} `json:"pin"`
	Ufrag           string `json:"ufrag"`
	MatchesAsOffer  *bool  `json:"matchesBaselineAsOffer"`
	MatchesAsAnswer *bool  `json:"matchesBaselineAsAnswer"`
}

type rrFixture struct {
	Capability       string             `json:"capability"`
	ResumeAuthKeyHex string             `json:"resumeAuthKeyHex"`
	Peers            map[string]string  `json:"peers"`
	Constants        map[string]int64   `json:"constants"`
	Payloads         map[string][]rrVec `json:"payloads"`
	ProbeFrames      []rrVec            `json:"probeFrames"`
	Envelopes        struct {
		Accept []rrVec `json:"accept"`
		Reject []rrVec `json:"reject"`
	} `json:"envelopes"`
	Server struct {
		Request rrVec `json:"request"`
		Grants  struct {
			Accept []rrVec `json:"accept"`
			Reject []rrVec `json:"reject"`
		} `json:"grants"`
	} `json:"server"`
	SdpPin                []rrVec `json:"sdpPin"`
	CandidateUfrag        []rrVec `json:"candidateUfrag"`
	InboundCandidateUfrag []rrVec `json:"inboundCandidateUfrag"`
}

func loadRelayRenewVectors(t *testing.T) (rrFixture, []byte) {
	t.Helper()
	raw, err := os.ReadFile(relayRenewVectorsPath)
	if err != nil {
		t.Fatalf("relay-renew vectors: %v", err)
	}
	var fx rrFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	key, err := hex.DecodeString(fx.ResumeAuthKeyHex)
	if err != nil || len(key) != 32 {
		t.Fatalf("key: %v", err)
	}
	return fx, key
}

func TestRelayRenewVectorsConstants(t *testing.T) {
	fx, _ := loadRelayRenewVectors(t)
	if fx.Capability != CapRenew {
		t.Fatalf("capability %q", fx.Capability)
	}
	want := map[string]int64{
		"probeKind": int64(RenewProbeKind), "probeVersion": int64(RenewProbeVersion),
		"probeTypeProbe": int64(RenewProbeTypeProbe), "probeTypeAck": int64(RenewProbeTypeAck),
		"probeFrameBytes": RenewProbeFrameBytes, "nonceBytes": RenewNonceBytes, "tagBytes": RenewTagBytes,
		"authLength": RenewAuthLength, "maxEpochsPerRound": RenewMaxEpochsPerRound,
		"maxProbeVerifications": RenewMaxProbeVerifications, "maxHeldCandidates": RenewMaxHeldCandidates,
		"probeRetryMs": RenewProbeRetry.Milliseconds(), "probeMaxSends": RenewProbeMaxSends,
		"prepareToReadyMs": RenewPrepareToReady.Milliseconds(), "readyToAnswerMs": RenewReadyToAnswer.Milliseconds(),
		"iceProbeMs": RenewICEProbe.Milliseconds(), "epochHardCapMs": RenewEpochHardCap.Milliseconds(),
		"prepareSilenceMs": RenewPrepareSilence.Milliseconds(),
	}
	for k, v := range want {
		got, ok := fx.Constants[k]
		if !ok || got != v {
			t.Errorf("constant %s: fixture %d (present %v), Go %d", k, got, ok, v)
		}
	}
	if len(fx.Constants) != len(want) {
		t.Errorf("fixture has %d constants, Go checks %d: a new one needs a Go consumer", len(fx.Constants), len(want))
	}
}

func TestRelayRenewVectorsPayloadsAndTags(t *testing.T) {
	fx, key := loadRelayRenewVectors(t)
	n := 0
	for typ, cases := range fx.Payloads {
		for _, v := range cases {
			sig := RenewSignal{Type: typ, Epoch: v.Epoch, Round: v.Round, SDPType: v.SDPType, SDP: v.SDP,
				Candidate: v.Candidate, SDPMid: v.SDPMid, SDPMLineIndex: v.SDPMLineIndex,
				UsernameFragment: v.UsernameFragment, Reason: v.Reason}
			p, err := RenewSignalPayload(sig, v.From, v.To)
			if err != nil {
				t.Fatalf("%s/%s: %v", typ, v.Case, err)
			}
			if p != v.Payload || hex.EncodeToString([]byte(p)) != v.PayloadUTF8Hex {
				t.Errorf("%s/%s payload\n got %q\nwant %q", typ, v.Case, p, v.Payload)
			}
			tag, err := linkcrypto.SignResume(key, p)
			if err != nil || tag != v.Tag {
				t.Errorf("%s/%s tag %s, want %s", typ, v.Case, tag, v.Tag)
			}
			// An envelope Go encodes parses back to the same signal, and the
			// tag verifies under the parsed payload.
			back, auth, ok := ParseRenewEnvelope(EncodeRenewEnvelope(sig, tag))
			if !ok || auth != tag {
				t.Fatalf("%s/%s: Go envelope does not parse", typ, v.Case)
			}
			bp, _ := RenewSignalPayload(back, v.From, v.To)
			if bp != p {
				t.Errorf("%s/%s: round-trip payload differs", typ, v.Case)
			}
			if !linkcrypto.VerifyResume(key, bp, auth) {
				t.Errorf("%s/%s: tag does not verify after round trip", typ, v.Case)
			}
			// Reflection: the reversed tuple must not verify.
			if rp, _ := RenewSignalPayload(sig, v.To, v.From); v.From != v.To && linkcrypto.VerifyResume(key, rp, tag) {
				t.Errorf("%s/%s: a reflected signal verified", typ, v.Case)
			}
			n++
		}
	}
	if n < 16 {
		t.Fatalf("only %d payload vectors consumed", n)
	}
}

func TestRelayRenewVectorsProbeFrames(t *testing.T) {
	fx, key := loadRelayRenewVectors(t)
	from, to := fx.Peers["from"], fx.Peers["to"]
	for _, v := range fx.ProbeFrames {
		nonce, _ := hex.DecodeString(v.NonceHex)
		if base64.StdEncoding.EncodeToString(nonce) != v.NonceBase64 {
			t.Fatalf("%s nonce base64", v.Case)
		}
		p, err := RenewProbePayload(v.Type == RenewProbeTypeAck, from, to, v.Epoch, v.Round, nonce)
		if err != nil || p != v.Payload {
			t.Errorf("%s payload\n got %q\nwant %q", v.Case, p, v.Payload)
		}
		r := &Renewal{key: key}
		if got := hex.EncodeToString(r.mac(p)); got != v.TagHex {
			t.Errorf("%s tag %s want %s", v.Case, got, v.TagHex)
		}
		f := RenewProbeFrame{Type: v.Type, Epoch: v.Epoch, Round: v.Round}
		copy(f.Nonce[:], nonce)
		tag, _ := hex.DecodeString(v.TagHex)
		copy(f.Tag[:], tag)
		frame := EncodeRenewProbe(f)
		if hex.EncodeToString(frame) != v.FrameHex {
			t.Errorf("%s frame\n got %x\nwant %s", v.Case, frame, v.FrameHex)
		}
		back, ok := DecodeRenewProbe(frame)
		if !ok || back != f {
			t.Errorf("%s: decode", v.Case)
		}
		// The receiving side verifies with the SENDER's tuple.
		rx := &Renewal{key: key, self: to, peer: from}
		if !rx.verifyFrame(back) {
			t.Errorf("%s: receiver cannot verify", v.Case)
		}
		reflected := &Renewal{key: key, self: from, peer: to}
		if reflected.verifyFrame(back) {
			t.Errorf("%s: a reflected frame verified", v.Case)
		}
		// Cheap checks: length, kind, version, type.
		for i, bad := range [][]byte{frame[:58], append(append([]byte{}, frame...), 0), {}, nil} {
			if _, ok := DecodeRenewProbe(bad); ok {
				t.Errorf("%s: bad length %d accepted", v.Case, i)
			}
		}
		for _, pos := range []struct {
			i int
			b byte
		}{{0, 0x09}, {1, 2}, {2, 3}, {2, 0}} {
			m := append([]byte{}, frame...)
			m[pos.i] = pos.b
			if _, ok := DecodeRenewProbe(m); ok {
				t.Errorf("%s: byte %d=%d accepted", v.Case, pos.i, pos.b)
			}
		}
		if !IsRenewControlFrame(frame) || !IsRenewControlFrame([]byte{0x0d}) || IsRenewControlFrame([]byte{0x09}) || IsRenewControlFrame(nil) {
			t.Errorf("%s: demux predicate", v.Case)
		}
	}
}

func TestRelayRenewVectorsEnvelopes(t *testing.T) {
	fx, key := loadRelayRenewVectors(t)
	from, to := fx.Peers["from"], fx.Peers["to"]
	for _, v := range fx.Envelopes.Accept {
		sig, auth, ok := ParseRenewEnvelope(v.JSON)
		if !ok {
			t.Errorf("accept %q refused", v.Case)
			continue
		}
		p, _ := RenewSignalPayload(sig, from, to)
		if !linkcrypto.VerifyResume(key, p, auth) {
			t.Errorf("accept %q: tag does not verify over the parsed signal", v.Case)
		}
		if !HasRenewKey(v.JSON) {
			t.Errorf("accept %q: not recognised as renewal", v.Case)
		}
	}
	for _, v := range fx.Envelopes.Reject {
		if _, _, ok := ParseRenewEnvelope(v.JSON); ok {
			t.Errorf("reject %q accepted (%s)", v.Case, v.JSON)
		}
	}
	if len(fx.Envelopes.Reject) < 20 {
		t.Fatalf("only %d reject vectors", len(fx.Envelopes.Reject))
	}
}

func TestRelayRenewVectorsServerRound(t *testing.T) {
	fx, _ := loadRelayRenewVectors(t)
	var env struct {
		Type string `json:"type"`
		Data struct {
			Round uint32 `json:"round"`
			RID   uint32 `json:"rid"`
		} `json:"data"`
	}
	if err := json.Unmarshal(fx.Server.Request.Envelope, &env); err != nil || env.Type != "ice-renew" {
		t.Fatalf("request envelope %s", fx.Server.Request.Envelope)
	}
	for _, v := range fx.Server.Grants.Accept {
		if _, ok := ParseIceGrant(v.JSON); !ok {
			t.Errorf("grant accept %q refused", v.Case)
		}
	}
	for _, v := range fx.Server.Grants.Reject {
		if _, ok := ParseIceGrant(v.JSON); ok {
			t.Errorf("grant reject %q accepted", v.Case)
		}
	}
}

func TestRelayRenewVectorsSdpPinAndUfrags(t *testing.T) {
	fx, _ := loadRelayRenewVectors(t)
	if len(fx.SdpPin) == 0 || fx.SdpPin[0].Pin == nil {
		t.Fatal("no baseline")
	}
	base := SdpPinOf(fx.SdpPin[0].SDP)
	bp := fx.SdpPin[0].Pin
	if !equalStrings(base.Fingerprints, bp.Fingerprints) || !equalStrings(base.Mids, bp.Mids) || base.Setup != bp.Setup {
		t.Fatalf("baseline pin %+v, want %+v", base, *bp)
	}
	for _, v := range fx.SdpPin {
		if got := SdpIceUfrag(v.SDP); got != v.Ufrag {
			t.Errorf("%s ufrag %q want %q", v.Case, got, v.Ufrag)
		}
		if v.MatchesAsOffer != nil {
			if got := SdpPinMatches(base, SdpPinOf(v.SDP), false); got != *v.MatchesAsOffer {
				t.Errorf("%s as offer: %v", v.Case, got)
			}
		}
		if v.MatchesAsAnswer != nil {
			if got := SdpPinMatches(base, SdpPinOf(v.SDP), true); got != *v.MatchesAsAnswer {
				t.Errorf("%s as answer: %v", v.Case, got)
			}
		}
	}
	for _, v := range fx.CandidateUfrag {
		if got := CandidateUfrag(v.Candidate); got != v.Ufrag {
			t.Errorf("candidateUfrag %s: %q want %q", v.Case, got, v.Ufrag)
		}
	}
	for _, v := range fx.InboundCandidateUfrag {
		if got := InboundCandidateUfrag(v.Candidate, v.UsernameFragment); got != v.Ufrag {
			t.Errorf("inboundCandidateUfrag %s: %q want %q", v.Case, got, v.Ufrag)
		}
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
