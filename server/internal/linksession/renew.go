package linksession

// relay-renew/1 for the CLI (A11): the wire, and the per-link renewal engine.
//
// Protocol: docs/protocol/relay-renew-v1.md. Reference implementation:
// web/src/lib/relay-renew-wire.ts and web/src/lib/relay-renew.ts, ported rule
// for rule; the cross-platform fixture is
// apps/RelayiumKit/Tests/Fixtures/relay-renew-vectors.json.
//
// ## The one rule
//
// A relayed link's deadline moves ONLY on §6.5 commit: local observation that
// the selected pair belongs to this epoch's ICE generation, plus the peer's
// signed ACK for this side's own fresh probe nonce, arriving after that
// observation held. Every other outcome — denial, silence, a failed pin, a
// timeout, an old peer, an old server — leaves the old deadline exactly as it
// was. There is no path from "something went wrong" to "a bit longer".
//
// ## What is different for the CLI: Pion restarts ICE break-before-make
//
// pion/ice's Agent.Restart clears the selected pair and closes every local
// candidate (including the old TURN allocation) the moment a restart offer is
// CREATED, or a restart offer is APPLIED on the answering side
// (artifacts/goal34-20260923/a11-metering/probe-pion-restart). A browser keeps
// the old pair until the new one is selected; Pion does not. So on the CLI:
//
//   - nothing restarts ICE before BOTH peers are `ready` on the same, locally
//     validated grant, the epoch-0 pin baseline exists, and (answering side)
//     the received offer passed the pin;
//   - an attempt that ends without commit AFTER the transport restarted cannot
//     fall back to an old path that no longer exists. It is reported through
//     RenewDeps.Broke, and the caller ends the link at once with a truthful
//     line (owner decision, option A). The deadline is still never extended.
//
// Money-side, this is the conservative direction: the old allocation is
// released at the restart, never held alongside the new one.
//
// ## Threading
//
// Everything here runs on the caller's single loop (the same one that drives
// the Session). HMACs are synchronous in Go, so verification is serialised by
// construction and routability is always decided against the current state.

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/relayium/relayium/internal/linkcrypto"
)

// ---------------------------------------------------------------- constants

// CapRenew is the capability. Announced only by a build with the whole path
// wired; it is an unsigned hint and confers no authority.
const CapRenew = "relay-renew/1"

const (
	RenewProbeKind       byte = 0x0d
	RenewProbeVersion    byte = 1
	RenewProbeTypeProbe  byte = 1
	RenewProbeTypeAck    byte = 2
	RenewNonceBytes           = 16
	RenewTagBytes             = 32
	RenewProbeFrameBytes      = 1 + 1 + 1 + 4 + 4 + RenewNonceBytes + RenewTagBytes // 59
	RenewAuthLength           = 44

	RenewMaxEpochsPerRound     = 3
	RenewMaxProbeVerifications = 8
	RenewAckVerifyReserve      = 4
	RenewProbeVerifyReserve    = 4
	RenewMaxHeldCandidates     = 64
	RenewProbeMaxSends         = 5
	RenewMaxPregrantAttempts   = 6
	RenewMaxPendingSignals     = 32
	RenewMaxInflightRounds     = 2

	// renewRoundsRetained bounds the per-round budget maps.
	renewRoundsRetained = 8
)

const (
	RenewProbeRetry       = 2 * time.Second
	RenewPrepareToReady   = 15 * time.Second
	RenewReadyToAnswer    = 15 * time.Second
	RenewICEProbe         = 30 * time.Second
	RenewEpochHardCap     = 60 * time.Second
	RenewPrepareSilence   = 10 * time.Second
	RenewRetryBackoff     = 60 * time.Second
	RenewPostCommitAck    = RenewICEProbe
	RenewRoundTimeout     = 15 * time.Second
	RenewActivityWindow   = 10 * time.Minute
	renewObservePoll      = 500 * time.Millisecond
	renewPoll             = time.Second
	renewMaxMargin        = 10 * time.Minute
	renewAbortDenied      = "denied"
	renewAbortUnavailable = "unavailable"
	renewAbortTimeout     = "timeout"
	renewAbortSDP         = "sdp"
	renewAbortClosed      = "closed"
)

var renewAbortReasons = []string{renewAbortDenied, renewAbortUnavailable, renewAbortTimeout, renewAbortSDP, renewAbortClosed}

var renewGrantStatuses = []string{"granted", "denied", "unavailable", "stale"}

var renewGrantReasons = []string{"quota", "unverified", "idle", "expired", "membership", "rate", "unavailable"}

// RenewMargin is `renewMarginMs`: min(10 min, floor(L/3)) of the grant's
// LIFETIME, measured from the instant the boundary was installed (never from
// now — see relay-renew-v1 §7.2).
func RenewMargin(deadlineAt, anchoredAt time.Time) time.Duration {
	life := deadlineAt.Sub(anchoredAt)
	if life < 0 {
		life = 0
	}
	third := time.Duration(int64(life/time.Millisecond)/3) * time.Millisecond
	return min(renewMaxMargin, third)
}

// ---------------------------------------------------------------- canonical payloads

// renewJSString is JavaScript JSON.stringify string escaping (link §4.4): the
// same rule as linkwire's leave payload.
func renewJSString(dst []byte, s string) []byte {
	const hexdigits = "0123456789abcdef"
	dst = append(dst, '"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			dst = append(dst, '\\', '"')
		case '\\':
			dst = append(dst, '\\', '\\')
		case '\b':
			dst = append(dst, '\\', 'b')
		case '\t':
			dst = append(dst, '\\', 't')
		case '\n':
			dst = append(dst, '\\', 'n')
		case '\f':
			dst = append(dst, '\\', 'f')
		case '\r':
			dst = append(dst, '\\', 'r')
		default:
			if c < 0x20 {
				dst = append(dst, '\\', 'u', '0', '0', hexdigits[c>>4], hexdigits[c&0xf])
			} else {
				dst = append(dst, c)
			}
		}
	}
	return append(dst, '"')
}

var errRenewUTF8 = errors.New("linksession: renew payload is not valid UTF-8")

type renewPayload struct {
	b   []byte
	err error
}

func newRenewPayload(kind, from, to string) *renewPayload {
	p := &renewPayload{b: []byte(`{"kind":`)}
	p.b = renewJSString(p.b, kind)
	p.str("from", from)
	p.str("to", to)
	return p
}

func (p *renewPayload) str(key, v string) {
	if !utf8.ValidString(v) {
		p.err = errRenewUTF8
	}
	p.b = append(p.b, ',', '"')
	p.b = append(p.b, key...)
	p.b = append(p.b, '"', ':')
	p.b = renewJSString(p.b, v)
}

func (p *renewPayload) u32(key string, v uint32) {
	p.b = append(p.b, ',', '"')
	p.b = append(p.b, key...)
	p.b = append(p.b, '"', ':')
	p.b = strconv.AppendUint(p.b, uint64(v), 10)
}

func (p *renewPayload) done() (string, error) {
	if p.err != nil {
		return "", p.err
	}
	return string(append(p.b, '}')), nil
}

// RenewSignal is one inner `renew` object (§3.2).
type RenewSignal struct {
	Type             string // prepare | ready | sdp | ice | abort
	Epoch            uint32
	Round            uint32
	SDPType          string
	SDP              string
	Candidate        string
	SDPMid           *string
	SDPMLineIndex    *uint32
	UsernameFragment string
	Reason           string
}

// RenewSignalPayload is the canonical string a signal's tag covers (§3.3).
func RenewSignalPayload(sig RenewSignal, from, to string) (string, error) {
	switch sig.Type {
	case "prepare":
		p := newRenewPayload("link-renew-prepare", from, to)
		p.u32("epoch", sig.Epoch)
		return p.done()
	case "ready":
		p := newRenewPayload("link-renew-ready", from, to)
		p.u32("epoch", sig.Epoch)
		p.u32("round", sig.Round)
		return p.done()
	case "sdp":
		p := newRenewPayload("link-renew-sdp", from, to)
		p.u32("epoch", sig.Epoch)
		p.u32("round", sig.Round)
		p.str("sdpType", sig.SDPType)
		p.str("sdp", sig.SDP)
		return p.done()
	case "ice":
		p := newRenewPayload("link-renew-ice", from, to)
		p.u32("epoch", sig.Epoch)
		p.u32("round", sig.Round)
		p.str("candidate", sig.Candidate)
		if sig.SDPMid == nil {
			p.b = append(p.b, `,"sdpMid":null`...)
		} else {
			p.str("sdpMid", *sig.SDPMid)
		}
		if sig.SDPMLineIndex == nil {
			p.b = append(p.b, `,"sdpMLineIndex":null`...)
		} else {
			p.u32("sdpMLineIndex", *sig.SDPMLineIndex)
		}
		p.str("usernameFragment", sig.UsernameFragment)
		return p.done()
	case "abort":
		p := newRenewPayload("link-renew-abort", from, to)
		p.u32("epoch", sig.Epoch)
		p.str("reason", sig.Reason)
		return p.done()
	}
	return "", errors.New("linksession: unknown renew signal type")
}

// RenewProbePayload is the data-lane probe/ack payload (§6.1).
func RenewProbePayload(ack bool, from, to string, epoch, round uint32, nonce []byte) (string, error) {
	kind := "link-renew-probe"
	if ack {
		kind = "link-renew-ack"
	}
	p := newRenewPayload(kind, from, to)
	p.u32("epoch", epoch)
	p.u32("round", round)
	p.str("nonce", base64.StdEncoding.EncodeToString(nonce))
	return p.done()
}

// ---------------------------------------------------------------- the envelope

// EncodeRenewEnvelope renders {"link":true,"renew":{…},"auth":…}. Nullable ICE
// fields are written as explicit nulls (§3.2).
func EncodeRenewEnvelope(sig RenewSignal, auth string) []byte {
	b := []byte(`{"link":true,"renew":{"type":`)
	b = renewJSString(b, sig.Type)
	b = append(b, `,"epoch":`...)
	b = strconv.AppendUint(b, uint64(sig.Epoch), 10)
	switch sig.Type {
	case "ready", "sdp", "ice":
		b = append(b, `,"round":`...)
		b = strconv.AppendUint(b, uint64(sig.Round), 10)
	}
	switch sig.Type {
	case "sdp":
		b = append(b, `,"sdpType":`...)
		b = renewJSString(b, sig.SDPType)
		b = append(b, `,"sdp":`...)
		b = renewJSString(b, sig.SDP)
	case "ice":
		b = append(b, `,"candidate":`...)
		b = renewJSString(b, sig.Candidate)
		b = append(b, `,"sdpMid":`...)
		if sig.SDPMid == nil {
			b = append(b, "null"...)
		} else {
			b = renewJSString(b, *sig.SDPMid)
		}
		b = append(b, `,"sdpMLineIndex":`...)
		if sig.SDPMLineIndex == nil {
			b = append(b, "null"...)
		} else {
			b = strconv.AppendUint(b, uint64(*sig.SDPMLineIndex), 10)
		}
		b = append(b, `,"usernameFragment":`...)
		b = renewJSString(b, sig.UsernameFragment)
	case "abort":
		b = append(b, `,"reason":`...)
		b = renewJSString(b, sig.Reason)
	}
	b = append(b, `},"auth":`...)
	b = renewJSString(b, auth)
	return append(b, '}')
}

var renewInnerKeys = map[string][]string{
	"prepare": {"type", "epoch"},
	"ready":   {"type", "epoch", "round"},
	"sdp":     {"type", "epoch", "round", "sdpType", "sdp"},
	"ice":     {"type", "epoch", "round", "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"},
	"abort":   {"type", "epoch", "reason"},
}

func renewObject(raw []byte) (map[string]json.RawMessage, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' {
		return nil, false
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return nil, false
	}
	return m, true
}

func renewExactKeys(m map[string]json.RawMessage, allowed []string) bool {
	if len(m) != len(allowed) {
		return false
	}
	for k := range m {
		if !slices.Contains(allowed, k) {
			return false
		}
	}
	return true
}

// renewUint32 is `isUint32`: a JSON number whose value is an exact integer in
// [0, 2^32-1]. A string, a fraction, a negative or an overflow is refused.
func renewUint32(raw json.RawMessage) (uint32, bool) {
	s := strings.TrimSpace(string(raw))
	if s == "" || (s[0] != '-' && (s[0] < '0' || s[0] > '9')) {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || f < 0 || f > math.MaxUint32 {
		return 0, false
	}
	return uint32(f), true
}

func renewString(raw json.RawMessage) (string, bool) {
	s := strings.TrimSpace(string(raw))
	if s == "" || s[0] != '"' {
		return "", false
	}
	var v string
	if json.Unmarshal([]byte(s), &v) != nil {
		return "", false
	}
	return v, true
}

func renewIsNull(raw json.RawMessage) bool { return strings.TrimSpace(string(raw)) == "null" }

// HasRenewKey reports whether a signal carries a top-level `renew` key at all.
// Such a signal belongs to renewal: if it does not parse exactly it is dropped,
// and it never reaches the link session.
func HasRenewKey(raw []byte) bool {
	m, ok := renewObject(raw)
	if !ok {
		return false
	}
	_, has := m["renew"]
	return has
}

// ParseRenewEnvelope recognises a renewal envelope by EXACT shape (§3.1,
// §3.2, §10). Anything else — including a near miss — is not one.
func ParseRenewEnvelope(raw []byte) (RenewSignal, string, bool) {
	outer, ok := renewObject(raw)
	if !ok || strings.TrimSpace(string(outer["link"])) != "true" {
		return RenewSignal{}, "", false
	}
	if !renewExactKeys(outer, []string{"link", "renew", "auth"}) {
		return RenewSignal{}, "", false
	}
	auth, ok := renewString(outer["auth"])
	if !ok || len(auth) != RenewAuthLength {
		return RenewSignal{}, "", false
	}
	inner, ok := renewObject(outer["renew"])
	if !ok {
		return RenewSignal{}, "", false
	}
	typ, ok := renewString(inner["type"])
	if !ok {
		return RenewSignal{}, "", false
	}
	allowed, ok := renewInnerKeys[typ]
	if !ok || !renewExactKeys(inner, allowed) {
		return RenewSignal{}, "", false
	}
	sig := RenewSignal{Type: typ}
	if sig.Epoch, ok = renewUint32(inner["epoch"]); !ok {
		return RenewSignal{}, "", false
	}
	if typ == "ready" || typ == "sdp" || typ == "ice" {
		if sig.Round, ok = renewUint32(inner["round"]); !ok {
			return RenewSignal{}, "", false
		}
	}
	switch typ {
	case "sdp":
		if sig.SDPType, ok = renewString(inner["sdpType"]); !ok || (sig.SDPType != "offer" && sig.SDPType != "answer") {
			return RenewSignal{}, "", false
		}
		if sig.SDP, ok = renewString(inner["sdp"]); !ok || sig.SDP == "" {
			return RenewSignal{}, "", false
		}
	case "ice":
		if sig.Candidate, ok = renewString(inner["candidate"]); !ok || sig.Candidate == "" {
			return RenewSignal{}, "", false
		}
		if !renewIsNull(inner["sdpMid"]) {
			mid, ok := renewString(inner["sdpMid"])
			if !ok {
				return RenewSignal{}, "", false
			}
			sig.SDPMid = &mid
		}
		if !renewIsNull(inner["sdpMLineIndex"]) {
			idx, ok := renewUint32(inner["sdpMLineIndex"])
			if !ok {
				return RenewSignal{}, "", false
			}
			sig.SDPMLineIndex = &idx
		}
		if sig.UsernameFragment, ok = renewString(inner["usernameFragment"]); !ok || sig.UsernameFragment == "" {
			return RenewSignal{}, "", false
		}
	case "abort":
		if sig.Reason, ok = renewString(inner["reason"]); !ok || !slices.Contains(renewAbortReasons, sig.Reason) {
			return RenewSignal{}, "", false
		}
	}
	return sig, auth, true
}

// ---------------------------------------------------------------- the server round

// IceGrant is one parsed `ice-grant` payload (§2.2). Body is the whole
// payload, handed to the SAME /api/ice sanitiser the link's first
// configuration went through.
type IceGrant struct {
	Status      string
	Round       uint32
	RID         uint32
	RelayDenied string
	Reason      string
	Body        []byte
}

// ParseIceGrant is `parseIceGrant`: strict on status/round/rid.
func ParseIceGrant(raw []byte) (IceGrant, bool) {
	m, ok := renewObject(raw)
	if !ok {
		return IceGrant{}, false
	}
	g := IceGrant{Body: bytes.Clone(raw)}
	if g.Status, ok = renewString(m["status"]); !ok || !slices.Contains(renewGrantStatuses, g.Status) {
		return IceGrant{}, false
	}
	if g.Round, ok = renewUint32(m["round"]); !ok {
		return IceGrant{}, false
	}
	if g.RID, ok = renewUint32(m["rid"]); !ok {
		return IceGrant{}, false
	}
	if v, ok := renewString(m["relayDenied"]); ok {
		g.RelayDenied = v
	}
	if v, ok := renewString(m["reason"]); ok && slices.Contains(renewGrantReasons, v) {
		g.Reason = v
	}
	return g, true
}

// ---------------------------------------------------------------- the data-lane control frame

// RenewProbeFrame is the decoded 59-byte frame.
type RenewProbeFrame struct {
	Type  byte
	Epoch uint32
	Round uint32
	Nonce [RenewNonceBytes]byte
	Tag   [RenewTagBytes]byte
}

// EncodeRenewProbe builds the frame.
func EncodeRenewProbe(f RenewProbeFrame) []byte {
	out := make([]byte, RenewProbeFrameBytes)
	out[0], out[1], out[2] = RenewProbeKind, RenewProbeVersion, f.Type
	binary.BigEndian.PutUint32(out[3:], f.Epoch)
	binary.BigEndian.PutUint32(out[7:], f.Round)
	copy(out[11:], f.Nonce[:])
	copy(out[27:], f.Tag[:])
	return out
}

// DecodeRenewProbe runs the cheap checks only: length, kind, version, type.
func DecodeRenewProbe(b []byte) (RenewProbeFrame, bool) {
	if len(b) != RenewProbeFrameBytes || b[0] != RenewProbeKind || b[1] != RenewProbeVersion {
		return RenewProbeFrame{}, false
	}
	if b[2] != RenewProbeTypeProbe && b[2] != RenewProbeTypeAck {
		return RenewProbeFrame{}, false
	}
	f := RenewProbeFrame{Type: b[2], Epoch: binary.BigEndian.Uint32(b[3:]), Round: binary.BigEndian.Uint32(b[7:])}
	copy(f.Nonce[:], b[11:27])
	copy(f.Tag[:], b[27:59])
	return f, true
}

// IsRenewControlFrame is the demux question: does a text-lane frame claim to
// be a renewal control frame at all? First byte only — a 0x0d frame that
// fails every later check is still consumed here and never shown to the text
// session, its idle timer or its rate budget (§6.2).
func IsRenewControlFrame(b []byte) bool { return len(b) > 0 && b[0] == RenewProbeKind }

// ---------------------------------------------------------------- SDP pinning and ufrags

// SdpPin is what an epoch ≥ 1 description must reproduce (§5.1).
type SdpPin struct {
	Fingerprints []string
	Mids         []string
	Setup        string
}

func sdpLines(sdp string) []string {
	sdp = strings.ReplaceAll(sdp, "\r\n", "\n")
	sdp = strings.ReplaceAll(sdp, "\r", "\n")
	return strings.Split(sdp, "\n")
}

// SdpPinOf is `sdpPin`.
func SdpPinOf(sdp string) SdpPin {
	fps := map[string]bool{}
	var pin SdpPin
	for _, raw := range sdpLines(sdp) {
		line := strings.TrimSpace(raw)
		switch {
		case strings.HasPrefix(line, "a=fingerprint:"):
			v := strings.TrimSpace(line[len("a=fingerprint:"):])
			sp := strings.IndexByte(v, ' ')
			if sp <= 0 {
				continue
			}
			hash, hex := strings.ToLower(v[:sp]), strings.ToUpper(strings.TrimSpace(v[sp+1:]))
			if hash == "" || hex == "" {
				continue
			}
			fps[hash+" "+hex] = true
		case strings.HasPrefix(line, "a=mid:"):
			pin.Mids = append(pin.Mids, strings.TrimSpace(line[len("a=mid:"):]))
		case strings.HasPrefix(line, "a=setup:"):
			pin.Setup = strings.ToLower(strings.TrimSpace(line[len("a=setup:"):]))
		}
	}
	for fp := range fps {
		pin.Fingerprints = append(pin.Fingerprints, fp)
	}
	slices.Sort(pin.Fingerprints)
	return pin
}

// SdpPinMatches is `sdpPinMatches`: setup is compared for an answer only.
func SdpPinMatches(base, next SdpPin, isAnswer bool) bool {
	if !slices.Equal(base.Fingerprints, next.Fingerprints) || !slices.Equal(base.Mids, next.Mids) {
		return false
	}
	if isAnswer && base.Setup != "" && base.Setup != next.Setup {
		return false
	}
	return true
}

// SdpIceUfrag is the first a=ice-ufrag of a description, or "".
func SdpIceUfrag(sdp string) string {
	for _, raw := range sdpLines(sdp) {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "a=ice-ufrag:") {
			return strings.TrimSpace(line[len("a=ice-ufrag:"):])
		}
	}
	return ""
}

// CandidateUfrag is the candidate string's own `ufrag` extension, or "".
func CandidateUfrag(candidate string) string {
	parts := strings.Fields(candidate)
	for i := 0; i+1 < len(parts); i++ {
		if parts[i] == "ufrag" {
			return parts[i+1]
		}
	}
	return ""
}

// CandidateAddressKey is `candidateAddressKey`: protocol|address|port|type.
func CandidateAddressKey(candidate string) string {
	parts := strings.Fields(strings.TrimPrefix(strings.TrimSpace(candidate), "a="))
	if len(parts) < 8 || !strings.HasPrefix(parts[0], "candidate:") {
		return ""
	}
	typ := slices.Index(parts, "typ")
	if typ < 0 || typ+1 >= len(parts) {
		return ""
	}
	port, err := strconv.Atoi(parts[5])
	if err != nil {
		return ""
	}
	return StatsAddressKey(parts[2], parts[4], port, parts[typ+1])
}

// StatsAddressKey is `statsAddressKey`.
func StatsAddressKey(protocol, address string, port int, candidateType string) string {
	if protocol == "" || address == "" || candidateType == "" {
		return ""
	}
	return strings.ToLower(protocol) + "|" + address + "|" + strconv.Itoa(port) + "|" + strings.ToLower(candidateType)
}

// InboundCandidateUfrag requires the two ufrag sources to agree where both
// are present; "" means the candidate cannot be attributed and is dropped.
func InboundCandidateUfrag(candidate, usernameFragment string) string {
	embedded := CandidateUfrag(candidate)
	if embedded != "" && usernameFragment != "" && embedded != usernameFragment {
		return ""
	}
	if usernameFragment != "" {
		return usernameFragment
	}
	return embedded
}

// ---------------------------------------------------------------- the engine

// RenewState is what a person may be told. Never "renewed" before commit.
type RenewState string

const (
	RenewIdle        RenewState = "idle"
	RenewRenewing    RenewState = "renewing"
	RenewRenewed     RenewState = "renewed"
	RenewDenied      RenewState = "denied"
	RenewUnsupported RenewState = "unsupported"
	RenewFailed      RenewState = "failed"
	// RenewBroken: an attempt ended without commit after the transport had
	// restarted onto the new credential (Pion, see the file comment). The
	// caller ends the link.
	RenewBroken RenewState = "broken"
)

// RenewCandidate is one ICE candidate crossing the renewal boundary.
type RenewCandidate struct {
	Candidate     string
	SDPMid        *string
	SDPMLineIndex *uint32
	// Ufrag is the generation the candidate belongs to: for a local candidate
	// the transport's authoritative label ("" = cannot tell: never sent), for
	// an inbound one the agreed InboundCandidateUfrag.
	Ufrag string
}

// RenewTransport is the live transport surface renewal migrates.
type RenewTransport interface {
	// SetConfiguration installs a granted configuration (opaque; built by
	// RenewDeps.RenewedConfig). It changes nothing on the wire by itself.
	SetConfiguration(cfg any) error
	// BaselineSDP is the remote description applied at epoch 0.
	BaselineSDP() (string, bool)
	// RestartOffer creates and applies an ICE-restart offer (initiator). On
	// Pion this retires the current path at once.
	RestartOffer() (string, error)
	// ApplyRemote applies a pinned remote description and returns the remote
	// description as the agent holds it (re-pinned after applying). On Pion,
	// applying a restart offer retires the current path at once.
	ApplyRemote(sdpType, sdp string) (string, error)
	// Answer creates and applies the answer to an applied restart offer.
	Answer() (string, error)
	// LocalUfrag / RemoteUfrag read the descriptions now applied.
	LocalUfrag() string
	RemoteUfrag() string
	AddCandidate(c RenewCandidate) error
	// SelectedGeneration names the ICE generation (ufrag) of the selected
	// pair's local and remote candidates; "" = cannot tell.
	SelectedGeneration() (local, remote string)
	// SendControl writes one 0x0d frame on the text lane, outside the text
	// session and its send queue.
	SendControl(frame []byte) error
}

// RenewBound is the relay boundary the link is under right now.
type RenewBound struct {
	DeadlineAt time.Time
	// AnchoredAt is when that boundary was installed (the margin's anchor).
	AnchoredAt time.Time
}

// RenewDeps connects the engine to the driver. Every func runs on the loop.
type RenewDeps struct {
	Now func() time.Time
	// SendSignal delivers a signed renewal envelope to the peer.
	SendSignal func(env []byte) error
	// RequestRound puts {"type":"ice-renew","data":{round,rid}} on the socket.
	RequestRound func(round, rid uint32) error
	// PeerSupportsRenew: the peer announced relay-renew/1 (a hint).
	PeerSupportsRenew func() bool
	// UserActive: authenticated user-lane activity inside RenewActivityWindow.
	UserActive func() bool
	// Bound is the current relay boundary, if the link is bounded at all.
	Bound func() (RenewBound, bool)
	// RenewedConfig turns a granted body into a configuration and the deadline
	// it states, derived at receipt. ok=false: nothing usable (refused).
	RenewedConfig func(body []byte) (cfg any, deadlineAt time.Time, ok bool)
	// Commit publishes a PROVEN migration onto a new round: the caller moves
	// the deadline to deadlineAt. Never called for a same-round repair.
	Commit func(cfg any, deadlineAt time.Time, round uint32)
	// Broke: an attempt ended without commit after the transport restarted.
	// The caller ends the link truthfully. The deadline is untouched.
	Broke func(reason string)
	// Busy, optional: the transport is in a legacy (link §8) recovery that
	// renewal must not race — no attempt starts, a peer's prepare is refused
	// as unavailable.
	Busy func() bool
	// OnState, optional.
	OnState func(RenewState)
	// Random, optional (tests).
	Random func([]byte)
}

type renewBudget struct {
	ackSpent, probeSpent int
}

func (b *renewBudget) can(typ byte) bool {
	if b.ackSpent+b.probeSpent >= RenewMaxProbeVerifications {
		return false
	}
	if typ == RenewProbeTypeAck {
		return b.ackSpent < RenewAckVerifyReserve
	}
	return b.probeSpent < RenewProbeVerifyReserve
}

func (b *renewBudget) spend(typ byte) {
	if typ == RenewProbeTypeAck {
		b.ackSpent++
	} else {
		b.probeSpent++
	}
}

type renewVerified struct {
	tag [RenewTagBytes]byte
	ack []byte
}

type renewConfig struct {
	cfg        any
	deadlineAt time.Time
}

type renewPhase int

const (
	phPreparing renewPhase = iota
	phAwaitingReady
	phNegotiating
	phProbing
)

type renewAttempt struct {
	epoch         uint32
	phase         renewPhase
	hasRound      bool
	round         uint32
	config        *renewConfig
	localReady    bool
	hasPeerRound  bool
	peerRound     uint32
	peerResponded bool
	localUfrag    string
	remoteUfrag   string
	held          map[string][]RenewCandidate
	heldCount     int
	observed      bool
	observedAt    time.Time
	nonce         []byte
	sends         int
	pendingAck    []byte
	verified      map[[RenewNonceBytes]byte]*renewVerified
	charged       bool
	key           uint32
	budget        *renewBudget
	timers        map[string]time.Time
	// restarted: this side's transport has restarted ICE for this attempt
	// (Pion: the previous path is gone).
	restarted bool
}

type renewCommitted struct {
	epoch      uint32
	round      uint32
	localUfrag string
	verified   map[[RenewNonceBytes]byte]*renewVerified
	budget     *renewBudget
	until      time.Time
}

type renewRequest struct {
	a          *renewAttempt
	round      uint32
	generation uint64
	stale      int
	until      time.Time
}

// Renewal is one authenticated link's renewal controller.
type Renewal struct {
	deps      RenewDeps
	tr        RenewTransport
	key       []byte
	self      string
	peer      string
	initiator bool

	state   RenewState
	stopped bool

	epochCounter   uint32
	round          uint32
	migrationSpent map[uint32]int
	approachSpent  map[uint32]int
	roundOrder     []uint32
	installed      *struct {
		round uint32
		cfg   *renewConfig
	}
	requestGen        uint64
	roundDenied       bool
	peerUnsupported   bool
	prepareSent       int
	retryNotBefore    time.Time
	attempt           *renewAttempt
	committed         *renewCommitted
	peerAuthenticated bool
	everRestarted     bool
	// peerProven: a verified renewal signal ever arrived from the peer, even
	// one refused unacted (busy). Unlike peerAuthenticated it confers no
	// unsigned-SDP lock; it only rules out the "unsupported" verdict.
	peerProven    bool
	renewalUfrags map[string]bool
	requests      map[uint32]*renewRequest
	broken        bool
}

// Renewal holds a copy of the link's resumeAuth: every formatter prints the
// renewal state only, never the key (the package's redaction rule).
func (r Renewal) summary() string {
	return "linksession.Renewal{state:" + string(r.state) + " round:" + strconv.FormatUint(uint64(r.round), 10) +
		" epoch:" + strconv.FormatUint(uint64(r.epochCounter), 10) + " key:redacted}"
}
func (r Renewal) Format(f fmt.State, _ rune) { _, _ = io.WriteString(f, r.summary()) }
func (r Renewal) String() string             { return r.summary() }
func (r Renewal) GoString() string           { return r.summary() }
func (r Renewal) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]string{"renewal": r.summary()})
}
func (r Renewal) LogValue() slog.Value { return slog.StringValue(r.summary()) }

// ErrRenewNoLink: renewal needs an open, authenticated link.
var ErrRenewNoLink = errors.New("linksession: renewal needs an open authenticated link")

// NewRenewal binds a renewal controller to this session's authenticated link.
// The link's resumeAuth is copied (renewal introduces no new secret) and is
// wiped by Stop.
func (s *Session) NewRenewal(deps RenewDeps, tr RenewTransport) (*Renewal, error) {
	if s.ended || s.linkM == nil || !s.lk.alive() || len(s.lk.resumeAuth) == 0 || tr == nil {
		return nil, ErrRenewNoLink
	}
	if deps.Now == nil || deps.SendSignal == nil || deps.RequestRound == nil || deps.PeerSupportsRenew == nil ||
		deps.UserActive == nil || deps.Bound == nil || deps.RenewedConfig == nil || deps.Commit == nil || deps.Broke == nil {
		return nil, errors.New("linksession: incomplete renewal deps")
	}
	if deps.Random == nil {
		deps.Random = func(b []byte) { _, _ = rand.Read(b) }
	}
	return &Renewal{
		deps: deps, tr: tr, key: bytes.Clone(s.lk.resumeAuth), self: s.selfID, peer: s.lk.peer,
		initiator: s.lk.role == LCInitiator, state: RenewIdle,
		migrationSpent: map[uint32]int{}, approachSpent: map[uint32]int{},
		renewalUfrags: map[string]bool{}, requests: map[uint32]*renewRequest{},
	}, nil
}

// OutboundAcked is the acknowledged byte count of the outbound batch: it
// moves only when the session accepts an ACK as real progress (never on a
// stray, duplicate, stale or out-of-range one). Renewal's user-activity gate
// reads its movement (relay-renew-v1 §7.1).
func (s *Session) OutboundAcked() uint64 { return s.fout.acked }

// PeerAnnouncedRenew reports whether the peer's last hello named relay-renew/1.
func (s *Session) PeerAnnouncedRenew() bool {
	if s.peer == "" {
		return false
	}
	caps, _ := s.caps.Announced(s.peer)
	return slices.Contains(caps, CapRenew)
}

// State is the current renewal state.
func (r *Renewal) State() RenewState { return r.state }

// Round is the round the link has committed onto (0 until one commits).
func (r *Renewal) Round() uint32 { return r.round }

// InFlight reports an attempt in flight: the unauthenticated link §8 restart
// must be suppressed meanwhile (§4.1).
func (r *Renewal) InFlight() bool { return r.attempt != nil }

// Restarted reports an attempt in flight whose transport has already
// restarted onto the new credential.
func (r *Renewal) Restarted() bool { return r.attempt != nil && r.attempt.restarted }

// Probing reports an attempt in its ICE+probe window: both of its
// descriptions are applied and only proof (or that window's deadline) can end
// it. Read-only; diagnostics and tests.
func (r *Renewal) Probing() bool { return r.attempt != nil && r.attempt.phase == phProbing }

// Migrated reports that the transport has restarted onto a renewal
// generation at least once: every later local candidate is renewal's.
func (r *Renewal) Migrated() bool { return r.everRestarted }

// LockUnsigned reports that this PeerConnection must refuse unsigned
// link-generation SDP (§4.1): a renewal signal was verified, or the transport
// has migrated onto a renewal generation.
func (r *Renewal) LockUnsigned() bool { return r.peerAuthenticated || r.everRestarted }

// Stop releases everything and wipes the key copy.
func (r *Renewal) Stop() {
	if r.stopped {
		return
	}
	r.stopped = true
	r.attempt = nil
	r.committed = nil
	r.requests = map[uint32]*renewRequest{}
	clear(r.key)
	r.state = RenewIdle
}

func (r *Renewal) now() time.Time { return r.deps.Now() }

func (r *Renewal) publish(s RenewState) {
	if r.state == s {
		return
	}
	r.state = s
	if r.deps.OnState != nil {
		r.deps.OnState(s)
	}
}

func (r *Renewal) sign(payload string) (string, bool) {
	tag, err := linkcrypto.SignResume(r.key, payload)
	return tag, err == nil
}

func (r *Renewal) mac(payload string) []byte {
	m := hmac.New(sha256.New, r.key)
	m.Write([]byte(payload))
	return m.Sum(nil)
}

// emit signs and sends one renewal signal, in order.
func (r *Renewal) emit(sig RenewSignal) {
	if r.stopped {
		return
	}
	p, err := RenewSignalPayload(sig, r.self, r.peer)
	if err != nil {
		return
	}
	auth, ok := r.sign(p)
	if !ok {
		return
	}
	_ = r.deps.SendSignal(EncodeRenewEnvelope(sig, auth))
}

// ---- budgets

func (r *Renewal) noteRound(k uint32) {
	if !slices.Contains(r.roundOrder, k) {
		r.roundOrder = append(r.roundOrder, k)
	}
	for len(r.roundOrder) > renewRoundsRetained {
		old := r.roundOrder[0]
		r.roundOrder = r.roundOrder[1:]
		delete(r.migrationSpent, old)
		delete(r.approachSpent, old)
	}
}

func (r *Renewal) roundExhausted(k uint32) bool { return r.migrationSpent[k] >= RenewMaxEpochsPerRound }

func (r *Renewal) chargeMigration(k uint32) {
	r.migrationSpent[k]++
	r.noteRound(k)
}

func (r *Renewal) chargeApproach(k uint32) {
	r.approachSpent[k]++
	r.noteRound(k)
}

func (r *Renewal) inWindow() bool {
	b, ok := r.deps.Bound()
	if !ok {
		return false
	}
	now := r.now()
	if !now.Before(b.DeadlineAt) {
		return false
	}
	return !now.Before(b.DeadlineAt.Add(-RenewMargin(b.DeadlineAt, b.AnchoredAt)))
}

func (r *Renewal) attemptKey(remote bool) uint32 {
	if !remote {
		return r.round + 1
	}
	repairable := r.installed != nil && r.installed.round >= r.round
	if repairable && !r.inWindow() {
		return r.installed.round
	}
	return r.round + 1
}

// ---- timers

func (r *Renewal) arm(a *renewAttempt, name string, d time.Duration) { a.timers[name] = r.now().Add(d) }
func (r *Renewal) disarm(a *renewAttempt, name string)               { delete(a.timers, name) }

// NextDeadline is the earliest instant Tick has something to do, including
// the opening of the renewal window and the end of a backoff.
func (r *Renewal) NextDeadline() (time.Time, bool) {
	if r.stopped {
		return time.Time{}, false
	}
	var at time.Time
	found := false
	fold := func(t time.Time) {
		if !found || t.Before(at) {
			at, found = t, true
		}
	}
	if a := r.attempt; a != nil {
		for _, t := range a.timers {
			fold(t)
		}
	}
	for _, q := range r.requests {
		fold(q.until)
	}
	if c := r.committed; c != nil {
		fold(c.until)
	}
	if r.attempt == nil && !r.peerUnsupported && !r.roundDenied {
		// Only FUTURE instants. Inside an open window with no backoff running,
		// the trigger is polled on a bounded cadence (renewPoll): whether an
		// attempt is due also depends on activity, which has no deadline.
		now := r.now()
		if b, ok := r.deps.Bound(); ok && now.Before(b.DeadlineAt) && !r.broken {
			open := b.DeadlineAt.Add(-RenewMargin(b.DeadlineAt, b.AnchoredAt))
			switch {
			case open.After(now):
				fold(open)
			case r.retryNotBefore.After(now):
				fold(r.retryNotBefore)
			default:
				fold(now.Add(renewPoll))
			}
		}
	}
	return at, found
}

// Tick fires due timers, then starts an attempt if one is due.
func (r *Renewal) Tick() {
	if r.stopped {
		return
	}
	for guard := 0; guard < 64; guard++ {
		now := r.now()
		fired := false
		// Earliest first; on a tie the attempt's own timers win, because they
		// were armed before the round request they would race (a peer-silence
		// verdict must not be pre-empted by the server's silence at the same
		// instant).
		var rid uint32
		var q *renewRequest
		for k, v := range r.requests {
			if !now.Before(v.until) && (q == nil || v.until.Before(q.until)) {
				rid, q = k, v
			}
		}
		name, due := "", time.Time{}
		if a := r.attempt; a != nil {
			for n, t := range a.timers {
				if !now.Before(t) && (name == "" || t.Before(due) || (t.Equal(due) && n < name)) {
					name, due = n, t
				}
			}
		}
		switch {
		case name != "" && (q == nil || !q.until.Before(due)):
			delete(r.attempt.timers, name)
			r.fire(r.attempt, name)
			fired = true
		case q != nil:
			delete(r.requests, rid)
			r.roundResult(q, nil)
			fired = true
		case r.committed != nil && !now.Before(r.committed.until):
			r.committed = nil
			fired = true
		}
		if !fired {
			break
		}
	}
	r.trigger()
}

func (r *Renewal) fire(a *renewAttempt, name string) {
	if r.attempt != a || r.stopped {
		return
	}
	switch name {
	case "epoch", "ready", "offer", "answer", "ice":
		r.abort(a, renewAbortTimeout)
	case "prepare":
		// A peer that ever sent a VERIFIED renewal signal implements it: its
		// silence now (a prepare it dropped as stale, a lost message) is a
		// timeout, never an "unsupported" verdict for the rest of the link.
		if a.peerResponded || r.peerAuthenticated || r.peerProven {
			r.abort(a, renewAbortTimeout)
			return
		}
		if r.prepareSent >= 2 {
			r.peerUnsupported = true
			r.finish(a, renewAbortTimeout, RenewUnsupported, true)
			return
		}
		r.abort(a, renewAbortTimeout)
	case "prepare-retry":
		if a.phase != phPreparing {
			return
		}
		r.prepareSent++
		r.emit(RenewSignal{Type: "prepare", Epoch: a.epoch})
	case "observe":
		r.pollObservation(a)
	case "probe":
		r.sendProbe(a)
	}
}

// ---- lifecycle

func (r *Renewal) endAttempt(a *renewAttempt, reason string, next RenewState) {
	if r.attempt != a {
		return
	}
	r.attempt = nil
	a.timers = map[string]time.Time{}
	// Local failure and teardown FIRST, independent of telling the peer: the
	// abort below is handed to the caller's signalling, which may be slow or
	// stuck, and nothing here may wait for it.
	if a.restarted && !r.broken {
		// Pion retired the previous path when this attempt restarted ICE.
		// Nothing can fall back to it; the link must end, truthfully, with
		// the deadline it had.
		r.broken = true
		r.publish(RenewBroken)
		why := reason
		if why == "" {
			why = "peer"
		}
		r.deps.Broke(why)
	} else if !r.broken {
		r.publish(next)
	}
	if reason != "" {
		r.emit(RenewSignal{Type: "abort", Epoch: a.epoch, Reason: reason})
	}
}

func (r *Renewal) finish(a *renewAttempt, announce string, st RenewState, backoff bool) {
	if r.attempt != a {
		return
	}
	if !a.charged {
		r.chargeApproach(a.key)
	}
	if backoff {
		r.retryNotBefore = r.now().Add(RenewRetryBackoff)
	}
	r.endAttempt(a, announce, st)
}

func (r *Renewal) abort(a *renewAttempt, reason string) {
	st := RenewFailed
	if reason == renewAbortDenied {
		st = RenewDenied
	}
	r.finish(a, reason, st, true)
}

func (r *Renewal) begin(epoch uint32, remote bool) *renewAttempt {
	a := &renewAttempt{
		epoch: epoch, key: r.attemptKey(remote), budget: &renewBudget{},
		held: map[string][]RenewCandidate{}, verified: map[[RenewNonceBytes]byte]*renewVerified{},
		timers: map[string]time.Time{},
	}
	r.attempt = a
	r.epochCounter = max(r.epochCounter, epoch)
	r.publish(RenewRenewing)
	r.arm(a, "epoch", RenewEpochHardCap)
	return a
}

// ---- the trigger

func (r *Renewal) due() bool {
	if r.stopped || r.broken || r.attempt != nil || r.peerUnsupported || r.roundDenied {
		return false
	}
	if !r.deps.PeerSupportsRenew() {
		return false
	}
	if r.deps.Busy != nil && r.deps.Busy() {
		return false
	}
	if r.approachSpent[r.attemptKey(false)] >= RenewMaxPregrantAttempts {
		return false
	}
	if r.roundExhausted(r.round+1) &&
		!(r.installed != nil && r.installed.round >= r.round && !r.roundExhausted(r.installed.round)) {
		return false
	}
	if _, ok := r.deps.Bound(); !ok {
		return false
	}
	if r.now().Before(r.retryNotBefore) {
		return false
	}
	if !r.inWindow() {
		return false
	}
	return r.deps.UserActive()
}

func (r *Renewal) trigger() {
	if !r.due() {
		return
	}
	a := r.begin(r.epochCounter+1, false)
	r.prepareSent++
	r.emit(RenewSignal{Type: "prepare", Epoch: a.epoch})
	r.arm(a, "prepare", RenewPrepareToReady)
	r.arm(a, "prepare-retry", RenewPrepareSilence)
	r.askServer(a, r.round+1, 1)
}

// ---- the server round

func (r *Renewal) randomU32() uint32 {
	var b [4]byte
	for {
		r.deps.Random(b[:])
		v := binary.BigEndian.Uint32(b[:])
		if v != 0 {
			return v
		}
		b = [4]byte{} // the server refuses rid 0; draw again
	}
}

func (r *Renewal) askServer(a *renewAttempt, asking uint32, stale int) {
	if len(r.requests) >= RenewMaxInflightRounds {
		r.awaitRepairOrAbort(a, renewAbortUnavailable)
		return
	}
	rid := r.randomU32()
	if _, dup := r.requests[rid]; dup {
		r.awaitRepairOrAbort(a, renewAbortUnavailable)
		return
	}
	q := &renewRequest{a: a, round: asking, generation: r.requestGen, stale: stale, until: r.now().Add(RenewRoundTimeout)}
	r.requests[rid] = q
	if err := r.deps.RequestRound(asking, rid); err != nil {
		delete(r.requests, rid)
		r.roundResult(q, nil)
	}
}

// Grant feeds one `ice-grant` payload from the signalling socket.
func (r *Renewal) Grant(raw []byte) {
	if r.stopped {
		return
	}
	g, ok := ParseIceGrant(raw)
	if !ok {
		return
	}
	q := r.requests[g.RID]
	if q == nil {
		return
	}
	if g.Status != "stale" && g.Round != q.round {
		return
	}
	delete(r.requests, g.RID)
	r.roundResult(q, &g)
}

func (r *Renewal) roundResult(q *renewRequest, g *IceGrant) {
	a := q.a
	if r.stopped || r.attempt != a {
		return
	}
	if q.generation != r.requestGen {
		return // fenced: this attempt adopted an installed round instead (§6.7)
	}
	if g == nil {
		r.awaitRepairOrAbort(a, renewAbortUnavailable)
		return
	}
	switch g.Status {
	case "stale":
		if q.stale <= 0 || !r.saneRound(g.Round) {
			r.awaitRepairOrAbort(a, renewAbortUnavailable)
			return
		}
		r.askServer(a, g.Round, q.stale-1)
		return
	case "denied":
		r.roundDenied = true
		r.abort(a, renewAbortDenied)
		return
	case "unavailable":
		r.awaitRepairOrAbort(a, renewAbortUnavailable)
		return
	}
	cfg, deadlineAt, ok := r.deps.RenewedConfig(g.Body)
	if !ok || deadlineAt.IsZero() {
		r.abort(a, renewAbortUnavailable) // no blind extension
		return
	}
	if b, ok := r.deps.Bound(); ok && !deadlineAt.After(b.DeadlineAt) {
		r.abort(a, renewAbortUnavailable) // would move the boundary earlier, or not at all
		return
	}
	if r.roundExhausted(g.Round) {
		r.abort(a, renewAbortUnavailable) // refused before any configuration or SDP
		return
	}
	rc := &renewConfig{cfg: cfg, deadlineAt: deadlineAt}
	a.hasRound, a.round, a.config = true, g.Round, rc
	if err := r.tr.SetConfiguration(cfg); err != nil {
		r.abort(a, renewAbortUnavailable)
		return
	}
	a.charged = true
	r.chargeMigration(g.Round)
	r.installed = &struct {
		round uint32
		cfg   *renewConfig
	}{g.Round, rc}
	a.localReady = true
	a.phase = phAwaitingReady
	r.disarm(a, "prepare-retry")
	r.emit(RenewSignal{Type: "ready", Epoch: a.epoch, Round: g.Round})
	r.arm(a, "ready", RenewReadyToAnswer)
	r.maybeOffer(a)
}

func (r *Renewal) awaitRepairOrAbort(a *renewAttempt, reason string) {
	h := r.installed
	if h == nil || h.round < r.round || !r.now().Before(h.cfg.deadlineAt) {
		r.abort(a, reason)
		return
	}
	a.phase = phAwaitingReady
}

func (r *Renewal) saneRound(next uint32) bool {
	return next > r.round && uint64(next) <= uint64(r.round)+RenewMaxEpochsPerRound+1
}

// ---- negotiation

func (r *Renewal) maybeOffer(a *renewAttempt) {
	if a.phase != phAwaitingReady || !a.localReady || !a.hasRound || !a.hasPeerRound || a.peerRound != a.round {
		return
	}
	// Pion restarts ICE break-before-make: before retiring the live path,
	// both sides are ready on the SAME locally validated round, and the pin
	// baseline exists so the peer's answer can be checked.
	if _, ok := r.tr.BaselineSDP(); !ok {
		r.abort(a, renewAbortSDP)
		return
	}
	a.phase = phNegotiating
	r.disarm(a, "ready")
	if !r.initiator {
		r.arm(a, "offer", RenewReadyToAnswer)
		return
	}
	a.restarted = true // CreateOffer(ICERestart) retires the path even if it then fails
	r.everRestarted = true
	sdp, err := r.tr.RestartOffer()
	if err != nil || r.attempt != a {
		if r.attempt == a {
			r.abort(a, renewAbortSDP)
		}
		return
	}
	a.localUfrag = r.tr.LocalUfrag()
	if a.localUfrag == "" {
		r.abort(a, renewAbortSDP)
		return
	}
	r.renewalUfrags[a.localUfrag] = true
	r.emit(RenewSignal{Type: "sdp", Epoch: a.epoch, Round: a.round, SDPType: "offer", SDP: sdp})
	r.arm(a, "answer", RenewReadyToAnswer)
}

func (r *Renewal) beginICE(a *renewAttempt) {
	if a.localUfrag == "" || a.remoteUfrag == "" {
		r.abort(a, renewAbortSDP)
		return
	}
	a.phase = phProbing
	r.disarm(a, "answer")
	r.disarm(a, "offer")
	r.arm(a, "ice", RenewICEProbe)
	r.pollObservation(a)
}

// PathChanged is a wake-up: the transport's selected pair changed.
func (r *Renewal) PathChanged() {
	if a := r.attempt; a != nil && a.phase == phProbing && !a.observed {
		r.observe(a)
	}
}

func (r *Renewal) pollObservation(a *renewAttempt) {
	if r.stopped || r.attempt != a || a.observed {
		return
	}
	r.observe(a)
	if r.attempt == a && !a.observed {
		r.arm(a, "observe", renewObservePoll)
	}
}

func (r *Renewal) observe(a *renewAttempt) {
	if r.stopped || r.attempt != a || a.observed || a.phase != phProbing {
		return
	}
	local, remote := r.tr.SelectedGeneration()
	if local == "" || local != a.localUfrag {
		return
	}
	if remote != "" && remote != a.remoteUfrag {
		return
	}
	a.observed = true
	a.observedAt = r.now()
	r.disarm(a, "observe")
	if n := a.pendingAck; n != nil {
		a.pendingAck = nil
		r.ackProbe(a.epoch, a.round, n, a.verified)
	}
	if a.nonce == nil {
		a.nonce = make([]byte, RenewNonceBytes)
		r.deps.Random(a.nonce)
		r.sendProbe(a)
	}
}

func (r *Renewal) sendProbe(a *renewAttempt) {
	if r.stopped || r.attempt != a || a.nonce == nil || a.sends >= RenewProbeMaxSends {
		return
	}
	a.sends++
	if f, ok := r.controlFrame(false, a.epoch, a.round, a.nonce); ok {
		_ = r.tr.SendControl(f)
	}
	r.arm(a, "probe", RenewProbeRetry)
}

func (r *Renewal) controlFrame(ack bool, epoch, round uint32, nonce []byte) ([]byte, bool) {
	p, err := RenewProbePayload(ack, r.self, r.peer, epoch, round, nonce)
	if err != nil {
		return nil, false
	}
	f := RenewProbeFrame{Type: RenewProbeTypeProbe, Epoch: epoch, Round: round}
	if ack {
		f.Type = RenewProbeTypeAck
	}
	copy(f.Nonce[:], nonce)
	copy(f.Tag[:], r.mac(p))
	return EncodeRenewProbe(f), true
}

func (r *Renewal) ackProbe(epoch, round uint32, nonce []byte, verified map[[RenewNonceBytes]byte]*renewVerified) {
	f, ok := r.controlFrame(true, epoch, round, nonce)
	if !ok {
		return
	}
	var k [RenewNonceBytes]byte
	copy(k[:], nonce)
	if rec := verified[k]; rec != nil {
		rec.ack = f
	}
	_ = r.tr.SendControl(f)
}

func (r *Renewal) commit(a *renewAttempt) {
	if a.config == nil || !a.hasRound {
		r.abort(a, renewAbortClosed)
		return
	}
	same := a.round == r.round
	if !same {
		r.round = a.round
		delete(r.approachSpent, a.round)
		r.roundDenied = false
		r.retryNotBefore = time.Time{}
	}
	r.attempt = nil
	r.committed = &renewCommitted{
		epoch: a.epoch, round: a.round, localUfrag: a.localUfrag,
		verified: a.verified, budget: a.budget, until: r.now().Add(RenewPostCommitAck),
	}
	r.publish(RenewRenewed)
	if !same {
		r.deps.Commit(a.config.cfg, a.config.deadlineAt, a.round)
	}
}

// ---- inbound signalling

// Signal consumes one inbound signal. It reports whether the signal belonged
// to renewal (then it must not reach the link session). A signal carrying a
// top-level `renew` key that is not an exact envelope is consumed and dropped.
func (r *Renewal) Signal(raw []byte) bool {
	sig, auth, ok := ParseRenewEnvelope(raw)
	if !ok {
		return HasRenewKey(raw)
	}
	if r.stopped {
		return true
	}
	if !r.routable(sig) {
		return true
	}
	payload, err := RenewSignalPayload(sig, r.peer, r.self)
	if err != nil || !linkcrypto.VerifyResume(r.key, payload, auth) {
		return true
	}
	// A prepare that would start a NEW attempt while a legacy (link §8)
	// recovery owns the transport is refused here, BEFORE it is acted on: a
	// refused prepare must not establish the permanent unsigned-SDP lock
	// (§4.1), or the legacy restart's own unsigned answer — which may simply
	// arrive after it — would be refused and the recovery would expire.
	// Verified first, so a forgery gets no reply.
	if sig.Type == "prepare" && (r.attempt == nil || sig.Epoch > r.attempt.epoch) && r.deps.Busy != nil && r.deps.Busy() {
		// What the refusal DOES keep (Codex r4): the epoch is spent — the
		// peer has used it, so a later local attempt must go higher or the
		// peer drops it as stale — and the peer is PROVEN to implement
		// renewal, so its later silence is never an "unsupported" verdict.
		// Neither is the unsigned-SDP lock, which stays unset.
		r.epochCounter = max(r.epochCounter, sig.Epoch)
		r.peerProven = true
		r.emit(RenewSignal{Type: "abort", Epoch: sig.Epoch, Reason: renewAbortUnavailable})
		return true
	}
	r.peerAuthenticated = true
	r.peerProven = true
	if a := r.attempt; a != nil && (sig.Type == "prepare" || sig.Epoch == a.epoch) {
		a.peerResponded = true
		r.disarm(a, "prepare")
		r.disarm(a, "prepare-retry")
	}
	r.apply(sig)
	return true
}

func (r *Renewal) routable(sig RenewSignal) bool {
	if r.broken {
		return false
	}
	if sig.Type == "prepare" {
		if r.peerUnsupported {
			return false
		}
		if r.attempt != nil {
			return sig.Epoch >= r.attempt.epoch
		}
		return sig.Epoch > r.epochCounter
	}
	return r.attempt != nil && sig.Epoch == r.attempt.epoch
}

func (r *Renewal) apply(sig RenewSignal) {
	if sig.Type == "prepare" {
		r.onPrepare(sig.Epoch)
		return
	}
	a := r.attempt
	if a == nil || a.epoch != sig.Epoch {
		return
	}
	switch sig.Type {
	case "abort":
		st := RenewFailed
		if sig.Reason == renewAbortDenied {
			r.roundDenied = true
			st = RenewDenied
		}
		r.finish(a, "", st, true)
	case "ready":
		a.hasPeerRound, a.peerRound = true, sig.Round
		r.maybeAdoptInstalled(a)
		r.maybeOffer(a)
	case "sdp":
		r.onSDP(a, sig)
	case "ice":
		r.onCandidate(a, sig)
	}
}

func (r *Renewal) onPrepare(epoch uint32) {
	if _, ok := r.deps.Bound(); !ok || !r.deps.UserActive() {
		r.emit(RenewSignal{Type: "abort", Epoch: epoch, Reason: renewAbortUnavailable})
		return
	}
	if r.roundDenied {
		r.emit(RenewSignal{Type: "abort", Epoch: epoch, Reason: renewAbortDenied})
		return
	}
	if a := r.attempt; a != nil && epoch <= a.epoch {
		return // the attempt in flight (or an older one): not a new start
	}
	// A legacy recovery owns the transport: no NEW attempt starts. The one
	// already in flight is not refused here — it is what will settle it.
	if r.deps.Busy != nil && r.deps.Busy() {
		r.emit(RenewSignal{Type: "abort", Epoch: epoch, Reason: renewAbortUnavailable})
		return
	}
	if a := r.attempt; a != nil {
		r.finish(a, "", RenewRenewing, false) // superseded: charged, no backoff
		if r.broken {
			return
		}
	}
	key := r.attemptKey(true)
	if r.approachSpent[key] >= RenewMaxPregrantAttempts || r.roundExhausted(key) {
		r.emit(RenewSignal{Type: "abort", Epoch: epoch, Reason: renewAbortUnavailable})
		return
	}
	a := r.begin(epoch, true)
	r.prepareSent++
	r.emit(RenewSignal{Type: "prepare", Epoch: epoch})
	r.askServer(a, r.round+1, 1)
}

func (r *Renewal) maybeAdoptInstalled(a *renewAttempt) {
	if !a.hasPeerRound || a.hasRound {
		return
	}
	h := r.installed
	if h == nil || a.peerRound != h.round || a.peerRound < r.round {
		return
	}
	if !r.now().Before(h.cfg.deadlineAt) || r.roundExhausted(h.round) {
		return
	}
	r.requestGen++ // fence the in-flight R+1 request
	if err := r.tr.SetConfiguration(h.cfg.cfg); err != nil {
		return
	}
	a.hasRound, a.round, a.config = true, h.round, h.cfg
	a.charged = true
	r.chargeMigration(h.round)
	a.localReady = true
	a.phase = phAwaitingReady
	r.disarm(a, "prepare-retry")
	r.emit(RenewSignal{Type: "ready", Epoch: a.epoch, Round: h.round})
	r.arm(a, "ready", RenewReadyToAnswer)
}

func (r *Renewal) onSDP(a *renewAttempt, sig RenewSignal) {
	if !a.hasRound || sig.Round != a.round {
		r.abort(a, renewAbortSDP)
		return
	}
	offering := sig.SDPType == "offer"
	if offering == r.initiator {
		r.abort(a, renewAbortSDP) // only the established initiator offers
		return
	}
	if offering && a.phase != phNegotiating {
		r.abort(a, renewAbortSDP)
		return
	}
	if !offering && a.localUfrag == "" {
		r.abort(a, renewAbortSDP)
		return
	}
	baseSDP, ok := r.tr.BaselineSDP()
	if !ok {
		r.abort(a, renewAbortSDP)
		return
	}
	base := SdpPinOf(baseSDP)
	isAnswer := sig.SDPType == "answer"
	// Pinned on the RECEIVED bytes, before the transport is touched.
	if !SdpPinMatches(base, SdpPinOf(sig.SDP), isAnswer) {
		r.abort(a, renewAbortSDP)
		return
	}
	if offering {
		// Applying a restart offer retires the live path on Pion.
		a.restarted = true
		r.everRestarted = true
	}
	applied, err := r.tr.ApplyRemote(sig.SDPType, sig.SDP)
	if err != nil {
		if r.attempt == a {
			r.abort(a, renewAbortSDP)
		}
		return
	}
	if r.attempt != a {
		return
	}
	if !SdpPinMatches(base, SdpPinOf(applied), isAnswer) {
		r.abort(a, renewAbortSDP)
		return
	}
	a.remoteUfrag = r.tr.RemoteUfrag()
	if a.remoteUfrag == "" {
		r.abort(a, renewAbortSDP)
		return
	}
	held := a.held[a.remoteUfrag]
	a.held, a.heldCount = map[string][]RenewCandidate{}, 0
	for _, c := range held {
		_ = r.tr.AddCandidate(c)
	}
	if !offering {
		r.beginICE(a)
		return
	}
	answer, err := r.tr.Answer()
	if err != nil || r.attempt != a {
		if r.attempt == a {
			r.abort(a, renewAbortSDP)
		}
		return
	}
	a.localUfrag = r.tr.LocalUfrag()
	if a.localUfrag == "" {
		r.abort(a, renewAbortSDP)
		return
	}
	r.renewalUfrags[a.localUfrag] = true
	r.emit(RenewSignal{Type: "sdp", Epoch: a.epoch, Round: a.round, SDPType: "answer", SDP: answer})
	r.beginICE(a)
}

func (r *Renewal) onCandidate(a *renewAttempt, sig RenewSignal) {
	if !a.hasRound || sig.Round != a.round {
		return
	}
	ufrag := InboundCandidateUfrag(sig.Candidate, sig.UsernameFragment)
	if ufrag == "" {
		return
	}
	c := RenewCandidate{Candidate: sig.Candidate, SDPMid: sig.SDPMid, SDPMLineIndex: sig.SDPMLineIndex, Ufrag: ufrag}
	if a.remoteUfrag == "" {
		if a.heldCount >= RenewMaxHeldCandidates {
			return
		}
		a.heldCount++
		a.held[ufrag] = append(a.held[ufrag], c)
		return
	}
	if ufrag != a.remoteUfrag {
		return
	}
	_ = r.tr.AddCandidate(c)
}

// LocalCandidate routes one locally gathered candidate. claimed=false means
// the transport has never migrated and the candidate belongs to the ordinary
// link path. Once a renewal generation exists every local candidate is
// renewal's: signed under the live or committed epoch when its generation
// matches, and dropped otherwise — never sent unsigned, never labelled from a
// "current epoch" guess.
func (r *Renewal) LocalCandidate(c RenewCandidate) (claimed bool) {
	if r.stopped {
		return r.everRestarted
	}
	if !r.everRestarted {
		return false
	}
	if c.Ufrag == "" {
		return true
	}
	if a := r.attempt; a != nil && a.hasRound && a.localUfrag != "" && c.Ufrag == a.localUfrag {
		r.emit(RenewSignal{Type: "ice", Epoch: a.epoch, Round: a.round, Candidate: c.Candidate,
			SDPMid: c.SDPMid, SDPMLineIndex: c.SDPMLineIndex, UsernameFragment: c.Ufrag})
		return true
	}
	if cm := r.committed; cm != nil && c.Ufrag == cm.localUfrag {
		r.emit(RenewSignal{Type: "ice", Epoch: cm.epoch, Round: cm.round, Candidate: c.Candidate,
			SDPMid: c.SDPMid, SDPMLineIndex: c.SDPMLineIndex, UsernameFragment: c.Ufrag})
	}
	return true
}

// ---- inbound data-lane frames

// Frame is the text lane's front demux. It reports whether the frame was a
// renewal control frame (first byte 0x0d) — then it was consumed here and
// MUST NOT reach the text session, its idle timer or its rate budget.
func (r *Renewal) Frame(b []byte) bool {
	if !IsRenewControlFrame(b) {
		return false
	}
	if r.stopped {
		return true
	}
	f, ok := DecodeRenewProbe(b)
	if !ok {
		return true
	}
	if a := r.attempt; a != nil && a.hasRound && f.Epoch == a.epoch && f.Round == a.round {
		r.handleControl(a, f)
		return true
	}
	if c := r.committed; c != nil && f.Epoch == c.epoch && f.Round == c.round && f.Type == RenewProbeTypeProbe {
		r.handleCommittedProbe(c, f)
	}
	return true
}

func (r *Renewal) verifyFrame(f RenewProbeFrame) bool {
	p, err := RenewProbePayload(f.Type == RenewProbeTypeAck, r.peer, r.self, f.Epoch, f.Round, f.Nonce[:])
	if err != nil {
		return false
	}
	return hmac.Equal(f.Tag[:], r.mac(p))
}

func (r *Renewal) handleControl(a *renewAttempt, f RenewProbeFrame) {
	if f.Type == RenewProbeTypeProbe {
		if known := a.verified[f.Nonce]; known != nil {
			if known.tag == f.Tag && known.ack != nil {
				_ = r.tr.SendControl(known.ack)
			}
			return
		}
	} else {
		// An ACK counts only for THIS side's current nonce, after observation.
		if a.nonce == nil || !bytes.Equal(a.nonce, f.Nonce[:]) || !a.observed {
			return
		}
	}
	if !a.budget.can(f.Type) {
		return
	}
	a.budget.spend(f.Type)
	if !r.verifyFrame(f) {
		return
	}
	if f.Type == RenewProbeTypeProbe {
		a.verified[f.Nonce] = &renewVerified{tag: f.Tag}
		if a.observed {
			r.ackProbe(a.epoch, a.round, f.Nonce[:], a.verified)
		} else {
			a.pendingAck = bytes.Clone(f.Nonce[:])
		}
		return
	}
	// §6.5: observed, observation before this ACK, and our current nonce.
	if !a.observed || !bytes.Equal(a.nonce, f.Nonce[:]) || r.now().Before(a.observedAt) {
		return
	}
	r.commit(a)
}

func (r *Renewal) handleCommittedProbe(c *renewCommitted, f RenewProbeFrame) {
	if known := c.verified[f.Nonce]; known != nil {
		if known.tag == f.Tag && known.ack != nil {
			_ = r.tr.SendControl(known.ack)
		}
		return
	}
	if !c.budget.can(RenewProbeTypeProbe) {
		return
	}
	c.budget.spend(RenewProbeTypeProbe)
	if !r.verifyFrame(f) {
		return
	}
	c.verified[f.Nonce] = &renewVerified{tag: f.Tag}
	r.ackProbe(c.epoch, c.round, f.Nonce[:], c.verified)
}
