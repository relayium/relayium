# Local copy of pion/turn — Relayium patches

This directory is `github.com/pion/turn/v4@v4.1.4`, copied byte-for-byte from
the module zip, plus one identity correction (Patch 1) and one test-only
change that keeps the module's own tests off the public internet (Patch 2).
`server/go.mod` points the
dependency here with

    replace github.com/pion/turn/v4 => ./third_party/pion-turn

and keeps `require github.com/pion/turn/v4 v4.1.4`, so every other module
version in the server's build list is unchanged. The upstream code, its
`LICENSE` (MIT, The Pion community) and `LICENSES/` are retained as received;
Relayium's additions to this directory are MIT-licensed like the code they
patch.

## Baseline

| | |
|---|---|
| Module | `github.com/pion/turn/v4@v4.1.4` |
| Module hash (`go.sum`) | `h1:EU11yMXKIsK43FhcUnjLlrhE4nboHZq+TXBIi3QpcxQ=` |
| go.mod hash | `h1:ES1DXVFKnOhuDkqn9hn5VJlSWmZPaRJLyBXoOeO/BmQ=` |
| Upstream | https://github.com/pion/turn, tag `v4.1.4`, commit `7ca9d6ab0d9491176cf8a22e0e054f4e74ef3ce8` |
| Copied | 2026-09-23, from the Go module cache zip that `go mod verify` accepted; the extracted tree's dirhash equalled the `h1:` above before any edit |

`RELAYIUM-BASELINE.sha256` lists the sha256 of every upstream file as copied.
`RELAYIUM-PATCHED.sha256` lists every file that differs from or is added to
that baseline. `TestPionTurnLocalCopyProvenance` in `server/cmd/relayium-node`
fails if any file in this directory matches neither list, if a listed file is
missing, or if `server/go.mod`'s require/replace no longer match this copy.

## Patch 1 — allocation identity guard

**Defect.** An allocation's own relay reader, on a read error, and its own
lifetime timer both called `Manager.DeleteAllocation(a.fiveTuple)`, which looks
the allocation up by 5-tuple fingerprint rather than by identity. A client that
ends an allocation with Refresh(LIFETIME=0) and allocates again from the same
source port reuses the 5-tuple, so when the first allocation's reader returned
from its failed read after the second allocation existed, it removed and
closed the second, live allocation. pion then had no allocation for a client it
had just granted one to, and the relay socket was closed. The same holds for a
lifetime timer callback that runs after its allocation was removed.

**Change.** Those two call sites now call a new unexported
`Manager.deleteAllocationIfCurrent(alloc)`, which removes the map entry only if
it is `alloc` itself, then closes and reports it exactly as `DeleteAllocation`
does. If the entry is not `alloc`, whoever removed `alloc` already closed and
reported it, and the call does nothing. The public
`DeleteAllocation(fiveTuple)` — client Refresh(LIFETIME=0), TCP connection end
— is unchanged and still ends whatever allocation is current.

Unlike the diagnostic prototype, the not-current case does not call
`alloc.Close()` again: that would add a Close of `alloc` that can run
concurrently with the remover's, and `Allocation.Close` is idempotent only for
sequential callers.

Tests added here: `internal/allocation/allocation_identity_test.go` (late
reader and late lifetime timer versus a successor, fail on unpatched v4.1.4;
own expiry/read failure/Manager.Close still end the current allocation exactly
once). End to end through the node's registry:
`TestTURNLateReaderOfEndedAllocationCannotEndItsSuccessor` in
`server/cmd/relayium-node`.

```diff
--- a/internal/allocation/allocation.go
+++ b/internal/allocation/allocation.go
@@ -300,7 +300,7 @@
 	for {
 		n, srcAddr, err := a.RelaySocket.ReadFrom(buffer)
 		if err != nil {
-			manager.DeleteAllocation(a.fiveTuple)
+			manager.deleteAllocationIfCurrent(a) // Relayium patch, see PATCHES.md
 
 			return
 		}
--- a/internal/allocation/allocation_manager.go
+++ b/internal/allocation/allocation_manager.go
@@ -130,7 +130,7 @@
 	m.log.Debugf("Listening on relay address: %s", alloc.RelayAddr)
 
 	alloc.lifetimeTimer = time.AfterFunc(lifetime, func() {
-		m.DeleteAllocation(alloc.fiveTuple)
+		m.deleteAllocationIfCurrent(alloc) // Relayium patch, see PATCHES.md
 	})
 
 	m.lock.Lock()
@@ -170,6 +170,39 @@
 	}
 }
 
+// deleteAllocationIfCurrent is DeleteAllocation for signals raised by alloc's
+// own goroutines — its relay reader failing and its lifetime timer firing.
+// Those can arrive after alloc was already removed and a newer allocation was
+// created on the same 5-tuple; looking the 5-tuple up would then remove and
+// close that newer, live allocation. Only the map entry that IS alloc is
+// removed. Otherwise whoever removed alloc has already closed and reported it,
+// so there is nothing to do.
+//
+// Relayium patch, see PATCHES.md at the module root.
+func (m *Manager) deleteAllocationIfCurrent(alloc *Allocation) {
+	fingerprint := alloc.fiveTuple.Fingerprint()
+
+	m.lock.Lock()
+	current := m.allocations[fingerprint] == alloc
+	if current {
+		delete(m.allocations, fingerprint)
+	}
+	m.lock.Unlock()
+
+	if !current {
+		return
+	}
+
+	if err := alloc.Close(); err != nil {
+		m.log.Errorf("Failed to close allocation: %v", err)
+	}
+
+	if m.EventHandler.OnAllocationDeleted != nil {
+		m.EventHandler.OnAllocationDeleted(alloc.fiveTuple.SrcAddr, alloc.fiveTuple.DstAddr,
+			alloc.fiveTuple.Protocol.String(), alloc.username, alloc.realm)
+	}
+}
+
 // CreateReservation stores the reservation for the token+port.
 func (m *Manager) CreateReservation(reservationToken string, port int) {
 	time.AfterFunc(30*time.Second, func() {
```

## Patch 2 — hermetic STUN test fixture (tests only)

**Defect.** Upstream's `TestClientWithSTUN` sends its `SendBindingRequest` and
`SendBindingRequestTo Parallel` exchanges to the public server
`stun1.l.google.com:19302`. Relayium's CI runs this module's tests in its
blocking `race-rest` lane, and without DNS and UDP egress those two subtests
fail after ~17 s of retransmissions — a merge gate that depends on a third-party
server rather than on the code.

**Change.** `stun_responder_test.go` (added) is a Binding responder on an
ephemeral `127.0.0.1` UDP port: it answers each well-formed Binding request
with a success response carrying the request's transaction ID and the sender's
address as XOR-MAPPED-ADDRESS, drops anything else unanswered, counts the
distinct transactions it answered, and is closed and awaited (bounded, 5 s)
when its test ends. `client_test.go` points those two subtests at it instead of
Google, and nothing else in the test changes: the subtests still send real UDP
through the real client, the local controls in the same test (`NewClient`
with a nil `Conn` fails; `SendBindingRequestTo timeout` against
`127.0.0.1:9`) are untouched, and the upstream assertions all remain — the
Binding succeeds and leaves no transaction behind. Because the server is now
known, the subtests also assert the mapped address is the client's own
`127.0.0.1` socket, that the parallel case produced two distinct answered
transactions, and that the parallel case also leaves no transaction behind.
No non-test file is affected; the node never links this code.

```diff
--- a/client_test.go
+++ b/client_test.go
@@ -44,7 +44,7 @@
-func createListeningTestClientWithSTUNServ(t *testing.T, loggerFactory logging.LoggerFactory) ( // nolint:lll
+func createListeningTestClientWithSTUNServ(t *testing.T, loggerFactory logging.LoggerFactory, addr string) ( // nolint:lll
@@ -53,8 +53,6 @@
-	addr := "stun1.l.google.com:19302"
-
@@ -70,8 +68,11 @@
+	// Relayium patch, see PATCHES.md: a responder on 127.0.0.1 replaces the
+	// public server stun1.l.google.com:19302 in the two exchanges below.
 	t.Run("SendBindingRequest", func(t *testing.T) {
-		client, pc, ok := createListeningTestClientWithSTUNServ(t, loggerFactory)
+		stunServ := startLocalSTUNResponder(t)
+		client, pc, ok := createListeningTestClientWithSTUNServ(t, loggerFactory, stunServ.addr())
@@ -81,6 +82,12 @@
+		// The mapped address is the client's own socket as the responder saw it.
+		if assert.NotNil(t, resp) {
+			wantMapped := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: pc.LocalAddr().(*net.UDPAddr).Port}
+			assert.Equal(t, wantMapped.String(), resp.String())
+		}
+		assert.Equal(t, 1, stunServ.answered())
@@ -96,10 +103,10 @@
-		to, err := net.ResolveUDPAddr("udp4", "stun1.l.google.com:19302")
+		stunServ := startLocalSTUNResponder(t)
+		to, err := net.ResolveUDPAddr("udp4", stunServ.addr())
-		// stun1.l.google.com:19302, more at https://gist.github.com/zziuni/3741933#file-stuns-L5
@@ -114,6 +121,9 @@
+		// Two distinct transactions, both answered and both cleared.
+		assert.Equal(t, 2, stunServ.answered())
+		assert.Equal(t, 0, client.trMap.Size(), "should be no transaction left")
```

Re-copying a new upstream version means re-applying this patch too, unless
upstream has made the test hermetic itself; it does not affect the removal
trigger below, which concerns Patch 1 only.

## Removal trigger

Delete this directory and the `replace` line, and return to a plain upstream
`require`, when a pion/turn release guards BOTH the relay-reader error path and
the lifetime-timer path by allocation identity (not by 5-tuple). Before
removing, run `TestTURNLateReaderOfEndedAllocationCannotEndItsSuccessor` in
`server/cmd/relayium-node` against that release: it must pass without this
copy. As of 2026-09-23 no such release exists (v4.1.4 is the latest tag, and
the diagnosis found upstream master at `28314adaa5cc` unchanged on both paths).

Bumping pion/turn to a release that does NOT carry the fix means re-copying
that release here, re-applying this patch, and regenerating both manifests —
never editing only the `require` line; the provenance test refuses that.

## Regenerating the manifests

`RELAYIUM-BASELINE.sha256` must only ever be the pristine upstream list; it is
regenerated only when a new upstream version is copied in. Never generate it
inside this directory: it holds Relayium's additions (this file, both
manifests, the added test) and patched files, and a shell redirect into the
directory creates the output file before `find` runs, so the list would hash
itself. Stage the verified module zip in a scratch directory and write the
manifest outside the staged tree (set `V` to the new version):

    V=v4.1.4
    stage=$(mktemp -d)
    zip=$(cd "$stage" && go mod download -json "github.com/pion/turn/v4@$V" | sed -n 's/^.*"Zip": "\(.*\)",$/\1/p')
    unzip -q "$zip" -d "$stage/zip"
    (cd "$stage/zip/github.com/pion/turn/v4@$V" &&
      find . -type f | sed 's|^\./||' | LC_ALL=C sort | xargs shasum -a 256) > "$stage/RELAYIUM-BASELINE.sha256"

`go mod download` verifies the zip against the Go checksum database before
reporting it, so the staged tree is the pristine upstream module; compare its
`"Sum"` with the `h1:` recorded above.
Replace this directory's contents with the staged tree (keep this file; the
provenance test rejects any leftover file from the old version), copy
`$stage/RELAYIUM-BASELINE.sha256` in, and only then re-apply the patch.
For v4.1.4 this procedure reproduces the committed baseline byte for byte.

`RELAYIUM-PATCHED.sha256` lists the patched and added files, from this
directory:

    shasum -a 256 internal/allocation/allocation.go \
      internal/allocation/allocation_manager.go \
      internal/allocation/allocation_identity_test.go \
      client_test.go \
      stun_responder_test.go > RELAYIUM-PATCHED.sha256
