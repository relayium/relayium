import Combine
import Foundation
import RelayiumAppKit
import RelayiumKit

/// One link's worth of what a counterpart observed, kept apart from every other
/// link's.
///
/// **Per-link rather than per-process, and that is a correctness requirement.**
/// The first version of this type stored one `sas` and one `messages` array for
/// the life of the peer. A UI acceptance run drives several links against one
/// resident counterpart, and the effect was a false pass: a later test polled
/// "has the counterpart derived a SAS yet", was answered by the digits an
/// EARLIER link had left behind, and concluded that a link it had never
/// established was open. An epoch that increments per claimed link is what lets
/// a caller say "a SAS for *this* link" instead of "a SAS".
public struct LinkRecord: Sendable {
    /// Which link this is, counting from 1. `0` means no link has been claimed.
    public var epoch: Int
    /// The digits this side derived, or nil before the handshake produced any.
    public var sas: String?
    /// Message bodies RECEIVED, in arrival order. Filtered to `.incoming`, so a
    /// body that only ever existed in the sender's composer cannot appear here.
    public var messages: [String] = []
    /// What the link's writer left on disk for this link.
    public var files: [FileReceipt] = []
}

/// The headless half of a `link/1` — what a resident counterpart does when the
/// person who would tap the buttons is a test.
///
/// **Why this type has to exist at all, and it is a defect rather than a
/// convenience.** `LanDiscoveryModel` announces `link/1` in the code-less room
/// on any build where `LINK_BUILD_SUPPORT` is true, and that constant is true
/// for `os(macOS)` — which `LocalTransferPeer` is. So `AppReceiverHost` already
/// announced the capability before this file existed, while composing no
/// `LinkWorkspaceModel` at all: it promised a wire it had nothing to answer
/// with. T2a never saw it, because T2a's counterpart is `PlainPeer`, which
/// announces `[TEXT_CAPABILITY]` at most and is therefore legacy in every room.
/// The first client to take the announcement seriously is a built App, which is
/// exactly what T2b drives — the app would offer Connect, dial a two-channel
/// link offer, and time out against a peer that never had a link surface.
/// `PeerCapabilityRegistry`'s own doc comment names this failure ("announce
/// `link/1` and then fail the establishment it invited") as the reason the build
/// flag is compiled per platform. The fix is to keep the promise, not to silence
/// the announcement: the shipped apps compose both the legacy receive machinery
/// and a link workspace on one room socket, so the acceptance counterpart
/// composes both too.
///
/// **What is a POLICY here rather than production code.** Five decisions a
/// person makes on screen are made here without one, and each is the decision
/// the acceptance run is *not* about:
///
///  - an unsolicited link is admitted (`shouldAcceptLink`), because a resident
///    counterpart with no surface to arbitrate has nothing to refuse for;
///  - the surface is permanently available (`setAvailableForInboundLink`),
///    because there is no second surface to lose it to;
///  - a pending SAS is confirmed, so a run against a peer whose own preference
///    is ON does not hang. The shipped default is OFF, so this normally never
///    fires; it is here so the policy is stated rather than depended on;
///  - an offered inbound batch is accepted;
///  - a finished link is DISMISSED, which is the headless equivalent of the user
///    tapping Done. Without it the workspace stays `.ended` with the last link's
///    `fileModel` and `textModel` still attached, and the counterpart serves
///    exactly one link per process — every later one meeting a dead peer whose
///    stale projections still answer questions about it.
///
/// None of them weakens what the run evidences. Each is on the RECEIVING side of
/// a decision the built App is making, and the digests compared afterwards are
/// of bytes the app's own lanes moved. What this must never do is fabricate a
/// receipt, shorten a wait, or answer for the app — so every value it reports is
/// read back from the model the production writer filled in.
@MainActor
public final class LinkCounterpart {

    private let link: LinkWorkspaceModel
    private var observers: Set<AnyCancellable> = []

    /// The link being served now, or the last one if none is.
    public private(set) var current = LinkRecord(epoch: 0)

    /// Where this counterpart narrates what it observed, or nil to stay silent.
    ///
    /// A resident counterpart is the only witness to a link that failed before
    /// the app could show anything about it, and a run whose diagnosis could not
    /// say WHICH transition it stopped on leaves a timeout to be attributed to
    /// whichever assertion happened to be first. Injected rather than imported,
    /// so this type stays independent of the executable's own logging.
    public var logEvent: ((String) -> Void)?

    /// Every link that has ended, oldest first, each frozen as it was.
    ///
    /// Kept rather than discarded because the evidence outlives the link: a
    /// launcher's final check runs after the app has gone, and a counterpart
    /// that forgot a completed transfer on dismissal would report nothing about
    /// the very run it just served.
    public private(set) var completed: [LinkRecord] = []

    public init(link: LinkWorkspaceModel) {
        self.link = link
    }

    /// Attach the headless answers. Call once, before the room is joined.
    public func start() {
        // Advisory, and true forever: the authoritative gate below is what
        // actually admits, and this side has no second surface that could own
        // the workspace instead.
        link.setAvailableForInboundLink(true)
        link.shouldAcceptLink = { _ in true }

        link.$connection
            .sink { [weak self] connection in
                MainActor.assumeIsolated { self?.connectionChanged(connection) }
            }
            .store(in: &observers)

        // The file and text models do not exist until an attempt is assembled,
        // so the subscription is to the OPTIONAL that holds them and is renewed
        // per link. A sink installed once on `link.fileModel` would have been
        // installed on nil and would never fire.
        link.$fileModel
            .sink { [weak self] model in
                MainActor.assumeIsolated { self?.fileModelChanged(model) }
            }
            .store(in: &observers)

        link.$textModel
            .sink { [weak self] model in
                MainActor.assumeIsolated { self?.textModelChanged(model) }
            }
            .store(in: &observers)
    }

    private func connectionChanged(_ connection: LinkWorkspaceConnection) {
        switch connection {
        case .requesting, .establishing, .open:
            // A link has been CLAIMED for a peer. `hasPeer` is the projection's
            // own word for that, and the epoch turns over exactly once per link
            // because `beginEpochIfNeeded` is idempotent within one.
            beginEpochIfNeeded()
        case .idle, .watching:
            break
        case .ended:
            endEpoch()
        }

        switch connection {
        case let .establishing(sas?), let .open(sas):
            current.sas = sas
        default:
            break
        }

        // Only ever fires when this side's OWN preference requires it, which the
        // throwaway defaults domain leaves at the shipped default of off.
        if link.isVerificationPending { link.confirmSAS() }

        // `actionError` and `signalingLost` travel with the phase because
        // `.failed` on its own names no cause: an establishment that dies in
        // under a second and one that times out both arrive here as `.failed`,
        // and only the model's own error text separates them.
        logEvent?("link: \(connection) epoch=\(current.epoch)"
                  + " error=\(link.actionError ?? "-")"
                  + " signalingLost=\(link.signalingLost)")
    }

    private var inEpoch = false

    private func beginEpochIfNeeded() {
        guard !inEpoch else { return }
        inEpoch = true
        current = LinkRecord(epoch: current.epoch + 1)
    }

    /// Freeze what this link produced, then hand the workspace back to idle.
    ///
    /// The freeze happens BEFORE `dismiss()`, and the order is the whole point:
    /// `dismiss()` releases `fileModel` and `textModel`, which are where the
    /// receipts and the transcript are read from.
    ///
    /// **`dismiss()` is unconditional, and the freeze is what is guarded.** It
    /// was the other way round, and the counterpart wedged: an `.ended` observed
    /// with no epoch open — a second `.ended` for one attempt, or an
    /// establishment that failed before this side ever reached `.establishing` —
    /// returned early and left `dismiss()` uncalled. `LinkWorkspaceModel` serves
    /// one link at a time and only `dismiss()` moves a terminal one out of the
    /// way, so the workspace stayed `.ended(failed)` for the life of the
    /// process and every later request met a surface that already had a session.
    /// That is exactly what a full acceptance run observed: the counterpart
    /// finished stuck in `ended(failed)`, and the NEXT test's precondition —
    /// "the counterpart returned to idle" — timed out against it.
    ///
    /// Dismissing without an epoch is safe: `dismiss()` is itself guarded on
    /// `.ended`, and freezing is what must not happen twice.
    ///
    /// **The dismissal happens on the NEXT main-actor turn, and that is
    /// load-bearing rather than tidy.** `@Published` publishes in `willSet`, so
    /// inside this sink `link.connection` still holds the value from BEFORE
    /// `.ended` — and `dismiss()` opens with `guard case .ended = connection`.
    /// Called inline it therefore returned silently every single time, and the
    /// counterpart served exactly one link per process: the workspace stayed
    /// terminal, and `LinkWorkspaceModel` serves one link at a time, so every
    /// later request met a surface that already had a session and failed
    /// instantly. A full acceptance run showed that as ten consecutive
    /// `requesting → establishing → ended(failed)` cycles inside thirty seconds,
    /// with no `idle` between them and none after the last — the retry bound in
    /// `LinkRoomRouter` (one request plus nine retries) spelled out on the
    /// receiving side. The freeze above still reads the live models, because at
    /// `willSet` time they are exactly the ones this link filled in.
    private func endEpoch() {
        if inEpoch {
            inEpoch = false
            current.files = liveReceipts()
            completed.append(current)
        }
        Task { @MainActor [link] in link.dismiss() }
    }

    private var fileObserver: AnyCancellable?

    private func fileModelChanged(_ model: LinkFilePresentationModel?) {
        fileObserver = model?.$batches
            .sink { [weak self] batches in
                MainActor.assumeIsolated { self?.batchesChanged(batches) }
            }
    }

    /// Consent to a manifest, once per offer.
    ///
    /// `acceptInboundBatch` re-reads `acceptsWork` and the lane's own state, so
    /// calling it on a snapshot that still says `.offered` after the accept was
    /// already sent is a no-op rather than a second accept.
    private func batchesChanged(_ batches: [LinkFileBatch]) {
        guard batches.contains(where: { $0.direction == .inbound && $0.state == .offered })
        else { return }
        link.acceptInboundBatch()
    }

    private var textObserver: AnyCancellable?
    private var phaseObserver: AnyCancellable?

    private func textModelChanged(_ model: LinkSessionPresentationModel?) {
        textObserver = model?.$textMessages
            .sink { [weak self] messages in
                MainActor.assumeIsolated {
                    self?.current.messages = messages
                        .filter { $0.direction == .incoming }
                        .map(\.body)
                }
            }
        // The ATTEMPT's own phase, not the workspace's. `LinkWorkspaceConnection`
        // collapses every unpublished ending into `.failed`, which is the one
        // thing a diagnosis of a link that died before it could show anything
        // needs to be able to tell apart: `establishmentFailed`,
        // `establishmentClosed`, `stopped` and `wiringFailed` have four different
        // causes and one workspace rendering.
        phaseObserver = model?.$phase
            .sink { [weak self] phase in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.logEvent?("attempt: \(phase) epoch=\(self.current.epoch)")
                }
            }
    }

    /// The live link's receipts, or the frozen ones once it has ended.
    public func receipts() -> [FileReceipt] {
        inEpoch ? liveReceipts() : current.files
    }

    /// What the link's own writer left on disk, per committed inbound batch.
    ///
    /// Re-read from the files rather than reported from the batch's manifest,
    /// for the reason `fileReceipts` records: a receipt derived from what was
    /// announced holds just as well for a writer that announced and never
    /// flushed.
    private func liveReceipts() -> [FileReceipt] {
        guard let model = link.fileModel else { return [] }
        return model.batches
            .filter { $0.direction == .inbound }
            .flatMap { batch -> [FileReceipt] in
                guard let files = batch.receivedFiles else { return [] }
                let base = (batch.receivedContainer ?? files.first?.deletingLastPathComponent())?
                    .standardized.path
                return files.map { url in
                    let full = url.standardized.path
                    let relative = base.map { base in
                        full.hasPrefix(base + "/")
                            ? String(full.dropFirst(base.count + 1)) : full
                    } ?? full
                    let size = (try? FileManager.default
                        .attributesOfItem(atPath: url.path))?[.size] as? Int
                    return FileReceipt(name: url.lastPathComponent,
                                       path: relative == url.lastPathComponent ? nil : relative,
                                       size: size ?? -1,
                                       sha256: sha256Hex(contentsOf: url) ?? "")
                }
            }
    }

    /// Every receipt this counterpart has taken, across every link it served.
    ///
    /// What a launcher checks after the app has gone: by then the live link has
    /// ended and been dismissed, so the only honest total is the archive plus
    /// whatever is live.
    public func allReceipts() -> [FileReceipt] {
        completed.flatMap(\.files) + (inEpoch ? liveReceipts() : [])
    }

    public func allMessages() -> [String] {
        completed.flatMap(\.messages) + (inEpoch ? current.messages : [])
    }
}
