#!/usr/bin/env python3
"""Owning test of scripts/ci/ios-ui-smoke.py: real processes, fake `xcrun`/`xcodebuild` on PATH.

Every case runs the helper as a child (its own process group, bounded here: TERM, then KILL) in a scratch
directory, with fake tools that record their PID and process group. After each case every recorded PID must be gone
and every recorded group empty, so "cleaned up" is checked, not assumed. Timing cases run a scratch COPY of the
helper whose limit constants alone are substituted (the rest is checked byte-equal), so the production limits
stay fixed in the file. Nothing here touches a real simulator, Xcode or the network.
"""
import json, os, re, shutil, signal, subprocess, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/ci/ios-ui-smoke.py"
SRC = HELPER.read_text()
UDID2 = "00000002-AAAA-BBBB-CCCC-DDDDEEEEFFF2"
LISTING = {"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
    {"name": "iPad Pro 13-inch (M4)", "udid": "00000001-AAAA-BBBB-CCCC-DDDDEEEEFFF1", "isAvailable": True},
    {"name": "iPhone 17 Pro", "udid": UDID2, "isAvailable": True}]}}
SELECT_OK = f'echo "Compact destination: iPhone 17 Pro" >&2\necho "{UDID2}"\n'
SELECTIONS = {
    "app-shell": ["-collect-test-diagnostics", "never", "-only-testing:RelayiumUITests/AppShellUITests"],
    "complement": ["-skip-testing:RelayiumUITests/AppShellUITests", "-only-testing:RelayiumUITests"],
}
LIMITS = ["-test-timeouts-enabled", "YES", "-default-test-execution-time-allowance", "300",
          "-maximum-test-execution-time-allowance", "300"]
failures = []


def check(ok, message):
    if not ok:
        failures.append(message)
    print(("PASS  " if ok else "FAIL  ") + message.split("\n")[0][:150], flush=True)


FAKE = r'''#!/bin/bash
# fake {tool}: records itself, then behaves as $FAKE_{TOOL}_<ACTION> says.
echo "$$ $(ps -o pgid= -p $$ | tr -d ' ')" >> "$FAKE_DIR/pids"
action="${{@: -1}}"
[ "$1 $2" = "simctl list" ] && action=list
[ "$1 $2" = "simctl bootstatus" ] && action=boot
# Test-only scheduling gap between the PID receipt and the start-call receipt (R7 control); never set by the helper.
if [ -n "${{FAKE_TEST_GAP_AFTER_PID:-}}" ] && [ "$action" = boot ]; then sleep "$FAKE_TEST_GAP_AFTER_PID"; fi
echo "- start {tool} $action $*" >> "$FAKE_DIR/calls"
for i in "$@"; do
  if [ "$prev" = "-resultBundlePath" ]; then mkdir -p "$i"; fi
  prev="$i"
done
mode_var="FAKE_{TOOL}_$(echo "$action" | tr 'a-z-' 'A-Z_')"
mode="${{!mode_var:-ok}}"
case "$mode" in
  ok) ;;
  sleep:*) sleep "${{mode#sleep:}}" ;;
  fail:*) echo "fake failure" >&2; exit "${{mode#fail:}}" ;;
  ignore-term:*) trap '' TERM; sleep "${{mode#ignore-term:}}" & wait $! ; sleep "${{mode#ignore-term:}}" ;;
  hold-stdout) sleep 30 & echo "$! $(ps -o pgid= -p $! | tr -d ' ')" >> "$FAKE_DIR/pids" ;;
  descendant:*) sleep 30 </dev/null >/dev/null 2>&1 & echo "$! $(ps -o pgid= -p $! | tr -d ' ')" >> "$FAKE_DIR/pids"; sleep "${{mode#descendant:}}" ;;
esac
if [ "$action" = list ]; then cat "$FAKE_DIR/listing.json"; fi
echo "- end {tool} $action" >> "$FAKE_DIR/calls"
'''


LIMIT_LINES = ("SELECT_BOOT_LIMIT", "ACTION_LIMIT", "STAGE_LIMIT", "POLL", "CLEANUP_TOTAL", "CLEANUP_KILL_AT")
RECEIPTS = []
SYS_TOOLS = ("tr", "ps", "sleep", "mkdir", "cat")


def scratch(limits=None, inject=None, no_xcodebuild=False):
    """A scratch dir with fake tools. `limits` substitutes limit constants; `inject` = (exact line, replacement) swaps
    ONE line; everything else must stay byte-equal to the real helper."""
    d = Path(tempfile.mkdtemp(prefix="ios-ui-smoke-test."))
    (d / "bin").mkdir()
    for tool in ("xcrun", "xcodebuild"):
        if tool == "xcodebuild" and no_xcodebuild:
            continue
        f = d / "bin" / tool
        f.write_text(FAKE.format(tool=tool, TOOL=tool.upper()))
        f.chmod(0o755)
    (d / "sys").mkdir()
    for tool in SYS_TOOLS:
        real = shutil.which(tool, path="/usr/bin:/bin")
        os.symlink(real, d / "sys" / tool)
    (d / "listing.json").write_text(json.dumps(LISTING))
    (d / "rt").mkdir()
    helper = HELPER
    if limits or inject:
        text, changed = SRC, []
        for name, value in (limits or {}).items():
            assert name in LIMIT_LINES
            text, n = re.subn(rf"^{name} = [0-9.]+$", f"{name} = {value}", text, flags=re.M)
            assert n == 1, name
            changed.append(name)
        if inject:
            assert text.count(inject[0] + "\n") == 1, inject[0]
            text = text.replace(inject[0] + "\n", inject[1] + "\n")
        drop = lambda t: "\n".join(l for l in t.split("\n")
                                   if not re.match(rf"^({'|'.join(LIMIT_LINES)}) = [0-9.]+$", l) and (not inject or l not in inject))
        assert drop(text) == drop(SRC), "the scratch helper differs from the real one outside its substitutions"
        helper = d / "ios-ui-smoke.py"
        helper.write_text(text)
    return d, helper


def kill_group(pgid, total=10.0):
    """Harness-side finite cleanup of ONE exact group: TERM, KILL at 6 s, verify by `total`."""
    end, kill_at = time.monotonic() + total, time.monotonic() + 6
    for sig, until in ((signal.SIGTERM, kill_at), (signal.SIGKILL, end)):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        while time.monotonic() < until:
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                return True
            except PermissionError:
                return False
            time.sleep(0.05)
    return False


def run(d, helper, shard="complement", script=SELECT_OK, env=None, args=None, bound=60, signal_after=None, sig=None,
        signals=(), stdout_closed=False, stop_after=None, path=None, slow_popen=None, wait_boot_popen=False):
    rt = d / "rt"
    argv = args if args is not None else [
        "--shard", shard, "--log-dir", str(rt / f"ios-ui-smoke-{shard}-logs"),
        "--build-result", str(rt / f"ios-ui-build-{shard}.xcresult"),
        "--test-result", str(rt / f"ios-ui-smoke-{shard}.xcresult"),
        "--", "-project", "apps/ios/Relayium.xcodeproj", "-scheme", "Relayium", "-derivedDataPath", str(rt / "dd-ios"),
        "--", *LIMITS, "--", *SELECTIONS.get(shard, ["-only-testing:RelayiumUITests"])]
    if path == "SCRATCH_BIN_AND_SYS":
        path = f"{d}/bin:{d}/sys"      # no xcodebuild anywhere on PATH: the build's spawn itself fails
    full_env = {"PATH": path or f"{d}/bin:/usr/bin:/bin", "FAKE_DIR": str(d), "HOME": os.environ.get("HOME", ""),
                "GITHUB_OUTPUT": str(d / "github-output"), **(env or {})}
    (d / "github-output").write_text("")
    site = []
    if full_env.pop("FAKE_ROLLBACK", None):
        # The wall clock runs BACKWARDS an hour on every read inside the helper process.
        site.append("import time\n_r = time.time\n_s = [0]\ndef _t():\n    _s[0] -= 3600\n    return _r() + _s[0]\ntime.time = _t\n")
    if slow_popen:
        # Process creation itself is slow for the named action: its cost must be charged to that task's budget.
        site.append("import subprocess, time\n_i = subprocess.Popen.__init__\n"
                    f"def _s(self, args, *a, **k):\n    if args and args[-1] == {slow_popen[0]!r}:\n        time.sleep({slow_popen[1]})\n"
                    "    _i(self, args, *a, **k)\nsubprocess.Popen.__init__ = _s\n")
    if wait_boot_popen:
        # The build is spawned only once the fake boot has REALLY started — its PID receipt AND its start-call
        # receipt are both recorded — bounded at 2 s, so a build spawn failure provably happens while an owned,
        # already-recorded boot group is live (R7: a PID receipt alone races the start-call receipt).
        site.append("import subprocess, time, os\n_i2 = subprocess.Popen.__init__\n"
                    f"def _w(self, args, *a, **k):\n    if args and args[-1] == 'build-for-testing':\n"
                    f"        end = time.monotonic() + 2\n"
                    f"        while time.monotonic() < end and not (os.path.exists({str(d / 'pids')!r}) and open({str(d / 'pids')!r}).read().strip()\n"
                    f"                and os.path.exists({str(d / 'calls')!r}) and '- start xcrun boot ' in open({str(d / 'calls')!r}).read()):\n"
                    "            time.sleep(0.02)\n"
                    "    _i2(self, args, *a, **k)\nsubprocess.Popen.__init__ = _w\n")
    if site:
        (d / "sitecustomize.py").write_text("\n".join(site))
        full_env["PYTHONPATH"] = str(d)
    log = open(d / "helper.log", "w")
    out = log
    if stdout_closed:
        r_end, w_end = os.pipe()
        os.close(r_end)
        out = w_end
    t0 = time.monotonic()
    p = subprocess.Popen(["/usr/bin/python3", "-B", str(helper), *argv], stdin=subprocess.PIPE, stdout=out,
                         stderr=log if stdout_closed else subprocess.STDOUT, env=full_env, start_new_session=True)
    if stdout_closed:
        os.close(w_end)
    p.stdin.write(script.encode())
    p.stdin.close()
    sig_times = []
    plan = sorted(([(signal_after, sig)] if signal_after is not None else []) + list(signals)
                  + ([(stop_after, signal.SIGSTOP)] if stop_after is not None else []))
    for when, s_ in plan:
        while time.monotonic() - t0 < when and p.poll() is None:
            time.sleep(0.01)
        if p.poll() is None:
            os.kill(p.pid, s_)
            sig_times.append(time.monotonic() - t0)
    hung = False
    try:
        p.wait(timeout=max(0.1, bound - (time.monotonic() - t0)))
    except subprocess.TimeoutExpired:
        hung = True
        kill_group(p.pid)      # the helper's own group; the fakes' groups are checked (and repaired) by case()
        p.wait(timeout=5)
    log.close()
    elapsed = time.monotonic() - t0
    calls = (d / "calls").read_text().splitlines() if (d / "calls").exists() else []
    return p.returncode, elapsed, calls, (d / "helper.log").read_text(), hung, sig_times


def recorded(d):
    pids, groups = set(), set()
    if (d / "pids").exists():
        for line in (d / "pids").read_text().split("\n"):
            parts = line.split()
            if len(parts) == 2:
                pids.add(int(parts[0]))
                groups.add(int(parts[1]))
    return pids, groups


def gone(d):
    """Every PID a fake recorded is gone and every group it recorded is empty. PermissionError is UNKNOWN: not gone."""
    time.sleep(0.1)
    pids, groups = recorded(d)
    alive = []
    for pid in pids:
        try:
            os.kill(pid, 0)
            alive.append(pid)
        except ProcessLookupError:
            pass
        except PermissionError:
            alive.append(f"{pid}?")
    for g in groups:
        try:
            os.killpg(g, 0)
            alive.append(f"group {g}")
        except ProcessLookupError:
            pass
        except PermissionError:
            alive.append(f"group {g}?")
    return not alive, alive, len(pids)


def actions(calls, edge):
    return [c.split()[3] for c in calls if c.split()[1] == edge]


def at(calls, edge, action):
    """The position of the first such line: the call file is appended in real order (one O_APPEND line each)."""
    return next((i for i, c in enumerate(calls) if c.split()[1] == edge and c.split()[3] == action), None)


def case(name, limits=None, inject=None, no_xcodebuild=False, **kw):
    """Run, judge closure BEFORE any harness repair, then repair exactly the recorded groups. The receipt keeps the
    original verdict; a harness repair never turns a helper failure into a pass."""
    d, helper = scratch(limits, inject, no_xcodebuild)
    code, elapsed, calls, log, hung, sig_times = 1, 0.0, [], "", False, []
    try:
        code, elapsed, calls, log, hung, sig_times = run(d, helper, **kw)
    finally:
        ok_gone, alive, n = gone(d)
        pids, groups = recorded(d)
        repaired = [g for g in groups if not kill_group(g)]
        RECEIPTS.append({"case": name, "dir": str(d), "pids": sorted(pids), "groups": sorted(groups),
                         "helper_left": alive, "harness_unrepaired": repaired, "hung": hung})
    return d, code, elapsed, calls, log, ok_gone and not hung, alive, n, sig_times


def done(d):
    if not failures:
        shutil.rmtree(d, ignore_errors=True)


# 1. the barrier: boot and build overlap, the test starts after BOTH ended, with the exact arguments
for shard in ("complement", "app-shell"):
    d, code, elapsed, calls, log, ok, alive, n, _sig = case("positive", env={"FAKE_XCRUN_BOOT": "sleep:0.8", "FAKE_XCODEBUILD_BUILD_FOR_TESTING": "sleep:0.4"}, shard=shard)
    starts = [c for c in calls if c.split()[1] == "start"]
    test = next((c for c in starts if c.split()[3] == "test-without-building"), "")
    build = next((c for c in starts if c.split()[3] == "build-for-testing"), "")
    check(code == 0 and ok, f"{shard}: both succeed → exit 0, all owned PIDs/groups gone (exit {code}, alive {alive})")
    check(at(calls, "start", "build-for-testing") < at(calls, "end", "boot"),
          f"{shard}: build-for-testing starts while bootstatus still runs (real overlap)")
    check(at(calls, "start", "test-without-building") >= max(at(calls, "end", "boot"), at(calls, "end", "build-for-testing")),
          f"{shard}: test-without-building starts only after BOTH boot and build ended")
    check(f"simctl bootstatus {UDID2} -b" in " ".join(starts) and f"id={UDID2}" in build and f"id={UDID2}" in test,
          f"{shard}: boot, build and test all target the selected UDID")
    rt = d / "rt"
    check(f"-resultBundlePath {rt}/ios-ui-build-{shard}.xcresult build-for-testing" in build
          and f"-resultBundlePath {rt}/ios-ui-smoke-{shard}.xcresult {' '.join(LIMITS)} {' '.join(SELECTIONS[shard])} test-without-building" in test
          and f"-project apps/ios/Relayium.xcodeproj -scheme Relayium -destination platform=iOS Simulator,id={UDID2} -derivedDataPath {rt}/dd-ios" in test,
          f"{shard}: build/test carry the original project, scheme, destination, DerivedData, limits and selection; unique build bundle")
    check((d / "github-output").read_text() == "", f"{shard}: nothing is written to GITHUB_OUTPUT")
    check(json.loads((rt / f"ios-ui-smoke-{shard}-logs/timing.json").read_text())["overlap_seconds"] > 0.2,
          f"{shard}: timing.json records the measured overlap")
    done(d)

# 2. selection and boot share ONE 300 s (scratch: 2 s) budget from the start
d, code, elapsed, calls, log, ok, alive, n, _sig = case("shared", limits={"SELECT_BOOT_LIMIT": 2}, script="sleep 1.2\n" + SELECT_OK,
                                                   env={"FAKE_XCRUN_BOOT": "sleep:1.5"})
check(code != 0 and "test-without-building" not in actions(calls, "start") and ok and elapsed < 2 + 6 and "boot exceeded its budget" in log,
      f"slow selection + slow boot exceed their SHARED budget → boot ended, no test (exit {code}, {elapsed:.1f}s, alive {alive})")
done(d)

# 3. the build ends first: waiting for the boot is not charged to build+test
d, code, elapsed, calls, log, ok, alive, n, _sig = case("bootwait", limits={"ACTION_LIMIT": 2},
    env={"FAKE_XCRUN_BOOT": "sleep:1.6", "FAKE_XCODEBUILD_BUILD_FOR_TESTING": "sleep:0.3", "FAKE_XCODEBUILD_TEST_WITHOUT_BUILDING": "sleep:1.2"})
check(code == 0 and ok and elapsed > 2.5, f"build 0.3 s + test 1.2 s fit 2 s of action time although the wall time is {elapsed:.1f}s (boot-only wait not charged)")
done(d)

# 4. build + test share the action budget: a test that would exceed it is ended
d, code, elapsed, calls, log, ok, alive, n, _sig = case("cumulative", limits={"ACTION_LIMIT": 2},
    env={"FAKE_XCODEBUILD_BUILD_FOR_TESTING": "sleep:1.2", "FAKE_XCODEBUILD_TEST_WITHOUT_BUILDING": "sleep:5"})
check(code != 0 and ok and "test exceeded its budget" in log and elapsed < 1.2 + 0.8 + 6,
      f"build 1.2 s leaves 0.8 s: the 5 s test is ended at that cumulative bound (exit {code}, {elapsed:.1f}s)")
done(d)

# 5. the stage clamp: every action ends within the stage limit even with action time left
d, code, elapsed, calls, log, ok, alive, n, _sig = case("stage", limits={"STAGE_LIMIT": 2.5, "ACTION_LIMIT": 100},
    env={"FAKE_XCRUN_BOOT": "sleep:1.5", "FAKE_XCODEBUILD_TEST_WITHOUT_BUILDING": "sleep:5"})
check(code != 0 and ok and "test exceeded its budget" in log and elapsed < 2.5 + 6,
      f"the test is clamped to the stage limit, not the remaining action time (exit {code}, {elapsed:.1f}s)")
done(d)

# 6/7. either failure ends the other and no test runs
for side, env in (("boot", {"FAKE_XCRUN_BOOT": "fail:149", "FAKE_XCODEBUILD_BUILD_FOR_TESTING": "sleep:20"}),
                  ("build", {"FAKE_XCODEBUILD_BUILD_FOR_TESTING": "fail:65", "FAKE_XCRUN_BOOT": "sleep:20"})):
    d, code, elapsed, calls, log, ok, alive, n, _sig = case(side, env=env)
    check(code != 0 and "test-without-building" not in actions(calls, "start") and ok and elapsed < 8,
          f"{side} fails → the other side is ended, no test, all owned PIDs gone (exit {code}, {elapsed:.1f}s, alive {alive})")
    done(d)

# 8. the selection must print exactly one uppercase UDID
for label, script in (("empty", "true\n"), ("two UDIDs", f'echo "{UDID2}"\necho "{UDID2}"\n'),
                      ("lowercase", f'echo "{UDID2.lower()}"\n'), ("fails", "exit 3\n"), ("extra stdout", f'echo "iPhone 17"\necho "{UDID2}"\n')):
    d, code, elapsed, calls, log, ok, alive, n, _sig = case("select", script=script)
    check(code != 0 and not [c for c in calls if " boot " in c or "xcodebuild" in c], f"selection {label} → refused before any boot or build")
    done(d)

# 9. a failing test keeps both bundles and returns its own status
d, code, elapsed, calls, log, ok, alive, n, _sig = case("testfail", env={"FAKE_XCODEBUILD_TEST_WITHOUT_BUILDING": "fail:65"})
rt = d / "rt"
check(code == 65 and (rt / "ios-ui-build-complement.xcresult").is_dir() and (rt / "ios-ui-smoke-complement.xcresult").is_dir()
      and (rt / "ios-ui-smoke-complement-logs/test.err.log").exists() and ok,
      f"test failure → exit 65, both bundles and the raw logs kept (exit {code})")
done(d)

# 10. cancel: SIGTERM and SIGINT during boot+build end every owned process, descendants included
for sig, want in ((signal.SIGTERM, 143), (signal.SIGINT, 130)):
    d, code, elapsed, calls, log, ok, alive, n, _sig = case("cancel", signal_after=1.0, sig=sig,
        env={"FAKE_XCRUN_BOOT": "descendant:20", "FAKE_XCODEBUILD_BUILD_FOR_TESTING": "descendant:20"})
    check(code == want and ok and n >= 4 and elapsed < 1 + 10 + 1, f"{signal.Signals(sig).name} → exit {code} (want {want}), {n} recorded PIDs all gone, {elapsed:.1f}s")
    done(d)

# 11. a descendant holding the boot's stdout cannot hang the supervisor; it is ended
d, code, elapsed, calls, log, ok, alive, n, _sig = case("held", env={"FAKE_XCRUN_BOOT": "hold-stdout"})
check(code != 0 and ok and elapsed < 12 and "its process group is not empty" in log and "test-without-building" not in actions(calls, "start"),
      f"boot exits leaving a stdout-holding descendant → fails closed, descendant ended, no hang, no test ({elapsed:.1f}s, alive {alive})")
done(d)

# 12. a child that ignores SIGTERM is KILLed within the finite cleanup
d, code, elapsed, calls, log, ok, alive, n, _sig = case("ignore", limits={"ACTION_LIMIT": 1},
    env={"FAKE_XCODEBUILD_BUILD_FOR_TESTING": "ignore-term:30"})
check(code != 0 and ok and elapsed < 1 + 10 + 1.5, f"TERM-ignoring build is KILLed within the 10 s cleanup ({elapsed:.1f}s, alive {alive})")
done(d)

# 13. a leader that exits leaving a detached-from-pipe descendant: the group is still closed
d, code, elapsed, calls, log, ok, alive, n, _sig = case("leader", env={"FAKE_XCODEBUILD_BUILD_FOR_TESTING": "descendant:0"})
check(code != 0 and ok and "its process group is not empty" in log and "test-without-building" not in actions(calls, "start"),
      f"build leader exits leaving a descendant → fails closed, descendant ended, no test (alive {alive})")
done(d)

# 14. argument and shard drift is refused before anything runs
d0, helper0 = scratch()
base = ["--shard", "complement", "--log-dir", str(d0 / "rt/ios-ui-smoke-complement-logs"),
        "--build-result", str(d0 / "rt/ios-ui-build-complement.xcresult"), "--test-result", str(d0 / "rt/ios-ui-smoke-complement.xcresult"),
        "--", "-project", "apps/ios/Relayium.xcodeproj", "-scheme", "Relayium", "-derivedDataPath", str(d0 / "rt/dd-ios"),
        "--", *LIMITS, "--", *SELECTIONS["complement"]]
drifts = {
    "unknown shard": lambda a: [("retired" if x == "complement" and i == 1 else x) for i, x in enumerate(a)],
    "complement loses -skip-testing": lambda a: [x for x in a if x != "-skip-testing:RelayiumUITests/AppShellUITests"],
    "app-shell selection on complement": lambda a: a[:a.index("--", a.index("--", a.index("--") + 1) + 1) + 1] + SELECTIONS["app-shell"],
    "allowance raised": lambda a: [("600" if x == "300" else x) for x in a],
    "other scheme": lambda a: [("Other" if x == "Relayium" else x) for x in a],
    "extra xcodebuild flag": lambda a: a + ["-parallel-testing-enabled", "YES"],
    "reused build bundle path": lambda a: [(x.replace("ios-ui-build-", "ios-ui-smoke-") if "ios-ui-build-" in x else x) for x in a],
    "unknown flag": lambda a: ["--command", "rm"] + a,
}
for label, mutate in drifts.items():
    if (d0 / "calls").exists():
        (d0 / "calls").unlink()
    code, elapsed, calls, log, _h, _s = run(d0, helper0, args=mutate(list(base)))
    check(code == 1 and calls == [] and "::error::ios-ui-smoke:" in log, f"{label} → refused before any child (exit {code})")
done(d0)

# 15. a wall-clock rollback cannot extend a budget: the helper never reads the wall clock for one
check(not re.search(r"time\.time\(|datetime\.now\(\)\s*[-+]", SRC) and SRC.count("time.monotonic()") >= 3,
      "budgets use time.monotonic() only (time.time()/datetime arithmetic absent)")
d, code, elapsed, calls, log, ok, alive, n, _sig = case("rollback", limits={"ACTION_LIMIT": 2},
    env={"FAKE_XCODEBUILD_BUILD_FOR_TESTING": "sleep:1.2", "FAKE_XCODEBUILD_TEST_WITHOUT_BUILDING": "sleep:5",
         "FAKE_ROLLBACK": "1"})
check(code != 0 and "test exceeded its budget" in log and ok, "the cumulative bound holds regardless of the wall clock (monotonic)")
done(d)


# ── r2 controls: the review's R1–R5 ────────────────────────────────────────────────────────────────────────────
# 16 (R1). a task that EXITED 0 after its deadline is refused, even when the exit is only observed later
d, code, elapsed, calls, log, ok, alive, n, _sig = case("late", limits={"SELECT_BOOT_LIMIT": 3, "POLL": 2.0},
    env={"FAKE_XCRUN_BOOT": "sleep:1.5", "FAKE_XCODEBUILD_BUILD_FOR_TESTING": "sleep:0.1"})
check(code != 0 and ok and "test-without-building" not in actions(calls, "start") and "boot finished after its budget" in log,
      f"boot exits 0 at ~3.5 s, after its 3 s budget (seen at the 4 s poll) → refused, no test (exit {code})")
done(d)

# 17 (R2). the build cannot even be spawned while the boot runs: the boot's group is still owned and ended
d, code, elapsed, calls, log, ok, alive, n, _sig = case("spawnfail", no_xcodebuild=True, env={"FAKE_XCRUN_BOOT": "descendant:20"},
    path="SCRATCH_BIN_AND_SYS", wait_boot_popen=True)
check(code != 0 and ok and n >= 1 and "boot" in actions(calls, "start") and "test-without-building" not in actions(calls, "start")
      and "FileNotFoundError" in log,
      f"build spawn fails while the boot REALLY runs ({n} boot PIDs recorded) → boot's group ended, no test (exit {code}, alive {alive})")
done(d)

# 17b (R7). the same, with a 0.3 s scheduling gap between the fake boot's PID receipt and its start-call receipt:
#           the barrier waits for BOTH receipts, so the boot is provably recorded before the build spawn fails.
d, code, elapsed, calls, log, ok, alive, n, _sig = case("spawnfail-gap", no_xcodebuild=True,
    env={"FAKE_XCRUN_BOOT": "descendant:20", "FAKE_TEST_GAP_AFTER_PID": "0.3"}, path="SCRATCH_BIN_AND_SYS", wait_boot_popen=True)
check(code != 0 and ok and n >= 1 and "boot" in actions(calls, "start") and "test-without-building" not in actions(calls, "start")
      and "FileNotFoundError" in log,
      f"R7: a 0.3 s gap after the boot's PID receipt does not race the barrier ({n} PIDs, boot call recorded, no test, alive {alive})")
done(d)

# 18 (R2). stdout is a closed pipe, so every log write fails after the spawns: ownership and cleanup do not depend on it
d, code, elapsed, calls, log, ok, alive, n, _sig = case("brokenpipe", stdout_closed=True,
    env={"FAKE_XCRUN_BOOT": "descendant:2", "FAKE_XCODEBUILD_BUILD_FOR_TESTING": "descendant:2"})
check(ok and n >= 4, f"with an unwritable stdout every owned group is still ended (exit {code}, alive {alive})")
done(d)

# 19/20 (R3). several TERM-ignoring groups, and SIGTERM/SIGINT repeated during cleanup: ONE 10 s total, not renewed
for label, extra in (("once", ()), ("repeated", ((2.0, signal.SIGINT), (3.0, signal.SIGTERM), (5.0, signal.SIGINT)))):
    d, code, elapsed, calls, log, ok, alive, n, sig_times = case(f"ignoreall-{label}", signal_after=1.0, sig=signal.SIGTERM,
        signals=extra, env={"FAKE_XCRUN_BOOT": "ignore-term:30", "FAKE_XCODEBUILD_BUILD_FOR_TESTING": "ignore-term:30"})
    after = elapsed - sig_times[0] if sig_times else 99
    check(code == 143 and ok and after <= 10 + 1.0,
          f"{label}: TERM-ignoring boot and build end within ONE 10 s cleanup after the first signal ({after:.1f}s, exit {code}, alive {alive})")
    done(d)

# 21 (R4). slow process creation is charged to the task: the build's 1 s spawn cost leaves less for the test
d, code, elapsed, calls, log, ok, alive, n, _sig = case("slowspawn", limits={"ACTION_LIMIT": 2.5}, slow_popen=("build-for-testing", 1.0),
    env={"FAKE_XCODEBUILD_BUILD_FOR_TESTING": "sleep:0.4", "FAKE_XCODEBUILD_TEST_WITHOUT_BUILDING": "sleep:1.5"})
check(code != 0 and ok and "test exceeded its budget" in log,
      f"1.0 s spawn + 0.4 s build leave under 1.1 s: the 1.5 s test is ended (exit {code})")
done(d)

# 22. an unexpected exception while boot and build run: both groups are ended, exit non-zero
d, code, elapsed, calls, log, ok, alive, n, _sig = case("unexpected",
    inject=("        wait_for([boot, build])", "        time.sleep(1.0); raise RuntimeError(\"injected\")"),
    env={"FAKE_XCRUN_BOOT": "descendant:20", "FAKE_XCODEBUILD_BUILD_FOR_TESTING": "descendant:20"})
check(code == 1 and ok and "UNEXPECTED RuntimeError: injected" in log and n >= 4,
      f"an unexpected exception still ends every owned group (exit {code}, alive {alive})")
done(d)

# 23. harness self-control: a helper that hangs (SIGSTOP) is ended by the harness bound, its survivors are DETECTED
#     (the case's original verdict) and then repaired exactly; the repair never turns the verdict into a pass.
d, code, elapsed, calls, log, ok, alive, n, _sig = case("hang", stop_after=1.0, bound=3,
    env={"FAKE_XCRUN_BOOT": "descendant:20", "FAKE_XCODEBUILD_BUILD_FOR_TESTING": "descendant:20"})
receipt = RECEIPTS[-1]
check(receipt["hung"] and not ok and receipt["helper_left"] and not receipt["harness_unrepaired"] and gone(d)[0],
      f"a hung helper is recorded as FAILED with survivors {receipt['helper_left']}, and the harness then ended exactly those")
done(d)

# ── r3 controls: R6, a cancellation acknowledged at the success tail is never a success ─────────────────────────
for label, line, sig, want in (
    ("SIGTERM before cleanup", "        closure = cleanup_all()", "SIGTERM", 143),
    ("SIGINT after cleanup", "        timing[\"cleanup\"] = closure", "SIGINT", 130),
    ("SIGTERM after the timing record", "        say(f\"ios-ui-smoke timing: {json.dumps(timing)}\")", "SIGTERM", 143),
):
    d, code, elapsed, calls, log, ok, alive, n, _sig = case(f"tail-{sig}",
        inject=(line, line[: len(line) - len(line.lstrip())] + f"signal.raise_signal(signal.{sig}); " + line.lstrip()))
    timing_file = d / "rt/ios-ui-smoke-complement-logs/timing.json"
    timing = json.loads(timing_file.read_text()) if timing_file.exists() else {}
    tested = "test-without-building" in actions(calls, "start")
    recorded_cancel = str(timing.get("result", "")).startswith("cancelled:") or "acknowledged after the timing record" in log
    check(tested and code == want and ok and recorded_cancel,
          f"{label}: the test ran and passed, but the acknowledged {sig} makes the run exit {code} (want {want}), recorded cancelled")
    done(d)

print(json.dumps({"failures": len(failures), "receipts": RECEIPTS}, indent=1))
sys.exit(1 if failures else 0)
