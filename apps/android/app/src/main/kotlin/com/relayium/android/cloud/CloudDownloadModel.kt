package com.relayium.android.cloud

import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import com.relayium.protocol.stored.StoredDestinations
import com.relayium.protocol.stored.StoredManifest
import com.relayium.protocol.stored.StoredWireException
import com.relayium.protocol.stored.asFileMetas
import com.relayium.protocol.stored.decryptManifestRaw
import com.relayium.protocol.stored.displayNames
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Receiving a stored transfer: a link in, files in a folder the user chose.
 *
 * ## One thread owns the receive store, and nothing else touches it
 *
 * [ReceiveStore] is explicitly not thread-safe, and its work is disk and
 * provider IO that must never run on the main thread. Both facts are satisfied
 * the same way: [storage] is a SINGLE-THREADED dispatcher, every one of this
 * model's coroutines runs on it, and the transport is built on it too — so the
 * `onChunk` callback that drives `write`/`export` arrives on the same thread as
 * `begin`, `finish` and `discard`. That is why the client is constructed here
 * from [clientFor] rather than passed in: a client bound to a different
 * dispatcher would put provider writes on one thread and rollback on another,
 * which is exactly the race that made a cancelled save able to delete a newly
 * begun batch's documents.
 *
 * A new save or a reset therefore CANCELS the previous job and then JOINS it
 * before touching the store. Cancelling alone is not enough: the old worker may
 * still be inside `export` when the new one calls `begin`.
 *
 * ## Why the manifest is read before a folder is asked for
 *
 * Everything that can refuse this batch is decided from the manifest alone — an
 * unsafe name, two entries that would land on one document, a key that does not
 * open it. Deciding first means the user is told the transfer cannot be saved
 * BEFORE they are sent into a folder picker for it, and no document is created
 * for a batch that was never going to complete.
 *
 * ## What is written, and when
 *
 * Bytes go to private staging first and reach the user's tree only once the
 * file they belong to is complete — [ReceiveStore] owns that rule, the ledger of
 * every document this batch created, the refusal to overwrite anything that
 * already exists, and the refusal to recursively delete a directory it does not
 * own. A failure part-way through removes what this batch made and says so;
 * where the provider cannot delete a created directory, the outcome reports the
 * cleanup as incomplete rather than claiming a clean rollback — including after
 * a cancellation, which is a leftover like any other.
 */
class CloudDownloadModel(
    private val scope: CoroutineScope,
    /**
     * The single thread that owns the receive store, the destination provider
     * and this model's state. MUST be single-threaded and MUST NOT be the main
     * dispatcher.
     */
    private val storage: CoroutineDispatcher,
    /** Builds the transport bound to a dispatcher — always [storage], so the
     *  chunk callback lands on the store's own thread. */
    clientFor: (CoroutineDispatcher) -> CloudClient,
    /** This app's own backend. A link naming any other origin is not one this
     *  app can open — see [parseStoredLink]. */
    private val origin: String,
    private val store: ReceiveStore,
) {

    private val client = clientFor(storage)

    sealed interface State {
        data object Idle : State

        /** Reading metadata. Brief, but it is a network round trip. */
        data object Loading : State

        /** The manifest opened and every entry is safe to create. Waiting for
         *  the user to choose where. */
        data class Ready(
            val names: List<String>,
            val totalBytes: Long,
            val burnAfterRead: Boolean,
            val expiresAt: Long,
        ) : State

        data class Saving(val received: Long, val total: Long) : State

        data class Done(val files: Int) : State

        /**
         * [cleanupIncomplete] is true when this batch left something in the
         * user's folder that it could not remove — a truthful leftover, not a
         * silent one.
         */
        data class Failed(
            val failure: CloudFailure,
            val cleanupIncomplete: Boolean = false,
        ) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    /** Held between [open] and [save]: the link's key and the manifest the user
     *  was shown. Never persisted, never logged. Confined to [storage]. */
    private var pending: Pending? = null

    private class Pending(val link: StoredLink, val manifest: StoredManifest)

    private var generation = 0

    /**
     * Which opened transfer a folder choice belongs to.
     *
     * The folder picker is a round trip through another process and its result
     * needs a provider resolve afterwards, so between "the user chose a folder"
     * and "this saves" the user may have opened a DIFFERENT link. Saving link B
     * into the folder chosen for link A is not what anybody asked for, so the
     * caller captures this when it launches the picker and it is rechecked on
     * [storage], at the save itself.
     *
     * **It is invalidated at command ADMISSION, not when the next transfer
     * becomes visible.** [open] and [reset] are admitted on the caller's thread
     * and do their work on [storage], so there is a window in which a newer
     * command has been queued but has not run: the state is still `Ready(A)` and
     * `pending` is still A. A stale folder result arriving in that window would
     * pass every check — and, worse, would CANCEL the queued newer command on
     * its way past, so the token it was checked against never advanced and the
     * user's chosen folder received the transfer they had already left.
     * Incrementing at admission closes the window: the stale result is refused
     * before it can cancel anything.
     */
    private val transferRequest = AtomicInteger(0)

    /** The transfer currently open, for a caller about to ask for a folder. */
    fun currentTransfer(): Int = transferRequest.get()

    /** The worker that currently owns the store, if any. Confined to [storage];
     *  cancelled from anywhere, joined only on [storage]. */
    private var running: Job? = null

    /**
     * Take over from whatever was running.
     *
     * Cancel is issued OUTSIDE the storage thread so it reaches a worker blocked
     * in a socket read (see [CloudClient]); the join then happens on the storage
     * thread, where it SUSPENDS and releases the thread so the cancelled worker
     * can actually finish. Returning only after that join is what guarantees the
     * store has exactly one owner.
     */
    private suspend fun takeOver(previous: Job?) {
        previous?.join()
    }

    /** Read what a link points at. Nothing is written and no folder is asked
     *  for until the user has seen this. */
    fun open(rawLink: String) {
        // FIRST, before anything is cancelled or queued: any folder result for
        // the previous transfer is now stale, whether or not the work below has
        // had a chance to run.
        transferRequest.incrementAndGet()
        val previous = running
        previous?.cancel()
        running = scope.launch(storage) {
            takeOver(previous)
            generation += 1
            val mine = generation
            pending = null
            val link = parseStoredLink(rawLink, origin)
            if (link == null) {
                _state.value = State.Failed(CloudFailure(CloudFailure.Kind.LINK_INVALID))
                return@launch
            }
            _state.value = State.Loading
            val meta = try {
                client.fetchMeta(link.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: CloudException) {
                if (mine == generation) _state.value = State.Failed(e.failure)
                return@launch
            }
            if (mine != generation) return@launch

            // RAW names: sanitising before validation would turn a name this
            // device must refuse into one it would happily create.
            val manifest = try {
                decryptManifestRaw(link.key, meta.encManifest)
            } catch (e: StoredWireException) {
                _state.value = State.Failed(
                    CloudFailure(
                        when (e.reason) {
                            StoredWireException.Reason.INVALID_MANIFEST -> CloudFailure.Kind.MALFORMED
                            else -> CloudFailure.Kind.DAMAGED
                        },
                    ),
                )
                return@launch
            }
            val plan = StoredDestinations.plan(manifest.asFileMetas())
            if (plan is StoredDestinations.Refuse) {
                _state.value = State.Failed(
                    CloudFailure(
                        when (plan.reason) {
                            StoredDestinations.Reason.UNSAFE_NAME -> CloudFailure.Kind.UNSAFE_NAME
                            StoredDestinations.Reason.COLLISION -> CloudFailure.Kind.NAME_COLLISION
                        },
                    ),
                )
                return@launch
            }
            pending = Pending(link, manifest)
            _state.value = State.Ready(
                names = manifest.displayNames(),
                totalBytes = manifest.files.sumOf { it.size },
                burnAfterRead = meta.burnAfterRead,
                expiresAt = meta.expiresAt,
            )
        }
    }

    /**
     * Save the opened transfer into [root].
     *
     * A null tree is the user backing out of the picker: it leaves the transfer
     * open rather than failing it, because nothing was attempted.
     */
    fun save(ops: ProviderOps, root: ProviderOps.Node, transfer: Int) {
        if (_state.value !is State.Ready) return
        if (transfer != transferRequest.get()) return
        val previous = running
        previous?.cancel()
        running = scope.launch(storage) {
            // The store is not ours until the previous worker has actually
            // stopped — not merely been asked to.
            takeOver(previous)
            // Rechecked HERE, on the storage thread, immediately before the
            // first write: the folder was chosen for ONE transfer, and by now
            // the user may have opened another.
            if (transfer != transferRequest.get()) return@launch
            val job = pending ?: return@launch
            generation += 1
            val mine = generation
            val metas = job.manifest.asFileMetas()
            val total = job.manifest.files.sumOf { it.size }

            val begun = store.begin(metas, ops, root)
            if (begun is ReceiveStore.Outcome.Failed) {
                _state.value = State.Failed(storeFailure(begun), !begun.cleanupComplete)
                return@launch
            }
            _state.value = State.Saving(0, total)

            val router = StoredStreamRouter(job.manifest.files.map { it.size })
            var received = 0L
            var failed: ReceiveStore.Outcome.Failed? = null
            val sink = object : StoredStreamRouter.Sink {
                override fun write(index: Int, bytes: ByteArray): Boolean {
                    val outcome = store.write(index, bytes)
                    if (outcome is ReceiveStore.Outcome.Failed) {
                        failed = outcome
                        return false
                    }
                    received += bytes.size
                    if (mine == generation) _state.value = State.Saving(received, total)
                    return true
                }

                override fun complete(index: Int): Boolean {
                    val outcome = store.export(index)
                    if (outcome is ReceiveStore.Outcome.Failed) {
                        failed = outcome
                        return false
                    }
                    return true
                }
            }

            try {
                client.downloadBlob(job.link, job.manifest) { chunk ->
                    // Raised rather than returned, because this callback runs
                    // inside the transport's read loop: throwing is what stops
                    // the rest of a doomed transfer being pulled over the
                    // network.
                    if (!router.accept(chunk, sink)) throw StoreStopped()
                }
                if (!router.finish(sink)) throw StoreStopped()
            } catch (e: CancellationException) {
                // A cancelled save removes what it created before it unwinds:
                // the coroutine is going away, the documents would not.
                rollback(CloudFailure(CloudFailure.Kind.CANCELLED))
                throw e
            } catch (_: StoreStopped) {
                rollback(failed?.let { storeFailure(it) } ?: CloudFailure(CloudFailure.Kind.SAVE_FAILED))
                return@launch
            } catch (e: CloudException) {
                rollback(e.failure)
                return@launch
            }

            store.finish()
            pending = null
            _state.value = State.Done(job.manifest.files.size)
        }
    }

    /**
     * The user chose a folder and it could not be opened — a revoked grant, or
     * a provider that no longer resolves the tree.
     *
     * An actionable failure, and deliberately NOT the same as backing out of
     * the picker: nothing was attempted in that case, and the transfer stays
     * open. Nothing has been written here either, so there is nothing to roll
     * back and the transfer stays openable against another folder.
     */
    fun destinationUnavailable(transfer: Int) {
        scope.launch(storage) {
            if (transfer != transferRequest.get()) return@launch
            if (_state.value is State.Ready) {
                _state.value = State.Failed(CloudFailure(CloudFailure.Kind.DESTINATION_UNAVAILABLE))
            }
        }
    }

    /** Abandon whatever is open, removing anything a part-done save created. */
    fun reset() {
        transferRequest.incrementAndGet()
        val previous = running
        previous?.cancel()
        running = scope.launch(storage) {
            takeOver(previous)
            generation += 1
            pending = null
            // A cancelled save has already rolled itself back and published the
            // truth about it. Only overwrite that with Idle when there is
            // nothing outstanding to report.
            val outstanding = _state.value.let {
                it is State.Failed && it.cleanupIncomplete
            }
            if (!outstanding) _state.value = State.Idle
        }
    }

    /**
     * Roll this batch back and report the failure with the truth about whatever
     * could not be removed.
     *
     * Runs on [storage], like every other store call. The discard OUTCOME is
     * kept rather than dropped: a rollback that could not delete a created
     * directory is a leftover the user has to be told about, and a cancellation
     * is no different from any other failure in that respect.
     */
    private fun rollback(failure: CloudFailure) {
        val cleanup = store.discard()
        val incomplete = cleanup is ReceiveStore.Outcome.Failed && !cleanup.cleanupComplete
        pending = null
        _state.value = State.Failed(failure, incomplete)
    }

    private fun storeFailure(outcome: ReceiveStore.Outcome.Failed): CloudFailure =
        CloudFailure(
            when (outcome.reason) {
                ReceiveStore.Outcome.Reason.NO_SPACE -> CloudFailure.Kind.NO_SPACE
                ReceiveStore.Outcome.Reason.UNSAFE_PATH -> CloudFailure.Kind.UNSAFE_NAME
                ReceiveStore.Outcome.Reason.NAME_TAKEN -> CloudFailure.Kind.NAME_TAKEN
                ReceiveStore.Outcome.Reason.WRITE_FAILED,
                ReceiveStore.Outcome.Reason.EXPORT_FAILED,
                -> CloudFailure.Kind.SAVE_FAILED
            },
        )

    /** Stops the transport's read loop when the destination has failed. Carries
     *  no message: the reason is already held as a store outcome. */
    private class StoreStopped : RuntimeException(null, null)
}
