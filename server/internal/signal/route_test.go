package signal

import "testing"

func TestRoomForCode(t *testing.T) {
	ok := func(string) bool { return true }
	room, max, lan, valid := RoomFor("424242", "", ok, nil)
	if room != "c:424242" || max != 2 || lan || !valid {
		t.Fatalf("got %q %d lan=%v ok=%v", room, max, lan, valid)
	}
}

func TestRoomForCodeRejected(t *testing.T) {
	no := func(string) bool { return false }
	_, _, _, valid := RoomFor("424242", "", no, nil)
	if valid {
		t.Fatal("bad code must be rejected")
	}
	// nil validator also rejects.
	if _, _, _, ok := RoomFor("424242", "", nil, nil); ok {
		t.Fatal("nil pair-validator must reject a code")
	}
}

func TestRoomForTokenStillWorks(t *testing.T) {
	ok := func(string) bool { return true }
	room, max, lan, valid := RoomFor("", "tok", nil, ok)
	if room != "t:tok" || max != 2 || lan || !valid {
		t.Fatalf("got %q %d lan=%v ok=%v", room, max, lan, valid)
	}
}

func TestRoomForLAN(t *testing.T) {
	room, max, lan, valid := RoomFor("", "", nil, nil)
	if room != "" || max != 0 || !lan || !valid {
		t.Fatalf("got %q %d lan=%v ok=%v", room, max, lan, valid)
	}
}

func TestRoomForCodeTakesPrecedenceOverToken(t *testing.T) {
	ok := func(string) bool { return true }
	room, _, _, valid := RoomFor("424242", "tok", ok, ok)
	if room != "c:424242" || !valid {
		t.Fatalf("code should win: got %q ok=%v", room, valid)
	}
}
