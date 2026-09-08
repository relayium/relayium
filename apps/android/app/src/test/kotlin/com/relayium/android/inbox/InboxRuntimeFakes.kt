package com.relayium.android.inbox

import com.relayium.android.cloud.DurableFiles
import com.relayium.android.cloud.FakeSecretBox
import com.relayium.android.cloud.ScriptedDurableFiles
import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.inbox.InboxKeyMaterial
import java.io.File
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

/**
 * The SENDER half of a scriptable Device Inbox, over the frozen
 * [FakeInboxTransport]'s device half.
 *
 * `FakeInboxTransport` answers `createTask`, `task`, `tasks` and `cancelTask`
 * with `UnsupportedOperationException`, so nothing above it can drive a send.
 * Delegation rather than a fork keeps every device-side behaviour that file
 * already models — a lost registration, a refused lease, a cut stream — while
 * adding the account-scoped half a coordinator needs.
 */
class ScriptedInboxServer(
    val device: FakeInboxTransport = FakeInboxTransport(),
) : InboxDeviceTransport by device, InboxSenderTransport {

    /** Method names in call order, sender half only. */
    val calls: MutableList<String> = Collections.synchronizedList(ArrayList())

    /** Tasks central holds, by id. */
    val tasks: MutableMap<String, InboxTaskRow> = ConcurrentHashMap()

    /** Answered by `createTask`, keyed by idempotency key, so a repeat
     *  converges exactly as central's own idempotency does. */
    private val created = ConcurrentHashMap<String, InboxTaskRow>()

    /** The exact wrapped keys `createTask` was given, in order: a sealed box is
     *  randomized, so "the same box" is the property a retry has to keep. */
    val wrappedKeys: MutableList<String> = Collections.synchronizedList(ArrayList())

    var devices: List<InboxDeviceRow>
        get() = device.devices
        set(value) {
            device.devices = value
        }

    /** Thrown by the next `createTask`, then cleared. */
    var createFailure: Throwable? = null

    /** Thrown by every `task` lookup while set. */
    var taskFailure: Throwable? = null

    /** Thrown by every `accept` while set. An explicit override rather than the
     *  delegate's, so a refused answer is drivable — the frozen fake always
     *  succeeds. */
    var acceptFailure: Throwable? = null

    /** Parked until released, so a test can hold an operation INSIDE a
     *  suspension and change the world under it. */
    var deviceGate: CompletableDeferred<Unit>? = null

    val deviceCalls = AtomicInteger(0)

    /**
     * Hand a claimed delivery out ONCE, as central's lease does.
     *
     * The frozen fake answers the same claim forever, which no server does — and
     * a receive loop that works a delivery and immediately claims it again would
     * spin rather than idle.
     */
    override suspend fun claim(max: Int): InboxClaimResult {
        val result = device.claim(max)
        if (result.deliveries.isNotEmpty()) {
            device.claimResult = InboxClaimResult(emptyList(), result.leaseSeconds)
            device.pending = emptyList()
        }
        return result
    }

    override suspend fun accept(taskId: String, accept: Boolean): InboxTaskRow {
        acceptFailure?.let { throw it }
        return device.accept(taskId, accept)
    }

    override suspend fun devices(): List<InboxDeviceRow> {
        calls.add("devices")
        deviceCalls.incrementAndGet()
        deviceGate?.await()
        return device.devices
    }

    override suspend fun createTask(
        targetDeviceId: String,
        request: InboxSendRequest,
    ): InboxTaskCreation {
        calls.add("createTask")
        wrappedKeys.add(request.wrappedKey)
        createFailure?.let { createFailure = null; throw it }
        created[request.idempotencyKey]?.let { return InboxTaskCreation(it, created = false) }
        val row = InboxTaskRow.read(
            InboxFixtures.task(
                "ID" to Json.of("task%026d".format(created.size + 1)),
                "TargetDeviceID" to Json.of(targetDeviceId),
                "SourceDeviceID" to Json.of(InboxFixtures.DEVICE_ID),
                "IdempotencyKey" to Json.of(request.idempotencyKey),
                "StoredFileID" to Json.of(request.storedFileId),
                "TargetKeyID" to Json.of(request.targetKeyId),
                "TargetKeyGeneration" to Json.of(request.targetKeyGeneration),
            ),
        )
        created[request.idempotencyKey] = row
        tasks[row.id] = row
        return InboxTaskCreation(row, created = true)
    }

    override suspend fun task(targetDeviceId: String, taskId: String): InboxTaskRow {
        calls.add("task")
        taskFailure?.let { throw it }
        return tasks[taskId] ?: throw InboxApiException(404, null)
    }

    override suspend fun tasks(targetDeviceId: String, limit: Int): List<InboxTaskRow> {
        calls.add("tasks")
        return tasks.values.filter { it.targetDeviceId == targetDeviceId }
    }

    override suspend fun cancelTask(targetDeviceId: String, taskId: String) {
        calls.add("cancelTask")
    }

    /** Move a task into a state, as central would once the target reported. */
    fun settle(taskId: String, state: com.relayium.protocol.inbox.InboxTaskState) {
        val row = tasks.getValue(taskId)
        tasks[taskId] = InboxTaskRow.read(
            InboxFixtures.task(
                "ID" to Json.of(row.id),
                "TargetDeviceID" to Json.of(row.targetDeviceId),
                "State" to Json.of(state.wire),
                "Terminal" to Json.of(state.isTerminal),
            ),
        )
    }

    fun count(name: String): Int = calls.count { it == name }
}

/** An uploader that publishes an object without a network, so the coordinator's
 *  ordering can be driven end to end. */
class FakeCiphertextUploader : InboxCiphertextUploader {

    val uploads: MutableList<String> = Collections.synchronizedList(ArrayList())

    /** Thrown by the next upload, then cleared. */
    var failure: InboxUploadException? = null

    /** Parked until released, so a test can cancel INSIDE an upload. */
    var gate: CompletableDeferred<Unit>? = null

    private val ordinal = AtomicInteger(0)

    override suspend fun upload(job: InboxSendJob, store: InboxSendStore): InboxSendJob {
        uploads.add(job.jobId)
        gate?.await()
        failure?.let { failure = null; throw it }
        job.storedFileId?.let { return job }
        return store.save(
            job.copy(storedFileId = "stored%026d".format(ordinal.incrementAndGet())),
            job.updatedAt + 1,
        )
    }
}

/** Opens in-memory sources, and records that it closed every one. */
class RecordingSourceOpener(
    private val payloads: List<Pair<String, ByteArray>>,
) : InboxSourceOpener {

    val closed = AtomicInteger(0)

    /** Parked while open, so a cancellation can be delivered with descriptors
     *  outstanding — the case where closing is the thing that unblocks a read. */
    var gate: CompletableDeferred<Unit>? = null

    override suspend fun <T> withSources(
        refs: List<InboxSourceRef>,
        body: suspend (List<com.relayium.protocol.stored.PlaintextSource>) -> T,
    ): T {
        val sources = payloads.map { (name, bytes) ->
            com.relayium.protocol.stored.BytesSource(name, bytes)
        }
        try {
            gate?.await()
            return body(sources)
        } finally {
            closed.addAndGet(sources.size)
        }
    }
}

/**
 * A whole account's Inbox on a temporary directory, with real stores.
 *
 * Real [InboxJournalStore], [InboxMessageStore], [InboxConversationStore],
 * [InboxSendStore], [InboxKeyStore] and [InboxOutgoingTextStore] over a
 * [FakeSecretBox] whose label binding is verified exactly as AES-GCM's AAD is —
 * so an account switch, a moved record and a tombstone are tested against the
 * storage that ships, not against a map.
 */
class TestInboxServices(
    root: File,
    val account: InboxAccountId,
    val server: ScriptedInboxServer = ScriptedInboxServer(),
    val secrets: FakeSecretBox = FakeSecretBox(),
    val files: DurableFiles = ScriptedDurableFiles(),
    val uploader: FakeCiphertextUploader = FakeCiphertextUploader(),
    var sources: InboxSourceOpener = RecordingSourceOpener(listOf("a.txt" to ByteArray(8) { 1 })),
    val nowSeconds: () -> Long = { 1_700_000_500L },
    private val io: CoroutineDispatcher = Dispatchers.Unconfined,
) {
    private var ordinal = 0

    val container = InboxContainer(root, files, io)
    private val accountRoot = File(File(root, InboxContainer.DIRECTORY), account.value)
    val journals = InboxJournalStore(container.journals(account), account, secrets, files, io)
    val messages = InboxMessageStore(container.messages(account), account, secrets, files, io)
    val outgoing =
        InboxOutgoingTextStore(File(accountRoot, "sent-text"), account, secrets, files, io)
    val conversations =
        InboxConversationStore(File(accountRoot, "history"), account, secrets, files, io)
    val sendStore = InboxSendStore(File(accountRoot, "outgoing"), account, secrets, files, io)
    val keys = InboxKeyStore(root, secrets, files, io)
    val policies = InboxPolicyStore(accountRoot, files, io)

    /** Free space, or null for "cannot tell" — which is NOT zero. */
    var freeBytes: Long? = null

    /** Engines built, so a test can assert exactly one loop existed. */
    val engines = AtomicInteger(0)

    fun bundle(deviceId: String = InboxFixtures.DEVICE_ID) = InboxServices(
        account = account,
        deviceId = deviceId,
        deviceName = "Pixel",
        device = server,
        sender = server,
        keys = keys,
        container = container,
        journals = journals,
        messages = messages,
        outgoing = outgoing,
        conversations = conversations,
        sendStore = sendStore,
        preparer = InboxSendPreparer(sendStore, nowSeconds) { "job%026d".format(++ordinal) },
        coordinator = InboxSendCoordinator(server, sendStore, uploader, nowSeconds),
        policies = policies,
        sources = sources,
        freeBytes = { freeBytes },
        engine = { policy, onPending, onDelivered ->
            engines.incrementAndGet()
            InboxReceiveEngine(
                transport = server, keys = keys, journals = journals, messages = messages,
                container = container, secrets = secrets, files = files, account = account,
                policy = policy, nowSeconds = nowSeconds,
                platform = "android", appVersion = "0.1.1", presentsText = true,
                freeBytes = { freeBytes }, io = io,
                onPending = onPending, onDelivered = onDelivered,
            )
        },
    )

    /** A device row for this account's other device, sendable by default. */
    fun peer(vararg overrides: Pair<String, Json?>): InboxDeviceRow = InboxDeviceRow.read(
        InboxFixtures.device(
            "ID" to Json.of(InboxFixtures.OTHER_DEVICE_ID),
            "Name" to Json.of("MacBook"),
            "Current" to Json.of(false),
            *overrides,
        ),
    )

    /** This device's own row, marked Current as central marks exactly one. */
    fun self(vararg overrides: Pair<String, Json?>): InboxDeviceRow =
        InboxDeviceRow.read(InboxFixtures.device(*overrides))

    /** Give this account a key it actually holds, so enrolment reports healthy. */
    suspend fun holdKey() {
        val pair = InboxKeyMaterial.generateKeyPair()
        keys.append(pair, account, 1_700_000_000)
        keys.bind(InboxKeyMaterial.encode(pair.publicKey), InboxFixtures.KEY_ID, 1, account)
        server.device.keys.add(
            InboxKeyRow(
                id = InboxFixtures.KEY_ID,
                algorithm = com.relayium.protocol.inbox.InboxProtocol.KEY_ALGORITHM,
                publicKey = InboxKeyMaterial.encode(pair.publicKey),
                generation = 1, createdAt = 1_700_000_000, supersededAt = 0, revokedAt = 0,
            ),
        )
        server.device.enrolResult = InboxEnrolResult(
            inbox = InboxEnrolmentView.read(
                InboxFixtures.enrolment(
                    "Key" to InboxFixtures.key(
                        "PublicKey" to Json.of(InboxKeyMaterial.encode(pair.publicKey)),
                    ),
                ),
            ),
            protocolVersion = com.relayium.protocol.inbox.InboxProtocol.MAX_PROTOCOL_VERSION,
            receiveCapability = com.relayium.protocol.inbox.InboxCapability.REQUIRED_RECEIVE,
            keyAlgorithm = com.relayium.protocol.inbox.InboxProtocol.KEY_ALGORITHM,
        )
    }

    suspend fun policy(policy: InboxAutoAccept) = policies.write(policy)
}
