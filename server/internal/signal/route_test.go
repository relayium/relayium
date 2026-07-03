package signal

import "testing"

func TestRoomForCode(t *testing.T) {
	ok := func(string) bool { return true }
	room, max, lan, valid := RoomFor("424242", ok)
	if room != "c:424242" || max != 2 || lan || !valid {
		t.Fatalf("got %q %d lan=%v ok=%v", room, max, lan, valid)
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
