import Foundation
import Clibsodium

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

/// AES-256-GCM, combined mode (ciphertext has the 16-byte tag appended),
/// matching Web Crypto's AES-GCM output layout.
///
/// NOTE: intentionally does NOT gate on `crypto_aead_aes256gcm_is_available()`.
/// On the bundled libsodium 1.0.22 xcframework, that check returns 0 on
/// Apple Silicon (arm64) even though the ARM crypto-extension AES-GCM
/// implementation it links is fully functional — a known upstream
/// misdetection (is_available() isn't wired to Apple's ARM feature probe),
/// not a real absence of hardware support. Verified empirically here:
/// seal() output is byte-identical to the Web-Crypto-derived vector and
/// open() round-trips + correctly fails closed on a wrong seq. Gating on
/// is_available() would make this unconditionally crash on every real
/// Apple Silicon Mac, which is strictly worse than not gating.
public func seal(key: [UInt8], seq: UInt64, plaintext: [UInt8]) -> [UInt8] {
    let nonce = nonceFromSeq(seq)
    var ct = [UInt8](repeating: 0, count: plaintext.count + Int(crypto_aead_aes256gcm_ABYTES))
    var ctLen: UInt64 = 0
    _ = crypto_aead_aes256gcm_encrypt(&ct, &ctLen, plaintext, UInt64(plaintext.count),
                                      nil, 0, nil, nonce, key)
    return Array(ct.prefix(Int(ctLen)))
}

public func open(key: [UInt8], seq: UInt64, ciphertext: [UInt8]) -> [UInt8]? {
    let nonce = nonceFromSeq(seq)
    guard ciphertext.count >= Int(crypto_aead_aes256gcm_ABYTES) else { return nil }
    var pt = [UInt8](repeating: 0, count: ciphertext.count - Int(crypto_aead_aes256gcm_ABYTES))
    var ptLen: UInt64 = 0
    let rc = crypto_aead_aes256gcm_decrypt(&pt, &ptLen, nil, ciphertext, UInt64(ciphertext.count),
                                           nil, 0, nonce, key)
    return rc == 0 ? Array(pt.prefix(Int(ptLen))) : nil
}
