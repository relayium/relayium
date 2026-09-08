package com.relayium.android.nearby

import com.relayium.android.transport.PeerScopedSignaling
import com.relayium.android.transport.SignalingClient
import com.relayium.android.transport.SignalingHandle
import com.relayium.protocol.Envelope
import com.relayium.protocol.Json
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * A local rendezvous with no rendezvous server: Bonjour supplies the roster,
 * direct TCP carries only addressed `signal` envelopes, and everything above
 * this class keeps seeing the ONE [SignalingHandle]/[SignalingClient.Events]
 * seam the hub's WebSocket presents.
 *
 * That equivalence is the whole design. The controller's admission rules, the
 * capability registry, the commit-reveal handshake and both lane machines are
 * the shipped ones, unchanged; only where the roster and the envelopes come
 * from is different. It is a port of the Apple client's
 * `LocalPeerSignalingChannel.swift`, and the rules below are ITS rules — a
 * difference in any of them is an iOS peer this build cannot talk to.
 *
 * ## Ownership
 *
 * Every field is confined to [queue], a single serial executor. Transport
 * callbacks hop onto it, so there is no lock and no half-observed map. Events
 * are emitted FROM that thread, exactly as the WebSocket client emits from
 * OkHttp's reader thread — the controller posts them onto its own session
 * executor either way.
 *
 * ## What browsing may and may not do
 *
 * Browsing lists. Only an explicitly addressed signal dials. A roster
 * capability announcement — a `caps` object with no other field — is therefore
 * DROPPED when no stream to that peer exists, because in the hub's room each
 * such frame costs a relay hop while here it would be a TCP connection to a
 * device the user has not chosen. Matched on SHAPE rather than on equality with
 * this build's own hello, so a composition that announces a different list does
 * not silently start dialling every device on the link.
 */
class LocalPeerSignalingChannel(
    val advertisement: LocalPeerAdvertisement,
    private val transport: LocalPeerTransport,
    private val events: SignalingClient.Events,
    /** Injectable so tests drive the grace timer without sleeping. */
    private val queue: ScheduledExecutorService = defaultQueue(),
    private val ownsQueue: Boolean = true,
    private val graceMs: Long = INBOUND_GRACE_MS,
) : SignalingHandle, PeerScopedSignaling, LocalPeerTransportDelegate {

    private class Record(val connection: LocalPeerConnection, val outbound: Boolean) {
        val reader = LocalPeerFraming.Reader()
        val held = ArrayList<String>()
    }

    private val discovered = LinkedHashMap<String, LocalPeerAdvertisement>()
    private val connections = LinkedHashMap<String, Record>()
    private val pending = ArrayList<Record>()
    private var joined = false
    private var closed = false

    // ── SignalingHandle ─────────────────────────────────────────────────────

    /**
     * Arm the responder and the browser.
     *
     * Deliberately NOT done in the constructor, and the separation is
     * load-bearing: the controller installs its event handlers by CONSTRUCTING
     * this object with them, but a transport that is ready synchronously — a
     * peer already advertising on the link — would otherwise deliver the first
     * roster before the caller had stored the handle it is about to receive
     * signals for. Nothing re-sends those frames.
     */
    override fun connect() {
        queue.execute {
            if (closed) return@execute
            transport.start(advertisement, this)
        }
    }

    override fun sendSignal(to: String, data: Json) {
        queue.execute { handleOutbound(to, data) }
    }

    override fun close() {
        queue.execute { finish(CLOSE_LOCAL, "local-close") }
    }

    /**
     * Drop the stream bound to [peerId] WITHOUT reporting a departure.
     *
     * Called when the owner retires a connection to a peer but stays in the
     * room. Closing the stream is what makes "a frame from the previous
     * establishment cannot reach the next one" a structural fact rather than a
     * timing hope: the peer's in-flight signals were addressed to a socket that
     * no longer exists, and a fresh establishment dials a fresh one.
     *
     * No departure is emitted because the peer has NOT left — it is still
     * advertising and must stay in the list the user is looking at.
     */
    override fun retirePeer(peerId: String) {
        queue.execute {
            val record = connections[peerId] ?: return@execute
            connections.remove(peerId)
            disownAndCancel(record)
        }
    }

    // ── LocalPeerTransportDelegate (hops onto the queue) ────────────────────

    override fun localPeerTransportDidStart() {
        queue.execute {
            if (closed || joined) return@execute
            joined = true
            // The identity IS this room's self id. Emitted before any roster,
            // for the same reason the hub sends `welcome` first: a roster is
            // meaningless until the reader can exclude itself from it.
            events.onSelfId(advertisement.identity, "")
            publishDiscovery(discovered.keys.toList())
        }
    }

    override fun localPeerTransportDidFail(reason: LocalPeerFailure) {
        queue.execute { finish(CLOSE_FAILURE, reason.name) }
    }

    override fun localPeerTransportDidDiscover(peers: List<LocalPeerAdvertisement>) {
        queue.execute {
            if (closed) return@execute
            val next = LinkedHashMap<String, LocalPeerAdvertisement>()
            for (peer in peers) {
                if (peer.identity == advertisement.identity) continue
                if (next.size >= MAX_DISCOVERED && !next.containsKey(peer.identity)) continue
                next[peer.identity] = peer
            }
            val appeared = next.keys.filter { !discovered.containsKey(it) }
            discovered.clear()
            discovered.putAll(next)
            if (!joined) return@execute
            publishDiscovery(appeared)
            for (identity in appeared.sorted()) flushHeld(identity)
        }
    }

    override fun localPeerTransportDidAccept(connection: LocalPeerConnection) {
        queue.execute {
            if (closed || pending.size >= MAX_PENDING || totalStreams() >= MAX_STREAMS) {
                connection.cancel()
                return@execute
            }
            val record = Record(connection, outbound = false)
            attach(record)
            pending.add(record)
            connection.start()
            // An inbound stream from a device the browser has not reported YET is
            // the ordinary case, not an attack: TCP can beat the browse update.
            // It gets a bounded grace period to be claimed by a valid, known
            // sender and is dropped in silence otherwise — silence because a
            // connection that was never bound to a peer has no departure to
            // report, and reporting one would remove a device that is still there.
            queue.schedule(
                {
                    if (closed) return@schedule
                    if (!contains(record)) return@schedule
                    val bound = identityOf(record)
                    if (bound == null || !discovered.containsKey(bound)) {
                        drop(record, emitDeparture = false)
                    }
                },
                graceMs, TimeUnit.MILLISECONDS,
            )
        }
    }

    // ── outbound ────────────────────────────────────────────────────────────

    private fun handleOutbound(target: String, data: Json) {
        if (closed || !joined) return
        if (!LocalPeerAdvertisement.isValidIdentity(target)) return
        if (target == advertisement.identity) return
        val peer = discovered[target] ?: return
        // Listing does not connect. See the class comment.
        if (connections[target] == null && isRosterCapabilityAnnouncement(data)) return
        val json = Json.stringify(
            Json.obj(
                "type" to Json.of(SIGNAL),
                // Stamped by the SENDER here, because there is no server to do
                // it. The receiver checks it against the stream it arrived on.
                "from" to Json.of(advertisement.identity),
                "to" to Json.of(target),
                "data" to data,
            ),
        )
        val frame = LocalPeerFraming.encode(json) ?: return
        val record = connections[target] ?: run {
            if (totalStreams() >= MAX_STREAMS) return
            adopt(transport.connect(peer), target, outbound = true)
        }
        record.connection.send(frame)
    }

    private fun adopt(connection: LocalPeerConnection, identity: String, outbound: Boolean): Record {
        val record = Record(connection, outbound)
        attach(record)
        bind(record, identity)
        if (connections[identity] === record) connection.start()
        return connections[identity] ?: record
    }

    private fun attach(record: Record) {
        record.connection.onBytes = { bytes, count ->
            val copy = bytes.copyOf(count)
            queue.execute { receive(copy, record) }
        }
        record.connection.onClosed = {
            queue.execute { drop(record, emitDeparture = true) }
        }
    }

    /**
     * Bind a stream to one peer identity, resolving the two-sided dial.
     *
     * Both devices may dial at the same moment, which leaves two streams for one
     * peer. The tiebreak is the SAME lexicographic comparison the link role uses
     * — the smaller identity keeps its OUTBOUND stream — so the two sides pick
     * the same survivor without exchanging anything. Only the losing socket is
     * closed, and no departure is reported: the peer did not leave, one of two
     * redundant streams did.
     */
    private fun bind(record: Record, identity: String) {
        pending.remove(record)
        val existing = connections[identity]
        if (existing == null) {
            connections[identity] = record
            return
        }
        if (existing === record) return
        val winner = if (existing.outbound == record.outbound) {
            existing
        } else {
            val keepOutbound = advertisement.identity < identity
            if (existing.outbound == keepOutbound) existing else record
        }
        val loser = if (winner === existing) record else existing
        connections[identity] = winner
        disownAndCancel(loser)
    }

    private fun receive(bytes: ByteArray, record: Record) {
        if (closed || !contains(record)) return
        val frames = try {
            record.reader.append(bytes)
        } catch (_: Exception) {
            // A malformed length, an empty frame or a body that is not UTF-8:
            // the stream is a length-prefixed sequence, so there is nothing to
            // resynchronise to. Drop it, and report the departure — from this
            // side the peer is gone.
            drop(record, emitDeparture = true)
            return
        }
        for (frame in frames) route(frame, record)
    }

    private fun route(text: String, record: Record) {
        if (!contains(record)) return
        val obj = Json.parseOrNull(text) as? Json.Obj ?: return
        if ((obj["type"] as? Json.Str)?.value != SIGNAL) return
        val sender = (obj["from"] as? Json.Str)?.value ?: return
        if (!LocalPeerAdvertisement.isValidIdentity(sender)) return
        val data = obj["data"] ?: return
        if (sender == advertisement.identity) {
            // Something claiming to be us. Never our own loopback in a shipped
            // build, and never a peer we would answer.
            drop(record, emitDeparture = false)
            return
        }
        if ((obj["to"] as? Json.Str)?.value != advertisement.identity) return

        val bound = identityOf(record)
        if (bound != null) {
            // ONE stream carries ONE peer. A second identity on a bound stream
            // is a peer trying to speak for another, which is exactly what
            // per-stream binding exists to refuse.
            if (bound != sender) {
                drop(record, emitDeparture = true)
                return
            }
        } else {
            bind(record, sender)
            if (connections[sender] !== record) return
        }

        if (!discovered.containsKey(sender)) {
            // Its stream arrived before its advertisement did. Hold a BOUNDED
            // number of frames in order and deliver them the moment browsing
            // credits the peer, so a device is never listed as selectable
            // before what it can speak has been established — and never
            // delivers a signal for a peer the roster has not introduced.
            if (record.held.size >= MAX_GRACE_FRAMES) {
                drop(record, emitDeparture = true)
                return
            }
            record.held.add(text)
            return
        }
        events.onSignal(sender, data)
    }

    private fun flushHeld(identity: String) {
        val record = connections[identity] ?: return
        if (record.held.isEmpty()) return
        val held = ArrayList(record.held)
        record.held.clear()
        for (text in held) {
            val obj = Json.parseOrNull(text) as? Json.Obj ?: continue
            if ((obj["from"] as? Json.Str)?.value != identity) continue
            if ((obj["to"] as? Json.Str)?.value != advertisement.identity) continue
            val data = obj["data"] ?: continue
            events.onSignal(identity, data)
        }
    }

    /**
     * Credit each newly appeared peer with the capabilities THAT PEER
     * advertised, then publish the roster — in that order.
     *
     * The order is the contract. On the hub, a peer announces its capabilities
     * in a roster hello that lands before anybody dials; here the advertisement
     * IS that hello, so it has to be delivered as one before the roster frame
     * behind it, or the list offers a device whose wire is unknown. The
     * capabilities are the PEER's, never this build's: crediting a discovered
     * device with our own list would be an announcement about ourselves wearing
     * somebody else's id.
     */
    private fun publishDiscovery(appeared: List<String>) {
        for (identity in appeared.sorted()) {
            val peer = discovered[identity] ?: continue
            events.onSignal(identity, capsField(peer.capabilities))
        }
        val peers = ArrayList<Envelope.Peer>(discovered.size + 1)
        // Self first, then the others by identity — the shape the hub's roster
        // has, so the reader's "exclude myself by id" rule is the same one.
        peers.add(Envelope.Peer(advertisement.identity, advertisement.name))
        for (peer in discovered.values.sortedBy { it.identity }) {
            peers.add(Envelope.Peer(peer.identity, peer.name))
        }
        events.onPeers(peers)
    }

    private fun identityOf(record: Record): String? =
        connections.entries.firstOrNull { it.value === record }?.key

    private fun contains(record: Record): Boolean =
        pending.any { it === record } || identityOf(record) != null

    private fun totalStreams(): Int = connections.size + pending.size

    private fun drop(record: Record, emitDeparture: Boolean) {
        pending.remove(record)
        val identity = identityOf(record)
        if (identity != null && connections[identity] === record) connections.remove(identity)
        disownAndCancel(record)
        if (emitDeparture && identity != null && !closed) events.onPeerLeft(identity)
    }

    private fun disownAndCancel(record: Record) {
        record.connection.onBytes = null
        record.connection.onClosed = null
        record.connection.cancel()
    }

    private fun finish(code: Int, reason: String) {
        if (closed) return
        closed = true
        cancelEverything()
        events.onClosed(code, reason)
        if (ownsQueue) queue.shutdown()
    }

    private fun cancelEverything() {
        transport.stop()
        val seen = HashSet<Record>()
        for (record in ArrayList(connections.values) + ArrayList(pending)) {
            if (!seen.add(record)) continue
            disownAndCancel(record)
        }
        connections.clear()
        pending.clear()
        discovered.clear()
    }

    companion object {
        const val SIGNAL = "signal"

        /** How long an unclaimed inbound stream may wait for its advertisement. */
        const val INBOUND_GRACE_MS = 5_000L
        /** Frames one such stream may hold while it waits. */
        const val MAX_GRACE_FRAMES = 16

        /** Bounds on what a hostile or broken link can make this hold. */
        const val MAX_DISCOVERED = 64
        const val MAX_PENDING = 8
        const val MAX_STREAMS = 16

        /** This side closed. */
        const val CLOSE_LOCAL = 1000
        /** The transport could not run; `reason` is a [LocalPeerFailure] name. */
        const val CLOSE_FAILURE = -2

        /**
         * A `caps` object with NO other field is a roster announcement whatever
         * it lists; an SDP confirmation carries `sdp` and `commit` beside it and
         * is not one.
         */
        fun isRosterCapabilityAnnouncement(data: Json?): Boolean {
            val obj = data as? Json.Obj ?: return false
            return obj.keys.size == 1 && obj.keys.contains("caps")
        }

        fun capsField(capabilities: List<String>): Json =
            Json.obj("caps" to Json.arr(capabilities.map(Json::of)))

        private fun defaultQueue(): ScheduledExecutorService =
            ScheduledThreadPoolExecutor(1) { runnable ->
                Executors.defaultThreadFactory().newThread(runnable).apply {
                    name = "relayium-localpeer"
                    isDaemon = true
                }
            }
    }
}
