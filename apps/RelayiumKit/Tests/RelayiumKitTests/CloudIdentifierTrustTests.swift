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
/// are the two length bounds. `a\n` is the trailing-newline form specifically:
/// a link's surrounding whitespace is trimmed, so a newline INSIDE the
/// identifier is the one that survives to be composed into a request.
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
    "a\n",
    "a\u{0}b",
    "ключ",
    "",
    String(repeating: "a", count: 129),
]

/// Ids the server really issues, plus both edges of what the rule allows.
let legitimateStoredObjectIDs = [
    "0f9a1b2c3d4e5f60718293a4b5c6d7e8",     // authx.NewID(): 32 hex
    "A-Za-z0-9_-",                          // every allowed character class
    "a",                                    // the short edge
    String(repeating: "a", count: 128),     // the inclusive long edge
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

// MARK: - the INBOUND half: an id that arrives from a shared link
//
// Everything above is an id this app was handed by the server it just uploaded
// to. The rest is the other direction, which is the wider boundary: the id in a
// `…/d/<id>#k=<key>` link is supplied by whoever produced the link — a sender,
// a page, a chat message, a Universal Link handoff — and it is composed into
// `/api/files/<id>/meta` and `/api/files/<id>/blob` by the same
// `appendingPathComponent` that percent-encodes neither `/` nor `.`.

/// A pasted `…/d/<id>#k=<key>` for every hostile id, in both spellings a link
/// can carry one.
///
/// The percent-encoded twin is not decoration — it is the only spelling that
/// works for most of these. `URL.path` DECODES before `parseTransferLink`
/// splits it, so `a%3Fb`, `a%23b`, `a%0Ab` and `a%00b` arrive as `a?b`, `a#b`,
/// `a\nb` and `a\0b`: identifiers whose raw spelling the URL grammar would
/// otherwise have eaten at a delimiter. `%2e%2e` is likewise how `..` reaches
/// the identifier past anything that resolves dot segments in the raw form.
private func hostileDownloadLinks() -> [String] {
    hostileStoredObjectIDs.flatMap { id -> [String] in
        let encoded = Data(id.utf8).map { String(format: "%%%02X", $0) }.joined()
        return [id, encoded].map { "https://relayium.com/d/\($0)#k=KEY" }
    }.filter { $0 != queryDelimitedLink }
}

/// The one link above that is NOT a refusal, and must not be asserted as one.
/// In the URL grammar `…/d/a?b#k=KEY` genuinely denotes the id `a` with a query
/// `b` — the `?b` is never part of the identifier, so there is nothing to
/// refuse. Its encoded twin `a%3Fb` IS an identifier containing `?`, and stays
/// in the corpus. Pinned by its own test below so this exclusion cannot quietly
/// grow into "the parser accepts query strings in ids".
private let queryDelimitedLink = "https://relayium.com/d/a?b#k=KEY"

final class SharedLinkIdentifierTrustTests: XCTestCase {

    /// The link parser is the first boundary a recipient-supplied id crosses,
    /// and it must refuse synchronously — before `resolve()` has a `ParsedLink`
    /// to build a request from.
    func testTheLinkParserRefusesEveryHostileIdentifier() {
        for link in hostileDownloadLinks() {
            XCTAssertNil(parseTransferLink(link), link.debugDescription)
        }
    }

    /// The documented exception, pinned rather than excluded silently: the id
    /// really is `a`, which is inert.
    func testAQueryDelimiterIsNotPartOfTheIdentifier() {
        XCTAssertEqual(parseTransferLink(queryDelimitedLink),
                       ParsedLink(id: "a", keyB64url: "KEY"))
    }

    /// Every legitimate link still parses, including both length edges — the
    /// refusal above must not have narrowed what a real share link may carry.
    func testTheLinkParserStillAcceptsEveryLegitimateIdentifier() {
        for id in legitimateStoredObjectIDs {
            XCTAssertEqual(parseTransferLink("https://relayium.com/d/\(id)#k=KEY"),
                           ParsedLink(id: id, keyB64url: "KEY"), id.debugDescription)
        }
        // The properties the parser already had, re-asserted beside the new
        // rule because they are what a too-eager refusal would break first.
        XCTAssertEqual(parseTransferLink("  https://relayium.com/d/x#k=Y \n"),
                       ParsedLink(id: "x", keyB64url: "Y"))
        XCTAssertEqual(parseTransferLink("https://files.example.org/d/zz#k=QQ"),
                       ParsedLink(id: "zz", keyB64url: "QQ"))
    }

    /// The production handoff. `parseAppDeepLink` reaches the same ids through
    /// an OS-delivered Universal Link, which is the one path where the app acts
    /// on a URL nobody in this process typed.
    func testTheProductionDeepLinkRefusesEveryHostileIdentifier() {
        var constructed = 0
        for link in hostileDownloadLinks() {
            guard let url = URL(string: link) else { continue }
            constructed += 1
            XCTAssertNil(parseAppDeepLink(url), link.debugDescription)
        }
        XCTAssertGreaterThan(constructed, 0, "no hostile link was even constructible")
    }

    func testTheProductionDeepLinkStillAcceptsALegitimateIdentifier() {
        for id in legitimateStoredObjectIDs {
            let url = URL(string: "https://relayium.com/d/\(id)#k=KEY")!
            XCTAssertEqual(parseAppDeepLink(url), .download(url), id.debugDescription)
        }
    }
}

/// The network boundary itself. `CloudClient` is public and its id parameter is
/// a plain `String`, so the parser's refusal is not the only thing between a
/// hostile id and a request: `resolve()` is one caller, and any other caller —
/// present or future, in this package or outside it — can reach `fetchMeta` and
/// `download` without going through `parseTransferLink` at all.
final class CloudClientIdentifierTrustTests: XCTestCase {
    private func client() -> CloudClient {
        CloudClient(baseURL: URL(string: "https://relayium.test")!,
                    session: StubURLProtocol.session())
    }

    /// A server that answers ANY path with a complete, valid transfer: the
    /// encrypted manifest on `/meta`, the real framed ciphertext everywhere
    /// else.
    ///
    /// Deliberately not a 404 or an empty body. "No chunk was delivered" is
    /// only evidence if chunks WOULD have been delivered had the request gone
    /// out — against a stub that fails anyway, the assertion passes whether or
    /// not the check exists.
    private func serveAWorkingTransfer(_ v: Vectors) {
        let encManifestB64 = Data(v.hex("manifest.ctHex")).base64EncodedString()
        let meta = #"{"encManifest":"\#(encManifestB64)","size":54,"burnAfterRead":false,"expiresAt":1790000000}"#
        StubURLProtocol.router = { req in
            req.url?.path.hasSuffix("/meta") == true
                ? .init(status: 200, body: Data(meta.utf8), check: nil)
                : .init(status: 200, body: Data(v.hex("streamHex")), check: nil)
        }
    }

    override func setUp() { StubURLProtocol.reset() }

    override func tearDown() {
        StubURLProtocol.router = nil
        StubURLProtocol.stub = nil
        StubURLProtocol.reset()
    }

    /// Nothing leaves. Not a HEAD, not a probe — the id never becomes a URL.
    func testFetchMetaWithAHostileIdentifierSendsNothingAtAll() async throws {
        let v = try Vectors.load("store-wire-vectors")
        serveAWorkingTransfer(v)
        for id in hostileStoredObjectIDs {
            StubURLProtocol.reset()
            do {
                _ = try await client().fetchMeta(id: id)
                XCTFail("meta id \(id.debugDescription) was accepted")
            } catch {
                XCTAssertEqual(error as? StoredLinkKeyError, .invalidIdentifier,
                               "meta id \(id.debugDescription)")
            }
            XCTAssertEqual(StubURLProtocol.requestCount, 0,
                           """
                           meta id \(id.debugDescription) reached the transport as \
                           \(StubURLProtocol.observed.map { $0.url?.absoluteString ?? "?" })
                           """)
        }
    }

    /// The same for the download, which composes the id into a SECOND URL — the
    /// blob — after the meta round trip. Both must be unreachable, and no
    /// plaintext may be handed to the caller on the way.
    func testDownloadWithAHostileIdentifierSendsNothingAndYieldsNoPlaintext() async throws {
        let v = try Vectors.load("store-wire-vectors")
        serveAWorkingTransfer(v)
        for id in hostileStoredObjectIDs {
            StubURLProtocol.reset()
            var chunks = 0
            do {
                _ = try await client().download(id: id, key: v.hex("keyHex")) { _ in chunks += 1 }
                XCTFail("download id \(id.debugDescription) was accepted")
            } catch {
                XCTAssertEqual(error as? StoredLinkKeyError, .invalidIdentifier,
                               "download id \(id.debugDescription)")
            }
            XCTAssertEqual(StubURLProtocol.requestCount, 0,
                           """
                           download id \(id.debugDescription) reached the transport as \
                           \(StubURLProtocol.observed.map { $0.url?.absoluteString ?? "?" })
                           """)
            XCTAssertEqual(chunks, 0,
                           "download id \(id.debugDescription) delivered \(chunks) chunk(s)")
        }
    }

    /// The valid path is byte-for-byte what it was: the same two endpoints, in
    /// the same order, with the id interpolated verbatim — and the plaintext
    /// still comes back out. Without this, refusing everything would pass.
    func testALegitimateIdentifierStillReachesTheSameEndpointsVerbatim() async throws {
        let v = try Vectors.load("store-wire-vectors")
        serveAWorkingTransfer(v)
        for id in legitimateStoredObjectIDs {
            StubURLProtocol.reset()
            var got = [UInt8]()
            let manifest = try await client().download(id: id, key: v.hex("keyHex")) { got += $0 }
            XCTAssertEqual(got, v.fileDatas().flatMap { $0 }, id.debugDescription)
            XCTAssertEqual(manifest.files.map(\.name), ["hello.txt", "ab.txt"], id.debugDescription)
            XCTAssertEqual(StubURLProtocol.observed.map { $0.url?.path ?? "" },
                           ["/api/files/\(id)/meta", "/api/files/\(id)/blob"],
                           id.debugDescription)
        }
    }

    func testALegitimateIdentifierStillFetchesItsMeta() async throws {
        let v = try Vectors.load("store-wire-vectors")
        serveAWorkingTransfer(v)
        let id = "0f9a1b2c3d4e5f60718293a4b5c6d7e8"
        let meta = try await client().fetchMeta(id: id)
        XCTAssertEqual(meta.expiresAt, 1_790_000_000)
        XCTAssertEqual(StubURLProtocol.observed.map { $0.url?.path ?? "" },
                       ["/api/files/\(id)/meta"])
    }
}

/// And the model that a pasted link actually goes through.
@MainActor
final class CloudDownloadModelIdentifierTrustTests: XCTestCase {
    private func makeModel() -> CloudDownloadModel {
        CloudDownloadModel(client: CloudClient(baseURL: URL(string: "https://relayium.test")!,
                                               session: StubURLProtocol.session()))
    }

    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-idtrust-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    override func setUp() {
        StubURLProtocol.reset()
        // A 200 for anything that escapes. Note that reaching it would still
        // end in `.failed` — the body does not decode — so the state alone
        // cannot tell a refusal from a round trip that failed later. That is
        // what the message and `requestCount` assertions below are for.
        StubURLProtocol.stub = .init(status: 200, body: Data("{}".utf8), check: nil)
    }

    override func tearDown() {
        StubURLProtocol.stub = nil
        StubURLProtocol.router = nil
        StubURLProtocol.reset()
    }

    /// A hostile link is bad INPUT, not a failed transfer: it is refused
    /// synchronously, with the copy that describes the expected link shape, and
    /// no task is ever started.
    func testResolvingAHostileLinkFailsAsBadInputWithoutAnyNetworkActivity() async {
        for link in hostileDownloadLinks() {
            StubURLProtocol.reset()
            let m = makeModel()
            m.linkText = link
            m.resolve()

            guard case .failed(let message) = m.state else {
                XCTFail("link \(link.debugDescription) resolved to \(m.state)")
                continue
            }
            XCTAssertEqual(message, L10n.t(.downloadBadLink), link.debugDescription)
            XCTAssertNil(m.receivedContainer, link.debugDescription)
            XCTAssertEqual(StubURLProtocol.requestCount, 0, link.debugDescription)

            // Nothing may arrive late either: a task started before the refusal
            // would settle into `.ready` after this yield.
            try? await Task.sleep(nanoseconds: 20_000_000)
            if case .ready = m.state { XCTFail("link \(link.debugDescription) became ready") }
            XCTAssertEqual(StubURLProtocol.requestCount, 0, link.debugDescription)
        }
    }

    /// The consequence that matters on disk: a refused link cannot reach
    /// `download(into:)`, so it cannot create a `relayium-<id>` directory named
    /// after an id this app refused to act on.
    func testAHostileLinkCannotCreateAReceiveDestination() throws {
        let parent = try tempDir()
        for link in hostileDownloadLinks() {
            let m = makeModel()
            m.linkText = link
            m.resolve()
            m.download(into: parent)
            guard case .failed = m.state else {
                XCTFail("link \(link.debugDescription) reached \(m.state)")
                continue
            }
            XCTAssertNil(m.received, link.debugDescription)
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: parent.path), [],
                       "a refused link created a destination in the folder the user chose")
    }

    /// Generation semantics are unchanged: a refusal still supersedes whatever
    /// was on screen, and `cancel()` still returns the model to idle.
    func testARefusalStillCancelsBackToIdle() {
        let m = makeModel()
        m.linkText = "https://relayium.com/d/..#k=KEY"
        m.resolve()
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }
        m.cancel()
        XCTAssertEqual(m.state, .idle)
        XCTAssertNil(m.receivedContainer)
    }
}
