#!/usr/bin/env node
// Pure script wiring formerly in LocalNearbyModuleBoundaryTests. Script-only
// changes do not select Swift CI, so repository-policy owns these assertions.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsText, splitText } from './lib/swift-source-text.mjs';
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the iOS built-App harness drives the link and the Mac one still drives the room', () => {
  const ios = read('scripts/ios-ui-session-acceptance.sh');
  assert.ok(containsText(ios, 'start_peer local-link-peer local-link-peer'),
    'the iOS built-App harness no longer starts a local link peer');
  assert.ok(!containsText(ios, 'start_peer nearby-receiver'),
    "the iOS harness is back on the hub's code-less room, which no shipped iOS build browses");
  const mac = read('scripts/macos-ui-session-acceptance.sh');
  assert.ok(containsText(mac, 'start_peer nearby-receiver nearby-receiver'),
    "the macOS harness left the hub's code-less room, which is still where macOS discovery joins");
  assert.ok(!containsText(mac, 'local-link-peer'), 'the macOS harness adopted the iOS-only local link');
});

// ── R123: the Nearby counterpart's residency is armed by the Nearby tests ──────
//
// `local-link-peer` fails itself after 240s with nothing moving. The launcher
// used to `POST /start` before `xcodebuild`, so that clock ran through compiling
// and booting a simulator (hosted run 37407624590: resident 03:17:22, failed
// 03:21:22, UI runner 03:27:31). These are SOURCE checks of where the start now
// lives and what it refuses; they do not execute the UI suite.
const IOS_LAUNCHER = 'scripts/ios-ui-session-acceptance.sh';
const IOS_SUITE = 'apps/ios/RelayiumUITests/LocalSessionUITests.swift';
const HELPER = 'requireResidentNearbyCounterpart';
const NEARBY_TESTS = ['testNearbyRosterNamesThePeerAndConnects',
  'testNearbyLinkTransfersThenDoneReturnsToACleanRoster'];
const CROSS_TEST = 'testCrossNetworkJoinsAMintedCodeAndOpensTheUnifiedWorkspace';

// The body of a Swift member: from its declaration to the next member or MARK
// at the same indentation.
function swiftBody(source, signature) {
  const parts = splitText(source, signature);
  if (parts.length !== 2) return null;
  const rest = parts[1];
  const ends = ['\n    func ', '\n    private func ', '\n    // MARK:', '\n    @discardableResult']
    .map(marker => rest.indexOf(marker)).filter(index => index >= 0);
  return ends.length ? rest.slice(0, Math.min(...ends)) : rest;
}

// Shell code with comment lines removed, so a comment describing the old start
// is not mistaken for one.
const shellCode = text => text.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');

function launcherProblems(text) {
  const code = shellCode(text);
  const problems = [];
  if (!containsText(code, 'start_peer local-link-peer local-link-peer')) problems.push('no local link peer is launched');
  if (!containsText(code, 'assert_control_api_is_guarded "$nearby_port"')) problems.push('the control API auth negatives are gone');
  if (!containsText(code, 'start_peer pair-link pair-link')) problems.push('the pairing peer is no longer launched');
  if (/control\s+"\$nearby_port"\s+POST\s+\/start/.test(code)) problems.push('the launcher starts Nearby residency itself');
  if (/\bPOST\s+\/start\b/.test(code)) problems.push('the launcher sends a /start');
  const xcodebuild = code.indexOf('xcodebuild -project');
  const idle = code.search(/if \[ "\$peer_phase" != "idle" \]; then\n\s*fail /);
  if (idle < 0) problems.push('the launcher no longer refuses a peer started before the UI run');
  else if (xcodebuild < 0 || idle > xcodebuild) problems.push('the idle guard does not precede xcodebuild');
  return problems;
}

function suiteProblems(text) {
  const problems = [];
  const helper = swiftBody(text, `private func ${HELPER}(_ harness: Harness) throws {`);
  if (!helper) return ['the residency helper is gone'];
  const need = (ok, why) => { if (!ok) problems.push(why); };
  need(containsText(helper, 'controlExchange(harness.nearbyPort, "POST", "/start")'), 'the helper no longer starts the Nearby port');
  need(splitText(helper, '"/start"').length === 2, 'the helper sends more than one /start');
  need(/case "idle":\s*\n\s*guard !Self\.nearbyStartRequested else \{\s*\n\s*throw /.test(helper), 'a start is no longer limited to the first idle answer');
  need(/Self\.nearbyStartRequested = true\s*\n\s*let started = controlExchange/.test(helper), 'the start is not recorded before it is sent');
  need(containsText(helper, 'guard started.status == 200, started.body?["ok"] as? Bool == true else {'), 'a refused /start (401/409/malformed) is accepted');
  need(/case "resident", "done":\s*\n\s*guard Self\.nearbyStartRequested else \{\s*\n\s*throw /.test(helper), 'a counterpart started elsewhere is reused');
  need(/case "failed":\s*\n\s*throw /.test(helper), 'a failed fixture is no longer refused at entry');
  need(/default:\s*\n\s*throw /.test(helper), 'an unknown phase is accepted');
  // Readiness: one 60s monotonic deadline taken after the /start answered,
  // every readiness request bounded by it; the entry /status and the /start
  // keep the ordinary caps. Elapsed behaviour is executed below, not read.
  need(containsText(text, 'private static let nearbyReadinessSeconds: TimeInterval = 60'), 'the readiness deadline is no longer 60s');
  const startGuard = helper.indexOf('guard started.status == 200');
  const deadlineAt = helper.indexOf('let deadline = NearbyReadinessDeadline(seconds: Self.nearbyReadinessSeconds)');
  need(deadlineAt >= 0, 'the readiness wait no longer takes one deadline of nearbyReadinessSeconds');
  need(splitText(helper, 'NearbyReadinessDeadline(').length === 2, 'the readiness wait does not take exactly one deadline');
  need(startGuard >= 0 && deadlineAt > startGuard, 'the readiness deadline starts before the /start has answered');
  need(containsText(helper, 'try pollUntilReady(deadline: deadline, interval: 0.5) {'), 'readiness is not polled under the deadline every 0.5s');
  need(!/for _ in 0\.\.</.test(helper) && !containsText(helper, 'Thread.sleep('), 'readiness has its own count-bounded loop or unbounded sleep again');
  need(containsText(helper, 'guard let status = try nearbyStatus(harness, within: deadline) else { return false }'), 'a readiness /status is not bounded by the deadline');
  need(containsText(helper, 'guard let entry = try nearbyStatus(harness, within: nil) else {'), 'the entry /status no longer keeps the ordinary caps');
  need(/let started = controlExchange\(harness\.nearbyPort, "POST", "\/start"\)\n/.test(helper), 'the /start is no longer sent with the ordinary caps');
  need(containsText(helper, 'if ready { return }'), 'readiness passes without a ready answer');
  need(/case "resident":\s*\n\s*try requireOwnAdvertisement\(last, harness\)\s*\n\s*return true/.test(helper), 'readiness passes without this run\'s own resident advertisement');
  need(!/case "done"/.test(helper.split('try pollUntilReady(')[1] ?? ''), 'readiness accepts a terminal phase it never waited through');
  const exchange = swiftBody(text, 'private func controlExchange(');
  need(exchange && containsText(exchange, 'awaitNearbyAnswer(within: deadline) { requestTimeout, deliver in')
    && containsText(exchange, 'URLRequest(url: url, timeoutInterval: requestTimeout)'), 'controlExchange does not take its caps from the shared clock');
  const status0 = swiftBody(text, 'private func nearbyStatus(');
  need(status0 && containsText(status0, 'controlExchange(harness.nearbyPort, "GET", "/status", within: deadline)')
    && containsText(status0, 'if let deadline, deadline.remaining == nil { return nil }'), '/status accepts an answer that landed after the deadline');
  const clock = readinessClock(text);
  need(clock !== null, 'the shared readiness clock block is gone');
  if (clock) {
    need(containsText(clock, 'let nearbyControlRequestCap: TimeInterval = 15') && containsText(clock, 'let nearbyControlAnswerCap: TimeInterval = 20'), 'the ordinary 15s request / 20s answer caps changed');
    need(containsText(clock, '    let end: DispatchTime\n') && containsText(clock, 'DispatchTime.now().uptimeNanoseconds') && !/\bDate\(|\bvar end\b/.test(clock), 'the deadline is no longer one immutable monotonic instant');
    // R140: every wait ends at an instant bounded by that original `end`, never
    // at a later `now` plus a `remaining` read earlier.
    need(containsText(clock, 'min(end, DispatchTime.now() + seconds)'), 'capped(_:) no longer bounds an instant by the original end');
    need(!/now\(\) \+ (left|limits\.answer|deadline\.remaining)\b/.test(clock.replace('?? DispatchTime.now() + limits.answer', '')),
      'a wait instant is built from a remaining duration read earlier, not from the original end');
    need(!containsText(clock, 'Thread.sleep(') && containsText(clock, 'nearbyPause(until: deadline.capped(interval))'),
      'the pause between polls no longer ends at an instant bounded by the original end');
    need(!/^import /m.test(clock), 'the shared clock imports beyond Foundation');
    const fixed = clock.indexOf('let answerBy = deadline?.capped(nearbyControlAnswerCap) ?? DispatchTime.now() + limits.answer');
    const sent = clock.indexOf('send(limits.request)');
    need(fixed >= 0 && sent > fixed && containsText(clock, 'done.wait(timeout: answerBy)'),
      'the answer wait is not one instant fixed before the request is sent');
  }
  need(splitText(helper, 'Self.nearbyStartRequested = false').length === 1, 'the helper resets its start record');
  const status = swiftBody(text, 'private func nearbyStatus(');
  need(status && containsText(status, 'guard answer.status == 200, let body = answer.body,'), '/status is read without requiring a well-formed 200');
  const own = swiftBody(text, 'private func requireOwnAdvertisement(');
  need(own && containsText(own, 'status.raw["peerName"] as? String == harness.peerName'), 'readiness no longer names this run\'s advertisement');
  need(own && containsText(own, 'status.raw["role"] as? String == Self.nearbyCounterpartRole'), 'readiness no longer checks the counterpart role');
  need(containsText(text, 'private static let nearbyCounterpartRole = "local-link-peer"'), 'the counterpart role changed');
  need(!/func requireHarness\(\)[\s\S]*?\n    \}\n/.exec(text)?.[0].includes(HELPER), 'requireHarness starts residency (control recursion, and Cross-network arms it)');
  for (const name of NEARBY_TESTS) {
    const body = swiftBody(text, `func ${name}() throws {`);
    if (!body) { problems.push(`${name} is gone`); continue; }
    const call = body.indexOf(`try ${HELPER}(harness)`);
    if (call < 0) { problems.push(`${name} no longer arms residency`); continue; }
    if (body.indexOf(`try ${HELPER}(harness)`, call + 1) >= 0) problems.push(`${name} arms residency twice`);
    const harness = body.indexOf('let harness = try requireHarness()');
    if (harness < 0 || harness > call) problems.push(`${name} arms residency before it has a harness`);
    for (const later of ['awaitIdleCounterpart(harness)', 'counterpartEpoch(harness)',
      'counterpartRoster(harness)', 'launch(harness']) {
      const at = body.indexOf(later);
      if (at < 0) problems.push(`${name} lost ${later}`);
      else if (at < call) problems.push(`${name} reads ${later} before residency is ready`);
    }
  }
  const cross = swiftBody(text, `func ${CROSS_TEST}() throws {`);
  need(cross && !cross.includes(HELPER), 'the Cross-network case arms Nearby residency');
  return problems;
}

test('R123: the launcher launches the Nearby peer but never starts its residency', () => {
  assert.deepEqual(launcherProblems(read(IOS_LAUNCHER)), []);
});

test('R123: each Nearby test arms residency before baselines or launch; Cross-network does not', () => {
  assert.deepEqual(suiteProblems(read(IOS_SUITE)), []);
});

test('R123 controls: each regression is caught for its stated reason', () => {
  const launcher = read(IOS_LAUNCHER);
  const suite = read(IOS_SUITE);
  const mutate = (text, from, to) => {
    const parts = splitText(text, from);
    assert.equal(parts.length, 2, `control anchor not unique: ${from}`);
    return parts.join(to);
  };
  const controls = [
    ['launcher', 'original prebuild start restored',
      mutate(launcher, 'maybe_fault after-ios-peers', 'control "$nearby_port" POST /start >/dev/null\nmaybe_fault after-ios-peers'),
      /the launcher starts Nearby residency itself/],
    ['launcher', 'idle guard removed',
      mutate(launcher, 'if [ "$peer_phase" != "idle" ]; then', 'if false; then'),
      /refuses a peer started before the UI run/],
    ['launcher', 'auth negatives removed',
      mutate(launcher, 'assert_control_api_is_guarded "$nearby_port"', 'true'),
      /auth negatives are gone/],
    ['suite', 'helper call removed from the roster test',
      mutate(suite, `    func ${NEARBY_TESTS[0]}() throws {\n        let harness = try requireHarness()\n        // Armed here, by this test, before any baseline is read or the app is\n        // launched — see \`${HELPER}\`.\n        try ${HELPER}(harness)\n`,
        `    func ${NEARBY_TESTS[0]}() throws {\n        let harness = try requireHarness()\n`),
      /testNearbyRosterNamesThePeerAndConnects no longer arms residency/],
    ['suite', 'helper call moved after the baseline in the transfer test',
      mutate(suite,
        `launched — see \`${HELPER}\`.\n        try ${HELPER}(harness)\n        awaitIdleCounterpart(harness)\n        let baseline = counterpartEpoch(harness)\n        let knownPeers = counterpartRoster(harness)\n        launch(harness, verifying: true,`,
        `launched — see \`${HELPER}\`.\n        awaitIdleCounterpart(harness)\n        let baseline = counterpartEpoch(harness)\n        try ${HELPER}(harness)\n        let knownPeers = counterpartRoster(harness)\n        launch(harness, verifying: true,`),
      /testNearbyLinkTransfersThenDoneReturnsToACleanRoster reads (awaitIdleCounterpart|counterpartEpoch)/],
    ['suite', 'Cross-network arms Nearby',
      mutate(suite, `    func ${CROSS_TEST}() throws {\n        let harness = try requireHarness()\n`,
        `    func ${CROSS_TEST}() throws {\n        let harness = try requireHarness()\n        try ${HELPER}(harness)\n`),
      /the Cross-network case arms Nearby residency/],
    ['suite', 'repeated start after a failure (failed restarts)',
      mutate(suite, '        case "failed":\n            throw NearbyFixtureRefusal(description: """\n                the Nearby counterpart has failed and is not restarted.',
        '        case "failed":\n            Self.nearbyStartRequested = false\n            throw NearbyFixtureRefusal(description: """\n                the Nearby counterpart has failed and is not restarted.'),
      /resets its start record|failed fixture is no longer refused/],
    ['suite', 'second start permitted from idle',
      mutate(suite, '        case "idle":\n            guard !Self.nearbyStartRequested else {', '        case "idle":\n            guard true else {'),
      /limited to the first idle answer/],
    ['suite', 'auth/409 failure of /start accepted',
      mutate(suite, 'guard started.status == 200, started.body?["ok"] as? Bool == true else {', 'guard started.status != nil else {'),
      /a refused \/start \(401\/409\/malformed\) is accepted/],
    ['suite', '/status accepted without a 200',
      mutate(suite, 'guard answer.status == 200, let body = answer.body,', 'guard let body = answer.body,'),
      /\/status is read without requiring a well-formed 200/],
    ['suite', 'readiness bypassed (any answer passes)',
      mutate(suite, '            case "resident":\n                try requireOwnAdvertisement(last, harness)\n                return true',
        '            case "resident":\n                return true'),
      /readiness passes without this run's own resident advertisement/],
    ['suite', 'readiness accepts unrelated peer name',
      mutate(suite, 'status.raw["peerName"] as? String == harness.peerName', 'status.raw["peerName"] != nil'),
      /no longer names this run's advertisement/],
    ['suite', 'readiness deadline grown',
      mutate(suite, 'nearbyReadinessSeconds: TimeInterval = 60', 'nearbyReadinessSeconds: TimeInterval = 120'),
      /no longer 60s/],
    ['suite', 'readiness /status not bounded by the deadline',
      mutate(suite, 'try nearbyStatus(harness, within: deadline) else { return false }', 'try nearbyStatus(harness, within: nil) else { return false }'),
      /readiness \/status is not bounded/],
    ['suite', 'deadline taken before the /start',
      mutate(mutate(suite, '        let deadline = NearbyReadinessDeadline(seconds: Self.nearbyReadinessSeconds)\n', ''),
        '        switch entry.phase {\n        case "idle":', '        let deadline = NearbyReadinessDeadline(seconds: Self.nearbyReadinessSeconds)\n        switch entry.phase {\n        case "idle":'),
      /starts before the \/start has answered/],
    ['suite', 'original count-bounded loop restored around the readiness poll',
      mutate(suite, 'let ready = try pollUntilReady(deadline: deadline, interval: 0.5) {', 'var ready = false\n        for _ in 0..<120 { Thread.sleep(forTimeInterval: 0.5) }\n        ready = try pollUntilReady(deadline: deadline, interval: 0.5) {'),
      /count-bounded loop/],
    ['suite', 'late /status answer accepted',
      mutate(suite, '        if let deadline, deadline.remaining == nil { return nil }\n        guard answer.status == 200', '        guard answer.status == 200'),
      /landed after the deadline/],
    ['suite', 'ordinary answer cap raised',
      mutate(suite, 'let nearbyControlAnswerCap: TimeInterval = 20', 'let nearbyControlAnswerCap: TimeInterval = 40'),
      /15s request \/ 20s answer caps changed/],
    ['suite', 'wall-clock deadline',
      mutate(suite, 'DispatchTime.now().uptimeNanoseconds + UInt64', 'UInt64(Date().timeIntervalSince1970 * 1e9) + UInt64'),
      /immutable monotonic instant/],
    ['suite', 'answer wait restarted after the send returns',
      mutate(suite, 'done.wait(timeout: answerBy)', 'done.wait(timeout: .now() + limits.answer)'),
      /one instant fixed before the request is sent/],
    ['suite', 'answer instant from a stale remaining (R136)',
      mutate(suite, 'let answerBy = deadline?.capped(nearbyControlAnswerCap) ?? DispatchTime.now() + limits.answer', 'let answerBy = DispatchTime.now() + limits.answer'),
      /built from a remaining duration read earlier/],
    ['suite', 'pause from a stale remaining (R140)',
      mutate(suite, 'nearbyPause(until: deadline.capped(interval))', 'Thread.sleep(forTimeInterval: min(interval, deadline.remaining ?? 0))'),
      /pause between polls no longer ends at an instant bounded by the original end/],
  ];
  for (const [which, name, text, expected] of controls) {
    const problems = which === 'launcher' ? launcherProblems(text) : suiteProblems(text);
    assert.ok(problems.some(problem => expected.test(problem)),
      `control "${name}" was not caught for its reason; problems: ${JSON.stringify(problems)}`);
  }
  assert.equal(controls.length, 22);
});

// ── R126: the readiness wait is bounded by elapsed time, executed ──────────────
//
// Compiles the suite's own `BEGIN/END nearby-readiness-clock` lines — the code
// the UI test runs — with a fake counterpart that answers slowly or never, and
// measures wall time. A count of polls proves nothing about seconds: 120 polls
// of a 15s request / 20s wait are 40 minutes, not 60 seconds.
function readinessClock(text) {
  const parts = splitText(text, '// BEGIN nearby-readiness-clock\n');
  if (parts.length !== 2) return null;
  const body = splitText(parts[1], '// END nearby-readiness-clock\n');
  return body.length === 2 ? body[0] : null;
}

// Each scenario prints RUN before it starts, so a mutant that hangs is caught
// in the scenario it hangs in. Short deadlines stand in for the 60s one: the
// shipped 15s/20s caps dwarf them, which is the point.
const CLOCK_DRIVER = String.raw`
import Foundation
var failures = 0
func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }
func run(_ name: String, _ body: () -> String?) {
  print("RUN \(name)"); fflush(stdout)
  if let why = body() { failures += 1; print("FAIL \(name): \(why)") } else { print("PASS \(name)") }
  fflush(stdout)
}
let only = CommandLine.arguments.dropFirst().first
func scenario(_ name: String, _ body: () -> String?) { if only == nil || only == name { run(name, body) } }
struct Refused: Error {}
// R140: the preemption builds insert a call to this into the shipped clock at
// one exact point (see PREEMPTIONS); the plain build never calls it.
var injectedPauses = 0
func nearbyInjectedPause() { injectedPauses += 1; Thread.sleep(forTimeInterval: 0.25) }

scenario("silent-counterpart") {
  // Never answers: every request would wait its full 20s without the deadline.
  let t0 = now(), deadline = NearbyReadinessDeadline(seconds: 1.0)
  var polls = 0
  let ready = pollUntilReady(deadline: deadline, interval: 0.5) {
    polls += 1
    let answer: Bool? = awaitNearbyAnswer(within: deadline) { _, _ in }
    return answer ?? false
  }
  let elapsed = now() - t0
  if ready { return "a silent counterpart was ready" }
  if elapsed > 1.35 || elapsed < 0.95 { return "elapsed \(elapsed)s for a 1.0s deadline (\(polls) polls)" }
  return nil
}
scenario("slow-answer") {
  // Answers 'ready' after 0.6s; only 0.2s are left.
  let t0 = now(), deadline = NearbyReadinessDeadline(seconds: 0.2)
  var timeout = -1.0
  let answer: Bool? = awaitNearbyAnswer(within: deadline) { requestTimeout, deliver in
    timeout = requestTimeout
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.6) { deliver(true) }
  }
  let elapsed = now() - t0
  if answer != nil { return "an answer after the deadline was returned" }
  if elapsed > 0.35 { return "the answer wait ran \(elapsed)s past a 0.2s deadline" }
  if timeout <= 0 || timeout > 0.2 { return "request timeout \(timeout)s not cut to the 0.2s left" }
  return nil
}
scenario("late-answer") {
  // The answer is delivered, but only after the deadline passed.
  let deadline = NearbyReadinessDeadline(seconds: 0.2)
  let answer: Bool? = awaitNearbyAnswer(within: deadline) { _, deliver in
    Thread.sleep(forTimeInterval: 0.4); deliver(true)
  }
  return answer == nil ? nil : "a success delivered after the deadline was accepted"
}
scenario("late-ready") {
  let deadline = NearbyReadinessDeadline(seconds: 0.2)
  let ready = pollUntilReady(deadline: deadline, interval: 0.5) { Thread.sleep(forTimeInterval: 0.4); return true }
  return ready ? "a ready answer returned after the deadline was accepted" : nil
}
scenario("pause-cut") {
  let t0 = now(), deadline = NearbyReadinessDeadline(seconds: 0.7)
  let ready = pollUntilReady(deadline: deadline, interval: 0.5) { false }
  let elapsed = now() - t0
  if ready { return "never-ready was ready" }
  return elapsed > 0.85 ? "pauses ran \(elapsed)s past a 0.7s deadline" : nil
}
scenario("ready-in-time") {
  var polls = 0
  let ready = pollUntilReady(deadline: NearbyReadinessDeadline(seconds: 2), interval: 0.05) { polls += 1; return polls == 3 }
  return ready && polls == 3 ? nil : "ready=\(ready) after \(polls) polls"
}
scenario("refusal-propagates") {
  do {
    _ = try pollUntilReady(deadline: NearbyReadinessDeadline(seconds: 2), interval: 0.05) { throw Refused() }
    return "a refusal was swallowed"
  } catch { return error is Refused ? nil : "wrong error \(error)" }
}
scenario("caps") {
  guard let plain = nearbyControlLimits(within: nil), plain == (15, 20) else { return "ordinary caps are not 15s/20s" }
  guard let far = nearbyControlLimits(within: NearbyReadinessDeadline(seconds: 100)), far == (15, 20) else { return "a long deadline raised the caps" }
  guard let near = nearbyControlLimits(within: NearbyReadinessDeadline(seconds: 1)), near.request <= 1, near.answer <= 1, near.request > 0.5 else { return "caps not cut to a 1s deadline" }
  let spent = NearbyReadinessDeadline(seconds: 0)
  if nearbyControlLimits(within: spent) != nil { return "a spent deadline still allowed a request" }
  var sent = false
  let answer: Bool? = awaitNearbyAnswer(within: spent) { _, deliver in sent = true; deliver(true) }
  if sent || answer != nil { return "a request was sent after the deadline" }
  var plainTimeout = -1.0
  let ordinary: Int? = awaitNearbyAnswer(within: nil) { requestTimeout, deliver in
    plainTimeout = requestTimeout
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { deliver(7) }
  }
  if ordinary != 7 || plainTimeout != 15 { return "no-deadline exchange answered \(String(describing: ordinary)) with timeout \(plainTimeout)" }
  guard let left = NearbyReadinessDeadline(seconds: 60).remaining, left > 59, left <= 60 else { return "a 60s deadline does not start with 60s left" }
  return nil
}
scenario("send-time") {
  // R133: the send itself takes time. The answer wait must end where it would
  // have without that time, not start over when the send returns.
  var sendReturned = 0.0
  var t0 = now(), deadline = NearbyReadinessDeadline(seconds: 0.4)
  var answer: Bool? = awaitNearbyAnswer(within: deadline) { _, _ in
    Thread.sleep(forTimeInterval: 0.3); sendReturned = now()
  }
  var after = now() - sendReturned, elapsed = now() - t0
  if answer != nil { return "a send that never delivered answered" }
  if after > 0.25 || elapsed > 0.55 {
    return "waited \(after)s after a 0.3s send (\(elapsed)s in all) for a 0.4s deadline"
  }
  // A send that overruns the whole deadline gets no wait at all after it.
  t0 = now(); deadline = NearbyReadinessDeadline(seconds: 0.4)
  answer = awaitNearbyAnswer(within: deadline) { _, _ in
    Thread.sleep(forTimeInterval: 0.5); sendReturned = now()
  }
  after = now() - sendReturned; elapsed = now() - t0
  if answer != nil { return "an overrunning send answered" }
  if after > 0.15 || elapsed > 0.65 {
    return "waited \(after)s more after a send that overran the 0.4s deadline (\(elapsed)s in all)"
  }
  // A slow send whose answer still lands in time is still accepted.
  answer = awaitNearbyAnswer(within: NearbyReadinessDeadline(seconds: 1.0)) { _, deliver in
    Thread.sleep(forTimeInterval: 0.2)
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { deliver(true) }
  }
  return answer == true ? nil : "an in-time answer after a slow send was lost: \(String(describing: answer))"
}
// R136/R140: a scheduler pause of 0.25s lands AFTER the time left was read and
// BEFORE the wait's end instant is formed. The wait must still end at the
// deadline's original instant (0.3s), not 0.25s + 0.3s later. Selected by name
// only, and only meaningful in the build that injects the pause.
func preempted(_ name: String, _ body: () -> String?) {
  guard only == name else { return }
  run(name) {
    if let why = body() { return why }
    return injectedPauses > 0 ? nil : "no scheduler pause was injected; the preemption point is not exercised"
  }
}
preempted("answer-preempted") {
  let t0 = now(), deadline = NearbyReadinessDeadline(seconds: 0.3)
  let answer: Bool? = awaitNearbyAnswer(within: deadline) { _, _ in }
  let elapsed = now() - t0
  if answer != nil { return "a send that never delivered answered" }
  return elapsed > 0.42 ? "the answer wait ended \(elapsed)s after start, past the original 0.3s deadline" : nil
}
preempted("pause-preempted") {
  let t0 = now(), deadline = NearbyReadinessDeadline(seconds: 0.3)
  let ready = pollUntilReady(deadline: deadline, interval: 0.5) { false }
  let elapsed = now() - t0
  if ready { return "never-ready was ready" }
  return elapsed > 0.42 ? "the pause ended \(elapsed)s after start, past the original 0.3s deadline" : nil
}
print(failures == 0 ? "ALL PASS" : "FAILURES \(failures)")
exit(failures == 0 ? 0 : 1)
`;

// The clock tests are the only executed proof of the readiness bound, and
// repository-policy runs this file on Linux. Under CI a missing compiler is a
// failure, never a skip; only a local run without one may skip, visibly.
const SWIFTC_PROBE = spawnSync('swiftc', ['--version'], { encoding: 'utf8' });
const swiftc = SWIFTC_PROBE.status === 0;
const underCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const CLOCK_SKIP = !swiftc && !underCI && 'swiftc is not on PATH (local run only; CI requires it)';
function requireSwiftc() {
  assert.ok(swiftc, `swiftc is required under CI to execute the readiness clock tests, and it is unavailable `
    + `(${SWIFTC_PROBE.error?.code ?? `exit ${SWIFTC_PROBE.status}`}); a skip here would leave the bound unproved`);
}

// Builds run concurrently (repository-policy has a 5-minute job budget); the
// timed runs stay strictly one at a time so build load cannot skew them.
async function buildClocks(clocks, dir) {
  return Promise.all(clocks.map((clock, index) => new Promise((resolve, reject) => {
    const sub = join(dir, String(index));
    mkdirSync(sub);
    writeFileSync(join(sub, 'clock.swift'), `import Foundation\n${clock}`);
    writeFileSync(join(sub, 'main.swift'), CLOCK_DRIVER);
    const exe = join(sub, 'clock');
    execFile('swiftc', ['-Onone', '-swift-version', '5', join(sub, 'clock.swift'), join(sub, 'main.swift'), '-o', exe],
      { encoding: 'utf8', timeout: 240_000 }, (error, _stdout, stderr) =>
        error ? reject(new Error(`the shared clock did not compile: ${stderr || error.message}`)) : resolve(exe));
  })));
}

// All scenarios together take about 4s; one hung scenario is killed well
// before the 20s answer cap it would otherwise wait out.
function runClock(exe, scenario) {
  const out = spawnSync(exe, scenario ? [scenario] : [], { encoding: 'utf8', timeout: scenario ? 8_000 : 15_000 });
  return { status: out.status, signal: out.signal, stdout: out.stdout ?? '' };
}

// R140: where a scheduler pause is injected into the shipped clock text — right
// after the time left was read, before the wait's end instant is formed.
const PREEMPTIONS = {
  'answer-preempted': '    guard let limits = nearbyControlLimits(within: deadline) else { return nil }\n',
  'pause-preempted': '        if ready { return true }\n',
};
function preempt(clock, scenario) {
  const anchor = PREEMPTIONS[scenario];
  const parts = splitText(clock, anchor);
  assert.equal(parts.length, 2, `preemption anchor not unique: ${anchor}`);
  return parts.join(`${anchor}nearbyInjectedPause()\n`);
}

test('R126: the shipped readiness clock bounds elapsed time, not poll count', { skip: CLOCK_SKIP }, async () => {
  requireSwiftc();
  const clock = readinessClock(read(IOS_SUITE));
  assert.ok(clock, 'the suite lost its BEGIN/END nearby-readiness-clock block');
  const dir = mkdtempSync(join(tmpdir(), 'r126-clock-'));
  try {
    const preempted = Object.keys(PREEMPTIONS);
    const [exe, ...preemptedExes] = await buildClocks([clock, ...preempted.map(name => preempt(clock, name))], dir);
    const out = runClock(exe, null);
    assert.equal(out.status, 0, out.stdout);
    for (const name of ['silent-counterpart', 'slow-answer', 'late-answer', 'late-ready', 'pause-cut',
      'ready-in-time', 'refusal-propagates', 'caps', 'send-time']) {
      assert.ok(out.stdout.includes(`PASS ${name}\n`), `${name} did not pass: ${out.stdout}`);
    }
    // R140: the shipped clock with a scheduler pause injected at each point.
    for (const [index, name] of preempted.entries()) {
      const run = runClock(preemptedExes[index], name);
      assert.equal(run.status, 0, run.stdout);
      assert.ok(run.stdout.includes(`PASS ${name}\n`), `${name} did not pass: ${run.stdout}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R126 controls: each clock regression fails its own executed scenario', { skip: CLOCK_SKIP }, async () => {
  requireSwiftc();
  const clock = readinessClock(read(IOS_SUITE));
  assert.ok(clock);
  const mutate = (from, to) => {
    const parts = splitText(clock, from);
    assert.equal(parts.length, 2, `control anchor not unique: ${from}`);
    return parts.join(to);
  };
  const controls = [
    ['request caps ignore the deadline (each request may take 15s/20s)',
      mutate('return (min(nearbyControlRequestCap, left), min(nearbyControlAnswerCap, left))', 'return (nearbyControlRequestCap, nearbyControlAnswerCap)'),
      // Since R140 the answer wait is bounded by the deadline's own `end`, so
      // this no longer lengthens any wait; what it still breaks is the
      // request timeout handed to URLRequest, which slow-answer reads.
      'slow-answer'],
    ['answer cap not cut to the deadline (the wait itself is bounded by end since R140)',
      mutate('min(nearbyControlAnswerCap, left))', 'nearbyControlAnswerCap)'), 'caps'],
    ['late exchange success accepted', mutate('    if let deadline, deadline.remaining == nil { return nil }\n', ''), 'late-answer'],
    ['late ready poll accepted',
      mutate('        guard deadline.remaining != nil else { return false }\n        if ready { return true }\n',
        '        if ready { return true }\n        guard deadline.remaining != nil else { return false }\n'),
      'late-ready'],
    ['pause not cut to the deadline', mutate('nearbyPause(until: deadline.capped(interval))', 'Thread.sleep(forTimeInterval: interval)'), 'pause-cut'],
    ['original count-bounded readiness (120 polls x 0.5s, no clock)',
      mutate(`    while deadline.remaining != nil {
        let ready = try poll()
        guard deadline.remaining != nil else { return false }
        if ready { return true }
        nearbyPause(until: deadline.capped(interval))
    }`, `    for _ in 0..<120 {
        if try poll() { return true }
        Thread.sleep(forTimeInterval: interval)
    }`),
      'late-ready'],
    ['a deadline raises the caps', mutate('min(nearbyControlAnswerCap, left)', 'max(nearbyControlAnswerCap, left)'), 'caps'],
    ['R126 relative answer wait restarted after the send (R133)',
      mutate('guard done.wait(timeout: answerBy) == .success', 'guard done.wait(timeout: .now() + limits.answer) == .success'),
      'send-time'],
    // R136/R140: the answer instant / pause end formed from a remaining read
    // before the injected scheduler pause, i.e. relative to a later now.
    ['answer instant = later now + earlier remaining (R136 root reproduction)',
      preempt(mutate('let answerBy = deadline?.capped(nearbyControlAnswerCap) ?? DispatchTime.now() + limits.answer',
        'let answerBy = DispatchTime.now() + limits.answer'), 'answer-preempted'),
      'answer-preempted'],
    ['pause = earlier remaining slept from a later now (R140)',
      preempt(mutate(`        guard deadline.remaining != nil else { return false }
        if ready { return true }
        nearbyPause(until: deadline.capped(interval))`, `        guard let left = deadline.remaining else { return false }
        if ready { return true }
        Thread.sleep(forTimeInterval: min(interval, left))`), 'pause-preempted'),
      'pause-preempted'],
  ];
  const dir = mkdtempSync(join(tmpdir(), 'r126-clock-controls-'));
  try {
    const exes = await buildClocks(controls.map(([, mutant]) => mutant), dir);
    const uncaught = [];
    for (const [index, [name, , scenario]] of controls.entries()) {
      const out = runClock(exes[index], scenario);
      const caught = out.stdout.includes(`FAIL ${scenario}:`)
        || (out.signal && out.stdout.trimEnd().endsWith(`RUN ${scenario}`));
      if (!caught || out.status === 0) uncaught.push(`control "${name}" was not caught by ${scenario}: ${JSON.stringify(out)}`);
    }
    assert.deepEqual(uncaught, []);
    assert.equal(controls.length, 10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// R134: runs this file again with no compiler on PATH. Under CI it must fail
// both clock tests for the missing compiler and nothing else; locally it skips
// exactly those two. The child is told not to recurse into this test.
test('R134 control: a missing swiftc fails the clock tests under CI and only skips them locally',
  { skip: process.env.RELAYIUM_CLOCK_CHILD === '1' && 'child run' }, () => {
    const empty = mkdtempSync(join(tmpdir(), 'r134-no-swiftc-'));
    const run = ci => {
      const env = { ...process.env, PATH: empty, RELAYIUM_CLOCK_CHILD: '1' };
      delete env.CI; delete env.GITHUB_ACTIONS;
      if (ci) env[ci] = 'true';
      const out = spawnSync(process.execPath, ['--test-reporter=tap', new URL(import.meta.url).pathname],
        { encoding: 'utf8', env, timeout: 120_000 });
      const count = key => Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(out.stdout)?.[1]);
      return { status: out.status, stdout: out.stdout, tests: count('tests'), pass: count('pass'),
        fail: count('fail'), skipped: count('skipped') };
    };
    try {
      for (const ci of ['CI', 'GITHUB_ACTIONS']) {
        const out = run(ci);
        assert.notEqual(out.status, 0, `${ci}=true without swiftc passed: ${out.stdout}`);
        assert.equal(out.fail, 2, `${ci}=true: expected exactly the two clock tests to fail: ${out.stdout}`);
        assert.equal(out.skipped, 1, `${ci}=true: only the child-run guard may skip: ${out.stdout}`);
        assert.equal(out.pass, out.tests - 3, `${ci}=true: another test was affected: ${out.stdout}`);
        assert.equal(splitText(out.stdout, 'swiftc is required under CI to execute the readiness clock tests').length - 1 >= 2, true,
          `${ci}=true: the failures do not name the missing compiler: ${out.stdout}`);
        assert.match(out.stdout, /not ok \d+ - R126: the shipped readiness clock bounds elapsed time/);
        assert.match(out.stdout, /not ok \d+ - R126 controls: each clock regression fails its own executed scenario/);
      }
      const local = run(null);
      assert.equal(local.status, 0, `a local run without swiftc failed: ${local.stdout}`);
      assert.equal(local.fail, 0, local.stdout);
      assert.equal(local.skipped, 3, `a local run must skip exactly the two clock tests (plus this guard): ${local.stdout}`);
      assert.match(local.stdout, /# SKIP swiftc is not on PATH \(local run only; CI requires it\)/);
      assert.equal(local.pass, local.tests - 3, local.stdout);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
