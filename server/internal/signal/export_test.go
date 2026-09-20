package signal

// Test-only seams.
//
// This file is named `_test.go`, so it is compiled ONLY when the signal package
// or its external test package is under test. Nothing here is production API,
// and nothing here may be referenced from a non-test file.
//
// It exists for one reason: the attribution regression that matters is a code
// generation being REUSED, and the only honest way to stage that is to make the
// real registry draw the same six digits twice. The draw is deliberately not a
// production knob — a settable code source would be a way to make codes
// predictable — so the seam lives here, where only a test can reach it.

// SetCodeDrawForTest replaces the pairing-code source. A test that wants the
// same digits minted twice installs a fixed draw; everything else about the
// registry, including the tag index and every expiry rule, stays real.
func (p *PairRegistry) SetCodeDrawForTest(fn func() string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.draw = fn
}
