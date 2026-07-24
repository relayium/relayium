import Foundation
import Clibsodium

public enum StoredWireError: Error, Equatable {
    case invalidKey, frameTooLarge, truncatedStream, lengthMismatch
}

/// base64url, no padding (libsodium URLSAFE_NO_PADDING): standard base64 then
/// +→-, /→_, strip trailing '='.
public func encodeStoreKey(_ raw: [UInt8]) -> String {
    let b64 = Data(raw).base64EncodedString()
    return b64.replacingOccurrences(of: "+", with: "-")
              .replacingOccurrences(of: "/", with: "_")
              .replacingOccurrences(of: "=", with: "")
}

/// Strict decode. Rejects any char outside [A-Za-z0-9_-] and any length where
/// length % 4 == 1 (base64 can't produce it — fail loud, never decode garbage).
public func decodeStoreKey(_ s: String) throws -> [UInt8] {
    let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
    guard s.allSatisfy({ allowed.contains($0) }), s.count % 4 != 1 else {
        throw StoredWireError.invalidKey
    }
    var b64 = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b64.count % 4 != 0 { b64 += "=" }
    guard let data = Data(base64Encoded: b64) else { throw StoredWireError.invalidKey }
    return [UInt8](data)
}

public func generateStoreKey() -> [UInt8] {
    ensureSodiumInit()
    var k = [UInt8](repeating: 0, count: 32)
    randombytes_buf(&k, 32)
    return k
}
