import Foundation

public enum PatchOutcome: Equatable {
    /// The server committed up to `received` (which may be inside the chunk we
    /// sent — it commits whatever landed before a reset).
    case committed(received: Int)
    /// 409: the server was already past where we started. Its offset wins.
    case serverAhead(received: Int)
}

/// `Content-Range: bytes <from>-<to-1>/<total>` — end is inclusive on the wire,
/// exclusive in our call sites.
func contentRangeHeader(from: Int, to: Int, total: Int) -> String {
    "bytes \(from)-\(to - 1)/\(total)"
}

/// Sort a 429 into the three the upload path can actually produce.
///
/// Only one of them means "wait": the per-account concurrency gate, which is the
/// only one that sets `Retry-After` (`uploads_resumable.go:205`). The two quota
/// gates (`:166` daily, `:188` monthly) set no such header, and telling someone
/// to wait a minute for a limit that resets next month is worse than saying
/// nothing.
///
/// So the header is the discriminator and the body only picks between the two
/// quota wordings. Matching server prose is a wire contract that can drift, so an
/// unrecognised body degrades to the generic wait rather than asserting a cause.
func tooManyRequestsError(retryAfter: String?, body: String) -> CloudError {
    if let r = retryAfter, !r.isEmpty { return .rateLimited }
    let text = body.lowercased()
    if text.contains("daily quota") { return .dailyQuota }
    if text.contains("monthly traffic") { return .monthlyTraffic }
    return .rateLimited
}

/// The four calls of the resumable upload protocol, behind a protocol so the
/// chunk loop can be tested without a server.
public protocol ResumableTransport {
    func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int)
    /// `bytes` is a slice of the caller's packing buffer and shares its storage.
    /// Implementations must not copy it — that copy is the whole memory problem.
    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String) async throws -> PatchOutcome
    func uploadOffset(uploadId: String, token: String) async throws -> Int
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult
}

public struct HTTPResumableTransport: ResumableTransport {
    let baseURL: URL
    let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                           size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        var comps = URLComponents(url: baseURL.appendingPathComponent("api/uploads"),
                                  resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "burnAfterRead", value: burnAfterRead ? "1" : "0"),
                            .init(name: "ttl", value: String(ttl)),
                            .init(name: "size", value: String(size))]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(header)
        let (data, http) = try await send(req)
        guard http.statusCode == 200 else { throw statusError(http, data) }
        struct Body: Decodable { let uploadId: String; let chunkSize: Int }
        guard let b = try? JSONDecoder().decode(Body.self, from: data) else { throw CloudError.decoding }
        // The server may report 0 to mean "use your default" — same rule as web.
        return (b.uploadId, b.chunkSize > 0 ? b.chunkSize : 8 << 20)
    }

    public func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                           total: Int, token: String) async throws -> PatchOutcome {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/uploads/\(uploadId)"))
        req.httpMethod = "PATCH"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(contentRangeHeader(from: from, to: to, total: total),
                     forHTTPHeaderField: "Content-Range")
        // Assigned, not re-wrapped: `Data(bytes)` here was one of three full
        // copies of every chunk that the memory investigation found.
        req.httpBody = bytes
        let (data, http) = try await send(req)
        struct Body: Decodable { let received: Int }
        switch http.statusCode {
        case 200:
            guard let b = try? JSONDecoder().decode(Body.self, from: data) else { throw CloudError.decoding }
            return .committed(received: b.received)
        case 409:
            guard let b = try? JSONDecoder().decode(Body.self, from: data) else { throw CloudError.decoding }
            return .serverAhead(received: b.received)
        default:
            throw statusError(http, data)
        }
    }

    public func uploadOffset(uploadId: String, token: String) async throws -> Int {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/uploads/\(uploadId)"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, http) = try await send(req)
        guard http.statusCode == 200 else { throw statusError(http, data) }
        struct Body: Decodable { let received: Int }
        guard let b = try? JSONDecoder().decode(Body.self, from: data) else { throw CloudError.decoding }
        return b.received
    }

    public func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/uploads/\(uploadId)/finalize"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, http) = try await send(req)
        guard http.statusCode == 200 else { throw statusError(http, data) }
        guard let r = try? JSONDecoder().decode(UploadResult.self, from: data) else {
            throw CloudError.decoding
        }
        return r
    }

    private func statusError(_ http: HTTPURLResponse, _ data: Data) -> CloudError {
        switch http.statusCode {
        case 401: return .unauthorized
        case 413: return .quota
        case 429:
            return tooManyRequestsError(
                retryAfter: http.value(forHTTPHeaderField: "Retry-After"),
                body: String(data: data, encoding: .utf8) ?? "")
        case 404: return .notFound
        default:  return .server(status: http.statusCode)
        }
    }

    private func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw CloudError.network }
            return (data, http)
        } catch let e as CloudError {
            throw e
        } catch {
            throw CloudError.network
        }
    }
}
