import Foundation
import RelayiumKit

/// The Device Inbox v2 manifest one staged delivery seals at frame 0.
///
/// The single place a `PendingUploadPlan` becomes a manifest, and deliberately a
/// pure function of the plan alone — no clock, no network, no in-memory state
/// left over from the attempt that staged it. Three properties follow from that,
/// and each is the answer to a real failure:
///
///  1. **Every attempt seals the same document.** A retry, a reseal after a key
///     rotation, and a restart after the idle reaper all rebuild the manifest
///     from the same durable plan, so none of them can produce a delivery of a
///     different kind — or a different item order — than the attempt before it.
///  2. **A resume in a fresh process is correct.** The staging process may be
///     long gone; everything this needs is on disk.
///  3. **There is no fall-back.** The shared Stored-Wire manifest is not
///     reachable from here at all. A delivery whose plan cannot produce a valid
///     v2 manifest fails, rather than quietly sealing the document its own
///     receiver refuses as `verify_failed`.
///
/// **A plan is not asked whether it is a v2 plan here.** That precondition
/// belongs one level up: `InboxSendCoordinator` restarts a delivery staged
/// before v2 — new content key, no session, no object — before it ever builds a
/// manifest. Refusing it here instead would classify the user's staged bytes as
/// unsendable content, which is the one answer that releases them.
///
/// **Item order is the plan's, never sorted.** `PendingUploadStore` stages
/// sources in selection order and `sources(for:)` reads them back in that same
/// order, so manifest item *i* describes the payload frames of staged file *i*.
/// Sorting here would silently rename every file in a folder send.
public enum InboxSendManifest {

    /// The manifest for one delivery, validated against every §8-§10 bound.
    ///
    /// Throws `InboxManifestError` when the plan describes something no receiver
    /// would accept — a traversal name, an oversized message, an item count past
    /// the ceiling — which is the honest outcome: it would have been refused
    /// after the upload instead.
    public static func manifest(for plan: PendingUploadPlan) throws -> InboxManifestV2 {
        guard plan.effectivePurpose == .deviceTask else {
            // A share's frame 0 is the shared manifest. Reaching here with one
            // would mean a caller had already decided to seal the wrong
            // document; refusing is the only safe answer.
            throw InboxManifestError.malformed
        }
        switch plan.effectiveDeliveryKind {
        case .file:
            return try InboxManifest.files(plan.files.map { (name: $0.name, size: $0.size) })
        case .text:
            // ONE item, and its size only. The message's bytes are the payload
            // frames; putting them here would make the manifest's size a
            // function of its content and would put plaintext into the one
            // structure a receiver parses before it has decided the delivery is
            // safe to accept.
            guard plan.files.count == 1 else { throw InboxManifestError.textItemCount }
            return try InboxManifest.text(size: plan.files[0].size)
        }
    }

    /// The same manifest, in the form `CloudUploader` seals at frame 0.
    public static func sealed(for plan: PendingUploadPlan) throws -> UploadManifest {
        .sealed(try InboxManifest.encode(try manifest(for: plan)))
    }
}
