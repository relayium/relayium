import Combine
import Foundation
// For the FILE lane's own vocabulary — `LinkFileDriverEvent`,
// `LinkFileDriverError` and `FileMeta` — which this projection mirrors rather
// than restates.
import RelayiumKit

/// Which way one batch is going.
///
/// It is not a rendering hint. It is what makes every report answerable: the
/// driver's inbound and outbound events share one batch-id space, so a report
/// whose direction disagrees with the batch it names belongs to a batch this
/// projection does not have, and applying it to the one that happens to share
/// the number is the single mistake that could corrupt two transfers at once.
public enum LinkFileBatchDirection: Equatable {
    case inbound
    case outbound
}

/// Where one batch is, as a screen would state it.
///
/// Six cases, and each is a thing a transfer list genuinely draws differently.
/// Three of them are terminal, and terminal means terminal: a batch that has a
/// result does not go back to moving, whatever arrives afterwards.
///
/// **`received` is the only one that carries URLs, and that is the whole point
/// of keeping it apart from `finished`.** `inboundFinished(batch:ok: true)` says
/// the driver's destination committed; it does not say WHERE, and nothing in it
/// could. Only `LinkReceivedBatch` — produced from inside a successful
/// `finalize`, which is the moment the bytes stop being a transfer and become
/// the user's files — carries the paths, so a `received` state synthesised from
/// `ok: true` would be a screen offering to reveal files it cannot name.
public enum LinkFileBatchState: Equatable {
    /// Inbound: the peer's manifest is waiting for this user's answer.
    case offered
    /// Outbound: the runtime accepted the enqueue and nothing has left yet.
    case queued
    /// Bytes have moved. Progress is what proves it, in either direction.
    case transferring
    /// Reported complete. For an outbound batch that is the whole truth — the
    /// peer took it — and for an inbound one it means the driver reported a
    /// commit this projection has seen no proof of. See `received`.
    case finished
    /// Inbound, committed, and on the user's disk. `files` is in manifest order
    /// and `container` is the folder the batch created for itself, or nil for a
    /// flat batch that landed straight in the chosen directory.
    case received(files: [URL], container: URL?)
    /// Over, with no result: refused, cancelled, timed out, stranded by a
    /// terminal lane, or left unfinished by a session that ended.
    case failed

    /// Whether a result has already been decided. The guard every later report
    /// passes through.
    public var isTerminal: Bool {
        switch self {
        case .offered, .queued, .transferring: return false
        case .finished, .received, .failed: return true
        }
    }
}

/// One batch of a `link/1` transfer, as a transfer list would show it.
///
/// `id` is the driver's own batch number rather than a model-local one — unlike
/// `LinkTextMessage.id`, which has no wire meaning — because correlating events
/// to rows IS this projection's job, and a second numbering would be one more
/// mapping to get wrong.
///
/// `files` is the manifest verbatim: the peer's for an inbound batch, this
/// side's for an outbound one. Nothing here trims a name, rewrites a path or
/// re-orders an entry. `path` in particular decides the shape of what lands on
/// disk, and this layer is not where that is decided.
public struct LinkFileBatch: Equatable, Identifiable {

    /// The driver's batch number.
    public let id: Int
    public let direction: LinkFileBatchDirection
    /// The manifest, exactly as it was announced or enqueued.
    public let files: [FileMeta]
    /// The manifest's own total, computed once and saturating — see
    /// `LinkFilePresentationModel.total(of:)` for why a peer's numbers may not
    /// be added naively.
    public let totalBytes: Int

    /// The whole manifest's durable prefix (inbound) or produced frontier
    /// (outbound), exactly as the driver last reported it. Monotonic.
    public fileprivate(set) var transferredBytes: Int = 0
    public fileprivate(set) var state: LinkFileBatchState

    public var isTerminal: Bool { state.isTerminal }

    /// The bar, or nil when there is nothing to draw one against.
    ///
    /// The DIVISION is this object's own arithmetic, so bounding it is not
    /// second-guessing the driver: `transferredBytes` is kept exactly as
    /// reported — a disagreement between a peer's manifest and the bytes that
    /// actually moved is a fact worth being able to see — and only the fraction
    /// derived from it is clamped, because a bar past its end or before its
    /// start renders as garbage.
    public var fractionCompleted: Double? {
        guard totalBytes > 0 else { return nil }
        return min(1, max(0, Double(transferredBytes) / Double(totalBytes)))
    }

    /// Where the files landed, once a commit proved it. Nil in every other
    /// state, including `finished`.
    public var receivedFiles: [URL]? {
        guard case let .received(files, _) = state else { return nil }
        return files
    }

    /// The folder this batch created for itself. Nil for a flat batch AND for a
    /// batch that has not committed, which a caller distinguishes by looking at
    /// `state` rather than at this.
    public var receivedContainer: URL? {
        guard case let .received(_, container) = state else { return nil }
        return container
    }

    fileprivate var isCommitted: Bool {
        guard case .received = state else { return false }
        return true
    }
}

/// The `@MainActor` projection of ONE attempt's FILE lane: its offers, its
/// per-batch progress, its results, and the batches that really reached the
/// user's disk.
///
/// ## What it is, and what it deliberately is not
///
/// It is the second projection above `LinkSessionEventBridge`, and it is exactly
/// one thing: `LinkSessionRuntimeEvent` in, published batch state out. It owns
/// no runtime, builds nothing, sends nothing, enqueues nothing, accepts nothing
/// and cannot cancel or end anything. Commands belong to `LinkSessionAttempt`,
/// which owns this object's whole lifetime and is the only caller of
/// `recordOutgoingBatch`.
///
/// It is a SEPARATE object from `LinkSessionPresentationModel` rather than more
/// state inside it, which is what that type's own note said this slice would be.
/// Neither knows the other exists: both are handed the same ordered stream by
/// their one owner, and each ignores what is not its own. A transfer list that
/// had to be reached through the connection projection would tie a file screen's
/// correctness to the conversation's.
///
/// ## The correlation rules, which are the whole design
///
/// **1. A batch exists because it was ANNOUNCED or ACCEPTED.** An inbound batch
/// enters through `inboundOffer`, an outbound one through `recordOutgoingBatch`
/// — which the attempt calls only after the runtime answered an enqueue with an
/// id. Nothing else creates a row: a progress report or a result for an unknown
/// batch is dropped, because a row invented from one would have no manifest
/// behind it and nothing to show.
///
/// **2. Strictly by id AND direction.** See `LinkFileBatchDirection`.
///
/// **3. Progress only ever increases.** The driver already clamps, and a resumed
/// attempt is exactly where that matters — a rebased send window reports from
/// further back, and a receiver whose durable prefix was lost with the transport
/// asks from further back still. This is the second guard, because a bar that
/// walks backwards is the most visible bug this layer can have.
///
/// **4. Terminal is terminal, with ONE deliberate exception.** A result is never
/// overwritten by a later report — the driver's retirement contract makes
/// `outboundFinished` and `batchesFailed` mutually exclusive for one accepted
/// batch, and `inboundFinished` exactly once for a batch that reached a
/// destination, so a second report is a stale one. The exception is a committed
/// `received`, which may upgrade a `finished` or a `failed` batch and may never
/// itself be overwritten: those bytes ARE the user's files, and the case is real
/// rather than theoretical — a `finalize` already in flight when the lane goes
/// terminal commits afterwards, and a screen saying "failed" while the files sit
/// in the receive folder would be lying about the one thing the user can check.
///
/// **5. The file lane's own end is absorbing.** After `failed`, every batch
/// without a result gets one and nothing this LANE says afterwards starts, moves
/// or revives anything — a committed receive, which is the runtime's report
/// rather than the lane's, is rule 4's exception. The failure kept is the FIRST
/// one, for the same reason the text projection keeps the first: the useful
/// value is what started this, not what fell out of it.
///
/// **6. The whole session's end is absorbing for everything.** `ended` is the
/// runtime's last event, so a batch still moving will never get a result and is
/// failed here, and nothing after it changes anything at all.
///
/// ## What it does NOT decide
///
/// Every limit, timeout, consent rule and retry belongs to `LinkFileSession` and
/// `LinkFileDriver`, and nothing here re-states one. In particular a void
/// command — accept, reject, cancel, pump — writes NOTHING here: those verbs
/// return nothing precisely because their refusal is the absence of the action,
/// and a projection that moved a batch on the strength of one would be showing a
/// user an outcome the lane never agreed to.
///
/// ## Threading
///
/// Everything is main-actor isolated, and the hop is the bridge's: it delivers
/// on the main actor, in publication order, one at a time. So `apply` is an
/// ordinary main-actor method with no synchronization of its own.
///
/// ## Lifetime
///
/// It holds no bridge and no runtime, and there is no `deinit` teardown, for
/// exactly the reasons `LinkSessionPresentationModel` records: retiring an
/// attempt is its owner's act, and doing it from a deallocation would run
/// actor-isolated cleanup on whichever thread released the last reference.
@MainActor
public final class LinkFilePresentationModel: ObservableObject {

    /// Every batch this attempt knows about, in the order it became known.
    ///
    /// One list rather than two, because the id space is one and a view that
    /// wants them apart has `inbound` and `outbound` below.
    @Published public private(set) var batches: [LinkFileBatch] = []

    /// Why the file lane failed, as the typed value the driver reported and no
    /// more. Turning it into words is a later slice's job — a message baked in
    /// here would be one this type could not localize and a view could not
    /// override.
    ///
    /// Unlike the text lane's, this cannot be nil while the lane is failed: the
    /// FILE lane has exactly one terminal report and it always carries an error,
    /// so `isFileLaneFailed` is a reading of this rather than a second flag that
    /// could disagree with it.
    @Published public private(set) var laneFailure: LinkFileDriverError?

    /// The whole attempt is over. Terminal, and absorbing for this projection.
    @Published public private(set) var isSessionEnded = false

    // MARK: - what a view asks

    /// This lane is over. Deliberately NOT the same question as the session's:
    /// a file lane that failed closed leaves a live link carrying a live
    /// conversation, and a screen has to be able to say both.
    public var isFileLaneFailed: Bool { laneFailure != nil }

    public var inbound: [LinkFileBatch] { batches.filter { $0.direction == .inbound } }
    public var outbound: [LinkFileBatch] { batches.filter { $0.direction == .outbound } }

    /// The peer's manifests waiting for this user's answer. What a consent
    /// prompt appears on.
    public var offers: [LinkFileBatch] { batches.filter { $0.state == .offered } }

    public func batch(_ id: Int) -> LinkFileBatch? { batches.first { $0.id == id } }

    // MARK: - the projection

    /// One event, one batch decision.
    func apply(_ event: LinkSessionRuntimeEvent) {
        // Rule 6. The runtime promises `ended` is its last event and the bridge
        // drops whatever it was holding, so this should be unreachable — it is
        // here because the alternative failure is a transfer that visibly
        // resumes on a screen that has already reported the session finished.
        guard !isSessionEnded else { return }

        switch event {
        case let .file(event):
            applyFile(event)

        case let .received(committed):
            // NOT inside `applyFile`, and not gated on the lane: this is the
            // runtime's report of a destination that committed, and it is rule
            // 4's exception. The runtime refuses one after its own end, so the
            // guard above is the only place it can be dropped.
            commit(committed)

        case .ended:
            endSession()

        case .sas, .opened, .text:
            // The connection and the conversation, which are the session
            // projection's. This object never touches them.
            break
        }
    }

    /// One file-lane event, one batch decision.
    private func applyFile(_ event: LinkFileDriverEvent) {
        // Rule 5. The lane is terminal, so nothing it says afterwards can start
        // or move anything — including a second `failed`, which is why
        // `failLane` below never has to guard for itself.
        guard laneFailure == nil else { return }

        switch event {
        case let .inboundOffer(batch, files):
            offer(batch, files: files)

        case let .inboundProgress(batch, durableBytes):
            note(batch, .inbound, bytes: durableBytes)

        case let .inboundFinished(batch, ok):
            // `ok: true` is NOT a committed receive. See `LinkFileBatchState`.
            retire(batch, .inbound, ok: ok)

        case let .outboundProgress(batch, sentBytes):
            note(batch, .outbound, bytes: sentBytes)

        case let .outboundFinished(batch, ok):
            retire(batch, .outbound, ok: ok)

        case let .batchesFailed(ids):
            // The terminal lane naming the queued and active work it took with
            // it. Those batches deliberately get no second result, so this is
            // the whole report for each of them — and it touches nothing it did
            // not name.
            for id in ids { fail(id) }

        case let .failed(error):
            failLane(error)
        }
    }

    // MARK: - what only the attempt owner knows

    /// Record one batch THIS side enqueued, after the runtime accepted it.
    ///
    /// The runtime's event stream has no accepted-enqueue event — the lane
    /// answers the CALLER with the batch id instead — so the only object that
    /// can honestly create an outbound row is the one that made the call and saw
    /// it return. `LinkSessionAttempt` is that object, it is this model's owner,
    /// and it is the only caller of this method.
    ///
    /// It is not a command and takes no decision: whether the batch could be
    /// queued was already answered, by the lane, before this runs.
    ///
    /// **The two terminal guards are defence in depth**, exactly as they are for
    /// an outgoing message: a live runtime refuses every enqueue once its
    /// session or its lane is over, so an accepted enqueue cannot coincide with
    /// either frozen state — and if one ever did, the visible failure would be a
    /// transfer list that grew on a screen that had already reported the lane,
    /// or the session, finished.
    ///
    /// Recording the same id twice is refused too, and so is an id an inbound
    /// offer already claimed. The runtime issues neither, and the failure a
    /// broken one would produce is two rows for one transfer, or an inbound
    /// batch quietly turning into an outbound one.
    func recordOutgoingBatch(_ batch: Int, files: [FileMeta]) {
        guard !isSessionEnded, laneFailure == nil else { return }
        guard self.batch(batch) == nil else { return }
        append(batch, direction: .outbound, files: files, state: .queued)
    }

    // MARK: - one batch at a time

    private func offer(_ batch: Int, files: [FileMeta]) {
        // A repeat is not a second batch, and it may not reset the one that is
        // there: the manifest a screen is already showing is the one the
        // transfer is running against.
        guard self.batch(batch) == nil else { return }
        append(batch, direction: .inbound, files: files, state: .offered)
    }

    private func note(_ batch: Int, _ direction: LinkFileBatchDirection, bytes: Int) {
        guard let index = index(of: batch, direction), !batches[index].isTerminal else { return }
        write(at: index) {
            // Rule 3. A regression, a duplicate and a negative all settle on the
            // high-water mark, and `write` then publishes nothing.
            $0.transferredBytes = max($0.transferredBytes, bytes)
            $0.state = .transferring
        }
    }

    private func retire(_ batch: Int, _ direction: LinkFileBatchDirection, ok: Bool) {
        guard let index = index(of: batch, direction), !batches[index].isTerminal else { return }
        write(at: index) { $0.state = ok ? .finished : .failed }
    }

    /// Fail one batch by id, whichever way it was going. `batchesFailed` names
    /// numbers rather than directions, and the terminal lane it comes from has
    /// already released both sides.
    private func fail(_ batch: Int) {
        guard let index = batches.firstIndex(where: { $0.id == batch }),
              !batches[index].isTerminal else { return }
        write(at: index) { $0.state = .failed }
    }

    /// Rule 4's exception, and the only place a URL enters this projection.
    private func commit(_ committed: LinkReceivedBatch) {
        guard let index = index(of: committed.batch, .inbound) else { return }
        // Not `isTerminal`: a commit outranks `finished` and `failed`. It does
        // not outrank another commit — a second report for one batch is the
        // stale one, and the destination fires its callback once in any case.
        guard !batches[index].isCommitted else { return }
        write(at: index) {
            // Verbatim. Neither list is re-ordered, resolved or standardised
            // here, and `transferredBytes` is left exactly where the driver last
            // reported it rather than being rounded up to the manifest: a commit
            // proves where the files are, not how many bytes a progress report
            // had got to.
            $0.state = .received(files: committed.files, container: committed.container)
        }
    }

    // MARK: - the two absorbing ends

    private func failLane(_ error: LinkFileDriverError) {
        // Reached only while `laneFailure` is nil — `applyFile` refuses
        // everything else — so this IS the first report, and the first is the
        // one kept.
        laneFailure = error
        failUnfinished()
    }

    private func endSession() {
        // Reached only once, for the same reason: `apply` refuses everything
        // after it.
        isSessionEnded = true
        failUnfinished()
    }

    /// Give every batch without a result the only honest one there is.
    ///
    /// Both ends mean "no further event will be projected for this lane", so a
    /// batch left offered, queued or moving would spin forever on a screen that
    /// has already been told why. One assignment rather than one per batch, so
    /// this repaints a view once.
    ///
    /// **After the SESSION's end this can be wrong in one direction, and it is
    /// the least wrong answer available.** `LinkSessionRuntime` refuses a commit
    /// that lands behind its `ended` — the files stay exactly where `finalize`
    /// put them and only the event is dropped — so a batch that committed in
    /// that window is failed here with its files on disk. Nothing at this layer
    /// can tell: there is no event, and inventing "may have arrived" would be a
    /// state a screen could not act on either. The lane's own end is different
    /// and is handled: a commit still reaches `apply` there, and `commit`
    /// takes it.
    private func failUnfinished() {
        var updated = batches
        var changed = false
        for index in updated.indices where !updated[index].isTerminal {
            updated[index].state = .failed
            changed = true
        }
        guard changed else { return }
        batches = updated
    }

    // MARK: - the list

    private func index(of batch: Int, _ direction: LinkFileBatchDirection) -> Int? {
        batches.firstIndex { $0.id == batch && $0.direction == direction }
    }

    private func append(_ batch: Int,
                        direction: LinkFileBatchDirection,
                        files: [FileMeta],
                        state: LinkFileBatchState) {
        batches.append(LinkFileBatch(id: batch,
                                     direction: direction,
                                     files: files,
                                     totalBytes: total(of: files),
                                     state: state))
    }

    /// Change one batch, and publish ONLY if that changed something.
    ///
    /// `@Published` publishes on every assignment, so an unguarded write for a
    /// duplicate or stale event would repaint a whole transfer list for a value
    /// that did not move. Every rule above is expressed as a clamp rather than
    /// as a branch precisely so that this one comparison is what decides.
    ///
    /// It compares the two MUTABLE fields rather than the whole value, and that
    /// is a correctness-preserving choice rather than a shortcut: `id`,
    /// `direction`, `files` and `totalBytes` are `let`, so `change` cannot move
    /// them and comparing them could only ever answer "equal". Comparing the
    /// whole value would put a manifest-sized array comparison on the main actor
    /// for every progress event of a folder with thousands of files in it.
    ///
    /// A later mutable field must be added to this comparison, or a change to it
    /// will silently fail to repaint.
    private func write(at index: Int, _ change: (inout LinkFileBatch) -> Void) {
        var updated = batches[index]
        change(&updated)
        guard updated.transferredBytes != batches[index].transferredBytes
                || updated.state != batches[index].state else { return }
        batches[index] = updated
    }

    /// A manifest's total, saturating.
    ///
    /// It is arithmetic on numbers this side did not choose — an inbound
    /// manifest is a PEER's claim about sizes — so `+` would be a remote trap.
    /// Saturation keeps the failure visible as a nonsense bar rather than as a
    /// crash, and `fractionCompleted` refuses to divide by a total that is not
    /// positive.
    private func total(of files: [FileMeta]) -> Int {
        var total = 0
        for file in files {
            let (sum, overflow) = total.addingReportingOverflow(file.size)
            total = overflow ? (file.size > 0 ? .max : .min) : sum
        }
        return total
    }
}
