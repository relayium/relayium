package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// B3, at the only place it can be applied: before a pairing code is minted.
//
// The decision (2026-08-11) is "block before entering the room when the account
// is over quota", and the pre-mint half of it asks about ONE limit — the monthly
// combined traffic allowance — because that is the only one whose exhaustion
// takes away both cross-network paths at once. Relayium's meter covers relay AND
// stored upload/download, so an account with no traffic left can neither pre-
// upload nor run a live TURN session: the six digits it would be handed name a
// rendezvous it cannot use.
//
// Storage and the rolling daily upload quota are deliberately NOT asked about
// here, and the tests below pin that. Both refuse an UPLOAD, neither touches the
// live relay path, and a code minted by an account whose disk is full is still a
// working code — refusing to mint one would be the server inventing a limit the
// product does not have.
//
// Everything reads through pairMintRefusal, which both the POST and the
// preflight call, so the answer the choose screen shows and the answer the mint
// enforces cannot drift.

// preflight GETs the read-only admission answer. `authed` sends the harness's
// session cookie; without it the request is anonymous.
func (h *pairHarness) preflight(t *testing.T, authed bool) (int, pairPreflightResponse) {
	t.Helper()
	req, _ := http.NewRequest("GET", h.ts.URL+"/api/pair/preflight", nil)
	if authed {
		req.AddCookie(h.cookie)
	}
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out pairPreflightResponse
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// spendTraffic bills `bytes` of this month's combined allowance to the harness's
// user, which is what an exhausted account looks like from the meter's side.
func (h *pairHarness) spendTraffic(t *testing.T, bytes int64) {
	t.Helper()
	if err := h.store.RecordMeter(context.Background(), h.userID, MeterUpload, bytes, h.now); err != nil {
		t.Fatalf("record traffic: %v", err)
	}
}

// fillStorage puts `bytes` of live stored objects on the account, without
// touching the traffic meter — the state that must NOT block a mint.
func (h *pairHarness) fillStorage(t *testing.T, bytes int64) {
	t.Helper()
	if err := h.store.CreateStoredFile(context.Background(), StoredFile{
		ID: "sf-fill", UserID: h.userID, BlobKey: "k-fill", EncManifest: []byte("M"),
		Size: bytes, CreatedAt: h.now, ExpiresAt: h.now + 86400, Purpose: "share",
	}); err != nil {
		t.Fatalf("fill storage: %v", err)
	}
}

// spendDailyQuota consumes the rolling 24-hour upload window, again without
// touching the monthly traffic meter.
func (h *pairHarness) spendDailyQuota(t *testing.T, bytes int64) {
	t.Helper()
	if _, err := h.store.ReserveUpload(context.Background(),
		UploadEvent{ID: "ev-daily", UserID: h.userID, Bytes: bytes, UploadedAt: h.now},
		h.now-dayWindow, 1<<40); err != nil {
		t.Fatalf("reserve daily quota: %v", err)
	}
}

// The evaluator itself, on the exact signature main.go hands the mint handler.
func (h *pairHarness) refusal() string {
	return h.svc.PairMintRefusal(httptest.NewRequest("POST", "/api/pair", nil), h.userID)
}

// ── the evaluator ───────────────────────────────────────────────────────────

func TestMintingIsRefusedWhenTheMonthlyTrafficAllowanceIsSpent(t *testing.T) {
	h := newPairHarness(t)
	h.setPlan(t, Plan{ID: "tight-traffic", Name: "Tight", StorageBytes: 1 << 30,
		TrafficBytes: 1000, RetentionSecs: 3600, DailyQuotaBytes: 1 << 30})
	h.spendTraffic(t, 1001)

	if got := h.refusal(); got != PairMintTrafficSpent {
		t.Fatalf("refusal = %q, want %q — an account with no cross-network allowance left cannot use either path the code names",
			got, PairMintTrafficSpent)
	}
}

// ── the exhaustion boundary, to the byte ────────────────────────────────────
//
// The two cases that decide what "spent" means. They are one byte apart, and the
// evaluator has to disagree about them, because everything the user is told hangs
// on this line: at exactly the cap the copy says the allowance is gone, and it is
// — the next relay packet and the next stored byte are both refused, so a code
// minted here names a rendezvous that cannot move anything.
//
// This is also why the evaluator does not ask overTraffic(…, 0): that question is
// `add > remaining`, which at remaining == 0 with add == 0 answers "fits", and a
// code would be handed out at the exact moment the allowance ran out. It asks
// trafficAllowanceSpent instead — the same helper the TURN credential gate and
// room admission ask, which is what makes "both cross-network paths are closed"
// true at this boundary and not just above it (turn_test.go and
// pairroom_hardening_test.go pin their halves).

func TestExactlyAtTheCapCountsAsSpent(t *testing.T) {
	h := newPairHarness(t)
	h.setPlan(t, Plan{ID: "tight-traffic", Name: "Tight", StorageBytes: 1 << 30,
		TrafficBytes: 1000, RetentionSecs: 3600, DailyQuotaBytes: 1 << 30})
	h.spendTraffic(t, 1000) // remaining == 0, not negative

	if rem, unlimited, err := h.svc.remainingTraffic(context.Background(), h.userID); err != nil || unlimited || rem != 0 {
		t.Fatalf("the account is not actually sitting on exactly its cap (remaining=%d unlimited=%v err=%v)", rem, unlimited, err)
	}
	if got := h.refusal(); got != PairMintTrafficSpent {
		t.Fatalf("refusal = %q with exactly zero bytes of allowance left, want %q — zero left is spent, and the screen says so",
			got, PairMintTrafficSpent)
	}
}

// One byte below the cap is not spent. A gate that rounded this off would refuse
// accounts that can still complete a transfer, which is the opposite failure and
// just as wrong.
func TestOneByteBelowTheCapStillMints(t *testing.T) {
	h := newPairHarness(t)
	h.setPlan(t, Plan{ID: "tight-traffic", Name: "Tight", StorageBytes: 1 << 30,
		TrafficBytes: 1000, RetentionSecs: 3600, DailyQuotaBytes: 1 << 30})
	h.spendTraffic(t, 999) // remaining == 1

	if got := h.refusal(); got != "" {
		t.Fatalf("refusal = %q with one byte of allowance left; the account is not out", got)
	}
}

// An unlimited plan has no boundary to sit on. `remaining` is meaningless when
// the cap is non-positive, and reading it as "zero left" would refuse exactly the
// accounts that can never run out.
func TestAnUnlimitedPlanIsNeverSpent(t *testing.T) {
	h := newPairHarness(t)
	h.setPlan(t, Plan{ID: "unlimited-traffic", Name: "Unlimited", StorageBytes: 1 << 30,
		TrafficBytes: 0, RetentionSecs: 3600, DailyQuotaBytes: 1 << 30})
	h.spendTraffic(t, 1<<40)

	if got := h.refusal(); got != "" {
		t.Fatalf("refusal = %q for an account whose plan has no traffic cap", got)
	}
}

// The boundary is one boundary. The preflight paints the screen and the POST
// decides, so a disagreement between them at exactly the cap is a button that
// vanishes and a mint that succeeds (or the reverse) — which is why both go
// through pairMintRefusal rather than each asking in its own words.
func TestThePostAndThePreflightAgreeAtTheExactBoundary(t *testing.T) {
	h := newPairHarness(t)
	h.setPlan(t, Plan{ID: "tight-traffic", Name: "Tight", StorageBytes: 1 << 30,
		TrafficBytes: 1000, RetentionSecs: 3600, DailyQuotaBytes: 1 << 30})

	h.spendTraffic(t, 999) // one below: both must admit
	status, body := h.preflight(t, true)
	if status != 200 || !body.Allowed || body.Reason != "" {
		t.Fatalf("preflight one byte below the cap = %d %+v, want allowed", status, body)
	}
	if got := h.refusal(); got != "" {
		t.Fatalf("the POST refused (%q) one byte below the cap while the preflight admitted", got)
	}

	h.spendTraffic(t, 1) // exactly at the cap: both must refuse
	status, body = h.preflight(t, true)
	if status != 200 || body.Allowed || body.Reason != PairMintTrafficSpent {
		t.Fatalf("preflight at exactly the cap = %d %+v, want blocked with %q", status, body, PairMintTrafficSpent)
	}
	if got := h.refusal(); got != PairMintTrafficSpent {
		t.Fatalf("the POST admitted (%q) at exactly the cap while the preflight blocked", got)
	}
}

// Storage full is an UPLOAD refusal, not a rendezvous one. The live relay does
// not store a byte, so a code minted here is a code that works.
func TestAFullDiskDoesNotStopACodeFromBeingMinted(t *testing.T) {
	h := newPairHarness(t)
	h.setPlan(t, Plan{ID: "tight-storage", Name: "Tight", StorageBytes: 1000,
		TrafficBytes: 1 << 40, RetentionSecs: 3600, DailyQuotaBytes: 1 << 30})
	h.fillStorage(t, 2000)

	if over, err := h.svc.overStorage(context.Background(), h.userID, 0); err != nil || !over {
		t.Fatalf("the account is not actually over its storage cap (over=%v err=%v); the test proves nothing", over, err)
	}
	if got := h.refusal(); got != "" {
		t.Fatalf("refusal = %q for an account that is only out of STORAGE; pre-upload would be refused later, but the live relay path is untouched and the code is usable", got)
	}
}

// The same for the rolling daily upload quota.
func TestASpentDailyQuotaDoesNotStopACodeFromBeingMinted(t *testing.T) {
	h := newPairHarness(t)
	h.setPlan(t, Plan{ID: "tight-daily", Name: "Tight", StorageBytes: 1 << 30,
		TrafficBytes: 1 << 40, RetentionSecs: 3600, DailyQuotaBytes: 1000})
	h.spendDailyQuota(t, 1000)

	if rem, err := h.svc.remainingDailyQuota(context.Background(), h.userID); err != nil || rem > 0 {
		t.Fatalf("the daily quota is not actually spent (remaining=%d err=%v)", rem, err)
	}
	if got := h.refusal(); got != "" {
		t.Fatalf("refusal = %q for an account that is only out of DAILY UPLOAD quota; the live relay path does not touch it", got)
	}
}

// Fail OPEN, on every read error, exactly like the room-admission gate and
// turn.go. One database blip must not stop everybody from starting a transfer,
// and it costs nothing: every byte that then moves still passes the
// authoritative gates.
func TestMintingFailsOpenWhenTheAllowanceCannotBeRead(t *testing.T) {
	h := newPairHarness(t)
	h.setPlan(t, Plan{ID: "tight-traffic", Name: "Tight", StorageBytes: 1 << 30,
		TrafficBytes: 1000, RetentionSecs: 3600, DailyQuotaBytes: 1 << 30})
	h.spendTraffic(t, 1001) // genuinely over, but unknowably so
	f := h.withFlakyStore(t)
	f.failNext("GetPlan", -1) // every plan read errors ⇒ the cap is unknown

	if got := h.refusal(); got != "" {
		t.Fatalf("refusal = %q when the allowance could not be read; a read error is not a spent allowance", got)
	}
}

// ── the preflight endpoint ──────────────────────────────────────────────────

// Anonymous callers learn nothing. The answer is a fact about somebody's
// account, and this endpoint has no other authorization to lean on.
func TestThePreflightRefusesAnonymousCallers(t *testing.T) {
	h := newPairHarness(t)
	status, body := h.preflight(t, false)
	if status != http.StatusUnauthorized {
		t.Fatalf("anonymous preflight = %d, want 401", status)
	}
	if body.Reason != "" || body.Allowed {
		t.Fatalf("an anonymous caller was told %+v about somebody's account", body)
	}
}

func TestThePreflightSaysAllowedForAnAccountWithAllowanceLeft(t *testing.T) {
	h := newPairHarness(t)
	status, body := h.preflight(t, true)
	if status != 200 {
		t.Fatalf("preflight = %d, want 200", status)
	}
	if !body.Allowed || body.Reason != "" {
		t.Fatalf("preflight said %+v for an account with its whole allowance", body)
	}
}

// The blocked answer, and the two things it must not do while giving it: mint,
// or touch the registry in any way. The choose screen calls this on every
// render, so a preflight that consumed anything would be a code shredder.
func TestThePreflightSaysBlockedAndMintsNothing(t *testing.T) {
	h := newPairHarness(t)
	h.setPlan(t, Plan{ID: "tight-traffic", Name: "Tight", StorageBytes: 1 << 30,
		TrafficBytes: 1000, RetentionSecs: 3600, DailyQuotaBytes: 1 << 30})
	h.spendTraffic(t, 1001)
	h.mintCode("878787", "")
	before := h.codes.codes["878787"]

	status, body := h.preflight(t, true)
	if status != 200 {
		t.Fatalf("preflight = %d, want 200 — a blocked answer is a successful read, not an error", status)
	}
	if body.Allowed || body.Reason != PairMintTrafficSpent {
		t.Fatalf("preflight said %+v, want blocked with %q", body, PairMintTrafficSpent)
	}
	if len(h.codes.codes) != 1 {
		t.Fatalf("the registry holds %d codes after a preflight; it must mint nothing", len(h.codes.codes))
	}
	if got := h.codes.codes["878787"]; got != before {
		t.Fatalf("the preflight altered a live registry entry: %+v, was %+v", got, before)
	}
	// Twice, because the choose screen may ask again and a second answer that
	// differed would mean the read had a side effect.
	if _, again := h.preflight(t, true); again != body {
		t.Fatalf("a second preflight answered %+v, first said %+v", again, body)
	}
}

func TestThePreflightFailsOpenWhenTheAllowanceCannotBeRead(t *testing.T) {
	h := newPairHarness(t)
	h.setPlan(t, Plan{ID: "tight-traffic", Name: "Tight", StorageBytes: 1 << 30,
		TrafficBytes: 1000, RetentionSecs: 3600, DailyQuotaBytes: 1 << 30})
	h.spendTraffic(t, 1001)
	f := h.withFlakyStore(t)
	f.failNext("GetPlan", -1)

	status, body := h.preflight(t, true)
	if status != 200 || !body.Allowed || body.Reason != "" {
		t.Fatalf("preflight with an unreadable allowance = %d %+v, want 200 allowed (fail open)", status, body)
	}
}
