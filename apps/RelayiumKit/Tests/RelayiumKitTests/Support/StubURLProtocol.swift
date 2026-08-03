import Foundation

/// Intercepts URLSession requests and returns a canned (status, body). Install
/// via a URLSessionConfiguration whose protocolClasses = [StubURLProtocol].
final class StubURLProtocol: URLProtocol {
    struct Stub {
        let status: Int
        let body: Data
        /// When set, the body is delivered across multiple `didLoad` calls (one per element)
        /// instead of as a single chunk — exercises chunk-boundary-independent reassembly.
        let bodyChunks: [Data]?
        let check: ((URLRequest) -> Void)?
        /// A transport failure delivered INSTEAD of a clean end of body, after
        /// whatever `body`/`bodyChunks` was already handed over. A status code
        /// cannot express "the connection dropped nine chunks in", and that is
        /// precisely the failure a partially written download comes from.
        let failure: Error?
        init(status: Int, body: Data = Data(), bodyChunks: [Data]? = nil,
             check: ((URLRequest) -> Void)? = nil, failure: Error? = nil) {
            self.status = status; self.body = body; self.bodyChunks = bodyChunks
            self.check = check; self.failure = failure
        }
    }
    nonisolated(unsafe) static var stub: Stub?
    nonisolated(unsafe) static var router: ((URLRequest) -> Stub)?
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBodyBytes: [UInt8] = []
    /// Requests that actually reached the transport. `lastRequest` cannot answer
    /// "was anything sent at all", which is the whole assertion for a client that
    /// is supposed to refuse an input BEFORE building a request. Reset it in the
    /// test that reads it; nothing else touches it.
    nonisolated(unsafe) static var requestCount = 0
    /// Every request, in order. `lastRequest` answers "what did the last call
    /// send"; this answers "what did ALL of them send", which is the only shape
    /// an absence assertion can take — a credential hides in the request the
    /// test forgot to look at, never in the one it inspected. Reset it in the
    /// test that reads it; nothing else touches it.
    nonisolated(unsafe) static var observed: [URLRequest] = []
    static func bodyBytes(_ req: URLRequest) -> [UInt8] { lastBodyBytes }

    /// The last request body as a JSON object.
    ///
    /// Reads the captured bytes rather than `req.httpBody`, for the same reason
    /// `bodyBytes` ignores its argument: a request that reaches a `URLProtocol`
    /// may carry its body as a stream instead, so the request alone cannot be
    /// trusted to answer "what was sent". `startLoading` captures the bytes
    /// before the stub's `check` runs, which is where this is read from.
    static func bodyJSON(_ req: URLRequest) -> [String: Any]? {
        let object = try? JSONSerialization.jsonObject(with: Data(lastBodyBytes))
        return object as? [String: Any]
    }

    /// Forget every recorded request. Deliberately not a `tearDown` hook: this
    /// type is shared static state, and a test that reads `observed` has to say
    /// where its own window of observation begins.
    static func reset() {
        observed = []
        requestCount = 0
        lastRequest = nil
        lastBodyBytes = []
    }

    static func session() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: cfg)
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requestCount += 1
        if let b = request.httpBody { Self.lastBodyBytes = [UInt8](b) }
        else if let s = request.httpBodyStream {
            s.open(); defer { s.close() }
            var buf = [UInt8](repeating: 0, count: 64 * 1024); var out = [UInt8]()
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; out += buf[0..<n] }
            Self.lastBodyBytes = out
        } else { Self.lastBodyBytes = [] }
        Self.lastRequest = request
        Self.observed.append(request)
        Self.stub?.check?(request)
        let s = Self.router?(request) ?? Self.stub ?? Stub(status: 500, body: Data(), check: nil)
        let resp = HTTPURLResponse(url: request.url!, statusCode: s.status,
                                   httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        if let chunks = s.bodyChunks {
            for c in chunks { client?.urlProtocol(self, didLoad: c) }
        } else {
            client?.urlProtocol(self, didLoad: s.body)
        }
        if let failure = s.failure {
            client?.urlProtocol(self, didFailWithError: failure)
        } else {
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}
