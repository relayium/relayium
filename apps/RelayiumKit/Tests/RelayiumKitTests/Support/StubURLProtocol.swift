import Foundation

/// Intercepts URLSession requests and returns a canned (status, body). Install
/// via a URLSessionConfiguration whose protocolClasses = [StubURLProtocol].
final class StubURLProtocol: URLProtocol {
    struct Stub { let status: Int; let body: Data; let check: ((URLRequest) -> Void)? }
    nonisolated(unsafe) static var stub: Stub?
    nonisolated(unsafe) static var lastRequest: URLRequest?

    static func session() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: cfg)
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lastRequest = request
        Self.stub?.check?(request)
        let s = Self.stub ?? Stub(status: 500, body: Data(), check: nil)
        let resp = HTTPURLResponse(url: request.url!, statusCode: s.status,
                                   httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: s.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
