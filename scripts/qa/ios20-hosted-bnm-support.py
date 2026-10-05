"""ios20 hosted same-host B/N/M QA — portable support library (temporary QA file; NEVER merge to main).
Assembled by AST selection from the frozen, reviewed local R6 operator (localgui.py 5d7cbde0…, gui_operator.py
14dd6f4b…): parsers, oracles, deadline, xctestrun validation, owned-process Supervisor and Op binding/cleanup.
No local path, UDID, receipt or governance data is included; every host fact is an explicit parameter.
RUN_BOUNDED below is the accepted block (sha e6a73178…) embedded byte-for-byte and verified before use."""
import difflib, hashlib, json, os, plistlib, re, shutil, signal, stat, subprocess, sys, tarfile, time, types
from pathlib import Path

WRAPPER_SHA = 'e6a73178a3b2a15d20d5e08fc742524ff87a5273316158794fc595b7c3209a93'
RUN_BOUNDED_SOURCE = '# BEGIN RUN_BOUNDED\ndef _group_alive(pgid):\n    try:\n        os.killpg(pgid, 0)\n        return True\n    except ProcessLookupError:\n        return False\n    except PermissionError:\n        return True\n\n\ndef _signal_and_wait(p, pgid, sig, wait_s):\n    """Send `sig` to the group, then poll for at most `wait_s` seconds until the leader is reaped AND the group is empty."""\n    try:\n        os.killpg(pgid, sig)\n    except ProcessLookupError:\n        p.poll()\n        return p.returncode is not None\n    deadline = time.monotonic() + wait_s\n    while time.monotonic() < deadline:\n        if p.poll() is not None and not _group_alive(pgid):\n            return True\n        time.sleep(0.05)\n    p.poll()\n    return p.returncode is not None and not _group_alive(pgid)\n\n\ndef run_bounded(cmd, cwd, env, limit, log_path, term_wait=5.0, kill_wait=5.0):\n    """Run `cmd` in its own process group for at most `limit` s, then end the WHOLE group: SIGTERM and at most\n    `term_wait` s, then SIGKILL and at most `kill_wait` s. The same cleanup runs when the leader exits early but left\n    members in its group. Never waits without a bound; reports closure as VERIFIED only when the leader was reaped\n    and the group is empty, otherwise UNVERIFIED."""\n    t0 = time.monotonic()\n    rec = {\'limit_s\': limit, \'timeout\': False, \'leftover_group_after_exit\': False,\n           \'term_sent\': False, \'kill_sent\': False}\n    with open(log_path, \'w\') as log:\n        p = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=log,\n                             stderr=subprocess.STDOUT, start_new_session=True)\n        pgid = p.pid\n        try:\n            p.wait(timeout=limit)\n        except subprocess.TimeoutExpired:\n            rec[\'timeout\'] = True\n        if not rec[\'timeout\'] and _group_alive(pgid):\n            rec[\'leftover_group_after_exit\'] = True\n        if rec[\'timeout\'] or rec[\'leftover_group_after_exit\']:\n            rec[\'term_sent\'] = True\n            if not _signal_and_wait(p, pgid, signal.SIGTERM, term_wait):\n                rec[\'kill_sent\'] = True\n                _signal_and_wait(p, pgid, signal.SIGKILL, kill_wait)\n        p.poll()\n    rec[\'log_closed\'] = log.closed\n    rec[\'exit\'] = p.returncode\n    rec[\'group_closed\'] = not _group_alive(pgid)\n    rec[\'closure\'] = \'VERIFIED\' if (p.returncode is not None and rec[\'group_closed\']) else \'UNVERIFIED\'\n    rec[\'pgid\'] = pgid\n    rec[\'seconds\'] = round(time.monotonic() - t0, 2)\n    return rec\n# END RUN_BOUNDED'
UI_REL = 'apps/ios/RelayiumUITests/AppShellUITests.swift'
TOKEN_REL = 'apps/ios/Relayium/UITestMode.swift'
RESOLVED_RELS = ('apps/ios/Relayium.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
                 'apps/RelayiumKit/Package.resolved')
BUNDLE = 'com.relayium.mac'
LAUNCH_TITLE = 'Launch ' + BUNDLE
TEST_METHOD = 'testASignedInLaunchRendersItsAccountAndUngatesSend'
CASE = 'RelayiumUITests/AppShellUITests/' + TEST_METHOD
CASE_ID = 'AppShellUITests/' + TEST_METHOD + '()'
ACCOUNT_MSG = 'a signed-in launch did not render the account it holds'
ACCOUNT_ASSERT_PREFIX = 'XCTAssertTrue(app.staticTexts["person@example.com"]'
REMOVED_ENTRY = ('        #selector(AppShellUITests.' + TEST_METHOD + '):\n'
                 '            ["--relayium-ui-testing-signed-in"],\n')
GIB = 1 << 30
SYSTEM_FLOOR = 3 * GIB
FAST_FLOOR = 10 * GIB
TOTAL_BUDGET = 3600.0
CLEANUP_RESERVE = 120.0
CAPS = {'archive': 120, 'build': 600, 'test': 510, 'boot': 60, 'bootstatus': 120, 'shutdown': 60,
        'state': 30, 'xcresult': 60, 'resolve': 600, 'select': 120,
        'initial_state': 120}   # ONLY the first simctl device listing (cold CoreSimulator start); later state stays 30
VARIANTS = ('B', 'N', 'M')
# Hosted profile (explicit; bound again by the manifest). Set by configure_profile() from the manifest.
UDID = None
RUNTIME_ID = None
RUNTIME_OS = None
DEVICE_TYPE = None


def configure_profile(runtime_id, runtime_os, device_type):
    global RUNTIME_ID, RUNTIME_OS, DEVICE_TYPE
    RUNTIME_ID, RUNTIME_OS, DEVICE_TYPE = runtime_id, runtime_os, device_type


class Refuse(Exception):
    """Fail-closed refusal; the operator records it and never retries."""


def sha(b):
    return hashlib.sha256(b).hexdigest()


def fsha(p):
    return sha(Path(p).read_bytes())


def git_blob_id(data):
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def parse_ls_tree(text):
    """`git ls-tree -r -z --full-tree <sha>` output -> {path: (mode, blob)}."""
    out = {}
    for rec in text.split('\0'):
        if not rec:
            continue
        meta, path = rec.split('\t', 1)
        mode, typ, oid = meta.split()
        if typ != 'blob':
            raise Refuse('unexpected_tree_entry:' + typ + ':' + path)
        out[path] = (mode, oid)
    return out


def safe_extract(tar_path, dest, tree):
    """Extract a git-archive tar into dest. Refuses absolute/'..'/escaping names, hard links, devices, FIFOs and
    any symlink that git does not track as mode 120000 or whose target escapes dest. Afterwards every extracted
    regular file must equal its git blob id and the path sets must be identical."""
    dest = Path(dest)
    dest.mkdir(mode=0o700)
    root = os.path.realpath(dest)
    with tarfile.open(tar_path, 'r:') as tf:
        for m in tf.getmembers():
            if m.name == 'pax_global_header' or m.type in (tarfile.XGLTYPE, tarfile.XHDTYPE):
                continue
            name = m.name.rstrip('/')
            if not name or name.startswith('/') or '..' in Path(name).parts:
                raise Refuse('archive_escape_name:' + m.name)
            target = os.path.realpath(os.path.join(root, name))
            if target != root and not target.startswith(root + os.sep):
                raise Refuse('archive_escape_resolved:' + m.name)
            if m.isdir():
                os.makedirs(target, mode=0o700, exist_ok=True)
            elif m.isreg():
                os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
                src = tf.extractfile(m)
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as f:
                    shutil.copyfileobj(src, f)
                os.chmod(target, 0o755 if m.mode & 0o111 else 0o644)
            elif m.issym():
                if tree.get(name, ('',))[0] != '120000':
                    raise Refuse('archive_untracked_symlink:' + name)
                link = os.path.realpath(os.path.join(os.path.dirname(target), m.linkname))
                if link != root and not link.startswith(root + os.sep):
                    raise Refuse('archive_symlink_escapes:' + name)
                os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
                os.symlink(m.linkname, target)
            else:
                raise Refuse('archive_member_type:' + name)
    return verify_tree_against_git(dest, tree)


def inventory(root, deadline=None, label='inventory'):
    """{relpath: {'sha256', 'x'} | {'link'}} for every non-directory entry; never follows symlinks. With a deadline,
    the common clock is checked every file so a large tree cannot run unbounded inside the whole-run budget."""
    root = Path(root)
    out = {}
    for dp, dns, fns in os.walk(root, followlinks=False):
        for n in sorted(fns + [d for d in dns if os.path.islink(os.path.join(dp, d))]):
            if deadline is not None:
                deadline.check(label)
            p = os.path.join(dp, n)
            rel = os.path.relpath(p, root)
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                out[rel] = {'link': os.readlink(p)}
            elif stat.S_ISREG(st.st_mode):
                out[rel] = {'sha256': fsha(p), 'x': bool(st.st_mode & 0o111)}
            else:
                raise Refuse('inventory_special_file:' + rel)
    return out


def inventory_digest(inv):
    return sha(json.dumps(inv, sort_keys=True).encode())


def verify_tree_against_git(dest, tree):
    dest = Path(dest)
    inv = inventory(dest)
    if set(inv) != set(tree):
        raise Refuse('archive_path_set_mismatch:%d/%d' % (len(set(inv) - set(tree)), len(set(tree) - set(inv))))
    for rel, (mode, oid) in tree.items():
        p = dest / rel
        if mode == '120000':
            if git_blob_id(os.readlink(p).encode()) != oid:
                raise Refuse('archive_symlink_blob_mismatch:' + rel)
        elif git_blob_id(p.read_bytes()) != oid or (mode == '100755') != inv[rel]['x']:
            raise Refuse('archive_blob_mismatch:' + rel)
    return inv


def function_bodies(text):
    """{name: body} for every `func test...(` in the file, by brace matching outside strings/comments."""
    out = {}
    for m in re.finditer(r'\bfunc (test\w+)\s*\(\)[^{]*\{', text):
        name, i, depth = m.group(1), m.end(), 1
        j = i
        in_str = in_line = in_block = False
        while depth:
            c = text[j]
            two = text[j:j + 2]
            if in_line:
                in_line = c != '\n'
            elif in_block:
                if two == '*/':
                    in_block, j = False, j + 1
            elif in_str:
                if c == '\\':
                    j += 1
                elif c == '"':
                    in_str = False
            elif two == '//':
                in_line = True
            elif two == '/*':
                in_block = True
            elif c == '"':
                in_str = True
            elif c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
            j += 1
        if name in out:
            raise Refuse('duplicate_test_declaration:' + name)
        out[name] = text[i:j - 1]
    return out


def fixture_block(text):
    m = re.search(r'private static let firstLaunchFixtures: \[Selector: \[String\]\] = \[\n(.*?)\n    \]\n', text, re.S)
    if not m:
        raise Refuse('fixture_table_not_found')
    return m.group(1)


def fixture_has_case(text, required=True):
    if not required and 'firstLaunchFixtures' not in text:
        return False
    return ('#selector(AppShellUITests.' + TEST_METHOD + ')') in fixture_block(text)


def launches_in(body):
    return len(re.findall(r'\bapp\.launch\(\)', body))


def setup_launches(text):
    m = re.search(r'override func setUpWithError\(\) throws \{(.*?)\n    \}\n', text, re.S)
    if not m:
        raise Refuse('setup_not_found')
    return launches_in(m.group(1))


def expected_launches(text):
    """Derive the expected target-launch count from the actual source: setup launches + case-body launches."""
    return setup_launches(text) + launches_in(function_bodies(text)[TEST_METHOD])


def expected_failure_line(text):
    """1-based line of the account XCTAssertTrue inside the case body (the assertion's #line)."""
    body = function_bodies(text)[TEST_METHOD]
    start = text.index(body)
    k = body.index(ACCOUNT_ASSERT_PREFIX)
    if body.count(ACCOUNT_MSG) != 1 or text.count(ACCOUNT_MSG) != 1:
        raise Refuse('account_message_not_unique')
    return text.count('\n', 0, start + k) + 1


def derive_m(n_text):
    """M = N with ONLY the signed-in firstLaunchFixtures entry removed."""
    if n_text.count(REMOVED_ENTRY) != 1 or fixture_block(n_text).count(REMOVED_ENTRY.rstrip('\n')) != 1:
        raise Refuse('m_entry_not_exactly_once')
    return n_text.replace(REMOVED_ENTRY, '', 1)


def check_variant_texts(b_text, n_text, m_text):
    """Mechanism evidence from the actual sources; returns expectations used by the result oracle."""
    nb, nn, nm = function_bodies(b_text), function_bodies(n_text), function_bodies(m_text)
    if len(nn) != 34 or set(nn) != set(nm) or set(nb) != set(nn):
        raise Refuse('test_method_set:%d/%d/%d' % (len(nb), len(nn), len(nm)))
    if any(nn[k] != nm[k] for k in nn):
        raise Refuse('m_changed_a_method_body')
    diff = [l for l in difflib.unified_diff(n_text.splitlines(True), m_text.splitlines(True), n=0)
            if l[:1] in '+-' and not l.startswith(('+++', '---'))]
    if diff != ['-' + x + '\n' for x in REMOVED_ENTRY.rstrip('\n').split('\n')]:
        raise Refuse('m_diff_not_exactly_the_entry')
    if not fixture_has_case(n_text) or fixture_has_case(m_text) or fixture_has_case(b_text, required=False):
        raise Refuse('fixture_mapping_state')
    exp = {'B': expected_launches(b_text), 'N': expected_launches(n_text), 'M': expected_launches(m_text)}
    if exp != {'B': 2, 'N': 1, 'M': 1}:
        raise Refuse('mechanism_launch_expectation:' + json.dumps(exp))
    if '--relayium-ui-testing-signed-in' not in nb[TEST_METHOD] or 'app.terminate()' not in nb[TEST_METHOD]:
        raise Refuse('baseline_case_does_not_relaunch_signed_in')
    return {'launches': exp, 'm_line': expected_failure_line(m_text), 'n_line': expected_failure_line(n_text)}


def check_token_store(text):
    """Bind the no-uninstall argument: signed-in store is in-memory; signed-out store is cleared every launch."""
    need = ('if isSignedIn { return makeSignedInTokenStore() }', 'try? store.clear()',
            'let store = InMemoryTokenStore()')
    missing = [n for n in need if n not in text]
    if missing:
        raise Refuse('token_store_binding:' + json.dumps(missing))


def checkout_revision(checkout):
    g = Path(checkout) / '.git'
    if not g.is_dir() or g.is_symlink():
        raise Refuse('checkout_git_not_plain_dir:' + str(checkout))
    head = (g / 'HEAD').read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{40}', head):
        raise Refuse('checkout_head_not_detached:' + str(checkout))
    return head


def xcframework_has_ios_sim_arm64(xcf):
    info = plistlib.loads((Path(xcf) / 'Info.plist').read_bytes())
    for lib in info.get('AvailableLibraries', []):
        if (lib.get('SupportedPlatform') == 'ios' and lib.get('SupportedPlatformVariant') == 'simulator'
                and 'arm64' in lib.get('SupportedArchitectures', [])):
            if not (Path(xcf) / lib['LibraryIdentifier']).is_dir():
                raise Refuse('xcframework_slice_missing:' + lib['LibraryIdentifier'])
            return lib['LibraryIdentifier']
    raise Refuse('xcframework_no_ios_sim_arm64:' + str(xcf))


def free_bytes(path):
    s = os.statvfs(path)
    return s.f_bavail * s.f_frsize


def admit(system_free, fast_free, measured_footprints, remaining_variants):
    """Admission policy (not an empirical allocation bound). Never lowered to make a machine pass."""
    if system_free < SYSTEM_FLOOR:
        raise Refuse('resource_system_below_floor:%d<%d' % (system_free, SYSTEM_FLOOR))
    per = max(measured_footprints) if measured_footprints else 0
    need = FAST_FLOOR + per * remaining_variants
    if fast_free < need:
        raise Refuse('resource_fast_below_floor:%d<%d' % (fast_free, need))
    return {'system_free': system_free, 'fast_free': fast_free, 'fast_need': need}


class Deadline:
    """One immutable whole-run deadline on one clock; never reset or extended. `check` refuses once the common end
    has passed (even after a zero-exit, non-timeout command); `grant` refuses before a spawn unless the phase's full
    cap fits ahead of the cleanup reserve. `on_check` is a control-only observation hook."""

    def __init__(self, total=TOTAL_BUDGET, clock=time.monotonic, on_check=None):
        self.clock, self.on_check = clock, on_check
        self.end = clock() + total
        self.checks = 0

    def remaining(self):
        return self.end - self.clock()

    def check(self, label, cleanup=False):
        self.checks += 1
        if self.on_check:
            self.on_check(label)
        rem = self.remaining() - (0 if cleanup else CLEANUP_RESERVE)
        if rem <= 0:
            raise Refuse('deadline_expired:%s:%.1f' % (label, rem))
        return rem

    def grant(self, phase, cleanup=False):
        cap = CAPS[phase]
        avail = self.check('grant-' + phase, cleanup=cleanup)
        if avail < cap:
            raise Refuse('deadline_insufficient:%s:%.1f<%d' % (phase, avail, cap))
        return cap


def check_sim_list(js, require_state='Shutdown', udid=UDID):
    devs = json.loads(js)['devices']
    found, booted = [], []
    for runtime, lst in devs.items():
        for d in lst:
            if d.get('state') == 'Booted' and d['udid'] != udid:
                booted.append(d['udid'])
            if d['udid'] == udid:
                found.append((runtime, d))
    if booted:
        raise Refuse('foreign_booted_device:' + ','.join(booted))
    if len(found) != 1:
        raise Refuse('owned_device_count:%d' % len(found))
    runtime, d = found[0]
    if runtime != RUNTIME_ID or not d.get('isAvailable') or d.get('deviceTypeIdentifier') != DEVICE_TYPE:
        raise Refuse('owned_device_identity')
    if require_state and d.get('state') != require_state:
        raise Refuse('owned_device_state:' + str(d.get('state')))
    return d


def du(path, deadline=None):
    total = 0
    for dp, dns, fns in os.walk(path, followlinks=False):
        for n in fns:
            if deadline is not None:
                deadline.check('du')
            total += os.lstat(os.path.join(dp, n)).st_blocks * 512
    return total


def tree_hash(root):
    h = hashlib.sha256()
    for rel, ent in sorted(inventory(root).items()):
        h.update(rel.encode() + b'\0' + json.dumps(ent, sort_keys=True).encode() + b'\n')
    return h.hexdigest()


BOOTSTRAP_MARKERS = ('caught error', 'unrecognized XCTest name', 'Failed to', 'timed out', 'Timed out',
                     'crash', 'Crash', 'Application ', 'bootstrap', 'Lost connection', 'Restarting after')


def titles(v):
    """Same traversal as fleet-e4-control/ios20-HOSTED-ACTIVITY-READER.py: every `title` anywhere."""
    if isinstance(v, dict):
        if isinstance(v.get('title'), str):
            yield v['title']
        for x in v.values():
            yield from titles(x)
    elif isinstance(v, list):
        for x in v:
            yield from titles(x)


def check_summary(js, variant, udid=UDID):
    s = json.loads(js)
    want = {'B': (1, 0), 'N': (1, 0), 'M': (0, 1)}[variant]
    if s.get('totalTestCount') != 1:
        raise Refuse('summary_test_count:%r' % s.get('totalTestCount'))
    got = (s.get('passedTests'), s.get('failedTests'))
    if got != want or s.get('skippedTests') != 0 or s.get('expectedFailures') != 0:
        raise Refuse('summary_counts:%s:%r/skip%r' % (variant, got, s.get('skippedTests')))
    dc = s.get('devicesAndConfigurations') or []
    if len(dc) != 1:
        raise Refuse('summary_destinations:%d' % len(dc))
    dev = dc[0]['device']
    if dev.get('deviceId') != udid or dev.get('osVersion') != RUNTIME_OS or dev.get('platform') != 'iOS Simulator':
        raise Refuse('summary_destination_identity')
    fails = s.get('testFailures') or []
    if variant != 'M':
        if fails or s.get('result') != 'Passed':
            raise Refuse('summary_unexpected_failure:' + variant)
        return {'result': s['result']}
    if len(fails) != 1:
        raise Refuse('summary_failure_count:%d' % len(fails))
    f = fails[0]
    if f.get('testIdentifierString') != CASE_ID or f.get('targetName') != 'RelayiumUITests':
        raise Refuse('summary_failure_wrong_test')
    text = f.get('failureText', '')
    if text.count(ACCOUNT_MSG) != 1 or not text.endswith(ACCOUNT_MSG) or any(b in text for b in BOOTSTRAP_MARKERS):
        raise Refuse('summary_failure_not_account_assertion:' + text[:200])
    return {'result': s.get('result'), 'failureText': text}


def check_activities(js, expected_launch_count, udid=UDID):
    a = json.loads(js)
    if a.get('testIdentifier') != CASE_ID:
        raise Refuse('activities_wrong_test')
    runs = a.get('testRuns') or []
    if len(runs) != 1:
        raise Refuse('activities_run_count:%d' % len(runs))
    if runs[0].get('device', {}).get('deviceId') != udid:
        raise Refuse('activities_destination')
    if not runs[0].get('activities'):
        raise Refuse('activities_unavailable')
    n = sum(t == LAUNCH_TITLE for t in titles(runs[0]['activities']))
    if n != expected_launch_count:
        raise Refuse('launch_count:%d!=%d' % (n, expected_launch_count))
    return n


LOCATION_RE = re.compile(r'^(?P<file>/\S+/AppShellUITests\.swift):(?P<line>\d+): error: '
                         r'-\[RelayiumUITests\.AppShellUITests ' + TEST_METHOD + r'\] : (?P<msg>.+)$', re.M)


def check_m_location(xcodebuild_log, m_file, m_line):
    """xcodebuild console failure line. Shape is the standard xcodebuild console format, NOT yet evidenced by a
    retained local run: an absent/ambiguous line is UNKNOWN and refused."""
    hits = list(LOCATION_RE.finditer(xcodebuild_log))
    if len(hits) != 1:
        raise Refuse('m_location_unknown:%d' % len(hits))
    h = hits[0]
    if os.path.realpath(h['file']) != os.path.realpath(m_file) or int(h['line']) != m_line:
        raise Refuse('m_location_mismatch:%s:%s' % (h['file'], h['line']))
    if not h['msg'].endswith(ACCOUNT_MSG):
        raise Refuse('m_location_message')
    return {'file': h['file'], 'line': int(h['line'])}


def judge_exit(variant, rec, oracle_ok):
    if rec.get('closure') != 'VERIFIED':
        raise Refuse('closure_unverified:' + variant)
    if rec.get('timeout'):
        raise Refuse('timeout:' + variant)
    if variant == 'M':
        if rec.get('exit') != 65 or not oracle_ok:
            raise Refuse('m_exit:%r' % rec.get('exit'))
    elif rec.get('exit') != 0:
        raise Refuse('exit:%s:%r' % (variant, rec.get('exit')))
    return True


def identity(p):
    st = os.lstat(p)
    return [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_mode]


def compare_checkout(path, tree, head, pin):
    """Tracked bytes of a SwiftPM checkout against the actual pinned Git tree (blob ids). Dirty bytes with the same
    HEAD string are reported as mismatches; untracked work-tree files (outside .git) are listed."""
    path = Path(path)
    mism, missing = [], []
    for rel, (mode, oid) in sorted(tree.items()):
        p = path / rel
        if not os.path.lexists(p):
            missing.append(rel)
            continue
        data = os.readlink(p).encode() if mode == '120000' else p.read_bytes()
        if git_blob_id(data) != oid or (mode == '120000') != os.path.islink(p):
            mism.append(rel)
    untracked = sorted(r for r in inventory(path) if not r.startswith('.git/') and r not in tree)
    return {'head': head, 'pin': pin, 'head_equals_pin': head == pin, 'tracked_files': len(tree),
            'tracked_mismatch': mism, 'tracked_missing': missing, 'untracked': untracked}


def xcframework_receipt(xcf):
    info = (Path(xcf) / 'Info.plist').read_bytes()
    return {'info_plist_sha256': sha(info), 'slice': xcframework_has_ios_sim_arm64(xcf),
            'libraries': sorted(l['LibraryIdentifier'] for l in plistlib.loads(info).get('AvailableLibraries', []))}


def check_copied_dependencies(sp, receipt, deadline=None):
    """A variant's SourcePackages copy must equal the receipt inventory byte for byte, except workspace-state.json,
    which must equal the exact expected per-variant rewrite (checked by the caller)."""
    inv = inventory(sp, deadline, 'deps-' + str(sp))
    want = dict(receipt['inventory'])
    got = dict(inv)
    want.pop('workspace-state.json')
    got.pop('workspace-state.json', None)
    if got != want:
        diff = sorted(k for k in set(got) | set(want) if got.get(k) != want.get(k))
        raise Refuse('dependency_copy_drift:%d:%s' % (len(diff), diff[:3]))
    return inventory_digest(got)


PASS = 'MECHANISM_PASS_LOCAL_ONE_CASE'


FETCH_EVIDENCE = re.compile(r'^(Fetching from|Cloning |Updating from|Updating https?://|Downloading binary artifact|'
                            r'Computing version for|Fetching https?://)', re.M)


RUNNER_BUNDLE = 'com.relayium.ios.UITests.xctrunner'


XCTEST_BUNDLE = 'com.relayium.ios.UITests'


APPEX_BUNDLE = 'com.relayium.mac.ShareIOS'


XCTESTRUN_TARGET_KEYS = {
    'DependentProductPaths', 'PreferredScreenCaptureFormat', 'IsXCTRunnerHostedTestBundle', 'TestTimeoutsEnabled',
    'ProcessNamesForCrashReportCollection', 'TestHostBundleIdentifier', 'BlueprintProviderRelativePath',
    'ToolchainsSettingValue', 'UITargetAppPath', 'IsMemoryTaggingAddressSanitizerEnabled', 'ProductModuleName',
    'TestLanguage', 'DefaultTestExecutionTimeAllowance', 'BlueprintProviderName', 'UITargetAppCommandLineArguments',
    'UITargetAppEnvironmentVariables', 'DiagnosticCollectionPolicy', 'UITargetAppPerformanceAntipatternCheckerEnabled',
    'UserAttachmentLifetime', 'TestHostPath', 'RunOrder', 'EnvironmentVariables', 'SystemAttachmentLifetime',
    'CommandLineArguments', 'TestingEnvironmentVariables', 'BlueprintName', 'TestRegion',
    'BundleIdentifiersForCrashReportEmphasis', 'IsUITestBundle', 'TestBundlePath'}


XCTESTRUN_REQUIRED = {'TestHostPath', 'TestBundlePath', 'UITargetAppPath', 'DependentProductPaths',
                      'IsUITestBundle', 'IsXCTRunnerHostedTestBundle', 'TestHostBundleIdentifier', 'BlueprintName',
                      'ProductModuleName'}


ENV_KEYS = ('EnvironmentVariables', 'TestingEnvironmentVariables', 'UITargetAppEnvironmentVariables')


ENV_EXACT_TOKENS = {
    ('EnvironmentVariables', 'DYLD_INSERT_LIBRARIES'): {'/usr/lib/libRPAC.dylib'},
    ('TestingEnvironmentVariables', 'DYLD_FRAMEWORK_PATH'): {'__PLATFORMS__/iPhoneSimulator.platform/Developer/Library/Frameworks'},
    ('TestingEnvironmentVariables', 'DYLD_LIBRARY_PATH'): {'__PLATFORMS__/iPhoneSimulator.platform/Developer/usr/lib'},
    ('TestingEnvironmentVariables', 'DYLD_INSERT_LIBRARIES'): {'__SIMRUNTIMEROOT__/usr/lib/libMainThreadChecker.dylib',
                                                              '/usr/lib/libRPAC.dylib'},   # observed Xcode 26.2 (run 37244303475)
}


CONTROL_CHARS = re.compile(r'[\x00-\x1f\x7f]')


class Cancelled(Exception):
    pass


CLOSE_CAP_S = 15.0


TERM_WAIT_S = 5.0


class Supervisor:
    """Owned supervisory adapter around the UNCHANGED accepted RUN_BOUNDED bytes (sha e6a7 verified before exec).
    Only the wrapper's namespace differs: its `subprocess.Popen` is a subclass that registers the one active owned
    child (leader of its own session/group).

    R5 boundary rules:
    - registration window: from entering the tracked constructor until `active` is set, a SIGTERM/SIGINT is only
      recorded and DEFERRED; immediately after registration the owned group is closed and Cancelled is raised;
    - closing is non-reentrant; R6: one immutable close plan per owned Popen (first close start/TERM cutoff/end,
      CLOSE_CAP_S for the WHOLE owned group across all close paths); signals during closing are recorded only,
      never nest, restart or extend the close;
    - ownership (`active`) is cleared only after the leader is reaped AND the group is verified empty; an unfinished
      closure is retained in `unclosed` and forces REFUSED (never PASS);
    - during trusted cleanup signals are recorded only.
    Limits (disclosed): RUN_BOUNDED's timeout runs in this SAME operator process, so SIGKILL of the operator also
    kills that watchdog; separately-sessioned owned children then have NO guaranteed timeout closure."""

    def __init__(self, collector=None):
        self.active = None
        self.cancel = None
        self.signals = []
        self.closures = []
        self.unclosed = []
        self.in_cleanup = False
        self.registering = False
        self.deferred = False
        self.closing = False
        self._close_plans = []          # R6: [(owned Popen object, immutable close plan)], identity lookup
        block = RUN_BOUNDED_SOURCE
        if sha(block.encode()) != WRAPPER_SHA:
            raise Refuse('wrapper_changed')
        sup = self

        class _TrackedPopen(subprocess.Popen):
            def __init__(self, *a, **k):
                sup.registering = True
                try:
                    super().__init__(*a, **k)
                    sup.active = self
                finally:
                    sup.registering = False
                if sup.deferred and not sup.in_cleanup:
                    sup.deferred = False
                    sup.close_active('deferred_registration_cancel')
                    raise Cancelled('deferred:' + signal.Signals(sup.cancel).name)
        proxy = types.SimpleNamespace(Popen=_TrackedPopen, DEVNULL=subprocess.DEVNULL, STDOUT=subprocess.STDOUT,
                                      TimeoutExpired=subprocess.TimeoutExpired)
        ns = {'os': os, 'time': time, 'subprocess': proxy, 'signal': signal}
        exec(compile(block, 'accepted-wrapper', 'exec'), ns)
        self._run_bounded = ns['run_bounded']
        self._group_alive = ns['_group_alive']

    def _closed(self, p):
        return p.poll() is not None and not self._group_alive(p.pid)

    def spawn(self, cmd, cwd, env, limit, log):
        if self.cancel is not None and not self.in_cleanup:
            raise Cancelled('no_new_work_after_cancel')
        if self.unclosed and not self.in_cleanup:
            raise Cancelled('owned_group_unclosed')
        try:
            return self._run_bounded(cmd, cwd, env, limit, log)
        finally:
            p = self.active
            if p is not None:
                if not self._closed(p):
                    self.close_active('spawn_exit_unclosed')
                if self._closed(p):
                    self.active = None              # ownership cleared only after verified closure
                else:
                    self.unclosed.append(p.pid)     # retained: never PASS
                    self.active = None
            if p is not None:
                self._close_plans = [(o, pl) for o, pl in self._close_plans if o is not p]   # dropped once recorded

    def close_active(self, reason):
        """R6: ONE immutable close plan per owned Popen object (identity key), bound at its FIRST close: start, TERM
        cutoff (start+5) and end (start+15). Every later close of the same owned Popen (handler, deferred, spawn
        finally) reuses that plan: no renewed 15 s, no renewed TERM phase, nothing spent after the first end. The
        plan is dropped only when the owned group is recorded closed or unclosed. 15 s is a whole-owned-group cap,
        not a per-invocation cap."""
        p = self.active
        if p is None or self.closing:
            return None
        self.closing = True
        try:
            plan = next((pl for o, pl in self._close_plans if o is p), None)   # object identity, not PID
            first = plan is None
            if first:
                s = time.monotonic()
                plan = {'start': s, 'term_until': s + min(TERM_WAIT_S, CLOSE_CAP_S), 'end': s + CLOSE_CAP_S,
                        'term_sent': False, 'kill_sent': False}
                self._close_plans.append((p, plan))
            t0 = time.monotonic()
            rec = {'pgid': p.pid, 'reason': reason, 'cap_s': CLOSE_CAP_S, 'first_close': first,
                   'deadline_reused': not first}
            for sig, until, key in ((signal.SIGTERM, plan['term_until'], 'term_sent'),
                                    (signal.SIGKILL, plan['end'], 'kill_sent')):
                if self._closed(p) or time.monotonic() >= until:
                    continue
                if not plan[key]:
                    try:
                        os.killpg(p.pid, sig)
                    except ProcessLookupError:
                        pass
                    plan[key] = True
                while time.monotonic() < until and not self._closed(p):
                    time.sleep(0.05)
            rec['term_sent'], rec['kill_sent'] = plan['term_sent'], plan['kill_sent']
            rec['group_closed'] = self._closed(p)
            rec['seconds'] = round(time.monotonic() - t0, 2)
            rec['since_first_close_s'] = round(time.monotonic() - plan['start'], 2)
            rec['signals_during_close'] = len(self.signals)
            self.closures.append(rec)
            return rec
        finally:
            self.closing = False

    def handler(self, signum, frame):
        self.signals.append(signum)
        if self.cancel is None:
            self.cancel = signum       # recorded in every phase: a cancellation can never end as PASS
        if self.in_cleanup or self.closing:
            return                     # record only: no nested/restarted/extended close; cleanup may finish
        if self.registering:
            self.deferred = True       # close + raise right after the owned child is registered
            return
        self.close_active('signal')
        raise Cancelled(signal.Signals(signum).name)


class Ctx:
    """Everything execute() touches. Real values in real_ctx(); controls build fake owned contexts."""

    def __init__(self, **kw):
        self.__dict__.update(kw)

    def vdir(self, v):
        return self.root / 'run' / v


def publish_atomic(path, data):
    tmp = Path(str(path) + '.partial')
    with open(tmp, 'w') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def bounded_copytree(ctx, src, dst, label):
    def cp(s, d):
        ctx.deadline.check(label)
        return shutil.copy2(s, d)
    shutil.copytree(src, dst, symlinks=True, copy_function=cp)


def _bundle(path, want_id):
    info = Path(path) / 'Info.plist'
    if not info.is_file():
        raise Refuse('bundle_info_missing:' + str(path))
    meta = plistlib.loads(info.read_bytes())
    if meta.get('CFBundleIdentifier') != want_id:
        raise Refuse('bundle_identifier:%s:%s' % (Path(path).name, meta.get('CFBundleIdentifier')))
    exe = Path(path) / str(meta.get('CFBundleExecutable', ''))
    if not meta.get('CFBundleExecutable') or not exe.is_file() or exe.is_symlink():
        raise Refuse('bundle_executable_missing:' + str(path))
    return meta, exe


def validate_xctestrun(ctx, v):
    """Resolve every execution-affecting path of the actually generated xctestrun; require exactly the expected
    bundles inside this variant's own Build/Products, the verified schema, real SDK names, and return the frozen
    product map (hashes of the bundles the run will actually use)."""
    prod = ctx.vdir(v) / 'dd/Build/Products'
    runs = sorted(prod.glob('*.xctestrun'))
    if len(runs) != 1:
        raise Refuse('xctestrun_count:%d' % len(runs))
    if runs[0].name != 'Relayium_%s-arm64.xctestrun' % ctx.sdk_name:
        raise Refuse('xctestrun_name_sdk:' + runs[0].name)
    xr = plistlib.loads(runs[0].read_bytes())
    if set(xr) != {'__xctestrun_metadata__', 'RelayiumUITests'}:
        raise Refuse('xctestrun_unsupported_schema:%s' % sorted(xr))
    meta = xr['__xctestrun_metadata__']
    if meta.get('FormatVersion') != 1 or meta.get('ContainerInfo') != {'ContainerName': 'Relayium', 'SchemeName': 'Relayium'}:
        raise Refuse('xctestrun_metadata')
    t = xr['RelayiumUITests']
    if set(t) - XCTESTRUN_TARGET_KEYS:
        raise Refuse('xctestrun_unknown_keys:%s' % sorted(set(t) - XCTESTRUN_TARGET_KEYS))
    if XCTESTRUN_REQUIRED - set(t):
        raise Refuse('xctestrun_missing_keys:%s' % sorted(XCTESTRUN_REQUIRED - set(t)))
    if (t['IsUITestBundle'] is not True or t['IsXCTRunnerHostedTestBundle'] is not True
            or t['TestHostBundleIdentifier'] != RUNNER_BUNDLE or t['BlueprintName'] != 'RelayiumUITests'
            or t['ProductModuleName'] != 'RelayiumUITests'):
        raise Refuse('xctestrun_target_identity')
    if t.get('CommandLineArguments', []) or t.get('UITargetAppCommandLineArguments', []):
        raise Refuse('xctestrun_injected_arguments')
    sim = prod / 'Debug-iphonesimulator'
    want = {'host': sim / 'RelayiumUITests-Runner.app', 'bundle': sim / 'RelayiumUITests-Runner.app/PlugIns/RelayiumUITests.xctest',
            'app': sim / 'Relayium.app'}
    root = os.path.realpath(prod)

    def resolve(s, host=None, must_exist=True):
        if s.startswith('__TESTROOT__/'):
            p = str(prod) + s[len('__TESTROOT__'):]
        elif s.startswith('__TESTHOST__/'):
            if host is None:
                raise Refuse('xctestrun_testhost_unresolved')
            p = host + s[len('__TESTHOST__'):]
        elif s.startswith('/'):
            p = s
        else:
            raise Refuse('xctestrun_relative_path:' + s)
        if re.search(r'__[A-Z]+__', p):
            raise Refuse('xctestrun_unsupported_placeholder:' + s)
        rp = os.path.realpath(p)
        if not rp.startswith(root + os.sep):
            raise Refuse('xctestrun_path_outside_variant:' + s)
        if must_exist and not os.path.exists(rp):
            raise Refuse('xctestrun_path_missing:' + s)
        return rp

    host = resolve(t['TestHostPath'])
    got = {'host': host, 'bundle': resolve(t['TestBundlePath'], host), 'app': resolve(t['UITargetAppPath'])}
    for k in want:
        if got[k] != os.path.realpath(want[k]):
            raise Refuse('xctestrun_selects_wrong_bundle:' + k)
    deps = t['DependentProductPaths']
    if not isinstance(deps, list) or not deps:
        raise Refuse('xctestrun_dependent_paths_empty')
    dep_set = {resolve(d, host) for d in deps}
    if dep_set != {os.path.realpath(sim / n) for n in ('Relayium.app', 'RelayiumShare.appex', 'RelayiumUITests-Runner.app',
                                                     'RelayiumUITests-Runner.app/PlugIns/RelayiumUITests.xctest')}:
        raise Refuse('xctestrun_dependent_paths')
    for ek in ENV_KEYS:
        envd = t.get(ek, {})
        if not isinstance(envd, dict):
            raise Refuse('xctestrun_env_shape:' + ek)
        for name, val in envd.items():
            if not isinstance(val, str) or CONTROL_CHARS.search(val):
                raise Refuse('xctestrun_env_value_shape:%s' % name)
            for tok in val.split(':'):
                if tok.startswith('__TESTROOT__/') and '..' not in tok.split('/'):
                    resolve(tok, must_exist=False)        # search-path entry: containment, not existence
                elif tok in ENV_EXACT_TOKENS.get((ek, name), ()):
                    continue                              # exact observed system template, nothing else
                elif tok.startswith('/'):
                    raise Refuse('xctestrun_env_foreign_absolute:%s:%s' % (name, tok))
                elif re.search(r'__[A-Z]+__', tok) or '..' in tok.split('/'):
                    raise Refuse('xctestrun_env_placeholder:%s:%s' % (name, tok))
    app_meta, app_exe = _bundle(want['app'], BUNDLE)
    appex_meta, appex_exe = _bundle(want['app'] / 'PlugIns/RelayiumShare.appex', APPEX_BUNDLE)
    run_meta, run_exe = _bundle(want['host'], RUNNER_BUNDLE)
    xt_meta, xt_exe = _bundle(want['bundle'], XCTEST_BUNDLE)
    for n, m in (('app', app_meta), ('appex', appex_meta), ('xctest', xt_meta)):
        if m.get('DTSDKName') != ctx.sdk_name:
            raise Refuse('sdk_name:%s:%s' % (n, m.get('DTSDKName')))
    if run_meta.get('DTSDKName') not in (ctx.sdk_name, ctx.sdk_name + '.internal'):
        raise Refuse('sdk_name:runner:%s' % run_meta.get('DTSDKName'))
    files = {'xctestrun': runs[0], 'app': app_exe, 'app_info': want['app'] / 'Info.plist', 'appex': appex_exe,
             'appex_info': want['app'] / 'PlugIns/RelayiumShare.appex/Info.plist', 'runner': run_exe,
             'runner_info': want['host'] / 'Info.plist', 'xctest': xt_exe, 'xctest_info': want['bundle'] / 'Info.plist'}
    return {'xctestrun_path': str(runs[0]), 'files': {k: str(p) for k, p in files.items()},
            'sha256': {k: fsha(p) for k, p in files.items()},
            'sdk': {'app': app_meta.get('DTSDKName'), 'runner': run_meta.get('DTSDKName')}}


def product_digest(prodmap):
    return {k: fsha(p) for k, p in prodmap['files'].items()}


class Op:
    def __init__(self, ctx, out):
        self.c, self.out = ctx, out
        self.log_dir = ctx.root / 'run/logs'
        self.frozen = {}          # label -> digest that must hold for every later command
        self.products = {}        # variant -> frozen product map
        self.ws_expected = {}     # variant -> exact expected workspace-state.json text sha

    # -- binding map: recomputed in full around every command
    def bindings(self, label):
        d = self.c.deadline
        b = {'code:' + n: fsha(p) for n, p in self.c.code.items()}
        b.update({'receipt:' + n: fsha(p) for n, p in self.c.receipts.items()})
        b.update({'overlay:' + r: fsha(p) for r, (p, _) in self.c.overlays.items()})
        b.update({'tool:' + k: identity(f['path']) for k, f in self.c.toolchain['files'].items()})
        b['deps:original'] = inventory_digest(inventory(self.c.dep_cache, d, label))
        for v in VARIANTS:
            src, sp = self.c.vdir(v) / 'src', self.c.vdir(v) / 'dd/SourcePackages'
            if src.is_dir():
                b['src:' + v] = inventory_digest(inventory(src, d, label))
            if sp.is_dir():
                b['deps:' + v] = check_copied_dependencies(sp, self.c.dep_receipt, d)
                b['ws:' + v] = fsha(sp / 'workspace-state.json')
            if v in self.products:
                b['products:' + v] = product_digest(self.products[v])
        d.check('bindings-' + label)
        return b

    def require_frozen(self, b, where):
        for k, want in self.frozen.items():
            if b.get(k) != want:
                raise Refuse('binding_drift:%s:%s' % (k, where))

    def freeze(self, b):
        """R4: extend only. Every already-frozen key must be unchanged; new keys (staged sources, products) are added."""
        changed = sorted(k for k in self.frozen if b.get(k) != self.frozen[k])
        if changed:
            raise Refuse('freeze_reassigns_existing_pin:%s' % changed)
        self.frozen = {**b, **self.frozen}

    def run(self, name, phase, argv, allowed_exit=(0,), cleanup=False):
        if self.c.supervisor.cancel is not None:
            raise Cancelled('no_new_work_after_cancel:' + name)
        d = self.c.deadline
        limit = d.grant(phase, cleanup=cleanup)
        log = self.log_dir / (name + '.log')
        if log.exists():
            raise Refuse('log_exists_no_retry:' + name)
        before = self.bindings('pre-' + name)
        self.require_frozen(before, 'pre-' + name)    # cleanup never uses this path (see cleanup_run)
        limit = d.grant(phase, cleanup=cleanup)              # re-grant after the pre-spawn hashing time
        t0 = time.time()
        rec = self.c.spawn(argv, str(self.c.root), self.c.env, limit, str(log))
        d.check('return-' + name, cleanup=cleanup)
        after = self.bindings('post-' + name)
        rec.update(name=name, phase=phase, argv=argv, wall_start=t0, bindings_before=before, bindings_after=after,
                   bindings_equal=before == after, log_sha256=fsha(log))
        os.chmod(log, 0o444)
        with open(self.log_dir / 'COMMANDS.jsonl', 'a') as f:
            f.write(json.dumps(rec, default=str) + '\n')
        self.out.setdefault('commands', []).append({k: rec.get(k) for k in ('name', 'exit', 'closure', 'timeout',
                                                    'leftover_group_after_exit', 'seconds', 'bindings_equal')})
        if not rec['bindings_equal']:
            changed = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
            raise Refuse('bindings_changed:%s:%s' % (name, changed))
        self.require_frozen(after, 'post-' + name)
        if rec.get('closure') != 'VERIFIED':
            raise Refuse('closure_unverified:' + name)
        if rec.get('timeout'):
            raise Refuse('timeout:' + name)
        if rec.get('leftover_group_after_exit'):
            raise Refuse('leftover_group:' + name)
        if rec.get('exit') not in allowed_exit:
            raise Refuse('exit:%s:%r' % (name, rec.get('exit')))
        d.check('accepted-' + name, cleanup=cleanup)
        return rec, log

    def cleanup_run(self, name, phase, argv, expected_argv):
        """R3 minimal cleanup path for the owned shutdown/readback ONLY. Independent of the diagnostic full binding
        map (no large hashing before cleanup, no failure from missing/corrupt products, code or dependencies).
        Safety inputs: the command must be exactly the expected owned command naming this UDID; the same immutable
        common end applies with the cleanup reserve usable (never extended); original caps (shutdown 60, state 30);
        no retry; exit 0, VERIFIED closure, no timeout/leftover required."""
        d = self.c.deadline
        if not expected_argv or list(argv) != list(expected_argv) or (phase == 'shutdown' and argv[-1] != self.c.udid):
            raise Refuse('cleanup_command_not_exact:' + name)
        self.verify_cleanup_tools(name)
        limit = d.grant(phase, cleanup=True)
        if not self.log_dir.is_dir():
            raise Refuse('cleanup_log_dir_missing:' + name)
        log = self.log_dir / (name + '.log')
        if log.exists():
            raise Refuse('log_exists_no_retry:' + name)
        t0 = time.time()
        rec = self.c.spawn(argv, str(self.c.root), self.c.env, limit, str(log))
        rec.update(name=name, phase=phase, argv=argv, wall_start=t0, cleanup_minimal_path=True,
                   log_sha256=fsha(log))
        os.chmod(log, 0o444)
        with open(self.log_dir / 'COMMANDS.jsonl', 'a') as f:
            f.write(json.dumps(rec, default=str) + '\n')
        self.out.setdefault('commands', []).append({k: rec.get(k) for k in ('name', 'exit', 'closure', 'timeout',
                                                    'leftover_group_after_exit', 'seconds')})
        d.check('return-' + name, cleanup=True)
        if rec.get('closure') != 'VERIFIED':
            raise Refuse('closure_unverified:' + name)
        if rec.get('timeout'):
            raise Refuse('timeout:' + name)
        if rec.get('leftover_group_after_exit'):
            raise Refuse('leftover_group:' + name)
        if rec.get('exit') != 0:
            raise Refuse('exit:%s:%r' % (name, rec.get('exit')))
        return rec, log

    def verify_cleanup_tools(self, name):
        """R4: the small actual safety inputs of the trusted cleanup (xcrun, simctl, Xcode identity plists and the
        DEVELOPER_DIR) must equal the frozen toolchain receipt before the owned command may run. Missing/changed means
        UNSAFE: refuse, never execute a changed tool, never fall back to another path."""
        tc = self.c.toolchain
        if self.c.env.get('DEVELOPER_DIR') != tc.get('developer_dir'):
            raise Refuse('cleanup_tool_unsafe:developer_dir:' + name)
        for k in self.c.cleanup_tool_keys:
            f = tc['files'].get(k)
            if not f:
                raise Refuse('cleanup_tool_unsafe:unpinned:%s:%s' % (k, name))
            try:
                ok = fsha(f['path']) == f['sha256']
            except OSError:
                ok = False
            if not ok:
                raise Refuse('cleanup_tool_unsafe:%s:%s' % (k, name))

    def admit(self, footprints, remaining, label):
        self.c.deadline.check('admit-' + label)
        r = admit(self.c.free(self.c.system_volume), self.c.free(str(self.c.root)), footprints, remaining)
        self.out.setdefault('admissions', []).append({label: r})
        return r


def build_source_binding(c, v, log_text):
    own = str(c.vdir(v) / 'src' / UI_REL)
    if own not in log_text:
        raise Refuse('build_log_lacks_own_source:' + v)
    for o in VARIANTS:
        if o != v and str(c.vdir(o)) + '/' in log_text:
            raise Refuse('build_log_mentions_other_variant:%s:%s' % (v, o))
