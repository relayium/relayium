# Cross-Network TURN Connectivity (②b-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a self-hosted coturn TURN relay available to cross-network peers via ephemeral credentials so WebRTC ICE falls back to relay on hard NATs, with graceful STUN-only degradation when no TURN secret is configured.

**Architecture:** A token-gated `GET /api/ice` returns ICE servers — always STUN, plus a TURN entry with a coturn TURN-REST ephemeral credential (`username = "<expiry>:<token>"`, `credential = base64(HMAC-SHA1(secret, username))`) when the request carries a valid transfer token and a TURN secret is configured. The web client fetches this list and passes it as `config.iceServers` to the existing `connect()`. No manual fallback logic — TURN just joins the ICE list and relay candidates carry the lowest priority.

**Tech Stack:** Go 1.26 (`crypto/hmac`, `crypto/sha1`, `encoding/base64`, `net/http`), Svelte 5 runes, Vitest.

## Global Constraints

- Module path: `github.com/relayium/relayium`; Go directive `go 1.26.3`.
- `GET /api/ice` is NOT session-gated. It authorizes TURN by possession of a valid transfer token (reuse `ValidateTransferToken` from ②a). It ALWAYS returns HTTP 200 with at least a STUN entry, and never reveals token validity (a bad/absent token simply omits TURN).
- Ephemeral credential format is fixed by the coturn TURN REST mechanism: `username = "<expiryUnix>:<token>"`, `credential = base64(HMAC-SHA1(static-auth-secret, username))`. HMAC-SHA1 is the required interop construction here (not a security choice); do not substitute another hash.
- TURN is OFF when `-turn-secret` is empty ⇒ `/api/ice` returns STUN only. This preserves ②a behavior and lets coturn be deployed incrementally.
- Time comes from the Service `now func() time.Time` for deterministic tests; never call `time.Now()` directly in service logic.
- LAN path and the crypto/SAS/transfer pipeline are unchanged. The server never touches file content or keys; TURN relays only the DTLS-encrypted stream.
- Web fetches use `credentials: "include"`; on a non-ok response the client falls back to a default STUN entry.
- Commit after every task. Run the full package suite once before committing.

**Out of scope (→ ②b-2):** counting/ingesting relayed bytes; quota/billing/rate-limit; a getStats "relayed" indicator. (→ ②c): trusted-device addressing.

---

### Task 1: TURN ephemeral credential generation

**Files:**
- Create: `server/internal/account/turn.go`
- Test: `server/internal/account/turn_test.go`

**Interfaces:**
- Produces:
  - `account.ICEServer{ URLs []string; Username, Credential string }` (JSON: `urls`, `username,omitempty`, `credential,omitempty`).
  - `turnCredentials(secret, token string, expiry int64, urls []string) ICEServer` — package-private helper.

- [ ] **Step 1: Write the failing test**

Create `server/internal/account/turn_test.go`:

```go
package account

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"testing"
)

func TestTurnCredentials(t *testing.T) {
	secret := "s3cr3t"
	token := "abc123"
	expiry := int64(1_000_000)
	urls := []string{"turn:turn.example.com:3478", "turns:turn.example.com:5349"}

	got := turnCredentials(secret, token, expiry, urls)

	wantUser := "1000000:abc123"
	if got.Username != wantUser {
		t.Fatalf("username = %q, want %q", got.Username, wantUser)
	}
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(wantUser))
	wantCred := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if got.Credential != wantCred {
		t.Fatalf("credential = %q, want %q", got.Credential, wantCred)
	}
	if fmt.Sprint(got.URLs) != fmt.Sprint(urls) {
		t.Fatalf("urls = %v, want %v", got.URLs, urls)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestTurnCredentials -v`
Expected: compile error — `turnCredentials` / `ICEServer` undefined.

- [ ] **Step 3: Implement**

Create `server/internal/account/turn.go`:

```go
package account

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
)

// ICEServer is one entry of an RTCConfiguration.iceServers list, serialized to
// the shape the browser's RTCPeerConnection expects.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// turnCredentials builds a coturn TURN-REST ephemeral credential. The shared
// static-auth-secret lets coturn validate the credential (and read the expiry
// embedded in the username) with no per-credential server state. HMAC-SHA1 is
// the construction mandated by the TURN REST mechanism, not a security choice.
func turnCredentials(secret, token string, expiry int64, urls []string) ICEServer {
	username := fmt.Sprintf("%d:%s", expiry, token)
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	cred := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return ICEServer{URLs: urls, Username: username, Credential: cred}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestTurnCredentials -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd server && go test ./internal/account/ && go vet ./internal/account/
git add server/internal/account/turn.go server/internal/account/turn_test.go
git commit -m "feat(account): coturn TURN-REST ephemeral credential generation"
```

---

### Task 2: `GET /api/ice` endpoint

**Files:**
- Modify: `server/internal/account/service.go` (add TURN/STUN fields to `Config`)
- Modify: `server/internal/account/turn.go` (add `handleICE` + a `stunServers` helper)
- Modify: `server/internal/account/handlers.go` (register the route)
- Test: `server/internal/account/turn_test.go` (append endpoint tests)

**Interfaces:**
- Consumes: `turnCredentials` (Task 1); `(*Service).ValidateTransferToken` and `(*Service).CreateTransfer` (②a); `writeJSON`, `newTestServer`/`newTestStore` test helpers.
- Produces: `Config.STUNURLs []string`, `Config.TURNURLs []string`, `Config.TURNSecret string`, `Config.TURNCredTTL time.Duration`; route `GET /api/ice`.

- [ ] **Step 1: Write the failing tests**

Append to `server/internal/account/turn_test.go` (add imports `context`, `encoding/json`, `net/http`, `net/http/httptest`, `strings`, `time`):

```go
func newICEServer(t *testing.T, secret string) (*httptest.Server, *Service, *SQLiteStore) {
	t.Helper()
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		TransferTTL: time.Hour,
		TURNCredTTL: time.Hour,
		STUNURLs:    []string{"stun:stun.example.com:3478"},
		TURNURLs:    []string{"turn:turn.example.com:3478"},
		TURNSecret:  secret,
	})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	return ts, svc, store
}

func iceServersFromBody(t *testing.T, resp *http.Response) []ICEServer {
	t.Helper()
	var out struct {
		ICEServers []ICEServer `json:"iceServers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out.ICEServers
}

func hasTURN(servers []ICEServer) bool {
	for _, s := range servers {
		for _, u := range s.URLs {
			if strings.HasPrefix(u, "turn:") || strings.HasPrefix(u, "turns:") {
				return true
			}
		}
	}
	return false
}

func TestICENoTokenReturnsStunOnly(t *testing.T) {
	ts, _, _ := newICEServer(t, "secret")
	resp, err := ts.Client().Get(ts.URL + "/api/ice")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("get: err=%v status=%v", err, resp.StatusCode)
	}
	servers := iceServersFromBody(t, resp)
	if len(servers) == 0 || hasTURN(servers) {
		t.Fatalf("expected STUN-only, got %+v", servers)
	}
}

func TestICEValidTokenIncludesTurn(t *testing.T) {
	ts, svc, store := newICEServer(t, "secret")
	u, _ := store.UpsertUserByEmail(context.Background(), "o@example.com", "O")
	tr, _ := svc.CreateTransfer(context.Background(), u.ID)

	resp, _ := ts.Client().Get(ts.URL + "/api/ice?room=" + tr.Token)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	servers := iceServersFromBody(t, resp)
	if !hasTURN(servers) {
		t.Fatalf("expected a TURN entry, got %+v", servers)
	}
	for _, s := range servers {
		if len(s.URLs) > 0 && (s.URLs[0] == "turn:turn.example.com:3478") {
			if s.Username == "" || s.Credential == "" {
				t.Fatalf("TURN entry missing username/credential: %+v", s)
			}
			if !strings.HasSuffix(s.Username, ":"+tr.Token) {
				t.Fatalf("username should embed token, got %q", s.Username)
			}
		}
	}
}

func TestICEInvalidTokenReturnsStunOnly(t *testing.T) {
	ts, _, _ := newICEServer(t, "secret")
	resp, _ := ts.Client().Get(ts.URL + "/api/ice?room=bogus")
	servers := iceServersFromBody(t, resp)
	if hasTURN(servers) {
		t.Fatalf("invalid token must not yield TURN, got %+v", servers)
	}
}

func TestICENoSecretReturnsStunOnly(t *testing.T) {
	ts, svc, store := newICEServer(t, "") // TURN disabled
	u, _ := store.UpsertUserByEmail(context.Background(), "o@example.com", "O")
	tr, _ := svc.CreateTransfer(context.Background(), u.ID)
	resp, _ := ts.Client().Get(ts.URL + "/api/ice?room=" + tr.Token)
	servers := iceServersFromBody(t, resp)
	if hasTURN(servers) {
		t.Fatalf("no secret must mean no TURN, got %+v", servers)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && go test ./internal/account/ -run TestICE -v`
Expected: compile error — `Config.STUNURLs`/`TURNURLs`/`TURNSecret`/`TURNCredTTL` and the `/api/ice` route/handler do not exist yet.

- [ ] **Step 3: Add Config fields**

In `server/internal/account/service.go`, add to the `Config` struct (after `TransferTTL`):

```go
	STUNURLs       []string
	TURNURLs       []string
	TURNSecret     string
	TURNCredTTL    time.Duration
```

- [ ] **Step 4: Add the handler + helper in turn.go**

Append to `server/internal/account/turn.go` (add imports `net/http`):

```go
// stunServers returns the configured STUN entries (always offered, no credentials).
func (s *Service) stunServers() []ICEServer {
	if len(s.cfg.STUNURLs) == 0 {
		return nil
	}
	return []ICEServer{{URLs: s.cfg.STUNURLs}}
}

// handleICE serves the RTCConfiguration.iceServers list. STUN is always
// included; a TURN entry with an ephemeral credential is added only when the
// request carries a valid transfer token AND a TURN secret is configured. It
// always returns 200 and never reveals token validity.
func (s *Service) handleICE(w http.ResponseWriter, r *http.Request) {
	servers := s.stunServers()
	token := r.URL.Query().Get("room")
	if token != "" && s.cfg.TURNSecret != "" && len(s.cfg.TURNURLs) > 0 &&
		s.ValidateTransferToken(r.Context(), token) {
		expiry := s.now().Add(s.cfg.TURNCredTTL).Unix()
		servers = append(servers, turnCredentials(s.cfg.TURNSecret, token, expiry, s.cfg.TURNURLs))
	}
	writeJSON(w, http.StatusOK, map[string]any{"iceServers": servers})
}
```

- [ ] **Step 5: Register the route**

In `server/internal/account/handlers.go`, add to `Routes()` (after the transfers route):

```go
	mux.HandleFunc("GET /api/ice", s.handleICE)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && go test ./internal/account/ -run 'TestICE' -v`
Expected: PASS (all four ICE tests).

- [ ] **Step 7: Commit**

```bash
cd server && go test ./internal/account/ && go vet ./internal/account/
git add server/internal/account/turn.go server/internal/account/service.go server/internal/account/handlers.go server/internal/account/turn_test.go
git commit -m "feat(account): GET /api/ice (token-gated STUN+TURN, graceful STUN-only)"
```

---

### Task 3: Wire TURN config into main.go

**Files:**
- Modify: `server/main.go`

**Interfaces:**
- Consumes: `Config.STUNURLs/TURNURLs/TURNSecret/TURNCredTTL` (Task 2).
- Produces: flags `-turn-secret`, `-turn-urls`, `-stun-urls`; sets the Config fields.

This is integration/wiring; verified by build + vet + the full suite + a smoke curl. There is no new unit test (the handler logic is unit-tested in Task 2).

- [ ] **Step 1: Add flags + a comma-split helper**

In `server/main.go`, add to the flag block (near `-base-url`):

```go
	turnSecret := flag.String("turn-secret", "", "coturn static-auth-secret (empty disables TURN)")
	turnURLs := flag.String("turn-urls", "", "comma-separated TURN URLs (e.g. turn:host:3478,turns:host:5349)")
	stunURLs := flag.String("stun-urls", "stun:stun.l.google.com:19302", "comma-separated STUN URLs")
```

Add a helper near `newID()`:

```go
// splitURLs parses a comma-separated URL flag, trimming spaces and dropping empties.
func splitURLs(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
```

Add `"strings"` to the import block.

- [ ] **Step 2: Set the Config fields**

In `server/main.go`, inside the `account.Config{...}` literal (after `TransferTTL: time.Hour,`), add:

```go
			STUNURLs:       splitURLs(*stunURLs),
			TURNURLs:       splitURLs(*turnURLs),
			TURNSecret:     *turnSecret,
			TURNCredTTL:    time.Hour,
```

- [ ] **Step 3: Build, vet, full suite**

Run:
```bash
cd server && go build ./... && go vet ./... && go test ./...
```
Expected: build OK; vet clean; all tests PASS.

- [ ] **Step 4: Smoke-check `/api/ice`**

Start the server with a TURN secret and confirm STUN-only without a token (a bogus token also yields STUN-only — TURN only appears for a real minted token, which needs a login, so STUN-only is the expected smoke result):

```bash
cd server && go run . -db ':memory:' -addr ':8088' -turn-secret testsecret -turn-urls 'turn:turn.example.com:3478' >/tmp/ice-smoke.log 2>&1 &
sleep 1.5
curl -s 'http://localhost:8088/api/ice' ; echo
curl -s 'http://localhost:8088/api/ice?room=bogus' ; echo
kill %1 2>/dev/null
```
Expected: both responses are JSON `{"iceServers":[{"urls":["stun:stun.l.google.com:19302"]}]}` (STUN only; no `turn:` entry, no `username`/`credential`). If your shell can't background a server, run it in another terminal; if you cannot run it at all, say so and mark the smoke check not-run rather than fabricating output.

- [ ] **Step 5: Commit**

```bash
git add server/main.go
git commit -m "feat(server): -turn-secret/-turn-urls/-stun-urls flags wired into /api/ice"
```

---

### Task 4: Web `ice` module

**Files:**
- Create: `web/src/lib/ice.ts`
- Test: `web/src/lib/ice.test.ts`

**Interfaces:**
- Produces: `fetchIceServers(token: string): Promise<RTCIceServer[]>` — GETs `/api/ice` (with `?room=` only when token is non-empty), returns the parsed `iceServers`, falls back to a default STUN entry on a non-ok response.

- [ ] **Step 1: Write the failing tests**

Create `web/src/lib/ice.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchIceServers } from "./ice";

const STUN = [{ urls: "stun:stun.l.google.com:19302" }];

describe("fetchIceServers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests /api/ice with ?room= when a token is given and returns the list", async () => {
    const servers = [
      { urls: ["stun:s:3478"] },
      { urls: ["turn:t:3478"], username: "u", credential: "c" },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ iceServers: servers }) });
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchIceServers("tok");
    expect(out).toEqual(servers);
    expect(fetchMock).toHaveBeenCalledWith("/api/ice?room=tok", {
      credentials: "include",
    });
  });

  it("omits ?room= when token is empty", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ iceServers: STUN }) });
    vi.stubGlobal("fetch", fetchMock);

    await fetchIceServers("");
    expect(fetchMock).toHaveBeenCalledWith("/api/ice", { credentials: "include" });
  });

  it("falls back to a STUN entry on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const out = await fetchIceServers("tok");
    expect(out).toEqual(STUN);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/ice.test.ts`
Expected: FAIL — module `./ice` not found.

- [ ] **Step 3: Implement the module**

Create `web/src/lib/ice.ts`:

```ts
// Fetches the RTCConfiguration.iceServers list from the server. For a token-room
// the server returns STUN + an ephemeral TURN credential; for LAN (no token) it
// returns STUN only. On any failure we fall back to a public STUN server so a
// direct-only connection can still be attempted.
export async function fetchIceServers(token: string): Promise<RTCIceServer[]> {
  const q = token ? `?room=${encodeURIComponent(token)}` : "";
  const res = await fetch(`/api/ice${q}`, { credentials: "include" });
  if (!res.ok) return [{ urls: "stun:stun.l.google.com:19302" }];
  return (await res.json()).iceServers as RTCIceServer[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/ice.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
cd web && npm run check
git add web/src/lib/ice.ts web/src/lib/ice.test.ts
git commit -m "feat(web): ice module — fetch ICE servers (STUN + ephemeral TURN)"
```

---

### Task 5: Pass fetched ICE servers into `connect()`

**Files:**
- Modify: `web/src/App.svelte`

**Interfaces:**
- Consumes: `fetchIceServers` (Task 4); the existing `roomToken` state (②a) and `connect()` whose `opts.config?: RtcConfig` already exists in `webrtc.ts`.

- [ ] **Step 1: Import and add an iceServers local**

In `web/src/App.svelte`, add to the imports:

```ts
  import { fetchIceServers } from "./lib/ice";
```

Add a non-reactive local near the other `let signaling: SignalingClient;` declarations (a safe STUN default so a transfer started before the fetch resolves still works):

```ts
  let iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
```

- [ ] **Step 2: Fetch the servers in onMount**

In `onMount`, after `roomToken = parseTransferToken(location.hash);` and before/after the `SignalingClient` is created, add:

```ts
    iceServers = await fetchIceServers(roomToken);
```

- [ ] **Step 3: Pass config to both connect() call sites**

In the RECEIVE path, change the `connect({...})` call to include `config`:

```ts
    const conn: Conn = await connect({
      signaling, peerId: from, selfKey: selfKey.publicKey, role: "responder",
      initialSignal: offer,
      onPeerKey: async (pk) => { keys = await deriveSession("responder", selfKey, pk); sasCode = sas(selfKey.publicKey, pk); },
      config: { iceServers },
    });
```

In the SEND path, change the `connect({...})` call to include `config`:

```ts
      conn = await connect({
        signaling, peerId, selfKey: selfKey.publicKey, role: "initiator",
        onPeerKey: async (pk) => { keys = await deriveSession("initiator", selfKey, pk); sasCode = sas(selfKey.publicKey, pk); },
        config: { iceServers },
      });
```

- [ ] **Step 4: Verify check, tests, build**

Run: `cd web && npm run check && npx vitest run && npm run build`
Expected: check 0 errors; tests PASS; build OK.

- [ ] **Step 5: Commit**

```bash
git add web/src/App.svelte
git commit -m "feat(web): use server-provided ICE servers (STUN+TURN) for transfers"
```

---

### Task 6: coturn deployment + manual acceptance docs

**Files:**
- Create: `docs/coturn.md`
- Modify: `docs/TESTING.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Write the coturn operations note**

Create `docs/coturn.md`:

```markdown
# Self-hosted coturn (TURN relay for cross-network transfers)

Relayium uses TURN only as a fallback when direct P2P (STUN hole-punching)
fails. The Go server mints ephemeral credentials with the coturn TURN REST
mechanism; coturn validates them against a shared secret with no per-credential
state.

## Minimal coturn config (`/etc/turnserver.conf`)

```
use-auth-secret
static-auth-secret=<SAME VALUE AS the server's -turn-secret>
realm=relayium.app
listening-port=3478
tls-listening-port=5349
# TLS for clients behind restrictive egress (turns:):
cert=/etc/letsencrypt/live/turn.relayium.app/fullchain.pem
pkey=/etc/letsencrypt/live/turn.relayium.app/privkey.pem
# Relay port range — open these in the firewall:
min-port=49152
max-port=65535
fingerprint
no-multicast-peers
```

## Run the Go server pointing at it

```
relayium \
  -turn-secret '<SAME VALUE AS static-auth-secret>' \
  -turn-urls 'turn:turn.relayium.app:3478,turns:turn.relayium.app:5349' \
  -stun-urls 'stun:turn.relayium.app:3478'
```

If `-turn-secret` is empty, TURN is disabled and the app uses STUN only
(cross-network still works for easy NATs).

## Firewall

Open UDP/TCP 3478, TCP 5349 (TLS), and the UDP relay range (min-port..max-port).

## Security notes

- Credentials are short-lived (1h) and HMAC-signed; coturn reads the expiry from
  the username and rejects expired ones.
- coturn relays only the DTLS-encrypted WebRTC stream — it never sees plaintext.
```

- [ ] **Step 2: Add the manual acceptance section**

Append to `docs/TESTING.md`:

```markdown
## Cross-network TURN relay (②b-1)

Prerequisites: a running coturn (see `docs/coturn.md`) and the Go server started
with matching `-turn-secret` / `-turn-urls`.

1. **STUN-only regression (no TURN configured):** start the server WITHOUT
   `-turn-secret`. `GET /api/ice?room=<valid token>` returns STUN only; an
   easy-NAT cross-network transfer still works (②a behavior).
2. **Credentials served:** with TURN configured, sign in, mint a link, and in
   the browser devtools confirm `GET /api/ice?room=<token>` returns a `turn:`
   entry with a `username` (`<expiry>:<token>`) and a `credential`. The
   login-free receiver opening the link gets the same TURN entry.
3. **Forced-relay transfer:** to prove the coturn path end-to-end, temporarily
   set `iceTransportPolicy: "relay"` in `RTCPeerConnection` (or test between two
   genuinely symmetric-NAT networks). Complete a transfer; confirm SAS matches
   and the per-file SHA-256 integrity check passes — proving relayed bytes are
   still end-to-end encrypted.
4. **Expiry:** an `/api/ice` credential older than the TTL is rejected by coturn
   (the relay allocation fails); a fresh link/credential succeeds.
```

- [ ] **Step 3: Commit**

```bash
git add docs/coturn.md docs/TESTING.md
git commit -m "docs: coturn deployment guide + TURN manual acceptance steps"
```

---

## Self-Review

**1. Spec coverage:**
- Ephemeral HMAC-SHA1 credential (coturn TURN-REST) → Task 1. ✅
- Token-gated `GET /api/ice`, always-200, STUN-always, TURN-when-valid-token+secret, no leak → Task 2. ✅
- Graceful STUN-only when no secret → Task 2 (`TURNSecret != ""` guard) + Task 3 default empty + Task 6 doc. ✅
- `now`-injected expiry → Task 2 (`s.now().Add(TURNCredTTL)`). ✅
- Config flags `-turn-secret/-turn-urls/-stun-urls` → Task 3. ✅
- Client `fetchIceServers` (token/no-token, non-ok fallback) → Task 4. ✅
- App passes `config.iceServers` to both connect sites; LAN ⇒ STUN-only ⇒ unchanged → Task 5. ✅
- Receiver (login-free) gets TURN via token-bearer auth → enforced by Task 2 (not `RequireSession`) + Task 4 fetch. ✅
- E2E/SAS/crypto untouched → no task touches `crypto.ts`/`transfer.ts`/`webrtc.ts`. ✅
- coturn deployment note + manual acceptance → Task 6. ✅
- Deferred (metering ②b-2, trusted-device ②c) → stated in header; no task implements them. ✅

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; every command shows expected output. ✅

**3. Type consistency:** `ICEServer{URLs,Username,Credential}` used identically in Tasks 1–2. `turnCredentials(secret,token,expiry,urls)` consistent Tasks 1–2. `Config.STUNURLs/TURNURLs/TURNSecret/TURNCredTTL` defined in Task 2, set in Task 3, read in Task 2's handler. `fetchIceServers(token)` consistent Tasks 4–5. `/api/ice` response shape `{iceServers: ICEServer[]}` consistent across Tasks 2, 4. ✅
