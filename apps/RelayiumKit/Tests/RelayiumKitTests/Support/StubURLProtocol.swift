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
        init(status: Int, body: Data = Data(), bodyChunks: [Data]? = nil, check: ((URLRequest) -> Void)? = nil) {
            self.status = status; self.body = body; self.bodyChunks = bodyChunks; self.check = check
        }
    }
    nonisolated(unsafe) static var stub: Stub?
    nonisolated(unsafe) static var router: ((URLRequest) -> Stub)?
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBodyBytes: [UInt8] = []
    static func bodyBytes(_ req: URLRequest) -> [UInt8] { lastBodyBytes }

    static func session() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: cfg)
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if let b = request.httpBody { Self.lastBodyBytes = [UInt8](b) }
        else if let s = request.httpBodyStream {
            s.open(); defer { s.close() }
            var buf = [UInt8](repeating: 0, count: 64 * 1024); var out = [UInt8]()
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; out += buf[0..<n] }
            Self.lastBodyBytes = out
        } else { Self.lastBodyBytes = [] }
        Self.lastRequest = request
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
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
