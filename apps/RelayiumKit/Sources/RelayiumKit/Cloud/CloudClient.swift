import Foundation

public struct CloudClient {
    let baseURL: URL
    let session: URLSession
    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL; self.session = session
    }

    public func upload(key: [UInt8], manifest: StoredManifest, files: [[UInt8]],
                       burnAfterRead: Bool, ttl: Int, token: String) async throws -> UploadResult {
        var comps = URLComponents(url: baseURL.appendingPathComponent("api/files"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "burnAfterRead", value: burnAfterRead ? "1" : "0"),
                            .init(name: "ttl", value: String(ttl))]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(try encodeUploadBody(key: key, manifest: manifest, files: files))

        let (data, http) = try await send(req)
        switch http.statusCode {
        case 200:
            guard let r = try? JSONDecoder().decode(UploadResult.self, from: data) else { throw CloudError.decoding }
            return r
        case 401: throw CloudError.unauthorized
        case 413: throw CloudError.quota
        case 429: throw CloudError.rateLimited
        default:  throw CloudError.server(status: http.statusCode)
        }
    }

    func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw CloudError.network }
            return (data, http)
        } catch let e as CloudError { throw e }
        catch { throw CloudError.network }
    }
}
