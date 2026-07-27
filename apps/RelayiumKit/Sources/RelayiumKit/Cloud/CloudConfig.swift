import Foundation

/// The public server settings the upload screen needs. Only the fields the app
/// reads — the endpoint returns more.
public struct ServerConfig: Codable, Equatable {
    public let maxFileSize: Int64      // 0 == unknown / unlimited

    public init(maxFileSize: Int64) { self.maxFileSize = maxFileSize }
}

extension CloudClient {
    /// `GET /api/config`. Advisory: the size hint is optional, and an upload
    /// still works without it — the server enforces the real cap either way.
    public func fetchConfig() async throws -> ServerConfig {
        let req = URLRequest(url: baseURL.appendingPathComponent("api/config"))
        let (data, http) = try await send(req)
        guard http.statusCode == 200 else { throw CloudError.server(status: http.statusCode) }
        guard let c = try? JSONDecoder().decode(ServerConfig.self, from: data) else {
            throw CloudError.decoding
        }
        return c
    }
}
