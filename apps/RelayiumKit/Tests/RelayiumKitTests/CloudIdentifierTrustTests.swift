import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// Ids a server must never be able to talk this app into acting on.
///
/// Not an abstract charset sweep: each one changes the MEANING of the string it
/// is composed into rather than its value. `../me` and `a/b` add path segments
/// to a PATCH or a DELETE; `a?b` and `a#b` truncate a URL at a delimiter and, in
/// a `/d/<id>#k=<key>` link, would move or orphan the key fragment; whitespace
/// and `a\u{0}b` break the token in a keychain attribute; `ключ` is outside the
/// ASCII any of these composed forms is defined over; empty and 129 characters
/// are the two length bounds.
let hostileStoredObjectIDs = [
    "../other",
    "..",
    "a/b",
    "/api/me",
    "a?b",
    "a#b",
    "a%2fb",
    "a.b",
    " ",
    "a b",
    "a\nb",
    "a\u{0}b",
    "ключ",
    "",
    String(repeating: "a", count: 129),
]

/// Records every call so a test can prove one did NOT happen. Its ids are
/// injectable: `initUpload` and `finalizeUpload` are two separate answers from
/// the server and two separate trust boundaries.
private final class IdentifierTransport: ResumableTransport, @unchecked Sendable {
    var initId = "up1"
    var finalizeId = "fid"
    var chunkSize = 64 * 1024

    private(set) var patchCalls = 0
    private(set) var offsetCalls = 0
    private(set) var finalizeCalls = 0
    private var committed = 0

    func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        (initId, chunkSize)
    }

    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String,
                    onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
        patchCalls += 1
        committed += bytes.count
        return .committed(received: committed)
    }

    func uploadOffset(uploadId: String, token: String) async throws -> Int {
        offsetCalls += 1
        return committed
    }

    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        finalizeCalls += 1
        return UploadResult(id: finalizeId, expiresAt: 4242)
    }

    var touchedTheUpload: Bool { patchCalls > 0 || offsetCalls > 0 || finalizeCalls > 0 }
}

/// A server with no `/api/uploads` — the only thing that legitimately reaches
/// the single-shot fallback.
private struct NoResumableEndpointTransport: ResumableTransport {
    func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        throw CloudError.server(status: 404)
    }
    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String,
                    onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
        XCTFail("the fallback path must not PATCH")
        return .committed(received: 0)
    }
    func uploadOffset(uploadId: String, token: String) async throws -> Int { 0 }
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        XCTFail("the fallback path must not finalize")
        return UploadResult(id: "x", expiresAt: 0)
    }
}

private func oneSource() -> [PlaintextSource] {
    [DataSource(name: "a", bytes: [UInt8](repeating: 0x5A, count: 4096))]
}

final class CloudIdentifierTrustTests: XCTestCase {

    // MARK: - the rule itself

    func testTheSharedRuleRefusesEveryHostileIdentifier() {
        for id in hostileStoredObjectIDs {
            XCTAssertThrowsError(try StoredObjectID.checked(id), "id \(id.debugDescription)") {
                XCTAssertEqual($0 as? StoredLinkKeyError, .invalidIdentifier,
                               "id \(id.debugDescription)")
            }
        }
    }

    /// The other half of the same rule: it has to be narrow enough to refuse the
    /// above and wide enough that nothing the server actually issues is caught.
    /// `authx.NewID()` is 32 hex characters; 128 is the inclusive upper bound.
    func testTheSharedRuleAcceptsEveryLegitimateIdentifier() throws {
        for id in ["0f9a1b2c3d4e5f60718293a4b5c6d7e8", "A-Za-z0-9_-", "a",
                   String(repeating: "a", count: 128)] {
            XCTAssertEqual(try StoredObjectID.checked(id), id, "id \(id.debugDescription)")
        }
    }

    // MARK: - the resumable init id

    /// The id `initUpload` hands back is appended as a URL path component by
    /// every call that follows it. If it is refused, none of those calls may
    /// happen — not one PATCH, not one offset read, not the finalize.
    func testAHostileInitIdentifierSendsNothingAtAll() async {
        for id in hostileStoredObjectIDs {
            let t = IdentifierTransport()
            t.initId = id
            let u = CloudUploader(transport: t)
            do {
                _ = try await u.upload(sources: oneSource(), burnAfterRead: false,
                                       ttl: 3600, token: "tok", onProgress: { _, _ in })
                XCTFail("init id \(id.debugDescription) was accepted")
            } catch {
                XCTAssertEqual(error as? StoredLinkKeyError, .invalidIdentifier,
                               "init id \(id.debugDescription)")
            }
            XCTAssertFalse(t.touchedTheUpload,
                           """
                           init id \(id.debugDescription) reached the upload: \
                           \(t.patchCalls) PATCH, \(t.offsetCalls) offset, \(t.finalizeCalls) finalize
                           """)
        }
    }

    /// A refused id is a trust-boundary failure, not an old server. Falling
    /// through to the single-shot path would send every byte a second time in
    /// answer to a malformed reply, and the retry inside `patchWithRetry` would
    /// be re-asking a question that cannot come back different.
    func testAHostileInitIdentifierDoesNotFallBackToSingleShot() async {
        for id in hostileStoredObjectIDs {
            let t = IdentifierTransport()
            t.initId = id
            let u = CloudUploader(transport: t)
            var fellBack = false
            do {
                _ = try await u.uploadResumable(
                    sources: oneSource(),
                    singleShot: { _, _, _ in
                        fellBack = true
                        return SingleShotResult(result: UploadResult(id: "single", expiresAt: 7),
                                                keyB64url: "K")
                    },
                    burnAfterRead: false, ttl: 3600, token: "tok", onProgress: { _, _ in })
                XCTFail("init id \(id.debugDescription) was accepted")
            } catch {
                XCTAssertEqual(error as? StoredLinkKeyError, .invalidIdentifier,
                               "init id \(id.debugDescription)")
            }
            XCTAssertFalse(fellBack, "init id \(id.debugDescription) triggered the fallback")
            XCTAssertFalse(t.touchedTheUpload, "init id \(id.debugDescription) reached the upload")
        }
    }

    // MARK: - the finalize id

    /// The id the finalize returns is the one that becomes a keychain account
    /// name and the `/d/<id>` shown to the user. No `UploadOutcome` may carry
    /// one this app would refuse to act on.
    func testAHostileFinalizeIdentifierNeverEscapesAsAnOutcome() async {
        for id in hostileStoredObjectIDs {
            let t = IdentifierTransport()
            t.finalizeId = id
            let u = CloudUploader(transport: t)
            do {
                let out = try await u.upload(sources: oneSource(), burnAfterRead: false,
                                             ttl: 3600, token: "tok", onProgress: { _, _ in })
                XCTFail("finalize id \(id.debugDescription) escaped as \(out.id.debugDescription)")
            } catch {
                XCTAssertEqual(error as? StoredLinkKeyError, .invalidIdentifier,
                               "finalize id \(id.debugDescription)")
            }
        }
    }

    /// And the failure it raises is still the terminal kind: a bad finalize id
    /// must not send the same bytes again down the fallback either.
    func testAHostileFinalizeIdentifierDoesNotFallBackToSingleShot() async {
        let t = IdentifierTransport()
        t.finalizeId = "../other"
        let u = CloudUploader(transport: t)
        var fellBack = false
        do {
            _ = try await u.uploadResumable(
                sources: oneSource(),
                singleShot: { _, _, _ in
                    fellBack = true
                    return SingleShotResult(result: UploadResult(id: "single", expiresAt: 7),
                                            keyB64url: "K")
                },
                burnAfterRead: false, ttl: 3600, token: "tok", onProgress: { _, _ in })
            XCTFail("a hostile finalize id was accepted")
        } catch {
            XCTAssertEqual(error as? StoredLinkKeyError, .invalidIdentifier)
        }
        XCTAssertFalse(fellBack, "a hostile finalize id triggered the fallback")
    }

    // MARK: - the legacy single-shot fallback

    /// The fallback reaches a different endpoint on an older server, so its
    /// result is a trust boundary of its own and gets the same check.
    func testAHostileFallbackIdentifierNeverEscapesAsAnOutcome() async {
        for id in hostileStoredObjectIDs {
            let u = CloudUploader(transport: NoResumableEndpointTransport())
            do {
                let out = try await u.uploadResumable(
                    sources: [DataSource(name: "a", bytes: [1, 2, 3])],
                    singleShot: { _, _, _ in
                        SingleShotResult(result: UploadResult(id: id, expiresAt: 7), keyB64url: "K")
                    },
                    burnAfterRead: false, ttl: 3600, token: "tok", onProgress: { _, _ in })
                XCTFail("fallback id \(id.debugDescription) escaped as \(out.id.debugDescription)")
            } catch {
                XCTAssertEqual(error as? StoredLinkKeyError, .invalidIdentifier,
                               "fallback id \(id.debugDescription)")
            }
        }
    }

    /// The fallback still works for the ids a real old server issues — the
    /// refusal above must not have closed the only path a pre-`/api/uploads`
    /// deployment has.
    func testTheFallbackStillAcceptsALegitimateIdentifier() async throws {
        let u = CloudUploader(transport: NoResumableEndpointTransport())
        let out = try await u.uploadResumable(
            sources: [DataSource(name: "a", bytes: [1, 2, 3])],
            singleShot: { _, _, _ in
                SingleShotResult(result: UploadResult(id: "0f9a1b2c3d4e5f60718293a4b5c6d7e8",
                                                      expiresAt: 7),
                                 keyB64url: "K")
            },
            burnAfterRead: false, ttl: 3600, token: "tok", onProgress: { _, _ in })
        XCTAssertEqual(out.id, "0f9a1b2c3d4e5f60718293a4b5c6d7e8")
        XCTAssertEqual(out.keyB64url, "K")
    }
}

/// The model-level half. `UploadOutcome` is a plain public struct, so the
/// uploader's refusal is not the only thing standing between a hostile id and
/// the screen — and the last step before it becomes a link is here.
@MainActor
final class CloudUploadModelIdentifierTrustTests: XCTestCase {
    private var keys = InMemoryStoredLinkKeyStore()

    override func setUp() { keys = InMemoryStoredLinkKeyStore() }

    private func makeModel() -> CloudUploadModel {
        CloudUploadModel(uploader: CloudUploader(transport: IdentifierTransport()),
                         keyStore: keys,
                         origin: "https://relayium.com")
    }

    /// Neither persisted nor shown. The second half is the one that matters:
    /// the store refuses a hostile id on its own, and the defect this pins is
    /// that the refused id was then interpolated into the link anyway and
    /// presented as a working `.done`.
    func testAHostileOutcomeIdentifierIsNeitherStoredNorShown() async {
        for id in hostileStoredObjectIDs {
            let m = makeModel()
            await m.applyOutcome(UploadOutcome(id: id, expiresAt: 99, keyB64url: "KEY"))
            guard case .failed(let message) = m.state else {
                return XCTFail("id \(id.debugDescription) was presented as \(m.state)")
            }
            XCTAssertFalse(message.isEmpty, "id \(id.debugDescription) failed with no explanation")
            // Nothing was filed under it.
            let stored = try? await keys.key(for: id)
            XCTAssertNil(stored ?? nil, "a key was stored for \(id.debugDescription)")
        }
    }

    /// The state must not merely lack a link — it must not be `.done` at all.
    /// `.done` is what the pane renders as "Link ready", and claiming an upload
    /// succeeded when its identifier was refused is the failure this whole
    /// change exists to prevent.
    func testAHostileOutcomeIdentifierIsNeverReportedAsSuccess() async {
        let m = makeModel()
        await m.applyOutcome(UploadOutcome(id: "../other", expiresAt: 99, keyB64url: "KEY"))
        if case .done = m.state { XCTFail("a refused id was reported as a completed upload") }
    }

    /// And it says something true and localized rather than a type name. This is
    /// the sentence the app already has for an id it will not act on; the
    /// upload's object really is on the server, so "manage it on relayium.com"
    /// is the actionable half rather than a deflection.
    func testTheRefusalUsesTheExistingLocalizedIdentifierCopy() async {
        let m = makeModel()
        await m.applyOutcome(UploadOutcome(id: "a/b", expiresAt: 99, keyB64url: "KEY"))
        guard case .failed(let message) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(message, ErrorCopy.message(for: StoredLinkKeyError.invalidIdentifier))
        XCTAssertFalse(message.contains("StoredLinkKeyError"),
                       "the unknown-error fallback was used: \(message)")
    }

    /// Generation semantics are unchanged by the check. A superseded result is
    /// silent whether its id was good or hostile — the user has moved on, and
    /// repainting a screen they left is the bug the generation counter exists
    /// for.
    func testASupersededHostileOutcomeDoesNotRepaint() async {
        let m = makeModel()
        let stale = m.currentGeneration
        m.reset()                                   // bumps the generation
        XCTAssertNotEqual(stale, m.currentGeneration, "precondition: the generation moved")
        await m.finish(UploadOutcome(id: "../other", expiresAt: 99, keyB64url: "KEY"), g: stale)
        if case .failed = m.state {
            XCTFail("a superseded hostile result repainted the screen as failed")
        }
    }

    /// The valid path is untouched: key first, then the link, then the state.
    func testALegitimateIdentifierStillStoresItsKeyAndShowsItsLink() async throws {
        let m = makeModel()
        let id = "0f9a1b2c3d4e5f60718293a4b5c6d7e8"
        await m.applyOutcome(UploadOutcome(id: id, expiresAt: 99, keyB64url: "KEY"))
        guard case .done(let link, let exp, let warning) = m.state else {
            return XCTFail("a legitimate id was reported as \(m.state)")
        }
        XCTAssertEqual(link, "https://relayium.com/d/\(id)#k=KEY")
        XCTAssertEqual(exp, 99)
        XCTAssertNil(warning)
        let stored = try await keys.key(for: id)
        XCTAssertEqual(stored, "KEY")
    }
}
