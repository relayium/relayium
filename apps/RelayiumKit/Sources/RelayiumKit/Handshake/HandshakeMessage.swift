import Foundation

public struct Reveal: Codable, Equatable {
    public let key: String   // base64 public key
    public let nonce: String // base64 nonce
    public init(key: String, nonce: String) { self.key = key; self.nonce = nonce }
}

public func commitField(_ b64: String) -> JSONValue { .object(["commit": .string(b64)]) }
public func revealField(_ r: Reveal) -> JSONValue {
    .object(["reveal": .object(["key": .string(r.key), "nonce": .string(r.nonce)])])
}
public func peerCommit(from data: JSONValue) -> String? {
    guard case let .object(o) = data, case let .string(c)? = o["commit"] else { return nil }
    return c
}
public func peerReveal(from data: JSONValue) -> Reveal? {
    guard case let .object(o) = data, case let .object(r)? = o["reveal"],
          case let .string(k)? = r["key"], case let .string(n)? = r["nonce"] else { return nil }
    return Reveal(key: k, nonce: n)
}
