package com.relayium.android.integration

import com.relayium.android.inbox.InboxSourceLease
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlin.coroutines.coroutineContext

/**
 * One export at a time, stoppable from outside, and cleaning up exactly what it
 * created.
 *
 * ## What a check between files does not buy
 *
 * Copying a delivery into a folder the user chose is a loop of provider writes,
 * and each individual write can block for as long as the receiving app likes.
 * Testing the account between files therefore proves very little: the file
 * being written when the account changes goes on being written to completion,
 * because nothing about a cancelled coroutine interrupts a thread already
 * blocked inside `OutputStream.write`.
 *
 * That is the same problem the Inbox's own source opener solves, and this
 * reuses its answer rather than writing a second one: [InboxSourceLease] owns
 * the streams, and a watcher coroutine on ANOTHER dispatcher closes them the
 * instant cancellation is requested. Closing the descriptor is what ends the
 * blocked write; a `finally` cannot, because a `finally` runs when the block
 * returns and the block is precisely what is stuck.
 *
 * ## Serialised by construction, and superseding
 *
 * "Cancel the previous job, then publish mine" is not serialisation: two callers
 * both cancel, both publish, and both run. Here a new export first asks the
 * running one to stop — which also unblocks it — and then takes an admission
 * lock that is only released when that one has actually finished. There is no
 * interleaving in which two exports hold streams at the same time.
 *
 * ## Cancellation reaches this from three directions
 *
 *  * the CALLER's coroutine being cancelled, which works because the body runs
 *    in the caller's own context rather than in a scope of this object's — an
 *    `async` on some other scope would leave the work running with only the
 *    `await` cancelled;
 *  * [stop], for an identity change the caller observed;
 *  * a newer export superseding this one.
 *
 * All three converge on the same two actions: cancel the job and close the
 * lease.
 *
 * ## A copy is not done until its sink has CLOSED
 *
 * A flush is not a commit. Providers that are not plain local files finalise on
 * `close()`, and report there if they could not — so the close is part of the
 * copy and its failure is the copy's failure. Deferring it to the lease would
 * put it in cleanup, where errors are deliberately suppressed, and the export
 * would report success for bytes the provider never kept.
 *
 * ## Cleanup is in `finally`, and never deletes a directory
 *
 * Whatever the run created is removed when it does not finish — from a
 * `finally`, so a body that throws past its own cleanup cannot skip it.
 *
 * **Only files.** A directory delete through `DocumentsContract` is RECURSIVE
 * and has no atomic empty-only form, so deleting a directory this export
 * created would destroy anything the user happened to put inside it in the
 * meantime. Directories this run created are therefore COUNTED and reported —
 * see [Cleanup.leftoverDirectories] — rather than removed, which is the same
 * conservative rule the accepted receive store already applies. An export that
 * left directories behind does not claim a clean folder.
 */
class ExportCoordinator(
    /** Where the copying happens. */
    private val io: CoroutineDispatcher = Dispatchers.IO,
    /**
     * Where the closing watcher runs.
     *
     * NOT the dispatcher doing the writing. The whole point is to close a
     * stream while a thread is blocked on it, so the closer must be able to run
     * on a thread the write is not occupying.
     */
    private val watchOn: CoroutineDispatcher = Dispatchers.Default,
    /**
     * Told, exactly once per run, when a run ended having left something
     * behind.
     *
     * ## Why this is a callback and not a field the host reads
     *
     * The host's only chance to look would be straight after [stop] — and
     * [stop] does not clean anything up. It cancels the job and closes the
     * lease; the export then has to unwind, and [Session.discard] runs after
     * that, on the export's own coroutine, doing provider deletes that can
     * block. A host that read a field at that moment would see `null`, or the
     * PREVIOUS run's result, and would tell the user their folder is clean
     * while the files were still being removed — or, worse, while the removal
     * was failing.
     *
     * So the notice is driven by the run COMPLETING, and it carries that run's
     * own result. Invoked from a cancelled coroutine's unwind, so it must not
     * suspend and must not block: setting a state value is all it is for.
     */
    private val onCleanup: (Cleanup) -> Unit = {},
) {

    /** How an export ended. */
    enum class Outcome {
        DONE,

        /** Nothing to export, or the identity that authorised it is gone. */
        UNAVAILABLE,

        /** A write failed, and everything this run created has been removed. */
        FAILED,

        /**
         * A write failed and the cleanup could not remove everything.
         *
         * Its own outcome rather than a silent `FAILED`: the user's chosen
         * folder now holds something this app put there and could not take
         * back, and telling them it merely failed would be untrue.
         */
        FAILED_INCOMPLETE,
    }

    /**
     * What a stopped export left behind.
     *
     * Recorded on the object rather than only returned, because the path that
     * needs it most is the one that cannot return anything: an export cancelled
     * by an account change takes its caller's coroutine with it, so there is
     * nobody left to receive a value. The host reads this afterwards and tells
     * the user the truth.
     */
    class Cleanup internal constructor(
        /** Every file this run created was removed. */
        val filesRemoved: Boolean,
        /**
         * Directories this run created and deliberately did NOT delete.
         *
         * A `DocumentsContract` directory delete is recursive with no atomic
         * empty-only form, so removing one could destroy whatever the user put
         * inside it in the meantime. They are counted and reported instead —
         * claiming a clean folder while leaving them would be untrue.
         */
        val leftoverDirectories: Int,
    ) {
        val isClean: Boolean get() = filesRemoved && leftoverDirectories == 0

        override fun toString(): String =
            "Cleanup(filesRemoved=$filesRemoved, leftoverDirectories=$leftoverDirectories)"
    }

    /**
     * The cleanup of the most recent run that did not finish cleanly, or null.
     *
     * Reset when a run starts, so it always describes the latest attempt.
     */
    @Volatile
    var lastCleanup: Cleanup? = null
        private set

    /** The work in flight, so it can be stopped from outside. */
    private class Active(val job: Job?, val lease: InboxSourceLease, val session: Session)

    /**
     * Admission. Held for the WHOLE of a run, so the next one cannot begin
     * until this one has finished — cancelled or not.
     */
    private val admission = Mutex()

    @Volatile
    private var active: Active? = null

    /**
     * Record a finished run's cleanup, and announce it if it left anything.
     *
     * One place, so the notice cannot be attached to one exit path and
     * forgotten on the other — and the cancellation path is precisely the one
     * that matters, because it is the one whose caller is gone.
     */
    private fun record(cleanup: Cleanup): Cleanup {
        lastCleanup = cleanup
        if (!cleanup.isClean) onCleanup(cleanup)
        return cleanup
    }

    /**
     * Stop the export that is running, if any.
     *
     * Closing the lease comes FIRST and is what actually ends a write that is
     * already blocked; cancelling the job alone would leave the thread inside
     * the provider until it returned on its own.
     *
     * Safe to call from any thread and when nothing is running.
     *
     * It does NOT clean up, and it does not know whether anything was left
     * behind: the run has to unwind first. Whatever it leaves is reported
     * through [onCleanup] when that run actually completes.
     */
    fun stop() {
        val running = active ?: return
        // Recorded FIRST. Closing the lease makes the blocked write throw, and
        // the body has to be able to tell that throw apart from a provider
        // genuinely failing — one is this app ending the export, the other is
        // something to report to the user.
        running.session.markStopped()
        running.lease.closeAll()
        running.job?.cancel()
    }

    /**
     * Run [body] as THE export.
     *
     * A newer call supersedes an older one: it stops it and then waits for it
     * to finish before starting. The body receives a [Session] it must register
     * every stream and every created node with — that registration is what
     * makes cancellation and cleanup possible at all.
     */
    suspend fun export(body: suspend (Session) -> Outcome): Outcome {
        // Ask whatever is running to stop, and unblock it, BEFORE queueing for
        // admission — otherwise a superseding export would wait behind a write
        // that nothing had told to end.
        stop()
        return admission.withLock {
            val lease = InboxSourceLease()
            val session = Session(lease)
            // Describes the LATEST attempt, so a clean run does not leave the
            // previous one's leftovers on screen.
            lastCleanup = null
            active = Active(coroutineContext[Job], lease, session)
            try {
                withContext(io) {
                    // A CHILD coroutine, not a completion handler:
                    // `invokeOnCompletion` fires when the job COMPLETES, and a
                    // job blocked inside a provider write cannot complete — so
                    // the close it was supposed to perform would wait for the
                    // very thing it exists to interrupt.
                    val watcher = launch(watchOn, start = CoroutineStart.UNDISPATCHED) {
                        try {
                            awaitCancellation()
                        } finally {
                            lease.closeAll()
                        }
                    }
                    try {
                        val outcome = body(session)
                        if (outcome == Outcome.DONE) {
                            outcome
                        } else {
                            // The body's own reason is kept — an export the
                            // account outlived is UNAVAILABLE, not FAILED — and
                            // is only overridden when the cleanup itself could
                            // not finish, which is a different, worse fact.
                            val cleanup = record(session.discard())
                            if (cleanup.isClean) outcome else Outcome.FAILED_INCOMPLETE
                        }
                    } catch (t: Throwable) {
                        // EVERY abnormal exit, not only cancellation. Closing
                        // the lease under a blocked write makes that write
                        // throw `IOException`, and a cleanup that only handled
                        // `CancellationException` would leave a half-written
                        // file in the user's folder on the very path this class
                        // exists to handle.
                        //
                        // The RESULT is recorded rather than discarded. This
                        // path cannot return anything — it rethrows, and on the
                        // account-change path the caller's coroutine is gone
                        // too — so [lastCleanup] is the only way the fact that
                        // something was left behind can reach the user at all.
                        record(session.discard())
                        throw t
                    } finally {
                        watcher.cancel()
                        lease.closeAll()
                    }
                }
            } finally {
                if (active?.lease === lease) active = null
            }
        }
    }

    /**
     * The things one export owns: the streams it has open and the documents it
     * has created.
     */
    class Session internal constructor(private val lease: InboxSourceLease) {

        private val created = ArrayList<Deletable>()

        /**
         * Directories this run created.
         *
         * Held apart from [created] because they are never deleted — only
         * counted. See [Cleanup.leftoverDirectories].
         */
        private var directoriesCreated = 0

        /**
         * Whether this export has been told to stop.
         *
         * Set before the lease is closed, so a write that throws because its
         * stream was pulled out from under it can be recognised as THIS APP
         * ending the export rather than as the provider failing. Without it the
         * user would be shown a save-failed message for an export they, or an
         * account change, deliberately ended.
         */
        @Volatile
        private var stopped = false

        internal fun markStopped() {
            stopped = true
        }

        /** Something this run made, and may therefore remove. */
        fun interface Deletable {
            /** True when it is gone. */
            fun delete(): Boolean
        }

        /**
         * Record a document this run created.
         *
         * Only what this run created is ever removed. A folder the user already
         * had is not this app's to touch.
         */
        fun recordCreated(node: Deletable) {
            created.add(node)
        }

        /**
         * Record a directory this run created.
         *
         * Deliberately not a [Deletable]: it will not be removed, and giving it
         * the same shape as something that will is how a recursive delete gets
         * added later by someone reading the type.
         */
        fun recordCreatedDirectory() {
            directoriesCreated += 1
        }

        /**
         * Open both ends, then copy, in chunks, cancellably.
         *
         * ## Why this takes factories and not streams
         *
         * A caller writing `copy(file.inputStream(), document.openOut())` opens
         * BOTH before either is owned by anything, and there is no ordering of
         * those two expressions that is safe: if the second throws — a provider
         * refusing, a document that vanished — the first is an open descriptor
         * nobody holds a reference to, and if a cancellation lands between them
         * the lease refuses the first and the second leaks in its place.
         *
         * Opening inside means each stream is registered at the moment it
         * exists, and a refusal closes what it refuses rather than abandoning
         * it. There is no expression the caller can write that opens something
         * this object does not own.
         *
         * The lease is what stops a copy that is already BLOCKED — it closes
         * the descriptor out from under the call — and the per-chunk check is
         * what stops a long one promptly once it is not. Neither alone is
         * cancellation.
         */
        suspend fun copy(openSource: () -> InputStream, openSink: () -> OutputStream) {
            val source = openSource()
            if (!lease.add(source)) {
                // The lease closed while this was opening. It closes what it
                // refuses, so there is nothing to clean up here — and nothing
                // has been opened for the other end yet.
                throw CancellationException("export: cancelled before the read")
            }
            val sink = try {
                openSink()
            } catch (t: Throwable) {
                // The source is already leased and will be closed with it, so
                // this cannot orphan a descriptor.
                throw t
            }
            if (!lease.add(sink)) {
                throw CancellationException("export: cancelled before the write")
            }
            val buffer = ByteArray(DEFAULT_CHUNK)
            try {
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val read = source.read(buffer)
                    if (read < 0) break
                    currentCoroutineContext().ensureActive()
                    sink.write(buffer, 0, read)
                }
                sink.flush()
                // CLOSED HERE, and its failure is this copy's failure.
                //
                // A flush is not a commit. For a document provider backed by
                // anything but a local file — a cloud drive, a sync client, a
                // provider that buffers and uploads — `close()` is where the
                // write is finalised, and it is the call that reports the
                // failure if it was not. Leaving the close to the lease means
                // it happens in cleanup, where errors are correctly SUPPRESSED
                // because cleanup must not throw over the outcome; the export
                // would then report DONE for a file the provider never
                // committed, which is the strongest wrong claim this class can
                // make.
                //
                // Closing twice is harmless: the lease closes it again on the
                // way out and swallows what it finds, so the stream stays owned
                // for the cancellation path and nothing is orphaned.
                sink.close()
            } catch (e: IOException) {
                // A stream closed under a blocked call throws here. If this
                // export was stopped — or the coroutine has since been
                // cancelled — that throw IS the stop taking effect, and
                // reporting it as a write failure would blame the provider for
                // something this app did. Anything else is a real failure and
                // is left to the caller.
                if (stopped) throw CancellationException("export: stopped")
                currentCoroutineContext().ensureActive()
                throw e
            }
        }

        /** Take ownership of something that must be closed on cancellation. */
        fun own(resource: Closeable): Boolean = lease.add(resource)

        /**
         * Remove what this run created, newest first, and say whether the
         * folder was left clean.
         *
         * Deliberately NOT suspending and deliberately not checking
         * cancellation: this runs when the export is already ending, including
         * on the cancellation path, and a cleanup that could itself be
         * cancelled would leave exactly the mess it exists to prevent.
         */
        internal fun discard(): Cleanup {
            var filesRemoved = true
            for (node in created.asReversed()) {
                val removed = try {
                    node.delete()
                } catch (_: Exception) {
                    false
                }
                if (!removed) filesRemoved = false
            }
            created.clear()
            return Cleanup(filesRemoved = filesRemoved, leftoverDirectories = directoriesCreated)
        }
    }

    private companion object {
        /** Big enough that a large file is not a million syscalls, small enough
         *  that the cancellation check between chunks is frequent. */
        const val DEFAULT_CHUNK = 64 * 1024
    }
}
