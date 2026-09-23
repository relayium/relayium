#!/usr/bin/env python3
"""One round's plan for an A12 CLI interop cell, and the CLI's staged sources.

    cli-matrix-plan.py web     RUN_ROOT ROUND CODE_ROLE VERIFY ENDING  > plan.json
    cli-matrix-plan.py android RUN_ROOT ROUND CODE_ROLE CANCEL [CODE]  > plan.json
    cli-matrix-plan.py mac     RUN_ROOT ROUND CODE_ROLE                > plan.json

Writes the plan to stdout and stages every file the CLI will `/send` under
RUN_ROOT/stage-ROUND (created fresh; it must not exist). The receive
destination RUN_ROOT/dest-ROUND is created empty.

Every payload is `(i * 31 + seed) & 0xff` — the same rule the page generates
in `web/e2e/cli-web-pairing.mjs`, the Android instrumentation uses
(`InteropAcceptanceTest.payload`) and the oracles recompute. Distinct seeds
per file, so a file that arrives carrying its neighbour's bytes under its own
name fails on the digest even when count, names and sizes all agree.

The body sizes are chosen, not arbitrary:
  * 199_000 and 250_000 cross the 192 KiB (196_608 B) logical fragment;
  * zero-byte files ride in the MIDDLE of a batch (no chunk at all);
  * the cancel bodies are 12 MiB + 4 KiB, larger than one 8 MiB flow window,
    so a receiver that acknowledges nothing holds the sender short of DONE.
"""
import json
import os
import sys

FLOW_BEYOND = 12 * 1024 * 1024 + 4096


def body(size, seed):
    return bytes(((i * 31 + seed) & 0xFF) for i in range(size)) if size < 1_000_000 else _big(size, seed)


def _big(size, seed):
    # Same rule, built by repeating one 256-byte period (i*31 mod 256 has
    # period 256 because 31 is odd), so a 12 MiB body costs milliseconds.
    period = bytes(((i * 31 + seed) & 0xFF) for i in range(256))
    reps, rest = divmod(size, 256)
    return period * reps + period[:rest]


def stage(root, rel, size, seed):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "xb") as f:
        f.write(body(size, seed))
    return path


def web_plan(run_root, rnd, code_role, verify, ending):
    r = int(rnd)
    stage_root = os.path.join(run_root, "stage-%d" % r)
    dest = os.path.join(run_root, "dest-%d" % r)
    os.makedirs(stage_root)
    os.makedirs(dest)

    webdir = "web-dir-%d" % r
    web = {
        "flat": [
            {"name": "web-big-%d.bin" % r, "size": 199_000, "seed": r},
            {"name": "web-zero-%d.bin" % r, "size": 0, "seed": 0},
            {"name": "web-small-%d.txt" % r, "size": 1024, "seed": r + 7},
        ],
        "folder": [
            {"name": "deep-%d.bin" % r, "path": "%s/sub/deep-%d.bin" % (webdir, r), "size": 70_000, "seed": r + 11},
            {"name": "empty-%d.bin" % r, "path": "%s/sub/empty-%d.bin" % (webdir, r), "size": 0, "seed": 0},
            {"name": "top-%d.txt" % r, "path": "%s/top-%d.txt" % (webdir, r), "size": 333, "seed": r + 12},
        ],
        "declined": [{"name": "web-declined-%d.bin" % r, "size": 5000, "seed": r + 13}],
        "cancel": {"name": "web-cancel-%d.bin" % r, "size": FLOW_BEYOND, "seed": r + 30},
    }

    def cli_entry(rel, size, seed, name=None):
        return {"name": name or os.path.basename(rel), "rel": rel, "size": size, "seed": seed,
                "src": stage(stage_root, rel, size, seed)}

    clidir = "cli-dir-%d" % r
    flat = [
        cli_entry("flat/cli-big-%d.bin" % r, 250_000, r + 40),
        cli_entry("flat/cli-zero-%d.bin" % r, 0, 0),
        cli_entry("flat/cli-small-%d.txt" % r, 2048, r + 41),
    ]
    dir_entries = [
        cli_entry("%s/a/b/nested-%d.bin" % (clidir, r), 90_000, r + 42),
        cli_entry("%s/a/empty-%d.bin" % (clidir, r), 0, 0),
        cli_entry("%s/top-%d.txt" % (clidir, r), 100, r + 43),
    ]
    cli = {
        "flat": flat,
        "dir": {"src": os.path.join(stage_root, clidir), "root": clidir,
                "entries": [dict(e, path=e["rel"]) for e in dir_entries]},
        "declined": cli_entry("cli-declined-%d.bin" % r, 4000, r + 44),
        "cancel": cli_entry("cli-cancel-%d.bin" % r, FLOW_BEYOND, r + 45),
        "final": cli_entry("cli-final-%d.bin" % r, FLOW_BEYOND, r + 46),
    }
    return {
        "cell": "cli-web",
        "round": r,
        "codeRole": code_role,
        "verify": verify,
        "ending": ending,
        "dest": dest,
        "stage": stage_root,
        # Whitespace-significant and non-ASCII on purpose: anything that trims,
        # normalises or re-encodes fails the exact comparison.
        "webMessages": [
            "  web → cli %d:\n\n\t你好 مرحبا 🌍 e\u0301\n   trailing   " % r,
            "web → cli %d after both cancels: 取消之后仍然可用" % r,
        ],
        # One line each: `pair` reads one message per input line.
        "cliMessages": [
            "cli → web %d: 端到端 · 0123456789\tindented   " % r,
            "cli → web %d after both cancels: still usable ✓" % r,
        ],
        "webBatches": web,
        "cliBatches": cli,
    }


def android_plan(run_root, rnd, code_role, cancel, code=""):
    """The CLI's side of `InteropAcceptanceTest`'s in-band protocol.

    The Android half's own payloads are fixed by its instrumentation arguments
    (`sendName`/`sendSize`/`sendSeed`, and the derived `zero-`, `small-` and
    `again-` entries with the seeds `InteropAcceptanceTest` adds), so they are
    written down here once, for the shell to pass and the oracle to expect.
    """
    r = int(rnd)
    stage_root = os.path.join(run_root, "stage-%d" % r)
    dest = os.path.join(run_root, "dest-%d" % r)
    os.makedirs(stage_root)
    os.makedirs(dest)

    def cli_entry(rel, size, seed):
        return {"name": os.path.basename(rel), "size": size, "seed": seed,
                "src": stage(stage_root, rel, size, seed)}

    send_name = "android-to-cli-%d.bin" % r
    send_size = 196_608 + 1024 * r   # crosses the 192 KiB fragment
    send_seed = 100 + r
    return {
        "cell": "cli-android",
        "round": r,
        "codeRole": code_role,
        "cancel": cancel,
        "code": code,
        "dest": dest,
        "stage": stage_root,
        "cliMessage": "cli → android %d: 端到端 · 0123456789\tindented   " % r,
        # Whitespace-significant and multi-line; it travels to the device as hex.
        "androidMessage": "android → cli %d: 你好 مرحبا 🌍\n\tsecond line   " % r,
        "postMessage": "android → cli %d: 取消之后仍然可用\t— still usable" % r,
        "first": [
            cli_entry("cli-big-%d.bin" % r, 199_000, r),
            cli_entry("cli-zero-%d.bin" % r, 0, 0),
            cli_entry("cli-small-%d.bin" % r, 1024, r + 7),
        ],
        "second": [cli_entry("cli-second-%d.bin" % r, 4096, r + 21)],
        "android": {
            "sendName": send_name, "sendSize": send_size, "sendSeed": send_seed,
            "expectSaved": [
                {"name": send_name, "size": send_size, "seed": send_seed},
                {"name": "zero-" + send_name, "size": 0, "seed": 0},
                {"name": "small-" + send_name, "size": 3072, "seed": send_seed + 2},
                {"name": "again-" + send_name, "size": 2048, "seed": send_seed + 1},
            ],
        },
    }


def mac_plan(run_root, rnd, code_role):
    """The CLI ↔ macOS app round. The Mac's control API sends a file from a
    JSON string, so its payloads are text (UTF-8, non-ASCII on purpose) and
    the oracle hashes their UTF-8 bytes."""
    r = int(rnd)
    stage_root = os.path.join(run_root, "stage-%d" % r)
    dest = os.path.join(run_root, "dest-%d" % r)
    os.makedirs(stage_root)
    os.makedirs(dest)

    def cli_entry(rel, size, seed):
        return {"name": os.path.basename(rel), "path": rel, "size": size, "seed": seed,
                "src": stage(stage_root, rel, size, seed)}

    clidir = "cli-dir-%d" % r
    dir_entries = [
        cli_entry("%s/a/b/nested-%d.bin" % (clidir, r), 90_000, r + 42),
        cli_entry("%s/a/empty-%d.bin" % (clidir, r), 0, 0),
        cli_entry("%s/top-%d.txt" % (clidir, r), 100, r + 43),
    ]
    flat = [
        cli_entry("cli-big-%d.bin" % r, 250_000, r + 40),
        cli_entry("cli-zero-%d.bin" % r, 0, 0),
        cli_entry("cli-small-%d.txt" % r, 2048, r + 41),
    ]
    for e in flat:
        e["path"] = e["name"]
    return {
        "cell": "cli-mac",
        "round": r,
        "codeRole": code_role,
        "dest": dest,
        # The Mac peer's receive root (cli-mac-acceptance.sh passes exactly
        # this to `--receive-root`); the oracle reads the Mac's tree off disk.
        "macReceive": os.path.join(run_root, "mac-receive-%d" % r),
        "stage": stage_root,
        "macMessage": "mac → cli %d: 你好 مرحبا 🌍 e\u0301 — trailing   " % r,
        "cliMessage": "cli → mac %d: 端到端 · 0123456789\tindented   " % r,
        "macFiles": [
            {"name": "mac-first-%d.txt" % r, "contents": ("mac → cli 端到端 %d — " % r) * 700},
            {"name": "mac-second-%d.txt" % r, "contents": "second batch on the same link %d ✓\n" % r},
        ],
        "cliBatches": {
            "flat": flat,
            "dir": {"src": os.path.join(stage_root, clidir), "root": clidir, "entries": dir_entries},
        },
    }


def main(argv):
    if len(argv) == 7 and argv[1] == "web":
        _, _, run_root, rnd, code_role, verify, ending = argv
        plan = web_plan(run_root, rnd, code_role, verify, ending)
    elif len(argv) in (6, 7) and argv[1] == "android":
        plan = android_plan(*argv[2:])
    elif len(argv) == 5 and argv[1] == "mac":
        plan = mac_plan(*argv[2:])
    else:
        print(__doc__, file=sys.stderr)
        return 2
    json.dump(plan, sys.stdout, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
