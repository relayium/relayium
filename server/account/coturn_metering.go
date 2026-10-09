package account

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/relayium/relayium/httpx"
	"github.com/relayium/relayium/internal/coturnbridge/wire"
	"github.com/relayium/relayium/internal/relayusage"
)

// Coturn metering ingest (F02).
//
// A coturn host runs relayium-coturn-bridge, which turns coturn's Redis
// accounting into immutable cumulative snapshots and POSTs them here. The
// bridge authenticates as a dedicated metering-only identity: it is not a
// fleet node, is never registered, scheduled or advertised, and its token
// grants nothing but this one route. See ApplyCoturnSnapshot for the ledger
// contract and artifacts/latency-optimization-release-20261001/coturn for the
// provider facts and the bounded-loss statement.

// Coturn metering modes.
const (
	CoturnMeteringShadow   = "shadow"
	CoturnMeteringBillable = "billable"
)

// CoturnMeteringConfig configures the ingest.
type CoturnMeteringConfig struct {
	// Relays maps a relay identity to the SHA-256 of its bearer token. Central
	// stores only the hash.
	Relays map[string][32]byte
	// Mode is CoturnMeteringShadow (never writes the billable ledger) or
	// CoturnMeteringBillable.
	Mode string
	// BillableSince (unix seconds) is the explicit activation baseline,
	// required in billable mode: only allocations the bridge first observed at
	// or after it, and first received after it, are ever billed.
	BillableSince int64
	// Now defaults to time.Now; Logf to log.Printf.
	Now  func() int64
	Logf func(format string, args ...any)
}

// ParseCoturnMeteringRelays parses "relay-a=<sha256 hex>,relay-b=<sha256 hex>".
func ParseCoturnMeteringRelays(spec string) (map[string][32]byte, error) {
	out := map[string][32]byte{}
	for part := range strings.SplitSeq(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, hexHash, ok := strings.Cut(part, "=")
		if !ok || !wire.ValidRelayID(id) {
			return nil, fmt.Errorf("coturn metering relay %q: want <relay-id>=<sha256 hex of its token>", id)
		}
		raw, err := hex.DecodeString(hexHash)
		if err != nil || len(raw) != sha256.Size {
			return nil, fmt.Errorf("coturn metering relay %q: token hash must be 64 hex characters", id)
		}
		if _, dup := out[id]; dup {
			return nil, fmt.Errorf("coturn metering relay %q listed twice", id)
		}
		out[id] = [32]byte(raw)
	}
	if err := distinctRelayTokens(out); err != nil {
		return nil, err
	}
	return out, nil
}

// distinctRelayTokens refuses two relay identities sharing one token hash: a
// token must authenticate exactly one identity, or which identity a request
// is attributed to would depend on map iteration order.
func distinctRelayTokens(relays map[string][32]byte) error {
	seen := map[[32]byte]string{}
	for id, h := range relays {
		if other, dup := seen[h]; dup {
			a, b := min(id, other), max(id, other)
			return fmt.Errorf("coturn metering relays %q and %q share one token", a, b)
		}
		seen[h] = id
	}
	return nil
}

// coturnMeteringStore is the store capability the ingest needs; only
// SQLiteStore has it, so the handler refuses to build over any other store.
type coturnMeteringStore interface {
	ApplyCoturnSnapshot(ctx context.Context, in CoturnSnapshotApply) (CoturnSnapshotOutcome, error)
	DemoteCoturnBillableBindings(ctx context.Context) (int64, error)
}

// CoturnMeteringIngest is the HTTP handler for wire.Path.
type CoturnMeteringIngest struct {
	cfg     CoturnMeteringConfig
	store   coturnMeteringStore
	refused func(token, userID string) string
}

// NewCoturnMeteringIngest builds the ingest over store. refused is the
// attribution guard (Service.attributionRefused); nil accepts every tag.
//
// In shadow mode it first demotes every existing billable binding to shadow
// (DemoteCoturnBillableBindings), after the whole configuration is validated
// and before the handler exists: on any error it returns no handler, and
// nothing has been demoted (an invalid configuration writes nothing at all).
func NewCoturnMeteringIngest(store Store, refused func(token, userID string) string, cfg CoturnMeteringConfig) (*CoturnMeteringIngest, error) {
	st, ok := store.(coturnMeteringStore)
	if !ok {
		return nil, errors.New("coturn metering ingest needs the SQLite store")
	}
	if len(cfg.Relays) == 0 {
		return nil, errors.New("coturn metering ingest needs at least one relay identity")
	}
	for id := range cfg.Relays {
		if !wire.ValidRelayID(id) {
			return nil, fmt.Errorf("coturn metering relay id %q", id)
		}
	}
	if err := distinctRelayTokens(cfg.Relays); err != nil {
		return nil, err
	}
	switch cfg.Mode {
	case CoturnMeteringShadow:
	case CoturnMeteringBillable:
		if cfg.BillableSince <= 0 {
			return nil, errors.New("coturn metering billable mode needs an explicit activation time (billable-since)")
		}
	default:
		return nil, fmt.Errorf("coturn metering mode %q: want %q or %q", cfg.Mode, CoturnMeteringShadow, CoturnMeteringBillable)
	}
	if cfg.Now == nil {
		cfg.Now = func() int64 { return time.Now().Unix() }
	}
	if cfg.Logf == nil {
		cfg.Logf = log.Printf
	}
	if refused == nil {
		refused = func(string, string) string { return "" }
	}
	if cfg.Mode == CoturnMeteringShadow {
		n, err := st.DemoteCoturnBillableBindings(context.Background())
		if err != nil {
			return nil, fmt.Errorf("coturn metering: demote billable bindings for shadow mode: %w", err)
		}
		cfg.Logf("coturn metering: shadow mode: demoted %d billable binding(s) to shadow for good", n)
	}
	return &CoturnMeteringIngest{cfg: cfg, store: st, refused: refused}, nil
}

// CoturnMeteringDisabled is the startup step for an ingest that is not
// configured: no route exists, so this period is not billable either, and
// every existing billable binding is demoted to shadow exactly as a
// shadow-mode startup does. A store without the coturn capability has no
// bindings.
func (s *Service) CoturnMeteringDisabled(ctx context.Context) error {
	st, ok := s.store.(coturnMeteringStore)
	if !ok {
		return nil
	}
	n, err := st.DemoteCoturnBillableBindings(ctx)
	if err != nil {
		return fmt.Errorf("coturn metering: demote billable bindings while the ingest is disabled: %w", err)
	}
	log.Printf("coturn metering: ingest disabled: demoted %d billable binding(s) to shadow for good", n)
	return nil
}

// CoturnMeteringHandler is NewCoturnMeteringIngest over this service's store
// and attribution guard.
func (s *Service) CoturnMeteringHandler(cfg CoturnMeteringConfig) (*CoturnMeteringIngest, error) {
	return NewCoturnMeteringIngest(s.store, s.attributionRefused, cfg)
}

// authenticate returns the relay identity whose token hash matches, comparing
// against every configured identity so timing does not depend on which one.
func (h *CoturnMeteringIngest) authenticate(r *http.Request) (string, bool) {
	tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || tok == "" {
		return "", false
	}
	sum := sha256.Sum256([]byte(tok))
	match := ""
	for id, want := range h.cfg.Relays {
		if subtle.ConstantTimeCompare(sum[:], want[:]) == 1 {
			match = id
		}
	}
	return match, match != ""
}

func (h *CoturnMeteringIngest) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		httpx.WriteJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	relayID, ok := h.authenticate(r)
	if !ok {
		h.cfg.Logf("coturn metering: refused unauthenticated report from %s", r.RemoteAddr)
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, wire.MaxRequestBytes))
	dec.DisallowUnknownFields()
	var req wire.Request
	if err := wire.DecodeStrict(dec, &req); err != nil {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "malformed request"})
		return
	}
	if req.RelayID != relayID {
		h.cfg.Logf("coturn metering: ALERT relay %s sent a body naming relay %q", relayID, req.RelayID)
		httpx.WriteJSON(w, http.StatusForbidden, map[string]string{"error": "relay identity mismatch"})
		return
	}
	if len(req.Snapshots) == 0 || len(req.Snapshots) > wire.MaxSnapshotsPerRequest {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "snapshot count out of range"})
		return
	}
	now := h.cfg.Now()
	resp := wire.Response{Acks: make([]wire.Ack, 0, len(req.Snapshots))}
	for i := range req.Snapshots {
		resp.Acks = append(resp.Acks, h.apply(r.Context(), relayID, &req.Snapshots[i], now))
	}
	httpx.WriteJSON(w, http.StatusOK, resp)
}

func (h *CoturnMeteringIngest) apply(ctx context.Context, relayID string, snap *wire.Snapshot, now int64) wire.Ack {
	ack := wire.Ack{Key: snap.Key(), Seq: snap.Seq, Hash: snap.Hash}
	reject := func(reason string) wire.Ack {
		ack.Status, ack.Reason = wire.AckRejected, reason
		h.cfg.Logf("coturn metering: ALERT relay %s snapshot %s seq %d rejected: %s", relayID, ack.Key, snap.Seq, reason)
		return ack
	}
	if err := snap.Validate(); err != nil {
		return reject("invalid snapshot: " + err.Error())
	}
	if snap.RelayID != relayID {
		return reject("snapshot names another relay")
	}
	userID, attrib := relayusage.SplitAttrib(relayusage.TokenFromUsername(snap.Username))
	if userID == "" {
		return reject("username carries no owner")
	}
	if why := h.refused(attrib, userID); why != "" {
		return reject("forged attribution (" + why + ")")
	}
	uh := sha256.Sum256([]byte(snap.Username))
	out, err := h.store.ApplyCoturnSnapshot(ctx, CoturnSnapshotApply{
		RelayID:       relayID,
		Snapshot:      *snap,
		UsernameHash:  hex.EncodeToString(uh[:]),
		UserID:        userID,
		Token:         attrib,
		Now:           now,
		Billable:      h.cfg.Mode == CoturnMeteringBillable,
		BillableSince: h.cfg.BillableSince,
	})
	if err != nil {
		h.cfg.Logf("coturn metering: relay %s snapshot %s seq %d not applied: %v", relayID, ack.Key, snap.Seq, err)
		ack.Status, ack.Reason = wire.AckRetry, "storage error"
		return ack
	}
	ack.Status, ack.Ledger, ack.Clamp, ack.Reason = out.Status, out.Ledger, out.Clamp, out.Reason
	if out.Accepted > 0 {
		ack.Accepted = uint64(out.Accepted)
	}
	switch {
	case out.Status == wire.AckConflict || out.Status == wire.AckRejected:
		h.cfg.Logf("coturn metering: ALERT relay %s snapshot %s seq %d %s: %s", relayID, ack.Key, snap.Seq, out.Status, out.Reason)
	case out.Status == wire.AckGone:
		// No user id or username in this line: the account is deleted.
		h.cfg.Logf("coturn metering: relay %s snapshot %s seq %d refused: %s (bytes forgiven)", relayID, ack.Key, snap.Seq, out.Reason)
	case out.Clamp != wire.ClampNone:
		h.cfg.Logf("coturn metering: relay %s snapshot %s seq %d clamped (%s): reported %d, accepted %d",
			relayID, ack.Key, snap.Seq, out.Clamp, snap.Cumulative, out.Accepted)
	}
	return ack
}
