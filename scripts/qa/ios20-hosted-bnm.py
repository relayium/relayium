#!/usr/bin/env python3
"""ios20 hosted same-host B/N/M causal QA operator (temporary QA file; NEVER merge to main).

One GitHub-hosted macOS job, one owned existing simulator, one immutable 3600 s deadline (120 s cleanup reserve):
  B = git archive of the base commit, N = git archive of the candidate commit (the checkout HEAD),
  M = N with ONLY the signed-in firstLaunchFixtures entry (2 lines) removed; all 34 N/M test bodies byte-identical.
Expected: B 1 pass + 2 target launches, N 1 pass + 1 launch, M exactly the original account assertion failure at
its actual M line + 1 launch. Anything else is REFUSED; an unknown Xcode 26 xctestrun shape is
REFUSED CALIBRATION_REQUIRED with the raw xctestrun/products/build log preserved. Proves the hosted same-host
mechanism only: not local Xcode 27, not full 34-case coverage, not latency savings.

Usage: ios20-hosted-bnm.py --repo DIR --out NEW_DIR [--build-only-diagnostic]
Typed stdout line: IOS20_HOSTED_BNM <json>; exit 0 only for PASS."""
import importlib.util, json, os, re, signal, stat, sys, time
from pathlib import Path
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('ios20_hosted_bnm_support', HERE / 'ios20-hosted-bnm-support.py')
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)
MANIFEST_REL = 'scripts/qa/ios20-hosted-bnm-manifest.json'
SOURCE_RELS = ('scripts/qa/ios20-hosted-bnm.py', 'scripts/qa/ios20-hosted-bnm-support.py',
               '.github/workflows/ios20-hosted-bnm.yml')
CALIBRATION_REASONS = ('xctestrun_unknown_keys', 'xctestrun_missing_keys', 'xctestrun_unsupported_schema',
                       'xctestrun_metadata', 'xctestrun_env_', 'xctestrun_name_sdk', 'xctestrun_count',
                       'sdk_name:', 'xctestrun_target_identity')
TYPED = 'IOS20_HOSTED_BNM '


def extract_select_block(ios_yml_text):
    """The exact RELAYIUM_SELECT_XCODE literal block of the frozen ios.yml (YAML `|` scalar, 4-space body)."""
    lines = ios_yml_text.splitlines(True)
    try:
        i = lines.index('  RELAYIUM_SELECT_XCODE: |\n')
    except ValueError:
        raise S.Refuse('select_block_missing')
    body = []
    for line in lines[i + 1:]:
        if line.strip() and not line.startswith('    '):
            break
        body.append(line[4:] if line.startswith('    ') else '\n')
    return ''.join(body).rstrip('\n') + '\n'


def verify_manifest(repo):
    m = json.loads((repo / MANIFEST_REL).read_text())
    for rel in SOURCE_RELS:
        if S.fsha(repo / rel) != m['source_sha256'][rel]:
            raise S.Refuse('qa_source_not_manifest_bound:' + rel)
    return m


class HostedCmds:
    def __init__(self, ctx):
        self.c = ctx

    def git(self, *a):
        return ['/usr/bin/git', '-C', str(self.c.repo)] + list(a)

    def select(self, block):
        return ['/bin/bash', '-c', block]

    def xcrun(self, *a):
        return ['/usr/bin/xcrun'] + list(a)

    def resolve(self, project, dd):
        return ['/usr/bin/xcrun', 'xcodebuild', '-resolvePackageDependencies', '-project', str(project),
                '-scheme', 'Relayium', '-derivedDataPath', str(dd), '-onlyUsePackageVersionsFromResolvedFile']

    def dep_ls_tree(self, co, rev):
        return ['/usr/bin/git', '--git-dir', str(Path(co) / '.git'), '--work-tree', str(co),
                'ls-tree', '-r', '-z', '--full-tree', rev]

    def build(self, v):
        t = self.c.vdir(v)
        return ['/usr/bin/xcrun', 'xcodebuild', 'build-for-testing',
                '-project', str(t / 'src/apps/ios/Relayium.xcodeproj'), '-scheme', 'Relayium',
                '-configuration', 'Debug', '-destination', 'id=' + self.c.udid, '-derivedDataPath', str(t / 'dd'),
                '-disableAutomaticPackageResolution', '-skipPackageUpdates', '-onlyUsePackageVersionsFromResolvedFile']

    def test(self, v, xctestrun):
        return ['/usr/bin/xcrun', 'xcodebuild', 'test-without-building', '-xctestrun', str(xctestrun),
                '-destination', 'id=' + self.c.udid, '-resultBundlePath', str(self.c.vdir(v) / 'result.xcresult'),
                '-only-testing:' + S.CASE, '-parallel-testing-enabled', 'NO', '-test-iterations', '1',
                '-test-timeouts-enabled', 'YES', '-default-test-execution-time-allowance', '300',
                '-maximum-test-execution-time-allowance', '300', '-collect-test-diagnostics', 'never']

    def summary(self, v):
        return ['/usr/bin/xcrun', 'xcresulttool', 'get', 'test-results', 'summary',
                '--path', str(self.c.vdir(v) / 'result.xcresult')]

    def activities(self, v):
        return ['/usr/bin/xcrun', 'xcresulttool', 'get', 'test-results', 'activities',
                '--path', str(self.c.vdir(v) / 'result.xcresult'), '--test-id', S.CASE_ID]

    def state(self):
        return ['/usr/bin/xcrun', 'simctl', 'list', 'devices', '-j']

    def boot(self):
        return ['/usr/bin/xcrun', 'simctl', 'boot', self.c.udid]

    def bootstatus(self):
        return ['/usr/bin/xcrun', 'simctl', 'bootstatus', self.c.udid]

    def shutdown(self):
        return ['/usr/bin/xcrun', 'simctl', 'shutdown', self.c.udid]


def pre_run(ctx, out, name, phase, argv, code_before):
    """Pre-freeze command (git reads, Xcode selection, queries, the one public resolve): accepted wrapper through the
    Supervisor, same deadline, exit 0 + VERIFIED + no timeout/leftover, QA code unchanged around it."""
    d = ctx.deadline
    if ctx.supervisor.cancel is not None:
        raise S.Cancelled('no_new_work_after_cancel:' + name)
    limit = d.grant(phase)
    log = ctx.root / 'run/logs' / (name + '.log')
    if log.exists():
        raise S.Refuse('log_exists_no_retry:' + name)
    rec = ctx.spawn(argv, str(ctx.root), ctx.env, limit, str(log))
    d.check('return-' + name)
    rec.update(name=name, phase=phase, argv=argv, log_sha256=S.fsha(log))
    with open(ctx.root / 'run/logs/COMMANDS.jsonl', 'a') as f:
        f.write(json.dumps(rec, default=str) + '\n')
    out.setdefault('commands', []).append({k: rec.get(k) for k in ('name', 'exit', 'closure', 'timeout', 'seconds')})
    if {k: S.fsha(p) for k, p in ctx.code.items()} != code_before:
        raise S.Refuse('qa_code_changed:' + name)
    check_sources(ctx, 'after-' + name)
    if rec.get('closure') != 'VERIFIED' or rec.get('timeout') or rec.get('leftover_group_after_exit') or rec.get('exit') != 0:
        raise S.Refuse('pre_command:%s:exit=%r:closure=%s:timeout=%s' % (name, rec.get('exit'), rec.get('closure'), rec.get('timeout')))
    return log


DIAG_CAP = 1 << 20      # workspace-state diagnostic capture cap (bytes); larger files are captured truncated + flagged
COMMANDS_CAP = 8 << 20  # bounded read of COMMANDS.jsonl for the diagnostic binding
_RD = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


class _NotRegular(Exception):
    pass


class _Unstable(Exception):
    pass


def _ident(st):
    return [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_mode]


def _read_regular(deadline, path, cap, label):
    """Typed, bounded, identity-stable read: lstat must be a regular file (never follows links, never opens FIFOs);
    open O_NOFOLLOW|O_NONBLOCK; fstat regular with the same dev/ino; read at most cap+1 bytes with the common deadline
    checked per chunk; the final fstat AND lstat full identity (dev/ino/size/mtime/ctime/mode) must equal the
    initial ones. Returns (data[:cap], truncated, identity)."""
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode):
        raise _NotRegular(stat.filemode(st.st_mode))
    fd = os.open(path, _RD)
    try:
        f0 = os.fstat(fd)
        if not stat.S_ISREG(f0.st_mode) or (f0.st_dev, f0.st_ino) != (st.st_dev, st.st_ino):
            raise _Unstable('changed_between_lstat_and_open')
        chunks, got = [], 0
        while got <= cap:
            deadline.check(label)
            chunk = os.read(fd, min(65536, cap + 1 - got))
            if not chunk:
                break
            chunks.append(chunk)
            got += len(chunk)
        f1 = os.fstat(fd)
    finally:
        os.close(fd)
    l1 = os.lstat(path)
    if _ident(f1) != _ident(f0) or _ident(l1) != _ident(st):
        raise _Unstable('identity_changed_during_read')
    data = b''.join(chunks)
    return data[:cap], len(data) > cap, _ident(f0)


def _write_new(deadline, path, data, label):
    """O_EXCL new file (never overwrite) under the common deadline: checked before and after EVERY partial write; a
    zero/negative write is refused (no-progress guard); then a typed bounded readback (expected length + 1, not an
    unbounded hash) must return exactly the written bytes from the SAME inode before the file counts as preserved."""
    deadline.check(label + '-write')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        st0 = os.fstat(fd)
        view = memoryview(data)
        while view:
            deadline.check(label + '-write')
            n = os.write(fd, view)
            if n is None or n <= 0:
                raise OSError('zero_progress_write:' + str(path))
            view = view[n:]
    finally:
        os.close(fd)
    back, truncated, ident = _read_regular(deadline, path, len(data), label + '-readback')
    if truncated or back != data or ident[:2] != [st0.st_dev, st0.st_ino]:
        raise OSError('published_mismatch:' + str(path))
    deadline.check(label + '-published')


def capture_ws(ctx, out, v, phase):
    """DIAGNOSTIC ONLY: raw snapshot of variant v's workspace-state.json into run/logs (selected for upload). Never
    changes any binding, pin or verdict; I/O and stability problems are recorded (UNBOUND), never hidden. Deadline
    refusals raise (same immutable deadline, never renewed)."""
    label = 'diag-ws-%s-%s' % (v, phase)
    d = ctx.deadline
    d.check(label)
    src = ctx.vdir(v) / 'dd/SourcePackages/workspace-state.json'
    raw = ctx.root / 'run/logs' / (label + '.raw')
    rec = {'variant': v, 'phase': phase, 'captured': False, 'stable': False}
    try:
        data, truncated, ident = _read_regular(d, src, DIAG_CAP, label)
        rec.update(identity=ident, size=ident[2], truncated=truncated, captured_bytes=len(data),
                   captured_sha256=S.sha(data), stable=True)
        rec['sha256'] = None if truncated else rec['captured_sha256']        # full-file sha only
        _write_new(d, raw, data, label)
        rec['captured'] = True
        rec['raw'] = raw.name
    except _NotRegular as e:
        rec['reason'] = 'not_regular_file_not_followed:%s' % e
    except _Unstable as e:
        rec['reason'] = 'unstable:%s' % e
        rec['stable'] = False
    except OSError as e:
        out.setdefault('diagnostics_errors', []).append('%s:%s:%s' % (label, type(e).__name__, e))
        rec['error'] = '%s:%s' % (type(e).__name__, e)
    try:
        _write_new(d, ctx.root / 'run/logs' / (label + '.meta.json'), json.dumps(rec, indent=1, sort_keys=True).encode(),
                   label + '-meta')
    except OSError as e:
        out.setdefault('diagnostics_errors', []).append('%s-meta:%s:%s' % (label, type(e).__name__, e))
    d.check(label + '-done')
    return rec


def bind_ws(ctx, out, v, pre, post):
    """Bind snapshots to the ACTUAL bounded COMMANDS.jsonl record of build-v (typed read <= COMMANDS_CAP, parsed under
    the common deadline). BOUND only for a preserved, stable, untruncated snapshot whose sha equals the command's
    bindings_before/after['ws:v']; everything else UNBOUND (never read as the exact difference)."""
    d = ctx.deadline
    label = 'diag-ws-%s-binding' % v
    key = 'ws:' + v
    res = {'variant': v, 'command_record': False}
    row = None
    try:
        data, truncated, _ = _read_regular(d, ctx.root / 'run/logs/COMMANDS.jsonl', COMMANDS_CAP, label + '-commands')
        if truncated:
            res['commands_reason'] = 'commands_oversize'
        else:
            for i, line in enumerate(data.decode('utf-8', 'replace').splitlines()):
                if i % 64 == 0:
                    d.check(label + '-parse')
                if line.strip():
                    r = json.loads(line)
                    if r.get('name') == 'build-' + v:
                        row = r
            res['command_record'] = row is not None
    except (_NotRegular, _Unstable) as e:
        res['commands_reason'] = '%s:%s' % (type(e).__name__, e)
    except (OSError, ValueError) as e:
        out.setdefault('diagnostics_errors', []).append('%s:%s:%s' % (label, type(e).__name__, e))
        res['commands_reason'] = '%s:%s' % (type(e).__name__, e)
    d.check(label + '-parsed')
    for side, snap, field in (('pre', pre, 'bindings_before'), ('post', post, 'bindings_after')):
        snap = snap or {}
        want = ((row or {}).get(field) or {}).get(key)
        ok_snap = snap.get('captured') and snap.get('stable') and not snap.get('truncated')
        got = snap.get('sha256') if ok_snap else None
        res[side] = {'command_ws_sha256': want, 'snapshot_sha256': got,
                     'status': 'BOUND' if want and got and want == got else 'UNBOUND'}
    out.setdefault('ws_diagnostics', {})[v] = res
    try:
        _write_new(d, ctx.root / 'run/logs' / (label + '.json'), json.dumps(res, indent=1, sort_keys=True).encode(), label)
    except OSError as e:
        out.setdefault('diagnostics_errors', []).append('%s:%s:%s' % (label, type(e).__name__, e))
    return res


def check_sources(ctx, label):
    for v, want in (getattr(ctx, 'src_expected', None) or {}).items():
        if S.inventory_digest(S.inventory(ctx.vdir(v) / 'src', ctx.deadline, 'srccheck-' + label)) != want:
            raise S.Refuse('source_changed_before_freeze:%s:%s' % (v, label))


PRODUCT_ROOTS = ('Relayium.app', 'RelayiumShare.appex', 'RelayiumUITests-Runner.app', 'PackageFrameworks')


def product_trees(ctx, v, label):
    """R2: full physical inventory (files, nested dirs, symlinks) of every product root the run can load, plus the
    xctestrun. R3 closure: every symlink's FINAL target must exist and lie inside the UNION of the fully inventoried
    product roots (whose bytes are therefore bound); a target elsewhere — even inside Build/Products (an unlisted
    bundle), another variant or the system — is refused, as is a missing target."""
    prod = ctx.vdir(v) / 'dd/Build/Products'
    sim = prod / 'Debug-iphonesimulator'
    roots, out, invs = {}, {}, {}
    for name in PRODUCT_ROOTS:
        d = sim / name
        if not os.path.lexists(d):
            if name == 'PackageFrameworks':
                continue
            raise S.Refuse('product_root_missing:%s:%s' % (v, name))
        if os.path.islink(d):
            raise S.Refuse('product_root_symlink:%s:%s' % (v, name))
        if not stat.S_ISDIR(os.lstat(d).st_mode):     # R4: every present product root must be a real directory
            raise S.Refuse('product_root_not_directory:%s:%s' % (v, name))
        roots[name] = os.path.realpath(d)
        invs[name] = S.inventory(d, ctx.deadline, label)
    inside = lambda tgt: any(tgt == r or tgt.startswith(r + os.sep) for r in roots.values())
    for name, inv in invs.items():
        for rel, ent in inv.items():
            if 'link' in ent:
                tgt = os.path.realpath(os.path.join(str(sim / name), rel))
                if not os.path.exists(tgt):
                    raise S.Refuse('product_symlink_missing_target:%s:%s/%s' % (v, name, rel))
                if not inside(tgt):
                    raise S.Refuse('product_symlink_escape:%s:%s/%s' % (v, name, rel))
        out[name] = S.inventory_digest(inv)
    for x in sorted(prod.glob('*.xctestrun')):
        out['xctestrun:' + x.name] = S.fsha(x)
    return out


class HostedOp(S.Op):
    """R6 Op plus R2 full product-tree bindings for every built variant (extend-only freeze still applies)."""

    def bindings(self, label):
        b = super().bindings(label)
        for v in self.products:
            b['ptree:' + v] = product_trees(self.c, v, 'ptree-' + label)
        self.c.deadline.check('ptree-' + label)
        return b


def select_simulator(listing_json, profile):
    """Exactly one available, Shutdown device of the profile's device type on the profile's runtime; no other device
    Booted anywhere. No first-match fallback."""
    devs = json.loads(listing_json)['devices']
    booted = [d['udid'] for lst in devs.values() for d in lst if d.get('state') == 'Booted']
    if booted:
        raise S.Refuse('foreign_booted_device:%d' % len(booted))
    hits = [d for d in devs.get(profile['runtime_id'], [])
            if d.get('isAvailable') and d.get('deviceTypeIdentifier') == profile['device_type']]
    if len(hits) != 1:
        raise S.Refuse('profile_device_not_unique:%d' % len(hits))
    if hits[0].get('state') != 'Shutdown':
        raise S.Refuse('profile_device_not_shutdown')
    return hits[0]['udid']


_SAFE_PATH = re.compile(r'/[A-Za-z0-9._@+/-]*')


def _canonical_safe(p):
    """R4-R2: an absolute local path must be safe ASCII with canonical components (no empty, '.', '..', trailing /)."""
    if not _SAFE_PATH.fullmatch(p) or p.endswith('/'):
        return False
    return all(c not in ('', '.', '..') for c in p.split('/')[1:])


def _no_dup(pairs):
    keys = [k for k, _ in pairs]
    if len(set(keys)) != len(keys):
        raise S.Refuse('workspace_state_duplicate_key')
    return dict(pairs)


def _strict_load(text):
    try:
        return json.loads(text, object_pairs_hook=_no_dup)
    except ValueError as e:
        raise S.Refuse('workspace_state_invalid_json:%s' % e)


def _walk_strings(o):
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for k, v in o.items():
            yield from _walk_strings(k)
            yield from _walk_strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from _walk_strings(v)


def _map_strings(o, f):
    if isinstance(o, str):
        return f(o)
    if isinstance(o, dict):
        return {k: _map_strings(v, f) for k, v in o.items()}
    if isinstance(o, list):
        return [_map_strings(v, f) for v in o]
    return o


def rewrite_ws(text, seed_sp, seed_kit, var_sp, var_kit, var_root):
    """R4: per-variant workspace-state preserving the ORIGINAL seed serialization byte-for-byte except for approved
    JSON string-token path edits: (a) every string equal to seed_sp or under seed_sp/ (component boundary) gets the
    variant SourcePackages prefix; (b) exactly the two relayiumkit fields (packageRef.location, state.path), which must
    equal seed_kit, become var_kit. Strict duplicate-key parse; no JSON escapes supported (refused); every path safe
    ASCII; expected count derived from the parsed structure; the parsed result must equal the expected semantic
    transform; reverse edits must reconstruct the original bytes exactly; all absolute strings inside var_root."""
    seed_sp, seed_kit, var_sp, var_kit, var_root = map(str, (seed_sp, seed_kit, var_sp, var_kit, var_root))
    for pth in (seed_sp, seed_kit, var_sp, var_kit, var_root):
        if not _SAFE_PATH.fullmatch(pth) or '//' in pth or pth.endswith('/') or '/../' in pth + '/' or '/./' in pth + '/':
            raise S.Refuse('workspace_state_unsupported_path_chars')
    if '\\' in text:
        raise S.Refuse('workspace_state_escape_unsupported')
    orig = _strict_load(text)
    in_sp = lambda s: s == seed_sp or s.startswith(seed_sp + '/')
    expected_sp = sum(1 for s in _walk_strings(orig) if in_sp(s))
    if expected_sp < 1:
        raise S.Refuse('workspace_state_seed_prefix_zero')
    tok = re.compile('"' + re.escape(seed_sp) + r'((?:/[^"\\]*)?)"')
    if len(tok.findall(text)) != expected_sp or text.count(seed_sp) != expected_sp:
        raise S.Refuse('workspace_state_seed_prefix_ambiguous')
    exp = _map_strings(orig, lambda s: var_sp + s[len(seed_sp):] if in_sp(s) else s)
    kits = [dep for dep in (exp.get('object') or {}).get('dependencies') or [] if (dep.get('packageRef') or {}).get('identity') == 'relayiumkit']
    if len(kits) != 1:
        raise S.Refuse('workspace_state_relayiumkit_count')
    kit = kits[0]
    if (kit.get('packageRef') or {}).get('location') != seed_kit or (kit.get('state') or {}).get('path') != seed_kit:
        raise S.Refuse('workspace_state_kit_identity')
    if text.count('"' + seed_kit + '"') != 2 or text.count(seed_kit) != 2 or sum(1 for s in _walk_strings(orig) if s == seed_kit) != 2:
        raise S.Refuse('workspace_state_kit_ambiguous')
    kit['packageRef']['location'] = var_kit
    kit['state']['path'] = var_kit
    for s in _walk_strings(exp):
        if s.startswith('/'):
            if not _canonical_safe(s):                 # every parsed absolute path AFTER mapping (suffixes included)
                raise S.Refuse('workspace_state_unsafe_path')
            if not (s == var_root or s.startswith(var_root + '/')):
                raise S.Refuse('workspace_state_foreign_path')
    if var_sp != seed_sp and text.count(var_sp):
        raise S.Refuse('workspace_state_target_preexists')
    if var_kit != seed_kit and text.count(var_kit):
        raise S.Refuse('workspace_state_target_preexists')
    new = tok.sub(lambda m: '"' + var_sp + m.group(1) + '"', text)
    new = new.replace('"' + seed_kit + '"', '"' + var_kit + '"')
    if _strict_load(new) != exp:
        raise S.Refuse('workspace_state_transform_mismatch')
    back = re.compile('"' + re.escape(var_sp) + r'((?:/[^"\\]*)?)"').sub(lambda m: '"' + seed_sp + m.group(1) + '"', new)
    back = back.replace('"' + var_kit + '"', '"' + seed_kit + '"')
    if back != text:
        raise S.Refuse('workspace_state_nonpath_bytes_changed')
    return new


def seed_receipt(ctx, out, seed_sp, pins, code0):
    """Pin the one public resolve: checkout revisions + tracked bytes vs the actual Git objects, binary xcframework
    metadata, full physical inventory."""
    ws = json.loads((seed_sp / 'workspace-state.json').read_text())
    checkouts = {}
    for dep in ws['object']['dependencies']:
        ident = dep['packageRef']['identity']
        if dep['packageRef']['kind'] != 'remoteSourceControl':
            continue
        rev = dep['state']['checkoutState']['revision']
        if pins.get(ident) != rev:
            raise S.Refuse('resolved_revision:' + ident)
        co = seed_sp / 'checkouts' / dep['subpath']
        if S.checkout_revision(co) != rev:
            raise S.Refuse('checkout_head:' + ident)
        log = pre_run(ctx, out, 'dep-ls-tree-' + ident, 'state', ctx.cmds.dep_ls_tree(co, rev), code0)
        cmp = S.compare_checkout(co, S.parse_ls_tree(log.read_text(errors='surrogateescape')), rev, rev)
        if cmp['tracked_mismatch'] or cmp['tracked_missing']:
            raise S.Refuse('checkout_tracked_bytes:' + ident)
        if cmp['untracked']:                          # R2: any untracked work-tree input (e.g. a new Sources/*.swift)
            raise S.Refuse('checkout_untracked:%s:%d' % (ident, len(cmp['untracked'])))
        checkouts[ident] = cmp
    if set(checkouts) != set(pins):
        raise S.Refuse('resolved_identity_set')
    xcf = {}
    for a in ws['object'].get('artifacts', []):
        p = Path(a['path'])
        if not str(p).startswith(str(seed_sp) + '/'):
            raise S.Refuse('artifact_outside_seed')
        xcf[a['packageRef']['identity'] + ':' + a['targetName']] = S.xcframework_receipt(p)
    inv = S.inventory(seed_sp, ctx.deadline, 'seed-inventory')
    return {'inventory': inv, 'inventory_digest': S.inventory_digest(inv), 'checkouts': checkouts,
            'xcframeworks': xcf, 'status': 'PINNED'}


def resolved_pin_map(text):
    return {p['identity']: p['state'].get('revision') for p in json.loads(text)['pins']}


def hosted_execute(repo, out_dir, build_only=False, spawn=None, clock=None, env=None, free=None, cmds_factory=None):
    sup = S.Supervisor()
    prev = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGINT)}
    for s in prev:
        signal.signal(s, sup.handler)
    try:
        return _hosted(repo, out_dir, build_only, sup, spawn, clock, env, free, cmds_factory)
    finally:
        for s, h in prev.items():
            signal.signal(s, h)


def _hosted(repo, out_dir, build_only, sup, spawn, clock, env, free, cmds_factory):
    repo, root = Path(repo).resolve(), Path(out_dir).resolve()
    out = {'start_wall': time.time(), 'mode': 'build_only_diagnostic' if build_only else 'full'}
    if root.exists():
        raise SystemExit(TYPED + json.dumps({'verdict': 'REFUSED', 'primary': 'REFUSED:out_dir_exists_no_retry'}))
    (root / 'run/logs').mkdir(parents=True, mode=0o700)
    deadline = S.Deadline(clock=clock) if clock else S.Deadline()
    ctx = S.Ctx(root=root, repo=repo, deadline=deadline, supervisor=sup,
                spawn=spawn(sup.spawn) if spawn else sup.spawn, overlays={},   # offline controls may wrap, never replace

                env=dict(env or {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': os.environ.get('HOME', ''),
                                 'LANG': 'C.UTF-8', 'TMPDIR': str(root / 'tmp') + '/'}),
                free=free or S.free_bytes, system_volume='/', receipts={}, udid=None)
    (root / 'tmp').mkdir(mode=0o700)
    ctx.vdir = lambda v: root / 'run' / v
    ctx.cmds = (cmds_factory or HostedCmds)(ctx)
    ctx.code = {rel: repo / rel for rel in SOURCE_RELS + (MANIFEST_REL,)}
    op, booted, primary, cleanup_problems = None, False, None, []
    try:
        deadline.check('start')
        m = verify_manifest(repo)
        out['manifest_sha256'] = S.fsha(repo / MANIFEST_REL)
        S.configure_profile(m['profile']['runtime_id'], m['profile']['runtime_os'], m['profile']['device_type'])
        code0 = {k: S.fsha(p) for k, p in ctx.code.items()}
        # The QA commit must be exactly one commit on top of N adding ONLY the four QA files (never merged).
        parent = pre_run(ctx, out, 'git-head-parent', 'state', ctx.cmds.git('rev-parse', 'HEAD^'), code0).read_text().strip()
        if parent != m['commit_n']:
            raise S.Refuse('qa_commit_parent_not_n')
        changed = pre_run(ctx, out, 'git-qa-delta', 'state', ctx.cmds.git('diff', '--name-only', m['commit_n'], 'HEAD'),
                          code0).read_text().split()
        if sorted(changed) != sorted(SOURCE_RELS + (MANIFEST_REL,)):
            raise S.Refuse('qa_commit_delta:' + ','.join(sorted(changed)))
        trees = {}
        for v, commit in (('B', m['commit_b']), ('N', m['commit_n'])):
            log = pre_run(ctx, out, 'ls-tree-' + v, 'archive', ctx.cmds.git('ls-tree', '-r', '-z', '--full-tree', commit), code0)
            trees[v] = S.parse_ls_tree(log.read_text(errors='surrogateescape'))
            tar = root / 'run' / (v + '.tar')
            pre_run(ctx, out, 'archive-' + v, 'archive', ctx.cmds.git('archive', '--format=tar', '-o', str(tar), commit), code0)
            ctx.vdir(v).mkdir(mode=0o700)
            S.safe_extract(tar, ctx.vdir(v) / 'src', trees[v])
            deadline.check('extracted-' + v)
        for v, pins in m['source_pins'].items():
            for rel, want in pins.items():
                if S.fsha(ctx.vdir(v) / 'src' / rel) != want:
                    raise S.Refuse('source_pin:%s:%s' % (v, rel))
        ctx.vdir('M').mkdir(mode=0o700)
        S.bounded_copytree(ctx, ctx.vdir('N') / 'src', ctx.vdir('M') / 'src', 'copy-M')
        n_text = (ctx.vdir('N') / 'src' / S.UI_REL).read_text()
        (ctx.vdir('M') / 'src' / S.UI_REL).write_text(S.derive_m(n_text))
        texts = {v: (ctx.vdir(v) / 'src' / S.UI_REL).read_text() for v in S.VARIANTS}
        mech = S.check_variant_texts(texts['B'], texts['N'], texts['M'])
        if mech['launches'] != m['expected']['launches'] or mech['m_line'] != m['expected']['m_line']:
            raise S.Refuse('mechanism_not_manifest:' + json.dumps(mech))
        out['mechanism'] = mech
        invs = {v: S.inventory(ctx.vdir(v) / 'src', deadline, 'src-' + v) for v in S.VARIANTS}
        # R2: the Git-verified B/N + exact-M source inventories become immutable expected bindings NOW; every later
        # pre-freeze command and the first freeze must reproduce them (a later freeze can never reset them).
        ctx.src_expected = {v: S.inventory_digest(i) for v, i in invs.items()}
        out['source_inventory_digests'] = ctx.src_expected
        dm = {k for k in set(invs['N']) | set(invs['M']) if invs['N'].get(k) != invs['M'].get(k)}
        if dm != {S.UI_REL}:
            raise S.Refuse('m_delta_not_exactly_ui_file')
        pins = {}
        for v in S.VARIANTS:
            S.check_token_store((ctx.vdir(v) / 'src' / S.TOKEN_REL).read_text())
            pv = [resolved_pin_map((ctx.vdir(v) / 'src' / r).read_text()) for r in S.RESOLVED_RELS]
            if pv[0] != pv[1] or (pins and pv[0] != pins) or pv[0] != m['dependency_pins']:
                raise S.Refuse('package_resolved_pins:' + v)
            pins = pv[0]
        # ---- Xcode selection: the exact frozen ios.yml block of N, hash-bound by the manifest
        block = extract_select_block((ctx.vdir('N') / 'src/.github/workflows/ios.yml').read_text())
        if S.sha(block.encode()) != m['select_block_sha256']:
            raise S.Refuse('select_block_not_manifest')
        envfile = root / 'run/select.env'
        envfile.write_text('')
        sel_env = dict(ctx.env, RELAYIUM_XCODE_MAJOR=m['profile']['xcode_major'],
                       RELAYIUM_MIN_IOS_SDK_MAJOR=m['profile']['min_ios_sdk_major'], GITHUB_ENV=str(envfile))
        saved_env, ctx.env = ctx.env, sel_env
        pre_run(ctx, out, 'select-xcode', 'select', ctx.cmds.select(block), code0)
        ctx.env = saved_env
        lines = [l for l in envfile.read_text().splitlines() if l.strip()]
        if len(lines) != 1 or not lines[0].startswith('DEVELOPER_DIR=/'):
            raise S.Refuse('select_output')
        ctx.env['DEVELOPER_DIR'] = lines[0].split('=', 1)[1]
        q = lambda name, argv: pre_run(ctx, out, name, 'state', argv, code0).read_text().strip()
        tools = {t: q('find-' + t, ctx.cmds.xcrun('--find', t)) for t in ('xcodebuild', 'simctl', 'xcresulttool')}
        sdk_ver = q('sdk-version', ctx.cmds.xcrun('--sdk', 'iphonesimulator', '--show-sdk-version'))
        xver = q('xcodebuild-version', ctx.cmds.xcrun('xcodebuild', '-version'))
        dev = Path(ctx.env['DEVELOPER_DIR'])
        files = {'xcrun': '/usr/bin/xcrun', **{t: os.path.realpath(p) for t, p in tools.items()},
                 'xcode_info': str(dev.parent / 'Info.plist'), 'xcode_version_plist': str(dev.parent / 'version.plist')}
        ctx.toolchain = {'developer_dir': str(dev), 'xcodebuild_version': xver.splitlines(), 'sdk_version': sdk_ver,
                         'files': {k: {'path': p, 'sha256': S.fsha(p), 'identity': S.identity(p)} for k, p in files.items()}}
        ctx.sdk_name = 'iphonesimulator' + sdk_ver
        if not re.fullmatch(r'\d+(\.\d+)*', sdk_ver) or int(sdk_ver.split('.')[0]) < int(m['profile']['min_ios_sdk_major']):
            raise S.Refuse('sdk_version:' + sdk_ver)
        (root / 'run/TOOLCHAIN.json').write_text(json.dumps(ctx.toolchain, indent=1, sort_keys=True))
        ctx.cleanup_tool_keys = ('xcrun', 'simctl', 'xcode_info', 'xcode_version_plist')
        # ---- the owned existing simulator (explicit profile, unique, Shutdown)
        # The FIRST simctl call after Xcode selection gets the distinct bounded initial phase (CAPS['initial_state']);
        # same single command/JSON, no retry, no boot. Every later state command keeps CAPS['state'].
        listing = pre_run(ctx, out, 'state-select', 'initial_state', ctx.cmds.state(), code0).read_text().strip()
        ctx.udid = select_simulator(listing, m['profile'])
        S.check_sim_list(listing, 'Shutdown', ctx.udid)
        ctx.cleanup_expected = {'shutdown': ctx.cmds.shutdown(), 'state': ctx.cmds.state()}
        out['device'] = {'udid': ctx.udid, 'runtime_id': m['profile']['runtime_id'], 'device_type': m['profile']['device_type']}
        # ---- one public dependency resolve, then pinned and strictly offline
        seed = root / 'run/seed'
        pre_run(ctx, out, 'resolve-once', 'resolve',
                ctx.cmds.resolve(ctx.vdir('N') / 'src/apps/ios/Relayium.xcodeproj', seed), code0)
        seed_sp = seed / 'SourcePackages'
        ctx.dep_receipt = seed_receipt(ctx, out, seed_sp, pins, code0)
        ctx.dep_cache = seed_sp
        (root / 'run/DEPENDENCIES.json').write_text(json.dumps(ctx.dep_receipt, indent=1, sort_keys=True))
        ctx.receipts = {'toolchain': root / 'run/TOOLCHAIN.json', 'dependencies': root / 'run/DEPENDENCIES.json'}
        check_sources(ctx, 'after-resolve')
        for v in S.VARIANTS:                          # explicit re-check of both Package.resolved after the resolve
            pv = [resolved_pin_map((ctx.vdir(v) / 'src' / r).read_text()) for r in S.RESOLVED_RELS]
            if pv[0] != m['dependency_pins'] or pv[1] != m['dependency_pins']:
                raise S.Refuse('package_resolved_changed:' + v)
        op = HostedOp(ctx, out)
        # R4: the ORIGINAL seed workspace-state is read bounded/typed/stable and retained raw (+meta) under run/logs
        # because the formatting-stability assumption is not yet proven; its serialization is preserved per variant.
        try:
            seed_raw, seed_trunc, seed_ident = _read_regular(deadline, seed_sp / 'workspace-state.json', DIAG_CAP, 'seed-ws')
        except (_NotRegular, _Unstable) as e:
            raise S.Refuse('seed_workspace_state:%s' % e)
        if seed_trunc:
            raise S.Refuse('seed_workspace_state_oversize')
        _write_new(deadline, root / 'run/logs/diag-ws-seed.raw', seed_raw, 'diag-ws-seed')
        _write_new(deadline, root / 'run/logs/diag-ws-seed.meta.json', json.dumps(
            {'sha256': S.sha(seed_raw), 'size': len(seed_raw), 'identity': seed_ident}, sort_keys=True).encode(), 'diag-ws-seed-meta')
        try:
            ws_text = seed_raw.decode('utf-8')
        except UnicodeDecodeError:
            raise S.Refuse('seed_workspace_state_not_utf8')
        for v in S.VARIANTS:
            sp = ctx.vdir(v) / 'dd/SourcePackages'
            sp.parent.mkdir(mode=0o700)
            S.bounded_copytree(ctx, seed_sp, sp, 'copy-deps-' + v)
            new = rewrite_ws(ws_text, seed_sp, ctx.vdir('N') / 'src/apps/RelayiumKit', sp,
                             ctx.vdir(v) / 'src/apps/RelayiumKit', ctx.vdir(v))
            (sp / 'workspace-state.json').write_text(new)
            op.ws_expected[v] = S.sha(new.encode())
            S.check_copied_dependencies(sp, ctx.dep_receipt, deadline)
        staged = op.bindings('staged')
        for v in S.VARIANTS:
            if staged['ws:' + v] != op.ws_expected[v]:
                raise S.Refuse('workspace_state_not_expected:' + v)
            if staged['src:' + v] != ctx.src_expected[v]:    # first freeze must equal the original Git-verified sources
                raise S.Refuse('source_changed_before_freeze:%s:first-freeze' % v)
        op.freeze(staged)
        _, s = op.run('state-pre', 'state', ctx.cmds.state())
        S.check_sim_list(s.read_text(), 'Shutdown', ctx.udid)
        feet = []
        for i, v in enumerate(('B',) if build_only else S.VARIANTS):
            op.admit(feet, len(S.VARIANTS) - i, 'build-' + v)
            pre = capture_ws(ctx, out, v, 'pre')        # diagnostic only; a deadline refusal here stops the run
            try:
                _, log = op.run('build-' + v, 'build', ctx.cmds.build(v))
            except BaseException:
                try:                                   # never mask the original build/binding failure
                    bind_ws(ctx, out, v, pre, capture_ws(ctx, out, v, 'post'))
                except BaseException as e:
                    out.setdefault('diagnostics_errors', []).append('diag-ws-%s-post-suppressed:%s:%s' % (v, type(e).__name__, e))
                raise
            bind_ws(ctx, out, v, pre, capture_ws(ctx, out, v, 'post'))
            text = log.read_text(errors='replace')
            if S.FETCH_EVIDENCE.search(text):
                raise S.Refuse('remote_fetch_evidence:' + v)
            S.build_source_binding(ctx, v, text)
            try:
                op.products[v] = S.validate_xctestrun(ctx, v)
                product_trees(ctx, v, 'validate-' + v)    # R2: full trees + symlink containment before any freeze
            except S.Refuse as e:
                keep = root / 'calibration' / v
                keep.mkdir(parents=True)
                prod = ctx.vdir(v) / 'dd/Build/Products'
                for x in sorted(prod.glob('*.xctestrun')):
                    (keep / x.name).write_bytes(x.read_bytes())
                if str(e).startswith(CALIBRATION_REASONS):
                    raise S.Refuse('CALIBRATION_REQUIRED:' + str(e))
                raise
            if build_only:
                raise S.Refuse('DIAGNOSTIC_BUILD_ONLY:xctestrun_accepted')
            feet.append(S.du(ctx.vdir(v), deadline))
            op.freeze(op.bindings('built-' + v))
        paths = [p['xctestrun_path'] for p in op.products.values()]
        if len(set(paths)) != 3 or op.products['N']['sha256']['xctest'] == op.products['M']['sha256']['xctest']:
            raise S.Refuse('cross_variant_products')
        out['products'] = op.products
        op.admit(feet, 0, 'boot')
        booted = True
        op.run('boot', 'boot', ctx.cmds.boot())
        op.run('bootstatus', 'bootstatus', ctx.cmds.bootstatus())
        _, s = op.run('state-booted', 'state', ctx.cmds.state())
        S.check_sim_list(s.read_text(), 'Booted', ctx.udid)
        results = {}
        for v in S.VARIANTS:
            op.admit(feet, 0, 'test-' + v)
            rec, log = op.run('test-' + v, 'test', ctx.cmds.test(v, op.products[v]['xctestrun_path']),
                              allowed_exit=(65,) if v == 'M' else (0,))
            xb = ctx.vdir(v) / 'result.xcresult'
            if not xb.is_dir():
                raise S.Refuse('xcresult_missing:' + v)
            xr = S.tree_hash(xb)
            _, sl = op.run('summary-' + v, 'xcresult', ctx.cmds.summary(v))
            _, al = op.run('activities-' + v, 'xcresult', ctx.cmds.activities(v))
            summ = S.check_summary(sl.read_text(), v, ctx.udid)
            n = S.check_activities(al.read_text(), mech['launches'][v], ctx.udid)
            loc = None
            if v == 'M':
                loc = S.check_m_location(log.read_text(errors='replace'), ctx.vdir('M') / 'src' / S.UI_REL, mech['m_line'])
            S.judge_exit(v, rec, oracle_ok=True)
            if S.tree_hash(xb) != xr:
                raise S.Refuse('xcresult_changed_during_read:' + v)
            deadline.check('oracle-' + v)
            results[v] = {'summary': summ, 'launches': n, 'location': loc, 'xcresult_tree': xr, 'exit': rec['exit']}
        out['results'] = results
        deadline.check('oracle-final')
    except S.Cancelled as e:
        primary = 'REFUSED:cancelled:' + str(e)
    except S.Refuse as e:
        primary = 'REFUSED:' + str(e)
    except Exception as e:
        primary = 'EXCEPTION:%s:%s' % (type(e).__name__, e)
    finally:
        sup.in_cleanup = True
        if booted and op is not None:
            for name, phase, argv, key in (('shutdown', 'shutdown', ctx.cmds.shutdown(), 'shutdown'),
                                           ('state-post', 'state', ctx.cmds.state(), 'state')):
                try:
                    _, s = op.cleanup_run(name, phase, argv, ctx.cleanup_expected.get(key))
                    if key == 'state':
                        out['post_state'] = S.check_sim_list(s.read_text(), 'Shutdown', ctx.udid)['state']
                except Exception as e:
                    cleanup_problems.append('%s:%s:%s' % (name, type(e).__name__, e))
    if primary is None and not cleanup_problems and op is not None:
        try:
            op.require_frozen(op.bindings('final'), 'final')
        except Exception as e:
            cleanup_problems.append('final_bindings:%s:%s' % (type(e).__name__, e))
    if sup.unclosed and primary is None:
        primary = 'REFUSED:owned_group_unclosed'
    if sup.cancel is not None and primary is None:
        primary = 'REFUSED:cancelled:' + signal.Signals(sup.cancel).name
    out.update(primary=primary, cleanup_problems=cleanup_problems)
    verdict = S.PASS if primary is None and not cleanup_problems else 'REFUSED'
    if verdict == S.PASS:
        try:
            deadline.check('export')
        except S.Refuse as e:
            verdict, out['primary'] = 'REFUSED', 'REFUSED:' + str(e)
    out['verdict'] = verdict
    result = root / 'RESULT.json'
    try:
        S.publish_atomic(result, json.dumps(out, indent=1, default=str))
        published = True
    except Exception as e:
        published, out['publication_error'] = False, '%s:%s' % (type(e).__name__, e)
    if verdict == S.PASS and (not published or sup.cancel is not None):
        verdict = out['verdict'] = 'REFUSED'
    if verdict == S.PASS:
        try:
            deadline.check('post-publication')
        except S.Refuse as e:
            verdict = out['verdict'] = 'REFUSED'
            out['primary'] = 'REFUSED:' + str(e)
            try:
                S.publish_atomic(result, json.dumps(out, indent=1, default=str))
            except Exception as e2:
                out['downgrade_error'] = str(e2)
                try:
                    os.replace(result, str(result) + '.INVALID-LATE')
                except Exception as e3:
                    out['downgrade_unlink_error'] = str(e3)
    print(TYPED + json.dumps({k: out.get(k) for k in ('verdict', 'primary', 'cleanup_problems', 'publication_error',
                                                      'mode', 'downgrade_error')}), flush=True)
    return out, (0 if verdict == S.PASS else 1)


def main(argv):
    args = argv[1:]
    build_only = '--build-only-diagnostic' in args
    args = [a for a in args if a != '--build-only-diagnostic']
    if len(args) != 4 or args[0] != '--repo' or args[2] != '--out':
        print(TYPED + json.dumps({'verdict': 'REFUSED', 'primary': 'REFUSED:usage'}))
        return 2
    return hosted_execute(args[1], args[3], build_only)[1]


if __name__ == '__main__':
    sys.exit(main(sys.argv))
