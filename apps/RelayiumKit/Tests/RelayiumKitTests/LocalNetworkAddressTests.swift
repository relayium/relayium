import XCTest
@testable import RelayiumAppKit

/// The LAN receive surface's "which network am I actually on" evidence.
///
/// Two halves, tested differently on purpose. `LocalAddressPolicy` is a pure
/// function and is driven exhaustively — a VPN's `utun`, a self-assigned
/// 169.254, a deprecated IPv6 address — because none of those can be arranged on
/// a CI runner. `LocalAddressInventory` talks to the kernel, so what is asserted
/// about it is the shape of the syscall it makes and the invariants its output
/// must satisfy on whatever machine is running, never a specific address.
final class LocalNetworkAddressTests: XCTestCase {

    private func ipv4(_ a: UInt8, _ b: UInt8, _ c: UInt8, _ d: UInt8,
                      interface: String = "en0",
                      isUp: Bool = true,
                      isRunning: Bool = true,
                      isLoopback: Bool = false,
                      isPointToPoint: Bool = false) -> LocalAddressCandidate {
        LocalAddressCandidate(interfaceName: interface, isUp: isUp, isRunning: isRunning,
                              isLoopback: isLoopback, isPointToPoint: isPointToPoint,
                              family: .ipv4, bytes: [a, b, c, d])
    }

    private func ipv6(_ bytes: [UInt8],
                      interface: String = "en0",
                      flags: IPv6AddressFlags = .read(0)) -> LocalAddressCandidate {
        LocalAddressCandidate(interfaceName: interface, family: .ipv6,
                              bytes: bytes, ipv6Flags: flags)
    }

    /// `2001:db8::1`, the documentation prefix, as 16 bytes.
    private let documentationIPv6: [UInt8] =
        [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]

    // MARK: - the ordinary answer

    func testAPrivateIPv4AddressOnAWiredOrWirelessInterfaceIsShown() {
        for interface in ["en0", "en1", "en7"] {
            XCTAssertTrue(LocalAddressPolicy.admits(ipv4(192, 168, 1, 42, interface: interface)))
        }
        XCTAssertTrue(LocalAddressPolicy.admits(ipv4(10, 0, 0, 5)))
        XCTAssertTrue(LocalAddressPolicy.admits(ipv4(172, 16, 4, 9)))
    }

    func testAStableGlobalIPv6AddressIsShown() {
        XCTAssertTrue(LocalAddressPolicy.admits(ipv6(documentationIPv6)))
    }

    /// `SECURED` (RFC 7217 stable-privacy) and `AUTOCONF` are what an ordinary
    /// modern address carries. Refusing them would leave IPv6 permanently empty.
    func testTheFlagsAnOrdinaryModernIPv6AddressCarriesAreNotRefused() {
        for flags: Int32 in [0x0400, 0x0040, 0x0440, 0x0020, 0x0100] {
            XCTAssertTrue(LocalAddressPolicy.admits(ipv6(documentationIPv6, flags: .read(flags))),
                          "flags \(flags) should not disqualify a usable address")
        }
    }

    // MARK: - every refusal, by name

    func testADownOrIdleInterfaceIsNotShown() {
        XCTAssertFalse(LocalAddressPolicy.admits(ipv4(192, 168, 1, 42, isUp: false)))
        XCTAssertFalse(LocalAddressPolicy.admits(ipv4(192, 168, 1, 42, isRunning: false)),
                       "an interface that is up but not running has no link")
    }

    func testLoopbackIsNotShownByFlagOrByPrefix() {
        XCTAssertFalse(LocalAddressPolicy.admits(ipv4(127, 0, 0, 1, interface: "lo0",
                                                      isLoopback: true)))
        // Belt and braces: 127/8 is refused even on an interface that did not
        // set the flag, and so is ::1.
        XCTAssertFalse(LocalAddressPolicy.admits(ipv4(127, 0, 0, 1)))
        XCTAssertFalse(LocalAddressPolicy.admits(
            ipv6(Array(repeating: 0, count: 15) + [1])))
    }

    func testEveryTunnelAndVPNInterfaceIsRefused() {
        for interface in ["utun0", "utun4", "ipsec0", "ppp0", "tun0", "tap0", "gif0", "stf0"] {
            XCTAssertFalse(LocalAddressPolicy.admits(ipv4(10, 8, 0, 2, interface: interface)),
                           "\(interface) is a tunnel and must not be presented as this network")
        }
    }

    /// A VPN that names its interface something this list has never heard of is
    /// still refused, because the kernel marks it point-to-point.
    func testAPointToPointLinkIsRefusedWhateverItIsCalled() {
        XCTAssertFalse(LocalAddressPolicy.admits(
            ipv4(10, 8, 0, 2, interface: "corpvpn0", isPointToPoint: true)))
    }

    func testEveryPeerToPeerAndVirtualBridgeInterfaceIsRefused() {
        for interface in ["awdl0", "llw0", "ap1", "anpi0", "bridge0", "bridge100",
                          "vmnet1", "vmnet8", "vboxnet0", "XHC20"] {
            XCTAssertFalse(LocalAddressPolicy.admits(ipv4(192, 168, 64, 1, interface: interface)),
                           "\(interface) is not a network this Mac shares with anybody")
        }
    }

    func testASelfAssignedIPv4AddressIsRefused() {
        XCTAssertFalse(LocalAddressPolicy.admits(ipv4(169, 254, 12, 7)),
                       "169.254/16 is what a Mac assigns itself when DHCP never answered")
        // The neighbouring /16s are ordinary addresses and must survive.
        XCTAssertTrue(LocalAddressPolicy.admits(ipv4(169, 253, 12, 7)))
        XCTAssertTrue(LocalAddressPolicy.admits(ipv4(169, 255, 12, 7)))
    }

    func testTheUnspecifiedAddressIsRefusedInBothFamilies() {
        XCTAssertFalse(LocalAddressPolicy.admits(ipv4(0, 0, 0, 0)))
        XCTAssertFalse(LocalAddressPolicy.admits(ipv6(Array(repeating: 0, count: 16))))
    }

    /// fe80::/10 — the whole range, not just addresses that happen to start
    /// `fe80`.
    func testEveryIPv6LinkLocalAddressIsRefused() {
        for second: UInt8 in [0x80, 0x90, 0xAB, 0xBF] {
            var bytes = Array<UInt8>(repeating: 0, count: 16)
            bytes[0] = 0xFE
            bytes[1] = second
            bytes[15] = 1
            XCTAssertFalse(LocalAddressPolicy.admits(ipv6(bytes)),
                           "fe\(String(second, radix: 16))… is inside fe80::/10")
        }
        // fec0::/10 is site-local and outside the link-local range.
        var siteLocal = Array<UInt8>(repeating: 0, count: 16)
        siteLocal[0] = 0xFE
        siteLocal[1] = 0xC0
        siteLocal[15] = 1
        XCTAssertTrue(LocalAddressPolicy.admits(ipv6(siteLocal)))
    }

    func testTemporaryDeprecatedAndTentativeIPv6AddressesAreRefused() {
        let refused: [(String, Int32)] = [
            ("anycast", 0x0001), ("tentative", 0x0002), ("duplicated", 0x0004),
            ("detached", 0x0008), ("deprecated", 0x0010), ("temporary", 0x0080),
            ("optimistic", 0x0200),
        ]
        for (name, flag) in refused {
            XCTAssertFalse(LocalAddressPolicy.admits(ipv6(documentationIPv6, flags: .read(flag))),
                           "a \(name) address must not be offered as a way to reach this Mac")
            // …and still refused when it also carries the ordinary ones.
            XCTAssertFalse(LocalAddressPolicy.admits(
                ipv6(documentationIPv6, flags: .read(flag | 0x0440))))
        }
    }

    /// The direction that matters. Flags the kernel would not report are not
    /// flags that are clear.
    func testAnIPv6AddressWhoseFlagsCouldNotBeReadIsRefused() {
        XCTAssertFalse(LocalAddressPolicy.admits(
            ipv6(documentationIPv6, flags: .unavailable)))
        XCTAssertFalse(LocalAddressPolicy.admits(
            ipv6(documentationIPv6, flags: .notApplicable)),
            "notApplicable on an IPv6 address means nothing asked the kernel")
    }

    func testAMalformedAddressLengthIsRefusedRatherThanRendered() {
        XCTAssertFalse(LocalAddressPolicy.admits(
            LocalAddressCandidate(interfaceName: "en0", family: .ipv4, bytes: [192, 168, 1])))
        XCTAssertFalse(LocalAddressPolicy.admits(
            LocalAddressCandidate(interfaceName: "en0", family: .ipv6, bytes: [0x20, 0x01],
                                  ipv6Flags: .read(0))))
    }

    // MARK: - presentation

    func testAddressesRenderExactlyAsTheOSWritesThem() {
        let presented = LocalAddressPolicy.present([
            ipv4(192, 168, 1, 42),
            ipv6(documentationIPv6),
        ])
        XCTAssertEqual(presented.map(\.text), ["192.168.1.42", "2001:db8::1"],
                       "an address compared against a router page must be exact")
    }

    func testTheListIsIPv4FirstThenStablyOrderedAndDeduplicated() {
        let presented = LocalAddressPolicy.present([
            ipv6(documentationIPv6, interface: "en1"),
            ipv4(10, 0, 0, 5, interface: "en1"),
            ipv4(192, 168, 1, 42, interface: "en0"),
            // The same address reported twice, as an alias legitimately can be.
            ipv4(192, 168, 1, 42, interface: "en0"),
        ])
        XCTAssertEqual(presented.map(\.text), ["192.168.1.42", "10.0.0.5", "2001:db8::1"])
        XCTAssertEqual(presented.map(\.interfaceName), ["en0", "en1", "en1"])
    }

    func testRefusedCandidatesNeverReachThePresentedList() {
        let presented = LocalAddressPolicy.present([
            ipv4(127, 0, 0, 1, interface: "lo0", isLoopback: true),
            ipv4(169, 254, 1, 1),
            ipv4(10, 8, 0, 2, interface: "utun3"),
            ipv6(documentationIPv6, flags: .read(0x0080)),
            ipv4(192, 168, 1, 42),
        ])
        XCTAssertEqual(presented.map(\.text), ["192.168.1.42"])
    }

    // MARK: - the syscall this makes

    /// The request number encodes `sizeof(struct in6_ifreq)`, so a wrong size is
    /// not a wrong buffer — it is a DIFFERENT ioctl. This pinned 44 (name plus a
    /// `sockaddr_in6`) until the live check below proved the kernel was refusing
    /// every call: the union's largest arm is `struct icmp6_ifstat`, and the real
    /// size is 288.
    ///
    /// Both numbers are pinned against what the platform headers produce
    /// (`sizeof(struct in6_ifreq)` = 288, `SIOCGIFAFLAG_IN6` = 0xC1206949), so a
    /// future SDK that moved either fails here rather than degrading IPv6 to
    /// nothing in silence.
    func testTheIPv6FlagRequestMatchesTheDocumentedIoctlEncoding() {
        XCTAssertEqual(MemoryLayout<sockaddr_in6>.size, 28)
        XCTAssertEqual(LocalAddressInventory.in6UnionOffset, 16,
                       "ifr_ifru begins after char ifr_name[IFNAMSIZ]")
        XCTAssertEqual(LocalAddressInventory.in6RequestSize, 288,
                       "sizeof(struct in6_ifreq) — the union's largest arm is icmp6_ifstat")
        XCTAssertEqual(LocalAddressInventory.siocgifaflagIn6, 0xC120_6949,
                       "_IOWR('i', 73, struct in6_ifreq)")
    }

    /// A live read on whatever machine runs this. It asserts nothing about which
    /// addresses exist — that is the runner's business — only that the walk
    /// completes, reports the loopback interface every Darwin machine has, and
    /// never returns something the policy would refuse.
    func testTheLiveInventoryWalksTheRealInterfaceTableAndAdmitsNothingRefused() {
        let candidates = LocalAddressInventory.candidates()
        XCTAssertFalse(candidates.isEmpty, "getifaddrs reported no addresses at all")
        XCTAssertTrue(candidates.contains { $0.isLoopback },
                      "every Darwin machine has a loopback address")
        for address in LocalAddressInventory.current() {
            XCTAssertFalse(address.text.isEmpty)
            XCTAssertFalse(LocalAddressPolicy.hasExcludedInterfaceName(address.interfaceName),
                           "\(address.interfaceName) reached the presented list")
        }
    }

    /// The IPv6 flag `ioctl` has to actually work, or every IPv6 address on
    /// every Mac fails closed and the feature quietly degrades to IPv4-only
    /// without anything noticing.
    ///
    /// Conditional on the runner HAVING an IPv6 address, because a machine with
    /// none is not evidence either way — but where one exists, the kernel must
    /// have answered for at least one of them.
    func testTheIPv6FlagQueryAnswersOnAMachineThatHasIPv6() throws {
        let ipv6Candidates = LocalAddressInventory.candidates().filter { $0.family == .ipv6 }
        try XCTSkipIf(ipv6Candidates.isEmpty, "this machine reports no IPv6 addresses")
        let answered = ipv6Candidates.contains {
            if case .read = $0.ipv6Flags { return true }
            return false
        }
        XCTAssertTrue(answered,
                      "SIOCGIFAFLAG_IN6 answered for no address — every IPv6 address "
                      + "would fail closed and the list would silently lose them all")
    }
}
