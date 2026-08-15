import Foundation

// The one origin an acceptance launch is allowed to move, and the rules that
// keep it from being anything except this machine.
//
// **Why a seam at all.** Q0-T2 needs a transfer that actually completes, and a
// transfer needs a second endpoint plus a hub to rendezvous through. Pointing a
// build at a local Go server is the only way to have both without spending a
// real account, a real relay and a real user's public address on every run. The
// eleven factories in `AppEnvironment` already take a `baseURL`; what was
// missing was one place to resolve it, so a run cannot end up half-local.
//
// **Why it is a compile-time absence rather than a runtime switch.** The whole
// seam lives inside `#if DEBUG`. A shipped binary contains neither the argument
// name, nor the parser, nor a branch that could select an origin — so there is
// no value a deep link, a relay, a malicious profile or a user could supply
// that would make Relayium.app talk to somewhere that is not relayium.com. This
// is the same shape `UITestMode` uses, for the same reason: a `Release` build
// that merely *refuses* an argument is a build where the mechanism still exists
// and only the policy is missing.
//
// **What it deliberately does NOT move.** The legal pages, the plans page, the
// account centre, the CLI page and Apple's subscription management are pinned to
// `AppEnvironment.productionBaseURL` and stay there. Those are documents a
// person is sent to read, and two of them are a purchase-surface requirement; a
// build pointed at a local server must not render a privacy policy served from
// `127.0.0.1` or a "manage your subscription" link that goes nowhere Apple
// knows about.

extension AppEnvironment {

    /// The service origin every network client in this process talks to.
    ///
    /// In Release this *is* `productionBaseURL` — same value, resolved from
    /// nothing, with no code able to produce another answer.
    public static var transferBaseURL: URL { resolvedTransferBaseURL }

    /// The transfer origin as a person reads it.
    ///
    /// Derived from `transferBaseURL` for exactly the reason `productionHost` is
    /// derived from `productionBaseURL`: the screens that say "open this on the
    /// other device" print an address and open one, and a build that printed
    /// `relayium.com` while dialling `127.0.0.1:53219` would be telling the user
    /// to go somewhere the button beside it does not. Neither half looks wrong
    /// alone, which is why they come from one value.
    public static var transferHost: String {
        transferBaseURL.host() ?? transferBaseURL.absoluteString
    }

    /// Whether this launch was pointed at this machine.
    ///
    /// The gate for anything an acceptance run may do only because nothing can
    /// leave the box — residency above all. It re-runs the whole admission on
    /// the resolved origin, rather than answering `transferBaseURL !=
    /// productionBaseURL`: an inequality would answer "true" for any origin the
    /// resolver ever came to accept, which makes the safety property depend on
    /// the parser staying correct forever rather than on the origin being
    /// loopback right now.
    ///
    /// **Re-admission, not a second predicate.** It was written as
    /// `transferBaseURL.host().map(isLoopbackHost)` — the same *function* the
    /// resolver uses, but reached with a different spelling of the host, and
    /// the difference is not cosmetic. `URLComponents.host`, which admission
    /// reads, gives an IPv6 authority **with** its brackets (`[::1]`);
    /// `URL.host()`, which this read, gives it **without** (`::1`). So
    /// `loopbackTransferOrigin` admitted `http://[::1]:53219` and this then
    /// called it not-loopback: residency stayed off and the deep-link
    /// acceptance arm stayed shut for an origin the resolver had already said
    /// yes to. It failed closed, which is why nothing caught it — the IPv4
    /// launcher path never touches it. Round-tripping the stored origin through
    /// `loopbackTransferOrigin` removes the class: there is one admission, it
    /// is reached one way, and "was this admitted?" is asked of the code that
    /// admits. It is also strictly stricter than the old form, which checked
    /// only the host — scheme, credentials, path, query and port are all
    /// re-checked here.
    public static var isLoopbackTransferOrigin: Bool {
        isLoopbackOrigin(transferBaseURL)
    }

    /// Re-admission of one already-resolved origin.
    ///
    /// Split out from the property for the reason `isSameHTTPOrigin` is split
    /// out of the deep-link arm: the property reads a launch-resolved global
    /// that is fixed for the life of the process, so the only origin a test in
    /// this process could ask it about is production — and production is the
    /// answer that was never in doubt. The bracket mismatch above got in
    /// precisely because the interesting inputs were unreachable.
    static func isLoopbackOrigin(_ url: URL) -> Bool {
        loopbackTransferOrigin(url.absoluteString) != nil
    }

    // MARK: - the predicate, which is compiled everywhere
    //
    // `loopbackTransferOrigin` and `isLoopbackHost` are deliberately NOT inside
    // `#if DEBUG`, and the distinction matters. What must be absent from a
    // Release build is the ability to *select* an origin — the argument name,
    // the `ProcessInfo` read, and any assignment to `resolvedTransferBaseURL`.
    // Those are below, and they are all `#if DEBUG`. A pure function that turns
    // a string into an optional URL selects nothing: in Release nothing calls
    // it, `resolvedTransferBaseURL` is a stored `productionBaseURL`, and
    // `isLoopbackTransferOrigin` is therefore `false` for the only origin that
    // exists. Keeping it compiled buys two things worth more than the deletion:
    // the acceptance peer validates its own `--origin` through the SAME
    // predicate the app uses, so it cannot address something the app would
    // refuse; and `swift build -c release` type-checks it.

    /// A loopback origin, canonicalised — or nil, which is every other input.
    ///
    /// Written as an allow-list of the things that make an origin *this machine*
    /// rather than a deny-list of the things that make it somebody else's. A
    /// deny-list here has to anticipate `127.0.0.1.attacker.example`,
    /// `127.0.0.1@attacker.example`, `0x7f.1`, `2130706433`, a redirect and
    /// whatever the next parser difference turns out to be; an allow-list has to
    /// be right about four shapes.
    public static func loopbackTransferOrigin(_ raw: String) -> URL? {
        guard let components = URLComponents(string: raw),
              // `http` is the point: a local server has no certificate anybody
              // would trust, and the acceptance run must not need one. `https`
              // is admitted too, because a loopback origin over TLS is a
              // stricter thing, not a looser one.
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              // `http://127.0.0.1@relayium.com/` has host `relayium.com` and
              // user `127.0.0.1`. Refusing credentials outright removes the
              // whole class rather than trusting this parser to have put the
              // authority where the next one will.
              components.user == nil, components.password == nil,
              // An origin is a scheme, a host and a port. A path would be
              // silently doubled or dropped by the `appendingPathComponent`
              // call sites downstream; a query or fragment on a *base* URL is
              // not something any of them carry through.
              components.path.isEmpty || components.path == "/",
              components.query == nil, components.fragment == nil,
              let host = components.host?.lowercased(),
              isLoopbackHost(host)
        else { return nil }
        // Port 0 is "ask the kernel", which is a thing a listener does and never
        // a thing a client can dial.
        if let port = components.port, port <= 0 || port > 65_535 { return nil }
        // Rebuilt from the validated parts rather than returned as parsed, so
        // what the app stores is exactly what was checked. Returning
        // `components.url` would hand back a value carrying whatever else the
        // parser preserved — a trailing slash above all, which turns every
        // downstream `appendingPathComponent("api/pair")` into `//api/pair`.
        let port = components.port.map { ":\($0)" } ?? ""
        return URL(string: "\(scheme)://\(host)\(port)")
    }

    /// The spellings of "this machine", and nothing else.
    ///
    /// `localhost` is deliberately **refused**. It is a name, and a name is
    /// whatever the resolver says it is: `/etc/hosts`, a search domain, a
    /// configuration profile or a DNS answer can all point it at an address that
    /// is not this box, and the seam's entire safety argument is that the origin
    /// cannot be off-machine. An address literal cannot be redirected, so the
    /// launcher uses one and this refuses the alternative rather than trusting
    /// the resolver. IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`) is refused for the
    /// neighbouring reason: whether it counts as loopback differs between the
    /// stack, WebRTC's own candidate filter and this function, and an origin
    /// whose meaning depends on which layer is asked is not one to admit.
    public static func isLoopbackHost(_ host: String) -> Bool {
        // The IPv6 loopback, in the only two spellings a URL authority can
        // carry it in. Anything else inside brackets is some other address.
        if host == "[::1]" || host == "[0:0:0:0:0:0:0:1]" { return true }
        // 127.0.0.0/8 — the whole loopback block, because a launcher binding
        // `127.0.0.2` to keep two runs apart is doing the right thing. Parsed
        // as four decimal octets, so `0x7f.0.0.1`, `127.1` and `2130706433`
        // — every one of which `inet_aton` resolves to loopback and no URL
        // client agrees about — are refused rather than admitted by a
        // permissive numeric parse.
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        guard octets.count == 4 else { return false }
        guard octets.allSatisfy({ octet in
            // No sign, no hex, no leading zeros, no empty component: exactly the
            // decimal spelling every one of these layers reads the same way.
            !octet.isEmpty && octet.count <= 3
                && octet.allSatisfy(\.isASCII) && octet.allSatisfy(\.isNumber)
                && (octet.count == 1 || octet.first != "0")
                && Int(octet).map { 0...255 ~= $0 } == true
        }) else { return false }
        return octets[0] == "127"
    }

    #if DEBUG

    /// The argument an acceptance launcher passes, with the origin as the next
    /// argument.
    ///
    /// A separate argument rather than an environment variable because
    /// `ProcessInfo.arguments` is fixed for the life of the process, which is
    /// what lets the answer be resolved once and read everywhere without a lock.
    /// It carries no secret — an origin is not a credential — so it is safe in
    /// argv, which the acceptance token deliberately is not.
    // nonlocalized: a test-only launch argument, absent from Release
    public static let transferBaseURLArgument = "--relayium-transfer-origin"

    /// Resolved once, at launch, from arguments that cannot change afterwards.
    static let resolvedTransferBaseURL: URL =
        transferBaseURL(from: ProcessInfo.processInfo.arguments)

    /// The whole resolution, as a pure function of the argument list.
    ///
    /// Pure so the acceptance suite can drive every refusal below without
    /// launching a process per case — the refusals are the interesting half, and
    /// a rule that can only be exercised by relaunching is a rule that gets one
    /// happy-path test.
    ///
    /// **Every failure falls back to production.** Not to a crash and not to a
    /// partially-applied origin: an unusable argument leaves the build behaving
    /// exactly as a shipped one, which is the only failure mode that cannot
    /// silently point a developer's transfer somewhere unintended.
    static func transferBaseURL(from arguments: [String]) -> URL {
        guard let flag = arguments.firstIndex(of: transferBaseURLArgument) else {
            return productionBaseURL
        }
        let value = arguments.index(after: flag)
        guard value < arguments.endIndex else { return productionBaseURL }
        return loopbackTransferOrigin(arguments[value]) ?? productionBaseURL
    }

    #else

    /// The production origin, and no code that could produce another answer.
    static let resolvedTransferBaseURL = productionBaseURL

    #endif
}
