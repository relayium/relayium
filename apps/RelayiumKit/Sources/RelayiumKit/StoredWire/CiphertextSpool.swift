import Foundation
import CryptoKit
import Darwin

/// Bounded ciphertext producers shared by live encryption and durable replay.
public protocol UploadCipherSource: AnyObject {
    var dropFromFirstFrame: Int { get }
    func next() throws -> Data?
}

/// No content key or plaintext: the exact encrypted manifest and stream identity.
public struct CiphertextSpoolRecord: Codable, Equatable, Sendable {
    public let header: Data
    public let size: Int
    public let sha256: Data
    public let authentication: Data

    public func authenticates(key: [UInt8]) -> Bool {
        let input = Data("relayium/stored-share-spool/v1\0".utf8) + header + sha256 + Data(String(size).utf8)
        return HMAC<SHA256>.isValidAuthenticationCode(authentication, authenticating: input, using: SymmetricKey(data: key))
    }
}

/// A complete, private ciphertext copy. A retry NEVER seals plaintext again.
/// Opening pins a regular file and verifies all bytes before any network call.
public final class CiphertextSpool: UploadCipherSource {
    public let record: CiphertextSpoolRecord
    public var dropFromFirstFrame: Int { 0 }
    private var source: FileURLSource
    private var remaining: Int

    public static func prepare(at url: URL, sources: [PlaintextSource], key: [UInt8]) throws -> CiphertextSpoolRecord {
        let header = try CloudUploader.manifestHeader(key: key, sources: sources, manifest: .storedWire)
        // Exclusive/no-follow: a partial prior seal is never overwritten under
        // the same key, and a link cannot redirect the output outside its job.
        let fd = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw StoredWireError.lengthMismatch }
        let output = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? output.close() }
        let encoder = ChunkEncryptor(key: key, sources: sources)
        var hash = SHA256()
        var size = 0
        while let bytes = try encoder.next() {
            try Task.checkCancellation()
            try output.write(contentsOf: bytes)
            hash.update(data: bytes)
            let (next, overflow) = size.addingReportingOverflow(bytes.count)
            guard !overflow else { throw StoredWireError.lengthMismatch }
            size = next
        }
        guard size == cipherSizeFor(sources.map(\.size)) else { throw StoredWireError.lengthMismatch }
        try output.synchronize()
        let digest = Data(hash.finalize())
        let input = Data("relayium/stored-share-spool/v1\0".utf8) + Data(header) + digest + Data(String(size).utf8)
        let authentication = Data(HMAC<SHA256>.authenticationCode(for: input, using: SymmetricKey(data: key)))
        return CiphertextSpoolRecord(header: Data(header), size: size, sha256: digest, authentication: authentication)
    }

    public init(at url: URL, record: CiphertextSpoolRecord, offset: Int = 0) throws {
        guard record.size >= 0, record.sha256.count == 32, !record.header.isEmpty,
              offset >= 0, offset <= record.size else { throw StoredWireError.lengthMismatch }
        let pinned = try FileURLSource(url: url)
        guard pinned.size == record.size else { throw StoredWireError.lengthMismatch }
        var verification = pinned
        var hash = SHA256()
        while true {
            try Task.checkCancellation()
            let bytes = try verification.read(STORE_CHUNK_SIZE)
            if bytes.isEmpty { break }
            hash.update(data: bytes)
        }
        guard Data(hash.finalize()) == record.sha256 else { throw StoredWireError.lengthMismatch }
        source = pinned
        var skipped = 0
        while skipped < offset {
            let bytes = try source.read(min(STORE_CHUNK_SIZE, offset - skipped))
            guard !bytes.isEmpty else { throw StoredWireError.lengthMismatch }
            skipped += bytes.count
        }
        remaining = record.size - offset
        self.record = record
    }

    public func next() throws -> Data? {
        guard remaining > 0 else { return nil }
        let bytes = try source.read(min(STORE_CHUNK_SIZE, remaining))
        guard !bytes.isEmpty else { throw StoredWireError.lengthMismatch }
        remaining -= bytes.count
        return Data(bytes)
    }
}
