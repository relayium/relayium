import Foundation
import RelayiumKit

/// The minimum durable state needed to keep following a task after the staged
/// upload has been retired. No plaintext, path, content key, bearer or upload
/// credential is represented by this type.
struct InboxDeliveryTrackingRecord: Codable, Equatable, Sendable {
    struct File: Codable, Equatable, Sendable {
        let name: String
        let size: Int
    }

    let accountID: String
    let jobID: String
    let taskID: String
    let targetDeviceID: String
    let createdAt: Int64
    let files: [File]
    let fileCount: Int
    let byteCount: Int
    var state: InboxTaskState
    var savedAt: Int64
    var expiresAt: Int64

    init(plan: PendingUploadPlan, targetDeviceID: String, task: InboxTask) {
        accountID = plan.accountId
        jobID = plan.jobId
        taskID = task.id
        self.targetDeviceID = targetDeviceID
        createdAt = plan.createdAt
        files = plan.effectiveDeliveryKind == .file
            ? plan.files.map { File(name: $0.name, size: $0.size) } : []
        fileCount = plan.files.count
        byteCount = plan.totalBytes
        state = task.state
        savedAt = task.savedAt
        expiresAt = task.expiresAt
    }

    init?(history entry: InboxTimelineEntry, accountID: String) {
        guard entry.direction == .sent, entry.sentState == .created,
              let jobID = entry.jobID, let taskID = entry.sentTaskID else { return nil }
        self.accountID = accountID
        self.jobID = jobID
        self.taskID = taskID
        targetDeviceID = entry.peerDeviceID
        createdAt = Int64(entry.at.timeIntervalSince1970)
        files = entry.sentFiles.compactMap {
            guard $0.size >= 0, $0.size <= Int64(Int.max) else { return nil }
            return File(name: $0.name, size: Int($0.size))
        }
        guard files.count == entry.sentFiles.count,
              entry.byteCount >= 0, entry.byteCount <= Int64(Int.max) else { return nil }
        fileCount = entry.kind == .message ? 1 : files.count
        byteCount = Int(entry.byteCount)
        state = .queued
        savedAt = 0
        expiresAt = 0
    }

    var task: InboxTask {
        InboxTask(id: taskID, targetDeviceID: targetDeviceID, state: state,
                  expiresAt: expiresAt, savedAt: savedAt)
    }
}

/// One atomic JSON file per job. Per-record files make account isolation and
/// crash recovery independent: a damaged record cannot erase every other send.
final class InboxDeliveryTrackingStore: @unchecked Sendable {
    private let root: URL
    private let fileManager: FileManager
    private let lock = NSLock()

    init(root: URL, fileManager: FileManager = .default) {
        self.root = root
        self.fileManager = fileManager
    }

    func records(for accountID: String) -> [InboxDeliveryTrackingRecord] {
        lock.lock(); defer { lock.unlock() }
        guard let urls = try? fileManager.contentsOfDirectory(at: root,
                                                               includingPropertiesForKeys: nil) else {
            return []
        }
        return urls.compactMap { url in
            guard url.pathExtension == "json",
                  let data = try? Data(contentsOf: url),
                  let record = try? JSONDecoder().decode(InboxDeliveryTrackingRecord.self,
                                                         from: data),
                  record.accountID == accountID,
                  url.deletingPathExtension().lastPathComponent == record.jobID else { return nil }
            return record
        }
    }

    func record(_ task: InboxTask, for plan: PendingUploadPlan,
                targetDeviceID: String) throws {
        try write(InboxDeliveryTrackingRecord(plan: plan, targetDeviceID: targetDeviceID,
                                               task: task))
    }

    func migrate(_ entry: InboxTimelineEntry, accountID: String) {
        guard let record = InboxDeliveryTrackingRecord(history: entry, accountID: accountID),
              !fileManager.fileExists(atPath: recordURL(record.jobID).path) else { return }
        try? write(record)
    }

    func update(jobID: String, accountID: String, task: InboxTask) throws {
        lock.lock(); defer { lock.unlock() }
        let url = recordURL(jobID)
        let data = try Data(contentsOf: url)
        var record = try JSONDecoder().decode(InboxDeliveryTrackingRecord.self, from: data)
        guard record.jobID == jobID, record.accountID == accountID,
              record.taskID == task.id else { throw CocoaError(.fileReadCorruptFile) }
        record.state = task.state
        record.savedAt = task.savedAt
        record.expiresAt = task.expiresAt
        try writeLocked(record)
    }

    func remove(jobID: String, accountID: String) {
        lock.lock(); defer { lock.unlock() }
        let url = recordURL(jobID)
        guard let data = try? Data(contentsOf: url),
              let record = try? JSONDecoder().decode(InboxDeliveryTrackingRecord.self, from: data),
              record.accountID == accountID, record.jobID == jobID else { return }
        try? fileManager.removeItem(at: url)
    }

    private func write(_ record: InboxDeliveryTrackingRecord) throws {
        lock.lock(); defer { lock.unlock() }
        try writeLocked(record)
    }

    private func writeLocked(_ record: InboxDeliveryTrackingRecord) throws {
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true,
                                        attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(record)
        try data.write(to: recordURL(record.jobID), options: [.atomic])
        try? fileManager.setAttributes([.posixPermissions: 0o600],
                                       ofItemAtPath: recordURL(record.jobID).path)
    }

    private func recordURL(_ jobID: String) -> URL {
        root.appendingPathComponent(jobID, isDirectory: false).appendingPathExtension("json")
    }
}
