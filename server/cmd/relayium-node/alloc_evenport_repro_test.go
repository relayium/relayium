package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/binary"
	"fmt"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/pion/turn/v4"
)

// A permanent leak proven reachable, driven over the wire against a real pion
// server.
//
// ## What the fleet showed
//
// Five nodes reported active_transfers of 0, 16, 28, 16 and 16 long after the
// clients that created those allocations had exited and long after pion's
// one-hour maximum allocation lifetime had passed. The count only ever went up.
// central picks its rollout canary as the least-busy node, so four of five
// machines silently stopped being eligible.
//
// ## What is actually reachable in pion v4.1.4
//
// The registry's only retirement signal used to be OnAllocationDeleted. Reading
// the dependency rather than assuming: every path that ends a real allocation
// DOES reach that callback. Manager.DeleteAllocation fires it, and it is called
// by the refresh-lifetime-0 handler, by the allocation lifetime timer, and by
// packetHandler when the relay read fails. Manager.Close (server shutdown) does
// not call it directly, but each packetHandler's read then fails and calls
// DeleteAllocation itself. CreateAllocation has no error path at all after
// AllocatePacketConn. So "an allocation aborted after AllocatePacketConn" —
// the previous explanation — is NOT reachable, and this test does not claim it.
//
// The reachable path is a relay socket pion allocates WITHOUT ever creating an
// allocation for it. allocation_manager.go:209, GetRandomEvenPort:
//
//	for i := 0; i < 128; i++ {
//	    conn, addr, err := m.allocatePacketConn("udp4", 0)   // -> countingGenerator -> reg.wrap
//	    ...
//	    err = conn.Close()
//	    if udpAddr.Port%2 == 0 { return udpAddr.Port, nil }
//	}
//
// m.allocatePacketConn IS countingGenerator.AllocatePacketConn, so every probe
// registers a live registry entry. The probe is then closed and thrown away:
// no CreateAllocation, no OnAllocationCreated, no OnAllocationDeleted, and the
// entry was reachable from neither index the registry then kept — not the
// srcAddr index, which only OnAllocationCreated populated, and not byRelay,
// whose key the real allocation that follows takes back. Nothing could ever
// retire it.
//
// internal/server/turn.go:134 reaches GetRandomEvenPort for any Allocate
// request carrying an EVEN-PORT attribute — the RFC 5766 section 14.6 way a
// client asks for an even relay port so it can pair RTP with RTCP. At least one
// probe leaks per such request, and about two on average, since the loop
// repeats until the OS hands back an even port.
//
// ## What this proves, and what it does not
//
// It proves that a real pion server on this exact dependency version leaks
// permanently live registry entries for a client request no node operator
// controls, that the leak never falls back, and that the fix stops it.
//
// It also shows a growth SHAPE compatible with what the fleet reported: the
// loop repeats until the OS returns an even port, so each EVEN-PORT request
// leaks a small batch — one at minimum, about two on average — rather than one
// socket at a time. A count that climbs in batches and never falls is what
// 0/16/28/16/16 looks like. Compatible is the whole claim, and it is weaker
// than it may read: other batch-shaped leaks would fit the same numbers.
//
// It does NOT prove that EVEN-PORT was the trigger behind 16/28/16/16. The node
// kept no per-path record while it was happening, so that attribution cannot be
// recovered after the fact, and nothing in this file should be cited as
// recovering it. allocRegistry.stats() and the heartbeat line added alongside
// this fix exist to close exactly that gap on the next controlled run; see
// TestStatsAttributeUnjoinedRelaySockets.
//
// The fix does not depend on the attribution either way: retiring on Close
// closes this proven leak whatever caused the historical one.
func TestEvenPortAllocateLeaksProbeSocketsBeforeTheFix(t *testing.T) {
	reg, _, serverAddr, realm, secret := startTestTURNServer(t)

	c := dialTURN(t, serverAddr, realm, secret)
	relayAddr := c.allocate(t, withEvenPort)

	// The count central reads. Pre-fix this is 1 + however many probe sockets
	// GetRandomEvenPort burned, which is at least 2 and never comes back down.
	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("after ONE even-port allocation: activeAllocs = %d, want 1.\n"+
			"Each extra count is a relay socket pion allocated inside GetRandomEvenPort, "+
			"closed, and threw away — with no allocation, no OnAllocationCreated and no "+
			"OnAllocationDeleted, so nothing could ever retire it. That is a permanent leak "+
			"whose batch-wise growth is compatible with the fleet's monotonically inflating "+
			"active_transfers; it does not establish that this path caused that incident.", got)
	}
	if relayAddr == "" {
		t.Fatal("the allocation succeeded but reported no XOR-RELAYED-ADDRESS")
	}

	// The probes must be gone from the index too, not merely counted as closed:
	// a surviving byRelay key is the same leak in a different map.
	if _, byRelay := registrySizes(reg); byRelay != 1 {
		t.Fatalf("byRelay holds %d keys after one allocation, want 1 — a probe socket's "+
			"index key outlived it", byRelay)
	}

	// A retired probe still owes one final snapshot, exactly like any other
	// retired allocation, so it stays in `entries` until the next heartbeat
	// drains it. It must carry no username, because it never was an allocation
	// — sendHeartbeat drops such samples, so no usage row is invented for it —
	// and that one snapshot must evict it rather than let it accumulate.
	for _, s := range reg.snapshot() {
		if s.Username == "" && s.RelayedBytes != 0 {
			t.Fatalf("a socket with no username reported %d relayed bytes: %+v", s.RelayedBytes, s)
		}
	}
	if entries, _ := registrySizes(reg); entries != 1 {
		t.Fatalf("after one heartbeat drained the retired probes, entries holds %d, want 1 "+
			"(the live allocation only)", entries)
	}
	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("draining the probes disturbed the live allocation: activeAllocs = %d, want 1", got)
	}

	// And the real allocation still retires normally afterwards.
	c.release(t)
	waitForActiveAllocs(t, reg, 0)
}

// The same request without EVEN-PORT never reaches GetRandomEvenPort, so it
// never leaked. Stated as a test so the reproducer above is known to isolate
// the probe path rather than to be measuring allocation bookkeeping in general.
func TestPlainAllocateNeverTouchedTheProbePath(t *testing.T) {
	reg, _, serverAddr, realm, secret := startTestTURNServer(t)

	c := dialTURN(t, serverAddr, realm, secret)
	if got := c.allocate(t); got == "" {
		t.Fatal("plain allocate reported no XOR-RELAYED-ADDRESS")
	}

	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("plain allocate: activeAllocs = %d, want 1", got)
	}
	if entries, byRelay := registrySizes(reg); entries != 1 || byRelay != 1 {
		t.Fatalf("entries=%d byRelay=%d, want 1/1", entries, byRelay)
	}
	c.release(t)
	waitForActiveAllocs(t, reg, 0)
}

// registrySizes reports the live entry and index cardinalities.
func registrySizes(r *allocRegistry) (entries, byRelay int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.entries), len(r.byRelay)
}

// ── a TURN client written to the wire, because go.mod is not ours to change ──
//
// pion's own turn.Client cannot send EVEN-PORT, and the attribute encoders that
// could are in github.com/pion/turn/v4/internal/proto. Reaching pion's
// GetRandomEvenPort therefore means building the Allocate request by hand.
// Everything below is stdlib plus turn.GenerateAuthKey, which this package
// already depends on, so no module requirement changes.
//
// The SERVER side is entirely real pion, which is the point: this drives the
// same code path a coturn turnutils_uclient or any RTP/RTCP-pairing client
// would.

const (
	stunMagicCookie = 0x2112A442

	// RFC 5389 section 18.2 and RFC 5766 section 14 attribute types.
	attrUsername           = 0x0006
	attrMessageIntegrity   = 0x0008
	attrErrorCode          = 0x0009
	attrLifetime           = 0x000D
	attrRealm              = 0x0014
	attrNonce              = 0x0015
	attrXORRelayedAddress  = 0x0016
	attrEvenPort           = 0x0018
	attrRequestedTransport = 0x0019

	// Method 0x003 (Allocate) and 0x004 (Refresh); the class bits are 4 and 8.
	msgAllocateRequest = 0x0003
	msgAllocateSuccess = 0x0103
	msgAllocateError   = 0x0113
	msgRefreshRequest  = 0x0004
	msgRefreshSuccess  = 0x0104

	protoUDP = 17
)

// turnWire is one client 5-tuple against the server: its own UDP socket, its
// credential, and the nonce the server last issued it.
type turnWire struct {
	conn     net.PacketConn
	server   net.Addr
	username string
	realm    string
	key      []byte
	nonce    []byte
}

// dialTURN opens a client socket and completes the long-term-credential
// challenge, so the returned client can send authenticated requests.
func dialTURN(t *testing.T, serverAddr, realm, secret string) *turnWire {
	t.Helper()
	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen client socket: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	srv, err := net.ResolveUDPAddr("udp4", serverAddr)
	if err != nil {
		t.Fatalf("resolve %s: %v", serverAddr, err)
	}

	username := strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10) + ":wire-test"
	c := &turnWire{
		conn:     conn,
		server:   srv,
		username: username,
		realm:    realm,
		key:      turn.GenerateAuthKey(username, realm, longTermPassword(secret, username)),
	}

	// An unauthenticated Allocate draws the 401 that carries REALM and NONCE.
	// The nonce is opaque (pion signs it with a per-server key), so it is
	// echoed back verbatim rather than constructed.
	typ, attrs := c.roundTrip(t, msgAllocateRequest, attr(attrRequestedTransport, []byte{protoUDP, 0, 0, 0}))
	if typ != msgAllocateError {
		t.Fatalf("unauthenticated Allocate: message type 0x%04x, want 0x%04x (the 401 challenge)",
			typ, msgAllocateError)
	}
	nonce, ok := attrs[attrNonce]
	if !ok {
		t.Fatalf("the 401 challenge carried no NONCE, only %v", attrKeys(attrs))
	}
	c.nonce = append([]byte(nil), nonce...)
	return c
}

type allocOption func() []byte

// withEvenPort adds RFC 5766 section 14.6 EVEN-PORT with the reservation bit
// clear, which is what routes the request through pion's GetRandomEvenPort.
func withEvenPort() []byte { return attr(attrEvenPort, []byte{0x00}) }

// allocate sends an authenticated Allocate and returns the relayed address the
// server reported, decoded from XOR-RELAYED-ADDRESS.
func (c *turnWire) allocate(t *testing.T, opts ...allocOption) string {
	t.Helper()
	body := attr(attrRequestedTransport, []byte{protoUDP, 0, 0, 0})
	for _, o := range opts {
		body = append(body, o()...)
	}
	typ, attrs := c.authRoundTrip(t, msgAllocateRequest, body)
	if typ != msgAllocateSuccess {
		t.Fatalf("Allocate: message type 0x%04x, want 0x%04x. ERROR-CODE=%s",
			typ, msgAllocateSuccess, errorCode(attrs))
	}
	return xorAddr(attrs[attrXORRelayedAddress])
}

// release ends the allocation the way a well-behaved client does: Refresh with
// LIFETIME 0, which is pion's DeleteAllocation path.
func (c *turnWire) release(t *testing.T) {
	t.Helper()
	typ, attrs := c.authRoundTrip(t, msgRefreshRequest, attr(attrLifetime, []byte{0, 0, 0, 0}))
	if typ != msgRefreshSuccess {
		t.Fatalf("Refresh(0): message type 0x%04x, want 0x%04x. ERROR-CODE=%s",
			typ, msgRefreshSuccess, errorCode(attrs))
	}
}

// authRoundTrip appends the credential attributes and MESSAGE-INTEGRITY.
func (c *turnWire) authRoundTrip(t *testing.T, msgType uint16, body []byte) (uint16, map[uint16][]byte) {
	t.Helper()
	body = append(body, attr(attrUsername, []byte(c.username))...)
	body = append(body, attr(attrRealm, []byte(c.realm))...)
	body = append(body, attr(attrNonce, c.nonce)...)
	return c.roundTrip(t, msgType, body, c.key)
}

// roundTrip sends one request and reads one reply. Retransmission is
// deliberately absent: both ends are on loopback in the same process, so a lost
// datagram is a defect worth failing on rather than papering over.
func (c *turnWire) roundTrip(t *testing.T, msgType uint16, body []byte, key ...[]byte) (uint16, map[uint16][]byte) {
	t.Helper()
	txID := make([]byte, 12)
	if _, err := rand.Read(txID); err != nil {
		t.Fatalf("transaction id: %v", err)
	}
	msg := append(stunHeader(msgType, txID, len(body)), body...)
	if len(key) == 1 {
		msg = signMessageIntegrity(msg, key[0])
	}

	if _, err := c.conn.WriteTo(msg, c.server); err != nil {
		t.Fatalf("send STUN 0x%04x: %v", msgType, err)
	}
	if err := c.conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	buf := make([]byte, 1600)
	n, _, err := c.conn.ReadFrom(buf)
	if err != nil {
		t.Fatalf("read the reply to STUN 0x%04x: %v", msgType, err)
	}
	typ, attrs, err := decodeSTUN(buf[:n])
	if err != nil {
		t.Fatalf("decode the reply to STUN 0x%04x: %v", msgType, err)
	}
	return typ, attrs
}

func stunHeader(msgType uint16, txID []byte, bodyLen int) []byte {
	h := make([]byte, 20)
	binary.BigEndian.PutUint16(h[0:2], msgType)
	binary.BigEndian.PutUint16(h[2:4], uint16(bodyLen))
	binary.BigEndian.PutUint32(h[4:8], stunMagicCookie)
	copy(h[8:20], txID)
	return h
}

// attr encodes one attribute, padded to the 4-byte boundary STUN requires.
func attr(typ uint16, value []byte) []byte {
	out := make([]byte, 4, 4+len(value)+3)
	binary.BigEndian.PutUint16(out[0:2], typ)
	binary.BigEndian.PutUint16(out[2:4], uint16(len(value)))
	out = append(out, value...)
	for len(out)%4 != 0 {
		out = append(out, 0)
	}
	return out
}

// signMessageIntegrity appends MESSAGE-INTEGRITY per RFC 5389 section 15.4: the
// header length is first set to the value it will have WITH the 24-byte
// attribute present, and the HMAC-SHA1 covers the message up to but excluding
// it.
func signMessageIntegrity(msg, key []byte) []byte {
	binary.BigEndian.PutUint16(msg[2:4], uint16(len(msg)-20+24))
	mac := hmac.New(sha1.New, key)
	mac.Write(msg)
	return append(msg, attr(attrMessageIntegrity, mac.Sum(nil))...)
}

func decodeSTUN(msg []byte) (uint16, map[uint16][]byte, error) {
	if len(msg) < 20 {
		return 0, nil, fmt.Errorf("STUN message is %d bytes, shorter than the 20-byte header", len(msg))
	}
	typ := binary.BigEndian.Uint16(msg[0:2])
	length := int(binary.BigEndian.Uint16(msg[2:4]))
	if 20+length > len(msg) {
		return 0, nil, fmt.Errorf("STUN header claims a %d-byte body but only %d bytes follow", length, len(msg)-20)
	}
	body := msg[20 : 20+length]
	out := make(map[uint16][]byte)
	for len(body) >= 4 {
		at := binary.BigEndian.Uint16(body[0:2])
		al := int(binary.BigEndian.Uint16(body[2:4]))
		if 4+al > len(body) {
			return 0, nil, fmt.Errorf("attribute 0x%04x claims %d bytes with only %d left", at, al, len(body)-4)
		}
		out[at] = body[4 : 4+al]
		// STUN pads every attribute to a 4-byte boundary and counts the padding
		// in the message length, so `advance` is normally within the body. A
		// malformed reply is a test failure, not a panic.
		advance := 4 + al + (4-al%4)%4
		if advance > len(body) {
			return 0, nil, fmt.Errorf("attribute 0x%04x runs past the end of the message body", at)
		}
		body = body[advance:]
	}
	return typ, out, nil
}

// xorAddr decodes XOR-MAPPED/XOR-RELAYED-ADDRESS (IPv4 only, which is all this
// node's single udp4 PacketConnConfig can produce).
func xorAddr(v []byte) string {
	if len(v) != 8 || v[1] != 0x01 {
		return ""
	}
	port := binary.BigEndian.Uint16(v[2:4]) ^ (stunMagicCookie >> 16)
	ip := make(net.IP, 4)
	binary.BigEndian.PutUint32(ip, binary.BigEndian.Uint32(v[4:8])^stunMagicCookie)
	return net.JoinHostPort(ip.String(), strconv.Itoa(int(port)))
}

func errorCode(attrs map[uint16][]byte) string {
	v, ok := attrs[attrErrorCode]
	if !ok || len(v) < 4 {
		return "none"
	}
	return fmt.Sprintf("%d%02d %q", v[2], v[3], v[4:])
}

func attrKeys(attrs map[uint16][]byte) []string {
	out := make([]string, 0, len(attrs))
	for k := range attrs {
		out = append(out, fmt.Sprintf("0x%04x", k))
	}
	return out
}
