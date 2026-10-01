// Package wire is the contract between relayium-coturn-bridge (on the coturn
// host) and central's dedicated coturn metering ingest. Both sides import it,
// so the canonical encoding a snapshot's hash covers has one definition.
//
// A Snapshot is immutable once created: the bridge never reuses a sequence
// number with different content, and central refuses a second, different
// snapshot under a sequence number it has already seen. The hash binds every
// field, so an ACK that names (seq, hash) names exactly one snapshot.
package wire

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

// Version is the only snapshot version this contract defines.
const Version = 1

// Path is central's ingest route. It is deliberately not under /api/nodes/:
// the coturn bridge is a metering-only identity, not a fleet node.
const Path = "/api/coturn-metering/v1/snapshots"

// MaxSnapshotsPerRequest bounds one POST. The bridge pages fairly across
// allocations; central refuses a larger batch outright.
const MaxSnapshotsPerRequest = 64

// MaxRequestBytes bounds one POST body.
const MaxRequestBytes = 1 << 20

// MaxCumulative bounds any byte counter on the wire. It is far above any real
// allocation and keeps every value representable in SQLite's signed INTEGER.
const MaxCumulative = uint64(1) << 62

// Snapshot states.
const (
	// StateLive: the allocation was live when the snapshot was taken.
	StateLive = "live"
	// StateFinal: coturn's total_traffic for the allocation was observed.
	StateFinal = "final"
	// StateEndedUnfinalized: the allocation ended (deleted status observed, or
	// it vanished from a complete psd listing of the same provider epoch)
	// without a final total; the cumulative is a lower bound.
	StateEndedUnfinalized = "ended_unfinalized"
	// StateEpochEnded: the provider process that owned the allocation is gone
	// (restart/crash) and no final was observed; the cumulative is a lower
	// bound.
	StateEpochEnded = "epoch_ended"
)

// Terminal reports whether no later snapshot can follow a snapshot in state.
func Terminal(state string) bool {
	switch state {
	case StateFinal, StateEndedUnfinalized, StateEpochEnded:
		return true
	}
	return false
}

// Snapshot is one immutable report of an allocation's cumulative client-side
// relay bytes (coturn rcvb + sentb).
//
// Cumulative is max(StreamSum, LiveSnapshot, Final): three independent lower
// bounds (Final is exact when FinalSeen). They are never added to each other.
type Snapshot struct {
	Version int    `json:"version"`
	RelayID string `json:"relayId"`
	// Provider epoch: the machine boot and the exact coturn process.
	BootID     string `json:"bootId"`
	PID        int    `json:"pid"`
	StartTicks uint64 `json:"startTicks"`
	// coturn's raw session id (%018llu) and the first username seen for it.
	SessionID string `json:"sessionId"`
	Username  string `json:"username"`

	Seq          uint64 `json:"seq"`
	Cumulative   uint64 `json:"cumulative"`
	StreamSum    uint64 `json:"streamSum"`
	LiveSnapshot uint64 `json:"liveSnapshot"`
	Final        uint64 `json:"final"`
	FinalSeen    bool   `json:"finalSeen"`
	State        string `json:"state"`
	// StreamGaps counts subscription gaps (reconnects, quarantined segments)
	// during the key's life: with any gap, StreamSum is a lower bound.
	StreamGaps uint32 `json:"streamGaps"`
	// Bridge wall-clock times. Not provider event times (coturn publishes
	// none); FirstObservedUnix gates shadow→billable activation only.
	FirstObservedUnix int64 `json:"firstObservedUnix"`
	CreatedUnix       int64 `json:"createdUnix"`

	Hash string `json:"hash"`
}

// Key identifies the allocation a snapshot describes, relay-independent (the
// relay id comes from authentication).
func (s *Snapshot) Key() string {
	return s.BootID + "/" + strconv.Itoa(s.PID) + "/" + strconv.FormatUint(s.StartTicks, 10) + "/" + s.SessionID
}

var (
	reRelayID   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	reBootID    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$`)
	reSessionID = regexp.MustCompile(`^[0-9]{18}$`)
	// TURN REST username as central issues it: "<expiry>:<owner>.<tag>".
	reUsername = regexp.MustCompile(`^[0-9]{1,20}:[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{1,128}$`)
	reHash     = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// ValidUsername reports whether u has the exact shape central issues.
func ValidUsername(u string) bool { return reUsername.MatchString(u) }

// ValidSessionID reports whether id is coturn's %018llu session id.
func ValidSessionID(id string) bool { return reSessionID.MatchString(id) }

// ValidRelayID reports whether id is an acceptable relay identity name.
func ValidRelayID(id string) bool { return reRelayID.MatchString(id) }

// ValidBootID reports whether id is an acceptable boot identifier.
func ValidBootID(id string) bool { return reBootID.MatchString(id) }

// Canonical returns the exact bytes Hash covers: every field except Hash, in
// a fixed order, one "name=value" per line. Validate rejects any string field
// that could contain a separator, so the encoding is unambiguous.
func (s *Snapshot) Canonical() []byte {
	var b strings.Builder
	b.WriteString("relayium-coturn-snapshot-v1\n")
	field := func(k, v string) { b.WriteString(k); b.WriteByte('='); b.WriteString(v); b.WriteByte('\n') }
	field("version", strconv.Itoa(s.Version))
	field("relayId", s.RelayID)
	field("bootId", s.BootID)
	field("pid", strconv.Itoa(s.PID))
	field("startTicks", strconv.FormatUint(s.StartTicks, 10))
	field("sessionId", s.SessionID)
	field("username", s.Username)
	field("seq", strconv.FormatUint(s.Seq, 10))
	field("cumulative", strconv.FormatUint(s.Cumulative, 10))
	field("streamSum", strconv.FormatUint(s.StreamSum, 10))
	field("liveSnapshot", strconv.FormatUint(s.LiveSnapshot, 10))
	field("final", strconv.FormatUint(s.Final, 10))
	field("finalSeen", strconv.FormatBool(s.FinalSeen))
	field("state", s.State)
	field("streamGaps", strconv.FormatUint(uint64(s.StreamGaps), 10))
	field("firstObservedUnix", strconv.FormatInt(s.FirstObservedUnix, 10))
	field("createdUnix", strconv.FormatInt(s.CreatedUnix, 10))
	return []byte(b.String())
}

// ComputeHash returns the hex SHA-256 of Canonical.
func (s *Snapshot) ComputeHash() string {
	sum := sha256.Sum256(s.Canonical())
	return hex.EncodeToString(sum[:])
}

// Seal sets Cumulative from the components and Hash from the content.
func (s *Snapshot) Seal() {
	s.Cumulative = max(s.StreamSum, s.LiveSnapshot, s.Final)
	s.Hash = s.ComputeHash()
}

// Validate checks every invariant a receiver relies on, including that Hash
// is the hash of the content.
func (s *Snapshot) Validate() error {
	switch {
	case s.Version != Version:
		return fmt.Errorf("version %d", s.Version)
	case !reRelayID.MatchString(s.RelayID):
		return errors.New("relayId")
	case !reBootID.MatchString(s.BootID):
		return errors.New("bootId")
	case s.PID <= 0:
		return errors.New("pid")
	case s.StartTicks == 0 || s.StartTicks > MaxCumulative:
		return errors.New("startTicks")
	case !reSessionID.MatchString(s.SessionID):
		return errors.New("sessionId")
	case !reUsername.MatchString(s.Username):
		return errors.New("username")
	case s.Seq == 0 || s.Seq > MaxCumulative:
		return errors.New("seq")
	case s.StreamSum > MaxCumulative || s.LiveSnapshot > MaxCumulative || s.Final > MaxCumulative:
		return errors.New("counter out of range")
	case s.Cumulative != max(s.StreamSum, s.LiveSnapshot, s.Final):
		return errors.New("cumulative is not max(streamSum, liveSnapshot, final)")
	case !s.FinalSeen && s.Final != 0:
		return errors.New("final without finalSeen")
	case s.State != StateLive && !Terminal(s.State):
		return fmt.Errorf("state %q", s.State)
	case (s.State == StateFinal) != s.FinalSeen:
		return errors.New("state/finalSeen mismatch")
	case s.FirstObservedUnix <= 0 || s.CreatedUnix < s.FirstObservedUnix:
		return errors.New("bridge times")
	case !reHash.MatchString(s.Hash):
		return errors.New("hash format")
	case s.Hash != s.ComputeHash():
		return errors.New("hash does not match content")
	}
	return nil
}

// Request is one POST body.
type Request struct {
	RelayID   string     `json:"relayId"`
	Snapshots []Snapshot `json:"snapshots"`
}

// ACK statuses.
const (
	// AckAccepted: applied (seq ≥ the last seen); Accepted is the ledger's
	// cumulative for the allocation after this snapshot.
	AckAccepted = "accepted"
	// AckStale: an older seq than one already applied; nothing written.
	AckStale = "stale"
	// AckConflict: permanently refused (same seq with another hash, a
	// non-monotone cumulative, a username that differs from the binding, a
	// snapshot after a terminal one). Never retry; dead-letter and alert.
	AckConflict = "conflict"
	// AckRejected: permanently refused as invalid or unattributable (bad
	// fields, no owner, forged attribution, owner account gone).
	AckRejected = "rejected"
	// AckRetry: transiently not applied (storage error); retry later.
	AckRetry = "retry"
	// AckGone: the allocation's owner account no longer exists (hard-purged,
	// or never bound and absent). Nothing was written; the bytes are
	// forgiven. The bridge deletes its record rather than dead-lettering it,
	// so no user-linked record outlives the account.
	AckGone = "gone"
)

// Ledger names.
const (
	LedgerBillable = "billable"
	LedgerShadow   = "shadow"
)

// Clamp reasons when Accepted < the snapshot's Cumulative.
const (
	ClampNone    = ""
	ClampRate    = "rate"    // per-report elapsed-time budget; retry later
	ClampCeiling = "ceiling" // absolute per-allocation ceiling; permanent
)

// Ack answers exactly one snapshot of the request.
type Ack struct {
	Key      string `json:"key"`
	Seq      uint64 `json:"seq"`
	Hash     string `json:"hash"`
	Status   string `json:"status"`
	Accepted uint64 `json:"accepted"`
	Ledger   string `json:"ledger,omitempty"`
	Clamp    string `json:"clamp,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

// Response is the POST answer: one Ack per request snapshot, same order.
type Response struct {
	Acks []Ack `json:"acks"`
}

// DecodeStrict decodes exactly one JSON value into v and requires the input
// to end there. json.Decoder.More alone is not enough: it reports false for a
// trailing '}' or ']', so a body like `{...}]` would pass.
func DecodeStrict(dec *json.Decoder, v any) error {
	if err := dec.Decode(v); err != nil {
		return err
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return err
	}
	return nil
}
