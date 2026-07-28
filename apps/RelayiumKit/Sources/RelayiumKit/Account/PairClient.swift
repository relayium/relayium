import Foundation

/// A freshly minted pairing code and when it stops working.
public struct MintedCode: Equatable {
    public let code: String
    public let expiresAt: Int64

    public init(code: String, expiresAt: Int64) {
        self.code = code
        self.expiresAt = expiresAt
    }
}

func parseMintedCode(_ data: Data) throws -> MintedCode {
    struct Body: Decodable { let code: String; let expiresAt: Int64 }
    guard let b = try? JSONDecoder().decode(Body.self, from: data), !b.code.isEmpty else {
        throw AccountError.decoding
    }
    return MintedCode(code: b.code, expiresAt: b.expiresAt)
}

func pairStatusError(_ code: Int) -> AccountError {
    switch code {
    // Not a rejected password — a request that needed an account and did not
    // have one. The UI has to explain that, and invalidCredentials' copy would
    // send the user looking for a typo in a form they never filled in.
    case 401: return .notSignedIn
    case 429: return .rateLimited
    default:  return .server(status: code)
    }
}

public protocol PairCodeClient {
    /// Mints a code the app can show. Requires the bearer: the code's owner
    /// pays for any traffic relayed through it, so the server will not mint
    /// one anonymously.
    func mint(token: String) async throws -> MintedCode
}

public struct HTTPPairClient: PairCodeClient {
    let baseURL: URL
    let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func mint(token: String) async throws -> MintedCode {
        // Answerable without asking: the server can only say 401, and offline
        // the round trip fails as `.network` — the wrong explanation entirely.
        guard !token.isEmpty else { throw AccountError.notSignedIn }
        var req = URLRequest(url: baseURL.appendingPathComponent("api/pair"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw AccountError.network }
            // 503 is the handler's "could not mint a pairing code, try again"
            // (pairhttp.go:104) — transient, and worth retrying by hand.
            guard http.statusCode == 200 else { throw pairStatusError(http.statusCode) }
            return try parseMintedCode(data)
        } catch let e as AccountError {
            throw e
        } catch {
            throw AccountError.network
        }
    }
}
