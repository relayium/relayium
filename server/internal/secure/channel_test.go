package secure

import (
	"errors"
	"net"
	"testing"
	"time"
)

var errMismatch = errors.New("mismatch")

func TestPinnedTLSRoundtrip(t *testing.T) {
	idA, _ := NewIdentity()
	idB, _ := NewIdentity()
	c1, c2 := net.Pipe()

	// Server side in a goroutine; client side here.
	srvCh := make(chan error, 1)
	go func() {
		s, err := Server(c2, idB, idA.Fingerprint)
		if err != nil {
			srvCh <- err
			return
		}
		buf := make([]byte, 5)
		s.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := s.Read(buf); err != nil {
			srvCh <- err
			return
		}
		if string(buf) != "hello" {
			srvCh <- errMismatch
			return
		}
		srvCh <- nil
	}()

	cli, err := Client(c1, idA, idB.Fingerprint)
	if err != nil {
		t.Fatalf("client handshake: %v", err)
	}
	cli.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := cli.Write([]byte("hello")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := <-srvCh; err != nil {
		t.Fatalf("server: %v", err)
	}
}

func TestPinRejectsWrongPeer(t *testing.T) {
	idA, _ := NewIdentity()
	idB, _ := NewIdentity()
	idImposter, _ := NewIdentity()
	c1, c2 := net.Pipe()

	go func() {
		// Server presents idImposter's cert, but client expects idB.
		s, err := Server(c2, idImposter, idA.Fingerprint)
		if err == nil {
			s.Close()
		}
	}()
	_, err := Client(c1, idA, idB.Fingerprint)
	if err == nil {
		t.Fatal("client accepted a cert that doesn't match the pinned fingerprint")
	}
}
