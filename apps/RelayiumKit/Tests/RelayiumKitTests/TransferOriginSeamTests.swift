import XCTest
@testable import RelayiumAppKit

/// The DEBUG acceptance seam, and the refusals that are the whole of its safety
/// argument.
///
/// The seam lets one Debug launch be pointed at a Go server on this machine so a
/// real transfer has a second endpoint and a hub. Everything that makes that
/// safe is a *refusal*: an origin that is not loopback, a link from a run that
/// is not this one, a residency that would join a room with strangers in it. The
/// accept path had a live end-to-end run behind it before this file existed; not
/// one refusal had a test, and a refusal with no test is a refusal that gets
/// deleted by the next person who finds it inconvenient.
///
/// Three things are deliberately NOT tested here, with the reason each:
///
///  - **The resolved value of this process.** `resolvedTransferBaseURL` is a
///    `static let` read from `ProcessInfo` once. The suite runs with no origin
///    argument, so it resolves production — asserted below as the default, but
///    it cannot be moved, and moving it would leak into every other test in the
///    process. The pure `transferBaseURL(from:)` exists so the resolution can be
///    driven exhaustively without that.
///  - **The Release arm.** An `#if DEBUG` absence has no runtime to observe from
///    a Debug test bundle, so it is asserted against the source text instead —
///    that is the last section of this file, and it is why the seam's shape
///    (argument name, `ProcessInfo` read, and assignment all inside the guard)
///    is pinned rather than merely reviewed.
///  - **`UITestMode.allowsResidency` at runtime.** It lives in the two app
///    targets, which this package cannot import. Its two halves are tested where
///    each actually is: the operand, `isLoopbackTransferOrigin`, is exercised
///    directly here, and the expression and its call sites are pinned by source.
final class TransferOriginSeamTests: XCTestCase {

    // MARK: - the allow-list, and what it lets through

    /// The shapes an acceptance launcher actually passes, and the canonical form
    /// each becomes.
    ///
    /// The returned value is asserted as a whole string rather than by host,
    /// because the rebuild is load-bearing: every consumer of this URL reaches
    /// it through `appendingPathComponent`, and a preserved trailing slash turns
    /// each of them into `//api/pair`.
    func testTheResolverAdmitsLoopbackOriginsAndCanonicalisesThem() {
        let admitted: [(String, String)] = [
            // The launcher's own shape: an ephemeral port on the IPv4 loopback.
            ("http://127.0.0.1:53219", "http://127.0.0.1:53219"),
            // No port is a real origin too — it means 80.
            ("http://127.0.0.1", "http://127.0.0.1"),
            // TLS on loopback is a stricter thing than plaintext, not a looser
            // one, so it is admitted.
            ("https://127.0.0.1:8443", "https://127.0.0.1:8443"),
            // The whole 127.0.0.0/8 block: a launcher binding a second address
            // to keep two runs apart is doing the right thing.
            ("http://127.0.0.2:53219", "http://127.0.0.2:53219"),
            ("http://127.255.255.255:1", "http://127.255.255.255:1"),
            ("http://127.0.0.0:1", "http://127.0.0.0:1"),
            // IPv6 loopback, in the two spellings a URL authority can carry.
            ("http://[::1]:53219", "http://[::1]:53219"),
            ("http://[0:0:0:0:0:0:0:1]:53219", "http://[0:0:0:0:0:0:0:1]:53219"),
            // Canonicalisation. The trailing slash is dropped, and the scheme is
            // lowercased, so what the app stores is exactly what was checked.
            ("http://127.0.0.1:53219/", "http://127.0.0.1:53219"),
            ("HTTP://127.0.0.1:53219", "http://127.0.0.1:53219"),
            ("http://127.0.0.1/", "http://127.0.0.1"),
            // The extreme ports are inside the range, not outside it.
            ("http://127.0.0.1:1", "http://127.0.0.1:1"),
            ("http://127.0.0.1:65535", "http://127.0.0.1:65535"),
        ]
        for (raw, canonical) in admitted {
            XCTAssertEqual(AppEnvironment.loopbackTransferOrigin(raw)?.absoluteString, canonical,
                           "\(raw) was refused, or was not canonicalised to \(canonical)")
        }
    }

    // MARK: - the refusals, which are the point

    /// Every shape that is not this machine, or not an origin at all.
    ///
    /// Grouped by the class each one stands for, because the value of the list
    /// is that it names the classes: a future edit that widens the parser has to
    /// delete a named case with a reason beside it, not merely fail to think of
    /// one.
    func testTheResolverRefusesEverythingThatIsNotALoopbackOrigin() {
        let refused: [(String, String)] = [
            // Credentials. `http://127.0.0.1@relayium.com/` has host
            // `relayium.com` and user `127.0.0.1` — the single case that most
            // looks loopback and least is.
            ("http://127.0.0.1@relayium.com/", "a credential smuggles the real host past a reader"),
            ("http://user:pass@127.0.0.1:53219", "credentials are accepted on a loopback origin"),
            ("http://127.0.0.1@127.0.0.1:53219", "a credential is accepted merely because the host is right"),
            // A path, query or fragment. An origin is a scheme, a host and a
            // port; every one of these is silently doubled, dropped or carried
            // somewhere unintended by the call sites downstream.
            ("http://127.0.0.1:53219/api", "a path is accepted on a base URL"),
            ("http://127.0.0.1:53219/cross-network", "a path is accepted on a base URL"),
            ("http://127.0.0.1:53219/?x=1", "a query is accepted on a base URL"),
            ("http://127.0.0.1:53219?x=1", "a query is accepted on a base URL"),
            ("http://127.0.0.1:53219#c=004291", "a fragment is accepted on a base URL"),
            ("http://127.0.0.1:53219/#c=004291", "a fragment is accepted on a base URL"),
            // A name, not an address. `localhost` is whatever the resolver says
            // it is — /etc/hosts, a search domain, a configuration profile or a
            // DNS answer can each point it off this machine, and the seam's
            // entire safety argument is that the origin cannot leave the box.
            ("http://localhost:53219", "localhost is admitted, so a resolver decides where the origin is"),
            ("http://localhost", "localhost is admitted, so a resolver decides where the origin is"),
            ("http://LOCALHOST:53219", "localhost is admitted in another case"),
            ("http://localhost.localdomain:53219", "a name that merely starts with localhost is admitted"),
            // Alternative numeric spellings. `inet_aton` reads every one of
            // these as 127.0.0.1 and no two URL clients agree, so an origin
            // whose meaning depends on which layer is asked is refused.
            ("http://0x7f.0.0.1", "a hex octet is admitted by a permissive numeric parse"),
            ("http://0x7f000001", "a packed hex address is admitted"),
            ("http://127.1", "a short-form address is admitted"),
            ("http://127.0.1", "a three-part address is admitted"),
            ("http://2130706433", "a packed decimal address is admitted"),
            ("http://" + ipv4("0177", 0, 0, 1), "an octal octet is admitted"),
            ("http://127.00.0.1", "a leading-zero octet is admitted"),
            ("http://127.0.0.01", "a leading-zero octet is admitted"),
            // IPv4-mapped IPv6. Whether it counts as loopback differs between
            // the stack, WebRTC's candidate filter and this function.
            ("http://[::ffff:127.0.0.1]:53219", "an IPv4-mapped IPv6 address is admitted"),
            ("http://[::ffff:7f00:1]:53219", "an IPv4-mapped IPv6 address is admitted"),
            // Some other IPv6 address that merely lives in brackets.
            ("http://[::2]:53219", "a non-loopback IPv6 address is admitted"),
            ("http://[fe80::1]:53219", "a link-local IPv6 address is admitted"),
            ("http://[2001:db8::1]:53219", "a routable IPv6 address is admitted"),
            // Somebody else's machine, including the ones that look local.
            ("http://relayium.com", "the production host is admitted as an acceptance origin"),
            ("https://relayium.com", "the production host is admitted as an acceptance origin"),
            ("http://127.0.0.1.attacker.example", "a host that merely begins with the address is admitted"),
            ("http://attacker.example/127.0.0.1", "a path that looks like the address is admitted"),
            ("http://" + ipv4("128", 0, 0, 1) + ":53219", "an address one octet outside the block is admitted"),
            ("http://" + ipv4("27", 0, 0, 1) + ":53219", "a routable address is admitted"),
            ("http://192.168.1.5:53219", "a private LAN address is admitted"),
            ("http://10.0.0.1:53219", "a private LAN address is admitted"),
            ("http://0.0.0.0:53219", "the unspecified address is admitted"),
            ("http://127.0.0.256:1", "an out-of-range octet is admitted"),
            ("http://127.0.0.1.1:1", "a five-part address is admitted"),
            // Ports. Zero is "ask the kernel", which a listener does and a
            // client never can; above 65535 URLComponents parses happily and
            // only this check refuses it.
            ("http://127.0.0.1:0", "port 0 is admitted, which no client can dial"),
            ("http://127.0.0.1:70000", "an out-of-range port is admitted"),
            ("http://127.0.0.1:65536", "an out-of-range port is admitted"),
            // Not http(s). A local server has no certificate anybody trusts,
            // which is why http is the point — but ws, file and the app's own
            // scheme are not origins these clients can be pointed at.
            ("ws://127.0.0.1:53219", "a websocket scheme is admitted as a base URL"),
            ("wss://127.0.0.1:53219", "a websocket scheme is admitted as a base URL"),
            ("file:///tmp", "a file URL is admitted"),
            ("relayium://127.0.0.1", "a custom scheme is admitted"),
            ("javascript:alert(1)", "a script scheme is admitted"),
            // Not a URL, or not one with an authority.
            ("", "the empty string resolves to an origin"),
            ("   ", "whitespace resolves to an origin"),
            ("127.0.0.1:53219", "a bare host:port with no scheme is admitted"),
            ("//127.0.0.1:53219", "a scheme-relative reference is admitted"),
            ("http://", "a URL with no host at all is admitted"),
            ("http:///api", "a URL with an empty host is admitted"),
            ("--relayium-transfer-origin", "the flag's own name resolves to an origin"),
        ]
        for (raw, why) in refused {
            XCTAssertNil(AppEnvironment.loopbackTransferOrigin(raw),
                         "\(raw.isEmpty ? "<empty>" : raw): \(why)")
        }
    }

    /// The host predicate on its own, including the spellings only it sees.
    ///
    /// Separate from the resolver's list because the resolver can only reach it
    /// with hosts `URLComponents` was willing to produce, and this is the
    /// function the acceptance peer validates its own `--origin` through.
    func testTheHostPredicateAdmitsOnlyTheLoopbackSpellings() {
        for host in ["127.0.0.1", "127.0.0.2", "127.1.2.3", "127.0.0.0",
                     "127.255.255.255", "[::1]", "[0:0:0:0:0:0:0:1]"] {
            XCTAssertTrue(AppEnvironment.isLoopbackHost(host), "\(host) is not treated as this machine")
        }
        for host in ["localhost", "relayium.com", ipv4("128", 0, 0, 1), ipv4("27", 0, 0, 1),
                     "0.0.0.0", ipv4("126", 255, 255, 255), "1270.0.0.1", "127.0.0.256",
                     "127.0.0.1.attacker.example", "127.0.0", "127.0.0.1.",
                     ".127.0.0.1", "127..0.1", "127.0.0.-1", "127.0.0.+1",
                     "0x7f.0.0.1", "127.1", "2130706433", ipv4("0177", 0, 0, 1),
                     "127.00.0.1", "", " ", "127.0.0.1 ", " 127.0.0.1",
                     // Unbracketed IPv6 — the spelling `URL.host()` hands back,
                     // and the one that used to make `isLoopbackTransferOrigin`
                     // disagree with the resolver that had just said yes.
                     "::1", "0:0:0:0:0:0:0:1",
                     "[::ffff:127.0.0.1]", "[::2]", "[fe80::1]", "[]",
                     // Full-width digits read as numbers but are not ASCII, and
                     // no two layers agree on what they address.
                     "\u{FF11}\u{FF12}\u{FF17}.0.0.1"] {
            XCTAssertFalse(AppEnvironment.isLoopbackHost(host),
                           "\(host.isEmpty ? "<empty>" : host) is treated as this machine")
        }
    }

    /// The one that had a real defect behind it.
    ///
    /// `loopbackTransferOrigin` reads `URLComponents.host`, which keeps an IPv6
    /// authority's brackets; the old `isLoopbackTransferOrigin` read
    /// `URL.host()`, which strips them. So the resolver admitted
    /// `http://[::1]:53219` and the gate then reported that same stored origin
    /// as not-loopback — residency off, deep-link acceptance arm shut, for an
    /// origin the seam had already accepted. It failed closed, so no run caught
    /// it. The two answers must agree for every origin the resolver can produce.
    func testTheResidencyGateAgreesWithTheResolverForEveryAdmittedOrigin() throws {
        for raw in ["http://127.0.0.1:53219", "http://127.0.0.1", "https://127.0.0.1:8443",
                    "http://127.0.0.2:53219", "http://[::1]:53219",
                    "http://[0:0:0:0:0:0:0:1]:53219"] {
            let admitted = AppEnvironment.loopbackTransferOrigin(raw)
            XCTAssertNotNil(admitted, "\(raw) is no longer admitted — this guard is stale")
            guard let admitted else { continue }
            // The gate, asked about the very origin the resolver just produced.
            // These two answers disagreeing is the defect: `[::1]` was admitted
            // and then gated off, so residency and the deep-link arm stayed shut
            // for an origin the seam had already said yes to.
            XCTAssertTrue(AppEnvironment.isLoopbackOrigin(admitted),
                          "\(raw) resolves to \(admitted), which the residency gate then "
                          + "reports as not loopback — the gate and the admission disagree "
                          + "about the same origin")
        }
        // And the gate refuses everything the resolver refuses, including the
        // production origin every unpointed launch resolves.
        for off in ["https://relayium.com", "http://relayium.com", "http://localhost:53219",
                    "http://192.168.1.5:53219", "http://[::ffff:127.0.0.1]:53219",
                    "http://127.0.0.1:53219/api", "http://user@127.0.0.1:53219",
                    "http://127.0.0.1:0", "ws://127.0.0.1:53219"] {
            XCTAssertFalse(AppEnvironment.isLoopbackOrigin(try XCTUnwrap(URL(string: off))),
                           "\(off) passes the residency gate")
        }
        XCTAssertFalse(AppEnvironment.isLoopbackOrigin(AppEnvironment.productionBaseURL),
                       "the production origin passes the residency gate, so every ordinary "
                       + "Debug build would go resident against the public hub")
        // And the property the whole product reads is that function applied to
        // the resolved origin — not a second, re-open-coded predicate that can
        // drift from it again.
        let source = try seamSource("TransferOrigin.swift")
        XCTAssertTrue(source.contains("isLoopbackTransferOrigin: Bool {\n        isLoopbackOrigin(transferBaseURL)\n    }"),
                      "the residency gate no longer resolves through the admission it is "
                      + "asserted against")
        XCTAssertFalse(source.contains("transferBaseURL.host().map(isLoopbackHost)"),
                       "the gate reads URL.host(), which strips an IPv6 authority's brackets "
                       + "while the admission it must agree with keeps them")
    }

    // MARK: - resolution from the argument list

    /// Every way an argument list fails, and the one way it succeeds.
    ///
    /// **Every failure falls back to production** — not a crash and not a
    /// half-applied origin. An unusable argument has to leave the build behaving
    /// exactly as a shipped one, because that is the only failure mode that
    /// cannot silently point a developer's transfer somewhere unintended.
    func testAnUnusableArgumentLeavesTheBuildOnProduction() {
        let production = AppEnvironment.productionBaseURL
        let flag = AppEnvironment.transferBaseURLArgument
        let fallsBack: [([String], String)] = [
            ([], "an empty argument list"),
            (["/path/to/Relayium.app/Contents/MacOS/Relayium"], "an ordinary launch"),
            (["--relayium-ui-testing"], "an acceptance launch that passes no origin"),
            // The flag with nothing after it. Reading past the end here would be
            // a crash on a launch argument.
            ([flag], "the flag as the last argument"),
            (["--relayium-ui-testing", flag], "the flag as the last argument"),
            // The flag with something after it that is not a loopback origin.
            ([flag, "https://relayium.com"], "production passed as the origin"),
            ([flag, "http://attacker.example"], "somebody else's host"),
            ([flag, "http://localhost:53219"], "a name instead of an address"),
            ([flag, "http://127.0.0.1:53219/api"], "an origin carrying a path"),
            ([flag, "http://127.0.0.1:0"], "an unusable port"),
            ([flag, ""], "an empty value"),
            // The flag consumed as its own value: still a refusal, not a
            // second look at the next argument.
            ([flag, flag, "http://127.0.0.1:53219"], "the flag as its own value"),
            // A near-miss spelling is not the flag at all.
            (["--relayium-transfer-url", "http://127.0.0.1:53219"], "a misspelled flag"),
            (["--relayium-transfer-origin=http://127.0.0.1:53219"], "an equals-joined flag"),
        ]
        for (arguments, why) in fallsBack {
            XCTAssertEqual(AppEnvironment.transferBaseURL(from: arguments), production,
                           "\(why) did not fall back to production")
        }
    }

    /// The accept path, and where in the list the flag may sit.
    func testAWellFormedLoopbackArgumentIsTheResolvedOrigin() {
        let flag = AppEnvironment.transferBaseURLArgument
        XCTAssertEqual(
            AppEnvironment.transferBaseURL(from: [flag, "http://127.0.0.1:53219"]).absoluteString,
            "http://127.0.0.1:53219")
        // Anywhere in the list, and beside the arguments a real launch carries.
        XCTAssertEqual(
            AppEnvironment.transferBaseURL(from: ["/path/to/Relayium", "--relayium-ui-testing",
                                                  flag, "http://127.0.0.1:53219",
                                                  "-NSDocumentRevisionsDebugMode", "YES"])
                .absoluteString,
            "http://127.0.0.1:53219")
        // Canonicalised on the way through, so the resolved value is the checked
        // one rather than whatever the launcher happened to type.
        XCTAssertEqual(
            AppEnvironment.transferBaseURL(from: [flag, "HTTP://127.0.0.1:53219/"]).absoluteString,
            "http://127.0.0.1:53219")
        // The first flag wins, and a second one cannot re-point a launch whose
        // origin was already read.
        XCTAssertEqual(
            AppEnvironment.transferBaseURL(from: [flag, "http://127.0.0.1:1",
                                                  flag, "http://127.0.0.1:2"]).absoluteString,
            "http://127.0.0.1:1")
        // A first flag that is refused does NOT fall through to a valid second
        // one: the answer is production, not the attacker-supplied tail.
        XCTAssertEqual(
            AppEnvironment.transferBaseURL(from: [flag, "http://attacker.example",
                                                  flag, "http://127.0.0.1:2"]),
            AppEnvironment.productionBaseURL)
    }

    /// This process passes no origin, so it is a production build in every way
    /// the seam can be asked about.
    ///
    /// The assertion that matters is the third: it is the operand of
    /// `UITestMode.allowsResidency` on both platforms, and it being false here
    /// is what makes an ordinary Debug build — a developer's, a CI unit run's —
    /// behave exactly as the shipped one.
    func testAnUnpointedLaunchIsProductionInEveryWayTheSeamIsAsked() {
        XCTAssertEqual(AppEnvironment.transferBaseURL, AppEnvironment.productionBaseURL)
        XCTAssertEqual(AppEnvironment.transferHost, AppEnvironment.productionHost)
        XCTAssertEqual(AppEnvironment.transferHost, "relayium.com")
        XCTAssertFalse(AppEnvironment.isLoopbackTransferOrigin,
                       "a launch that passed no origin reports itself as loopback, so an "
                       + "ordinary Debug build would go resident and claim 127.0.0.1 links")
    }

    /// The shown address and the dialled one are one value, for the transfer
    /// origin exactly as they already were for production.
    ///
    /// The empty-roster card prints `transferHost` and opens `transferBaseURL`.
    /// A build that printed one and opened the other would be telling the user
    /// to go somewhere the button beside it does not, and neither half looks
    /// wrong alone.
    func testTheShownTransferHostIsTheHostOfTheURLItOpens() {
        XCTAssertEqual(AppEnvironment.transferHost, AppEnvironment.transferBaseURL.host())
        XCTAssertFalse(AppEnvironment.transferHost.contains("/"),
                       "the shown address carries a path, so it is not an address to type")
    }

    // MARK: - what the seam deliberately does NOT move

    /// The documents and the purchase surface stay on relayium.com.
    ///
    /// A build pointed at a local server must not render a privacy policy served
    /// from `127.0.0.1` or a "manage your subscription" link that goes nowhere
    /// Apple knows about. These are asserted through the constants rather than
    /// through the source, because the property is the value they resolve to.
    func testTheLegalAndAccountSurfacesAreNotMovedByTheSeam() {
        for url in [AppEnvironment.privacyWebURL, AppEnvironment.termsWebURL,
                    AppEnvironment.accountWebURL, AppEnvironment.plansWebURL,
                    AppEnvironment.cliWebURL] {
            XCTAssertEqual(url.scheme, "https", "\(url) is not over TLS")
            XCTAssertEqual(url.host(), "relayium.com", "\(url) is no longer pinned to production")
        }
    }

    // MARK: - the deep-link origin arm

    /// The production hand-off is unchanged, and is the only origin an
    /// unpointed build answers to.
    ///
    /// This is guard 2 of the acceptance arm, observed at runtime: a Debug build
    /// that was not pointed anywhere resolves production, so
    /// `isLoopbackTransferOrigin` is false and the loopback arm is unreachable.
    /// Without it, every developer's Debug build would start claiming
    /// `http://127.0.0.1` links from any source the OS or a browser handed it.
    func testAnUnpointedBuildClaimsProductionLinksAndNoLoopbackOnes() throws {
        XCTAssertEqual(parseAppDeepLink(try XCTUnwrap(URL(string:
            "https://relayium.com/cross-network#c=004291"))), .realtime(code: "004291"))
        for loopback in ["http://127.0.0.1:53219/cross-network#c=004291",
                         "http://127.0.0.1/cross-network#c=004291",
                         "https://127.0.0.1/cross-network#c=004291",
                         "http://[::1]:53219/cross-network#c=004291",
                         "http://localhost:53219/cross-network#c=004291"] {
            XCTAssertNil(parseAppDeepLink(try XCTUnwrap(URL(string: loopback))),
                         "\(loopback) is claimed by a build that was never pointed at a "
                         + "local server")
        }
        // And the production arm is still as narrow as it was: no plaintext, no
        // credential, no neighbouring host, no other port.
        for refused in ["http://relayium.com/cross-network#c=004291",
                        "https://relayium.com:8443/cross-network#c=004291",
                        "https://user@relayium.com/cross-network#c=004291",
                        "https://relayium.com.attacker.example/cross-network#c=004291",
                        "https://attacker.example/cross-network#c=004291"] {
            XCTAssertNil(parseAppDeepLink(try XCTUnwrap(URL(string: refused))),
                         "\(refused) is claimed as a production hand-off")
        }
    }

    /// Guard 3: the exact origin this run resolved, port included — not "some
    /// loopback address".
    ///
    /// On a shared machine `127.0.0.1:53220` is a different server belonging to
    /// somebody else's run, and a link from it must not be claimed by this one.
    /// Driven through the extracted comparison because the origin the guarded
    /// arm reads is a launch-resolved global this process cannot move.
    func testTheAcceptanceArmMatchesOneExactOriginAndNoNeighbour() throws {
        let origin = try XCTUnwrap(URL(string: "http://127.0.0.1:53219"))
        for same in ["http://127.0.0.1:53219/cross-network#c=004291",
                     "http://127.0.0.1:53219",
                     "http://127.0.0.1:53219/",
                     "HTTP://127.0.0.1:53219/cross-network"] {
            XCTAssertTrue(isSameHTTPOrigin(try XCTUnwrap(URL(string: same)), as: origin),
                          "\(same) is not recognised as this run's own origin")
        }
        for other in [// A neighbouring port: somebody else's concurrent run.
                      "http://127.0.0.1:53220/cross-network#c=004291",
                      "http://127.0.0.1:53218/cross-network#c=004291",
                      // The default port is not this run's port.
                      "http://127.0.0.1/cross-network#c=004291",
                      // A neighbouring loopback address is still not this one.
                      "http://127.0.0.2:53219/cross-network#c=004291",
                      "http://[::1]:53219/cross-network#c=004291",
                      // A different scheme on the right host and port.
                      "https://127.0.0.1:53219/cross-network#c=004291",
                      // And production.
                      "https://relayium.com/cross-network#c=004291"] {
            XCTAssertFalse(isSameHTTPOrigin(try XCTUnwrap(URL(string: other)), as: origin),
                           "\(other) is accepted as this run's own origin")
        }
        // The port defaulting is applied on both sides, so an origin with no
        // port and a link naming that scheme's default port are the one origin
        // they actually are.
        let bare = try XCTUnwrap(URL(string: "http://127.0.0.1"))
        XCTAssertTrue(isSameHTTPOrigin(try XCTUnwrap(URL(string: "http://127.0.0.1:80")), as: bare))
        XCTAssertFalse(isSameHTTPOrigin(try XCTUnwrap(URL(string: "http://127.0.0.1:8080")), as: bare))
        let tls = try XCTUnwrap(URL(string: "https://127.0.0.1"))
        XCTAssertTrue(isSameHTTPOrigin(try XCTUnwrap(URL(string: "https://127.0.0.1:443")), as: tls))
        XCTAssertFalse(isSameHTTPOrigin(try XCTUnwrap(URL(string: "http://127.0.0.1:80")), as: tls))
    }

    /// The pairing link names the hub the code was minted on.
    ///
    /// In Release the two origins are identical, so this reads as the production
    /// assertion it replaced; the property it adds is that the link and the
    /// origin cannot come apart. A build talking to a local server that printed
    /// `relayium.com` here would hand the user a code minted on one hub and a
    /// link to a different one, and neither half would look wrong on its own.
    func testThePairingLinkIsBuiltOnTheOriginTheCodeWasMintedOn() throws {
        let url = try XCTUnwrap(transferPairingJoinURL(code: "004291"))
        XCTAssertEqual(url.host(), AppEnvironment.transferBaseURL.host())
        XCTAssertEqual(url.scheme, AppEnvironment.transferBaseURL.scheme)
        XCTAssertEqual(url.port, AppEnvironment.transferBaseURL.port)
        // The round trip the link exists for: whatever origin this build is on,
        // it parses its own link back to the code it put in.
        XCTAssertEqual(parseAppDeepLink(url), .realtime(code: "004291"))
    }

    // MARK: - the Release absence, which has no runtime to observe

    /// Everything that could select an origin is inside `#if DEBUG`.
    ///
    /// The seam's whole safety argument is a compile-time absence rather than a
    /// runtime refusal: a shipped binary contains neither the argument name, nor
    /// the `ProcessInfo` read, nor a branch that could assign anything but
    /// production — so there is no value a deep link, a relay, a malicious
    /// profile or a user could supply that would move it. A Release build that
    /// merely *refused* an argument is a build where the mechanism still exists
    /// and only the policy is missing, and this is what keeps it the former.
    func testNothingOutsideTheDebugGuardCanSelectAnOrigin() throws {
        let source = try seamSource("TransferOrigin.swift")
        let halves = source.components(separatedBy: "\n    #else")
        XCTAssertEqual(halves.count, 2, "TransferOrigin lost its Debug/Release split")
        let release = try XCTUnwrap(halves.last)
        for selecting in ["transferBaseURLArgument", "--relayium-transfer-origin",
                          "ProcessInfo", "arguments", "transferBaseURL(from:",
                          "loopbackTransferOrigin("] {
            XCTAssertFalse(release.contains(selecting),
                           "a shipped build reaches \(selecting), so the mechanism ships too")
        }
        XCTAssertTrue(release.contains("resolvedTransferBaseURL = productionBaseURL"),
                      "the Release origin is no longer a stored production constant")
        // And the Debug half is where all of it lives.
        let debug = try XCTUnwrap(halves.first)
        for selecting in ["--relayium-transfer-origin", "ProcessInfo.processInfo.arguments"] {
            XCTAssertTrue(debug.contains(selecting), "\(selecting) is gone — this guard is stale")
        }
        // One resolution, read once. A second `ProcessInfo` read is a second
        // answer, and an origin that can differ between two callers is not one
        // value the whole process agreed on.
        XCTAssertEqual(source.components(separatedBy: "ProcessInfo").count - 1, 1,
                       "the origin is read from the process more than once")
    }

    /// The deep-link acceptance arm keeps all three of its guards.
    ///
    /// Source rather than runtime for the same reason as above — and because
    /// guard 2 is what makes guard 3 unreachable in this process, so no test
    /// here can observe them both. Losing any one of them is a Debug build that
    /// claims links from a server it is not talking to.
    func testTheDeepLinkAcceptanceArmKeepsAllThreeGuards() throws {
        let source = try seamSource("AppDeepLink.swift")
        let halves = source.components(separatedBy: "#if DEBUG")
        XCTAssertEqual(halves.count, 2, "the deep-link origin check lost its Debug arm")
        // Guard 1: the production origin is decided BEFORE the Debug arm, so it
        // is the answer a shipped build gives and the arm cannot weaken it.
        let beforeArm = try XCTUnwrap(halves.first)
        XCTAssertTrue(beforeArm.contains("url.host?.lowercased() == \"relayium.com\""),
                      "the unconditional production arm is gone or is now conditional")
        let arm = try XCTUnwrap(halves.last)
        // Guard 2: an unpointed Debug build resolves production and stops here.
        XCTAssertTrue(arm.contains("guard AppEnvironment.isLoopbackTransferOrigin else { return false }"),
                      "the acceptance arm no longer requires a loopback origin, so an "
                      + "ordinary Debug build claims 127.0.0.1 links")
        // Guard 3: exact origin equality against the one this process resolved,
        // reached only through guard 2 and not open-coded a second time.
        XCTAssertTrue(arm.contains("isSameHTTPOrigin(url, as: AppEnvironment.transferBaseURL)"),
                      "the acceptance arm compares against something other than the origin "
                      + "this run resolved")
        XCTAssertTrue(arm.contains("#else") && arm.contains("return false"),
                      "the Release side of the acceptance arm no longer refuses")
        // The comparison must not become a host-only or prefix check: the port
        // is what keeps two concurrent runs on one machine apart.
        let comparison = try XCTUnwrap(source.components(separatedBy: "func isSameHTTPOrigin").last)
        for required in ["url.port", "origin.scheme", "origin.host()"] {
            XCTAssertTrue(comparison.contains(required),
                          "the origin comparison stopped reading \(required)")
        }
    }

    /// Residency is gated on the resolved origin, on both platforms, and the
    /// gate has no argument of its own.
    ///
    /// **Why it cannot be a flag.** Acceptance skips residency because the
    /// production hub keys its code-less room by the public address it observes,
    /// so a resident test build joins a room with whatever strangers share that
    /// address — a privacy consequence, which is why no `--please-be-resident`
    /// argument would be an acceptable way to turn it back on. A loopback origin
    /// removes the consequence rather than accepting it. So the permission and
    /// the seam have to be the same fact, and the only thing this can be is
    /// `isActive && isLoopbackTransferOrigin`.
    ///
    /// Asserted against source because `UITestMode` lives in the two app
    /// targets, which this package cannot import. The operand's own behaviour is
    /// tested for real above.
    func testResidencyIsGatedOnTheResolvedOriginOnBothPlatforms() throws {
        let expression = "static let allowsResidency = isActive && AppEnvironment.isLoopbackTransferOrigin"
        for platform in ["mac", "ios"] {
            let mode = try appSource(platform, "UITestMode.swift")
            XCTAssertTrue(mode.contains(expression),
                          "\(platform) does not derive residency from the resolved origin")
            // Exactly one definition per side of the split, and the Release side
            // is a constant that names no origin.
            let halves = mode.components(separatedBy: "#else")
            XCTAssertEqual(halves.count, 2, "\(platform) UITestMode lost its Debug/Release split")
            let release = try XCTUnwrap(halves.last)
            XCTAssertTrue(release.contains("static let allowsResidency = false"),
                          "\(platform) has no Release value for the residency gate")
            XCTAssertFalse(release.contains("isLoopbackTransferOrigin"),
                           "a shipped \(platform) build reads the acceptance seam")
            XCTAssertEqual(mode.components(separatedBy: "allowsResidency =").count - 1, 2,
                           "\(platform) defines the residency gate somewhere else as well")
            // No second way to switch it on. An argument here would be exactly
            // the `--please-be-resident` the gate exists to not be.
            XCTAssertFalse(mode.contains("allowsResidency = ProcessInfo")
                           || mode.contains("allowsResidency = isActive\n"),
                           "\(platform) can be told to go resident by something other than "
                           + "the resolved origin")
        }
        // The call sites. Both platforms must read the gate beside `isActive`,
        // so a launch that resolved no loopback origin takes the path it always
        // took, and neither may reach residency through `isActive` alone.
        let mac = try appSource("mac", "RelayiumApp.swift")
        XCTAssertTrue(mac.contains("guard !UITestMode.isActive || UITestMode.allowsResidency else { return }"),
                      "the macOS residency start is not gated on the resolved origin")
        XCTAssertTrue(mac.contains("if !UITestMode.isActive { notifications.start() }"),
                      "macOS notification registration is no longer unconditionally skipped "
                      + "under acceptance, so a local run reaches Apple's servers")
        let ios = try appSource("ios", "RelayiumApp.swift")
        XCTAssertTrue(ios.contains("if !UITestMode.isActive || UITestMode.allowsResidency {"),
                      "the iOS residency phase hand-off is not gated on the resolved origin")
        XCTAssertTrue(ios.contains("} else if UITestMode.isActive, !UITestMode.allowsResidency {"),
                      "iOS pauses the listener on a loopback launch, so the acceptance run "
                      + "proves that nothing arrives")
    }

    // MARK: - spelling an address the repo may not carry as a literal

    /// One IPv4 spelling, assembled at runtime from its octets.
    ///
    /// `scripts/check-production-identifiers.sh` fails the tree on any complete
    /// IPv4 literal outside the loopback, private and documentation ranges,
    /// because production addresses once accumulated in checked-in documents
    /// and nothing stopped them coming back. A handful of the refusals above
    /// need exactly that kind of address — the block's neighbour, an ordinary
    /// routable one — as the *input* a predicate has to say no to, and one of
    /// them is interesting only for a leading zero the guard's regex reads
    /// straight past. Building the string here is byte-identical at runtime and
    /// leaves the source with no literal to flag, so the refusals keep their
    /// cases without the guard having to grow an exemption for this file.
    ///
    /// The leading octet is a string because that is the one whose *spelling*,
    /// not value, is under test: `0177` is a different assertion from `127`.
    private func ipv4(_ first: String, _ second: Int, _ third: Int, _ fourth: Int) -> String {
        "\(first).\(second).\(third).\(fourth)"
    }

    // MARK: - reading the sources these guards are about

    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → …/apps
    private var appsRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
            .deletingLastPathComponent()   // apps
    }

    /// A shared-package source with its whole-line comments dropped.
    ///
    /// Both seam files explain at length what they deliberately do NOT do, and
    /// name the very mechanisms these guards assert the absence of. Raw text
    /// would fail on the sentence promising the absence being checked for.
    private func seamSource(_ name: String) throws -> String {
        try codeOnly(String(contentsOf: appsRoot.appendingPathComponent(
            "RelayiumKit/Sources/RelayiumAppKit/\(name)"), encoding: .utf8))
    }

    private func appSource(_ platform: String, _ name: String) throws -> String {
        try codeOnly(String(contentsOf: appsRoot.appendingPathComponent(
            "\(platform)/Relayium/\(name)"), encoding: .utf8))
    }

    private func codeOnly(_ raw: String) -> String {
        raw
            .components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }
}
