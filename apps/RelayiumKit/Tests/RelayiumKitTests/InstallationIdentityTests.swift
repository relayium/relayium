import Security
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// One Mac, one device row — and the local half of that promise.
///
/// The identifier this covers is **not a credential**. It cannot sign anything
/// in, it is not derived from the account, and central will only consult it
/// after a human has approved a device-code login for the matching account. Its
/// only job is to answer "which row is this installation" so that signing out
/// and back in stops manufacturing a third device.
///
/// Everything asserted here is therefore about lifetime and shape: it survives
/// logout, it is scoped to this installation rather than shared with the
/// extensions this app ships, it is one canonical spelling, and a store that
/// cannot answer degrades to no hint at all rather than to a wrong one.
final class InstallationIdentityTests: XCTestCase {

    /// An in-memory stand-in for the keychain, keyed the way the real one is:
    /// by (service, account). Keying it that way is the point — a sign-out that
    /// cleared by SERVICE would take the installation identity with the bearer,
    /// and this fake is what lets that mistake fail a test.
    final class FakeKeychain {
        private(set) var items: [String: String] = [:]
        var failNextLoad = false
        var failEverySave = false
        var loads = 0

        func store(service: String, account: String) -> Store { Store(keychain: self, key: service + "/" + account) }

        final class Store: InstallationIdentityStoring, TokenStore {
            let keychain: FakeKeychain
            let key: String
            init(keychain: FakeKeychain, key: String) { self.keychain = keychain; self.key = key }
            func save(_ value: String) throws {
                if keychain.failEverySave { throw KeychainError.status(errSecIO) }
                keychain.items[key] = value
            }
            func load() throws -> String? {
                keychain.loads += 1
                if keychain.failNextLoad { keychain.failNextLoad = false; throw KeychainError.status(errSecIO) }
                return keychain.items[key]
            }
            func clear() throws { keychain.items.removeValue(forKey: key) }
        }

        /// The mistake this fake exists to catch: "sign out, so clear everything
        /// this app ever wrote".
        func clearWholeService(_ service: String) {
            for key in items.keys where key.hasPrefix(service + "/") { items.removeValue(forKey: key) }
        }
    }

    // MARK: - shape

    func testAGeneratedIdentifierIsTheCanonicalSpellingTheServerAccepts() throws {
        let id = InstallationIdentity.generate()
        // 32 bytes, RawURLEncoding, no padding — `validInstallID` in
        // server/account/installid.go accepts exactly this and nothing else.
        XCTAssertEqual(id.count, 43)
        XCTAssertTrue(InstallationIdentity.isValid(id))
        // Decoded independently of the implementation's own encoder: padded back
        // to a multiple of four and read with Foundation's standard decoder, so
        // this asserts the bytes rather than restating how they were written.
        let padded = id.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/") + "="
        let bytes = try XCTUnwrap(Data(base64Encoded: padded))
        XCTAssertEqual(bytes.count, 32)
    }

    func testTwoInstallationsDoNotShareAnIdentifier() {
        var seen = Set<String>()
        for _ in 0..<200 { seen.insert(InstallationIdentity.generate()) }
        XCTAssertEqual(seen.count, 200, "generation is not random")
    }

    /// The value is compared as TEXT on the server, so a second spelling of the
    /// same bytes is a second identity. Only the canonical one is ours.
    func testValidationRefusesEverySpellingButTheCanonicalOne() {
        let canonical = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        XCTAssertTrue(InstallationIdentity.isValid(canonical))
        for bad in [
            "",
            "   ",
            String(repeating: "A", count: 42),
            String(repeating: "A", count: 44),
            canonical + "=",                                    // padded
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh/",      // standard-base64 '/'
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh+",      // standard-base64 '+'
            String(canonical.dropLast()) + "9",                 // non-zero trailing bits
            String(canonical.dropLast()) + ".",                 // outside the alphabet
        ] {
            XCTAssertFalse(InstallationIdentity.isValid(bad), "accepted \(bad.debugDescription)")
        }
    }

    /// Never a hardware fingerprint. The identifier is random and local, so it
    /// says nothing about the machine and cannot be reconstructed by anyone who
    /// knows the machine.
    func testTheIdentifierIsNotDerivedFromAnythingAboutTheMachine() throws {
        let source = try sourceOfInstallationIdentity()
        for forbidden in ["IOPlatform", "serialNumber", "gethostname",
                          "hostName", "uuidString", "identifierForVendor"] {
            XCTAssertFalse(source.contains(forbidden),
                           "the identifier is derived from \(forbidden)")
        }
        XCTAssertTrue(source.contains("SecRandomCopyBytes"),
                      "the identifier is not from the system CSPRNG")
    }

    // MARK: - lifetime

    func testTheIdentifierIsCreatedOnceAndThenStable() {
        let keychain = FakeKeychain()
        let provider = InstallationIdentityProvider(store: keychain.store(service: "s", account: "installation-id"))
        let first = provider.current()
        XCTAssertNotNil(first)
        XCTAssertEqual(provider.current(), first, "a second read minted a second identity")

        // A relaunch: a brand-new provider over the same store.
        let relaunched = InstallationIdentityProvider(store: keychain.store(service: "s", account: "installation-id"))
        XCTAssertEqual(relaunched.current(), first, "the identity did not survive a relaunch")
    }

    /// The whole point. Logging out revokes the bearer; it does not make this a
    /// different Mac.
    func testSigningOutDoesNotTakeTheIdentifierWithTheBearer() async {
        let keychain = FakeKeychain()
        let bearer = keychain.store(service: "com.relayium.mac", account: "bearer-token")
        let installation = keychain.store(service: "com.relayium.mac", account: "installation-id")
        try? bearer.save("rlm_cli_live")
        let before = InstallationIdentityProvider(store: installation).current()
        XCTAssertNotNil(before)

        // The real sign-out path, driven through the real session: logOut()
        // revokes server-side and then clears the token store.
        StubURLProtocol.router = { _ in .init(status: 200, body: Data("{}".utf8)) }
        defer { StubURLProtocol.router = nil }
        let session = await AccountSession(
            client: AccountClient(baseURL: URL(string: "https://relayium.test")!,
                                  session: StubURLProtocol.session()),
            tokenStore: bearer,
            deviceName: "Test Mac")
        await session.restore()
        await session.logOut()

        XCTAssertNil(try? bearer.load() ?? nil, "the bearer was not revoked locally")
        let after = InstallationIdentityProvider(store: installation).current()
        XCTAssertEqual(after, before, "signing out erased the installation identity")
    }

    /// A store that answers with something this product could not have written
    /// is not trusted: sending it would be sending a value no rule governs, and
    /// keeping it would pin the installation to an identity the server refuses.
    func testACorruptStoredValueIsReplacedRatherThanSent() {
        let keychain = FakeKeychain()
        let store = keychain.store(service: "s", account: "installation-id")
        try? store.save("not-a-canonical-identifier")

        let id = InstallationIdentityProvider(store: store).current()
        let replaced = try? XCTUnwrap(id)
        XCTAssertNotNil(replaced)
        XCTAssertTrue(InstallationIdentity.isValid(id ?? ""))
        XCTAssertNotEqual(id, "not-a-canonical-identifier")
        XCTAssertEqual(try? store.load(), id, "the replacement was not persisted")
    }

    /// A keychain that cannot be read or written is a reason to send NO hint —
    /// never a reason to fail a sign-in. The user loses row reuse, which is an
    /// optimisation; they do not lose the ability to sign in, which is not.
    func testAnUnavailableStoreDegradesToNoHintRatherThanBlockingSignIn() {
        let keychain = FakeKeychain()
        keychain.failEverySave = true
        let provider = InstallationIdentityProvider(store: keychain.store(service: "s", account: "installation-id"))
        XCTAssertNil(provider.current(), "an unpersistable identity was handed out anyway")
    }

    func testAFailedReadDoesNotOverwriteAnExistingIdentity() {
        let keychain = FakeKeychain()
        let store = keychain.store(service: "s", account: "installation-id")
        let original = InstallationIdentityProvider(store: store).current()
        XCTAssertNotNil(original)

        keychain.failNextLoad = true
        XCTAssertNil(InstallationIdentityProvider(store: store).current(),
                     "a failed read invented an identity")
        XCTAssertEqual(try? store.load(), original,
                       "a failed read overwrote the identity already stored")
    }

    /// A sign-out implemented as "clear everything this service holds" would
    /// destroy the identity. Keyed by account, it cannot.
    func testTheIdentityLivesUnderItsOwnAccountKeyNotTheBearers() {
        let keychain = FakeKeychain()
        let bearer = keychain.store(service: "com.relayium.mac", account: "bearer-token")
        let installation = keychain.store(service: "com.relayium.mac", account: "installation-id")
        try? bearer.save("rlm_cli_live")
        let id = InstallationIdentityProvider(store: installation).current()

        try? bearer.clear()
        XCTAssertEqual(try? installation.load(), id)

        // And the mistake, made explicit, so the guarantee is the KEY and not
        // the current implementation of one caller.
        keychain.clearWholeService("com.relayium.mac")
        XCTAssertNil(try? installation.load() ?? nil)
    }

    // MARK: - wiring

    func testTheProductStoreIsScopedToThisInstallationAndNotShared() {
        let store = AppEnvironment.makeInstallationIdentityStore(
            AppEnvironment.keychainConfiguration(for: .macOS))
        XCTAssertEqual(store.baseQuery[kSecAttrService as String] as? String, "com.relayium.mac")
        XCTAssertEqual(store.baseQuery[kSecAttrAccount as String] as? String,
                       AppEnvironment.installationIdentityAccount)
        // An access group is a SHARE. The Share extension has no business
        // reading this, and a value reachable from another process is a value
        // two installations could present.
        XCTAssertNil(store.baseQuery[kSecAttrAccessGroup as String],
                     "the installation identity joined the shared team group")
        // Not the bearer's item: same service, different account.
        XCTAssertNotEqual(AppEnvironment.installationIdentityAccount,
                          AppEnvironment.keychainAccount)
    }

    /// Restoring this Mac's backup onto another Mac must not hand that machine
    /// this installation's identity — two machines presenting one identifier is
    /// the only way the same account can be made to fight over one row.
    /// `…ThisDeviceOnly` is Apple's documented mechanism for exactly that: such
    /// an item is not migrated to a new device when restoring from a backup.
    func testTheIdentityIsStoredWithAnAccessibilityThatDoesNotTravelInBackups() {
        XCTAssertEqual(KeychainTokenStore.accessibility,
                       kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
    }

    /// A UI-test launch writes to its own identity, like every other store this
    /// app persists to. Otherwise an acceptance run would read — and could
    /// overwrite — the identifier of the product installed on this machine.
    func testTheIsolatedLaunchDoesNotResolveTheProductsIdentity() {
        let product = AppEnvironment.makeInstallationIdentityStore()
        let isolated = AppEnvironment.makeInstallationIdentityStore(
            AppEnvironment.isolatedKeychainConfiguration())
        XCTAssertNotEqual(isolated.baseQuery[kSecAttrService as String] as? String,
                          product.baseQuery[kSecAttrService as String] as? String)
    }

    // MARK: - the wire

    func testTheStartRequestCarriesTheHintUnderTheServersFieldName() async throws {
        StubURLProtocol.reset()
        defer { StubURLProtocol.stub = nil; StubURLProtocol.reset() }
        StubURLProtocol.stub = .init(status: 200, body: Data("""
        {"user_code":"WDJB-MJHT","device_code":"dc","verification_uri":"https://relayium.test/device",
         "interval":5,"expires_in":600}
        """.utf8))
        let client = HTTPDeviceAuthClient(baseURL: URL(string: "https://relayium.test")!,
                                          session: StubURLProtocol.session(),
                                          installationID: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
        _ = try await client.start()

        let request = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/api/cli/device/start")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(StubURLProtocol.bodyJSON(request))
        // The exact field `handleDeviceStart` reads.
        XCTAssertEqual(body["install_id"] as? String,
                       "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
    }

    /// With no identity to offer, the request must look exactly like the one
    /// every shipped CLI sends — a bodyless POST. `handleDeviceStart` treats an
    /// EOF body as "no hint" and anything unparseable as a 400, so inventing a
    /// body here would be a new failure mode for no gain.
    func testWithoutAnIdentityTheStartRequestIsUnchangedFromEveryOlderClient() async throws {
        StubURLProtocol.reset()
        defer { StubURLProtocol.stub = nil; StubURLProtocol.reset() }
        StubURLProtocol.stub = .init(status: 200, body: Data("""
        {"user_code":"WDJB-MJHT","device_code":"dc","verification_uri":"https://relayium.test/device",
         "interval":5,"expires_in":600}
        """.utf8))
        let client = HTTPDeviceAuthClient(baseURL: URL(string: "https://relayium.test")!,
                                          session: StubURLProtocol.session(),
                                          installationID: nil)
        _ = try await client.start()

        let request = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertTrue(StubURLProtocol.lastBodyBytes.isEmpty, "a bodyless start gained a body")
        XCTAssertNil(request.value(forHTTPHeaderField: "Content-Type"))
    }

    /// The client refuses to send a value the server would reject anyway. This
    /// is belt and braces — the provider only ever hands out canonical values —
    /// but the client is public API and a caller could pass anything.
    func testAMalformedHintIsDroppedRatherThanSent() async throws {
        StubURLProtocol.reset()
        defer { StubURLProtocol.stub = nil; StubURLProtocol.reset() }
        StubURLProtocol.stub = .init(status: 200, body: Data("""
        {"user_code":"WDJB-MJHT","device_code":"dc","verification_uri":"https://relayium.test/device",
         "interval":5,"expires_in":600}
        """.utf8))
        let client = HTTPDeviceAuthClient(baseURL: URL(string: "https://relayium.test")!,
                                          session: StubURLProtocol.session(),
                                          installationID: "nope")
        _ = try await client.start()
        XCTAssertTrue(StubURLProtocol.lastBodyBytes.isEmpty,
                      "a malformed hint reached the wire")
    }

    /// The poll is where a token comes back, and it must stay a pure
    /// `device_code` exchange: an identifier there would read as a second
    /// credential in the one call that hands out a bearer.
    func testThePollNeverCarriesTheIdentifier() async throws {
        StubURLProtocol.reset()
        defer { StubURLProtocol.stub = nil; StubURLProtocol.reset() }
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"status":"authorization_pending"}"#.utf8))
        let client = HTTPDeviceAuthClient(baseURL: URL(string: "https://relayium.test")!,
                                          session: StubURLProtocol.session(),
                                          installationID: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
        _ = try await client.poll(deviceCode: "dc")

        let request = try XCTUnwrap(StubURLProtocol.lastRequest)
        let body = try XCTUnwrap(StubURLProtocol.bodyJSON(request))
        XCTAssertEqual(body.keys.sorted(), ["device_code"])
    }

    // MARK: - helpers

    private func sourceOfInstallationIdentity() throws -> String {
        let root = (0..<5).reduce(URL(fileURLWithPath: #filePath)) { u, _ in u.deletingLastPathComponent() }
        return try String(
            contentsOf: root.appendingPathComponent(
                "apps/RelayiumKit/Sources/RelayiumKit/Account/InstallationIdentity.swift"),
            encoding: .utf8)
    }
}
