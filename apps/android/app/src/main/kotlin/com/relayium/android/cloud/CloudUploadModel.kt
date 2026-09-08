package com.relayium.android.cloud

import com.relayium.android.account.AccountSession
import com.relayium.protocol.stored.ManifestFile
import com.relayium.protocol.stored.PlaintextSource
import com.relayium.protocol.stored.StoredManifest
import com.relayium.protocol.stored.StoredWireException
import com.relayium.protocol.stored.encodeStoreKey
import com.relayium.protocol.stored.generateStoreKey
import com.relayium.protocol.stored.validateManifestFiles
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** One thing the user chose to send, as the picker described it. */
data class CloudSelection(val uri: String, val name: String, val size: Long)

/**
 * How long the sender ASKS the object to live.
 *
 * The server decides the real answer: `clampTTL` and the account's plan
 * retention cap both shorten it silently, so the choice here is a request and
 * the expiry shown afterwards is the server's own `expiresAt` — never this
 * value echoed back. That is why a plan whose cap is shorter than the selection
 * still produces an honest result rather than a promise the product cannot keep.
 */
enum class CloudRetention(val seconds: Int) {
    HOUR(3_600),
    DAY(86_400),
    THREE_DAYS(259_200),
    WEEK(604_800),
    TWO_WEEKS(1_209_600),
}

/**
 * Uploading files as one encrypted stored object, and producing the link that
 * opens it.
 *
 * ## The fences, and the race each one catches
 *
 * An upload is a long round trip, and by the time it lands any of these may
 * have happened:
 *
 * 1. **The user cancelled or started another.** A generation counter catches it;
 *    a superseded answer writes nothing.
 * 2. **The account changed.** The [AccountSession.Authority] captured BEFORE the
 *    request is rechecked after it, so an object uploaded under one account —
 *    and metered against it — can never be presented under another. The link is
 *    not shown, because showing it would attach one account's file to whoever is
 *    signed in now.
 * 3. **The bytes changed.** The encoder itself refuses a source that grew or
 *    shrank against the manifest the server was told about.
 *
 * ## What never leaves this device
 *
 * The key is generated here and used here. It is not sent, not logged, not put
 * in a request URL, and not written to any saved UI bundle. It reaches the user
 * exactly once, inside the link they explicitly copy or share — which is the
 * product, and the only path it takes.
 *
 * **The link is not persisted.** This model lives as long as the ViewModel, so a
 * finished upload survives rotation and a tab change but not process death. The
 * key would be the thing to persist, and persisting it needs account-scoped
 * Keystore storage that is not part of this slice; inventing a weaker store — or
 * putting the key in a `rememberSaveable` bundle — would be the wrong trade for
 * a convenience. Until then the honest behaviour is what the UI states: copy the
 * link before leaving.
 */
class CloudUploadModel(
    private val scope: CoroutineScope,
    /** The dispatcher [AccountSession] confines its state to; the authority
     *  checks below read its owner-confined state directly. */
    private val owner: CoroutineDispatcher,
    /** Where blocking document opens happen; never [owner], which in this app
     *  is the MAIN dispatcher. */
    private val io: CoroutineDispatcher,
    private val client: CloudClient,
    private val session: AccountSession,
    /** This app's OWN resolved backend. The link is composed against it and
     *  never against anything a server said — a link assembled from a
     *  server-supplied string is a redirect waiting to happen. */
    private val origin: String,
    /** Opens a chosen document for reading, or null if it cannot be read. */
    private val open: (CloudSelection) -> PlaintextSource?,
) {

    sealed interface State {
        data object Idle : State

        /** Chosen and describable, not yet sent. */
        data class Selected(val files: List<CloudSelection>, val totalBytes: Long) : State

        data class Uploading(val sent: Long, val total: Long) : State

        /**
         * Done, with the address that opens it.
         *
         * [expiresAt] is the SERVER's answer, not the requested retention: the
         * account's plan may shorten it, and telling the user what they asked
         * for rather than what they got would be a promise the product does not
         * keep.
         */
        data class Ready(
            val link: String,
            val expiresAt: Long,
            val burnAfterRead: Boolean,
            val files: Int,
        ) : State {
            /** The link carries the KEY in its fragment. It is shown and shared
             *  by explicit user action; it does not belong in a log line or a
             *  test failure. */
            override fun toString(): String =
                "Ready(link=<redacted>, expiresAt=$expiresAt, burn=$burnAfterRead, files=$files)"
        }

        data class Failed(val failure: CloudFailure) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    private val _retention = MutableStateFlow(CloudRetention.DAY)
    val retention: StateFlow<CloudRetention> = _retention.asStateFlow()

    private val _burnAfterRead = MutableStateFlow(false)
    val burnAfterRead: StateFlow<Boolean> = _burnAfterRead.asStateFlow()

    /**
     * Volatile because the upload's progress callback reads it from the
     * transport's IO thread while [owner] writes it. Without that, a superseded
     * upload's progress could be published from a stale cached read.
     */
    @Volatile
    private var generation = 0
    private var running: Job? = null

    /** Latest progress, conflated. Publishing every frame through [owner] would
     *  queue one coroutine per 192 KiB; publishing straight from the IO thread
     *  would race a newer terminal state onto the flow. Conflating and posting
     *  through the owner does neither. */
    private val pendingProgress = AtomicReference<LongArray?>(null)
    private val posting = AtomicBoolean(false)

    /**
     * Which pick a picker result belongs to.
     *
     * Owned HERE rather than by the caller so the token and the state it gates
     * are behind one owner: the system picker is a round trip through another
     * process, followed by an asynchronous metadata query, and a slow first
     * pick can otherwise land after a second one and replace it.
     */
    private val selectionRequest = AtomicInteger(0)

    /** Claim the next pick. The caller hands this back with the result. */
    fun beginSelection(): Int = selectionRequest.incrementAndGet()

    private fun postProgress(mine: Int, sent: Long, total: Long) {
        pendingProgress.set(longArrayOf(sent, total))
        if (!posting.compareAndSet(false, true)) return
        scope.launch(owner) {
            posting.set(false)
            val latest = pendingProgress.getAndSet(null) ?: return@launch
            // Both fences: the right generation, and a state that is still an
            // upload in flight — so a late frame cannot overwrite a Ready or a
            // Failed that has already been decided.
            if (mine == generation && _state.value is State.Uploading) {
                _state.value = State.Uploading(latest[0], latest[1])
            }
        }
    }

    fun chooseRetention(value: CloudRetention) {
        _retention.value = value
    }

    fun chooseBurnAfterRead(value: Boolean) {
        _burnAfterRead.value = value
    }

    /**
     * Accept a selection from the system picker.
     *
     * The manifest is validated HERE, before anything is uploaded: a selection
     * the wire would refuse should cost the user a message, not a full transfer
     * that fails at the far end.
     */
    fun select(files: List<CloudSelection>, request: Int) {
        scope.launch(owner) {
            // Checked in the SAME owner turn that commits, which is the whole
            // point: a check on another thread followed by a hand-off to this
            // one leaves a window where a newer pick is issued in between and
            // the older result commits over it.
            if (request != selectionRequest.get()) return@launch
            generation += 1
            running?.cancel()
            if (files.isEmpty()) {
                _state.value = State.Idle
                return@launch
            }
            val manifest = StoredManifest(files.map { ManifestFile(it.name, it.size) })
            val total = try {
                validateManifestFiles(manifest.files)
            } catch (_: StoredWireException) {
                _state.value = State.Failed(CloudFailure(CloudFailure.Kind.MALFORMED))
                return@launch
            }
            _state.value = State.Selected(files, total)
        }
    }

    /**
     * The picker produced something this app cannot describe.
     *
     * Reported rather than swallowed: silently returning to Idle reads as a
     * picker that did nothing. An upload already in flight is left alone — a
     * late, failed pick must not cancel a newer one.
     */
    fun selectionUnreadable(request: Int) {
        scope.launch(owner) {
            if (request != selectionRequest.get()) return@launch
            if (_state.value is State.Uploading) return@launch
            generation += 1
            _state.value = State.Failed(CloudFailure(CloudFailure.Kind.UNREADABLE_SELECTION))
        }
    }

    /** Send the current selection. */
    fun upload() {
        val selected = _state.value as? State.Selected ?: return
        val burn = _burnAfterRead.value
        val ttl = _retention.value.seconds
        running = scope.launch(owner) {
            generation += 1
            val mine = generation
            val authority = session.authority()
            if (authority == null) {
                _state.value = State.Failed(CloudFailure(CloudFailure.Kind.NOT_SIGNED_IN))
                return@launch
            }

            // Opening a document is disk work behind a content provider, so it
            // happens off the owner — which in this app is the main thread.
            //
            // The list is declared and its `finally` established BEFORE the
            // `withContext`, which is the part that is easy to get wrong: if the
            // coroutine is cancelled while `open` is blocked, `withContext`
            // REFUSES to deliver its result to a cancelled caller, so a value
            // returned from inside it is dropped — descriptors and all. Owning
            // the list from out here means every exit, cancellation included,
            // passes through one close. `open` may also THROW rather than
            // return null: a document provider is entitled to raise
            // SecurityException, and that is a failed upload, not a crash.
            // ONE owner for the sources, for the whole of their life.
            //
            // Every exit below — an early return, a throw, a cancellation while
            // a provider is still opening, a cancellation while the upload is
            // in flight — leaves through this `finally`, and the sources are
            // close-once, so the cancellation watcher closing one first (which
            // it must, to unblock a reader stuck inside `read`) costs nothing.
            // No adoption flag, no nested bookkeeping: the list is opened here
            // and closed here.
            val sources = ArrayList<PlaintextSource>(selected.files.size)
            try {
                val opened = try {
                    withContext(io) {
                        for (file in selected.files) {
                            // Each source joins the OUTER list as soon as it
                            // exists, so a cancellation between two opens still
                            // closes the ones already made.
                            // Wrapped at the moment it exists, so close-once is
                            // the SOURCE's own property. Three owners close
                            // these — the cancellation watcher, the upload's
                            // `finally`, and `ChunkEncryptor.close` — and a
                            // guard held by only one of them is not a guard.
                            sources.add(CloseOnce(open(file) ?: error("unreadable")))
                        }
                        true
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Throwable) {
                    false
                }
                if (!opened) {
                    _state.value = State.Failed(CloudFailure(CloudFailure.Kind.SAVE_FAILED))
                    return@launch
                }
                if (mine != generation) return@launch
                // The account may have changed WHILE the provider was opening
                // documents. Uploading now would meter one account's bytes
                // against a session that is no longer there.
                if (!session.isCurrent(authority)) {
                    _state.value = State.Failed(CloudFailure(CloudFailure.Kind.STALE_ACCOUNT))
                    return@launch
                }

                val key = generateStoreKey()
                val plan = StoredUploadPlan(
                    key = key,
                    manifest = StoredManifest(selected.files.map { ManifestFile(it.name, it.size) }),
                    sources = sources,
                    burnAfterRead = burn,
                    ttlSeconds = ttl,
                )
                _state.value = State.Uploading(0, selected.totalBytes)

                val result = try {
                    // Cancellation has to reach the SOURCES, not only the
                    // socket. `PlaintextSource.read` can block — a remote
                    // document provider is another process — and the writer
                    // sits inside it, so the `finally` below would not run
                    // until that read returned. A watcher that closes the
                    // sources from another thread is what unblocks it; closing
                    // is idempotent, so the normal path closing them again
                    // costs nothing.
                    coroutineScope {
                        val watcher = launch(io, start = CoroutineStart.UNDISPATCHED) {
                            try {
                                awaitCancellation()
                            } finally {
                                for (source in sources) runCatching { source.close() }
                            }
                        }
                        try {
                            client.upload(plan, authority.token) { sent, total ->
                                // Arrives on the transport's IO thread;
                                // published through the owner so it cannot race
                                // a terminal state.
                                postProgress(mine, sent, total)
                            }
                        } finally {
                            watcher.cancel()
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: CloudException) {
                    if (mine == generation) _state.value = State.Failed(e.failure)
                    return@launch
                }

                if (mine != generation) return@launch
                // Rechecked HERE, after the round trip and immediately before
                // the only thing that has an effect. An object uploaded under
                // one account is never presented under another.
                if (!session.isCurrent(authority)) {
                    _state.value = State.Failed(CloudFailure(CloudFailure.Kind.STALE_ACCOUNT))
                    return@launch
                }
                readyFor = authority
                _state.value = State.Ready(
                    link = buildDownloadLink(origin, result.id, encodeStoreKey(key)),
                    expiresAt = result.expiresAt,
                    burnAfterRead = burn,
                    files = selected.files.size,
                )
            } finally {
                closeSources(sources)
            }
        }
    }

    /**
     * Close every source, off the owner, whether or not the coroutine was
     * cancelled.
     *
     * `NonCancellable` because this runs while unwinding a cancelled upload and
     * would otherwise be skipped, and [io] because the owner here is the MAIN
     * dispatcher — closing a document-provider stream is not main-thread work.
     * Closing is idempotent per source, so the cancellation watcher having
     * already closed one is the normal case rather than a race.
     */
    private suspend fun closeSources(sources: List<PlaintextSource>) {
        withContext(NonCancellable + io) {
            for (source in sources) runCatching { source.close() }
        }
    }

    /**
     * Which account a shown link belongs to.
     *
     * A finished upload keeps its link on screen, and the link is a capability:
     * whoever reads it can open that account's files. Signing out and signing
     * in as somebody else must therefore take it away — the in-flight fence
     * cannot do that, because by then the upload has already succeeded.
     */
    private var readyFor: AccountSession.Authority? = null

    /**
     * Drop a shown link if it does not belong to the current session.
     *
     * Called on every account state change, on [owner], where the authority is
     * readable.
     */
    fun accountChanged() {
        scope.launch(owner) {
            val owning = readyFor ?: return@launch
            if (session.isCurrent(owning)) return@launch
            readyFor = null
            generation += 1
            if (_state.value is State.Ready) _state.value = State.Idle
        }
    }

    /** Stop an upload in flight, or clear a finished one. */
    fun reset() {
        scope.launch(owner) {
            generation += 1
            running?.cancel()
            running = null
            readyFor = null
            _state.value = State.Idle
        }
    }
}

/**
 * A source that closes exactly once, however many owners try.
 *
 * Three of them legitimately do: the cancellation watcher, which MUST close a
 * source to unblock a reader stuck inside it; the upload's own `finally`; and
 * [com.relayium.protocol.stored.ChunkEncryptor.close], which closes every source
 * it was handed. A guard held by only one of those is not a guard, and a guard
 * held by the model would have to remember every source it ever opened. Putting
 * it on the source itself makes the property local, per batch, and collectable
 * with the upload it belongs to.
 *
 * A second `close()` on a content stream is usually harmless — but "usually" is
 * not something to build a cancellation path on.
 */
private class CloseOnce(private val delegate: PlaintextSource) : PlaintextSource {
    private val closed = java.util.concurrent.atomic.AtomicBoolean(false)
    override val name: String get() = delegate.name
    override val size: Long get() = delegate.size
    override fun read(max: Int): ByteArray = delegate.read(max)
    override fun close() {
        if (closed.compareAndSet(false, true)) delegate.close()
    }
}
