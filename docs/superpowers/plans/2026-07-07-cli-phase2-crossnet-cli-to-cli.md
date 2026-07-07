# Relayium CLI — Phase 2 / Spec 1 Implementation Plan: CLI↔CLI cross-network transfer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two `relayium` CLIs on different networks send files to each other over a short code — direct TCP when either side is publicly reachable (free), a new lightweight WebSocket relay otherwise (paid, metered) — all E2E-encrypted, reusing the Phase 1 `xfer` engine.

**Architecture:** Both peers join the existing rendezvous (`wss://server/ws?code=<code>`), exchange ephemeral-TLS-cert commitments (commit-then-reveal, defeats a tampering rendezvous) and TCP connection candidates over the `signal` envelope. They race a direct TCP dial/accept; on failure both fall back to a new server `/relay?code=` WebSocket that pipes bytes and meters them to the code owner. The resulting raw stream is wrapped in TLS 1.3 with the peer cert pinned to the revealed commitment (a 6-digit SAS is printed for optional out-of-band comparison), and `xfer.Send`/`xfer.Receive` run over that TLS stream.

**Tech Stack:** Go 1.26.3, standard library (`crypto/tls`, `crypto/ed25519`, `crypto/x509`, `crypto/sha256`, `net`) plus the already-vendored `github.com/coder/websocket` (used by the server; reused as the client). No new third-party modules. Pure Go, `CGO_ENABLED=0`.

## Global Constraints

- Module `github.com/relayium/relayium`, rooted at `server/` (all Go paths below are relative to `server/`; run go commands from `server/`).
- Go 1.26.3; `CGO_ENABLED=0`; the only non-stdlib dependency permitted is the already-present `github.com/coder/websocket` — add no other third-party module.
- Tests use the standard `testing` package only (no testify), `t.Fatalf` style, `t.TempDir()`.
- Client packages reuse the Phase 1 engine `internal/xfer` and the wire types in `internal/signal` (Envelope/Peer/constants — pure JSON structs). They MUST NOT import `internal/account` or `internal/metering` (server-only); the new `/relay` server endpoint may.
- This spec assumes the pairing **code already exists** (minted elsewhere). Both peers only *join* by code — joining needs no auth.
- E2E crypto is Go-native and intentionally **not** wire-compatible with the browser (that is a later phase).
- SAS default: print, do not block; `--verify` requires human confirmation.
- Relayed bytes are metered to the code owner in the existing monthly ledger (`store.RecordUsage` / `UserRelayedSince` / `RelayMonthlyFree`), sharing the 2 GiB/month cap with coturn TURN.

---

### Task 1: Rendezvous WebSocket client (`internal/rzvous`)

**Files:**
- Create: `internal/rzvous/rzvous.go`
- Test: `internal/rzvous/rzvous_test.go`

**Interfaces:**
- Consumes: `github.com/relayium/relayium/internal/signal` (`Envelope`, `Peer`, `TypeJoin`, `TypeWelcome`, `TypePeers`, `TypeSignal`, `EncodeEnvelope`, `DecodeEnvelope`); `github.com/coder/websocket`.
- Produces:
  - `type Session struct { ... }`
  - `func Join(ctx context.Context, serverURL, code, name string) (*Session, error)` — `serverURL` like `ws://host:port` or `wss://host`; dials `serverURL+"/ws?code="+code`, sends `{type:"join", name:name}`, reads `welcome` (records self id), then waits for a `peers` roster containing exactly one other peer and records its id. Returns once a peer is present.
  - `func (s *Session) SelfID() string`, `func (s *Session) PeerID() string`
  - `func (s *Session) SendSignal(ctx context.Context, data json.RawMessage) error` — sends `{type:"signal", to:PeerID, data:data}`
  - `func (s *Session) RecvSignal(ctx context.Context) (json.RawMessage, error)` — returns the `data` of the next `signal` envelope; skips roster updates.
  - `func (s *Session) Close() error`

- [ ] **Step 1: Write the failing test** (drives a real in-process signal server)

```go
package rzvous

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/signal"
)

// startHub spins up the real signaling server on an httptest server and returns
// its ws:// base URL.
func startHub(t *testing.T) string {
	t.Helper()
	hub := signal.NewHub()
	go hub.Run()
	seq := 0
	newID := func() string { seq++; return "peer" + string(rune('A'+seq)) }
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		signal.ServeWS(hub, newID)(w, r, c)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func TestJoinPairsTwoPeersAndRelaysSignals(t *testing.T) {
	base := startHub(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// LAN room (no code): both peers share the httptest loopback IP → same room.
	aCh := make(chan *Session, 1)
	go func() {
		a, err := Join(ctx, base, "", "alice")
		if err != nil {
			t.Errorf("join a: %v", err)
			return
		}
		aCh <- a
	}()
	b, err := Join(ctx, base, "", "bob")
	if err != nil {
		t.Fatalf("join b: %v", err)
	}
	a := <-aCh
	if a.PeerID() != b.SelfID() || b.PeerID() != a.SelfID() {
		t.Fatalf("peer ids not mutual: a self=%s peer=%s, b self=%s peer=%s",
			a.SelfID(), a.PeerID(), b.SelfID(), b.PeerID())
	}

	if err := a.SendSignal(ctx, json.RawMessage(`{"hi":1}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	got, err := b.RecvSignal(ctx)
	if err != nil {
		t.Fatalf("recv: %v", err)
	}
	if strings.TrimSpace(string(got)) != `{"hi":1}` {
		t.Fatalf("relayed data = %s", got)
	}
}
```

> Note: this test uses the **signal server's real exported surface**. Before implementing, the engineer MUST open `internal/signal/` and confirm the exact names/signatures of `NewHub`, `Run`, and `ServeWS` (the ServeWS signature in `main.go:132` is `signal.ServeWS(hub, newID)` returning a handler; adapt `startHub` to the real signature — if `ServeWS` already calls `websocket.Accept` internally, register it directly as `mux.HandleFunc("/ws", signal.ServeWS(hub, newID))` and delete the manual Accept). Fix the helper to match reality; keep the test's assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/rzvous/ -run TestJoin -v`
Expected: FAIL — `undefined: Join` (package doesn't compile yet).

- [ ] **Step 3: Write minimal implementation**

```go
// Package rzvous is the CLI's rendezvous client: it speaks the existing
// signaling Envelope over a WebSocket to pair with one peer in a code room and
// relay opaque signal payloads to it. It carries no file bytes.
package rzvous

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/signal"
)

type Session struct {
	conn   *websocket.Conn
	selfID string
	peerID string
}

func (s *Session) SelfID() string { return s.selfID }
func (s *Session) PeerID() string { return s.peerID }

// Join dials the rendezvous, announces the given nickname, and blocks until
// exactly one peer shares the room. An empty code joins the LAN room.
func Join(ctx context.Context, serverURL, code, name string) (*Session, error) {
	u, err := url.Parse(serverURL)
	if err != nil {
		return nil, err
	}
	u.Path = "/ws"
	if code != "" {
		u.RawQuery = "code=" + url.QueryEscape(code)
	}
	conn, _, err := websocket.Dial(ctx, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("rendezvous dial: %w", err)
	}
	s := &Session{conn: conn}

	if err := s.write(ctx, signal.Envelope{Type: signal.TypeJoin, Name: name}); err != nil {
		conn.Close(websocket.StatusInternalError, "join")
		return nil, err
	}
	for {
		env, err := s.read(ctx)
		if err != nil {
			conn.Close(websocket.StatusInternalError, "handshake")
			return nil, err
		}
		switch env.Type {
		case signal.TypeWelcome:
			s.selfID = env.Name
		case signal.TypePeers:
			for _, p := range env.Peers {
				if p.ID != s.selfID {
					s.peerID = p.ID
				}
			}
			if s.peerID != "" {
				return s, nil
			}
		}
	}
}

func (s *Session) SendSignal(ctx context.Context, data json.RawMessage) error {
	return s.write(ctx, signal.Envelope{Type: signal.TypeSignal, To: s.peerID, Data: data})
}

// RecvSignal returns the payload of the next signal envelope from the peer,
// skipping roster/presence frames.
func (s *Session) RecvSignal(ctx context.Context) (json.RawMessage, error) {
	for {
		env, err := s.read(ctx)
		if err != nil {
			return nil, err
		}
		if env.Type == signal.TypeSignal {
			return env.Data, nil
		}
	}
}

func (s *Session) Close() error { return s.conn.Close(websocket.StatusNormalClosure, "") }

func (s *Session) write(ctx context.Context, e signal.Envelope) error {
	b, err := signal.EncodeEnvelope(e)
	if err != nil {
		return err
	}
	return s.conn.Write(ctx, websocket.MessageText, b)
}

func (s *Session) read(ctx context.Context) (signal.Envelope, error) {
	_, b, err := s.conn.Read(ctx)
	if err != nil {
		return signal.Envelope{}, err
	}
	return signal.DecodeEnvelope(b)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/rzvous/ -run TestJoin -v`
Expected: PASS. If it hangs, the `startHub` helper doesn't match the real signal API — fix the helper (Step 1 note), not the assertions.

- [ ] **Step 5: Commit**

```bash
git add server/internal/rzvous/
git commit -m "feat(cli): rendezvous websocket client (join + signal relay)"
```

---

### Task 2: Secure crypto core — ephemeral cert, fingerprint, commit-reveal, SAS (`internal/secure`)

**Files:**
- Create: `internal/secure/crypto.go`
- Test: `internal/secure/crypto_test.go`

**Interfaces:**
- Consumes: stdlib only (`crypto/ed25519`, `crypto/x509`, `crypto/tls`, `crypto/sha256`, `crypto/rand`, `crypto/subtle`, `encoding/hex`, `encoding/binary`, `math/big`, `sort`).
- Produces:
  - `type Identity struct { TLSCert tls.Certificate; Fingerprint string }` — an ephemeral self-signed Ed25519 identity; `Fingerprint` = lowercase hex SHA-256 of the cert's DER bytes.
  - `func NewIdentity() (*Identity, error)`
  - `func Commit(fingerprint string, nonce []byte) []byte` — `SHA256(fingerprint-bytes ‖ nonce)`.
  - `func VerifyCommit(commit []byte, fingerprint string, nonce []byte) bool` — constant-time.
  - `func SAS(fpA, fpB string) string` — sort the two hex fingerprints ascending, `d = SHA256(a-bytes ‖ b-bytes)`, `n = (be32(d[0:4]) XOR be32(d[4:8]))`, return `n % 1_000_000` zero-padded to 6 digits. Order-independent.
  - `const NonceLen = 32`
  - `func NewNonce() ([]byte, error)`

- [ ] **Step 1: Write the failing test**

```go
package secure

import (
	"encoding/hex"
	"testing"
)

func TestIdentityFingerprintStable(t *testing.T) {
	id, err := NewIdentity()
	if err != nil {
		t.Fatalf("new identity: %v", err)
	}
	if len(id.TLSCert.Certificate) == 0 {
		t.Fatal("no cert der")
	}
	if _, err := hex.DecodeString(id.Fingerprint); err != nil || len(id.Fingerprint) != 64 {
		t.Fatalf("fingerprint not 32-byte hex: %q", id.Fingerprint)
	}
}

func TestCommitRoundtripAndReject(t *testing.T) {
	nonce, _ := NewNonce()
	fp := "aa11bb22"
	c := Commit(fp, nonce)
	if !VerifyCommit(c, fp, nonce) {
		t.Fatal("valid commit rejected")
	}
	if VerifyCommit(c, "deadbeef", nonce) {
		t.Fatal("wrong fingerprint accepted")
	}
	bad := make([]byte, len(nonce))
	copy(bad, nonce)
	bad[0] ^= 1
	if VerifyCommit(c, fp, bad) {
		t.Fatal("wrong nonce accepted")
	}
}

func TestSASOrderIndependentAnd6Digits(t *testing.T) {
	a := "00ff00ff"
	b := "ffee00aa"
	s1 := SAS(a, b)
	s2 := SAS(b, a)
	if s1 != s2 {
		t.Fatalf("SAS not order-independent: %s vs %s", s1, s2)
	}
	if len(s1) != 6 {
		t.Fatalf("SAS not 6 digits: %q", s1)
	}
	for _, r := range s1 {
		if r < '0' || r > '9' {
			t.Fatalf("SAS not decimal: %q", s1)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/secure/ -run 'Identity|Commit|SAS' -v`
Expected: FAIL — undefined identifiers.

- [ ] **Step 3: Write minimal implementation**

```go
// Package secure builds the CLI's end-to-end secure channel: an ephemeral
// self-signed TLS identity, a commit-then-reveal fingerprint exchange that pins
// the peer's cert through an untrusted rendezvous, and a 6-digit SAS for
// out-of-band human verification.
package secure

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/hex"
	"math/big"
	"sort"
	"time"
)

const NonceLen = 32

type Identity struct {
	TLSCert     tls.Certificate
	Fingerprint string
}

// NewIdentity generates a fresh Ed25519 self-signed certificate for one transfer.
func NewIdentity() (*Identity, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "relayium-cli"},
		NotBefore:    time.Unix(0, 0),
		NotAfter:     time.Unix(1<<62, 0), // ephemeral; validity window is irrelevant under pinning
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, pub, priv)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(der)
	return &Identity{
		TLSCert:     tls.Certificate{Certificate: [][]byte{der}, PrivateKey: priv},
		Fingerprint: hex.EncodeToString(sum[:]),
	}, nil
}

func NewNonce() ([]byte, error) {
	n := make([]byte, NonceLen)
	_, err := rand.Read(n)
	return n, err
}

// Commit is SHA256(fingerprint-bytes ‖ nonce).
func Commit(fingerprint string, nonce []byte) []byte {
	h := sha256.New()
	h.Write([]byte(fingerprint))
	h.Write(nonce)
	return h.Sum(nil)
}

func VerifyCommit(commit []byte, fingerprint string, nonce []byte) bool {
	return subtle.ConstantTimeCompare(commit, Commit(fingerprint, nonce)) == 1
}

// SAS derives an order-independent 6-digit short authentication string from the
// two peers' cert fingerprints.
func SAS(fpA, fpB string) string {
	pair := []string{fpA, fpB}
	sort.Strings(pair)
	h := sha256.New()
	h.Write([]byte(pair[0]))
	h.Write([]byte(pair[1]))
	d := h.Sum(nil)
	n := binary.BigEndian.Uint32(d[0:4]) ^ binary.BigEndian.Uint32(d[4:8])
	s := make([]byte, 6)
	v := n % 1_000_000
	for i := 5; i >= 0; i-- {
		s[i] = byte('0' + v%10)
		v /= 10
	}
	return string(s)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/secure/ -run 'Identity|Commit|SAS' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/secure/crypto.go server/internal/secure/crypto_test.go
git commit -m "feat(cli): ephemeral TLS identity, commit-reveal, SAS"
```

---

### Task 3: TLS secure channel with cert pinning (`internal/secure`)

**Files:**
- Create: `internal/secure/channel.go`
- Test: `internal/secure/channel_test.go`

**Interfaces:**
- Consumes: `Identity` (Task 2); stdlib `crypto/tls`, `crypto/sha256`, `encoding/hex`, `net`.
- Produces:
  - `func Client(conn net.Conn, id *Identity, peerFingerprint string) (*tls.Conn, error)` — TLS 1.3 client handshake, presents `id`'s cert, verifies the server cert's SHA-256 equals `peerFingerprint` (pinning; normal CA verification disabled).
  - `func Server(conn net.Conn, id *Identity, peerFingerprint string) (*tls.Conn, error)` — TLS 1.3 server side, requires + pins the client cert.
  - Both block through the handshake and return the ready `*tls.Conn` or a pinning error.

- [ ] **Step 1: Write the failing test**

```go
package secure

import (
	"net"
	"testing"
	"time"
)

func TestPinnedTLSRoundtrip(t *testing.T) {
	idA, _ := NewIdentity()
	idB, _ := NewIdentity()
	c1, c2 := net.Pipe()

	type res struct {
		conn *tlsConnLike
		err  error
	}
	// Server side in a goroutine; client side here. (tlsConnLike = *tls.Conn.)
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
```

> Note: replace `tlsConnLike`/`errMismatch` in the test with the real types — declare `var errMismatch = errors.New("mismatch")` at file scope and use `*tls.Conn` directly (drop the `tlsConnLike` alias; it's only shown to signal the goroutine returns a `*tls.Conn`). Keep the assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/secure/ -run 'PinnedTLS|PinRejects' -v`
Expected: FAIL — `undefined: Client` / `Server`.

- [ ] **Step 3: Write minimal implementation**

```go
package secure

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"net"
)

// Client completes a TLS 1.3 client handshake over conn, presenting id's cert
// and pinning the server to peerFingerprint (standard CA checks are disabled —
// trust comes solely from the out-of-band-committed fingerprint).
func Client(conn net.Conn, id *Identity, peerFingerprint string) (*tls.Conn, error) {
	cfg := &tls.Config{
		Certificates:          []tls.Certificate{id.TLSCert},
		InsecureSkipVerify:    true, // pinning (VerifyPeerCertificate) replaces CA verification
		MinVersion:            tls.VersionTLS13,
		VerifyPeerCertificate: pinCheck(peerFingerprint),
	}
	c := tls.Client(conn, cfg)
	if err := c.Handshake(); err != nil {
		return nil, err
	}
	return c, nil
}

// Server completes a TLS 1.3 server handshake, requiring and pinning the client cert.
func Server(conn net.Conn, id *Identity, peerFingerprint string) (*tls.Conn, error) {
	cfg := &tls.Config{
		Certificates:          []tls.Certificate{id.TLSCert},
		MinVersion:            tls.VersionTLS13,
		ClientAuth:            tls.RequireAnyClientCert,
		VerifyPeerCertificate: pinCheck(peerFingerprint),
	}
	c := tls.Server(conn, cfg)
	if err := c.Handshake(); err != nil {
		return nil, err
	}
	return c, nil
}

// pinCheck verifies the peer presented exactly one certificate whose DER
// SHA-256 hex equals want. rawCerts[0] is the leaf in DER form. The signature
// matches tls.Config.VerifyPeerCertificate exactly.
func pinCheck(want string) func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
	return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if len(rawCerts) == 0 {
			return errors.New("secure: peer sent no certificate")
		}
		sum := sha256.Sum256(rawCerts[0])
		if hex.EncodeToString(sum[:]) != want {
			return errors.New("secure: peer certificate does not match pinned fingerprint")
		}
		return nil
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/secure/ -run 'PinnedTLS|PinRejects' -v`
Expected: PASS — pinned roundtrip works; imposter cert is rejected by the client.

- [ ] **Step 5: Commit**

```bash
git add server/internal/secure/channel.go server/internal/secure/channel_test.go
git commit -m "feat(cli): pinned TLS 1.3 secure channel"
```

---

### Task 4: Handshake over rendezvous — commit-reveal + candidates + roles (`internal/rzvous`)

**Files:**
- Create: `internal/rzvous/handshake.go`
- Test: `internal/rzvous/handshake_test.go`

**Interfaces:**
- Consumes: `Session` (Task 1), `secure.Identity`/`Commit`/`VerifyCommit`/`SAS`/`NewNonce` (Tasks 2), stdlib `encoding/json`, `encoding/hex`, `encoding/base64`.
- Produces:
  - `type Handshake struct { PeerFingerprint string; SAS string; PeerCandidates []string; IsServer bool }`
  - `func DoHandshake(ctx context.Context, s *Session, id *secure.Identity, localCandidates []string) (*Handshake, error)` — over the signal channel: (1) send our `commit`; (2) receive peer `commit`; (3) send our `reveal{fingerprint,nonce}` + our candidates; (4) receive peer reveal+candidates, `VerifyCommit` them (abort on mismatch); compute `SAS`; set `IsServer = SelfID() < PeerID()` (deterministic role: lexicographically-smaller peer id is the TLS server + listener). All three payloads are distinct JSON messages tagged by a `kind` field, sent via `s.SendSignal`.

- [ ] **Step 1: Write the failing test**

```go
package rzvous

import (
	"context"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/secure"
)

func TestDoHandshakeAgreesOnSASAndRoles(t *testing.T) {
	base := startHub(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	aCh := make(chan *Session, 1)
	go func() { s, _ := Join(ctx, base, "", "a"); aCh <- s }()
	b, err := Join(ctx, base, "", "b")
	if err != nil {
		t.Fatalf("join b: %v", err)
	}
	a := <-aCh

	idA, _ := secure.NewIdentity()
	idB, _ := secure.NewIdentity()

	type res struct {
		h   *Handshake
		err error
	}
	ch := make(chan res, 1)
	go func() {
		h, err := DoHandshake(ctx, a, idA, []string{"1.2.3.4:5000"})
		ch <- res{h, err}
	}()
	hb, err := DoHandshake(ctx, b, idB, []string{"5.6.7.8:6000"})
	if err != nil {
		t.Fatalf("handshake b: %v", err)
	}
	ra := <-ch
	if ra.err != nil {
		t.Fatalf("handshake a: %v", ra.err)
	}
	ha := ra.h

	if ha.SAS != hb.SAS {
		t.Fatalf("SAS disagree: %s vs %s", ha.SAS, hb.SAS)
	}
	if ha.PeerFingerprint != idB.Fingerprint || hb.PeerFingerprint != idA.Fingerprint {
		t.Fatal("pinned fingerprints wrong")
	}
	if ha.IsServer == hb.IsServer {
		t.Fatal("both peers picked the same TLS role")
	}
	if len(hb.PeerCandidates) != 1 || hb.PeerCandidates[0] != "1.2.3.4:5000" {
		t.Fatalf("b did not receive a's candidates: %v", hb.PeerCandidates)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/rzvous/ -run TestDoHandshake -v`
Expected: FAIL — `undefined: DoHandshake` / `Handshake`.

- [ ] **Step 3: Write minimal implementation**

```go
package rzvous

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/relayium/relayium/internal/secure"
)

type Handshake struct {
	PeerFingerprint string
	SAS             string
	PeerCandidates  []string
	IsServer        bool
}

type hsMsg struct {
	Kind       string   `json:"kind"`           // "commit" | "reveal"
	Commit     string   `json:"commit,omitempty"`     // base64, kind=commit
	Fingerprint string  `json:"fp,omitempty"`         // hex, kind=reveal
	Nonce      string   `json:"nonce,omitempty"`      // base64, kind=reveal
	Candidates []string `json:"candidates,omitempty"` // kind=reveal
}

func sendHS(ctx context.Context, s *Session, m hsMsg) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return s.SendSignal(ctx, b)
}

func recvHS(ctx context.Context, s *Session, want string) (hsMsg, error) {
	data, err := s.RecvSignal(ctx)
	if err != nil {
		return hsMsg{}, err
	}
	var m hsMsg
	if err := json.Unmarshal(data, &m); err != nil {
		return hsMsg{}, err
	}
	if m.Kind != want {
		return hsMsg{}, errors.New("rzvous: unexpected handshake message " + m.Kind)
	}
	return m, nil
}

// DoHandshake runs commit-then-reveal over the signal channel, pins the peer's
// cert fingerprint, exchanges TCP candidates, and derives the shared SAS.
func DoHandshake(ctx context.Context, s *Session, id *secure.Identity, localCandidates []string) (*Handshake, error) {
	nonce, err := secure.NewNonce()
	if err != nil {
		return nil, err
	}
	commit := secure.Commit(id.Fingerprint, nonce)
	if err := sendHS(ctx, s, hsMsg{Kind: "commit", Commit: base64.StdEncoding.EncodeToString(commit)}); err != nil {
		return nil, err
	}
	peerCommitMsg, err := recvHS(ctx, s, "commit")
	if err != nil {
		return nil, err
	}
	peerCommit, err := base64.StdEncoding.DecodeString(peerCommitMsg.Commit)
	if err != nil {
		return nil, err
	}

	if err := sendHS(ctx, s, hsMsg{
		Kind:        "reveal",
		Fingerprint: id.Fingerprint,
		Nonce:       base64.StdEncoding.EncodeToString(nonce),
		Candidates:  localCandidates,
	}); err != nil {
		return nil, err
	}
	rev, err := recvHS(ctx, s, "reveal")
	if err != nil {
		return nil, err
	}
	peerNonce, err := base64.StdEncoding.DecodeString(rev.Nonce)
	if err != nil {
		return nil, err
	}
	if _, err := hex.DecodeString(rev.Fingerprint); err != nil {
		return nil, errors.New("rzvous: peer fingerprint not hex")
	}
	if !secure.VerifyCommit(peerCommit, rev.Fingerprint, peerNonce) {
		return nil, errors.New("rzvous: peer commitment mismatch — aborting (possible MITM)")
	}

	return &Handshake{
		PeerFingerprint: rev.Fingerprint,
		SAS:             secure.SAS(id.Fingerprint, rev.Fingerprint),
		PeerCandidates:  rev.Candidates,
		IsServer:        s.SelfID() < s.PeerID(),
	}, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/rzvous/ -v`
Expected: PASS (both Task 1 and Task 4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/internal/rzvous/handshake.go server/internal/rzvous/handshake_test.go
git commit -m "feat(cli): commit-reveal handshake + candidate/role exchange over rendezvous"
```

---

### Task 5: Direct-connect candidate gathering + dial/listen race (`internal/connect`)

**Files:**
- Create: `internal/connect/direct.go`
- Test: `internal/connect/direct_test.go`

**Interfaces:**
- Consumes: stdlib `net`, `context`.
- Produces:
  - `func LocalCandidates(port int, advertise string) []string` — returns `host:port` strings for each non-loopback, non-private, non-link-local IPv4/IPv6 interface address, plus `advertise` verbatim if non-empty. (Private ranges are excluded because they're not reachable across networks; `advertise` is the escape hatch for port-forwarded/NAT setups.)
  - `func RaceDirect(ctx context.Context, ln net.Listener, peerCandidates []string, dialTimeout time.Duration) (net.Conn, error)` — concurrently accepts one inbound connection on `ln` and dials every `peerCandidate`; returns the first successful `net.Conn` and cancels the rest. Returns an error if none connect before `ctx` is done.

- [ ] **Step 1: Write the failing test**

```go
package connect

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestRaceDirectDialSucceeds(t *testing.T) {
	// Peer "server" listens; our RaceDirect should dial in and win.
	peerLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer peerLn.Close()
	go func() {
		c, err := peerLn.Accept()
		if err == nil {
			c.Write([]byte("ok"))
			c.Close()
		}
	}()

	// Our own listener (nobody dials it in this test).
	ourLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ourLn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := RaceDirect(ctx, ourLn, []string{peerLn.Addr().String()}, 2*time.Second)
	if err != nil {
		t.Fatalf("RaceDirect: %v", err)
	}
	defer conn.Close()
	buf := make([]byte, 2)
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := conn.Read(buf); err != nil || string(buf) != "ok" {
		t.Fatalf("read = %q err=%v", buf, err)
	}
}

func TestRaceDirectAcceptSucceeds(t *testing.T) {
	ourLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ourLn.Close()
	// Peer dials us; no reachable peer candidate given.
	go func() {
		time.Sleep(50 * time.Millisecond)
		c, err := net.Dial("tcp", ourLn.Addr().String())
		if err == nil {
			c.Write([]byte("in"))
			c.Close()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := RaceDirect(ctx, ourLn, []string{"192.0.2.1:9"}, 300*time.Millisecond)
	if err != nil {
		t.Fatalf("RaceDirect: %v", err)
	}
	defer conn.Close()
	buf := make([]byte, 2)
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := conn.Read(buf); err != nil || string(buf) != "in" {
		t.Fatalf("read = %q err=%v", buf, err)
	}
}

func TestLocalCandidatesIncludesAdvertiseAndExcludesLoopback(t *testing.T) {
	cands := LocalCandidates(7777, "203.0.113.5:7777")
	found := false
	for _, c := range cands {
		if c == "203.0.113.5:7777" {
			found = true
		}
		if c == "127.0.0.1:7777" {
			t.Fatalf("loopback leaked into candidates: %v", cands)
		}
	}
	if !found {
		t.Fatalf("advertise not included: %v", cands)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/connect/ -run 'RaceDirect|LocalCandidates' -v`
Expected: FAIL — undefined identifiers.

- [ ] **Step 3: Write minimal implementation**

```go
// Package connect establishes a raw byte stream to the peer: it races a direct
// TCP dial/accept and falls back to the server relay. It carries no crypto — the
// caller wraps the returned conn with package secure.
package connect

import (
	"context"
	"errors"
	"net"
	"time"
)

// LocalCandidates lists publicly-plausible TCP endpoints for this host: every
// non-loopback, non-private, non-link-local interface address at the given
// port, plus an explicit advertise value (host:port) when provided.
func LocalCandidates(port int, advertise string) []string {
	var out []string
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipnet.IP
		if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsPrivate() || ip.IsUnspecified() {
			continue
		}
		out = append(out, net.JoinHostPort(ip.String(), itoa(port)))
	}
	if advertise != "" {
		out = append(out, advertise)
	}
	return out
}

// RaceDirect returns the first connection made either by accepting on ln or by
// dialing one of peerCandidates, whichever completes first.
func RaceDirect(ctx context.Context, ln net.Listener, peerCandidates []string, dialTimeout time.Duration) (net.Conn, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	type result struct {
		c   net.Conn
		err error
	}
	results := make(chan result, 1+len(peerCandidates))

	go func() {
		c, err := ln.Accept()
		select {
		case results <- result{c, err}:
		case <-ctx.Done():
			if c != nil {
				c.Close()
			}
		}
	}()

	var d net.Dialer
	for _, cand := range peerCandidates {
		cand := cand
		go func() {
			dctx, dcancel := context.WithTimeout(ctx, dialTimeout)
			defer dcancel()
			c, err := d.DialContext(dctx, "tcp", cand)
			select {
			case results <- result{c, err}:
			case <-ctx.Done():
				if c != nil {
					c.Close()
				}
			}
		}()
	}

	for {
		select {
		case <-ctx.Done():
			return nil, errors.New("connect: no direct connection established")
		case r := <-results:
			if r.err == nil && r.c != nil {
				return r.c, nil
			}
			// keep waiting for another candidate / the acceptor
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
```

> Note: `RaceDirect` may leak the losing goroutines' connections in the failure-flood edge (all candidates error). That's acceptable for v1; the accept goroutine is unblocked by closing `ln` in the caller (Task 8) via `defer ln.Close()`. Use `strconv.Itoa` instead of the hand-rolled `itoa` if you prefer — either is fine; `strconv` is cleaner, replace it and drop `itoa`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/connect/ -run 'RaceDirect|LocalCandidates' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/connect/direct.go server/internal/connect/direct_test.go
git commit -m "feat(cli): direct TCP candidate gathering + dial/accept race"
```

---

### Task 6: Server relay endpoint `/relay` + metering + quota (`internal/signal`)

**Files:**
- Create: `internal/signal/relay.go`
- Test: `internal/signal/relay_test.go`

**Interfaces:**
- Consumes: `github.com/coder/websocket`; stdlib `net/http`, `sync`, `io`, `context`.
- Produces:
  - `type RelayDeps struct { OwnerOf func(code string) (string, bool); OverQuota func(ctx context.Context, owner string) bool; Record func(ctx context.Context, sessionID, owner, code string, bytes int64); NewID func() string }`
  - `func RelayHandler(deps RelayDeps) http.HandlerFunc` — on `GET /relay?code=<code>`: rejects (HTTP 403) if `code` is empty or `OwnerOf` returns not-ok, or (HTTP 429-style close) if `OverQuota`. Accepts the WebSocket; the **first** peer for a code parks in an in-memory rendezvous map keyed by code; the **second** peer is matched to it. Then it pipes binary messages bidirectionally between the two sockets, summing bytes and calling `Record` periodically (and once at close) with the running total under a per-session id.
  - The relay never inspects payloads (they are E2E-encrypted TLS records).

- [ ] **Step 1: Write the failing test**

```go
package signal

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestRelayPipesAndMeters(t *testing.T) {
	var mu sync.Mutex
	recorded := map[string]int64{}
	deps := RelayDeps{
		OwnerOf:   func(code string) (string, bool) { return "owner1", code == "123456" },
		OverQuota: func(ctx context.Context, owner string) bool { return false },
		Record: func(ctx context.Context, sid, owner, code string, b int64) {
			mu.Lock()
			recorded[owner] = b // MAX semantics: last running total wins
			mu.Unlock()
		},
		NewID: func() string { return "sess1" },
	}
	srv := httptest.NewServer(RelayHandler(deps))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	dial := func() *websocket.Conn {
		c, _, err := websocket.Dial(ctx, wsURL+"?code=123456", nil)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		return c
	}
	a := dial()
	b := dial()
	defer a.Close(websocket.StatusNormalClosure, "")
	defer b.Close(websocket.StatusNormalClosure, "")

	if err := a.Write(ctx, websocket.MessageBinary, []byte("hello-peer")); err != nil {
		t.Fatalf("a write: %v", err)
	}
	typ, got, err := b.Read(ctx)
	if err != nil || typ != websocket.MessageBinary || string(got) != "hello-peer" {
		t.Fatalf("b read = %q typ=%v err=%v", got, typ, err)
	}

	// Let a metering tick land.
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	total := recorded["owner1"]
	mu.Unlock()
	if total < int64(len("hello-peer")) {
		t.Fatalf("metered %d bytes, want >= %d", total, len("hello-peer"))
	}
}

func TestRelayRejectsUnknownCode(t *testing.T) {
	deps := RelayDeps{
		OwnerOf:   func(code string) (string, bool) { return "", false },
		OverQuota: func(ctx context.Context, owner string) bool { return false },
		Record:    func(ctx context.Context, sid, owner, code string, b int64) {},
		NewID:     func() string { return "x" },
	}
	srv := httptest.NewServer(RelayHandler(deps))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "?code=nope")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/signal/ -run TestRelay -v`
Expected: FAIL — `undefined: RelayHandler` / `RelayDeps`.

- [ ] **Step 3: Write minimal implementation**

```go
package signal

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

type RelayDeps struct {
	OwnerOf   func(code string) (string, bool)
	OverQuota func(ctx context.Context, owner string) bool
	Record    func(ctx context.Context, sessionID, owner, code string, bytes int64)
	NewID     func() string
}

type relayWaiter struct {
	conn  *websocket.Conn
	ready chan *websocket.Conn // receives the second peer's conn
}

type relayRendezvous struct {
	mu      sync.Mutex
	waiting map[string]*relayWaiter
}

func newRelayRendezvous() *relayRendezvous {
	return &relayRendezvous{waiting: map[string]*relayWaiter{}}
}

// pair blocks until a partner arrives for code; the first caller parks, the
// second caller matches and wakes the first. Returns (partnerConn, isFirst).
func (rr *relayRendezvous) pair(code string, self *websocket.Conn) (*websocket.Conn, bool) {
	rr.mu.Lock()
	if w, ok := rr.waiting[code]; ok {
		delete(rr.waiting, code)
		rr.mu.Unlock()
		w.ready <- self // hand ourselves to the parked first peer
		return w.conn, false
	}
	w := &relayWaiter{conn: self, ready: make(chan *websocket.Conn, 1)}
	rr.waiting[code] = w
	rr.mu.Unlock()
	partner := <-w.ready
	return partner, true
}

func RelayHandler(deps RelayDeps) http.HandlerFunc {
	rr := newRelayRendezvous()
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		owner, ok := deps.OwnerOf(code)
		if code == "" || !ok {
			http.Error(w, "unknown code", http.StatusForbidden)
			return
		}
		if deps.OverQuota(r.Context(), owner) {
			http.Error(w, "relay quota exceeded", http.StatusForbidden)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c.SetReadLimit(-1) // file bytes; no small default cap

		partner, _ := rr.pair(code, c)
		if partner == nil {
			c.Close(websocket.StatusInternalError, "no partner")
			return
		}

		sid := deps.NewID()
		var total atomic.Int64 // written from both pipe goroutines
		ctx := context.Background()
		defer func() { deps.Record(ctx, sid, owner, code, total.Load()) }()

		// Pipe self→partner, accumulating bytes; a second goroutine pipes the
		// reverse direction. Either side closing ends the session.
		errc := make(chan error, 2)
		go pipe(ctx, c, partner, &total, deps, sid, owner, code, errc)
		go pipe(ctx, partner, c, &total, deps, sid, owner, code, errc)
		<-errc
		c.Close(websocket.StatusNormalClosure, "")
		partner.Close(websocket.StatusNormalClosure, "")
	}
}

func pipe(ctx context.Context, from, to *websocket.Conn, total *atomic.Int64, deps RelayDeps, sid, owner, code string, errc chan<- error) {
	var lastRecord time.Time
	for {
		typ, data, err := from.Read(ctx)
		if err != nil {
			errc <- err
			return
		}
		if err := to.Write(ctx, typ, data); err != nil {
			errc <- err
			return
		}
		n := total.Add(int64(len(data)))
		if time.Since(lastRecord) > time.Second {
			deps.Record(ctx, sid, owner, code, n)
			lastRecord = time.Now()
		}
	}
}
```

> Note for the implementer: `total` is an `atomic.Int64` because both pipe goroutines update it — keep it atomic (verified under `-race`). The `time`-based throttle plus the deferred final `Record` give the metering store the running total; the store's `RecordUsage` keeps the MAX per session id, so periodic + final overwrites are safe. Run `go test -race ./internal/signal/ -run TestRelay` before committing.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test -race ./internal/signal/ -run TestRelay -v`
Expected: PASS, no race warnings.

- [ ] **Step 5: Commit**

```bash
git add server/internal/signal/relay.go server/internal/signal/relay_test.go
git commit -m "feat(server): /relay websocket pipe with owner metering + quota gate"
```

---

### Task 7: Connect orchestration (direct → relay) + relay client (`internal/connect`)

**Files:**
- Create: `internal/connect/relay.go`
- Test: `internal/connect/relay_test.go`

**Interfaces:**
- Consumes: `RaceDirect` (Task 5); `github.com/coder/websocket`; stdlib `net`, `context`, `time`.
- Produces:
  - `func DialRelay(ctx context.Context, serverURL, code string) (net.Conn, error)` — dials `serverURL+"/relay?code="+code` and adapts the WebSocket into a `net.Conn` (binary messages as the byte stream), so TLS can run over it.
  - `func Establish(ctx context.Context, p EstablishParams) (conn net.Conn, viaRelay bool, err error)` where
    `type EstablishParams struct { Listener net.Listener; PeerCandidates []string; DialTimeout time.Duration; DirectWindow time.Duration; ServerURL, Code string; RelayOnly bool }` —
    tries `RaceDirect` within `DirectWindow` (unless `RelayOnly`); on success returns `(conn, false, nil)`; otherwise returns `DialRelay(...)` as `(conn, true, nil)`.

- [ ] **Step 1: Write the failing test**

```go
package connect

import (
	"context"
	"net"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/signal"
)

func TestEstablishFallsBackToRelay(t *testing.T) {
	// Relay server that just pairs and echoes via the real RelayHandler.
	deps := signal.RelayDeps{
		OwnerOf:   func(code string) (string, bool) { return "o", true },
		OverQuota: func(ctx context.Context, owner string) bool { return false },
		Record:    func(ctx context.Context, sid, owner, code string, b int64) {},
		NewID:     func() string { return "s" },
	}
	srv := httptest.NewServer(signal.RelayHandler(deps))
	defer srv.Close()
	serverURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	// No reachable peer candidate → direct fails fast → relay.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	type out struct {
		c        net.Conn
		viaRelay bool
		err      error
	}
	// Peer B connects to the relay and echoes.
	go func() {
		bc, err := DialRelay(ctx, serverURL, "123456")
		if err != nil {
			return
		}
		defer bc.Close()
		buf := make([]byte, 4)
		bc.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, err := bc.Read(buf); err == nil {
			bc.Write(buf)
		}
	}()

	conn, viaRelay, err := Establish(ctx, EstablishParams{
		Listener:       ln,
		PeerCandidates: []string{"192.0.2.1:9"}, // unreachable (TEST-NET)
		DialTimeout:    200 * time.Millisecond,
		DirectWindow:   300 * time.Millisecond,
		ServerURL:      serverURL,
		Code:           "123456",
	})
	if err != nil {
		t.Fatalf("establish: %v", err)
	}
	if !viaRelay {
		t.Fatal("expected relay fallback")
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(2 * time.Second))
	conn.Write([]byte("ping"))
	buf := make([]byte, 4)
	if _, err := conn.Read(buf); err != nil || string(buf) != "ping" {
		t.Fatalf("relay echo = %q err=%v", buf, err)
	}
	_ = websocket.MessageBinary // keep import if adapter is in another file
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/connect/ -run TestEstablish -v`
Expected: FAIL — `undefined: Establish` / `DialRelay`.

- [ ] **Step 3: Write minimal implementation**

```go
package connect

import (
	"context"
	"net"
	"net/url"
	"time"

	"github.com/coder/websocket"
)

// DialRelay connects to the server relay for a code and presents it as a
// net.Conn carrying the raw byte stream (over binary WebSocket messages).
func DialRelay(ctx context.Context, serverURL, code string) (net.Conn, error) {
	u, err := url.Parse(serverURL)
	if err != nil {
		return nil, err
	}
	u.Path = "/relay"
	u.RawQuery = "code=" + url.QueryEscape(code)
	c, _, err := websocket.Dial(ctx, u.String(), nil)
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(-1)
	// websocket.NetConn adapts a Conn to net.Conn; MessageBinary is the stream type.
	return websocket.NetConn(context.Background(), c, websocket.MessageBinary), nil
}

type EstablishParams struct {
	Listener       net.Listener
	PeerCandidates []string
	DialTimeout    time.Duration
	DirectWindow   time.Duration
	ServerURL      string
	Code           string
	RelayOnly      bool
}

// Establish returns a raw stream to the peer: a direct TCP connection when one
// can be raced within DirectWindow, otherwise the metered server relay.
func Establish(ctx context.Context, p EstablishParams) (net.Conn, bool, error) {
	if !p.RelayOnly {
		dctx, cancel := context.WithTimeout(ctx, p.DirectWindow)
		conn, err := RaceDirect(dctx, p.Listener, p.PeerCandidates, p.DialTimeout)
		cancel()
		if err == nil {
			return conn, false, nil
		}
	}
	conn, err := DialRelay(ctx, p.ServerURL, p.Code)
	if err != nil {
		return nil, false, err
	}
	return conn, true, nil
}
```

> Note: confirm the exact `websocket.NetConn` signature in the vendored `coder/websocket` version (`go doc github.com/coder/websocket.NetConn`) — in current versions it is `func NetConn(ctx context.Context, c *Conn, msgType MessageType) net.Conn`. Adapt the call if the signature differs.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/connect/ -run TestEstablish -v`
Expected: PASS. Also run the whole package: `go test ./internal/connect/`.

- [ ] **Step 5: Commit**

```bash
git add server/internal/connect/relay.go server/internal/connect/relay_test.go
git commit -m "feat(cli): connect orchestration (direct race → metered relay)"
```

---

### Task 8: CLI `send` / `receive` + wiring + `/relay` server registration

**Files:**
- Create: `cmd/relayium/crossnet.go` (the `send`/`receive` subcommands)
- Modify: `cmd/relayium/run.go` (add `send`/`receive` cases + usage lines)
- Modify: `main.go` (register the `/relay` handler)
- Test: `cmd/relayium/crossnet_test.go`

**Interfaces:**
- Consumes: `rzvous.Join`/`DoHandshake`, `secure.NewIdentity`/`Client`/`Server`, `connect.LocalCandidates`/`Establish`, `xfer.Send`/`Receive`/`BuildManifest`, `signal.RelayHandler`/`RelayDeps`.
- Produces: `Run` dispatches `send`/`receive`; a shared `crossnetConn` helper that, given a code + role, returns a ready `*tls.Conn` and prints the SAS.

- [ ] **Step 1: Write the failing test** (CLI-level dispatch/usage; the full transfer is covered by Task 9 E2E and the package tests of Tasks 1–7)

```go
package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunSendNeedsArgs(t *testing.T) {
	var out, errb bytes.Buffer
	code := Run([]string{"send"}, &out, &errb)
	if code == 0 {
		t.Fatal("send with no args should exit non-zero")
	}
	if !strings.Contains(errb.String(), "send") {
		t.Fatalf("stderr should explain send usage, got %q", errb.String())
	}
}

func TestUsageListsSendReceive(t *testing.T) {
	var out, errb bytes.Buffer
	Run(nil, &out, &errb)
	combined := out.String() + errb.String()
	if !strings.Contains(combined, "send") || !strings.Contains(combined, "receive") {
		t.Fatalf("usage should list send/receive, got %q", combined)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./cmd/relayium/ -run 'Send|Usage' -v`
Expected: FAIL — `send`/`receive` not in usage/dispatch yet.

- [ ] **Step 3: Write minimal implementation**

Add to `cmd/relayium/run.go`'s dispatch switch (inside `Run`):

```go
	case "send":
		return runSendCross(args[1:], stdout, stderr)
	case "receive":
		return runReceiveCross(args[1:], stdout, stderr)
```

Extend the `usage` const with:

```
  relayium send <src...> <code>              send to a peer over a pairing code (cross-network)
  relayium receive <code> [destdir]          receive such a transfer
```

Create `cmd/relayium/crossnet.go`:

```go
package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/relayium/relayium/internal/connect"
	"github.com/relayium/relayium/internal/rzvous"
	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/xfer"
)

const defaultServer = "wss://relayium.com"

type crossFlags struct {
	server    string
	advertise string
	relayOnly bool
	verify    bool
}

// crossnetConn joins the code room, runs the handshake, establishes a direct or
// relayed stream, wraps it in pinned TLS, prints the SAS, and returns the conn.
func crossnetConn(ctx context.Context, code, name string, f crossFlags, stderr io.Writer) (*tls.Conn, bool, error) {
	id, err := secure.NewIdentity()
	if err != nil {
		return nil, false, err
	}
	sess, err := rzvous.Join(ctx, f.server, code, name)
	if err != nil {
		return nil, false, err
	}
	defer sess.Close()

	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		return nil, false, err
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	hs, err := rzvous.DoHandshake(ctx, sess, id, connect.LocalCandidates(port, f.advertise))
	if err != nil {
		return nil, false, err
	}

	fmt.Fprintf(stderr, "SAS: %s  (compare on both ends)\n", hs.SAS)
	if f.verify {
		if !confirmSAS(stderr) {
			return nil, false, fmt.Errorf("SAS not confirmed; aborting")
		}
	}

	raw, viaRelay, err := connect.Establish(ctx, connect.EstablishParams{
		Listener:       ln,
		PeerCandidates: hs.PeerCandidates,
		DialTimeout:    3 * time.Second,
		DirectWindow:   4 * time.Second,
		ServerURL:      f.server,
		Code:           code,
		RelayOnly:      f.relayOnly,
	})
	if err != nil {
		return nil, false, err
	}

	var tconn *tls.Conn
	if hs.IsServer {
		tconn, err = secure.Server(raw, id, hs.PeerFingerprint)
	} else {
		tconn, err = secure.Client(raw, id, hs.PeerFingerprint)
	}
	if err != nil {
		raw.Close()
		return nil, false, err
	}
	if viaRelay {
		fmt.Fprintln(stderr, "path: relay (metered)")
	} else {
		fmt.Fprintln(stderr, "path: direct (free)")
	}
	return tconn, viaRelay, nil
}

func runSendCross(args []string, stdout, stderr io.Writer) int {
	f, rest, err := parseCrossFlags(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if len(rest) < 2 {
		fmt.Fprintln(stderr, "send needs <src...> <code>")
		return 2
	}
	code := rest[len(rest)-1]
	srcs := rest[:len(rest)-1]
	m, paths, err := xfer.BuildManifest(srcs)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	conn, _, err := crossnetConn(ctx, code, "sender", f, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer conn.Close()
	rep, err := xfer.Send(conn, m, paths, xfer.SendOpts{})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return reportExit(rep, stderr)
}

func runReceiveCross(args []string, stdout, stderr io.Writer) int {
	f, rest, err := parseCrossFlags(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if len(rest) < 1 {
		fmt.Fprintln(stderr, "receive needs <code> [destdir]")
		return 2
	}
	code := rest[0]
	dest := "."
	if len(rest) > 1 {
		dest = rest[1]
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	conn, _, err := crossnetConn(ctx, code, "receiver", f, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer conn.Close()
	rep, err := xfer.Receive(conn, dest, xfer.RecvOpts{})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return reportExit(rep, stderr)
}

func confirmSAS(w io.Writer) bool {
	// Minimal: in --verify mode read a line from stdin; "y"/"yes" confirms.
	fmt.Fprint(w, "Do the SAS codes match on both ends? [y/N] ")
	var ans string
	fmt.Fscanln(osStdin(), &ans)
	return ans == "y" || ans == "yes" || ans == "Y"
}
```

Create `cmd/relayium/crossflags.go`:

```go
package main

import (
	"flag"
	"os"
)

func parseCrossFlags(args []string) (crossFlags, []string, error) {
	fs := flag.NewFlagSet("cross", flag.ContinueOnError)
	var f crossFlags
	fs.StringVar(&f.server, "server", defaultServer, "Relayium server base URL (self-host)")
	fs.StringVar(&f.advertise, "advertise", "", "host:port to advertise as a direct endpoint")
	fs.BoolVar(&f.relayOnly, "relay-only", false, "skip direct dial, use the relay")
	fs.BoolVar(&f.verify, "verify", false, "require SAS confirmation before transfer")
	if err := fs.Parse(args); err != nil {
		return f, nil, err
	}
	return f, fs.Args(), nil
}

func osStdin() *os.File { return os.Stdin }
```

Register the relay in `main.go` (near the other `mux.HandleFunc` registrations, e.g. after the `/ws` block; use the real `pairReg`, `acct` service, and an id generator that already exist there):

```go
	mux.HandleFunc("/relay", signal.RelayHandler(signal.RelayDeps{
		OwnerOf: pairReg.OwnerOf,
		OverQuota: func(ctx context.Context, owner string) bool {
			return acct.RelayOverQuota(ctx, owner) // add this thin method on the account Service (below)
		},
		Record: func(ctx context.Context, sid, owner, code string, b int64) {
			acct.RecordRelaySession(ctx, sid, owner, code, b) // add this thin method too
		},
		NewID: newID,
	}))
```

Add two thin methods to the account service (`internal/account/turn.go` or a new `relay.go` in that package) that wrap the existing store, so `main.go` stays clean and `internal/signal` needs no account import:

```go
// RelayOverQuota reports whether the owner is at/over the monthly relay cap.
func (s *Service) RelayOverQuota(ctx context.Context, owner string) bool {
	if owner == "" {
		return false
	}
	st := s.resolveSettings(ctx)
	since, _ := monthRange(periodOf(s.now().Unix()))
	used, err := s.store.UserRelayedSince(ctx, owner, since)
	if err != nil {
		return false // fail open, matching handleICE
	}
	return used >= st.RelayMonthlyFree
}

// RecordRelaySession records a relay session's running byte total under a
// stable session id (RecordUsage keeps the max per id).
func (s *Service) RecordRelaySession(ctx context.Context, sessionID, owner, code string, bytes int64) {
	if owner == "" {
		return
	}
	_ = s.store.RecordUsage(ctx, UsageEvent{
		AllocID:      "relay:" + sessionID,
		Token:        code,
		UserID:       owner,
		RelayedBytes: bytes,
		RecordedAt:   s.now(),
	})
}
```

> Note for the implementer: before writing the `main.go` block, open `main.go` and confirm the real identifiers — the account service variable name (the grep showed `acct.Routes()`), `pairReg`, and the id generator (`newID`). Confirm `UsageEvent`'s field names in `internal/account/sqlite.go` (`AllocID`, `Token`, `UserID`, `RelayedBytes`, `RecordedAt`) and that `resolveSettings`, `monthRange`, `periodOf`, `s.now`, `s.store` exist (they do — used by `handleICE`). Match names exactly. `reportExit` already exists in `run.go` (Phase 1). Confirm `defaultServer` should be `wss://relayium.com` (or the real production host).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go vet ./... && go test ./cmd/relayium/ -run 'Send|Usage' -v && go build ./...`
Expected: `go vet` clean, tests PASS, whole module builds.

- [ ] **Step 5: Commit**

```bash
git add server/cmd/relayium/ server/main.go server/internal/account/
git commit -m "feat(cli): send/receive cross-network subcommands + /relay wiring"
```

---

### Task 9: End-to-end cross-network test (in-process, opt-in real)

**Files:**
- Create: `cmd/relayium/crossnet_e2e_test.go`

**Interfaces:** Consumes the whole stack. This test wires an in-process rendezvous (`signal` hub) + relay on one `httptest` server and drives `send`+`receive` against it entirely on loopback (no external network) — so it runs in CI. It is the acceptance gate for the feature.

- [ ] **Step 1: Write the test**

```go
package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/signal"
)

// inProcServer runs the rendezvous (/ws) + relay (/relay) for a fixed code.
func inProcServer(t *testing.T, code string) string {
	t.Helper()
	hub := signal.NewHub()
	go hub.Run()
	n := 0
	newID := func() string { n++; return "p" + string(rune('a'+n)) }
	deps := signal.RelayDeps{
		OwnerOf:   func(c string) (string, bool) { return "owner", c == code },
		OverQuota: func(ctx context.Context, owner string) bool { return false },
		Record:    func(ctx context.Context, sid, owner, c string, b int64) {},
		NewID:     newID,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		signal.ServeWS(hub, newID)(w, r, c) // adapt to the real ServeWS signature
	})
	mux.HandleFunc("/relay", signal.RelayHandler(deps))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func TestCrossnetEndToEndOverRelay(t *testing.T) {
	code := "123456"
	server := inProcServer(t, code)

	// Source file to send.
	srcDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(srcDir, "hello.txt"), []byte("cross-network!"), 0o644); err != nil {
		t.Fatal(err)
	}
	dstDir := t.TempDir()

	// Force relay (no reachable direct candidate on loopback across "networks").
	sendArgs := []string{"send", "--server", server, "--relay-only", filepath.Join(srcDir, "hello.txt"), code}
	recvArgs := []string{"receive", "--server", server, "--relay-only", code, dstDir}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = ctx

	errc := make(chan int, 2)
	go func() {
		var o, e bytes.Buffer
		errc <- Run(recvArgs, &o, &e)
	}()
	// Small stagger so the receiver parks on the relay first (either order works).
	time.Sleep(100 * time.Millisecond)
	go func() {
		var o, e bytes.Buffer
		errc <- Run(sendArgs, &o, &e)
	}()

	for i := 0; i < 2; i++ {
		select {
		case code := <-errc:
			if code != 0 {
				t.Fatalf("a peer exited %d", code)
			}
		case <-time.After(15 * time.Second):
			t.Fatal("timeout waiting for transfer")
		}
	}

	got, err := os.ReadFile(filepath.Join(dstDir, "hello.txt"))
	if err != nil || string(got) != "cross-network!" {
		t.Fatalf("received = %q err=%v", got, err)
	}
}
```

> Note: `--server` here is a `ws://` loopback URL, so the CLI's `defaultServer` `wss://` default must be overridable by the flag (it is). If `send`/`receive` reference production defaults anywhere else, ensure the flag wins. Adapt `inProcServer`'s `/ws` registration to the real `ServeWS` signature (same fix as Task 1).

- [ ] **Step 2: Run it**

Run: `cd server && go test ./cmd/relayium/ -run TestCrossnetEndToEnd -v`
Expected: PASS — the file transfers over the in-process relay, E2E-encrypted, verified byte-identical.

- [ ] **Step 3: Run the whole suite**

Run: `cd server && go test ./... && go vet ./...`
Expected: all PASS, vet clean. Confirm the server packages (account/signal/metering) still pass untouched except the new `/relay` additions.

- [ ] **Step 4: Commit**

```bash
git add server/cmd/relayium/crossnet_e2e_test.go
git commit -m "test(cli): in-process end-to-end cross-network transfer over relay"
```

---

## Self-Review

**1. Spec coverage:**
- §3 `send`/`receive` + flags (`--server`/`--advertise`/`--relay-only`/`--verify`) → Task 8 (`crossflags.go`, `crossnet.go`). ✅
- §4.1 join code room via `/ws?code=` → Task 1. ✅
- §4.2 commit-reveal + candidate exchange → Tasks 2 (primitives) + 4 (exchange). ✅
- §4.3 direct TCP dial/accept race → Task 5; §4.3 relay fallback + orchestration → Task 7. ✅
- §4.4 pinned TLS + SAS → Tasks 2 (SAS) + 3 (pinned TLS); SAS print/`--verify` → Task 8. ✅
- §4.5 `xfer.Send`/`Receive` over the TLS stream → Task 8. ✅
- §5 `/relay` endpoint + metering to owner + quota gate → Task 6 (handler) + Task 8 (wiring to the real store/pairReg + fail-open quota). ✅
- §7 package layout (`rzvous`/`connect`/`secure`, server relay in `signal`) → Tasks 1–8; the two thin account methods keep `signal` free of an account import. ✅
- §9 unit + integration + opt-in-style E2E → Tasks 1–8 unit/integration; Task 9 in-process E2E (runs in CI, no external network — stronger than opt-in, so the spec's opt-in real E2E is an optional manual extra, noted below). ✅

**2. Placeholder scan:** No bogus types or stubs remain — Task 3's `pinCheck` uses the real `func([][]byte, [][]*x509.Certificate) error` signature; Task 6 uses `atomic.Int64` directly. The remaining Notes are concrete confirm-one-real-signature pointers (the vendored `ServeWS` signature in Tasks 1/8/9; `websocket.NetConn` in Task 7; the real `main.go` identifiers/`UsageEvent` fields in Task 8) — each names the exact file/symbol to check, not an open-ended TODO. No "TBD"/"implement later"/vague-error-handling instructions anywhere.

**3. Type consistency:** `rzvous.Session`/`Join`/`SendSignal`/`RecvSignal`, `rzvous.Handshake{PeerFingerprint,SAS,PeerCandidates,IsServer}`/`DoHandshake`, `secure.Identity{TLSCert,Fingerprint}`/`NewIdentity`/`Commit`/`VerifyCommit`/`SAS`/`NewNonce`/`Client`/`Server`, `connect.LocalCandidates`/`RaceDirect`/`DialRelay`/`Establish`/`EstablishParams`, `signal.RelayHandler`/`RelayDeps{OwnerOf,OverQuota,Record,NewID}`, and the account `RelayOverQuota`/`RecordRelaySession` wrappers are used with identical signatures across Tasks 1–9. `xfer.Send`/`Receive`/`BuildManifest`/`SendOpts`/`RecvOpts`/`Report` match the Phase-1 surface confirmed in code. ✅

## Deferred within this spec (tracked, not dropped)
- Real opt-in E2E against a **deployed** rendezvous (Task 9 covers in-process; a `RELAYIUM_E2E_CROSSNET=1`-gated real run is a nice manual extra but not required for the CI gate).
- Progress reporting for cross-network transfers (reuse Phase-1 `SendOpts.Progress`; wire a TTY bar later).
- `RaceDirect` losing-goroutine connection cleanup on the all-error path (bounded; noted in Task 5).
- STUN-based candidates / NAT hole-punch (out of scope per spec §2) — expands free-direct coverage to double-NAT peers in a later phase.
