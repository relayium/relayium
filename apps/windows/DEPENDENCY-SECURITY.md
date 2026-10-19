# Windows client: dependency security notes

Advisories against this package's dependency tree, what was done about each,
and when the workaround can go. Status as of 2026-10-19.

All three advisories below are in the **packager's** tree (`electron-builder`
26.15.3 → `app-builder-lib`). What is checked, and what that does and does not
establish:

- The affected chains are absent from the packaged runtime closure.
  `electron-builder` packages this package's `dependencies`
  (`libsodium-wrappers`, `qrcode`, and theirs), and none of the packages named
  below is in that closure. `test/unit/dependency-security.test.ts` asserts
  this against the lock. Being marked `dev` in the lock is not, on its own,
  taken as proof of no exposure: build and runtime graphs can share
  unrelated packages, so the check names the packages.
- The bundled application code did not change. When this change was made,
  `npm run build` produced a byte-identical `dist/` (139 files, same SHA-256
  for every file) from the tree before the change and the tree after it.
  That is a measurement of one change, not a standing guarantee.
- Electron's own installer uses `@electron/get` 5.1.0, which contains neither
  of the `@electron/get` 3.1.0 chains.

## GHSA-hp3w-g68c-fv3c — `sprintf-js` <= 1.1.3 (moderate): removed

Route: `@electron/get` 3.1.0 → optional `global-agent` ^3.0.0 → `roarr`
2.15.4 → `sprintf-js` 1.1.3. There is no fixed `sprintf-js` release; the
advisory range covers the latest version.

Fix: `package.json` overrides that one edge:

```json
"overrides": { "@electron/get@3.1.0": { "global-agent": "4.1.3" } }
```

`global-agent` 4.x has no `roarr` dependency, so `roarr` and `sprintf-js`
leave the graph entirely (along with `boolean`, `detect-node`, `es6-error`,
`json-stringify-safe` and `semver-compare`; `matcher`, `serialize-error` and
`type-fest` move to the versions 4.1.3 declares). No other locked version
changes.

Why this is safe for the one place `global-agent` is used — `@electron/get`'s
`initializeProxy()`, which runs `require('global-agent').bootstrap()` only when
`ELECTRON_GET_USE_PROXY` is set (nothing in `electron-builder` or this
repository's workflows sets it, so in practice only an operator's environment
loads it):

- 4.1.3 is CommonJS (`main: ./dist/index.js`) and exports the same
  `bootstrap()`, reading the same `GLOBAL_AGENT_HTTP_PROXY` /
  `GLOBAL_AGENT_HTTPS_PROXY` / `GLOBAL_AGENT_NO_PROXY` variables that
  `initializeProxy()` sets.
- TLS verification stays on: `rejectUnauthorized` is the request's own value,
  else derived from `NODE_TLS_REJECT_UNAUTHORIZED`, defaulting to `true`.
- The registry tarball's integrity matches the lock, it carries a verified
  registry signature, and its SLSA provenance names `gajus/global-agent` commit
  `e9138f654826f9a82e0ac4f3abdb9541ac988286` (the package's `gitHead`).

`test/unit/dependency-security.test.ts` checks the lock and the installed tree
for the removed chain, and makes real downloads through the packager's
`@electron/get` in a clean child process against loopback servers: through an
HTTP proxy, direct for a `NO_PROXY` host, a wrong SHA-256 refused, an untrusted
certificate through a `CONNECT` tunnel refused, and the same server accepted
once its certificate is trusted.

**Remove the override when** `electron-builder` stops nesting `@electron/get`
3.1.0 (the override is keyed on that exact version and silently stops matching
when it changes) or when `@electron/get` itself depends on a `global-agent`
without `roarr`. After an `electron-builder` upgrade, delete the override, run
`npm install`, and let the graph tests say whether it is still needed; update
the version pins those tests assert.

## GHSA-hrr3-gc8f-f4qj — `fast-uri` < 3.1.8 (moderate): fixed

Route: `app-builder-lib` → `ajv` 8.20.0 → `fast-uri` (declared `^3.0.1`).
Before 3.1.8, a scheme-relative reference had its host lower-cased before it
was percent-decoded, so `parse("//%41.com").host` was `"A.com"` while
`//a.com` and `//A.com` gave `"a.com"`, and `equal("//%41.com", "//a.com")`
was `false`. The advisory names 3.1.8 as the fix for the 3.x line.

Fix: a lock-only update to 3.1.8 within Ajv's existing range (`npm update
fast-uri`); `package.json` is unchanged for this, and no other lock entry moved.
The test resolves `fast-uri` from Ajv's own directory and checks that `parse`,
`normalize` and `equal` treat `//%41.com` the same as `//a.com`; the same
assertions fail against 3.1.7.

**Nothing to remove later.** A future lock regeneration stays at or above 3.1.8;
the test catches a regression to an affected version.

## GHSA-ch52-4w7c-c8xp — `http-cache-semantics` <= 4.2.0 (high): NOT fixed, open residual

Route: `@electron/get` 3.1.0 → `got` 11.8.6 → `cacheable-request` 7.0.4 →
`http-cache-semantics` 4.2.0.

The advisory's affected range ends at 4.2.0 and 4.3.0 exists, but 4.3.0 does
not change the reported behaviour. Its source (byte-identical to upstream
`b1d4bd6`; 4.2.0 is byte-identical to `f01112e`, the commit the advisory cites)
changes only `Vary` matching and adds a `status` field. The `max-stale` branch
in `evaluateRequest`/`satisfiesWithoutRevalidation` and the `maxAge() === 0`
handling of shared `Set-Cookie` responses are unchanged, and both versions
serve a shared `Set-Cookie` entry to a `max-stale` request identically. The
maintainer has disputed the report (upstream issue #56: the RFC permits
sharing such responses; `Cache-Control: private` is what prevents it). Bumping
to 4.3.0 would clear the alert without changing the code it is about, so it was
not done.

This remains an open alert. The installed version is still 4.2.0, inside the
advisory range; it has not been dismissed and should not be reported as
resolved. The decision to keep it was made by the change's independent
reviewer on the evidence below.

Reachability: `got` only constructs a `cacheable-request` when its `cache`
option is set. `@electron/get` never sets it, and `electron-builder.yml` has no
`electronDownload` options that could. The packager is a single-user build
tool, not a shared cache. Two checks pin this:

- statically, the lock has one route to the package (dev-only, through
  `got`), and the downloader source passes no `cache` option;
- dynamically, the test instruments the exact `http-cache-semantics` file that
  `cacheable-request` resolves, then makes a real download through the
  packager's `@electron/get`. It counts zero `CachePolicy` constructions. With
  got's `cache` option turned on, the same download builds one, so the zero
  reflects the downloader's behaviour rather than a blind counter.

**Revisit when** upstream ships a release that changes the `max-stale` path,
the advisory is withdrawn or amended, or `electron-builder` stops depending on
`got` 11.

## Expected `npm audit` result

After this change `npm audit` should report exactly one finding, the
`http-cache-semantics` residual above. That is not zero vulnerabilities.
