import Foundation
import Sodium
import Clibsodium

/// Shared libsodium handle. swift-sodium initialises libsodium in its own
/// initialiser, so constructing `Sodium()` is the readiness gate.
public let sodium = Sodium()

/// True once libsodium is usable. A trivial op that would fail pre-init.
public func sodiumReady() -> Bool {
    return sodium.utils.hex2bin("00") != nil
}

// Swift global `let` initialization is thread-safe and runs exactly once.
private let sodiumInitialized: Bool = { sodium_init() >= 0 }()

/// Call before any direct Clibsodium use. Idempotent, thread-safe.
@inline(__always) func ensureSodiumInit() { precondition(sodiumInitialized, "sodium_init() failed") }
