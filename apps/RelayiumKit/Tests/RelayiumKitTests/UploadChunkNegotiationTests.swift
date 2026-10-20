import XCTest
import Foundation
@testable import RelayiumKit

private final class ChunkHintWireState: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [URLRequest] = []
    private var chunk = 8 << 20
    func reset(chunk: Int) { lock.lock(); values = []; self.chunk = chunk; lock.unlock() }
    func record(_ r: URLRequest) -> Int { lock.lock(); defer { lock.unlock() }; values.append(r); return chunk }
    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return values }
}
private final class ChunkHintWireProtocol: URLProtocol, @unchecked Sendable {
    static let state = ChunkHintWireState()
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "chunk-hint.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let chunk = Self.state.record(request)
        let body = request.httpMethod == "POST"
            ? "{\"uploadId\":\"test-upload\",\"chunkSize\":\(chunk)}" // No pipeline marker: old-server compatibility.
            : "{\"received\":1}"
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type":"application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class UploadChunkNegotiationTests: XCTestCase {
    func testOnlyLargeSharesOfferPackingHintAndServerKeepsChoosingSize() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ChunkHintWireProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let transport = HTTPResumableTransport(baseURL: URL(string:"https://chunk-hint.invalid")!, session:session)
        for (purpose, size, offered) in [(UploadPurpose.share, 70_000_000, true), (.share,64<<20,true),
                                        (.share,(64<<20)-1,false),(.share,0,false),(.deviceTask,70_000_000,false)] {
            for serverChunk in [8<<20, (16<<20)-(192*1024+16+256+4)] {
                ChunkHintWireProtocol.state.reset(chunk:serverChunk)
                let result = try await transport.initPipelinedUpload(header:[0,0,0,1,1],purpose:purpose,
                    burnAfterRead:false,ttl:3600,size:size,token:"fixture")
                XCTAssertEqual(result.chunkSize,serverChunk)
                XCTAssertFalse(result.supportsPipeline, "A size hint cannot invent old-server pipeline support")
                let request = try XCTUnwrap(ChunkHintWireProtocol.state.requests.last)
                XCTAssertEqual(request.value(forHTTPHeaderField:"X-Relayium-Upload-Chunk"),offered ? "large-v1" : nil)
                XCTAssertEqual(URLComponents(url:request.url!,resolvingAgainstBaseURL:false)?.queryItems?.first(where:{$0.name=="purpose"})?.value,purpose.rawValue)
            }
        }
    }
    func testPackingHintDoesNotBecomePatchAuthorization() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ChunkHintWireProtocol.self]
        let session = URLSession(configuration:config);defer {session.invalidateAndCancel()}
        let transport = HTTPResumableTransport(baseURL:URL(string:"https://chunk-hint.invalid")!,session:session)
        ChunkHintWireProtocol.state.reset(chunk:8<<20)
        _ = try await transport.initUpload(header:[1],purpose:.share,burnAfterRead:false,ttl:3600,size:70_000_000,token:"fixture")
        _ = try await transport.patchChunk(uploadId:"test-upload",bytes:Data([1]),from:0,to:1,total:1,token:"fixture",onBytesSent:nil)
        XCTAssertEqual(ChunkHintWireProtocol.state.requests.count,2)
        XCTAssertNil(ChunkHintWireProtocol.state.requests.last?.value(forHTTPHeaderField:"X-Relayium-Upload-Chunk"))
        XCTAssertNil(ChunkHintWireProtocol.state.requests.last?.value(forHTTPHeaderField:"X-Relayium-Upload-Pipeline"))
    }
}
