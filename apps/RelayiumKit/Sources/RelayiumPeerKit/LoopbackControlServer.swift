import Foundation
import Network

/// The acceptance peer's control, status and result API.
///
/// **Bound to `127.0.0.1` on an ephemeral port, and that is a property of the
/// socket rather than of a check in a handler.** `NWListener` with
/// `requiredLocalEndpoint` set to a loopback address gives the kernel the
/// constraint: nothing off this machine can complete a TCP handshake to it in
/// the first place, so there is no request for an authorization check to be the
/// only thing standing between a stranger and this peer's file contents. The
/// bearer check below is the second layer, for the other processes on this same
/// machine — a shared build agent runs several — and not the first.
///
/// **Port 0.** A fixed port is how two concurrent runs on one machine end up
/// talking to each other's peer, and how a run fails because something
/// unrelated already holds the port. The kernel assigns one, and the launcher
/// reads it back from the peer's own announcement.
public final class LoopbackControlServer: @unchecked Sendable {

    public struct Route {
        public let method: String
        public let path: String
        public let handler: @Sendable (Data) -> (status: Int, body: Data)
        public init(method: String, path: String,
                    handler: @escaping @Sendable (Data) -> (status: Int, body: Data)) {
            self.method = method
            self.path = path
            self.handler = handler
        }
    }

    public enum ServerError: Error, Equatable {
        case cannotListen(String)
        case noPortAssigned
    }

    private let listener: NWListener
    private let token: String
    private let routes: [String: Route]
    private let queue = DispatchQueue(label: "com.relayium.acceptance.control")
    private let log: @Sendable (String) -> Void

    /// - Parameter token: the shared secret every request must carry.
    ///   **Never read from `CommandLine`.** It arrives in the environment, which
    ///   `ps` does not publish, because argv on macOS is readable by any process
    ///   the same user runs — including anything a build script pulled in.
    public init(token: String,
                routes: [Route],
                log: @escaping @Sendable (String) -> Void) throws {
        guard !token.isEmpty else { throw ServerError.cannotListen("empty token") }
        self.token = token
        self.log = log
        self.routes = Dictionary(uniqueKeysWithValues: routes.map { ("\($0.method) \($0.path)", $0) })
        let parameters = NWParameters.tcp
        // The loopback bind. `.requiredLocalEndpoint` is what makes this a
        // socket-level constraint rather than a hostname the resolver picks.
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        parameters.allowLocalEndpointReuse = false
        do {
            listener = try NWListener(using: parameters)
        } catch {
            throw ServerError.cannotListen("\(error)")
        }
    }

    /// Starts listening and returns the port the kernel assigned.
    public func start(timeout: TimeInterval = 10) throws -> UInt16 {
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
            if case .failed = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + timeout) == .success,
              let port = listener.port?.rawValue, port != 0 else {
            listener.cancel()
            throw ServerError.noPortAssigned
        }
        return port
    }

    public func stop() {
        listener.cancel()
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    /// Reads until the headers are complete and the declared body has arrived.
    ///
    /// A hand-rolled reader rather than a framework one because this speaks to
    /// exactly one client — the launcher's `curl` — and adding an HTTP server
    /// dependency to a package whose entire dependency argument is "two pinned
    /// packages, both load-bearing for the crypto or the transport" is a worse
    /// trade than 40 lines of parsing that only ever has to be right about
    /// `Content-Length`.
    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) {
            [weak self] chunk, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let chunk { buffer += chunk }
            if error != nil { connection.cancel(); return }
            if let request = Self.parse(buffer) {
                respond(connection, to: request)
                return
            }
            if isComplete { connection.cancel(); return }
            // A request that never completes must not hold a slot forever, and
            // must not grow without bound: 1 MiB is far past anything this API
            // accepts and far short of anything that matters.
            guard buffer.count < 1 << 20 else { connection.cancel(); return }
            receive(connection, buffer: buffer)
        }
    }

    struct Request {
        var method: String
        var path: String
        var authorization: String?
        var body: Data
    }

    /// nil means "not yet complete", not "malformed" — the caller reads more.
    static func parse(_ buffer: Data) -> Request? {
        let separator = Data("\r\n\r\n".utf8)
        guard let headerEnd = buffer.range(of: separator) else { return nil }
        let head = String(decoding: buffer[..<headerEnd.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return nil }
        var authorization: String?
        var contentLength = 0
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let field = line[..<colon].lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if field == "authorization" { authorization = value }
            if field == "content-length" { contentLength = Int(value) ?? 0 }
        }
        let bodyStart = headerEnd.upperBound
        let available = buffer.count - bodyStart
        guard available >= contentLength else { return nil }
        // The path only; a query string is not part of any route here, and
        // silently routing `/result?anything` to `/result` would make a typo
        // look like a working request.
        let path = String(requestLine[1]).split(separator: "?", maxSplits: 1).first.map(String.init) ?? "/"
        return Request(method: String(requestLine[0]), path: path,
                       authorization: authorization,
                       body: buffer.subdata(in: bodyStart..<(bodyStart + contentLength)))
    }

    private func respond(_ connection: NWConnection, to request: Request) {
        guard authorized(request) else {
            log("control: refused \(request.method) \(request.path) — bad or missing token")
            return write(connection, status: 401, body: Data(#"{"error":"unauthorized"}"#.utf8))
        }
        guard let route = routes["\(request.method) \(request.path)"] else {
            return write(connection, status: 404, body: Data(#"{"error":"no such route"}"#.utf8))
        }
        let (status, body) = route.handler(request.body)
        write(connection, status: status, body: body)
    }

    /// Constant-time over the token bytes.
    ///
    /// The comparison is not a realistic attack surface on a loopback socket
    /// against a process that lives for one run — but the token is the only
    /// thing separating two concurrent runs on a shared agent, and an
    /// early-exit `==` on a secret is the kind of thing that is free to get
    /// right here and expensive to notice later.
    private func authorized(_ request: Request) -> Bool {
        guard let header = request.authorization,
              header.hasPrefix("Bearer ") else { return false }
        let presented = Array(header.dropFirst("Bearer ".count).utf8)
        let expected = Array(token.utf8)
        guard presented.count == expected.count else { return false }
        var difference: UInt8 = 0
        for (a, b) in zip(presented, expected) { difference |= a ^ b }
        return difference == 0
    }

    private func write(_ connection: NWConnection, status: Int, body: Data) {
        var head = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\n"
        head += "Content-Type: application/json\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Connection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + body,
                        completion: .contentProcessed { _ in connection.cancel() })
    }
}
