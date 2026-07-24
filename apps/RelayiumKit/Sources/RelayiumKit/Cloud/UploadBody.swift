import Foundation

/// Assemble the `POST /api/files` body: uint32BE(len(encManifest)) || encManifest
/// || frameStream. Mirrors web/src/lib/stored-file.ts uploadFile's part assembly.
public func encodeUploadBody(key: [UInt8], manifest: StoredManifest, files: [[UInt8]]) throws -> [UInt8] {
    let encManifest = try encryptManifest(key: key, manifest)   // seq 0
    let frameStream = encryptChunks(key: key, files: files)    // seq 1,2,…
    let n = encManifest.count
    var out = [UInt8]()
    out.reserveCapacity(4 + encManifest.count + frameStream.count)
    out += [UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)]
    out += encManifest
    out += frameStream
    return out
}
