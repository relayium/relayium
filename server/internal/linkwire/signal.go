package linkwire

import (
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"unicode/utf8"

	"github.com/relayium/relayium/internal/linkcrypto"
)

// Signal is one peer-authored signalling payload, parsed without trusting it.
// Keys are exact and case-sensitive, a duplicated key keeps its last value (as
// JSON.parse), and a payload that is valid JSON but not an object is a Signal
// with no fields — never an error, because a frame this build does not
// understand must not throw out of a dispatch loop.
type Signal struct {
	fields   map[string]json.RawMessage
	isObject bool
}

// ParseSignal parses raw. It fails only for bytes that are not acceptable
// JSON: invalid JSON, invalid UTF-8, or an unpaired surrogate escape.
func ParseSignal(raw []byte) (Signal, error) {
	fields, ok, err := jsonObject(raw)
	if err != nil {
		return Signal{}, err
	}
	return Signal{fields: fields, isObject: ok}, nil
}

// IsObject reports whether the payload was a JSON object.
func (s Signal) IsObject() bool { return s.isObject }

func (s Signal) isTrue(key string) bool { return jsonIsTrue(s.fields[key]) }

// Generation is which concurrent connection a signal belongs to. The inbound
// vocabulary is wider than what may be constructed: `file` and `text` must
// still be recognised so that they are not mistaken for this protocol.
type Generation int

const (
	GenerationFile Generation = iota
	GenerationResume
	GenerationText
	GenerationLink
)

func (g Generation) String() string {
	switch g {
	case GenerationResume:
		return "resume"
	case GenerationText:
		return "text"
	case GenerationLink:
		return "link"
	}
	return "file"
}

// SignalGeneration classifies by exact JSON `true`, in the precedence of link
// §4.1: resume, then link, then text, otherwise file. `resume` outranks `link`,
// so a signal carrying both is a rebuild and never an establishment.
func SignalGeneration(s Signal) Generation {
	switch {
	case s.isTrue("resume"):
		return GenerationResume
	case s.isTrue("link"):
		return GenerationLink
	case s.isTrue("text"):
		return GenerationText
	}
	return GenerationFile
}

// IsLinkOffer reports a fresh link offer: the link generation and an `sdp`
// object whose `type` is the string "offer".
func IsLinkOffer(s Signal) bool {
	if SignalGeneration(s) != GenerationLink {
		return false
	}
	sdp, ok, err := jsonObject(s.fields["sdp"])
	if err != nil || !ok {
		return false
	}
	t, ok := jsonString(sdp["type"])
	return ok && t == "offer"
}

// IsLinkRequest reports {"link":true,"linkRequest":true} with NO `sdp` key;
// that absence is part of recognising it.
func IsLinkRequest(s Signal) bool {
	_, hasSDP := s.fields["sdp"]
	return s.isTrue("link") && s.isTrue("linkRequest") && !hasSDP
}

// LeaveAuth recognises a leave signal by EXACT shape, before anything
// cryptographic runs, and returns its tag: exactly the keys link, leave and
// auth; link and leave exact `true`; auth a string of LinkAuthTagLength UTF-16
// code units (the Web's `.length`). Anything else is not a leave. Any extra key
// would be acted on by another handler sharing the link generation.
func LeaveAuth(s Signal) (string, bool) {
	if !s.isObject || len(s.fields) != 3 || !s.isTrue("link") || !s.isTrue("leave") {
		return "", false
	}
	auth, ok := jsonString(s.fields["auth"])
	if !ok || utf16Len(auth) != LinkAuthTagLength {
		return "", false
	}
	return auth, true
}

// LinkLeavePayload is the exact string a leave tag covers:
// {"kind":"link-leave","from":<from>,"to":<to>} with JavaScript JSON.stringify
// escaping. It refuses invalid UTF-8 (which includes anything that would stand
// for a lone UTF-16 surrogate) rather than render a replacement character.
func LinkLeavePayload(from, to string) (string, error) {
	if !utf8.ValidString(from) || !utf8.ValidString(to) {
		return "", ErrInvalidUTF8
	}
	b := []byte(`{"kind":"link-leave","from":`)
	b = appendJSString(b, from)
	b = append(b, `,"to":`...)
	b = appendJSString(b, to)
	return string(append(b, '}')), nil
}

// SignLeave tags a leave this side sends to peer: HMAC over
// LinkLeavePayload(self, peer) under the link's ResumeAuth key.
func SignLeave(resumeAuth []byte, self, peer string) (string, error) {
	p, err := LinkLeavePayload(self, peer)
	if err != nil {
		return "", err
	}
	return linkcrypto.SignResume(resumeAuth, p)
}

// VerifyLeave checks a leave received from sender: the tag must cover
// LinkLeavePayload(sender, self), so a leave reflected back at its own sender
// verifies the reversed tuple and fails. Any malformed input is false. This is
// only the MAC; the shape check, the link/status checks and the per-link
// attempt budget of link §4.6 come first and belong to the lane layer.
func VerifyLeave(resumeAuth []byte, sender, self, tag string) bool {
	p, err := LinkLeavePayload(sender, self)
	if err != nil {
		return false
	}
	return linkcrypto.VerifyResume(resumeAuth, p, tag)
}

// AuthFields is what a resume/ICE tag covers (link §4.4). A nil field renders
// as JSON null.
type AuthFields struct {
	SDPType          *string
	SDP              *string
	Candidate        *string
	SDPMid           *string
	SDPMLineIndex    *int64
	UsernameFragment *string
}

// AuthPayload renders the exact string a resume/ICE tag covers, fields in this
// fixed order with no whitespace:
// {"sdpType","sdp","candidate","sdpMid","sdpMLineIndex","usernameFragment"}.
// Strings must be valid UTF-8; sdpMLineIndex must be a safe integer and is
// rendered in plain decimal, as JavaScript renders it.
func AuthPayload(f AuthFields) (string, error) {
	b := []byte(`{"sdpType":`)
	var err error
	if b, err = appendStringOrNull(b, f.SDPType); err != nil {
		return "", err
	}
	b = append(b, `,"sdp":`...)
	if b, err = appendStringOrNull(b, f.SDP); err != nil {
		return "", err
	}
	b = append(b, `,"candidate":`...)
	if b, err = appendStringOrNull(b, f.Candidate); err != nil {
		return "", err
	}
	b = append(b, `,"sdpMid":`...)
	if b, err = appendStringOrNull(b, f.SDPMid); err != nil {
		return "", err
	}
	b = append(b, `,"sdpMLineIndex":`...)
	if f.SDPMLineIndex == nil {
		b = append(b, "null"...)
	} else {
		v := *f.SDPMLineIndex
		if v > MaxSafeInteger || v < -MaxSafeInteger {
			return "", ErrInvalidSignal
		}
		b = strconv.AppendInt(b, v, 10)
	}
	b = append(b, `,"usernameFragment":`...)
	if b, err = appendStringOrNull(b, f.UsernameFragment); err != nil {
		return "", err
	}
	return string(append(b, '}')), nil
}

func appendStringOrNull(b []byte, s *string) ([]byte, error) {
	if s == nil {
		return append(b, "null"...), nil
	}
	if !utf8.ValidString(*s) {
		return nil, ErrInvalidUTF8
	}
	return appendJSString(b, *s), nil
}

// AuthFieldsOf reads the covered fields out of a received signal, as the Web
// does field by field: an absent or null `sdp`/`ice`, or an absent or null
// field inside one, is null. A present value of the wrong JSON type, or an
// sdpMLineIndex that is not a safe integer, is an error, so a verifier refuses
// the signal instead of rendering something the signer never meant.
func AuthFieldsOf(s Signal) (AuthFields, error) {
	var f AuthFields
	sdp, err := optionalObject(s.fields["sdp"])
	if err != nil {
		return f, err
	}
	ice, err := optionalObject(s.fields["ice"])
	if err != nil {
		return f, err
	}
	for _, x := range []struct {
		obj map[string]json.RawMessage
		key string
		dst **string
	}{
		{sdp, "type", &f.SDPType},
		{sdp, "sdp", &f.SDP},
		{ice, "candidate", &f.Candidate},
		{ice, "sdpMid", &f.SDPMid},
		{ice, "usernameFragment", &f.UsernameFragment},
	} {
		v, present := x.obj[x.key]
		if !present || jsonIsNull(v) {
			continue
		}
		str, ok := jsonString(v)
		if !ok {
			return AuthFields{}, ErrInvalidSignal
		}
		*x.dst = &str
	}
	if v, present := ice["sdpMLineIndex"]; present && !jsonIsNull(v) {
		n, ok := jsonNumber(v)
		if !ok || n > MaxSafeInteger || n < -MaxSafeInteger || n != math.Trunc(n) {
			return AuthFields{}, ErrInvalidSignal
		}
		i := int64(n) // -0 becomes 0, as JavaScript renders it
		f.SDPMLineIndex = &i
	}
	return f, nil
}

// optionalObject reads a value that must be absent, null or an object.
func optionalObject(v json.RawMessage) (map[string]json.RawMessage, error) {
	if v == nil || jsonIsNull(v) {
		return nil, nil
	}
	obj, ok, err := jsonObject(v)
	if err != nil || !ok {
		return nil, ErrInvalidSignal
	}
	return obj, nil
}

// LinkRole is the deterministic establishment role (link §3): the smaller id
// initiates. Go string comparison is bytewise, which agrees with UTF-16
// code-unit order for the ASCII ids the hub issues. A self-collision resolves
// to Responder rather than trapping.
func LinkRole(selfID, peerID string) linkcrypto.Role {
	if selfID < peerID {
		return linkcrypto.Initiator
	}
	return linkcrypto.Responder
}

// The only signals this package builds. None carries a top-level `kind`: every
// client reads that key as the CLI's discriminator.

// RequestSignal is {"link":true,"linkRequest":true}.
func RequestSignal() []byte { return []byte(`{"link":true,"linkRequest":true}`) }

// BusySignal is {"link":true,"busy":true}.
func BusySignal() []byte { return []byte(`{"link":true,"busy":true}`) }

// LeaveSignal is {"link":true,"leave":true,"auth":<tag>}. The tag must be a
// LinkAuthTagLength-character ASCII string, as SignLeave produces.
func LeaveSignal(auth string) ([]byte, error) {
	if len(auth) != LinkAuthTagLength || utf16Len(auth) != LinkAuthTagLength {
		return nil, ErrInvalidSignal
	}
	b := []byte(`{"link":true,"leave":true,"auth":`)
	b = appendJSString(b, auth)
	return append(b, '}'), nil
}

// ParseHello reads a roster hello (link §1.4). ok is false — "not a hello",
// leaving any earlier announcement standing — for a non-object, an array, a
// missing `caps`, or a `caps` that is not an array. Inside an array, non-string
// entries are dropped and strings are kept in order. The result is a snapshot,
// never an additive grant.
func ParseHello(s Signal) ([]string, bool) {
	if !s.isObject {
		return nil, false
	}
	entries, ok := jsonArray(s.fields["caps"])
	if !ok {
		return nil, false
	}
	caps := make([]string, 0, len(entries))
	for _, e := range entries {
		if c, ok := jsonString(e); ok {
			caps = append(caps, c)
		}
	}
	return caps, true
}

// CapsIncludeLink reports whether an announcement names exactly `link/1`.
// `link/2`, `LINK/1` and every other string are different protocols.
func CapsIncludeLink(caps []string) bool {
	return slices.Contains(caps, Capability)
}

// PeerCaps records what each peer last announced. It holds announcements only:
// the hello cadence, retirement and room-scope decisions are the lane layer's.
// The zero value is an empty registry. Not safe for concurrent use.
type PeerCaps struct {
	announced map[string][]string
}

// NewPeerCaps returns an empty registry.
func NewPeerCaps() *PeerCaps { return &PeerCaps{announced: map[string][]string{}} }

// Record applies a hello from peer as a snapshot and reports whether s was a
// hello at all. A frame that is not a hello leaves the earlier state standing.
func (p *PeerCaps) Record(peer string, s Signal) bool {
	caps, ok := ParseHello(s)
	if !ok {
		return false
	}
	if p.announced == nil {
		p.announced = map[string][]string{}
	}
	p.announced[peer] = caps
	return true
}

// RecordProvenLink lets a link-generation frame stand in for a hello that
// never arrived — ONLY for a peer that has said nothing (link §1.5). It never
// overrules a stated announcement, including an empty one.
func (p *PeerCaps) RecordProvenLink(peer string, s Signal) bool {
	if SignalGeneration(s) != GenerationLink {
		return false
	}
	if _, stated := p.announced[peer]; stated {
		return false
	}
	if p.announced == nil {
		p.announced = map[string][]string{}
	}
	p.announced[peer] = []string{Capability}
	return true
}

// Announced returns a copy of peer's last announcement.
func (p *PeerCaps) Announced(peer string) ([]string, bool) {
	caps, ok := p.announced[peer]
	return slices.Clone(caps), ok
}

// SupportsLink reports whether peer's last announcement names `link/1`.
func (p *PeerCaps) SupportsLink(peer string) bool {
	return CapsIncludeLink(p.announced[peer])
}

// Forget drops peer, which left the roster.
func (p *PeerCaps) Forget(peer string) { delete(p.announced, peer) }
