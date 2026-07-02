package signal

import (
	"context"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A consumer that never drains its socket must not block Send past the write
// deadline: send returns a (timeout) error so the caller can drop the peer.
func TestWSConnSendWriteTimeout(t *testing.T) {
	w := &wsConn{
		ctx:          context.Background(),
		writeTimeout: 20 * time.Millisecond,
		writeFn: func(ctx context.Context, _ websocket.MessageType, _ []byte) error {
			<-ctx.Done() // simulate a peer whose socket buffer never drains
			return ctx.Err()
		},
	}

	done := make(chan error, 1)
	go func() { done <- w.send([]byte("x")) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("send should return a timeout error for a stuck consumer")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("send blocked well past its write deadline")
	}
}

// A healthy write returns nil and does not spuriously time out.
func TestWSConnSendSucceeds(t *testing.T) {
	var gotCtx context.Context
	w := &wsConn{
		ctx:          context.Background(),
		writeTimeout: time.Second,
		writeFn: func(ctx context.Context, _ websocket.MessageType, _ []byte) error {
			gotCtx = ctx
			return nil
		},
	}
	if err := w.send([]byte("hi")); err != nil {
		t.Fatalf("send: %v", err)
	}
	if gotCtx == nil {
		t.Fatal("writeFn should receive a deadline-bearing context")
	}
	if _, ok := gotCtx.Deadline(); !ok {
		t.Fatal("write context should carry a deadline")
	}
}
