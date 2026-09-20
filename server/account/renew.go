package account

import (
	"context"
	"log"
	"strings"

	"github.com/relayium/relayium/internal/signal"
)

// Issuing credentials for a transfer that is already running.
//
// This is the account half of renewal. The signalling half (who may ask, how
// often, and what happens to a half-collected round) is in
// internal/signal/grant.go; everything here is the question "may this account
// have another hour of relay, and on which nodes".
//
// ## It is the same answer as /api/ice, with one policy inverted
//
// The configuration shape, the credential format, the strict-mode rule and the
// relay pool are all literally the same code (relayPool). What differs is what
// an unanswerable question means:
//
//   - **/api/ice fails OPEN.** A database blip must not stop a transfer from
//     starting. That policy is unchanged here and deliberately untouched.
//   - **Renewal fails CLOSED.** Every gate below returns `unavailable` — never
//     credentials — when it cannot get an answer. The asymmetry is the whole
//     point: at /api/ice time the alternative to issuing is a user who cannot
//     transfer at all, while at renewal time there is an EXISTING credential
//     still running, so a refusal costs the remaining minutes of that hour and
//     a truthful ending rather than a broken product. Extending paid relay on
//     a question nobody answered is the one outcome neither of those justifies.
//
// `unavailable` also does not advance the issuance round or charge the rate
// floor, so a client's bounded retry costs the account nothing.
//
// ## What it is given, and what it is NOT given
//
// It receives the generation's FROZEN owner and attribution tag, captured when
// the code was minted. It never sees a pairing code and never resolves one:
// those six digits are recycled minutes after they expire, and a renewal that
// re-read them could issue against whoever owns them now. For the same reason
// the token it stamps is the original tag, so a renewed credential's bytes are
// billed exactly where the original's were.
//
// ## What it does NOT do
//
// It grants no new entitlement. It mints no quota, extends no plan and creates
// no funds. Renewal is the same per-hour credential the account could already
// obtain by pairing again; what it removes is the forced re-pair, not a limit.
// The bytes it enables are metered and attributed by the unchanged ledger.

// RenewRelayGrant issues credentials for an already-paired generation, or says
// why not. It is the production RenewIssuer.
//
// Errors are never returned: every outcome is a status the protocol defines,
// because a caller that had to distinguish "error" from "denied" would be a
// second place where the fail-closed rule could be got wrong.
func (s *Service) RenewRelayGrant(ctx context.Context, owner, tag string) signal.RenewIssue {
	unavailable := func(what string, err error) signal.RenewIssue {
		// Logged, because a renewal that keeps failing is an operational fact
		// and the client's only visible symptom is a link that ends on time.
		log.Printf("relay renewal unavailable for owner %s: %s: %v", owner, what, err)
		return signal.RenewIssue{Status: signal.RenewUnavailable, Reason: "unavailable"}
	}
	if owner == "" || tag == "" {
		return signal.RenewIssue{Status: signal.RenewDenied, Reason: "membership"}
	}
	if s.relayAttrib == nil {
		// No attribution resolver means this process cannot name what the bytes
		// would be billed as. Refuse rather than issue an unattributable
		// credential.
		return signal.RenewIssue{Status: signal.RenewUnavailable, Reason: "unavailable"}
	}

	// The account still has to exist, and still has to be an account. A user
	// row that is gone, or scheduled for deletion, does not get another hour of
	// relay on the strength of a socket that is still open.
	u, err := s.store.GetUserByID(ctx, owner)
	if err != nil {
		return unavailable("account", err)
	}
	if u.ID == "" || u.DeletedAt > 0 {
		return signal.RenewIssue{Status: signal.RenewDenied, Reason: "membership"}
	}

	// Same Sybil gate /api/ice applies, read the other way round: there an
	// unreadable answer issues anyway, here it refuses.
	verified, err := s.store.EmailVerified(ctx, owner)
	if err != nil {
		return unavailable("email verification", err)
	}
	if !verified {
		return signal.RenewIssue{Status: signal.RenewDenied, Reason: "unverified", RelayDenied: "unverified"}
	}

	// The plan's monthly traffic allowance, evaluated fresh on every round —
	// including at exactly zero left, which is the same boundary /api/ice and
	// the pre-mint gate both refuse at.
	//
	// **This is an ISSUANCE-TIME gate, and that is all it is.** It decides
	// whether another credential may be handed out. It does not reach an
	// allocation that already exists, cannot revoke one, and does not cap bytes
	// as they move.
	//
	// Two consequences, both pre-existing and neither introduced here:
	//
	//   - A credential expiry does not compel the third-party TURN server to
	//     retire an allocation that is already running. Our own relay nodes do
	//     re-authenticate and stop; that is a property of those nodes, not a
	//     general one, and must not be stated as a guarantee for every relay
	//     this endpoint hands out.
	//   - Relay usage is metered after the fact — a node's periodic report, or
	//     the end of an allocation on the third-party path — so this check is
	//     evaluated per round against whatever the meter has seen by then.
	//
	// The residual that follows from those two is recorded as a separate
	// deferred money-path task with its own evidence; it is not waived here and
	// nothing in this file claims to close it. Read through the STRICT chain,
	// because the ordinary one folds an unreadable admin grant or plan row into
	// a default tier and would compute this cap from an entitlement nobody
	// confirmed. See docs/billing-transparency.md for the public statement of
	// the limits.
	spent, err := s.trafficAllowanceSpentStrict(ctx, owner)
	if err != nil {
		return unavailable("traffic allowance", err)
	}
	if spent {
		return signal.RenewIssue{Status: signal.RenewDenied, Reason: "quota", RelayDenied: "quota"}
	}

	now := s.now()
	expiry := now.Add(s.cfg.TURNCredTTL).Unix()
	// The ORIGINAL tag, so renewed bytes bill exactly where the first hour's
	// did, and so the metering index needs no new entry for this round.
	token := owner + "." + tag

	servers := s.stunServers()
	// Strict mode read from the row already fetched above, so it cannot
	// disagree with the deletion check.
	strict := u.OnlyOwnNodes
	// Legacy single TURN, on the same terms /api/ice offers it: withheld in
	// strict mode, present otherwise, so a non-strict BYO owner keeps the fleet
	// fallback rather than silently losing it at renewal.
	if !strict && s.cfg.TURNSecret != "" && len(s.cfg.TURNURLs) > 0 {
		servers = append(servers, turnCredentials(s.cfg.TURNSecret, token, expiry, withTCPTransport(s.cfg.TURNURLs)))
	}

	relays, err := s.relayPool(ctx, owner, token, expiry, strict, now, true)
	if err != nil {
		return unavailable("relay pool", err)
	}

	// Nothing to migrate onto. Reported as retryable rather than terminal: a
	// node coming back online genuinely fixes it, and a client that keeps its
	// old deadline loses nothing by asking again inside its margin.
	if !answerCarriesRelay(servers, relays) {
		return signal.RenewIssue{Status: signal.RenewUnavailable, Reason: "unavailable"}
	}

	config := map[string]any{"iceServers": servers}
	if len(relays) > 0 {
		config["relays"] = relays
	}
	// NOTHING is recorded here — not the retention, not the expiry.
	//
	// This function stamps an expiry onto credentials that the grant layer may
	// still decide not to publish: the generation can lapse, lose a member or
	// be replaced while these reads are running. Recording the issuance now
	// would extend the very authority that decision is about to be judged
	// against, and a discarded result would have silently bought itself another
	// hour. The grant records it after it accepts, through
	// PairRegistry.RetainTag, which reaches the attribution index without
	// feeding the renewal authority.
	return signal.RenewIssue{Status: signal.RenewGranted, Config: config, Expiry: expiry}
}

// answerCarriesRelay reports whether a configuration contains a TURN entry at
// all. A STUN-only answer is a valid /api/ice response — a LAN room is exactly
// that — but it is not a renewal: there is no new allocation to migrate onto,
// and publishing one would spend a round and a rate slot on nothing.
func answerCarriesRelay(servers []ICEServer, relays []relayEntry) bool {
	if iceServersCarryTURN(servers) {
		return true
	}
	for _, r := range relays {
		if iceServersCarryTURN(r.ICEServers) {
			return true
		}
	}
	return false
}

func iceServersCarryTURN(servers []ICEServer) bool {
	for _, srv := range servers {
		if srv.Credential == "" {
			continue
		}
		for _, u := range srv.URLs {
			if strings.HasPrefix(u, "turn:") || strings.HasPrefix(u, "turns:") {
				return true
			}
		}
	}
	return false
}
