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

extension CloudClient {
    public func fetchMeta(id: String) async throws -> StoredFileMeta {
        let req = URLRequest(url: baseURL.appendingPathComponent("api/files/\(id)/meta"))
        let (data, http) = try await send(req)
        switch http.statusCode {
        case 200:
            guard let m = try? JSONDecoder().decode(StoredFileMeta.self, from: data) else { throw CloudError.decoding }
            return m
        case 404: throw CloudError.notFound
        default:  throw CloudError.server(status: http.statusCode)
        }
    }

    public func download(id: String, key: [UInt8], onChunk: ([UInt8]) throws -> Void) async throws {
        // 1) manifest → expected plaintext total (truncation defense).
        let meta = try await fetchMeta(id: id)
        guard let encManifest = Data(base64Encoded: meta.encManifest) else { throw CloudError.decoding }
        let manifest = try decryptManifest(key: key, [UInt8](encManifest))
        let expected = manifest.files.reduce(0) { $0 + Int($1.size) }

        // 2) stream the blob (follow 302; retry once on a first-attempt 403).
        let blobURL = baseURL.appendingPathComponent("api/files/\(id)/blob")
        var bytes: URLSession.AsyncBytes
        var attempt = 0
        while true {
            let (s, resp) = try await streamed(URLRequest(url: blobURL))
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 403 && attempt == 0 { attempt += 1; continue }
            if code == 404 { throw CloudError.notFound }
            guard code == 200 else { throw CloudError.server(status: code) }
            bytes = s; break
        }

        // 3) decrypt frame-by-frame; end() enforces the expected total.
        let dec = StoreDecryptor(key: key)
        var buf = [UInt8](); buf.reserveCapacity(64 * 1024)
        for try await b in bytes {
            buf.append(b)
            if buf.count >= 64 * 1024 { for pt in try dec.push(buf) { try onChunk(pt) }; buf.removeAll(keepingCapacity: true) }
        }
        if !buf.isEmpty { for pt in try dec.push(buf) { try onChunk(pt) } }
        try dec.end(expectedBytes: expected)
    }

    private func streamed(_ req: URLRequest) async throws -> (URLSession.AsyncBytes, URLResponse) {
        do { return try await session.bytes(for: req) }
        catch { throw CloudError.network }
    }
}
