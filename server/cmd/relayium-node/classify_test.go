package main

import (
	"errors"
	"fmt"
	"testing"

	"github.com/relayium/relayium/selfupdate"
)

// The mapping is the whole point of the change, so it is asserted directly
// rather than through a message. A test that keys on error text goes red when
// someone rewords a message and green when someone breaks the classification.
func TestExitCodeForUpdateError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"fetch", fmt.Errorf("download x: %w: %w", selfupdate.ErrFetch, errors.New("no route to host")), exitFetchFailed},
		{"verify", fmt.Errorf("%w: %w", selfupdate.ErrVerify, errors.New("sha256 mismatch")), exitUpdateFailed},
		{"anything else", errors.New("disk full"), exitUpdateFailed},
	}
	for _, tc := range cases {
		if got := exitCodeForUpdateError(tc.err); got != tc.want {
			t.Fatalf("%s: exitCodeForUpdateError = %d, want %d", tc.name, got, tc.want)
		}
	}
}

// A node that could not obtain the artifact must report something central can
// advance past. Reporting "failed" is what halts the fleet for one machine's
// network.
func TestResultForFetchFailureIsNotFailed(t *testing.T) {
	got := resultForExitCode(exitFetchFailed)
	if got == "failed" || got == "rolled_back" {
		t.Fatalf("resultForExitCode(exitFetchFailed) = %q, which halts the track", got)
	}
	if got != "unreachable" {
		t.Fatalf("resultForExitCode(exitFetchFailed) = %q, want unreachable", got)
	}
}

// Verification failure keeps halting. This is the regression guard on the half
// of the change that must NOT loosen.
func TestResultForVerificationFailureStillHalts(t *testing.T) {
	if got := resultForExitCode(exitUpdateFailed); got != "failed" {
		t.Fatalf("resultForExitCode(exitUpdateFailed) = %q, want failed", got)
	}
}
