#!/usr/bin/env python3
"""Keep the crash evidence of a failed `swift-package.yml` `swift test` run.

## Why this exists

Run 37175317336 (attempt 1, job 111356690940) failed because the process that
runs the package's XCTest bundle died: SwiftPM printed `error: Exited with
unexpected signal code 11` in the middle of an otherwise passing test line. That
is a native crash, not an XCTest assertion, and stdout cannot say which test
was running — the message is interleaved with buffered test output. No stack
was retained: the job kept nothing but the log, and whether CrashReporter wrote
a report on that ephemeral runner is unknown. Nothing in this script explains
or fixes that crash; it only tries to keep evidence of the next one.

## What it does

`mark` runs immediately before the `swift test` step and writes a small marker:
the time the test window opened, bound to this commit, run id and attempt, the
checked-out HEAD read from `.git/HEAD`, and the toolchain versions. It never
fails the job: every problem is recorded in the marker and it exits 0.

`finish` runs from the `swift test` step's EXIT trap, the moment the original
`swift test 2>&1 | tee` pipeline has ended, and records that IMMUTABLE test
end. It changes nothing about the pipeline's own exit status — the trap saves
`$?`, disables errexit for this command and re-exits with the saved status —
and is bounded to 5 s by its own watchdog and to 10 s by the `perl` alarm the
trap wraps it in.

`capture` runs ONLY after the job has failed. Within one 60-second budget it:

  * copies the original `swift-test.log` the `swift test` step tee'd (the raw
    test output, unchanged, capped at 64 MiB — the tail is kept when larger);
  * finds the test bundles this job actually built — only
    `apps/RelayiumKit/.build/<triple>/debug/<name>.xctest/Contents/MacOS/<exe>`,
    every component a real directory or regular file, never a symbolic link —
    and reads each executable's Mach-O UUID with the fixed `/usr/bin/dwarfdump
    --uuid` (finite time, bounded output; nothing is built or executed);
  * looks in exactly `~/Library/Logs/DiagnosticReports` and its `Retired`
    directory, one level each, for `xctest-*.ips` / `swiftpm-testing-helper-*.ips`
    crash reports, and selects one ONLY when it parses as an Apple crash report
    (two JSON documents, `bug_type` 309), whose crash `captureTime` lies inside
    THIS test window — between the marker and the recorded test end, which
    never moves while the capture polls, so a crash during the diagnostics
    themselves is rejected — and whose header (write) time is not before the
    crash and not after now (ReportCrash may write it after the test ended),
    was written by an XCTest
    runner process, and lists one of THIS job's test-bundle UUIDs in its
    `usedImages`. A file name alone never selects a report;
  * writes `summary.json` and, for each selected report, a SANITIZED
    `report-<n>.json`: exception, termination, the crashing thread's frames and
    a bounded slice of the others, and the name/UUID/offsets needed to
    symbolicate them. The raw report is never copied. Registers, environment,
    paths, command lines, user names and every other field are dropped, and
    strings are scrubbed of home-directory paths.

When no report is found the summary says `UNAVAILABLE`; that is an absence of
evidence, never a cause. The capture also refuses to attribute anything unless
the marker and the test end were written for this head, run and attempt, the
marker saw a checkout equal to that head, and the checkout still is. Every rejected candidate is listed with an explicit
reason (`old`, `future`, `uuid-mismatch`, `other-process`, `malformed`,
`truncated`, `too-large`, `unstable`, `replaced`, `not-regular`, `read-timeout`,
`no-bundle-uuid`). The marker's run binding is diagnostic provenance only.

## What it can never do

The `swift test` step's own exit status is the verdict. `capture` runs only
when the job already failed, so it cannot turn a green run red; nothing it does
or exits with can turn a red one green, revive the named-execution proof, a
toolchain certificate or an evidence witness. It runs no test, no build, no
debugger and no loop around the suite.

## Bounds

Every mode arms a real-time `SIGALRM` watchdog FIRST and clears it only after
its last write: `capture` 60 s, `mark` 40 s, `finish` 5 s, covering directory
creation, reads, tools, JSON and output. When it fires the helper writes
nothing more, prints `UNAVAILABLE` and exits 5. Output goes only through
directory descriptors anchored at `--runner-temp`, never through a symbolic
link, a pre-existing capture directory or a replaced component; every file is
created exclusively under its final name, checked against its descriptor after
the open and before each write, never renamed, overwritten or deleted. Fixed tools
read stdout through a hard byte cap enforced while reading, and are killed
with their whole process group at the cap or their deadline. At most
`MAX_DIR_ENTRIES` names per directory are listed, `MAX_CANDIDATES` reports read,
`MAX_REPORT_BYTES` each, `MAX_TOTAL_REPORT_BYTES` in total, `MAX_SELECTED`
sanitized, `MAX_OUTPUT_BYTES` per written JSON file. `mark`: 40 s, two version
probes of 15 s each.

Python 3.9 standard library only: it runs as `/usr/bin/python3` on the hosted
macOS image and its tests (scripts/test/swift-test-diagnostics-test.py) run on
Linux in repo-hygiene.
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time

SCHEMA_MARK = "relayium-swift-test-diagnostics-mark/1"
SCHEMA_SUMMARY = "relayium-swift-test-diagnostics/1"

DIAG_DIR = "swift-test-diagnostics"
MARK_NAME = "mark.json"
FINISH_NAME = "finish.json"
SCHEMA_FINISH = "relayium-swift-test-diagnostics-finish/1"
FINISH_BUDGET_S = 5.0
CAPTURE_DIR = "capture"
SUMMARY_NAME = "summary.json"
LOG_NAME = "swift-test.log"

# Fixed inputs, relative to the job's working directory (the checkout).
PACKAGE_BUILD = ("apps", "RelayiumKit", ".build")
GIT_HEAD = (".git", "HEAD")
REPORT_DIRS = (("Library", "Logs", "DiagnosticReports"), ("Library", "Logs", "DiagnosticReports", "Retired"))

# Fixed tools. Never taken from the command line or the environment.
DWARFDUMP = "/usr/bin/dwarfdump"
VERSION_PROBES = (("swift", ("/usr/bin/xcrun", "swift", "--version")), ("xcodebuild", ("/usr/bin/xcodebuild", "-version")))

CAPTURE_BUDGET_S = 60.0
CAPTURE_RESERVE_S = 4.0
POLL_INTERVAL_S = 1.0
MARK_BUDGET_S = 40.0
PROBE_TIMEOUT_S = 15.0
DWARFDUMP_TIMEOUT_S = 10.0
TOOL_STDOUT_MAX = 8 * 1024

MAX_DIR_ENTRIES = 512
MAX_BUNDLES = 8
MAX_CANDIDATES = 16
MAX_REPORT_BYTES = 4 * 1024 * 1024
MAX_TOTAL_REPORT_BYTES = 16 * 1024 * 1024
MAX_SELECTED = 2
MAX_LOG_BYTES = 64 * 1024 * 1024
MAX_MARK_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_REJECTIONS = 32
MAX_TRIGGERED_FRAMES = 128
MAX_OTHER_THREADS = 24
MAX_OTHER_FRAMES = 12
MAX_STRING = 512
CHUNK = 64 * 1024
WINDOW_SLACK_S = 2.0

REPORT_NAME_RE = re.compile(r"^(xctest|swiftpm-testing-helper)-\d{4}-\d{2}-\d{2}-\d{6}(-\d{1,4})?\.ips$")
RUNNER_PROCESSES = ("xctest", "swiftpm-testing-helper")
TRIPLE_RE = re.compile(r"^[A-Za-z0-9_]+(-[A-Za-z0-9_.]+){1,3}$")
BUNDLE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}\.xctest$")
EXE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGITS_RE = re.compile(r"^[0-9]{1,20}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DWARF_LINE_RE = re.compile(r"^UUID: ([0-9A-Fa-f-]{36}) \(([A-Za-z0-9_]+)\) ")
IPS_TIME_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))? ([+-])(\d{2})(\d{2})$")
LOG_SIGNAL_RE = re.compile(rb"Exited with unexpected signal code (\d{1,3})")


class Deadline(Exception):
    """The watchdog fired: write nothing more."""


class BudgetSpent(Exception):
    """The cooperative budget (before the write reserve) is spent: stop gathering, still write the summary.

    Distinct from Deadline on purpose. When both were one exception, a poll that woke just under the
    reserve aborted the whole capture with no summary — an intermittent fixture failure that would
    also have hit the 60 s production budget.
    """


def _on_alarm(signum, frame):
    # Second firing (cleanup after the first did not finish): leave at once, write nothing.
    if getattr(_on_alarm, "fired", False):
        os.write(1, b"swift-test-diagnostics: UNAVAILABLE (watchdog)\n")
        os._exit(5)
    _on_alarm.fired = True
    signal.setitimer(signal.ITIMER_REAL, 1.0)
    raise Deadline()


def arm_watchdog(seconds):
    _on_alarm.fired = False
    signal.signal(signal.SIGALRM, _on_alarm)
    signal.setitimer(signal.ITIMER_REAL, max(0.05, seconds))


def disarm_watchdog():
    signal.setitimer(signal.ITIMER_REAL, 0)


class Unsafe(Exception):
    """A path component was not what it must be (link, replaced, wrong type)."""


def utc_iso(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class Budget:
    """One deadline, and the slice of it kept back for writing the summary."""

    def __init__(self, seconds, reserve=0.0):
        self.end = time.monotonic() + seconds
        self.reserve = reserve

    def left(self):
        return self.end - time.monotonic()

    def charge(self, extra=0.0):
        if self.left() <= self.reserve + extra:
            raise BudgetSpent()


# ── scrubbing ───────────────────────────────────────────────────────────────

HOME_RE = re.compile(r"/(?:Users|home)/[^/\s\"']+")
VAR_FOLDERS_RE = re.compile(r"/(?:private/)?var/folders/[^\s\"']+")


def scrub(value, home=None):
    """A bounded string with this job's home path, every home directory and per-user temp paths removed.

    The user name is removed only as part of a path: replacing it everywhere would also rewrite
    symbol names that merely contain it (the hosted user is `runner`; `XCTestRunner` is a symbol).
    """
    if not isinstance(value, str):
        return None
    s = value
    if home and len(home) > 1:
        s = s.replace(home.rstrip("/"), "/Users/USER")
    s = HOME_RE.sub("/Users/USER", s)
    s = VAR_FOLDERS_RE.sub("/var/folders/TMP", s)
    return s[:MAX_STRING]


def scrub_int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def basename_only(value, user):
    if not isinstance(value, str):
        return None
    return scrub(value.rsplit("/", 1)[-1], user)


# ── descriptor-walked reads ─────────────────────────────────────────────────

NOFOLLOW_DIR = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
NOFOLLOW_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0)


def open_dir_at(parent_fd, name):
    """Open `name` below `parent_fd` as a real directory, or raise Unsafe."""
    try:
        st = os.lstat(name, dir_fd=parent_fd)
    except FileNotFoundError:
        raise
    if not stat.S_ISDIR(st.st_mode):
        raise Unsafe("not-a-directory" if not stat.S_ISLNK(st.st_mode) else "symlink")
    fd = os.open(name, NOFOLLOW_DIR, dir_fd=parent_fd)
    fst = os.fstat(fd)
    if (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
        os.close(fd)
        raise Unsafe("replaced")
    return fd


def walk_chain(base_fd, parts):
    """Open each component below `base_fd`; return (fds, identities). Caller closes fds."""
    fds, ids = [], []
    parent = base_fd
    try:
        for part in parts:
            fd = open_dir_at(parent, part)
            fds.append(fd)
            st = os.fstat(fd)
            ids.append((st.st_dev, st.st_ino))
            parent = fd
    except BaseException:
        for fd in fds:
            os.close(fd)
        raise
    return fds, ids


def chain_unchanged(base_fd, parts, ids):
    try:
        fds, now = walk_chain(base_fd, parts)
    except (OSError, Unsafe):
        return False
    for fd in fds:
        os.close(fd)
    return now == ids


def _read_chunk(fd, n):
    return os.read(fd, n)


def read_stable(dir_fd, name, cap, budget):
    """Read a regular file `name` below `dir_fd` whole, at most `cap` bytes.

    Returns (status, bytes_or_None, stat). The file must be a regular file opened
    without following links, the same inode/size/mtime before and after the read,
    and its name must still resolve to that inode afterwards.
    """
    try:
        st = os.lstat(name, dir_fd=dir_fd)
    except FileNotFoundError:
        return "absent", None, None
    if not stat.S_ISREG(st.st_mode):
        return "not-regular", None, st
    if st.st_size > cap:
        return "too-large", None, st
    try:
        fd = os.open(name, NOFOLLOW_FILE, dir_fd=dir_fd)
    except OSError:
        return "not-regular", None, st
    try:
        fst = os.fstat(fd)
        ident = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino, fst.st_size, fst.st_mtime_ns) != ident:
            return "replaced", None, st
        parts, total = [], 0
        while total <= st.st_size:
            budget.charge()
            data = _read_chunk(fd, min(CHUNK, st.st_size + 1 - total))
            if not data:
                break
            parts.append(data)
            total += len(data)
        after = os.fstat(fd)
        if total != st.st_size or (after.st_size, after.st_mtime_ns) != (st.st_size, st.st_mtime_ns):
            return "unstable", None, st
    finally:
        os.close(fd)
    try:
        again = os.lstat(name, dir_fd=dir_fd)
    except FileNotFoundError:
        return "replaced", None, st
    if (again.st_dev, again.st_ino) != (st.st_dev, st.st_ino):
        return "replaced", None, st
    return "ok", b"".join(parts), st


def list_names(dir_fd):
    """At most MAX_DIR_ENTRIES names, and whether the listing stopped early."""
    names, complete = [], True
    with os.scandir(dir_fd) as it:
        for entry in it:
            if len(names) >= MAX_DIR_ENTRIES:
                complete = False
                break
            names.append(entry.name)
    return sorted(names), complete


# ── bounded tool execution ──────────────────────────────────────────────────

def _kill_group(p):
    """SIGKILL the tool's whole process group and reap the leader, bounded."""
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except OSError:
        pass
    end = time.monotonic() + 2.0
    while p.poll() is None and time.monotonic() < end:
        time.sleep(0.02)


def run_tool(argv, timeout, pass_fds=()):
    """Run a fixed tool with no stdin and a hard timeout, reading at most TOOL_STDOUT_MAX + 1 bytes.

    The cap bounds what is READ, not only what is returned: at the cap the whole process group is
    killed and the pipe closed, so a tool that floods stdout is never drained into memory.
    """
    import select
    try:
        p = subprocess.Popen(list(argv), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, start_new_session=True, pass_fds=tuple(pass_fds))
    except OSError as err:
        return {"status": "unavailable", "error": type(err).__name__}
    fd = p.stdout.fileno()
    buf = bytearray()
    status = None
    end = time.monotonic() + timeout
    try:
        while True:
            left = end - time.monotonic()
            if left <= 0:
                status = "timeout"
                break
            ready, _, _ = select.select([fd], [], [], min(left, 0.2))
            if not ready:
                continue
            data = os.read(fd, min(4096, TOOL_STDOUT_MAX + 1 - len(buf)))
            if not data:
                break
            buf += data
            if len(buf) > TOOL_STDOUT_MAX:
                status = "over-cap"
                break
        if status is None:
            while p.poll() is None and time.monotonic() < end:
                time.sleep(0.02)
            if p.poll() is None:
                status = "timeout"
    except BaseException:
        _kill_group(p)  # the watchdog fired mid-call: leave no tool running behind it
        p.stdout.close()
        raise
    if status is not None:
        _kill_group(p)
    p.stdout.close()
    if status is None:
        status = "ok" if p.returncode == 0 else "failed"
    return {"status": status, "exit": p.returncode, "bytes_read": len(buf),
            "stdout": bytes(buf[:TOOL_STDOUT_MAX]).decode("utf-8", "replace"),
            "truncated": len(buf) > TOOL_STDOUT_MAX}


# ── owned output directories ────────────────────────────────────────────

class Outputs:
    """Directory capabilities anchored at --runner-temp, every component below it opened O_NOFOLLOW.

    The runner temp directory itself is the trusted base (it may sit behind a system alias such as
    /var -> /private/var). Every directory below it must be a real directory owned by this user with
    no group/other write bit, and its (device, inode) is re-checked from the base before every file
    is created, immediately after it is opened and before every write. Files are created
    exclusively under their final names and nothing is ever deleted or overwritten.
    """

    def __init__(self, runner_temp):
        self.base = os.open(runner_temp, NOFOLLOW_DIR)
        self.chain = []  # [(name, fd, (dev, ino))]
        self.written = {}  # name -> {"bytes", "sha256"} of every file this capability completed

    def close(self):
        for _, fd, _ in self.chain:
            os.close(fd)
        os.close(self.base)

    def _check_owned(self, st):
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o022:
            raise Unsafe("not-an-owned-directory")

    def enter(self, name, create, must_create=False):
        parent = self.chain[-1][1] if self.chain else self.base
        if create:
            try:
                os.mkdir(name, 0o700, dir_fd=parent)
            except FileExistsError:
                if must_create:
                    raise
        st = os.lstat(name, dir_fd=parent)
        if stat.S_ISLNK(st.st_mode):
            raise Unsafe("symlink")
        self._check_owned(st)
        fd = os.open(name, NOFOLLOW_DIR, dir_fd=parent)
        fst = os.fstat(fd)
        if (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            os.close(fd)
            raise Unsafe("replaced")
        self.chain.append((name, fd, (st.st_dev, st.st_ino)))
        return fd

    def verify(self):
        parent = self.base
        for name, fd, ident in self.chain:
            try:
                st = os.lstat(name, dir_fd=parent)
            except FileNotFoundError:
                raise Unsafe("replaced")
            if stat.S_ISLNK(st.st_mode) or (st.st_dev, st.st_ino) != ident:
                raise Unsafe("replaced")
            parent = fd

    def write_json(self, name, obj):
        """Write JSON to a NEW file `name` (see write_bytes_new); <= MAX_OUTPUT_BYTES."""
        data = (json.dumps(obj, indent=2, sort_keys=True) + "\n").encode()
        if len(data) > MAX_OUTPUT_BYTES:
            data = (json.dumps({"schema": obj.get("schema"), "status": "OUTPUT-LIMIT", "bytes": len(data)}) + "\n").encode()
        return self.write_bytes_new(name, [data])

    def _bound(self, dfd, name, fd):
        """The directory chain from the base, and `name` in it, still are exactly what `fd` was opened as."""
        self.verify()
        try:
            st = os.lstat(name, dir_fd=dfd)
        except FileNotFoundError:
            raise Unsafe("output-replaced")
        fst = os.fstat(fd)
        if stat.S_ISLNK(st.st_mode) or (st.st_dev, st.st_ino) != (fst.st_dev, fst.st_ino):
            raise Unsafe("output-replaced")

    def write_bytes_new(self, name, chunks):
        """Create `name` exclusively and write `chunks` to it; return (bytes, sha256).

        The final name is created with O_CREAT|O_EXCL|O_NOFOLLOW through the directory descriptor,
        so nothing that already exists — a competing file, a link — is ever opened or overwritten,
        and there is no later rename or link step to race. Immediately after the open, and again
        before EVERY write of at most CHUNK bytes, the whole directory chain from the base and the
        name itself must still be the inode this descriptor holds; otherwise the write stops with
        Unsafe. Nothing is ever deleted: a file left incomplete by a refusal or the watchdog stays,
        and is incomplete by construction because the summary, written last, lists every file's
        size and sha256. When complete the file is made read-only through its descriptor.

        Residual (same user, not excludable by any check): a rename landing between the last check
        and the write syscall right after it moves that one write (<= CHUNK bytes) with the inode.
        """
        dfd = self.chain[-1][1]
        self.verify()
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
                     0o600, dir_fd=dfd)
        total, digest = 0, hashlib.sha256()
        try:
            self._bound(dfd, name, fd)
            for data in chunks:
                view = memoryview(data)
                while view:
                    piece = view[:CHUNK]
                    self._bound(dfd, name, fd)
                    n = os.write(fd, piece)
                    digest.update(piece[:n])
                    total += n
                    view = view[n:]
            self._bound(dfd, name, fd)
            os.fchmod(fd, 0o400)
        finally:
            os.close(fd)
        self.written[name] = {"bytes": total, "sha256": digest.hexdigest()}
        return total


def open_outputs(runner_temp, sub=None):
    """(Outputs, diag_fd) for DIAG_DIR, optionally entering a NEW `sub` directory below it."""
    out = Outputs(runner_temp)
    try:
        out.enter(DIAG_DIR, create=True)  # an existing one must still be a real, owned directory
        if sub is not None:
            out.enter(sub, create=True, must_create=True)
    except BaseException:
        out.close()
        raise
    return out


# ── mark / finish ────────────────────────────────────────────────────────────

def valid_identity(head, run_id, attempt):
    return bool(SHA_RE.match(head or "")) and bool(DIGITS_RE.match(run_id or "")) and bool(DIGITS_RE.match(attempt or ""))


def read_git_head(cwd_fd, budget):
    try:
        fds, _ = walk_chain(cwd_fd, GIT_HEAD[:-1])
    except (OSError, Unsafe):
        return None
    try:
        status, data, _ = read_stable(fds[-1], GIT_HEAD[-1], 256, budget)
    finally:
        for fd in fds:
            os.close(fd)
    if status != "ok":
        return None
    text = data.decode("ascii", "replace").strip()
    return text if SHA_RE.match(text) else None


def current_checkout_head(budget):
    cwd_fd = os.open(".", NOFOLLOW_DIR)
    try:
        return read_git_head(cwd_fd, budget)
    finally:
        os.close(cwd_fd)


def mark(args):
    budget = Budget(MARK_BUDGET_S - 2.0)
    started = time.time()
    record = {"schema": SCHEMA_MARK, "window_start": started, "window_start_iso": utc_iso(started),
              "head": args.head, "run_id": args.run_id, "attempt": args.attempt, "status": "ok"}
    git_head = current_checkout_head(budget)
    record["checkout_head"] = git_head
    record["checkout_matches_head"] = git_head is not None and git_head == args.head
    record["runner"] = {k: scrub(os.environ.get(k)) for k in ("ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH")}
    tools = {}
    for name, argv in VERSION_PROBES:
        if budget.left() <= PROBE_TIMEOUT_S + 1:
            tools[name] = {"status": "skipped-budget"}
            continue
        res = run_tool(argv, PROBE_TIMEOUT_S)
        if "stdout" in res:
            res["stdout"] = scrub(res["stdout"])
        tools[name] = res
    record["toolchain"] = tools
    out = Outputs(args.runner_temp)
    try:
        out.enter(DIAG_DIR, create=True, must_create=True)  # a pre-existing directory or link is refused
        out.write_json(MARK_NAME, record)
    finally:
        out.close()
    print("swift-test-diagnostics: marked test window at %s" % record["window_start_iso"])
    return 0


def finish(args):
    ended = time.time()
    record = {"schema": SCHEMA_FINISH, "test_end": ended, "test_end_iso": utc_iso(ended),
              "head": args.head, "run_id": args.run_id, "attempt": args.attempt}
    out = open_outputs(args.runner_temp)
    try:
        out.write_json(FINISH_NAME, record)
    finally:
        out.close()
    print("swift-test-diagnostics: recorded the test end at %s" % record["test_end_iso"])
    return 0


# ── capture ─────────────────────────────────────────────────────────────────

def parse_ips_time(value):
    if not isinstance(value, str):
        return None
    m = IPS_TIME_RE.match(value)
    if not m:
        return None
    base = datetime.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
    frac = float("0." + m.group(2)) if m.group(2) else 0.0
    offset = (int(m.group(4)) * 60 + int(m.group(5))) * 60 * (1 if m.group(3) == "+" else -1)
    tz = datetime.timezone(datetime.timedelta(seconds=offset))
    return base.replace(tzinfo=tz).timestamp() + frac


def parse_ips(data):
    """(status, header, body) for an Apple `.ips` crash report: two JSON documents."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return "malformed", None, None
    head, sep, rest = text.partition("\n")
    if not sep:
        return "truncated", None, None
    try:
        header = json.loads(head)
    except ValueError:
        return "malformed", None, None
    try:
        body = json.loads(rest)
    except ValueError:
        # A body that stops mid-document is the one way a report is "truncated";
        # anything else unparseable is malformed.
        stripped = rest.strip()
        return ("truncated" if stripped.startswith("{") and not stripped.endswith("}") else "malformed"), None, None
    if not isinstance(header, dict) or not isinstance(body, dict):
        return "malformed", None, None
    if str(header.get("bug_type")) != "309":
        return "unsupported-format", None, None
    if not isinstance(body.get("threads"), list) or not isinstance(body.get("usedImages"), list):
        return "unsupported-format", None, None
    return "ok", header, body


def sanitize_frames(frames, limit, user, referenced):
    out = []
    for fr in frames[:limit] if isinstance(frames, list) else []:
        if not isinstance(fr, dict):
            continue
        idx = scrub_int(fr.get("imageIndex"))
        if idx is not None:
            referenced.add(idx)
        item = {"imageIndex": idx, "imageOffset": scrub_int(fr.get("imageOffset")),
                "symbol": scrub(fr.get("symbol"), user), "symbolLocation": scrub_int(fr.get("symbolLocation")),
                "sourceFile": basename_only(fr.get("sourceFile"), user), "sourceLine": scrub_int(fr.get("sourceLine"))}
        out.append({k: v for k, v in item.items() if v is not None})
    return out


def sanitize_report(header, body, user, bundle_uuids):
    referenced = set()
    threads = body.get("threads") or []
    faulting = scrub_int(body.get("faultingThread"))
    flagged = [i for i, th in enumerate(threads) if isinstance(th, dict) and th.get("triggered") is True]
    crash_index = flagged[0] if flagged else faulting
    triggered = None
    others = []
    for i, th in enumerate(threads):
        if not isinstance(th, dict):
            continue
        if i == crash_index:
            triggered = {"index": i, "queue": scrub(th.get("queue"), user), "name": scrub(th.get("name"), user),
                         "frames": sanitize_frames(th.get("frames"), MAX_TRIGGERED_FRAMES, user, referenced),
                         "frameCount": len(th.get("frames") or [])}
            continue
        if len(others) < MAX_OTHER_THREADS:
            others.append({"index": i, "queue": scrub(th.get("queue"), user), "name": scrub(th.get("name"), user),
                           "frames": sanitize_frames(th.get("frames"), MAX_OTHER_FRAMES, user, referenced),
                           "frameCount": len(th.get("frames") or [])})
    images = []
    used = body.get("usedImages") or []
    for idx in sorted(referenced):
        if 0 <= idx < len(used) and isinstance(used[idx], dict):
            img = used[idx]
            uuid = str(img.get("uuid", "")).lower()
            images.append({"index": idx, "name": basename_only(img.get("name") or img.get("path"), user),
                           "uuid": uuid if UUID_RE.match(uuid) else None, "arch": scrub(img.get("arch"), user),
                           "testBundle": uuid in bundle_uuids})
    exc = body.get("exception") if isinstance(body.get("exception"), dict) else {}
    term = body.get("termination") if isinstance(body.get("termination"), dict) else {}
    return {
        "bug_type": "309",
        "os_version": scrub(header.get("os_version"), user),
        "timestamp": scrub(header.get("timestamp"), user),
        "captureTime": scrub(body.get("captureTime"), user),
        "procName": scrub(body.get("procName"), user),
        "pid": scrub_int(body.get("pid")),
        "parentProc": scrub(body.get("parentProc"), user),
        "parentPid": scrub_int(body.get("parentPid")),
        "exception": {"type": scrub(exc.get("type"), user), "signal": scrub(exc.get("signal"), user),
                      "subtype": scrub(exc.get("subtype"), user), "codes": scrub(exc.get("codes"), user)},
        "termination": {"namespace": scrub(term.get("namespace"), user), "code": scrub_int(term.get("code")),
                        "indicator": scrub(term.get("indicator"), user)},
        "faultingThread": faulting,
        "triggeredThread": triggered,
        "otherThreads": others,
        "threadCount": len(threads),
        "images": images,
        "dropped": "registers, environment, paths, command line, user, vm and every other field",
    }


def bundle_uuids(cwd_fd, budget, user):
    """UUIDs of the test-bundle executables this job built, via the fixed dwarfdump.

    The executable is opened (O_NOFOLLOW, regular, same inode as listed) through a descriptor chain
    walked from the checkout, and dwarfdump is given THAT open descriptor as /dev/fd/N — never a
    pathname — so swapping `.build`, the triple, `debug` or any component below cannot make it read
    another binary. The whole chain is also re-walked from the checkout after the tool, and the
    executable's inode, size and mtime must be unchanged.
    """
    found, notes = [], []
    try:
        fds, build_ids = walk_chain(cwd_fd, PACKAGE_BUILD)
    except FileNotFoundError:
        return found, ["no-build-directory"]
    except (OSError, Unsafe) as err:
        return found, ["build-directory-unsafe:%s" % (err.args[0] if err.args else type(err).__name__)]
    build_fd = fds[-1]
    try:
        names, complete = list_names(build_fd)
        if not complete:
            notes.append("build-listing-incomplete")
        for triple in names:
            if not TRIPLE_RE.match(triple):
                continue
            budget.charge()
            try:
                tfds, tids = walk_chain(build_fd, (triple, "debug"))
            except (OSError, Unsafe):
                continue
            try:
                debug_fd = tfds[-1]
                bnames, bcomplete = list_names(debug_fd)
                if not bcomplete:
                    notes.append("debug-listing-incomplete")
                for bundle in bnames:
                    if not BUNDLE_RE.match(bundle) or len(found) >= MAX_BUNDLES:
                        continue
                    rel = (bundle, "Contents", "MacOS")
                    try:
                        mfds, mids = walk_chain(debug_fd, rel)
                    except (OSError, Unsafe):
                        notes.append("bundle-unsafe")
                        continue
                    try:
                        exes, _ = list_names(mfds[-1])
                        for exe in exes[:4]:
                            if not EXE_RE.match(exe):
                                continue
                            st = os.lstat(exe, dir_fd=mfds[-1])
                            if not stat.S_ISREG(st.st_mode):
                                notes.append("executable-not-regular")
                                continue
                            try:
                                xfd = os.open(exe, NOFOLLOW_FILE, dir_fd=mfds[-1])
                            except OSError:
                                notes.append("executable-not-regular")
                                continue
                            try:
                                xst = os.fstat(xfd)
                                ident = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
                                if (xst.st_dev, xst.st_ino, xst.st_size, xst.st_mtime_ns) != ident:
                                    notes.append("executable-replaced")
                                    continue
                                tool_limit = min(DWARFDUMP_TIMEOUT_S, budget.left() - budget.reserve - 0.5)
                                if tool_limit < 0.5:
                                    notes.append("dwarfdump-skipped-budget")
                                    continue
                                res = run_tool((DWARFDUMP, "--uuid", "/dev/fd/%d" % xfd), tool_limit, pass_fds=(xfd,))
                                after = os.fstat(xfd)
                            finally:
                                os.close(xfd)
                            full = PACKAGE_BUILD + (triple, "debug") + rel
                            again = os.lstat(exe, dir_fd=mfds[-1])
                            if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != ident or \
                                    (again.st_dev, again.st_ino) != (st.st_dev, st.st_ino) or \
                                    not chain_unchanged(cwd_fd, full, build_ids + tids + mids):
                                notes.append("executable-replaced")
                                continue
                            if res["status"] != "ok":
                                notes.append("dwarfdump-%s" % res["status"])
                                continue
                            for line in res["stdout"].splitlines():
                                m = DWARF_LINE_RE.match(line)
                                if m and UUID_RE.match(m.group(1).lower()):
                                    found.append({"uuid": m.group(1).lower(), "arch": m.group(2),
                                                  "bundle": scrub(bundle, user), "triple": triple})
                    finally:
                        for fd in mfds:
                            os.close(fd)
            finally:
                for fd in tfds:
                    os.close(fd)
    finally:
        for fd in fds:
            os.close(fd)
    return found, notes


def copy_log(out, budget):
    """Copy the original swift-test.log into the capture directory (tail kept when over MAX_LOG_BYTES)."""
    rt_fd = out.base
    try:
        st = os.lstat(LOG_NAME, dir_fd=rt_fd)
    except FileNotFoundError:
        return {"status": "absent"}, set()
    if not stat.S_ISREG(st.st_mode):
        return {"status": "not-regular"}, set()
    fd = os.open(LOG_NAME, NOFOLLOW_FILE, dir_fd=rt_fd)
    try:
        fst = os.fstat(fd)
        if (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino) or not stat.S_ISREG(fst.st_mode):
            return {"status": "replaced"}, set()
        size = fst.st_size
        start = max(0, size - MAX_LOG_BYTES)
        os.lseek(fd, start, os.SEEK_SET)
        state = {"copied": 0, "carry": b"", "signals": set()}

        def chunks():
            while state["copied"] < size - start:
                budget.charge()
                data = _read_chunk(fd, min(CHUNK, size - start - state["copied"]))
                if not data:
                    return
                state["copied"] += len(data)
                window = state["carry"] + data
                state["signals"].update(int(x) for x in LOG_SIGNAL_RE.findall(window))
                state["carry"] = window[-64:]
                yield data

        out.write_bytes_new(LOG_NAME, chunks())
    finally:
        os.close(fd)
    return ({"status": "truncated-head" if start else "copied", "bytes": state["copied"], "original_bytes": size},
            state["signals"])


def read_record(runner_temp, name, schema, cap, budget, args):
    """(status, record) for a JSON record this helper wrote under DIAG_DIR, bound to head/run/attempt."""
    try:
        base = os.open(runner_temp, NOFOLLOW_DIR)
    except OSError:
        return "absent", None
    try:
        try:
            dfds, _ = walk_chain(base, (DIAG_DIR,))
        except FileNotFoundError:
            return "absent", None
        except (OSError, Unsafe):
            return "unsafe", None
        try:
            status, data, _ = read_stable(dfds[-1], name, cap, budget)
        finally:
            for fd in dfds:
                os.close(fd)
    finally:
        os.close(base)
    if status != "ok":
        return status, None
    try:
        m = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return "malformed", None
    if not isinstance(m, dict) or m.get("schema") != schema:
        return "malformed", None
    if m.get("head") != args.head:
        return "wrong-head", m
    if m.get("run_id") != args.run_id:
        return "wrong-run", m
    if m.get("attempt") != args.attempt:
        return "wrong-attempt", m
    return "ok", m


def read_mark(runner_temp, budget, args):
    status, m = read_record(runner_temp, MARK_NAME, SCHEMA_MARK, MAX_MARK_BYTES, budget, args)
    if status != "ok":
        return status, m
    if not isinstance(m.get("window_start"), (int, float)) or isinstance(m.get("window_start"), bool):
        return "malformed", None
    if m.get("checkout_matches_head") is not True or m.get("checkout_head") != args.head:
        return "checkout-mismatch", m  # false, absent, non-boolean or a different head: fail closed
    return "ok", m


def read_finish(runner_temp, budget, args, window_start):
    status, f = read_record(runner_temp, FINISH_NAME, SCHEMA_FINISH, MAX_MARK_BYTES, budget, args)
    if status != "ok":
        return status, f
    end = f.get("test_end")
    if not isinstance(end, (int, float)) or isinstance(end, bool) or end < window_start:
        return "malformed", None
    return "ok", f


def scan_reports(home_fd, window, now, uuids, user, budget, state):
    """One pass over the two report directories. `window` is the immutable (start, test end)."""
    lo, hi = window
    for parts in REPORT_DIRS:
        budget.charge()
        try:
            fds, ids = walk_chain(home_fd, parts)
        except FileNotFoundError:
            state["dirs"][os.path.join(*parts)] = "absent"
            continue
        except (OSError, Unsafe) as err:
            state["dirs"][os.path.join(*parts)] = "unsafe:%s" % (err.args[0] if err.args else type(err).__name__)
            continue
        key = os.path.join(*parts)
        try:
            dfd = fds[-1]
            names, complete = list_names(dfd)
            state["dirs"][key] = "complete" if complete else "incomplete"
            for name in names:
                if not REPORT_NAME_RE.match(name) or (key, name) in state["seen"]:
                    continue
                if state["read_count"] >= MAX_CANDIDATES or state["read_bytes"] >= MAX_TOTAL_REPORT_BYTES:
                    state["limits_hit"] = True
                    return
                try:
                    st = os.lstat(name, dir_fd=dfd)
                except FileNotFoundError:
                    continue
                if st.st_mtime < lo:
                    # Written before this window opened: never read.
                    state["seen"].add((key, name))
                    reject(state, "old", None, None)
                    continue
                cap = min(MAX_REPORT_BYTES, MAX_TOTAL_REPORT_BYTES - state["read_bytes"])
                status, data, _ = read_stable(dfd, name, cap, budget)
                if status == "unstable":
                    reject(state, status, None, None)
                    continue  # may still be being written: look again on the next pass
                state["seen"].add((key, name))
                if status != "ok":
                    reject(state, status, None, None)
                    continue
                state["read_count"] += 1
                state["read_bytes"] += len(data)
                if not chain_unchanged(home_fd, parts, ids):
                    state["dirs"][key] = "replaced"
                    reject(state, "replaced", None, None)
                    break
                pstatus, header, body = parse_ips(data)
                if pstatus != "ok":
                    reject(state, pstatus, None, None)
                    continue
                proc = scrub(body.get("procName"), user)
                ctime = parse_ips_time(body.get("captureTime"))
                htime = parse_ips_time(header.get("timestamp"))
                if ctime is None or htime is None:
                    reject(state, "malformed", proc, body.get("captureTime"))
                    continue
                if ctime < lo:
                    reject(state, "old", proc, body.get("captureTime"))
                    continue
                if ctime > hi:
                    # Crashed after the test ended (e.g. during these diagnostics): never this test's crash.
                    reject(state, "after-test-end", proc, body.get("captureTime"))
                    continue
                if htime < ctime - 0.01 or htime > now:
                    # The header is the write time: not before the crash, not in the future.
                    reject(state, "inconsistent-header-time", proc, body.get("captureTime"))
                    continue
                if proc not in RUNNER_PROCESSES:
                    reject(state, "other-process", proc, body.get("captureTime"))
                    continue
                if not uuids:
                    reject(state, "no-bundle-uuid", proc, body.get("captureTime"))
                    continue
                used = {str(img.get("uuid", "")).lower() for img in body["usedImages"] if isinstance(img, dict)}
                if not used & uuids:
                    reject(state, "uuid-mismatch", proc, body.get("captureTime"))
                    continue
                if len(state["selected"]) < MAX_SELECTED:
                    state["selected"].append(sanitize_report(header, body, user, uuids))
                else:
                    reject(state, "over-selection-limit", proc, body.get("captureTime"))
        finally:
            for fd in fds:
                os.close(fd)


def reject(state, reason, proc, ctime):
    state["reasons"][reason] = state["reasons"].get(reason, 0) + 1
    if len(state["rejected"]) < MAX_REJECTIONS:
        state["rejected"].append({"reason": reason, "procName": proc,
                                  "captureTime": scrub(ctime) if isinstance(ctime, str) else None})


def capture(args, budget_s=CAPTURE_BUDGET_S, poll_interval=POLL_INTERVAL_S):
    """The capture proper. The caller has armed the watchdog for `budget_s`; this keeps a reserve of it
    for writing, and everything — including the writes — happens before the watchdog fires."""
    started = time.time()
    budget = Budget(budget_s, reserve=min(CAPTURE_RESERVE_S, budget_s / 4.0))
    out = open_outputs(args.runner_temp, CAPTURE_DIR)  # refuses a link, a foreign or an existing capture dir
    try:
        return _capture(args, out, budget, started, budget_s, poll_interval)
    finally:
        out.close()


def _capture(args, out, budget, started, budget_s, poll_interval):
    user = os.path.normpath(args.home)  # scrubbed from every string as a path
    summary = {"schema": SCHEMA_SUMMARY, "capture_start_iso": utc_iso(started), "head": args.head,
               "run_id": args.run_id, "attempt": args.attempt, "status": "ERROR",
               "bounds": {"budget_s": budget_s, "max_dir_entries": MAX_DIR_ENTRIES, "max_candidates": MAX_CANDIDATES,
                          "max_report_bytes": MAX_REPORT_BYTES, "max_total_report_bytes": MAX_TOTAL_REPORT_BYTES,
                          "max_selected": MAX_SELECTED, "max_log_bytes": MAX_LOG_BYTES, "depth": 1},
               "pid_binding": "not-observable: the swift test log does not name the runner process id; "
                              "the report's pid is recorded, never used to choose it"}
    state = {"dirs": {}, "seen": set(), "selected": [], "rejected": [], "reasons": {},
             "read_count": 0, "read_bytes": 0, "limits_hit": False}
    mstatus, m = read_mark(args.runner_temp, budget, args)
    summary["mark"] = {"status": mstatus}
    if m is not None:
        summary["mark"].update({k: m.get(k) for k in ("window_start_iso", "checkout_head",
                                                       "checkout_matches_head", "toolchain", "runner")})
    fstatus, f = ("not-read", None)
    if mstatus == "ok":
        fstatus, f = read_finish(args.runner_temp, budget, args, float(m["window_start"]))
    summary["finish"] = {"status": fstatus, "test_end_iso": f.get("test_end_iso") if f else None}
    checkout = current_checkout_head(budget)
    summary["checkout_now"] = {"head": checkout, "matches": checkout == args.head}
    try:
        log_info, signals = copy_log(out, budget)
    except BudgetSpent:
        log_info, signals = {"status": "budget-spent: incomplete, not listed in files"}, set()
        state["budget_spent"] = True
    summary["log"] = log_info
    summary["log_signals"] = sorted(signals)
    cwd_fd = os.open(".", NOFOLLOW_DIR)
    try:
        uuids, notes = bundle_uuids(cwd_fd, budget, user)
    except BudgetSpent:
        uuids, notes = [], ["budget-spent"]
        state["budget_spent"] = True
    finally:
        os.close(cwd_fd)
    summary["test_bundles"] = uuids
    summary["test_bundle_notes"] = notes
    if mstatus != "ok":
        summary["status"] = "UNAVAILABLE" if mstatus == "absent" else "REFUSED-MARK"
        summary["reason"] = "no test window bound to this run and checkout (mark %s); nothing attributed" % mstatus
    elif fstatus != "ok":
        summary["status"] = "REFUSED-WINDOW"
        summary["reason"] = "no immutable test end bound to this run (finish %s); nothing attributed" % fstatus
    elif checkout != args.head:
        summary["status"] = "REFUSED-CHECKOUT"
        summary["reason"] = "the checkout is no longer the expected head; nothing attributed"
    else:
        window = (float(m["window_start"]), float(f["test_end"]))
        summary["window"] = {"start_iso": utc_iso(window[0]), "test_end_iso": utc_iso(window[1])}
        uuid_set = {u["uuid"] for u in uuids}
        try:
            home_fd = os.open(args.home, NOFOLLOW_DIR)
        except OSError:
            home_fd = None
            summary["status"] = "UNAVAILABLE"
            summary["reason"] = "home directory not readable"
        if home_fd is not None:
            try:
                while True:
                    # Only the clock used to reject future header times moves; the window never does.
                    try:
                        scan_reports(home_fd, window, time.time(), uuid_set, user, budget, state)
                    except BudgetSpent:
                        state["budget_spent"] = True
                        break
                    # Without a UUID of this job's test bundle nothing can ever bind, so one
                    # pass records what is there and waiting longer cannot change the answer.
                    if state["selected"] or state["limits_hit"] or not uuid_set:
                        break
                    if budget.left() <= budget.reserve + poll_interval:
                        break
                    time.sleep(poll_interval)
            finally:
                os.close(home_fd)
            summary["status"] = "MATCHED" if state["selected"] else "UNAVAILABLE"
            if not state["selected"]:
                summary["reason"] = ("no crash report bound to this window and test bundle; "
                                     "absence of evidence, not a cause")
    summary["report_dirs"] = state["dirs"]
    summary["rejected"] = state["rejected"]
    summary["rejected_counts"] = state["reasons"]
    summary["scan_limits_hit"] = state["limits_hit"]
    summary["budget_spent"] = state.get("budget_spent", False)
    summary["reports_read"] = state["read_count"]
    summary["selected"] = []
    for i, rep in enumerate(state["selected"], 1):
        name = "report-%d.json" % i
        out.write_json(name, rep)
        summary["selected"].append(name)
    summary["seconds"] = round(time.time() - started, 3)
    # Written last: a file is complete only if listed here with this size and sha256.
    summary["files"] = dict(out.written)
    out.write_json(SUMMARY_NAME, summary)
    print("swift-test-diagnostics: %s (%d report(s) selected, %d read)" %
          (summary["status"], len(summary["selected"]), state["read_count"]))
    return 0


def parse_args(argv):
    p = argparse.ArgumentParser(prog="swift-test-diagnostics.py")
    sub = p.add_subparsers(dest="command")
    for name in ("mark", "finish", "capture"):
        s = sub.add_parser(name)
        s.add_argument("--runner-temp", required=True)
        s.add_argument("--head", required=True)
        s.add_argument("--run-id", required=True)
        s.add_argument("--attempt", required=True)
        if name == "capture":
            s.add_argument("--home", required=True)
    return p.parse_args(argv)


BUDGETS = {"mark": MARK_BUDGET_S, "finish": FINISH_BUDGET_S, "capture": CAPTURE_BUDGET_S}


def main(argv=None, budget_s=None, poll_interval=POLL_INTERVAL_S):
    """Every mode runs entirely under its watchdog: armed before the first open, cleared after the
    last write. At the deadline nothing more is written; stdout says UNAVAILABLE and the exit is 5.
    `mark` and `finish` never fail the job (exit 0 on any error); usage errors exit 2."""
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
    except SystemExit:
        return 2
    if args.command not in BUDGETS:
        return 2
    if not valid_identity(args.head, args.run_id, args.attempt) or not os.path.isabs(args.runner_temp) or \
            (args.command == "capture" and not os.path.isabs(args.home)):
        print("swift-test-diagnostics: refusing an invalid head/run id/attempt or a relative path", file=sys.stderr)
        return 2
    seconds = BUDGETS[args.command] if budget_s is None else budget_s
    arm_watchdog(seconds)
    try:
        if args.command == "mark":
            return mark(args)
        if args.command == "finish":
            return finish(args)
        return capture(args, budget_s=seconds - 0.5, poll_interval=poll_interval)
    except (Deadline, BudgetSpent):
        print("swift-test-diagnostics: UNAVAILABLE (deadline; nothing more written)")
        return 5
    except FileExistsError:
        print("swift-test-diagnostics: UNAVAILABLE (an output already exists; refusing to open or overwrite it)")
        return 0 if args.command != "capture" else 3
    except (Unsafe, OSError) as err:
        print("swift-test-diagnostics: UNAVAILABLE (%s: %s)" % (type(err).__name__, err.args[0] if err.args else ""))
        return 0 if args.command != "capture" else 4
    finally:
        disarm_watchdog()


if __name__ == "__main__":
    sys.exit(main())
