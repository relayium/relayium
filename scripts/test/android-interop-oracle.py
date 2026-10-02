#!/usr/bin/env python3
"""The Android ↔ Web interop comparison, as a file both the acceptance and its
own test can run.

## Why this is not a heredoc inside the shell script

It was, and a heredoc cannot be mutation-tested. The first version of this
comparison skipped the digest check whenever the browser reported NO received
bytes -- `elif browser.get("receivedFileHex")` -- so an observation in which
the browser received nothing at all passed exactly like one where it received
the right bytes. A false green in the acceptance oracle is worse than a missing
test: the lane reports that two implementations agreed when one of them
transferred nothing.

So the rules live here, `scripts/test/android-interop-oracle-test.mjs` runs
them against a correct observation AND against mutants of it, and every mutant
must be REJECTED. A rule that has never been observed rejecting something is
indistinguishable from a rule that cannot.

## The shape of the judgement

Both halves write down only what they OBSERVED. Neither compares anything, and
neither may grant itself a pass. This file:

  * requires every field it reads to be PRESENT -- a missing field is a
    failure, never a skipped check;
  * compares payloads by size AND digest, including for zero-byte and empty
    results, so "nothing arrived" can never satisfy "the right thing arrived";
  * requires the round's declared shape (cancels, retries, repeated batches)
    to have actually happened, rather than accepting a flag that says so.

## Who played which role, and how that is known

The acceptance server runs a deterministic, loopback-only peer-id schedule
(`RELAYIUM_ACCEPTANCE_PEER_IDS`), so each round PLANS which role the browser
plays. `judge_identity` requires three independent things to agree with that
plan: the ids the server actually assigned (the browser's own welcome and the
room rosters it received), the role those real ids imply (`self < peer`), and
what the two clients actually DID on the wire -- the responder asks
(`linkRequest`), the initiator offers. The browser's `role` field is that
file's own arithmetic and is never accepted as proof on its own.

Three subcommands share these rules:

  android-interop-oracle.py <browser.json> <android.json> <expect.json>
      judge one round.
  android-interop-oracle.py ready-receipt <receipt> <round> <nonce> <id16>
      check the browser's welcome-barrier receipt before Android starts.
  android-interop-oracle.py peer-id-log <server.log> <ids-csv>
      check that the acceptance server assigned EXACTLY one id per scheduled
      socket: every accepted websocket logged, none missing, none extra.

Exit 0 means the check passed. Anything else prints every problem it found.
"""
import hashlib
import json
import os
import re
import stat
import sys

ID16 = re.compile(r"[0-9a-f]{16}")
ROLES = ("initiator", "responder")


def sha256_hex(hex_bytes):
    return hashlib.sha256(bytes.fromhex(hex_bytes)).hexdigest()


def judge(browser, android, expect):
    problems = []

    def require(obj, key, where):
        """Read a field that MUST exist. Absence is a failure, not a skip."""
        if key not in obj:
            problems.append("%s is missing the field %r" % (where, key))
            return None
        return obj[key]

    # ── the run was against this run's own server ───────────────────────────
    origin = require(android, "origin", "the Android report")
    if origin is not None and origin != expect["origin"]:
        problems.append("the Android app resolved %r, not this run's server %r"
                        % (origin, expect["origin"]))

    if require(browser, "reachedWorkspace", "the browser report") is False:
        problems.append("the browser never reached the unified workspace")

    error_key = require(android, "errorKey", "the Android report")
    if error_key:
        problems.append("the Android app ended the round with %r" % (error_key,))
    if require(android, "cleanupIncomplete", "the Android report"):
        problems.append("the Android app reported an incomplete cleanup")

    # ── one link, one SAS, derived independently by two implementations ─────
    #
    # The only cell in the matrix where this can be checked at all: the Kotlin
    # vector test and the Web test each check their own implementation against
    # a frozen value, and neither has ever compared two live endpoints.
    browser_sas = require(browser, "sas", "the browser report")
    android_sas = require(android, "sas", "the Android report")
    if expect.get("verify") == "on":
        if not browser_sas:
            problems.append("the browser derived no SAS on the path that shows one")
        elif not android_sas:
            problems.append("the Android app derived no SAS")
        elif browser_sas != android_sas:
            problems.append("the two sides derived different SAS digits: browser %s, android %s"
                            % (browser_sas, android_sas))

    # ── text, both directions, exactly ──────────────────────────────────────
    seen_by_browser = require(browser, "receivedMessages", "the browser report") or []
    for message in expect["androidMessages"]:
        if message not in seen_by_browser:
            problems.append("the browser did not receive the Android message %r; it saw %r"
                            % (message, seen_by_browser))
    android_received = require(android, "receivedMessage", "the Android report")
    if android_received != expect["webMessage"]:
        problems.append("Android did not receive the browser's message: %r"
                        % (android_received,))

    # ── files: android → web ────────────────────────────────────────────────
    #
    # Compared as a SET of complete records. The old rule read one name and one
    # hex string and skipped the digest when the hex was empty, which is the
    # false green this file exists to prevent.
    got = {}
    for entry in require(browser, "receivedFiles", "the browser report") or []:
        name = entry.get("name")
        if name is None:
            problems.append("a browser save record has no name: %r" % (entry,))
            continue
        if "hex" not in entry or "size" not in entry:
            problems.append("the browser save record for %r has no bytes or no size" % (name,))
            continue
        got[name] = entry

    for want in expect["androidSent"]:
        entry = got.get(want["name"])
        if entry is None:
            problems.append("the browser never completed a save of %r; it completed %r"
                            % (want["name"], sorted(got)))
            continue
        # SIZE and DIGEST, unconditionally. An empty result fails both against
        # a non-empty expectation, and a zero-byte expectation is satisfied
        # only by a zero-byte result with the digest of the empty string.
        if entry["size"] != want["size"]:
            problems.append("the browser saved %r as %d bytes, not %d"
                            % (want["name"], entry["size"], want["size"]))
        if len(entry["hex"]) != 2 * entry["size"]:
            problems.append("the browser's record for %r is internally inconsistent: "
                            "%d hex chars for %d bytes"
                            % (want["name"], len(entry["hex"]), entry["size"]))
        digest = sha256_hex(entry["hex"])
        if digest != want["sha256"]:
            problems.append("the browser's bytes for %r differ from what Android sent "
                            "(%s vs %s)" % (want["name"], digest, want["sha256"]))

    # A cancelled SEND is not proved by the forbidden name being absent — the
    # real Web calls sink.close() on the abort path (mixed-file-session
    # closeSink), so it genuinely commits a PARTIAL file. The claim is instead:
    # if the cancelled name is present at all, it is strictly SMALLER than the
    # full payload and does not match its digest; and the gate that made the
    # cancel deterministically active actually ran.
    full = expect.get("cancelledFullSize", 0)
    for forbidden in expect.get("browserMustNotSave", []):
        entry = got.get(forbidden)
        if not full:
            # No full size declared: the name must not appear as a completed
            # save at all (the strict rule for a round that expects nothing of
            # it to survive).
            if entry is not None:
                problems.append("the browser completed a save of %r, which this round cancelled"
                                % (forbidden,))
            continue
        if entry is None:
            continue  # a cancelled send may leave nothing committed at all
        # Otherwise only a strictly-smaller PARTIAL is allowed: a save AT or
        # ABOVE the full size is a completed transfer (the run7 failure), since
        # a partial can never reach — let alone match the digest of — the whole.
        if entry.get("size", 0) >= full:
            problems.append("the browser saved the cancelled file %r at %d bytes, not a "
                            "strictly-smaller partial of %d — the cancel was not active"
                            % (forbidden, entry.get("size", 0), full))

    if expect.get("cancel") == "send":
        # The gate's lifecycle proves the cancel was ACTIVE and OBSERVED, not
        # synthesized: the browser really held the first write, saw the peer's
        # cancel request, and released it. A round missing any of these did not
        # cancel a live transfer.
        gate = require(browser, "forbiddenGate", "the browser report")
        if not gate:
            problems.append("the send-cancel round recorded no gate lifecycle")
        else:
            if not gate.get("writeHeld"):
                problems.append("the browser never held the cancelled file's write, so the "
                                "sender's batch was never stalled mid-flight")
            if not gate.get("cancelObserved"):
                problems.append("the browser never observed the peer's cancel request")
            if not gate.get("released"):
                problems.append("the browser never released the held write, so the real "
                                "BATCH_ABORT could not run")

    # ── files: web → android ────────────────────────────────────────────────
    saved = {}
    for entry in require(android, "saved", "the Android report") or []:
        name = entry.get("name")
        if name is None or "sha256" not in entry or "size" not in entry:
            problems.append("an Android save record is incomplete: %r" % (entry,))
            continue
        saved[name] = entry

    for want in expect["webSent"]:
        entry = saved.get(want["name"])
        if entry is None:
            problems.append("Android never saved %r; it saved %r"
                            % (want["name"], sorted(saved)))
            continue
        if entry["size"] != want["size"]:
            problems.append("Android saved %r as %d bytes, not %d"
                            % (want["name"], entry["size"], want["size"]))
        if entry["sha256"].lower() != want["sha256"].lower():
            problems.append("Android's bytes for %r differ from what the browser sent"
                            % (want["name"],))

    for forbidden in expect.get("androidMustNotSave", []):
        if forbidden in saved:
            problems.append("Android saved %r, which this round cancelled" % (forbidden,))

    # The boundary payloads are named as REQUIREMENTS, not hoped for: a round
    # whose sizes drifted below them would still compare equal and would prove
    # much less than the comment above it claims. In BOTH directions — before
    # the android→web checks existed, zero-byte and multi-entry were proved
    # web→android only while the run's claim covered both.
    #
    # Only for an UNCANCELLED round: a receive-cancel round discards the
    # boundary-carrying first batch by design and completes a single-file
    # retry, and a send-cancel round retries one file. Demanding the
    # boundaries there would reject every correct cancel round; the boundary
    # proof is the cancel-free rounds' job, and those run in the same
    # acceptance.
    if expect.get("cancel", "none") == "none":
        sizes = [e["size"] for e in saved.values()]
        if not any(s == 0 for s in sizes):
            problems.append("no ZERO-byte file was saved by Android; sizes were %r" % (sizes,))
        if not any(s > 196608 for s in sizes):
            problems.append("nothing crossed the 192KiB fragment boundary on Android: %r" % (sizes,))
        if len(expect["webSent"]) < 2:
            problems.append("this round's plan sends fewer than two inbound files, so the "
                            "multi-entry file sequence is not exercised")
        sent_sizes = [w["size"] for w in expect["androidSent"]]
        if not any(s == 0 for s in sent_sizes):
            problems.append("this round's plan sends no ZERO-byte file android→web: %r"
                            % (sent_sizes,))
        if not any(s > 196608 for s in sent_sizes):
            problems.append("nothing in the plan crosses the 192KiB boundary android→web: %r"
                            % (sent_sizes,))
        if len(expect["androidSent"]) < 2:
            problems.append("this round's plan sends fewer than two android→web files, so the "
                            "multi-entry file sequence is not exercised in that direction")

    # ── the terminal handshake actually happened ────────────────────────────
    #
    # The done message is what keeps the Android Activity alive until the
    # browser has everything; a round in which it silently stopped happening
    # would be one premature-teardown regression away from the pilot that
    # reported OK while the browser's ledger was missing a file.
    sent_done = require(browser, "sentDone", "the browser report")
    if sent_done is not None and sent_done is not True:
        problems.append("the browser never sent the terminal done handshake")
    peer_left = require(browser, "peerLeft", "the browser report")
    if peer_left is not None and peer_left is not True:
        problems.append("the browser never observed the Android peer leave after done")
    confirmed = require(android, "peerConfirmedDone", "the Android report")
    if confirmed is not None and confirmed is not True:
        problems.append("Android closed without the browser's in-band done confirmation")

    # ── the round's declared shape actually happened ────────────────────────
    if expect.get("cancel") == "receive":
        tree_after = require(android, "treeAfterCancel", "the Android report")
        if tree_after is None:
            problems.append("the receive-cancel round recorded no post-cancel directory listing")
        else:
            leaked = [n for n in expect.get("androidMustNotSave", []) if n in tree_after]
            if leaked:
                problems.append("a cancelled receive left %r in the destination" % (leaked,))
        if not require(android, "sentinelIntact", "the Android report"):
            problems.append("the cancelled receive's rollback damaged unrelated content")
    if expect.get("cancel") == "send":
        if not require(android, "sendCancelled", "the Android report"):
            problems.append("the send-cancel round did not cancel")

    # A retry is only a retry if something was cancelled and something later
    # succeeded; both halves have to show it.
    if expect.get("cancel") in ("send", "receive"):
        if not expect["androidSent"] and not expect["webSent"]:
            problems.append("a cancel round with no successful transfer proves no retry")

    problems.extend(judge_identity(browser, expect))
    return problems


def planned_role_of(self_id, peer_id):
    """`linkRole` from web/src/lib/peer-link.svelte.ts: the smaller id offers."""
    return "initiator" if self_id < peer_id else "responder"


def judge_identity(browser, expect):
    """The round's identities and roles: planned, assigned, and played.

    Every rule reads the browser's recorded HISTORY, so a reconnect, a second
    welcome, a foreign peer or a peer that left and came back cannot be
    overwritten into a clean-looking last value."""
    problems = []
    planned = expect.get("plannedRole")
    want_self = expect.get("expectedBrowserId")
    want_peer = expect.get("expectedAndroidId")
    if planned not in ROLES:
        problems.append("the round has no planned role (%r); a round that plans nothing proves "
                        "no role" % (planned,))
        return problems
    for what, value in (("browser", want_self), ("Android", want_peer)):
        if not isinstance(value, str) or not ID16.fullmatch(value):
            problems.append("the round's planned %s id %r is not 16 lowercase hex characters"
                            % (what, value))
    if problems:
        return problems
    if want_self == want_peer:
        problems.append("the round planned the SAME id %s for both clients" % want_self)
        return problems
    if planned_role_of(want_self, want_peer) != planned:
        problems.append("the schedule is inconsistent: planned ids %s/%s make the browser %s, "
                        "not the planned %s"
                        % (want_self, want_peer, planned_role_of(want_self, want_peer), planned))
        return problems

    wire = browser.get("wire")
    if not isinstance(wire, dict) or not isinstance(wire.get("sockets"), list):
        problems.append("the browser report carries no wire history")
        return problems
    sockets = wire["sockets"]
    if len(sockets) != 1:
        problems.append("the browser page opened %d websockets, not one; a reconnect or a second "
                        "socket consumes a scheduled id" % len(sockets))
        return problems
    sock = sockets[0]
    for key in ("welcomes", "rosters", "lefts", "signals"):
        if not isinstance(sock.get(key), list):
            problems.append("the browser socket record has no %r history" % key)
    if problems:
        return problems

    # -- the id the server actually assigned to the browser ------------------
    welcomes = sock["welcomes"]
    if len(welcomes) != 1:
        problems.append("the browser saw %d welcomes, not exactly one" % len(welcomes))
        return problems
    self_id = welcomes[0]
    if not isinstance(self_id, str) or not ID16.fullmatch(self_id):
        problems.append("the browser's welcome id %r is not 16 lowercase hex characters" % (self_id,))
        return problems
    if self_id != want_self:
        problems.append("the server welcomed the browser as %s, not the planned %s (a foreign round, "
                        "an extra accepted socket, or a reordered join)" % (self_id, want_self))

    # -- the Android id, from the rosters the browser actually received ------
    rosters = sock["rosters"]
    if not rosters:
        problems.append("the browser received no room roster at all")
        return problems
    others = set()
    for roster in rosters:
        if not isinstance(roster, list) or not all(isinstance(i, str) for i in roster):
            problems.append("a roster record is malformed: %r" % (roster,))
            return problems
        if self_id not in roster:
            problems.append("a roster omitted the browser's own id %s: %r" % (self_id, roster))
        if len(set(roster)) != len(roster):
            problems.append("a roster named the same id twice: %r" % (roster,))
        others.update(i for i in roster if i != self_id)
    if len(others) != 1:
        problems.append("the rosters named %d peers besides the browser (%s), not exactly the "
                        "Android app" % (len(others), sorted(others)))
        return problems
    peer_id = next(iter(others))
    if not ID16.fullmatch(peer_id):
        problems.append("the Android id %r is not 16 lowercase hex characters" % (peer_id,))
        return problems
    if peer_id != want_peer:
        problems.append("the room's Android id was %s, not the planned %s" % (peer_id, want_peer))
    present = [peer_id in roster for roster in rosters]
    first = present.index(True) if True in present else -1
    last = len(present) - 1 - present[::-1].index(True) if True in present else -1
    if first < 0 or not all(present[first:last + 1]):
        problems.append("the Android peer left the roster and came back within one round: %r"
                        % (rosters,))
    for gone in sock["lefts"]:
        if gone != peer_id:
            problems.append("the hub reported a departure of %r, which is not this round's Android "
                            "peer" % (gone,))

    # -- the role those REAL ids imply ---------------------------------------
    real_role = planned_role_of(self_id, peer_id)
    if real_role != planned:
        problems.append("the assigned ids %s/%s make the browser %s, not the planned %s"
                        % (self_id, peer_id, real_role, planned))

    # -- the role the browser actually PLAYED on the wire --------------------
    counts = {}
    for sig in sock["signals"]:
        if not isinstance(sig, dict) or sig.get("dir") not in ("in", "out") \
                or sig.get("kind") not in ("request", "offer", "answer", "other"):
            problems.append("a signal record is malformed: %r" % (sig,))
            continue
        if sig.get("peer") != peer_id:
            problems.append("a %s %s signal was %s %r, not this round's Android peer"
                            % (sig["dir"], sig["kind"], "addressed to" if sig["dir"] == "out" else "from",
                               sig.get("peer")))
        key = (sig["dir"], sig["kind"])
        counts[key] = counts.get(key, 0) + 1
    out_offer, in_offer = counts.get(("out", "offer"), 0), counts.get(("in", "offer"), 0)
    out_req, in_req = counts.get(("out", "request"), 0), counts.get(("in", "request"), 0)
    out_ans, in_ans = counts.get(("out", "answer"), 0), counts.get(("in", "answer"), 0)
    if out_offer and in_offer:
        problems.append("offers went in BOTH directions (%d out, %d in); one link has one initiator"
                        % (out_offer, in_offer))
    elif out_offer:
        wire_role = "initiator"
    elif in_offer:
        wire_role = "responder"
    else:
        problems.append("no link offer crossed the browser's socket in either direction")
    if not (out_offer and in_offer) and (out_offer or in_offer):
        if wire_role != planned:
            problems.append("the browser's wire role %r is not the planned %r (%d offer(s) out, "
                            "%d in)" % (wire_role, planned, out_offer, in_offer))
        # The asking and the answering must point the same way as the offers.
        if wire_role == "initiator" and (out_req or out_ans):
            problems.append("the browser offered yet also sent %d link request(s) and %d answer(s), "
                            "which only a responder sends" % (out_req, out_ans))
        if wire_role == "responder" and (in_req or in_ans):
            problems.append("the browser received offers yet also received %d link request(s) and "
                            "%d answer(s), which only an initiator receives" % (in_req, in_ans))

    # -- this file's arithmetic must merely agree, never decide --------------
    for key, want in (("selfId", self_id), ("peerId", peer_id), ("role", planned)):
        if browser.get(key) != want:
            problems.append("the browser report's %s %r disagrees with its own wire history (%r)"
                            % (key, browser.get(key), want))
    return problems


def identity_summary(browser, expect):
    """One CI log line per round: the real ids, the plan and the wire."""
    sock = browser["wire"]["sockets"][0]
    counts = {}
    for sig in sock["signals"]:
        counts[(sig["dir"], sig["kind"])] = counts.get((sig["dir"], sig["kind"]), 0) + 1
    return ("-- round %s identities: browser %s (planned %s), Android %s (planned %s), planned role "
            "%s, wire offers out %d / in %d, requests out %d / in %d, sockets %d, welcomes %d"
            % (expect.get("round"), sock["welcomes"][0], expect["expectedBrowserId"],
               browser["peerId"], expect["expectedAndroidId"], expect["plannedRole"],
               counts.get(("out", "offer"), 0), counts.get(("in", "offer"), 0),
               counts.get(("out", "request"), 0), counts.get(("in", "request"), 0),
               len(browser["wire"]["sockets"]), len(sock["welcomes"])))


# -- the welcome barrier's receipt --------------------------------------------

def judge_receipt(path, rnd, nonce, want_id):
    problems = []
    try:
        st = os.lstat(path)
    except OSError as err:
        return ["the welcome receipt %s is absent (%s); the browser was never welcomed" % (path, err)]
    if not stat.S_ISREG(st.st_mode):
        return ["the welcome receipt %s is not a regular file" % path]
    if stat.S_IMODE(st.st_mode) != 0o600:
        problems.append("the welcome receipt has mode %o, not 0600" % stat.S_IMODE(st.st_mode))
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        receipt = json.loads(text)
    except (OSError, ValueError) as err:
        return problems + ["the welcome receipt is unreadable or not JSON: %s" % err]
    if not text.endswith("\n") or not isinstance(receipt, dict):
        return problems + ["the welcome receipt is truncated or not an object"]
    want = {"round": rnd, "nonce": nonce, "selfId": want_id, "expectedSelfId": want_id,
            "sockets": 1, "welcomes": 1}
    if set(receipt) != set(want):
        problems.append("the welcome receipt carries fields %s, want exactly %s"
                        % (sorted(receipt), sorted(want)))
    for key, value in want.items():
        if receipt.get(key) != value:
            problems.append("the welcome receipt's %s is %r, want %r" % (key, receipt.get(key), value))
    return problems


# -- every accepted websocket, counted ----------------------------------------
#
# The server's deterministic hook logs one line per accepted /ws through its
# injected logger, `acceptancePeerIDLogFormat` in server/main.go, after Go's
# standard log prefix. The ids CYCLE, so the ids alone cannot tell six accepted
# sockets from twelve; the sequence numbers can. Lines from concurrent accepts
# may be written out of order, so the judgement is over the SET of sequence
# numbers, never over physical line order.

PEER_ID_MARKER = "relayium-acceptance-peer-id"
PEER_ID_LINE = re.compile(
    r"(?:\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})? )?"
    + re.escape(PEER_ID_MARKER) + r" seq=([1-9][0-9]*) id=([0-9a-f]{16})")


def parse_schedule(ids_csv):
    ids = ids_csv.split(",")
    problems = []
    if len(ids) < 2 or not all(ID16.fullmatch(i) for i in ids):
        problems.append("the schedule %r is not a list of 16-lowercase-hex ids" % (ids_csv,))
    elif len(set(ids)) != len(ids):
        problems.append("the schedule repeats an id; a repeated id cannot tell rounds apart")
    return ids, problems


def judge_peer_id_log(text, ids):
    """Returns (problems, table) for a complete server log."""
    problems = []
    if not text:
        return ["the server log is empty; no accepted socket was recorded"], []
    if not text.endswith("\n"):
        problems.append("the server log does not end with a newline; it was truncated or read "
                        "while still being written")
    seen = {}
    for line in text.split("\n"):
        if PEER_ID_MARKER not in line:
            continue
        m = PEER_ID_LINE.fullmatch(line)
        if not m:
            problems.append("a peer-id log line is malformed: %r" % line)
            continue
        seq, got = int(m.group(1)), m.group(2)
        if seq in seen:
            problems.append("sequence %d was logged twice" % seq)
            continue
        seen[seq] = got
    want = list(range(1, len(ids) + 1))
    if sorted(seen) != want:
        missing = [s for s in want if s not in seen]
        extra = sorted(s for s in seen if s > len(ids))
        problems.append("the server accepted %d websocket(s), not exactly the %d scheduled "
                        "(missing %s, extra %s)" % (len(seen), len(ids), missing, extra))
    for seq in sorted(seen):
        want_id = ids[(seq - 1) % len(ids)]
        if seen[seq] != want_id:
            problems.append("sequence %d carried %s, but the schedule's %s entry is %s"
                            % (seq, seen[seq], ordinal(seq), want_id))
    table = [(seq, seen[seq]) for seq in sorted(seen)]
    return problems, table


def ordinal(n):
    return "%d%s" % (n, "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th"))


def report(problems):
    for p in problems:
        print("  - %s" % p, file=sys.stderr)
    return 1 if problems else 0


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "ready-receipt":
        if len(sys.argv) != 6:
            print("usage: android-interop-oracle.py ready-receipt <receipt> <round> <nonce> <id16>",
                  file=sys.stderr)
            return 2
        return report(judge_receipt(*sys.argv[2:6]))
    if len(sys.argv) >= 2 and sys.argv[1] == "peer-id-log":
        if len(sys.argv) != 4:
            print("usage: android-interop-oracle.py peer-id-log <server.log> <ids-csv>", file=sys.stderr)
            return 2
        ids, problems = parse_schedule(sys.argv[3])
        if problems:
            return report(problems)
        try:
            with open(sys.argv[2], encoding="utf-8", errors="strict") as fh:
                text = fh.read()
        except (OSError, ValueError) as err:
            return report(["the server log is unreadable: %s" % err])
        problems, table = judge_peer_id_log(text, ids)
        for seq, got in table:
            print("-- accepted websocket seq=%d id=%s" % (seq, got), file=sys.stderr)
        if problems:
            return report(problems)
        print("-- the server accepted exactly the %d scheduled websockets, one id each" % len(ids),
              file=sys.stderr)
        return 0
    if len(sys.argv) != 4:
        print("usage: android-interop-oracle.py <browser.json> <android.json> <expect.json>",
              file=sys.stderr)
        return 2
    browser = json.load(open(sys.argv[1]))
    android = json.load(open(sys.argv[2]))
    expect = json.load(open(sys.argv[3]))

    problems = judge(browser, android, expect)
    if problems:
        for p in problems:
            print("  - %s" % p, file=sys.stderr)
        print("browser: %s" % json.dumps(browser, ensure_ascii=False)[:2000], file=sys.stderr)
        print("android: %s" % json.dumps(android, ensure_ascii=False)[:2000], file=sys.stderr)
        return 1

    print(identity_summary(browser, expect), file=sys.stderr)
    print("-- round agreed: %s, both directions, files byte-identical (browser was %s)"
          % ("SAS %s on both sides" % browser["sas"] if expect.get("verify") == "on"
             else "verification at its shipped default", browser.get("role")),
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
