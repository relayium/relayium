#!/usr/bin/env node
// web/scripts/gen-link-session-vectors.mjs — the cross-language link-session
// STATE-MACHINE vectors (W-N18 A08e).
//
//   node scripts/gen-link-session-vectors.mjs   # run from web/
//
// ## What this fixture is, and what it is not
//
// `realtime-wire-vectors.json` proves BYTES: a frame each implementation seals
// is the frame the others open. It cannot prove ORDER — consent before content,
// glare, the drain after a cancel, what a consent expiry may and may not send,
// what an END owes. Those are behaviours of the lane machines, and four
// implementations have one each (the Web's `mixed-file-session` /
// `mixed-text-session`, the Go CLI's `internal/linksession`, Android's
// `:protocol` `FileLaneSession` / `TextLaneSession`, and RelayiumKit).
//
// This fixture is a list of abstract SCENARIOS. Every consumer drives its REAL
// lane machine — never a re-implementation — against a scripted peer that seals
// its frames with that consumer's own shipped codecs, advances a fake clock for
// the timer steps, and compares what its machine put on the lane (as abstract
// tokens) and the abstract state it is in after every step. Frame bytes are
// never written here: the codecs are already pinned by the wire vectors.
//
// ## Who the authority is
//
// The Web. `link-v1` was written from it, and every expectation below was
// checked against Web SOURCE, not copied from the Go prototype's draft
// (`link-session-vectors.draft.json`, private design input). Where the draft
// and the Web disagreed, the disagreement is resolved in the scenario's
// `resolution` note with the Web file that decided it.
//
// Where a consumer knowingly behaves differently, the main expectation still
// says what the protocol requires, and the consumer's behaviour is recorded as
// a `divergence` — with the step, the consumer's actual expectation and a
// tracked follow-up. A divergence is ASSERTED, not skipped: the consumer must
// still match its recorded divergent behaviour, so fixing the consumer turns
// the vector red until the entry is removed. Nothing is hidden by editing the
// main expectation to match a consumer.
//
// ## This generator is the only author
//
// Every value is a literal below; nothing is read, randomised or timestamped, so
// two runs are byte-identical and `check-wire-vectors.mjs` can gate it. The
// Web half of the claim — that the Web implementation actually behaves as
// written — is `web/src/lib/link-session-vectors.test.ts`, which this gate
// cannot replace and which cannot replace this gate.

import { writeFileSync } from "node:fs";

const OUT = "../apps/RelayiumKit/Tests/Fixtures/link-session-vectors.json";

/** One step. `auto` names consumers whose machine performs this step on its
 *  own as part of the PREVIOUS step (see `stepSemantics`). */
const step = (doWhat, emit, state, extra = {}) => ({ do: doWhat, ...extra, expect: { emit, state } });

const ALL = ["web", "go", "kotlin"];
const NO_KOTLIN_ADAPTER = "the arbitration/timer this scenario exercises lives in the Android app "
  + "module's TransferController, not in :protocol; driving it from the :protocol test would mean "
  + "re-implementing the adapter";

// ── follow-ups, named once so every divergence cites the same tracked item ───
const FOLLOW_UP = {
  webPromptReject: "A08-DESIGN §6.5/§15.2: Web mixed-file-session prompt-phase consent timeout "
    + "calls rejectInbound (sends REJECT); only the picking phase withholds. Web task: withhold at "
    + "the prompt too (enter an expired state and wait for the sender's BATCH_ABORT).",
  goFinalAck: "A08e-D2: Go linksession FileDurable emits an ACK when durable == batch total, "
    + "below the 512 KiB interval; Web and Android ACK only on the interval. Benign (the sender "
    + "clamps it) but a wire difference: decide in Codex review whether Go drops it or link-v1 §9.1 "
    + "allows it.",
  goReplayDelay: "A08e-D3: Go linksession re-offers a glare-yielded batch the instant the lane is "
    + "Idle; the Web responder waits MIXED_FILE_REPLAY_DELAY_MS (250 ms) before replaying. Decide in "
    + "Codex review whether the CLI should adopt the delay.",
  kotlinRejectAbort: "A08e-D4: Android FileLaneSession answers a peer REJECT or BUSY received while "
    + "waiting for consent with its own BATCH_ABORT; the Web sends nothing (REJECT before ACCEPT is "
    + "itself the complete barrier). Benign at a Web/Go receiver (an abort with no inbound batch is "
    + "a no-op) — Android task to align, or link-v1 to permit it explicitly.",
  kotlinBusyRequeue: "A08e-D5: after a peer BUSY, Android :protocol retires the batch as a failure "
    + "(requeue, if any, is the app adapter's); the Web and Go requeue it once and re-offer. Android "
    + "task: confirm TransferController requeues exactly once.",
  kotlinIntegrity: "A08e-D6: Android FileLaneSession treats a DONE digest mismatch as a LANE "
    + "failure with no REJECT; the Web and Go send REJECT, drain to the sender's BATCH_ABORT and keep "
    + "the lane reusable. Android task (file lane recovers from one corrupt batch).",
  appleFirstHello: "A08-DESIGN §3.1/§15.1: link-v1 §1.3/§12.3 say Apple's first hello is on the "
    + "1.5 s tick; the pairing-room source (LinkCapabilityAnnouncer.rosterChanged) announces "
    + "immediately. Doc correction task; Swift is not a consumer of this fixture yet.",
};

// ── bounds the timer steps advance by (milliseconds) ────────────────────────
// Each is the Web constant named beside it; every consumer maps the key onto
// its own constant and a consumer whose constant differs fails loudly.
const BOUNDS = {
  fileConsent: 600_000, // MIXED_FILE_CONSENT_TIMEOUT_MS
  fileDrain: 30_000, // MIXED_FILE_DRAIN_TIMEOUT_MS
  fileReplay: 250, // MIXED_FILE_REPLAY_DELAY_MS (responder-side glare replay)
  textConsent: 600_000, // MIXED_TEXT_CONSENT_TIMEOUT_MS
  textEndAck: 30_000, // MIXED_TEXT_END_ACK_TIMEOUT_MS
  helloInterval: 1_500, // LINK_CAPS_RETRY_INTERVAL_MS
};

// ── file lane ────────────────────────────────────────────────────────────────
// One batch = one file of 5 bytes ("hello"), one logical chunk, one DONE.
const receiveFrom = (prefixState = "InRecv") => [
  step("peer:manifest", [], "InPrompt"),
  step("local:accept", ["ACCEPT"], prefixState),
];

const fileScenarios = [
  {
    name: "file.receive.accept-and-complete",
    role: "responder",
    source: "web: mixed-file-session.svelte.ts acceptInbound → handleInboundOutput (COMPLETE after the last verified DONE)",
    consumers: ALL,
    steps: [
      ...receiveFrom(),
      step("peer:content", [], "InRecv"),
      step("local:durable", [], "InRecv", { auto: ["web"] }),
      step("peer:done", [], "InRecv"),
      step("local:commit", ["COMPLETE"], "Idle", { auto: ["web", "go"] }),
    ],
    divergences: [
      { consumer: "go", step: 3, expect: { emit: ["ACK"], state: "InRecv" }, followUp: FOLLOW_UP.goFinalAck },
    ],
  },
  {
    name: "file.send.offer-accept-complete",
    role: "initiator",
    source: "web: mixed-file-session.svelte.ts runOutbound",
    consumers: ALL,
    steps: [
      step("local:offer", ["MANIFEST"], "OutWait"),
      step("peer:ACCEPT", [], "OutSend"),
      step("local:send-all", ["CHUNK", "DONE"], "OutFinish", { auto: ["web"] }),
      step("peer:COMPLETE", [], "Idle"),
    ],
  },
  {
    name: "file.glare.initiator-keeps",
    role: "initiator",
    source: "draft:file.glare.initiator-keeps; web: onManifest (initiator answers FILE_BUSY)",
    consumers: ["web", "go"],
    skip: { kotlin: NO_KOTLIN_ADAPTER },
    steps: [
      step("local:offer", ["MANIFEST"], "OutWait"),
      step("peer:manifest", ["BUSY"], "OutWait"),
      step("peer:BATCH_ABORT", [], "OutWait"),
      step("peer:ACCEPT", [], "OutSend"),
      step("local:send-all", ["CHUNK", "DONE"], "OutFinish", { auto: ["web"] }),
      step("peer:COMPLETE", [], "Idle"),
    ],
  },
  {
    name: "file.glare.responder-yields",
    role: "responder",
    source: "draft:file.glare.responder-yields; web: onManifest yield → runOutbound BATCH_ABORT → requeueOrFail → pump (replay after MIXED_FILE_REPLAY_DELAY_MS)",
    resolution: "The draft's last step was a LOCAL offer. In the Web the yielded batch is requeued "
      + "once and replayed by the lane itself after 250 ms (responder only), so the step is the "
      + "replay timer, not a user action.",
    consumers: ["web", "go"],
    skip: { kotlin: NO_KOTLIN_ADAPTER },
    steps: [
      step("local:offer", ["MANIFEST"], "OutWait"),
      step("peer:manifest", ["BATCH_ABORT"], "InPrompt"),
      step("peer:BUSY", [], "InPrompt"),
      step("local:accept", ["ACCEPT"], "InRecv"),
      step("peer:content", [], "InRecv"),
      step("local:durable", [], "InRecv", { auto: ["web"] }),
      step("peer:done", [], "InRecv"),
      step("local:commit", ["COMPLETE"], "Idle", { auto: ["web", "go"] }),
      step("timer:fileReplay", ["MANIFEST"], "OutWait"),
    ],
    divergences: [
      { consumer: "go", step: 5, expect: { emit: ["ACK"], state: "InRecv" }, followUp: FOLLOW_UP.goFinalAck },
      // Go's step 6 absorbs step 7 (auto), so this is the merged expectation.
      { consumer: "go", step: 6, expect: { emit: ["COMPLETE", "MANIFEST"], state: "OutWait" }, followUp: FOLLOW_UP.goReplayDelay },
      { consumer: "go", step: 8, expect: { emit: [], state: "OutWait" }, followUp: FOLLOW_UP.goReplayDelay },
    ],
  },
  {
    name: "file.cancel.crossing",
    role: "responder",
    source: "draft:file.cancel.crossing; web: cancel(\"recv\") → beginDrain → queueAbort",
    consumers: ALL,
    steps: [
      ...receiveFrom(),
      step("local:cancel-in", ["REJECT"], "InDrain"),
      step("peer:content", [], "InDrain"),
      step("peer:done", [], "InDrain"),
      step("peer:BATCH_ABORT", [], "Idle"),
      step("peer:manifest", [], "InPrompt"),
    ],
  },
  {
    name: "file.consent-expired.no-answer",
    role: "responder",
    source: "draft:file.consent-expired.no-answer; A08-DESIGN §6.5",
    consumers: ["web", "go"],
    skip: { kotlin: NO_KOTLIN_ADAPTER },
    steps: [
      step("peer:manifest", [], "InPrompt"),
      step("timer:fileConsent", [], "InExpired"),
      step("local:accept", [], "InExpired"),
      step("peer:BATCH_ABORT", [], "Idle"),
    ],
    divergences: [
      { consumer: "web", step: 1, expect: { emit: ["REJECT"], state: "Idle" }, followUp: FOLLOW_UP.webPromptReject },
      { consumer: "web", step: 2, expect: { emit: [], state: "Idle" }, followUp: FOLLOW_UP.webPromptReject },
    ],
  },
  {
    name: "file.content-before-consent",
    role: "initiator",
    source: "draft:file.content-before-consent; web: queueInbound throws before feed()",
    consumers: ALL,
    steps: [step("peer:content-unannounced", [], "Ended")],
  },
  {
    name: "file.content-at-prompt",
    role: "responder",
    source: "web: queueInbound (content outside receiving/draining fails the lane without feed())",
    consumers: ALL,
    steps: [
      step("peer:manifest", [], "InPrompt"),
      step("peer:content", [], "Ended"),
    ],
  },
  {
    name: "file.integrity-then-retry",
    role: "responder",
    source: "draft:file.integrity-then-retry; web: handleInboundOutput (allOk false → beginDrain integrityFail)",
    consumers: ALL,
    steps: [
      ...receiveFrom(),
      step("peer:content", [], "InRecv"),
      step("local:durable", [], "InRecv", { auto: ["web"] }),
      step("peer:done-mismatch", ["REJECT"], "InDrain"),
      step("peer:BATCH_ABORT", [], "Idle"),
      step("peer:manifest", [], "InPrompt"),
      step("local:accept", ["ACCEPT"], "InRecv"),
      step("peer:content", [], "InRecv"),
      step("local:durable", [], "InRecv", { auto: ["web"] }),
      step("peer:done", [], "InRecv"),
      step("local:commit", ["COMPLETE"], "Idle", { auto: ["web", "go"] }),
    ],
    divergences: [
      { consumer: "go", step: 3, expect: { emit: ["ACK"], state: "InRecv" }, followUp: FOLLOW_UP.goFinalAck },
      { consumer: "go", step: 9, expect: { emit: ["ACK"], state: "InRecv" }, followUp: FOLLOW_UP.goFinalAck },
      { consumer: "kotlin", step: 4, expect: { emit: [], state: "Ended" }, stopAfter: true, followUp: FOLLOW_UP.kotlinIntegrity },
    ],
  },
  {
    name: "file.peer-declines",
    role: "initiator",
    source: "web: runOutbound answer \"reject\" (no barrier: REJECT before ACCEPT already retired the batch)",
    consumers: ALL,
    steps: [
      step("local:offer", ["MANIFEST"], "OutWait"),
      step("peer:REJECT", [], "Idle"),
    ],
    divergences: [
      { consumer: "kotlin", step: 1, expect: { emit: ["BATCH_ABORT"], state: "Idle" }, followUp: FOLLOW_UP.kotlinRejectAbort },
    ],
  },
  {
    name: "file.peer-busy-requeues-once",
    role: "initiator",
    source: "web: runOutbound answer \"busy\" → requeueOrFail → pump (initiator relaunches at once)",
    consumers: ALL,
    steps: [
      step("local:offer", ["MANIFEST"], "OutWait"),
      step("peer:BUSY", ["MANIFEST"], "OutWait"),
      step("peer:BUSY", [], "Idle"),
    ],
    divergences: [
      { consumer: "kotlin", step: 1, expect: { emit: ["BATCH_ABORT"], state: "Idle" }, stopAfter: true, followUp: FOLLOW_UP.kotlinBusyRequeue },
    ],
  },
  {
    name: "file.drain-timeout",
    role: "responder",
    source: "web: refreshDrainWatchdog → markLaneFailed",
    consumers: ALL,
    steps: [
      ...receiveFrom(),
      step("local:cancel-in", ["REJECT"], "InDrain"),
      step("timer:fileDrain", [], "Ended"),
    ],
  },
];

// ── text lane ────────────────────────────────────────────────────────────────
const openAsInitiator = [
  step("local:request", ["REQUEST"], "WaitAccept"),
  step("peer:ACCEPT", [], "Open"),
];
const openAsResponder = [
  step("peer:REQUEST", [], "Incoming"),
  step("local:accept", ["ACCEPT"], "Open"),
];

const textScenarios = [
  {
    name: "text.accept-and-message",
    role: "responder",
    source: "web: mixed-text-session.svelte.ts receiveRequest / accept / queueProtected / send",
    consumers: ALL,
    steps: [
      ...openAsResponder,
      step("peer:message", [], "Open"),
      step("local:send", ["MESSAGE"], "Open"),
    ],
  },
  {
    name: "text.glare",
    role: "responder",
    source: "draft:text.glare; web: receiveRequest (responder converts its intent into the prompt)",
    consumers: ALL,
    steps: [
      step("local:request", ["REQUEST"], "WaitAccept"),
      step("peer:REQUEST", [], "Incoming"),
      step("peer:REJECT", [], "Incoming"),
      step("local:accept", ["ACCEPT"], "Open"),
      step("peer:message", [], "Open"),
    ],
  },
  {
    name: "text.glare.initiator-keeps",
    role: "initiator",
    source: "web: receiveRequest (initiator keeps its request and answers REJECT)",
    consumers: ALL,
    steps: [
      step("local:request", ["REQUEST"], "WaitAccept"),
      step("peer:REQUEST", ["REJECT"], "WaitAccept"),
      step("peer:ACCEPT", [], "Open"),
    ],
  },
  {
    name: "text.end-drain",
    role: "initiator",
    source: "draft:text.end-drain; web: startLocalEnd (inboundDrain) → onLifecycle end",
    consumers: ALL,
    steps: [
      ...openAsInitiator,
      step("local:end", ["END"], "EndWait"),
      step("peer:message", [], "EndWait"),
      step("peer:END", [], "Idle"),
      step("peer:REQUEST", [], "Incoming"),
    ],
  },
  {
    name: "text.unknown-ignored.short9-fatal",
    role: "initiator",
    source: "draft:text.unknown-ignored.short9-fatal; web: onData (non-0x09 unknown ignored, short 0x09 fails)",
    consumers: ALL,
    steps: [
      ...openAsInitiator,
      step("peer:unknown", [], "Open"),
      step("peer:message", [], "Open"),
      step("peer:short9", [], "Failed"),
    ],
  },
  {
    name: "text.peer-end-is-answered",
    role: "responder",
    source: "web: onLifecycle end while open → symmetric END",
    consumers: ALL,
    steps: [
      ...openAsResponder,
      step("peer:END", ["END"], "Idle"),
    ],
  },
  {
    name: "text.content-before-accept",
    role: "responder",
    source: "web: onData (content with no open conversation fails the text lane)",
    consumers: ALL,
    steps: [step("peer:message", [], "Failed")],
  },
  {
    name: "text.consent-timeout.incoming",
    role: "responder",
    source: "web: beginConversation consent timer → startLocalEnd from incomingRequest (REJECT)",
    consumers: ["web", "go"],
    skip: { kotlin: NO_KOTLIN_ADAPTER },
    steps: [
      step("peer:REQUEST", [], "Incoming"),
      step("timer:textConsent", ["REJECT"], "Idle"),
    ],
  },
  {
    name: "text.consent-timeout.waiting",
    role: "initiator",
    source: "web: beginConversation consent timer → startLocalEnd from waitingAccept (END + end-ack lease)",
    consumers: ["web", "go"],
    skip: { kotlin: NO_KOTLIN_ADAPTER },
    steps: [
      step("local:request", ["REQUEST"], "WaitAccept"),
      step("timer:textConsent", ["END"], "EndWait"),
      step("timer:textEndAck", [], "Failed"),
    ],
  },
  {
    name: "text.end-ack-timeout",
    role: "initiator",
    source: "web: awaitEndAck → markFailed (text codecs retired; file lane untouched)",
    consumers: ALL,
    steps: [
      ...openAsInitiator,
      step("local:end", ["END"], "EndWait"),
      step("timer:textEndAck", [], "Failed"),
    ],
  },
];

// ── the two app behaviours discovery depends on (A08-DESIGN §3.1, §13) ──────
const appPeerModels = {
  helloAtRosterGain: {
    name: "app.hello-at-roster-gain",
    source: "web: peer-caps.svelte.ts CapsAnnouncer.rosterChanged / #arm; android: LinkSession.rosterChanged / helloRetryTick",
    consumers: ["web", "kotlin"],
    note: "The first hello is owed by roster gain ALONE and is sent at once; retries tick at "
      + "helloInterval until the budget of 3 is spent or the peer is heard. A new CLI relies on "
      + "this: it waits passively for an unhinted app because the app always speaks first.",
    steps: [
      { do: "roster", peers: ["peer-z"], expect: { hello: ["peer-z"] } },
      { do: "tick", expect: { hello: ["peer-z"] } },
      { do: "tick", expect: { hello: ["peer-z"] } },
      { do: "tick", expect: { hello: [] } },
      { do: "roster", peers: ["peer-z", "peer-y"], expect: { hello: ["peer-y"] } },
      { do: "heard", peer: "peer-y", expect: { hello: [] } },
      { do: "tick", expect: { hello: [] } },
    ],
    helloCarries: "link/1",
    divergences: [
      { consumer: "swift", note: "not a consumer in A08e", followUp: FOLLOW_UP.appleFirstHello },
    ],
  },
  kindLatchesCli: {
    name: "app.kind-latches-cli",
    source: "web: cli-peer.svelte.ts isCliHandshakeSignal; android: CliPeerSignal.isHandshake; go: linksession ClassifySignal",
    consumers: ["web", "kotlin", "go"],
    note: "Any object with a top-level STRING kind is the CLI's legacy handshake; nothing else is. "
      + "Every shipped app latches on it, which is why a new CLI must never send a kind frame "
      + "first to a peer that is not proven to be an old CLI.",
    cases: [
      { signal: { kind: "commit", commit: "AAAA", mode: "text" }, cli: true },
      { signal: { kind: "reveal", key: "AAAA", nonce: "AAAA" }, cli: true },
      { signal: { kind: "pair-needs-newer-relayium" }, cli: true },
      { signal: { kind: "" }, cli: true },
      { signal: { kind: 5 }, cli: false },
      { signal: { kind: null }, cli: false },
      { signal: { caps: ["link/1"] }, cli: false },
      { signal: { caps: [] }, cli: false },
      { signal: { link: true, sdp: { type: "offer", sdp: "v=0" }, commit: "AAAA", caps: ["link/1"] }, cli: false },
      { signal: { sdp: { type: "offer", sdp: "v=0" }, commit: "AAAA" }, cli: false },
      { signal: ["kind", "commit"], cli: false },
      { signal: "kind", cli: false },
    ],
  },
};

// ── the CLI's own discovery machine (Go is the only implementation) ─────────
const cliScenarios = [
  {
    name: "discovery.new-new",
    source: "draft:discovery.new-new",
    cmd: "pair",
    consumers: ["go"],
    steps: [
      { do: "room", view: { serverHints: true, peerHinted: true }, expect: { emit: ["HELLO"], state: "Greeting" } },
      { do: "timer:helloInterval", expect: { emit: ["HELLO"], state: "Greeting" } },
      { do: "signal", signal: { caps: ["link/1"] }, expect: { emit: [], state: "Link" } },
    ],
  },
  {
    name: "discovery.apple-late-hello",
    source: "draft:discovery.apple-late-hello",
    cmd: "send",
    consumers: ["go"],
    steps: [
      { do: "room", view: { serverHints: true, peerHinted: false }, expect: { emit: [], state: "Passive" } },
      { do: "signal", signal: { caps: ["text/1", "link/1"] }, expect: { emit: ["HELLO"], state: "Link" } },
    ],
  },
  {
    name: "discovery.old-cli-behind-roster",
    source: "draft:discovery.old-cli-behind-roster",
    cmd: "send",
    consumers: ["go"],
    steps: [
      { do: "signal", signal: { kind: "commit", commit: "AAAA" }, expect: { emit: [], state: "Joining" } },
      { do: "room", view: { serverHints: true, peerHinted: false }, expect: { emit: ["LEGACY"], state: "Legacy" } },
    ],
    resolution: "The draft split the replay into two steps (PeerUnhinted → Passive, then the replayed "
      + "commit → Legacy). A real Room call replays the capture inside the same input, so one step "
      + "observes both transitions.",
  },
  {
    name: "discovery.pair-meets-old-cli",
    source: "draft:discovery.pair-meets-old-cli",
    cmd: "pair",
    consumers: ["go"],
    steps: [
      { do: "room", view: { serverHints: true, peerHinted: false }, expect: { emit: [], state: "Passive" } },
      { do: "signal", signal: { kind: "commit", commit: "AAAA" }, expect: { emit: ["KIND:pair-needs-newer-relayium"], state: "Failed" } },
    ],
  },
  {
    name: "discovery.link-ignores-injected-kind",
    source: "A08c D1; web: App.svelte onSignal consumes a top-level kind (noteCliPeer) before any link handler and never ends a link on it",
    cmd: "pair",
    consumers: ["go"],
    resolution: "The draft table failed the session on a legacy kind frame in discovery Link. "
      + "Signalling is unauthenticated, so a relay-injected frame must not end an authenticated "
      + "link; the Web agrees (the frame is consumed, the link is untouched). A08c's D1 already "
      + "implements the drop.",
    steps: [
      { do: "room", view: { serverHints: true, peerHinted: true }, expect: { emit: ["HELLO"], state: "Greeting" } },
      { do: "signal", signal: { caps: ["link/1"] }, expect: { emit: [], state: "Link" } },
      { do: "signal", signal: { kind: "commit", commit: "AAAA" }, expect: { emit: [], state: "Link" } },
    ],
  },
];

const out = {
  _: [
    "GENERATED by web/scripts/gen-link-session-vectors.mjs and gated byte-for-byte by",
    "web/scripts/check-wire-vectors.mjs. Do not edit by hand: change the generator, run",
    "`npm run gen:vectors` from web/, and commit both together.",
    "Abstract lane-machine scenarios (W-N18 A08e). The Web is the authority; each consumer",
    "drives its REAL machine against a scripted peer that seals frames with that consumer's",
    "own codecs, on a fake clock. Wire bytes live in realtime-wire-vectors.json, never here.",
  ],
  format: "relayium-link-session-vectors/1",
  authority: "web",
  stepSemantics: {
    order: "Steps run in order. After each step the consumer compares the tokens its machine put "
      + "on the lane during that step (in order) and its abstract state with `expect`.",
    auto: "A consumer listed in a step's `auto` performs that step by itself as part of the "
      + "PREVIOUS step (the Web streams data after ACCEPT, acks and COMPLETEs as its sink "
      + "resolves). It does not perform the step; it asserts the previous step's emissions "
      + "followed by this step's, and this step's state, after the previous step.",
    divergence: "`divergences[].step` is a zero-based step index. For that consumer the entry's "
      + "`expect` replaces the step's (after any `auto` merge onto that index) and is asserted, "
      + "not skipped. `stopAfter` ends the scenario for that consumer after the step.",
    consumers: "A scenario is run by exactly the consumers it lists; `skip` records why any other "
      + "known consumer does not run it. A consumer that meets a step it cannot map must fail.",
    peer: "The scripted peer is the other end of the link, sealing with the consumer's codecs. "
      + "peer:manifest announces one file of 5 bytes (\"hello\"); peer:content is that batch's "
      + "next chunk; peer:done its DONE; peer:done-mismatch a DONE at the right sequence whose "
      + "digest is for different bytes; peer:content-unannounced a chunk frame of a batch whose "
      + "manifest was never delivered. local:offer offers one 5-byte file. peer:unknown is the "
      + "text-lane frame [0x0d, 0x00]; peer:short9 is [0x09, 0x00, 0x00].",
  },
  tokens: {
    file: {
      MANIFEST: "BATCH_PART* + BATCH_ENC (kinds 11*, 7), counted once",
      CHUNK: "CHUNK_PART* + CHUNK (kinds 10*, 1), counted once per logical chunk",
      DONE: "DONE_ENC (kind 8)",
      ACK: "ACK (kind 6)",
      ACCEPT: "0xfe", REJECT: "0xff", COMPLETE: "0xfd", BUSY: "0xf9", BATCH_ABORT: "0xf8",
    },
    text: { REQUEST: "0xfa", ACCEPT: "0xfe", REJECT: "0xff", END: "0xfb", MESSAGE: "kind 9 frame" },
    cli: {
      HELLO: "{\"caps\":[\"link/1\"]}",
      "KIND:<k>": "a signal with top-level kind <k>",
      LEGACY: "hand-off to the legacy commit/reveal handshake",
    },
  },
  states: {
    file: ["Idle", "OutWait", "OutSend", "OutFinish", "InPrompt", "InRecv", "InDrain", "InExpired", "Ended"],
    text: ["Idle", "WaitAccept", "Incoming", "Open", "EndWait", "Failed"],
    cli: ["Joining", "Passive", "Greeting", "Link", "Legacy", "Failed"],
  },
  bounds: BOUNDS,
  consumers: {
    web: "web/src/lib/link-session-vectors.test.ts — createMixedFileSession / createMixedTextSession on a fake link, vi fake timers; CapsAnnouncer; isCliHandshakeSignal",
    go: "server/internal/linksession/vectors_test.go — Session lane machines on a fake clock; ClassifySignal; discovery",
    kotlin: "apps/android/protocol/src/test/kotlin/com/relayium/protocol/LinkSessionVectorTest.kt — FileLaneSession / TextLaneSession; LinkSession announcer; CliPeerSignal",
    swift: "not a consumer in A08e (optional in the plan); RelayiumKit keeps its capability-block vectors",
  },
  notCarried: [
    {
      draft: "link.responder.lanes-before-reveal",
      why: "link establishment is the CLI's own machine with no second implementation of these "
        + "abstract events; it stays in Go's TestLaneCaptureBeforeReveal / TestSessionEstablishmentOrdering. "
        + "Web and Android establishment are pinned by link-protocol-vectors / LinkVectorTest.",
    },
    {
      draft: "link.reveal-without-commit",
      why: "same as above (TestSessionEstablishmentOrdering asserts it on the real Session).",
    },
  ],
  file: fileScenarios,
  text: textScenarios,
  appPeers: appPeerModels,
  cli: cliScenarios,
};

writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
process.stdout.write(`wrote ${OUT} (${fileScenarios.length} file, ${textScenarios.length} text, ${cliScenarios.length} cli scenarios)\n`);
