import Foundation

/// One entry of an `RTCConfiguration.iceServers` list, in the shape
/// `server/account/turn.go:21-25` serializes. `username`/`credential` are absent
/// for STUN and present for TURN.
public struct ICEServerConfig: Codable, Equatable {
    public let urls: [String]
    public let username: String?
    public let credential: String?

    public init(urls: [String], username: String? = nil, credential: String? = nil) {
        self.urls = urls
        self.username = username
        self.credential = credential
    }
}

/// One relay in the pool `/api/ice` advertises alongside the legacy single
/// TURN. `id` is what the two peers exchange to agree on a relay.
public struct RelayEntry: Codable, Equatable {
    public let id: String
    public let region: String?
    public let iceServers: [ICEServerConfig]

    public init(id: String, region: String? = nil, iceServers: [ICEServerConfig]) {
        self.id = id
        self.region = region
        self.iceServers = iceServers
    }
}

/// Everything `/api/ice` returns: the servers to use when there is no better
/// choice, and the pool to choose from when there is.
public struct ICEConfig: Equatable {
    public let iceServers: [ICEServerConfig]
    public let relays: [RelayEntry]

    public init(iceServers: [ICEServerConfig], relays: [RelayEntry] = []) {
        self.iceServers = iceServers
        self.relays = relays
    }
}

/// An empty `iceServers` is a configuration failure, not an empty success: a
/// peer connection with no ICE servers fails later, and much more obscurely.
///
/// An empty `relays` is neither — it is the LAN case, and every caller treats
/// the pool as optional.
func parseICEConfig(_ data: Data) throws -> ICEConfig {
    struct Body: Decodable {
        let iceServers: [ICEServerConfig]?
        let relays: [RelayEntry]?
    }
    guard let b = try? JSONDecoder().decode(Body.self, from: data),
          let servers = b.iceServers, !servers.isEmpty else {
        throw AccountError.decoding
    }
    return ICEConfig(iceServers: servers, relays: b.relays ?? [])
}

func iceStatusError(_ code: Int) -> AccountError {
    code == 429 ? .rateLimited : .server(status: code)
}

public protocol ICEConfigClient {
    /// `code` is the live pairing code. TURN credentials and the relay pool
    /// come back only for a valid one, because relayed bytes bill to that
    /// code's owner; without it the response is STUN-only.
    func fetch(code: String) async throws -> ICEConfig
}

public struct HTTPICEClient: ICEConfigClient {
    let baseURL: URL
    let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func fetch(code: String) async throws -> ICEConfig {
        var comps = URLComponents(url: baseURL.appendingPathComponent("api/ice"),
                                  resolvingAgainstBaseURL: false)!
        if !code.isEmpty { comps.queryItems = [URLQueryItem(name: "code", value: code)] }
        let req = URLRequest(url: comps.url!)
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw AccountError.network }
            guard http.statusCode == 200 else { throw iceStatusError(http.statusCode) }
            return try parseICEConfig(data)
        } catch let e as AccountError {
            throw e
        } catch {
            throw AccountError.network
        }
    }
}
