import Foundation
import CryptoKit

/// 12-byte nonce derived from the frame sequence number. Mirrors crypto.ts
/// nonceFromSeq: 4 zero bytes, then BE high-32 of seq, then BE low-32.
public func nonceFromSeq(_ seq: UInt64) -> [UInt8] {
    var n = [UInt8](repeating: 0, count: 12)
    let hi = UInt32(truncatingIfNeeded: seq >> 32)
    let lo = UInt32(truncatingIfNeeded: seq)
    n[4] = UInt8(hi >> 24 & 0xff); n[5] = UInt8(hi >> 16 & 0xff)
    n[6] = UInt8(hi >> 8 & 0xff);  n[7] = UInt8(hi & 0xff)
    n[8] = UInt8(lo >> 24 & 0xff); n[9] = UInt8(lo >> 16 & 0xff)
    n[10] = UInt8(lo >> 8 & 0xff); n[11] = UInt8(lo & 0xff)
    return n
}

/// AES-256-GCM via CryptoKit, ciphertext with the 16-byte tag appended
/// (ct || tag), matching Web Crypto's AES-GCM output layout.
///
/// NOTE: this intentionally uses CryptoKit's AES.GCM rather than libsodium's
/// crypto_aead_aes256gcm. libsodium reports that primitive as unavailable on
/// Apple Silicon (crypto_aead_aes256gcm_is_available() returns 0, since its
/// AES-GCM implementation is gated on x86 AES-NI) — relying on it would be
/// fragile across machines / CI / swift-sodium versions even though it
/// happens to produce correct output on some builds. CryptoKit's AES.GCM is
/// guaranteed-available and hardware-accelerated on every Apple platform and
/// is standard, interoperable AES-256-GCM.
public func seal(key: [UInt8], seq: UInt64, plaintext: [UInt8]) -> [UInt8] {
    let nonce = try! AES.GCM.Nonce(data: Data(nonceFromSeq(seq)))
    let box = try! AES.GCM.seal(Data(plaintext), using: SymmetricKey(data: key), nonce: nonce)
    // box.combined would prepend the nonce; the wire layout here is ct||tag
    // only, since the nonce is derived from seq independently on both ends.
    return [UInt8](box.ciphertext) + [UInt8](box.tag)
}

public func open(key: [UInt8], seq: UInt64, ciphertext: [UInt8]) -> [UInt8]? {
    guard ciphertext.count >= 16 else { return nil }
    let ct = ciphertext[..<(ciphertext.count - 16)]
    let tag = ciphertext[(ciphertext.count - 16)...]
    guard let nonce = try? AES.GCM.Nonce(data: Data(nonceFromSeq(seq))) else { return nil }
    guard let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: Data(ct), tag: Data(tag)) else {
        return nil
    }
    guard let pt = try? AES.GCM.open(box, using: SymmetricKey(data: key)) else { return nil }
    return [UInt8](pt)
}
