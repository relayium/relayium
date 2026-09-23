#!/usr/bin/env python3
"""The judge of one CLI ↔ Web round (A12).

    cli-web-oracle.py PLAN.json OBSERVED.json

Exit 0 and print the CLI's link role (`initiator`/`responder`) on stdout when
the round agrees; exit 1 with every problem on stderr when it does not.

It trusts neither endpoint's own summary:
  * the CLI's received TREE is read off disk here, every regular file hashed
    here, and compared with digests derived here from the plan's seeds — an
    extra file (a declined or cancelled batch, a leftover partial or staging
    file) fails as surely as a missing one;
  * the page's saves come from its save ledger (bytes the product wrote,
    hashed in the page) and are compared with digests derived here;
  * the CLI's stdout must be EXACTLY the page's two messages, each followed by
    the newline `pair` appends off a terminal — stdout carries the peer's words
    and nothing else (A10 output contract);
  * every outcome line the CLI owes is counted, not merely found once;
  * both ends' own statements of the link role must be complementary, and on a
    `verify=on` round the two SAS must be the same digits.
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


def digest(size, seed):
    return hashlib.sha256(body(size, seed)).hexdigest()


def tree(root):
    """Every entry under root: files with size+sha256, and every directory."""
    files, dirs = {}, set()
    for dirpath, dirnames, filenames in os.walk(root):
        for d in dirnames:
            full = os.path.join(dirpath, d)
            if os.path.islink(full):
                files[os.path.relpath(full, root)] = {"symlink": True}
            else:
                dirs.add(os.path.relpath(full, root).replace(os.sep, "/"))
        for f in filenames:
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if os.path.islink(full) or not os.path.isfile(full):
                files[rel] = {"special": True}
                continue
            with open(full, "rb") as fh:
                data = fh.read()
            files[rel] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    return files, dirs


def count(lines, pattern):
    rx = re.compile(pattern)
    return sum(1 for l in lines if rx.search(l))


def judge(plan, obs):
    problems = []
    p = problems.append

    if not obs.get("complete"):
        p("the driver did not complete the round (steps reached: %r)" % obs.get("steps"))
    cli = obs.get("cli") or {}
    stderr = cli.get("stderr") or []
    web = obs.get("web") or {}

    # ── link roles and SAS ────────────────────────────────────────────────
    linked = [re.match(r"^linked with (.*) \(end-to-end encrypted link/1, (initiator|responder)\)$", l) for l in stderr]
    linked = [m for m in linked if m]
    cli_role = ""
    if len(linked) != 1:
        p("the CLI printed %d linked lines, not exactly one" % len(linked))
    else:
        cli_role = linked[0].group(2)
        if linked[0].group(1) != "a Relayium app or the web page":
            p("the CLI named its peer %r, not the app/web wording" % linked[0].group(1))
    web_role = web.get("role", "")
    if web_role not in ("initiator", "responder"):
        p("the page could not name its role: %r" % web_role)
    elif cli_role and {cli_role, web_role} != {"initiator", "responder"}:
        p("both ends claim the same link role: CLI %s, page %s" % (cli_role, web_role))

    sas = [re.match(r"^verification code \(SAS\): (\S+) — ", l) for l in stderr]
    sas = [m.group(1) for m in sas if m]
    if len(sas) != 1:
        p("the CLI printed %d SAS lines, not exactly one" % len(sas))
    if plan["verify"] == "on":
        wd = re.sub(r"\D", "", web.get("sas", ""))
        cd = re.sub(r"\D", "", sas[0]) if sas else ""
        if not wd:
            p("the page showed no SAS on a verify=on round")
        elif wd != cd:
            p("the two ends derived different SAS digits: page %s, CLI %s" % (wd, cd))

    # ── text ─────────────────────────────────────────────────────────────
    want_stdout = "".join(m + "\n" for m in plan["webMessages"])
    if cli.get("stdout") != want_stdout:
        p("the CLI's stdout is not exactly the page's two messages: %r" % (cli.get("stdout", "")[:600],))
    got_web_msgs = web.get("receivedMessages") or []
    for m in plan["cliMessages"]:
        if m not in got_web_msgs:
            p("the page never showed the CLI's message %r (it has %r)" % (m, got_web_msgs[-6:]))

    # ── web → cli: the tree on disk ───────────────────────────────────────
    files, dirs = tree(plan["dest"])
    want = {}
    for e in plan["webBatches"]["flat"]:
        want[e["name"]] = e
    for e in plan["webBatches"]["folder"]:
        want[e["path"]] = e
    for rel, e in sorted(want.items()):
        got = files.get(rel)
        if got is None:
            p("the CLI did not save %s (it has %s)" % (rel, sorted(files)))
        elif got.get("size") != e["size"] or got.get("sha256") != digest(e["size"], e["seed"]):
            p("the CLI saved %s with the wrong bytes: %r" % (rel, got))
    for rel in sorted(set(files) - set(want)):
        p("the CLI's destination holds an entry it must not: %s %r" % (rel, files[rel]))
    want_dirs = set()
    for e in plan["webBatches"]["folder"]:
        parts = e["path"].split("/")[:-1]
        for i in range(1, len(parts) + 1):
            want_dirs.add("/".join(parts[:i]))
    for d in sorted(dirs - want_dirs):
        p("the CLI's destination holds a directory it must not: %s/" % d)
    for d in sorted(want_dirs - dirs):
        p("the CLI's destination lacks the directory %s/" % d)

    # ── cli → web: the page's save ledger ─────────────────────────────────
    saves = web.get("saves") or []
    complete = [s for s in saves if s.get("closed") and not s.get("removed") and not s.get("aborted")]
    by_path = {}
    for s in complete:
        by_path.setdefault(s.get("path"), []).append(s)
    want_web = {}
    for e in plan["cliBatches"]["flat"]:
        want_web[e["name"]] = e
    for e in plan["cliBatches"]["dir"]["entries"]:
        want_web[e["path"]] = e
    for path, e in sorted(want_web.items()):
        got = by_path.get(path, [])
        if len(got) != 1:
            p("the page completed %d saves of %s, not exactly one (saves: %r)"
              % (len(got), path, [(s.get("path"), s.get("size")) for s in saves]))
            continue
        if got[0].get("size") != e["size"] or got[0].get("sha256") != digest(e["size"], e["seed"]):
            p("the page saved %s with the wrong bytes: size %r" % (path, got[0].get("size")))
    declined = plan["cliBatches"]["declined"]["name"]
    if any(s.get("name") == declined for s in saves):
        p("the page opened a save for %s, which it declined" % declined)
    stopped = [plan["cliBatches"]["cancel"]]
    if plan["ending"] == "interrupt":
        stopped.append(plan["cliBatches"]["final"])
    for e in stopped:
        for s in saves:
            if s.get("name") == e["name"] and s.get("size", 0) >= e["size"]:
                p("the page holds the FULL body of %s, which must not have completed" % e["name"])
            if s.get("name") == e["name"] and s.get("sha256") == digest(e["size"], e["seed"]):
                p("the page's save of %s matches the full body" % e["name"])
    extra = sorted(set(by_path) - set(want_web) - {e["name"] for e in stopped})
    if extra:
        p("the page completed saves nobody sent it: %r" % extra)

    # ── the CLI's own account of every outcome, counted ──────────────────
    expect_counts = [
        (r"^saved: every file verified and written to disk in ", 2, "saved"),
        (r"^declined$", 1, "its own decline"),
        (r"^delivered: the other side verified and saved the files$", 2, "delivered"),
        (r"^not sent: the other side declined the files$", 1, "the page's decline"),
        (r"^not saved: the sender cancelled; nothing from it was kept$", 1, "the sender's cancel"),
        (r"^not delivered: the other side stopped the transfer$", 1, "the receiver's stop"),
        (r"^the partial files of that batch were removed; nothing from it was kept$", 1, "the discard of the cancelled batch"),
    ]
    for pattern, n, what in expect_counts:
        got = count(stderr, pattern)
        if got != n:
            p("the CLI reported %s %d time(s), not %d" % (what, got, n))
    for pattern, what in [
        (r"^the connection to the other side was lost$", "a lost connection"),
        (r"^the link ended: ", "an abnormal link end"),
        (r"^messages: ", "a text-lane failure"),
        (r"not confirmed: the other side never confirmed", "an unconfirmed delivery"),
        (r"could not be written to stdout", "lost output"),
    ]:
        if count(stderr, pattern):
            p("the CLI reported %s" % what)
    if not obs.get("cancel", {}).get("webCancelClicked") or not obs.get("cancel", {}).get("resumed"):
        p("the sender-cancel cell did not run as planned: %r" % obs.get("cancel"))
    if not (obs.get("receiverCancel") or {}).get("clicked"):
        p("the receiver-stop cell did not run as planned: %r" % obs.get("receiverCancel"))

    # ── the ending ───────────────────────────────────────────────────────
    ex = cli.get("exit") or {}
    if plan["ending"] == "quit":
        # A declined batch, a sender cancel and a receiver stop are each a
        # batch that did not complete, so `pair` exits 1 (pair.go exit table).
        if ex.get("code") != 1:
            p("after /quit the CLI exited %r, not 1 (the round declined and cancelled batches)" % (ex,))
    else:
        if ex.get("code") != 130:
            p("after SIGINT the CLI exited %r, not 130" % (ex,))
        if count(stderr, r"^interrupted: leaving the session$") != 1:
            p("the CLI did not say it was leaving on the interrupt")
        if count(stderr, r"^delivered: ") > 2:
            p("the CLI reported the interrupted batch as delivered")
    return problems, cli_role, web_role


def main(argv):
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    plan = json.load(open(argv[1]))
    obs = json.load(open(argv[2]))
    problems, cli_role, web_role = judge(plan, obs)
    if problems:
        for x in problems:
            print("  - %s" % x, file=sys.stderr)
        return 1
    sdp = (obs.get("web") or {}).get("sdp") or {}
    print("-- round %s agreed: code by %s, CLI %s / page %s, SAS %s, page advertised "
          "max-message-size %r and saw the CLI advertise %r"
          % (plan["round"], plan["codeRole"], cli_role, web_role,
             "compared" if plan["verify"] == "on" else "not shown (default)",
             sorted({d.get("maxMessageSize") for d in sdp.get("local", [])}, key=str),
             sorted({d.get("maxMessageSize") for d in sdp.get("remote", [])}, key=str)),
          file=sys.stderr)
    print(cli_role)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
