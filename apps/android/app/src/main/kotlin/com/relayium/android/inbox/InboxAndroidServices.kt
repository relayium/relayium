package com.relayium.android.inbox

import android.content.Context
import android.os.CancellationSignal
import android.os.OperationCanceledException
import android.os.storage.StorageManager
import androidx.core.net.toUri
import com.relayium.android.cloud.CloudClient
import com.relayium.android.cloud.DurableFiles
import com.relayium.android.cloud.KeystoreSecretBox
import com.relayium.android.cloud.SecretBox
import com.relayium.protocol.stored.PlaintextSource
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.InputStream
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.security.SecureRandom
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

/**
 * The production composition: real Keystore, real no-backup storage, real
 * StorageManager, real sockets.
 *
 * This is the only place Android types meet the Inbox, which is what keeps
 * everything above it JVM-testable. Three decisions are made here and nowhere
 * else:
 *
 *  * **Where the stores live.** `noBackupFilesDir`, so received files, journals,
 *    messages, key history and outgoing spools do not travel in a cloud backup
 *    or a device transfer. The manifest already excludes every storage domain
 *    for both; putting them here means that protection does not rest on a
 *    manifest rule alone.
 *  * **Which device this is.** Central's `Current` row, resolved through an
 *    account-scoped transport and then PINNED into a device-scoped one that
 *    refuses to act as any other row. A native client cannot assume its device
 *    id, and the first row of a list is not an answer.
 *  * **How much room there is.** [StorageManager.getAllocatableBytes], whose
 *    failure is reported as UNKNOWN rather than as zero — a zero would report
 *    `disk_full` for a device with plenty of room, and stop it receiving.
 */
class InboxAndroidServices(
    context: Context,
    private val origin: String,
    private val userAgent: String,
    /** This build's version, as central records it at enrolment. */
    private val appVersion: String,
    private val cloud: CloudClient,
    private val nowSeconds: () -> Long,
    /** Its own Keystore alias and its own labels: an Inbox record must not be
     *  openable as, or confusable with, a pending cloud upload. */
    private val secrets: SecretBox = KeystoreSecretBox(INBOX_ALIAS),
    private val files: DurableFiles = DurableFiles.Platform,
    private val http: OkHttpClient = OkHttpInboxTransport.defaultClient(),
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val newId: () -> String = ::randomId,
) : InboxServiceFactory {

    private val app = context.applicationContext
    private val root: File = app.noBackupFilesDir
    private val storage = app.getSystemService(Context.STORAGE_SERVICE) as? StorageManager

    override suspend fun open(account: InboxAccountId, bearer: String): InboxServices {
        // Sender first, because it is the half that can ASK which device this
        // is. The answer is then pinned: `forDevice` refuses a row that is not
        // the id it was built with, so a re-login that minted a different row
        // fails loudly instead of enrolling under someone else's identity.
        val sender = OkHttpInboxTransport.forAccount(origin, userAgent, bearer, http, io)
        val current = sender.currentDevice()
        val device = OkHttpInboxTransport.forDevice(
            origin, userAgent, bearer, current.id, http, io,
        )

        val container = InboxContainer(root, files, io)
        val accountRoot = File(File(root, InboxContainer.DIRECTORY), account.value)
        val journals = InboxJournalStore(container.journals(account), account, secrets, files, io)
        val messages = InboxMessageStore(container.messages(account), account, secrets, files, io)
        val conversations =
            InboxConversationStore(File(accountRoot, LEDGER), account, secrets, files, io)
        val sendStore = InboxSendStore(File(accountRoot, OUTGOING), account, secrets, files, io)
        val outgoing =
            InboxOutgoingTextStore(File(accountRoot, SENT_TEXT), account, secrets, files, io)
        val keys = InboxKeyStore(root, secrets, files, io)
        val uploader = CloudInboxUploader(cloud, { bearer }, OBJECT_TTL_SECONDS, nowSeconds, io)

        val free = { allocatable(container.directory(account)) }

        return InboxServices(
            account = account,
            deviceId = current.id,
            deviceName = current.name,
            device = device,
            sender = sender,
            keys = keys,
            container = container,
            journals = journals,
            messages = messages,
            outgoing = outgoing,
            conversations = conversations,
            sendStore = sendStore,
            preparer = InboxSendPreparer(sendStore, nowSeconds, newId),
            coordinator = InboxSendCoordinator(sender, sendStore, uploader, nowSeconds),
            policies = InboxPolicyStore(accountRoot, files, io),
            sources = ContentResolverSources(app, io),
            freeBytes = free,
            engine = { policy, onPending, onDelivered ->
                InboxReceiveEngine(
                    transport = device, keys = keys, journals = journals, messages = messages,
                    container = container, secrets = secrets, files = files, account = account,
                    policy = policy, nowSeconds = nowSeconds,
                    platform = PLATFORM, appVersion = appVersion,
                    // This surface renders a received message AS a message, so
                    // announcing the capability is truthful rather than
                    // aspirational.
                    presentsText = true,
                    freeBytes = free, io = io,
                    onPending = onPending, onDelivered = onDelivered,
                )
            },
        )
    }

    /**
     * How much this app could actually allocate, or null when the platform
     * cannot say.
     *
     * `getAllocatableBytes` rather than `usableSpace`, because the platform will
     * clear cached data to satisfy an allocation — so the free-space figure that
     * matters is the one that accounts for it. Every failure answers UNKNOWN:
     * the delivery is then decided by the write itself, which is the honest
     * outcome, instead of by a zero this code invented.
     */
    private fun allocatable(directory: File): Long? {
        val manager = storage ?: return null
        return try {
            val target = if (directory.exists()) directory else root
            manager.getAllocatableBytes(manager.getUuidForPath(target))
        } catch (e: IOException) {
            null
        } catch (e: IllegalArgumentException) {
            null
        } catch (e: SecurityException) {
            null
        }
    }

    private companion object {
        const val PLATFORM = "android"
        const val LEDGER = "history"
        const val OUTGOING = "outgoing"
        const val SENT_TEXT = "sent-text"

        /**
         * The ciphertext object's own lifetime, asked of the server.
         *
         * A ceiling on how long an undelivered task's bytes are paid for, not a
         * promise: central clamps it against the account's plan exactly as it
         * does a share. A task that outlives its object fails with a stored
         * object that is gone, which the receiver already reports honestly.
         */
        const val OBJECT_TTL_SECONDS = 7 * 24 * 60 * 60

        /** Distinct from every other alias in the app. See [KeystoreSecretBox]. */
        const val INBOX_ALIAS = "com.relayium.android.inbox.records.v1"
    }
}

/** 32 lowercase hex characters, the shape [InboxId] accepts. */
private fun randomId(): String {
    val bytes = ByteArray(16)
    SecureRandom().nextBytes(bytes)
    return bytes.joinToString("") { "%02x".format(it) }
}

/**
 * Opens what the user picked, owning every descriptor from the instant it
 * exists.
 *
 * Three things this does that a `try/finally` around `openInputStream` does not:
 *
 *  * **The descriptor is leased before it is handed back.** It is registered
 *    while still inside the block that created it, so a cancellation delivered
 *    at the dispatcher hand-off cannot drop a live descriptor on the floor. A
 *    lease that has already closed refuses the resource AND closes it.
 *  * **Cancellation closes it concurrently with a blocked read.** A `finally`
 *    runs when the block returns, and the block is precisely what is stuck
 *    inside another process; the lease closes from the cancelling thread, and
 *    that close is what ends the read.
 *  * **The provider call is cancellable where the platform allows it.**
 *    `openFileDescriptor` takes a [CancellationSignal]; the signal is leased
 *    BEFORE the binder call, so a cancellation during the call cancels the
 *    open rather than waiting it out.
 *
 * The stream is opened ONCE and held for the whole staging rather than reopened
 * per chunk: a second resolution of the same URI is the one that can point at
 * different bytes than the ones the user approved. What it cannot prevent is the
 * document changing in place, which is why the encoder refuses a source that
 * disagrees with the size the manifest declared.
 */
private class ContentResolverSources(
    private val context: Context,
    private val io: CoroutineDispatcher,
) : InboxSourceOpener {

    private val delegate = InboxLeasedSources(open = ::openDocument)

    override suspend fun <T> withSources(
        refs: List<InboxSourceRef>,
        body: suspend (List<PlaintextSource>) -> T,
    ): T = delegate.withSources(refs, body)

    private suspend fun openDocument(
        ref: InboxSourceRef,
        lease: InboxSourceLease,
    ): PlaintextSource? = withContext(io) {
        val signal = CancellationSignal()
        // Leased BEFORE the binder call, so a cancellation arriving during it
        // cancels the provider's own work.
        if (!lease.add(Closeable { signal.cancel() })) return@withContext null
        val stream = openStream(ref, signal, lease) ?: return@withContext null
        // Registered before it can reach a caller. A lease that closed while
        // this was opening closes the stream here and refuses it.
        if (!lease.add(stream)) return@withContext null
        object : PlaintextSource {
            override val name = ref.name
            override val size = ref.size

            override fun read(max: Int): ByteArray {
                if (max <= 0) return ByteArray(0)
                val buffer = ByteArray(max)
                var read = 0
                // A content stream may return a short read at any point; only a
                // -1 means the end. Filling the buffer keeps frames at the wire
                // size instead of producing a stream of tiny ones.
                while (read < max) {
                    val n = stream.read(buffer, read, max - read)
                    if (n <= 0) break
                    read += n
                }
                return if (read == max) buffer else buffer.copyOf(read)
            }

            // Closing is the LEASE's job: it is the only owner that can act
            // while a read is blocked. Closing twice is harmless, and this is
            // what `InboxSendPreparer` will not call anyway.
            override fun close() = Unit
        }
    }

    /**
     * A descriptor first, because that is the form the platform will let a
     * signal cancel; the untyped stream only as a fallback for a provider that
     * offers nothing else.
     */
    /**
     * A cancellable ASSET descriptor first, and nothing uncancellable ever.
     *
     * `openAssetFileDescriptor` is the right primitive here, not
     * `openFileDescriptor`: it takes a [CancellationSignal], and it also covers
     * the shape a plain descriptor cannot — a provider serving a SUBSECTION of a
     * file, where the offset and length matter and reading the whole descriptor
     * would hand back the wrong bytes. `createInputStream` applies that
     * subsection.
     *
     * The typed form follows for a provider that only streams (a pipe). There is
     * deliberately no `openInputStream` fallback: it is the same binder call
     * with nowhere to put a signal, and restarting an uncancellable open after
     * two cancellable ones failed would reintroduce, by our own choice, exactly
     * the hang the lease exists to prevent. A provider that ignores the signal
     * is an honest external limit; one this code creates is not.
     */
    private suspend fun openStream(
        ref: InboxSourceRef,
        signal: CancellationSignal,
        lease: InboxSourceLease,
    ): InputStream? {
        val uri = ref.uri.toUri()
        val resolver = context.contentResolver

        currentCoroutineContext().ensureActive()
        try {
            val asset = resolver.openAssetFileDescriptor(uri, "r", signal)
            if (asset != null) {
                // Leased BEFORE the conversion: `createInputStream` can throw,
                // and the descriptor would then be unreachable and unclosed.
                if (!lease.add(asset)) return null
                return asset.createInputStream()
            }
        } catch (e: OperationCanceledException) {
            return null
        } catch (e: SecurityException) {
            // A grant that is gone. Actionable, not a crash.
            return null
        } catch (e: IOException) {
            // Falls through: a provider that only implements `openTypedAssetFile`
            // answers `FileNotFoundException` here and still opens below.
        } catch (e: IllegalArgumentException) {
            return null
        }

        currentCoroutineContext().ensureActive()
        return try {
            val typed = resolver.openTypedAssetFileDescriptor(uri, "*/*", null, signal)
            if (typed == null || !lease.add(typed)) null else typed.createInputStream()
        } catch (e: OperationCanceledException) {
            null
        } catch (e: SecurityException) {
            null
        } catch (e: IOException) {
            null
        } catch (e: IllegalArgumentException) {
            null
        }
    }
}
