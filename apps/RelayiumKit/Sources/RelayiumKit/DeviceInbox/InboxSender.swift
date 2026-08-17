import Foundation

/// The SENDER half of the Device Inbox HTTP API.
///
/// Deliberately a separate type from `InboxClient`, and the split is the
/// security decision on this file. It mirrors the one central already makes
/// (`server/account/deviceinbox_task.go`): the device-self routes assert what a
/// MACHINE is doing with a file, while create/list/read/cancel are assertions
/// about the SENDER's own account.
///
/// Concretely, `InboxClient` is constructed around ONE device id — its own — and
/// every URL it builds is under that id, which is exactly what stops a receiver
/// acting on another device's row. A sender is the opposite: it addresses every
/// device the account owns EXCEPT, normally, itself. Giving the receiver client
/// a second identity to switch between would erase the property that makes it
/// safe. So the target id is a per-call argument here, checked on every call,
/// and this type holds no device identity at all.
///
/// PRE-IMPLEMENTATION INVARIANTS, each asserted by a test in
/// `InboxSenderClientTests`:
///
///  1. NO PLAINTEXT LEAVES. The create body has exactly seven keys, the seventh
///     being v2's integer `protocolVersion`. There is no shape, and no code
///     path, carrying a content key, a content kind, a file name, a destination
///     path, a message, a manifest plaintext or a device private key.
///  2. EVERY REMOTE IDENTIFIER IS CHECKED BEFORE IT BECOMES A URL. A target
///     device id and a task id are composed into paths, and
///     `appendingPathComponent` percent-encodes neither `/` nor `.`.
///  3. FAIL CLOSED ON VOCABULARY. Task responses decode through the same strict
///     `InboxTask` decoder the receiver uses: an unknown state or error code
///     throws rather than resolving to a default.
///  4. NOTHING REMOTE IS ECHOED. A rejection contributes its status and the
///     machine-readable token from a BOUNDED body prefix, and nothing else.

/// What a create returned: the task, and whether central minted it now.
///
/// `created` is not cosmetic. It is how a retry under the same idempotency key
/// is distinguished from a first attempt — central answers `201` for a new task
/// and `200` for a converged one — which is what lets a sender retry an
/// ambiguous create without risking a second delivery of the same bytes.
public struct InboxTaskCreation: Equatable, Sendable {
    public let task: InboxTask
    public let created: Bool

    public init(task: InboxTask, created: Bool) {
        self.task = task
        self.created = created
    }
}

/// One validated create. A struct rather than six loose arguments so the
/// refusals can be asserted without a transport, and so no call site can build
/// a request that skipped them.
///
/// Every field is checked in the initializer, in the same order and to the same
/// rule central applies. The initializer is the only way to make one.
public struct InboxSendRequest: Equatable, Sendable {
    public let idempotencyKey: String
    public let storedFileID: String
    public let wrapAlgorithm: String
    public let wrappedKey: String
    public let targetKeyID: String
    public let targetKeyGeneration: Int64

    public init(idempotencyKey: String, storedFileID: String,
                wrapAlgorithm: String = InboxProtocol.keyAlgorithm,
                wrappedKey: String, targetKeyID: String,
                targetKeyGeneration: Int64) throws {
        guard InboxIdempotencyKey.isValid(idempotencyKey) else {
            throw InboxError.invalidIdempotencyKey
        }
        guard let storedFile = try? StoredObjectID.checked(storedFileID),
              let keyID = try? StoredObjectID.checked(targetKeyID) else {
            throw InboxError.invalidIdentifier
        }
        guard wrapAlgorithm == InboxProtocol.keyAlgorithm else {
            throw InboxError.unsupportedWrapAlgorithm
        }
        // The same shape check central makes, so a malformed box fails here
        // rather than after the ciphertext has already been uploaded.
        guard (try? InboxKeyMaterial.decode(wrappedKey,
                                            expecting: InboxProtocol.sealedBoxBytes)) != nil else {
            throw InboxError.invalidWrappedKey
        }
        guard targetKeyGeneration > 0 else { throw InboxError.invalidKeyGeneration }
        self.idempotencyKey = idempotencyKey
        self.storedFileID = storedFile
        self.wrapAlgorithm = wrapAlgorithm
        self.wrappedKey = wrappedKey
        self.targetKeyID = keyID
        self.targetKeyGeneration = targetKeyGeneration
    }

    /// The request body, and the ONLY thing that becomes one.
    ///
    /// Spelled out as a literal rather than encoded from `self` so the wire
    /// shape is readable at the one place it is decided: a field added to this
    /// type does not silently become a field on the wire.
    var payload: [String: Any] {
        [
            "idempotencyKey": idempotencyKey,
            "storedFileId": storedFileID,
            // The protocol the sealed manifest was written to. An integer, and
            // the ONLY thing v2 added here: still no kind, no name, no text.
            "protocolVersion": InboxProtocol.taskProtocolVersion,
            "wrapAlgorithm": wrapAlgorithm,
            "wrappedKey": wrappedKey,
            "targetKeyId": targetKeyID,
            "targetKeyGeneration": targetKeyGeneration,
        ]
    }
}

/// The one rule for a sender-minted creation key, matching
/// `printableASCIIToken` and `inbox.MaxIdempotencyKeyLen` on the server.
public enum InboxIdempotencyKey {
    /// `inbox.MaxIdempotencyKeyLen`. A bound rather than a format, because the
    /// key is opaque to central — but an unbounded one would be a free-text
    /// field on a queue row, which is exactly what this protocol does not have.
    public static let maxLength = 128

    /// Printable ASCII with neither space nor DEL, byte for byte what central
    /// accepts. Written against UTF-8 bytes rather than Characters so a
    /// multi-byte scalar cannot pass a per-Character check and then exceed the
    /// server's per-BYTE length bound.
    public static func isValid(_ key: String) -> Bool {
        let bytes = Array(key.utf8)
        guard !bytes.isEmpty, bytes.count <= maxLength else { return false }
        return bytes.allSatisfy { $0 > 0x20 && $0 <= 0x7e }
    }

    /// Mint one. A UUID string: 36 characters, all inside the accepted set, and
    /// unguessable enough that two concurrent sends cannot collide onto one
    /// task.
    public static func mint() -> String { UUID().uuidString }
}

/// The account-scoped calls a sending client makes.
///
/// A protocol for the same reason `InboxTransport` is one: the interesting
/// behaviour is what a sender does with an ambiguous create, a task that went
/// terminal between poll and read, and a cancel that raced a device claim —
/// none of which is reachable through a URL stub alone.
public protocol InboxSenderTransport: AnyObject, Sendable {
    /// Every device on the caller's account, including this one. Filtering is
    /// the caller's job: which devices are eligible targets is a product
    /// decision about presence, capability and key state, not a transport one.
    func devices() async throws -> [InboxDeviceRow]
    func createTask(targetDeviceID: String,
                    _ request: InboxSendRequest) async throws -> InboxTaskCreation
    func task(targetDeviceID: String, taskID: String) async throws -> InboxTask
    func tasks(targetDeviceID: String, limit: Int) async throws -> [InboxTask]
    func cancelTask(targetDeviceID: String, taskID: String) async throws
}

public final class InboxSenderClient: InboxSenderTransport, @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let token: String

    /// No device id, by construction. See the type comment: a sender addresses
    /// many devices, and an instance bound to one would either be useless or
    /// would have to switch identities, which is the property that makes the
    /// receiver client safe.
    public init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    // MARK: - targets

    public func devices() async throws -> [InboxDeviceRow] {
        struct Body: Decodable { let devices: [InboxDeviceRow] }
        let body: Body = try await send(request(.get,
                                                url: baseURL.appendingPathComponent("api/devices")))
        return body.devices
    }

    // MARK: - tasks

    /// Queue one encrypted delivery to one of the caller's own devices.
    ///
    /// Idempotent by the request's own key: central answers `201` with a new
    /// task, or `200` with the task that key already made. A caller that lost
    /// the answer to a previous attempt repeats this call with the SAME
    /// `InboxSendRequest` and converges on exactly one delivery.
    public func createTask(targetDeviceID: String,
                           _ sendRequest: InboxSendRequest) async throws -> InboxTaskCreation {
        struct Body: Decodable { let task: InboxTask; let created: Bool }
        var req = request(.post, url: try tasksPath(targetDeviceID))
        req.httpBody = try encode(sendRequest.payload)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (body, status): (Body, Int) = try await sendWithStatus(req)
        // The status is the authority on whether this attempt minted the task;
        // the body's flag is carried by central for the same purpose. They are
        // required to agree, because a sender that believed a converged retry
        // was a fresh send would report a second delivery that does not exist.
        guard status == 200 || status == 201,
              body.created == (status == 201),
              body.task.targetDeviceID == targetDeviceID,
              body.task.idempotencyKey == sendRequest.idempotencyKey,
              body.task.storedFileID == sendRequest.storedFileID,
              body.task.wrapAlgorithm == sendRequest.wrapAlgorithm,
              body.task.targetKeyID == sendRequest.targetKeyID,
              body.task.targetKeyGeneration == sendRequest.targetKeyGeneration else {
            throw InboxError.malformedResponse
        }
        return InboxTaskCreation(task: body.task, created: body.created)
    }

    public func task(targetDeviceID: String, taskID: String) async throws -> InboxTask {
        struct Body: Decodable { let task: InboxTask }
        let body: Body = try await send(request(.get,
                                                url: try taskPath(targetDeviceID, taskID)))
        return body.task
    }

    public func tasks(targetDeviceID: String, limit: Int) async throws -> [InboxTask] {
        struct Body: Decodable { let tasks: [InboxTask] }
        var url = try tasksPath(targetDeviceID)
        if limit > 0, var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            comps.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
            url = comps.url ?? url
        }
        let body: Body = try await send(request(.get, url: url))
        return body.tasks
    }

    /// Cancel a task the sender owns. Central refuses one a device is already
    /// downloading or verifying, so this is not a way to delete ciphertext out
    /// from under a live receiver.
    public func cancelTask(targetDeviceID: String, taskID: String) async throws {
        try await sendDiscardingBody(request(.delete,
                                             url: try taskPath(targetDeviceID, taskID)))
    }

    // MARK: - request plumbing

    private enum Method: String { case get = "GET", post = "POST", delete = "DELETE" }

    /// A target device id becomes a URL path component, so it goes through the
    /// same refusal `InboxClient` applies to its own — and here it matters more,
    /// because this one is chosen per call rather than fixed at construction.
    private func tasksPath(_ deviceID: String) throws -> URL {
        guard let checked = try? StoredObjectID.checked(deviceID) else {
            throw InboxError.invalidIdentifier
        }
        return baseURL.appendingPathComponent("api/devices")
            .appendingPathComponent(checked)
            .appendingPathComponent("inbox")
            .appendingPathComponent("tasks")
    }

    private func taskPath(_ deviceID: String, _ taskID: String) throws -> URL {
        guard let checked = try? StoredObjectID.checked(taskID) else {
            throw InboxError.invalidIdentifier
        }
        return try tasksPath(deviceID).appendingPathComponent(checked)
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
        let (value, _): (T, Int) = try await sendWithStatus(req)
        return value
    }

    private func sendWithStatus<T: Decodable>(_ req: URLRequest) async throws -> (T, Int) {
        let (data, http) = try await perform(req)
        guard (200..<300).contains(http.statusCode) else {
            throw InboxError.api(status: http.statusCode,
                                 code: InboxClient.errorToken(in: data))
        }
        do {
            return (try JSONDecoder().decode(T.self, from: data), http.statusCode)
        } catch let e as InboxError {
            // A closed-set refusal thrown out of `InboxTask`'s decoder, kept as
            // itself: "central named a state we do not know" and "the body was
            // the wrong shape" are different facts with different remedies.
            throw e
        } catch {
            throw InboxError.malformedResponse
        }
    }

    private func sendDiscardingBody(_ req: URLRequest) async throws {
        let (data, http) = try await perform(req)
        guard (200..<300).contains(http.statusCode) else {
            throw InboxError.api(status: http.statusCode,
                                 code: InboxClient.errorToken(in: data))
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
            // Drops the underlying error deliberately: `URLError` composes its
            // description from the request URL, which would put a device id and
            // a server host into any log line that formatted it.
            throw InboxError.network
        }
    }
}
