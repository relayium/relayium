#!/usr/bin/env python3
"""The judge of one CLI ↔ Android emulator round (A12).

    cli-android-oracle.py PLAN.json CLI_OBSERVED.json ANDROID_OBSERVED.json

Exit 0 and print the CLI's link role on stdout when the round agrees; exit 1
with every problem on stderr otherwise. The CLI's received tree is read off
disk HERE and compared with digests derived HERE from the plan's seeds; the
Android half's saved files are its own digests of what it wrote to the tree
the app was handed (`InteropDriver.readSaved`), compared with digests derived
here from the CLI's staged seeds.
"""
import hashlib
import json
import os
import re
import sys

SEND_AGAIN = "relayium-e2e:send-again"
# One flow window (linkwire.FlowWindowBytes / RealtimeFrame.FLOW_WINDOW_BYTES).
FLOW_WINDOW = 8 * 1024 * 1024
STOP_LINE = "not delivered: the other side stopped the transfer"


def body(size, seed):
    period = bytes(((i * 31 + seed) & 0xFF) for i in range(256))
    reps, rest = divmod(size, 256)
    return period * reps + period[:rest]


def digest(size, seed):
    return hashlib.sha256(body(size, seed)).hexdigest()


def tree(root):
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for d in dirnames:
            out[os.path.relpath(os.path.join(dirpath, d), root) + "/"] = {"dir": True}
        for f in filenames:
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, root)
            if os.path.islink(full) or not os.path.isfile(full):
                out[rel] = {"special": True}
                continue
            data = open(full, "rb").read()
            out[rel] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    return out


def judge(plan, cli_obs, android):
    problems = []
    p = problems.append
    if not cli_obs.get("complete"):
        p("the CLI half did not complete (steps: %r)" % cli_obs.get("steps"))
    if not android.get("complete"):
        p("the Android half did not complete")
    cli = cli_obs.get("cli") or {}
    stderr = cli.get("stderr") or []

    linked = [m for m in (re.match(r"^linked with (.*) \(end-to-end encrypted link/1, (initiator|responder)\)$", l)
                          for l in stderr) if m]
    role = ""
    if len(linked) != 1:
        p("the CLI printed %d linked lines, not one" % len(linked))
    else:
        role = linked[0].group(2)
        if linked[0].group(1) != "a Relayium app or the web page":
            p("the CLI named the Android peer %r" % linked[0].group(1))
    sas = [m.group(1) for m in (re.match(r"^verification code \(SAS\): (\S+) — ", l) for l in stderr) if m]
    a_sas = re.sub(r"\D", "", str(android.get("sas") or ""))
    if len(sas) != 1 or not a_sas or re.sub(r"\D", "", sas[0]) != a_sas:
        p("the SAS differ or are missing: CLI %r, Android %r" % (sas, android.get("sas")))

    # text
    if android.get("receivedMessage") != plan["cliMessage"]:
        p("Android received %r, not the CLI's message" % (android.get("receivedMessage"),))
    want_stdout = plan["androidMessage"] + "\n" + SEND_AGAIN + "\n" + plan["postMessage"] + "\n"
    if cli.get("stdout") != want_stdout:
        p("the CLI's stdout is not exactly Android's three messages: %r" % (cli.get("stdout", "")[:600],))

    # cli → android
    want_saved = ([] if plan["cancel"] == "receive" else plan["first"]) + plan["second"]
    got_saved = {s.get("name"): s for s in (android.get("saved") or [])}
    for e in want_saved:
        g = got_saved.get(e["name"])
        if not g or g.get("size") != e["size"] or str(g.get("sha256", "")).lower() != digest(e["size"], e["seed"]):
            p("Android did not save %s exactly: %r" % (e["name"], g))
    extra = sorted(set(got_saved) - {e["name"] for e in want_saved})
    if extra:
        p("Android saved entries nobody expected: %r" % extra)
    if plan["cancel"] == "receive":
        leaked = [e["name"] for e in plan["first"] if e["size"] > 0 and e["name"] in (android.get("treeAfter") or [])]
        if leaked:
            p("the cancelled receive left files in Android's tree: %r" % leaked)

    # android → cli, read off disk
    files = tree(plan["dest"])
    want = {e["name"]: e for e in plan["android"]["expectSaved"]}
    for name, e in sorted(want.items()):
        g = files.get(name)
        if not g or g.get("size") != e["size"] or g.get("sha256") != digest(e["size"], e["seed"]):
            p("the CLI did not save %s exactly: %r" % (name, g))
    for extra in sorted(set(files) - set(want)):
        p("the CLI's destination holds an entry it must not: %s" % extra)

    gate = judge_gate(plan, cli_obs, android, p)

    # the CLI's own account, counted
    def count(rx):
        return sum(1 for l in stderr if re.search(rx, l))
    delivered = count(r"^delivered: the other side verified and saved the files$")
    stopped = count(r"^not delivered: the other side stopped the transfer$")
    saved = count(r"^saved: every file verified and written to disk in ")
    declined = count(r"^not sent: the other side declined the files$")
    if gate:
        # An ACTIVE receive cancel: the first write was held, so the CLI was
        # mid-send when the refusal arrived. Exactly a STOP — a DECLINE (before
        # acceptance) or "could not save" (after the last byte) are impossible
        # for a cancel that really was active, so either one is a failure.
        if (delivered, stopped, declined) != (1, 1, 0):
            p("active receive-cancel round: CLI reported delivered %d / stopped %d / declined %d, not 1 / 1 / 0"
              % (delivered, stopped, declined))
        if count(r"^not delivered: the other side could not save the files$"):
            p("active receive-cancel round: the CLI reported a save failure")
        if cli_obs.get("firstBatchOutcome") != STOP_LINE:
            p("active receive-cancel round: the CLI's first batch ended %r, not the stop"
              % (cli_obs.get("firstBatchOutcome"),))
    elif plan["cancel"] == "receive":
        # Android cancels on acceptance: a STOP if bytes had started, a DECLINE
        # if both landed before the first byte. Exactly one, never a delivery.
        if delivered != 1 or stopped + declined != 1:
            p("receive-cancel round: CLI reported delivered %d / stopped %d / declined %d, not 1 / one refusal"
              % (delivered, stopped, declined))
    elif (delivered, stopped, declined) != (2, 0, 0):
        p("CLI reported delivered %d / stopped %d / declined %d, not 2 / 0 / 0" % (delivered, stopped, declined))
    if saved != 2:
        p("the CLI reported %d saved batches, not 2" % saved)
    for rx, what in [(r"^the link ended: ", "an abnormal link end"),
                     (r"^messages: ", "a text-lane failure")]:
        if count(rx):
            p("the CLI reported %s" % what)
    # How the session ended. Android leaves only AFTER it has seen the CLI's
    # DONE (every expectation above is met by then), by closing its Activity.
    # Observed 2026-09-24: that teardown (ViewModel.onCleared → closeOnSession)
    # sends no authenticated leave, so the CLI truthfully reports a lost
    # connection and exits 1. Either ending is accepted here — the lane must not
    # turn red the day Android starts announcing its leave — but exactly one
    # must have happened, and the exit code must follow the CLI's own table.
    left = count(r"^the other side ended the session$")
    lost = count(r"^the connection to the other side was lost$")
    ending = "leave" if (left, lost) == (1, 0) else "drop" if (left, lost) == (0, 1) else ""
    if not ending:
        p("the session did not end exactly once by Android's leave or drop (leave %d, lost %d)" % (left, lost))
    want_exit = 1 if plan["cancel"] == "receive" or ending == "drop" else 0
    if (cli.get("exit") or {}).get("code") != want_exit:
        p("the CLI exited %r, not %d (ending: %s)" % (cli.get("exit"), want_exit, ending or "?"))
    return problems, role, ending


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def judge_gate(plan, cli_obs, android, p):
    """The plan's receive gate, and — when it is on — the Android half's typed
    record of an ACTIVE receive cancel. Returns whether the gate is on.

    Every field is required with its exact type; nothing absent is defaulted.
    The record is what the instrumentation observed on the real store and the
    real controller state, in the order the store numbered it."""
    if "receiveGate" not in plan:
        p("the plan does not say whether the receive gate is on")
        return False
    mode = plan["receiveGate"]
    if mode is None:
        if "activeReceiveCancel" in android:
            p("Android reported an active receive cancel in a round that did not plan one")
        return False
    if mode != "first-write":
        p("the plan names an unknown receive gate %r" % (mode,))
        return True
    if plan["cancel"] != "receive":
        p("the receive gate is planned for a %r round" % (plan["cancel"],))
    first = plan["first"]
    if not first or not is_int(first[0].get("size")) or first[0]["size"] <= FLOW_WINDOW:
        p("the gated batch's first body is not larger than one flow window (%r)"
          % (first[0].get("size") if first else None,))
    rec = android.get("activeReceiveCancel")
    if not isinstance(rec, dict):
        p("Android reported no active receive-cancel record")
        return True
    names = [e["name"] for e in first]

    def need(key, ok, what):
        if key not in rec:
            p("the active receive-cancel record has no %r" % key)
        elif not ok(rec[key]):
            p("the active receive-cancel record's %s is %r: %s" % (key, rec[key], what))

    need("mode", lambda v: v == "first-write", "not the first-write gate")
    need("storeSerial", lambda v: is_int(v) and is_int(rec.get("storeSerialBefore")) and v == rec["storeSerialBefore"] + 1,
         "not the one store this launch built")
    need("storeSerialBefore", is_int, "not an integer")
    need("token", lambda v: is_int(v) and v >= 1, "no owner token")
    need("boundGeneration", lambda v: is_int(v) and v >= 1, "the gate never bound to a batch")
    need("manifest", lambda v: v == names, "not the CLI's first batch")
    need("heldIndex", lambda v: is_int(v) and v == 0, "not the batch's first file")
    need("heldBytes", lambda v: is_int(v) and v > 0, "nothing was held")
    need("okWritesBeforeHold", lambda v: is_int(v) and v == 0, "bytes were durable (and acknowledged) before the hold")
    need("incomingAtCancel", lambda v: v == names, "the cancel was not of the held batch")
    need("progressNullAtCancel", lambda v: v is True, "progress was already reported at the cancel")
    need("errorKeyAtCancel", lambda v: v is None, "an error stood before the cancel")
    need("laneDownAtCancel", lambda v: v is False, "the file lane was down at the cancel")
    need("phaseAtCancel", lambda v: v == "CONNECTED", "the link was not connected")
    need("linkAtCancel", lambda v: is_int(v) and v == android.get("linkId"), "not this round's link")
    need("effectWhileHeld", lambda v: v is True, "the cancel's effect was not observed while the write was held")
    need("errorKeyAfterEffect", lambda v: v is None, "the cancel left an error (a save failure is not a cancel)")
    need("laneDownAfterEffect", lambda v: v is False, "the cancel took the file lane down")
    need("phaseAfterEffect", lambda v: v == "CONNECTED", "the link did not stay connected")
    need("linkAfterEffect", lambda v: is_int(v) and v == android.get("linkId"), "not this round's link")
    need("releasedBy", lambda v: v == "test", "the hold was not released by the test after the cancel")
    need("heldWriteOutcome", lambda v: v == "ok",
         "the held write did not complete cleanly (a storage failure must not hide behind the cancel)")
    need("discardGeneration", lambda v: is_int(v) and v == rec.get("boundGeneration"), "not the cancelled batch's rollback")
    need("discardDuringBegin", lambda v: v is False, "a begin's defensive discard, not the cancellation's rollback")
    need("discardOutcome", lambda v: v == "ok", "the cancelled batch's rollback did not complete")
    marks = rec.get("marks")
    if not isinstance(marks, dict):
        p("the active receive-cancel record has no event marks")
        marks = {}
    order = [("holdSeq", rec.get("holdSeq")), ("cancelCalled", marks.get("cancelCalled")),
             ("cancelEffectObserved", marks.get("cancelEffectObserved")), ("releaseSeq", rec.get("releaseSeq")),
             ("heldWriteSeq", rec.get("heldWriteSeq")), ("discardSeq", rec.get("discardSeq"))]
    missing = [k for k, v in order if not is_int(v)]
    if missing:
        p("the active receive-cancel record is missing events %r" % missing)
    else:
        seqs = [v for _, v in order]
        if seqs != sorted(seqs) or len(set(seqs)) != len(seqs):
            p("the active receive-cancel events are out of order: %r" % order)
    # The rollback and the retry, as the instrumentation saw them.
    after = android.get("treeAfterCancel")
    if not isinstance(after, list) or not all(isinstance(x, str) for x in after):
        p("the gated round has no post-cancel tree")
    else:
        leaked = [n for n in names if n in after]
        if leaked:
            p("the cancelled receive left files behind: %r" % leaked)
        if "sentinel-do-not-touch.txt" not in after:
            p("the rollback removed content it did not own")
    if android.get("cleanupIncompleteAfterCancel") is not False:
        p("the cancelled batch's rollback was not complete (%r)" % (android.get("cleanupIncompleteAfterCancel"),))
    return True


def main(argv):
    if len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    plan, cli_obs, android = (json.load(open(a)) for a in argv[1:4])
    problems, role, ending = judge(plan, cli_obs, android)
    if problems:
        for x in problems:
            print("  - %s" % x, file=sys.stderr)
        return 1
    print("-- round %s agreed: code by %s, cancel=%s, CLI was %s, Android ended the session by %s"
          % (plan["round"], plan["codeRole"], plan["cancel"], role,
             "an authenticated leave" if ending == "leave" else "dropping the connection (no leave)"),
          file=sys.stderr)
    print(role)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
