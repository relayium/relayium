// Package inbox holds the Device Inbox protocol vocabulary shared by central
// and every client: protocol versioning, capability negotiation, device
// end-to-end public-key validation, and presence.
//
// PRE-IMPLEMENTATION INVARIANTS (Phase 1A). Each is asserted by a test in
// inbox_test.go or account/deviceinbox_test.go; changing one of them is a
// protocol change, not a refactor.
//
//  1. ZERO KNOWLEDGE. Central's only crypto role in Device Inbox is validating
//     and storing PUBLIC keys. This package therefore has no private-key type,
//     no decrypt/unwrap function and no content-key handling. A device's
//     private key and a task's content key exist only on the device and on the
//     sender; neither has a representation here.
//  2. FAIL CLOSED ON VERSION. A device whose protocol version or receive
//     capability central does not understand is refused at registration and
//     stays non-receiving. An unrecognised version never degrades to a default.
//  3. FAIL CLOSED ON KEY MATERIAL. A public key that is the wrong length, not
//     canonical base64url, or a low-order Curve25519 point (which would make
//     every wrapped content key recoverable) is rejected before storage.
//  4. PRESENCE EXPIRES. Presence is derived from an expiry timestamp at read
//     time, never from a stored boolean. A device that stops heartbeating goes
//     offline on its own; nothing has to remember to switch it off.
package inbox

import (
	"crypto/ecdh"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"slices"
	"sort"
	"strings"
	"time"
)

// Protocol versions central speaks. A client announces the set it supports and
// central picks the highest common one (NegotiateProtocolVersion), so a rolling
// fleet of mixed client versions converges explicitly instead of each side
// assuming the other's shape.
const (
	// ProtocolV1 is the HISTORICAL first Device Inbox protocol
	// (docs/protocol/relayium-device-inbox-v1.md): file deliveries only, with
	// the shared Stored-Wire manifest describing them.
	//
	// Named, but not supported. The owner waived old-client and old-protocol
	// compatibility on 2026-08-17 (no external users, the release forces an
	// update), so v2 replaces v1 outright rather than shipping a dual stack.
	// Keeping the constant is what lets the refusal be asserted by name: a
	// build announcing only v1 must be told to upgrade, not quietly accepted.
	ProtocolV1 = 1

	// ProtocolV2 is the Device Inbox protocol this build speaks
	// (docs/protocol/relayium-device-inbox-v2.md). Its one substantive change
	// over v1 is that a delivery now declares its CONTENT KIND — file or text —
	// and it does so only inside the authenticated encrypted manifest, so
	// central still cannot tell a message from a file.
	ProtocolV2 = 2

	MinProtocolVersion = ProtocolV2
	MaxProtocolVersion = ProtocolV2
)

// Capability tokens are versioned by construction ("<name>.v<N>"): a behaviour
// change ships as a new token rather than as a silent redefinition of an old
// one, so an old client and a new central never disagree about what a token
// means. See ValidateCapabilities for the accepted syntax.
const (
	// CapReceiveV1 is the HISTORICAL receive capability. Named so it can be
	// refused by name (see ProtocolV1): a device announcing only v1 cannot
	// decode a v2 manifest, so listing it as a send target would promise a
	// delivery it would fail on.
	CapReceiveV1 = "inbox.receive.v1"
	// CapReceiveV2 is the REQUIRED capability for a receiving device: it says
	// the device can claim a queued task, unwrap its content key with its own
	// private key, decode the v2 encrypted manifest, verify, and commit
	// atomically. Registration without a supported receive capability is
	// refused (invariant 2).
	CapReceiveV2 = "inbox.receive.v2"
	// CapTextV1 says this receiver presents a text delivery AS TEXT — it
	// commits the message to its protected message store and shows it, rather
	// than writing a file into the user's receive folder.
	//
	// Central neither requires nor interprets it: content kind lives only
	// inside the encrypted manifest, so central could not check the claim even
	// if it wanted to. The token exists for the SENDER, which reads it off the
	// device list to decide whether offering "send text" to that target would
	// be honest. A receiver that stores text as a `.txt` file must not announce
	// it — the whole value of the token is that its absence is truthful.
	CapTextV1 = "inbox.text.v1"
	// CapAutoAcceptV1 says the device implements the same-account automatic
	// receive policy (PRD §8) — an explicitly enabled, default-off, per-device
	// setting. Its ABSENCE is meaningful: such a device may only be sent to
	// under the "ask" policy.
	CapAutoAcceptV1 = "inbox.autoaccept.v1"
	// CapResumeV1 says the device resumes an interrupted ciphertext download
	// from a complete frame boundary instead of restarting it.
	CapResumeV1 = "inbox.resume.v1"
)

// supportedReceiveCapabilities scopes the ONE capability family that gates
// registration. Everything else a device announces is carried verbatim for the
// sender to interpret; the receive capability is central's business because a
// device that cannot receive must not appear in a send target list at all.
//
// supportedReceiveCapabilities is the set of receive capabilities central can
// negotiate, highest preference first. Kept as an explicit list rather than
// derived from a version number: adding a version must be a deliberate edit
// that forces a look at what existing senders will do with such a device.
//
// v1 is deliberately absent, not merely lower-preference. It is not a downgrade
// path central may fall back to — a v1 device cannot read a v2 manifest at all.
var supportedReceiveCapabilities = []string{CapReceiveV2}

// SupportedReceiveCapabilities is the negotiable receive set, for the API layer
// to echo on a refusal. Exported (and cloned) so no caller has to restate the
// list — a hand-written `[]string{CapReceiveV1}` in an error body is exactly how
// a rejection ends up telling a client to implement the version central just
// stopped supporting.
func SupportedReceiveCapabilities() []string {
	return slices.Clone(supportedReceiveCapabilities)
}

// KeyAlgX25519SealedBoxV1 wraps a task's 32-byte content key to a device with
// libsodium's crypto_box_seal (X25519 + XSalsa20-Poly1305, ephemeral sender
// key). PublicKey is the raw 32-byte X25519 public key, base64url (unpadded) —
// the same encoding storecrypto uses for the `#k=` content key, so clients have
// one encoding rule to implement.
//
// Chosen because every surface already has it: the web bundles
// libsodium-wrappers, RelayiumKit/Swift and the Go CLI can both reach the same
// primitive, and it needs no sender identity — the queue's authorisation is the
// account, not a sender key.
const KeyAlgX25519SealedBoxV1 = "x25519-sealedbox-v1"

// X25519PublicKeyBytes is the raw (decoded) length of every algorithm this
// package accepts today.
const X25519PublicKeyBytes = 32

// Automatic-receive policy (PRD §8). Default-off is a product invariant, not a
// preference: a device must never write to disk on someone else's say-so until
// its owner has chosen a directory and accepted the risk.
const (
	AutoAcceptOff  = "off"
	AutoAcceptAsk  = "ask"
	AutoAcceptAuto = "auto"
)

// Presence states. There are exactly two, and neither is "unknown": a device
// central has not heard from is offline, which is the truthful thing to tell a
// sender deciding whether their file lands now or waits in the queue.
const (
	PresenceOnline  = "online"
	PresenceOffline = "offline"
)

const (
	// HeartbeatInterval is what central tells a device to use. PresenceTTL is
	// deliberately a multiple of it: a device that misses two consecutive
	// heartbeats (a GC pause, a blip) is not yet declared offline, but one that
	// has genuinely stopped is, without central needing a sweeper.
	HeartbeatInterval = 30 * time.Second
	PresenceTTL       = 90 * time.Second
)

// Bounds on what a device may announce. A device is a semi-trusted party (it
// holds a bearer for the account), so its self-description is bounded before
// storage: 32 tokens of 64 bytes is far more than any real client needs and
// caps what one row can cost.
const (
	MaxCapabilities     = 32
	MaxCapabilityLen    = 64
	MaxPlatformLen      = 32
	MaxAppVersionLen    = 64
	MaxProtocolVersions = 16
)

var (
	// ErrUnsupportedProtocol means the intersection of what the client speaks
	// and what central speaks is empty. Fail closed: nothing is stored.
	ErrUnsupportedProtocol = errors.New("inbox: no mutually supported protocol version")
	// ErrUnsupportedCapability means the client announced no receive
	// capability central understands (or none at all).
	ErrUnsupportedCapability = errors.New("inbox: no mutually supported receive capability")
	// ErrUnsupportedAutoAcceptCapability means the device requested automatic
	// receive without announcing the versioned behavior that makes that policy
	// meaningful. Storing the combination would let a later queue mistake a
	// string value for proof that the client implements the safety contract.
	ErrUnsupportedAutoAcceptCapability = errors.New("inbox: automatic receive capability not announced")
	ErrTooManyCapabilities             = errors.New("inbox: too many capabilities")
	ErrMalformedCapability             = errors.New("inbox: malformed capability token")
	ErrUnknownKeyAlgorithm             = errors.New("inbox: unknown device key algorithm")
	ErrMalformedPublicKey              = errors.New("inbox: malformed device public key")
	// ErrUnusablePublicKey is a syntactically valid key that must never be used:
	// a low-order Curve25519 point drives every X25519 exchange to the all-zero
	// shared secret, so a content key "wrapped" to it is wrapped to a value the
	// whole world can compute.
	ErrUnusablePublicKey  = errors.New("inbox: unusable device public key")
	ErrInvalidAutoAccept  = errors.New("inbox: invalid auto-accept policy")
	ErrInvalidPlatform    = errors.New("inbox: invalid platform")
	ErrInvalidAppVersion  = errors.New("inbox: invalid app version")
	ErrTooManyProtocolVer = errors.New("inbox: too many protocol versions")
)

// SupportedProtocolVersions lists what central speaks, ascending. Returned to
// a client that fails negotiation so it can report an actionable "upgrade" or
// "central is older than you" instead of a bare rejection.
func SupportedProtocolVersions() []int {
	out := make([]int, 0, MaxProtocolVersion-MinProtocolVersion+1)
	for v := MinProtocolVersion; v <= MaxProtocolVersion; v++ {
		out = append(out, v)
	}
	return out
}

// NegotiateProtocolVersion picks the HIGHEST version both sides speak.
// Highest-common rather than lowest-common so a fleet upgrades as its clients
// do; an empty intersection is an error, never a fallback to MinProtocolVersion
// (invariant 2 — a client that did not claim v1 must not be treated as v1).
func NegotiateProtocolVersion(client []int) (int, error) {
	if len(client) == 0 {
		return 0, ErrUnsupportedProtocol
	}
	if len(client) > MaxProtocolVersions {
		return 0, ErrTooManyProtocolVer
	}
	best := 0
	for _, v := range client {
		if v < MinProtocolVersion || v > MaxProtocolVersion {
			continue
		}
		if v > best {
			best = v
		}
	}
	if best == 0 {
		return 0, ErrUnsupportedProtocol
	}
	return best, nil
}

// NegotiateReceiveCapability returns the receive capability both sides support.
// A device announcing only a receive version central does not implement (say
// inbox.receive.v2) is refused: central cannot honestly list it as a send
// target when it does not know what claiming a task means for that device.
func NegotiateReceiveCapability(caps []string) (string, error) {
	for _, supported := range supportedReceiveCapabilities {
		if slices.Contains(caps, supported) {
			return supported, nil
		}
	}
	return "", ErrUnsupportedCapability
}

// ValidateCapabilities checks the announced set and returns it deduplicated and
// sorted, which is the canonical stored form (so a re-registration that merely
// reorders the list is a no-op diff).
//
// Syntactically valid but UNKNOWN tokens are kept on purpose. Central is a
// relay for this field, not its semantic authority: dropping a token a newer
// client announced would silently hide a capability from a newer sender that
// does understand it. What is not negotiable is the receive family (see
// NegotiateReceiveCapability) and the bounds above.
func ValidateCapabilities(caps []string) ([]string, error) {
	if len(caps) > MaxCapabilities {
		return nil, ErrTooManyCapabilities
	}
	seen := make(map[string]struct{}, len(caps))
	out := make([]string, 0, len(caps))
	for _, c := range caps {
		if !validCapabilityToken(c) {
			return nil, ErrMalformedCapability
		}
		if _, dup := seen[c]; dup {
			continue
		}
		seen[c] = struct{}{}
		out = append(out, c)
	}
	sort.Strings(out)
	return out, nil
}

// validCapabilityToken accepts "<segment>(.<segment>)*.v<N>": lowercase
// alphanumeric segments, an explicit trailing version, no leading zeros. The
// version suffix is mandatory so that no unversioned token can ever exist to be
// redefined later.
func validCapabilityToken(c string) bool {
	if c == "" || len(c) > MaxCapabilityLen {
		return false
	}
	segs := strings.Split(c, ".")
	if len(segs) < 2 {
		return false
	}
	for _, s := range segs[:len(segs)-1] {
		if s == "" {
			return false
		}
		for i := 0; i < len(s); i++ {
			b := s[i]
			if (b < 'a' || b > 'z') && (b < '0' || b > '9') {
				return false
			}
		}
	}
	ver := segs[len(segs)-1]
	if len(ver) < 2 || ver[0] != 'v' {
		return false
	}
	digits := ver[1:]
	if digits[0] == '0' { // v0 and v01 are both rejected: one canonical spelling
		return false
	}
	for i := 0; i < len(digits); i++ {
		if digits[i] < '0' || digits[i] > '9' {
			return false
		}
	}
	return true
}

// lowOrderProbe is a fixed X25519 scalar used only to detect low-order points.
// Any clamped scalar works — a low-order point drives the exchange to zero
// regardless — so a FIXED one is used to keep validation deterministic and
// independent of the random source. Derived from a domain string rather than
// written as a magic literal.
var lowOrderProbe = sha256.Sum256([]byte("relayium-device-inbox-loworder-probe-v1"))

// ValidatePublicKey decodes and checks a device's announced public key,
// returning the raw bytes. It rejects, in order: an unknown algorithm, a
// non-canonical base64url encoding, the wrong length, and a low-order point.
//
// The last check is the one that matters for the zero-knowledge promise: Go's
// X25519 ECDH errors on an all-zero shared secret, which is exactly the set of
// points for which "wrapped to this device" would mean "wrapped to nobody".
// Rejecting at REGISTRATION means no sender ever wraps a content key to one.
func ValidatePublicKey(algorithm, encoded string) ([]byte, error) {
	if algorithm != KeyAlgX25519SealedBoxV1 {
		return nil, ErrUnknownKeyAlgorithm
	}
	// RawURLEncoding (no padding) is strict: it rejects padding, whitespace and
	// non-canonical trailing bits, so one key has exactly one spelling and the
	// "have I seen this key before?" comparisons below can be plain string
	// equality.
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return nil, ErrMalformedPublicKey
	}
	if len(raw) != X25519PublicKeyBytes {
		return nil, ErrMalformedPublicKey
	}
	pub, err := ecdh.X25519().NewPublicKey(raw)
	if err != nil {
		return nil, ErrMalformedPublicKey
	}
	probe, err := ecdh.X25519().NewPrivateKey(lowOrderProbe[:])
	if err != nil {
		return nil, ErrUnusablePublicKey
	}
	if _, err := probe.ECDH(pub); err != nil {
		return nil, ErrUnusablePublicKey
	}
	return raw, nil
}

// EncodePublicKey is the inverse spelling rule, exposed so tests and clients in
// this repo cannot drift from ValidatePublicKey's expectation.
func EncodePublicKey(raw []byte) string {
	return base64.RawURLEncoding.EncodeToString(raw)
}

// ValidateAutoAccept checks a policy value. An empty string means "unspecified"
// and resolves to AutoAcceptOff — the default-off invariant is enforced here so
// no caller can arrive at "auto" by omission.
func ValidateAutoAccept(p string) (string, error) {
	switch p {
	case "":
		return AutoAcceptOff, nil
	case AutoAcceptOff, AutoAcceptAsk, AutoAcceptAuto:
		return p, nil
	default:
		return "", ErrInvalidAutoAccept
	}
}

// ValidateAutoAcceptCapability rejects the contradictory combination of the
// automatic policy with no matching versioned capability. off and ask remain
// valid for older clients; only unattended writes require the explicit token.
func ValidateAutoAcceptCapability(policy string, caps []string) error {
	if policy == AutoAcceptAuto && !slices.Contains(caps, CapAutoAcceptV1) {
		return ErrUnsupportedAutoAcceptCapability
	}
	return nil
}

// ValidatePlatform bounds the free-text platform label ("darwin", "linux",
// "ios", …). It is display/diagnostic metadata, so the rule is a length and
// charset bound rather than an allowlist central would have to keep current.
func ValidatePlatform(p string) (string, error) {
	if len(p) > MaxPlatformLen || !printableASCII(p) {
		return "", ErrInvalidPlatform
	}
	return p, nil
}

// ValidateAppVersion bounds the client's self-reported software version, with
// the same reasoning as ValidatePlatform.
func ValidateAppVersion(v string) (string, error) {
	if len(v) > MaxAppVersionLen || !printableASCII(v) {
		return "", ErrInvalidAppVersion
	}
	return v, nil
}

func printableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// PresenceExpiry is when a heartbeat received at `now` stops meaning "online".
func PresenceExpiry(now time.Time) int64 {
	return now.Add(PresenceTTL).Unix()
}

// Presence derives the state a sender is shown. It is a pure function of the
// stored expiry and the current time (invariant 4): there is no stored "online"
// flag that could survive a crashed device, a killed process, or a central
// restart, and no sweeper whose failure would leave a dead device advertised as
// available.
//
// `revoked` short-circuits to offline: a device whose active key was revoked
// cannot be sent to at all, so reporting a live heartbeat for it would be a
// true fact that tells a lie.
func Presence(presenceExpiresAt, now int64, revoked bool) string {
	if revoked || presenceExpiresAt <= 0 || now >= presenceExpiresAt {
		return PresenceOffline
	}
	return PresenceOnline
}
