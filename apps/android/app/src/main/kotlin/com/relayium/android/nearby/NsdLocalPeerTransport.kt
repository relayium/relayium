package com.relayium.android.nearby

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The real thing: `NsdManager` for discovery, a real `ServerSocket` for inbound
 * streams, real `Socket`s for outbound ones.
 *
 * ## Ownership
 *
 * Every field is confined to [queue], one serial executor. `NsdManager`
 * delivers its callbacks on a binder thread and sockets are read on their own
 * threads; all of it hops here first, so there is no lock and no callback that
 * can race a stop.
 *
 * ## Why resolution is serialised
 *
 * `NsdManager.resolveService` is single-flight below API 34: a second call while
 * one is outstanding fails with `FAILURE_ALREADY_ACTIVE` and — historically —
 * could wedge the resolver for the process. `minSdk` here is 26, so the
 * deprecated resolver is the only one available on most of the supported range,
 * and the queue below is what makes a link with a dozen devices on it behave.
 * Pending resolutions are BOUNDED for the same reason every other queue in this
 * package is: a link is not a trusted input.
 *
 * ## What discovery is worth
 *
 * Nothing here authenticates anything. A record is a public, unauthenticated
 * claim; the commit-reveal handshake and the SAS are what make a session
 * trustworthy, and no timeout or bound in this file shortens either.
 */
class NsdLocalPeerTransport(
    context: Context,
    private val queue: ScheduledExecutorService = defaultQueue(),
    /**
     * Whether [stop] must also shut the queue down.
     *
     * True for the default queue, and it has to be: this transport is built
     * fresh for every room, so a room that dropped and reopened five times would
     * otherwise leave five daemon threads parked forever. False when a caller
     * supplies its own — shutting down somebody else's executor is not this
     * object's decision to make.
     */
    private val ownsQueue: Boolean = true,
    private val startDeadlineMs: Long = START_DEADLINE_MS,
) : LocalPeerTransport {

    private val app = context.applicationContext
    private val nsd: NsdManager? = runCatching {
        app.getSystemService(NsdManager::class.java)
    }.getOrNull()

    private val lifecycle = LocalPeerTransportLifecycle()

    /**
     * Hop onto the owner thread, tolerating a queue that has already stopped.
     *
     * `NsdManager` holds this object's listeners until the platform gets around
     * to releasing them, so a resolve completion or a discovery callback can
     * arrive after [stop]. Rejected work is MOOT, not an error: the room it
     * belonged to is gone.
     */
    private fun onQueue(task: () -> Unit) {
        runCatching { queue.execute(task) }
    }

    private fun onQueueLater(delayMs: Long, task: () -> Unit) {
        runCatching { queue.schedule(task, delayMs, TimeUnit.MILLISECONDS) }
    }
    private var delegate: LocalPeerTransportDelegate? = null
    private var advertisement: LocalPeerAdvertisement? = null

    private var server: ServerSocket? = null
    private var acceptThread: Thread? = null
    private var registrationListener: NsdManager.RegistrationListener? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null

    /** Resolved peers, by identity. `connect` dials from THIS, never from a
     *  name or an address the caller supplied. */
    private val resolved = LinkedHashMap<String, Resolved>()
    private val resolveQueue = ArrayDeque<Pending>()
    private var resolveInFlight: Pending? = null
    /** Instance names whose resolution failed once. A second failure is final
     *  for that appearance, so a permanently unresolvable record cannot spin. */
    private val resolveRetried = HashSet<String>()

    /**
     * Which APPEARANCE of a service name a resolution belongs to.
     *
     * A resolution is an asynchronous answer about an endpoint, and by the time
     * it lands the service may have been lost — or lost and found again at a
     * DIFFERENT address, which is the ordinary shape of a peer that changed
     * network. Adopting such an answer would resurrect a device that is gone, or
     * publish the old endpoint of one that moved, and every later dial would go
     * to an address nothing is listening on.
     *
     * So each `onServiceFound` stamps a fresh number, the resolution carries it,
     * and an answer is adopted only if the name is still present under exactly
     * that stamp.
     */
    private var findSeq = 0
    private val present = HashMap<String, Int>()

    private class Pending(val info: NsdServiceInfo, val name: String, val appearance: Int)

    private class Resolved(
        val advertisement: LocalPeerAdvertisement,
        val address: InetAddress,
        val port: Int,
    )

    // ── LocalPeerTransport ──────────────────────────────────────────────────

    override fun start(advertisement: LocalPeerAdvertisement, delegate: LocalPeerTransportDelegate) {
        onQueue { beginStart(advertisement, delegate) }
    }

    private fun beginStart(ad: LocalPeerAdvertisement, target: LocalPeerTransportDelegate) {
        if (lifecycle.start() != LocalPeerTransportLifecycle.StartDecision.ARM) return
        delegate = target
        advertisement = ad
        val manager = nsd ?: run { announceFailure(LocalPeerFailure.UNAVAILABLE); return }

        val socket = try {
            // Port 0: the OS picks, and the chosen port is what the TXT record's
            // service advertises. Nothing here binds a fixed port, so two
            // instances on one device do not collide and no firewall rule has to
            // be guessed at.
            ServerSocket().apply {
                reuseAddress = true
                bind(InetSocketAddress(0), ACCEPT_BACKLOG)
            }
        } catch (_: IOException) {
            announceFailure(LocalPeerFailure.ADVERTISE)
            return
        }
        server = socket
        acceptThread = Thread({ acceptLoop(socket) }, "relayium-nearby-accept").apply {
            isDaemon = true
            start()
        }

        val info = NsdServiceInfo().apply {
            serviceName = ad.serviceInstanceName
            serviceType = LocalPeerAdvertisement.SERVICE_TYPE
            port = socket.localPort
            for ((key, value) in ad.txtRecord) setAttribute(key, value)
        }
        val registration = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) {
                onQueue { onRegistered(info.serviceName) }
            }
            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
                onQueue { announceFailure(LocalPeerFailure.ADVERTISE) }
            }
            override fun onServiceUnregistered(info: NsdServiceInfo) = Unit
            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) = Unit
        }
        registrationListener = registration
        val discovery = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                onQueue { onBrowseReady() }
            }
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                onQueue { announceFailure(LocalPeerFailure.DISCOVER) }
            }
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onServiceFound(info: NsdServiceInfo) {
                onQueue { onFound(info) }
            }
            override fun onServiceLost(info: NsdServiceInfo) {
                onQueue { onLost(info.serviceName) }
            }
        }
        discoveryListener = discovery
        try {
            manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration)
        } catch (_: IllegalArgumentException) {
            announceFailure(LocalPeerFailure.ADVERTISE)
            return
        }
        try {
            manager.discoverServices(
                LocalPeerAdvertisement.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discovery,
            )
        } catch (_: IllegalArgumentException) {
            announceFailure(LocalPeerFailure.DISCOVER)
            return
        }

        onQueueLater(startDeadlineMs) {
            if (lifecycle.startDeadlineElapsed() ==
                LocalPeerTransportLifecycle.AnnouncementDecision.ANNOUNCE
            ) {
                announceFailureAndTearDown(LocalPeerFailure.UNAVAILABLE)
            }
        }
    }

    /**
     * The platform accepted the registration — under WHICH name?
     *
     * Bonjour renames a colliding instance (`name (2)`), and a renamed instance
     * is a record every peer REFUSES: the reader requires the TXT `i` field to
     * equal the instance name, and `i` still carries the identity we minted. So
     * a rename is not a smaller success, it is advertising under a name nobody
     * will read, and the honest answer is to fail. A 32-character random
     * identity makes a genuine collision vanishingly unlikely, which is what
     * lets this be a hard failure rather than a remint loop.
     */
    private fun onRegistered(registeredName: String) {
        val mine = advertisement?.identity
        if (mine == null || registeredName != mine) {
            announceFailureAndTearDown(LocalPeerFailure.ADVERTISE)
            return
        }
        if (lifecycle.advertiseBecameReady() ==
            LocalPeerTransportLifecycle.AnnouncementDecision.ANNOUNCE
        ) {
            delegate?.localPeerTransportDidStart()
        }
    }

    private fun onBrowseReady() {
        if (lifecycle.browseBecameReady() ==
            LocalPeerTransportLifecycle.AnnouncementDecision.ANNOUNCE
        ) {
            delegate?.localPeerTransportDidStart()
        }
    }

    // ── discovery ───────────────────────────────────────────────────────────

    private fun onFound(info: NsdServiceInfo) {
        if (!lifecycle.isDeliveringEvents) return
        val name = info.serviceName ?: return
        // Our own advertisement comes back from the browser. Ignored here as
        // well as in the channel: two independent readers, and neither is the
        // other's backstop.
        if (name == advertisement?.identity) return
        // Refused BEFORE it costs a resolution: an instance name that is not a
        // valid identity can never produce a record `parse` would accept, so
        // resolving it would only spend the single-flight resolver on a peer
        // that is already known to be unreadable.
        if (!LocalPeerAdvertisement.isValidIdentity(name)) return
        // A NEW appearance, always — including a name that was just lost and has
        // come back. The endpoint behind one identity legitimately changes (a
        // peer that moved networks keeps advertising), and treating a refind as
        // "already known" would keep publishing the address it used to have.
        findSeq++
        val appearance = findSeq
        present[name] = appearance
        if (resolved.containsKey(name)) return
        resolveQueue.removeAll { it.name == name }
        if (resolveQueue.size >= MAX_PENDING_RESOLUTIONS) return
        resolveQueue.addLast(Pending(info, name, appearance))
        pumpResolutions()
    }

    private fun onLost(serviceName: String?) {
        if (serviceName == null) return
        // Its appearance is over. A resolution already in flight for it is not
        // cancellable, so it is fenced instead: the adopt below checks the
        // appearance it was queued under against the one that is present NOW,
        // and a lost — or lost-and-refound — service fails that comparison.
        present.remove(serviceName)
        resolveQueue.removeAll { it.name == serviceName }
        resolveRetried.remove(serviceName)
        if (resolved.remove(serviceName) != null) publish()
    }

    private fun pumpResolutions() {
        if (resolveInFlight != null) return
        val manager = nsd ?: return
        val next = resolveQueue.removeFirstOrNull() ?: return
        resolveInFlight = next
        val listener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                onQueue { onResolveFailed(next, errorCode) }
            }
            override fun onServiceResolved(info: NsdServiceInfo) {
                onQueue { onResolved(next, info) }
            }
        }
        try {
            @Suppress("DEPRECATION")
            manager.resolveService(next.info, listener)
        } catch (_: IllegalArgumentException) {
            resolveInFlight = null
            onQueue { pumpResolutions() }
        }
    }

    private fun onResolveFailed(pending: Pending, errorCode: Int) {
        resolveInFlight = null
        // Exactly ONE retry, and only for the contended case. Anything else is a
        // record this device cannot read, and re-queuing it forever would starve
        // every peer behind it in a single-flight resolver. A service that has
        // since been lost is not retried at all.
        if (errorCode == NsdManager.FAILURE_ALREADY_ACTIVE &&
            present[pending.name] == pending.appearance &&
            resolveRetried.add(pending.name) &&
            resolveQueue.size < MAX_PENDING_RESOLUTIONS
        ) {
            resolveQueue.addLast(pending)
        }
        onQueueLater(RESOLVE_RETRY_MS) { pumpResolutions() }
    }

    private fun onResolved(pending: Pending, info: NsdServiceInfo) {
        resolveInFlight = null
        if (lifecycle.isDeliveringEvents) adopt(pending, info)
        pumpResolutions()
    }

    private fun adopt(pending: Pending, info: NsdServiceInfo) {
        val name = info.serviceName ?: return
        // The answer is about the appearance it was ASKED under. A service that
        // has been lost since — or lost and found again, which is how a peer
        // that changed network looks — must not be published from this answer:
        // it would resurrect a device that is gone, or hand out the address it
        // no longer has.
        if (name != pending.name) return
        if (present[name] != pending.appearance) return
        val attributes = info.attributes ?: return
        val txt = HashMap<String, String>(attributes.size)
        for ((key, value) in attributes) {
            // A NULL-valued TXT key is a key that is PRESENT — DNS-SD says so —
            // and this record shape has no valued-optional keys. Reading it as
            // absent would admit a record whose key set is not the three the
            // parser requires.
            val bytes = value ?: return
            // STRICT. The lenient decoder replaces a malformed sequence with
            // U+FFFD, which would admit a name or a capability the record does
            // not actually carry — and a capability is compared for exact
            // equality everywhere it is read.
            txt[key] = LocalPeerFraming.strictUtf8(bytes) ?: return
        }
        val ad = LocalPeerAdvertisement.parse(name, txt) ?: return
        @Suppress("DEPRECATION")
        val host = info.host ?: return
        val port = info.port
        if (port !in 1..65535) return
        if (resolved.size >= MAX_RESOLVED && !resolved.containsKey(ad.identity)) return
        resolved[ad.identity] = Resolved(ad, host, port)
        resolveRetried.remove(name)
        publish()
    }

    private fun publish() {
        if (!lifecycle.isDeliveringEvents) return
        delegate?.localPeerTransportDidDiscover(resolved.values.map { it.advertisement })
    }

    // ── streams ─────────────────────────────────────────────────────────────

    private fun acceptLoop(socket: ServerSocket) {
        while (true) {
            val accepted = try {
                socket.accept()
            } catch (_: IOException) {
                return // the socket was closed by stop(), or the link went away
            }
            val delivered = handOffAccepted(
                accepted = accepted,
                submit = { task -> queue.execute(task) },
                receive = { connection ->
                    val target = delegate
                    if (target == null || !lifecycle.isDeliveringEvents) {
                        false
                    } else {
                        target.localPeerTransportDidAccept(connection)
                        true
                    }
                },
            )
            // The queue is gone, so this room is over and every later accept
            // would be refused the same way. Stop listening.
            if (!delivered) return
        }
    }

    override fun connect(peer: LocalPeerAdvertisement): LocalPeerConnection {
        // Snapshot the address on the CALLER's turn is not possible — this is
        // called from the channel's queue, not this one — so the dial resolves
        // the endpoint on its own thread against a value published by this
        // queue. `resolved` is only ever written here, and a missing entry is a
        // connection that fails immediately rather than one that dials a guess.
        val identity = peer.identity
        return SocketPeerConnection.dialling {
            val future = java.util.concurrent.CompletableFuture<Resolved?>()
            // A queue that has stopped answers immediately rather than making the
            // dial wait out its lookup deadline for a room that is already gone.
            if (runCatching { queue.execute { future.complete(resolved[identity]) } }.isFailure) {
                future.complete(null)
            }
            val target = future.get(DIAL_LOOKUP_MS, TimeUnit.MILLISECONDS)
                ?: throw IOException("no resolved address for $identity")
            Socket().apply {
                tcpNoDelay = true
                connect(InetSocketAddress(target.address, target.port), DIAL_TIMEOUT_MS.toInt())
            }
        }
    }

    override fun stop() {
        onQueue { performStop() }
    }

    private fun performStop() {
        if (lifecycle.stop() != LocalPeerTransportLifecycle.StopDecision.TEAR_DOWN) return
        delegate = null
        val manager = nsd
        registrationListener?.let { listener ->
            runCatching { manager?.unregisterService(listener) }
        }
        registrationListener = null
        discoveryListener?.let { listener ->
            runCatching { manager?.stopServiceDiscovery(listener) }
        }
        discoveryListener = null
        runCatching { server?.close() }
        server = null
        acceptThread = null
        resolved.clear()
        resolveQueue.clear()
        resolveRetried.clear()
        resolveInFlight = null
        present.clear()
        // Last, and only for a queue this object created. A transport is built
        // fresh for every room, so a queue left running is one parked daemon
        // thread per reconnect. `shutdown()` — not `shutdownNow()` — lets the
        // teardown this call is part of finish; work posted afterwards is
        // rejected, which [onQueue] treats as the moot event it is.
        if (ownsQueue) runCatching { queue.shutdown() }
    }

    private fun announceFailure(reason: LocalPeerFailure) {
        if (lifecycle.fail() != LocalPeerTransportLifecycle.AnnouncementDecision.ANNOUNCE) return
        announceFailureAndTearDown(reason)
    }

    /**
     * Announce FIRST, then release the listener and the socket.
     *
     * A failure this transport will not recover from must not leave the device
     * still advertising `_relayium._tcp` while its owner's state says the room is
     * gone — and [performStop] clears the delegate, so the announcement cannot
     * come after it.
     */
    private fun announceFailureAndTearDown(reason: LocalPeerFailure) {
        delegate?.localPeerTransportDidFail(reason)
        performStop()
    }

    companion object {
        /** Long enough that a user answering a system prompt is not raced, short
         *  enough that a link with no multicast becomes a truthful "cannot search
         *  here" rather than an endless spinner. Matches the Apple client. */
        const val START_DEADLINE_MS = 20_000L
        const val RESOLVE_RETRY_MS = 400L
        const val DIAL_TIMEOUT_MS = 10_000L
        const val DIAL_LOOKUP_MS = 5_000L
        const val ACCEPT_BACKLOG = 8
        const val MAX_PENDING_RESOLUTIONS = 32
        const val MAX_RESOLVED = 64

        private fun defaultQueue(): ScheduledExecutorService =
            ScheduledThreadPoolExecutor(1) { runnable ->
                Executors.defaultThreadFactory().newThread(runnable).apply {
                    name = "relayium-nearby-nsd"
                    isDaemon = true
                }
            }
    }
}

/**
 * Hand ONE accepted socket to the owner thread without ever losing it.
 *
 * This is the ONE hop onto the transport's queue that carries a live file
 * descriptor, which is why it does not go through the transport's ordinary
 * fire-and-forget helper. Dropping a rejected task silently is right for a
 * discovery callback about a room that is gone, and WRONG here: nothing else
 * holds a reference, so a rejected dispatch is a leaked descriptor and a dead
 * accept thread. `stop()` shuts the queue down and can do so between `accept()`
 * returning and this dispatch, so that rejection is caught and the socket is
 * closed on the calling thread instead.
 *
 * The same reasoning covers [receive] answering false — no delegate, or a room
 * no longer delivering events. An accepted socket with nobody to give it to is
 * this function's to close.
 *
 * Extracted from the loop so it is drivable from a plain JVM test against a real
 * socket and a real rejecting executor; the loop calls exactly this.
 *
 * @return false when the queue refused the work and the caller must stop
 *   accepting.
 */
internal fun handOffAccepted(
    accepted: Socket,
    submit: (Runnable) -> Unit,
    receive: (LocalPeerConnection) -> Boolean,
): Boolean {
    val dispatched = runCatching {
        submit(
            Runnable {
                // Wrapped FIRST, so from here on exactly one object owns the
                // descriptor and cancelling it is what closes it.
                val connection = SocketPeerConnection.accepted(accepted)
                if (!receive(connection)) connection.cancel()
            },
        )
    }.isSuccess
    if (!dispatched) runCatching { accepted.close() }
    return dispatched
}

/**
 * One TCP stream, with the handler-ownership rule the seam requires: an end
 * observed before a close handler exists is still owed to the first handler
 * installed afterwards, and every callback is delivered exactly once.
 *
 * Reads and writes have their own threads because both block: a peer that stops
 * reading must not be able to stall the channel's owner thread, and a socket has
 * no write deadline to lean on.
 */
internal class SocketPeerConnection private constructor(
    /** How to obtain the socket, for an OUTBOUND stream. Null when the socket
     *  already exists — an accepted one is connected before this object does. */
    private val open: (() -> Socket)?,
    accepted: Socket?,
) : LocalPeerConnection {

    /**
     * The ownership lock, and the ONLY thing that decides who closes the socket.
     *
     * Two races made this explicit rather than incidental, and both leaked a
     * real file descriptor:
     *
     *  1. an ACCEPTED socket is connected before this object exists. The channel
     *     legitimately refuses one — it is over its stream bound, or already
     *     closed — by calling [cancel] and never [start]. A socket that only the
     *     worker thread knew about was then never closed by anyone.
     *  2. a [cancel] landing between a dial returning and the worker publishing
     *     its result saw a null field, closed nothing, and the worker then
     *     published and read from a socket its owner believed was gone.
     *
     * So the socket and the cancelled flag move together, inside this lock: a
     * cancel either takes the socket and closes it, or arrives first and the
     * worker refuses to adopt what it opened and closes that instead. Exactly
     * one side ends up owning any descriptor, in every interleaving.
     */
    private val lock = Any()
    private var socket: Socket? = null

    /** Written only inside [lock]; read freely, so a send does not contend. */
    @Volatile
    private var cancelled = false

    private var bytesHandler: ((ByteArray, Int) -> Unit)? = null
    private var closeHandler: (() -> Unit)? = null
    private var endObserved = false
    private var closeDelivered = false

    private val started = AtomicBoolean(false)
    private val outbox = ArrayBlockingQueue<ByteArray>(SEND_QUEUE_FRAMES)

    init {
        // Adopted IMMEDIATELY, so a refusal before `start()` still has something
        // to close.
        if (accepted != null) synchronized(lock) { socket = accepted }
    }

    override var onBytes: ((ByteArray, Int) -> Unit)?
        get() = synchronized(lock) { bytesHandler }
        set(value) { synchronized(lock) { bytesHandler = value } }

    override var onClosed: (() -> Unit)?
        get() = synchronized(lock) { closeHandler }
        set(value) {
            val owed = synchronized(lock) {
                if (value == null) { closeHandler = null; return@synchronized null }
                if (closeDelivered) { closeHandler = null; return@synchronized null }
                // An end observed before a handler existed is still OWED to the
                // first handler installed afterwards; nothing re-announces it.
                if (endObserved) { closeDelivered = true; closeHandler = null; return@synchronized value }
                closeHandler = value
                null
            }
            owed?.invoke()
        }

    override fun start() {
        if (cancelled) return
        if (!started.compareAndSet(false, true)) return
        Thread({ run() }, "relayium-nearby-stream").apply { isDaemon = true }.start()
    }

    override fun send(bytes: ByteArray) {
        if (cancelled) return
        // A full outbox is a peer that is not reading. Bounded rather than
        // grown: dropping the stream is truthful — the establishment behind it
        // cannot complete anyway — and an unbounded queue is a memory lever a
        // link can pull.
        if (!outbox.offer(bytes)) cancel()
    }

    override fun cancel() {
        val toClose = synchronized(lock) {
            if (cancelled) return
            cancelled = true
            socket.also { socket = null }
        }
        runCatching { toClose?.close() }
        outbox.clear()
        // Unblock the writer, which is parked on take().
        outbox.offer(POISON)
        // A stream cancelled before it ever ran still owes its owner the close
        // edge: nothing else will produce one, because no worker exists.
        if (!started.get()) fireClosed()
    }

    private fun run() {
        val dialled = if (open != null) {
            try {
                open.invoke()
            } catch (_: Exception) {
                fireClosed()
                return
            }
        } else {
            null
        }
        // Publication and the cancellation check, indivisibly. A cancel that
        // already ran refuses the adoption and this thread closes what it
        // opened; a cancel that runs after takes the socket and closes it.
        val active = synchronized(lock) {
            if (cancelled) {
                null
            } else {
                if (dialled != null) socket = dialled
                socket
            }
        }
        if (active == null) {
            runCatching { dialled?.close() }
            fireClosed()
            return
        }
        val input: InputStream
        val output: OutputStream
        try {
            active.tcpNoDelay = true
            input = active.getInputStream()
            output = active.getOutputStream()
        } catch (_: IOException) {
            cancel()
            fireClosed()
            return
        }
        val writer = Thread({ writeLoop(output) }, "relayium-nearby-write").apply {
            isDaemon = true
            start()
        }
        val buffer = ByteArray(READ_BUFFER_BYTES)
        try {
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (read == 0) continue
                val handler = synchronized(lock) { bytesHandler } ?: continue
                handler(buffer, read)
            }
        } catch (_: IOException) {
            // A reset, or a close during teardown: the same terminal edge.
        } finally {
            cancel()
            runCatching { writer.join(WRITER_JOIN_MS) }
            fireClosed()
        }
    }

    private fun writeLoop(output: OutputStream) {
        try {
            while (true) {
                val frame = outbox.take()
                if (frame === POISON) return
                output.write(frame)
                output.flush()
            }
        } catch (_: IOException) {
            cancel()
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun fireClosed() {
        val owed = synchronized(lock) {
            if (closeDelivered) return@synchronized null
            endObserved = true
            val handler = closeHandler ?: return@synchronized null
            closeDelivered = true
            closeHandler = null
            handler
        }
        owed?.invoke()
    }

    companion object {
        const val READ_BUFFER_BYTES = LocalPeerFraming.MAX_FRAME_BYTES + LocalPeerFraming.HEADER_BYTES
        const val SEND_QUEUE_FRAMES = 64
        const val WRITER_JOIN_MS = 1_000L
        private val POISON = ByteArray(0)

        /** An already-accepted socket. Owned from this instant, so a refusal
         *  before [start] closes it. */
        fun accepted(socket: Socket): SocketPeerConnection =
            SocketPeerConnection(open = null, accepted = socket)

        /** An outbound stream. [open] runs on the stream's own thread, so a
         *  connect that blocks for its full timeout stalls nothing else. */
        fun dialling(open: () -> Socket): SocketPeerConnection =
            SocketPeerConnection(open = open, accepted = null)
    }
}
