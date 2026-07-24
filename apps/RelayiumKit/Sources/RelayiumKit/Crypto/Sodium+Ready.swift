import Foundation
import Sodium

/// Shared libsodium handle. swift-sodium initialises libsodium in its own
/// initialiser, so constructing `Sodium()` is the readiness gate.
public let sodium = Sodium()

/// True once libsodium is usable. A trivial op that would fail pre-init.
public func sodiumReady() -> Bool {
    return sodium.utils.hex2bin("00") != nil
}
