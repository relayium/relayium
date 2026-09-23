package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"unicode"
)

// H2: the built-in help promises exactly what this build does (design §5.4,
// Stage 1 column) — no more.
func TestInboxSendHelpMatchesWhatTheSenderDoes(t *testing.T) {
	isolatedEnv(t)
	var stdout, stderr bytes.Buffer
	if rc := Run([]string{"inbox", "send", "-h"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc = %d", rc)
	}
	flat := strings.Join(strings.Fields(stdout.String()), " ")
	for _, n := range []string{
		"QUEUED IS NOT SAVED",
		"A network drop while the command runs is resumed automatically",
		"the outcome is unknown (exit 3). Nothing is uploaded again automatically",
		`"relayium inbox retry <id>" finishes it if the server can confirm the upload; otherwise the outcome stays unknown`,
		"stopped part-way through the upload, it cannot be resumed",
		"which is a new upload and is counted again",
		"After a restart it cannot be, and the send fails",
		"Your own current device is a valid target",
		"does not need Device Inbox receiving turned on",
	} {
		if !strings.Contains(flat, n) {
			t.Errorf("send help omits %q", n)
		}
	}
}

// H3: copy never promises cleanup "within an hour" and never claims a charge
// for bytes that were not sent — anywhere in the sender's help or messages.
func TestInboxSenderCopyMakesNoCleanupOrChargePromise(t *testing.T) {
	texts := []string{inboxSendUsage, inboxRetryUsage, inboxSentUsage, inboxCancelUsage, inboxDevicesUsage, inboxUsage}
	for _, s := range texts {
		low := strings.ToLower(strings.Join(strings.Fields(s), " "))
		for _, banned := range []string{"within 1 hour", "within an hour", "within one hour", "within 1 h",
			"charged for bytes not sent", "bytes that were not sent", "exactly once", "resumes after a restart",
			// Cancelling deletes the task, then only REQUESTS the ciphertext's
			// deletion from storage, which can fail or wait for cleanup.
			"deletes its ciphertext", "at the same time", "same transaction", "immediately deleted"} {
			if strings.Contains(low, banned) {
				t.Errorf("sender copy says %q", banned)
			}
		}
	}
	if !strings.Contains(strings.Join(strings.Fields(inboxCancelUsage), " "), "released for deletion from storage, which can happen later") {
		t.Error("cancel help lost its precise cleanup wording")
	}
}

// --json output is one document with every control character escaped, even
// the DEL and C1 characters encoding/json leaves raw.
func TestWriteJSONEscapesEveryControlCharacter(t *testing.T) {
	var b bytes.Buffer
	writeJSON(&b, map[string]string{"name": "a\x1b[2J\u007f\u0085\u009b31m z"})
	out := b.String()
	for _, r := range strings.TrimSuffix(out, "\n") {
		if unicode.IsControl(r) || r == ' ' {
			t.Fatalf("raw control character %U in %q", r, out)
		}
	}
	var m map[string]string
	if err := json.Unmarshal(b.Bytes(), &m); err != nil || m["name"] != "a\x1b[2J\u007f\u0085\u009b31m z" {
		t.Fatalf("escaped JSON does not round-trip: %v %q", err, m["name"])
	}
}

// Usage errors are exit 2 and need no credential.
func TestInboxSenderUsageErrors(t *testing.T) {
	isolatedEnv(t)
	for _, args := range [][]string{
		{"inbox", "send", "a.txt"},     // no --to
		{"inbox", "send", "--to", "x"}, // no paths
		{"inbox", "send", "--to", "x", "--ttl", "zz", "a"},
		{"inbox", "send", "--to", "x", "--wait=-1s", "a"},
		{"inbox", "retry"},
		{"inbox", "cancel"},
		{"inbox", "sent", "a", "b"},
		{"inbox", "sent", "--limit", "0"},
		{"inbox", "devices", "extra"},
	} {
		var o, e bytes.Buffer
		if rc := Run(args, &o, &e); rc != 2 {
			t.Errorf("%v: rc = %d, want 2 (%s)", args, rc, e.String())
		}
	}
	var o, e bytes.Buffer
	if rc := Run([]string{"inbox", "retry", "../../etc/passwd"}, &o, &e); rc == 0 {
		t.Fatal("a traversal id was accepted")
	}
}
