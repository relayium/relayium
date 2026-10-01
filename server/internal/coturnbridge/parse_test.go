package coturnbridge

import (
	"errors"
	"strings"
	"testing"
)

const tUser = "1790167572:0123456789abcdef0123456789abcdef.g0123456789abcdef0123456789abcdef"

func ch(kind string) string {
	return "turn/realm/relayium.com/user/" + tUser + "/allocation/007000000000000001/" + kind
}

// Payloads below are byte-for-byte coturn 4.6.1 formats (see the 09-23 repro
// events.jsonl and ns_ioalib_engine_impl.c).
func TestParseMessage(t *testing.T) {
	for _, c := range []struct {
		channel, payload, kind string
		bytes                  uint64
	}{
		{ch("traffic"), "rcvp=1029, rcvb=1024268, sentp=1029, sentb=1023912", KindTraffic, 1024268 + 1023912},
		{ch("total_traffic"), "rcvp=3011, rcvb=3013308, sentp=3011, sentb=3012920", KindTotal, 3013308 + 3012920},
		// uint32-wrapping peer counters are never used.
		{ch("traffic/peer"), "rcvp=1019, rcvb=1019000, sentp=1019, sentb=1019000", KindIgnored, 0},
		{ch("total_traffic/peer"), "rcvp=3000, rcvb=3000000, sentp=3000, sentb=3000000", KindIgnored, 0},
		{ch("status"), "new lifetime=777, type=UDP, local=127.0.0.1:34780, remote=127.0.0.1:64996, ssl=NONE, cipher=NONE", KindNew, 0},
		{ch("status"), "refreshed lifetime=0, type=UDP, local=127.0.0.1:34780, remote=127.0.0.1:60776, ssl=NONE, cipher=NONE", KindRefreshed, 0},
		{ch("status"), "deleted", KindDeleted, 0},
		{ch("traffic"), "rcvp=0, rcvb=18446744073709551615, sentp=0, sentb=0", "", 0}, // > 2^62: malformed
		// A STUN-only session (no username), exactly as the 2026-10-01 provider
		// run captured it for a Binding request: counted, never an allocation.
		{"turn/realm/relayium.com/user//allocation/000000000000000001/traffic", "rcvp=1, rcvb=20, sentp=1, sentb=88", KindUnattributed, 108},
		{"turn/realm/relayium.com/user//allocation/000000000000000001/traffic/peer", "rcvp=0, rcvb=0, sentp=0, sentb=0", KindUnattributed, 0},
	} {
		ev, err := ParseMessage("relayium.com", c.channel, c.payload)
		if c.kind == "" {
			if !errors.Is(err, ErrMalformed) {
				t.Fatalf("%q accepted: %+v", c.payload, ev)
			}
			continue
		}
		wantUser, wantSID := tUser, "007000000000000001"
		if c.kind == KindUnattributed {
			wantUser, wantSID = "", "000000000000000001"
		}
		if err != nil || ev.Kind != c.kind || ev.Bytes != c.bytes || ev.Username != wantUser || ev.SessionID != wantSID {
			t.Fatalf("%s %q: %+v %v", c.channel, c.payload, ev, err)
		}
	}
}

func TestParseMessageRejectsMalformed(t *testing.T) {
	good := "rcvp=1, rcvb=2, sentp=3, sentb=4"
	for _, c := range []struct{ realm, channel, payload string }{
		{"other.realm", ch("traffic"), good},
		{"relayium.com", strings.Replace(ch("traffic"), tUser, "static-user", 1), good},
		{"relayium.com", strings.Replace(ch("traffic"), "007000000000000001", "7000000000000001", 1), good},
		{"relayium.com", ch("traffic/extra"), good},
		{"relayium.com", ch("traffic"), "rcvp=1, rcvb=2, sentp=3"},
		{"relayium.com", ch("traffic"), "rcvp=1,rcvb=2,sentp=3,sentb=4"},
		{"relayium.com", ch("traffic"), "rcvp=1, rcvb=-2, sentp=3, sentb=4"},
		{"relayium.com", ch("traffic"), "rcvp=1, rcvb=2, sentp=3, sentb=4 "},
		{"relayium.com", "turn/realm/relayium.com/user//allocation/000000000000000001/traffic", "rcvp=1, rcvb=20"},
		{"relayium.com", "turn/realm/relayium.com/user//allocation/000000000000000001/bogus", good},
		{"relayium.com", ch("traffic"), "rcvp=1, rcvb=123456789012345678901, sentp=3, sentb=4"},
		{"", ch("traffic"), good},
	} {
		if _, err := ParseMessage(c.realm, c.channel, c.payload); !errors.Is(err, ErrMalformed) {
			t.Fatalf("accepted %q %q %q", c.realm, c.channel, c.payload)
		}
	}
}

// A psd dump exactly as print_sessions writes it into a file (cs->f set).
const psdTwo = `
    1) id=007000000000000001, user <` + tUser + `>:
      realm: relayium.com
      started 12 secs ago
      expiring in 588 secs
      client protocol UDP, relay protocol UDP
      client addr 127.0.0.1:60776, server addr 127.0.0.1:34780
      relay addr 127.0.0.1:55001
      fingerprints enforced: OFF
      mobile: OFF
      usage: rp=2000, rb=2000000, sp=1990, sb=1990000
       rate: r=166666, s=165833, total=332499 (bytes per sec)
      peers:
          127.0.0.1:34790

    2) id=005000000000000002, user <static-user>:
      realm: relayium.com
      started undefined time
      expired
      client protocol TCP, relay protocol UDP
      client addr 127.0.0.1:1, server addr 127.0.0.1:2
      fingerprints enforced: OFF
      mobile: OFF
      usage: rp=1, rb=10, sp=1, sb=10
       rate: r=0, s=0, total=0 (bytes per sec)

  Total sessions: 2

`

func TestParsePSDComplete(t *testing.T) {
	got, err := ParsePSD([]byte(psdTwo))
	if err != nil {
		t.Fatal(err)
	}
	// The foreign (non-Relayium) username is counted for completeness but not
	// returned: it cannot be attributed.
	if len(got) != 1 || got[0].SessionID != "007000000000000001" || got[0].Username != tUser || got[0].Bytes != 3990000 || got[0].StartedAgo != 12 {
		t.Fatalf("parsed %+v", got)
	}
	empty, err := ParsePSD([]byte("\n  Total sessions: 0\n\n"))
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty listing: %v %v", empty, err)
	}
}

// No truncated or partial listing is ever used as evidence.
func TestParsePSDRejectsIncomplete(t *testing.T) {
	cut := strings.Index(psdTwo, "  Total sessions")
	for name, in := range map[string]string{
		"truncated before total": psdTwo[:cut],
		"truncated mid-session":  psdTwo[:strings.Index(psdTwo, "      usage: rp=1,")],
		"no trailing newline":    strings.TrimSuffix(psdTwo, "\n"),
		"total mismatch":         strings.Replace(psdTwo, "Total sessions: 2", "Total sessions: 3", 1),
		"index gap":              strings.Replace(psdTwo, "    2) id=", "    3) id=", 1),
		"missing usage":          strings.Replace(psdTwo, "      usage: rp=2000, rb=2000000, sp=1990, sb=1990000\n", "", 1),
		"duplicate usage":        strings.Replace(psdTwo, "      mobile: OFF\n      usage: rp=2000", "      usage: rp=1, rb=1, sp=1, sb=1\n      usage: rp=2000", 1),
		"text after total":       psdTwo + "garbage\n",
		"unexpected line":        strings.Replace(psdTwo, "\n    1) id=", "\nCannot open file for writing\n    1) id=", 1),
		"usage out of range":     strings.Replace(psdTwo, "rb=2000000,", "rb=99999999999999999999,", 1),
		"telnet cursor in file":  strings.Replace(psdTwo, "  Total sessions: 2", "> ", 1),
		"empty":                  "",
	} {
		if _, err := ParsePSD([]byte(in)); !errors.Is(err, ErrPSDIncomplete) {
			t.Errorf("%s: accepted (%v)", name, err)
		}
	}
}
