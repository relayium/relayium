package inboxsend

import (
	"sort"
	"strings"

	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxclient"
	"github.com/relayium/relayium/internal/termtext"
)

// Send availability: a Go port of Web `sendAvailability`
// (web/src/lib/device-inbox.ts). Same blocks, same order, same caveats, so a
// device the Web will not offer is one the CLI will not send to, and for the
// same first reason.
//
// There is deliberately NO "self" block. Central authorises by account, and a
// currently enrolled device that is explicitly named receives from itself like
// any other (the real receiver saves it). A picker may hide the current device
// by default; the CLI never offers, it only accepts an explicit --to.

// Blocks, first match wins.
const (
	BlockUnusableID            = "unusable_id"
	BlockNotEnrolled           = "not_enrolled"
	BlockRevoked               = "revoked"
	BlockCannotReceive         = "cannot_receive"
	BlockUnsupportedCapability = "unsupported_capability"
	BlockUnsupportedKey        = "unsupported_key"
	BlockUnknownPolicy         = "unknown_policy"
	BlockReceiveOff            = "receive_off"
)

// Caveats: sendable, but not unattended or not immediate.
const (
	CaveatNeedsApproval     = "needs_approval"
	CaveatDirectoryNotReady = "directory_not_ready"
	CaveatQueuedUntilOnline = "queued_until_online"
)

// Availability is the verdict for one device row.
type Availability struct {
	Sendable bool
	Block    string
	Caveats  []string
	Online   bool
	Policy   string
}

// Evaluate computes the verdict for a device row.
func Evaluate(d inboxclient.Device) Availability {
	in := d.Inbox
	a := Availability{Caveats: []string{}}
	if in != nil {
		a.Online = in.Presence == inbox.PresenceOnline
		switch in.AutoAccept {
		case inbox.AutoAcceptOff, inbox.AutoAcceptAsk, inbox.AutoAcceptAuto:
			a.Policy = in.AutoAccept
		}
	}
	no := func(block string) Availability { a.Block = block; return a }

	if !isInertID(d.ID) {
		return no(BlockUnusableID)
	}
	if in == nil || in.RegisteredAt == 0 {
		return no(BlockNotEnrolled)
	}
	if in.Revoked {
		return no(BlockRevoked)
	}
	if !in.CanReceive {
		return no(BlockCannotReceive)
	}
	if in.ReceiveCapability != inbox.CapReceiveV3 {
		return no(BlockUnsupportedCapability)
	}
	k := in.Key
	if k == nil || k.RevokedAt != 0 || k.SupersededAt != 0 || k.Algorithm != inbox.KeyAlgX25519SealedBoxV1 ||
		!isInertID(k.ID) || k.Generation <= 0 {
		return no(BlockUnsupportedKey)
	}
	// Byte-level check (canonical base64url, 32 bytes, not a low-order point):
	// a key no sealed box may be addressed to is refused here, before any work.
	if _, err := inbox.ValidatePublicKey(k.Algorithm, k.PublicKey); err != nil {
		return no(BlockUnsupportedKey)
	}
	if a.Policy == "" {
		return no(BlockUnknownPolicy)
	}
	if a.Policy == inbox.AutoAcceptOff {
		return no(BlockReceiveOff)
	}
	a.Sendable = true
	if a.Policy == inbox.AutoAcceptAsk {
		a.Caveats = append(a.Caveats, CaveatNeedsApproval)
	}
	if a.Policy == inbox.AutoAcceptAuto && !in.ReceiveDirReady {
		a.Caveats = append(a.Caveats, CaveatDirectoryNotReady)
	}
	if !a.Online {
		a.Caveats = append(a.Caveats, CaveatQueuedUntilOnline)
	}
	return a
}

// blockSentence is the human reason for a block.
func blockSentence(block string) string {
	switch block {
	case BlockUnusableID:
		return "the server reported an id this client will not use"
	case BlockNotEnrolled:
		return "it has not turned on Device Inbox receiving"
	case BlockRevoked:
		return "its Device Inbox was revoked"
	case BlockCannotReceive:
		return "the server says it cannot receive deliveries right now"
	case BlockUnsupportedCapability:
		return "it runs a receiver version this sender does not support"
	case BlockUnsupportedKey:
		return "it has no usable receiving key"
	case BlockUnknownPolicy:
		return "its receive policy is not one this client understands"
	case BlockReceiveOff:
		return "automatic receive is turned off on it"
	}
	return "it cannot receive deliveries"
}

// CaveatSentence is the human note for a caveat.
func CaveatSentence(c string) string {
	switch c {
	case CaveatNeedsApproval:
		return "someone at that device must accept the delivery before it is saved"
	case CaveatDirectoryNotReady:
		return "its receive folder is not ready, so the delivery will wait for attention there"
	case CaveatQueuedUntilOnline:
		return "it is offline; the delivery waits until it comes online"
	}
	return c
}

// resolveTarget finds the device --to names: an exact device ID first; else an
// exact, case-sensitive display name that is unique in the account. Anything
// else is a ClassLocal refusal before any network write.
func resolveTarget(devices []inboxclient.Device, to string) (inboxclient.Device, error) {
	if to == "" {
		return inboxclient.Device{}, local(CodeNoSuchTarget, "name the receiving device with --to <device id or name>")
	}
	for _, d := range devices {
		if d.ID == to {
			return d, nil
		}
	}
	var matches []inboxclient.Device
	for _, d := range devices {
		if d.Name == to {
			matches = append(matches, d)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		return inboxclient.Device{}, localf(CodeNoSuchTarget,
			"no device in this account has the id or name %q (run `relayium inbox devices`)", termtext.Safe(to))
	}
	ids := make([]string, len(matches))
	for i, d := range matches {
		ids[i] = termtext.Safe(d.ID)
	}
	sort.Strings(ids)
	return inboxclient.Device{}, localf(CodeAmbiguousTarget,
		"%d devices are named %q; use the device id instead: %s", len(matches), termtext.Safe(to), strings.Join(ids, ", "))
}

// currentDevice is the one row the bearer authenticates as.
func currentDevice(devices []inboxclient.Device) (inboxclient.Device, bool) {
	for _, d := range devices {
		if d.Current {
			return d, true
		}
	}
	return inboxclient.Device{}, false
}
