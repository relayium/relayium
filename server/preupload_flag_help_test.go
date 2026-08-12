package main

import (
	"os"
	"strings"
	"testing"
)

// The -enable-preupload flag's help is the one description of this feature an
// operator reads at the moment they decide whether to turn it on, and it is the
// only one they read without opening the source. That makes it the surface where
// a stale claim costs the most: an operator who is told the server has NO way to
// end a joined room's storage reasons about the flag differently than one who is
// told the way exists but nothing spends it yet.
//
// Both of those were true at different commits, which is exactly why this guard
// exists. Before the completion capability was built (pairroom_complete.go), the
// help said a joined room's ciphertext had "no completion lifecycle". That
// sentence survived the commit that built one, and nothing failed — help strings
// are not compiled against the thing they describe, so they rot silently.
//
// A source-reading guard, and it has to be: the flags are declared inside main(),
// so no test can register them and read the help back off the flag package. This
// follows the same shape as account/admin_i18n_test.go, which reads its own
// source for the same reason.
func TestPreUploadFlagHelpDoesNotClaimThereIsNoCompletionLifecycle(t *testing.T) {
	line := preUploadFlagDeclaration(t)

	// The ban is conditional on the default, and the condition is the point. This
	// claim is only WRONG while the capability exists and the flag ships off; a
	// deployment default of true would be a different feature state with different
	// honest help, so rather than quietly keep enforcing a rule written for the
	// old state, fail and make someone re-read both.
	if !strings.Contains(line, `envBool("RELAYIUM_ENABLE_PREUPLOAD", false)`) {
		t.Fatalf("-enable-preupload no longer defaults to false.\n"+
			"That is a rollout decision, not a typo, so this guard will not quietly\n"+
			"keep enforcing a rule written for the default-off state. Re-read the\n"+
			"flag help against what the server actually does now, then update this\n"+
			"test to match the new state.\ndeclaration: %s", line)
	}

	// The exact stale sentence, banned by the letter of it. The capability is
	// built: a sender records a verifier at finalize and POST /api/files/{id}/
	// complete spends it (server/account/pairroom_complete.go). Saying it does
	// not exist misdescribes the server an operator is being asked to configure.
	if strings.Contains(line, "no completion lifecycle") {
		t.Errorf("-enable-preupload help still claims a joined room has \"no completion lifecycle\".\n"+
			"That was true before server/account/pairroom_complete.go existed and is\n"+
			"false now: the completion capability is built and mounted. What is still\n"+
			"open is that no receiver spends it, what becomes of a room nobody\n"+
			"completes is undecided, and the rollout gates are open — say that\n"+
			"instead.\nhelp: %s", line)
	}

	// The SAME rot, one commit later. "Built but nobody spends it" was true from
	// the commit that added pairroom_complete.go until the Web receiver started
	// posting completions (web/src/lib/preupload-receive.svelte.ts), and it is
	// false now. It is the more dangerous of the two stale sentences, because it
	// understates rather than overstates: an operator told that nothing ever ends
	// a joined room will not think to ask which receivers can end one and which
	// cannot — and that distinction is the whole shape of the storage commitment
	// they are being asked to take on (docs/protocol/relayium-pair-room-v1.md
	// §7.6: only a browser that commits files to disk itself completes at all).
	for _, stale := range []string{"no receiver spends it", "no receiver spends one"} {
		if strings.Contains(line, stale) {
			t.Errorf("-enable-preupload help still claims %q.\n"+
				"That was true before the Web receiver posted completions and is false\n"+
				"now. What is still open is that a room nobody completes has no end, and\n"+
				"that only a receiver whose browser commits files to disk can complete at\n"+
				"all — say that instead.\nhelp: %s", stale, line)
		}
	}

	// The other direction of the same rot, and the reason this guard is more than
	// a banned-substring list: help that drops the pointer stops being checkable
	// against anything. Naming the file that implements the capability is what
	// lets the next reader — human or this test — find out whether the sentence
	// around it is still true.
	if !strings.Contains(line, "pairroom_complete.go") {
		t.Errorf("-enable-preupload help no longer points at pairroom_complete.go.\n" +
			"The help describes a storage commitment whose only exit is that file;\n" +
			"without the pointer an operator cannot check the claim, and neither\n" +
			"can this test.")
	}

	// Every file the help sends an operator to must be a file they can open. A
	// dangling pointer in operator-facing help is the same failure as the stale
	// sentence — text that used to be true about a layout that has since moved.
	for _, ref := range []string{
		"account/pairroom.go",
		"account/pairroom_complete.go",
	} {
		if !strings.Contains(line, ref) {
			continue
		}
		if _, err := os.Stat(ref); err != nil {
			t.Errorf("-enable-preupload help points at %s, which does not exist: %v", ref, err)
		}
	}

	// Default-off is the single most consequential fact in this help — it is the
	// answer to the question the operator opened -h to ask — so it is required
	// explicitly rather than left to be inferred from the prose around it.
	if !strings.Contains(line, "default OFF") {
		t.Errorf("-enable-preupload help no longer states \"default OFF\" while the flag\n" +
			"still defaults to false. An operator reading -h must not have to infer\n" +
			"the default from the surrounding prose.")
	}
}

// preUploadFlagDeclaration returns the single source line that declares
// -enable-preupload.
//
// Insisting on EXACTLY one match rather than taking the first: two declarations
// would mean the flag is registered twice (a flag package panic at startup) or
// that this guard is reading a copy while the binary uses the other, and a guard
// that silently checks the wrong one of two strings is worse than no guard.
func preUploadFlagDeclaration(t *testing.T) string {
	t.Helper()
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	var found []string
	for line := range strings.SplitSeq(string(src), "\n") {
		if strings.Contains(line, `flag.Bool("enable-preupload"`) {
			found = append(found, strings.TrimSpace(line))
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly 1 declaration of -enable-preupload in main.go, found %d", len(found))
	}
	return found[0]
}
