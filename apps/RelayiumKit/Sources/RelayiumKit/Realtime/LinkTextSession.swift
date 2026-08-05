import Foundation

/// Per-frame wire overhead: the 5-byte header plus the 16-byte AES-GCM tag.
/// `web/src/lib/text-wire.ts`'s `TEXT_FRAME_OVERHEAD`.
public let LINK_TEXT_FRAME_OVERHEAD = 5 + 16

/// The plaintext one message may carry on THIS connection: the product cap,
/// lowered to whatever the sealed frame has to fit inside.
///
/// `nil` means the connection never produced a usable number, and that is a
/// REFUSAL rather than "no limit". The web computes this with `Math.floor` and
/// `Math.min`, both of which propagate NaN, and every later comparison against a
/// NaN limit is false — so an unnegotiated connection there silently admits any
/// message. Text does not fragment, so an oversized frame is not a slow send:
/// it is a nonce burned on bytes the channel will refuse.
///
/// Positive infinity is the one non-finite value that is an ANSWER: a connection
/// reporting no ceiling has reported something. `web/src/lib/text-wire.ts`'s
/// `textPlainLimit` returns `Math.min(Infinity, TEXT_MAX_BYTES)` for it — the
/// product cap — and treating it as unknown here would refuse every message on a
/// link the deployed web carries.
public func linkTextPlainLimit(maxFrameBytes: Double) -> Int? {
    // A frame size is a positive number. Zero, a negative, negative infinity and
    // a NaN are not small limits, they are the absence of one — and the
    // difference matters to the caller: a limit of 0 is a connection that
    // reported something real and uselessly small, which is a message too long
    // for it. NaN fails this comparison, which is exactly why it is written as
    // one.
    guard maxFrameBytes > 0 else { return nil }
    // No ceiling on the frame, so only the product cap remains.
    guard maxFrameBytes.isFinite else { return TEXT_MAX_BYTES }
    let usable = maxFrameBytes.rounded(.down) - Double(LINK_TEXT_FRAME_OVERHEAD)
    guard usable > 0 else { return 0 }
    // Clamped as a `Double` before the conversion: `Int(_:)` traps on a value
    // beyond `Int.max`, and `maxFrameBytes` is a number the connection reports.
    return Int(min(usable, Double(TEXT_MAX_BYTES)))
}

/// What the driver must do, in order, because of one event.
///
/// Every external action this owner needs is exactly one of these, and nothing
/// here performs any of them: no channel, no timers, no queues, no UI.
public enum LinkTextSessionEffect: Equatable, Sendable {
    /// Put this lifecycle control on the TEXT channel.
    ///
    /// Separate from `sendProtected` because the two failures are different
    /// failures, and the difference is not recoverable by inspection: a control
    /// consumes no AEAD sequence, so bytes that never leave the buffer cost this
    /// transport GENERATION and a replacement channel may simply send them
    /// again.
    case sendControl(UInt8)
    /// Put this sealed frame on the TEXT channel.
    ///
    /// Its nonce is already spent. Bytes that never leave the buffer therefore
    /// leave the peer expecting a sequence number that will never arrive, which
    /// no replacement transport can repair — the honest answer is to poison this
    /// lane's codecs (`protectedSendFailed`). A driver must never have to
    /// re-demux bytes it just received from this owner to work out which of the
    /// two it is holding.
    case sendProtected([UInt8])
    case armConsentTimeout
    case cancelConsentTimeout
    case armEndAckTimeout
    case cancelEndAckTimeout
    /// One authenticated inbound message, for a conversation both sides
    /// consented to. Frames drained after a local END are authenticated without
    /// producing this.
    case received(String)
    /// This lane's codecs can no longer be proven safe to reuse.
    case poisonCodecs
    case closeLane
}

public enum LinkTextSessionError: Error, Equatable, Sendable {
    case laneFailed
    /// No conversation is open, so no plaintext may cross this lane.
    case notOpen
    case emptyBody
    /// The connection never reported a usable frame size — a NaN, a zero, a
    /// negative or negative infinity. A connection reporting NO ceiling is not
    /// this: see `linkTextPlainLimit`.
    case unknownFrameLimit
    case tooLong(bytes: Int, limit: Int)
    /// The sender refused THIS message before consuming its nonce, and can
    /// still produce the next one. Only a size refusal reaches this: a refusal
    /// that is a property of the sender itself is terminal for the lane and is
    /// never thrown — see `linkTextSealIsTerminal`.
    case sealFailed(RealtimeTextError)
}

/// Does this `RealtimeTextSender` refusal end the LANE, or only the message?
///
/// The link owns exactly one text sender for its whole life, so the question is
/// not "did this message fail" but "can this sender ever produce another frame".
/// `messageTooLarge` is decided from the body alone and leaves the sender
/// untouched. Everything else is a property of the sender or its key: a sender
/// that refuses for one of those reasons refuses forever, and reporting it as a
/// per-message error would leave the conversation open, showing a composer that
/// can only fail while the peer waits on a conversation this side cannot
/// continue.
///
/// Exhaustive on purpose: a new `RealtimeTextError` must not silently inherit
/// the retryable answer. The receive-side cases cannot come out of `frame`, and
/// if one ever does the terminal answer is the honest one — an unexplained seal
/// refusal is not evidence that sealing will work next time.
func linkTextSealIsTerminal(_ error: RealtimeTextError) -> Bool {
    switch error {
    case .messageTooLarge:
        return false
    case .invalidKey, .sequenceExhausted, .malformedFrame, .wrongKind,
         .outOfOrder, .authenticationFailed, .invalidUTF8:
        return true
    }
}

public struct LinkTextSessionGapOutcome: Equatable, Sendable {
    /// Did this lane have work worth holding the whole link — and the
    /// initiator's ICE/TURN allocations — open for?
    public let needsRecovery: Bool
    public let effects: [LinkTextSessionEffect]

    public init(needsRecovery: Bool, effects: [LinkTextSessionEffect] = []) {
        self.needsRecovery = needsRecovery
        self.effects = effects
    }
}

/// The reusable text-conversation owner above `LinkTextLane`.
///
/// ## What it adds to the lane
///
/// `LinkTextLane` decides WHEN plaintext may cross: which consent state the
/// conversation is in, which frames are drained, which failures are worth
/// poisoning codecs for. It has no keys and never sees a byte of content. This
/// type is the other half: it holds the link's ONE `RealtimeTextSender` and
/// `RealtimeTextReceiver`, builds the frames the lane authorises, and feeds the
/// frames the lane admits — in the lane's order, without reordering any of it.
///
/// ## Why it is constructed from a `LinkIdentity`
///
/// The identity is what survives a transport rebuild, and its `codecs` are the
/// object identity the whole feature turns on: one `(text key, direction)`
/// sequence for the life of the link. Taking codecs — or, worse, keys — would
/// make it possible to build a second sender under the same key, which restarts
/// an AES-GCM nonce at zero and is a break of the encryption rather than a bug.
/// The role comes from the same place, so a rebuild cannot turn two peers into
/// two initiators and hand them the same tie-break answer.
///
/// ## What it deliberately does not own
///
/// No DataChannel, no timers, no queues, no UI, and no file-lane anything. It
/// holds no reference to a file session and nothing here can reach one, so a
/// conversation failing closed cannot touch a transfer: that is structural
/// rather than a rule somebody has to remember.
///
/// ## Concurrency
///
/// Pure and synchronous. **The owner serializes every call** — the codecs are
/// stateful counters, and producing or feeding two frames at once would put
/// their sequence numbers on the wire out of order. That is the same FIFO the
/// web's `sendChain`/`recvChain` are.
///
/// Pinned against `web/src/lib/mixed-text-session.svelte.ts`.
public final class LinkTextSession {

    /// The authenticated link this conversation belongs to. Its `codecs` are
    /// used for the whole life of the link and are never replaced.
    public let identity: LinkIdentity
    let lane: LinkTextLane

    private var codecs: LinkCodecs { identity.codecs }

    public convenience init(identity: LinkIdentity) {
        self.init(identity: identity, now: { Date().timeIntervalSince1970 })
    }

    /// - Parameter now: the rate buckets' clock. Internal, so a test can state a
    ///   rate rule without waiting in real time.
    init(identity: LinkIdentity, now: @escaping () -> TimeInterval) {
        self.identity = identity
        self.lane = LinkTextLane(role: identity.role, now: now)
    }

    // MARK: - what a driver may read

    public var status: LinkTextStatus { lane.status }
    public var conversationCount: Int { lane.conversationCount }
    public var codecsPoisoned: Bool { lane.codecsPoisoned }
    public var maySendProtected: Bool { lane.maySendProtected }
    public var isActive: Bool { lane.isActive }
    /// The sticky claim on the link's recovery window this lane recorded at its
    /// gap. Read AFTER `transportGap` has suspended the lane; see
    /// `LinkTextLane.needsRecovery` for why the two are separate questions.
    public var needsRecovery: Bool { lane.needsRecovery }

    // MARK: - local intent

    public func localOpen() -> [LinkTextSessionEffect] { mapped(lane.localOpen()) }
    public func localAccept() -> [LinkTextSessionEffect] { mapped(lane.localAccept()) }
    public func localReject() -> [LinkTextSessionEffect] { mapped(lane.localReject()) }
    public func localEnd() -> [LinkTextSessionEffect] { mapped(lane.localEnd()) }

    // MARK: - timers

    public func consentTimedOut() -> [LinkTextSessionEffect] { mapped(lane.consentTimedOut()) }
    public func endAckTimedOut() -> [LinkTextSessionEffect] { mapped(lane.endAckTimedOut()) }

    // MARK: - outbound messages

    /// Seal one message for the open conversation.
    ///
    /// **Everything that can refuse the MESSAGE runs before the sender is
    /// touched.** A refusal must cost nothing: `RealtimeTextSender` consumes a
    /// nonce the moment a frame exists, and a message that is merely too big for
    /// this connection would then take the link's reusable text codecs with it.
    ///
    /// A refusal that the SENDER itself raises is the exception, and it does not
    /// throw: it fails this lane closed and returns the terminal effects, for
    /// the reason in `linkTextSealIsTerminal`. The returned list contains no
    /// `sendProtected`, so nothing crossed the wire and the caller's own
    /// `status`/`codecsPoisoned` say so.
    ///
    /// - Parameter maxFrameBytes: what the CONNECTION negotiated, not the
    ///   product cap. A sealed 64 KiB message is 65 557 B and does not fit a
    ///   peer that negotiated the RFC 8841 default of 65 536.
    public func send(_ body: String, maxFrameBytes: Double) throws -> [LinkTextSessionEffect] {
        guard !lane.codecsPoisoned else { throw LinkTextSessionError.laneFailed }
        guard lane.maySendProtected else { throw LinkTextSessionError.notOpen }
        let bytes = body.utf8.count
        guard bytes > 0 else { throw LinkTextSessionError.emptyBody }
        guard let limit = linkTextPlainLimit(maxFrameBytes: maxFrameBytes) else {
            throw LinkTextSessionError.unknownFrameLimit
        }
        guard bytes <= limit else { throw LinkTextSessionError.tooLong(bytes: bytes, limit: limit) }
        let frame: [UInt8]
        do {
            frame = try codecs.textSender.frame(body: body, key: codecs.textSendKey)
        } catch let error as RealtimeTextError {
            guard linkTextSealIsTerminal(error) else {
                // A size refusal precedes the sender's nonce, so it costs
                // nothing and the lane stays usable for the next message.
                throw LinkTextSessionError.sealFailed(error)
            }
            // The reusable sender cannot progress, so neither can this lane. No
            // nonce was consumed, but there will never be another frame to
            // consume one — leaving the conversation open would be a lie the
            // driver has no way to detect.
            return mapped(lane.failClosed())
        }
        // The nonce is spent from here. `didSendProtected` is what makes a gap
        // with bytes still buffered terminal rather than recoverable.
        lane.didSendProtected()
        return [.sendProtected(frame)]
    }

    /// A frame this session produced could not be put on the wire.
    ///
    /// The seam exists because the lane cannot see it. Once `send` returns, a
    /// nonce is spent whatever the transport does next, so a refused frame
    /// leaves the peer expecting a sequence number that will never arrive and no
    /// replacement channel can repair it. Poisons the TEXT codecs and closes the
    /// text lane; the file lane and the peer link are untouched.
    @discardableResult
    public func protectedSendFailed() -> [LinkTextSessionEffect] {
        mapped(lane.failClosed())
    }

    /// The transport's send buffer was observed empty, so everything handed to
    /// it has left.
    public func didFlushSendBuffer() { lane.didFlushSendBuffer() }

    // MARK: - inbound

    /// Route one frame off the text channel.
    ///
    /// The classes partition the space exactly as the web's `onData` does: a
    /// one-byte lifecycle control, a well-formed kind-9 frame, a kind-9 frame
    /// too short to be one — which is terminal, because on an ordered channel it
    /// is either corruption or a peer this build cannot follow — and everything
    /// else, which consumes no sequence and is ignored.
    public func admitFrame(_ frame: [UInt8]) -> [LinkTextSessionEffect] {
        guard !lane.codecsPoisoned else { return [] }
        if let control = linkTextLifecycleKind(frame) {
            return mapped(lane.inboundControl(control))
        }
        guard isLinkTextFrame(frame) else {
            guard frame.first == RealtimeKind.text else { return [] }
            return mapped(lane.failClosed())
        }
        // The framed length is what the per-conversation budget is measured in.
        return mapped(lane.inboundProtectedFrame(byteCount: frame.count), frame: frame)
    }

    // MARK: - transport generations

    /// Enter a transport gap. Idempotent: a channel `onclose` and the peer
    /// connection's own terminal callback are ONE gap.
    ///
    /// - Parameter bufferedBytes: what the channel still held. Paired with the
    ///   protected send this session recorded: `send()` only enqueues.
    @discardableResult
    public func transportGap(bufferedBytes: Int = 0) -> LinkTextSessionGapOutcome {
        let outcome = lane.transportGap(bufferedBytes: bufferedBytes)
        return LinkTextSessionGapOutcome(needsRecovery: outcome.needsRecovery,
                                         effects: mapped(outcome.effects))
    }

    /// A replacement transport is current. Same authenticated link, same codecs,
    /// new channel — and deliberately no replay: consent was given on a
    /// transport that no longer exists.
    @discardableResult
    public func didAttachReplacementTransport() -> [LinkTextSessionEffect] {
        mapped(lane.didAttachReplacementTransport())
    }

    // MARK: - internals

    /// The lane's decisions, in the lane's order, as the driver's effects.
    ///
    /// A translation rather than a second list: the lane fixes the order that
    /// keeps a driver from holding two prompts or poisoning without closing, and
    /// nothing here may reorder it. `feedProtected` is the one decision the lane
    /// cannot carry out itself, because it has no keys — so it happens HERE, in
    /// place, which is what keeps a received message ordered against the timer
    /// and control effects around it.
    private func mapped(_ effects: [LinkTextEffect],
                        frame: [UInt8]? = nil) -> [LinkTextSessionEffect] {
        var out: [LinkTextSessionEffect] = []
        for effect in effects {
            switch effect {
            case let .sendControl(byte): out.append(.sendControl(byte))
            case .armConsentTimeout: out.append(.armConsentTimeout)
            case .cancelConsentTimeout: out.append(.cancelConsentTimeout)
            case .armEndAckTimeout: out.append(.armEndAckTimeout)
            case .cancelEndAckTimeout: out.append(.cancelEndAckTimeout)
            case .poisonCodecs: out.append(.poisonCodecs)
            case .closeLane: out.append(.closeLane)
            case let .feedProtected(discard):
                // The frame was admitted in wire order, so a receiver that
                // refuses it leaves this side unable to prove its sequence:
                // authentication, UTF-8 and ordering failures are one outcome,
                // and it is the poisoning one. `failClosed` never asks to feed
                // anything, so this cannot recurse further.
                guard let frame,
                      let body = try? codecs.textReceiver.receive(frame: frame,
                                                                  key: codecs.textRecvKey) else {
                    return out + mapped(lane.failClosed())
                }
                if !discard { out.append(.received(body)) }
            }
        }
        return out
    }
}
