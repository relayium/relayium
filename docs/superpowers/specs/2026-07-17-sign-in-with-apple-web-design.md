# Sign in with Apple — Web + Native Activation

Date: 2026-07-17
Status: Design approved, pending spec review

## Goal

Turn on the dormant Sign in with Apple (SiwA) support now that an Apple
developer account exists. Ship **both** surfaces in a single PR, each gated by
the existing `EnableApple` switch so they can be activated by configuration
alone:

- **Native app** (iOS/macOS) — already implemented and tested in
  `server/internal/account/apple.go`; only needs configuration to activate.
- **Web** ("Sign in with Apple" button on relayium.com) — new work, modeled on
  the existing Google web OAuth flow (`server/internal/account/oauth.go`).

## Secret-handling principle (open-source repo)

The repository is public. No secret, and no real identifier, is ever committed
or pasted into a chat transcript.

- All Apple config is read from environment variables / file paths, exactly
  like the existing `RELAYIUM_APPLE_*` and `RELAYIUM_GOOGLE_*` config.
- The `.p8` signing key lives **only on the production host**, referenced by a
  file-path env var. The code never contains the key, a placeholder value, or a
  path with a real key in it.
- The author (Claude) never needs to see the private key. The read logic is
  written generically; the operator places the `.p8` on the host out of band.

## Current state (already shipped, commit dce06b0 / 2b7b706 / 0d7700e)

- `verifyAppleIDToken(ctx, idToken, expectedNonce)` — RS256 verification against
  Apple's JWKS (`appleKeyStore`), then `iss` / `aud`-allowlist / `exp` / nonce
  checks. Reusable by both native and web flows.
- `POST /api/auth/apple/native` (`handleAppleNative`) — native token exchange,
  gated behind `EnableApple` (default off → 404).
- Config: `EnableApple`, `AppleClientIDs` (aud allowlist),
  `AppleAppIDs` (Universal Links AASA).
- `wellknown.go` serves `/.well-known/apple-app-site-association` from
  `AppleAppIDs` (dormant → 404 when unset).
- `csrfGuard` rejects any non-GET whose `Origin` header is cross-origin.
- Google web OAuth (`oauth.go`): `handleGoogleStart` → state cookie → redirect;
  `handleGoogleCallback` (GET) → exchange → `UpsertUserByEmail` → frozen guard →
  `LinkIdentity` → `IssueSession` → `setSessionCookie`. This is the template.

## New configuration

All added to `Service.Config` and wired in `main.go` (env + flag, matching the
existing style). Repo carries only empty defaults.

| Env var | Field | Meaning | Secret |
|---|---|---|---|
| `RELAYIUM_APPLE_SERVICES_ID` | `AppleServicesID` | Web client_id (Services ID); also belongs in the aud allowlist | no |
| `RELAYIUM_APPLE_TEAM_ID` | `AppleTeamID` | Apple Team ID (client_secret `iss`) | no |
| `RELAYIUM_APPLE_KEY_ID` | `AppleKeyID` | Key ID of the `.p8` (client_secret JWT header `kid`) | no |
| `RELAYIUM_APPLE_PRIVATE_KEY_FILE` | `ApplePrivateKeyFile` | Path to the `.p8` (e.g. `/etc/relayium/apple_signin.p8`, chmod 600) | **yes, prod host only** |
| `RELAYIUM_APPLE_CLIENT_IDS` | `AppleClientIDs` | aud allowlist: Bundle ID (native) + Services ID (web) | no |
| `RELAYIUM_APPLE_DOMAIN_ASSOC_FILE` | `AppleDomainAssocFile` | Path to Apple's domain-association `.txt` | no |

Derived (not configured directly):

- `AppleRedirect = baseURL + "/api/auth/apple/web/callback"` (mirrors
  `GoogleRedirect`).

Gating:

- Native web routes register when `EnableApple` is true (unchanged).
- **Web** routes register only when `EnableApple` is true **and** the web
  material is present (`AppleServicesID`, `AppleTeamID`, `AppleKeyID`, and a
  readable `ApplePrivateKeyFile`). A half-configured web flow must not register
  routes that would 500.
- Startup parses the `.p8` **fail-fast**: if `EnableApple` + Services ID are set
  but the key file is missing/unparseable, the server logs and exits rather than
  booting a broken web-login button.

## Web flow — new file `server/internal/account/apple_web.go`

### 1. client_secret (ES256 JWT signed with the `.p8`)

Apple's OAuth `client_secret` is not a static string; it is a short-lived JWT
signed with the `.p8` (an EC P-256 / ES256 key).

- Parse the `.p8` (PKCS#8 EC private key) once at startup into an
  `*ecdsa.PrivateKey`.
- `appleClientSecret()` builds and signs the JWT:
  - header: `{ "alg": "ES256", "kid": AppleKeyID }`
  - claims: `{ iss: AppleTeamID, iat: now, exp: now+~30m, aud: "https://appleid.apple.com", sub: AppleServicesID }`
  - signature: ES256 (P-256 ECDSA over SHA-256), encoded as raw `r || s` (JOSE
    P1363, 64 bytes), base64url — **not** ASN.1 DER.
- Cache the signed token and regenerate a few minutes before `exp`. Apple caps
  `exp` at 6 months; a short 30-minute window keeps blast radius small and is
  cheap to regenerate.
- Signing is hand-rolled (~30 lines) using `crypto/ecdsa` + `crypto/sha256`,
  consistent with the existing hand-written Apple JWT **verification** — no new
  JWT dependency.

### 2. `GET /api/auth/apple/web/start` — `handleAppleWebStart`

- Generate `state` and `nonce` (via `randToken()`), store both in short-lived
  HttpOnly cookies (reuse the `oauthStateCookie` pattern; add an
  `oauthNonceCookie`).
- Redirect to `https://appleid.apple.com/auth/authorize` with:
  `response_type=code`, `response_mode=form_post`, `client_id=AppleServicesID`,
  `redirect_uri=AppleRedirect`, `scope="name email"`, `state`, `nonce`.
- `response_mode=form_post` is required by Apple whenever `name`/`email` scope is
  requested — the callback arrives as a POST.

### 3. `POST /api/auth/apple/web/callback` — `handleAppleWebCallback`

Apple posts an `application/x-www-form-urlencoded` body:
`code`, `state`, optional `user` (JSON, **first authorization only**, carrying
`name`), optional `error`.

Steps:

1. Verify the `state` cookie matches the posted `state`; mismatch → redirect
   `/?login=error`.
2. Exchange `code` at `https://appleid.apple.com/auth/token` (POST form:
   `grant_type=authorization_code`, `code`, `redirect_uri`,
   `client_id=AppleServicesID`, `client_secret=appleClientSecret()`). Response
   carries an `id_token`.
3. Verify the `id_token` with the existing `verifyAppleIDToken(..., nonceFromCookie)`
   — reuses signature/iss/aud/exp/nonce checks. `AppleServicesID` must be in the
   aud allowlist for this to pass.
4. Resolve the account exactly like `handleAppleNative`: `GetUserByIdentity("apple", sub)`
   first; on first sign-in require `claims.Email`, then `UpsertUserByEmail(email, name)`
   where `name` comes from the `user` form field (first auth only).
5. Frozen-account guard (mirror `handleGoogleCallback` / `frozenBlocked`): a
   pending-deletion account is redirected to `/?account=pending_deletion&token=…`,
   never issued a session.
6. `LinkIdentity("apple", sub, u.ID)`; `SetEmailVerified` when
   `claims.EmailVerified`; `IssueSession`; `setSessionCookie`; redirect `/`.

### 4. CSRF exemption

The callback is a legitimate cross-site POST from `appleid.apple.com`, which
`csrfGuard` would reject on the `Origin` header. The `state` cookie+param
provides equivalent CSRF protection, so the Apple web callback is registered
**outside** the `csrfGuard`-wrapped mux (or explicitly path-exempted in
`csrfGuard`). No other endpoint's protection changes.

## Domain verification — `wellknown.go`

- Serve `GET /.well-known/apple-developer-domain-association.txt` with the file
  contents from `AppleDomainAssocFile`.
- Dormant when unset or unreadable → 404, matching the AASA handler's
  publish-nothing-when-unconfigured style.
- Read the file at startup (or per-request with a small cache); serve as
  `text/plain`, no redirect (Apple's fetcher requires a direct 200).

## Web UI

- Add a "Sign in with Apple" button alongside the existing Google button in the
  login surface. It performs a full-page navigation to
  `/api/auth/apple/web/start` (same mechanism as Google's start redirect).
- Show it only when `GET /api/auth/methods` reports `apple: true`.
- Styling follows Apple's Human Interface brand guidelines: black button, Apple
  logo, localized "Sign in with Apple" label across all 9 locales
  (en/zh/de/fr/ja/ko/es/pt/ar), with RTL handled by the existing logical-property
  mechanism.

## Native activation

No new code. Activated by configuration:

- `RELAYIUM_ENABLE_APPLE=true`
- Bundle ID added to `RELAYIUM_APPLE_CLIENT_IDS`.

## Testing

- `appleClientSecret`: header/claims shape; ES256 signature verifies against the
  derived public key; `exp` window; cache regeneration near expiry.
- Web callback: state mismatch rejected; nonce binding enforced (reuses
  `verifyAppleIDToken` tests); name captured from `user` on first auth; frozen
  account redirected to pending-deletion, not sessioned; happy path issues a
  session cookie.
- `.p8` parsing: valid key parses; malformed key fails startup fast.
- Domain-association handler: 404 when unset; serves file bytes as text/plain
  when set (dormant ↔ enabled flip).
- Route registration: web routes absent when web material incomplete even if
  `EnableApple` is true.
- Full Go suite + web `svelte-check` + web tests green; routes smoke-tested
  through the dormant↔enabled flip.

## Out of scope (YAGNI)

- Apple server-to-server notifications webhook (account revoke / email change).
  Deferred; not needed for login to work.
- APNs push (separate `.p8`, unrelated to login).
- Refresh-token storage — a session is issued at login; Apple refresh tokens are
  not needed for our session model.
