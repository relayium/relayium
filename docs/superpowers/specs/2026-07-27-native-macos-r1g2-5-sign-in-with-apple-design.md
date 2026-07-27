# Native macOS R1-G2.5 — Sign in with Apple — design

A short round between G2 and G3. The first draft of this spec designed the
native `ASAuthorizationController` flow. **That flow is unavailable to a
Developer ID app**, established by testing rather than by reading docs. What
follows is the roadblock sign, and then the design that replaces it.

## Why the native flow is unavailable

Recorded in full because everything about it looks like it should work, and the
next person to reach for `ASAuthorizationController` will need to be stopped by
evidence rather than by an assertion.

1. **The portal accepts the capability.** Sign in with Apple was enabled on the
   App ID `com.relayium.mac` and correctly grouped under `com.relayium.app` as
   primary — the same primary the `com.relayium.web` Services ID uses. The portal
   reports success.
2. **Developer ID profiles never carry the entitlement.** The `Relayium Mac`
   provisioning profile was regenerated **three times** after enabling the
   capability. None of them contained `com.apple.developer.applesignin`.
3. **A binary signed with it is killed at launch.** A probe app signed with the
   entitlement was terminated by `taskgated` with `Unsatisfied entitlements:
   com.apple.developer.applesignin`. Embedding the freshly generated profile
   changed nothing.
4. **The same App ID works for development signing.** Xcode's automatically
   managed *development* profile for `com.relayium.mac` **does** contain
   `applesignin`, which proves the App ID's server-side provisioning is correct
   and rules out a portal mistake.
5. **Apple's backend refuses outright.** `xcodebuild -exportArchive` with
   `method=developer-id` fails with *Cannot create a Developer ID provisioning
   profile*.

The conclusion is not "we configured it wrong". Apple does not issue Developer ID
provisioning profiles carrying `com.apple.developer.applesignin`, so a macOS app
distributed outside the App Store cannot use native Sign in with Apple. The
entitlement is reachable only through development signing or App Store /
TestFlight distribution.

**What this does not block:** the native endpoint `POST /api/auth/apple/native`
stays as it is, dormant and correct. It becomes usable the day an iOS build ships
through the App Store, which is R3. Nothing about it is deleted or changed.

## Background

G1 deferred Sign in with Apple to "the first sub-round that has a Team ID"
(`2026-07-26-native-macos-r1g1-app-shell-account-design.md:55-57`). G2 declined
it because the entitlement work would reopen the App ID, the profile and a CI
secret inside a round about transfer UI. This round exists to pay that cost —
and the finding above is that the cost cannot be paid at all on this
distribution channel, so the round changes shape rather than being cancelled:
the user still gets a Sign in with Apple button, reached through the browser.

## What the server already does

Verified by reading the code and by read-only checks against production.

**The web flow is live.** `GET /api/auth/apple/web/start` returns 302 to
`appleid.apple.com` with `client_id=com.relayium.web`, so the Services ID is
`com.relayium.web` and web Sign in with Apple is configured, not merely enabled.
`GET /api/auth/methods` reports `{"apple":true,…}`.

**Web and native resolve the same user.** Both call
`GetUserByIdentity("apple", claims.Sub)` and `LinkIdentity("apple", claims.Sub, …)`
— `apple_web.go:126,154` and `apple.go:154,174`. There is no separate native
user table and no merge step. Because `com.relayium.mac` is grouped under the
same primary App ID as the `com.relayium.web` Services ID, Apple issues the same
`sub` to both, which is what the acceptance criterion rests on.

**The web callback ends in a cookie, not a token.** `handleAppleWebCallback`
finishes with `IssueSession` → `setSessionCookie` → redirect to `/`
(`apple_web.go:173-178`). This is the fact that shapes the whole design: a
browser-delegated login produces a *web session*, and the Mac app needs an
`rlm_cli_` bearer. Something has to convert one into the other.

**Something already does.** The CLI device-authorization flow exists and is
mounted today:

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/cli/device/start` | none, rate-limited | → `{user_code, device_code, verification_uri, interval, expires_in}` |
| `GET /device?code=…` | cookie optional | approval page; `?code=` prefills and auto-loads details |
| `POST /api/cli/device/approve` | `RequireSession` | mints `rlm_cli_` + device row, stashes it for one pickup |
| `POST /api/cli/device/poll` | none | → `authorization_pending` / `denied` / `expired`, or `{status:"ok", access_token, account_email}` |

`verification_uri` is `BaseURL + "/device"` (`deviceauth.go:78`). The token is
handed out exactly once — `ConsumeDeviceAuth` blanks it in the same atomic
transition (`deviceauth.go:125-126`). The approval page shows the requesting IP
and user agent so a phished user has something to notice, and warns in as many
words that approving grants full account access.

## The design

**The app delegates the whole login to the browser and collects a bearer through
the device-authorization flow.** No new server code, and the bearer never travels
in a URL.

```
app: POST /api/cli/device/start            → user_code, device_code, interval
app: open  https://relayium.com/device?code=<user_code>   in ASWebAuthenticationSession
user: signs in — Apple, password, whatever the web offers — and approves
app: POST /api/cli/device/poll (device_code) every `interval`
     → {status:"ok", access_token:"rlm_cli_…"}
app: hands the token to AccountSession exactly as a password login would
```

The Apple button the user presses is the **web** one, on relayium.com's login
page. This round adds no Apple-specific client code at all: it adds a browser
login path, and Sign in with Apple arrives with it, along with every other method
the web supports now or later.

### Why not a custom `relayium://` callback

`ASWebAuthenticationSession` is built around a callback scheme, so it is the
obvious shape and it is the wrong one here:

- **It needs server work this round otherwise does not.** Nothing today mints a
  bearer at the end of the web flow; a callback design requires a new endpoint
  that does, plus a redirect target.
- **It puts a bearer in a URL.** Query strings reach shell history, crash logs
  and screen recordings, and this bearer never expires (`cli_tokens` has no
  expiry column). The device flow delivers the same token in a TLS POST body.
- **Custom schemes are not owned on macOS.** Any application can register
  `relayium://`. `ASWebAuthenticationSession` scopes delivery to the initiating
  session, which mitigates it, but the mitigation is the API's rather than ours,
  and the device flow does not need it.

The device flow also inherits protections already built and reviewed: the
approval page's phishing warning, the origin display, and the rate limit on
`start`.

### How the session is presented and dismissed

`ASWebAuthenticationSession` is still the right container, for two reasons that
have nothing to do with callbacks: it presents in-app rather than yanking the
user into Safari, and with `prefersEphemeralWebBrowserSession = false` it shares
Safari's cookie jar, so a user already signed into relayium.com approves in one
click instead of signing in again.

It is initialized with a callback scheme that is never reached. The app dismisses
the sheet itself by calling `cancel()` the moment polling returns a token. The
spec says this plainly because it reads like a bug otherwise: the session is a
browser window with a Done button, not a callback pipeline.

**If the user closes the sheet**, polling keeps running until `expires_in`
elapses. The app stops polling when the sheet is dismissed without a token and
reports nothing — a closed sheet is a cancelled login, not a failure.

### Where the code lives

Following G1's split, and reusing what G2 built:

- **Kit** — `DeviceAuthClient` in `RelayiumKit/Account`: `start()`, `poll(deviceCode:)`,
  modelling the four poll outcomes as an enum. Pure networking, fully testable,
  and platform-neutral so R3's iOS build gets it free.
- **AppKit** — `BrowserLoginModel`: drives start → poll loop → outcome, with the
  same operation-identity guard `AccountSession` and both G2 models use. Owns the
  polling `Task` and cancellation.
- **App target** — the `ASWebAuthenticationSession` presentation and its
  presentation anchor, which need a window and are therefore the only untestable
  part. Kept to opening and dismissing.
- **`AccountSession.adoptBearer(_:)`** — accepts a token obtained out of band,
  persists it to the keychain, loads `/api/me` and `/api/me/usage`, and lands in
  `.ready`. This is the one new session entry point; every existing transition,
  including the frozen-account and superseded-callback paths, is reused
  unchanged.

### Sign-out and credential revocation

Sign-out is unchanged: clear the keychain, drop the in-memory token.

**Apple credential revocation cannot be observed by this app, and that is a
consequence of the pivot worth stating.** `ASAuthorizationAppleIDProvider.getCredentialState`
requires the Apple user identifier, which only the native flow returns; a
browser-delegated login never sees it. Revoking the app under Apple Account
settings therefore has no effect on an already-signed-in Mac app.

The exposure is the same one the round would have had anyway: native sign-out
revokes nothing server-side, because `issueBearer` mints a fresh device row per
login and `DELETE /api/devices/{id}` is session-only
(`server/account/handlers.go:139`) — the debt recorded in G1's handoff
(`a50876a5`) and still open. Either way the only revocation route is the web
devices page, which does work: deleting the device cascade-deletes its token.

## Scope

**In:** `DeviceAuthClient`, `BrowserLoginModel`, `AccountSession.adoptBearer`,
the `ASWebAuthenticationSession` presentation, a "Sign in with browser" button on
the login screen, and error copy for the flow's failure modes.

**Out:**

- **Native `ASAuthorizationController`** — unavailable, see above. The server
  endpoint stays dormant for R3's App Store build.
- **Server changes.** None. This round writes no Go.
- **Portal and CI changes.** None remain — see below.
- **An in-app Apple button.** The Apple button lives on the web login page. A
  native button that opens a browser would be a lie about what it does.

## Operations and portal changes

**All portal work is done, and none of it is needed any more.** Recorded because
the state exists and the next round should not redo it:

- Sign in with Apple is enabled on `com.relayium.mac`, grouped under
  `com.relayium.app` as primary, matching the `com.relayium.web` Services ID's
  primary. Harmless and correct; it simply cannot be expressed in a Developer ID
  profile.
- The provisioning profile does **not** need regenerating, `Relayium.entitlements`
  does **not** gain `com.apple.developer.applesignin` — a binary carrying it is
  killed at launch — and `MACOS_PROVISIONING_PROFILE_BASE64` does **not** need
  rotating. The G1.5 profile stands unchanged.
- `RELAYIUM_APPLE_CLIENT_IDS` does **not** need `com.relayium.mac`. The `aud` in
  play is the Services ID `com.relayium.web`, already allowlisted. Add the bundle
  ID when R3 ships an App Store build that uses the native endpoint.
- `RELAYIUM_ENABLE_APPLE` is already `true` in production.

Two corrections to how the round was originally framed, both checked rather than
assumed: there is no `deploy/config-manifest` line for any of this — that
manifest covers nginx, the systemd unit and logrotate, while `RELAYIUM_*` values
live in a host-local `.env` (`docs/DEPLOYMENT.md`) — and nothing needs enabling
because Apple is already on.

**So this round's operational footprint is zero.** No portal step, no secret
rotation, no host edit, no deploy.

## Error handling

`ErrorCopy` gains the device flow's outcomes:

- `denied` — the user pressed Deny on the approval page. Say that, and offer to
  start over.
- `expired` — the code timed out. Same, without implying anything went wrong.
- A poll that keeps returning `authorization_pending` until expiry is the same
  thing as expired; there is no separate state to report.

Closing the sheet renders nothing, as with `ASAuthorizationError.canceled` in the
abandoned design: a user who changed their mind has not failed at anything.

## Testing

**Unit (`swift test`):** `DeviceAuthClient` decodes all four poll outcomes,
including the success body's `access_token`; `BrowserLoginModel` drives
start → pending → ok, stops on `denied` and `expired`, honours cancellation
mid-poll, and ignores a superseded callback; `AccountSession.adoptBearer` reaches
`.ready` and persists to the keychain, and handles a frozen account the same way
the password path does; `ErrorCopy` covers denied and expired.

`ASWebAuthenticationSession` is not unit-testable — it needs a window and a live
browser. The app-target code is therefore kept to presentation only.

**Manual acceptance**, with the first item unchanged from the original spec
because the criterion did not change:

1. **Sign into the web with Apple. Then sign into the Mac app through the browser
   flow with the same Apple ID. The app must show that account's files and
   usage** — not an empty account. A second account here means the App ID
   grouping is wrong, and nothing else reports it.
2. A user already signed into relayium.com in Safari approves in one click,
   without re-authenticating.
3. Sign in with a password account through the same flow — the button is not
   Apple-specific and must work for every method the web offers.
4. Press Deny on the approval page; the app reports it and offers to retry.
5. Close the sheet without approving; nothing is reported and the login screen
   stays usable.
6. Quit and relaunch after a browser sign-in; auto-login works, proving the
   adopted bearer reached the keychain exactly as a password login's does.

## Done when

- `swift test` passes with 0 failures.
- CI is green with the **unchanged** G1.5 profile — this round must not perturb
  the signing configuration at all.
- All six manual acceptance items pass, item 1 above all.
- No server, portal, CI-secret or host change was required to make it work.

## Open questions

**The device flow shows a code.** The user sees `/device?code=WDJB-MJHT`
prefilled and presses Approve; they never type it, but they do see a screen whose
copy was written for someone at a terminal ("Confirm the code shown in your
terminal", `devicepage.go:53`). It is accurate for the CLI and slightly wrong for
an app that just opened the page itself. Rewording it is a web change in a round
that otherwise touches nothing — flagged rather than assumed either way.

**The abandoned native path leaves the nonce question unanswered.** The native
endpoint compares the token's `nonce` claim against a value from the same request
body (`apple.go:116,149`), so it is not replay protection the way the web flow's
cookie-bound nonce is (`apple_web.go:57,67`). It is dormant, so nothing is
exposed today — but R3 will make it reachable, and that is the round that has to
resolve it.

## Non-goals

Native `ASAuthorizationController`, account-linking UI, iOS, server changes, the
native sign-out revocation debt (`a50876a5`), and Universal Links (G4).
