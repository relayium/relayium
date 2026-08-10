import Foundation

/// **What this Mac's own network addresses are, and which of them are worth
/// telling a person about.**
///
/// This exists for one question the LAN receive surface could not answer: *am I
/// on the network I think I am?* The room this app joins is grouped by the
/// PUBLIC address the service observes, not by anything measured here, so a
/// user whose Mac silently moved onto a guest VLAN, a phone hotspot or a VPN
/// had no way to see it. Listing the addresses this machine actually holds is
/// the only local evidence there is.
///
/// ## What it is emphatically not
///
/// It is **not** how peers are found, matched or grouped — that is the
/// service-observed network path, and the surface says so beside these values
/// rather than leaving the reader to infer it. It is **not** stored: nothing
/// here writes to disk, to `UserDefaults`, to a log or to the network, and the
/// call sites hold the result only in view state that is dropped the moment the
/// socket stops listening. An address inventory is a fingerprint of somebody's
/// home network; it is rendered and then forgotten.
///
/// ## Why the policy is separate from the enumeration
///
/// `LocalAddressPolicy` is a pure function over facts. `LocalAddressInventory`
/// is the part that talks to the kernel. Splitting them is what lets the
/// interesting half — a VPN's `utun`, a deprecated IPv6 address, a self-assigned
/// 169.254 — be driven exhaustively by tests on a machine whose real interfaces
/// are whatever the runner happens to have.
///
/// Compiled on macOS and iOS both: `getifaddrs` and the IPv6 address-flag
/// `ioctl` are Darwin, not AppKit, and keeping one implementation is what stops
/// the two platforms disagreeing about what counts as a usable address.

// MARK: - the facts a decision is made from

public enum LocalAddressFamily: String, Equatable, Sendable {
    case ipv4
    case ipv6
}

/// Per-address IPv6 flags, as three DISTINCT answers.
///
/// `unavailable` is not "no flags set". It means the kernel would not answer,
/// and the policy refuses the address rather than guessing — the safe direction,
/// because a temporary or deprecated address presented as a way to reach this
/// Mac is advice that fails silently and intermittently.
public enum IPv6AddressFlags: Equatable, Sendable {
    case read(Int32)
    case unavailable
    /// Not an IPv6 address; the concept does not apply.
    case notApplicable
}

/// One address, with everything the policy is allowed to consider.
///
/// Deliberately flat and `Equatable`: a test writes the case it means, rather
/// than constructing an interface.
public struct LocalAddressCandidate: Equatable, Sendable {
    public var interfaceName: String
    public var isUp: Bool
    public var isRunning: Bool
    public var isLoopback: Bool
    public var isPointToPoint: Bool
    public var family: LocalAddressFamily
    /// Network-order bytes: 4 for IPv4, 16 for IPv6.
    public var bytes: [UInt8]
    public var ipv6Flags: IPv6AddressFlags

    public init(interfaceName: String,
                isUp: Bool = true,
                isRunning: Bool = true,
                isLoopback: Bool = false,
                isPointToPoint: Bool = false,
                family: LocalAddressFamily,
                bytes: [UInt8],
                ipv6Flags: IPv6AddressFlags = .notApplicable) {
        self.interfaceName = interfaceName
        self.isUp = isUp
        self.isRunning = isRunning
        self.isLoopback = isLoopback
        self.isPointToPoint = isPointToPoint
        self.family = family
        self.bytes = bytes
        self.ipv6Flags = ipv6Flags
    }
}

/// One address this Mac holds, ready to be rendered.
///
/// The interface name travels with the text because two addresses on one screen
/// with no way to tell Wi-Fi from Ethernet is a list the reader cannot use.
public struct LocalNetworkAddress: Equatable, Sendable, Identifiable {
    public let interfaceName: String
    public let family: LocalAddressFamily
    public let text: String

    /// Stable within one snapshot, which is all a `ForEach` needs. Not an
    /// identity that outlives the render: nothing keeps these.
    public var id: String { interfaceName + "/" + text }

    public init(interfaceName: String, family: LocalAddressFamily, text: String) {
        self.interfaceName = interfaceName
        self.family = family
        self.text = text
    }
}

// MARK: - the decision

public enum LocalAddressPolicy {

    /// Interfaces that are a tunnel, a VPN, or one end of a point-to-point link.
    ///
    /// An address on one of these is reachable only by whatever is at the other
    /// end of the tunnel, so presenting it as "where this Mac is on your
    /// network" is wrong in the one situation the user most needs the truth: a
    /// VPN is on and they are wondering why nothing can see them.
    // nonlocalized: BSD interface name prefixes, never displayed as prose
    public static let tunnelPrefixes = ["utun", "ipsec", "ppp", "tun", "tap", "gif", "stf"]

    /// Interfaces that are peer-to-peer links or virtual bridges rather than a
    /// network this Mac shares with anybody.
    ///
    /// `awdl`/`llw` are AirDrop's direct radio links, `ap` is the hotspot this
    /// Mac serves, `bridge`/`vmnet`/`vboxnet` are virtual machines and Internet
    /// Sharing, `anpi` is an internal management link. None of them is the
    /// answer to "which network am I on".
    // nonlocalized: BSD interface name prefixes, never displayed as prose
    public static let virtualPrefixes = ["awdl", "llw", "ap", "anpi", "bridge",
                                         "vmnet", "vboxnet", "XHC"]

    /// IPv6 address flags that make an address unusable, unstable or private.
    ///
    /// `TENTATIVE`/`DUPLICATED`/`DETACHED` are not usable yet or at all,
    /// `DEPRECATED` is on its way out, `ANYCAST` is not this host alone,
    /// `OPTIMISTIC` has not finished duplicate detection, and `TEMPORARY` is an
    /// RFC 4941 privacy address that is rotated out from under anybody who wrote
    /// it down. What survives is the stable, valid, preferred address — which is
    /// the only one worth showing.
    static let refusedIPv6Flags: Int32 = 0x0001  // ANYCAST
        | 0x0002  // TENTATIVE
        | 0x0004  // DUPLICATED
        | 0x0008  // DETACHED
        | 0x0010  // DEPRECATED
        | 0x0080  // TEMPORARY
        | 0x0200  // OPTIMISTIC

    /// Is this address one a person can act on?
    ///
    /// Every clause is a refusal. Nothing is admitted by having a property; an
    /// address is admitted by surviving all of them, which is what keeps a new
    /// interface kind — some future virtual link — out by default rather than in.
    public static func admits(_ candidate: LocalAddressCandidate) -> Bool {
        guard candidate.isUp, candidate.isRunning else { return false }
        guard !candidate.isLoopback, !candidate.isPointToPoint else { return false }
        guard !hasExcludedInterfaceName(candidate.interfaceName) else { return false }
        switch candidate.family {
        case .ipv4:
            guard candidate.bytes.count == 4 else { return false }
            // 169.254/16 is what a Mac assigns itself when DHCP never answered.
            // It is the address of a machine that failed to join the network,
            // presented as though it had.
            guard !(candidate.bytes[0] == 169 && candidate.bytes[1] == 254) else { return false }
            // 0.0.0.0 is not an address; 127/8 is loopback even on an interface
            // that did not set the flag.
            guard candidate.bytes != [0, 0, 0, 0], candidate.bytes[0] != 127 else { return false }
            return true
        case .ipv6:
            guard candidate.bytes.count == 16 else { return false }
            // fe80::/10 — link-local, meaningless without the scope id that this
            // surface deliberately does not print.
            guard !(candidate.bytes[0] == 0xFE && (candidate.bytes[1] & 0xC0) == 0x80)
            else { return false }
            // :: and ::1.
            guard candidate.bytes.contains(where: { $0 != 0 }) else { return false }
            guard candidate.bytes != Array(repeating: 0, count: 15) + [1] else { return false }
            // Fail CLOSED: flags that could not be read are not flags that are
            // clear. See `IPv6AddressFlags.unavailable`.
            guard case let .read(flags) = candidate.ipv6Flags else { return false }
            return flags & refusedIPv6Flags == 0
        }
    }

    static func hasExcludedInterfaceName(_ name: String) -> Bool {
        (tunnelPrefixes + virtualPrefixes).contains { name.hasPrefix($0) }
    }

    /// The admitted addresses, in a stable order.
    ///
    /// Sorted rather than left in kernel order because the list is compared by
    /// eye against a router page or another device: IPv4 first, because that is
    /// what a person recognises, then by interface, then by text. Duplicates are
    /// collapsed — the same address can be reported on more than one alias.
    public static func present(_ candidates: [LocalAddressCandidate]) -> [LocalNetworkAddress] {
        var seen = Set<String>()
        var result: [LocalNetworkAddress] = []
        for candidate in candidates where admits(candidate) {
            guard let text = LocalAddressText.string(family: candidate.family,
                                                     bytes: candidate.bytes) else { continue }
            let address = LocalNetworkAddress(interfaceName: candidate.interfaceName,
                                              family: candidate.family,
                                              text: text)
            guard seen.insert(address.id).inserted else { continue }
            result.append(address)
        }
        return result.sorted { lhs, rhs in
            if lhs.family != rhs.family { return lhs.family == .ipv4 }
            if lhs.interfaceName != rhs.interfaceName { return lhs.interfaceName < rhs.interfaceName }
            return lhs.text < rhs.text
        }
    }
}

// MARK: - bytes to text

/// `inet_ntop`, and nothing hand-rolled.
///
/// Writing IPv6 by hand means reimplementing the `::` run-compression rules, and
/// an address a user compares character by character against their router is the
/// last place to be approximately right.
enum LocalAddressText {
    static func string(family: LocalAddressFamily, bytes: [UInt8]) -> String? {
        let domain = family == .ipv4 ? AF_INET : AF_INET6
        let expected = family == .ipv4 ? 4 : 16
        guard bytes.count == expected else { return nil }
        var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
        let rendered: UnsafePointer<CChar>? = bytes.withUnsafeBufferPointer { raw in
            guard let base = raw.baseAddress else { return nil }
            return inet_ntop(domain, base, &buffer, socklen_t(INET6_ADDRSTRLEN))
        }
        guard rendered != nil else { return nil }
        return String(cString: buffer)
    }
}

// MARK: - asking the kernel

/// The one place this app reads its own interface list.
public enum LocalAddressInventory {

    /// Every address this machine currently holds that the policy admits.
    ///
    /// Synchronous and cheap — `getifaddrs` is a copy of a kernel table, not a
    /// network operation — so callers may run it on a state change without a
    /// task. It allocates nothing that outlives the call.
    public static func current() -> [LocalNetworkAddress] {
        LocalAddressPolicy.present(candidates())
    }

    /// Everything `getifaddrs` reports, converted into decisions' input.
    ///
    /// Internal rather than private so the policy's own coverage can be checked
    /// against the shape this really produces.
    static func candidates() -> [LocalAddressCandidate] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }

        // One socket for every IPv6 flag query, closed on the way out. Opening
        // one per address would be a file descriptor per address on a machine
        // that may have dozens.
        let ipv6Socket = socket(AF_INET6, SOCK_DGRAM, 0)
        defer { if ipv6Socket >= 0 { close(ipv6Socket) } }

        var candidates: [LocalAddressCandidate] = []
        var entry: UnsafeMutablePointer<ifaddrs>? = first
        while let current = entry {
            defer { entry = current.pointee.ifa_next }
            guard let addressPointer = current.pointee.ifa_addr else { continue }
            let name = String(cString: current.pointee.ifa_name)
            let flags = current.pointee.ifa_flags
            let family = addressPointer.pointee.sa_family

            if family == UInt8(AF_INET) {
                var storage = sockaddr_in()
                memcpy(&storage, addressPointer, MemoryLayout<sockaddr_in>.size)
                candidates.append(LocalAddressCandidate(
                    interfaceName: name,
                    isUp: flags & UInt32(IFF_UP) != 0,
                    isRunning: flags & UInt32(IFF_RUNNING) != 0,
                    isLoopback: flags & UInt32(IFF_LOOPBACK) != 0,
                    isPointToPoint: flags & UInt32(IFF_POINTOPOINT) != 0,
                    family: .ipv4,
                    bytes: withUnsafeBytes(of: storage.sin_addr.s_addr) { Array($0) }))
            } else if family == UInt8(AF_INET6) {
                var storage = sockaddr_in6()
                memcpy(&storage, addressPointer, MemoryLayout<sockaddr_in6>.size)
                let bytes = withUnsafeBytes(of: storage.sin6_addr) { Array($0) }
                candidates.append(LocalAddressCandidate(
                    interfaceName: name,
                    isUp: flags & UInt32(IFF_UP) != 0,
                    isRunning: flags & UInt32(IFF_RUNNING) != 0,
                    isLoopback: flags & UInt32(IFF_LOOPBACK) != 0,
                    isPointToPoint: flags & UInt32(IFF_POINTOPOINT) != 0,
                    family: .ipv6,
                    bytes: bytes,
                    ipv6Flags: ipv6Flags(socket: ipv6Socket, name: name, address: storage)))
            }
        }
        return candidates
    }

    // MARK: the IPv6 address-flag ioctl

    /// `sizeof(struct in6_ifreq)`.
    ///
    /// **288, not 44.** The obvious reading of the struct — `char ifr_name[16]`
    /// plus a 28-byte `sockaddr_in6` — is wrong, because `ifr_ifru` is a union
    /// whose largest arm is `struct icmp6_ifstat`, a block of per-interface
    /// ICMPv6 counters this call never touches. A 44-byte request composes the
    /// number `0xC02C6949`, which is a DIFFERENT ioctl, and the kernel refuses it
    /// — which is exactly what it did, silently, until the live test below asked
    /// whether the flag query ever answered.
    ///
    /// It is a kernel ABI constant rather than a compile-time measurement: the
    /// size is baked into the command number the kernel dispatches on, so it
    /// cannot drift with an SDK without the command itself changing. Pinned by
    /// `LocalNetworkAddressTests` against the value the platform headers produce.
    static let in6RequestSize = 288

    /// Where `ifr_ifru` begins — the offset the address is written to on the way
    /// in and `ifru_flags6` is read from on the way out. They are the same
    /// offset because they are two arms of one union.
    static let in6UnionOffset = 16

    /// `SIOCGIFAFLAG_IN6`, composed rather than pasted.
    ///
    /// `_IOWR('i', 73, struct in6_ifreq)` — the `<sys/ioccom.h>` encoding, which
    /// Swift does not import because it is macros all the way down. Computing it
    /// from the struct size is what makes the value checkable: a test asserts
    /// both the size and the resulting request number, so a wrong constant is a
    /// test failure rather than an `ioctl` against whatever command that number
    /// happens to name.
    static var siocgifaflagIn6: UInt {
        let inOut: UInt = 0xC000_0000
        let parameterMask: UInt = 0x1FFF
        return inOut
            | (UInt(in6RequestSize) & parameterMask) << 16
            | UInt(UInt8(ascii: "i")) << 8
            | 73
    }

    /// The per-address flags, or `.unavailable`.
    ///
    /// Built as a raw byte buffer at documented offsets rather than as a Swift
    /// struct mirroring the C one, because Swift guarantees nothing about its own
    /// layout and this buffer is handed to the kernel. The size is asserted
    /// against `in6RequestSize` before anything is sent.
    private static func ipv6Flags(socket handle: Int32,
                                  name: String,
                                  address: sockaddr_in6) -> IPv6AddressFlags {
        guard handle >= 0 else { return .unavailable }
        let nameBytes = Array(name.utf8)
        // 16 bytes including the terminator, exactly as `ifr_name` is declared.
        guard nameBytes.count < 16 else { return .unavailable }

        var request = [UInt8](repeating: 0, count: in6RequestSize)
        request.replaceSubrange(0..<nameBytes.count, with: nameBytes)
        withUnsafeBytes(of: address) { source in
            request.replaceSubrange(in6UnionOffset..<(in6UnionOffset + source.count),
                                    with: source)
        }

        let ok = request.withUnsafeMutableBytes { buffer -> Bool in
            guard let base = buffer.baseAddress else { return false }
            return ioctl(handle, siocgifaflagIn6, base) == 0
        }
        guard ok else { return .unavailable }
        // `ifr_ifru.ifru_flags6` is an `int` at the start of the union, i.e. at
        // the offset the address was written to.
        let flags = request.withUnsafeBytes { buffer in
            buffer.loadUnaligned(fromByteOffset: in6UnionOffset, as: Int32.self)
        }
        return .read(flags)
    }
}
