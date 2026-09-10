# Relayium for Windows — licensing and third-party notices

## This package is AGPL-3.0-only

`apps/` is Apache-2.0 by default, and the root `LICENSE` explains why: the Apple
apps are distributed through the App Store, whose terms are the kind of extra
restriction the AGPL forbids adding.

**`apps/windows/` is the exception.** Two facts make it one:

1. It **compiles `web/src/lib` directly** rather than vendoring a copy. Those
   modules are AGPL-3.0-only, and a combined work that includes them is
   AGPL-3.0-only. Labelling this package Apache-2.0 would be relicensing code
   this repository does not have the right to relicense.
2. It is distributed as a **direct download**, not through the Microsoft Store,
   so the App Store incompatibility that motivates the Apache exception does not
   apply here.

Nothing under `web/` is relicensed by this. The reused files keep their own
licence and notices; this package is a combined work distributed under the same
terms.

## Third-party components in the packaged application

The installer embeds the Electron runtime, which itself embeds Chromium and
Node.js. Their licences travel with the binaries electron-builder packages, in
`LICENSES.chromium.html` and `LICENSE` inside the installed application
directory. They are not restated here, because a hand-copied notice file is one
that silently goes stale against the runtime it describes.

| Component | Licence | How it reaches the package |
|---|---|---|
| Electron (Chromium, Node.js, V8) | MIT, with embedded third-party licences | Bundled runtime; notices shipped by electron-builder |
| libsodium (via `libsodium-wrappers`) | ISC | npm dependency, compiled into the renderer bundle |
| Svelte | MIT | npm dependency, compiled into the renderer bundle |
| Relayium web protocol modules | AGPL-3.0-only | Compiled from `web/src/lib` in this repository |

`electron-builder` is a build-time dependency and is not distributed.
