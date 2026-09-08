package com.relayium.android.cloud

import com.relayium.android.account.AccountSession
import com.relayium.protocol.stored.ChunkEncryptor
import com.relayium.protocol.stored.ManifestFile
import com.relayium.protocol.stored.PlaintextSource
import com.relayium.protocol.stored.StoredManifest
import com.relayium.protocol.stored.StoredWireException
import com.relayium.protocol.stored.cipherSize
import com.relayium.protocol.stored.encodeStoreKey
import com.relayium.protocol.stored.encryptManifest
import com.relayium.protocol.stored.generateStoreKey
import com.relayium.protocol.stored.uploadHeader
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
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

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
 * A finished upload's key is filed under the account in [StoredLinkKeyStore], so
 * the file list can rebuild the link later — Keystore-wrapped, in no-backup
 * storage, never in a saved `Bundle`.
 *
 * ## Two upload paths, chosen by size
 *
 * Below [RESUMABLE_MIN_BYTES] the accepted single-shot stream is used: one
 * request, nothing staged, and an interruption costs the user one re-pick. That
 * is stated in the UI rather than implied.
 *
 * At or above it the bytes are spooled — encrypted ONCE — into this app's own
 * no-backup storage, and the upload becomes a durable job that survives process
 * death. Re-encrypting the user's current files on resume is the thing that is
 * never done: the same key and the same frame sequence over different plaintext
 * destroys the integrity of every frame the server already holds.
 *
 * Uploading runs only while the app does. There is no foreground service and no
 * background delivery claim; what is promised is that an interrupted upload can
 * be continued, and the copy says exactly that.
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
    /** Where a large upload is spooled so it can survive process death. Null
     *  keeps the single-shot behaviour for every size, which is what a test
     *  that is not about recovery wants. */
    private val pending: PendingUploadStore? = null,
    /** Where a finished upload's key is filed, so its link can be rebuilt in
     *  the file list later. */
    private val linkKeys: StoredLinkKeyStore? = null,
    private val now: () -> Long = { System.currentTimeMillis() / 1000L },
    /**
     * The plaintext total at or above which an upload is staged and made
     * resumable. [RESUMABLE_MIN_BYTES] in the app.
     *
     * Exposed rather than read from the companion at each use, so the surface
     * states the SAME threshold this instance acts on: a screen promising
     * recovery at one size while the model staged at another is a lie the user
     * only discovers after an interruption.
     */
    val resumableMinBytes: Long = RESUMABLE_MIN_BYTES,
) {

    init {
        // A durable job's cleanup is licensed by the key being FILED. Without a
        // key store there is nothing to file it in, so the commit marker would
        // be a fiction and the purge that follows it would delete the only copy
        // of the key to a published object.
        require(pending == null || linkKeys != null) {
            "a resumable upload store needs a stored-link key store"
        }
    }

    sealed interface State {
        data object Idle : State

        /** Chosen and describable, not yet sent. */
        data class Selected(val files: List<CloudSelection>, val totalBytes: Long) : State

        /** Encrypting the selection onto this device, once. */
        data class Staging(val staged: Long, val total: Long) : State

        /** Proving the staged ciphertext is still byte-for-byte what this job
         *  recorded, before a single byte of it is replayed. */
        data object Verifying : State

        data class Uploading(val sent: Long, val total: Long) : State

        /**
         * A staged job this account can finish, offered and never taken
         * automatically.
         *
         * [resumable] is false when the staged bytes are gone or no longer match
         * the job. Such a job is still SHOWN — hiding it would leave data on the
         * device that nothing could name or remove — but the only action it
         * offers is a discard.
         */
        data class Interrupted(
            val files: Int,
            val bytes: Long,
            val resumable: Boolean,
            val failure: CloudFailure?,
        ) : State

        /**
         * Finalize was requested and its outcome is unknown.
         *
         * The one state that must never resolve itself. The object may exist and
         * be billed; opening a fresh session would publish the same files a
         * second time. The user is offered a retry of the SAME session and a
         * local discard, and pointed at the file list.
         */
        data class Uncertain(val files: Int, val bytes: Long) : State

        /**
         * The object EXISTS and only this device's tidy-up is outstanding.
         *
         * Told apart from [Uncertain] because they are different facts offering
         * different actions. Here nothing is unknown: the server named the
         * object, the plan recorded it, and what remains is filing its key and
         * showing its link — no request, no republication. A discard is NOT
         * offered, because the job directory holds the only copy of the key to
         * something the account is already paying for.
         */
        data class Completing(val files: Int, val bytes: Long) : State

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

    /** Something true that is not a failure: the upload worked and the tidy-up
     *  did not, or the link could not be filed for later. */
    enum class Notice { CLEANUP_FAILED, LINK_KEY_NOT_SAVED }

    private val _notice = MutableStateFlow<Notice?>(null)
    val notice: StateFlow<Notice?> = _notice.asStateFlow()

    /**
     * This device is holding interrupted-upload data it can no longer read.
     *
     * Deliberately not account-scoped: an unreadable record has no readable
     * account. It is surfaced as a device-data fact with an explicit removal,
     * never folded into a sign-out or into discarding one account's job.
     */
    private val _strandedDeviceData = MutableStateFlow(false)
    val strandedDeviceData: StateFlow<Boolean> = _strandedDeviceData.asStateFlow()

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

    private fun postProgress(mine: Int, sent: Long, total: Long, staging: Boolean = false) {
        pendingProgress.set(longArrayOf(sent, total))
        if (!posting.compareAndSet(false, true)) return
        scope.launch(owner) {
            posting.set(false)
            val latest = pendingProgress.getAndSet(null) ?: return@launch
            // Both fences: the right generation, and a state that is still the
            // phase this frame belongs to — so a late frame cannot overwrite a
            // Ready, a Failed or the next phase that has already been decided.
            if (mine != generation) return@launch
            val current = _state.value
            when {
                staging && current is State.Staging -> _state.value = State.Staging(latest[0], latest[1])
                !staging && current is State.Uploading ->
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
            // Recorded before any await, so an account leaving during staging —
            // when there is no job yet — still stops the work.
            activeAuthority = authority

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
                val store = pending
                if (store != null && selected.totalBytes >= resumableMinBytes) {
                    // Large enough to be worth surviving: spool it once, then
                    // drive it as a durable job. The sources are closed as soon
                    // as staging is done — the upload itself reads only the
                    // spool, which is what lets it continue in a process that
                    // never saw the user's files.
                    stageAndRun(store, selected, key, burn, ttl, authority, mine, sources)
                    return@launch
                }
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
                // Rechecked HERE, after the round trip. An object uploaded under
                // one account is never presented under another.
                if (!session.isCurrent(authority)) {
                    staleAccount(mine)
                    return@launch
                }
                // Filed BEFORE the link is presented, so the file list can
                // rebuild it later. A failure is a notice, not a failed upload:
                // the object exists and the user is holding its link.
                val filed = fileLinkKey(authority, result.id, key, result.expiresAt)
                // And rechecked AGAIN, because filing the key is durable work
                // off the owner and a sign-out lands inside it routinely. The
                // key stays written under the account that paid for the object —
                // it is that account's, and nothing here deletes it — but the
                // link belongs to a session that is no longer here and is not
                // shown. An admission taken before an await is not an admission.
                if (!owns(mine, authority)) {
                    staleAccount(mine)
                    return@launch
                }
                readyFor = authority
                _notice.value = if (filed) null else Notice.LINK_KEY_NOT_SAVED
                _state.value = State.Ready(
                    link = buildDownloadLink(origin, result.id, encodeStoreKey(key)),
                    expiresAt = result.expiresAt,
                    burnAfterRead = burn,
                    files = selected.files.size,
                )
            } finally {
                closeSources(sources)
                if (mine == generation) activeAuthority = null
            }
        }
    }

    // ── the durable path ────────────────────────────────────────────────────

    /**
     * Spool the selection once, commit the job, and drive it.
     *
     * The order is the correctness. The ciphertext and the content key become
     * this app's own BEFORE any server session exists; reversed, a crash in
     * between would leave a session nothing on this device could feed.
     */
    private suspend fun stageAndRun(
        store: PendingUploadStore,
        selected: State.Selected,
        key: ByteArray,
        burn: Boolean,
        ttl: Int,
        authority: AccountSession.Authority,
        mine: Int,
        sources: List<PlaintextSource>,
    ) {
        val files = selected.files.map { PendingUploadFile(it.name, it.size) }
        val manifest = StoredManifest(selected.files.map { ManifestFile(it.name, it.size) })
        val payloadTotal = try {
            cipherSize(manifest.files.map { it.size })
        } catch (_: StoredWireException) {
            _state.value = State.Failed(CloudFailure(CloudFailure.Kind.MALFORMED))
            return
        }
        // Admission BEFORE a byte is copied. A staging pass that fills the disk
        // and then fails has already cost the user the copy.
        if (store.usableSpace() < payloadTotal + STAGING_HEADROOM_BYTES) {
            _state.value = State.Failed(CloudFailure(CloudFailure.Kind.NO_SPACE))
            return
        }
        _state.value = State.Staging(0, payloadTotal)

        val plan = try {
            withContext(io) {
                val staging = store.begin()
                try {
                    // Cancellation has to reach a blocked provider read, exactly
                    // as it does on the single-shot path: the watcher closes the
                    // sources from another thread, and closing is idempotent.
                    coroutineScope {
                        val watcher = launch(io, start = CoroutineStart.UNDISPATCHED) {
                            try {
                                awaitCancellation()
                            } finally {
                                for (source in sources) runCatching { source.close() }
                            }
                        }
                        try {
                            staging.writeHeader(uploadHeader(encryptManifest(key, manifest)))
                            val encryptor = ChunkEncryptor(key, sources)
                            while (true) {
                                ensureActive()
                                val frame = encryptor.next() ?: break
                                staging.appendPayload(frame)
                                postProgress(mine, staging.staged, payloadTotal, staging = true)
                            }
                            encryptor.finish()
                        } finally {
                            watcher.cancel()
                        }
                    }
                    // The spool must be exactly what the manifest committed to,
                    // or every later offset is against a different stream.
                    if (staging.staged != payloadTotal) {
                        throw PendingUploadException(
                            PendingUploadException.Reason.UNUSABLE_SELECTION,
                            "the staged ciphertext is not the size the manifest promised",
                        )
                    }
                    staging.commit(authority.accountId, files, burn, ttl, now(), key)
                } catch (e: Throwable) {
                    // Including cancellation: a half-staged job is bytes with
                    // nothing to describe them, and leaving it for a sweep would
                    // occupy the user's disk until the next launch.
                    staging.abandon()
                    throw e
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: PendingUploadException) {
            if (mine == generation) _state.value = State.Failed(e.asFailure())
            return
        } catch (e: StoredWireException) {
            if (mine == generation) _state.value = State.Failed(stagingWireFailure(e))
            return
        } catch (_: Throwable) {
            // A document provider may raise anything at all while it is being
            // read. That is the FILE failing, not the network.
            if (mine == generation) _state.value = State.Failed(CloudFailure(CloudFailure.Kind.SOURCE_FAILED))
            return
        }

        // The spool is the only thing the upload reads from here on.
        closeSources(sources)
        if (mine != generation) return
        if (!session.isCurrent(authority)) {
            _state.value = State.Failed(CloudFailure(CloudFailure.Kind.STALE_ACCOUNT))
            return
        }
        job = plan
        run(store, plan, key, authority, mine)
    }

    /**
     * One attempt at a staged job, from wherever the server actually got to.
     *
     * Every exit is a state the user can act on, and none of them re-publishes:
     * the only path that opens a NEW session is one whose durable state proves
     * finalize was never requested.
     */
    private suspend fun run(
        store: PendingUploadStore,
        staged: PendingUploadPlan,
        key: ByteArray,
        authority: AccountSession.Authority,
        mine: Int,
    ) {
        var plan = staged
        try {
            // The object already exists and only its key still has to be filed.
            plan.finalizedStoredId?.let { id ->
                publish(store, plan, key, id, plan.finalizedExpiresAt, authority, mine)
                return
            }

            _state.value = State.Verifying
            withContext(io) { store.verifySpool(plan) }
            // Rechecked after every hop off the owner, and before anything that
            // presents this bearer. Cancellation is not the only way a job stops
            // being current: an account switch leaves the coroutine alive.
            if (!owns(mine, authority)) return

            // Finalize was already requested for this session, so the bytes are
            // all there. Retry FINALIZE — never the upload, and never a new
            // session.
            if (plan.finalizeAttempted) {
                finish(store, plan, key, authority, mine)
                return
            }

            val header = withContext(io) { store.header(plan) }
            if (!owns(mine, authority)) return
            var committed = 0L
            var session = plan.uploadId?.let { id ->
                try {
                    val offset = client.uploadOffset(id, authority.token)
                    // Refused rather than clamped: an offset outside the stream
                    // means this is not the session this job describes, and
                    // continuing would splice bytes into somebody's blob.
                    if (offset < 0 || offset > plan.payloadTotal) {
                        throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
                    }
                    committed = offset
                    ResumableSession(id, plan.uploadChunkSize ?: PendingUploadStore.DEFAULT_CHUNK_SIZE)
                } catch (e: CloudException) {
                    if (e.failure.kind != CloudFailure.Kind.UPLOAD_SESSION_GONE) throw e
                    // Reaped while idle. Safe to replace ONLY because the plan
                    // proves no finalize was ever requested — checked above, and
                    // re-read here rather than assumed.
                    committed = 0L
                    null
                }
            }

            // Rechecked between the status probe and any decision it licenses:
            // opening a replacement session is the most consequential thing on
            // this path and must not run under a bearer that has moved.
            if (!owns(mine, authority)) return
            if (session == null) {
                session = client.initUpload(
                    header = header,
                    burnAfterRead = plan.burnAfterRead,
                    ttlSeconds = plan.ttlSeconds,
                    payloadTotal = plan.payloadTotal,
                    token = authority.token,
                )
                committed = 0L
            }

            if (mine != generation) return
            if (!this.session.isCurrent(authority)) {
                staleAccount(mine)
                return
            }
            // Recorded BEFORE a byte moves, including for a session that just
            // replaced a reaped one.
            plan = withContext(io) { store.setSession(plan, session.uploadId, session.chunkSize) }
            // The record is about the SESSION and stands either way; what is
            // fenced is the screen and this model's idea of the current job.
            if (!owns(mine, authority)) return
            job = plan

            _state.value = State.Uploading(committed, plan.payloadTotal)
            val acked = pump(store, plan, session, committed, authority, mine)
            if (mine != generation) return

            // The client's own completeness gate. The server finalizes whatever
            // the blob holds and checks nothing, so this is the only thing
            // standing between a truncated upload and a published object nobody
            // can open.
            if (acked != plan.payloadTotal) {
                _state.value = State.Failed(CloudFailure(CloudFailure.Kind.DAMAGED))
                return
            }
            if (!this.session.isCurrent(authority)) {
                staleAccount(mine)
                return
            }
            finish(store, plan, key, authority, mine)
        } catch (e: CancellationException) {
            throw e
        } catch (e: PendingUploadException) {
            interrupted(store, plan, e.asFailure(), authority, mine)
        } catch (e: CloudException) {
            interrupted(store, plan, e.failure, authority, mine)
        }
    }

    /** Feed the spool from [from] to the end, replaying exactly what is there. */
    private suspend fun pump(
        store: PendingUploadStore,
        plan: PendingUploadPlan,
        session: ResumableSession,
        from: Long,
        authority: AccountSession.Authority,
        mine: Int,
    ): Long {
        var offset = from
        var high = from
        var stalled = 0
        val size = minOf(session.chunkSize.toLong(), plan.payloadTotal).toInt().coerceAtLeast(1)
        val buffer = ByteArray(size)
        // The holder and its `finally` are established BEFORE the open, for the
        // reason the accepted source path establishes its own: `withContext`
        // refuses to deliver a result to a cancelled caller, so a descriptor
        // returned from inside it is dropped with nothing owning it.
        val holder = AtomicReference<PendingUploadStore.PayloadReader?>(null)
        try {
            withContext(io) { holder.set(store.openPayload(plan)) }
            val reader = holder.get()
                ?: throw CloudException(CloudFailure(CloudFailure.Kind.SPOOL_UNUSABLE))
            while (offset < plan.payloadTotal) {
                currentCoroutineContext().ensureActive()
                // The ACCOUNT as well as the generation, per chunk. A sign-out
                // does not cancel this coroutine, and the next PATCH would
                // present a bearer that is no longer current.
                if (!owns(mine, authority)) return high
                val length = minOf(size.toLong(), plan.payloadTotal - offset).toInt()
                val at = offset
                withContext(io) { reader.read(at, buffer, length) }
                // Again, after the read. The check above the read is not the
                // same check: the read is a hop off the owner, and the very next
                // statement presents this account's bearer to the server. An
                // admission taken before an await does not authorise what
                // happens after it.
                if (!owns(mine, authority)) return high
                val outcome = client.patchChunk(
                    uploadId = session.uploadId,
                    body = buffer,
                    length = length,
                    from = at,
                    payloadTotal = plan.payloadTotal,
                    token = authority.token,
                ) { sent -> postProgress(mine, at + sent, plan.payloadTotal) }
                val received = outcome.received
                // The authoritative offset, bounded before it is acted on. The
                // server commits at most one capped append per request and may
                // answer with an offset below or above the range that was sent;
                // both are realignments, and the immutable spool means either
                // can simply be replayed.
                if (received < 0 || received > plan.payloadTotal) {
                    throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
                }
                if (received > high) {
                    high = received
                    stalled = 0
                } else if (++stalled >= MAX_STALLED_APPENDS) {
                    // A slow uplink is not this: a legitimately slow request is
                    // cut server-side after committing what arrived, which moves
                    // the offset. Repeated answers that move nothing are a loop,
                    // and spinning in one forever is worse than saying so.
                    throw CloudException(CloudFailure(CloudFailure.Kind.NO_PROGRESS))
                }
                offset = received
                postProgress(mine, offset, plan.payloadTotal)
            }
        } finally {
            withContext(NonCancellable + io) { holder.getAndSet(null)?.close() }
        }
        return high
    }

    /**
     * Ask the server to publish, having first written down that we did.
     *
     * The marker is what makes a lost answer safe. After it, a retry may finalize
     * the SAME session — the server's claim is terminal, so a second object
     * cannot appear — but nothing may open a new one, because 409 and 404 carry
     * no object id and prove neither publication nor its absence.
     */
    private suspend fun finish(
        store: PendingUploadStore,
        staged: PendingUploadPlan,
        key: ByteArray,
        authority: AccountSession.Authority,
        mine: Int,
    ) {
        val uploadId = staged.uploadId ?: run {
            _state.value = State.Failed(CloudFailure(CloudFailure.Kind.MALFORMED))
            return
        }
        // The marker is uncancellable, and it lands whether or not this job is
        // still the current one — it describes the SESSION, not the screen.
        val plan = withContext(NonCancellable + io) { store.markFinalizeAttempted(staged) }
        if (!owns(mine, authority)) {
            // The marker stands, so the job is left exactly where recovery can
            // retry its finalize under the right account. Nothing is requested
            // with a bearer that is no longer current.
            staleAccount(mine)
            return
        }
        job = plan
        val result = try {
            client.finalizeUpload(uploadId, authority.token)
        } catch (e: CloudException) {
            val unknown = e.failure.kind == CloudFailure.Kind.ALREADY_FINALIZED ||
                e.failure.kind == CloudFailure.Kind.UPLOAD_SESSION_GONE
            if (mine != generation) return
            if (unknown) uncertain(plan, mine) else interrupted(store, plan, e.failure, authority, mine)
            return
        }
        publish(store, plan, key, result.id, result.expiresAt, authority, mine)
    }

    /**
     * The object exists. Record it, file its key, show the link, then tidy up.
     *
     * Written down BEFORE anything is deleted, so a crash or a failure in the
     * tidy-up leaves a job recovery will finish rather than one it would upload
     * again.
     */
    private suspend fun publish(
        store: PendingUploadStore,
        staged: PendingUploadPlan,
        key: ByteArray,
        storedId: String,
        expiresAt: Long,
        authority: AccountSession.Authority,
        mine: Int,
    ) {
        // Everything durable below happens whether or not this job still owns
        // the screen. It is about an object the server already holds: a
        // superseded coroutine must still record it, file its key and release
        // its bytes, or the account pays for ciphertext nothing can name.
        //
        // None of it may THROW past here either. A finalized object exists; a
        // plan write that fails after it must not unwind into "interrupted",
        // which would offer to upload the same bytes again.
        var plan = staged
        var recorded = true
        if (plan.finalizedStoredId == null) {
            val marked = withContext(NonCancellable + io) {
                runCatching { store.markFinalized(plan, storedId, expiresAt) }.getOrNull()
            }
            if (marked == null) recorded = false else plan = marked
        }
        val filed = fileLinkKey(authority, storedId, key, expiresAt)
        // Cleanup is licensed by BOTH: the key filed somewhere else, and this
        // job's own record of the object durable. Without the record, a crash
        // between here and the purge leaves nothing that knows the object
        // exists.
        var committed = false
        if (filed && recorded) {
            val marked = withContext(NonCancellable + io) {
                runCatching { store.markLinkKeyCommitted(plan) }.getOrNull()
            }
            if (marked != null) {
                plan = marked
                committed = true
            }
        }
        // Presentation is fenced on the EXACT generation and the live account,
        // re-evaluated after each await rather than decided once: a completion
        // that lands after the user picked something else must not replace their
        // selection, and an id check alone cannot say that — the job field may
        // already name a newer plan.
        if (owns(mine, authority)) {
            job = plan
            readyFor = authority
            _notice.value = when {
                !filed -> Notice.LINK_KEY_NOT_SAVED
                !recorded -> Notice.CLEANUP_FAILED
                else -> null
            }
            _state.value = State.Ready(
                link = buildDownloadLink(origin, storedId, encodeStoreKey(key)),
                expiresAt = expiresAt,
                burnAfterRead = plan.burnAfterRead,
                files = plan.files.size,
            )
        }
        if (!committed) return
        val removed = withContext(NonCancellable + io) { store.purge(plan) }
        // Re-evaluated AFTER the purge, not reused from before it. A newer job
        // may have been adopted while this ran, and clearing it — or restoring
        // this one's notice over it — would be this completion reaching past
        // its own lifetime.
        if (!owns(mine, authority)) return
        if (job?.jobId != plan.jobId) return
        job = null
        if (!removed) _notice.value = Notice.CLEANUP_FAILED
    }

    /** Whether this coroutine still owns the screen: the exact generation it
     *  claimed, and the account it captured still being the live one. */
    private fun owns(mine: Int, authority: AccountSession.Authority): Boolean =
        mine == generation && session.isCurrent(authority)

    private fun staleAccount(mine: Int) {
        if (mine == generation) _state.value = State.Failed(CloudFailure(CloudFailure.Kind.STALE_ACCOUNT))
    }

    /**
     * File a finished object's key under the account. False when it could not be
     * kept, which costs the file list a link and costs the upload nothing.
     *
     * The absent-store branch is reachable only for a single-shot upload: the
     * constructor refuses a durable store with no key store, so a commit marker
     * can never be written against a key that was never filed.
     */
    private suspend fun fileLinkKey(
        authority: AccountSession.Authority,
        storedId: String,
        key: ByteArray,
        expiresAt: Long,
    ): Boolean {
        val keys = linkKeys ?: return true
        return withContext(NonCancellable + io) {
            runCatching {
                keys.save(authority.accountId, storedId, encodeStoreKey(key), expiresAt, now())
            }.isSuccess
        }
    }

    private fun uncertain(plan: PendingUploadPlan, mine: Int) {
        if (mine != generation) return
        job = plan
        _state.value = State.Uncertain(plan.files.size, plan.totalBytes)
    }

    /** A staged job that did not finish, kept and offered rather than lost. */
    private suspend fun interrupted(
        store: PendingUploadStore,
        plan: PendingUploadPlan,
        failure: CloudFailure,
        authority: AccountSession.Authority,
        mine: Int,
    ) {
        if (!owns(mine, authority)) return
        val resumable = failure.kind != CloudFailure.Kind.SPOOL_UNUSABLE &&
            withContext(io) { store.spoolLength(plan) } == plan.payloadTotal
        // Rechecked after the length read, which happens off the owner — and on
        // the ACCOUNT too, because the observer that notices a sign-out may not
        // have run yet when this returns.
        if (!owns(mine, authority)) return
        job = plan
        _state.value = State.Interrupted(plan.files.size, plan.totalBytes, resumable, failure)
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
     * The staged job this model is currently driving or offering.
     *
     * Owner-confined, like every other field here. It is the thing Resume and
     * Discard act on, and it is dropped the moment the account it belongs to
     * stops being the current one.
     */
    private var job: PendingUploadPlan? = null

    /**
     * The account whose work is in flight right now.
     *
     * [job] alone cannot answer that: between choosing files and committing a
     * plan there is a whole staging pass with no job yet, and an account leaving
     * during it must still stop the work. Owner-confined, set when work starts
     * and cleared when it ends.
     */
    private var activeAuthority: AccountSession.Authority? = null

    /** The recovery pass, so an account change can cancel it. It reads the key
     *  store off the owner, which is long enough for a sign-out to land. */
    private var recovering: Job? = null

    /** One discard at a time: it cancels and JOINS the writer, which is long
     *  enough for a second tap to arrive. */
    private var discarding = false

    /**
     * How far a discard got, because the three outcomes need different answers.
     *
     * [NO_TOMBSTONE] deleted NOTHING and leaves a job that must be offered
     * again; [TOMBSTONED] recorded the decision but could not remove the bytes,
     * so the job is finished with and only a leftover copy remains.
     */
    private enum class Discard { REMOVED, TOMBSTONED, NO_TOMBSTONE }

    // ── recovery: offered, never taken on its own ───────────────────────────

    /**
     * Look for a job this account can finish.
     *
     * Contacts nothing. Recovery is an offer made from this device's own disk,
     * not a transfer started on the user's behalf — and it is an account-entry
     * action, so it never replaces a selection, a failure the user is reading,
     * or a link they have not copied yet.
     */
    fun recoverPendingJob() {
        val store = pending ?: return
        recovering = scope.launch(owner) {
            if (_state.value !is State.Idle) return@launch
            val authority = session.authority() ?: return@launch
            generation += 1
            val mine = generation
            activeAuthority = authority
            try {
                val swept = withContext(io) { store.sweep() }
                if (!owns(mine, authority)) return@launch
                _strandedDeviceData.value = swept.unreadable > 0
                val plan = withContext(io) { store.pending(authority.accountId) }
                if (!owns(mine, authority)) return@launch
                if (plan == null) {
                    job = null
                    return@launch
                }
                // A job whose key this device cannot read can never be finished.
                // Saying so — and offering a discard — is the honest answer;
                // silently deleting it would destroy the user's staged bytes on
                // the strength of one bad key-store answer.
                val readable = try {
                    withContext(io) { store.key(plan) } != null
                } catch (e: PendingUploadException) {
                    if (owns(mine, authority)) {
                        job = plan
                        _state.value = State.Interrupted(
                            plan.files.size,
                            plan.totalBytes,
                            resumable = false,
                            failure = e.asFailure(),
                        )
                    }
                    return@launch
                }
                if (!owns(mine, authority)) return@launch
                job = plan
                if (!readable) {
                    _state.value = State.Interrupted(
                        plan.files.size,
                        plan.totalBytes,
                        resumable = false,
                        failure = CloudFailure(CloudFailure.Kind.PROTECTION_UNAVAILABLE),
                    )
                    return@launch
                }
                // Three outstanding-work states, kept apart because they are
                // three different facts about the server.
                if (plan.finalizedStoredId != null) {
                    _state.value = State.Completing(plan.files.size, plan.totalBytes)
                    return@launch
                }
                if (plan.finalizeAttempted) {
                    _state.value = State.Uncertain(plan.files.size, plan.totalBytes)
                    return@launch
                }
                val resumable = withContext(io) { store.spoolLength(plan) } == plan.payloadTotal
                if (!owns(mine, authority)) return@launch
                _state.value = State.Interrupted(plan.files.size, plan.totalBytes, resumable, null)
            } finally {
                if (mine == generation) activeAuthority = null
            }
        }
    }

    /** Continue the offered job. Only ever from an explicit choice. */
    fun resumePending() {
        val store = pending ?: return
        running = scope.launch(owner) {
            val current = _state.value
            val offered = current is State.Interrupted || current is State.Uncertain ||
                current is State.Completing
            if (!offered) return@launch
            val plan = job ?: return@launch
            generation += 1
            val mine = generation
            _notice.value = null
            val authority = session.authority()
            if (authority == null) {
                _state.value = State.Failed(CloudFailure(CloudFailure.Kind.NOT_SIGNED_IN))
                return@launch
            }
            if (plan.accountId != authority.accountId) {
                _state.value = State.Failed(CloudFailure(CloudFailure.Kind.STALE_ACCOUNT))
                return@launch
            }
            activeAuthority = authority
            try {
                val key = try {
                    withContext(io) { store.key(plan) }
                } catch (e: PendingUploadException) {
                    if (owns(mine, authority)) {
                        _state.value = State.Interrupted(
                            plan.files.size,
                            plan.totalBytes,
                            resumable = false,
                            failure = e.asFailure(),
                        )
                    }
                    return@launch
                }
                if (!owns(mine, authority)) return@launch
                if (key == null) {
                    // The bytes are here and the key is not, so nothing can ever
                    // open this upload. A job that reached a finalized object is
                    // exempt: its ciphertext is on the server and removing the
                    // record would erase the only proof it exists.
                    if (plan.finalizedStoredId == null) {
                        withContext(NonCancellable + io) {
                            runCatching { store.markRetired(plan) }.getOrNull()
                                ?.let { store.purge(it) }
                        }
                        if (owns(mine, authority)) job = null
                    }
                    if (owns(mine, authority)) {
                        _state.value = State.Failed(CloudFailure(CloudFailure.Kind.SPOOL_UNUSABLE))
                    }
                    return@launch
                }
                run(store, plan, key, authority, mine)
            } finally {
                if (mine == generation) activeAuthority = null
            }
        }
    }

    /**
     * Forget the offered job and remove it from this device.
     *
     * The tombstone is written FIRST and the removal only follows it: a process
     * death in between still leaves a job the sweep deletes rather than one
     * recovery offers again. If the tombstone cannot be written, NOTHING is
     * deleted — a discard this device could not record is one it must not
     * half-perform, so the job is offered again with the failure said out loud.
     *
     * A job whose object the server already has is refused, and the surface does
     * not offer this action there: its directory holds the only copy of that
     * object's key.
     */
    fun discardPending() {
        val store = pending ?: return
        scope.launch(owner) {
            val plan = job ?: return@launch
            if (plan.finalizedStoredId != null) return@launch
            if (discarding) return@launch
            discarding = true
            generation += 1
            val mine = generation
            val writer = running
            running = null
            recovering?.cancel()
            recovering = null
            activeAuthority = null
            _notice.value = null
            try {
                // Cancelled AND JOINED. A writer that is merely cancelled is
                // still unwinding, and it can still record a session or an
                // attempt marker for this job — which would put the directory
                // back after the removal below took it away.
                writer?.cancelAndJoin()
                val outcome = withContext(NonCancellable + io) {
                    val retired = runCatching { store.markRetired(plan) }.getOrNull()
                        ?: return@withContext Discard.NO_TOMBSTONE
                    if (store.purge(retired)) Discard.REMOVED else Discard.TOMBSTONED
                }
                if (mine != generation) return@launch
                if (outcome == Discard.NO_TOMBSTONE) {
                    // Nothing was deleted, because nothing recorded the
                    // decision: a discard this device cannot write down is one
                    // it must not half-perform. The job is still here, so it is
                    // offered again — with the failure said out loud rather than
                    // left as a silent no-op that looks like it worked.
                    val resumable = withContext(io) { store.spoolLength(plan) } == plan.payloadTotal
                    if (mine != generation) return@launch
                    job = plan
                    _state.value =
                        State.Interrupted(plan.files.size, plan.totalBytes, resumable, null)
                    _notice.value = Notice.CLEANUP_FAILED
                    return@launch
                }
                // Tombstoned. Whether or not the bytes went, this job will never
                // be offered again and the sweep finishes it — so the screen is
                // done with it, and only the leftover copy is worth mentioning.
                job = null
                _state.value = State.Idle
                if (outcome == Discard.TOMBSTONED) _notice.value = Notice.CLEANUP_FAILED
            } finally {
                discarding = false
            }
        }
    }

    /**
     * Remove interrupted-upload data this device can no longer read.
     *
     * A device-data action, not an account one: an unreadable record has no
     * readable account, so nothing can say whose it is. It is never run as part
     * of signing out or of discarding one account's job.
     */
    fun clearStrandedDeviceData() {
        val store = pending ?: return
        scope.launch(owner) {
            val mine = generation
            val complete = withContext(NonCancellable + io) { store.purgeUnreadableDeviceData() }
            _strandedDeviceData.value = !complete
            if (mine == generation && !complete) _notice.value = Notice.CLEANUP_FAILED
        }
    }

    fun dismissNotice() {
        scope.launch(owner) { _notice.value = null }
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
            val shown = readyFor
            if (shown != null && !session.isCurrent(shown)) {
                readyFor = null
                generation += 1
                if (_state.value is State.Ready) _state.value = State.Idle
            }
            // Work belongs to ONE account, and a job is not the only evidence of
            // it: between choosing files and committing a plan there is a whole
            // staging pass with no job yet. The authority captured when the work
            // started answers for both.
            val active = activeAuthority
            val staged = job
            val live = session.authority()
            val stale = (active != null && !session.isCurrent(active)) ||
                (staged != null && live?.accountId != staged.accountId)
            if (!stale) return@launch
            // Hidden on the owner, so no turn exists in which the next account
            // sees the previous one's files, progress or link. The bytes are
            // deliberately NOT deleted: signing out is not a destructive act,
            // and the same account signing back in finds its upload where it
            // left it.
            generation += 1
            running?.cancel()
            running = null
            recovering?.cancel()
            recovering = null
            activeAuthority = null
            job = null
            _notice.value = null
            when (_state.value) {
                is State.Staging, is State.Verifying, is State.Uploading,
                is State.Interrupted, is State.Uncertain, is State.Completing,
                -> _state.value = State.Idle
                else -> Unit
            }
        }
    }

    /**
     * Stop an upload in flight, or clear a finished one.
     *
     * A STAGED job is deliberately not deleted here. Cancel means "stop
     * uploading", and the encrypted copy is the whole reason the upload can be
     * continued; throwing it away would make Cancel a destructive action the
     * button does not name. [discardPending] is the one that deletes, and it
     * asks first.
     */
    fun reset() {
        scope.launch(owner) {
            generation += 1
            running?.cancel()
            running = null
            readyFor = null
            _notice.value = null
            activeAuthority = null
            val staged = job
            if (staged == null) {
                _state.value = State.Idle
                return@launch
            }
            if (staged.finalizedStoredId != null) {
                _state.value = State.Completing(staged.files.size, staged.totalBytes)
                return@launch
            }
            if (staged.finalizeAttempted) {
                _state.value = State.Uncertain(staged.files.size, staged.totalBytes)
                return@launch
            }
            val mine = generation
            val resumable = pending?.let {
                withContext(io) { it.spoolLength(staged) } == staged.payloadTotal
            } ?: false
            // The length read happens off the owner, so a newer selection or an
            // account change can land inside it. A cancelled job may not
            // overwrite whatever replaced it, and it may not be shown under an
            // account that is no longer the one it belongs to — the observer
            // that notices a sign-out may not have run yet.
            if (mine != generation) return@launch
            if (session.authority()?.accountId != staged.accountId) {
                _state.value = State.Idle
                return@launch
            }
            _state.value = State.Interrupted(
                staged.files.size,
                staged.totalBytes,
                resumable,
                CloudFailure(CloudFailure.Kind.CANCELLED),
            )
        }
    }

    // ── shared classification ───────────────────────────────────────────────

    private fun PendingUploadException.asFailure(): CloudFailure = CloudFailure(
        when (reason) {
            PendingUploadException.Reason.UNUSABLE_SELECTION -> CloudFailure.Kind.MALFORMED
            PendingUploadException.Reason.NO_SPACE -> CloudFailure.Kind.NO_SPACE
            PendingUploadException.Reason.STORAGE -> CloudFailure.Kind.STAGE_FAILED
            PendingUploadException.Reason.PROTECTION -> CloudFailure.Kind.PROTECTION_UNAVAILABLE
            PendingUploadException.Reason.SPOOL_INVALID -> CloudFailure.Kind.SPOOL_UNUSABLE
        },
    )

    /** A wire refusal raised while STAGING is about the selection, not about a
     *  server: a source that grew or shrank against the manifest is the file
     *  failing, and the user's next action is to check it. */
    private fun stagingWireFailure(e: StoredWireException): CloudFailure = CloudFailure(
        when (e.reason) {
            StoredWireException.Reason.LENGTH_MISMATCH -> CloudFailure.Kind.SOURCE_FAILED
            StoredWireException.Reason.INVALID_MANIFEST -> CloudFailure.Kind.MALFORMED
            StoredWireException.Reason.INVALID_KEY -> CloudFailure.Kind.MALFORMED
            else -> CloudFailure.Kind.DAMAGED
        },
    )

    companion object {
        /**
         * The plaintext total at or above which an upload is staged and made
         * resumable.
         *
         * One server chunk. Below it the accepted single-shot stream sends the
         * whole thing in one request, which costs no disk copy and whose
         * recovery story is honestly stated in the UI: choose the files again.
         * Above it an interruption is expensive enough that spooling a second
         * copy of the ciphertext is the better trade.
         */
        const val RESUMABLE_MIN_BYTES = 8L * 1024 * 1024

        /** Free space a staging pass insists on beyond the spool itself, so
         *  filling the disk exactly is not the thing that ends it. */
        const val STAGING_HEADROOM_BYTES = 16L * 1024 * 1024

        /**
         * Consecutive appends after which an offset that has not advanced is
         * reported rather than retried.
         *
         * A slow uplink is NOT this case: a request the server cuts at its own
         * wall-clock bound still commits what arrived, which moves the offset.
         * Answers that move nothing are a loop.
         */
        const val MAX_STALLED_APPENDS = 5
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
