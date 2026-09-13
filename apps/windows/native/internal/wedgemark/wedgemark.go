// The entry marker shared by the wedging test sink and the test that drives it.
//
// It lives in its own package for one reason: the test must wait for a literal
// the sink actually emits. If each side spelled the marker out separately, a
// typo on either side would turn the barrier back into a sleep — the test would
// fall through to its timeout and report a missing shutdown bound, or worse,
// wait on a marker that never arrives while the behaviour under test was fine.
// One constant, two importers, no drift.
//
// ## This is not a runtime hook
//
// Only cmd/relayium-io-helper/sink_wedge_windows.go imports this, and that file
// is behind the `relayiumwedgehook` build tag. Nothing in a shipping build
// references this package, so the marker is not a string a shipped binary can
// be made to emit.
//
// The value is fixed and carries no user content: it is a constant announcing
// that a test-only sink was entered, and nothing about the transfer.
package wedgemark

// Entered is written to stderr by the wedging sink immediately before it blocks
// forever. Observing it proves the serve loop reached the sink, which is the
// state the shutdown bound is a promise about.
const Entered = "RELAYIUM-WEDGE-SINK-ENTERED"
