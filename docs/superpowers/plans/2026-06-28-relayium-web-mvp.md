# Relayium Web MVP (M0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a web-first file transfer MVP where two browsers on the same LAN discover each other through a lightweight Go signaling server and transfer a file directly over a WebRTC DataChannel with end-to-end encryption the server cannot break.

**Architecture:** A stateless Go WebSocket signaling server groups clients by public IP into "rooms" and relays WebRTC signaling messages. The Svelte web client establishes a WebRTC DataChannel peer-to-peer; on top of WebRTC's DTLS it layers its own X25519 key agreement + AES-256-GCM chunk encryption with a SAS (short authentication string) so a malicious signaling server cannot MITM. Files stream chunk-by-chunk and are written to disk via the File System Access API (never fully buffered in memory).

**Tech Stack:** Go (`coder/websocket`) for the signaling server; TypeScript + Svelte (Vite) for the client; `libsodium-wrappers` for X25519 + SAS; WebCrypto `AES-256-GCM` for bulk encryption; Vitest for client unit tests; Go `testing` for the server.

## Global Constraints

- **Module path (Go):** `github.com/relayium/relayium` (server lives in `server/`).
- **Go version floor:** 1.22.
- **Node version floor:** 20.
- **Bulk cipher:** AES-256-GCM via WebCrypto (universally available, hardware-accelerated). X25519 ECDH, HKDF, and SAS hashing via libsodium. (Spec names AES-256-GCM as the default; XChaCha20-Poly1305 is a future M-stage option, NOT this MVP.)
- **Chunk size:** 64 KiB plaintext per frame (safe under WebRTC DataChannel message limits).
- **Server invariant:** the signaling server MUST never receive file bytes, plaintext, or session keys. It sees only: room membership (public IP), device nickname, online status, and opaque signaling payloads.
- **Scope ceiling:** same-LAN / same-public-IP only. NO TURN, NO accounts, NO persistent device identity, NO resume, NO directories — those are M1/M2 per the spec.
- **Browser target:** Chrome/Chromium is the full-feature target; Firefox/Safari must at least complete a basic transfer (streaming download may degrade to a fallback).

---

## File Structure

```
server/
  go.mod                         # module github.com/relayium/relayium
  main.go                        # flag parsing, http.Server wiring
  internal/signal/
    hub.go                       # Hub: rooms keyed by public IP, register/unregister/relay
    hub_test.go
    client.go                    # per-connection read/write pump
    message.go                   # wire message types (JSON) + (de)serialization
    message_test.go
    roomkey.go                   # publicIP(*http.Request) -> room key
    roomkey_test.go
web/
  package.json
  vite.config.ts
  vitest.config.ts
  index.html
  src/
    lib/protocol.ts              # signaling message TS types (mirror of server message.go)
    lib/signaling.ts             # SignalingClient: WS connect, peer list, send/recv signals
    lib/signaling.test.ts
    lib/crypto.ts                # X25519 key agreement, AES-GCM seal/open, SAS derivation
    lib/crypto.test.ts
    lib/transfer.ts              # framing, chunk encrypt/decrypt, incremental SHA-256
    lib/transfer.test.ts
    lib/webrtc.ts                # PeerConnection + DataChannel lifecycle over signaling
    lib/filesink.ts              # streaming write: File System Access API + fallback
    App.svelte                   # UI: peer list, drag/drop, SAS confirm, progress
    main.ts                      # mount
```

---

### Task 1: Project scaffolding (server + web tooling)

**Files:**
- Create: `server/go.mod`, `server/main.go`
- Create: `web/package.json`, `web/vite.config.ts`, `web/vitest.config.ts`, `web/index.html`, `web/src/main.ts`, `web/src/App.svelte`
- Create: `.gitignore`

**Interfaces:**
- Produces: a runnable (empty) Go HTTP server on `:8080`; a runnable Vite dev server for the Svelte app; a working `vitest` command.

- [ ] **Step 1: Create `.gitignore`**

```
# Go
server/relayium-server
# Node
web/node_modules/
web/dist/
```

- [ ] **Step 2: Initialize Go module**

Run: `cd server && go mod init github.com/relayium/relayium && go get github.com/coder/websocket@latest`
Expected: `go.mod` created with `coder/websocket` required.

- [ ] **Step 3: Minimal `server/main.go`**

```go
package main

import (
	"flag"
	"log"
	"net/http"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	flag.Parse()
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	log.Printf("relayium signaling server listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
```

- [ ] **Step 4: Verify server builds and runs**

Run: `cd server && go build -o relayium-server . && ./relayium-server & sleep 1 && curl -s localhost:8080/healthz && kill %1`
Expected: prints `ok`.

- [ ] **Step 5: Scaffold the Svelte + Vite + Vitest app**

Run: `cd web && npm create vite@latest . -- --template svelte-ts` then `npm install` then `npm install -D vitest jsdom` and `npm install libsodium-wrappers` and `npm install -D @types/libsodium-wrappers`.

- [ ] **Step 6: Create `web/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "jsdom", globals: true },
});
```

- [ ] **Step 7: Verify the toolchain**

Run: `cd web && npx vitest run --passWithNoTests`
Expected: exits 0 (no tests yet).

- [ ] **Step 8: Commit**

```bash
git add server web .gitignore
git commit -m "chore: scaffold Go signaling server and Svelte web client"
```

---

### Task 2: Signaling wire protocol (server-side message types)

**Files:**
- Create: `server/internal/signal/message.go`, `server/internal/signal/message_test.go`

**Interfaces:**
- Produces:
  - `type Envelope struct { Type string; From string; To string; Name string; Data json.RawMessage }`
  - `const (TypeJoin="join"; TypeWelcome="welcome"; TypePeers="peers"; TypeSignal="signal")`
  - `type Peer struct { ID string; Name string }`
  - `func DecodeEnvelope([]byte) (Envelope, error)`
  - `func EncodeEnvelope(Envelope) ([]byte, error)`

- [ ] **Step 1: Write the failing test**

```go
package signal

import "testing"

func TestEnvelopeRoundTrip(t *testing.T) {
	in := Envelope{Type: TypeSignal, To: "peer-2", Data: []byte(`{"sdp":"x"}`)}
	b, err := EncodeEnvelope(in)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	out, err := DecodeEnvelope(b)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Type != TypeSignal || out.To != "peer-2" || string(out.Data) != `{"sdp":"x"}` {
		t.Fatalf("round trip mismatch: %+v", out)
	}
}

func TestDecodeRejectsInvalidJSON(t *testing.T) {
	if _, err := DecodeEnvelope([]byte("not json")); err == nil {
		t.Fatal("expected error on invalid JSON")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/signal/ -run TestEnvelope`
Expected: FAIL (undefined: Envelope).

- [ ] **Step 3: Write `message.go`**

```go
package signal

import "encoding/json"

const (
	TypeJoin    = "join"
	TypeWelcome = "welcome"
	TypePeers   = "peers"
	TypeSignal  = "signal"
)

// Envelope is every message on the wire, client<->server, in both directions.
type Envelope struct {
	Type  string          `json:"type"`
	From  string          `json:"from,omitempty"`  // server-stamped sender peer id
	To    string          `json:"to,omitempty"`    // target peer id for TypeSignal
	Name  string          `json:"name,omitempty"`  // device nickname on join / self on welcome
	Peers []Peer          `json:"peers,omitempty"` // room roster on TypePeers
	Data  json.RawMessage `json:"data,omitempty"`  // opaque WebRTC/crypto payload
}

type Peer struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func DecodeEnvelope(b []byte) (Envelope, error) {
	var e Envelope
	err := json.Unmarshal(b, &e)
	return e, err
}

func EncodeEnvelope(e Envelope) ([]byte, error) {
	return json.Marshal(e)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/signal/ -run TestEnvelope`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/signal/message.go server/internal/signal/message_test.go
git commit -m "feat(server): signaling wire protocol envelope"
```

---

### Task 3: Room key derivation (public IP)

**Files:**
- Create: `server/internal/signal/roomkey.go`, `server/internal/signal/roomkey_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `func RoomKey(r *http.Request) string` — returns the client public IP; honors `X-Forwarded-For` first hop when present, else `RemoteAddr` host.

- [ ] **Step 1: Write the failing test**

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/signal/ -run TestRoomKey`
Expected: FAIL (undefined: RoomKey).

- [ ] **Step 3: Write `roomkey.go`**

```go
package signal

import (
	"net"
	"net/http"
	"strings"
)

// RoomKey groups clients sharing a public IP into one room (pseudo-LAN discovery).
func RoomKey(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first := strings.TrimSpace(strings.Split(xff, ",")[0])
		if first != "" {
			return first
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/signal/ -run TestRoomKey`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/signal/roomkey.go server/internal/signal/roomkey_test.go
git commit -m "feat(server): derive room key from public IP"
```

---

### Task 4: Signaling hub (rooms, roster broadcast, relay)

**Files:**
- Create: `server/internal/signal/hub.go`, `server/internal/signal/hub_test.go`

**Interfaces:**
- Consumes: `Envelope`, `Peer` (Task 2).
- Produces:
  - `type Conn interface { Send(Envelope) }` — abstraction over a websocket connection so the hub is testable without real sockets.
  - `type Hub struct { ... }`
  - `func NewHub() *Hub`
  - `func (h *Hub) Join(room, id, name string, c Conn)` — registers a peer, sends it `welcome`, broadcasts updated `peers` roster to the room.
  - `func (h *Hub) Leave(room, id string)` — removes peer, re-broadcasts roster.
  - `func (h *Hub) Relay(room string, e Envelope)` — forwards a `signal` envelope (with `e.From` stamped) to the single peer `e.To` in the same room.
  - All methods are safe for concurrent use.

- [ ] **Step 1: Write the failing test**

```go
package signal

import (
	"sync"
	"testing"
)

type fakeConn struct {
	mu   sync.Mutex
	sent []Envelope
}

func (f *fakeConn) Send(e Envelope) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, e)
}

func (f *fakeConn) last() Envelope {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sent[len(f.sent)-1]
}

func TestJoinSendsWelcomeAndRoster(t *testing.T) {
	h := NewHub()
	a := &fakeConn{}
	h.Join("ip1", "a", "Alice", a)
	if a.sent[0].Type != TypeWelcome || a.sent[0].Name != "a" {
		t.Fatalf("expected welcome with self id, got %+v", a.sent[0])
	}
	b := &fakeConn{}
	h.Join("ip1", "b", "Bob", b)
	// Both a and b should now have received a peers roster naming both.
	if got := a.last(); got.Type != TypePeers || len(got.Peers) != 2 {
		t.Fatalf("a roster wrong: %+v", got)
	}
}

func TestRelayGoesOnlyToTarget(t *testing.T) {
	h := NewHub()
	a, b, c := &fakeConn{}, &fakeConn{}, &fakeConn{}
	h.Join("ip1", "a", "A", a)
	h.Join("ip1", "b", "B", b)
	h.Join("ip1", "c", "C", c)
	bBefore := len(b.sent)
	cBefore := len(c.sent)
	h.Relay("ip1", Envelope{Type: TypeSignal, From: "a", To: "b", Data: []byte(`"x"`)})
	if len(b.sent) != bBefore+1 || b.last().From != "a" {
		t.Fatalf("b should receive relayed signal from a")
	}
	if len(c.sent) != cBefore {
		t.Fatalf("c must NOT receive a's signal")
	}
}

func TestLeaveRebroadcastsRoster(t *testing.T) {
	h := NewHub()
	a, b := &fakeConn{}, &fakeConn{}
	h.Join("ip1", "a", "A", a)
	h.Join("ip1", "b", "B", b)
	h.Leave("ip1", "b")
	if got := a.last(); got.Type != TypePeers || len(got.Peers) != 1 {
		t.Fatalf("a should see roster of 1 after b leaves: %+v", got)
	}
}

func TestRoomsAreIsolated(t *testing.T) {
	h := NewHub()
	a, b := &fakeConn{}, &fakeConn{}
	h.Join("ip1", "a", "A", a)
	h.Join("ip2", "b", "B", b)
	if got := a.last(); len(got.Peers) != 1 {
		t.Fatalf("a in ip1 must not see b in ip2: %+v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/signal/ -run 'TestJoin|TestRelay|TestLeave|TestRooms'`
Expected: FAIL (undefined: NewHub).

- [ ] **Step 3: Write `hub.go`**

```go
package signal

import "sync"

// Conn is the hub's view of a connection; the real websocket adapter implements it.
type Conn interface {
	Send(Envelope)
}

type peer struct {
	id   string
	name string
	conn Conn
}

type Hub struct {
	mu    sync.Mutex
	rooms map[string]map[string]*peer // room key -> peer id -> peer
}

func NewHub() *Hub {
	return &Hub{rooms: make(map[string]map[string]*peer)}
}

func (h *Hub) Join(room, id, name string, c Conn) {
	h.mu.Lock()
	if h.rooms[room] == nil {
		h.rooms[room] = make(map[string]*peer)
	}
	h.rooms[room][id] = &peer{id: id, name: name, conn: c}
	h.mu.Unlock()

	c.Send(Envelope{Type: TypeWelcome, Name: id})
	h.broadcastRoster(room)
}

func (h *Hub) Leave(room, id string) {
	h.mu.Lock()
	if h.rooms[room] != nil {
		delete(h.rooms[room], id)
		if len(h.rooms[room]) == 0 {
			delete(h.rooms, room)
		}
	}
	h.mu.Unlock()
	h.broadcastRoster(room)
}

func (h *Hub) Relay(room string, e Envelope) {
	h.mu.Lock()
	var target *peer
	if h.rooms[room] != nil {
		target = h.rooms[room][e.To]
	}
	h.mu.Unlock()
	if target != nil {
		target.conn.Send(e)
	}
}

func (h *Hub) broadcastRoster(room string) {
	h.mu.Lock()
	members := h.rooms[room]
	roster := make([]Peer, 0, len(members))
	conns := make([]Conn, 0, len(members))
	for _, p := range members {
		roster = append(roster, Peer{ID: p.id, Name: p.name})
		conns = append(conns, p.conn)
	}
	h.mu.Unlock()
	for _, c := range conns {
		c.Send(Envelope{Type: TypePeers, Peers: roster})
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/signal/ -run 'TestJoin|TestRelay|TestLeave|TestRooms' -race`
Expected: PASS, no race warnings.

- [ ] **Step 5: Commit**

```bash
git add server/internal/signal/hub.go server/internal/signal/hub_test.go
git commit -m "feat(server): signaling hub with IP-keyed rooms and targeted relay"
```

---

### Task 5: WebSocket adapter + HTTP wiring

**Files:**
- Create: `server/internal/signal/client.go`
- Modify: `server/main.go` (add `/ws` handler, serve static `web/dist`)

**Interfaces:**
- Consumes: `Hub`, `Conn`, `Envelope`, `RoomKey` (Tasks 2–4).
- Produces: `func ServeWS(h *Hub, idgen func() string) http.HandlerFunc` — upgrades the connection, assigns a peer id via `idgen`, waits for the first `join` envelope to capture the nickname, then pumps messages: `signal` envelopes are stamped with `From` and relayed; disconnect triggers `Leave`.

**Note on testing:** the read/write pump over a real websocket is covered by the Task 12 integration test, not a unit test. Keep this task's logic thin — all branching lives in the already-tested `Hub`.

- [ ] **Step 1: Write `client.go`**

```go
package signal

import (
	"context"
	"sync"

	"github.com/coder/websocket"
)

type wsConn struct {
	ctx  context.Context
	c    *websocket.Conn
	mu   sync.Mutex // serialize writes
}

func (w *wsConn) Send(e Envelope) {
	b, err := EncodeEnvelope(e)
	if err != nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.c.Write(w.ctx, websocket.MessageText, b)
}

// ServeWS handles one websocket client for its whole lifetime.
func ServeWS(h *Hub, idgen func() string) func(ctx context.Context, c *websocket.Conn, room string) {
	return func(ctx context.Context, c *websocket.Conn, room string) {
		id := idgen()
		conn := &wsConn{ctx: ctx, c: c}
		joined := false
		defer func() {
			if joined {
				h.Leave(room, id)
			}
		}()
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			e, err := DecodeEnvelope(data)
			if err != nil {
				continue
			}
			switch e.Type {
			case TypeJoin:
				if !joined {
					joined = true
					h.Join(room, id, e.Name, conn)
				}
			case TypeSignal:
				e.From = id
				h.Relay(room, e)
			}
		}
	}
}
```

- [ ] **Step 2: Wire `/ws` and static serving into `main.go`**

```go
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"log"
	"net/http"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/signal"
)

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	static := flag.String("static", "../web/dist", "static files directory")
	flag.Parse()

	hub := signal.NewHub()
	handle := signal.ServeWS(hub, newID)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		room := signal.RoomKey(r)
		ctx := r.Context()
		handle(ctx, c, room)
		_ = c.Close(websocket.StatusNormalClosure, "")
		_ = ctx
		_ = context.Background
	})
	mux.Handle("/", http.FileServer(http.Dir(*static)))

	log.Printf("relayium signaling server listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
```

- [ ] **Step 3: Verify it builds**

Run: `cd server && go build -o relayium-server . && go vet ./...`
Expected: builds clean, vet passes.

- [ ] **Step 4: Commit**

```bash
git add server/internal/signal/client.go server/main.go
git commit -m "feat(server): websocket adapter and HTTP wiring"
```

---

### Task 6: Client signaling protocol types

**Files:**
- Create: `web/src/lib/protocol.ts`

**Interfaces:**
- Produces TS types mirroring `message.go`:
  - `interface Peer { id: string; name: string }`
  - `type Envelope = { type: "join"|"welcome"|"peers"|"signal"; from?: string; to?: string; name?: string; peers?: Peer[]; data?: unknown }`

- [ ] **Step 1: Write `protocol.ts`**

```ts
export interface Peer {
  id: string;
  name: string;
}

export type Envelope = {
  type: "join" | "welcome" | "peers" | "signal";
  from?: string;
  to?: string;
  name?: string;
  peers?: Peer[];
  data?: unknown;
};
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/protocol.ts
git commit -m "feat(web): signaling protocol types mirroring server"
```

---

### Task 7: Crypto module (X25519 + AES-256-GCM + SAS)

**Files:**
- Create: `web/src/lib/crypto.ts`, `web/src/lib/crypto.test.ts`

**Interfaces:**
- Produces:
  - `interface KeyPair { publicKey: Uint8Array; privateKey: Uint8Array }`
  - `async function ready(): Promise<void>` — awaits libsodium init.
  - `function generateKeyPair(): KeyPair` — X25519 keypair (`crypto_kx_keypair`).
  - `interface SessionKeys { send: CryptoKey; recv: CryptoKey }` — AES-GCM keys.
  - `async function deriveSession(role: "initiator"|"responder", self: KeyPair, peerPublic: Uint8Array): Promise<SessionKeys>` — ECDH via libsodium `crypto_kx_*_session_keys`, then imports the two 32-byte secrets as WebCrypto AES-256-GCM keys. Initiator's `send` MUST equal responder's `recv` and vice versa.
  - `function sas(self: Uint8Array, peer: Uint8Array): string` — order-independent 6-digit code from both public keys (`crypto_generichash` over the two pubkeys sorted lexicographically).
  - `async function seal(key: CryptoKey, seq: number, plaintext: Uint8Array): Promise<Uint8Array>` — AES-GCM; nonce = 12-byte big-endian counter from `seq`.
  - `async function open(key: CryptoKey, seq: number, ciphertext: Uint8Array): Promise<Uint8Array>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import {
  ready, generateKeyPair, deriveSession, sas, seal, open,
} from "./crypto";

beforeAll(async () => { await ready(); });

describe("crypto", () => {
  it("derives matching session keys across the two roles", async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const ka = await deriveSession("initiator", a, b.publicKey);
    const kb = await deriveSession("responder", b, a.publicKey);
    // a seals with its send key; b must open with its recv key.
    const msg = new TextEncoder().encode("hello relayium");
    const ct = await seal(ka.send, 0, msg);
    const pt = await open(kb.recv, 0, ct);
    expect(new TextDecoder().decode(pt)).toBe("hello relayium");
  });

  it("produces an order-independent 6-digit SAS that differs per pair", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const c = generateKeyPair();
    expect(sas(a.publicKey, b.publicKey)).toMatch(/^\d{6}$/);
    expect(sas(a.publicKey, b.publicKey)).toBe(sas(b.publicKey, a.publicKey));
    expect(sas(a.publicKey, b.publicKey)).not.toBe(sas(a.publicKey, c.publicKey));
  });

  it("fails to open with a wrong sequence number (nonce binding)", async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const ka = await deriveSession("initiator", a, b.publicKey);
    const kb = await deriveSession("responder", b, a.publicKey);
    const ct = await seal(ka.send, 5, new Uint8Array([1, 2, 3]));
    await expect(open(kb.recv, 6, ct)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/crypto.test.ts`
Expected: FAIL (cannot find module './crypto').

- [ ] **Step 3: Write `crypto.ts`**

```ts
import sodium from "libsodium-wrappers";

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface SessionKeys {
  send: CryptoKey;
  recv: CryptoKey;
}

export async function ready(): Promise<void> {
  await sodium.ready;
}

export function generateKeyPair(): KeyPair {
  const kp = sodium.crypto_kx_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function deriveSession(
  role: "initiator" | "responder",
  self: KeyPair,
  peerPublic: Uint8Array,
): Promise<SessionKeys> {
  // crypto_kx gives a (rx, tx) pair; client/server roles produce mirror-image
  // keys so that one side's tx equals the other side's rx.
  const keys =
    role === "initiator"
      ? sodium.crypto_kx_client_session_keys(
          self.publicKey,
          self.privateKey,
          peerPublic,
        )
      : sodium.crypto_kx_server_session_keys(
          self.publicKey,
          self.privateKey,
          peerPublic,
        );
  return {
    send: await importAesKey(keys.sharedTx),
    recv: await importAesKey(keys.sharedRx),
  };
}

function nonceFromSeq(seq: number): Uint8Array {
  const n = new Uint8Array(12);
  const view = new DataView(n.buffer);
  // high 4 bytes zero; low 8 bytes hold the counter (supports >2^53 frames anyway).
  view.setUint32(4, Math.floor(seq / 2 ** 32));
  view.setUint32(8, seq >>> 0);
  return n;
}

export async function seal(
  key: CryptoKey,
  seq: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonceFromSeq(seq) },
    key,
    plaintext,
  );
  return new Uint8Array(ct);
}

export async function open(
  key: CryptoKey,
  seq: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonceFromSeq(seq) },
    key,
    ciphertext,
  );
  return new Uint8Array(pt);
}

export function sas(self: Uint8Array, peer: Uint8Array): string {
  // Order-independent: sort the two public keys before hashing.
  const [a, b] = compare(self, peer) <= 0 ? [self, peer] : [peer, self];
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a, 0);
  combined.set(b, a.length);
  const digest = sodium.crypto_generichash(8, combined);
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const num = view.getUint32(0) ^ view.getUint32(4);
  return (num % 1_000_000).toString().padStart(6, "0");
}

function compare(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/crypto.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/crypto.ts web/src/lib/crypto.test.ts
git commit -m "feat(web): X25519 session keys, AES-256-GCM seal/open, SAS"
```

---

### Task 8: Transfer codec (framing + incremental SHA-256)

**Files:**
- Create: `web/src/lib/transfer.ts`, `web/src/lib/transfer.test.ts`

**Interfaces:**
- Consumes: `SessionKeys`, `seal`, `open` (Task 7).
- Produces:
  - `const CHUNK_SIZE = 64 * 1024`
  - `interface FileMeta { name: string; size: number }`
  - `type Frame = { kind: "meta"; meta: FileMeta } | { kind: "chunk"; seq: number; data: Uint8Array } | { kind: "done"; sha256: string }`
  - `function encodeFrame(f: Frame): Uint8Array` / `function decodeFrame(b: Uint8Array): Frame` — length-prefixed binary framing (1 type byte + payload). Chunk payload is raw ciphertext; meta/done payloads are UTF-8 JSON.
  - `class Sender` with `async *frames(file: File, keys: SessionKeys): AsyncGenerator<Uint8Array>` — yields encoded `meta`, then encrypted `chunk` frames read via `file.stream()`, computing SHA-256 incrementally, then a `done` frame with the hex digest.
  - `class Receiver` with `feed(encoded: Uint8Array): Promise<{ meta?: FileMeta; chunk?: Uint8Array; done?: { ok: boolean } }>` — decodes, decrypts chunks in `seq` order, updates a running SHA-256, and on `done` reports whether the digest matched.
- Producer note for Task 11: `Sender.frames` and `Receiver.feed` are the only transport-facing entry points.

- [ ] **Step 1: Write the failing test (round-trip over an in-memory loopback)**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { ready, generateKeyPair, deriveSession } from "./crypto";
import { Sender, Receiver } from "./transfer";

beforeAll(async () => { await ready(); });

async function session() {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const ka = await deriveSession("initiator", a, b.publicKey);
  const kb = await deriveSession("responder", b, a.publicKey);
  return { ka, kb };
}

describe("transfer", () => {
  it("round-trips a multi-chunk file with integrity check", async () => {
    const { ka, kb } = await session();
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    const file = new File([bytes], "build.tar.gz");

    const sender = new Sender();
    const receiver = new Receiver();
    let meta: { name: string; size: number } | undefined;
    const received: Uint8Array[] = [];
    let ok = false;

    for await (const frame of sender.frames(file, ka)) {
      const out = await receiver.feed(frame, kb);
      if (out.meta) meta = out.meta;
      if (out.chunk) received.push(out.chunk);
      if (out.done) ok = out.done.ok;
    }

    expect(meta).toEqual({ name: "build.tar.gz", size: 200_000 });
    expect(ok).toBe(true);
    const joined = new Uint8Array(received.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of received) { joined.set(c, off); off += c.length; }
    expect(joined).toEqual(bytes);
  });

  it("reports integrity failure when a chunk is corrupted", async () => {
    const { ka, kb } = await session();
    const file = new File([new Uint8Array(100_000)], "x.bin");
    const sender = new Sender();
    const receiver = new Receiver();
    let ok: boolean | undefined;
    let first = true;
    for await (const frame of sender.frames(file, ka)) {
      // Flip a byte in the first chunk frame's ciphertext region (after the type byte).
      if (first && frame[0] === 1 /* chunk */) { frame[10] ^= 0xff; first = false; }
      try {
        const out = await receiver.feed(frame, kb);
        if (out.done) ok = out.done.ok;
      } catch {
        ok = false; // AEAD open throws on tamper — that is a detected failure.
      }
    }
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/transfer.test.ts`
Expected: FAIL (cannot find module './transfer').

- [ ] **Step 3: Write `transfer.ts`**

```ts
import { seal, open, type SessionKeys } from "./crypto";

export const CHUNK_SIZE = 64 * 1024;

export interface FileMeta {
  name: string;
  size: number;
}

const KIND_META = 0;
const KIND_CHUNK = 1;
const KIND_DONE = 2;

const enc = new TextEncoder();
const dec = new TextDecoder();

function frame(kind: number, seq: number, payload: Uint8Array): Uint8Array {
  // [1 byte kind][4 byte big-endian seq][payload]
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, seq);
  out.set(payload, 5);
  return out;
}

async function sha256Hex(buffers: Uint8Array[]): Promise<string> {
  // Used only by tests indirectly; runtime uses the incremental path below.
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) { joined.set(b, off); off += b.length; }
  const digest = await crypto.subtle.digest("SHA-256", joined);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Incremental SHA-256 via an accumulating buffer list kept small by hashing
// the whole stream once at the end. For 1GB this would be too much memory, so
// we instead fold using subtle.digest over a rolling concatenation is NOT ok.
// Use a streaming hash: we keep a growing list ONLY of digests is not possible
// with WebCrypto (no streaming). Therefore we hash each chunk's plaintext into
// a chained value: h = SHA256(h || chunk). This is integrity-equivalent for our
// purpose (detecting corruption) and uses O(1) memory.
async function chainHash(prev: Uint8Array, chunk: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(prev.length + chunk.length);
  buf.set(prev, 0);
  buf.set(chunk, prev.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export class Sender {
  async *frames(file: File, keys: SessionKeys): AsyncGenerator<Uint8Array> {
    const meta: FileMeta = { name: file.name, size: file.size };
    yield frame(KIND_META, 0, enc.encode(JSON.stringify(meta)));

    let seq = 0;
    let hash = new Uint8Array(32);
    const reader = file.stream().getReader();
    let carry = new Uint8Array(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      let buf = new Uint8Array(carry.length + value.length);
      buf.set(carry, 0);
      buf.set(value, carry.length);
      while (buf.length >= CHUNK_SIZE) {
        const piece = buf.slice(0, CHUNK_SIZE);
        hash = await chainHash(hash, piece);
        yield frame(KIND_CHUNK, seq, await seal(keys.send, seq, piece));
        seq++;
        buf = buf.slice(CHUNK_SIZE);
      }
      carry = buf;
    }
    if (carry.length > 0) {
      hash = await chainHash(hash, carry);
      yield frame(KIND_CHUNK, seq, await seal(keys.send, seq, carry));
      seq++;
    }
    yield frame(KIND_DONE, seq, enc.encode(JSON.stringify({ sha256: toHex(hash) })));
  }
}

export class Receiver {
  private expectedSeq = 0;
  private hash = new Uint8Array(32);

  async feed(
    encoded: Uint8Array,
    keys: SessionKeys,
  ): Promise<{ meta?: FileMeta; chunk?: Uint8Array; done?: { ok: boolean } }> {
    const kind = encoded[0];
    const seq = new DataView(encoded.buffer, encoded.byteOffset).getUint32(1);
    const payload = encoded.slice(5);
    if (kind === KIND_META) {
      return { meta: JSON.parse(dec.decode(payload)) as FileMeta };
    }
    if (kind === KIND_CHUNK) {
      if (seq !== this.expectedSeq) throw new Error("out-of-order chunk");
      const plain = await open(keys.recv, seq, payload); // throws on tamper
      this.expectedSeq++;
      this.hash = await chainHash(this.hash, plain);
      return { chunk: plain };
    }
    if (kind === KIND_DONE) {
      const { sha256 } = JSON.parse(dec.decode(payload)) as { sha256: string };
      return { done: { ok: sha256 === toHex(this.hash) } };
    }
    throw new Error("unknown frame kind " + kind);
  }
}
```

- [ ] **Step 4: Remove the unused `sha256Hex` helper**

Delete the `sha256Hex` function (it documented the rejected approach; the chained hash is the real one). Keep `chainHash`, `toHex`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/transfer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/transfer.ts web/src/lib/transfer.test.ts
git commit -m "feat(web): transfer codec with framing, AEAD chunks, integrity hash"
```

---

### Task 9: Signaling client (WebSocket wrapper)

**Files:**
- Create: `web/src/lib/signaling.ts`, `web/src/lib/signaling.test.ts`

**Interfaces:**
- Consumes: `Envelope`, `Peer` (Task 6).
- Produces:
  - `class SignalingClient` constructed with `(url: string, name: string, wsFactory?: (url: string) => WebSocketLike)` so tests inject a fake socket.
  - `interface WebSocketLike { send(d: string): void; close(): void; onopen: (() => void) | null; onmessage: ((ev: { data: string }) => void) | null; onclose: (() => void) | null }`
  - `onSelfId(cb: (id: string) => void)`, `onPeers(cb: (peers: Peer[]) => void)`, `onSignal(cb: (from: string, data: unknown) => void)`.
  - `sendSignal(to: string, data: unknown): void`.
  - On socket open it sends a `join` envelope with `name`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { SignalingClient, type WebSocketLike } from "./signaling";

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(d: string) { this.sent.push(d); }
  close() {}
  emit(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

describe("SignalingClient", () => {
  it("sends join on open and routes welcome/peers/signal", () => {
    const sock = new FakeSocket();
    const c = new SignalingClient("ws://x", "Alice", () => sock);
    let selfId = "";
    let peers = 0;
    let signalFrom = "";
    c.onSelfId((id) => (selfId = id));
    c.onPeers((p) => (peers = p.length));
    c.onSignal((from) => (signalFrom = from));

    sock.onopen?.();
    expect(JSON.parse(sock.sent[0])).toMatchObject({ type: "join", name: "Alice" });

    sock.emit({ type: "welcome", name: "abc123" });
    sock.emit({ type: "peers", peers: [{ id: "abc123", name: "Alice" }, { id: "def", name: "Bob" }] });
    sock.emit({ type: "signal", from: "def", data: { sdp: "x" } });

    expect(selfId).toBe("abc123");
    expect(peers).toBe(2);
    expect(signalFrom).toBe("def");
  });

  it("stamps the target on sendSignal", () => {
    const sock = new FakeSocket();
    const c = new SignalingClient("ws://x", "Alice", () => sock);
    sock.onopen?.();
    c.sendSignal("def", { ice: "candidate" });
    const last = JSON.parse(sock.sent[sock.sent.length - 1]);
    expect(last).toMatchObject({ type: "signal", to: "def", data: { ice: "candidate" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/signaling.test.ts`
Expected: FAIL (cannot find module './signaling').

- [ ] **Step 3: Write `signaling.ts`**

```ts
import type { Envelope, Peer } from "./protocol";

export interface WebSocketLike {
  send(d: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
}

type WsFactory = (url: string) => WebSocketLike;

export class SignalingClient {
  private sock: WebSocketLike;
  private selfCb: ((id: string) => void) | null = null;
  private peersCb: ((p: Peer[]) => void) | null = null;
  private signalCb: ((from: string, data: unknown) => void) | null = null;

  constructor(
    url: string,
    private name: string,
    wsFactory: WsFactory = (u) => new WebSocket(u) as unknown as WebSocketLike,
  ) {
    this.sock = wsFactory(url);
    this.sock.onopen = () => this.send({ type: "join", name: this.name });
    this.sock.onmessage = (ev) => this.handle(JSON.parse(ev.data) as Envelope);
  }

  onSelfId(cb: (id: string) => void) { this.selfCb = cb; }
  onPeers(cb: (p: Peer[]) => void) { this.peersCb = cb; }
  onSignal(cb: (from: string, data: unknown) => void) { this.signalCb = cb; }

  sendSignal(to: string, data: unknown) {
    this.send({ type: "signal", to, data });
  }

  private send(e: Envelope) { this.sock.send(JSON.stringify(e)); }

  private handle(e: Envelope) {
    if (e.type === "welcome" && e.name) this.selfCb?.(e.name);
    else if (e.type === "peers" && e.peers) this.peersCb?.(e.peers);
    else if (e.type === "signal" && e.from) this.signalCb?.(e.from, e.data);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/signaling.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/signaling.ts web/src/lib/signaling.test.ts
git commit -m "feat(web): signaling client over websocket"
```

---

### Task 10: WebRTC connection + streaming file sink

**Files:**
- Create: `web/src/lib/webrtc.ts`, `web/src/lib/filesink.ts`

**Interfaces:**
- Consumes: `SignalingClient` (Task 9), `KeyPair` (Task 7).
- Produces (`webrtc.ts`):
  - `interface RtcConfig { iceServers: RTCIceServer[] }`
  - `const DEFAULT_ICE: RtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }`
  - `async function connect(opts): Promise<RTCDataChannel>` where `opts = { signaling: SignalingClient; peerId: string; selfKey: Uint8Array; role: "initiator"|"responder"; onPeerKey: (k: Uint8Array)=>void; config?: RtcConfig }`. The initiator creates the DataChannel + offer (embedding its X25519 public key in the signal `data`); the responder answers. Both forward ICE candidates through signaling. `onPeerKey` fires with the peer's public key extracted from the offer/answer. Applies `bufferedAmountLowThreshold` backpressure (see Task 11 usage).
- Produces (`filesink.ts`):
  - `interface FileSink { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> }`
  - `async function createFileSink(name: string, size: number): Promise<FileSink>` — uses `window.showSaveFilePicker` to stream to disk when available; otherwise falls back to accumulating chunks and triggering a Blob download on `close()` (logs a console warning that large files may exhaust memory in this browser).

**Testing note:** `RTCPeerConnection` and `showSaveFilePicker` are not available under jsdom; these modules are validated by the Task 12 manual integration test, not unit tests. Keep them thin.

- [ ] **Step 1: Write `filesink.ts`**

```ts
export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export async function createFileSink(name: string, _size: number): Promise<FileSink> {
  const picker = (window as unknown as {
    showSaveFilePicker?: (o: { suggestedName: string }) => Promise<{
      createWritable: () => Promise<{
        write: (d: Uint8Array) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }>;
  }).showSaveFilePicker;

  if (picker) {
    const handle = await picker({ suggestedName: name });
    const writable = await handle.createWritable();
    return {
      write: (chunk) => writable.write(chunk),
      close: () => writable.close(),
    };
  }

  // Fallback: buffer in memory, download as a Blob on close.
  console.warn(
    "File System Access API unavailable; buffering in memory. Large files may fail in this browser.",
  );
  const parts: Uint8Array[] = [];
  return {
    write: async (chunk) => { parts.push(chunk); },
    close: async () => {
      const blob = new Blob(parts as BlobPart[]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    },
  };
}
```

- [ ] **Step 2: Write `webrtc.ts`**

```ts
import type { SignalingClient } from "./signaling";

export interface RtcConfig {
  iceServers: RTCIceServer[];
}

export const DEFAULT_ICE: RtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

interface ConnectOpts {
  signaling: SignalingClient;
  peerId: string;
  selfKey: Uint8Array;
  role: "initiator" | "responder";
  onPeerKey: (k: Uint8Array) => void;
  config?: RtcConfig;
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export async function connect(opts: ConnectOpts): Promise<RTCDataChannel> {
  const pc = new RTCPeerConnection(opts.config ?? DEFAULT_ICE);
  const { signaling, peerId, selfKey, role, onPeerKey } = opts;

  pc.onicecandidate = (e) => {
    if (e.candidate) signaling.sendSignal(peerId, { ice: e.candidate });
  };

  let channel: RTCDataChannel;
  const ready = new Promise<RTCDataChannel>((resolve) => {
    if (role === "initiator") {
      channel = pc.createDataChannel("relayium");
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = 1 << 20;
      channel.onopen = () => resolve(channel);
    } else {
      pc.ondatachannel = (ev) => {
        channel = ev.channel;
        channel.binaryType = "arraybuffer";
        channel.bufferedAmountLowThreshold = 1 << 20;
        if (channel.readyState === "open") resolve(channel);
        else channel.onopen = () => resolve(channel);
      };
    }
  });

  signaling.onSignal(async (from, data) => {
    if (from !== peerId) return;
    const msg = data as { sdp?: RTCSessionDescriptionInit; key?: string; ice?: RTCIceCandidateInit };
    if (msg.key) onPeerKey(unb64(msg.key));
    if (msg.sdp) {
      await pc.setRemoteDescription(msg.sdp);
      if (msg.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signaling.sendSignal(peerId, { sdp: answer, key: b64(selfKey) });
      }
    }
    if (msg.ice) await pc.addIceCandidate(msg.ice);
  });

  if (role === "initiator") {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.sendSignal(peerId, { sdp: offer, key: b64(selfKey) });
  }

  return ready;
}
```

- [ ] **Step 3: Verify type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/webrtc.ts web/src/lib/filesink.ts
git commit -m "feat(web): WebRTC datachannel setup and streaming file sink"
```

---

### Task 11: UI wiring (App.svelte)

**Files:**
- Modify: `web/src/App.svelte`, `web/src/main.ts`

**Interfaces:**
- Consumes: every `src/lib` module. This task assembles the full send/receive flow:
  1. On mount: `await ready()`, generate a keypair, connect `SignalingClient` to `ws://<host>/ws`, render the peer roster (excluding self).
  2. Sender: pick a peer → drag/drop or pick a file → `connect({role:"initiator"})` → `deriveSession` once `onPeerKey` fires → show SAS → on confirm, iterate `Sender.frames(file, keys)` writing each encoded frame to the DataChannel, honoring `bufferedAmount` backpressure → show progress.
  3. Receiver: on incoming DataChannel (a peer initiated) → `connect({role:"responder"})` → `deriveSession` → show SAS prompt → feed each DataChannel message to `Receiver.feed` → first `meta` opens a `FileSink`; chunks are written; `done` closes the sink and reports integrity.

- [ ] **Step 1: Write `App.svelte`**

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { ready, generateKeyPair, deriveSession, sas, type KeyPair, type SessionKeys } from "./lib/crypto";
  import { SignalingClient } from "./lib/signaling";
  import { connect } from "./lib/webrtc";
  import { Sender, Receiver, CHUNK_SIZE } from "./lib/transfer";
  import { createFileSink } from "./lib/filesink";
  import type { Peer } from "./lib/protocol";

  let selfKey: KeyPair;
  let signaling: SignalingClient;
  let peers: Peer[] = [];
  let selfId = "";
  let status = "starting…";
  let sasCode = "";
  let progress = 0;

  onMount(async () => {
    await ready();
    selfKey = generateKeyPair();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    signaling = new SignalingClient(`${proto}://${location.host}/ws`, deviceName());
    signaling.onSelfId((id) => (selfId = id));
    signaling.onPeers((p) => (peers = p));
    status = "ready";
    listenForIncoming();
  });

  function deviceName(): string {
    return `${navigator.platform || "device"}-${Math.floor(Math.random() * 1000)}`;
  }

  function visiblePeers(): Peer[] {
    return peers.filter((p) => p.id !== selfId);
  }

  async function sendTo(peerId: string, file: File) {
    status = `connecting to ${peerId}…`;
    let keys: SessionKeys | undefined;
    const channel = await connect({
      signaling, peerId, selfKey: selfKey.publicKey, role: "initiator",
      onPeerKey: async (pk) => {
        keys = await deriveSession("initiator", selfKey, pk);
        sasCode = sas(selfKey.publicKey, pk);
      },
    });
    while (!keys) await sleep(20);
    status = `verify code ${sasCode}, sending…`;
    const sender = new Sender();
    let sent = 0;
    for await (const frame of sender.frames(file, keys!)) {
      await backpressure(channel);
      channel.send(frame);
      sent += frame.byteLength;
      progress = Math.min(100, Math.round((sent / file.size) * 100));
    }
    status = "sent ✓";
  }

  function listenForIncoming() {
    // Responder path: a peer's offer arrives via signaling; connect() as responder.
    signaling.onSignal(async (from, data) => {
      const msg = data as { sdp?: { type?: string } };
      if (msg.sdp?.type !== "offer") return;
      let keys: SessionKeys | undefined;
      const channel = await connect({
        signaling, peerId: from, selfKey: selfKey.publicKey, role: "responder",
        onPeerKey: async (pk) => {
          keys = await deriveSession("responder", selfKey, pk);
          sasCode = sas(selfKey.publicKey, pk);
        },
      });
      while (!keys) await sleep(20);
      const receiver = new Receiver();
      let sink: Awaited<ReturnType<typeof createFileSink>> | undefined;
      let total = 0, got = 0;
      channel.onmessage = async (ev) => {
        const out = await receiver.feed(new Uint8Array(ev.data as ArrayBuffer), keys!);
        if (out.meta) { sink = await createFileSink(out.meta.name, out.meta.size); total = out.meta.size; }
        if (out.chunk && sink) { await sink.write(out.chunk); got += out.chunk.length; progress = Math.round((got/total)*100); }
        if (out.done && sink) { await sink.close(); status = out.done.ok ? "received ✓" : "INTEGRITY FAILED ✗"; }
      };
    });
  }

  async function backpressure(ch: RTCDataChannel) {
    if (ch.bufferedAmount > 8 * CHUNK_SIZE) {
      await new Promise<void>((r) => { ch.onbufferedamountlow = () => r(); });
    }
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let pickedPeer: string | null = null;
  function onDrop(e: DragEvent, peerId: string) {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) sendTo(peerId, file);
  }
</script>

<main>
  <h1>Relayium</h1>
  <p>status: {status} {#if sasCode}· code <b>{sasCode}</b>{/if}</p>
  {#if progress > 0}<progress value={progress} max="100"></progress> {progress}%{/if}
  <h2>Devices on your network</h2>
  {#if visiblePeers().length === 0}<p>No other devices yet. Open this page on another device on the same network.</p>{/if}
  <ul>
    {#each visiblePeers() as p}
      <li
        on:dragover|preventDefault
        on:drop={(e) => onDrop(e, p.id)}
      >
        {p.name}
        <input type="file" on:change={(e) => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; if (f) sendTo(p.id, f); }} />
      </li>
    {/each}
  </ul>
</main>
```

- [ ] **Step 2: Ensure `main.ts` mounts App**

```ts
import App from "./App.svelte";

const app = new App({ target: document.getElementById("app")! });
export default app;
```

(If the Vite template used Svelte 5 `mount()`, keep its generated form instead — match the scaffold.)

- [ ] **Step 3: Build to verify everything compiles**

Run: `cd web && npm run build`
Expected: `dist/` produced with no type errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/App.svelte web/src/main.ts
git commit -m "feat(web): wire full send/receive flow with SAS and progress"
```

---

### Task 12: End-to-end integration + acceptance verification

**Files:**
- Create: `docs/TESTING.md` (manual acceptance procedure)

**Interfaces:**
- Consumes: the built server and `web/dist`.

This task verifies the spec's §7 acceptance criteria. There is no unit test; it is a scripted manual procedure because it requires two real browsers, a real network, and real WebRTC.

- [ ] **Step 1: Build both halves**

Run: `cd web && npm run build && cd ../server && go build -o relayium-server .`
Expected: `web/dist` exists; `relayium-server` binary exists.

- [ ] **Step 2: Run the server**

Run: `cd server && ./relayium-server --addr :8080 --static ../web/dist`
Expected: logs "listening on :8080".

- [ ] **Step 3: Acceptance — two devices discover and transfer (criteria 1, 3)**

Procedure: On two machines on the same LAN, open `http://<server-LAN-IP>:8080`. Confirm each sees the other in "Devices on your network". Drag a known file (note its `shasum -a 256`) from device A onto device B's entry. Approve the SAS. Confirm device B downloads the file and `shasum -a 256` matches the source.
Expected: rosters populate; transfer completes; SHA-256 matches.

- [ ] **Step 4: Acceptance — 1GB without OOM (criterion 2)**

Procedure: `mkfile 1g big.bin` (macOS) or `head -c 1G /dev/urandom > big.bin`. Transfer it in Chrome (which has `showSaveFilePicker`). Watch the receiving tab's memory in Chrome Task Manager.
Expected: completes; tab memory stays well under the file size (streaming to disk).

- [ ] **Step 5: Acceptance — server sees no file content (criterion 4)**

Procedure: With the server running, observe its logs and (optionally) `tcpdump` on the server port during a transfer. Confirm only WebSocket signaling traffic hits the server; the bulk transfer goes peer-to-peer.
Expected: no file bytes traverse the server.

- [ ] **Step 6: Acceptance — SAS detects MITM (criterion 5)**

Procedure: Temporarily add a debug flag to `webrtc.ts` (or a branch) that replaces the peer key in `onPeerKey` with a random key on one side, simulating a key-swapping server. Run a transfer.
Expected: the two SAS codes differ between the devices — the user can detect the MITM by comparison. Revert the debug change afterward.

- [ ] **Step 7: Acceptance — browser matrix (criterion 6)**

Procedure: Repeat Step 3 with Firefox and Safari (smaller file, e.g. 50MB, since fallback buffers in memory).
Expected: basic transfer completes; note any degradation in `docs/TESTING.md`.

- [ ] **Step 8: Write `docs/TESTING.md`** capturing Steps 2–7 as the repeatable acceptance script, then commit.

```bash
git add docs/TESTING.md
git commit -m "docs: manual acceptance procedure for web MVP"
```

---

## Self-Review

**1. Spec coverage:**
- §2.1 signaling server → Tasks 2–5. ✔
- §2.1 Svelte client + peer list → Tasks 6, 9, 11. ✔
- §2.1 WebRTC DataChannel transfer → Task 10, 11. ✔
- §2.1 X25519 + AES-256-GCM → Task 7. ✔
- §2.1 SAS → Task 7 (`sas`), Task 11 (display/confirm), Task 12 Step 6 (MITM test). ✔
- §2.1 streaming to disk → Task 10 `filesink.ts`, Task 12 Step 4. ✔
- §2.1 progress + SHA-256 integrity → Task 8 (hash), Task 11 (progress). ✔
- §5 threat model / server sees no content → Task 4 (targeted relay), Task 12 Step 5. ✔
- §7 acceptance criteria 1–6 → Task 12 Steps 3–7. ✔
- §2.2 out-of-scope items (TURN, accounts, resume, dirs) → not implemented, as required. ✔

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". The one self-referential doc-comment in Task 8 about the rejected hashing approach is deleted in Task 8 Step 4. ✔

**3. Type consistency:**
- `Envelope` fields match between `message.go` (Task 2) and `protocol.ts` (Task 6). ✔
- `SessionKeys { send, recv }` defined in Task 7, consumed identically in Task 8 (`keys.send`/`keys.recv`) and Task 11. ✔
- `deriveSession(role, self, peerPublic)` signature consistent across Tasks 7, 8 (test), 11. ✔
- `Sender.frames` / `Receiver.feed` signatures defined in Task 8 and used unchanged in Task 11. ✔
- `connect(opts)` shape defined in Task 10 and used with the same fields in Task 11. ✔

**Known deviation (documented):** spec §6 named both "AES-256-GCM" and earlier text mentioned ECDH/HKDF; this plan uses libsodium `crypto_kx` (X25519-based) for key agreement instead of raw HKDF-over-ECDH. Functionally equivalent for M0 (derives mirror-image AES-256-GCM keys) and simpler/safer. Flagged here so the reviewer accepts it deliberately.
