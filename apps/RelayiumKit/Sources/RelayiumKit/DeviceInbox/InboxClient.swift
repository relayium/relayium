import Foundation

/// The device half of the Device Inbox HTTP API.
///
/// PRE-IMPLEMENTATION INVARIANTS for this file. Each is asserted by a test in
/// `InboxClientTests`; changing one of them is a protocol change, not a
/// refactor.
///
///  1. THE PRIVATE KEY NEVER LEAVES. The only key material sent to central is a
///     32-byte X25519 PUBLIC key. There is no request shape, and no code path,
///     that transmits a private key, an unsealed content key, a manifest
///     plaintext, a file name or a destination path.
///  2. BOTH CREDENTIALS, EVERY TIME. Ciphertext reads and progress reports carry
///     the device bearer AND the current claim token, and the claim token
///     travels in `X-Relayium-Inbox-Claim` — never in a URL, where it would
///     reach a proxy log.
///  3. FAIL CLOSED ON VOCABULARY. An unknown state, error code, policy or
///     presence value throws. A device state that central does not accept from a
///     device, and a `saved` without the commit assertion, are refused BEFORE a
///     request is built, so an invalid claim never reaches the wire at all.
///  4. NOTHING REMOTE IS ECHOED. A rejection contributes its status and the
///     machine-readable `error` token from a BOUNDED prefix of the body, and
///     nothing else. The body itself is never carried further.

/// One ciphertext stream. `chunks` must be consumed or abandoned by the caller.
public struct InboxBlobStream: Sendable {
    public let status: Int
    /// Whether the server honoured a `Range` request with a `206`.
    ///
    /// A resume answered with a full `200` is NOT a tail, and treating it as one
    /// would splice the start of the object into the middle of the stream.
    public let isPartial: Bool
    public let chunks: AsyncThrowingStream<Data, Error>

    public init(status: Int, isPartial: Bool, chunks: AsyncThrowingStream<Data, Error>) {
        self.status = status
        self.isPartial = isPartial
        self.chunks = chunks
    }
}

/// What this device announces about itself at enrolment.
///
/// Everything in it is bounded display/negotiation metadata that central
/// validates. Nothing derived from a received file appears here, and there is no
/// field that could carry one.
public struct InboxEnrolRequest: Equatable, Sendable, Encodable {
    public let platform: String
    public let appVersion: String
    public let protocolVersions: [Int]
    public let capabilities: [String]
    public let autoAccept: InboxAutoAccept
    public let receiveDirReady: Bool

    public init(platform: String, appVersion: String,
                protocolVersions: [Int] = InboxProtocol.versions,
                capabilities: [String] = InboxProtocol.capabilities,
                autoAccept: InboxAutoAccept, receiveDirReady: Bool) {
        self.platform = platform
        self.appVersion = appVersion
        self.protocolVersions = protocolVersions
        self.capabilities = capabilities
        self.autoAccept = autoAccept
        self.receiveDirReady = receiveDirReady
    }
}

/// The calls a receiving device makes.
///
/// A protocol rather than the concrete client for the same reason
/// `AccountManagementService` is one: the receiver's interesting behaviour is
/// what it does when a lease is refused mid-download, when a resume is answered
/// with a full body, or when a report lands after the task went terminal — and
/// none of that is reachable through a URL stub alone.
public protocol InboxTransport: AnyObject, Sendable {
    func currentDevice() async throws -> InboxDeviceRow
    func enrol(_ request: InboxEnrolRequest) async throws -> InboxEnrolResult
    func registerKey(algorithm: String, publicKey: String,
                     previousKeyID: String?) async throws -> InboxKey
    func listKeys() async throws -> [InboxKey]
    @discardableResult
    func heartbeat(receiveDirReady: Bool) async throws -> InboxHeartbeatResult
    func goOffline() async throws
    func pending(limit: Int) async throws -> [InboxTask]
    func claim(max: Int) async throws -> (deliveries: [InboxDelivery], leaseSeconds: Int)
    func blob(taskID: String, claimToken: String, offset: Int64) async throws -> InboxBlobStream
    @discardableResult
    func report(taskID: String, claimToken: String, state: InboxTaskState,
                errorCode: InboxDeviceErrorCode, committed: Bool) async throws -> InboxTask
    @discardableResult
    func accept(taskID: String, accept: Bool) async throws -> InboxTask
    func clearInbox() async throws
}

public final class InboxClient: InboxTransport, @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let token: String
    private let deviceID: String

    /// `deviceID` is checked, not escaped, at construction: it is composed into
    /// every URL path below, and `appendingPathComponent` percent-encodes
    /// neither `/` nor `.`. Refusing is the only defence that does not depend on
    /// who normalises the path — the same rule, and the same reasoning, as
    /// `StoredObjectID`.
    public init(baseURL: URL, deviceID: String, token: String,
                session: URLSession = .shared) throws {
        guard let checked = try? StoredObjectID.checked(deviceID) else {
            throw InboxError.invalidIdentifier
        }
        self.baseURL = baseURL
        self.deviceID = checked
        self.token = token
        self.session = session
    }

    // MARK: - device discovery

    /// The device row this bearer authenticates as.
    ///
    /// A native client cannot assume its device id: it is minted server-side when
    /// the login is approved, so the honest way to learn it is to ask which row
    /// is `Current`. A cookie-authenticated caller never marks a row, and this
    /// client only ever sends a bearer, so at most one row can be current.
    ///
    /// Deliberately an instance method even though it does not use `deviceID`:
    /// the answer is a property of the CREDENTIAL, and pairing the two in one
    /// object is what stops a caller resolving one device's row and then acting
    /// on another's.
    public func currentDevice() async throws -> InboxDeviceRow {
        struct Body: Decodable { let devices: [InboxDeviceRow] }
        let body: Body = try await send(request(.get, url: baseURL.appendingPathComponent("api/devices")))
        guard let current = body.devices.first(where: { $0.isCurrent }) else {
            throw InboxError.noCurrentDevice
        }
        return current
    }

    // MARK: - enrolment and keys

    public func enrol(_ enrolRequest: InboxEnrolRequest) async throws -> InboxEnrolResult {
        var req = request(.put, url: devicePath("inbox"))
        req.httpBody = try encode([
            "platform": enrolRequest.platform,
            "appVersion": enrolRequest.appVersion,
            "protocolVersions": enrolRequest.protocolVersions,
            "capabilities": enrolRequest.capabilities,
            "autoAccept": enrolRequest.autoAccept.rawValue,
            "receiveDirReady": enrolRequest.receiveDirReady,
        ])
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await send(req)
    }

    /// Publish a public key. `previousKeyID` is the compare-and-swap input: nil
    /// means "I have no key yet" and is refused if one exists; otherwise it must
    /// name the key currently active. That is what makes a captured request
    /// useless on replay.
    public func registerKey(algorithm: String, publicKey: String,
                            previousKeyID: String?) async throws -> InboxKey {
        struct Body: Decodable { let key: InboxKey }
        var payload: [String: Any] = ["algorithm": algorithm, "publicKey": publicKey]
        if let previousKeyID, !previousKeyID.isEmpty {
            payload["previousKeyId"] = previousKeyID
        }
        var req = request(.post, url: devicePath("inbox/keys"))
        req.httpBody = try encode(payload)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: Body = try await send(req)
        return body.key
    }

    public func listKeys() async throws -> [InboxKey] {
        struct Body: Decodable { let keys: [InboxKey] }
        let body: Body = try await send(request(.get, url: devicePath("inbox/keys")))
        return body.keys
    }

    // MARK: - presence

    /// Refresh presence and report whether the receive directory is usable RIGHT
    /// NOW. The caller probes immediately before each call, so a device whose
    /// folder grant was revoked stops advertising a directory it cannot write.
    @discardableResult
    public func heartbeat(receiveDirReady: Bool) async throws -> InboxHeartbeatResult {
        var req = request(.post, url: devicePath("inbox/heartbeat"))
        req.httpBody = try encode(["receiveDirReady": receiveDirReady])
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await send(req)
    }

    /// The graceful goodbye of a receiver shutting down or pausing: it expires
    /// this device's presence immediately instead of leaving senders to wait out
    /// the TTL believing the machine is still there.
    public func goOffline() async throws {
        try await sendDiscardingBody(request(.post, url: devicePath("inbox/offline")))
    }

    // MARK: - queue

    public func pending(limit: Int) async throws -> [InboxTask] {
        struct Body: Decodable { let tasks: [InboxTask] }
        var url = devicePath("inbox/pending")
        if limit > 0, var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            comps.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
            url = comps.url ?? url
        }
        let body: Body = try await send(request(.get, url: url))
        return body.tasks
    }

    public func claim(max: Int) async throws -> (deliveries: [InboxDelivery], leaseSeconds: Int) {
        struct Body: Decodable { let tasks: [InboxDelivery]; let leaseSeconds: Int? }
        var req = request(.post, url: devicePath("inbox/claim"))
        req.httpBody = try encode(["max": max])
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: Body = try await send(req)
        return (body.tasks, body.leaseSeconds ?? 0)
    }

    /// Open the task's ciphertext, resuming at `offset` when non-zero.
    ///
    /// The caller MUST check `isPartial`: when `offset > 0` and the server
    /// answered `200`, the stream is a fresh start rather than a tail and the
    /// whole transfer has to restart.
    public func blob(taskID: String, claimToken: String, offset: Int64) async throws -> InboxBlobStream {
        var req = request(.get, url: try taskPath(taskID, "blob"))
        req.setValue(claimToken, forHTTPHeaderField: InboxProtocol.claimTokenHeader)
        if offset > 0 {
            req.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range")
        }
        let (http, stream) = try await streamedChunks(req)
        guard (200..<300).contains(http.statusCode) else {
            // Drain rather than abandon: the body of a rejection is small and
            // carries the machine-readable token, and leaving it unread would
            // leave the connection unusable for the retry that follows.
            let code = await Self.errorToken(from: stream)
            throw InboxError.api(status: http.statusCode, code: code)
        }
        return InboxBlobStream(status: http.statusCode,
                               isPartial: http.statusCode == 206,
                               chunks: stream)
    }

    /// Record progress, the final commit, or a failure.
    ///
    /// Repeating the current state is an idempotent lease renewal, which is how a
    /// long download keeps its claim alive without a separate heartbeat endpoint.
    ///
    /// Two refusals happen HERE, before a request exists, because both would be
    /// this device asserting something it must not: a state central does not
    /// accept from a device, and `saved` without the commit assertion. Central
    /// refuses both as well; refusing locally means a bug in this client cannot
    /// even attempt the claim.
    @discardableResult
    public func report(taskID: String, claimToken: String, state: InboxTaskState,
                       errorCode: InboxDeviceErrorCode, committed: Bool) async throws -> InboxTask {
        guard state.isDeviceReportable else {
            throw InboxError.stateNotDeviceReportable(state)
        }
        guard state != .saved || committed else { throw InboxError.savedNotAsserted }
        struct Body: Decodable { let task: InboxTask }
        var req = request(.post, url: try taskPath(taskID, "report"))
        req.httpBody = try encode([
            "claimToken": claimToken, "state": state.rawValue,
            "errorCode": errorCode.rawValue, "committed": committed,
        ])
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: Body = try await send(req)
        return body.task
    }

    /// Resolve an `attention_required` task from this machine: `true` re-queues
    /// it, `false` ends it as `failed_terminal`/`user_declined`.
    @discardableResult
    public func accept(taskID: String, accept: Bool) async throws -> InboxTask {
        struct Body: Decodable { let task: InboxTask }
        var req = request(.post, url: try taskPath(taskID, "accept"))
        req.httpBody = try encode(["accept": accept])
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: Body = try await send(req)
        return body.task
    }

    /// Remove this device's enrolment and its whole key history, which also
    /// terminates its unfinished tasks as revoked. It must succeed before any
    /// local private key is destroyed.
    public func clearInbox() async throws {
        try await sendDiscardingBody(request(.delete, url: devicePath("inbox")))
    }

    // MARK: - request plumbing

    private enum Method: String { case get = "GET", post = "POST", put = "PUT", delete = "DELETE" }

    private func devicePath(_ suffix: String) -> URL {
        var url = baseURL.appendingPathComponent("api/devices").appendingPathComponent(deviceID)
        for component in suffix.split(separator: "/") {
            url = url.appendingPathComponent(String(component))
        }
        return url
    }

    /// A task id becomes a URL path component, so it goes through the same
    /// refusal the device id did. Central mints these itself, which is exactly
    /// why the check is here: this converts a REMOTE string into a path, and that
    /// conversion must not depend on a remote invariant staying true.
    private func taskPath(_ taskID: String, _ suffix: String) throws -> URL {
        guard let checked = try? StoredObjectID.checked(taskID) else {
            throw InboxError.invalidIdentifier
        }
        return devicePath("inbox/tasks").appendingPathComponent(checked)
            .appendingPathComponent(suffix)
    }

    private func request(_ method: Method, url: URL) -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = method.rawValue
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return req
    }

    private func encode(_ payload: [String: Any]) throws -> Data {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload) else {
            throw InboxError.malformedResponse
        }
        return data
    }

    private func send<T: Decodable>(_ req: URLRequest) async throws -> T {
        let (data, http) = try await perform(req)
        guard (200..<300).contains(http.statusCode) else {
            throw InboxError.api(status: http.statusCode, code: Self.errorToken(in: data))
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch let e as InboxError {
            // A closed-set refusal thrown out of a custom decoder. Preserved as
            // itself: "the server named a state we do not know" and "the body was
            // the wrong shape" are different facts with different remedies.
            throw e
        } catch {
            throw InboxError.malformedResponse
        }
    }

    private func sendDiscardingBody(_ req: URLRequest) async throws {
        let (data, http) = try await perform(req)
        guard (200..<300).contains(http.statusCode) else {
            throw InboxError.api(status: http.statusCode, code: Self.errorToken(in: data))
        }
    }

    private func perform(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw InboxError.network }
            return (data, http)
        } catch let e as InboxError {
            throw e
        } catch {
            // Deliberately drops the underlying error. `URLError` composes its
            // description from the request URL, which would put a device id and a
            // server host into any log line that formatted it.
            throw InboxError.network
        }
    }

    /// The `error` token of a rejection body, from a BOUNDED prefix.
    ///
    /// A body that is not JSON, or carries no token, yields "" — the caller then
    /// reports the status alone rather than echoing server text.
    static func errorToken(in data: Data) -> String {
        let bounded = data.prefix(maxErrorBody)
        struct Body: Decodable { let error: String? }
        guard let body = try? JSONDecoder().decode(Body.self, from: bounded) else { return "" }
        return body.error ?? ""
    }

    private static func errorToken(from stream: AsyncThrowingStream<Data, Error>) async -> String {
        var collected = Data()
        do {
            for try await chunk in stream {
                collected.append(chunk)
                if collected.count >= maxErrorBody { break }
            }
        } catch {
            return ""
        }
        return errorToken(in: collected)
    }

    /// How much of a rejection body is read before it is parsed. Remote input on
    /// a path that ends in a log, so it is bounded and never echoed verbatim.
    static let maxErrorBody = 4 << 10

    /// Bridges a data task to an async `Data`-chunk stream, resolving with the
    /// response as soon as headers arrive.
    ///
    /// Deliberately NOT `session.data(for:)`: a ciphertext body is arbitrarily
    /// large, and buffering it whole would put a delivery-sized allocation in a
    /// resident process. Deliberately not a blanket `URLSession.timeoutInterval`
    /// either — it would bound the whole request including the streaming body,
    /// killing any transfer slower than the cap mid-stream.
    private func streamedChunks(_ req: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, Error>) {
        do {
            var delegate: InboxBlobDelegate!
            let http: HTTPURLResponse = try await withCheckedThrowingContinuation { cont in
                delegate = InboxBlobDelegate(responseCont: cont)
                let task = session.dataTask(with: req)
                task.delegate = delegate
                // Terminating the stream cancels the transfer. Without this, a
                // caller that stops reading — which the receiver does on a lost
                // lease, a local write failure or a tampered frame — leaves a
                // delivery-sized download running to completion in the background,
                // spending the user's bandwidth on bytes nothing will consume.
                delegate.cancelOnTermination(task)
                task.resume()
            }
            return (http, delegate.stream)
        } catch {
            throw InboxError.network
        }
    }
}

/// Surfaces a data task's response and body as an async `Data`-chunk stream, so
/// the receiver can authenticate on frame boundaries instead of paying a
/// per-byte async suspension.
private final class InboxBlobDelegate: NSObject, URLSessionDataDelegate {
    private let responseCont: CheckedContinuation<HTTPURLResponse, Error>
    private var resumed = false
    let stream: AsyncThrowingStream<Data, Error>
    private var streamCont: AsyncThrowingStream<Data, Error>.Continuation!

    init(responseCont: CheckedContinuation<HTTPURLResponse, Error>) {
        self.responseCont = responseCont
        var c: AsyncThrowingStream<Data, Error>.Continuation!
        self.stream = AsyncThrowingStream { c = $0 }
        super.init()
        self.streamCont = c
    }

    /// Cancel `task` when the stream terminates, however it terminates —
    /// finished, thrown, or dropped by a caller that stopped reading. Cancelling
    /// an already-finished task is a no-op, so this costs nothing on the happy
    /// path.
    func cancelOnTermination(_ task: URLSessionDataTask) {
        streamCont.onTermination = { _ in task.cancel() }
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
        streamCont.yield(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if !resumed {
            resumed = true
            responseCont.resume(throwing: error ?? URLError(.badServerResponse))
        }
        if let error {
            streamCont.finish(throwing: error)
        } else {
            streamCont.finish()
        }
    }
}
