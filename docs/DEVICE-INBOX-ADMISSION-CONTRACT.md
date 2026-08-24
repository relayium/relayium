# The Device Inbox admission contract

`contracts/device-inbox-admission-v1.json` is the repository's first root-level,
versioned, runtime-neutral contract. It freezes the small set of Device Inbox
admission facts that Go, TypeScript and Swift must already agree on, so that a
disagreement between two shipped implementations becomes a failing test instead
of a delivery that silently does nothing.

It is **not** a code generator and **not** a source of truth that overrides an
implementation. Nothing is generated from it, and it is generated from nothing.
Each of the three implementations parses the same file independently and
compares it to the constants it already ships.

## What is frozen, and only what is frozen

| Fact | Key |
| ---- | --- |
| Protocol version and wrap-algorithm token | `protocolVersion`, `keyAlgorithm` |
| Capability tokens, and the syntax every token must satisfy | `capabilityTokens`, `capabilityTokenSyntax`, `requiredReceiveCapability` |
| The closed server-visible task states, in PRD §10 order | `taskStates` |
| The states that can never transition again | `terminalStates` |
| What a target device may assert about a task it leases | `deviceReportableStates` |
| The whole legal transition graph | `stateTransitions` |
| The no-error value | `noErrorValue` |
| The nonempty codes a device may submit | `deviceReportableErrors` |
| The codes central writes and a device may never submit | `centralOnlyErrors` |

### What is deliberately absent

Freezing more would turn a wire contract into a place where product decisions
get made by whoever edits a JSON file.

* **Platform admission and UI ladders.** Whether a device is *offered* as a send
  target, in what order the reasons are shown, and which one wins when several
  apply, are per-surface product decisions. `sendAvailability` in the browser and
  the macOS inbox surface answer them differently and correctly.
* **Broad HTTP error unions.** `InboxRejection` (Swift) and `SEND_ERROR_CODES`
  (Web) are per-endpoint and per-surface. The browser's union deliberately folds
  central's create refusals together with local failures like `network` and
  `cancelled`, because the card shows one sentence either way. That is copy, not
  a wire fact.
* **Operational bounds.** Lease TTL, attempt caps, backoff, queue depth. Central
  advertises the ones a client must follow, and a client that compiled a
  different number in would be wrong to prefer it.
* **Sender-local phases.** `encrypting` and `uploading` are real product states
  that central cannot observe. They are absent from `taskStates` and every
  consumer test asserts that its own parser refuses them.
* **Auto-accept policy and presence.** Real shared vocabularies, but not part of
  the admission facts this v1 was scoped to; a later contract may take them.

## The document's own rules

The document is deterministic — one set of facts has exactly one spelling — so
that a regenerated or hand-edited copy is a byte-for-byte diff of what changed.

* `taskStates` carries the one **semantic** order (PRD §10 items 3-12). Every
  other list of states — `terminalStates`, `deviceReportableStates` and every
  transition target list — must be a **subsequence** of it. That single rule is
  the determinism rule, the duplicate check and the unknown-member check at once.
* Every other list (`consumers`, `capabilityTokens`, `deviceReportableErrors`,
  `centralOnlyErrors`, each `definedBy`) is **strictly ascending**. Strict, so
  the order check is also the duplicate check.
* The top-level key set is **closed in both directions**. Each consumer compares
  the document's keys to a set it states itself, so an unknown fact and a
  **deleted** fact both fail. A deleted fact is the dangerous direction: it is
  not a smaller contract, it is a fact no implementation is compared against any
  more.
* **Every** state is a key of `stateTransitions`; a terminal state maps to `[]`.
  Go's own table omits terminal sources, because absence is how it refuses them.
  The document states them explicitly instead — that is what lets a consumer with
  no transition table read terminality off the graph.
* `terminalStates` is therefore redundant with `stateTransitions`, on purpose,
  and all three consumer tests check the two readings against each other.

### Why that redundancy is the useful part

Only the server implements the transition graph. The browser and the Apple
clients do not, and should not — they are a sender and a receiver, not a state
machine. But both implement *terminality*: the browser stops polling on it, and
`InboxTaskState.isTerminal` gates what the receiver will still act on.

"Terminal" and "has no outgoing edge" are one fact. Stating it twice lets Web
and Swift compare their own rule against the server's graph without carrying the
graph — which is precisely the drift that would otherwise be invisible until a
task stopped being polled one state too early.

## Who checks it, and what each can prove

| Consumer | Test | Reaches the file by |
| -------- | ---- | ------------------- |
| Go | `server/account/deviceinbox_admission_contract_test.go` | marker-based walk to the repository root |
| Web | `web/src/lib/device-inbox-admission-contract.test.ts` | marker-based walk from `import.meta.url` |
| Swift | `apps/RelayiumKit/Tests/RelayiumKitTests/DeviceInboxAdmissionContractTests.swift` | `RepoRoot`, the target's existing resolver |

None of the three shares a loader, a schema type or a helper with the others.
That is deliberate: a shared parser that misread the document would make all
three agree with each other about something none of them does.

Each proves as much as its language allows, and the gaps are not symmetric:

* **Go** compares `TaskStates()` as an exact ordered sequence, and checks the
  transition graph as **all 100 ordered pairs** against `CanTransitionTask`
  rather than as a map equality. The extra pairs are the point — a map
  comparison says nothing about the two refusals that are not edges, a terminal
  *source* and `from == to`, and the second is what stops `saved -> saved` from
  overwriting an honest commit timestamp.
* **Swift** gets exact set equality for free: `InboxTaskState`,
  `InboxDeviceErrorCode` and `InboxCentralErrorCode` are all `CaseIterable`, so
  a case added here and to no other implementation fails immediately.
* **Web** compares `SERVER_TASK_STATES` as an ordered sequence and
  `TASK_ERROR_CODES` as an exact set — the union of both authors' codes, which
  is what a read model legitimately sees.

**Where enumeration is impossible, the source is read.** Go's `inbox` package
exports no enumerator for its error codes or capability tokens, and Swift's
`InboxCapability` is a namespace of `static let`s that nothing can enumerate.
`ValidateDeviceErrorCode` is total over strings, so testing it against the
contract's own members could only ever prove that those members behave — never
that a fifteenth code was added to one implementation and to no other. Both
tests therefore scan the declaring source file, and both **fail when the scan
matches nothing**, because an empty scan agrees with every contract there is.

## Changing it

A new fact, or a changed one, is a change to three implementations and this
document in one commit. A **breaking** change is a new file beside this one —
`device-inbox-admission-v2.json` — never a rewrite of v1: a consumer pinned to v1
must keep reading v1.

If the three implementations disagree about a fact today, that is drift between
shipped code, and the contract is where it became visible. Report it. Do not
edit runtime to agree with the document, and do not edit the document to agree
with whichever implementation is most convenient.

## CI

A contract-only edit starts the dedicated `contracts.yml` lane plus the two
always-on gates, and nothing else. See
[CI platform boundary](CI-PLATFORM-BOUNDARY.md#the-contracts-tree) for why the
consumer suites do **not** name the contract in their own path filters, and
`scripts/test/contract-ci-policy-test.mjs` for the executable form of that rule.
