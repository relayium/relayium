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

/// An empty list is a configuration failure, not an empty success: a peer
/// connection with no ICE servers fails later, and much more obscurely.
func parseICEServers(_ data: Data) throws -> [ICEServerConfig] {
    struct Body: Decodable { let iceServers: [ICEServerConfig]? }
    guard let b = try? JSONDecoder().decode(Body.self, from: data),
          let servers = b.iceServers, !servers.isEmpty else {
        throw AccountError.decoding
    }
    return servers
}

func iceStatusError(_ code: Int) -> AccountError {
    code == 429 ? .rateLimited : .server(status: code)
}

public protocol ICEConfigClient {
    /// `code` is the live pairing code. TURN credentials come back only for a
    /// valid one, because relayed bytes bill to that code's owner; without it
    /// the response is STUN-only.
    func fetch(code: String) async throws -> [ICEServerConfig]
}

public struct HTTPICEClient: ICEConfigClient {
    let baseURL: URL
    let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func fetch(code: String) async throws -> [ICEServerConfig] {
        var comps = URLComponents(url: baseURL.appendingPathComponent("api/ice"),
                                  resolvingAgainstBaseURL: false)!
        if !code.isEmpty { comps.queryItems = [URLQueryItem(name: "code", value: code)] }
        let req = URLRequest(url: comps.url!)
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw AccountError.network }
            guard http.statusCode == 200 else { throw iceStatusError(http.statusCode) }
            return try parseICEServers(data)
        } catch let e as AccountError {
            throw e
        } catch {
            throw AccountError.network
        }
    }
}

// The response may also carry `relays` (a pool of TURN servers with ids) and
// `relayDenied`. Both are decoded away on purpose.
//
// The pool exists so both peers measure RTT to each candidate and converge on
// the lowest-latency common relay. Skipping it costs latency, not correctness:
// with TURN each peer may relay through a different server and ICE still finds
// a working candidate pair. Implementing convergence means measuring RTT and
// agreeing with the peer, which is its own round.
