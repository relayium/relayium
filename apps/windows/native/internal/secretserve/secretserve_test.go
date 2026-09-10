// Portable serve tests, against a fake protector.
//
// SCOPE: dispatch, status mapping, bounds and diagnostics. No DPAPI call is
// made here, so nothing in this file is evidence about Windows behaviour.
package secretserve

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/relayium/relayium/apps/windows/native/internal/secretframe"
)

type fakeProtector struct {
	sealed   []byte
	opened   []byte
	sealErr  error
	openErr  error
	sawSeal  []byte
	sawOpen  []byte
	oversize bool
}

func (f *fakeProtector) Seal(plaintext []byte) ([]byte, error) {
	f.sawSeal = append([]byte{}, plaintext...)
	if f.sealErr != nil {
		return nil, f.sealErr
	}
	if f.oversize {
		return make([]byte, secretframe.MaxBlobBytes+1), nil
	}
	return f.sealed, nil
}

func (f *fakeProtector) Open(blob []byte) ([]byte, error) {
	f.sawOpen = append([]byte{}, blob...)
	if f.openErr != nil {
		return nil, f.openErr
	}
	if f.oversize {
		return make([]byte, secretframe.MaxPlaintextBytes+1), nil
	}
	return f.opened, nil
}

func run(t *testing.T, in []byte, p Protector) (int, byte, []byte, string) {
	t.Helper()
	var out, log bytes.Buffer
	code := Serve(Options{In: bytes.NewReader(in), Out: &out, Log: &log, Protector: p})
	if out.Len() == 0 {
		return code, 0, nil, log.String()
	}
	status, payload, err := secretframe.DecodeResponse(out.Bytes())
	if err != nil {
		t.Fatalf("response did not decode: %v", err)
	}
	return code, status, payload, log.String()
}

func request(t *testing.T, op byte, payload []byte) []byte {
	t.Helper()
	frame, err := secretframe.EncodeRequest(op, payload)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

// Root fixed this mapping; it is asserted rather than described.
func TestExitMapping(t *testing.T) {
	for status, want := range map[byte]int{
		secretframe.StatusOK:       0,
		secretframe.StatusProtocol: 2,
		secretframe.StatusRefused:  3,
		secretframe.StatusInternal: 4,
	} {
		if got := ExitFor(status); got != want {
			t.Fatalf("status %d exits %d, want %d", status, got, want)
		}
	}
	// Anything unknown is internal, never a success.
	if ExitFor(200) != 4 {
		t.Fatal("an unknown status did not exit internal")
	}
}

func TestSealAndOpenDispatch(t *testing.T) {
	p := &fakeProtector{sealed: []byte("blob")}
	code, status, payload, _ := run(t, request(t, secretframe.OpSeal, []byte("plain")), p)
	if code != 0 || status != secretframe.StatusOK || string(payload) != "blob" {
		t.Fatalf("seal: exit %d status %d payload %q", code, status, payload)
	}
	if string(p.sawSeal) != "plain" {
		t.Fatalf("protector saw %q", p.sawSeal)
	}

	p2 := &fakeProtector{opened: []byte("plain")}
	code, status, payload, _ = run(t, request(t, secretframe.OpOpen, []byte("blob")), p2)
	if code != 0 || status != secretframe.StatusOK || string(payload) != "plain" {
		t.Fatalf("open: exit %d status %d payload %q", code, status, payload)
	}
}

// Every protector failure is REFUSED with no distinction. Reporting which kind
// would describe the protected bytes, and CryptUnprotectData's codes vary
// anyway.
func TestProtectorFailureIsUniformlyRefused(t *testing.T) {
	for name, p := range map[string]*fakeProtector{
		"seal fails": {sealErr: errors.New("whatever")},
		"open fails": {openErr: errors.New("something else")},
	} {
		t.Run(name, func(t *testing.T) {
			op := secretframe.OpSeal
			if p.openErr != nil {
				op = secretframe.OpOpen
			}
			code, status, payload, log := run(t, request(t, op, []byte("x")), p)
			if code != 3 || status != secretframe.StatusRefused {
				t.Fatalf("exit %d status %d, want 3/refused", code, status)
			}
			if len(payload) != 0 {
				t.Fatalf("a refusal carried %d payload bytes", len(payload))
			}
			if !strings.Contains(log, "refused") {
				t.Fatalf("log %q", log)
			}
		})
	}
}

func TestMalformedRequestsExitProtocol(t *testing.T) {
	good := request(t, secretframe.OpSeal, []byte("x"))
	cases := map[string][]byte{
		"empty":       {},
		"wrong magic": append([]byte("ZZZZ"), good[4:]...),
		"unknown op":  func() []byte { c := append([]byte{}, good...); c[5] = 7; return c }(),
		"trailing":    append(append([]byte{}, good...), good...),
		"oversize":    make([]byte, secretframe.MaxFrameBytes+1),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			code, status, payload, _ := run(t, raw, &fakeProtector{})
			if code != 2 || status != secretframe.StatusProtocol {
				t.Fatalf("exit %d status %d, want 2/protocol", code, status)
			}
			if len(payload) != 0 {
				t.Fatal("a protocol failure carried a payload")
			}
		})
	}
}

// A protector that returns more than its operation may carry is an internal
// failure, not a truncated success.
func TestOversizeProtectorOutputIsInternal(t *testing.T) {
	code, status, _, _ := run(t, request(t, secretframe.OpSeal, []byte("x")), &fakeProtector{oversize: true})
	if code != 4 || status != secretframe.StatusInternal {
		t.Fatalf("exit %d status %d, want 4/internal", code, status)
	}
}

// stderr is a crash surface that ships, and this process handles secrets.
func TestDiagnosticsEchoNothingFromTheRequest(t *testing.T) {
	secret := "SECRET-MARKER-4f21"
	_, _, _, log := run(t, request(t, secretframe.OpSeal, []byte(secret)), &fakeProtector{sealErr: errors.New(secret)})
	if strings.Contains(log, secret) {
		t.Fatalf("stderr echoed request material: %q", log)
	}
	// Even the protector's own error text stays out: it is not this process's
	// to interpret and could carry anything.
	if strings.Contains(log, "4f21") {
		t.Fatalf("stderr leaked a fragment: %q", log)
	}
	// And it is a closed word, not a format string with an argument.
	for _, line := range strings.Split(strings.TrimSpace(log), "\n") {
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "secret-helper: ") {
			t.Fatalf("unexpected diagnostic shape: %q", line)
		}
		switch strings.TrimPrefix(line, "secret-helper: ") {
		case "protocol", "oversize", "trailing", "refused", "encode", "write":
		default:
			t.Fatalf("diagnostic outside the closed set: %q", line)
		}
	}
}

func TestPlaintextAtTheBoundIsAccepted(t *testing.T) {
	p := &fakeProtector{sealed: []byte("blob")}
	code, status, _, _ := run(t, request(t, secretframe.OpSeal, make([]byte, secretframe.MaxPlaintextBytes)), p)
	if code != 0 || status != secretframe.StatusOK {
		t.Fatalf("a request at the bound was refused: exit %d status %d", code, status)
	}
}

// A response that could not be delivered is INTERNAL, not the operation's own
// status: reporting success for an answer the parent never received would claim
// a delivery that did not happen.
func TestUndeliverableResponseIsInternal(t *testing.T) {
	var log bytes.Buffer
	code := Serve(Options{
		In:        bytes.NewReader(request(t, secretframe.OpSeal, []byte("x"))),
		Out:       failingWriter{},
		Log:       &log,
		Protector: &fakeProtector{sealed: []byte("blob")},
	})
	if code != 4 {
		t.Fatalf("exit %d, want 4", code)
	}
	if !strings.Contains(log.String(), "write") {
		t.Fatalf("log %q", log.String())
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("gone") }
