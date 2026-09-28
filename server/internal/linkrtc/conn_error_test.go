package linkrtc

import (
	"errors"
	"testing"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/rtcerr"
)

func TestNormalizePeerConnectionClosedError(t *testing.T) {
	err := &rtcerr.InvalidStateError{Err: webrtc.ErrConnectionClosed}
	if got := normalizePeerConnectionError(err); !errors.Is(got, ErrClosed) {
		t.Fatalf("normalizePeerConnectionError(%v) = %v, want ErrClosed", err, got)
	}

	other := errors.New("other")
	if got := normalizePeerConnectionError(other); got != other {
		t.Fatalf("normalizePeerConnectionError(other) = %v, want original error", got)
	}
}
