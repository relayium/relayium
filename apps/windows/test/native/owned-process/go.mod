// TEST-ONLY. Not built into, shipped with, or imported by any product binary.
//
// Deliberately its own module rather than a package inside
// `apps/windows/native`: that module is production, its dependency set is a
// release input, and a test-only Windows Job Object helper has no business
// widening it. The Go version and the `x/sys` version below are PINNED to the
// exact ones that module already uses, so this introduces no new toolchain or
// dependency into the workspace at all.
module github.com/relayium/relayium/apps/windows/test/native/owned-process

go 1.26.6

require golang.org/x/sys v0.47.0
