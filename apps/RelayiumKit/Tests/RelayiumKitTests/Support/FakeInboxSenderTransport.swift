import Foundation
@testable import RelayiumKit

/// A scriptable stand-in for the account-scoped half of central.
///
/// It exists for the same reason `FakeInboxTransport` does: the behaviour worth
/// asserting here is unreachable through a URL stub. An answer that never
/// arrives, a create that succeeds on the wire and is lost on the way back, a
/// device that rotates its key BETWEEN the read and the create — each is one
/// line of script here and an entire afternoon with a real server.
///
/// Every call is recorded in order, because the sharpest assertions in this area
/// are about what did NOT happen: a second create carrying a fresh idempotency
/// key, a re-upload after a reseal, a DELETE issued against a task central is
/// actively downloading.
final class FakeInboxSenderTransport: InboxSenderTransport, @unchecked Sendable {

    enum Call: Equatable {
        case devices
        case create(device: String, idempotencyKey: String, storedFile: String,
                    wrappedKey: String, keyID: String, keyGeneration: Int64)
        case task(device: String, task: String)
        case tasks(device: String, limit: Int)
        case cancel(device: String, task: String)
    }

    private let lock = NSLock()
    private var _calls: [Call] = []
    var calls: [Call] { sync { _calls } }
    private func record(_ call: Call) { sync { _calls.append(call) } }

    /// Non-`async`, deliberately: taking an `NSLock` inside an `async` function
    /// is an error under the Swift 6 language mode.
    @discardableResult
    private func sync<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }

    // MARK: - script

    /// Rows returned by `devices()`, re-read on every call so a test can rotate
    /// a key between the seal and the create.
    var deviceRows: [InboxDeviceRow] = []
    var devicesError: Error?

    /// Consumed front-to-back, one per `createTask`. When it runs dry the last
    /// entry repeats, so "every attempt fails the same way" is one entry.
    var createOutcomes: [Result<InboxTaskCreation, Error>] = []
    private var createIndex = 0

    var taskResults: [Result<InboxTask, Error>] = []
    private var taskIndex = 0

    var listedTasks: [InboxTask] = []
    var tasksError: Error?

    var cancelError: Error?

    /// Invoked before each `createTask` answer is produced, so a test can
    /// rotate the device list at the exact instant a create is in flight.
    var beforeCreate: (@Sendable (Int) -> Void)?

    // MARK: - InboxSenderTransport

    func devices() async throws -> [InboxDeviceRow] {
        record(.devices)
        if let devicesError { throw devicesError }
        return sync { deviceRows }
    }

    func createTask(targetDeviceID: String,
                    _ request: InboxSendRequest) async throws -> InboxTaskCreation {
        let n = sync { createIndex }
        beforeCreate?(n)
        record(.create(device: targetDeviceID, idempotencyKey: request.idempotencyKey,
                       storedFile: request.storedFileID, wrappedKey: request.wrappedKey,
                       keyID: request.targetKeyID,
                       keyGeneration: request.targetKeyGeneration))
        let outcome: Result<InboxTaskCreation, Error>? = sync {
            guard !createOutcomes.isEmpty else { return nil }
            let value = createOutcomes[min(createIndex, createOutcomes.count - 1)]
            createIndex += 1
            return value
        }
        guard let outcome else { throw InboxError.network }
        return try outcome.get()
    }

    func task(targetDeviceID: String, taskID: String) async throws -> InboxTask {
        record(.task(device: targetDeviceID, task: taskID))
        let outcome: Result<InboxTask, Error>? = sync {
            guard !taskResults.isEmpty else { return nil }
            let value = taskResults[min(taskIndex, taskResults.count - 1)]
            taskIndex += 1
            return value
        }
        guard let outcome else { throw InboxError.network }
        return try outcome.get()
    }

    func tasks(targetDeviceID: String, limit: Int) async throws -> [InboxTask] {
        record(.tasks(device: targetDeviceID, limit: limit))
        if let tasksError { throw tasksError }
        return sync { listedTasks }
    }

    func cancelTask(targetDeviceID: String, taskID: String) async throws {
        record(.cancel(device: targetDeviceID, task: taskID))
        if let cancelError { throw cancelError }
    }

    // MARK: - readers

    var creates: [Call] { calls.filter { if case .create = $0 { return true }; return false } }

    var createdIdempotencyKeys: [String] {
        calls.compactMap { call in
            if case .create(_, let key, _, _, _, _) = call { return key }
            return nil
        }
    }

    var createdWrappedKeys: [String] {
        calls.compactMap { call in
            if case .create(_, _, _, let wrapped, _, _) = call { return wrapped }
            return nil
        }
    }

    var createdKeyIdentities: [String] {
        calls.compactMap { call in
            if case .create(_, _, _, _, let id, let generation) = call {
                return "\(id)/\(generation)"
            }
            return nil
        }
    }
}

/// Records what was deleted, and can refuse. Stands in for the account's own
/// stored-object routes, which is where an unbound `device_task` object's quota
/// is returned.
final class FakeStoredObjectService: AccountManagementService, @unchecked Sendable {
    private let lock = NSLock()
    private var _deleted: [String] = []
    var deleted: [String] { lock.lock(); defer { lock.unlock() }; return _deleted }
    var deleteError: Error?
    var deletion: StoredFileDeletion = .deleted

    func listDevices(token: String) async throws -> [AccountDevice] { [] }
    func deleteDevice(id: String, token: String) async throws {}
    func listStoredFiles(token: String) async throws -> [StoredFileSummary] { [] }

    func deleteStoredFile(id: String, token: String) async throws -> StoredFileDeletion {
        lock.lock(); _deleted.append(id); lock.unlock()
        if let deleteError { throw deleteError }
        return deletion
    }
}
