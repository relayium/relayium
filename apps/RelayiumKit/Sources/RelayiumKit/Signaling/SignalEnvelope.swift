import Foundation

public enum SignalType {
    public static let join = "join"
    public static let welcome = "welcome"
    public static let peers = "peers"
    public static let signal = "signal"
}

/// Opaque JSON payload carried in a signal's `data`. The signaling layer never
/// interprets it; the realtime layer converts its typed payloads to/from this.
public indirect enum JSONValue: Codable, Equatable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON")
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        }
    }
}

public struct Peer: Codable, Equatable {
    public let id: String
    public let name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

public struct Envelope: Codable, Equatable {
    public var type: String
    public var from: String?
    public var to: String?
    public var name: String?
    public var ip: String?
    public var peers: [Peer]?
    public var data: JSONValue?

    public init(type: String, from: String? = nil, to: String? = nil, name: String? = nil,
                ip: String? = nil, peers: [Peer]? = nil, data: JSONValue? = nil) {
        self.type = type; self.from = from; self.to = to; self.name = name
        self.ip = ip; self.peers = peers; self.data = data
    }
    // Codable synthesises key names == property names (type/from/to/name/ip/peers/data),
    // and JSONEncoder omits nil optionals by default — matching Go's omitempty.
}
