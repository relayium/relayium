import Foundation

public enum PatchOutcome: Equatable {
    /// The server committed up to `received` (which may be inside the chunk we
    /// sent — it commits whatever landed before a reset).
    case committed(received: Int)
    /// 409: the server was already past where we started. Its offset wins.
    case serverAhead(received: Int)
}

/// The protocol default used when the server reports 0 at initialization. A
/// pending plan persists the resolved value beside its upload id, so a later
/// process never guesses this value for an existing session.
public let DEFAULT_UPLOAD_CHUNK_SIZE = 8 << 20

/// Refuse a server or a corrupted pending plan that would make the uploader
/// reserve an unbounded buffer. Production currently issues 8 MiB; 64 MiB
/// leaves room for a future tuning change without allowing an init response to
/// turn directly into a multi-gigabyte allocation.
public let MAX_UPLOAD_CHUNK_SIZE = 64 << 20

@inline(__always)
public func validUploadChunkSize(_ size: Int) -> Bool {
    size > 0 && size <= MAX_UPLOAD_CHUNK_SIZE
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
    ///
    /// `onBytesSent` reports bytes of THIS chunk that have left, cumulatively.
    /// Without it the only progress signal is the chunk committing, and the
    /// server hands out 8 MiB chunks: on a 2 Mbit uplink that is one movement
    /// every ~28 seconds, which reads as a frozen transfer rather than a slow
    /// one. May be called from any thread.
    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String,
                    onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome
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
        return (b.uploadId, b.chunkSize > 0 ? b.chunkSize : DEFAULT_UPLOAD_CHUNK_SIZE)
    }

    public func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                           total: Int, token: String,
                           onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/uploads/\(uploadId)"))
        req.httpMethod = "PATCH"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(contentRangeHeader(from: from, to: to, total: total),
                     forHTTPHeaderField: "Content-Range")
        // Assigned, not re-wrapped: `Data(bytes)` here was one of three full
        // copies of every chunk that the memory investigation found.
        req.httpBody = bytes
        let (data, http) = try await send(req, onBytesSent: onBytesSent)
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

    private func send(_ req: URLRequest,
                      onBytesSent: ((Int) -> Void)? = nil) async throws -> (Data, HTTPURLResponse) {
        do {
            // A per-task delegate rather than a session-wide one: this type is
            // handed a URLSession it does not own (the app shares one, tests
            // pass a stubbed one), and installing a session delegate would
            // reach beyond this request.
            let delegate = onBytesSent.map(UploadProgressDelegate.init)
            let (data, resp) = try await session.data(for: req, delegate: delegate)
            guard let http = resp as? HTTPURLResponse else { throw CloudError.network }
            return (data, http)
        } catch let e as CloudError {
            throw e
        } catch {
            throw CloudError.network
        }
    }
}

/// Turns URLSession's `didSendBodyData` into the cumulative byte count
/// `patchChunk` promises its caller.
///
/// `totalBytesSent` is what the transport has handed to the kernel, not what
/// the server has acknowledged — so it can reach the chunk's full size a little
/// before the response arrives. That is the right signal for a progress bar
/// (the bytes really have left) and the wrong one for the resume offset, which
/// keeps coming from the server's own `received` in the PATCH response.
final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate {
    private let onBytesSent: (Int) -> Void

    init(onBytesSent: @escaping (Int) -> Void) {
        self.onBytesSent = onBytesSent
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64,
                    totalBytesExpectedToSend: Int64) {
        onBytesSent(Int(totalBytesSent))
    }
}
