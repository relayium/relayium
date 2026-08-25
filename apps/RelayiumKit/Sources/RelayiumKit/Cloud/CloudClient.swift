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
        // The single-shot path meets the same three 429s as the chunked one
        // (files.go:90 concurrency, :173 daily, :196 monthly), so it sorts them
        // the same way rather than calling every limit a rate limit.
        case 429: throw tooManyRequestsError(
            retryAfter: http.value(forHTTPHeaderField: "Retry-After"),
            body: String(data: data, encoding: .utf8) ?? "")
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
    /// Both public entry points below take the id a RECIPIENT supplied — it
    /// arrives in a `…/d/<id>#k=<key>` link, from a sender, a page, a chat
    /// message or an OS handoff — and append it as a URL path component, which
    /// percent-encodes neither `/` nor `.`. `parseTransferLink` applies the same
    /// rule, but it is one caller of a public type, so the check lives here too:
    /// the boundary that builds the request is the one that has to hold.
    ///
    /// Refused, not escaped: see `StoredObjectID`.
    public func fetchMeta(id: String) async throws -> StoredFileMeta {
        try await fetchMeta(checked: StoredObjectID.checked(id))
    }

    /// The id here has already been through `StoredObjectID.checked`, and it is
    /// the same value the URL below is built from — so `download` can do the one
    /// check that covers both of its requests instead of a second one that
    /// would look like belt-and-braces and be neither.
    private func fetchMeta(checked id: String) async throws -> StoredFileMeta {
        let req = URLRequest(url: baseURL.appendingPathComponent("api/files/\(id)/meta"))
        let (data, http) = try await send(req)
        switch http.statusCode {
        case 200:
            guard let m = try? JSONDecoder().decode(StoredFileMeta.self, from: data) else { throw CloudError.decoding }
            return m
        case 404: throw CloudError.notFound
        // Both server-side download gates currently sit on `/blob`, but an edge
        // or future metadata limiter can still return 429 here. Keep the whole
        // stored-download path on one user-facing outcome.
        case 429: throw CloudError.downloadLimited
        // Everything else is the service, not the link. `server(status:)` stays
        // the upload path's answer — there the user is the account holder and
        // "the server returned an error (500)" is a complete story. Here it is
        // not: the reader holds a link and a key and has to be told which of
        // the three to act on, and metadata failing says nothing about either
        // of theirs. The status rides along for the bug report.
        default:  throw CloudError.downloadUnavailable(status: http.statusCode)
        }
    }

    public func download(id: String, key: [UInt8], onChunk: ([UInt8]) throws -> Void) async throws -> StoredManifest {
        // 0) the id, once, before either request is built and before the caller
        //    is handed a single byte of plaintext.
        let id = try StoredObjectID.checked(id)

        // 1) manifest → expected plaintext total (truncation defense).
        let meta = try await fetchMeta(checked: id)
        guard let encManifest = Data(base64Encoded: meta.encManifest) else { throw CloudError.decoding }
        let manifest = try decryptManifest(key: key, [UInt8](encManifest))
        let expected = manifest.files.reduce(0) { $0 + Int($1.size) }

        // 2) stream the blob in Data chunks (follow 302; retry once on a first-attempt 403).
        let blobURL = baseURL.appendingPathComponent("api/files/\(id)/blob")
        var chunkStream: BoundedDataStream
        var attempt = 0
        while true {
            var request = URLRequest(url: blobURL)
            request.setValue("1", forHTTPHeaderField: "X-Relayium-Direct-Download")
            let (http, stream) = try await streamedChunks(request)
            let code = http.statusCode
            if code == 403 && attempt == 0 {
                stream.cancel()
                attempt += 1
                continue
            }
            if code == 404 {
                stream.cancel()
                throw CloudError.notFound
            }
            // Only an initial 403 gets the bounded redirect-target retry above.
            // A 429 is surfaced after exactly one blob request.
            if code == 429 {
                stream.cancel()
                throw CloudError.downloadLimited
            }
            // Every remaining non-200 is the storage or the server in front of
            // it, answered after exactly the requests already made: the replay
            // above is the ONLY one, so a 5xx is surfaced on its first response
            // rather than doubled against a service that is already failing,
            // and a second 403 lands here with its own status.
            guard code == 200 else {
                stream.cancel()
                throw CloudError.downloadUnavailable(status: code)
            }
            chunkStream = stream; break
        }
        defer { chunkStream.cancel() }

        // 3) decrypt chunk-by-chunk (StoreDecryptor is boundary-independent); end() enforces the expected total.
        let dec = StoreDecryptor(key: key)
        do {
            for try await chunk in chunkStream {
                for pt in try dec.push([UInt8](chunk)) { try onChunk(pt) }
            }
        } catch let e as StoredWireError {
            throw e
        } catch {
            throw CloudError.network
        }
        try dec.end(expectedBytes: expected)
        return manifest
    }

    /// Bridges a `URLSessionDataTask` to an async stream of `Data` chunks, resolving with the
    /// `HTTPURLResponse` as soon as headers arrive (before any body is streamed).
    private func streamedChunks(_ req: URLRequest) async throws -> (HTTPURLResponse, BoundedDataStream) {
        do {
            var delegate: BlobStreamDelegate!
            let http: HTTPURLResponse = try await withCheckedThrowingContinuation { cont in
                delegate = BlobStreamDelegate(responseCont: cont)
                let task = session.dataTask(with: req)
                task.delegate = delegate
                delegate.stream.attach(task)
                task.resume()
            }
            return (http, delegate.stream)
        } catch { throw CloudError.network }
    }
}

/// Surfaces a data task's response + body as an async `Data`-chunk stream, so callers can decrypt
/// on chunk boundaries instead of paying per-byte async suspension costs.
private final class BlobStreamDelegate: NSObject, URLSessionDataDelegate {
    private let responseCont: CheckedContinuation<HTTPURLResponse, Error>
    private var resumed = false
    let stream = BoundedDataStream()

    init(responseCont: CheckedContinuation<HTTPURLResponse, Error>) {
        self.responseCont = responseCont
        super.init()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if !resumed, let http = response as? HTTPURLResponse {
            resumed = true
            responseCont.resume(returning: http)
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        stream.yield(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if !resumed {
            resumed = true
            responseCont.resume(throwing: error ?? URLError(.badServerResponse))
        }
        if let error {
            stream.finish(throwing: error)
        } else {
            stream.finish()
        }
    }
}
