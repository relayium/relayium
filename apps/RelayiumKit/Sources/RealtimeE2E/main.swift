import Foundation
import RelayiumKit
import WebRTC

// Live realtime E2E: two native RealtimeConnection peers join the same code room
// on the production /ws hub, run the commit-reveal SAS handshake, and transfer a
// file over the DataChannel. Asserts both derive the same SAS and the received
// bytes equal the sent bytes. Not a unit test — needs the network.
//   swift run RealtimeE2E [wsBase]        (default wss://relayium.com)

let wsBase = URL(string: CommandLine.arguments.dropFirst().first ?? "wss://relayium.com")!
// Empty code = the LAN room (keyed by the client's public IP). Both peers run on
// this machine → same IP → same room → they pair. A non-empty code must be a
// server-registered pairing code (RoomFor validates it against pairReg), which we
// have no logged-in session to mint here. Peers are matched by NAME below so a
// stranger sharing our public IP in the LAN room can't derail the test.
let code = ""
// A per-run tag so our two peers find EACH OTHER (not a stranger) in the LAN room.
let runTag = String(UUID().uuidString.prefix(8)).lowercased()
let testData = Array("hello from native relayium e2e :: the quick brown fox jumps over 0123456789".utf8)
let testFile = FileMeta(name: "e2e.txt", size: testData.count, path: nil)
// Same-machine peers pair on host candidates; a public STUN helps candidate
// gathering on some networks. TURN isn't needed for a loopback/LAN hop.
let iceServers = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]

func log(_ s: String) { FileHandle.standardError.write(Data("[\(Date())] \(s)\n".utf8)) }

let group = DispatchGroup(); group.enter()
let lock = NSLock()
var result = "PENDING"
var senderSAS: String?, receiverSAS: String?
var received: [UInt8] = []
var doneOK: Bool?

func finish(_ r: String) {
    lock.lock(); defer { lock.unlock() }
    if result == "PENDING" { result = r; group.leave() }
}

final class E2EPeer {
    let name: String
    let isSender: Bool
    let signaling: SignalingClient
    var conn: RealtimeConnection?
    var selfId: String?
    var started = false

    let counterpart: String

    init(name: String, isSender: Bool) {
        self.name = name; self.isSender = isSender
        self.counterpart = (isSender ? "receiver-" : "sender-") + runTag
        signaling = SignalingClient.connect(wsBase: wsBase, code: code, name: name)
        signaling.onSelfId = { [self] id, ip in selfId = id; log("\(name): self=\(id) ip=\(ip)") }
        signaling.onClose = { [self] in log("\(name): signaling closed") }
        signaling.onPeers = { [self] peers in
            guard conn == nil, let peer = peers.first(where: { $0.name == counterpart }) else {
                log("\(name): roster \(peers.map(\.name)) — waiting for \(counterpart)")
                return
            }
            log("\(name): matched peer=\(peer.id) (\(peer.name)), making \(isSender ? "initiator" : "responder")")
            makeConnection(peerId: peer.id)
        }
    }

    func makeConnection(peerId: String) {
        let c = RealtimeConnection(signaling: signaling, peerId: peerId,
                                   role: isSender ? .initiator : .responder, iceServers: iceServers)
        c.onSAS = { [self] sas in
            log("\(name): SAS=\(sas)")
            lock.lock(); if isSender { senderSAS = sas } else { receiverSAS = sas }; lock.unlock()
        }
        c.onOpen = { [self] in
            log("\(name): DataChannel OPEN")
            // send() is called OFF the connection's callback queue: onOpen runs ON
            // that queue and send() does a queue.sync internally (would deadlock).
            if isSender {
                DispatchQueue.global().async {
                    log("sender: send()")
                    c.send(sources: [DataSource(name: testFile.name, bytes: testData)], metas: [testFile])
                }
            }
        }
        c.onManifest = { [self] files in
            log("\(name): manifest \(files.map { "\($0.name)(\($0.size))" }) → accept()")
            c.accept()
        }
        c.onFileChunk = { d in lock.lock(); received += d; lock.unlock() }
        c.onProgress = { [self] n in log("\(name): progress \(n)") }
        c.onDone = { [self] ok in
            log("\(name): DONE ok=\(ok)")
            lock.lock(); doneOK = ok; let got = received; lock.unlock()
            if got == testData && ok { finish("PASS") }
            else { finish("FAIL: bytes(\(got.count)/\(testData.count)) ok=\(ok)") }
        }
        c.onControl = { [self] ctrl in log("\(name): control \(ctrl)") }
        c.onError = { [self] e in log("\(name): ERROR \(e)"); finish("FAIL: \(name) \(e)") }
        c.onClose = { [self] in log("\(name): connection closed") }
        conn = c
        if isSender {
            // Let the responder wire its onSignal handler before the offer goes out.
            DispatchQueue.global().asyncAfter(deadline: .now() + 1.2) { [self] in
                guard !started else { return }; started = true
                log("sender: start()"); c.start()
            }
        }
    }
}

log("E2E code=\(code) wsBase=\(wsBase)")
let receiver = E2EPeer(name: "receiver-\(runTag)", isSender: false)
let sender = E2EPeer(name: "sender-\(runTag)", isSender: true)

DispatchQueue.global().asyncAfter(deadline: .now() + 75) { finish("FAIL: timeout") }

group.notify(queue: .main) {
    lock.lock()
    let sMatch = senderSAS != nil && senderSAS == receiverSAS
    log("=== RESULT: \(result) ===")
    log("SAS sender=\(senderSAS ?? "nil") receiver=\(receiverSAS ?? "nil") match=\(sMatch)")
    log("received \(received.count)/\(testData.count) bytes, doneOK=\(String(describing: doneOK))")
    let ok = result == "PASS" && sMatch
    lock.unlock()
    receiver.conn?.close(); sender.conn?.close()
    receiver.signaling.close(); sender.signaling.close()
    exit(ok ? 0 : 1)
}
dispatchMain()
