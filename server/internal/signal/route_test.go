package signal

import "testing"

func TestRoomForCode(t *testing.T) {
	ok := func(string) bool { return true }
	room, max, lan, valid := RoomFor("424242", ok)
	if room != "c:424242" || max != 2 || lan || !valid {
		t.Fatalf("got %q %d lan=%v ok=%v", room, max, lan, valid)
	}
}

func TestRoomForResolvedUsesOpaqueGeneration(t *testing.T) {
	validateCalls := 0
	room, max, lan, ok := RoomForResolved("424242", func(string) bool {
		validateCalls++
		return true
	}, func(code string) (string, bool) {
		if code != "424242" {
			t.Fatalf("resolver code = %q", code)
		}
		return pairRoomForGeneration(code, "opaque"), true
	})
	if !ok || lan || max != 2 || room != "c:424242:opaque" {
		t.Fatalf("resolved room = (%q,%d,%v,%v)", room, max, lan, ok)
	}
	if validateCalls != 0 {
		t.Fatalf("legacy validator called %d times despite authoritative resolver", validateCalls)
	}
}

func TestRoomForResolvedRejectsUnknownCode(t *testing.T) {
	if _, _, _, ok := RoomForResolved("424242", nil, func(string) (string, bool) { return "", false }); ok {
		t.Fatal("resolver-refused code was admitted")
	}
}

func TestRoomForCodeRejected(t *testing.T) {
	no := func(string) bool { return false }
	if _, _, _, valid := RoomFor("424242", no); valid {
		t.Fatal("bad code must be rejected")
	}
	// nil validator also rejects.
	if _, _, _, ok := RoomFor("424242", nil); ok {
		t.Fatal("nil pair-validator must reject a code")
	}
}

func TestRoomForLAN(t *testing.T) {
	room, max, lan, valid := RoomFor("", nil)
	if room != "" || max != 0 || !lan || !valid {
		t.Fatalf("got %q %d lan=%v ok=%v", room, max, lan, valid)
	}
}
