#!/usr/bin/env python3
"""The judge of one CLI ↔ macOS app round (A12).

    cli-mac-oracle.py PLAN.json OBSERVED.json

Exit 0 and print the CLI's link role on stdout when the round agrees. The
CLI's tree is read off disk here; the Mac's receipts are what its production
models recorded (`AppPairLinkHost.observed`), compared with digests derived
here from the CLI's staged seeds.
"""
import hashlib
import json
import os
import re
import sys


def body(size, seed):
    period = bytes(((i * 31 + seed) & 0xFF) for i in range(256))
    reps, rest = divmod(size, 256)
    return period * reps + period[:rest]


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


def judge(plan, obs):
    problems = []
    p = problems.append
    if not obs.get("complete"):
        p("the round did not complete (steps: %r)" % obs.get("steps"))
    cli = obs.get("cli") or {}
    stderr = cli.get("stderr") or []
    mac = obs.get("mac") or {}

    linked = [m for m in (re.match(r"^linked with (.*) \(end-to-end encrypted link/1, (initiator|responder)\)$", l)
                          for l in stderr) if m]
    role = ""
    if len(linked) != 1:
        p("the CLI printed %d linked lines, not one" % len(linked))
    else:
        role = linked[0].group(2)
        if linked[0].group(1) != "a Relayium app or the web page":
            p("the CLI named the Mac %r" % linked[0].group(1))
    sas = [m.group(1) for m in (re.match(r"^verification code \(SAS\): (\S+) — ", l) for l in stderr) if m]
    m_sas = re.sub(r"\D", "", str(mac.get("sas") or ""))
    if len(sas) != 1 or not m_sas or re.sub(r"\D", "", sas[0]) != m_sas:
        p("the SAS differ or are missing: CLI %r, Mac %r" % (sas, mac.get("sas")))
    if mac.get("legacyFallback"):
        p("the Mac fell back to the legacy wire: %r" % mac.get("legacyFallback"))

    if cli.get("stdout") != plan["macMessage"] + "\n":
        p("the CLI's stdout is not exactly the Mac's message: %r" % (cli.get("stdout", "")[:400],))
    if plan["cliMessage"] not in (mac.get("messages") or []) + (mac.get("allMessages") or []):
        p("the Mac never recorded the CLI's message")

    # mac → cli, off disk
    files = tree(plan["dest"])
    want = {}
    for f in plan["macFiles"]:
        data = f["contents"].encode("utf-8")
        want[f["name"]] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    for name, w in want.items():
        if files.get(name) != w:
            p("the CLI did not save %s exactly: %r" % (name, files.get(name)))
    for extra in sorted(set(files) - set(want)):
        p("the CLI's destination holds an entry it must not: %s" % extra)

    # cli → mac: the Mac's receive root, read off disk here — the strict check,
    # including the directory tree's root folder and nesting.
    expected = plan["cliBatches"]["flat"] + plan["cliBatches"]["dir"]["entries"]
    mac_tree = tree(plan["macReceive"])
    want_mac = {e["path"]: e for e in expected}
    want_dirs = set()
    for e in plan["cliBatches"]["dir"]["entries"]:
        parts = e["path"].split("/")[:-1]
        for i in range(1, len(parts) + 1):
            want_dirs.add("/".join(parts[:i]) + "/")
    for path, e in sorted(want_mac.items()):
        g = mac_tree.get(path)
        if not g or g.get("size") != e["size"] or g.get("sha256") != hashlib.sha256(body(e["size"], e["seed"])).hexdigest():
            p("the Mac did not write %s exactly: %r" % (path, g))
    for extra in sorted(set(mac_tree) - set(want_mac) - want_dirs):
        p("the Mac's receive root holds an entry nobody sent: %s" % extra)
    # And the app's own receipts agree with the disk. A receipt's `path` is
    # relative to the batch's top folder, so it is compared by file name.
    receipts = mac.get("allFiles") or mac.get("files") or []
    by_name = {}
    for r in receipts:
        by_name.setdefault(r.get("name"), []).append(r)
    for e in expected:
        got = by_name.get(e["name"]) or []
        want_sha = hashlib.sha256(body(e["size"], e["seed"])).hexdigest()
        if len(got) != 1 or got[0].get("size") != e["size"] or str(got[0].get("sha256", "")).lower() != want_sha:
            p("the Mac's receipts for %s do not match: %r" % (e["name"], got))

    def count(rx):
        return sum(1 for l in stderr if re.search(rx, l))
    if count(r"^saved: every file verified and written to disk in ") != 2:
        p("the CLI did not report exactly two saved batches")
    if count(r"^delivered: the other side verified and saved the files$") != 2:
        p("the CLI did not report exactly two delivered batches")
    for rx, what in [(r"^the connection to the other side was lost$", "a lost connection"),
                     (r"^the link ended: ", "an abnormal link end"),
                     (r"^not (sent|delivered|saved|confirmed)", "an incomplete batch")]:
        if count(rx):
            p("the CLI reported %s" % what)
    if (cli.get("exit") or {}).get("code") != 0:
        p("after /quit with everything delivered the CLI exited %r, not 0" % (cli.get("exit"),))
    return problems, role


def main(argv):
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    plan, obs = json.load(open(argv[1])), json.load(open(argv[2]))
    problems, role = judge(plan, obs)
    if problems:
        for x in problems:
            print("  - %s" % x, file=sys.stderr)
        return 1
    print("-- round %s agreed: code by %s, CLI was %s" % (plan["round"], plan["codeRole"], role), file=sys.stderr)
    print(role)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
