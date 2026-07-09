# Relay Cost Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the blast radius of TURN-relay bandwidth cost so no single user or time window can produce a runaway egress bill, before payments are introduced.

**Architecture:** Three defense layers, hardest to softest. Layer 0 (cloud egress budget alarm + auto-cutoff) is the only true monthly-byte ceiling — documented as a runbook. Layer 1 (coturn `max-bps` + concurrency quotas) rate-limits how fast bytes can leak. Layer 2 (two small `handleICE` guards) keeps availability while blocking confirmed-unverified accounts and surfacing a metering-blind alert.

**Tech Stack:** Go (stdlib `net/http`, `log`), SQLite via existing `Store` interface, coturn config via `deploy/coturn-setup.sh` (bash), Markdown docs.

## Global Constraints

- No new external dependencies (Go modules or system packages). Use stdlib only. (from spec: "不新增外部依赖")
- Monthly-byte hard ceiling target: **数十 GB / 月**; on hit, relay off globally, STUN stays up. (spec Goal)
- Do **not** change `handleICE`'s existing pair-code → owner resolution, the WebRTC/signaling/crypto layers, or add per-plan quota logic (that is billing phase-1). (spec Non-goals)
- Fail-open philosophy: on any *error* reading metering/verification state, still issue relay (availability first — cost is already capped by L0/L1). Only deny on a positively-known bad state. (spec L2)
- coturn owner is always a real authenticated account: pairing-code minting requires login (`server/internal/signal/pairhttp.go:95` → 401 for anonymous). Guards below rely on this.

---

### Task 1: Relay requires a verified email (Layer 2b)

Gate TURN issuance on the owning account having a verified email — the cheapest Sybil dampener. Because a pairing-code owner is always a real logged-in account, and the fake test owner `"owner-1"` is not a DB row (so `EmailVerified` returns `ErrNotFound` → fail-open), existing TURN tests stay green.

**Files:**
- Modify: `server/internal/account/turn.go` (inside `handleICE`, the `if validCode {` block around lines 57-65)
- Test: `server/internal/account/turn_test.go` (add two tests)

**Interfaces:**
- Consumes: `s.store.EmailVerified(ctx context.Context, userID string) (bool, error)` (already in `Store`, `store.go:177`); `s.store.UpsertUserByEmail(ctx, email, displayName) (User, error)`; `s.store.SetEmailVerified(ctx, userID) error`; test helper `ownerResolver(ownerID, code string) func(string)(string,bool)` (already in `turn_test.go`).
- Produces: `handleICE` may set `relayDenied = "unverified"` and withhold TURN/relays when the owner's email is confirmed unverified.

- [ ] **Step 1: Write the failing tests**

Add to `server/internal/account/turn_test.go` (the file already imports `context`, `net/http`, `time`, `strings`):

```go
func TestICEUnverifiedOwnerDeniedRelay(t *testing.T) {
	ts, svc, store := newICEServer(t, "secret")
	u, err := store.UpsertUserByEmail(context.Background(), "unv@example.com", "U")
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	// u is unverified by default (email_verified = 0).
	svc.SetPairCodeOwner(ownerResolver(u.ID, "424242"))

	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	servers := iceServersFromBody(t, resp)
	if hasTURN(servers) {
		t.Fatalf("unverified owner must be STUN-only, got %+v", servers)
	}
}

func TestICEVerifiedOwnerGetsRelay(t *testing.T) {
	ts, svc, store := newICEServer(t, "secret")
	u, err := store.UpsertUserByEmail(context.Background(), "v@example.com", "V")
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := store.SetEmailVerified(context.Background(), u.ID); err != nil {
		t.Fatalf("verify user: %v", err)
	}
	svc.SetPairCodeOwner(ownerResolver(u.ID, "424242"))

	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	servers := iceServersFromBody(t, resp)
	if !hasTURN(servers) {
		t.Fatalf("verified owner should get TURN, got %+v", servers)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./internal/account/ -run 'TestICEUnverifiedOwnerDeniedRelay|TestICEVerifiedOwnerGetsRelay' -v`
Expected: `TestICEUnverifiedOwnerDeniedRelay` FAILS ("unverified owner must be STUN-only" — relay is currently issued to any valid code). `TestICEVerifiedOwnerGetsRelay` PASSES (relay already issued today).

- [ ] **Step 3: Add the verified-email guard**

In `server/internal/account/turn.go`, `handleICE`, insert a guard just after `expiry := now.Add(...)` and *before* the existing quota block. The existing block starts at:

```go
	// Interim relay cap: withhold TURN when the code's owner is over the monthly
```

Insert immediately above that comment:

```go
	// Sybil dampener: only a verified account may consume paid relay bandwidth.
	// Deny only when we positively know the email is unverified; on any read
	// error, fall through (fail-open) so a DB blip never blocks a real user.
	if validCode {
		if verified, err := s.store.EmailVerified(r.Context(), owner); err == nil && !verified {
			validCode = false
			relayDenied = "unverified"
		}
	}
```

Note: `relayDenied` is declared a few lines below in the current code (`relayDenied := ""`). Move that declaration up so it exists before this new block. Change the existing:

```go
	relayDenied := ""
	if validCode {
		st := s.resolveSettings(r.Context())
```

to hoist the declaration above the new guard. Concretely, the region becomes:

```go
	now := s.now()
	expiry := now.Add(s.cfg.TURNCredTTL).Unix()
	relayDenied := ""

	// Sybil dampener: only a verified account may consume paid relay bandwidth.
	// Deny only when we positively know the email is unverified; on any read
	// error, fall through (fail-open) so a DB blip never blocks a real user.
	if validCode {
		if verified, err := s.store.EmailVerified(r.Context(), owner); err == nil && !verified {
			validCode = false
			relayDenied = "unverified"
		}
	}

	// Interim relay cap: withhold TURN when the code's owner is over the monthly
	// free relay allowance. On a read error, fail open (issue TURN) rather than
	// blocking a legit transfer. Per-plan quota (billing phase-1) supersedes this.
	if validCode {
		st := s.resolveSettings(r.Context())
		since, _ := monthRange(periodOf(now.Unix()))
		if used, err := s.store.UserRelayedSince(r.Context(), owner, since); err == nil && used >= st.RelayMonthlyFree {
			validCode = false
			relayDenied = "quota"
		}
	}
```

(The only substantive change vs. today is the new guard block and hoisting `relayDenied := ""` above it. Everything below — the `token`, legacy TURN append, pool loop, `relayDenied` response field — stays byte-for-byte.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test ./internal/account/ -run 'TestICEUnverifiedOwnerDeniedRelay|TestICEVerifiedOwnerGetsRelay' -v`
Expected: both PASS.

- [ ] **Step 5: Run the full account package to confirm no regressions**

Run: `cd server && go test ./internal/account/`
Expected: PASS (existing TURN tests use fake owner `"owner-1"` → `EmailVerified` returns `ErrNotFound` → guard falls through → relay still issued).

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/turn.go server/internal/account/turn_test.go
git commit -m "feat(relay): require verified email before issuing TURN relay creds"
```

---

### Task 2: Fail-open metering-read alert (Layer 2a)

Keep issuing relay when the metering read errors (availability first), but emit an operator-visible log so a blind metering pipeline (e.g. Redis down) gets noticed and fixed.

**Files:**
- Modify: `server/internal/account/turn.go` (the quota block's `UserRelayedSince` call)
- Test: `server/internal/account/turn_test.go` (one test + a small erroring-store helper)

**Interfaces:**
- Consumes: `s.store.UserRelayedSince(ctx, userID string, since int64) (int64, error)`; stdlib `log`.
- Produces: on a `UserRelayedSince` error, `handleICE` logs `relay metering read failed for owner <id>: <err> (fail-open, issuing relay)` and still issues relay.

- [ ] **Step 1: Write the failing test**

Add to `server/internal/account/turn_test.go`. Add `"bytes"`, `"fmt"`, `"log"`, `"os"` to the import block if not present (`context`, `net/http`, `net/http/httptest`, `strings`, `time` already are):

```go
// relayErrStore wraps a real store but forces UserRelayedSince to error, to
// exercise the fail-open metering path. All other methods delegate.
type relayErrStore struct{ *SQLiteStore }

func (relayErrStore) UserRelayedSince(context.Context, string, int64) (int64, error) {
	return 0, fmt.Errorf("redis down")
}

func TestICEMeteringReadErrorFailsOpenWithAlert(t *testing.T) {
	base := newTestStore(t)
	u, err := base.UpsertUserByEmail(context.Background(), "v@example.com", "V")
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := base.SetEmailVerified(context.Background(), u.ID); err != nil {
		t.Fatalf("verify user: %v", err)
	}

	var logbuf bytes.Buffer
	log.SetOutput(&logbuf)
	defer log.SetOutput(os.Stderr)

	svc := NewService(relayErrStore{base}, &capturingMailer{}, Config{
		TURNCredTTL:      time.Hour,
		STUNURLs:         []string{"stun:stun.example.com:3478"},
		TURNURLs:         []string{"turn:turn.example.com:3478"},
		TURNSecret:       "secret",
		RelayMonthlyFree: 2 << 30,
	})
	svc.SetPairCodeOwner(ownerResolver(u.ID, "424242"))
	ts := httptest.NewServer(svc.Routes())
	defer ts.Close()

	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	servers := iceServersFromBody(t, resp)
	if !hasTURN(servers) {
		t.Fatalf("metering read error must fail-open to relay, got %+v", servers)
	}
	if !strings.Contains(logbuf.String(), "metering read failed") {
		t.Fatalf("expected a metering-blind alert log, got %q", logbuf.String())
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestICEMeteringReadErrorFailsOpenWithAlert -v`
Expected: FAIL on the log assertion (`expected a metering-blind alert log, got ""`) — relay is issued today but nothing is logged.

- [ ] **Step 3: Add the alert on the error branch**

In `server/internal/account/turn.go`, add `"log"` to the import block:

```go
import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
)
```

Change the quota block's condition from a single `err == nil && used >= cap` test to an explicit error branch:

```go
	if validCode {
		st := s.resolveSettings(r.Context())
		since, _ := monthRange(periodOf(now.Unix()))
		used, err := s.store.UserRelayedSince(r.Context(), owner, since)
		if err != nil {
			log.Printf("relay metering read failed for owner %s: %v (fail-open, issuing relay)", owner, err)
		} else if used >= st.RelayMonthlyFree {
			validCode = false
			relayDenied = "quota"
		}
	}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestICEMeteringReadErrorFailsOpenWithAlert -v`
Expected: PASS.

- [ ] **Step 5: Run the full account package**

Run: `cd server && go test ./internal/account/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/turn.go server/internal/account/turn_test.go
git commit -m "feat(relay): log an alert when relay metering read fails (fail-open preserved)"
```

---

### Task 3: coturn per-session rate + concurrency caps (Layer 1)

Add coturn native limits so a single session can't be used as a fat proxy and a single window can't leak unbounded bytes. Extract the config generation into a pure, testable function (matching how `deploy/auto-deploy.sh` exposes pure helpers to `deploy/test/`).

**Files:**
- Modify: `deploy/coturn-setup.sh` (extract `emit_turnserver_conf`, add a source guard, add three directives)
- Create: `deploy/test/coturn-conf-test.sh` (grep assertions on the generated config)

**Interfaces:**
- Produces: shell function `emit_turnserver_conf secret realm min_port max_port ext_line tls_cert tls_key` that echoes a full `turnserver.conf` to stdout, now including `max-bps`, `user-quota`, `total-quota`. Sourcing `coturn-setup.sh` loads only the functions (guard returns before the imperative install body).

- [ ] **Step 1: Write the failing test**

Create `deploy/test/coturn-conf-test.sh`:

```bash
#!/usr/bin/env bash
# Tests that coturn-setup.sh emits the cost-cap directives in the generated conf.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../coturn-setup.sh
source "$HERE/../coturn-setup.sh"   # source guard must prevent the install body from running

fail=0
ok()  { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; fail=1; }

conf="$(emit_turnserver_conf 'SEC' 'realm.example' 49152 65535 '1.2.3.4' '' '')"

grep -q '^static-auth-secret=SEC$'  <<<"$conf" && ok "secret present"      || bad "secret present"
grep -q '^realm=realm.example$'     <<<"$conf" && ok "realm present"       || bad "realm present"
grep -q '^max-bps='                 <<<"$conf" && ok "max-bps cap"         || bad "max-bps cap"
grep -q '^user-quota='              <<<"$conf" && ok "per-user quota"      || bad "per-user quota"
grep -q '^total-quota='             <<<"$conf" && ok "server total quota"  || bad "server total quota"

[ "$fail" = 0 ] && echo "ALL TESTS PASSED" || echo "SOME TESTS FAILED"
exit "$fail"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash deploy/test/coturn-conf-test.sh`
Expected: FAIL — `emit_turnserver_conf: command not found` (function does not exist yet; sourcing also currently runs the install body and errors).

- [ ] **Step 3: Extract the config generator + add a source guard + the new directives**

In `deploy/coturn-setup.sh`, immediately after `set -euo pipefail` (line 43), insert the function definition and a source guard, before the `ID=""...` argument defaults (line 45):

```bash
set -euo pipefail

# emit_turnserver_conf writes a full turnserver.conf to stdout. Pure (args only,
# no globals) so deploy/test can call it directly. Args:
#   $1 secret  $2 realm  $3 min_port  $4 max_port  $5 external_ip  $6 tls_cert  $7 tls_key
emit_turnserver_conf() {
  local secret="$1" realm="$2" min_port="$3" max_port="$4" ext_line="$5" tls_cert="$6" tls_key="$7"
  echo "# Managed by relayium deploy/coturn-setup.sh"
  echo "use-auth-secret"
  echo "static-auth-secret=$secret"
  echo "realm=$realm"
  echo "listening-port=3478"
  echo "min-port=$min_port"
  echo "max-port=$max_port"
  echo "external-ip=$ext_line"
  echo "fingerprint"
  echo "no-multicast-peers"
  echo "no-cli"
  # --- Layer 1 cost caps (see docs/superpowers/specs/2026-07-09-relay-cost-hardening-design.md) ---
  # max-bps: per-session bandwidth ceiling in bytes/sec. Caps a single 1h
  # credential window and stops the relay being used as a fat proxy. Tunable.
  echo "max-bps=2000000"
  # user-quota / total-quota: max simultaneous allocations per user / server-wide.
  echo "user-quota=12"
  echo "total-quota=1200"
  if [ -n "$tls_cert" ] && [ -n "$tls_key" ]; then
    echo "tls-listening-port=5349"
    echo "cert=$tls_cert"
    echo "pkey=$tls_key"
  fi
}

# When sourced by deploy/test, BASH_SOURCE[0] != $0: load only the functions
# above and stop before the imperative install body.
[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0

ID="" REALM="" REGION="" HOST="" SECRET="" TLS_CERT="" TLS_KEY=""
```

Then replace the old inline config-generation block (the `echo "==> writing /etc/turnserver.conf"` section, `{ echo "# Managed..."; ... } > /etc/turnserver.conf`) with a call to the function:

```bash
echo "==> writing /etc/turnserver.conf"
emit_turnserver_conf "$SECRET" "$REALM" "$MIN_PORT" "$MAX_PORT" "$EXT_LINE" "$TLS_CERT" "$TLS_KEY" > /etc/turnserver.conf
```

(Delete the whole old `{ ... } > /etc/turnserver.conf` brace block — its content now lives verbatim in `emit_turnserver_conf`, plus the three new cap lines.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash deploy/test/coturn-conf-test.sh`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 5: Lint the script**

Run: `shellcheck deploy/coturn-setup.sh deploy/test/coturn-conf-test.sh`
Expected: no errors (warnings pre-existing in the untouched body are acceptable; the new function and test must be clean).

- [ ] **Step 6: Commit**

```bash
git add deploy/coturn-setup.sh deploy/test/coturn-conf-test.sh
git commit -m "feat(coturn): add max-bps + allocation quotas; extract testable conf generator"
```

> **Implementation-time verification (spec open item #1):** on a real relay host, confirm the installed `turnserver` accepts `max-bps`/`user-quota`/`total-quota` and that their units match this plan's intent (`turnserver --help` / the man page for the installed version). Adjust the starter values (spec open item #2) if the box's normal transfer speeds need more than 2 MB/s per session.

---

### Task 4: Cloud egress cap runbook (Layer 0)

Document the only true monthly-byte ceiling: a per-relay-host cloud egress/bandwidth budget alarm with an auto-cutoff action. Pure documentation — no code path, so verification is doc review + the manual steps it contains.

**Files:**
- Modify: `docs/coturn.md` (append a "Cost ceiling / egress budget" section)

**Interfaces:** none (documentation).

- [ ] **Step 1: Append the runbook section**

Add to the end of `docs/coturn.md`:

```markdown
## Cost ceiling: egress budget alarm (Layer 0)

coturn's `max-bps`/quotas (set by `deploy/coturn-setup.sh`) limit *rate* and
*concurrency*, not cumulative monthly bytes. The only real ceiling on the
monthly relay bill is your cloud provider's egress budget. Set one per relay
host so a bug or abuse can never produce a runaway bill.

**Target:** relay egress hard-cut at **tens of GB/month**. On hit, relay stops;
STUN is unaffected (same-network / hole-punchable transfers keep working).

**Set up (per relay VPS):**

1. Create a bandwidth/egress **budget alarm** at your provider with thresholds
   at **50% / 80% / 100%** of the monthly target, notifying you (email/push).
2. Wire the **100% threshold to an automatic action** that stops relay traffic
   without touching STUN. Two equivalent options:
   - stop coturn: `systemctl stop coturn`
   - or firewall the relay ports: block UDP/TCP 3478 and 5349, leave STUN's
     UDP 3478 handling to your STUN config if separate.
3. Re-enable manually after investigating (or at the next month boundary).

**Verify once:** trigger a low test threshold (e.g. set a temporary 1 GB alarm)
and confirm both the notification and the auto-stop action fire, then restore
the real thresholds.

> The exact alarm + action mechanism is provider-specific (budget action,
> webhook, or a small cron that reads the provider's usage API). Implement it
> for whichever cloud each relay host runs on.
```

- [ ] **Step 2: Verify the doc renders and is internally consistent**

Run: `grep -n 'max-bps\|tens of GB\|systemctl stop coturn' docs/coturn.md`
Expected: the new section's key lines are present.

- [ ] **Step 3: Commit**

```bash
git add docs/coturn.md
git commit -m "docs(coturn): egress budget alarm runbook as the monthly relay cost ceiling"
```

---

## Self-Review

**Spec coverage:**
- L0 (cloud egress cap) → Task 4. ✓
- L1 (coturn max-bps + concurrency) → Task 3. ✓
- L2a (fail-open + alert) → Task 2. ✓
- L2b (relay requires verified email) → Task 1. ✓
- Spec open item #1 (verify coturn directive semantics) → noted in Task 3 verification callout. ✓
- Spec open item #2 (tune max-bps value) → noted in Task 3 callout. ✓
- Spec open item #3 (provider-specific L0 action) → noted in Task 4 doc. ✓

**Placeholder scan:** No TBD/TODO; every code/test step shows full content. ✓

**Type consistency:** `EmailVerified(ctx, userID) (bool, error)`, `UserRelayedSince(ctx, userID, since) (int64, error)`, `UpsertUserByEmail(ctx, email, display) (User, error)`, `SetEmailVerified(ctx, userID) error`, `ownerResolver(id, code)`, `emit_turnserver_conf secret realm min max ext cert key` — used consistently across tasks. `relayDenied` values: `"unverified"` (Task 1), `"quota"` (existing). ✓
