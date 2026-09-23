package linkrtc

import (
	"errors"
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/relayium/relayium/internal/linkwire"
)

func TestNewBudget(t *testing.T) {
	cases := []struct {
		transport, local uint32
		want             Budget
		err              bool
	}{
		// Pion/Firefox advertise 1 GiB: clamped to our own ceiling.
		{1073741823, 0, Budget{262144, linkwire.ChunkSize, linkwire.TextMaxBytes}, false},
		{262144, 0, Budget{262144, linkwire.ChunkSize, linkwire.TextMaxBytes}, false},
		// Peer omitted a=max-message-size: Pion enforces 65 535.
		{65535, 0, Budget{65535, 65514, 65514}, false},
		{65536, 0, Budget{65536, 65515, 65515}, false},
		// Our own forced ceiling wins over a larger peer.
		{262144, 65536, Budget{65536, 65515, 65515}, false},
		{196629, 0, Budget{196629, linkwire.ChunkSize, linkwire.TextMaxBytes}, false},
		{linkwire.MinPieceBytes + linkwire.ChunkOverhead, 0, Budget{4117, 4096, 4096}, false},
		{linkwire.MinPieceBytes + linkwire.ChunkOverhead - 1, 0, Budget{}, true},
		{0, 0, Budget{}, true}, // no association
	}
	for _, c := range cases {
		got, err := NewBudget(c.transport, c.local)
		if (err != nil) != c.err || got != c.want {
			t.Errorf("NewBudget(%d,%d) = %+v, %v; want %+v err=%v", c.transport, c.local, got, err, c.want, c.err)
		}
		if err != nil && !errors.Is(err, linkwire.ErrPieceTooSmall) {
			t.Errorf("error %v does not wrap ErrPieceTooSmall", err)
		}
	}
	b, _ := NewBudget(65536, 0)
	if !b.FitsText(65515) || b.FitsText(65516) || b.FitsText(-1) {
		t.Error("FitsText boundary")
	}
}

func cand(typ webrtc.ICECandidateType, addr string) *webrtc.ICECandidate {
	return &webrtc.ICECandidate{Typ: typ, Address: addr, Protocol: webrtc.ICEProtocolUDP}
}

func TestClassify(t *testing.T) {
	host, srflx, prflx, relay := webrtc.ICECandidateTypeHost, webrtc.ICECandidateTypeSrflx,
		webrtc.ICECandidateTypePrflx, webrtc.ICECandidateTypeRelay
	cases := []struct {
		name string
		pair *webrtc.ICECandidatePair
		want Path
	}{
		{"nil", nil, PathUnknown},
		{"missing remote", &webrtc.ICECandidatePair{Local: cand(host, "10.0.0.1")}, PathUnknown},
		{"relay local", webrtc.NewICECandidatePair(cand(relay, "203.0.113.5"), cand(host, "10.0.0.2")), PathRelay},
		{"relay remote", webrtc.NewICECandidatePair(cand(srflx, "198.51.100.1"), cand(relay, "203.0.113.5")), PathRelay},
		{"relay both private", webrtc.NewICECandidatePair(cand(relay, "127.0.0.1"), cand(relay, "127.0.0.1")), PathRelay},
		{"host private", webrtc.NewICECandidatePair(cand(host, "192.168.1.2"), cand(host, "192.168.1.3")), PathLAN},
		{"host loopback", webrtc.NewICECandidatePair(cand(host, "127.0.0.1"), cand(host, "127.0.0.1")), PathLAN},
		{"host ula", webrtc.NewICECandidatePair(cand(host, "fd00::1"), cand(host, "fd00::2")), PathLAN},
		{"host link-local v6", webrtc.NewICECandidatePair(cand(host, "fe80::1"), cand(host, "fe80::2")), PathLAN},
		{"host v4-mapped private", webrtc.NewICECandidatePair(cand(host, "::ffff:10.0.0.1"), cand(host, "10.0.0.2")), PathLAN},
		{"host public", webrtc.NewICECandidatePair(cand(host, "8.8.8.8"), cand(host, "10.0.0.2")), PathDirect},
		{"host mdns", webrtc.NewICECandidatePair(cand(host, "abc.local"), cand(host, "10.0.0.2")), PathDirect},
		{"srflx", webrtc.NewICECandidatePair(cand(srflx, "198.51.100.1"), cand(host, "10.0.0.2")), PathDirect},
		{"prflx", webrtc.NewICECandidatePair(cand(prflx, "10.0.0.1"), cand(prflx, "10.0.0.2")), PathDirect},
	}
	for _, c := range cases {
		if got := Classify(c.pair); got.Path != c.want {
			t.Errorf("%s: %s, want %s", c.name, got.Path, c.want)
		}
	}
	info := Classify(webrtc.NewICECandidatePair(cand(relay, "1.2.3.4"), cand(host, "10.0.0.2")))
	if info.LocalType != "relay" || info.RemoteType != "host" || info.Protocol != "udp" {
		t.Errorf("info %+v", info)
	}
}

func TestNewAPIRejectsNonIPAdvertise(t *testing.T) {
	if _, err := NewAPI(Options{AdvertiseIPs: []string{"example.com"}}); err == nil {
		t.Fatal("hostname accepted as advertise address")
	}
	if _, err := NewAPI(Options{AdvertiseIPs: []string{"203.0.113.9"}}); err != nil {
		t.Fatal(err)
	}
}

func TestRoleAndSDPTypeGuards(t *testing.T) {
	a, b := newPair(t, pairOpts{})
	if err := b.c.Offer(); !errors.Is(err, ErrWrongRole) {
		t.Fatalf("responder offer: %v", err)
	}
	if err := a.c.SetRemote(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "x"}); !errors.Is(err, ErrSDPType) {
		t.Fatalf("initiator given an offer: %v", err)
	}
	if err := b.c.SetRemote(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: "x"}); !errors.Is(err, ErrSDPType) {
		t.Fatalf("responder given an answer: %v", err)
	}
	if err := a.c.RestartICE(); err == nil {
		t.Fatal("restart before offer accepted")
	}
	if err := a.c.Attach(func([]byte) {}, func([]byte) {}); !errors.Is(err, ErrNotOpen) {
		t.Fatalf("attach before open: %v", err)
	}
	if _, err := a.c.Budget(); !errors.Is(err, ErrNotOpen) {
		t.Fatalf("budget before open: %v", err)
	}
}
