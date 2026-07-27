# Native macOS R1-G2.5 — Sign in with Apple — design

A short round between G2 and G3. The server side has been built and dormant
since the web flow shipped; this wires the button, and pays the signing-config
cost G2 refused to carry inside a transfer round.

## Background

G1 deferred Sign in with Apple to "the first sub-round that has a Team ID"
(`2026-07-26-native-macos-r1g1-app-shell-account-design.md:55-57`). G2 declined
it for a concrete reason rather than taste: the `com.apple.developer.applesignin`
entitlement must be carried by the provisioning profile, and adding it reopens
the App ID, the profile and a CI secret — signing work inside a round about
transfer UI, where its failures would present as UI bugs
(`…r1g2-cloud-transfer-ui-design.md`, Non-goals).

That is exactly what this round is for.

## What the server already does

Verified by reading the code and by two read-only checks against production.

`POST /api/auth/apple/native` (`server/account/apple.go:139`), mounted only when
`EnableApple` is set (`server/account/handlers.go:113-114`).

**Request** — JSON, body capped at 16 KiB:

```json
{ "idToken": "<Apple identity token>", "nonce": "<the nonce string>", "name": "<display name>" }
```

**Verification** (`apple.go:50`): RS256 against Apple's JWKS for the token's
`kid`, then `iss == https://appleid.apple.com`, `aud ∈ cfg.AppleClientIDs`,
`exp > now`, non-empty `sub`, and — only when the request supplied one — a nonce
equal to the token's.

**Resolution** (`apple.go:154`): look the user up by `("apple", sub)`. If absent,
this is the first authorization, which is the only time Apple sends the email; a
request without one is refused with 400 `{"error":"no_email_first_signin"}`.
Otherwise the account is created or matched by email, the identity is linked, and
if Apple reports the email verified, any password planted on that address while
unverified is dropped before the account is marked verified — the same
pre-hijack defense `oauth.go` uses.

**Responses:**

| Case | Status | Body |
|---|---|---|
| Success | 200 | `{token, user{id, email, displayName, hasPassword, emailVerified, linkedMethods}}` |
| Bad or unverifiable token | 401 | `{"error":"invalid_token"}` |
| First sign-in with no email | 400 | `{"error":"no_email_first_signin"}` |
| Account scheduled for deletion | 200 | `{"status":"pending_deletion", "purgeAfter", "reactivateToken"}` |

The success body comes from `finishNativeLogin` (`server/account/native.go:89`) —
the same function the password login returns through, so the shape the app
already decodes is unchanged. The frozen-account body is the shape
`AccountSession` already handles as `.pendingDeletion`.

**Production state**, checked read-only:

- `GET /api/auth/methods` → `{"apple":true,"google":false,"magic":false,"password":true}`.
  `EnableApple` is already on; **nothing has to be turned on to make the native
  endpoint exist.**
- `GET /api/auth/apple/web/start` → 302 to `appleid.apple.com` with
  `client_id=com.relayium.web`. So the **web Services ID is `com.relayium.web`**,
  and the web flow is fully configured and live, not merely enabled.

## The one thing that decides whether this works

Web and native resolve the user through the **same** identity row: both call
`GetUserByIdentity("apple", claims.Sub)` and `LinkIdentity("apple", claims.Sub, …)`
— `apple.go:154,174` for native, `apple_web.go:126,154` for web. There is no
separate native user table and no merge step to write.

So the acceptance criterion — *a user who signed into the web with Apple must
land on that same account in the Mac app* — reduces entirely to one question:

**Does Apple issue the same `sub` to `com.relayium.mac` that it issues to the
`com.relayium.web` Services ID?**

Apple scopes that identifier to a *primary App ID*, not to the team. A Services
ID is configured against a primary App ID, and an App ID enabling Sign in with
Apple either becomes its own primary or is **grouped with** an existing one. If
`com.relayium.mac` is enabled as its own primary, Apple mints a different `sub`
for the same human, `GetUserByIdentity` misses, and the flow proceeds to create
a *second account* by email — silently, with no error to notice.

That is the failure this round has to design against, and it is a portal setting,
not code. See the operations checklist.

## Scope

**In:**

- `Sign in with Apple` button on the login screen, and the `ASAuthorizationController`
  flow behind it.
- A Kit client that posts the identity token and decodes the existing outcome.
- `AccountSession.logInWithApple(...)`, reusing the state machine unchanged.
- Credential-revocation handling: a revoked Apple credential signs the app out.
- The entitlement, the regenerated profile, and the CI secret rotation.

**Out:**

- **iOS.** The Kit client and the session method are platform-neutral and R3
  reuses them; the button and the delegate are macOS-only this round.
- **Account linking UI.** A user with a password account who signs in with the
  same Apple email gets linked by the server's existing rules. Surfacing "you now
  have two ways to sign in" is an account-screen feature, not a login one.
- **Server changes.** None are needed, and this round writes no Go.

## Native flow

The split follows G1's: everything testable in `RelayiumAppKit`, and only what
needs a window in the app target. `ASAuthorizationController` needs a
presentation anchor, so its delegate is app-target code; nothing else is.

**App target** — `AppleSignInButton` in `LoginView`, under the password form:

1. Generate a random raw nonce. Set `request.nonce` to its **SHA-256 hex**, which
   is what Apple embeds in the token's `nonce` claim.
2. `ASAuthorizationAppleIDProvider().createRequest()`, scopes `[.fullName, .email]`.
3. On success, read `identityToken` (Data → UTF-8) and format `fullName`.
4. Hand `(idToken, nonce, name)` to the session.

**The nonce sent to the server is the hashed string**, not the raw one — the
server compares it against the token's claim verbatim (`apple.go:116`), and the
claim holds whatever was set on the request. Sending the raw nonce fails every
sign-in with `invalid_token`, which looks like a signing problem and is not.

**Kit** — `AppleSignInClient.signIn(idToken:nonce:name:) async throws -> LoginOutcome`,
decoding the same three outcomes `AccountClient` already models
(`success` / `pendingDeletion` / the error cases). `emailUnverified` cannot occur
here: Apple's flow either verifies the address or the account was already
resolved by `sub`.

**Session** — `AccountSession.logInWithApple(idToken:nonce:name:)` runs the same
operation-identity guard, the same keychain persistence, and the same state
transitions as `logIn(email:password:)`. Nothing about `SessionState` changes,
which is the point: the app's login screen gains a second button, not a second
notion of being signed in.

## Credential revocation

A user can revoke the app in **Settings → Apple Account → Sign in with Apple**.
The app should not keep acting signed in afterwards.

`ASAuthorizationAppleIDProvider.getCredentialState(forUserID:)` answers this, and
it needs the Apple user identifier — the `sub`. The app does not store it today.
This round persists it beside the session (`UserDefaults`, not the keychain: it
is an identifier, not a credential) and checks it on launch and on
`credentialRevokedNotification`, signing out locally on `.revoked` or `.notFound`.

**Local sign-out is all this can do**, and the reason is a debt this round does
not pay: native sign-out revokes nothing server-side, because `issueBearer`
mints a fresh device row per login and `DELETE /api/devices/{id}` is
session-only (`server/account/handlers.go:139`). Recorded in G1's handoff
(`a50876a5`), still open, and still out of scope here — but it means a revoked
Apple credential leaves a live bearer token that only the web devices page can
kill. The round states this rather than implying revocation is complete.

## Operations and portal changes

Two of these differ from what the round's brief assumed, so they are spelled out
exactly.

**1. App ID capability — the step the acceptance criterion depends on.**

Identifiers → App IDs → `com.relayium.mac` → enable **Sign in with Apple** →
**Configure**. Choose **Group with an existing primary App ID**, and pick the
same primary that the `com.relayium.web` Services ID is configured against —
read it first from Identifiers → Services IDs → `com.relayium.web` → Sign in
with Apple → **Configure** → *Primary App ID*.

**Do not choose "Enable as a primary App ID."** That is the default-looking
option and it silently breaks the criterion: same person, different `sub`, second
account created by email, no error anywhere.

**2. Regenerate the provisioning profile.**

The installed `Relayium Mac` profile carries exactly `application-identifier`,
`team-identifier` and `keychain-access-groups` (verified in G1.5). A profile is
a snapshot of the App ID's capabilities at generation time, so it must be
regenerated after step 1 to carry `com.apple.developer.applesignin`.

`keychain-access-groups` needs no special handling: Apple includes it as
`7PVYUG4YQS.*` by default, which is why G1.5 found nothing to configure. Verify
rather than assume:

```bash
security cms -D -i ~/Library/MobileDevice/Provisioning\ Profiles/<uuid>.provisionprofile \
  | plutil -convert xml1 -o - - \
  | grep -A3 -E 'applesignin|keychain-access-groups'
```

Both keys must be present. If `keychain-access-groups` is missing, stop — the
G1.5 keychain work depends on it and installing that profile would break
sign-in persistence.

**3. Rotate the CI secret.**

```bash
base64 -i <new>.provisionprofile | gh secret set MACOS_PROVISIONING_PROFILE_BASE64 --repo relayium/relayium
```

The `signed-build` job installs it before building and then asserts both
entitlements, so a profile missing either fails CI rather than a user.

**4. Entitlements file.**

`apps/mac/Relayium/Relayium.entitlements` gains
`com.apple.developer.applesignin` = `["Default"]`.

**5. Server env — not a repository change.**

`RELAYIUM_APPLE_CLIENT_IDS` is the `aud` allowlist and must gain
`com.relayium.mac`; a macOS native identity token's `aud` is the app's bundle ID.
Without it every native sign-in fails `apple: aud %q not in allowlist`
(`apple.go:105`) — a 401 that looks like a token problem and is a config one.

Two corrections to how the brief framed this:

- **`EnableApple` is already true in production.** There is nothing to turn on.
- **There is no `config-manifest` line for it.** `deploy/config-manifest` covers
  only nginx configs, the systemd unit and logrotate. `RELAYIUM_*` values live in
  a host-local `.env` in the server's working directory, mode 0600, deliberately
  never in the repo (`docs/DEPLOYMENT.md`). So this is a host edit plus a service
  restart, and pushing to relayium-ops will not do it.

The existing operator guide is `docs/deploy/apple-signin.md` in relayium-ops; it
should gain a line recording that the Mac bundle ID joins the allowlist and why.

## Error handling

`ErrorCopy` gains the two failures this endpoint can produce that no existing
case covers:

- `invalid_token` — the token Apple issued was rejected. After a fresh install
  the overwhelmingly likely cause is configuration, not the user, so the copy
  must not tell them to try a different account.
- `no_email_first_signin` — the user hid their email *and* Apple sent none,
  which happens when the account was previously authorized against this App ID
  and then the app was deleted. Apple only sends the email once. The copy has to
  say the actionable thing: revoke the app under Apple Account settings, then
  sign in again.

`ASAuthorizationError.canceled` is not an error and must render nothing — a user
dismissing the sheet has not failed at anything.

## Testing

**Unit (`swift test`):** the nonce is sent hashed, not raw; each server response
shape maps to the right `LoginOutcome`; `AccountSession.logInWithApple` drives the
same transitions as the password path, including the superseded-callback guard;
`ErrorCopy` covers both new failures and cancellation renders nothing.

`ASAuthorizationController` itself is not unit-testable — it needs a window and a
live Apple session. The delegate is therefore kept to translation only: extract
token, format name, hand off. Anything with a decision in it belongs below it.

**Manual acceptance is where this round is actually verified**, and the first
item is the whole point:

1. **Sign into the web with Apple. Then sign into the Mac app with the same
   Apple ID. The app must show that account's files and usage** — not an empty
   account. This is the criterion; a second account here means step 1 of the
   portal checklist was done wrong, and it is silent otherwise.
2. First-ever Apple sign-in (an Apple ID never used with Relayium) creates an
   account and lands signed in.
3. Sign in with "Hide My Email" and confirm the relay address is what the
   account screen shows.
4. Cancel the Apple sheet — no error appears, the form stays usable.
5. Revoke the app under Apple Account settings, return to the app, confirm it
   signs out.
6. Quit and relaunch after an Apple sign-in — auto-login still works, proving the
   regenerated profile did not break the keychain access group.

## Done when

- `swift test` passes with 0 failures.
- CI's `signed-build` is green with the regenerated profile, and its entitlement
  assertions still pass — including `keychain-access-groups`.
- `codesign -d --entitlements -` on the built app reports both
  `com.apple.developer.applesignin` and `7PVYUG4YQS.com.relayium.shared`.
- All six manual acceptance items pass, item 1 above all.
- `RELAYIUM_APPLE_CLIENT_IDS` on the host contains `com.relayium.mac`, confirmed
  by a successful native sign-in rather than by reading the file.

## Open question

**The native nonce is self-asserted.** The server compares the token's `nonce`
claim against the value in the same request body (`apple.go:149` passing
`in.Nonce`), so an attacker replaying a captured identity token simply replays
its nonce alongside. The web flow does not have this shape: it mints the nonce
server-side and binds it through a short-lived cookie (`apple_web.go:57,67`).

The exposure is bounded — Apple identity tokens are short-lived and the exchange
is TLS-only — but the token it buys is a bearer credential that never expires
(`cli_tokens` has no expiry column). Closing it means a server round trip to
issue and store a nonce before the Apple request, which is server work this
round declared out of scope.

Flagged rather than fixed, and flagged here rather than in a commit message
nobody will search: it is a pre-existing property of an endpoint written before
there was a client, and this round is the first to actually use it.

## Non-goals

Account-linking UI, iOS, server changes, the native sign-out revocation debt
(`a50876a5`), and Universal Links (G4).
