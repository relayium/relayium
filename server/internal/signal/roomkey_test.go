package signal

import (
	"net/http"
	"testing"
)

func TestRoomKeyFromRemoteAddr(t *testing.T) {
	r := &http.Request{RemoteAddr: "203.0.113.7:54321", Header: http.Header{}}
	if got := RoomKey(r); got != "203.0.113.7" {
		t.Fatalf("got %q", got)
	}
}

func TestRoomKeyPrefersForwardedFor(t *testing.T) {
	r := &http.Request{RemoteAddr: "10.0.0.1:1", Header: http.Header{}}
	r.Header.Set("X-Forwarded-For", "198.51.100.9, 10.0.0.1")
	if got := RoomKey(r); got != "198.51.100.9" {
		t.Fatalf("got %q", got)
	}
}
