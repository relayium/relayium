#!/usr/bin/env python3
"""One iPhone UI smoke shard: select, boot and build at the same time, then test.

Called by exactly one step of `.github/workflows/ios.yml` (`ui_smoke`), which passes the job's own simulator
selection script on stdin (a quoted heredoc, so the shell never expands it) and its own argument arrays:

    ios-ui-smoke.py --shard SHARD --log-dir DIR --build-result B.xcresult --test-result T.xcresult \
        -- COMMON... -- TEST_LIMITS... -- SELECTION...

Sequence, all under ONE monotonic clock started before anything runs:

  1. selection   the stdin script runs under `/bin/bash -euo pipefail`; its stdout must be exactly one
                 uppercase simulator UDID (diagnostics go to stderr).
  2. barrier     `xcrun simctl bootstatus UDID -b` and `xcodebuild … build-for-testing` start together for that
                 UDID. Selection plus boot share 300 s from the start. Build and test share 2880 s of their own
                 elapsed time; waiting for the boot after the build finished is not charged to them.
  3. test        `xcodebuild … test-without-building` starts only after BOTH succeeded, with the remaining
                 action time, clamped so that every action ends within 3170 s of the start (10 s of the step's
                 3180 s are kept for cleanup).

Every child runs in its own process group (it and anything it spawns), is registered the moment it was spawned,
writes to a log file under --log-dir (never a pipe, so a descendant holding stdout cannot hang the supervisor), and
on ANY exit path — failure, timeout, SIGTERM/SIGINT, an unexpected exception, or success — every owned group is
ended under ONE fixed 10 s monotonic cleanup deadline (SIGTERM, SIGKILL at 6 s, verify until 10 s; never renewed by
repeated calls or signals). A group that cannot be verified empty fails the step. A task that exits while its group
still has members, or whose (polled, so conservatively late) end falls on or after its deadline, fails closed. The simulator itself runs under CoreSimulatorService, outside any group this owns: ending
`bootstatus` ends the waiting process, not the boot.

Arguments are not a command line: every array must equal the one this file expects for the shard, and the
destination is built here from the validated UDID. Exit 0 only when the test ran and passed; the test's own non-zero
status is returned when it failed; 1 for anything else, 130/143 for SIGINT/SIGTERM.
"""
import json, os, re, signal, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

SELECT_BOOT_LIMIT = 300.0
ACTION_LIMIT = 2880.0
STAGE_LIMIT = 3170.0
CLEANUP_TOTAL = 10.0
CLEANUP_KILL_AT = 6.0
POLL = 0.2
SCRIPT_CAP = 64 * 1024

SHARDS = {
    "app-shell": ["-collect-test-diagnostics", "never", "-only-testing:RelayiumUITests/AppShellUITests"],
    "complement": ["-skip-testing:RelayiumUITests/AppShellUITests", "-only-testing:RelayiumUITests"],
}
TEST_LIMITS = ["-test-timeouts-enabled", "YES", "-default-test-execution-time-allowance", "300",
               "-maximum-test-execution-time-allowance", "300"]
UDID = re.compile(r"[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}")
OUTPUT_ENV = ("GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_STATE", "GITHUB_STEP_SUMMARY")


class Fail(Exception):
    def __init__(self, message, code=1):
        super().__init__(message)
        self.code = code


T0 = time.monotonic()
STOP = {"signal": None, "count": 0}
OWNED = []                      # every child, registered the moment Popen returned; cleaned on every exit path
CLEANUP = {"deadline": None, "result": None}


def now():
    return time.monotonic() - T0


def utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def say(text):
    """Logging never decides ownership or cleanup: an unwritable stdout is ignored, not raised."""
    try:
        sys.stdout.write(text + "\n")
        sys.stdout.flush()
    except (OSError, ValueError):
        pass


def on_signal(signum, _frame):
    STOP["count"] += 1
    if STOP["signal"] is None:
        STOP["signal"] = signum


def group_state(pgid):
    """True: members remain; False: empty; None: unknown (treated as not empty)."""
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return None


def closed(t):
    t.proc.poll()
    return t.proc.returncode is not None and group_state(t.pgid) is False


def cleanup_all():
    """End EVERY owned group under ONE fixed monotonic deadline (CLEANUP_TOTAL from the first call; later calls,
    and signals arriving meanwhile, never renew it): SIGTERM, SIGKILL at CLEANUP_KILL_AT, then reap/verify until the
    deadline. Returns VERIFIED only when every owned leader is reaped and every owned group is empty."""
    if CLEANUP["deadline"] is None:
        CLEANUP["deadline"] = time.monotonic() + CLEANUP_TOTAL
        CLEANUP["kill_at"] = time.monotonic() + CLEANUP_KILL_AT
    for sig, until in ((signal.SIGTERM, CLEANUP["kill_at"]), (signal.SIGKILL, CLEANUP["deadline"])):
        live = [t for t in OWNED if not closed(t)]
        if not live:
            break
        for t in live:
            try:
                os.killpg(t.pgid, sig)
            except (ProcessLookupError, PermissionError):
                pass
        while time.monotonic() < until and not all(closed(t) for t in OWNED):
            time.sleep(0.05)
    CLEANUP["result"] = "VERIFIED" if all(closed(t) for t in OWNED) else "UNVERIFIED"
    return CLEANUP["result"]


class Task:
    """One child in its own process group, logging to files. `started` is taken BEFORE the spawn call, so the
    time spent creating the process is charged to the task's budget."""

    def __init__(self, name, argv, log_dir, env, deadline):
        self.name, self.argv, self.deadline = name, argv, deadline
        self.out_path = log_dir / f"{name}.out.log"
        self.err_path = log_dir / f"{name}.err.log"
        self.forwarded = {self.out_path: 0, self.err_path: 0}
        self.ended = None
        self.started = now()
        with open(self.out_path, "wb") as out, open(self.err_path, "wb") as err:
            proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err, env=env, start_new_session=True)
            self.proc, self.pgid = proc, proc.pid
            OWNED.append(self)
        say(f"[{name}] started {utc()} pid {self.pgid}: {' '.join(argv)}")

    def finished(self):
        """None while running. Once the leader exited: a member left in its group, or an end observed after the
        deadline (inclusive), fails closed; otherwise the exit status. Times are polling observations, conservative."""
        if self.ended is not None:
            return self.proc.returncode
        if self.proc.poll() is None:
            if now() >= self.deadline:
                raise Fail(f"{self.name} exceeded its budget ({self.deadline - self.started:.0f}s)")
            return None
        self.ended = now()
        self.forward(final=True)
        state = group_state(self.pgid)
        if state is not False:
            raise Fail(f"{self.name}: its leader exited ({self.proc.returncode}) but its process group is "
                       f"{'not empty' if state else 'unverifiable'}")
        say(f"[{self.name}] ended {utc()} exit {self.proc.returncode} after {self.ended - self.started:.1f}s (observed)")
        if self.proc.returncode == 0 and self.ended >= self.deadline:
            raise Fail(f"{self.name} finished after its budget ({self.ended - self.started:.1f}s observed, "
                       f"{self.deadline - self.started:.0f}s allowed)")
        return self.proc.returncode

    def forward(self, final=False):
        for path, done in self.forwarded.items():
            try:
                with open(path, "rb") as handle:
                    handle.seek(done)
                    chunk = handle.read(1 << 20)
            except OSError:
                continue
            if not final:
                if b"\n" not in chunk:
                    continue
                chunk = chunk[: chunk.rindex(b"\n") + 1]
            self.forwarded[path] = done + len(chunk)
            for line in chunk.decode("utf-8", "replace").splitlines():
                say(f"[{self.name}] {line}")


def wait_for(tasks):
    """Poll until every task ended successfully within its deadline; anything else raises (cleanup is the caller's)."""
    while True:
        if STOP["signal"] is not None:
            sig = STOP["signal"]
            raise Fail(f"received {signal.Signals(sig).name}", 128 + sig)
        for t in tasks:
            code = t.finished()
            if code is not None and code != 0:
                raise Fail(f"{t.name} failed with exit {code}", code if t.name == "test" else 1)
            if t.ended is None:
                t.forward()
        if all(t.ended is not None for t in tasks):
            return
        time.sleep(POLL)


def parse(argv):
    flags, groups, cur = {}, [], None
    it = iter(argv)
    for a in it:
        if a == "--":
            groups.append([])
            cur = groups[-1]
        elif cur is not None:
            cur.append(a)
        elif a in ("--shard", "--log-dir", "--build-result", "--test-result") and a not in flags:
            flags[a] = next(it, None)
        else:
            raise Fail(f"unexpected argument {a!r}")
    shard = flags.get("--shard")
    if shard not in SHARDS:
        raise Fail(f"unknown UI shard {shard!r}; it would select nothing")
    if len(groups) != 3:
        raise Fail("want exactly three argument groups: COMMON -- TEST_LIMITS -- SELECTION")
    log_dir = Path(flags.get("--log-dir") or "")
    if not log_dir.is_absolute() or log_dir.name != f"ios-ui-smoke-{shard}-logs":
        raise Fail(f"--log-dir must be an absolute .../ios-ui-smoke-{shard}-logs")
    temp = log_dir.parent
    want = {
        "--build-result": temp / f"ios-ui-build-{shard}.xcresult",
        "--test-result": temp / f"ios-ui-smoke-{shard}.xcresult",
    }
    for flag, path in want.items():
        if flags.get(flag) is None or Path(flags[flag]) != path:
            raise Fail(f"{flag} must be {path}, got {flags.get(flag)!r}")
        if os.path.lexists(path):
            raise Fail(f"{path} already exists; a result bundle is never reused")
    common, limits, selection = groups
    if common[:5] != ["-project", "apps/ios/Relayium.xcodeproj", "-scheme", "Relayium", "-derivedDataPath"] \
            or len(common) != 6 or Path(common[5]) != temp / "dd-ios":
        raise Fail(f"the common arguments are not the iOS project/scheme/DerivedData: {common}")
    if limits != TEST_LIMITS:
        raise Fail(f"the test time limits are not the original 300 s allowances: {limits}")
    if selection != SHARDS[shard]:
        raise Fail(f"the {shard} selection is {selection}, want {SHARDS[shard]}")
    if os.path.lexists(log_dir):
        raise Fail(f"{log_dir} already exists")
    return shard, log_dir, want["--build-result"], want["--test-result"], common, limits, selection


def main(argv):
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    timing = {"limits": {"select_boot": SELECT_BOOT_LIMIT, "action": ACTION_LIMIT, "stage": STAGE_LIMIT, "cleanup": CLEANUP_TOTAL}}
    log_dir = None
    code = 1
    try:
        shard, log_dir, build_result, test_result, common, limits, selection = parse(argv)
        # The selection script is a finite here-document (the workflow's quoted heredoc). An interactive or
        # never-closing producer on stdin is not a supported caller.
        script = sys.stdin.buffer.read(SCRIPT_CAP + 1)
        if not script.strip() or len(script) > SCRIPT_CAP:
            raise Fail("no selection script on stdin, or one above 64 KiB")
        log_dir.mkdir(parents=True)
        (log_dir / "select.sh").write_bytes(script)
        env = {k: v for k, v in os.environ.items() if k not in OUTPUT_ENV}

        say(f"Selection started {utc()}")
        sel = Task("select", ["/bin/bash", "-euo", "pipefail", str(log_dir / "select.sh")], log_dir, env,
                   min(SELECT_BOOT_LIMIT, STAGE_LIMIT))
        wait_for([sel])
        lines = sel.out_path.read_text(errors="replace").splitlines()
        if len(lines) != 1 or not UDID.fullmatch(lines[0]):
            raise Fail(f"the selection printed {lines!r}; want exactly one uppercase simulator UDID")
        device = lines[0]
        destination = ["-destination", f"platform=iOS Simulator,id={device}"]
        timing["udid"] = device
        say(f"Selected {device} after {now():.1f}s")

        boot = Task("boot", ["xcrun", "simctl", "bootstatus", device, "-b"], log_dir, env, min(SELECT_BOOT_LIMIT, STAGE_LIMIT))
        build_start = now()
        build = Task("build", ["xcodebuild", *common[:4], *destination, *common[4:], "-resultBundlePath", str(build_result),
                               "build-for-testing"], log_dir, env, min(build_start + ACTION_LIMIT, STAGE_LIMIT))
        wait_for([boot, build])
        build_elapsed = build.ended - build.started
        overlap = max(0.0, min(boot.ended, build.ended) - max(boot.started, build.started))
        timing.update(boot={"start": boot.started, "end": boot.ended}, build={"start": build.started, "end": build.ended},
                      overlap_seconds=round(overlap, 2), boot_only_wait_after_build=round(max(0.0, boot.ended - build.ended), 2))
        say(f"Boot and build both succeeded after {now():.1f}s (observed overlap {overlap:.1f}s; build {build_elapsed:.1f}s)")

        test_start = now()
        test_deadline = min(test_start + ACTION_LIMIT - build_elapsed, STAGE_LIMIT)
        if test_deadline <= test_start:
            raise Fail(f"no action time left for the test ({test_deadline - test_start:.1f}s)")
        test = Task("test", ["xcodebuild", *common[:4], *destination, *common[4:], "-resultBundlePath", str(test_result),
                             *limits, *selection, "test-without-building"], log_dir, env, test_deadline)
        wait_for([test])
        timing["test"] = {"start": test.started, "end": test.ended, "budget": round(test_deadline - test_start, 2)}
        timing["result"] = "success"
        code = 0
    except Fail as e:
        timing["result"] = f"failure: {e}"
        say(f"::error::ios-ui-smoke: {e}")
        code = e.code
    except BaseException as e:  # noqa: BLE001 - any unexpected error still ends every owned group
        timing["result"] = f"unexpected: {type(e).__name__}: {e}"
        say(f"::error::ios-ui-smoke: UNEXPECTED {type(e).__name__}: {e}")
        code = 1
    finally:
        closure = cleanup_all()
        timing["cleanup"] = closure
        code = acknowledge_cancel(code, timing)
        timing["signals_received"] = STOP["count"]
        timing["elapsed"] = round(now(), 2)
        try:
            if log_dir is not None and log_dir.is_dir():
                (log_dir / "timing.json").write_text(json.dumps(timing, indent=1))
        except OSError:
            pass
        say(f"ios-ui-smoke timing: {json.dumps(timing)}")
        if closure != "VERIFIED":
            say("::error::ios-ui-smoke: an owned process group could not be verified empty")
            code = code or 1
        # The decision boundary: a SIGTERM/SIGINT acknowledged by the handler at any point up to here — during the
        # test's last poll, during cleanup or while the record above was written — refuses success. A signal that
        # arrives after this line (after the decision) is not covered; the process is then already exiting.
        code = acknowledge_cancel(code, timing, late=True)
    return code


def acknowledge_cancel(code, timing, late=False):
    """A cancellation always wins over success: 128+signal (SIGTERM 143, SIGINT 130), recorded as cancelled."""
    sig = STOP["signal"]
    if sig is None or code == 128 + sig:
        return code
    name = signal.Signals(sig).name
    if late:
        say(f"::error::ios-ui-smoke: {name} acknowledged after the timing record; the run is cancelled, not a success")
    else:
        timing["result"] = f"cancelled: {name} acknowledged (was: {timing.get('result')})"
        say(f"::error::ios-ui-smoke: {name} acknowledged; cancelled, never success")
    return 128 + sig


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
