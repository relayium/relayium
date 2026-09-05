import Foundation

public enum LocalPeerFramingError: Error, Equatable {
    case emptyFrame
    case frameTooLarge(declared: Int)
    case notUTF8
}

/// Four-byte, big-endian length framing for signalling JSON only. File and
/// message bodies remain on the encrypted WebRTC data channel.
public enum LocalPeerFraming {
    public static let maximumFrameBytes = 64 * 1024
    public static let headerBytes = 4

    public static func encode(_ text: String) -> Data? {
        let body = Data(text.utf8)
        guard !body.isEmpty, body.count <= maximumFrameBytes else { return nil }
        let length = UInt32(body.count)
        return Data([
            UInt8((length >> 24) & 0xff), UInt8((length >> 16) & 0xff),
            UInt8((length >> 8) & 0xff), UInt8(length & 0xff),
        ]) + body
    }

    public struct Reader {
        private var header = Data()
        private var body = Data()
        private var expectedBodyBytes: Int?

        public init() {}

        public var pendingBytes: Int { header.count + body.count }

        public mutating func append(_ chunk: Data) throws -> [String] {
            var frames: [String] = []
            var cursor = chunk.startIndex

            while cursor < chunk.endIndex {
                if expectedBodyBytes == nil {
                    let needed = LocalPeerFraming.headerBytes - header.count
                    let count = min(needed, chunk.distance(from: cursor, to: chunk.endIndex))
                    let end = chunk.index(cursor, offsetBy: count)
                    header.append(contentsOf: chunk[cursor..<end])
                    cursor = end
                    guard header.count == LocalPeerFraming.headerBytes else { continue }

                    let declared = header.reduce(0) { ($0 << 8) | Int($1) }
                    guard declared > 0 else { throw LocalPeerFramingError.emptyFrame }
                    guard declared <= LocalPeerFraming.maximumFrameBytes else {
                        throw LocalPeerFramingError.frameTooLarge(declared: declared)
                    }
                    expectedBodyBytes = declared
                    body.reserveCapacity(declared)
                }

                guard let expectedBodyBytes else { continue }
                let needed = expectedBodyBytes - body.count
                let count = min(needed, chunk.distance(from: cursor, to: chunk.endIndex))
                let end = chunk.index(cursor, offsetBy: count)
                body.append(contentsOf: chunk[cursor..<end])
                cursor = end
                guard body.count == expectedBodyBytes else { continue }
                guard let text = String(data: body, encoding: .utf8) else {
                    throw LocalPeerFramingError.notUTF8
                }
                frames.append(text)
                header.removeAll(keepingCapacity: true)
                body.removeAll(keepingCapacity: true)
                self.expectedBodyBytes = nil
            }
            return frames
        }
    }
}
