import XCTest
import CryptoKit
import Foundation
@testable import RelayiumKit

private final class TuningFileSource: PlaintextSource {
    var source: FileURLSource
    var readSeconds = 0.0
    var readCalls = 0
    var name: String { source.name }
    var size: Int { source.size }
    init(url: URL) throws { source = try FileURLSource(url: url) }
    func read(_ max: Int) throws -> [UInt8] {
        let t = ProcessInfo.processInfo.systemUptime
        defer { readSeconds += ProcessInfo.processInfo.systemUptime - t; readCalls += 1 }
        return try source.read(max)
    }
}
private final class TuningDiagnostics: @unchecked Sendable {
    private let lock = NSLock()
    private var value = UploadDiagnostics()
    func set(_ x: UploadDiagnostics) { lock.lock(); value = x; lock.unlock() }
    func get() -> UploadDiagnostics { lock.lock(); defer { lock.unlock() }; return value }
}
final class UploadChunkTuningTests: XCTestCase {
    func testNativeChunkMatrix() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let path = env["RELAYIUM_CHUNK_TUNING_HOME"] else { throw XCTSkip("opt-in native chunk comparison") }
        let home = URL(fileURLWithPath: path)
        let port = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: env["RELAYIUM_CHUNK_PORT"] ?? home.appendingPathComponent("PORT.json").path))) as! [String: Any]
        let base = try XCTUnwrap(URL(string: try XCTUnwrap(port["url"] as? String)))
        guard base.scheme == "http", base.host == "127.0.0.1", base.port != nil else {
            throw CloudError.decoding
        }
        guard let reps = Int(env["RELAYIUM_CHUNK_REPS"] ?? "6"), (0...12).contains(reps),
              let bytes = Int(env["RELAYIUM_CHUNK_BYTES"] ?? "70000000"), (1...(128 << 20)).contains(bytes) else {
            throw CloudError.decoding
        }
        let output = home.appendingPathComponent(env["RELAYIUM_CHUNK_OUTPUT"] ?? "RAW.jsonl")
        guard output.deletingLastPathComponent().standardizedFileURL == home.standardizedFileURL,
              !FileManager.default.fileExists(atPath: output.path) else { throw CloudError.decoding }
        XCTAssertTrue(FileManager.default.createFile(atPath: output.path, contents: nil))
        let log = try FileHandle(forWritingTo: output); defer { try? log.close() }
        let fixture = home.appendingPathComponent("native-source-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: fixture) }
        let file = fixture.appendingPathComponent("test.bin")
        // Deterministic file; generation and cache warming are outside timing.
        var body = Data(count: bytes)
        body.withUnsafeMutableBytes { raw in
            let p = raw.bindMemory(to: UInt8.self)
            for i in p.indices { p[i] = UInt8(truncatingIfNeeded: (i &* 31) ^ (i >> 13)) }
        }
        let expected = SHA256.hash(data: body)
        try body.write(to: file); body.removeAll(keepingCapacity: false)
        let profiles: [(String, Int, Int)] = env["RELAYIUM_CHUNK_SMOKE"] == "1"
            ? [("fast", 0, 0)]
            : [("fast",0,0), ("confirmation-delay",1000,500), ("shared-rate",8000,100)]
        let negotiated = env["RELAYIUM_CHUNK_NEGOTIATED"] == "1"
        let orders = negotiated ? [[8,16],[16,8],[8,16],[16,8],[8,16],[16,8]]
            : [[8,16,32],[32,16,8],[16,8,32],[32,8,16],[8,32,16],[16,32,8]]
        for (profile, bodyUS, ackMS) in profiles {
            for rep in -1..<reps {
                for chunk in orders[rep < 0 ? 0 : rep % orders.count] {
                    var reset = URLRequest(url: base.appendingPathComponent("bench/reset"))
                    reset.httpMethod = "POST"
                    reset.httpBody = try JSONSerialization.data(withJSONObject: ["chunkMiB":chunk,"bodyUS":bodyUS,"ackMS":ackMS,"native":negotiated && chunk == 16])
                    let (resetData, resetResponse) = try await URLSession.shared.data(for: reset)
                    XCTAssertEqual((resetResponse as? HTTPURLResponse)?.statusCode, 200)
                    let cfg = try JSONSerialization.jsonObject(with: resetData) as! [String: Any]
                    let config = URLSessionConfiguration.ephemeral
                    config.httpCookieStorage = nil
                    config.httpAdditionalHeaders = ["Cookie": try XCTUnwrap(cfg["cookie"] as? String)]
                    let session = URLSession(configuration: config)
                    defer { session.invalidateAndCancel() }
                    let source = try TuningFileSource(url: file)
                    let uploader = CloudUploader(transport: HTTPResumableTransport(baseURL: base, session: session))
                    let diagnostics = TuningDiagnostics()
                    let start = ProcessInfo.processInfo.systemUptime
                    let outcome = try await uploader.upload(sources: [source], burnAfterRead: false, ttl: 3600,
                        token: "local-fixture", onActivity: { _, d in diagnostics.set(d) }, onProgress: { _, _ in })
                    let uploaded = ProcessInfo.processInfo.systemUptime
                    var hasher = SHA256(); var received = 0
                    let manifest = try await CloudClient(baseURL: base, session: session).download(id: outcome.id,
                        key: decodeStoreKey(outcome.keyB64url), onChunk: { chunk in
                            received += chunk.count; hasher.update(data: Data(chunk))
                        })
                    let verified = ProcessInfo.processInfo.systemUptime
                    XCTAssertEqual(received, bytes); XCTAssertEqual(hasher.finalize(), expected)
                    XCTAssertEqual(manifest.files.count, 1); XCTAssertEqual(manifest.files[0].size, bytes)
                    let (statsData, statsResponse) = try await session.data(from: base.appendingPathComponent("bench/stats"))
                    XCTAssertEqual((statsResponse as? HTTPURLResponse)?.statusCode, 200)
                    let stats = try JSONSerialization.jsonObject(with: statsData) as! [String: Any]
                    let cipher = bytes + ((bytes + STORE_CHUNK_SIZE - 1) / STORE_CHUNK_SIZE) * FRAME_OVERHEAD
                    XCTAssertEqual(stats["inits"] as? Int, 1); XCTAssertEqual(stats["finals"] as? Int, 1)
                    XCTAssertEqual(stats["active"] as? Int, 0); XCTAssertEqual(stats["heldBytes"] as? Int, 0)
                    XCTAssertEqual(stats["waiters"] as? Int, 0)
                    XCTAssertEqual(stats["bodyBytes"] as? Int, cipher); XCTAssertEqual(stats["meter"] as? Int, cipher)
                    XCTAssertLessThanOrEqual(stats["peak"] as? Int ?? 99, 2)
                    if negotiated { XCTAssertEqual(stats["appendLimit"] as? Int, 16 << 20) }
                    XCTAssertTrue((stats["statuses"] as? [Int] ?? []).allSatisfy { $0 == 200 })
                    XCTAssertLessThanOrEqual(uploader.bufferPeak, 2 * ((chunk << 20) + STORE_CHUNK_SIZE + FRAME_OVERHEAD))
                    let d = diagnostics.get(); XCTAssertEqual(d.transportRetries, 0)
                    var stages: [String: Double] = [:]
                    for (stage, seconds) in d.stageSeconds { stages[stage.rawValue] = seconds * 1000 }
                    let row: [String: Any] = ["profile":profile,"rep":rep,"warmup":rep<0,"chunkMiB":chunk,
                        "negotiated":negotiated && chunk == 16,"bytes":bytes,"verified":true,"uploadMs":(uploaded-start)*1000,
                        "uploadAndDownloadVerifiedMs":(verified-start)*1000,"sourceReadMs":source.readSeconds*1000,
                        "readCalls":source.readCalls,"bufferPeak":uploader.bufferPeak,"diagnosticStageMs":stages,
                        "server":stats,"environment":"local HTTP/real SQLite/real DiskStore/fsync; synthetic aggregate read pacing and post-durable confirmation delay; warm file cache; release-compiled native; not WAN" ]
                    try log.write(contentsOf: JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]))
                    try log.write(contentsOf: Data([10])); try log.synchronize()
                    // Remove only this synthetic completed object; ledger remains evidence.
                    var delete = URLRequest(url: base.appendingPathComponent("api/files/\(outcome.id)")); delete.httpMethod = "DELETE"
                    let (_, response) = try await session.data(for: delete)
                    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                    print("CHUNK-SAMPLE \(profile) \(rep) \(chunk) \((uploaded-start)*1000)")
                }
            }
        }
    }
    func testNativeLargeShareFaultControls() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let path = env["RELAYIUM_CHUNK_TUNING_HOME"], let portPath = env["RELAYIUM_CHUNK_PORT"] else {
            throw XCTSkip("opt-in local fault fixture")
        }
        let home = URL(fileURLWithPath:path)
        let port = try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:portPath))) as! [String:Any]
        let base = URL(string:try XCTUnwrap(port["url"] as? String))!
        guard base.scheme == "http", base.host == "127.0.0.1", base.port != nil else {
            throw CloudError.decoding
        }
        let file = home.appendingPathComponent("fault-source-" + UUID().uuidString)
        var body = Data(count:70_000_000)
        body.withUnsafeMutableBytes { raw in
            let p = raw.bindMemory(to:UInt8.self)
            for i in p.indices { p[i] = UInt8(truncatingIfNeeded:(i &* 31) ^ (i >> 13)) }
        }
        let expected = SHA256.hash(data:body)
        try body.write(to:file);body.removeAll(keepingCapacity:false)
        defer {try? FileManager.default.removeItem(at:file)}
        var results: [[String:Any]] = []
        for fault in ["drop-ack","corrupt","cancel"] {
            var reset = URLRequest(url:base.appendingPathComponent("bench/reset"));reset.httpMethod="POST"
            reset.httpBody=try JSONSerialization.data(withJSONObject:["chunkMiB":16,"bodyUS":fault=="cancel" ? 8000:0,"ackMS":0,"native":true])
            let (resetData,response)=try await URLSession.shared.data(for:reset)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode,200)
            let settings=try JSONSerialization.jsonObject(with:resetData) as! [String:Any]
            let cfg=URLSessionConfiguration.ephemeral;cfg.httpCookieStorage=nil
            cfg.httpAdditionalHeaders=["Cookie":try XCTUnwrap(settings["cookie"] as? String),"X-Tuning-Fault":fault]
            let session=URLSession(configuration:cfg);defer {session.invalidateAndCancel()}
            let uploader=CloudUploader(transport:HTTPResumableTransport(baseURL:base,session:session))
            let source=try TuningFileSource(url:file);let trace=TuningDiagnostics()
            if fault=="cancel" {
                let task=Task {try await uploader.upload(sources:[source],burnAfterRead:false,ttl:3600,token:"fixture",onProgress:{_,_ in})}
                var observed=false
                for _ in 0..<150 {
                    let (data,_)=try await session.data(from:base.appendingPathComponent("bench/stats"))
                    let stats=try JSONSerialization.jsonObject(with:data) as! [String:Any]
                    if (stats["active"] as? Int ?? 0)>0 {observed=true;break}
                    try await Task.sleep(nanoseconds:10_000_000)
                }
                XCTAssertTrue(observed,"Cancellation control must reach an actual HTTP upload")
                task.cancel()
                do {_ = try await task.value;XCTFail("cancelled upload completed")} catch {XCTAssertTrue(task.isCancelled)}
            } else {
                let outcome=try await uploader.upload(sources:[source],burnAfterRead:false,ttl:3600,token:"fixture",
                    onActivity:{_,d in trace.set(d)},onProgress:{_,_ in})
                var hasher=SHA256();var count=0;var rejected=false
                do {
                    _=try await CloudClient(baseURL:base,session:session).download(id:outcome.id,key:decodeStoreKey(outcome.keyB64url),onChunk:{part in
                        count+=part.count;hasher.update(data:Data(part))
                    })
                } catch let error as StoredWireError {
                    rejected=true
                    XCTAssertEqual(error, .truncatedStream)
                } catch {
                    XCTFail("Expected ciphertext authentication failure, got \(error)")
                    rejected=true
                }
                if fault=="corrupt" {XCTAssertTrue(rejected,"corrupted ciphertext passed authentication")}
                else {
                    XCTAssertFalse(rejected);XCTAssertEqual(count,70_000_000);XCTAssertEqual(hasher.finalize(),expected)
                    // URLSession may recover a lost answer itself; prove the actual drop below.
                }
                var delete=URLRequest(url:base.appendingPathComponent("api/files/\(outcome.id)"));delete.httpMethod="DELETE"
                let (_,deleted)=try await session.data(for:delete);XCTAssertEqual((deleted as? HTTPURLResponse)?.statusCode,200)
            }
            var last: [String:Any]=[:]
            for _ in 0..<300 {
                let (data,_)=try await session.data(from:base.appendingPathComponent("bench/stats"))
                last=try JSONSerialization.jsonObject(with:data) as! [String:Any]
                if last["active"] as? Int==0 && last["heldBytes"] as? Int==0 && last["waiters"] as? Int==0 {break}
                try await Task.sleep(nanoseconds:10_000_000)
            }
            XCTAssertEqual(last["active"] as? Int,0);XCTAssertEqual(last["heldBytes"] as? Int,0);XCTAssertEqual(last["waiters"] as? Int,0)
            XCTAssertEqual(last["appendLimit"] as? Int,16<<20)
            if fault=="drop-ack" {XCTAssertGreaterThan(last["droppedAnswers"] as? Int ?? 0,0)}
            if fault=="cancel" {XCTAssertEqual(last["finals"] as? Int,0)}
            else {XCTAssertEqual(last["meter"] as? Int,cipherSizeFor([70_000_000]));XCTAssertEqual(last["finals"] as? Int,1)}
            results.append(["fault":fault,"stats":last,"clientRetries":trace.get().transportRetries,"passed":true])
        }
        try JSONSerialization.data(withJSONObject:results,options:[.prettyPrinted,.sortedKeys]).write(to:home.appendingPathComponent("FAULT-CONTROLS.json"))
    }
}
